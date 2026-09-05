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

  postable: (types) => {
    const all = get().accounts.filter(
      // A placeholder is a container: GnuCash will not let a transaction land on
      // one, so offering it in a picker only sets up a server-side rejection.
      // Hidden accounts are excluded for the same reason a user hid them.
      (a) => a.placeholder === 0 && a.hidden === 0,
    );
    return types && types.length ? all.filter((a) => types.includes(a.account_type)) : all;
  },

  reset: () => set({ accounts: [], loading: false, error: null, cachedAt: null, loadedOnce: false }),
}));

/** Asset accounts, which is what both sides of a transfer must be. */
export const ASSET_TYPES = ['BANK', 'CASH', 'ASSET'];
export const EXPENSE_TYPES = ['EXPENSE'];
export const INCOME_TYPES = ['INCOME'];
