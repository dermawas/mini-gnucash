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
import { Icon } from '../../src/components/Icon';
import AmountInput from '../../src/components/AmountInput';
import { AccountPicker } from '../../src/components/AccountPicker';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts, ASSET_TYPES, EXPENSE_TYPES, INCOME_TYPES } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { callRpc, markInFlight, clearInFlight, type Account } from '../../src/services/api';
import { generateTransactionId } from '../../src/utils/idempotency';
import { parseCurrencyInput, formatAmount } from '../../src/utils/currency';
import { theme, fonts } from '../../src/constants/theme';
import { DateField } from '../../src/components/DateField';
import { todayIso } from '../../src/utils/receiptDate';

type Line = { key: string; accountGuid: string | null; raw: string; memo: string };


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
  // Drives the handoff's inline confirmation. A boolean rather than a toast:
  // the button is where the user is already looking when a save lands.
  const [saved, setSaved] = useState(false);
  // Previously hardcoded to today(), so nothing backdated could be entered.
  const [postDate, setPostDate] = useState<string>(todayIso());

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
        p_post_date: postDate,
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
      // 'already_recorded' keeps its alert. It means the idempotency key
      // matched a write that had already landed, which is a different outcome
      // from "this entry went in just now", and quietly showing the same
      // "Saved" for both would hide a duplicate submission.
      if (result.data.status === 'already_recorded') {
        Alert.alert(
          'Already recorded',
          'This entry had already been written to your book.',
          [{ text: 'Done', onPress: () => router.back() }],
        );
        return;
      }
      // The handoff's confirmation: "Saved" in the button for ~1.2s, then
      // back to one empty line, staying on the screen. The funding account and
      // the date are deliberately kept -- entering several things bought on
      // the same day out of the same wallet is the normal case.
      setSaved(true);
      setLines([newLine()]);
      setDescription('');
      setTimeout(() => setSaved(false), 1200);
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
        <ConnectionBanner />
        <Text style={styles.h1}>{inflow ? 'New income' : 'New spend'}</Text>

        {/* The handoff's chip row: the two facts that frame every line, small
            enough to sit side by side and tappable to change. */}
        <View style={styles.chipRow}>
          <DateField
            value={postDate}
            onChange={setPostDate}
            variant="chip"
          />
          <Pressable style={styles.chip} onPress={() => setPicker({ kind: 'account' })}>
            <Text style={styles.chipText} numberOfLines={1}>
              {account
                ? `${inflow ? 'Into' : 'From'} · ${account.name}`
                : inflow ? 'Into · choose' : 'From · choose'}
            </Text>
          </Pressable>
        </View>

        {account ? (
          <Text style={styles.ccyNote}>
            Every line has to be in {currency} too. Mixing currencies in one entry needs a rate, so
            it belongs in GnuCash desktop.
          </Text>
        ) : null}

        <View style={styles.sectionHead}>
          <Text style={styles.sectionLabel}>LINES</Text>
          <Text style={styles.sectionCount}>{lines.length}</Text>
        </View>

        {lines.map((line) => {
          const lineAcct = line.accountGuid ? byGuid(line.accountGuid) : undefined;
          return (
            <View key={line.key} style={styles.lineRow}>
              <View style={styles.lineLeft}>
                <View style={styles.lineTop}>
                  <Pressable
                    style={styles.lineAcct}
                    onPress={() => setPicker({ kind: 'line', key: line.key })}
                  >
                    <Text
                      style={lineAcct ? styles.lineAcctText : styles.linePlaceholder}
                      numberOfLines={1}
                    >
                      {lineAcct
                        ? lineAcct.name
                        : inflow ? 'Choose an income account' : 'Choose an expense account'}
                    </Text>
                  </Pressable>
                  {lines.length > 1 ? (
                    <Pressable
                      hitSlop={12}
                      onPress={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      accessibilityRole="button"
                      accessibilityLabel="Remove this line"
                    >
                      <Text style={styles.lineRemove}>×</Text>
                    </Pressable>
                  ) : null}
                </View>
                <TextInput
                  style={styles.lineMemo}
                  placeholder="Note (optional)"
                  placeholderTextColor={theme.inkFaint}
                  value={line.memo}
                  onChangeText={(memo) => setLine(line.key, { memo })}
                />
              </View>

              <View style={styles.lineRight}>
                <AmountInput
                  value={line.raw}
                  onChangeText={(raw) => setLine(line.key, { raw })}
                  currency={currency}
                  style={styles.lineAmount}
                  placeholder="0"
                  placeholderTextColor={theme.inkFaint}
                />
              </View>
            </View>
          );
        })}

        <Pressable style={styles.addLine} onPress={() => setLines((prev) => [...prev, newLine()])}>
          <Icon name="add" size={14} color={theme.inkFaint} />
          <Text style={styles.addLineText}>Add line</Text>
        </Pressable>

        <Text style={styles.label}>What is this for</Text>
        <TextInput
          style={styles.note}
          placeholder={inflow ? 'e.g. September invoice' : 'e.g. Groceries'}
          placeholderTextColor={theme.inkFaint}
          value={description}
          onChangeText={setDescription}
        />

        {blockedReason ? <Text style={styles.blocked}>{blockedReason}</Text> : null}

        <Pressable style={styles.cancel} onPress={() => router.back()}>
          <Text style={styles.cancelText}>Back to accounts</Text>
        </Pressable>
      </ScrollView>

      {/* Sticky, per the handoff, so the running total and the commit are in
          view while lines are being typed rather than at the end of a scroll. */}
      <View style={styles.footer}>
        <View style={styles.footerTotal}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{formatAmount(total, currency)}</Text>
        </View>
        <Pressable
          style={[styles.primary, (!ready || !canWrite || saving) && styles.primaryOff]}
          disabled={!ready || !canWrite || saving}
          onPress={handleSave}
        >
          <Text style={styles.primaryText} numberOfLines={1}>
            {saved
              ? 'Saved ✓'
              : saving
                ? 'Saving…'
                : account ? `Save to ${account.name}` : 'Save'}
          </Text>
        </Pressable>
      </View>

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
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },
  h1: { color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium, marginBottom: 14 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chip: {
    backgroundColor: theme.surface, borderRadius: 8,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 9, paddingHorizontal: 12, flexShrink: 1,
  },
  chipText: { color: theme.ink, fontSize: 13, fontFamily: fonts.sans },
  ccyNote: {
    color: theme.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 10, fontFamily: fonts.sans,
  },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    paddingTop: 18, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong, marginBottom: 10,
  },
  sectionLabel: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1.1, fontFamily: fonts.sansMedium,
  },
  sectionCount: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.mono },
  // The handoff's 1fr / 92px grid.
  lineRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  lineLeft: {
    flex: 1, backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong, paddingVertical: 8, paddingHorizontal: 10,
  },
  lineTop: { flexDirection: 'row', alignItems: 'center' },
  lineAcct: { flex: 1, paddingVertical: 2 },
  lineAcctText: { color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  linePlaceholder: { color: theme.inkFaint, fontSize: 14, fontFamily: fonts.sans },
  lineRemove: { color: theme.inkFaint, fontSize: 18, paddingLeft: 8, lineHeight: 20 },
  lineMemo: {
    color: theme.inkSoft, fontSize: 12, fontFamily: fonts.sans,
    paddingVertical: 2, marginTop: 2, minHeight: 22,
  },
  lineRight: {
    width: 92, backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6,
  },
  lineAmount: {
    color: theme.ink, fontSize: 15, fontFamily: fonts.mono, textAlign: 'center',
    width: '100%', paddingVertical: 8,
  },
  addLine: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderStyle: 'dashed', borderColor: theme.disabled,
    borderRadius: 10, paddingVertical: 11, marginTop: 2,
  },
  addLineText: { color: theme.inkFaint, fontSize: 13, fontFamily: fonts.sans, marginLeft: 6 },
  label: {
    color: theme.ink, fontSize: 13, fontFamily: fonts.sansMedium, marginTop: 22, marginBottom: 8,
  },
  note: {
    backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    color: theme.ink, fontSize: 14, fontFamily: fonts.sans,
    paddingVertical: 12, paddingHorizontal: 12, minHeight: 46,
  },
  blocked: { color: theme.coral, fontSize: 12, lineHeight: 17, marginTop: 14, fontFamily: fonts.sans },
  cancel: { paddingVertical: 14, alignItems: 'center', marginTop: 14 },
  cancelText: { color: theme.inkFaint, fontSize: 13, fontFamily: fonts.sansMedium },
  footer: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20,
    borderTopWidth: 1, borderTopColor: theme.hairlineStrong, backgroundColor: theme.bg,
  },
  footerTotal: { flex: 1, marginRight: 14 },
  totalLabel: { color: theme.inkFaint, fontSize: 12, fontFamily: fonts.sans },
  totalValue: {
    color: theme.ink, fontSize: 22, fontFamily: fonts.monoMedium,
    fontVariant: ['tabular-nums'], marginTop: 2,
  },
  primary: {
    backgroundColor: theme.ink, borderRadius: 10,
    paddingVertical: 12, paddingHorizontal: 20, flexShrink: 1,
  },
  primaryOff: { opacity: 0.35 },
  primaryText: { color: theme.bg, fontSize: 14, fontFamily: fonts.sansMedium },
});
