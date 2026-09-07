// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Pick a real GnuCash account. There is no "wallet" or "category" concept in
// this app to map onto -- a wallet IS a BANK account and a category IS an
// EXPENSE account, so this one component serves every picker.

import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { OverlayModal } from './OverlayModal';
import { useAccounts } from '../store/accountStore';
import { theme, fonts } from '../constants/theme';
import type { Account } from '../services/api';

type Props = {
  visible: boolean;
  title: string;
  /** Restrict by account_type, e.g. ASSET_TYPES for a transfer. */
  types?: string[];
  /** Restrict to one commodity, e.g. a receipt's currency. */
  commodityGuid?: string;
  excludeGuids?: string[];
  selectedGuid?: string | null;
  onSelect: (account: Account) => void;
  onDismiss: () => void;
};

export function AccountPicker({
  visible, title, types, commodityGuid, excludeGuids, selectedGuid, onSelect, onDismiss,
}: Props) {
  const [query, setQuery] = useState('');
  const postable = useAccounts((s) => s.postable);
  const cachedAt = useAccounts((s) => s.cachedAt);

  const matches = useMemo(() => {
    let list = postable(types);
    if (commodityGuid) list = list.filter((a) => a.commodity_guid === commodityGuid);
    if (excludeGuids?.length) list = list.filter((a) => !excludeGuids.includes(a.guid));

    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 200);

    // Substring over the FULL PATH, not just the leaf name. So "coffee" finds
    // Expenses:Food:Coffee, and "food" finds everything beneath Food -- the
    // ancestry is searchable, which is most of the value of having paths.
    return list.filter((a) => a.full_path.toLowerCase().includes(q)).slice(0, 200);
  }, [postable, types, commodityGuid, excludeGuids, query]);

  return (
    <OverlayModal visible={visible} onDismiss={onDismiss}>
      <Text style={styles.title}>{title}</Text>

      {cachedAt ? (
        <Text style={styles.stale}>
          Showing accounts saved on {new Date(cachedAt).toLocaleDateString()} — you are offline.
        </Text>
      ) : null}

      <TextInput
        style={styles.search}
        placeholder="Search accounts"
        placeholderTextColor={theme.inkFaint}
        value={query}
        onChangeText={setQuery}
        autoCapitalize="none"
        autoCorrect={false}
      />

      <ScrollView style={styles.list} nestedScrollEnabled keyboardShouldPersistTaps="handled">
        {matches.length === 0 ? (
          <Text style={styles.empty}>
            {query ? 'No account matches that.' : 'No accounts available.'}
            {'\n\n'}
            This app can only use accounts that already exist in your book.
          </Text>
        ) : (
          matches.map((a) => {
            const selected = a.guid === selectedGuid;
            return (
              <Pressable
                key={a.guid}
                onPress={() => onSelect(a)}
                style={[styles.row, selected && styles.rowSelected]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowPath} numberOfLines={2}>{a.full_path}</Text>
                  <Text style={styles.rowMeta}>
                    {a.account_type}
                    {a.commodity_mnemonic ? ` · ${a.commodity_mnemonic}` : ''}
                  </Text>
                </View>
                {selected ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>

      <Pressable style={styles.cancel} onPress={onDismiss}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  title: { color: theme.ink, fontSize: 18, fontFamily: fonts.sansMedium, marginBottom: 4 },
  stale: { color: theme.coral, fontSize: 12, marginBottom: 12, lineHeight: 17, fontFamily: fonts.sans },
  search: {
    backgroundColor: theme.bg,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: theme.ink,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: theme.ink,
    fontSize: 15,
    fontFamily: fonts.sans,
    marginTop: 12,
    marginBottom: 12,
  },
  list: { maxHeight: 320 },
  empty: {
    color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingVertical: 24,
    fontFamily: fonts.sans,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.hairline,
  },
  rowSelected: { backgroundColor: theme.surfaceSoft },
  rowMain: { flex: 1 },
  rowPath: { color: theme.ink, fontSize: 14, lineHeight: 19, fontFamily: fonts.sans },
  rowMeta: { color: theme.inkFaint, fontSize: 12, marginTop: 2, fontFamily: fonts.sans },
  check: { color: theme.ink, fontSize: 16, marginLeft: 10, fontFamily: fonts.sansSemi },
  cancel: { marginTop: 16, alignItems: 'center', paddingVertical: 14 },
  cancelText: { color: theme.inkFaint, fontSize: 14, fontFamily: fonts.sansMedium },
});
