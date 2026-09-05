-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- mgc_record_transaction -- an expense or an income entry, single currency.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/45_record_transaction.sql
--
-- One function rather than two. `p_direction` decides the sign, so the client
-- never does sign arithmetic and always sends positive amounts. Income is not
-- "an expense with negative numbers", it is the same double entry with the
-- sign flipped, and putting that single decision in SQL keeps it in one place.
--
-- Cross-currency is REFUSED here, deliberately. A transfer between two asset
-- accounts can derive its rate from two amounts the user actually knows. A
-- receipt cannot: nobody has the rate for a lunch bought on a foreign card, and
-- inventing one would write a number into the ledger that came from nowhere.
-- The refusal names both accounts and both currencies so the fix is obvious.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.mgc_record_transaction(
  p_request_id   text,
  p_account_guid varchar(32),   -- the asset account money leaves or arrives in
  p_direction    text,          -- 'outflow' (expense) | 'inflow' (income)
  p_splits       jsonb,         -- [{"account_guid":..., "amount":..., "memo":...}]
  p_post_date    date,
  p_description  text,
  p_num          text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_existing   varchar(32);
  v_acct       record;
  v_sign       integer;
  v_want_type  text;
  v_tx         varchar(32);
  v_split      jsonb;
  v_other      record;
  v_amount     numeric;
  v_memo       text;
  v_num        bigint;
  v_total      bigint := 0;
  v_guids      text[] := '{}';
  v_g          varchar(32);
  v_val_sum    numeric;
  v_idx        integer := 0;
BEGIN
  IF jsonb_typeof(p_splits) <> 'array' OR jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'A transaction needs at least one line.';
  END IF;

  IF p_direction NOT IN ('outflow', 'inflow') THEN
    RAISE EXCEPTION 'Direction must be outflow or inflow, got "%".', p_direction;
  END IF;

  -- Idempotency before the lock check, so a repeat can still be answered while
  -- desktop holds the book. Refusing there would push a client into retrying a
  -- write that already succeeded.
  SELECT s.obj_guid INTO v_existing
    FROM slots s WHERE s.name = 'mgc_req_id' AND s.string_val = p_request_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded', 'tx_guid', v_existing);
  END IF;

  SELECT a.guid, a.name, a.account_type, a.commodity_guid, a.commodity_scu,
         COALESCE(a.placeholder, 0) AS placeholder, c.mnemonic
    INTO v_acct
    FROM accounts a LEFT JOIN commodities c ON c.guid = a.commodity_guid
   WHERE a.guid = p_account_guid;

  IF v_acct.guid IS NULL THEN
    RAISE EXCEPTION 'Account not found: %', p_account_guid USING ERRCODE = 'no_data_found';
  END IF;
  IF v_acct.placeholder = 1 THEN
    RAISE EXCEPTION '% is a placeholder account and cannot hold transactions.', v_acct.name;
  END IF;
  IF v_acct.account_type NOT IN ('BANK','CASH','ASSET','CREDIT','LIABILITY') THEN
    RAISE EXCEPTION 'Money has to come from or go to an asset or liability account. % is %.',
      v_acct.name, v_acct.account_type;
  END IF;

  -- outflow: the funding account is credited (negative), categories debited.
  -- inflow: the reverse. The wallet side is ALWAYS the opposite sign to the
  -- category side, and never varies by account_type -- a credit card expense is
  -- still negative on the card. GnuCash flips the DISPLAY sign for liabilities;
  -- the stored value does not vary. Getting this wrong produced an imbalanced
  -- transaction the first time it was attempted in this project's predecessor.
  v_sign      := CASE p_direction WHEN 'outflow' THEN 1 ELSE -1 END;
  v_want_type := CASE p_direction WHEN 'outflow' THEN 'EXPENSE' ELSE 'INCOME' END;

  PERFORM mgc_assert_unlocked();

  v_tx := mgc_new_guid('tx');
  INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
  VALUES (v_tx, v_acct.commodity_guid, COALESCE(p_num, ''),
          mgc_neutral_ts(p_post_date), now(), COALESCE(p_description, ''));

  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits)
  LOOP
    v_idx    := v_idx + 1;
    v_amount := (v_split->>'amount')::numeric;
    v_memo   := COALESCE(v_split->>'memo', '');

    IF v_amount IS NULL OR v_amount <= 0 THEN
      RAISE EXCEPTION 'Line % has no amount. Amounts are always positive; the direction decides the sign.', v_idx;
    END IF;

    SELECT a.guid, a.name, a.account_type, a.commodity_guid, a.commodity_scu,
           COALESCE(a.placeholder,0) AS placeholder, c.mnemonic
      INTO v_other
      FROM accounts a LEFT JOIN commodities c ON c.guid = a.commodity_guid
     WHERE a.guid = (v_split->>'account_guid')::varchar(32);

    IF v_other.guid IS NULL THEN
      RAISE EXCEPTION 'Line %: account not found.', v_idx USING ERRCODE = 'no_data_found';
    END IF;
    IF v_other.placeholder = 1 THEN
      RAISE EXCEPTION 'Line %: % is a placeholder account and cannot hold transactions.',
        v_idx, v_other.name;
    END IF;
    IF v_other.account_type <> v_want_type THEN
      RAISE EXCEPTION 'Line %: % is %, but a% needs a% account. Moving money between two of your own accounts is a transfer, not a%.',
        v_idx, v_other.name, v_other.account_type,
        CASE p_direction WHEN 'outflow' THEN 'n expense' ELSE 'n income entry' END,
        CASE p_direction WHEN 'outflow' THEN 'n EXPENSE' ELSE 'n INCOME' END,
        CASE p_direction WHEN 'outflow' THEN 'n expense' ELSE 'n income entry' END;
    END IF;

    -- The same-currency gate. This is the check whose absence let a
    -- predecessor record Rp 191,400 as $191,400.00 against a USD account, with
    -- no error anywhere and a silently wrong ledger as the only evidence.
    IF v_other.commodity_guid IS DISTINCT FROM v_acct.commodity_guid THEN
      RAISE EXCEPTION
        'Cross-currency is not supported here. % is in %, but % is in %. Enter this in GnuCash desktop, where you can set the rate.',
        v_acct.name, COALESCE(v_acct.mnemonic, '?'),
        v_other.name, COALESCE(v_other.mnemonic, '?');
    END IF;

    v_num   := round(v_amount * v_acct.commodity_scu);
    v_total := v_total + v_num;

    v_g := mgc_new_guid('s' || v_idx::text);  v_guids := v_guids || v_g;
    INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                        reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
    VALUES (v_g, v_tx, v_other.guid, v_memo, '', 'n', NULL,
            v_sign * v_num, v_acct.commodity_scu,
            v_sign * v_num, v_acct.commodity_scu, NULL);
  END LOOP;

  -- The funding split is the negated SUM OF THE ALREADY-ROUNDED numerators, not
  -- a rounding of the summed amount. That is what guarantees the transaction
  -- balances to exactly zero even when the individual amounts do not sum
  -- cleanly at the currency's precision. Do not "simplify" this to
  -- round(total_amount * scu).
  v_g := mgc_new_guid('fund');  v_guids := v_guids || v_g;
  INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                      reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
  VALUES (v_g, v_tx, v_acct.guid, '', '', 'n', NULL,
          -1 * v_sign * v_total, v_acct.commodity_scu,
          -1 * v_sign * v_total, v_acct.commodity_scu, NULL);

  INSERT INTO slots (obj_guid, name, slot_type, string_val)
  VALUES (v_tx, 'mgc_req_id', 4, p_request_id);
  INSERT INTO slots (obj_guid, name, slot_type, timespec_val, gdate_val)
  VALUES (v_tx, 'date-posted', 10, '1970-01-01 00:00:00', p_post_date);

  -- Assert before returning. A failure raises, and because PostgREST runs each
  -- request in one transaction the whole write rolls back rather than leaving
  -- an unbalanced entry behind.
  SELECT sum(value_num::numeric / value_denom) INTO v_val_sum
    FROM splits WHERE tx_guid = v_tx;
  IF v_val_sum <> 0 THEN
    RAISE EXCEPTION 'Refusing to write: splits do not balance (value sums to %).', v_val_sum;
  END IF;

  RETURN jsonb_build_object(
    'status',      'recorded',
    'tx_guid',     v_tx,
    'direction',   p_direction,
    'currency',    v_acct.mnemonic,
    'line_count',  v_idx,
    'split_guids', to_jsonb(v_guids)
  );
END;
$FN$;

ALTER FUNCTION public.mgc_record_transaction(text, varchar, text, jsonb, date, text, text)
  OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_record_transaction(text, varchar, text, jsonb, date, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_record_transaction(text, varchar, text, jsonb, date, text, text)
  TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
