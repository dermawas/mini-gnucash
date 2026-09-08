// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Move money between two of your own accounts, including across currencies.
//
// ===========================================================================
// THE RATE IS SHOWN, NEVER TYPED.
// ===========================================================================
// It is tempting to add a rate field here. Do not.
//
// A cross-currency transfer has three numbers -- amount out, amount in, rate --
// of which only two are independent. Every UI that asks for all three lets them
// disagree, rounding guarantees they eventually will, and the remainder becomes
// an Imbalance split. That is the exact problem this screen replaces.
//
// So: two inputs, and a read-only readout of what the server will derive. The
// number displayed after saving is the server's own `derived_rate`, not a
// client-side recomputation of what was typed.
// ===========================================================================

import { useCallback, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import AmountInput from '../../src/components/AmountInput';
import { AccountSheet } from '../../src/components/AccountSheet';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts, ASSET_TYPES } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { transfer } from '../../src/services/api';
import { generateTransactionId } from '../../src/utils/idempotency';
import { parseCurrencyInput, formatAmount } from '../../src/utils/currency';
import { theme, fonts } from '../../src/constants/theme';
import type { Account } from '../../src/services/api';
import { DateField } from '../../src/components/DateField';
import { todayIso } from '../../src/utils/receiptDate';


export default function Transfer() {
  const router = useRouter();
  const byGuid = useAccounts((s) => s.byGuid);
  const canWrite = useConnection((s) => s.canWrite());
  const blockedReason = useConnection((s) => s.writeBlockedReason());
  const noteFailure = useConnection((s) => s.noteFailure);

  const [fromGuid, setFromGuid] = useState<string | null>(null);
  const [toGuid, setToGuid] = useState<string | null>(null);
  const [fromRaw, setFromRaw] = useState('');
  const [toRaw, setToRaw] = useState('');
  const [description, setDescription] = useState('');
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const [saving, setSaving] = useState(false);
  // Previously hardcoded to today(), so a transfer done last week could not
  // be entered from the phone at all.
  const [postDate, setPostDate] = useState<string>(todayIso());

  // Android back, same three layers as the Entry screen and for the same
  // reason: AccountPicker sits in an OverlayModal, which is a plain View
  // rather than a native <Modal>, so back does not dismiss it for free -- it
  // sailed past an open picker and closed the app, taking the half-typed
  // transfer with it. Transfer became a tab on 2026-09-08, which is what
  // exposed this; as a pushed route back had somewhere harmless to go.
  const dirty = !!fromGuid || !!toGuid || !!fromRaw.trim() || !!toRaw.trim()
    || description.trim().length > 0;

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (picker) { setPicker(null); return true; }
        if (dirty) {
          Alert.alert(
            'Discard this transfer?',
            'Nothing has been written to your book yet.',
            [
              { text: 'Keep editing', style: 'cancel' },
              {
                text: 'Discard',
                style: 'destructive',
                onPress: () => {
                  setFromGuid(null); setToGuid(null);
                  setFromRaw(''); setToRaw(''); setDescription('');
                },
              },
            ],
          );
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [picker, dirty]),
  );

  const from = fromGuid ? byGuid(fromGuid) : undefined;
  const to = toGuid ? byGuid(toGuid) : undefined;

  const sameCurrency = !!from && !!to && from.commodity_guid === to.commodity_guid;
  const fromAmount = parseCurrencyInput(fromRaw);
  // When both sides share a commodity the amounts cannot differ, so the second
  // input disappears and mirrors the first rather than inviting a contradiction.
  const toAmount = sameCurrency ? fromAmount : parseCurrencyInput(toRaw);

  const rate = useMemo(() => {
    if (sameCurrency || !fromAmount || !toAmount) return null;
    return toAmount / fromAmount;
  }, [sameCurrency, fromAmount, toAmount]);

  const ready = !!from && !!to && fromAmount > 0 && toAmount > 0 && from.guid !== to.guid;

  function pick(a: Account) {
    if (picker === 'from') setFromGuid(a.guid);
    if (picker === 'to') setToGuid(a.guid);
    setPicker(null);
  }

  async function handleSave() {
    if (!ready || !from || !to || saving) return;
    setSaving(true);

    const result = await transfer({
      requestId: generateTransactionId(),
      fromGuid: from.guid,
      fromAmount,
      toGuid: to.guid,
      toAmount,
      postDate,
      description: description.trim(),
    });

    setSaving(false);

    if (result.ok) {
      const d = result.data;
      const rateLine =
        d.derived_rate != null
          ? `\n\nRate applied: 1 ${d.from_currency} = ${d.derived_rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${d.to_currency}`
          : '';
      Alert.alert(
        d.status === 'already_recorded' ? 'Already recorded' : 'Transfer recorded',
        d.status === 'already_recorded'
          ? 'This transfer had already been written to your book.'
          : `Written to GnuCash as ${d.form === 'trading' ? 'a balanced four-split entry' : 'a balanced entry'}.${rateLine}`,
        [{ text: 'Done', onPress: () => router.back() }],
      );
      return;
    }

    noteFailure(result.kind, result.error);

    // An offline result is the one genuinely ambiguous outcome: the server may
    // have committed with the response lost. The request id is parked on disk,
    // so say so honestly rather than inviting a blind retry that could double it.
    if (result.kind === 'offline') {
      Alert.alert(
        'Connection lost',
        `${result.error}\n\nThis transfer may or may not have reached your book. The app will check and tell you next time it connects — don't re-enter it yet.`,
      );
      return;
    }

    Alert.alert('Not saved', result.error);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Transfer</Text>
        <ConnectionBanner />

        <Text style={styles.label}>From</Text>
        <Pressable style={styles.selector} onPress={() => setPicker('from')}>
          <Text style={from ? styles.selectorValue : styles.selectorPlaceholder} numberOfLines={2}>
            {from ? from.full_path : 'Choose an account'}
          </Text>
          {from?.commodity_mnemonic ? (
            <Text style={styles.selectorCcy}>{from.commodity_mnemonic}</Text>
          ) : null}
        </Pressable>

        {from ? (
          <AmountInput
            value={fromRaw}
            onChangeText={setFromRaw}
            currency={from.commodity_mnemonic ?? 'IDR'}
            style={styles.amount}
            placeholderTextColor={theme.inkFaint}
            placeholder="0"
          />
        ) : null}

        <Text style={styles.label}>To</Text>
        <Pressable style={styles.selector} onPress={() => setPicker('to')}>
          <Text style={to ? styles.selectorValue : styles.selectorPlaceholder} numberOfLines={2}>
            {to ? to.full_path : 'Choose an account'}
          </Text>
          {to?.commodity_mnemonic ? (
            <Text style={styles.selectorCcy}>{to.commodity_mnemonic}</Text>
          ) : null}
        </Pressable>

        {to && !sameCurrency ? (
          <AmountInput
            value={toRaw}
            onChangeText={setToRaw}
            currency={to.commodity_mnemonic ?? 'IDR'}
            style={styles.amount}
            placeholderTextColor={theme.inkFaint}
            placeholder="0"
          />
        ) : null}

        {to && sameCurrency ? (
          <Text style={styles.mirrorNote}>
            Both accounts are in {to.commodity_mnemonic}, so the amount received is the same.
          </Text>
        ) : null}

        <Text style={styles.label}>What is this for</Text>
        <TextInput
          style={styles.note}
          placeholder="e.g. Sold USD"
          placeholderTextColor={theme.inkFaint}
          value={description}
          onChangeText={setDescription}
        />

        <Text style={styles.label}>Date</Text>
        <DateField
          value={postDate}
          onChange={setPostDate}
          caption="Defaults to today. Change it for a transfer you are recording after the fact."
        />

        {/* Read-only. See the header of this file before changing that. */}
        {!sameCurrency && from && to ? (
          <View style={styles.rateBox}>
            <Text style={styles.rateLabel}>Exchange rate</Text>
            {rate ? (
              <>
                <Text style={styles.rateMain}>
                  1 {from.commodity_mnemonic} ={' '}
                  {rate.toLocaleString(undefined, { maximumFractionDigits: 6 })}{' '}
                  {to.commodity_mnemonic}
                </Text>
                <Text style={styles.rateInverse}>
                  1 {to.commodity_mnemonic} ={' '}
                  {(1 / rate).toLocaleString(undefined, { maximumFractionDigits: 8 })}{' '}
                  {from.commodity_mnemonic}
                </Text>
              </>
            ) : (
              <Text style={styles.ratePending}>Enter both amounts to see the rate.</Text>
            )}
            <Text style={styles.rateHint}>
              Worked out from the two amounts, so the entry cannot come out unbalanced.
            </Text>
          </View>
        ) : null}

        {blockedReason ? <Text style={styles.blocked}>{blockedReason}</Text> : null}

        <Pressable
          style={[styles.btn, (!ready || !canWrite || saving) && styles.btnDisabled]}
          disabled={!ready || !canWrite || saving}
          onPress={handleSave}
        >
          <Text style={styles.btnText}>{saving ? 'Saving…' : 'Record transfer'}</Text>
        </Pressable>

        <Pressable style={styles.cancel} onPress={() => router.back()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </ScrollView>

      <AccountSheet
        visible={picker !== null}
        title={picker === 'from' ? 'Transfer from' : 'Transfer to'}
        types={ASSET_TYPES}
        excludeGuids={
          picker === 'from' ? (toGuid ? [toGuid] : []) : fromGuid ? [fromGuid] : []
        }
        selectedGuid={picker === 'from' ? fromGuid : toGuid}
        onSelect={pick}
        onDismiss={() => setPicker(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 20, paddingBottom: 300 },
  h1: { color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium, marginBottom: 16 },
  label: { color: theme.ink, fontSize: 13, fontFamily: fonts.sansMedium, marginTop: 20, marginBottom: 8 },
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  selectorValue: { color: theme.ink, fontSize: 14, flex: 1, lineHeight: 19 },
  selectorPlaceholder: { color: theme.inkFaint, fontSize: 14, flex: 1 },
  selectorCcy: { color: theme.inkSoft, fontSize: 12, marginLeft: 10 },
  amount: {
    backgroundColor: theme.surface,
    borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingHorizontal: 14,
    paddingVertical: 14,
    color: theme.ink,
    fontSize: 20,
    marginTop: 10,
    fontFamily: fonts.mono,
    fontVariant: ['tabular-nums'],
  },
  note: {
    backgroundColor: theme.surface,
    borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingHorizontal: 14,
    paddingVertical: 13,
    color: theme.ink,
    fontSize: 15,
  },
  mirrorNote: { color: theme.inkFaint, fontSize: 12, lineHeight: 17, marginTop: 10 },
  rateBox: {
    backgroundColor: theme.surfaceSoft,
    borderRadius: 12,
    padding: 16,
    marginTop: 24,
  },
  rateLabel: { color: theme.inkFaint, fontSize: 11, letterSpacing: 1, marginBottom: 8 },
  rateMain: { color: theme.ink, fontSize: 17, fontFamily: fonts.mono, fontVariant: ['tabular-nums'] },
  rateInverse: { color: theme.inkSoft, fontSize: 13, marginTop: 4, fontFamily: fonts.mono, fontVariant: ['tabular-nums'] },
  ratePending: { color: theme.inkFaint, fontSize: 14 },
  rateHint: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 10 },
  blocked: { color: theme.amber, fontSize: 13, lineHeight: 19, marginTop: 24 },
  btn: {
    backgroundColor: theme.accent,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 24,
  },
  btnText: { color: theme.bg, fontSize: 15, fontFamily: fonts.sansMedium },
  btnDisabled: { opacity: 0.4 },
  cancel: { alignItems: 'center', paddingVertical: 16, marginTop: 4 },
  cancelText: { color: theme.inkSoft, fontSize: 15 },
});
