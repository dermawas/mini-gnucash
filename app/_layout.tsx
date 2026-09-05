// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

import { useEffect, useCallback, useState } from 'react';
import { AppState } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import * as Sentry from '@sentry/react-native';
import { useConnection } from '../src/store/connectionStore';
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

function RootLayout() {
  const refresh = useConnection((s) => s.refresh);
  const [ready, setReady] = useState(false);

  const [fontsLoaded] = useFonts({
    DMSerifDisplay: require('../assets/fonts/DMSerifDisplay-Regular.ttf'),
  });

  useEffect(() => {
    loadCrashReportingPreference();
    refresh().finally(() => setReady(true));
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
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default Sentry.wrap(RootLayout);
