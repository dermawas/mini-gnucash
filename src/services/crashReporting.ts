// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

// Opt-in gate for Sentry crash reporting. Default OFF.
//
// Why crash reporting survives the telemetry cull at all: in a local-first
// app the maintainer cannot look at your data to work out what went wrong.
// Without a stack trace, a bug report is just "it crashed." That is a real,
// direct benefit to the person who opts in — unlike product analytics, which
// only ever benefited us.
//
// Why it defaults to off anyway: an app whose pitch is "your data stays on
// your device" does not get to quietly ship an exception to that on first
// launch. The user turns it on, or it never sends anything.
//
// ---------------------------------------------------------------------------
// Implementation note — why a beforeSend gate rather than Sentry's `enabled`
// ---------------------------------------------------------------------------
// Sentry.init() runs at module scope in app/_layout.tsx, before any async
// storage read can complete, so `enabled` cannot be set from the persisted
// preference at init time. Re-initialising later is worse. Instead Sentry is
// initialised once with a beforeSend hook that consults this module's
// synchronous in-memory flag, which starts false and is flipped once the
// preference loads. Net effect: nothing is ever transmitted before the
// preference is known, and app start is never blocked waiting for it.

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'mgc_crash_reporting_enabled';

let enabled = false;

// Read synchronously by Sentry's beforeSend on every event.
export function isCrashReportingEnabled(): boolean {
  return enabled;
}

// Call once at app start. Failure is silent and leaves reporting off, which
// is the safe direction — a storage error must never accidentally opt someone
// in.
export async function loadCrashReportingPreference(): Promise<boolean> {
  try {
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    enabled = stored === 'true';
  } catch {
    enabled = false;
  }
  return enabled;
}

export async function setCrashReportingEnabled(next: boolean): Promise<void> {
  enabled = next;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // In-memory flag still took effect for this session.
  }
}
