-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Phase 0: interrogate the book before writing anything to it.
--
-- These are all READ-ONLY. Run them against your own GnuCash database before
-- installing anything else in this directory:
--
--     sudo -u postgres psql -d gnucash -f sql/00_verify.sql
--
-- Every answer below the "RESULT" markers was recorded against the maintainer's
-- own book on 2026-09-05 (402 accounts, ~9,600 transactions, ~22,700 splits).
-- Your book will differ. The point of running these is that several design
-- decisions in this project depend on the answers, and guessing them wrong is
-- silent rather than loud.
--
-- ===========================================================================

\echo '=== Q1. Are trading accounts enabled? THE most consequential question. ==='
-- Decides whether a cross-currency transfer is 2 splits or 4. See 40_write_rpcs.sql.
-- The book option is the answer. The existence of Trading:* accounts is only a
-- hint, because GnuCash auto-creates them whenever it needs to balance something.
SELECT s.name, s.slot_type, s.string_val
  FROM books b
  JOIN slots s ON s.obj_guid = b.guid
 WHERE s.name LIKE 'options%'
 ORDER BY s.name;
-- RESULT: options/Accounts/Use Trading Accounts | 4 | t     -> ENABLED (4-split form)
-- RESULT: 37 accounts of account_type = 'TRADING' also present.

\echo '=== Q1b. The gold reference: what does desktop itself write for a cross-currency transfer? ==='
-- Copy this shape rather than reasoning from first principles.
SELECT t.guid, t.post_date, t.description, count(DISTINCT a.commodity_guid) AS n_currencies
  FROM transactions t
  JOIN splits s   ON s.tx_guid = t.guid
  JOIN accounts a ON a.guid = s.account_guid
 GROUP BY 1,2,3
HAVING count(DISTINCT a.commodity_guid) > 1
 ORDER BY t.post_date DESC
 LIMIT 10;

-- Then dump one in full (substitute a guid from above):
--   SELECT a.name, a.account_type, c.mnemonic, a.commodity_scu,
--          s.value_num, s.value_denom, s.quantity_num, s.quantity_denom
--     FROM splits s
--     JOIN accounts a    ON a.guid = s.account_guid
--     JOIN commodities c ON c.guid = a.commodity_guid
--    WHERE s.tx_guid = '<guid>';
--
-- RESULT (tx 9da8807c29744a88ae51e2fbbcfa468d, "Sell to IDR", 2026-09-02,
--         $3,155.80 -> Rp 56,081,722, tx currency = USD):
--
--   Jenius (USD)  BANK/USD     value  -315580/100   quantity  -315580/100
--   Trading:USD   TRADING/USD  value  +315580/100   quantity  +315580/100
--   Trading:IDR   TRADING/IDR  value  -315580/100   quantity  -5608172200/100
--   Jenius (IDR)  BANK/IDR     value  +315580/100   quantity  +5608172200/100
--
--   value  is in the TRANSACTION currency on every split, and sums to zero.
--   quantity is in each split's OWN account commodity, and sums to zero
--   independently PER COMMODITY.
--   Confirmed in reverse (IDR -> USD) on tx 36eae5a3de4d4a86bab95d00d5eab1a7.

\echo '=== Q2. What does desktop actually write into the nullable accounts columns? ==='
-- create_account must match this, not guess. A NULL where desktop writes ''
-- will not error but may render oddly.
SELECT count(*) AS total,
       count(*) FILTER (WHERE code IS NULL)        AS code_null,
       count(*) FILTER (WHERE code = '')           AS code_empty,
       count(*) FILTER (WHERE description IS NULL) AS desc_null,
       count(*) FILTER (WHERE description = '')    AS desc_empty,
       count(*) FILTER (WHERE hidden IS NULL)      AS hidden_null,
       count(*) FILTER (WHERE placeholder IS NULL) AS ph_null
  FROM accounts;
-- RESULT: 402 total, ZERO nulls in any of them.
--         -> code = '', description = '', hidden = 0, placeholder = 0.

SELECT non_std_scu, count(*) FROM accounts GROUP BY 1 ORDER BY 1;
-- RESULT: 0 -> 401 rows, 1 -> 1 row.  So non_std_scu = 0 is correct.

SELECT count(*) AS names_containing_colon FROM accounts WHERE name LIKE '%:%';
-- RESULT: 0. ':' is GnuCash's account separator; refusing it in a name is safe.

\echo '=== Q3. Can commodity_scu be derived from the commodity fraction? ==='
SELECT a.commodity_scu, c.fraction, c.mnemonic, count(*)
  FROM accounts a
  JOIN commodities c ON c.guid = a.commodity_guid
 GROUP BY 1,2,3
 ORDER BY 3;
-- RESULT: commodity_scu = fraction in ALL 24 groups. Deriving it is correct.
--         Range is wide and hardcoding any of it would be a serious bug:
--           stocks (GOTO, MTEL, bbca.jk)  = 1
--           currencies (IDR USD SGD ...)  = 100
--           XAU (gold)                    = 1,000,000
--           crypto (BTC ETH USDT ...)     = 100,000,000

\echo '=== Q4. post_date time-of-day convention ==='
SELECT post_date::time AS time_of_day, count(*)
  FROM transactions GROUP BY 1 ORDER BY 2 DESC;
-- RESULT: 10:59:00 -> 9,640    (GnuCash's timezone-neutral time)
--         00:00:00 ->    32    (all written by Ledgerize, which passed a bare date)
-- A bare date casts to 00:00:00, which in UTC+7 can render as the PREVIOUS day.
-- Every write RPC here emits 10:59:00. See pocket_neutral_ts() in 20_helpers.sql.

\echo '=== Q5. reconcile_date convention per reconcile_state ==='
SELECT reconcile_state,
       count(*) AS n,
       count(*) FILTER (WHERE reconcile_date = '1970-01-01 00:00:00') AS epoch_rows,
       count(*) FILTER (WHERE reconcile_date IS NULL) AS null_rows,
       min(reconcile_date) AS earliest, max(reconcile_date) AS latest
  FROM splits GROUP BY 1 ORDER BY 1;
-- RESULT: 'c' -> 1,812 rows, 1,799 at epoch, real dates never used
--         'n' -> 18,699 rows, 18,591 at epoch, 100 null
--         'y' -> 2,254 rows, ALL carrying real dates (2022-2024)
-- So reconcile_date is only meaningful for 'y'. pocket_set_split_cleared
-- therefore LEAVES IT ALONE when flipping n <-> c. Do not "helpfully" set it.

\echo '=== Q6. Do splits carry their own slots? ==='
SELECT 'split slots' AS kind, count(*) FROM slots s JOIN splits   sp ON sp.guid = s.obj_guid
UNION ALL
SELECT 'account slots',       count(*) FROM slots s JOIN accounts a  ON a.guid  = s.obj_guid;
-- RESULT: split slots = 0. Only transactions and accounts carry slots.

\echo '=== Q7. The imbalance canary: baseline before any write ==='
-- GnuCash auto-creates these when it cannot balance something. Snapshot the
-- split counts now; any increase after a write RPC is proof the write was wrong.
SELECT a.name, a.account_type, count(sp.guid) AS splits
  FROM accounts a
  LEFT JOIN splits sp ON sp.account_guid = a.guid
 WHERE a.name ILIKE 'Imbalance%' OR a.name ILIKE 'Orphan%'
 GROUP BY 1,2 ORDER BY 1;
-- RESULT: 7 accounts (Imbalance-USD/IDR/CNY/XAU, Orphan-IDR/CNY/XAU),
--         ALL WITH ZERO SPLITS. A perfectly clean book, which makes this the
--         crispest available regression check.

\echo '=== Q8. Roots. There is normally more than one. ==='
SELECT guid, name, account_type FROM accounts WHERE account_type = 'ROOT';
-- RESULT: 'Root Account'  89fab298edc14f88b859a8f46b6d49e9  <- the real tree
--         'Template Root' 18e207a1bcc542aaa66f6904e436320d  <- scheduled-txn templates
-- pocket_get_accounts() must EXCLUDE the Template Root subtree, and
-- pocket_create_account() must never parent under either root directly.

\echo '=== Q9. Existing grants and sequences ==='
SELECT grantee, table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.table_privileges
 WHERE table_name IN ('accounts','splits','transactions','slots','commodities',
                      'gnclock','books','prices','versions')
   AND grantee NOT IN ('postgres','PUBLIC')
 GROUP BY 1,2 ORDER BY 1,2;

SELECT sequence_name,
       has_sequence_privilege('gnucash_owner', 'public.'||sequence_name, 'USAGE')  AS owner_usage,
       has_sequence_privilege('gnucash_owner', 'public.'||sequence_name, 'SELECT') AS owner_select
  FROM information_schema.sequences WHERE sequence_schema = 'public';
-- RESULT: gnucash_owner already has USAGE+SELECT on slots_id_seq. Good --
--         inserting a slot needs it, and a missing sequence grant has bitten
--         this project before.
--         gnucash_owner was MISSING: INSERT on accounts, UPDATE on splits,
--         and any grant at all on commodities and books. 10_roles_and_grants.sql
--         adds exactly those four.
