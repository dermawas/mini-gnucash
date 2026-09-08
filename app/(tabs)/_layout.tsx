// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Styled to the 2026-09-08 handoff: 72px tall including the safe area, paper
// ground, a hairline on top, 22px icons over 11pt labels, ink when active and
// #8E9188 when not.
//
// Three tabs: Accounts, Entry, Settings. The handoff draws four, with
// Transfer beside Entry, and that fourth one was built and then removed on
// 2026-09-08.
//
// The reason is that a transfer is not a different KIND of thing. It is an
// entry whose other side happens to be an account of your own -- same date,
// same description, same two-column form, same double-entry underneath. The
// separate screen forced a choice before you had typed anything ("is this an
// expense or a transfer?") and then could not be corrected without starting
// again, which is the same silent-mode problem the direction segment exists to
// avoid. It also could not hold a transfer fee, because a fee is an ordinary
// expense split and that screen only had room for two accounts.
//
// So Move is now the third position of the Out / In segment on Entry, and the
// screen changes what the sections are called rather than which screen you are
// on. Direction stays in-screen state, never a route param: a param lingers,
// and money written the wrong way round from a navigation detail is exactly
// the failure this arrangement is shaped to prevent.

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
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color }) => <Icon name="settings" size={22} color={color} />,
        }}
      />
    </Tabs>
  );
}
