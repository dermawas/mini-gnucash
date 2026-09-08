// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Styled to the 2026-09-08 handoff: 72px tall including the safe area, paper
// ground, a hairline on top, 22px icons over 11pt labels, ink when active and
// #8E9188 when not.
//
// Four tabs, as the handoff draws them: Accounts, Entry, Transfer, Settings.
//
// This was two tabs until 2026-09-08, and the objection to widening it was
// specific: Spend as a tab kept its route params, and Income was the same
// screen at `?direction=inflow`, so tapping "Spend" later could land in Income
// mode with nothing on screen saying so -- money written the wrong way round
// from a navigation detail.
//
// Board Turn 5 removes that. Direction is now in-screen state with an Out/In
// segmented control that recolours the whole surface, so there is no param to
// linger and no silent mode. The objection is gone and the tab is safe.

import { Tabs } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from '../../src/components/Icon';
import { theme, fonts } from '../../src/constants/theme';

export default function TabsLayout() {
  // The handoff specifies a 72px bar "incl. safe area". Hardcoding height 72
  // and a fixed paddingBottom is what that sentence reads like, and it is
  // wrong on a device with a system navigation bar: the nav bar sits on top of
  // the tab bar and slices through both labels. Verified on the S10, which has
  // the three-button bar.
  //
  // So 72 is the bar ABOVE the inset, and the inset is added to it. On a
  // gesture-navigation device inset.bottom is ~0 and this is exactly 72.
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.ink,
        tabBarInactiveTintColor: theme.tabInactive,
        tabBarStyle: {
          backgroundColor: theme.bg,
          borderTopColor: theme.hairlineStrong,
          borderTopWidth: 1,
          height: 72 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 14,
          elevation: 0,
        },
        tabBarLabelStyle: { fontSize: 11, fontFamily: fonts.sans },
      }}
    >
      <Tabs.Screen
        name="accounts"
        options={{
          title: 'Accounts',
          tabBarIcon: ({ color }) => <Icon name="accounts" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="entry"
        options={{
          title: 'Entry',
          tabBarIcon: ({ color }) => <Icon name="spend" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="transfer"
        options={{
          title: 'Transfer',
          tabBarIcon: ({ color }) => <Icon name="transfer" size={22} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <Icon name="settings" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}
