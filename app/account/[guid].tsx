// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab
//
// One account's register.
//
// Read-only, apart from the cleared dot. This app never edits or deletes an
// existing transaction: corrections belong in GnuCash desktop, where there is
// an undo and a person looking at the whole book. The screen says so rather
// than leaving the absence to be discovered.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, Pressable, RefreshControl, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Icon } from '../../src/components/Icon';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useConnection } from '../../src/store/connectionStore';
import { getRegister, callRpc, type Register, type RegisterRow } from '../../src/services/api';
import { formatAmount } from '../../src/utils/currency';
import { theme, fonts } from '../../src/constants/theme';
import { usePrivacy, maskIfHidden } from '../../src/store/privacyStore';

export default function AccountRegister() {
  const hidden = usePrivacy((s) => s.hidden);
  const toggleHidden = usePrivacy((s) => s.toggle);
  const loadPrivacy = usePrivacy((s) => s.load);
  const { guid } = useLocalSearchParams<{ guid: string }>();
  const router = useRouter();
  const canWrite = useConnection((s) => s.canWrite());
  const noteFailure = useConnection((s) => s.noteFailure);

  const [register, setRegister] = useState<Register | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busySplit, setBusySplit] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!guid) return;
    const result = await getRegister(guid, 90, 200);
    if (!result.ok) {
      noteFailure(result.kind, result.error);
      setRegister(null);
      setError(result.error);
      return;
    }
    setRegister(result.data);
    setError(null);
  }, [guid, noteFailure]);

  useEffect(() => {
    loadPrivacy();
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  /**
   * Running balance, newest first.
   *
   * This is why the RPC returns opening_balance. The window is bounded at 90
   * days, so accumulating from zero would produce a column that disagrees with
   * the account's real balance by however much history was excluded. Starting
   * from the opening figure makes the numbers correct despite only receiving a
   * slice.
   */
  const withRunning = useMemo(() => {
    if (!register) return [];
    const ascending = [...register.rows].reverse();
    let running = register.opening_balance;
    const balanceBySplit: Record<string, number> = {};
    for (const r of ascending) {
      running += r.quantity;
      balanceBySplit[r.split_guid] = running;
    }
    return register.rows.map((r) => ({ row: r, balance: balanceBySplit[r.split_guid] }));
  }, [register]);

  async function toggleCleared(row: RegisterRow) {
    if (row.reconcile_state === 'y') {
      Alert.alert(
        'Reconciled in GnuCash',
        'This split has been reconciled against a statement. Reconciled entries can only be changed in GnuCash desktop.',
      );
      return;
    }
    if (!canWrite || busySplit) return;

    const next = row.reconcile_state !== 'c';
    setBusySplit(row.split_guid);

    // Optimistic, with a rollback. This is the only reversible write in the
    // app, so an optimistic update is safe here in a way it would not be for
    // anything that moves money.
    setRegister((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((r) =>
              r.split_guid === row.split_guid ? { ...r, reconcile_state: next ? 'c' : 'n' } : r,
            ),
          }
        : prev,
    );

    const result = await callRpc<{ status: string }>('mgc_set_split_cleared', {
      p_split_guid: row.split_guid,
      p_cleared: next,
    });
    setBusySplit(null);

    if (!result.ok) {
      noteFailure(result.kind, result.error);
      setRegister((prev) =>
        prev
          ? {
              ...prev,
              rows: prev.rows.map((r) =>
                r.split_guid === row.split_guid ? { ...r, reconcile_state: row.reconcile_state } : r,
              ),
            }
          : prev,
      );
      Alert.alert('Not changed', result.error);
    }
  }

  const currency = register?.commodity ?? 'IDR';
  const scu = register?.commodity_scu;

  // The account's balance and its cleared portion, for the header.
  //
  // The cleared sum is computed here rather than read from the RPC on purpose:
  // the dot is optimistic, so the figure has to move the instant a dot is
  // tapped. Reading a server total would leave the header disagreeing with the
  // row the user just changed until the next refresh.
  //
  // Reconciled ('y') counts as cleared. It is a stronger statement than
  // cleared, not a different one -- a reconciled split has been matched to a
  // statement, so leaving it out would make the cleared figure smaller than
  // the truth.
  const clearedSum = useMemo(
    () => (register?.rows ?? [])
      .filter((r) => r.reconcile_state === 'c' || r.reconcile_state === 'y')
      .reduce((sum, r) => sum + r.quantity, 0),
    [register],
  );
  const currentBalance = withRunning.length ? withRunning[0].balance : register?.opening_balance;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ConnectionBanner />

      {/* The whole "< Accounts" chunk is the back target, per the handoff --
          not just the chevron, which was a 26px glyph with 4px of padding. */}
      <Pressable onPress={() => router.back()} style={styles.crumbRow} hitSlop={8}>
        <Icon name="chevronLeft" size={14} color={theme.inkFaint} />
        <Text style={styles.crumb} numberOfLines={1}>
          Accounts{register?.account_type ? ` / ${register.account_type}` : ''}
        </Text>
      </Pressable>

      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.h1} numberOfLines={1}>{register?.account_name ?? 'Register'}</Text>
          {register ? (
            <Text style={styles.sub} numberOfLines={1}>
              {register.commodity} · last {register.window_days} days
            </Text>
          ) : null}
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.balance} numberOfLines={1}>
            {currentBalance != null
              ? maskIfHidden(formatAmount(currentBalance, currency, scu), hidden)
              : '—'}
          </Text>
          <Text style={styles.clearedNote} numberOfLines={1}>
            {maskIfHidden(formatAmount(clearedSum, currency, scu), hidden)} cleared
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

      {loading ? (
        <ActivityIndicator style={styles.spinner} color={theme.ink} />
      ) : (
        <FlatList
          data={withRunning}
          keyExtractor={(item) => item.row.split_guid}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              tintColor={theme.ink}
            />
          }
          ListEmptyComponent={
            <Text style={styles.empty}>
              {error ?? 'Nothing posted to this account in the last 90 days.'}
            </Text>
          }
          ListFooterComponent={
            register?.truncated ? (
              <Text style={styles.truncated}>
                Showing the {register.row_count} most recent of {register.total_in_window} entries in
                this window. Open GnuCash for the full history.
              </Text>
            ) : null
          }
          renderItem={({ item }) => {
            const r = item.row;
            const other = r.other_splits[0];
            const crossCurrency = r.tx_currency && r.tx_currency !== register?.commodity;
            const cleared = r.reconcile_state === 'c';
            const reconciled = r.reconcile_state === 'y';
            return (
              <View style={styles.row}>
                <Pressable
                  onPress={() => toggleCleared(r)}
                  hitSlop={9}
                  style={styles.dotHit}
                  disabled={busySplit === r.split_guid}
                  accessibilityRole="button"
                  accessibilityLabel={
                    reconciled
                      ? 'Reconciled in GnuCash'
                      : cleared ? 'Cleared. Tap to unclear.' : 'Not cleared. Tap to clear.'
                  }
                >
                  {/* 10px circle, 1.5px ink border, filled when cleared -- the
                      handoff's dot. Reconciled is filled in verdigris instead:
                      it is also settled, but it is not something this app can
                      toggle, and a dot that looks identical to a tappable one
                      invites a tap that only ever produces an alert. */}
                  <View
                    style={[
                      styles.dot,
                      reconciled && styles.dotReconciled,
                      cleared && styles.dotCleared,
                    ]}
                  />
                </Pressable>

                <View style={styles.rowMain}>
                  <Text style={styles.rowDesc} numberOfLines={1}>
                    {r.description || '(no description)'}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {r.post_date}
                    {other ? ` · ${other.name}` : ''}
                    {r.split_count > 2 ? ` · ${r.split_count} splits` : ''}
                  </Text>
                  {crossCurrency ? (
                    <Text style={styles.rowCross}>
                      Cross-currency, booked in {r.tx_currency}
                    </Text>
                  ) : null}
                </View>

                <View style={styles.rowRight}>
                  <Text
                    style={[styles.rowAmount, r.quantity < 0 ? styles.neg : styles.pos]}
                    numberOfLines={1}
                  >
                    {maskIfHidden(formatAmount(r.quantity, currency, scu), hidden)}
                  </Text>
                  <Text style={styles.rowBalance} numberOfLines={1}>
                    {maskIfHidden(formatAmount(item.balance, currency, scu), hidden)}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}

      {/* The handoff's legend. It replaces a sentence that had to describe the
          dot in words because there was nothing on screen to point at. */}
      <View style={styles.legend}>
        <View style={[styles.dot, styles.dotCleared, styles.legendDot]} />
        <Text style={styles.legendText}>cleared</Text>
        <View style={[styles.dot, styles.legendDot, styles.legendDotGap]} />
        <Text style={styles.legendText}>uncleared · tap a dot to toggle</Text>
      </View>
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
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  headerText: { flex: 1, marginRight: 12 },
  h1: { color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium },
  sub: { color: theme.inkFaint, fontSize: 12, marginTop: 3, fontFamily: fonts.sans },
  headerRight: { alignItems: 'flex-end' },
  balance: {
    color: theme.ink, fontSize: 22, fontFamily: fonts.monoMedium,
    fontVariant: ['tabular-nums'],
  },
  clearedNote: { color: theme.inkFaint, fontSize: 11, marginTop: 3, fontFamily: fonts.mono },
  eye: { marginLeft: 12, paddingTop: 4 },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 20, paddingBottom: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  // 28px of touch around a 10px dot, which is the handoff's rule and the
  // reason the dot can be this small at all.
  dotHit: {
    width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginRight: 4,
  },
  dot: {
    width: 10, height: 10, borderRadius: 5,
    borderWidth: 1.5, borderColor: theme.ink, backgroundColor: 'transparent',
  },
  dotCleared: { backgroundColor: theme.ink },
  dotReconciled: { backgroundColor: theme.moss, borderColor: theme.moss },
  rowMain: { flex: 1, marginRight: 10 },
  rowDesc: { color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  rowMeta: { color: theme.inkFaint, fontSize: 12, marginTop: 2, fontFamily: fonts.sans },
  rowCross: { color: theme.inkSoft, fontSize: 11, marginTop: 2, fontFamily: fonts.sans },
  rowRight: { alignItems: 'flex-end' },
  rowAmount: { fontSize: 14, fontFamily: fonts.mono, fontVariant: ['tabular-nums'] },
  pos: { color: theme.moss },
  neg: { color: theme.ink },
  rowBalance: {
    color: theme.inkFaint, fontSize: 11, marginTop: 3,
    fontFamily: fonts.mono, fontVariant: ['tabular-nums'],
  },
  empty: {
    color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingTop: 40,
    textAlign: 'center', fontFamily: fonts.sans,
  },
  truncated: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16, paddingTop: 16,
    textAlign: 'center', fontFamily: fonts.sans,
  },
  legend: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: theme.hairline,
  },
  legendDot: { marginRight: 6 },
  legendDotGap: { marginLeft: 14 },
  legendText: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.sans },
});
