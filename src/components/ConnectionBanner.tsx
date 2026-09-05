// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Says what is actually true about the connection, in the places where being
// wrong would matter.
//
// The bar for this component: never imply data is current when it is not, and
// never send someone to check their VPN when the real problem is their token.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useConnection } from '../store/connectionStore';
import { theme } from '../constants/theme';

export function ConnectionBanner({ onPress }: { onPress?: () => void }) {
  const state = useConnection((s) => s.state);
  const lockedBy = useConnection((s) => s.lockedBy);
  const lastError = useConnection((s) => s.lastError);

  if (state === 'online' || state === 'unknown') return null;

  let tint: string = theme.amber;
  let text: string;

  switch (state) {
    case 'locked':
      // Amber, not coral: nothing is wrong, one capability is temporarily gone.
      text = `GnuCash desktop has the book open${lockedBy ? ` on ${lockedBy}` : ''}. You can look, but not save.`;
      break;
    case 'offline':
      text = 'Not connected to your ledger. Balances and history live in GnuCash and cannot be read from here.';
      break;
    case 'unauthorized':
      tint = theme.coral;
      text = lastError || 'Your server credentials were rejected. Check them in Settings.';
      break;
    case 'unconfigured':
      text = 'Connect to your GnuCash server to get started.';
      break;
    default:
      return null;
  }

  const Wrapper: any = onPress ? Pressable : View;
  return (
    <Wrapper onPress={onPress} style={[styles.bar, { borderLeftColor: tint }]}>
      <Text style={[styles.dot, { color: tint }]}>●</Text>
      {/* Status colour goes on the indicator, not the words. A tinted sentence
          shouts a state the glyph already conveys. */}
      <Text style={styles.text}>{text}</Text>
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: theme.surface,
    borderLeftWidth: 3,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  dot: { fontSize: 11, marginRight: 10, marginTop: 3 },
  text: { color: theme.inkSoft, fontSize: 13, lineHeight: 19, flex: 1 },
});
