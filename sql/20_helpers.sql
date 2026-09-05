-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Internal helpers. These are NOT granted to the app role -- they are only ever
-- called from inside a SECURITY DEFINER function, where the effective user is
-- already gnucash_owner.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/20_helpers.sql
--
-- Run as postgres (or as the current owner of each function, on a re-run).

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- mgc_new_guid -- GnuCash-format identifier
-- ---------------------------------------------------------------------------
-- GnuCash GUIDs are a random 128-bit value, hex-encoded, 32 lowercase chars.
-- There is no embedded algorithm or metadata, so an externally generated one is
-- indistinguishable from a desktop-generated one -- confirmed by this project's
-- predecessor writing thousands of rows that GnuCash desktop then read, edited
-- and re-saved without complaint.
--
-- The salt lets one statement mint several distinct guids in the same
-- clock_timestamp() tick.
CREATE OR REPLACE FUNCTION public.mgc_new_guid(p_salt text)
RETURNS varchar(32)
LANGUAGE sql VOLATILE AS $$
  SELECT md5(gen_random_uuid()::text || clock_timestamp()::text || p_salt)::varchar(32);
$$;

REVOKE ALL ON FUNCTION public.mgc_new_guid(text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- mgc_neutral_ts -- GnuCash's timezone-neutral posting time
-- ---------------------------------------------------------------------------
-- GnuCash writes post_date at 10:59:00, not midnight. The reason is that
-- 10:59 UTC lands on the same calendar date in every timezone from roughly
-- UTC-11 to UTC+13, so a transaction dated "3 September" reads as 3 September
-- wherever the book is opened.
--
-- Passing a bare date instead casts to 00:00:00, which in UTC+7 can render as
-- the PREVIOUS day. That is a real, shipped bug in this project's predecessor:
-- of its 35 transactions, the 32 never subsequently touched in desktop all sit
-- at 00:00:00 while all 9,640 desktop-written rows sit at 10:59:00.
--
-- Every write path in this project goes through here.
CREATE OR REPLACE FUNCTION public.mgc_neutral_ts(p_date date)
RETURNS timestamp
LANGUAGE sql IMMUTABLE AS $$
  SELECT p_date::timestamp + interval '10 hours 59 minutes';
$$;

REVOKE ALL ON FUNCTION public.mgc_neutral_ts(date) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- mgc_assert_unlocked -- refuse to write while GnuCash desktop holds the book
-- ---------------------------------------------------------------------------
-- gnclock is desktop's own advisory lock table: it writes a row on open and
-- removes it on clean close.
--
-- This check is coarse and race-prone, and saying so plainly matters. It knows
-- "the book is open by someone", not "that someone is editing this exact
-- transaction", and it cannot see an unsaved edit sitting in desktop's UI.
-- What it does buy, for almost nothing, is preventing the worst case: writing
-- into a book that desktop has loaded into memory and will later save over the
-- top of.
--
-- A crashed desktop leaves a stale row behind, which blocks every write until
-- someone runs `DELETE FROM gnclock;`. That is annoying but strictly the safe
-- direction to fail in.
--
-- PLACEMENT RULE: call this AFTER the idempotency lookup and BEFORE the first
-- INSERT or UPDATE. A repeat request must still be able to answer
-- "already recorded" while the book is open -- refusing that would push a
-- client into retrying a write that already succeeded.
CREATE OR REPLACE FUNCTION public.mgc_assert_unlocked()
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_host varchar(255);
BEGIN
  SELECT hostname INTO v_host FROM gnclock LIMIT 1;
  IF v_host IS NOT NULL THEN
    RAISE EXCEPTION
      'GnuCash desktop currently has this book open (locked from %). Close it there and try again.',
      v_host
      USING ERRCODE = 'lock_not_available';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.mgc_assert_unlocked() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- mgc_uses_trading_accounts -- read the book option, do not assume
-- ---------------------------------------------------------------------------
-- This single boolean decides whether a cross-currency transfer is written as
-- 2 splits or 4. Getting it wrong is not silent corruption, but it is wrong
-- both ways:
--
--   option ON  + 2-split written  -> GnuCash sees an unbalanced transaction and
--                                    injects trading splits itself on next edit
--   option OFF + 4-split written  -> the transaction balances, but two trading
--                                    splits appear that the user never asked for
--
-- Detected at call time rather than baked in as a constant, so that flipping
-- the option in desktop later does not silently start producing wrong writes.
--
-- Note the *existence* of Trading:* accounts is not the answer -- GnuCash
-- auto-creates those whenever it needs to balance a cross-currency entry, which
-- can happen with the option off. The book option slot is the answer.
CREATE OR REPLACE FUNCTION public.mgc_uses_trading_accounts()
RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_val text;
BEGIN
  -- Query by fully-qualified name, NOT by joining to books.guid.
  -- GnuCash KVP slots form a nested tree: the top-level "options" frame
  -- (slot_type 9) hangs off the book guid, but "options/Accounts" hangs off
  -- THAT slot's own generated guid, and the leaf value hangs off that one's.
  -- So a books join finds the frame and never reaches the value -- it silently
  -- returns NULL, which COALESCEs to false, which would write 2-split
  -- transfers into a book that needs 4. Verified: each fully-qualified
  -- "options/..." name occurs exactly once per book, so name alone is safe.
  SELECT s.string_val INTO v_val
    FROM slots s
   WHERE s.name = 'options/Accounts/Use Trading Accounts'
   LIMIT 1;

  -- GnuCash omits the slot entirely when the option has never been enabled,
  -- and its default is off.
  RETURN COALESCE(v_val, 'f') IN ('t', 'true', '1');
END;
$$;

REVOKE ALL ON FUNCTION public.mgc_uses_trading_accounts() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- mgc_trading_account -- resolve the trading account for one commodity
-- ---------------------------------------------------------------------------
-- With trading accounts enabled, GnuCash keeps one trading account per
-- commodity at Trading:<namespace>:<mnemonic>, e.g. Trading:CURRENCY:USD.
--
-- Matching on commodity_guid alone is NOT sufficient, and the failure is silent
-- and serious -- it would write the balancing splits into the wrong account.
-- Two things make it ambiguous in a real book:
--
--   1. The container accounts (Trading, Trading:CURRENCY, Trading:CRYPTO, ...)
--      all carry the book's DEFAULT commodity, so on an IDR book five separate
--      TRADING accounts match commodity = IDR. They are excluded by
--      placeholder = 1, which is what marks them as containers.
--   2. A book can hold the same commodity in more than one branch. This
--      project's own book has Trading:CRYPTO:BTC and Trading:FUND:BTC, both
--      non-placeholder, both commodity BTC.
--
-- Anchoring on parent.name = commodity.namespace resolves both, and was
-- verified to return exactly one row for every commodity in a 402-account book.
--
-- Deliberately NOT matched on account name = mnemonic: that looks equivalent
-- but breaks on renamed accounts. This book has an account named 'LUNA' holding
-- the LUNC commodity, which a name match would miss entirely.
--
-- Returns NULL when the book has no trading account for that commodity yet.
-- Callers must treat NULL as "refuse and explain", NEVER as "create one" --
-- see the note in 40_write_rpcs.sql.
CREATE OR REPLACE FUNCTION public.mgc_trading_account(p_commodity_guid varchar(32))
RETURNS varchar(32)
LANGUAGE sql STABLE AS $BODY$
  SELECT a.guid
    FROM accounts a
    JOIN commodities c ON c.guid = a.commodity_guid
    JOIN accounts p    ON p.guid = a.parent_guid
   WHERE a.account_type = 'TRADING'
     AND a.commodity_guid = p_commodity_guid
     AND COALESCE(a.placeholder, 0) = 0
     AND p.name = c.namespace
   LIMIT 1;
$BODY$;

REVOKE ALL ON FUNCTION public.mgc_trading_account(varchar) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- mgc_root_guid -- the real root account, not the template root
-- ---------------------------------------------------------------------------
-- A GnuCash book normally contains TWO accounts of type ROOT: the real tree,
-- and "Template Root" which holds scheduled-transaction templates. Walking
-- parents without knowing that pulls template accounts into the account picker
-- and lets a new account be parented into the template tree.
--
-- Identified by which root actually has a commodity: the template root's
-- commodity_guid is NULL.
CREATE OR REPLACE FUNCTION public.mgc_root_guid()
RETURNS varchar(32)
LANGUAGE sql STABLE AS $$
  SELECT guid FROM accounts
   WHERE account_type = 'ROOT' AND commodity_guid IS NOT NULL
   ORDER BY guid
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.mgc_root_guid() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- Ownership. Not optional.
-- ---------------------------------------------------------------------------
-- These helpers are called from inside SECURITY DEFINER functions owned by
-- gnucash_owner. Inside such a function the effective user is the OWNER, not
-- the caller -- so gnucash_owner needs the right to execute them.
--
-- Because every helper above is REVOKEd from PUBLIC, leaving them owned by
-- postgres makes them uncallable by gnucash_owner, and the failure is not
-- obvious: it surfaces as "permission denied for function
-- mgc_uses_trading_accounts" raised from the middle of mgc_ping(), which
-- reads like a bug in ping. Making gnucash_owner the owner gives it implicit
-- EXECUTE and keeps PUBLIC locked out.
ALTER FUNCTION public.mgc_new_guid(text)              OWNER TO gnucash_owner;
ALTER FUNCTION public.mgc_neutral_ts(date)            OWNER TO gnucash_owner;
ALTER FUNCTION public.mgc_assert_unlocked()           OWNER TO gnucash_owner;
ALTER FUNCTION public.mgc_uses_trading_accounts()     OWNER TO gnucash_owner;
ALTER FUNCTION public.mgc_trading_account(varchar)    OWNER TO gnucash_owner;
ALTER FUNCTION public.mgc_root_guid()                 OWNER TO gnucash_owner;
