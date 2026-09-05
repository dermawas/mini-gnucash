-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Roles and the owner-side permission set.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/10_roles_and_grants.sql
--
-- ===========================================================================
-- RUN THIS AS THE postgres SUPERUSER. NOT as gnucash_owner.
--
-- This is not a style preference. gnucash_owner does not hold grant-option on
-- the GnuCash tables (postgres owns them), so a GRANT issued as gnucash_owner
-- SILENTLY NO-OPS with "WARNING: no privileges were granted" and returns
-- success. You will believe the grants applied when they did not, and the
-- failure surfaces much later as a permission error inside a function.
-- Verify afterwards with the query at the bottom of this file.
-- ===========================================================================
--
-- The security model, in one paragraph:
--
--   The phone holds a JWT naming a Postgres role. PostgREST connects as
--   `authenticator_mgc` (which can log in but owns nothing), then switches
--   into `gnucash_mgc_user` for the request. `gnucash_mgc_user` has
--   *zero table privileges* -- it cannot SELECT a single row of anything. Every
--   read and every write goes through a SECURITY DEFINER function owned by
--   `gnucash_owner`, which is where the real privileges live.
--
-- Why zero table grants rather than "SELECT on accounts is harmless":
--
--   GnuCash desktop, on opening a book, reads the `versions` table first. If it
--   cannot read it, desktop concludes the database is EMPTY and attempts to
--   initialise a brand new book -- CREATE TABLE for everything, a fresh Root
--   Account. A role with *partial* access is the dangerous shape, because it
--   can get far enough into that sequence to matter. A role with no table
--   privileges at all fails desktop's very first read cleanly. This has been a
--   real near-miss on this project's own server.
--
--   It also means the entire permission boundary is one list of function
--   grants, readable in a single query, rather than a mix of table and
--   function privileges you have to reason about together.
--
-- PostgreSQL 13+ required (core gen_random_uuid(), no extensions).

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. gnucash_owner -- the role that owns the SECURITY DEFINER functions.
-- ---------------------------------------------------------------------------
-- This is also the role GnuCash *desktop* connects as, if you followed the
-- upstream self-hosting guide. It is the "true owner" of the ledger.
--
-- On an existing book the tables are usually owned by `postgres`, and
-- gnucash_owner may hold only a partial set of grants (or none at all -- on
-- this project's own production server it was a dormant role with nothing).
-- The grants below are ADDITIVE and do not disturb any other role.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gnucash_owner') THEN
    -- Password is a placeholder. Change it, or create the role yourself first.
    CREATE ROLE gnucash_owner LOGIN PASSWORD 'CHANGE_ME_owner_password';
    RAISE NOTICE 'Created role gnucash_owner with a placeholder password -- change it.';
  END IF;
END $$;

-- What each grant is actually for. Nothing here is speculative; every line
-- corresponds to a specific statement in the function files.
GRANT SELECT, INSERT         ON accounts     TO gnucash_owner;  -- mgc_create_account
GRANT SELECT, INSERT, UPDATE ON splits       TO gnucash_owner;  -- UPDATE: mgc_set_split_cleared
GRANT SELECT, INSERT         ON transactions TO gnucash_owner;
GRANT SELECT, INSERT         ON slots        TO gnucash_owner;  -- idempotency markers
GRANT SELECT                 ON commodities  TO gnucash_owner;  -- currency + fraction lookups
GRANT SELECT                 ON books        TO gnucash_owner;  -- root/template-root guids
GRANT SELECT                 ON gnclock      TO gnucash_owner;  -- pre-write lock check

-- slots has a serial primary key. The table grant alone is NOT enough to
-- INSERT into it -- Postgres also needs the sequence. This has bitten this
-- project before and the error it produces ("permission denied for sequence
-- slots_id_seq") looks unrelated to the INSERT that triggered it.
GRANT USAGE, SELECT ON SEQUENCE slots_id_seq TO gnucash_owner;

-- Deliberately NOT granted:
--   DELETE on anything      -- this app never deletes. See 60_set_split_cleared.sql.
--   UPDATE on transactions  -- this app never edits an existing transaction.
--   UPDATE on accounts      -- it can create accounts, never rename or move one.
--   anything on prices      -- v1 writes no price rows. See 40_write_rpcs.sql.
--   anything on versions    -- never touched. That table is GnuCash's own.

-- ---------------------------------------------------------------------------
-- 2. The app-facing role pair.
-- ---------------------------------------------------------------------------
-- Rename both freely; just keep them consistent with your PostgREST config and
-- the `role` claim in your JWT.
--
-- If you already run another GnuCash-facing app (this project's predecessor,
-- Ledgerize, used `gnucash_sync_user`), DO NOT reuse or widen its role. This
-- app needs reads that one should never have. A separate role and a separate
-- PostgREST instance keep the two permission boundaries independent.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gnucash_mgc_user') THEN
    CREATE ROLE gnucash_mgc_user NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator_mgc') THEN
    -- NOINHERIT matters: authenticator must not passively hold the app role's
    -- privileges, only be able to SET ROLE into it for the duration of a request.
    CREATE ROLE authenticator_mgc NOINHERIT LOGIN
      PASSWORD 'CHANGE_ME_authenticator_password';
    RAISE NOTICE 'Created authenticator_mgc with a placeholder password -- change it and put it in postgrest.conf.';
  END IF;
END $$;

GRANT gnucash_mgc_user TO authenticator_mgc;

-- Needed for EXECUTE on functions in this schema to be reachable at all.
-- Easy to forget, and the resulting error does not mention the schema.
GRANT USAGE ON SCHEMA public TO gnucash_mgc_user;

-- NOTE: there are deliberately NO table grants for gnucash_mgc_user here.
-- Not on accounts, not on commodities, not on anything. Function EXECUTE
-- grants are issued at the end of each function file, so that a function and
-- its grant can never drift apart.

COMMIT;

-- ---------------------------------------------------------------------------
-- 3. Verify the grants actually applied.
-- ---------------------------------------------------------------------------
-- Run this and read it. If you ran the file as gnucash_owner instead of
-- postgres, the GRANTs above will have silently done nothing and this is where
-- you find out.

\echo ''
\echo '=== gnucash_owner should have the 7 tables below ==='
SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.table_privileges
 WHERE grantee = 'gnucash_owner'
   AND table_name IN ('accounts','splits','transactions','slots',
                      'commodities','books','gnclock')
 GROUP BY 1 ORDER BY 1;
-- Expect exactly:
--   accounts     INSERT,SELECT
--   books        SELECT
--   commodities  SELECT
--   gnclock      SELECT
--   slots        INSERT,SELECT
--   splits       INSERT,SELECT,UPDATE
--   transactions INSERT,SELECT

\echo ''
\echo '=== gnucash_mgc_user must have NO table privileges. Expect zero rows. ==='
SELECT table_name, privilege_type
  FROM information_schema.table_privileges
 WHERE grantee = 'gnucash_mgc_user';

\echo ''
\echo '=== sequence access for slots_id_seq (both must be t) ==='
SELECT has_sequence_privilege('gnucash_owner', 'public.slots_id_seq', 'USAGE')  AS usage_ok,
       has_sequence_privilege('gnucash_owner', 'public.slots_id_seq', 'SELECT') AS select_ok;
