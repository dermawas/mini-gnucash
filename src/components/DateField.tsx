// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The post date for anything this app writes.
//
// One component for all three writing screens -- Scan review, Spend and
// Transfer -- so the date behaves identically wherever it is set, and a fix
// lands in one place. Spend and Transfer had no date control at all before
// this: both hardcoded today(), so nothing backdated could be entered from the
// phone.
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
import { theme } from '../constants/theme';
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
}: {
  value: string;
  onChange: (iso: string) => void;
  /** Screen-specific line under the field, e.g. where the date came from. */
  caption?: string;
}) {
  const [open, setOpen] = useState(false);
  const concern = dateConcern(value);
  const isToday = value === todayIso();

  // An invalid stored value must still open the picker on something real,
  // otherwise the calendar has nothing to show.
  const asDate = isValidIsoDate(value) ? new Date(`${value}T00:00:00`) : new Date();

  return (
    <View>
      <View style={styles.row}>
        <Pressable
          style={[styles.field, concern ? styles.fieldWarn : null]}
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Date, ${humanise(value)}. Tap to change.`}
        >
          <Text style={styles.value}>{humanise(value)}</Text>
        </Pressable>
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
    backgroundColor: theme.surface, borderRadius: 8,
    paddingVertical: 12, paddingHorizontal: 14,
  },
  fieldWarn: { borderWidth: 1, borderColor: theme.amber },
  value: { color: theme.ink, fontSize: 14 },
  today: { paddingVertical: 10, paddingHorizontal: 14 },
  todayText: { color: theme.accent, fontSize: 13, fontWeight: '600' },
  caption: { color: theme.inkFaint, fontSize: 12, marginTop: 6 },
  warn: { color: theme.amber, fontSize: 12, lineHeight: 18, marginTop: 8 },
});
