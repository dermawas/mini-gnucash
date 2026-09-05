// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The chart of accounts with balances.
//
// Two rules this screen exists to hold to:
//
//   1. Every balance is shown in its OWN account's commodity. There is no
//      combined total and no net-worth figure anywhere, because adding IDR to
//      USD needs an exchange rate this app does not have and will not invent.
//      A parent spanning several currencies shows "--", not a number.
//
//   2. Off-VPN it shows NOTHING rather than a cached number. A stale balance
//      presented as current is the exact failure this project is arranged to
//      avoid. The account tree is cached; the money is not.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, SectionList, Pressable, RefreshControl, StyleSheet, ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Icon from '@react-native-vector-icons/material-design-icons';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { getBalances, type Balance } from '../../src/services/api';
import { formatAmount } from '../../src/utils/currency';
import { theme } from '../../src/constants/theme';

/** Order matters: this is how a person reads a balance sheet, not alphabetical. */
const SECTIONS: { key: string; title: string; types: string[] }[] = [
  { key: 'assets', title: 'Assets', types: ['BANK', 'CASH', 'ASSET', 'STOCK', 'MUTUAL'] },
  { key: 'liabilities', title: 'Liabilities', types: ['CREDIT', 'LIABILITY'] },
  { key: 'income', title: 'Income', types: ['INCOME'] },
  { key: 'expenses', title: 'Expenses', types: ['EXPENSE'] },
  { key: 'equity', title: 'Equity', types: ['EQUITY'] },
];

export default function Accounts() {
  const router = useRouter();
  const accounts = useAccounts((s) => s.accounts);
  const loadAccounts = useAccounts((s) => s.load);
  const accountsLoading = useAccounts((s) => s.loading);
  const cachedAt = useAccounts((s) => s.cachedAt);

  const connState = useConnection((s) => s.state);
  const refreshConn = useConnection((s) => s.refresh);
  const noteFailure = useConnection((s) => s.noteFailure);

  const [balances, setBalances] = useState<Record<string, Balance> | null>(null);
  const [balancesError, setBalancesError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadBalances = useCallback(async () => {
    const result = await getBalances();
    if (!result.ok) {
      noteFailure(result.kind, result.error);
      // Drop what we had. Keeping the previous numbers on screen after a failed
      // refresh is precisely how a stale balance gets read as a current one.
      setBalances(null);
      setBalancesError(result.error);
      return;
    }
    const map: Record<string, Balance> = {};
    for (const b of result.data) map[b.guid] = b;
    setBalances(map);
    setBalancesError(null);
  }, [noteFailure]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    await refreshConn();
    await loadAccounts();
    await loadBalances();
    setRefreshing(false);
  }, [refreshConn, loadAccounts, loadBalances]);

  useEffect(() => {
    refreshAll();
    // Deliberately once on mount. Re-running on every connection change would
    // hammer the server while a flaky VPN flaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sections = useMemo(() => {
    // Top two levels only. A 400-account book rendered flat is unusable, and
    // the register screen is where detail belongs.
    const shown = accounts.filter((a) => a.depth <= 1 && a.hidden === 0);
    return SECTIONS.map((s) => ({
      key: s.key,
      title: s.title,
      data: shown
        .filter((a) => s.types.includes(a.account_type))
        .sort((a, b) => a.full_path.localeCompare(b.full_path)),
    })).filter((s) => s.data.length > 0);
  }, [accounts]);

  const showMoney = connState === 'online' || connState === 'locked';

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.h1}>Accounts</Text>
        <Pressable style={styles.action} onPress={() => router.push('/entry/transfer')}>
          <Icon name="swap-horizontal" size={18} color={theme.accent} />
          <Text style={styles.actionText}>Transfer</Text>
        </Pressable>
      </View>

      <ConnectionBanner />

      {cachedAt && !showMoney ? (
        <Text style={styles.cacheNote}>
          Account list saved on {new Date(cachedAt).toLocaleDateString()}. Balances are not saved and
          are not shown.
        </Text>
      ) : null}

      {accountsLoading && accounts.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.guid}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={theme.accent} />
          }
          contentContainerStyle={styles.list}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionTitle}>{section.title}</Text>
          )}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {connState === 'offline'
                ? 'Not connected. Your accounts live in GnuCash.'
                : 'No accounts found in this book.'}
            </Text>
          }
          renderItem={({ item }) => {
            const bal = balances?.[item.guid];
            // Prefer the subtree total for a parent, its own balance for a leaf.
            // balance_subtree is null when the subtree mixes commodities, and
            // that null must render as "--", never as 0.
            const isParent = item.placeholder === 1 || accounts.some((a) => a.parent_guid === item.guid);
            const value = isParent && bal ? bal.balance_subtree : bal?.balance_total ?? null;
            const mixed = isParent && bal && bal.balance_subtree === null;

            return (
              <Pressable
                style={[styles.row, item.depth === 1 && styles.rowNested]}
                onPress={() => router.push(`/account/${item.guid}`)}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.rowMeta}>
                    {item.account_type}
                    {item.commodity_mnemonic ? ` · ${item.commodity_mnemonic}` : ''}
                    {item.placeholder === 1 ? ' · placeholder' : ''}
                  </Text>
                </View>
                <Text style={styles.rowAmount}>
                  {!showMoney
                    ? '—'
                    : mixed
                      ? '--'
                      : value != null
                        ? formatAmount(value, item.commodity_mnemonic ?? 'IDR')
                        : '…'}
                </Text>
              </Pressable>
            );
          }}
        />
      )}

      {balancesError && showMoney ? (
        <Text style={styles.errorFooter}>{balancesError}</Text>
      ) : null}

      {/* Said once, plainly, rather than implied by an absence people would
          otherwise read as a missing feature. */}
      <Text style={styles.footnote}>
        Totals are not combined across currencies. A group holding more than one shows --.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  h1: { color: theme.ink, fontSize: 26, fontFamily: 'DMSerifDisplay' },
  action: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, paddingLeft: 12 },
  actionText: { color: theme.accent, fontSize: 14, fontWeight: '600', marginLeft: 6 },
  cacheNote: {
    color: theme.amber, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 20, paddingBottom: 12,
  },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 16, paddingBottom: 40 },
  sectionTitle: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1.2,
    textTransform: 'uppercase', marginTop: 24, marginBottom: 8, paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.surface, borderRadius: 10,
    paddingVertical: 14, paddingHorizontal: 14, marginBottom: 6,
  },
  rowNested: { marginLeft: 16, backgroundColor: theme.surfaceSoft },
  rowMain: { flex: 1, marginRight: 12 },
  rowName: { color: theme.ink, fontSize: 15 },
  rowMeta: { color: theme.inkFaint, fontSize: 11, marginTop: 3 },
  rowAmount: { color: theme.ink, fontSize: 14, fontVariant: ['tabular-nums'] },
  empty: { color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingTop: 40, textAlign: 'center' },
  errorFooter: { color: theme.coral, fontSize: 12, paddingHorizontal: 20, paddingBottom: 6 },
  footnote: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16,
    paddingHorizontal: 20, paddingBottom: 10,
  },
});
