// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// A tappable pill that shows a chosen value and opens the thing that changes
// it. Entry's header holds two of them side by side -- the date and the
// funding account -- and they were separately defined in two files with
// identical values, which is exactly the arrangement that drifts.
//
// It carries no state and does no choosing. It is the box and the label.

import React from 'react';
import { Text, Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { theme, fonts } from '../constants/theme';

type Props = {
  label: string;
  onPress: () => void;
  /** Marks a value that needs a second look -- a date far from today. */
  warn?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function Chip({ label, onPress, warn, style, accessibilityLabel }: Props) {
  return (
    <Pressable
      style={[styles.chip, warn ? styles.warn : null, style]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      <Text style={styles.text} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: theme.surface, borderRadius: 8,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 9, paddingHorizontal: 12,
    // So a long account name shortens instead of pushing the date chip off
    // the row. Harmless where there is room.
    flexShrink: 1,
  },
  warn: { borderColor: theme.amber },
  text: { color: theme.ink, fontSize: 13, fontFamily: fonts.sans },
});
