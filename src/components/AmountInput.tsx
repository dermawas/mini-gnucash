// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

import React from 'react';
import { TextInput, TextInputProps } from 'react-native';
import { formatAmountInput, cleanAmountInput } from '../utils/currency';

interface AmountInputProps extends Omit<TextInputProps, 'value' | 'onChangeText' | 'keyboardType'> {
  value: string; // raw numeric string (e.g. "1000000"), no separators — same shape callers already store
  onChangeText: (raw: string) => void;
  currency?: string;
}

// Wraps TextInput to live-format amounts with locale-correct thousand
// separators as the user types (e.g. "1.000.000" for IDR, "1,000,000" for
// USD), while the value handed to onChangeText/parseFloat stays a plain
// digit string — callers don't need to change how they store/parse amounts.
export default function AmountInput({ value, onChangeText, currency = 'IDR', ...rest }: AmountInputProps) {
  return (
    <TextInput
      {...rest}
      keyboardType="numeric"
      value={formatAmountInput(value, currency)}
      onChangeText={(text) => onChangeText(cleanAmountInput(text, currency))}
    />
  );
}
