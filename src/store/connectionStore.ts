// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// One source of truth for "can we talk to the ledger, and can we write to it".
//
// This app has no local ledger, so connection state is not a background detail
// -- it decides whether a screen has anything to show at all. Getting it wrong
// in the reassuring direction (showing a stale number as if it were current) is
// the failure this whole project is arranged to avoid.

import { create } from 'zustand';
import {
  ping,
  loadCredentials,
  type Credentials,
  type PingResult,
} from '../services/api';

/**
 * Five states, not two, because they call for different actions:
 *
 *   unknown       we have not asked yet
 *   unconfigured  no URL/token stored -- first run
 *   online        reachable and writable
 *   locked        reachable, but GnuCash desktop holds the book. READS STILL
 *                 WORK. Only writes are blocked. Showing this as "offline"
 *                 would hide a perfectly usable app.
 *   offline       not reachable. Off VPN, or the server is down.
 *   unauthorized  reachable, credentials rejected. Retrying never helps, so
 *                 this must not be phrased as a connection problem -- it sends
 *                 people to check their wifi instead of their token.
 */
export type ConnectionState =
  | 'unknown'
  | 'unconfigured'
  | 'online'
  | 'locked'
  | 'offline'
  | 'unauthorized';

type Store = {
  state: ConnectionState;
  lockedBy: string | null;
  tradingAccounts: boolean;
  accountCount: number;
  lastError: string | null;
  lastCheckedAt: string | null;
  checking: boolean;

  /** True only when a write can actually succeed right now. */
  canWrite: () => boolean;
  /** Why a write is unavailable, phrased for a disabled button. */
  writeBlockedReason: () => string | null;

  refresh: (creds?: Credentials | null) => Promise<void>;
  /** Fold a failed call's outcome into connection state without a round trip. */
  noteFailure: (kind: 'offline' | 'unauthorized' | 'locked' | 'rejected', error: string) => void;
  reset: () => void;
};

export const useConnection = create<Store>((set, get) => ({
  state: 'unknown',
  lockedBy: null,
  tradingAccounts: false,
  accountCount: 0,
  lastError: null,
  lastCheckedAt: null,
  checking: false,

  canWrite: () => get().state === 'online',

  writeBlockedReason: () => {
    const s = get();
    switch (s.state) {
      case 'online':
        return null;
      case 'locked':
        return `GnuCash desktop has the book open${s.lockedBy ? ` on ${s.lockedBy}` : ''}. Close it there to save from here.`;
      case 'offline':
        return 'Not connected to your ledger. Connect to the VPN to save.';
      case 'unauthorized':
        return 'Your server credentials were rejected. Check them in Settings.';
      case 'unconfigured':
        return 'No ledger configured yet.';
      default:
        return 'Checking the connection...';
    }
  },

  refresh: async (creds) => {
    if (get().checking) return;
    set({ checking: true });
    try {
      const c = creds ?? (await loadCredentials());
      if (!c) {
        set({ state: 'unconfigured', lastError: null, checking: false });
        return;
      }

      const result = await ping(c);
      if (result.ok) {
        const p: PingResult = result.data;
        set({
          state: p.book_locked ? 'locked' : 'online',
          lockedBy: p.locked_by,
          tradingAccounts: p.trading_accounts,
          accountCount: p.account_count,
          lastError: null,
          lastCheckedAt: new Date().toISOString(),
          checking: false,
        });
        return;
      }

      set({
        state: result.kind === 'unauthorized' ? 'unauthorized' : 'offline',
        lastError: result.error,
        lastCheckedAt: new Date().toISOString(),
        checking: false,
      });
    } catch (err: any) {
      set({ state: 'offline', lastError: String(err?.message ?? err), checking: false });
    }
  },

  noteFailure: (kind, error) => {
    // A 'rejected' says nothing about reachability -- the server answered. Record
    // the message but leave the connection state alone, or one bad input would
    // make the whole app claim to be offline.
    if (kind === 'rejected') {
      set({ lastError: error });
      return;
    }
    set({
      state: kind === 'locked' ? 'locked' : kind === 'unauthorized' ? 'unauthorized' : 'offline',
      lastError: error,
    });
  },

  reset: () =>
    set({
      state: 'unconfigured',
      lockedBy: null,
      tradingAccounts: false,
      accountCount: 0,
      lastError: null,
      lastCheckedAt: null,
      checking: false,
    }),
}));
