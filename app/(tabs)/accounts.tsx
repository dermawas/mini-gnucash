// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The chart of accounts, as a tree you walk down.
//
// It has to be a tree rather than a flat list, and that is not a style choice.
// A real book puts the accounts you actually use several levels deep:
//
//   01-Assets                                    depth 0  placeholder
//     011-Current Assets                         depth 1  placeholder
//       0111-Checking Account                    depth 2  placeholder
//         BCA, Jenius (IDR), Jago, Blu ...       depth 3  the real accounts
//
// An earlier version showed only the top two levels, which meant 299 of 367
// postable accounts were unreachable -- every bank account included.
//
// Three rules this screen holds to:
//
//   1. Every balance is in its OWN account's commodity. There is no combined
//      total and no net-worth figure anywhere, because adding IDR to USD needs
//      an exchange rate this app does not have and will not invent. A group
//      spanning several currencies shows "--", not a number.
//
//   2. A placeholder never opens a register. GnuCash will not let a transaction
//      land on one, so its register is always empty -- and an empty register
//      reads as "no activity" when the truth is "the activity is one level
//      down". Tapping one drills in instead.
//
//   3. Off-VPN it shows NOTHING rather than a cached number. A stale balance
//      presented as current is the exact failure this project exists to avoid.
//      The account tree is cached; the money is not.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, FlatList, Pressable, RefreshControl, StyleSheet, ActivityIndicator,
  BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import Icon from '@react-native-vector-icons/material-design-icons';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { getBalances, type Balance } from '../../src/services/api';
import { formatAmount } from '../../src/utils/currency';
import { theme } from '../../src/constants/theme';
import type { Account } from '../../src/services/api';

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
  /** Ancestors of the level currently on screen. Empty means the top. */
  const [trail, setTrail] = useState<Account[]>([]);

  const loadBalances = useCallback(async () => {
    const result = await getBalances();
    if (!result.ok) {
      noteFailure(result.kind, result.error);
      // Drop what we had. Keeping the previous numbers up after a failed
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
    // Once on mount. Re-running on every connection change would hammer the
    // server while a flaky VPN flaps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const childrenOf = useMemo(() => {
    const map = new Map<string | null, Account[]>();
    for (const a of accounts) {
      if (a.hidden === 1) continue;
      const key = a.parent_guid ?? null;
      // Depth 0 accounts are the top level; the server already stripped the
      // root, so their parent_guid points at a root we never received.
      const bucket = a.depth === 0 ? null : key;
      const list = map.get(bucket) ?? [];
      list.push(a);
      map.set(bucket, list);
    }
    for (const list of map.values()) list.sort((x, y) => x.name.localeCompare(y.name));
    return map;
  }, [accounts]);

  const current = trail.length ? trail[trail.length - 1] : null;
  const rows = childrenOf.get(current ? current.guid : null) ?? [];

  const showMoney = connState === 'online' || connState === 'locked';

  // Android's hardware back knows nothing about `trail`, because drilling into
  // the tree is local state and not a route push. Without this, back from three
  // levels deep skips the whole tree and leaves the app, which reads as a
  // crash rather than as navigation -- and it is why the on-screen back link
  // had to be made a full-width row in the first place.
  //
  // Only claim the event when there is somewhere to go back TO. At the top of
  // the tree, return false and let Android do the normal thing for a tab root.
  // Bound to focus, or this screen would keep swallowing back presses from the
  // Settings tab.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (trail.length === 0) return false;
        setTrail((t) => t.slice(0, -1));
        return true;
      });
      return () => sub.remove();
    }, [trail.length]),
  );

  function open(a: Account) {
    const hasChildren = (childrenOf.get(a.guid)?.length ?? 0) > 0;
    // A placeholder always drills, never opens a register -- rule 2 above.
    if (hasChildren) {
      setTrail((t) => [...t, a]);
      return;
    }
    if (a.placeholder === 1) return; // childless placeholder: nothing to show
    router.push(`/account/${a.guid}`);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <View style={styles.header}>
        <Text style={styles.h1} numberOfLines={1}>
          {current ? current.name : 'Accounts'}
        </Text>
        {current ? (
          <Text style={styles.crumb} numberOfLines={1}>
            {trail.map((t) => t.name).join(' › ')}
          </Text>
        ) : null}
      </View>

      {current ? (
        <Pressable
          style={({ pressed }) => [styles.up, pressed && styles.upPressed]}
          onPress={() => setTrail((t) => t.slice(0, -1))}
          hitSlop={8}
        >
          <Icon name="chevron-left" size={26} color={theme.accent} />
          <Text style={styles.upText} numberOfLines={1}>
            {trail.length > 1 ? `Back to ${trail[trail.length - 2].name}` : 'All accounts'}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.actions}>
          <View style={styles.actionsInner}>
            <Pressable style={styles.action} onPress={() => router.push('/entry/spend')}>
              <Icon name="minus-circle-outline" size={18} color={theme.accent} />
              <Text style={styles.actionText} numberOfLines={1}>Spend</Text>
            </Pressable>
            <Pressable
              style={styles.action}
              onPress={() => router.push('/entry/spend?direction=inflow')}
            >
              <Icon name="plus-circle-outline" size={18} color={theme.accent} />
              <Text style={styles.actionText} numberOfLines={1}>Income</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={() => router.push('/entry/transfer')}>
              <Icon name="swap-horizontal" size={18} color={theme.accent} />
              <Text style={styles.actionText} numberOfLines={1}>Transfer</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={() => router.push('/scan/review')}>
              <Icon name="camera-outline" size={18} color={theme.accent} />
              <Text style={styles.actionText} numberOfLines={1}>Scan</Text>
            </Pressable>
          </View>
        </View>
      )}

      <ConnectionBanner />

      {cachedAt && !showMoney ? (
        <Text style={styles.cacheNote}>
          Account list saved on {new Date(cachedAt).toLocaleDateString()}. Balances are not saved
          and are not shown.
        </Text>
      ) : null}

      {accountsLoading && accounts.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.accent} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.guid}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={theme.accent} />
          }
          contentContainerStyle={styles.list}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {connState === 'offline'
                ? 'Not connected. Your accounts live in GnuCash.'
                : 'Nothing under this account.'}
            </Text>
          }
          renderItem={({ item }) => {
            const bal = balances?.[item.guid];
            const kids = childrenOf.get(item.guid)?.length ?? 0;
            // Prefer the subtree total for a group, its own balance for a leaf.
            // balance_subtree is null when the subtree mixes commodities, and
            // that null must render as "--", never as 0.
            const value = kids > 0 && bal ? bal.balance_subtree : bal?.balance_total ?? null;
            const mixed = kids > 0 && bal && bal.balance_subtree === null;

            return (
              <Pressable style={styles.row} onPress={() => open(item)}>
                <View style={styles.rowMain}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {item.account_type}
                    {item.commodity_mnemonic ? ` · ${item.commodity_mnemonic}` : ''}
                    {kids > 0 ? ` · ${kids} inside` : ''}
                  </Text>
                </View>
                <View style={styles.rowRight}>
                  <Text style={styles.rowAmount}>
                    {!showMoney
                      ? '—'
                      : mixed
                        ? '--'
                        : value != null
                          ? formatAmount(value, item.commodity_mnemonic ?? 'IDR', item.commodity_scu)
                          : '…'}
                  </Text>
                  {kids > 0 ? (
                    <Icon name="chevron-right" size={18} color={theme.inkFaint} />
                  ) : item.placeholder === 1 ? null : (
                    <Icon name="chevron-right" size={18} color={theme.inkFaint} />
                  )}
                </View>
              </Pressable>
            );
          }}
        />
      )}

      {balancesError && showMoney ? (
        <Text style={styles.errorFooter}>{balancesError}</Text>
      ) : null}

      <Text style={styles.footnote}>
        Totals are not combined across currencies. A group holding more than one shows --.
      </Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 10 },
  h1: { color: theme.ink, fontSize: 26, fontFamily: 'DMSerifDisplay' },
  crumb: { color: theme.inkFaint, fontSize: 11, marginTop: 4 },
  // Full-width and row-height on purpose. This was a 18px chevron next to 14px
  // text with no top padding -- a target well under the 48dp minimum, and the
  // only way back out of a drill-down, so a missed tap stranded you.
  up: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: theme.surface,
    minHeight: 52,
  },
  upPressed: { opacity: 0.6 },
  upText: { color: theme.accent, fontSize: 16, fontWeight: '600', marginLeft: 4, flex: 1 },
  actions: { paddingHorizontal: 10, paddingBottom: 14 },
  actionsInner: { flexDirection: 'row', justifyContent: 'space-between' },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    // Without this a flex child refuses to shrink below its content width.
    minWidth: 0,
    marginHorizontal: 3,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: theme.surface,
  },
  // flexShrink + numberOfLines are a guard, not decoration. At font_scale 1.3
  // "Transfer" already fills its box to the pixel and its icon is the first
  // thing the layout compresses; a fifth button or a longer label would clip
  // it, which is bug 2 all over again. Let the label shrink and stay on one
  // line instead of pushing the row wider than the screen.
  actionText: {
    // 12, not 13. At font_scale 1.3 the four labels need 228px for "Transfer"
    // and the box gives 165 for its text -- icon 48 + gap 15 + text 165 filled
    // the button exactly, with nothing spare. A point off the label, plus the
    // padding reclaimed above, buys real slack instead of the zero it had.
    color: theme.accent, fontSize: 12, fontWeight: '600', marginLeft: 5,
    flexShrink: 1,
  },
  cacheNote: {
    color: theme.amber, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 20, paddingBottom: 12,
  },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 16, paddingBottom: 40 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: theme.surface, borderRadius: 10,
    paddingVertical: 14, paddingHorizontal: 14, marginBottom: 6,
  },
  rowMain: { flex: 1, marginRight: 12 },
  rowName: { color: theme.ink, fontSize: 15 },
  rowMeta: { color: theme.inkFaint, fontSize: 11, marginTop: 3 },
  rowRight: { flexDirection: 'row', alignItems: 'center' },
  rowAmount: { color: theme.ink, fontSize: 14, fontVariant: ['tabular-nums'], marginRight: 4 },
  empty: { color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingTop: 40, textAlign: 'center' },
  errorFooter: { color: theme.coral, fontSize: 12, paddingHorizontal: 20, paddingBottom: 6 },
  footnote: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16,
    paddingHorizontal: 20, paddingBottom: 10,
  },
});
