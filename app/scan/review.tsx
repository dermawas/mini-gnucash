// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Scan a receipt, review what came back, then write it.
//
// The order on this screen is deliberate: the funding account is chosen BEFORE
// the photo is taken. It decides the commodity, the commodity decides which
// expense accounts are eligible, and matching against the wrong set is worse
// than not matching at all. It also means a scan is never spent on a selection
// the user had not made yet.
//
// Everything the AI produced is a PROPOSAL. Nothing is written until the save
// button is pressed, no line is saved without an account the user can see, and
// `suggested_category` only ranks accounts -- it is never stored. What IS
// stored, on this device only, is which account you picked for a merchant, so
// the next scan of the same shop proposes what you meant rather than whatever
// phrase the model produced that run. See merchantMemory.ts. The
// arithmetic that has to balance is done by allocate.ts and then by the RPC,
// never by the model.

import { useMemo, useState } from 'react';
import {
  View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert, Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Icon } from '../../src/components/Icon';
import { AccountPicker } from '../../src/components/AccountPicker';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { useAccounts, ASSET_TYPES, EXPENSE_TYPES } from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import { callRpc, markInFlight, clearInFlight, type Account } from '../../src/services/api';
import { extractReceipt, type ReceiptScan } from '../../src/services/receiptExtraction';
import { getAiKey, getAiModel } from '../../src/services/aiKey';
import { matchLine } from '../../src/services/accountMatch';
import { loadMemory, recall, remember } from '../../src/services/merchantMemory';
import { generateTransactionId } from '../../src/utils/idempotency';
import { formatAmount, roundingUnit } from '../../src/utils/currency';
import { postDate, todayIso, isValidIsoDate } from '../../src/utils/receiptDate';
import { DateField } from '../../src/components/DateField';
import { theme, fonts } from '../../src/constants/theme';

type Line = {
  key: string;
  name: string;
  amount: number;
  accountGuid: string | null;
  /** True while the account is the matcher's proposal, not a user choice. */
  proposed: boolean;
  /**
   * Where a proposal came from, so the screen can say. "You chose this here
   * before" and "the words on the receipt looked like this" deserve different
   * amounts of trust, and the second is the one that has been wrong.
   */
  basis: 'tokens' | 'item' | 'merchant' | null;
};

export default function ScanReview() {
  const router = useRouter();
  const byGuid = useAccounts((s) => s.byGuid);
  const postable = useAccounts((s) => s.postable);
  const canWrite = useConnection((s) => s.canWrite());
  const blockedReason = useConnection((s) => s.writeBlockedReason());
  const noteFailure = useConnection((s) => s.noteFailure);

  const [acctGuid, setAcctGuid] = useState<string | null>(null);
  const [scan, setScan] = useState<ReceiptScan | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [scanning, setScanning] = useState(false);
  // The handoff puts a strip of the receipt above the lines, so a suspicious
  // figure can be checked against the paper without leaving the screen. Only
  // the local URI is held; the base64 that goes to Google is not kept.
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoBig, setPhotoBig] = useState(false);
  const [saving, setSaving] = useState(false);
  // null means "whatever the receipt said"; a string is a correction the user
  // typed. Kept separate so re-scanning cleanly discards an edit that belonged
  // to the previous receipt.
  const [dateEdit, setDateEdit] = useState<string | null>(null);
  const [picker, setPicker] =
    useState<{ kind: 'account' } | { kind: 'line'; key: string } | null>(null);

  const account = acctGuid ? byGuid(acctGuid) : undefined;
  const currency = account?.commodity_mnemonic ?? null;
  const scu = account?.commodity_scu ?? 100;

  const total = useMemo(() => lines.reduce((s, l) => s + l.amount, 0), [lines]);
  // A zero line is real information off the receipt -- a free paper bag is
  // genuinely printed there -- but it is not a split. mgc_record_transaction
  // rejects any amount <= 0 on purpose ("amounts are always positive; the
  // direction decides the sign"), and that guard is worth keeping for every
  // caller rather than loosening for this one. So show the line, and leave it
  // out of the payload: a zero split would add nothing to the double entry
  // either way.
  const payable = lines.filter((l) => l.amount > 0);

  // The number on this screen and the number that reaches the ledger must be
  // the same one. They diverged once: the filter above, written for a Rp 0
  // paper bag, also dropped the negative discount lines a supermarket receipt
  // carries, so the screen showed a discounted total while the payload held the
  // undiscounted one -- and nothing complained, because mgc_record_transaction
  // derives the funding split from the lines it is given and balanced happily
  // at the wrong figure. Negative lines are folded into the discount upstream
  // now, so this should never fire; it exists so that if it ever does, it stops
  // the write instead of quietly changing the amount.
  const payableTotal = payable.reduce((sum, l) => sum + l.amount, 0);
  const totalsAgree = Math.abs(total - payableTotal) < 1e-9;
  const unassigned = payable.filter((l) => !l.accountGuid).length;

  // The receipt's currency against the funding account's. Not a warning to
  // click past: mgc_record_transaction refuses a cross-currency entry, so
  // saving would fail server-side. Better to say so here, in terms of the
  // receipt in the user's hand.
  const currencyMismatch =
    !!scan && !!currency && !!scan.currency && scan.currency.toUpperCase() !== currency;

  const extractedDate = scan ? postDate(scan.date) : null;
  const effectiveDate = dateEdit ?? extractedDate?.date ?? todayIso();

  // An unparseable date blocks the save -- the RPC would reject it anyway, and
  // failing here says why. A date that is merely suspicious does not block:
  // an old receipt is a real thing, and refusing it would be worse than the
  // problem being guarded against.
  const dateUnusable = !!scan && !isValidIsoDate(effectiveDate);

  const ready =
    !!account && payable.length > 0 && unassigned === 0 && totalsAgree && !saving
    && !currencyMismatch && !dateUnusable;

  async function runScan(source: 'camera' | 'library') {
    if (!account) return;

    const apiKey = await getAiKey();
    if (!apiKey) {
      Alert.alert(
        'No Gemini key',
        'Receipt scanning uses your own Gemini API key. Add one in Settings.',
      );
      return;
    }

    if (source === 'camera') {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera not allowed', 'Grant camera access to photograph a receipt.');
        return;
      }
    }

    const picked =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7 })
        : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7 });

    if (picked.canceled || !picked.assets?.length) return;
    const asset = picked.assets[0];
    setPhotoUri(asset.uri ?? null);
    setPhotoBig(false);
    if (!asset.base64) {
      Alert.alert('Could not read that image', 'Try again, or pick a different photo.');
      return;
    }

    setScanning(true);
    const result = await extractReceipt({
      base64Image: asset.base64,
      mimeType: asset.mimeType ?? 'image/jpeg',
      apiKey,
      model: await getAiModel(),
      // The funding account is chosen before the photo, so its precision is
      // always known by the time allocation runs.
      roundingUnit: roundingUnit(currency ?? 'IDR', scu),
    });
    setScanning(false);

    if (!result.ok) {
      Alert.alert('Could not read that receipt', result.message);
      return;
    }

    // A topup moves money between two real accounts. Recording it here would
    // book it as an expense against a category, which is the wrong shape, and
    // the rate would be invented. Send it where it belongs.
    if (result.receipt_type === 'topup') {
      Alert.alert(
        'That looks like a topup',
        'Money moving into your own wallet is a transfer, not an expense. The transfer screen takes both amounts and derives the rate itself.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open transfer', onPress: () => router.replace('/transfer') },
        ],
      );
      return;
    }

    const candidates = postable(EXPENSE_TYPES);
    const memory = await loadMemory();
    setScan(result);
    setDateEdit(null);
    setLines(
      result.items.map((item, i) => {
        const match = matchLine(
          item,
          candidates,
          currency,
          recall(memory, result.merchant ?? '', item.name),
        );
        return {
          key: `r${i}`,
          name: item.name,
          amount: item.allocated_price,
          accountGuid: match?.account.guid ?? null,
          proposed: !!match,
          basis: match?.basis ?? null,
        };
      }),
    );
  }

  async function handleSave() {
    if (!ready || !account || !scan) return;
    setSaving(true);

    const date = effectiveDate;
    const requestId = generateTransactionId();
    const label = scan.merchant?.trim() || 'Receipt';
    // The discount is spread across the lines, so no split records it and the
    // figure would otherwise exist nowhere in the book. Descriptions are the
    // only transaction-level free text this RPC takes, and they are searchable
    // in GnuCash desktop and in SQL -- the same place the item names live.
    const description =
      scan.receipt_discount > 0
        ? `${label} (disc ${formatAmount(scan.receipt_discount, currency ?? 'IDR', scu)})`
        : label;
    await markInFlight(requestId, label);

    const result = await callRpc<{ status: string; tx_guid: string; line_count: number }>(
      'mgc_record_transaction',
      {
        p_request_id: requestId,
        p_account_guid: account.guid,
        p_direction: 'outflow',
        p_splits: payable.map((l) => ({
          account_guid: l.accountGuid,
          amount: l.amount,
          memo: l.name.trim(),
        })),
        p_post_date: date,
        p_description: description,
      },
    );

    if (result.ok || result.kind === 'rejected' || result.kind === 'unauthorized') {
      await clearInFlight();
    }
    setSaving(false);

    if (result.ok) {
      // After the write, never before: a save that failed may have been a
      // correction in progress. `proposed` is false only where the user opened
      // the picker and chose, which is the only thing worth learning from.
      await remember(
        label,
        payable
          .filter((l) => l.accountGuid)
          .map((l) => ({ name: l.name, accountGuid: l.accountGuid as string, chosen: !l.proposed })),
      );
      Alert.alert(
        result.data.status === 'already_recorded' ? 'Already recorded' : 'Recorded',
        result.data.status === 'already_recorded'
          ? 'This receipt had already been written to your book.'
          : `Written to GnuCash across ${result.data.line_count} line${result.data.line_count === 1 ? '' : 's'}.`,
        [{ text: 'Done', onPress: () => router.back() }],
      );
      return;
    }

    noteFailure(result.kind, result.error);
    if (result.kind === 'offline') {
      Alert.alert(
        'Connection lost',
        `${result.error}\n\nThis receipt may or may not have reached your book. The app will check and tell you next time it connects, so do not enter it again yet.`,
      );
      return;
    }
    Alert.alert('Not saved', result.error);
  }



  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.h1}>Scan a receipt</Text>
        <ConnectionBanner />

        <Text style={styles.label}>Paid from</Text>
        <Pressable style={styles.selector} onPress={() => setPicker({ kind: 'account' })}>
          <Text
            style={account ? styles.selectorValue : styles.selectorPlaceholder}
            numberOfLines={2}
          >
            {account ? account.full_path : 'Choose an account'}
          </Text>
          {account?.commodity_mnemonic ? (
            <Text style={styles.selectorCcy}>{account.commodity_mnemonic}</Text>
          ) : null}
        </Pressable>

        {!account ? (
          <Text style={styles.note}>
            Pick this first. It sets the currency, and only expense accounts in that currency can be
            matched.
          </Text>
        ) : null}

        {account ? (
          <View style={styles.scanRow}>
            <Pressable style={styles.scanBtn} disabled={scanning} onPress={() => runScan('camera')}>
              <Icon name="scan" size={18} color={theme.ink} />
              <Text style={styles.scanBtnText}>Photograph</Text>
            </Pressable>
            <Pressable
              style={styles.scanBtn}
              disabled={scanning}
              onPress={() => runScan('library')}
            >
              <Icon name="receipt" size={18} color={theme.ink} />
              <Text style={styles.scanBtnText}>Choose photo</Text>
            </Pressable>
          </View>
        ) : null}

        {scanning ? (
          <View style={styles.scanning}>
            <ActivityIndicator color={theme.ink} />
            <Text style={styles.scanningText}>
              Reading the receipt. This is the one call that leaves your network, and it can take
              up to a minute.
            </Text>
          </View>
        ) : null}

        {scan && !scanning ? (
          <>
            <View style={styles.receiptHead}>
              <Text style={styles.merchant} numberOfLines={2}>
                {scan.merchant || 'Unknown merchant'}
              </Text>
              <View style={styles.dateWrap}>
                <DateField
                  value={effectiveDate}
                  onChange={setDateEdit}
                  caption={
                    dateEdit !== null
                      ? 'You set this date.'
                      : extractedDate?.fellBack
                        ? 'No readable date on the receipt — using today. Change it if that is wrong.'
                        : 'Read from the receipt. Check it before saving.'
                  }
                />
              </View>
            </View>

            {currencyMismatch ? (
              <Text style={styles.warn}>
                This receipt reads as {scan.currency}, but {account?.name} is in {currency}. One
                entry cannot span two currencies without a rate, so it cannot be saved against this
                account. Choose an account in {scan.currency}, or enter it in GnuCash desktop.
              </Text>
            ) : null}

            {scan.total_mismatch ? (
              <Text style={styles.warn}>
                The lines come to {formatAmount(scan.computed_total, currency ?? 'IDR', scu)}, but
                the receipt says {formatAmount(scan.printed_total, currency ?? 'IDR', scu)}. Check
                the amounts before saving.
              </Text>
            ) : null}

            {photoUri ? (
              <Pressable onPress={() => setPhotoBig((b) => !b)} style={styles.photoWrap}>
                <Image
                  source={{ uri: photoUri }}
                  style={[styles.photo, photoBig && styles.photoBig]}
                  resizeMode="cover"
                />
              </Pressable>
            ) : null}

            <View style={styles.sectionHead}>
              <Text style={styles.sectionLabel}>DETECTED LINES</Text>
              <Text style={styles.sectionCount}>
                {payable.length - unassigned} of {payable.length}
              </Text>
            </View>

            {lines.map((line) => {
              const lineAcct = line.accountGuid ? byGuid(line.accountGuid) : undefined;
              const zero = line.amount <= 0;
              // "Unsure" in the handoff's sense: nothing chosen yet, or a
              // proposal that came from the receipt text alone. The two
              // memory-backed bases are the ones the user has confirmed
              // before, so they do not get the copper treatment.
              const unsure = !zero && (!lineAcct || (line.proposed && line.basis === 'tokens'));
              const settled = !zero && !!lineAcct && !unsure;
              return (
                <View key={line.key}>
                  <Pressable
                    style={({ pressed }) => [styles.lineRow, pressed && styles.lineRowPressed]}
                    onPress={() => (zero ? undefined : setPicker({ kind: 'line', key: line.key }))}
                    disabled={zero}
                    accessibilityRole="button"
                    accessibilityLabel={
                      zero
                        ? `${line.name}, no amount, not written`
                        : `${line.name}, ${lineAcct ? lineAcct.full_path : 'no account'}. Tap to choose an account.`
                    }
                  >
                    {/* The handoff's 20px checkbox. Here it reports whether a
                        line is ready to write rather than whether it has been
                        ticked: this screen has no accept/reject step, because
                        the funding split is derived from the sum of the lines
                        and dropping one would post a total nobody agreed to. */}
                    <View style={[styles.box, settled && styles.boxOn, zero && styles.boxOff]}>
                      {settled ? <Text style={styles.boxCheck}>✓</Text> : null}
                    </View>

                    <View style={styles.lineMain}>
                      <Text style={styles.lineName} numberOfLines={2}>{line.name}</Text>
                      <Text
                        style={[styles.lineAcct, unsure && styles.lineAcctUnsure]}
                        numberOfLines={1}
                      >
                        {zero
                          ? 'no amount — not written'
                          : lineAcct
                            ? `→ ${lineAcct.full_path}`
                            : '→ choose an account'}
                      </Text>
                    </View>

                    <Text style={styles.lineAmount}>
                      {formatAmount(line.amount, currency ?? 'IDR', scu)}
                    </Text>
                  </Pressable>

                  {/* Kept verbatim from before the redesign. Which of these
                      three sentences is showing is the difference between a
                      guess and a confirmed choice, and it is the sentence that
                      catches a wrong account before it reaches the book. */}
                  {!zero && lineAcct && line.proposed ? (
                    <Text style={styles.proposed}>
                      {line.basis === 'item'
                        ? 'You chose this for this item here before.'
                        : line.basis === 'merchant'
                          ? 'You have always chosen this account at this merchant.'
                          : 'Suggested from the receipt text — check it before saving.'}
                    </Text>
                  ) : null}
                  {!zero && !lineAcct ? (
                    <Text style={styles.unmatched}>
                      No confident match. Pick one — this app cannot create accounts yet.
                    </Text>
                  ) : null}
                </View>
              );
            })}

            {scan.receipt_discount > 0 ? (
              <Text style={styles.note}>
                Discount of {formatAmount(scan.receipt_discount, currency ?? 'IDR', scu)} spread
                across the lines above, so each one shows what it actually cost. The total is
                after it.
              </Text>
            ) : null}

            {scan.receipt_tax > 0 ? (
              <Text style={styles.note}>
                Tax of {formatAmount(scan.receipt_tax, currency ?? 'IDR', scu)} added and spread
                across the lines above.
              </Text>
            ) : null}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalValue}>
                {formatAmount(total, currency ?? 'IDR', scu)}
              </Text>
            </View>

            {unassigned > 0 ? (
              <Text style={styles.note}>
                {unassigned} line{unassigned === 1 ? '' : 's'} still {unassigned === 1 ? 'needs' : 'need'} an
                account.
              </Text>
            ) : null}

            {!totalsAgree ? (
              <Text style={styles.warn}>
                These lines add up to {formatAmount(total, currency ?? 'IDR', scu)}, but only{' '}
                {formatAmount(payableTotal, currency ?? 'IDR', scu)} of it can be written. Refusing
                to record a total you have not seen — please enter this one in GnuCash desktop.
              </Text>
            ) : null}

            {!canWrite && blockedReason ? <Text style={styles.warn}>{blockedReason}</Text> : null}

            <Pressable
              style={[styles.save, (!ready || !canWrite) && styles.saveOff]}
              disabled={!ready || !canWrite}
              onPress={handleSave}
            >
              <Text style={styles.saveText}>{saving ? 'Saving…' : 'Save to GnuCash'}</Text>
            </Pressable>
          </>
        ) : null}

        <Pressable style={styles.cancel} onPress={() => router.back()}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </ScrollView>

      <AccountPicker
        visible={picker !== null}
        title={picker?.kind === 'account' ? 'Pay from' : 'Expense account'}
        types={picker?.kind === 'account' ? [...ASSET_TYPES, 'CREDIT', 'LIABILITY'] : EXPENSE_TYPES}
        commodityGuid={picker?.kind === 'line' ? account?.commodity_guid ?? undefined : undefined}
        selectedGuid={
          picker?.kind === 'line'
            ? lines.find((l) => l.key === picker.key)?.accountGuid ?? null
            : acctGuid
        }
        onSelect={(a: Account) => {
          if (picker?.kind === 'account') {
            // Changing the funding account changes the eligible commodity, so
            // proposals made against the old one are no longer trustworthy.
            if (a.guid !== acctGuid) {
              setScan(null);
              setLines([]);
            }
            setAcctGuid(a.guid);
          }
          if (picker?.kind === 'line') {
            const key = picker.key;
            setLines((prev) =>
              prev.map((l) =>
                (l.key === key ? { ...l, accountGuid: a.guid, proposed: false, basis: null } : l)),
            );
          }
          setPicker(null);
        }}
        onDismiss={() => setPicker(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { padding: 20, paddingBottom: 60 },
  h1: { color: theme.ink, fontSize: 20, fontFamily: fonts.sansMedium, marginBottom: 6 },
  label: {
    color: theme.ink, fontSize: 13, fontFamily: fonts.sansMedium, marginTop: 22, marginBottom: 8,
  },
  note: { color: theme.inkSoft, fontSize: 12, lineHeight: 17, marginTop: 8, fontFamily: fonts.sans },
  warn: { color: theme.coral, fontSize: 12, lineHeight: 18, marginTop: 12, fontFamily: fonts.sans },
  selector: {
    backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 14, paddingHorizontal: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  selectorValue: {
    color: theme.ink, fontSize: 14, flex: 1, marginRight: 10, fontFamily: fonts.sans,
  },
  selectorPlaceholder: {
    color: theme.inkFaint, fontSize: 14, flex: 1, marginRight: 10, fontFamily: fonts.sans,
  },
  selectorCcy: { color: theme.inkSoft, fontSize: 12, fontFamily: fonts.mono },
  scanRow: { flexDirection: 'row', marginTop: 16 },
  scanBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 14, marginHorizontal: 4, minHeight: 48,
  },
  scanBtnText: { color: theme.ink, fontSize: 14, fontFamily: fonts.sansMedium, marginLeft: 8 },
  scanning: { alignItems: 'center', marginTop: 24 },
  scanningText: {
    color: theme.inkSoft, fontSize: 12, lineHeight: 18,
    textAlign: 'center', marginTop: 12, fontFamily: fonts.sans,
  },
  receiptHead: { marginTop: 22 },
  merchant: { color: theme.ink, fontSize: 18, fontFamily: fonts.sansMedium },
  receiptMeta: { color: theme.inkFaint, fontSize: 12, marginTop: 6, fontFamily: fonts.sans },
  dateWrap: { marginTop: 8 },
  // The handoff's photo strip: 120 tall, radius 12, hairline border. Tapping
  // it grows the strip in place rather than opening a viewer -- the point is
  // to check a figure against the paper without losing the line you were on.
  photoWrap: { marginTop: 18 },
  photo: {
    width: '100%', height: 120, borderRadius: 12,
    borderWidth: 1, borderColor: theme.hairlineStrong, backgroundColor: theme.surfaceSoft,
  },
  photoBig: { height: 360 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    marginTop: 22, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  sectionLabel: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1.1, fontFamily: fonts.sansMedium,
  },
  sectionCount: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.mono },
  lineRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  lineRowPressed: { backgroundColor: theme.pressed },
  box: {
    width: 20, height: 20, borderRadius: 6,
    borderWidth: 1.5, borderColor: theme.ink,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  boxOn: { backgroundColor: theme.ink },
  boxOff: { borderColor: theme.disabled },
  boxCheck: { color: theme.bg, fontSize: 12, lineHeight: 14, fontFamily: fonts.sansSemi },
  lineMain: { flex: 1, marginRight: 10 },
  lineName: { color: theme.ink, fontSize: 14, fontFamily: fonts.sans },
  lineAcct: { color: theme.inkFaint, fontSize: 12, marginTop: 2, fontFamily: fonts.sans },
  lineAcctUnsure: { color: theme.coral },
  lineAmount: {
    color: theme.ink, fontSize: 14, fontFamily: fonts.mono, fontVariant: ['tabular-nums'],
  },
  proposed: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16,
    marginTop: 4, marginBottom: 6, marginLeft: 32, fontFamily: fonts.sans,
  },
  unmatched: {
    color: theme.coral, fontSize: 11, lineHeight: 16,
    marginTop: 4, marginBottom: 6, marginLeft: 32, fontFamily: fonts.sans,
  },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end',
    marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.hairlineStrong,
  },
  totalLabel: { color: theme.inkFaint, fontSize: 12, fontFamily: fonts.sans },
  totalValue: {
    color: theme.ink, fontSize: 22, fontFamily: fonts.monoMedium, fontVariant: ['tabular-nums'],
  },
  save: {
    backgroundColor: theme.ink, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center', marginTop: 22,
  },
  saveOff: { opacity: 0.35 },
  saveText: { color: theme.bg, fontSize: 14, fontFamily: fonts.sansMedium },
  cancel: { alignItems: 'center', paddingVertical: 16, marginTop: 6 },
  cancelText: { color: theme.inkFaint, fontSize: 13, fontFamily: fonts.sansMedium },
});
