// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The wording you have used before, held on the phone.
//
// Two lists, one set of rules. `descriptions` is what an entry as a whole was
// called; `memos` is what a single line was noted as. They come from two
// server functions, are stored under two keys, and are matched by exactly the
// same code -- which is why they live in one file rather than two.
//
// ---------------------------------------------------------------------------
// ACROSS THE WHOLE BOOK, not one account
// ---------------------------------------------------------------------------
// GnuCash desktop completes out of the register you have open, so it only ever
// knows the account you are standing in. This does not. A note you have used
// on one account is very often the note you want on another, and on this
// screen the account is frequently still unchosen when the note is typed.
//
// Suseno asked for this explicitly on 2026-09-16 after seeing the desktop
// behaviour. `sql/38_memos.sql` carries the same rule and the numbers behind
// it. Do not add an account filter to either side.
//
// ---------------------------------------------------------------------------
// Why the whole list, and not a query per keystroke
// ---------------------------------------------------------------------------
// Measured on production, 2026-09-16: 9,789 transactions carry 1,866 different
// descriptions, and 23,055 splits carry 2,324 different notes. About 190 KB of
// JSON for both. That fits on a phone with room to spare, so a suggestion
// costs no network and appears between two letters. A query per keystroke
// would need the VPN up at the exact moment you are typing, which is the one
// moment this app cannot assume.
//
// ---------------------------------------------------------------------------
// This is the SECOND copy of book data the app keeps
// ---------------------------------------------------------------------------
// The chart of accounts was the first and, until now, the only one. That was a
// deliberate line and this crosses it, so it is stated plainly here and in
// Settings rather than left to be discovered: this file holds text copied out
// of the ledger. No amounts, no accounts, no dates -- words and a count,
// nothing else. Both lists are cleared with the account cache whenever the
// ledger underneath changes, because one book's wording has no business being
// offered against another's.
//
// ---------------------------------------------------------------------------
// What the phone adds
// ---------------------------------------------------------------------------
// Wording you just saved is in the book, but a list is only refreshed about
// once a day, so it would not come back for hours. `note()` puts it in
// immediately and counts it, which also means what you personally type most
// rises to the top of your own list between refreshes.
//
// Only a SUCCESSFUL write teaches, the same rule `merchantMemory.ts` holds to.
// Wording typed into a save that failed is not something you did; it may well
// be what you were in the middle of correcting.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getDescriptions, getMemos, type WordingRow, type RpcResult, type WordingList } from './api';

/** How old a copy may get before the Entry screen quietly refetches it. */
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

/** Enough for this book twice over. Bounds what a bigger one could cost. */
const MAX_KEPT = 6000;

/**
 * One letter would offer five near-random rows out of two thousand and cover
 * the field while you were still typing the word. Two is where the list starts
 * being an answer rather than noise.
 */
export const MIN_CHARS = 2;

/** More than this and the list is taller than the field it belongs to. */
export const MAX_SUGGESTIONS = 5;

export type Suggestion = WordingRow & {
  /**
   * When this phone last saved an entry using it. ISO, absent for wording that
   * has only ever arrived from the book.
   *
   * It exists to break ties, and the tie is the common case: 1,061 of this
   * book's 1,866 descriptions have been used exactly once, and 1,710 of its
   * 2,324 notes. Without it those are ordered alphabetically, which is
   * arbitrary to a reader -- wording entered an hour ago sinks under ten
   * strangers that happen to sort earlier, at the exact moment it is most
   * likely to be what you are typing again.
   */
  notedAt?: string;
};

export type WordingCache = {
  rows: Suggestion[];
  /** ISO, or null when nothing has ever been fetched. */
  fetchedAt: string | null;
};

const EMPTY: WordingCache = { rows: [], fetchedAt: null };

/** Case folded and trimmed, so one shop is one entry. Matches the SQL. */
function fold(text: string): string {
  return text.trim().toLowerCase();
}

export function isStale(fetchedAt: string | null): boolean {
  if (!fetchedAt) return true;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return true;
  return Date.now() - at > REFRESH_AFTER_MS;
}

/**
 * The one order used everywhere: most used, then most recently used HERE,
 * then alphabetical so two rows can never swap places between calls.
 */
export function byRank(a: Suggestion, b: Suggestion): number {
  if (a.uses !== b.uses) return b.uses - a.uses;
  // A row this phone has saved beats one it has only read about.
  if (a.notedAt !== b.notedAt) {
    if (!a.notedAt) return 1;
    if (!b.notedAt) return -1;
    return b.notedAt.localeCompare(a.notedAt);
  }
  return a.text.localeCompare(b.text);
}

function rank(rows: Suggestion[]): Suggestion[] {
  return rows.sort(byRank).slice(0, MAX_KEPT);
}

/**
 * What to offer for what has been typed. Pure, so it can be reasoned about
 * and tested without storage, and shared by both lists.
 *
 * Two tiers, and the order between them is the whole behaviour:
 *
 *   1. The wording STARTS with what was typed. This is what GnuCash desktop
 *      does and it is what the field is for.
 *   2. A WORD inside it starts with what was typed, so `bakery` still finds
 *      `Holland Bakery`. Desktop cannot do this and a phone should: you do not
 *      always remember which word the wording begins with, and retyping the
 *      first half to find out defeats the point.
 *
 * Deliberately not a plain substring match. `art` would then pull in
 * `Supermarket`, and a list you have to read carefully is slower than typing.
 *
 * ---------------------------------------------------------------------------
 * Why the tiers outrank the counts, and what that costs
 * ---------------------------------------------------------------------------
 * The obvious alternative is one list sorted by use count, tier only breaking
 * ties. Both were run against the real 1,866 descriptions on 2026-09-16 and
 * each is wrong somewhere:
 *
 *   sorting by count   typing `co` offers Starbucks Coffee (40), Income
 *                      Coupon/ORI019 (24) and three more -- five rows, not one
 *                      of them beginning with what was typed. The feature
 *                      reads as broken.
 *
 *   sorting by tier    typing `supermarket` puts Supermarket Instant Cempaka
 *                      Putih, used ONCE, above Diamond SuperMarket, used 244
 *                      times, because only the first begins with the word.
 *
 * Tiers win because of how each one fails. The count sort loses the whole
 * list; the tier sort loses one line of reading. The Supermarket row is the
 * known price and it is not a bug report.
 */
export function suggest(
  rows: Suggestion[],
  typed: string,
  limit = MAX_SUGGESTIONS,
): Suggestion[] {
  const q = fold(typed);
  if (q.length < MIN_CHARS) return [];

  const starts: Suggestion[] = [];
  const inside: Suggestion[] = [];

  for (const row of rows) {
    const text = fold(row.text);
    // Already typed in full. There is nothing left to offer, and a row that
    // fills in exactly what is on screen reads as a bug.
    if (text === q) continue;
    if (text.startsWith(q)) starts.push(row);
    else if (wordStartsWith(text, q)) inside.push(row);
  }

  return [...starts.sort(byRank), ...inside.sort(byRank)].slice(0, limit);
}

/** Does any word in `text` begin with `q`? Both are already folded. */
function wordStartsWith(text: string, q: string): boolean {
  // Split on anything that is not a letter or a digit, so `top-up`,
  // `Gojek/Gocar` and `Adjustment - Males` all break where a reader would.
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word && word.startsWith(q)) return true;
  }
  return false;
}

export type WordingStore = {
  load: () => Promise<WordingCache>;
  refresh: () => Promise<WordingCache | null>;
  note: (text: string) => Promise<WordingCache>;
  /** Several at once, in ONE read and one write. See the note on counting. */
  noteMany: (texts: string[]) => Promise<WordingCache>;
  clear: () => Promise<void>;
};

/**
 * One list: where it is stored and where it comes from. Everything else about
 * the two is identical, which is the whole reason this is a factory and not
 * two copies of the same file.
 */
function makeStore(
  cacheKey: string,
  fetchAll: () => Promise<RpcResult<WordingList>>,
): WordingStore {
  async function load(): Promise<WordingCache> {
    try {
      const raw = await AsyncStorage.getItem(cacheKey);
      if (!raw) return EMPTY;
      const parsed = JSON.parse(raw);
      // A half-written blob must not break the Entry screen. The cost of being
      // wrong here is one session with no suggestions.
      if (!parsed || !Array.isArray(parsed.rows)) return EMPTY;
      // Every row is checked, not just the shape around them. A row with no
      // count sorts against NaN, and a comparator that returns NaN leaves the
      // whole list in an order the engine does not define.
      const rows = (parsed.rows as unknown[]).filter(
        (r): r is Suggestion =>
          !!r &&
          typeof (r as Suggestion).text === 'string' &&
          (r as Suggestion).text.trim().length > 0 &&
          Number.isFinite((r as Suggestion).uses),
      );
      return { rows, fetchedAt: parsed.fetchedAt ?? null };
    } catch {
      return EMPTY;
    }
  }

  async function save(cache: WordingCache): Promise<void> {
    try {
      await AsyncStorage.setItem(cacheKey, JSON.stringify(cache));
    } catch {
      /* best effort: a lost cache costs one refetch */
    }
  }

  async function noteMany(texts: string[]): Promise<WordingCache> {
    const cache = await load();
    const clean = texts.map((t) => t.trim()).filter(Boolean);
    if (clean.length === 0) return cache;

    const notedAt = new Date().toISOString();
    const rows = cache.rows.slice();
    const at = new Map(rows.map((r, i) => [fold(r.text), i]));

    for (const text of clean) {
      const key = fold(text);
      const found = at.get(key);
      if (found !== undefined) {
        rows[found] = { text: rows[found].text, uses: rows[found].uses + 1, notedAt };
      } else {
        at.set(key, rows.length);
        rows.push({ text, uses: 1, notedAt });
      }
    }

    const next: WordingCache = { rows: rank(rows), fetchedAt: cache.fetchedAt };
    await save(next);
    return next;
  }

  return {
    load,

    /**
     * Refetch from the book and keep anything the phone knows that it does not.
     *
     * The server is authoritative for everything already written, so its count
     * replaces the local one rather than adding to it -- otherwise wording
     * saved here would be counted twice, once by `note()` and once by the book.
     *
     * Returns null when the fetch failed, and the stored copy is left alone. An
     * old list is better than no list, and this is never worth an error on
     * screen.
     */
    refresh: async () => {
      const result = await fetchAll();
      if (!result.ok) return null;

      const existing = await load();
      const knownHere = new Map(existing.rows.map((r) => [fold(r.text), r]));
      const merged = new Map<string, Suggestion>();

      for (const row of result.data.rows) {
        const text = row.text.trim();
        if (!text) continue;
        const key = fold(text);
        // The book's spelling and count win, but when it was last used on THIS
        // phone is something the book does not know and must not erase.
        merged.set(key, { text, uses: row.uses, notedAt: knownHere.get(key)?.notedAt });
      }
      // Saved here since the last refresh, so not in the answer above yet.
      for (const [key, row] of knownHere) {
        if (!merged.has(key)) merged.set(key, row);
      }

      const cache: WordingCache = {
        rows: rank([...merged.values()]),
        fetchedAt: new Date().toISOString(),
      };
      await save(cache);
      return cache;
    },

    note: (text: string) => noteMany([text]),

    /**
     * Record wording that just reached the book.
     *
     * The book's own spelling is kept when there is one, so a hurried
     * lower-case `parkir` does not quietly replace the `Parkir` that 306
     * entries use.
     *
     * Repeats inside one call are counted SEPARATELY and on purpose. An entry
     * with three lines all noted `Aqua` is three splits in the book, so
     * `mgc_memos` will report three, and a phone that counted one would
     * disagree with the server until the next refresh silently corrected it.
     *
     * One read and one write for the whole batch. Calling `note` in a loop
     * would re-read and re-write the entire list per line.
     */
    noteMany,

    clear: async () => {
      try {
        await AsyncStorage.removeItem(cacheKey);
      } catch {
        /* best effort */
      }
    },
  };
}

/** What the whole entry was called. */
export const descriptions = makeStore('mgc.descriptions.v1', getDescriptions);

/** What a single line was noted as. */
export const memos = makeStore('mgc.memos.v1', getMemos);

/** Settings needs this, and so does every ledger switch. */
export async function clearWording(): Promise<void> {
  await descriptions.clear();
  await memos.clear();
}
