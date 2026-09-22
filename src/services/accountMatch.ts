// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// Deterministic matching of a receipt line to a real expense account.
//
// Until 2026-09-22 this was deterministic ONLY: the extraction prompt was kept
// away from the chart of accounts, and everything here was plain token
// overlap. That had a ceiling. A till receipt prints "SARI ROTI TAWAR", no
// chart of accounts has those words, so the tokens could only ever reach an
// account through the model's loose `suggested_category` -- and on one
// Indomaret receipt all six items came back "Groceries", in a book with
// fourteen accounts under Groceries.
//
// So the scanner is now GIVEN the list of accounts and names one per item
// (receiptExtraction/prompt.ts, appended after the extraction rules, which were
// not touched). That pick is checked here, and it is only an input: it must
// name a real candidate in the right currency or it is ignored, and the token
// overlap below still answers whenever it is missing or wrong.
//
// Three rules this holds to:
//
//   1. `suggested_category` is an INPUT, never a stored value. The ledger
//      records the account the user confirmed. A phrase a model produced is
//      evidence about which account to offer, and nothing more.
//
//   2. Candidates are filtered to the funding account's commodity. An expense
//      here is single-currency by design -- `mgc_record_entry` refuses a
//      cross-currency one rather than inventing a rate -- so offering an
//      account that would be rejected server-side is offering a dead end.
//
//   3. A weak match is no match. Below the threshold this returns null and the
//      user picks. Proposing a plausible-looking wrong account is worse than
//      proposing nothing, because it invites a confirming tap.
//
//   4. What the user chose before beats anything scored here, and beats the
//      scanner's pick too. The tokens can
//      only reach a leaf via `suggested_category` -- a chart of accounts has
//      no word for `Donat` -- and that phrase changes between runs on one
//      receipt. `merchantMemory.ts` supplies the recollection; this file stays
//      pure, and takes it as an argument so it is still reproducible offline.

import type { Account } from './api';
import type { Remembered } from './merchantMemory';

export type Match = {
  account: Account;
  score: number;
  /** Which query tokens hit, for the review screen to show its reasoning. */
  matched: string[];
  /**
   * Fraction of the leaf segment's own tokens the query explained. Breaks ties
   * between equal scores -- see the comparison in matchLine.
   */
  leafCoverage: number;
  /**
   * Where the proposal came from. `tokens` is the scoring below; `model` is the
   * account the scanner picked from the list it was given; `item` and
   * `merchant` mean it was recalled from what the user chose before, which
   * outranks both -- see matchLine.
   */
  basis: 'tokens' | 'model' | 'item' | 'merchant';
};

// Tokens carrying no discriminating power in any book. Path segments shared by
// every candidate are removed separately and dynamically below, which handles
// book-specific noise like a top-level "Expenses" without hardcoding it.
const STOPWORDS = new Set([
  'and', 'or', 'the', 'of', 'for', 'to', 'a', 'an',
  'misc', 'miscellaneous', 'other', 'others', 'general',
  'dan', 'lain', 'lainnya', 'umum',
]);

/**
 * Lowercase, strip accounting prefixes, split on anything not alphanumeric.
 *
 * The leading-digits strip matters for this book specifically: accounts are
 * named `03-Expenses`, `0111-Checking Account`. Without it every account
 * contributes a meaningless numeric token and "03" could match a price.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.replace(/^\d+$/, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Path segments, leaf last. `full_path` uses GnuCash's own ':' convention. */
function segments(account: Account): string[] {
  return account.full_path.split(':').filter(Boolean);
}

/**
 * Tokens that appear in EVERY candidate carry zero information -- they cannot
 * separate one account from another -- so they are dropped. This is what keeps
 * a shared root like `03-Expenses` from contributing to every score, without a
 * hardcoded list that would only be right for this one book.
 */
function uninformativeTokens(candidates: Account[]): Set<string> {
  if (candidates.length < 2) return new Set();
  let common: Set<string> | null = null;
  for (const a of candidates) {
    const tokens = new Set(segments(a).flatMap(tokenize));
    if (common === null) {
      common = tokens;
      continue;
    }
    for (const t of [...common]) if (!tokens.has(t)) common.delete(t);
  }
  return common ?? new Set();
}

// A leaf hit is much stronger evidence than an ancestor hit: `Food:Coffee`
// matching "coffee" on the leaf means this exact account, while matching
// "food" on the parent only narrows to a branch.
const LEAF_WEIGHT = 3;
const ANCESTOR_WEIGHT = 1;

/** Below this, the evidence is one ancestor token and we decline to guess. */
export const MIN_SCORE = LEAF_WEIGHT;

export function scoreAccount(
  queryTokens: string[],
  account: Account,
  ignore: Set<string>,
): { score: number; matched: string[]; leafCoverage: number } {
  const segs = segments(account);
  const leaf = new Set(tokenize(segs[segs.length - 1] ?? ''));
  const ancestors = new Set(segs.slice(0, -1).flatMap(tokenize));

  let score = 0;
  let leafHits = 0;
  const matched: string[] = [];
  for (const q of new Set(queryTokens)) {
    if (ignore.has(q)) continue;
    if (leaf.has(q)) {
      score += LEAF_WEIGHT;
      leafHits += 1;
      matched.push(q);
    } else if (ancestors.has(q)) {
      score += ANCESTOR_WEIGHT;
      matched.push(q);
    }
  }
  return { score, matched, leafCoverage: leaf.size ? leafHits / leaf.size : 0 };
}

/**
 * Best expense account for one receipt line, or null when nothing clears the
 * threshold.
 *
 * `candidates` should already be the postable, non-hidden set. Commodity
 * filtering happens here so no caller can forget it -- including for a
 * remembered account, which is why memory is resolved here rather than by the
 * caller. An account confirmed months ago may since have been made a
 * placeholder, hidden, or re-denominated.
 *
 * **A memory outranks a score.** The tokens can only ever match on the AI's
 * `suggested_category`, because no chart of accounts contains the words a till
 * receipt prints, and that phrase is not stable between runs. What the user
 * chose for this merchant is. See merchantMemory.ts.
 */
export function matchLine(
  params: { name: string; suggested_category: string; account?: string },
  candidates: Account[],
  fundingCommodity: string | null,
  remembered: Remembered | null = null,
): Match | null {
  const eligible = candidates.filter(
    (a) => !fundingCommodity || a.commodity_mnemonic === fundingCommodity,
  );
  if (eligible.length === 0) return null;

  if (remembered) {
    const account = eligible.find((a) => a.guid === remembered.guid);
    // Silently falling through to the tokens is right when it is gone: the
    // proposal is a proposal either way, and the picker is one tap away.
    if (account) {
      return { account, score: Infinity, matched: [], leafCoverage: 1, basis: remembered.basis };
    }
  }

  // The scanner's pick, when it names a real candidate. Compared on the full
  // path, which is what it was shown; trimmed and case-folded because a model
  // copying 206 lines does not always keep a capital, and two accounts that
  // differ only in case would be a book problem rather than a scanning one.
  const picked = params.account?.trim().toLowerCase();
  if (picked) {
    const account = eligible.find((a) => a.full_path.toLowerCase() === picked);
    if (account) {
      return { account, score: Infinity, matched: [], leafCoverage: 1, basis: 'model' };
    }
  }

  // Sorted before scoring so ties always resolve the same way across runs.
  const ordered = [...eligible].sort((a, b) => a.full_path.localeCompare(b.full_path));
  const ignore = uninformativeTokens(ordered);
  const queryTokens = [...tokenize(params.name), ...tokenize(params.suggested_category)];
  if (queryTokens.length === 0) return null;

  let best: Match | null = null;
  for (const account of ordered) {
    const { score, matched, leafCoverage } = scoreAccount(queryTokens, account, ignore);
    if (score < MIN_SCORE) continue;
    const candidate: Match = { account, score, matched, leafCoverage, basis: 'tokens' };
    if (!best || isBetter(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * Ranking, in order: more evidence, then a tighter fit.
 *
 * The tie-break is not cosmetic. "Domains" and "Digital Services" both score a
 * single leaf hit for a query mentioning domains, and without this the winner
 * is whichever sorts first alphabetically -- which is to say, arbitrary.
 * Coverage asks how much of the account's own name the query explained:
 * "Domains" is fully explained, "Digital Services" only half, so the query is
 * better evidence for the former.
 *
 * Anything still tied keeps the incumbent, and candidates are iterated in
 * sorted order, so the same receipt always proposes the same account.
 */
function isBetter(candidate: Match, incumbent: Match): boolean {
  if (candidate.score !== incumbent.score) return candidate.score > incumbent.score;
  return candidate.leafCoverage > incumbent.leafCoverage;
}
