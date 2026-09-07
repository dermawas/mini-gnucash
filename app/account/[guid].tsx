// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
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
import Icon from '@react-native-vector-icons/material-design-icons';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useConnection } from '../../src/store/connectionStore';
import { getRegister, callRpc, type Register, type RegisterRow } from '../../src/services/api';
import { formatAmount } from '../../src/utils/currency';
import { theme } from '../../src/constants/theme';
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} style={styles.back} hitSlop={12}>
          <Icon name="chevron-left" size={26} color={theme.inkSoft} />
        </Pressable>
        <Pressable
          onPress={toggleHidden}
          hitSlop={12}
          style={styles.eye}
          accessibilityRole="button"
          accessibilityLabel={hidden ? 'Show amounts' : 'Hide amounts'}
        >
          <Icon name={hidden ? 'eye-off-outline' : 'eye-outline'} size={22} color={theme.inkSoft} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.h1} numberOfLines={1}>{register?.account_name ?? 'Register'}</Text>
          {register ? (
            <Text style={styles.sub}>
              {register.account_type} · {register.commodity} · last {register.window_days} days
            </Text>
          ) : null}
        </View>
      </View>

      <ConnectionBanner />

      {loading ? (
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      ) : (
        <FlatList
          data={withRunning}
          keyExtractor={(item) => item.row.split_guid}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }}
              tintColor={theme.accent}
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
            return (
              <View style={styles.row}>
                <Pressable
                  onPress={() => toggleCleared(r)}
                  hitSlop={10}
                  style={styles.dotHit}
                  disabled={busySplit === r.split_guid}
                >
                  {/* n hollow, c filled, y locked and not interactive. */}
                  <Icon
                    name={
                      r.reconcile_state === 'y'
                        ? 'lock'
                        : r.reconcile_state === 'c'
                          ? 'circle-slice-8'
                          : 'circle-outline'
                    }
                    size={16}
                    color={r.reconcile_state === 'n' ? theme.inkFaint : theme.moss}
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

      <Text style={styles.footnote}>
        Tap a dot to mark an entry cleared. Editing and deleting happen in GnuCash desktop.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingBottom: 14, paddingTop: 4 },
  back: { padding: 4 },
  eye: { marginRight: 4 },
  headerText: { flex: 1, marginLeft: 4 },
  h1: { color: theme.ink, fontSize: 21, fontFamily: 'DMSerifDisplay' },
  sub: { color: theme.inkFaint, fontSize: 11, marginTop: 3 },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 16, paddingBottom: 30 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.surface, borderRadius: 10,
    paddingVertical: 12, paddingHorizontal: 12, marginBottom: 6,
  },
  dotHit: { paddingRight: 12, paddingVertical: 4 },
  rowMain: { flex: 1, marginRight: 10 },
  rowDesc: { color: theme.ink, fontSize: 14 },
  rowMeta: { color: theme.inkFaint, fontSize: 11, marginTop: 3 },
  rowCross: { color: theme.inkSoft, fontSize: 10, marginTop: 3 },
  rowRight: { alignItems: 'flex-end' },
  rowAmount: { fontSize: 14, fontVariant: ['tabular-nums'] },
  pos: { color: theme.moss },
  neg: { color: theme.ink },
  rowBalance: { color: theme.inkFaint, fontSize: 11, marginTop: 3, fontVariant: ['tabular-nums'] },
  empty: { color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingTop: 40, textAlign: 'center' },
  truncated: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, paddingTop: 16, textAlign: 'center' },
  footnote: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, paddingHorizontal: 20, paddingBottom: 10 },
});
