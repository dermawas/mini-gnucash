-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- mgc_memos -- the notes you have put on a LINE before.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/38_memos.sql
--
-- Run as postgres (or as the current owner, on a re-run).
--
-- ---------------------------------------------------------------------------
-- The sibling of mgc_descriptions, and deliberately a separate function
-- ---------------------------------------------------------------------------
-- `sql/37_descriptions.sql` does the same job for the whole entry's
-- description. This one does it for a split's memo -- what the Entry screen
-- calls "Note for this line".
--
-- They are two functions rather than one with a flag because they read two
-- different tables and answer two different questions, and because a caller
-- wanting one of them should not pay for the other. The SHAPE of the answer is
-- identical on purpose, so the phone can hold and match both with one piece of
-- code.
--
-- ---------------------------------------------------------------------------
-- A memo is a thinner seam than a description, and the numbers say so
-- ---------------------------------------------------------------------------
-- Measured on production, 2026-09-16:
--
--   splits                          23,055
--   splits carrying a memo           5,381   (23%: most splits have none)
--   different memos                  2,324
--   used more than once                614   (26% of them)
--   text, all of them                47 KB
--
-- Compare descriptions, where 43% repeat. A memo is more often a one-off --
-- an item name off a receipt -- so this list will offer "once" more of the
-- time. That is the honest answer and the ranking already says which is which.
--
-- ---------------------------------------------------------------------------
-- ACROSS EVERY ACCOUNT, and that is the point. Do not scope this.
-- ---------------------------------------------------------------------------
-- GnuCash desktop's completion is locked to the register you have open, so it
-- only ever knows one account's history. **This is deliberately not that.**
-- There is no account filter in this function or in `mgc_descriptions`, and
-- adding one would be a regression, not a refinement. Suseno's instruction,
-- 2026-09-16, asked for exactly this after seeing the desktop behaviour.
--
-- The tempting argument against, written down so it is not re-discovered and
-- acted on: 483 of the 614 repeated memos, **79%**, appear on exactly one
-- account, so the line's account IS strong evidence about which note is meant.
-- True, and still not a reason to scope. On this screen the account is often
-- still unchosen when the note is typed, and a note you have used on one
-- account is very often the note you want on a new one -- which is the whole
-- reason the desktop behaviour was worth changing.
--
-- If the global list ever proves noisy, the fix is to RANK a note from the
-- chosen account above the others. Never to hide the rest.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.mgc_memos(
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000);
  v_total integer;
  v_rows  jsonb;
BEGIN
  -- Over the whole book, not the limited set, so the caller can be told
  -- honestly when it is holding a trimmed list.
  SELECT count(*) INTO v_total
    FROM (
      SELECT DISTINCT lower(btrim(s.memo))
        FROM splits s
       WHERE s.memo IS NOT NULL
         AND btrim(s.memo) <> ''
    ) d;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('text', r.text, 'uses', r.uses)
                            ORDER BY r.uses DESC, r.last_used DESC, r.text),
                  '[]'::jsonb)
    INTO v_rows
    FROM (
      SELECT folded.text, folded.uses, folded.last_used
        FROM (
          SELECT spelled.key,
                 sum(spelled.uses)::integer                                  AS uses,
                 max(spelled.last_used)                                      AS last_used,
                 -- The spelling actually used most, exactly as descriptions
                 -- does it. `AQUA X 4` and `Aqua x 4` are one note.
                 (array_agg(spelled.text
                            ORDER BY spelled.uses DESC, spelled.text))[1]    AS text
            FROM (
              SELECT lower(btrim(s.memo)) AS key,
                     btrim(s.memo)        AS text,
                     count(*)             AS uses,
                     -- Dated by the transaction the split belongs to. A split
                     -- carries no date of its own.
                     max(t.post_date)     AS last_used
                FROM splits s
                JOIN transactions t ON t.guid = s.tx_guid
               WHERE s.memo IS NOT NULL
                 AND btrim(s.memo) <> ''
               GROUP BY 1, 2
            ) spelled
           GROUP BY spelled.key
        ) folded
       ORDER BY folded.uses DESC, folded.last_used DESC, folded.text
       LIMIT v_limit
    ) r;

  RETURN jsonb_build_object(
    'row_count', jsonb_array_length(v_rows),
    'total',     v_total,
    'truncated', v_total > v_limit,
    'rows',      v_rows
  );
END;
$FN$;

ALTER FUNCTION public.mgc_memos(integer) OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_memos(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_memos(integer) TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
