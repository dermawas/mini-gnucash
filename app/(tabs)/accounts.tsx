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
import { SectionLabel } from '../../src/components/SectionLabel';
import { Icon } from '../../src/components/Icon';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { getBalances, type Balance } from '../../src/services/api';
import { formatAmount } from '../../src/utils/currency';
import { theme, fonts } from '../../src/constants/theme';
import { usePrivacy, maskIfHidden } from '../../src/store/privacyStore';
import type { Account } from '../../src/services/api';
import { useEntryTabGuard } from '../../src/hooks/useEntryTabGuard';

export default function Accounts() {
  useEntryTabGuard('accounts');
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
  const hidden = usePrivacy((s) => s.hidden);
  const toggleHidden = usePrivacy((s) => s.toggle);
  const loadPrivacy = usePrivacy((s) => s.load);

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
    loadPrivacy();
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

  // The abbreviation on a row's avatar. Book accounts are numbered
  // ("01-Assets", "0111-Checking Account"), and the number is the least
  // distinguishing part of the name, so it is skipped before taking letters.
  function initials(name: string): string {
    const words = name.replace(/^[\d\-.\s]+/, '').split(/[\s\-_:]+/).filter(Boolean);
    if (words.length === 0) return name.slice(0, 2).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ConnectionBanner />

      {/*
        No hero figure here, though the 2026-09-08 handoff draws a "Net worth"
        slot at 28pt mono. It was built, shipped to the phone, and taken out
        again the same day, because against the real book it could never show
        a number: the root holds more than one commodity (an Imbalance-CNY
        account sits beside the IDR tree), and 01-Assets own subtree spans
        IDR, USD, CNY and XAU, so balance_subtree is null. A 28pt figure that
        is permanently "--" is worse than no figure.

        It could be made to work per-commodity, from the leaves, with no
        exchange rate involved -- rule 1 forbids COMBINING currencies, not
        totalling each separately. That was offered and declined: the account
        list is what this screen is for. Do not re-add the slot without that
        leaf-level sum behind it.
      */}
      <View style={styles.header}>
        <View style={styles.headTop}>
          <Text style={styles.h1} numberOfLines={1}>
            {current ? current.name : 'Accounts'}
          </Text>
          <Pressable
            onPress={toggleHidden}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={hidden ? 'Show balances' : 'Hide balances'}
          >
            <Icon name={hidden ? 'hide' : 'show'} size={22} color={theme.inkSoft} />
          </Pressable>
        </View>
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
          <Icon name="chevronLeft" size={20} color={theme.ink} />
          <Text style={styles.upText} numberOfLines={1}>
            {trail.length > 1 ? `Back to ${trail[trail.length - 2].name}` : 'All accounts'}
          </Text>
        </Pressable>
      ) : null}

      {cachedAt && !showMoney ? (
        <Text style={styles.cacheNote}>
          Account list saved on {new Date(cachedAt).toLocaleDateString()}. Balances are not saved
          and are not shown.
        </Text>
      ) : null}

      {accountsLoading && accounts.length === 0 ? (
        <ActivityIndicator style={styles.spinner} color={theme.ink} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.guid}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={refreshAll} tintColor={theme.ink} />
          }
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            rows.length ? (
              <View style={styles.sectionHead}>
                <SectionLabel>{current ? 'INSIDE' : 'ACCOUNTS'}</SectionLabel>
                <Text style={styles.sectionCount}>{rows.length}</Text>
              </View>
            ) : null
          }
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
            const negative = value != null && value < 0;
            // A childless placeholder is the one row that goes nowhere: no
            // register, nothing beneath it. Its chevron would be a promise the
            // tap does not keep.
            const inert = kids === 0 && item.placeholder === 1;

            return (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                onPress={() => open(item)}
                disabled={inert}
              >
                <View style={styles.avatar}>
                  <Text style={styles.avatarText}>{initials(item.name)}</Text>
                </View>
                <View style={styles.rowMain}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {item.account_type}
                    {item.commodity_mnemonic ? ` · ${item.commodity_mnemonic}` : ''}
                    {kids > 0 ? ` · ${kids} inside` : ''}
                  </Text>
                </View>
                <Text style={[styles.rowAmount, negative && styles.rowAmountNeg]}>
                  {!showMoney
                    ? '—'
                    : mixed
                      ? '--'
                      : value != null
                        ? maskIfHidden(
                            formatAmount(
                              value, item.commodity_mnemonic ?? 'IDR', item.commodity_scu),
                            hidden)
                        : '…'}
                </Text>
                {inert ? (
                  <View style={styles.chevronGap} />
                ) : (
                  <Icon name="chevron" size={16} color={theme.disabled} />
                )}
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
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12 },
  headTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  h1: {
    color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium, flex: 1, marginRight: 12,
  },
  crumb: { color: theme.inkFaint, fontSize: 12, marginTop: 6, fontFamily: fonts.sans },
  // Full-width and row-height on purpose. This was a small chevron next to
  // 14px text with no top padding -- a target well under the 48dp minimum, and
  // the only way back out of a drill-down, so a missed tap stranded you.
  up: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 13,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.hairlineStrong,
    minHeight: 52,
  },
  upPressed: { backgroundColor: theme.pressed },
  upText: {
    color: theme.ink, fontSize: 14, fontFamily: fonts.sansMedium, marginLeft: 6, flex: 1,
  },
  cacheNote: {
    color: theme.coral, fontSize: 12, lineHeight: 17,
    paddingHorizontal: 20, paddingBottom: 12, fontFamily: fonts.sans,
  },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 20, paddingBottom: 40 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    paddingTop: 14, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  sectionCount: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.mono },
  // A hairline list rather than the rounded cards this screen used to draw.
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowPressed: { backgroundColor: theme.pressed },
  avatar: {
    width: 28, height: 28, borderRadius: 8, marginRight: 12,
    backgroundColor: theme.surfaceSoft, alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: theme.inkSoft, fontSize: 11, fontFamily: fonts.sansSemi },
  rowMain: { flex: 1, marginRight: 12 },
  rowName: { color: theme.ink, fontSize: 15, fontFamily: fonts.sans },
  rowMeta: { color: theme.inkFaint, fontSize: 12, marginTop: 2, fontFamily: fonts.sans },
  rowAmount: {
    color: theme.ink, fontSize: 14, fontFamily: fonts.mono,
    fontVariant: ['tabular-nums'], marginRight: 8,
  },
  rowAmountNeg: { color: theme.coral },
  chevronGap: { width: 16 },
  empty: {
    color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingTop: 40,
    textAlign: 'center', fontFamily: fonts.sans,
  },
  errorFooter: {
    color: theme.coral, fontSize: 12, paddingHorizontal: 20, paddingBottom: 6,
    fontFamily: fonts.sans,
  },
  footnote: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16,
    paddingHorizontal: 20, paddingBottom: 10, fontFamily: fonts.sans,
  },
});
