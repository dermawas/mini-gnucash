// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

import { Tabs } from 'expo-router';
import Icon from '@react-native-vector-icons/material-design-icons';
import { theme } from '../../src/constants/theme';

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: theme.accent,
        tabBarInactiveTintColor: theme.inkFaint,
        tabBarStyle: { backgroundColor: theme.surface, borderTopColor: theme.hairline },
      }}
    >
      <Tabs.Screen
        name="accounts"
        options={{
          title: 'Accounts',
          tabBarIcon: ({ color, focused }) => (
            <Icon name={focused ? 'wallet' : 'wallet-outline'} size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, focused }) => (
            <Icon name={focused ? 'cog' : 'cog-outline'} size={24} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
