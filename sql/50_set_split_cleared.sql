-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- mgc_set_split_cleared -- the ONLY change this app makes to anything that
-- already exists in the book.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/50_set_split_cleared.sql
--
-- ===========================================================================
-- WHAT IS DELIBERATELY ABSENT FROM THIS PROJECT
-- ===========================================================================
-- There is no mgc_delete_transaction, no mgc_void_transaction and no
-- mgc_update_transaction, and their absence is a decision rather than an
-- oversight. Correcting an existing entry belongs in GnuCash desktop, where
-- there is an undo, the whole book is in front of you, and no coarse advisory
-- lock is standing in for real coordination.
--
-- So the entire mutation surface of this app against existing data is one
-- character, flipping between 'n' and 'c' on one split. It changes no amount,
-- so no double-entry invariant can be violated, and it is reversible from the
-- phone that made it.
-- ===========================================================================
--
-- On the security of taking a split guid from the client: the guid is not the
-- capability, the validation is. Every reachable outcome of this function is
-- "one split's cleared dot changed", which is fully reversible here. Wrapping
-- it in a signed handle would add machinery that protects nothing.

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.mgc_set_split_cleared(
  p_split_guid varchar(32),
  p_cleared    boolean
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_current char(1);
  v_target  char(1);
  v_tx      varchar(32);
  v_rows    integer;
BEGIN
  SELECT reconcile_state, tx_guid INTO v_current, v_tx
    FROM splits WHERE guid = p_split_guid;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'That entry no longer exists in your book.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Never write 'y', and never overwrite one. A reconciled split is the record
  -- of a statement having been agreed; changing it from a phone, with no
  -- statement in hand and no reconciliation screen, would quietly undo work
  -- that was done properly.
  IF v_current = 'y' THEN
    RAISE EXCEPTION
      'This entry is reconciled in GnuCash. Reconciled entries can only be changed in GnuCash desktop.';
  END IF;

  -- Whitelist, not blacklist. Anything that is not exactly 'n' or 'c' is
  -- refused by default, which covers 'f' (frozen), 'v' (voided) and whatever a
  -- future GnuCash version introduces without this function having to have
  -- anticipated it. A blacklist would silently accept the unknown case.
  IF v_current NOT IN ('n', 'c') THEN
    RAISE EXCEPTION 'This entry is marked "%" in GnuCash and cannot be changed from here.', v_current;
  END IF;

  v_target := CASE WHEN p_cleared THEN 'c' ELSE 'n' END;

  IF v_current = v_target THEN
    RETURN jsonb_build_object('status', 'unchanged', 'reconcile_state', v_current);
  END IF;

  PERFORM mgc_assert_unlocked();

  -- Compare-and-swap. Between the SELECT above and this UPDATE, desktop or
  -- another device could have changed the same split. Without the state in the
  -- WHERE clause this would silently overwrite that; with it, the update
  -- affects zero rows and the caller is told to look again.
  UPDATE splits
     SET reconcile_state = v_target
   WHERE guid = p_split_guid
     AND reconcile_state = v_current;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'This entry changed while you were looking at it. Refresh and try again.';
  END IF;

  -- reconcile_date is deliberately NOT touched.
  --
  -- Checked against a real 22,700-split book: of 1,812 splits marked 'c', 1,799
  -- carry an epoch date and none carries a meaningful one. Only 'y' splits have
  -- real dates. So GnuCash does not use this column for cleared, and writing a
  -- timestamp here would make our rows differ from every other row in the book
  -- for no gain.

  RETURN jsonb_build_object(
    'status', 'updated',
    'reconcile_state', v_target,
    'tx_guid', v_tx
  );
END;
$FN$;

ALTER FUNCTION public.mgc_set_split_cleared(varchar, boolean) OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_set_split_cleared(varchar, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_set_split_cleared(varchar, boolean) TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
