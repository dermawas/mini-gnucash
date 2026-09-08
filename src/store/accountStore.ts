// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The chart of accounts, and only the chart of accounts.
//
// This is the one thing the app keeps a copy of, because account structure is
// stable and a picker that cannot open off-VPN is useless. Balances and
// registers are deliberately NOT held here -- they are fetched live every time
// and shown as nothing when unreachable. Money changes; the shape of the book
// does not.

import { create } from 'zustand';
import { getAccounts, type Account } from '../services/api';
import { useConnection } from './connectionStore';

type Store = {
  accounts: Account[];
  loading: boolean;
  error: string | null;
  /** Set when the list came from cache rather than the server. */
  cachedAt: string | null;
  loadedOnce: boolean;

  load: () => Promise<void>;
  byGuid: (guid: string) => Account | undefined;
  /** Accounts that can actually hold a transaction. */
  postable: (types?: string[]) => Account[];
  /** Whether the book has a usable trading account for this commodity. */
  hasTradingAccount: (commodityGuid: string | null) => boolean;
  reset: () => void;
};

export const useAccounts = create<Store>((set, get) => ({
  accounts: [],
  loading: false,
  error: null,
  cachedAt: null,
  loadedOnce: false,

  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    const result = await getAccounts();

    if (!result.ok) {
      useConnection.getState().noteFailure(result.kind as any, result.error);
      set({ loading: false, error: result.error });
      return;
    }

    set({
      accounts: result.accounts,
      cachedAt: result.fromCache ? result.cachedAt : null,
      loading: false,
      error: null,
      loadedOnce: true,
    });
  },

  byGuid: (guid) => get().accounts.find((a) => a.guid === guid),

  /**
   * Does a trading account exist for this commodity?
   *
   * Mirrors `mgc_trading_account` in `sql/20_helpers.sql` predicate for
   * predicate: type TRADING, this commodity, not a placeholder, and parented
   * under an account NAMED for the commodity's namespace.
   *
   * Kept deliberately in step with the server. If the two ever disagree the
   * phone will either block a write the server would have taken, or offer one
   * it is going to refuse -- and the second is what this exists to prevent.
   */
  hasTradingAccount: (commodityGuid) => {
    if (!commodityGuid) return false;
    const all = get().accounts;
    return all.some((a) => {
      if (a.account_type !== 'TRADING') return false;
      if (a.commodity_guid !== commodityGuid) return false;
      if (a.placeholder !== 0) return false;
      const parent = all.find((p) => p.guid === a.parent_guid);
      return !!parent && parent.name === a.commodity_namespace;
    });
  },

  postable: (types) => {
    const all = get().accounts.filter(
      // A placeholder is a container: GnuCash will not let a transaction land on
      // one, so offering it in a picker only sets up a server-side rejection.
      // Hidden accounts are excluded for the same reason a user hid them.
      //
      // Depth 0 excludes GnuCash's own machinery. Imbalance-* and Orphan-* sit
      // directly under the root and exist to catch an unbalanced import;
      // nothing should ever deliberately post to one from a phone. They are
      // recognised structurally rather than by name -- in this book the only
      // postable accounts at depth 0 are exactly those seven, and every real
      // account is deeper.
      //
      // This is filtered for PICKERS only. The Accounts tree reads
      // `accounts` directly, so an Imbalance account with a balance in it is
      // still visible, which is the one time you need to see it.
      (a) => a.placeholder === 0 && a.hidden === 0 && a.depth > 0,
    );
    return types && types.length ? all.filter((a) => types.includes(a.account_type)) : all;
  },

  reset: () => set({ accounts: [], loading: false, error: null, cachedAt: null, loadedOnce: false }),
}));

/** Asset accounts, which is what both sides of a transfer must be. */
export const ASSET_TYPES = ['BANK', 'CASH', 'ASSET'];
export const EXPENSE_TYPES = ['EXPENSE'];
export const INCOME_TYPES = ['INCOME'];
