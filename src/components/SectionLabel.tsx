// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// The small tracked capitals that name a block: ACCOUNTS, INSIDE, TO, PAID BY,
// MONEY BACK, DESCRIPTION.
//
// Two copies existed, on Accounts and on Entry, and they had drifted a point
// of size and a tenth of letter-spacing apart -- not a decision anyone made,
// just two files. Settled here at the Accounts values, which are the ones on
// the screen you read rather than type into.
//
// The CONTAINER these sit in is deliberately not shared. Accounts pairs the
// label with a count and aligns to the baseline; Entry pairs it with the Scan
// button and centres. A label beside a number and a label beside a control
// want different vertical alignment, so each screen keeps its own head row.

import React from 'react';
import { Text, StyleSheet, StyleProp, TextStyle } from 'react-native';
import { theme, fonts } from '../constants/theme';

export function SectionLabel({
  children,
  style,
}: {
  children: React.ReactNode;
  /** Margins, and the one colour override: MONEY BACK takes the accent. */
  style?: StyleProp<TextStyle>;
}) {
  return <Text style={[styles.label, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  label: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1.1, fontFamily: fonts.sansMedium,
  },
});
