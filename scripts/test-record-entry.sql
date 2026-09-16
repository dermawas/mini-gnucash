-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Exercises mgc_record_entry against a real book, inside a transaction that
-- is ROLLED BACK, so it can be run against the dev clone without leaving
-- anything behind.
--
--   sudo -u postgres psql -d gnucash_clone -f scripts/test-record-entry.sql
--
-- NOT a migration -- deliberately outside sql/ and unnumbered so it cannot be
-- applied by mistake alongside the schema files.
--
-- The GUIDs below come from this book. On another book, re-resolve them.
--
-- Seven cases must succeed, nine must be refused. The successes are the four
-- shapes the old mgc_record_transaction could not express -- a discount
-- running against the entry, two funding accounts, a negative expense, and a
-- transfer carrying a fee -- plus the ordinary spend, which must keep working
-- exactly as before.

\set ON_ERROR_STOP off
\pset pager off
\timing off

BEGIN;

\set bank    '''83090c9e3f314d85bb86b05054a50b95'''
\set wallet  '''c15e080593aa4c6abed255fb8406f647'''
\set expense '''f2fc095c6fdf432aa2b7a9f05a8bbcf2'''
\set fee     '''0faf868ee9134f6bacebe7165c0b3d07'''
\set income  '''cab71b5e1bff4e518f0de85f6ad33e09'''
\set stock   '''49edca00612e4b2a8b47b0bd5d7fcfcf'''
\set usd     '''929d804ea9984c0686338786dd3b7e6e'''
\set ph      '''a8c135c6daec41b1b78f7c7a9a4679c8'''
\set trading '''4d42437f7fdc48c9857d1cf1e919adf9'''

\echo '=============== SHOULD SUCCEED ==============='

\echo '--- 1. ordinary spend: one funder (balancer) + one line'
SELECT mgc_record_entry('t1', jsonb_build_array(
  jsonb_build_object('account_guid', :expense, 'amount', 100000, 'memo', 'jajan'),
  jsonb_build_object('account_guid', :bank)
), DATE '2026-09-08', 'T1 ordinary spend')->>'status' AS status;

\echo '--- 2. the real 2026-08-16 shape: topup + fee, funder balances'
SELECT mgc_record_entry('t2', jsonb_build_array(
  jsonb_build_object('account_guid', :expense, 'amount', 100000),
  jsonb_build_object('account_guid', :fee,     'amount', 1000),
  jsonb_build_object('account_guid', :bank)
), DATE '2026-09-08', 'T2 topup with fee') AS result;
SELECT a.name, a.account_type, round(s.value_num::numeric/s.value_denom) amt
FROM splits s JOIN accounts a ON a.guid=s.account_guid
WHERE s.tx_guid=(SELECT obj_guid FROM slots WHERE name='mgc_req_id' AND string_val='t2')
ORDER BY amt DESC;

\echo '--- 3. discount running the OTHER WAY inside an outflow (the 110 case)'
SELECT mgc_record_entry('t3', jsonb_build_array(
  jsonb_build_object('account_guid', :expense, 'amount', 100000),
  jsonb_build_object('account_guid', :income,  'amount', -500, 'memo', 'promo'),
  jsonb_build_object('account_guid', :bank)
), DATE '2026-09-08', 'T3 with discount') AS result;
SELECT a.name, a.account_type, round(s.value_num::numeric/s.value_denom) amt
FROM splits s JOIN accounts a ON a.guid=s.account_guid
WHERE s.tx_guid=(SELECT obj_guid FROM slots WHERE name='mgc_req_id' AND string_val='t3')
ORDER BY amt DESC;

\echo '--- 4. TWO funding accounts, every amount supplied (the 74 case)'
SELECT mgc_record_entry('t4', jsonb_build_array(
  jsonb_build_object('account_guid', :expense, 'amount', 100000),
  jsonb_build_object('account_guid', :bank,    'amount', -60000),
  jsonb_build_object('account_guid', :wallet,  'amount', -40000)
), DATE '2026-09-08', 'T4 two funders')->>'status' AS status;

\echo '--- 5. negative EXPENSE, a waived fee (the 221 case)'
SELECT mgc_record_entry('t5', jsonb_build_array(
  jsonb_build_object('account_guid', :expense, 'amount', 100000),
  jsonb_build_object('account_guid', :fee,     'amount', -400, 'memo', 'fee waived'),
  jsonb_build_object('account_guid', :bank)
), DATE '2026-09-08', 'T5 waived fee')->>'status' AS status;

\echo '--- 6. a TRANSFER WITH A FEE -- the question that started all this'
SELECT mgc_record_entry('t6', jsonb_build_array(
  jsonb_build_object('account_guid', :wallet, 'amount', 100000),
  jsonb_build_object('account_guid', :fee,    'amount', 500, 'memo', 'admin'),
  jsonb_build_object('account_guid', :bank)
), DATE '2026-09-08', 'T6 transfer with fee') AS result;
SELECT a.name, a.account_type, round(s.value_num::numeric/s.value_denom) amt
FROM splits s JOIN accounts a ON a.guid=s.account_guid
WHERE s.tx_guid=(SELECT obj_guid FROM slots WHERE name='mgc_req_id' AND string_val='t6')
ORDER BY amt DESC;

\echo '--- 7. idempotency: replaying t1 must not write again'
SELECT mgc_record_entry('t1', jsonb_build_array(
  jsonb_build_object('account_guid', :expense, 'amount', 999),
  jsonb_build_object('account_guid', :bank)
), DATE '2026-09-08', 'T7 replay')->>'status' AS status;

\echo '--- every entry written above balances to exactly zero? ---'
SELECT count(*) AS entries, sum(bad) AS unbalanced FROM (
  SELECT s.tx_guid, CASE WHEN sum(s.value_num::numeric/s.value_denom)<>0 THEN 1 ELSE 0 END AS bad
  FROM splits s WHERE s.tx_guid IN
    (SELECT obj_guid FROM slots WHERE name='mgc_req_id' AND string_val IN ('t1','t2','t3','t4','t5','t6'))
  GROUP BY s.tx_guid) q;

\echo ''
\echo '=============== SHOULD BE REFUSED ==============='

DO $$ BEGIN PERFORM mgc_record_entry('x1', jsonb_build_array(
  jsonb_build_object('account_guid','49edca00612e4b2a8b47b0bd5d7fcfcf','amount',1000),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95')),
  DATE '2026-09-08','x'); RAISE NOTICE 'X1 security         : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X1 security         : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x2', jsonb_build_array(
  jsonb_build_object('account_guid','929d804ea9984c0686338786dd3b7e6e','amount',10),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95')),
  DATE '2026-09-08','x'); RAISE NOTICE 'X2 cross-currency   : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X2 cross-currency   : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x3', jsonb_build_array(
  jsonb_build_object('account_guid','a8c135c6daec41b1b78f7c7a9a4679c8','amount',1000),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95')),
  DATE '2026-09-08','x'); RAISE NOTICE 'X3 placeholder      : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X3 placeholder      : %', SQLERRM; END $$;

-- The trading account MUST be a postable one in a CURRENCY namespace.
-- The first version of this test used a placeholder trading account and was
-- therefore refused by the placeholder check, leaving the trading guard
-- untested and looking green.
DO $$
DECLARE g varchar(32);
BEGIN
  SELECT a.guid INTO g FROM accounts a JOIN commodities c ON c.guid=a.commodity_guid
   WHERE a.account_type='TRADING' AND COALESCE(a.placeholder,0)=0
     AND c.namespace='CURRENCY' LIMIT 1;
  IF g IS NULL THEN RAISE NOTICE 'X4 trading account  : SKIPPED (no postable trading account)'; RETURN; END IF;
  PERFORM mgc_record_entry('x4', jsonb_build_array(
    jsonb_build_object('account_guid', g, 'amount', 1000),
    jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95')),
    DATE '2026-09-08','x');
  RAISE NOTICE 'X4 trading account  : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X4 trading account  : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x5', jsonb_build_array(
  jsonb_build_object('account_guid','f2fc095c6fdf432aa2b7a9f05a8bbcf2'),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95')),
  DATE '2026-09-08','x'); RAISE NOTICE 'X5 two balancers    : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X5 two balancers    : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x6', jsonb_build_array(
  jsonb_build_object('account_guid','f2fc095c6fdf432aa2b7a9f05a8bbcf2','amount',100000),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95','amount',-99999)),
  DATE '2026-09-08','x'); RAISE NOTICE 'X6 unbalanced       : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X6 unbalanced       : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x7', jsonb_build_array(
  jsonb_build_object('account_guid','f2fc095c6fdf432aa2b7a9f05a8bbcf2','amount',0),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95')),
  DATE '2026-09-08','x'); RAISE NOTICE 'X7 zero amount      : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X7 zero amount      : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x8', jsonb_build_array(
  jsonb_build_object('account_guid','f2fc095c6fdf432aa2b7a9f05a8bbcf2','amount',100)),
  DATE '2026-09-08','x'); RAISE NOTICE 'X8 single split     : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X8 single split     : %', SQLERRM; END $$;

DO $$ BEGIN PERFORM mgc_record_entry('x9', jsonb_build_array(
  jsonb_build_object('account_guid','f2fc095c6fdf432aa2b7a9f05a8bbcf2','amount',100000),
  jsonb_build_object('account_guid','83090c9e3f314d85bb86b05054a50b95','amount',-100000),
  jsonb_build_object('account_guid','0faf868ee9134f6bacebe7165c0b3d07')),
  DATE '2026-09-08','x'); RAISE NOTICE 'X9 balancer is zero : NOT REFUSED';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'X9 balancer is zero : %', SQLERRM; END $$;

ROLLBACK;

\echo ''
\echo '--- rolled back: dev book unchanged ---'
SELECT count(*) AS leftover_test_rows FROM slots
WHERE name='mgc_req_id' AND string_val IN ('t1','t2','t3','t4','t5','t6');
