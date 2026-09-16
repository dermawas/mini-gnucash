-- SPDX-License-Identifier: GPL-3.0-or-later
--
-- mgc_descriptions -- the wording you have used before, so you can stop
-- retyping it.
--
--   sudo -u postgres psql -d <your_gnucash_db> -f sql/37_descriptions.sql
--
-- Run as postgres (or as the current owner, on a re-run).
--
-- ---------------------------------------------------------------------------
-- What this is for
-- ---------------------------------------------------------------------------
-- GnuCash desktop completes a description from the register as you type it.
-- The phone had nothing: every entry was typed from the first letter, in a
-- book where the same words come back hundreds of times. Measured on
-- production, 2026-09-16: 9,789 transactions, 9,782 of them described, and
-- only 1,866 different descriptions between them. `KlikIndomaret` alone
-- accounts for 398, `Parkir` 306, `Diamond Supermarket` 244.
--
-- ---------------------------------------------------------------------------
-- The whole book, not one account. Do not add a filter.
-- ---------------------------------------------------------------------------
-- Desktop's completion is locked to the register you have open, so it only
-- knows the account you are standing in. **This is deliberately not that.**
-- There is no account filter here, and adding one would be a regression.
-- Suseno's instruction, 2026-09-16. `sql/38_memos.sql` holds the same rule for
-- a line's note, with the numbers behind it.
--
-- ---------------------------------------------------------------------------
-- Why it hands over the whole list instead of answering per keystroke
-- ---------------------------------------------------------------------------
-- A prefix query per keystroke is the obvious shape and it is the wrong one
-- here. It needs the VPN up at the exact moment you are typing, and it puts a
-- round trip between a letter and the list under it.
--
-- Those 1,866 descriptions are 42 KB of text in total. The phone can hold all
-- of them, match them itself with no network at all, and it does. This
-- function is therefore called about once a day, not once a letter.
--
-- ---------------------------------------------------------------------------
-- Case is folded, and the spelling you use most is what comes back
-- ---------------------------------------------------------------------------
-- The same shop is not written the same way twice. In production
-- `KlikIndomaret` appears 306 times and `Klikindomaret` 92, which are one
-- merchant and would otherwise be two entries in the list, each with a
-- misleadingly small count.
--
-- So rows are grouped on the folded text, their counts are added together, and
-- the label returned is the most frequent original spelling -- ties broken by
-- the text itself, so the answer cannot drift between calls. Nothing is
-- lower-cased on the way out: the book's own capitalisation is what gets
-- offered, and therefore what gets written back.
--
-- ---------------------------------------------------------------------------
-- What is NOT returned, and why
-- ---------------------------------------------------------------------------
-- No dates. Ranking is by use count, with the last posting date breaking ties
-- server-side only. Shipping a date per row would grow the payload by half for
-- something no screen shows. If ranking ever needs to favour recent wording
-- over merely frequent wording, that belongs here, in the ORDER BY, not on the
-- phone.
--
-- Empty and whitespace-only descriptions are dropped. They are not wording,
-- and this app requires a description on every entry it writes anyway.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION public.mgc_descriptions(
  p_limit integer DEFAULT 5000
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $FN$
DECLARE
  -- Clamped like every other read here. The ceiling is generous because the
  -- whole answer is small; it exists to bound the payload, not to ration it.
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 5000), 1), 20000);
  v_total integer;
  v_rows  jsonb;
BEGIN
  -- Counted over the whole book, not the limited set, so the caller can be
  -- told honestly when it is holding a trimmed list.
  SELECT count(*) INTO v_total
    FROM (
      SELECT DISTINCT lower(btrim(t.description))
        FROM transactions t
       WHERE t.description IS NOT NULL
         AND btrim(t.description) <> ''
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
                 -- The spelling actually used most. See the header.
                 (array_agg(spelled.text
                            ORDER BY spelled.uses DESC, spelled.text))[1]    AS text
            FROM (
              SELECT lower(btrim(t.description)) AS key,
                     btrim(t.description)        AS text,
                     count(*)                    AS uses,
                     max(t.post_date)            AS last_used
                FROM transactions t
               WHERE t.description IS NOT NULL
                 AND btrim(t.description) <> ''
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

ALTER FUNCTION public.mgc_descriptions(integer) OWNER TO gnucash_owner;
REVOKE ALL  ON FUNCTION public.mgc_descriptions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mgc_descriptions(integer) TO gnucash_mgc_user;

NOTIFY pgrst, 'reload schema';
