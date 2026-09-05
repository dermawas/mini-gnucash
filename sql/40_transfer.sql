-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- mgc_transfer -- move money between two of your own accounts, including
-- across currencies.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/40_transfer.sql
--
-- ===========================================================================
-- THERE IS NO EXCHANGE RATE PARAMETER, AND THERE MUST NEVER BE ONE.
-- ===========================================================================
-- This is the entire point of the function, so it goes at the top where nobody
-- can miss it.
--
-- Entering a cross-currency transfer by hand asks for THREE numbers -- amount
-- out, amount in, and the rate -- of which only two are independent. Rounding
-- makes them disagree, and the leftover lands in Imbalance-USD. That is the
-- problem this project was started to solve.
--
-- This function takes TWO numbers and derives the rate:
--
--     rate = p_to_amount / p_from_amount
--
-- There is no third number, so there is nothing to disagree, and the splits
-- below balance by construction rather than by the caller getting the
-- arithmetic right. Adding a rate parameter later -- however convenient it
-- looks -- reintroduces exactly the bug this replaced.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- mgc_check_request -- did an interrupted write actually land?
-- ---------------------------------------------------------------------------
-- A phone on a VPN can lose its connection between the server committing and
-- the response arriving. PostgREST wraps each request in one transaction, so
-- the book is never left half-written -- but the client genuinely does not know
-- whether it succeeded.
--
-- Without this, the only safe options are "retry and risk a duplicate" or
-- "don't retry and risk losing the entry". With it, the client parks the
-- request id before sending and asks afterwards.
CREATE OR REPLACE FUNCTION public.mgc_check_request(p_request_id text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_tx_guid varchar(32);
  v_desc    text;
  v_date    date;
BEGIN
  SELECT s.obj_guid INTO v_tx_guid
    FROM slots s WHERE s.name = 'mgc_req_id' AND s.string_val = p_request_id
   LIMIT 1;

  IF v_tx_guid IS NULL THEN
    RETURN jsonb_build_object('found', false);
  END IF;

  SELECT t.description, t.post_date::date INTO v_desc, v_date
    FROM transactions t WHERE t.guid = v_tx_guid;

  -- The slot exists but the transaction does not: it was deleted in desktop
  -- after this app wrote it. Report it distinctly -- "it landed and was
  -- removed" is a different fact from "it never landed", and re-sending would
  -- be wrong in the first case.
  IF v_desc IS NULL THEN
    RETURN jsonb_build_object('found', true, 'deleted_since', true, 'tx_guid', v_tx_guid);
  END IF;

  RETURN jsonb_build_object('found', true, 'deleted_since', false,
                            'tx_guid', v_tx_guid,
                            'description', v_desc, 'post_date', v_date);
END;
$FN$;

ALTER FUNCTION public.mgc_check_request(text) OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_check_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_check_request(text) TO gnucash_mgc_user;

-- ---------------------------------------------------------------------------
-- mgc_transfer
-- ---------------------------------------------------------------------------
-- Split layout, derived from a real desktop-written transfer on this project's
-- own book (tx 9da8807c..., "Sell to IDR", $3,155.80 -> Rp 56,081,722) rather
-- than from first principles. For amount A leaving account F (commodity X) and
-- arriving as amount B in account T (commodity Y), with the transaction
-- currency being X:
--
--   TRADING ACCOUNTS ON -- four splits:
--     F                      value -A (X)   quantity -A (X)
--     Trading:<ns>:X         value +A (X)   quantity +A (X)
--     Trading:<ns>:Y         value -A (X)   quantity -B (Y)
--     T                      value +A (X)   quantity +B (Y)
--
--   TRADING ACCOUNTS OFF -- two splits:
--     F                      value -A (X)   quantity -A (X)
--     T                      value +A (X)   quantity +B (Y)
--
-- Two invariants, both asserted before this function returns:
--   * value sums to exactly zero across all splits
--   * each commodity's quantities sum to exactly zero independently
--     (trading form only -- the 2-split form cannot satisfy the second, which
--      is precisely what trading accounts exist to fix)
--
-- Note value_denom is the TRANSACTION currency's scu on every split, while
-- quantity_denom is each split's own account's scu. Conflating those is the
-- single-currency assumption that makes this project's predecessor unable to
-- write a correct cross-currency entry.
CREATE OR REPLACE FUNCTION public.mgc_transfer(
  p_request_id  text,
  p_from_guid   varchar(32),
  p_from_amount numeric,
  p_to_guid     varchar(32),
  p_to_amount   numeric,
  p_post_date   date,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_existing    varchar(32);
  v_from        record;
  v_to          record;
  v_cross       boolean;
  v_trading     boolean;
  v_tr_from     varchar(32);
  v_tr_to       varchar(32);
  v_tx          varchar(32);
  v_rate        numeric;
  v_from_num    bigint;
  v_to_num      bigint;
  v_val_denom   bigint;
  v_guids       text[] := '{}';
  v_g           varchar(32);
  v_val_sum     numeric;
  v_qty_bad     integer;
BEGIN
  -- 1. Idempotency FIRST, before the lock check. A repeat request must be able
  --    to answer "already recorded" even while desktop holds the book --
  --    refusing it there would push a client into retrying a write that has
  --    already succeeded.
  SELECT s.obj_guid INTO v_existing
    FROM slots s WHERE s.name = 'mgc_req_id' AND s.string_val = p_request_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded', 'tx_guid', v_existing);
  END IF;

  -- 2. Load and validate both accounts.
  SELECT a.guid, a.name, a.account_type, a.commodity_guid, a.commodity_scu,
         COALESCE(a.placeholder,0) AS placeholder, c.mnemonic
    INTO v_from
    FROM accounts a LEFT JOIN commodities c ON c.guid = a.commodity_guid
   WHERE a.guid = p_from_guid;
  IF v_from.guid IS NULL THEN
    RAISE EXCEPTION 'Source account not found: %', p_from_guid USING ERRCODE = 'no_data_found';
  END IF;

  SELECT a.guid, a.name, a.account_type, a.commodity_guid, a.commodity_scu,
         COALESCE(a.placeholder,0) AS placeholder, c.mnemonic
    INTO v_to
    FROM accounts a LEFT JOIN commodities c ON c.guid = a.commodity_guid
   WHERE a.guid = p_to_guid;
  IF v_to.guid IS NULL THEN
    RAISE EXCEPTION 'Destination account not found: %', p_to_guid USING ERRCODE = 'no_data_found';
  END IF;

  IF p_from_guid = p_to_guid THEN
    RAISE EXCEPTION 'Source and destination are the same account (%).', v_from.name;
  END IF;
  IF v_from.placeholder = 1 THEN
    RAISE EXCEPTION '% is a placeholder account and cannot hold transactions.', v_from.name;
  END IF;
  IF v_to.placeholder = 1 THEN
    RAISE EXCEPTION '% is a placeholder account and cannot hold transactions.', v_to.name;
  END IF;

  -- CREDIT and LIABILITY are excluded deliberately: moving money "from" a
  -- credit card is a cash advance with different semantics, and quietly
  -- treating it as a transfer would misstate it. Say so rather than guess.
  IF v_from.account_type NOT IN ('BANK','CASH','ASSET') THEN
    RAISE EXCEPTION 'Transfers are only supported between asset accounts. % is %.',
      v_from.name, v_from.account_type;
  END IF;
  IF v_to.account_type NOT IN ('BANK','CASH','ASSET') THEN
    RAISE EXCEPTION 'Transfers are only supported between asset accounts. % is %.',
      v_to.name, v_to.account_type;
  END IF;

  IF p_from_amount IS NULL OR p_from_amount <= 0 THEN
    RAISE EXCEPTION 'Amount sent must be greater than zero.';
  END IF;
  IF p_to_amount IS NULL OR p_to_amount <= 0 THEN
    RAISE EXCEPTION 'Amount received must be greater than zero.';
  END IF;

  v_cross := v_from.commodity_guid IS DISTINCT FROM v_to.commodity_guid;
  v_rate  := p_to_amount / p_from_amount;

  IF NOT v_cross AND p_from_amount <> p_to_amount THEN
    RAISE EXCEPTION
      'Both accounts are in %, so the amounts must match (got % and %).',
      v_from.mnemonic, p_from_amount, p_to_amount;
  END IF;

  -- A fat-fingered amount otherwise writes a plausible-looking entry that only
  -- desktop can fix. This app has no delete, so refusing is the kinder failure.
  IF v_cross AND (v_rate < 1e-9 OR v_rate > 1e9) THEN
    RAISE EXCEPTION
      'That implies an exchange rate of % % per %, which looks wrong. Check the amounts.',
      round(v_rate, 6), v_to.mnemonic, v_from.mnemonic;
  END IF;

  -- 3. Now the lock check, immediately before the first write.
  PERFORM mgc_assert_unlocked();

  -- 4. Resolve trading accounts if the book uses them.
  v_trading := v_cross AND mgc_uses_trading_accounts();
  IF v_trading THEN
    v_tr_from := mgc_trading_account(v_from.commodity_guid);
    v_tr_to   := mgc_trading_account(v_to.commodity_guid);
    -- Refuse rather than create. A trading account is machinery the user has no
    -- basis to review, and creating accounts without an explicit tap is a line
    -- this project does not cross.
    IF v_tr_from IS NULL OR v_tr_to IS NULL THEN
      RAISE EXCEPTION
        'Your book uses trading accounts but has none for %. Make one %/% transfer in GnuCash desktop -- it creates these automatically -- and this will work from your phone afterwards.',
        COALESCE(CASE WHEN v_tr_from IS NULL THEN v_from.mnemonic END, v_to.mnemonic),
        v_from.mnemonic, v_to.mnemonic;
    END IF;
  END IF;

  -- 5. Amounts as integer numerators, each against its OWN account's scu.
  v_from_num  := round(p_from_amount * v_from.commodity_scu);
  v_to_num    := round(p_to_amount   * v_to.commodity_scu);
  v_val_denom := v_from.commodity_scu;   -- value is in the transaction currency

  IF v_from_num = 0 OR v_to_num = 0 THEN
    RAISE EXCEPTION 'Amount rounds to zero at this currency''s precision.';
  END IF;

  -- 6. Header. Transaction currency is the SOURCE account's commodity, and
  --    post_date uses GnuCash's timezone-neutral 10:59 (see mgc_neutral_ts).
  v_tx := mgc_new_guid('tx');
  INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
  VALUES (v_tx, v_from.commodity_guid, '', mgc_neutral_ts(p_post_date), now(),
          COALESCE(p_description, ''));

  -- 7. Splits.
  v_g := mgc_new_guid('s1');  v_guids := v_guids || v_g;
  INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                      reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
  VALUES (v_g, v_tx, v_from.guid, '', '', 'n', NULL,
          -v_from_num, v_val_denom, -v_from_num, v_from.commodity_scu, NULL);

  IF v_trading THEN
    v_g := mgc_new_guid('s2');  v_guids := v_guids || v_g;
    INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                        reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
    VALUES (v_g, v_tx, v_tr_from, '', '', 'n', NULL,
             v_from_num, v_val_denom,  v_from_num, v_from.commodity_scu, NULL);

    v_g := mgc_new_guid('s3');  v_guids := v_guids || v_g;
    INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                        reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
    VALUES (v_g, v_tx, v_tr_to, '', '', 'n', NULL,
            -v_from_num, v_val_denom, -v_to_num,   v_to.commodity_scu, NULL);
  END IF;

  v_g := mgc_new_guid('s4');  v_guids := v_guids || v_g;
  INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                      reconcile_date, value_num, value_denom, quantity_num, quantity_denom, lot_guid)
  VALUES (v_g, v_tx, v_to.guid, '', '', 'n', NULL,
           v_from_num, v_val_denom,  v_to_num,   v_to.commodity_scu, NULL);

  -- 8. Idempotency marker, plus the date-posted slot desktop writes on every
  --    transaction, so these rows are indistinguishable from hand-entered ones.
  INSERT INTO slots (obj_guid, name, slot_type, string_val)
  VALUES (v_tx, 'mgc_req_id', 4, p_request_id);

  INSERT INTO slots (obj_guid, name, slot_type, timespec_val, gdate_val)
  VALUES (v_tx, 'date-posted', 10, '1970-01-01 00:00:00', p_post_date);

  -- 9. Assert the invariants BEFORE returning. Any failure raises, and because
  --    PostgREST runs each request in one transaction, the whole thing rolls
  --    back rather than leaving an unbalanced entry in the book. This is the
  --    difference between "we computed it carefully" and "it cannot be wrong".
  SELECT sum(value_num::numeric / value_denom) INTO v_val_sum
    FROM splits WHERE tx_guid = v_tx;
  IF v_val_sum <> 0 THEN
    RAISE EXCEPTION 'Refusing to write: splits do not balance (value sums to %).', v_val_sum;
  END IF;

  IF v_trading THEN
    SELECT count(*) INTO v_qty_bad FROM (
      SELECT a.commodity_guid, sum(s.quantity_num::numeric / s.quantity_denom) AS q
        FROM splits s JOIN accounts a ON a.guid = s.account_guid
       WHERE s.tx_guid = v_tx GROUP BY a.commodity_guid HAVING sum(s.quantity_num::numeric / s.quantity_denom) <> 0
    ) bad;
    IF v_qty_bad > 0 THEN
      RAISE EXCEPTION 'Refusing to write: % commodity/ies do not net to zero.', v_qty_bad;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status',        'recorded',
    'tx_guid',       v_tx,
    'form',          CASE WHEN v_trading THEN 'trading' ELSE 'simple' END,
    'cross_currency', v_cross,
    'from_currency', v_from.mnemonic,
    'to_currency',   v_to.mnemonic,
    'derived_rate',  CASE WHEN v_cross THEN round(v_rate, 10)::float8 ELSE NULL END,
    'split_guids',   to_jsonb(v_guids)
  );
END;
$FN$;

ALTER FUNCTION public.mgc_transfer(text, varchar, numeric, varchar, numeric, date, text)
  OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_transfer(text, varchar, numeric, varchar, numeric, date, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_transfer(text, varchar, numeric, varchar, numeric, date, text)
  TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
