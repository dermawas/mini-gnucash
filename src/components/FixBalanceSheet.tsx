// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// Fix balance: type what the bank app shows, and the entry takes the difference.
//
// The owner's request, 2026-10-03: "Sometimes i forgot multiple transaction and
// just want to input everything in 1 go, so i just subtract the recorded balance
// with the actual balance and use that as the recorded amount." GnuCash desktop
// lets him type "a - b" in the amount field. The phone's number pad has no minus
// or plus key, and AmountInput's caret handling took two rounds of fixes to get
// right, so the sum is done here instead of inside the field.
//
// The book's number is the PRESENT balance, not the total one the before-and-
// after line shows. The bank has never heard of an entry dated next week, so a
// total that includes one would make every fix wrong by that amount. When the
// two differ, the sheet says so.
//
// A card is compared in what is OWED, as a positive number, because that is
// what a card app shows. The book keeps it negative.

import { useState } from 'react';
import { Text, View, Pressable, StyleSheet } from 'react-native';
import { OverlayModal } from './OverlayModal';
import AmountInput from './AmountInput';
import { formatAmount, parseCurrencyInput } from '../utils/currency';
import { theme, fonts } from '../constants/theme';

export type FixDirection = 'outflow' | 'inflow';

export function FixBalanceSheet({
  visible, name, ccy, scu, owed, present, total, onUse, onDismiss,
}: {
  visible: boolean;
  name: string;
  ccy: string;
  scu: number;
  /** A card or loan: compared in what is owed, not in the book's sign. */
  owed: boolean;
  /** In the book's own sign. null while the balance is still loading. */
  present: number | null;
  total: number | null;
  onUse: (amount: number, direction: FixDirection) => void;
  onDismiss: () => void;
}) {
  const [raw, setRaw] = useState('');
  if (!visible) return null;

  const close = () => { setRaw(''); onDismiss(); };
  const money = (x: number) => formatAmount(x, ccy, scu);

  const book = present == null ? null : owed ? -present : present;
  const typed = raw.trim() !== '';
  // How much the balance FELL that the book does not know about. For a card
  // that is the owed amount going UP, so the subtraction runs the other way.
  const fell = book == null || !typed
    ? null
    : Math.round((owed ? parseCurrencyInput(raw) - book : book - parseCurrencyInput(raw)) * scu) / scu;
  const later = present != null && total != null && total !== present
    ? (owed ? present - total : total - present)
    : 0;

  return (
    <OverlayModal visible onDismiss={close}>
      <Text style={styles.title} numberOfLines={1}>Fix balance: {name}</Text>
      <Text style={styles.blurb}>
        {owed
          ? 'Type what the card app says you owe now. The difference becomes the amount of this entry.'
          : 'Type what the bank app shows now. The difference becomes the amount of this entry.'}
      </Text>

      <View style={styles.line}>
        <Text style={styles.label}>{owed ? 'Owed, in the book' : 'In the book'}</Text>
        <Text style={styles.value}>{book == null ? '…' : money(book)}</Text>
      </View>
      {later !== 0 ? (
        <Text style={styles.note}>
          Leaves out {money(Math.abs(later))} dated after today, which the bank has not seen yet.
        </Text>
      ) : null}
      <View style={styles.line}>
        <Text style={styles.label}>{owed ? 'Owed, actual' : 'Actual now'}</Text>
        <AmountInput
          value={raw}
          onChangeText={setRaw}
          currency={ccy}
          style={styles.input}
          placeholder="0"
          placeholderTextColor={theme.inkFaint}
          autoFocus
        />
      </View>

      <View style={[styles.line, styles.diffLine]}>
        <Text style={styles.label}>Difference</Text>
        <Text
          style={[
            styles.value,
            fell != null && fell > 0 ? { color: theme.coral } : null,
            fell != null && fell < 0 ? { color: theme.moss } : null,
          ]}
        >
          {fell == null ? '' : fell === 0 ? 'Matches the book' : `${money(Math.abs(fell))} ${fell > 0 ? 'out' : 'in'}`}
        </Text>
      </View>

      <View style={styles.buttons}>
        <Pressable style={styles.cancel} onPress={close}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.use, (fell == null || fell === 0) && styles.useOff]}
          disabled={fell == null || fell === 0}
          onPress={() => {
            if (fell == null || fell === 0) return;
            const amount = Math.abs(fell);
            const direction: FixDirection = fell > 0 ? 'outflow' : 'inflow';
            setRaw('');
            onUse(amount, direction);
          }}
        >
          <Text style={styles.useText}>Use this</Text>
        </Pressable>
      </View>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  title: { color: theme.ink, fontSize: 18, fontFamily: fonts.sansMedium },
  blurb: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 6, marginBottom: 10,
    fontFamily: fonts.sans,
  },
  line: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, gap: 12,
  },
  diffLine: { borderTopWidth: 1, borderTopColor: theme.hairline, marginTop: 4 },
  label: { color: theme.inkSoft, fontSize: 13, fontFamily: fonts.sans },
  value: { color: theme.ink, fontSize: 14, fontFamily: fonts.mono },
  note: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.sans, marginTop: -4 },
  input: {
    flex: 1, textAlign: 'right', color: theme.ink, fontSize: 16, fontFamily: fonts.mono,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong, paddingVertical: 4,
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 18 },
  cancel: { paddingVertical: 11, paddingHorizontal: 16 },
  cancelText: { color: theme.inkFaint, fontSize: 14, fontFamily: fonts.sansMedium },
  use: { backgroundColor: theme.ink, borderRadius: 10, paddingVertical: 11, paddingHorizontal: 16 },
  useOff: { opacity: 0.35 },
  useText: { color: theme.bg, fontSize: 13, fontFamily: fonts.sansMedium },
});
