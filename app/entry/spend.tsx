// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Expense and income, one screen, because they are one entry with the sign
// flipped. `?direction=inflow` switches it.
//
// Multi-line by design rather than as a stretch goal: a receipt with several
// items is the normal case, and forcing it into one lump loses exactly the
// detail that makes keeping a ledger worth the effort.

import { useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Icon from '@react-native-vector-icons/material-design-icons';
import AmountInput from '../../src/components/AmountInput';
import { AccountPicker } from '../../src/components/AccountPicker';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts, ASSET_TYPES, EXPENSE_TYPES, INCOME_TYPES } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { callRpc, markInFlight, clearInFlight, type Account } from '../../src/services/api';
import { generateTransactionId } from '../../src/utils/idempotency';
import { parseCurrencyInput, formatAmount } from '../../src/utils/currency';
import { theme } from '../../src/constants/theme';

type Line = { key: string; accountGuid: string | null; raw: string; memo: string };

function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let lineSeq = 0;
const newLine = (): Line => ({ key: `l${++lineSeq}`, accountGuid: null, raw: '', memo: '' });

export default function Spend() {
  const { direction } = useLocalSearchParams<{ direction?: string }>();
  const inflow = direction === 'inflow';
  const router = useRouter();

  const byGuid = useAccounts((s) => s.byGuid);
  const canWrite = useConnection((s) => s.canWrite());
  const blockedReason = useConnection((s) => s.writeBlockedReason());
  const noteFailure = useConnection((s) => s.noteFailure);

  const [acctGuid, setAcctGuid] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [description, setDescription] = useState('');
  const [picker, setPicker] = useState<{ kind: 'account' } | { kind: 'line'; key: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const account = acctGuid ? byGuid(acctGuid) : undefined;
  const currency = account?.commodity_mnemonic ?? 'IDR';

  const total = useMemo(
    () => lines.reduce((sum, l) => sum + parseCurrencyInput(l.raw), 0),
    [lines],
  );

  const ready =
    !!account &&
    lines.length > 0 &&
    lines.every((l) => l.accountGuid && parseCurrencyInput(l.raw) > 0);

  function setLine(key: string, patch: Partial<Line>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pick(a: Account) {
    if (picker?.kind === 'account') setAcctGuid(a.guid);
    if (picker?.kind === 'line') setLine(picker.key, { accountGuid: a.guid });
    setPicker(null);
  }

  async function handleSave() {
    if (!ready || !account || saving) return;
    setSaving(true);

    const requestId = generateTransactionId();
    await markInFlight(requestId, description.trim() || (inflow ? 'Income' : 'Expense'));

    const result = await callRpc<{ status: string; tx_guid: string; line_count: number }>(
      'mgc_record_transaction',
      {
        p_request_id: requestId,
        p_account_guid: account.guid,
        p_direction: inflow ? 'inflow' : 'outflow',
        p_splits: lines.map((l) => ({
          account_guid: l.accountGuid,
          amount: parseCurrencyInput(l.raw),
          memo: l.memo.trim(),
        })),
        p_post_date: today(),
        p_description: description.trim(),
      },
    );

    // Clear only on a KNOWN outcome. Offline is not known: the write may have
    // committed with the response lost, and that is what the marker is for.
    if (result.ok || result.kind === 'rejected' || result.kind === 'unauthorized') {
      await clearInFlight();
    }
    setSaving(false);

    if (result.ok) {
      Alert.alert(
        result.data.status === 'already_recorded' ? 'Already recorded' : 'Recorded',
        result.data.status === 'already_recorded'
          ? 'This entry had already been written to your book.'
          : `Written to GnuCash across ${result.data.line_count} line${result.data.line_count === 1 ? '' : 's'}.`,
        [{ text: 'Done', onPress: () => router.back() }],
      );
      return;
    }

    noteFailure(result.kind, result.error);

    if (result.kind === 'offline') {
      Alert.alert(
        'Connection lost',
        `${result.error}\n\nThis entry may or may not have reached your book. The app will check and tell you next time it connects, so do not enter it again yet.`,
      );
      return;
    }
    Alert.alert('Not saved', result.error);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>{inflow ? 'Income' : 'Expense'}</Text>
        <ConnectionBanner />

        <Text style={styles.label}>{inflow ? 'Into' : 'Paid from'}</Text>
        <Pressable style={styles.selector} onPress={() => setPicker({ kind: 'account' })}>
          <Text style={account ? styles.selectorValue : styles.selectorPlaceholder} numberOfLines={2}>
            {account ? account.full_path : 'Choose an account'}
          </Text>
          {account?.commodity_mnemonic ? (
            <Text style={styles.selectorCcy}>{account.commodity_mnemonic}</Text>
          ) : null}
        </Pressable>

        {account ? (
          <Text style={styles.ccyNote}>
            Every line has to be in {currency} too. Mixing currencies in one entry needs a rate, so
            it belongs in GnuCash desktop.
          </Text>
        ) : null}

        <Text style={styles.label}>{inflow ? 'From' : 'Spent on'}</Text>
        {lines.map((line, i) => {
          const lineAcct = line.accountGuid ? byGuid(line.accountGuid) : undefined;
          return (
            <View key={line.key} style={styles.lineCard}>
              <View style={styles.lineHead}>
                <Text style={styles.lineNum}>{i + 1}</Text>
                {lines.length > 1 ? (
                  <Pressable
                    hitSlop={10}
                    onPress={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                  >
                    <Icon name="close" size={16} color={theme.inkFaint} />
                  </Pressable>
                ) : null}
              </View>

              <Pressable
                style={styles.lineSelector}
                onPress={() => setPicker({ kind: 'line', key: line.key })}
              >
                <Text
                  style={lineAcct ? styles.selectorValue : styles.selectorPlaceholder}
                  numberOfLines={2}
                >
                  {lineAcct ? lineAcct.full_path : inflow ? 'Choose an income account' : 'Choose an expense account'}
                </Text>
              </Pressable>

              <AmountInput
                value={line.raw}
                onChangeText={(raw) => setLine(line.key, { raw })}
                currency={currency}
                style={styles.lineAmount}
                placeholder="0"
                placeholderTextColor={theme.inkFaint}
              />

              <TextInput
                style={styles.lineMemo}
                placeholder="Note for this line (optional)"
                placeholderTextColor={theme.inkFaint}
                value={line.memo}
                onChangeText={(memo) => setLine(line.key, { memo })}
              />
            </View>
          );
        })}

        <Pressable style={styles.addLine} onPress={() => setLines((prev) => [...prev, newLine()])}>
          <Icon name="plus" size={16} color={theme.accent} />
          <Text style={styles.addLineText}>Add another line</Text>
        </Pressable>

        <Text style={styles.label}>What is this for</Text>
        <TextInput
          style={styles.note}
          placeholder={inflow ? 'e.g. September invoice' : 'e.g. Groceries'}
          placeholderTextColor={theme.inkFaint}
          value={description}
          onChangeText={setDescription}
        />

        <View style={styles.totalBox}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatAmount(total, currency)}</Text>
        </View>

        {blockedReason ? <Text style={styles.blocked}>{blockedReason}</Text> : null}

        <Pressable
          style={[styles.btn, (!ready || !canWrite || saving) && styles.btnDisabled]}
          disabled={!ready || !canWrite || saving}
          onPress={handleSave}
        >
          <Text style={styles.btnText}>{saving ? 'Saving…' : `Record ${inflow ? 'income' : 'expense'}`}</Text>
        </Pressable>

        <Pressable style={styles.cancel} onPress={() => router.back()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </ScrollView>

      <AccountPicker
        visible={picker !== null}
        title={
          picker?.kind === 'account'
            ? inflow ? 'Receive into' : 'Pay from'
            : inflow ? 'Income account' : 'Expense account'
        }
        types={
          picker?.kind === 'account'
            ? [...ASSET_TYPES, 'CREDIT', 'LIABILITY']
            : inflow ? INCOME_TYPES : EXPENSE_TYPES
        }
        // Lines are constrained to the funding account's own commodity, which
        // is the same rule the server enforces. Better to make the wrong choice
        // unreachable than to explain a rejection afterwards.
        commodityGuid={picker?.kind === 'line' ? account?.commodity_guid ?? undefined : undefined}
        selectedGuid={
          picker?.kind === 'account'
            ? acctGuid
            : picker?.kind === 'line'
              ? lines.find((l) => l.key === picker.key)?.accountGuid ?? null
              : null
        }
        onSelect={pick}
        onDismiss={() => setPicker(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 20, paddingBottom: 300 },
  h1: { color: theme.ink, fontSize: 26, fontFamily: 'DMSerifDisplay', marginBottom: 16 },
  label: { color: theme.ink, fontSize: 13, fontWeight: '600', marginTop: 22, marginBottom: 8 },
  selector: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: theme.surface,
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 14,
  },
  selectorValue: { color: theme.ink, fontSize: 14, flex: 1, lineHeight: 19 },
  selectorPlaceholder: { color: theme.inkFaint, fontSize: 14, flex: 1 },
  selectorCcy: { color: theme.inkSoft, fontSize: 12, marginLeft: 10 },
  ccyNote: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 8 },
  lineCard: {
    backgroundColor: theme.surfaceSoft, borderRadius: 12, padding: 12, marginBottom: 10,
  },
  lineHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  lineNum: { color: theme.inkFaint, fontSize: 11, letterSpacing: 1 },
  lineSelector: {
    backgroundColor: theme.surface, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12,
  },
  lineAmount: {
    backgroundColor: theme.surface, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12,
    color: theme.ink, fontSize: 18, marginTop: 8, fontVariant: ['tabular-nums'],
  },
  lineMemo: {
    backgroundColor: theme.surface, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10,
    color: theme.ink, fontSize: 13, marginTop: 8,
  },
  addLine: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  addLineText: { color: theme.accent, fontSize: 14, fontWeight: '600', marginLeft: 6 },
  note: {
    backgroundColor: theme.surface, borderRadius: 10, paddingHorizontal: 14,
    paddingVertical: 13, color: theme.ink, fontSize: 15,
  },
  totalBox: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 24, paddingTop: 16, borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.hairline,
  },
  totalLabel: { color: theme.inkFaint, fontSize: 11, letterSpacing: 1.2, textTransform: 'uppercase' },
  totalValue: { color: theme.ink, fontSize: 22, fontFamily: 'DMSerifDisplay' },
  blocked: { color: theme.amber, fontSize: 13, lineHeight: 19, marginTop: 20 },
  btn: {
    backgroundColor: theme.accent, borderRadius: 12, paddingVertical: 16,
    alignItems: 'center', marginTop: 22,
  },
  btnText: { color: theme.bg, fontSize: 15, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },
  cancel: { alignItems: 'center', paddingVertical: 16 },
  cancelText: { color: theme.inkSoft, fontSize: 15 },
});
