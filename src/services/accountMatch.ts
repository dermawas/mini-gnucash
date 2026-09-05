// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Deterministic matching of a receipt line to a real expense account.
//
// Deterministic FIRST, and for now deterministic ONLY. The extraction prompt
// is hard-won and must not be destabilised by bolting a chart of accounts onto
// it, and a second text-only AI call is deferred. Everything here is plain
// token overlap you can reason about, reproduce, and debug offline.
//
// Three rules this holds to:
//
//   1. `suggested_category` is an INPUT, never a stored value. The ledger
//      records the account the user confirmed. A phrase a model produced is
//      evidence about which account to offer, and nothing more.
//
//   2. Candidates are filtered to the funding account's commodity. An expense
//      here is single-currency by design -- mgc_record_transaction refuses a
//      cross-currency one rather than inventing a rate -- so offering an
//      account that would be rejected server-side is offering a dead end.
//
//   3. A weak match is no match. Below the threshold this returns null and the
//      user picks. Proposing a plausible-looking wrong account is worse than
//      proposing nothing, because it invites a confirming tap.

import type { Account } from './api';

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
 * filtering happens here so no caller can forget it.
 */
export function matchLine(
  params: { name: string; suggested_category: string },
  candidates: Account[],
  fundingCommodity: string | null,
): Match | null {
  const eligible = candidates.filter(
    (a) => !fundingCommodity || a.commodity_mnemonic === fundingCommodity,
  );
  if (eligible.length === 0) return null;

  // Sorted before scoring so ties always resolve the same way across runs.
  const ordered = [...eligible].sort((a, b) => a.full_path.localeCompare(b.full_path));
  const ignore = uninformativeTokens(ordered);
  const queryTokens = [...tokenize(params.name), ...tokenize(params.suggested_category)];
  if (queryTokens.length === 0) return null;

  let best: Match | null = null;
  for (const account of ordered) {
    const { score, matched, leafCoverage } = scoreAccount(queryTokens, account, ignore);
    if (score < MIN_SCORE) continue;
    const candidate: Match = { account, score, matched, leafCoverage };
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
