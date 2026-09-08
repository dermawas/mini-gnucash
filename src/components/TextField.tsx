// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The project's one text field.
//
// Before this there were six hand-rolled `<TextInput>`s with six private
// style blocks -- connect (x3), SettingRow, settings' ledger editor and
// Entry's description -- which had already drifted into two border weights,
// two radii, two paddings and two font sizes with no rule behind any of it.
// Every one of them also repeated `placeholderTextColor` by hand, so a field
// that forgot it got the platform's grey instead of the palette's.
//
// ---------------------------------------------------------------------------
// The two variants, and why the difference is kept
// ---------------------------------------------------------------------------
// The drift turned out to encode something real, so it is stated here rather
// than flattened away:
//
//   'form'   -- always on screen. Paper ground, hairline border. It is one of
//               several fields in a form and should not shout.
//   'active' -- exists ONLY while you are editing. Page ground, a 1.5px ink
//               border. Used where a value is normally read-only text and a
//               tap swapped it for a field (Settings, the ledger editor), and
//               for the account sheet's search box, which is the one thing in
//               that sheet you are expected to type into.
//
// The heavier border is the affordance that says "this is live now". Anything
// permanently on screen takes 'form'.
//
// ---------------------------------------------------------------------------
// What deliberately does NOT use this
// ---------------------------------------------------------------------------
//   * `AmountInput` -- wraps TextInput to reformat thousands separators as you
//     type, and money is set right-aligned in the mono face. It is a different
//     component on purpose, not an oversight.
//   * Entry's per-line memo -- has no box at all. It sits underneath the
//     account name INSIDE a row, and a border there would fight the row.
//     Its lack of a frame is what makes the row read as one thing.

import React from 'react';
import { TextInput, TextInputProps, StyleSheet, StyleProp, TextStyle } from 'react-native';
import { theme, fonts } from '../constants/theme';

type Props = Omit<TextInputProps, 'placeholderTextColor'> & {
  variant?: 'form' | 'active';
  /** Set values in the mono face: tokens, URLs, keys. */
  mono?: boolean;
  /** For margins only. Do not restyle the field here -- change the variant. */
  style?: StyleProp<TextStyle>;
};

export function TextField({ variant = 'form', mono, style, multiline, ...rest }: Props) {
  return (
    <TextInput
      {...rest}
      multiline={multiline}
      placeholderTextColor={theme.inkFaint}
      style={[
        styles.base,
        variant === 'active' ? styles.active : styles.form,
        mono ? styles.mono : null,
        multiline ? styles.multiline : null,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    color: theme.ink,
    fontSize: 15,
    fontFamily: fonts.sans,
    minHeight: 44,
  },
  form: {
    backgroundColor: theme.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.hairlineStrong,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  active: {
    backgroundColor: theme.bg,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: theme.ink,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  mono: { fontFamily: fonts.mono },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
});
