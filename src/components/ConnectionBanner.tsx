// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Says what is actually true about the connection, in the places where being
// wrong would matter.
//
// The bar for this component: never imply data is current when it is not, and
// never send someone to check their VPN when the real problem is their token.
//
// Styled to the 2026-09-08 handoff's inset banner -- margin 4/16/0, padding
// 8x12, radius 10, 12px text, a 7px status dot, and an optional bold action on
// the right. Three tones, mapped onto this app's real connection states:
//
//   parchment  offline / not set up yet   calm, nothing is broken
//   copper     locked / rejected          needs you
//
// TWO DEPARTURES FROM THE HANDOFF'S COPY, both deliberate:
//
//   * It writes the offline banner as "Offline · 3 changes queued". This app
//     has no queue. It is a thin client over the book -- a write either
//     reaches PostgREST or it does not happen -- so a queued-changes count
//     would be a claim about the user's data that is never true. The shape of
//     the line is kept; the second half says what is actually withheld.
//
//   * Its "conflict" tone is captioned "Book changed on desktop" with a
//     "Review" action. There is no review flow here and no divergence to
//     reconcile: the real state is that GnuCash desktop holds the lock, so
//     writing is refused until it lets go. Same tone, true sentence, and no
//     action, because there is nothing this app can do about it.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useConnection } from '../store/connectionStore';
import { theme, fonts } from '../constants/theme';

export function ConnectionBanner({ onPress }: { onPress?: () => void }) {
  const state = useConnection((s) => s.state);
  const lockedBy = useConnection((s) => s.lockedBy);
  const lastError = useConnection((s) => s.lastError);
  const refresh = useConnection((s) => s.refresh);

  if (state === 'online' || state === 'unknown') return null;

  let tone: 'calm' | 'attention' = 'calm';
  let text: string;
  let action: { label: string; run: () => void } | null = null;

  switch (state) {
    case 'locked':
      tone = 'attention';
      text = `Book open in GnuCash${lockedBy ? ` on ${lockedBy}` : ''} · look, don't save`;
      break;
    case 'offline':
      text = 'Offline · balances live in GnuCash';
      action = { label: 'Retry', run: () => { void refresh(); } };
      break;
    case 'unauthorized':
      tone = 'attention';
      text = lastError || 'Credentials rejected · check them in Settings';
      break;
    case 'unconfigured':
      text = 'Connect to your GnuCash server to get started';
      break;
    default:
      return null;
  }

  const attention = tone === 'attention';
  const fg = attention ? theme.copperDark : theme.ink;
  const Wrapper: any = onPress ? Pressable : View;

  return (
    <Wrapper
      onPress={onPress}
      style={[styles.bar, { backgroundColor: attention ? theme.copperTint : theme.surfaceSoft }]}
    >
      {/* Status colour goes on the indicator, not the words. A tinted sentence
          shouts a state the dot already conveys. */}
      <View style={[styles.dot, { backgroundColor: attention ? theme.coral : theme.inkFaint }]} />
      <Text style={[styles.text, { color: fg }]}>{text}</Text>
      {action ? (
        <Pressable onPress={action.run} hitSlop={10} accessibilityRole="button">
          <Text style={[styles.action, { color: fg }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 4,
    marginHorizontal: 16,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 9 },
  text: { fontSize: 12, lineHeight: 17, flex: 1, fontFamily: fonts.sans },
  action: { fontSize: 12, fontFamily: fonts.sansSemi, marginLeft: 12 },
});
