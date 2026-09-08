// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// The Entry screen's account picker, board 5d of the 2026-09-08 handoff.
//
// It differs from AccountPicker in two ways that matter, which is why it is a
// second component rather than a flag on the first:
//
//   1. An account that cannot be used is SHOWN, dimmed, with the reason on it,
//      instead of being filtered out. A stock holding missing from the list
//      reads as "the app has lost my account"; the same row at 45% opacity
//      tagged "STOCK · desktop" says what is actually true. The same goes for
//      an account in the wrong currency once the entry has one.
//   2. Every row carries its full path and an account-type tag. This book has
//      two accounts called IPOT -- one ASSET holding broker cash, one EXPENSE
//      holding its fees -- and the name alone cannot tell them apart.

import { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet } from 'react-native';
import { OverlayModal } from './OverlayModal';
import { useAccounts } from '../store/accountStore';
import { theme, fonts } from '../constants/theme';
import type { Account } from '../services/api';

type Props = {
  visible: boolean;
  title: string;
  /** Account types this pick may return. */
  types: string[];
  /**
   * The entry's currency once it has one. Accounts in any other commodity are
   * shown dimmed rather than hidden -- see the note above.
   */
  commodityGuid?: string | null;
  selectedGuid?: string | null;
  onSelect: (a: Account) => void;
  onDismiss: () => void;
};

/** Why a row cannot be picked, or null when it can. */
function blockedReason(a: Account, commodityGuid?: string | null): string | null {
  if (a.commodity_namespace !== 'CURRENCY') {
    return `${a.commodity_namespace ?? 'NON-CURRENCY'} · desktop`;
  }
  if (commodityGuid && a.commodity_guid !== commodityGuid) {
    return `${a.commodity_mnemonic ?? '?'} · other currency`;
  }
  return null;
}

export function AccountSheet({
  visible, title, types, commodityGuid, selectedGuid, onSelect, onDismiss,
}: Props) {
  const [query, setQuery] = useState('');
  const postable = useAccounts((s) => s.postable);

  // Clear the search on every OPEN, not on every close.
  //
  // Clearing at each exit was the first attempt and it leaked in practice: a
  // search for "uob" while choosing who paid was still sitting in the box when
  // the expense picker opened, silently hiding every account that does not
  // match. Driving it from `visible` instead means there is no exit path left
  // to forget -- backdrop, Cancel, selection, or anything added later.
  useEffect(() => { if (visible) setQuery(''); }, [visible, title]);

  const rows = useMemo(() => {
    const list = postable(types);
    const q = query.trim().toLowerCase();
    // Substring over the FULL PATH, not the leaf, so "coffee" finds
    // Expenses:Food:Coffee and "food" finds everything beneath Food.
    const matched = q ? list.filter((a) => a.full_path.toLowerCase().includes(q)) : list;
    // Usable accounts first. A dimmed row is there to explain an absence, not
    // to be scrolled past on the way to the one you want.
    const scored = matched.map((a) => ({ a, blocked: blockedReason(a, commodityGuid) }));
    scored.sort((x, y) => (x.blocked ? 1 : 0) - (y.blocked ? 1 : 0));
    return scored.slice(0, 200);
  }, [postable, types, commodityGuid, query]);

  function close() {
    setQuery('');
    onDismiss();
  }

  return (
    <OverlayModal visible={visible} onDismiss={close}>
      <Text style={styles.title}>{title}</Text>

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
        {rows.length === 0 ? (
          <Text style={styles.empty}>
            {query ? 'No account matches that.' : 'No accounts available.'}
            {'\n\n'}
            This app can only use accounts that already exist in your book.
          </Text>
        ) : (
          rows.map(({ a, blocked }) => {
            const selected = a.guid === selectedGuid;
            return (
              <Pressable
                key={a.guid}
                disabled={!!blocked}
                onPress={() => { setQuery(''); onSelect(a); }}
                style={({ pressed }) => [
                  styles.row,
                  selected && styles.rowSelected,
                  pressed && !blocked && styles.rowPressed,
                  !!blocked && styles.rowBlocked,
                ]}
              >
                <View style={styles.rowMain}>
                  <Text style={styles.rowName} numberOfLines={1}>{a.name}</Text>
                  <Text style={styles.rowPath} numberOfLines={1}>{a.full_path}</Text>
                </View>
                <Text style={[styles.tag, !!blocked && styles.tagBlocked]}>
                  {blocked ?? a.account_type}
                </Text>
                {selected ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>
            );
          })
        )}
      </ScrollView>

      <Pressable style={styles.cancel} onPress={close}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </OverlayModal>
  );
}

const styles = StyleSheet.create({
  title: { color: theme.ink, fontSize: 18, fontFamily: fonts.sansMedium },
  search: {
    backgroundColor: theme.bg, borderRadius: 8,
    borderWidth: 1.5, borderColor: theme.ink,
    paddingHorizontal: 12, paddingVertical: 10,
    color: theme.ink, fontSize: 15, fontFamily: fonts.sans,
    marginTop: 12, marginBottom: 12,
  },
  list: { maxHeight: 340 },
  empty: {
    color: theme.inkFaint, fontSize: 14, lineHeight: 20, paddingVertical: 24,
    fontFamily: fonts.sans,
  },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowSelected: { backgroundColor: theme.surfaceSoft },
  rowPressed: { backgroundColor: theme.pressed },
  rowBlocked: { opacity: 0.45 },
  rowMain: { flex: 1, marginRight: 8 },
  rowName: { color: theme.ink, fontSize: 12, fontFamily: fonts.sansMedium },
  rowPath: { color: theme.inkFaint, fontSize: 11, marginTop: 2, fontFamily: fonts.sans },
  tag: {
    color: theme.inkSoft, fontSize: 10, letterSpacing: 0.6,
    backgroundColor: theme.surfaceSoft, borderRadius: 4,
    paddingHorizontal: 5, paddingVertical: 2,
    fontFamily: fonts.sansMedium, overflow: 'hidden',
  },
  tagBlocked: { color: theme.copperDark, backgroundColor: theme.copperTint },
  check: { color: theme.ink, fontSize: 14, marginLeft: 8, fontFamily: fonts.sansSemi },
  cancel: { marginTop: 14, alignItems: 'center', paddingVertical: 14 },
  cancelText: { color: theme.inkFaint, fontSize: 14, fontFamily: fonts.sansMedium },
});
