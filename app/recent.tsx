// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// What was entered lately, across the whole book.
//
// Every other read in this app is anchored to an account, and sorted on
// post_date. This one is neither, deliberately.
//
// The question it answers is "did that save, and did it save what I meant",
// which is a question about YOUR ACTION, not about when the money moved. A
// receipt scanned today for a ride taken two years ago has an enter_date of
// today and a post_date of two years ago. It belongs at the top of this list
// and nowhere near a register. The dev book holds exactly that entry.
//
// Every leg is shown, not just the total. That is the point: a Gocar receipt
// that should be two lines and a funder is only verifiable if you can see
// whether both lines are actually there.
//
// Read-only, like every other view of an existing transaction. Corrections
// belong in GnuCash desktop.

import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, RefreshControl, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Icon } from '../src/components/Icon';
import { ConnectionBanner } from '../src/components/ConnectionBanner';
import { useConnection } from '../src/store/connectionStore';
import { getRecentEntries, type RecentEntries, type RecentEntry } from '../src/services/api';
import { formatAmount } from '../src/utils/currency';
import { theme, fonts } from '../src/constants/theme';
import { usePrivacy, maskIfHidden } from '../src/store/privacyStore';

// Hours, and what to call them. Kept short: this screen is for checking a
// thing you just did, not for browsing history. That is what a register is for.
const WINDOWS: { label: string; hours: number }[] = [
  { label: '24 hours', hours: 24 },
  { label: '3 days', hours: 72 },
  { label: '7 days', hours: 168 },
];

export default function RecentEntriesScreen() {
  const router = useRouter();
  const hidden = usePrivacy((s) => s.hidden);
  const toggleHidden = usePrivacy((s) => s.toggle);
  const loadPrivacy = usePrivacy((s) => s.load);
  const connState = useConnection((s) => s.state);

  const [hours, setHours] = useState(24);
  const [data, setData] = useState<RecentEntries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const result = await getRecentEntries(hours, 50);
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      // Nothing stale is left on screen. Rule 3 of the accounts tab: a figure
      // presented as current when it is not is the failure this app exists to
      // avoid, and that applies to a list of entries just as much as a balance.
      setData(null);
      setError(result.error);
    }
    setLoading(false);
  }, [hours]);

  useEffect(() => {
    loadPrivacy();
  }, [loadPrivacy]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Local time, from the UTC the server sends. The server stores and returns
  // UTC; a person reading this screen wants the clock on their own wall.
  function enteredAt(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  // Shown only when it differs from the day the entry was made, because that
  // is the case worth flagging. An entry keyed in today for today needs no
  // second date; one keyed in today for 2024 very much does.
  function datedNote(row: RecentEntry): string | null {
    const entered = new Date(row.enter_date);
    if (Number.isNaN(entered.getTime())) return null;
    const enteredDay = [
      entered.getFullYear(),
      String(entered.getMonth() + 1).padStart(2, '0'),
      String(entered.getDate()).padStart(2, '0'),
    ].join('-');
    return row.post_date === enteredDay ? null : `dated ${row.post_date}`;
  }

  function renderRow({ item }: { item: RecentEntry }) {
    const dated = datedNote(item);
    const currency = item.currency ?? 'IDR';
    return (
      <View style={styles.row}>
        <View style={styles.rowHead}>
          <View style={styles.rowMain}>
            <Text style={styles.rowDesc} numberOfLines={1}>
              {item.description || '(no description)'}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {enteredAt(item.enter_date)}
              {dated ? ` · ${dated}` : ''}
              {item.from_phone ? ' · from this app' : ''}
            </Text>
          </View>
          <Text style={styles.rowAmount} numberOfLines={1}>
            {maskIfHidden(formatAmount(item.amount, currency), hidden)}
          </Text>
        </View>

        {/*
          Every leg. A two-line receipt that saved as one line is invisible
          from a total alone, and that is precisely the mistake this screen is
          meant to catch.
        */}
        <View style={styles.splits}>
          {item.splits.map((s, i) => (
            <View key={`${item.tx_guid}-${i}`} style={styles.splitRow}>
              <Text style={styles.splitName} numberOfLines={1}>
                {s.account_name}
                {s.memo ? <Text style={styles.splitMemo}>{`  ${s.memo}`}</Text> : null}
              </Text>
              <Text style={[styles.splitAmount, s.quantity < 0 ? styles.neg : styles.pos]}>
                {maskIfHidden(formatAmount(s.quantity, s.commodity ?? currency), hidden)}
              </Text>
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ConnectionBanner />

      <Pressable onPress={() => router.back()} style={styles.crumbRow} hitSlop={8}>
        <Icon name="chevronLeft" size={14} color={theme.inkFaint} />
        <Text style={styles.crumb} numberOfLines={1}>Accounts</Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.h1} numberOfLines={1}>Recently added</Text>
          <Text style={styles.sub} numberOfLines={1}>
            {data
              ? `${data.total_in_window} entered · by the time you keyed them in`
              : 'by the time you keyed them in'}
          </Text>
        </View>
        <Pressable
          onPress={toggleHidden}
          hitSlop={12}
          style={styles.eye}
          accessibilityRole="button"
          accessibilityLabel={hidden ? 'Show amounts' : 'Hide amounts'}
        >
          <Icon name={hidden ? 'hide' : 'show'} size={22} color={theme.inkSoft} />
        </Pressable>
      </View>

      <View style={styles.windows}>
        {WINDOWS.map((w) => (
          <Pressable
            key={w.hours}
            onPress={() => setHours(w.hours)}
            style={[styles.window, hours === w.hours && styles.windowOn]}
            accessibilityRole="button"
            accessibilityState={{ selected: hours === w.hours }}
          >
            <Text style={[styles.windowText, hours === w.hours && styles.windowTextOn]}>
              {w.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator style={styles.spinner} color={theme.ink} />
      ) : (
        <FlatList
          data={data?.rows ?? []}
          keyExtractor={(item) => item.tx_guid}
          contentContainerStyle={styles.list}
          renderItem={renderRow}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={theme.ink} />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {error
                ? error
                : connState !== 'online'
                  ? 'Offline. Nothing is shown rather than something out of date.'
                  : 'Nothing entered in this window.'}
            </Text>
          }
          ListFooterComponent={
            data?.truncated ? (
              <Text style={styles.truncated}>
                Showing the {data.row_count} most recent of {data.total_in_window}.
              </Text>
            ) : null
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  crumbRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4,
  },
  crumb: { color: theme.inkFaint, fontSize: 12, marginLeft: 3, fontFamily: fonts.sans },
  header: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 20, paddingBottom: 12, paddingTop: 4,
  },
  headerText: { flex: 1, marginRight: 12 },
  h1: { color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium },
  sub: { color: theme.inkFaint, fontSize: 12, marginTop: 3, fontFamily: fonts.sans },
  eye: { marginLeft: 12, paddingTop: 4 },
  windows: {
    flexDirection: 'row', paddingHorizontal: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  window: {
    paddingHorizontal: 12, paddingVertical: 6, marginRight: 8,
    borderRadius: 14, borderWidth: 1, borderColor: theme.hairlineStrong,
  },
  windowOn: { backgroundColor: theme.ink, borderColor: theme.ink },
  windowText: { color: theme.inkSoft, fontSize: 12, fontFamily: fonts.sans },
  windowTextOn: { color: theme.bg, fontFamily: fonts.sansMedium },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 20, paddingBottom: 20 },
  row: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: theme.hairline },
  rowHead: { flexDirection: 'row', alignItems: 'flex-start' },
  rowMain: { flex: 1, marginRight: 10 },
  rowDesc: { color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  rowMeta: { color: theme.inkFaint, fontSize: 12, marginTop: 2, fontFamily: fonts.sans },
  rowAmount: {
    color: theme.ink, fontSize: 14, fontFamily: fonts.monoMedium,
    fontVariant: ['tabular-nums'],
  },
  splits: { marginTop: 8, paddingLeft: 10, borderLeftWidth: 1, borderLeftColor: theme.hairline },
  splitRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 2 },
  splitName: { flex: 1, color: theme.inkSoft, fontSize: 12, marginRight: 8, fontFamily: fonts.sans },
  splitMemo: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.sans },
  splitAmount: { fontSize: 12, fontFamily: fonts.mono, fontVariant: ['tabular-nums'] },
  pos: { color: theme.moss },
  neg: { color: theme.ink },
  empty: {
    color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingTop: 40,
    textAlign: 'center', fontFamily: fonts.sans,
  },
  truncated: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16, paddingTop: 16,
    textAlign: 'center', fontFamily: fonts.sans,
  },
});
