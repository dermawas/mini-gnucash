// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// The post date for anything this app writes.
//
// One component wherever this app writes -- which is now the single Entry
// screen, in its `chip` variant. It was built when Scan review, Spend and
// Transfer were three separate screens with three separate ideas about dates,
// two of which hardcoded today() and so could not record anything after the
// fact at all.
//
// A native calendar, not a text box. The first version of this was a
// `TextInput` expecting YYYY-MM-DD, and driving it proved how bad that is:
// `maxLength` silently clipped an append back to the original value, the
// cursor landed mid-string, and clearing needed paced deletes. A date is a
// date; the platform has a picker for it.
//
// The warning underneath is the point of the whole thing. A GoCar ride was
// written to the production book dated 1,049 days in the past because the
// model misread the receipt and nothing on screen questioned it.

import { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { theme, fonts } from '../constants/theme';
import { Chip } from './Chip';
import { todayIso, isValidIsoDate, dateConcern } from '../utils/receiptDate';

/** How the date reads on screen. The ISO value is what gets written. */
function humanise(iso: string): string {
  if (!isValidIsoDate(iso)) return iso || 'Pick a date';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

export function DateField({
  value,
  onChange,
  caption,
  variant = 'field',
}: {
  value: string;
  onChange: (iso: string) => void;
  /** Screen-specific line under the field, e.g. where the date came from. */
  caption?: string;
  /**
   * 'chip' is the compact form the 2026-09-08 handoff puts at the top of
   * Spend, beside the funding account. It is the same control -- same native
   * calendar, same warning underneath -- drawn small enough to sit in a row of
   * two. The full 'field' stays the default because Scan review needs the date
   * to have visual weight: a misread receipt date is the reason that warning
   * exists.
   */
  variant?: 'field' | 'chip';
}) {
  const [open, setOpen] = useState(false);
  const concern = dateConcern(value);
  const isToday = value === todayIso();

  // An invalid stored value must still open the picker on something real,
  // otherwise the calendar has nothing to show.
  const asDate = isValidIsoDate(value) ? new Date(`${value}T00:00:00`) : new Date();
  const chip = variant === 'chip';

  return (
    <View>
      <View style={styles.row}>
        {chip ? (
          <Chip
            label={isToday ? 'Today' : humanise(value)}
            warn={!!concern}
            onPress={() => setOpen(true)}
            accessibilityLabel={`Date, ${humanise(value)}. Tap to change.`}
          />
        ) : (
          <Pressable
            style={[styles.field, concern ? styles.fieldWarn : null]}
            onPress={() => setOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Date, ${humanise(value)}. Tap to change.`}
          >
            <Text style={styles.value}>{humanise(value)}</Text>
          </Pressable>
        )}
        {!isToday ? (
          <Pressable style={styles.today} onPress={() => onChange(todayIso())}>
            <Text style={styles.todayText}>Today</Text>
          </Pressable>
        ) : null}
      </View>

      {caption ? <Text style={styles.caption}>{caption}</Text> : null}
      {concern ? <Text style={styles.warn}>{concern}</Text> : null}

      {open ? (
        <DateTimePicker
          value={asDate}
          mode="date"
          display={Platform.OS === 'ios' ? 'inline' : 'calendar'}
          // A receipt cannot be for a purchase that has not happened, so the
          // calendar simply does not offer one. The future branch of
          // dateConcern still exists for a value that arrived some other way.
          maximumDate={new Date()}
          onChange={(event, picked) => {
            setOpen(false);
            if (event.type !== 'set' || !picked) return;
            const p = (n: number) => String(n).padStart(2, '0');
            onChange(
              `${picked.getFullYear()}-${p(picked.getMonth() + 1)}-${p(picked.getDate())}`,
            );
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  field: {
    backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 12, paddingHorizontal: 14,
  },
  fieldWarn: { borderWidth: 1, borderColor: theme.amber },
  value: { color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  today: { paddingVertical: 10, paddingHorizontal: 14 },
  todayText: { color: theme.ink, fontSize: 13, fontFamily: fonts.sansSemi },
  caption: { color: theme.inkFaint, fontSize: 12, marginTop: 6, fontFamily: fonts.sans },
  // Bold, matching the total-mismatch warning on the entry screen. Both are
  // asking you to check a number before it reaches the book, so they should
  // read as the same kind of thing.
  warn: { color: theme.coral, fontSize: 12, lineHeight: 18, marginTop: 8, fontFamily: fonts.sansSemi },
});
