// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Styled to the 2026-09-08 handoff: 72px tall including the safe area, paper
// ground, a hairline on top, 22px icons over 11pt labels, ink when active and
// #8E9188 when not.
//
// The handoff draws FOUR tabs -- Accounts, Spend, Receipt, Settings. This bar
// has two, and that is a deliberate hold rather than an oversight.
//
// Making Spend a tab means the tab keeps its route params. Income is the same
// screen entered as `?direction=inflow`, so once that param is on the tab,
// tapping "Spend" in the bar later can land in Income mode with nothing on
// screen saying so -- money written the wrong way round in a ledger, from a
// navigation detail. Fixing it properly means lifting direction out of the URL
// and putting a visible control on the screen, which is a change to how Spend
// works, not to how it looks.
//
// Receipt could move on its own, but a three-tab bar matches neither design.
// Both stay pushed routes from the Accounts action row until that is settled.

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
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <Icon name="settings" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}
