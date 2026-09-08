// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// One entry: spend, income, and the shapes the old Spend screen could not
// express. Board Turn 5 of the 2026-09-08 handoff.
//
// ---------------------------------------------------------------------------
// Why this replaces Spend and Income
// ---------------------------------------------------------------------------
// A GnuCash transaction is a set of splits that sum to zero. "Spend" and
// "transfer" were this app's inventions, and reading the production book
// showed how much they could not say: 110 entries carry a discount that runs
// against the entry, 221 carry a refund or a waived fee, and 74 are paid from
// more than one account. None of those could be written before.
//
// So the screen is three lists of splits -- items, money back, paid by -- and
// the account types say what the entry means. `mgc_record_entry` records it.
//
// ---------------------------------------------------------------------------
// Nobody types a sign
// ---------------------------------------------------------------------------
// Every amount on screen is positive. The sign is decided by WHICH SECTION a
// row is in, combined with the direction, and nothing else:
//
//              outflow   inflow
//   items         +        -
//   money back    -        +
//   paid by       -        +
//
// which is one variable (`sgn` below) rather than a rule per section. There is
// deliberately no per-row direction toggle: the add-link that created a row
// fixes what it is, so a row cannot quietly become its own opposite.
//
// ---------------------------------------------------------------------------
// The collapsed default
// ---------------------------------------------------------------------------
// A coffee is one funding chip and one item row. The money-back and paid-by
// sections do not exist until their link is used, and the subtotal block does
// not appear until there is something to subtotal. The three links are always
// present so the complex entry is never hidden, but it costs nothing to
// ignore.
//
// With a single funder the amount is NOT sent: `mgc_record_entry` derives that
// split from the negation of the already-rounded others, so the ordinary entry
// balances by construction rather than by the client doing arithmetic that
// could disagree. The same trick covers a split payment where the last funder
// is left empty -- it absorbs the remainder.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import AmountInput from '../../src/components/AmountInput';
import { AccountSheet } from '../../src/components/AccountSheet';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { DateField } from '../../src/components/DateField';
import { Icon } from '../../src/components/Icon';
import {
  useAccounts, ASSET_TYPES, EXPENSE_TYPES, INCOME_TYPES,
} from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import {
  recordEntry, markInFlight, clearInFlight, type Account, type EntrySplit,
} from '../../src/services/api';
import { getLastFunder, setLastFunder } from '../../src/services/lastFunder';
import { generateTransactionId } from '../../src/utils/idempotency';
import { parseCurrencyInput, formatAmount } from '../../src/utils/currency';
import { todayIso } from '../../src/utils/receiptDate';
import { theme, fonts } from '../../src/constants/theme';

type Section = 'items' | 'moneyBack' | 'funders';
type Row = { key: string; accountGuid: string | null; memo: string; raw: string };

let seq = 0;
const newRow = (accountGuid: string | null = null): Row =>
  ({ key: `r${++seq}`, accountGuid, memo: '', raw: '' });

// Funders may name a security so the picker can show it dimmed rather than
// pretend the account does not exist. AccountSheet blocks it on namespace.
const FUNDER_TYPES = [...ASSET_TYPES, 'CREDIT', 'LIABILITY', 'STOCK', 'MUTUAL'];

export default function Entry() {
  const byGuid = useAccounts((s) => s.byGuid);
  const loadAccounts = useAccounts((s) => s.load);
  const canWrite = useConnection((s) => s.canWrite());
  const blockedReason = useConnection((s) => s.writeBlockedReason());
  const noteFailure = useConnection((s) => s.noteFailure);

  const [direction, setDirection] = useState<'outflow' | 'inflow'>('outflow');
  const [postDate, setPostDate] = useState<string>(todayIso());
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<Row[]>([newRow()]);
  const [moneyBack, setMoneyBack] = useState<Row[]>([]);
  const [funders, setFunders] = useState<Row[]>([newRow()]);
  const [picker, setPicker] = useState<{ section: Section; key: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    loadAccounts();
    getLastFunder().then((guid) => {
      if (guid) setFunders((f) => (f[0]?.accountGuid ? f : [{ ...f[0], accountGuid: guid }]));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(useCallback(() => { loadAccounts(); }, [loadAccounts]));

  // Anything the user has actually put in. The funder is pre-filled from the
  // last entry, so having one is NOT dirt -- only a funder they changed or
  // added counts.
  const dirty =
    items.some((r) => r.accountGuid || r.raw.trim() || r.memo.trim()) ||
    moneyBack.length > 0 ||
    funders.length > 1 ||
    funders.some((r) => r.raw.trim()) ||
    description.trim().length > 0;

  function reset() {
    setItems([newRow()]);
    setMoneyBack([]);
    setFunders([newRow(funders[0]?.accountGuid ?? null)]);
    setDescription('');
  }

  // Android back, in three layers.
  //
  // The account sheet is NOT a native <Modal> -- OverlayModal is an absolutely
  // positioned View, for reasons its own header explains at length. The cost is
  // that Android does not dismiss it for free: back sailed straight past an
  // open picker and closed the whole app. That is how a GoCar entry was lost.
  //
  // So: an open sheet closes first, then a half-typed entry asks before it is
  // thrown away, and only an empty screen lets Android do its normal thing and
  // leave. Returning false is what makes the last case behave like a tab root
  // should, rather than trapping the user in the app.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (picker) { setPicker(null); return true; }
        if (dirty) {
          Alert.alert(
            'Discard this entry?',
            'Nothing has been written to your book yet.',
            [
              { text: 'Keep editing', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: reset },
            ],
          );
          return true;
        }
        return false;
      });
      return () => sub.remove();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [picker, dirty, items, moneyBack, funders, description]),
  );

  const inflow = direction === 'inflow';
  // The one variable the whole sign scheme rests on. See the header.
  const sgn = inflow ? -1 : 1;
  // "Against the direction" is verdigris in an outflow (money coming back) and
  // copper in an inflow (a fee taken out of what arrived). Never ink.
  const against = inflow ? theme.coral : theme.moss;

  const list = (s: Section) => (s === 'items' ? items : s === 'moneyBack' ? moneyBack : funders);
  const setList = (s: Section, v: Row[]) =>
    (s === 'items' ? setItems : s === 'moneyBack' ? setMoneyBack : setFunders)(v);

  function patch(section: Section, key: string, p: Partial<Row>) {
    setList(section, list(section).map((r) => (r.key === key ? { ...r, ...p } : r)));
  }
  function drop(section: Section, key: string) {
    setList(section, list(section).filter((r) => r.key !== key));
  }

  const amt = (r: Row) => parseCurrencyInput(r.raw);
  const sum = (rows: Row[]) => rows.reduce((t, r) => t + amt(r), 0);

  const itemsTotal = useMemo(() => sum(items), [items]);
  const backTotal = useMemo(() => sum(moneyBack), [moneyBack]);
  const required = itemsTotal - backTotal;

  // The entry's currency comes from the first account chosen anywhere, and
  // every later pick is constrained to it by the sheet.
  const chosen = [...items, ...moneyBack, ...funders]
    .map((r) => (r.accountGuid ? byGuid(r.accountGuid) : undefined))
    .filter((a): a is Account => !!a);
  const commodityGuid = chosen[0]?.commodity_guid ?? null;

  // The currency the OPEN picker constrains to, which is deliberately not
  // `commodityGuid`.
  //
  // A row must not constrain its own replacement. Picking Gold (an XAU asset)
  // pinned the entry to XAU, and reopening that same picker then greyed out
  // every IDR account as "other currency" -- including the one you were trying
  // to correct it to. There was no way back out of a wrong first pick.
  //
  // So the constraint comes from the OTHER rows only. With nothing else chosen
  // there is no constraint at all, and changing your mind always works.
  const pickerCommodityGuid = useMemo(() => {
    if (!picker) return null;
    const other = [...items, ...moneyBack, ...funders]
      .filter((r) => r.key !== picker.key)
      .map((r) => (r.accountGuid ? byGuid(r.accountGuid) : undefined))
      .find((a): a is Account => !!a);
    return other?.commodity_guid ?? null;
  }, [picker, items, moneyBack, funders, byGuid]);
  const currency = chosen[0]?.commodity_mnemonic ?? 'IDR';
  // Scope guard. The sheet already prevents these, so this is the backstop for
  // an account that changed under a cached list.
  const scopeProblem =
    chosen.find((a) => a.commodity_namespace !== 'CURRENCY')
      ? `${chosen.find((a) => a.commodity_namespace !== 'CURRENCY')!.name} is not a currency account. Stocks, bonds and crypto belong in GnuCash desktop.`
      : chosen.find((a) => a.commodity_guid !== commodityGuid)
        ? 'Every account in one entry has to be in the same currency. Enter this in GnuCash desktop, where you can set the rate.'
        : null;

  // Exactly one row anywhere may be left without an amount; the server derives
  // it. With one funder that is the normal case and no arithmetic happens on
  // this device at all.
  const blankFunders = funders.filter((r) => !r.raw.trim());
  const fundersTotal = sum(funders);
  const balanced =
    blankFunders.length === 1
      ? required > 0
      : blankFunders.length === 0 && Math.abs(fundersTotal - required) < 0.0001 && required > 0;

  const itemsReady = items.length > 0 && items.every((r) => r.accountGuid && amt(r) > 0);
  const backReady = moneyBack.every((r) => r.accountGuid && amt(r) > 0);
  const fundersReady =
    funders.length > 0 && funders.every((r) => r.accountGuid) &&
    funders.every((r) => !r.raw.trim() || amt(r) > 0);
  const ready =
    itemsReady && backReady && fundersReady && balanced && !scopeProblem && canWrite && !saving;

  const funderNames = funders.map((r) => (r.accountGuid ? byGuid(r.accountGuid)?.name : null));
  const funderLabel =
    funders.length > 1 ? `${funders.length} accounts` : funderNames[0] ?? '…';

  // What the commit button says while it is disabled.
  //
  // A dead button with no reason is not this project's style -- `TODO.md` says
  // so about the receipt screen, where Save greyed out with nothing on screen
  // explaining it. So the button names the one thing still missing instead of
  // repeating an action it will not perform. Order matters: it reports what
  // you would fix FIRST, top of the screen down.
  const missing: string | null =
    items.some((r) => !r.accountGuid) ? 'Choose an account'
      : items.some((r) => amt(r) <= 0) ? 'Enter an amount'
      : moneyBack.some((r) => !r.accountGuid) ? 'Choose the money back account'
      : moneyBack.some((r) => amt(r) <= 0) ? 'Enter the money back amount'
      : funders.some((r) => !r.accountGuid) ? (inflow ? 'Choose where it arrived' : 'Choose who paid')
      : scopeProblem ? 'Cannot be saved from here'
      : !canWrite ? 'Cannot save right now'
      : !balanced ? 'Not balanced yet'
      : null;

  const commitText = saved
    ? 'Saved ✓'
    : saving
      ? 'Saving…'
      : missing
        ?? (inflow ? `Record income to ${funderLabel}` : `Spend from ${funderLabel}`);

  async function commit() {
    if (!ready) return;
    setSaving(true);

    const splits: EntrySplit[] = [];
    for (const r of items) {
      splits.push({ account_guid: r.accountGuid!, amount: sgn * amt(r), memo: r.memo.trim() });
    }
    for (const r of moneyBack) {
      splits.push({ account_guid: r.accountGuid!, amount: -sgn * amt(r), memo: r.memo.trim() });
    }
    for (const r of funders) {
      // A funder with no amount is sent WITHOUT one, so the server derives it.
      if (r.raw.trim()) {
        splits.push({ account_guid: r.accountGuid!, amount: -sgn * amt(r), memo: r.memo.trim() });
      } else {
        splits.push({ account_guid: r.accountGuid!, memo: r.memo.trim() });
      }
    }

    const requestId = generateTransactionId();
    const label = description.trim() || (inflow ? 'Income' : 'Expense');
    await markInFlight(requestId, label);

    const result = await recordEntry({
      requestId, splits, postDate, description: description.trim(),
    });

    // Clear only on a KNOWN outcome. Offline is not known: the write may have
    // committed with the response lost, which is what the marker is for.
    if (result.ok || result.kind === 'rejected' || result.kind === 'unauthorized') {
      await clearInFlight();
    }
    setSaving(false);

    if (result.ok) {
      if (funders[0]?.accountGuid) void setLastFunder(funders[0].accountGuid);
      if (result.data.status === 'already_recorded') {
        Alert.alert('Already recorded', 'This entry had already been written to your book.');
        return;
      }
      setSaved(true);
      setItems([newRow()]);
      setMoneyBack([]);
      setFunders([newRow(funders[0]?.accountGuid ?? null)]);
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

  const showSubtotal = moneyBack.length > 0 || funders.length > 1;

  function rowsFor(section: Section, colour?: string) {
    return list(section).map((r) => {
      const a = r.accountGuid ? byGuid(r.accountGuid) : undefined;
      const removable = section === 'items' ? list(section).length > 1 : true;
      return (
        <View key={r.key} style={styles.row}>
          <Pressable style={styles.rowMain} onPress={() => setPicker({ section, key: r.key })}>
            <Text style={[styles.rowName, colour ? { color: colour } : null]} numberOfLines={1}>
              {colour ? '↩ ' : ''}{a ? a.name : 'Choose an account'}
            </Text>
            {a ? (
              <Text style={styles.rowPath} numberOfLines={1}>{a.full_path}</Text>
            ) : null}
          </Pressable>
          <View style={styles.amountWrap}>
            {colour ? <Text style={[styles.minus, { color: colour }]}>−</Text> : null}
            <AmountInput
              value={r.raw}
              onChangeText={(raw) => patch(section, r.key, { raw })}
              currency={currency}
              style={[styles.amount, colour ? { color: colour } : null]}
              placeholder={section === 'funders' ? 'rest' : '0'}
              placeholderTextColor={theme.inkFaint}
            />
          </View>
          {removable ? (
            <Pressable
              hitSlop={10}
              onPress={() => drop(section, r.key)}
              accessibilityRole="button"
              accessibilityLabel="Remove this row"
            >
              <Text style={styles.remove}>×</Text>
            </Pressable>
          ) : null}
        </View>
      );
    });
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <ConnectionBanner />

        <View style={styles.header}>
          <Text style={styles.h1}>Entry</Text>
          <View style={styles.segmented}>
            {(['outflow', 'inflow'] as const).map((d) => {
              const on = direction === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => setDirection(d)}
                  style={[
                    styles.seg,
                    on && { backgroundColor: d === 'inflow' ? theme.moss : theme.ink },
                  ]}
                >
                  <Text style={[styles.segText, on && styles.segTextOn]}>
                    {d === 'outflow' ? 'Out' : 'In'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.chips}>
          <DateField value={postDate} onChange={setPostDate} variant="chip" />
          <Pressable
            style={styles.chip}
            onPress={() => setPicker({ section: 'funders', key: funders[0].key })}
          >
            <Text style={styles.chipText} numberOfLines={1}>
              {inflow ? 'Received in' : 'Paid from'} {funderLabel} ▾
            </Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.desc}
          placeholder="What is this for"
          placeholderTextColor={theme.inkFaint}
          value={description}
          onChangeText={setDescription}
        />

        <View style={styles.sectionHead}>
          <Text style={styles.sectionLabel}>ITEMS · {inflow ? 'INCOME' : 'EXPENSE'}</Text>
          <Pressable
            style={[styles.scanPill, inflow && styles.scanPillOff]}
            disabled={inflow}
            onPress={() => Alert.alert(
              'Scan',
              'Scanning fills the items from a receipt. It is not wired into this screen yet — use the Scan action on Accounts for now.',
            )}
          >
            <Icon name="scan" size={13} color={inflow ? theme.disabled : theme.ink} />
            <Text style={[styles.scanText, inflow && { color: theme.disabled }]}>Scan</Text>
          </Pressable>
        </View>
        {rowsFor('items')}

        <View style={styles.links}>
          <Pressable onPress={() => setItems([...items, newRow()])}>
            <Text style={styles.link}>+ Add item</Text>
          </Pressable>
          <Pressable onPress={() => setMoneyBack([...moneyBack, newRow()])}>
            <Text style={[styles.link, { color: against }]}>↩ Money back</Text>
          </Pressable>
          <Pressable onPress={() => setFunders([...funders, newRow()])}>
            <Text style={styles.link}>Split payment</Text>
          </Pressable>
        </View>

        {moneyBack.length > 0 ? (
          <>
            <Text style={[styles.sectionLabel, styles.sectionSolo, { color: against }]}>
              ↩ MONEY BACK
            </Text>
            {rowsFor('moneyBack', against)}
          </>
        ) : null}

        {funders.length > 1 ? (
          <>
            <Text style={[styles.sectionLabel, styles.sectionSolo]}>PAID BY</Text>
            {rowsFor('funders')}
            <Text style={styles.hint}>
              Leave the last one empty and it takes whatever is left.
            </Text>
          </>
        ) : null}

        {showSubtotal ? (
          <View style={styles.subtotal}>
            <SubRow label="Items" value={formatAmount(itemsTotal, currency)} />
            {moneyBack.length > 0 ? (
              <SubRow label="Money back" value={`− ${formatAmount(backTotal, currency)}`} colour={against} />
            ) : null}
            <SubRow label={inflow ? 'To receive' : 'To pay'} value={formatAmount(required, currency)} strong />
          </View>
        ) : null}

        {scopeProblem ? <Text style={styles.warn}>{scopeProblem}</Text> : null}
        {!canWrite && blockedReason ? <Text style={styles.warn}>{blockedReason}</Text> : null}
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.footerTotal}>
          <Text style={styles.footerSub} numberOfLines={1}>
            {moneyBack.length > 0
              ? `${formatAmount(itemsTotal, currency)} − ${formatAmount(backTotal, currency)} back`
              : funders.length > 1
                ? (balanced ? 'Balanced' : 'Not balanced yet')
                : inflow ? 'Total in' : 'Total out'}
          </Text>
          <Text style={[styles.footerAmount, inflow && { color: theme.moss }]} numberOfLines={1}>
            {formatAmount(required, currency)}
          </Text>
        </View>
        <Pressable
          style={[
            styles.commit,
            inflow && { backgroundColor: theme.moss },
            !ready && styles.commitOff,
          ]}
          disabled={!ready}
          onPress={commit}
        >
          <Text style={styles.commitText} numberOfLines={1}>{commitText}</Text>
        </Pressable>
      </View>

      <AccountSheet
        visible={picker !== null}
        title={
          picker?.section === 'items'
            ? (inflow ? 'Income account' : 'Expense account')
            : picker?.section === 'moneyBack'
              ? 'Money back to'
              : inflow ? 'Received in' : 'Paid from'
        }
        types={
          picker?.section === 'items'
            ? (inflow ? INCOME_TYPES : EXPENSE_TYPES)
            : picker?.section === 'moneyBack'
              ? [...INCOME_TYPES, ...EXPENSE_TYPES]
              : FUNDER_TYPES
        }
        commodityGuid={pickerCommodityGuid}
        selectedGuid={
          picker ? list(picker.section).find((r) => r.key === picker.key)?.accountGuid ?? null : null
        }
        onSelect={(a) => {
          if (picker) patch(picker.section, picker.key, { accountGuid: a.guid });
          setPicker(null);
        }}
        onDismiss={() => setPicker(null)}
      />
    </SafeAreaView>
  );
}

function SubRow({
  label, value, colour, strong,
}: { label: string; value: string; colour?: string; strong?: boolean }) {
  return (
    <View style={styles.subRow}>
      <Text style={[styles.subLabel, colour ? { color: colour } : null]}>{label}</Text>
      <Text
        style={[
          styles.subValue,
          colour ? { color: colour } : null,
          strong ? styles.subValueStrong : null,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 12,
  },
  h1: { color: theme.ink, fontSize: 18, fontFamily: fonts.sansMedium },
  segmented: {
    flexDirection: 'row', backgroundColor: theme.surfaceSoft, borderRadius: 8, padding: 2,
  },
  seg: { paddingVertical: 5, paddingHorizontal: 14, borderRadius: 6 },
  segText: { color: theme.inkSoft, fontSize: 12, fontFamily: fonts.sansMedium },
  segTextOn: { color: theme.bg },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  chip: {
    backgroundColor: theme.surface, borderRadius: 8,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    paddingVertical: 9, paddingHorizontal: 12, flexShrink: 1,
  },
  chipText: { color: theme.ink, fontSize: 13, fontFamily: fonts.sans },
  desc: {
    backgroundColor: theme.surface, borderRadius: 10,
    borderWidth: 1, borderColor: theme.hairlineStrong,
    color: theme.ink, fontSize: 14, fontFamily: fonts.sans,
    paddingVertical: 10, paddingHorizontal: 12, marginTop: 10, minHeight: 42,
  },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 18, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  sectionSolo: {
    marginTop: 18, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  sectionLabel: {
    color: theme.inkFaint, fontSize: 10, letterSpacing: 1, fontFamily: fonts.sansMedium,
  },
  scanPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: theme.ink, borderRadius: 99,
    paddingVertical: 3, paddingHorizontal: 10,
  },
  scanPillOff: { borderColor: theme.disabled },
  scanText: { color: theme.ink, fontSize: 11, fontFamily: fonts.sansMedium },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowMain: { flex: 1, marginRight: 8 },
  rowName: { color: theme.ink, fontSize: 12, fontFamily: fonts.sansMedium },
  rowPath: { color: theme.inkFaint, fontSize: 11, marginTop: 2, fontFamily: fonts.sans },
  amountWrap: { flexDirection: 'row', alignItems: 'center' },
  minus: { fontSize: 13, fontFamily: fonts.mono, marginRight: 1 },
  amount: {
    color: theme.ink, fontSize: 13, fontFamily: fonts.mono,
    textAlign: 'right', minWidth: 96, paddingVertical: 4,
  },
  remove: { color: theme.inkFaint, fontSize: 17, paddingLeft: 10, lineHeight: 20 },
  links: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12,
  },
  link: { color: theme.ink, fontSize: 11, fontFamily: fonts.sansMedium },
  hint: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 8, fontFamily: fonts.sans },
  subtotal: {
    marginTop: 18, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: theme.hairlineStrong,
  },
  subRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  subLabel: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.sans },
  subValue: { color: theme.inkSoft, fontSize: 11, fontFamily: fonts.mono },
  subValueStrong: { color: theme.ink, fontFamily: fonts.monoMedium },
  warn: { color: theme.coral, fontSize: 12, lineHeight: 17, marginTop: 14, fontFamily: fonts.sans },
  footer: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12,
    borderTopWidth: 1, borderTopColor: theme.hairlineStrong, backgroundColor: theme.bg,
  },
  footerTotal: { flex: 1, marginRight: 12 },
  footerSub: { color: theme.inkFaint, fontSize: 11, fontFamily: fonts.sans },
  footerAmount: {
    color: theme.ink, fontSize: 17, fontFamily: fonts.monoMedium, marginTop: 1,
  },
  commit: {
    backgroundColor: theme.ink, borderRadius: 10,
    paddingVertical: 11, paddingHorizontal: 16, flexShrink: 1,
  },
  commitOff: { opacity: 0.35 },
  commitText: { color: theme.bg, fontSize: 13, fontFamily: fonts.sansMedium },
});
