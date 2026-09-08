-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- mgc_record_entry -- one single-currency entry as N splits over accounts of
-- any type.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/46_record_entry.sql
--
-- ---------------------------------------------------------------------------
-- Why this exists alongside mgc_record_transaction
-- ---------------------------------------------------------------------------
-- `mgc_record_transaction` takes ONE funding account, ONE direction, and a
-- list of category lines that must all be the same account type. Reading the
-- production book on 2026-09-08 showed how much that shape cannot express:
--
--   110 entries carry a Direct Discount INCOME split inside an outflow
--   221 entries carry a negative EXPENSE split (a refund, or a waived fee)
--    74 entries are funded from MORE THAN ONE account
--
-- and a transfer fee, which had been treated as its own feature, turned out to
-- be an ordinary expense split sitting beside the two asset legs. GnuCash has
-- no notion of a "spend" or a "transfer": a transaction is a set of splits
-- that sum to zero, and every distinction past that was this app's invention.
--
-- So this function records the general shape and lets the account types say
-- what the entry means, rather than the caller declaring it up front.
--
-- ---------------------------------------------------------------------------
-- Signed amounts, and why the old positive-only rule is not kept
-- ---------------------------------------------------------------------------
-- `mgc_record_transaction` deliberately takes positive amounts and derives
-- every sign from `p_direction`, so the client never does sign arithmetic.
-- That is the right call when there IS one direction. Here there is not: an
-- entry can hold a funding split, several expense lines and a discount that
-- runs the other way, and no single flag describes them.
--
-- The alternative considered was a per-split word ('in'/'out'). It was
-- rejected because it invents a second vocabulary for something the data model
-- already expresses: a split has a signed value, and inventing a parallel
-- notion means translating twice and being wrong in a new way. What IS kept is
-- the guarantee that mattered -- see the balancing split below.
--
-- ---------------------------------------------------------------------------
-- The balancing split keeps balance proven by construction
-- ---------------------------------------------------------------------------
-- The old function cannot write an unbalanced entry, because the funding split
-- is the negated sum of the ALREADY-ROUNDED line numerators rather than a
-- rounding of the summed amount. That is a real safety property and this app
-- has no edit and no delete, so it is not given up lightly.
--
-- It is kept: exactly one split MAY omit `amount`, and that split is computed
-- as the negation of everything else, at the currency's precision. For the
-- ordinary "one funder, some lines" entry the guarantee is therefore identical
-- to before. When every amount is supplied, the sum is checked instead and the
-- entry is refused if it does not come to zero -- refusing, never adjusting.
--
-- ---------------------------------------------------------------------------
-- Scope: currency accounts, one commodity
-- ---------------------------------------------------------------------------
-- Securities are excluded, and that exclusion is ONE GUARD rather than an
-- assumption spread through the function -- because they are out of scope, not
-- out of model. GnuCash gives every split a `value` (in the transaction's
-- currency) and a `quantity` (in the account's own commodity). Those two are
-- equal exactly when the account is in the entry's own currency, which is why
-- this function can derive quantity from value. Cross-currency and securities
-- are the same single extension -- let quantity be stated per split -- and
-- when that day comes it is a new optional key here, not a new function.
--
-- Measured against the production book: 9,449 of 9,706 transactions (97.4%)
-- are single-currency with every account a CURRENCY account, and are therefore
-- writable by this function. 16 are cross-currency (mgc_transfer's job) and
-- 241 touch a stock, bond or crypto account and belong in GnuCash desktop.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.mgc_record_entry(
  p_request_id  text,
  -- [{"account_guid":..., "amount":<signed, optional on ONE split>, "memo":...}]
  -- amount is SIGNED and in the entry's currency: negative means money leaves
  -- that account. Omit it on exactly one split to have it balance the entry.
  p_splits      jsonb,
  p_post_date   date,
  p_description text,
  p_num         text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_existing    varchar(32);
  v_n           integer;
  v_split       jsonb;
  v_acct        record;
  v_idx         integer := 0;
  v_ccy         varchar(32);
  v_scu         bigint;
  v_ccy_name    text;
  v_amount      numeric;
  v_num         bigint;
  v_total       bigint := 0;          -- sum of the supplied numerators
  v_balancer    integer := NULL;      -- index of the split with no amount
  v_bal_guid    varchar(32);
  v_bal_memo    text := '';
  v_tx          varchar(32);
  v_g           varchar(32);
  v_guids       text[] := '{}';
  v_val_sum     numeric;
  v_nums        bigint[] := '{}';
  v_accts       varchar(32)[] := '{}';
  v_memos       text[] := '{}';
BEGIN
  IF jsonb_typeof(p_splits) <> 'array' THEN
    RAISE EXCEPTION 'Splits must be a list.';
  END IF;
  v_n := jsonb_array_length(p_splits);
  IF v_n < 2 THEN
    RAISE EXCEPTION 'An entry needs at least two splits; got %.', v_n;
  END IF;

  -- Idempotency BEFORE the lock check, so a repeat can still be answered while
  -- desktop holds the book. Refusing there would push a client into retrying a
  -- write that already succeeded.
  SELECT s.obj_guid INTO v_existing
    FROM slots s WHERE s.name = 'mgc_req_id' AND s.string_val = p_request_id
   LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'already_recorded', 'tx_guid', v_existing);
  END IF;

  -- ---------------------------------------------------------------------
  -- Pass 1: resolve and validate every account, and fix the entry currency
  -- from the first split. Nothing is written in this pass.
  -- ---------------------------------------------------------------------
  FOR v_split IN SELECT * FROM jsonb_array_elements(p_splits)
  LOOP
    v_idx := v_idx + 1;

    SELECT a.guid, a.name, a.account_type, a.commodity_guid, a.commodity_scu,
           COALESCE(a.placeholder, 0) AS placeholder,
           c.mnemonic, c.namespace
      INTO v_acct
      FROM accounts a LEFT JOIN commodities c ON c.guid = a.commodity_guid
     WHERE a.guid = (v_split->>'account_guid')::varchar(32);

    IF v_acct.guid IS NULL THEN
      RAISE EXCEPTION 'Split %: account not found.', v_idx USING ERRCODE = 'no_data_found';
    END IF;
    IF v_acct.placeholder = 1 THEN
      RAISE EXCEPTION 'Split %: % is a placeholder account and cannot hold transactions.',
        v_idx, v_acct.name;
    END IF;

    -- The securities guard. One place, by design: this single check is all
    -- that stands between this function and stocks, bonds and crypto, whose
    -- splits carry a quantity independent of their value.
    IF v_acct.namespace IS DISTINCT FROM 'CURRENCY' THEN
      RAISE EXCEPTION
        'Split %: % is held in % (%), not a currency. Stocks, bonds and crypto have a quantity separate from their value, so they belong in GnuCash desktop.',
        v_idx, v_acct.name, COALESCE(v_acct.mnemonic, '?'),
        COALESCE(v_acct.namespace, 'unknown');
    END IF;

    -- TRADING accounts are machinery GnuCash maintains for cross-currency
    -- entries. Nothing single-currency should ever name one, and writing to
    -- one by hand corrupts the book's own bookkeeping.
    IF v_acct.account_type = 'TRADING' THEN
      RAISE EXCEPTION 'Split %: % is a trading account, which this app never writes to directly.',
        v_idx, v_acct.name;
    END IF;
    IF v_acct.account_type NOT IN
       ('BANK','CASH','ASSET','CREDIT','LIABILITY','EXPENSE','INCOME') THEN
      RAISE EXCEPTION 'Split %: % is %, which this app does not post to.',
        v_idx, v_acct.name, v_acct.account_type;
    END IF;

    IF v_idx = 1 THEN
      v_ccy      := v_acct.commodity_guid;
      v_scu      := v_acct.commodity_scu;
      v_ccy_name := COALESCE(v_acct.mnemonic, '?');
    ELSE
      -- The same-currency gate. This is the check whose absence let a
      -- predecessor record Rp 191,400 as $191,400.00 against a USD account,
      -- with no error anywhere and a silently wrong ledger as the only
      -- evidence.
      IF v_acct.commodity_guid IS DISTINCT FROM v_ccy THEN
        RAISE EXCEPTION
          'Every account in one entry must share a currency. Split % (%) is in %, but the entry is in %. A movement between two currencies is a transfer, where you state both amounts.',
          v_idx, v_acct.name, COALESCE(v_acct.mnemonic, '?'), v_ccy_name;
      END IF;
      -- Same commodity with a different denominator would make the numerators
      -- below incomparable. It should be impossible; refuse rather than write
      -- something that silently does not add up.
      IF v_acct.commodity_scu IS DISTINCT FROM v_scu THEN
        RAISE EXCEPTION 'Split %: % records % to a different precision than the rest of the entry.',
          v_idx, v_acct.name, v_ccy_name;
      END IF;
    END IF;

    v_accts := v_accts || v_acct.guid;
    v_memos := v_memos || COALESCE(v_split->>'memo', '');

    IF v_split ? 'amount' AND jsonb_typeof(v_split->'amount') <> 'null' THEN
      v_amount := (v_split->>'amount')::numeric;
      IF v_amount = 0 THEN
        RAISE EXCEPTION 'Split % has an amount of zero. Leave the split out instead.', v_idx;
      END IF;
      v_num   := round(v_amount * v_scu);
      IF v_num = 0 THEN
        RAISE EXCEPTION 'Split % rounds to zero at %''s precision.', v_idx, v_ccy_name;
      END IF;
      v_nums  := v_nums || v_num;
      v_total := v_total + v_num;
    ELSE
      IF v_balancer IS NOT NULL THEN
        RAISE EXCEPTION
          'Only one split may be left without an amount, to balance the entry; splits % and % both were.',
          v_balancer, v_idx;
      END IF;
      v_balancer := v_idx;
      v_nums     := v_nums || 0::bigint;   -- placeholder, filled in below
    END IF;
  END LOOP;

  -- ---------------------------------------------------------------------
  -- Resolve the balance. Either one split absorbs it -- proven by
  -- construction, exactly as mgc_record_transaction derives its funding
  -- split -- or every amount was given and the total must already be zero.
  -- ---------------------------------------------------------------------
  IF v_balancer IS NOT NULL THEN
    IF v_total = 0 THEN
      RAISE EXCEPTION
        'The other splits already balance, so split % would be zero. Give it an amount or leave it out.',
        v_balancer;
    END IF;
    v_nums[v_balancer] := -v_total;
  ELSIF v_total <> 0 THEN
    RAISE EXCEPTION
      'The splits do not balance: they come to % %. Every entry must sum to zero, or leave one split without an amount to absorb the difference.',
      round(v_total::numeric / v_scu, 2), v_ccy_name;
  END IF;

  -- Now, and only now, the lock check -- immediately before the first write.
  PERFORM mgc_assert_unlocked();

  v_tx := mgc_new_guid('tx');
  INSERT INTO transactions (guid, currency_guid, num, post_date, enter_date, description)
  VALUES (v_tx, v_ccy, COALESCE(p_num, ''),
          mgc_neutral_ts(p_post_date), now(), COALESCE(p_description, ''));

  FOR v_idx IN 1 .. v_n LOOP
    v_g := mgc_new_guid('s' || v_idx::text);  v_guids := v_guids || v_g;
    -- quantity = value, because every account was proven above to be in the
    -- entry's own currency. This is the line that becomes a supplied value the
    -- day cross-currency or securities arrive.
    INSERT INTO splits (guid, tx_guid, account_guid, memo, action, reconcile_state,
                        reconcile_date, value_num, value_denom,
                        quantity_num, quantity_denom, lot_guid)
    VALUES (v_g, v_tx, v_accts[v_idx], v_memos[v_idx], '', 'n', NULL,
            v_nums[v_idx], v_scu,
            v_nums[v_idx], v_scu, NULL);
  END LOOP;

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
    'status',       'recorded',
    'tx_guid',      v_tx,
    'currency',     v_ccy_name,
    'split_count',  v_n,
    'balanced_by',  v_balancer,
    'split_guids',  to_jsonb(v_guids)
  );
END;
$FN$;

ALTER FUNCTION public.mgc_record_entry(text, jsonb, date, text, text)
  OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_record_entry(text, jsonb, date, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_record_entry(text, jsonb, date, text, text)
  TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
