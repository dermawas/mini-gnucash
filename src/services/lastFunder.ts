// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Which account paid last time.
//
// The Entry screen opens with one funding chip already filled, because the
// funder is the one field that is nearly always the same and asking for it
// every time is what made the old Spend screen slow. The handoff spells this
// out: "Paid by defaults to the last-used funder."
//
// One guid, on this phone only. It is a convenience, never a default that
// gets WRITTEN without being seen -- the chip always shows which account it
// picked, so an unnoticed wrong funder is not possible.

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'mgc.lastFunder.v1';

export async function getLastFunder(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export async function setLastFunder(guid: string): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, guid);
  } catch {
    /* best effort: a forgotten default just means one extra tap */
  }
}
