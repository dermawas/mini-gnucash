-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Ledger reads: balances and the register.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/35_ledger_reads.sql
--
-- Run as postgres (or as the current owner, on a re-run).
--
-- ===========================================================================
-- THE RULE THAT MATTERS IN THIS FILE
-- ===========================================================================
-- Balances are summed from quantity_num/quantity_denom, NEVER from
-- value_num/value_denom.
--
-- In a single-currency transaction the two are identical, so the mistake is
-- invisible until the first cross-currency transfer -- at which point it is
-- badly wrong and still looks plausible. In the reference transfer on this
-- project's own book, the IDR bank account's split carries:
--
--     value    +315580/100        <- 3,155.80 USD, the TRANSACTION currency
--     quantity +5608172200/100    <- 56,081,722 IDR, the ACCOUNT's commodity
--
-- Summing `value` there would report a USD figure on an IDR account, off by a
-- factor of ~17,771. `value` answers "what was this worth in the transaction's
-- currency"; only `quantity` answers "how much of its own commodity does this
-- account hold". A balance is the second question.
--
-- Worth stating loudly because the obvious thing to copy -- the drift-check
-- function in this project's predecessor -- sums value, correctly, for a
-- different purpose.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- mgc_get_balances -- every account's balance, in its own commodity
-- ---------------------------------------------------------------------------
-- Four balances per account, because they answer different questions and a
-- register UI wants more than one of them:
--
--   total       every split, including future-dated ones
--   present     splits posted up to now -- what you actually have today
--   cleared     splits marked 'c' or 'y' -- what the bank agrees with
--   reconciled  splits marked 'y' only
--
-- Also returns a SUBTREE balance, because an accounts screen that shows nothing
-- against a parent looks broken. It is deliberately NULL whenever the subtree
-- spans more than one commodity: adding IDR to USD needs an exchange rate this
-- app does not have and will not invent. A parent over mixed currencies shows
-- its own balance and no total, which is the honest answer.
CREATE OR REPLACE FUNCTION public.mgc_get_balances()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_result jsonb;
BEGIN
  RETURN (
    WITH RECURSIVE per_account AS (
      SELECT sp.account_guid,
             sum(sp.quantity_num::numeric / sp.quantity_denom)                        AS bal_total,
             sum(sp.quantity_num::numeric / sp.quantity_denom)
               FILTER (WHERE t.post_date <= now())                                    AS bal_present,
             sum(sp.quantity_num::numeric / sp.quantity_denom)
               FILTER (WHERE sp.reconcile_state IN ('c','y'))                          AS bal_cleared,
             sum(sp.quantity_num::numeric / sp.quantity_denom)
               FILTER (WHERE sp.reconcile_state = 'y')                                 AS bal_reconciled,
             count(*)                                                                  AS split_count
        FROM splits sp
        JOIN transactions t ON t.guid = sp.tx_guid
       GROUP BY sp.account_guid
    ),
    -- (root, member) pairs: every account paired with itself and each of its
    -- descendants. RECURSIVE is declared on the WITH clause as a whole (Postgres
    -- requires it there, not on the individual CTE), so it covers this one.
    subtree(root, member, depth) AS (
      SELECT guid, guid, 0 FROM accounts WHERE account_type <> 'ROOT'
      UNION ALL
      SELECT s.root, c.guid, s.depth + 1
        FROM subtree s
        JOIN accounts c ON c.parent_guid = s.member
       WHERE s.depth < 20
    ),
    rollup AS (
      SELECT s.root,
             sum(COALESCE(pa.bal_total, 0))                    AS subtree_total,
             count(DISTINCT m.commodity_guid)                  AS n_commodities
        FROM subtree s
        JOIN accounts m       ON m.guid = s.member
        LEFT JOIN per_account pa ON pa.account_guid = s.member
       GROUP BY s.root
    )
    SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.guid), '[]'::jsonb)
      FROM (
        SELECT a.guid,
               c.mnemonic                          AS commodity_mnemonic,
               a.commodity_scu,
               COALESCE(pa.bal_total,      0)::float8 AS balance_total,
               COALESCE(pa.bal_present,    0)::float8 AS balance_present,
               COALESCE(pa.bal_cleared,    0)::float8 AS balance_cleared,
               COALESCE(pa.bal_reconciled, 0)::float8 AS balance_reconciled,
               COALESCE(pa.split_count,    0)         AS split_count,
               -- NULL, not 0, when the subtree mixes commodities. A client must
               -- render "--" there rather than a number that means nothing.
               CASE WHEN r.n_commodities = 1 THEN r.subtree_total::float8 ELSE NULL END
                 AS balance_subtree
          FROM accounts a
          LEFT JOIN commodities c  ON c.guid = a.commodity_guid
          LEFT JOIN per_account pa ON pa.account_guid = a.guid
          LEFT JOIN rollup r       ON r.root = a.guid
         WHERE a.account_type <> 'ROOT'
      ) x
  );
END;
$FN$;

ALTER FUNCTION public.mgc_get_balances() OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_get_balances() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_get_balances() TO gnucash_mgc_user;

-- ---------------------------------------------------------------------------
-- mgc_get_register -- one account's recent transactions
-- ---------------------------------------------------------------------------
-- Bounded on the SERVER, not by the client asking nicely. A phone that requests
-- 99999 days gets 400, and one that requests 99999 rows gets 500. The client
-- cannot widen this, which is the whole point of a bounded RPC standing in for
-- a SELECT grant.
--
-- `opening_balance` is what the account held immediately before the window
-- opens. Without it a running balance computed client-side would be wrong by
-- however much history the window excluded -- it would start from zero and
-- disagree with the account's real balance. With it, the running total is
-- correct even though only a slice of history was sent.
--
-- `truncated` says plainly that there is more. A register that silently stops
-- invites the reader to believe they have seen everything.
--
-- Returns `split_guid` and `reconcile_state` per row, so the cleared-flag
-- toggle needs no second round trip to find its target.
CREATE OR REPLACE FUNCTION public.mgc_get_register(
  p_account_guid varchar(32),
  p_days         integer DEFAULT 90,
  p_limit        integer DEFAULT 200
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_days     integer := LEAST(GREATEST(COALESCE(p_days,  90),  1), 400);
  v_limit    integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
  v_from     timestamp;
  v_acct     record;
  v_opening  numeric;
  v_total    integer;
  v_rows     jsonb;
BEGIN
  SELECT a.guid, a.name, a.account_type, a.commodity_scu, c.mnemonic
    INTO v_acct
    FROM accounts a
    LEFT JOIN commodities c ON c.guid = a.commodity_guid
   WHERE a.guid = p_account_guid;

  IF v_acct.guid IS NULL THEN
    RAISE EXCEPTION 'Account not found: %', p_account_guid
      USING ERRCODE = 'no_data_found';
  END IF;

  v_from := (now() - make_interval(days => v_days))::timestamp;

  SELECT COALESCE(sum(sp.quantity_num::numeric / sp.quantity_denom), 0)
    INTO v_opening
    FROM splits sp
    JOIN transactions t ON t.guid = sp.tx_guid
   WHERE sp.account_guid = p_account_guid
     AND t.post_date < v_from;

  SELECT count(*) INTO v_total
    FROM splits sp
    JOIN transactions t ON t.guid = sp.tx_guid
   WHERE sp.account_guid = p_account_guid
     AND t.post_date >= v_from;

  SELECT COALESCE(jsonb_agg(row_to_json(r)::jsonb ORDER BY r.post_date DESC, r.tx_guid), '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT t.guid                                        AS tx_guid,
             sp.guid                                       AS split_guid,
             t.post_date::date                             AS post_date,
             COALESCE(t.num, '')                           AS num,
             COALESCE(t.description, '')                   AS description,
             COALESCE(sp.memo, '')                         AS memo,
             COALESCE(sp.action, '')                       AS action,
             sp.reconcile_state,
             (sp.quantity_num::numeric / sp.quantity_denom)::float8 AS quantity,
             (sp.value_num::numeric    / sp.value_denom)::float8    AS value,
             tc.mnemonic                                   AS tx_currency,
             (SELECT count(*) FROM splits s2 WHERE s2.tx_guid = t.guid) AS split_count,
             -- The other side(s) of the entry, so a register row can say what
             -- it was actually for without a second query per row.
             (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'guid',      oa.guid,
                       'name',      oa.name,
                       'quantity',  (os.quantity_num::numeric / os.quantity_denom)::float8,
                       'commodity', oc.mnemonic)), '[]'::jsonb)
                FROM splits os
                JOIN accounts oa    ON oa.guid = os.account_guid
                LEFT JOIN commodities oc ON oc.guid = oa.commodity_guid
               WHERE os.tx_guid = t.guid AND os.guid <> sp.guid) AS other_splits
        FROM splits sp
        JOIN transactions t       ON t.guid = sp.tx_guid
        LEFT JOIN commodities tc  ON tc.guid = t.currency_guid
       WHERE sp.account_guid = p_account_guid
         AND t.post_date >= v_from
       ORDER BY t.post_date DESC, t.guid
       LIMIT v_limit
    ) r;

  RETURN jsonb_build_object(
    'account_guid',    v_acct.guid,
    'account_name',    v_acct.name,
    'account_type',    v_acct.account_type,
    'commodity',       v_acct.mnemonic,
    'commodity_scu',   v_acct.commodity_scu,
    'window_days',     v_days,
    'opening_balance', v_opening::float8,
    'row_count',       jsonb_array_length(v_rows),
    'total_in_window', v_total,
    'truncated',       v_total > v_limit,
    'rows',            v_rows
  );
END;
$FN$;

ALTER FUNCTION public.mgc_get_register(varchar, integer, integer) OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_get_register(varchar, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_get_register(varchar, integer, integer) TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
