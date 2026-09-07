// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Whether balances are shown on screen.
//
// For the ordinary case of not wanting your financial position readable by
// whoever is next to you. It hides nothing from anyone with the phone in their
// hands -- one tap brings it back -- and it is not a security control. The
// security boundary is the VPN and the Postgres role; this is a curtain.
//
// Deliberately scoped to BALANCES: the accounts list and a register. Those are
// the persistent at-a-glance numbers, and they are what a glance over your
// shoulder actually reveals. Amounts you are in the middle of typing or
// reviewing are left alone -- you need them to do the thing you are doing, and
// masking the figures inside a warning like "the lines come to X but the
// receipt says Y" would turn a useful sentence into a puzzle.
//
// The preference is remembered, because a toggle that resets every launch is
// one you stop using.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'mgc.hideBalances.v1';

/** What a hidden amount reads as. Wide enough not to imply a magnitude. */
export const MASK = '••••••';

type PrivacyState = {
  hidden: boolean;
  /** Read the stored preference. Safe to call more than once. */
  load: () => Promise<void>;
  toggle: () => Promise<void>;
};

export const usePrivacy = create<PrivacyState>((set, get) => ({
  hidden: false,

  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      set({ hidden: raw === '1' });
    } catch {
      // A preference that cannot be read is not worth failing a screen over.
      set({ hidden: false });
    }
  },

  toggle: async () => {
    const next = !get().hidden;
    set({ hidden: next });
    try {
      await AsyncStorage.setItem(KEY, next ? '1' : '0');
    } catch {
      // The toggle still applied for this session; only persistence failed.
    }
  },
}));

/**
 * Format a balance, or hide it.
 *
 * Takes the already-formatted string rather than the number, so every caller
 * keeps its own currency and scu handling and this cannot quietly change how
 * anything is rounded or symbolised.
 */
export function maskIfHidden(formatted: string, hidden: boolean): string {
  return hidden ? MASK : formatted;
}
