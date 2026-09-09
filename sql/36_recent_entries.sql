-- ---------------------------------------------------------------------------
-- mgc_recent_entries -- what was entered lately, across the whole book
-- ---------------------------------------------------------------------------
-- Every other read in this app is anchored to an account. `mgc_get_register`
-- takes an account guid and answers "what happened here". Nothing answered
-- "what did I just add", and that is the question you actually have after a
-- scan: did it save, and did it save what I meant.
--
-- ---------------------------------------------------------------------------
-- Why enter_date and not post_date
-- ---------------------------------------------------------------------------
-- These are different dates and the difference is the whole point of this
-- function. `post_date` is the date the transaction is dated. `enter_date` is
-- the moment it was keyed in. Everything else in this app sorts on post_date,
-- correctly, because a register is about when money moved.
--
-- This one sorts on enter_date, because it is about YOUR ACTION, not the
-- money's date. The dev book holds a Gocar entry keyed in on 2026-09-08 with a
-- post_date of 2024-05-20: a post_date window of any sane length would not show
-- it, and it is exactly the kind of entry you would want to check right after
-- making it.
--
-- ---------------------------------------------------------------------------
-- Time zones
-- ---------------------------------------------------------------------------
-- GnuCash stores enter_date as `timestamp without time zone` holding UTC, and
-- `mgc_record_entry` writes `now()` into it. That is correct today only because
-- the server runs in UTC. Rather than inherit that assumption, the window here
-- is built from `now() AT TIME ZONE 'UTC'`, which stays right even if the
-- server's TimeZone setting is ever changed.
--
-- ---------------------------------------------------------------------------
-- What "amount" means here
-- ---------------------------------------------------------------------------
-- The sum of the POSITIVE values. An entry's splits sum to zero by
-- construction, so the positive side is the size of the entry: 11,000 out of a
-- wallet reads as 11,000, not 22,000 and not 0. Values are in the
-- transaction's own currency, so this holds for cross-currency transfers too.
--
-- Balances are never combined across currencies anywhere in this app, and this
-- function keeps that rule: each row carries its own currency and there is no
-- grand total across rows.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.mgc_recent_entries(
  p_hours integer DEFAULT 24,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  -- Clamped, like every other read here: a caller cannot ask for the whole
  -- book by passing a big number.
  v_hours integer   := LEAST(GREATEST(COALESCE(p_hours, 24),  1), 720);  -- 30 days
  v_limit integer   := LEAST(GREATEST(COALESCE(p_limit, 50),  1), 200);
  v_from  timestamp;
  v_total integer;
  v_rows  jsonb;
BEGIN
  v_from := (now() AT TIME ZONE 'UTC') - make_interval(hours => v_hours);

  -- Counted separately from the limited row set, so the caller can be told
  -- honestly that it is looking at a truncated list.
  SELECT count(*) INTO v_total
    FROM transactions t
   WHERE t.enter_date >= v_from;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb
                            ORDER BY r.enter_date DESC, r.tx_guid), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT t.guid                                          AS tx_guid,
             to_char(t.enter_date, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS enter_date,
             t.post_date::date                               AS post_date,
             COALESCE(t.num, '')                             AS num,
             COALESCE(t.description, '')                     AS description,
             tc.mnemonic                                     AS currency,
             -- The size of the entry. See the header.
             (SELECT COALESCE(sum(s.value_num::numeric / s.value_denom)
                                FILTER (WHERE s.value_num > 0), 0)
                FROM splits s WHERE s.tx_guid = t.guid)::float8 AS amount,
             (SELECT count(*) FROM splits s2 WHERE s2.tx_guid = t.guid) AS split_count,
             -- Written by this app, rather than by GnuCash desktop or an
             -- import. `mgc_record_entry` and `mgc_transfer` both stamp this
             -- slot, so it is a reliable "I did this on the phone" marker.
             EXISTS (SELECT 1 FROM slots sl
                      WHERE sl.obj_guid = t.guid AND sl.name = 'mgc_req_id') AS from_phone,
             -- Every leg, so a row can show what the entry was actually made
             -- of without a second query per row. This is the whole reason the
             -- screen can show you that the platform fee is or is not there.
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'account_guid', a.guid,
                       'account_name', a.name,
                       'account_type', a.account_type,
                       'memo',         COALESCE(s.memo, ''),
                       'quantity',     (s.quantity_num::numeric / s.quantity_denom)::float8,
                       'commodity',    c.mnemonic)
                     ORDER BY (s.value_num::numeric / s.value_denom) DESC), '[]'::jsonb)
                FROM splits s
                JOIN accounts a          ON a.guid = s.account_guid
                LEFT JOIN commodities c  ON c.guid = a.commodity_guid
               WHERE s.tx_guid = t.guid)                     AS splits
        FROM transactions t
        LEFT JOIN commodities tc ON tc.guid = t.currency_guid
       WHERE t.enter_date >= v_from
       ORDER BY t.enter_date DESC, t.guid
       LIMIT v_limit
    ) r;

  RETURN jsonb_build_object(
    'window_hours',  v_hours,
    'from_utc',      to_char(v_from, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'row_count',     jsonb_array_length(v_rows),
    'total_in_window', v_total,
    'truncated',     v_total > v_limit,
    'rows',          v_rows
  );
END;
$FN$;

ALTER FUNCTION public.mgc_recent_entries(integer, integer) OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_recent_entries(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_recent_entries(integer, integer) TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
