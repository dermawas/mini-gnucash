-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- Read RPCs. Bounded by construction -- there is no SELECT grant on any table
-- for the app role, so these functions ARE the read surface.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/30_read_rpcs.sql
--
-- Run as postgres (or as the current owner, on a re-run).
--
-- All are STABLE, so PostgREST will serve them over GET as well as POST.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- mgc_ping -- reachability, lock state and book mode in one round trip
-- ---------------------------------------------------------------------------
-- Deliberately answers three separate client questions at once, because the app
-- needs all three to decide what to render and they change independently:
--
--   * can I reach the ledger at all?          -> the call succeeding
--   * can I write right now?                  -> book_locked / locked_by
--   * which transfer form applies?            -> trading_accounts
--
-- A phone that is off-VPN gets a fetch timeout here and shows its offline
-- state. A phone with a bad JWT gets a 401, which is a DIFFERENT state and must
-- not be conflated -- one is "come back when you're on the VPN", the other is
-- "your credentials are wrong, go to Settings".
CREATE OR REPLACE FUNCTION public.mgc_ping()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_host varchar(255);
BEGIN
  SELECT hostname INTO v_host FROM gnclock LIMIT 1;

  RETURN jsonb_build_object(
    'ok',               true,
    'server_time',      to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'book_locked',      v_host IS NOT NULL,
    'locked_by',        v_host,
    'trading_accounts', mgc_uses_trading_accounts(),
    'account_count',    (SELECT count(*) FROM accounts WHERE account_type <> 'ROOT')
  );
END;
$$;

ALTER FUNCTION public.mgc_ping() OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_ping() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_ping() TO gnucash_mgc_user;

-- ---------------------------------------------------------------------------
-- mgc_get_accounts -- the chart of accounts, with paths already built
-- ---------------------------------------------------------------------------
-- Replaces what would otherwise be `GET /accounts` plus `GET /commodities`,
-- and with them the two table grants those endpoints require. That is the whole
-- reason this exists as a function: it lets the app role hold no table
-- privileges at all.
--
-- It also fixes two things the client used to get wrong when it built paths
-- itself by walking parent_guid upward:
--
--   1. Every path was prefixed with "Root Account", which is noise in a picker
--      and pollutes substring search.
--   2. The Template Root subtree (GnuCash's scheduled-transaction templates)
--      was walked like any other branch, so template accounts appeared in the
--      picker as if they were real.
--
-- Anchoring the recursion at the real root's children solves both at once:
-- the root name never enters a path, and the template tree is simply never
-- reached.
--
-- Separator is ':' to match GnuCash's own full-name convention, so a path shown
-- here reads identically to the same account in desktop.
CREATE OR REPLACE FUNCTION public.mgc_get_accounts()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_result jsonb;
BEGIN
  WITH RECURSIVE tree AS (
    -- Anchor: children of the REAL root only. Never the root itself, never
    -- Template Root, never Template Root's children.
    SELECT a.guid, a.name, a.account_type, a.parent_guid,
           COALESCE(a.placeholder, 0) AS placeholder,
           COALESCE(a.hidden, 0)      AS hidden,
           a.commodity_guid, a.commodity_scu, a.description,
           a.name::text AS full_path,
           0            AS depth
      FROM accounts a
     WHERE a.parent_guid = mgc_root_guid()

    UNION ALL

    SELECT c.guid, c.name, c.account_type, c.parent_guid,
           COALESCE(c.placeholder, 0),
           COALESCE(c.hidden, 0),
           c.commodity_guid, c.commodity_scu, c.description,
           (t.full_path || ':' || c.name)::text,
           t.depth + 1
      FROM accounts c
      JOIN tree t ON c.parent_guid = t.guid
     -- Depth guard. A cycle in parent_guid should be impossible in a healthy
     -- book, but an unbounded recursive CTE is not the place to find out.
     WHERE t.depth < 20
  )
  SELECT COALESCE(jsonb_agg(row_to_json(x)::jsonb ORDER BY x.full_path), '[]'::jsonb)
    INTO v_result
    FROM (
      SELECT t.guid,
             t.name,
             t.account_type,
             t.parent_guid,
             t.placeholder,
             t.hidden,
             t.full_path,
             t.depth,
             t.commodity_guid,
             t.commodity_scu,
             c.mnemonic  AS commodity_mnemonic,
             c.namespace AS commodity_namespace,
             COALESCE(t.description, '') AS description
        FROM tree t
        LEFT JOIN commodities c ON c.guid = t.commodity_guid
    ) x;

  RETURN v_result;
END;
$$;

ALTER FUNCTION public.mgc_get_accounts() OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_get_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_get_accounts() TO gnucash_mgc_user;

-- Placeholder and hidden accounts are RETURNED, not filtered out. The client
-- decides: a placeholder is still a valid parent when creating an account and
-- still needs to render so the tree reads correctly, it just cannot be posted
-- to. Filtering server-side would make that impossible to express.

NOTIFY pgrst, 'reload schema';
