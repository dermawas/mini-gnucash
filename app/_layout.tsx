// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

import { useEffect, useCallback, useState } from 'react';
import { Alert, AppState } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { theme } from '../src/constants/theme';
import {
  IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold,
} from '@expo-google-fonts/ibm-plex-sans';
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono';
import * as Sentry from '@sentry/react-native';
import { useConnection } from '../src/store/connectionStore';
import { readInFlight, clearInFlight, checkRequest } from '../src/services/api';
import { isCrashReportingEnabled, loadCrashReportingPreference } from '../src/services/crashReporting';

SplashScreen.preventAutoHideAsync();

const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;

// Crash reporting is OFF by default and gated in beforeSend rather than via
// `enabled`. Sentry.init() runs at module scope, before any async read of the
// stored preference can resolve, so `enabled` would be decided from a value we
// do not have yet. A source build with no DSN is inert by construction.
Sentry.init({
  dsn: SENTRY_DSN,
  enabled: !!SENTRY_DSN,
  tracesSampleRate: 0,
  beforeSend: (event) => (isCrashReportingEnabled() ? event : null),
});

/**
 * Resolve a write that was interrupted between the server committing and the
 * response arriving.
 *
 * The id was parked on disk before the request went out. If it turns out the
 * write landed, say so and clear the marker. If it did not, say that too, so
 * the entry can be made again without wondering. If we still cannot reach the
 * server, leave the marker alone and try again next launch -- guessing either
 * way is what produces a duplicate transaction in someone's ledger.
 */
async function resolveInterruptedWrite() {
  const pending = await readInFlight();
  if (!pending) return;

  const result = await checkRequest(pending.requestId);
  if (!result.ok) return; // still unreachable; the marker survives

  if (result.data.found) {
    await clearInFlight();
    Alert.alert(
      'That did go through',
      `"${pending.label}" reached your book before the connection dropped. Nothing more to do, and do not enter it again.`,
    );
    return;
  }

  await clearInFlight();
  Alert.alert(
    'That did not go through',
    `"${pending.label}" never reached your book. Nothing was written, so it is safe to enter again.`,
  );
}

function RootLayout() {
  const refresh = useConnection((s) => s.refresh);
  const [ready, setReady] = useState(false);

  // IBM Plex, per the 2026-09-08 design handoff. The keys ARE the family
  // names used in styles, which is why they are spelled out rather than
  // spread -- `src/constants/theme.ts` names the same strings in `fonts`.
  //
  // DM Serif Display is no longer loaded. The handoff sets screen titles in
  // Sans 500; the .ttf and its licence stay in assets/fonts rather than being
  // deleted, so going back is a one-line change.
  const [fontsLoaded] = useFonts({
    IBMPlexSans_400Regular,
    IBMPlexSans_500Medium,
    IBMPlexSans_600SemiBold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  });

  useEffect(() => {
    loadCrashReportingPreference();
    refresh()
      .then(resolveInterruptedWrite)
      .finally(() => setReady(true));
  }, [refresh]);

  // Re-check on foreground. There is deliberately no background poller: the
  // only thing it would buy is a fresher badge, at the cost of waking the radio
  // on a schedule nobody asked for. Every real call updates the state anyway.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded && ready) SplashScreen.hideAsync();
  }, [fontsLoaded, ready]);

  if (!fontsLoaded || !ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayoutRootView}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
