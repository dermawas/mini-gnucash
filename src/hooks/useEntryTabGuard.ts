// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// Stops a tap on Accounts or Settings from silently walking away from a
// half-built entry on the Entry tab. Switching Out/In/Move already asks
// (`chooseDirection` in entry.tsx); this is the same question for the other
// way off the screen.
//
// A tab screen only ever hears its OWN `tabPress`, whether or not it is the
// one currently focused -- so the ask lives here, on the tabs being pressed,
// not on Entry itself.

import { useEffect } from 'react';
import { Alert } from 'react-native';
import { useNavigation } from 'expo-router';
import { useEntryDraft } from '../store/entryDraftStore';

/**
 * The bottom-tab navigator's own `tabPress` event. `useNavigation()`'s type
 * does not know it exists -- this app has no direct dependency on
 * `@react-navigation/bottom-tabs`, only expo-router's bundled copy of it --
 * so the shape is stated here rather than reached for with `any`.
 */
type TabNavigation = {
  addListener(type: 'tabPress', cb: (e: { preventDefault(): void }) => void): () => void;
  navigate(routeName: string): void;
};

/**
 * `routeName` is this screen's OWN name in `app/(tabs)/_layout.tsx`
 * ('accounts' or 'settings') -- confirming here always means "finish
 * arriving at the tab whose icon was just pressed", so that is simply
 * navigated to directly.
 *
 * An earlier version tried to replay the tabPress event's own navigation
 * action (`navigation.dispatch(e.data.action)`), on the assumption that is
 * what the official recipe for this does. On this device it cleared the
 * entry on "Discard" but never actually left the screen: the event's `data`
 * did not carry an `action` in expo-router's bundled navigator the way plain
 * `@react-navigation/bottom-tabs` docs assume. Navigating explicitly needs no
 * assumption about that shape.
 */
export function useEntryTabGuard(routeName: 'accounts' | 'settings') {
  const navigation = useNavigation() as unknown as TabNavigation;
  const dirty = useEntryDraft((s) => s.dirty);
  const requestClear = useEntryDraft((s) => s.requestClear);

  useEffect(() => navigation.addListener('tabPress', (e) => {
    if (!dirty) return;
    e.preventDefault();
    Alert.alert(
      'Discard this entry?',
      'Nothing has been written to your book yet.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: () => { requestClear(); navigation.navigate(routeName); },
        },
      ],
    );
  }), [navigation, dirty, requestClear, routeName]);
}
