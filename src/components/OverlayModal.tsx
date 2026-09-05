// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The project's one modal pattern, in one place so it is applied by
// construction rather than by remembering.
//
// It is NOT React Native's <Modal>, and it does NOT use KeyboardAvoidingView.
// Both are deliberate and both were settled the hard way in this codebase's
// predecessor: five separate KeyboardAvoidingView configurations were tried
// against a transparent native Modal on Android and every one of them was
// broken on-device -- covered fields, screen jumping, or oscillation.
//
// What works instead: an absolutely-positioned overlay View, with the sheet
// inside a plain ScrollView carrying a large paddingBottom. That padding is
// invisible when the keyboard is closed, and gives the ScrollView real overflow
// to drag the sheet clear of the keyboard when it is open.
//
// Two further rules learned on-device, both encoded here:
//   * no maxHeight on the sheet -- a plain View does not scroll its own
//     overflow, so a maxHeight silently clips the buttons off the bottom once
//     content grows.
//   * chip rows inside must be flexWrap grids, never horizontal ScrollViews.
//     A nested horizontal GestureScrollView rendered completely empty on some
//     devices and the root cause was never isolated.

import React from 'react';
import { View, ScrollView, Pressable, StyleSheet } from 'react-native';
import { theme } from '../constants/theme';

type Props = {
  visible: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
};

export function OverlayModal({ visible, onDismiss, children }: Props) {
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
      >
        {/* Tapping the dimmed area dismisses; the sheet itself must not. */}
        <Pressable style={styles.backdrop} onPress={onDismiss} />
        <View style={styles.sheet}>{children}</View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#00000080',
    zIndex: 1000,
    elevation: 1000,
  },
  scroll: {
    flexGrow: 1,
    justifyContent: 'flex-end',
    // The manual keyboard buffer. Do not remove; see the header.
    paddingBottom: 300,
  },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    backgroundColor: theme.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
  },
});
