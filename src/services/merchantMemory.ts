// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// What account you chose for this merchant last time.
//
// Why this exists: the token matcher in `accountMatch.ts` can only score a
// leaf hit, and a chart of accounts has no vocabulary for `Donat` or
// `Lemper Ayam`. The only query token that can ever reach a leaf is the
// model's `suggested_category` -- which is not stable between runs. The same
// Holland Bakery receipt proposed `Dining out:Bakery`, then
// `Dining out:Snacks`, then `Food Delivery`, and the last one was written.
//
// A confirmed account is the opposite kind of evidence: it is stable by
// construction, it is what a person actually meant, and it is the same thing a
// human uses when they recognise a shop. So it outranks the tokens.
//
// Three rules this holds to:
//
//   1. **Only an explicit pick teaches.** A line the user actively chose an
//      account for is remembered as `chosen`. A proposal they merely left
//      alone is recorded as `accepted` and never proposed from. Otherwise one
//      unstable `Food Delivery` guess gets saved once and becomes permanent --
//      the exact failure this is meant to end.
//
//   2. **A weak memory is no memory**, matching `accountMatch`'s own rule. A
//      merchant-wide recollection is offered only when every account ever
//      chosen there agrees. A supermarket with both `Groceries` and
//      `Household` confirmed proposes nothing and lets the tokens try.
//
//   3. **Deterministic.** Same store, same merchant, same item, same answer --
//      ties broken by guid so there is no iteration-order dependence.
//
// This is app state, not ledger state. It lives in AsyncStorage beside the
// account cache, holds no amounts and no credentials, and losing it costs
// nothing but a few proposals. The book remains the only record of anything.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { tokenize } from './accountMatch';

const STORE_KEY = 'mgc.merchantMemory.v1';

/** Merchants kept before the least recently used are evicted. */
const MAX_MERCHANTS = 200;

/** How an account came to be attached to a key. See rule 1. */
type Tally = { chosen: number; accepted: number };

type ItemMemory = Record<string /* account guid */, Tally>;

type MerchantMemory = {
  /** ISO date of the last save touching this merchant, for eviction only. */
  lastUsed: string;
  items: Record<string /* normalised item name */, ItemMemory>;
};

export type MemoryStore = Record<string /* normalised merchant */, MerchantMemory>;

export type Remembered = {
  guid: string;
  /** `item` is this exact line at this merchant; `merchant` is the shop only. */
  basis: 'item' | 'merchant';
};

/**
 * A stable key for free text.
 *
 * Reuses the matcher's tokenizer so both sides agree on what a word is, which
 * also strips the item codes a till receipt prints (`1275-PAPERBAG BESAR_PCS`
 * becomes `paperbag besar pcs`). Returns '' when nothing survives, and an
 * empty key is never stored or recalled.
 */
export function memoryKey(text: string): string {
  return tokenize(text).join(' ');
}

/** Highest `chosen` wins; guid breaks ties so the answer cannot drift. */
function bestChosen(memory: ItemMemory): string | null {
  let best: string | null = null;
  for (const guid of Object.keys(memory).sort()) {
    const tally = memory[guid];
    if (tally.chosen < 1) continue;
    if (!best || tally.chosen > memory[best].chosen) best = guid;
  }
  return best;
}

/**
 * What was chosen for this line at this merchant before, or null.
 *
 * Pure, so the decision can be reasoned about and tested without storage.
 * Eligibility is NOT checked here -- the caller passes the result to
 * `matchLine`, which drops an account that is no longer postable or is in the
 * wrong commodity.
 */
export function recall(
  store: MemoryStore,
  merchant: string,
  itemName: string,
): Remembered | null {
  const mKey = memoryKey(merchant);
  if (!mKey) return null;
  const merchantMemory = store[mKey];
  if (!merchantMemory) return null;

  // Rule 1 and the strongest evidence there is: this exact line, this shop.
  const iKey = memoryKey(itemName);
  if (iKey) {
    const exact = bestChosen(merchantMemory.items[iKey] ?? {});
    if (exact) return { guid: exact, basis: 'item' };
  }

  // Rule 2: the shop alone, and only when it has never disagreed with itself.
  const across = new Set<string>();
  for (const item of Object.values(merchantMemory.items)) {
    for (const [guid, tally] of Object.entries(item)) {
      if (tally.chosen > 0) across.add(guid);
    }
  }
  if (across.size === 1) return { guid: [...across][0], basis: 'merchant' };
  return null;
}

export async function loadMemory(): Promise<MemoryStore> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // A hand-edited or half-written blob must not break scanning; the cost of
    // being wrong here is one lost proposal.
    return parsed && typeof parsed === 'object' ? (parsed as MemoryStore) : {};
  } catch {
    return {};
  }
}

/** Least recently used merchants dropped first, so the store cannot grow forever. */
function evict(store: MemoryStore): MemoryStore {
  const keys = Object.keys(store);
  if (keys.length <= MAX_MERCHANTS) return store;
  const keep = keys
    .sort((a, b) => store[b].lastUsed.localeCompare(store[a].lastUsed))
    .slice(0, MAX_MERCHANTS);
  const trimmed: MemoryStore = {};
  for (const k of keep) trimmed[k] = store[k];
  return trimmed;
}

/**
 * Record what was saved. `chosen` lines teach; `accepted` lines are counted
 * but never proposed from -- see rule 1.
 *
 * Called after the write succeeds. A failed write teaches nothing, because the
 * user may well have been correcting the line when it failed.
 */
export async function remember(
  merchant: string,
  lines: { name: string; accountGuid: string; chosen: boolean }[],
): Promise<void> {
  const mKey = memoryKey(merchant);
  if (!mKey || lines.length === 0) return;

  try {
    const store = await loadMemory();
    const entry: MerchantMemory = store[mKey] ?? { lastUsed: '', items: {} };
    entry.lastUsed = new Date().toISOString();

    for (const line of lines) {
      const iKey = memoryKey(line.name);
      if (!iKey) continue;
      const item = entry.items[iKey] ?? {};
      const tally = item[line.accountGuid] ?? { chosen: 0, accepted: 0 };
      if (line.chosen) tally.chosen += 1;
      else tally.accepted += 1;
      item[line.accountGuid] = tally;
      entry.items[iKey] = item;
    }

    store[mKey] = entry;
    await AsyncStorage.setItem(STORE_KEY, JSON.stringify(evict(store)));
  } catch {
    // Memory is an optimisation. Never let it fail a save that already wrote.
  }
}

/** Settings needs this: a memory you cannot clear is one you cannot correct. */
export async function forgetAll(): Promise<void> {
  await AsyncStorage.removeItem(STORE_KEY);
}
