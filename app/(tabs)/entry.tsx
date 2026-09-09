// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// One entry: money out, money in, and money moved between your own accounts.
// Board Turn 5 of the 2026-09-08 handoff, plus the Transfer merge.
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
// A move needs no fourth column. Money leaves the FROM account and arrives at
// the TO account, which is the outflow column exactly -- so `sgn` is unchanged
// and only the labels and the pickers differ.
//
// ---------------------------------------------------------------------------
// Why Transfer is a segment and not a screen
// ---------------------------------------------------------------------------
// It was its own tab until 2026-09-08. A transfer is not a different KIND of
// thing, though: it is an entry whose other side happens to be an account of
// your own. The separate screen made you commit before typing anything, could
// not be corrected without starting over, and had no room for a transfer fee
// -- a fee being an ordinary expense split, which the two-account form could
// not hold. Here it is one more line under TO.
//
// ===========================================================================
// THE RATE IS SHOWN, NEVER TYPED.  (inherited from the deleted transfer.tsx)
// ===========================================================================
// It is tempting to add a rate field. Do not.
//
// A cross-currency move has three numbers -- amount out, amount in, rate --
// of which only two are independent. Every UI that asks for all three lets
// them disagree, rounding guarantees they eventually will, and the remainder
// becomes an Imbalance split. That is the exact problem this replaces.
//
// So: two inputs, and a read-only readout of what the server will derive. The
// number displayed AFTER saving is the server's own `derived_rate`, not a
// client-side recomputation of what was typed.
//
// Two currencies are also the one case that does not go through
// `mgc_record_entry`, which is single-currency by construction. That shape --
// one account to one account, nothing else in the entry -- routes to
// `mgc_transfer` instead, and anything richer is refused with a reason rather
// than having a rate invented for it.
// ===========================================================================
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, Alert, BackHandler,
  ActivityIndicator, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import AmountInput from '../../src/components/AmountInput';
import { TextField } from '../../src/components/TextField';
import { AccountSheet } from '../../src/components/AccountSheet';
import { Chip } from '../../src/components/Chip';
import { SectionLabel } from '../../src/components/SectionLabel';
import { ConnectionBanner } from '../../src/components/ConnectionBanner';
import { DateField } from '../../src/components/DateField';
import { Icon } from '../../src/components/Icon';
import {
  useAccounts, ASSET_TYPES, EXPENSE_TYPES, INCOME_TYPES,
} from '../../src/store/accountStore';
import { useConnection } from '../../src/store/connectionStore';
import {
  recordEntry, transfer as transferRpc, getRegister, type RegisterRow,
  markInFlight, clearInFlight, type Account, type EntrySplit,
} from '../../src/services/api';
import { getLastFunder, setLastFunder } from '../../src/services/lastFunder';
import { scanReceipt, type MatchBasis } from '../../src/services/scanReceipt';
import { generateTransactionId } from '../../src/utils/idempotency';
import { CURRENCIES, parseCurrencyInput, formatAmount } from '../../src/utils/currency';
import { todayIso, dateConcern, isFutureDate } from '../../src/utils/receiptDate';
import { useEntryDraft } from '../../src/store/entryDraftStore';
import { theme, fonts } from '../../src/constants/theme';

type Section = 'items' | 'moneyBack' | 'funders';
type Row = {
  key: string;
  accountGuid: string | null;
  memo: string;
  raw: string;
  /** True while the account is the scanner's guess, not a user's choice. */
  proposed?: boolean;
  /** How the scanner arrived at it, so the row can say how much to trust it. */
  basis?: MatchBasis | null;
};

let seq = 0;
const newRow = (accountGuid: string | null = null): Row =>
  ({ key: `r${++seq}`, accountGuid, memo: '', raw: '' });

// Funders may name a security so the picker can show it dimmed rather than
// pretend the account does not exist. AccountSheet blocks it on namespace.
const FUNDER_TYPES = [...ASSET_TYPES, 'CREDIT', 'LIABILITY', 'STOCK', 'MUTUAL'];
/** What `mgc_transfer` will move between, and therefore all that can cross a
 *  currency boundary from this screen. */
const TRANSFERABLE = ASSET_TYPES;

export default function Entry() {
  const byGuid = useAccounts((s) => s.byGuid);
  const loadAccounts = useAccounts((s) => s.load);
  const postable = useAccounts((s) => s.postable);
  const hasTradingAccount = useAccounts((s) => s.hasTradingAccount);
  const accountsEpoch = useAccounts((s) => s.epoch);
  const usesTrading = useConnection((s) => s.tradingAccounts);
  const accountCount = useAccounts((s) => s.accounts.length);
  const canWrite = useConnection((s) => s.canWrite());
  const blockedReason = useConnection((s) => s.writeBlockedReason());
  const noteFailure = useConnection((s) => s.noteFailure);

  const [direction, setDirection] = useState<'outflow' | 'inflow' | 'transfer'>('outflow');
  const [postDate, setPostDate] = useState<string>(todayIso());
  const [description, setDescription] = useState('');
  const [items, setItems] = useState<Row[]>([newRow()]);
  const [moneyBack, setMoneyBack] = useState<Row[]>([]);
  const [funders, setFunders] = useState<Row[]>([newRow()]);
  const [picker, setPicker] = useState<{ section: Section; key: string } | null>(null);
  const [saving, setSaving] = useState(false);
  /** Looking for a duplicate. Not saving yet, and must not say it is. */
  const [checkingDup, setCheckingDup] = useState(false);
  const [saved, setSaved] = useState(false);
  const [scanning, setScanning] = useState(false);
  const seqRef = useRef(0);
  // How much of the screen the keyboard is covering.
  //
  // This activity is edge-to-edge, so Android does NOT resize the window when
  // the keyboard opens -- the sticky footer was simply buried under it, which
  // meant typing an amount hid both the running total and the commit button.
  // Committing a figure you cannot see is not acceptable in a ledger.
  //
  // Deliberately NOT KeyboardAvoidingView: five configurations of it were
  // tried and found broken on this project's predecessor (see OverlayModal's
  // header). A measured height and a margin is boring and debuggable.
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) => setKeyboard(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboard(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  // What the receipt said it came to, kept only to warn when the lines and the
  // printed total disagree. It is not written anywhere.
  const [printedTotal, setPrintedTotal] = useState<number | null>(null);

  useEffect(() => { loadAccounts(); }, [loadAccounts]);

  // Restore the remembered funder only once the accounts are actually loaded,
  // and only if it is still one the picker would offer.
  //
  // It is stored as a bare guid and was being resolved with byGuid(), which
  // reads EVERY account rather than the postable ones. So an account hidden in
  // GnuCash desktop vanished from the picker but stayed pre-filled in the
  // chip -- and would have been written to, by an entry whose funder the
  // picker refused to offer. Hiding an account has to mean hidden everywhere.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || accountCount === 0) return;
    restored.current = true;
    getLastFunder().then((guid) => {
      if (!guid) return;
      if (!postable(FUNDER_TYPES).some((a) => a.guid === guid)) return;
      setFunders((f) => (f[0]?.accountGuid ? f : [{ ...f[0], accountGuid: guid }]));
    });
  }, [accountCount, postable]);

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

  // Out/In/Move already asks before clearing a half-built entry
  // (`chooseDirection`, below). Accounts and Settings could not, because nothing
  // outside this screen knew there was anything to lose -- so mirror `dirty`
  // into the shared store those tabs read before letting a tap leave here.
  const setDraftDirty = useEntryDraft((s) => s.setDirty);
  useEffect(() => { setDraftDirty(dirty); }, [dirty, setDraftDirty]);

  // Everything a finished entry leaves behind. The date and the receipt's
  // printed total are in here for a reason: a scanned receipt sets BOTH, and
  // after saving one dated 2024 the next entry silently inherited that date,
  // with a stale "but the receipt says..." warning still on screen. A
  // backdated entry written by accident is exactly what the date guard exists
  // to prevent, so the reset has to be one thing that cannot be half-applied.
  /**
   * Empty the form.
   *
   * The funding account is normally KEPT: you pay for most things from the
   * same place, and re-picking it after every entry was the single most
   * repeated tap in the app. It is dropped only when the book itself has
   * changed, because then the guid belongs to a different ledger.
   */
  function reset(keepFunder = true) {
    setItems([newRow()]);
    setMoneyBack([]);
    setFunders([newRow(keepFunder ? funders[0]?.accountGuid ?? null : null)]);
    setDescription('');
    setPrintedTotal(null);
    setPostDate(todayIso());
  }

  // The other half of the tab guard above: once Accounts or Settings has
  // asked and the user chose to discard, clear this screen in response.
  const clearRequest = useEntryDraft((s) => s.clearRequest);
  const clearRequestSeen = useRef(clearRequest);
  useEffect(() => {
    if (clearRequest === clearRequestSeen.current) return;
    clearRequestSeen.current = clearRequest;
    reset();
  }, [clearRequest]);

  // A half-built entry must not survive a change of ledger.
  //
  // Switching ledgers reloads the chart of accounts but left this screen
  // holding rows composed against the OLD book. Because the dev clone shares
  // its guids with production, those rows resolved perfectly against the wrong
  // ledger: a cross-currency move typed against dev sat on screen, fully
  // valid, with a live commit button, after the app had been switched back to
  // production. It would have written it there.
  //
  // Against a genuinely different book the guids would simply fail to resolve
  // and the rows would blank themselves, which is the same bug wearing a
  // costume that happens to be harmless.
  const lastEpoch = useRef(accountsEpoch);
  useEffect(() => {
    if (lastEpoch.current === accountsEpoch) return;
    lastEpoch.current = accountsEpoch;
    reset(false);
    setDirection('outflow');
    setPicker(null);
  }, [accountsEpoch]);

  /**
   * Change direction, clearing what no longer means anything.
   *
   * The three directions share one set of rows, and the SECTIONS mean
   * different things in each: an expense account sitting under "ITEMS ·
   * INCOME" is not a mistake the user made, it is one the screen made by
   * keeping it. Switching therefore starts the entry again -- but asks first
   * when there is something to lose, because the usual reason to switch is
   * having tapped the wrong segment before typing anything, and that case
   * should cost nothing.
   */
  function chooseDirection(d: 'outflow' | 'inflow' | 'transfer') {
    if (d === direction) return;
    if (!dirty) { setDirection(d); return; }
    const name = d === 'outflow' ? 'Money out' : d === 'inflow' ? 'Money in' : 'Move money';
    Alert.alert(
      `Start again as ${name}?`,
      'The accounts on this entry only make sense one way round, so switching clears them. The account you are paying from is kept.',
      [
        { text: 'Keep editing', style: 'cancel' },
        {
          text: 'Switch and clear',
          style: 'destructive',
          onPress: () => { reset(); setDirection(d); },
        },
      ],
    );
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
              { text: 'Discard', style: 'destructive', onPress: () => reset() },
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
  // A transfer is not a different kind of thing, it is an entry whose other
  // side happens to be an account of your own. Same three lists, same signs as
  // an outflow -- the destination is debited, the source credited -- so the
  // only differences are which accounts the pickers offer and what the
  // sections are called.
  const transferMode = direction === 'transfer';
  // The one variable the whole sign scheme rests on. See the header.
  const sgn = inflow ? -1 : 1;
  // "Against the direction" is verdigris in an outflow (money coming back) and
  // copper in an inflow (a fee taken out of what arrived). Never ink.
  const against = inflow ? theme.coral : theme.moss;

  // The direction's OWN colour, applied to the four places that carry the
  // whole screen's identity: the segment, the headline, the running total and
  // the commit button.
  //
  // Money in is the settled green, and it is the easy one -- money arriving is
  // never unwelcome. Money out is copper, so that spending does not read as
  // the neutral default; the palette's one warm colour already means "look at
  // this", and a payment is a thing worth looking at.
  //
  // A move stays INK on purpose, and that is the point of having three: your
  // own money changing pockets is neither good nor bad and your net worth does
  // not shift, so it gets the ground colour rather than a verdict. It also
  // keeps copper meaning something -- if all three were coloured, none of the
  // colours would say anything.
  const tone = transferMode ? theme.ink : inflow ? theme.moss : theme.coral;

  // What the three sections are called, and what each may hold.
  const itemsLabel = transferMode ? 'TO' : `ITEMS · ${inflow ? 'INCOME' : 'EXPENSE'}`;
  const fundersLabel = transferMode ? 'FROM' : 'PAID BY';
  const funderVerb = transferMode ? 'From' : inflow ? 'Received in' : 'Paid from';
  // In transfer mode the destination may be an account of your own OR an
  // expense -- a transfer fee is an ordinary expense split sitting beside the
  // two asset legs, which is exactly what the book already contains.
  // FUNDER_TYPES and not a hand-built list, so a stock account appears here
  // DIMMED with "desktop" beside it rather than silently missing -- an account
  // you own that is simply absent reads as a bug in the app.
  const itemTypes = transferMode
    ? [...FUNDER_TYPES, ...EXPENSE_TYPES]
    : inflow ? INCOME_TYPES : EXPENSE_TYPES;

  const list = (s: Section) => (s === 'items' ? items : s === 'moneyBack' ? moneyBack : funders);
  const setList = (s: Section, v: Row[]) =>
    (s === 'items' ? setItems : s === 'moneyBack' ? setMoneyBack : setFunders)(v);

  function patch(section: Section, key: string, p: Partial<Row>) {
    setList(section, list(section).map((r) => (r.key === key ? { ...r, ...p } : r)));
  }
  function drop(section: Section, key: string) {
    setList(section, list(section).filter((r) => r.key !== key));
  }

  // Removing a row that has something in it asks first.
  //
  // The remove button sits a thumb's width from the amount field, and while
  // driving this screen I hit it twice by accident and lost the row both
  // times. There is no undo here and no edit afterwards, so a mis-tap that
  // silently deletes work is the wrong trade. An untouched row still goes
  // without ceremony -- the confirmation is about losing something, not about
  // the tap.
  function askDrop(section: Section, r: Row) {
    if (!r.accountGuid && !r.raw.trim() && !r.memo.trim()) { drop(section, r.key); return; }
    Alert.alert(
      'Remove this row?',
      'It has not been written to your book, so nothing is lost from the ledger.',
      [
        { text: 'Keep', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: () => drop(section, r.key) },
      ],
    );
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

  // The one shape `mgc_transfer` can express: ONE account to ONE account.
  // It takes a single from and a single to, so a cross-currency move with a
  // fee line or a second source has nowhere to put them.
  const simpleShape = items.length === 1 && funders.length === 1 && moneyBack.length === 0;
  const itemAcct = items[0]?.accountGuid ? byGuid(items[0].accountGuid) : undefined;
  const funderAcct = funders[0]?.accountGuid ? byGuid(funders[0].accountGuid) : undefined;
  // Two currencies in one move, which is the one case that does NOT go through
  // `mgc_record_entry` -- that function is single-currency by construction and
  // refuses the rest. Here both amounts are stated and the SERVER derives the
  // rate from them.
  // ...and only between asset accounts, because that is all `mgc_transfer`
  // accepts (`sql/40_transfer.sql`: BANK, CASH or ASSET on both sides). A
  // foreign-currency EXPENSE would otherwise light the button up and then be
  // refused by the server, which is a worse way to learn it.
  const crossCurrency =
    transferMode && simpleShape && !!itemAcct && !!funderAcct &&
    itemAcct.commodity_guid !== funderAcct.commodity_guid &&
    TRANSFERABLE.includes(itemAcct.account_type) &&
    TRANSFERABLE.includes(funderAcct.account_type);
  const fromCcy = funderAcct?.commodity_mnemonic ?? null;
  const toCcy = itemAcct?.commodity_mnemonic ?? null;

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
    // ...except in a one-to-one move, where two currencies are the point.
    // Any richer shape is written by `mgc_record_entry`, which is
    // single-currency, so there the constraint comes straight back.
    if (transferMode && simpleShape) return null;
    const other = [...items, ...moneyBack, ...funders]
      .filter((r) => r.key !== picker.key)
      .map((r) => (r.accountGuid ? byGuid(r.accountGuid) : undefined))
      .find((a): a is Account => !!a);
    return other?.commodity_guid ?? null;
  }, [picker, items, moneyBack, funders, byGuid]);
  const currency = chosen[0]?.commodity_mnemonic ?? 'IDR';
  // Scope guard. The sheet already prevents these, so this is the backstop for
  // an account that changed under a cached list.
  // Hidden or turned into a placeholder while it was already on the screen --
  // the picker cannot prevent that, only notice it.
  const goneStale = chosen.find((a) => a.hidden === 1 || a.placeholder === 1);
  const mixedCurrency = !!chosen.find((a) => a.commodity_guid !== commodityGuid);
  // A cross-currency move in a trading-accounts book needs a trading account
  // for BOTH currencies, and `mgc_transfer` refuses rather than creating one.
  // The phone already holds every account including the trading tree, so it can
  // say this before the button lights up instead of after the write bounces.
  const missingTrading =
    crossCurrency && usesTrading
      ? [funderAcct, itemAcct].find((a) => a && !hasTradingAccount(a.commodity_guid))
      : undefined;
  const nonAsset = [itemAcct, funderAcct]
    .find((a) => a && !TRANSFERABLE.includes(a.account_type));
  const scopeProblem =
    goneStale
      ? `${goneStale.name} is hidden in GnuCash now. Choose another account.`
      : chosen.find((a) => a.commodity_namespace !== 'CURRENCY')
      ? `${chosen.find((a) => a.commodity_namespace !== 'CURRENCY')!.name} is not a currency account. Stocks, bonds and crypto belong in GnuCash desktop.`
      : missingTrading
        ? `Your book uses trading accounts but has none for ${
            missingTrading.commodity_mnemonic}. Make one ${fromCcy}/${toCcy} transfer in GnuCash desktop — it creates these by itself — and this will work from the phone afterwards.`
      : crossCurrency
        ? null
      : mixedCurrency
        ? (!transferMode
            ? 'Every account in one entry has to be in the same currency. Use Move, which takes both amounts and works the rate out itself.'
          : !simpleShape
            ? 'Two currencies can only be moved one account to one account. Take the extra lines off and record them separately.'
            // One-to-one, but something other than an asset is involved, and
            // `mgc_transfer` will not touch it.
            : `Moving between two currencies only works between asset accounts, and ${
                nonAsset?.name ?? 'one of these'} is ${nonAsset?.account_type ?? 'not one'}. A foreign-currency expense needs a rate set by hand — GnuCash desktop.`)
        : null;

  // Exactly one row anywhere may be left without an amount; the server derives
  // it. With one funder that is the normal case and no arithmetic happens on
  // this device at all.
  const blankFunders = funders.filter((r) => !r.raw.trim());
  const fundersTotal = sum(funders);
  const balanced = crossCurrency
    // Nothing balances across a currency boundary and nothing needs to: the
    // two amounts are independent and the server derives the rate between
    // them. Both simply have to be there.
    ? amt(items[0]) > 0 && amt(funders[0]) > 0
    : blankFunders.length === 1
      ? required > 0
      : blankFunders.length === 0 && Math.abs(fundersTotal - required) < 0.0001 && required > 0;

  const itemsReady = items.length > 0 && items.every((r) => r.accountGuid && amt(r) > 0);
  const backReady = moneyBack.every((r) => r.accountGuid && amt(r) > 0);
  const fundersReady =
    funders.length > 0 && funders.every((r) => r.accountGuid) &&
    funders.every((r) => !r.raw.trim() || amt(r) > 0) &&
    // Nothing is derived across a currency boundary, so "rest" is not on offer.
    (!crossCurrency || amt(funders[0]) > 0);

  // A receipt cannot be dated after today -- see `isFutureDate`'s header.
  // There is no legitimate case on the other side of this one, so unlike the
  // stale-date warning below it is a hard stop, not a tap-through.
  const futureDate = isFutureDate(postDate);

  // The one client-side arithmetic check this screen keeps, and it exists
  // because it very nearly did not: a receipt scan can leave the rows adding
  // up to something other than what it read as the total, and a mismatch that
  // only ever printed a coral warning still let the ShopeePay/TOKOO KITA entry
  // save with its money-back split half finished. Structural incompleteness
  // (`missing`, below) already disables the button instead of merely warning
  // beside it; this joins that list rather than staying purely cosmetic.
  const totalMismatch =
    printedTotal != null && Math.abs(required - printedTotal) > Math.max(1, printedTotal * 0.02);

  const ready =
    !futureDate && itemsReady && backReady && fundersReady && balanced && !totalMismatch &&
    !scopeProblem && canWrite && !saving;

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
    // The date sits above every section on screen, so a bad one is fixed
    // before anything else -- same "top of the screen down" rule as the rest.
    futureDate ? 'That date is in the future'
      : items.some((r) => !r.accountGuid) ? 'Choose an account'
      : items.some((r) => amt(r) <= 0) ? 'Enter an amount'
      : moneyBack.some((r) => !r.accountGuid) ? 'Choose the money back account'
      : moneyBack.some((r) => amt(r) <= 0) ? 'Enter the money back amount'
      : funders.some((r) => !r.accountGuid)
        ? (transferMode ? 'Choose where it came from' : inflow ? 'Choose where it arrived' : 'Choose who paid')
      : crossCurrency && amt(funders[0]) <= 0 ? `Enter the amount in ${fromCcy}`
      : totalMismatch ? 'Check the amount against the receipt'
      : scopeProblem ? 'Cannot be saved from here'
      : !canWrite ? 'Cannot save right now'
      : !balanced ? 'Not balanced yet'
      : null;

  const commitText = saved
    ? 'Saved ✓'
    : checkingDup
      ? 'Checking…'
    : saving
      ? 'Saving…'
      : missing
        // All three name what happens to the MONEY, not what the app does
        // with it. "Record income to X" was the odd one out -- it described
        // the filing rather than the payment, beside a "Spend from X" that
        // described the payment.
        // In a cross-currency move the FROM section is on screen naming the
        // account a line above, so a button repeating it only clips the figure
        // next to it.
        ?? (crossCurrency ? 'Move'
            : transferMode
              ? `Move from ${funderLabel}`
              : inflow ? `Receive into ${funderLabel}` : `Spend from ${funderLabel}`);

  // Scan is an INPUT METHOD here, not a destination: it fills the rows this
  // screen already knows how to hold, and everything after that -- correcting
  // an account, adding a money-back row, splitting the payment across two
  // cards -- is the ordinary screen. The standalone review screen could do
  // none of that.
  async function runScan(source: 'camera' | 'library') {
    // The funding account decides the currency, which decides which expense
    // accounts can be matched at all. It is normally already filled from last
    // time; when it is not, matching against the wrong currency is worse than
    // asking.
    if (!funders[0]?.accountGuid) {
      Alert.alert(
        'Choose who paid first',
        'The account paying decides the currency, and that decides which expense accounts a receipt can be matched against.',
      );
      return;
    }

    setScanning(true);
    const out = await scanReceipt({
      source,
      currency,
      scu: chosen[0]?.commodity_scu,
      candidates: postable(EXPENSE_TYPES),
    });
    setScanning(false);

    if (out.kind === 'cancelled') return;
    if (out.kind === 'error') { Alert.alert(out.title, out.message); return; }
    if (out.kind === 'topup') {
      Alert.alert('That looks like a topup', out.message, [
        { text: 'Not now', style: 'cancel' },
        { text: 'Switch to Move', onPress: () => setDirection('transfer') },
      ]);
      return;
    }

    setItems(out.lines.map((l) => ({
      key: `r${++seqRef.current}`,
      accountGuid: l.accountGuid,
      // The receipt's own wording for the line. It is the memo because the row
      // already shows the ACCOUNT; "Ayam Nanking" is what makes the line
      // recognisable against the paper.
      memo: l.name,
      raw: String(l.amount),
      proposed: l.proposed,
      basis: l.basis,
    })));

    // The discount arrives as an amount with NO account. The model knows money
    // came off; it cannot know whether that belongs to a discount income
    // account or against the expense, and after 2026-09-08 that choice is a
    // deliberate one with tax consequences. So the amount is filled and the
    // account is left for a tap -- the commit button will say so.
    setMoneyBack(out.discount > 0
      ? [{ key: `r${++seqRef.current}`, accountGuid: null, memo: 'Discount', raw: String(out.discount) }]
      : []);

    if (out.date) setPostDate(out.date);
    if (out.merchant) setDescription(out.merchant);
    setPrintedTotal(out.printedTotal);
  }

  /**
   * Ask a yes/no question and wait for the answer.
   *
   * `Alert` is callback-shaped, so without this the duplicate check would have
   * to be written inside-out around it.
   */
  function ask(title: string, message: string, proceed: string): Promise<boolean> {
    return new Promise((resolve) => {
      Alert.alert(
        title, message,
        [
          { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
          { text: proceed, style: 'destructive', onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      );
    });
  }

  /**
   * The same money, from the same account, on the same day, already in the book.
   *
   * It WARNS, it does not refuse, and that distinction is the whole design.
   * Two legitimate 30.000 entries were written from this phone within a minute
   * of each other on 2026-09-08 -- a lunch and a matching deposit -- and both
   * came off the same account on the same date. A rule that blocked the second
   * would have been wrong. What the user needs is to be asked.
   *
   * It reads the FUNDING account, because that is where a payment made twice
   * shows up whichever categories it was split across, and it matches the sign
   * so an expense is never mistaken for the refund of one.
   *
   * A failed lookup returns null. Never block a write because the check could
   * not run -- the check is the convenience, the write is the point.
   */
  async function findDuplicate(): Promise<RegisterRow | null> {
    const guid = funders[0]?.accountGuid;
    const amount = crossCurrency ? amt(funders[0]) : required;
    if (!guid || !(amount > 0)) return null;

    const res = await getRegister(guid, 7, 100);
    if (!res.ok) return null;

    const leaves = !inflow;
    // A move and an ordinary expense or income are different KINDS of entry
    // even when the amount, date and direction all agree -- your own money
    // changing pockets is not spending, and matching one against the other is
    // a false positive the coincidence produces for free. (A Move of 36.000
    // flagged an unrelated 36.000 grocery run as "the same" purchase for
    // exactly this reason.) So a candidate only counts if its own shape
    // agrees: at least one of ITS other splits is an asset account exactly
    // when this entry's other side is one too.
    const transferish = (r: RegisterRow) =>
      r.other_splits.some((o) => {
        const acct = byGuid(o.guid);
        return !!acct && TRANSFERABLE.includes(acct.account_type);
      });

    return res.data.rows.find((r) =>
      r.post_date.slice(0, 10) === postDate &&
      (r.quantity < 0) === leaves &&
      Math.abs(Math.abs(r.quantity) - amount) < 0.005 &&
      transferish(r) === transferMode,
    ) ?? null;
  }

  async function commit() {
    if (!ready) return;
    setSaving(true);

    // `ready` already refused a future date outright. What is left here is
    // only the past-threshold case, which stays a tap-through: a genuinely
    // old receipt (Holland Bakery, 38 days) is a real thing this app has to
    // let you record, and it is a misread year -- not a late receipt -- that
    // this is actually guarding against.
    const dateWarning = dateConcern(postDate);
    if (dateWarning) {
      const go = await ask('Check the date', dateWarning, 'Save anyway');
      if (!go) { setSaving(false); return; }
    }

    setCheckingDup(true);
    const dup = await findDuplicate();
    setCheckingDup(false);
    if (dup) {
      const same = `${dup.description || 'An entry'} — ${
        formatAmount(Math.abs(dup.quantity), crossCurrency ? (fromCcy ?? currency) : currency)
      }`;
      const go = await ask(
        'Already got one like this',
        `${funderLabel} already has this on the same date:

${same}

` +
          'If that is this same purchase, go back. This app cannot edit or delete, ' +
          'so a duplicate has to be unpicked in GnuCash desktop.',
        'Record anyway',
      );
      if (!go) { setSaving(false); return; }
    }

    const label = description.trim()
      || (transferMode ? 'Transfer' : inflow ? 'Income' : 'Expense');

    // Two currencies go to `mgc_transfer`, which is the only function that
    // takes two amounts and writes the trading splits GnuCash needs. Its
    // marker and offline handling live inside `transferRpc`, so this branch
    // does not repeat them.
    if (crossCurrency) {
      const result = await transferRpc({
        requestId: generateTransactionId(),
        fromGuid: funders[0].accountGuid!,
        fromAmount: amt(funders[0]),
        toGuid: items[0].accountGuid!,
        toAmount: amt(items[0]),
        postDate,
        description: description.trim() || label,
      });
      setSaving(false);

      if (result.ok) {
        void setLastFunder(funders[0].accountGuid!);
        const d = result.data;
        const already = d.status === 'already_recorded';
        // Both sides are stated, because in a cross-currency move neither
        // amount can be worked out from the other on sight. The rate is the
        // SERVER's `derived_rate`, never the figure shown while typing.
        const summary =
          `Moved ${formatAmount(amt(funders[0]), fromCcy ?? 'IDR')} from ${funderLabel}
` +
          `to ${formatAmount(amt(items[0]), toCcy ?? 'IDR')} in ${itemLabel}` +
          (d.derived_rate != null
            ? `
1 ${d.from_currency} = ${d.derived_rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${d.to_currency}`
            : '');
        setSaved(true);
        reset();
        setTimeout(() => setSaved(false), 1200);
        Alert.alert(
          already ? 'Already in your book' : 'Saved',
          already ? `${summary}

This had already been written; nothing was recorded twice.` : summary,
        );
        return;
      }

      noteFailure(result.kind, result.error);
      if (result.kind === 'offline') {
        Alert.alert(
          'Connection lost',
          `${result.error}

This move may or may not have reached your book. The app will check and tell you next time it connects, so do not enter it again yet.`,
        );
        return;
      }
      Alert.alert('Not saved', result.error);
      return;
    }

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
      const already = result.data.status === 'already_recorded';
      const summary = writtenSummary();
      // Either way it is IN THE BOOK, so either way the form clears. It used
      // to be left full on "already recorded", which invited entering it a
      // second time -- the opposite of what that answer means.
      setSaved(true);
      reset();
      setTimeout(() => setSaved(false), 1200);
      Alert.alert(
        already ? 'Already in your book' : 'Saved',
        already ? `${summary}

This had already been written; nothing was recorded twice.` : summary,
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

  // SHOWN, NEVER TYPED. A cross-currency move has three numbers -- out, in,
  // rate -- of which only two are independent, and every UI that asks for all
  // three lets them disagree. This is the same arithmetic the server does, put
  // on screen so the rate can be sanity-checked before saving; the number
  // reported AFTER saving is the server's own `derived_rate`, never this one.
  const rate =
    crossCurrency && amt(funders[0]) > 0 && amt(items[0]) > 0
      ? amt(items[0]) / amt(funders[0])
      : null;
  // A rate is still a number in a currency and has to group like one. Left to
  // the device locale it printed "16,400 IDR" directly under an amount reading
  // "4.100.000" -- same screen, same currency, two conventions.
  // Decimals go by MAGNITUDE, not by side: 16400 wants none and 0.000061 wants
  // several, and which side is which depends on the pair.
  const rateText = (x: number, ccy: string | null) =>
    x.toLocaleString(CURRENCIES[ccy ?? '']?.locale ?? 'en-US', {
      maximumFractionDigits: x >= 1 ? 4 : 8,
    });

  // Whether to print the currency beside each amount. Always while moving
  // money, where two accounts of yours may well be in different currencies and
  // the codes are the only thing that says which is which -- and otherwise
  // only when the entry actually holds more than one, so an ordinary IDR
  // receipt is not made to repeat itself four times.
  const showCcy =
    transferMode || new Set(chosen.map((a) => a.commodity_guid)).size > 1;

  const itemNames = items.map((r) => (r.accountGuid ? byGuid(r.accountGuid)?.name : null));
  const itemLabel =
    items.length > 1 ? `${items.length} accounts` : itemNames[0] ?? '…';

  /**
   * What the app tells you it just wrote.
   *
   * A write used to confirm itself by flashing "Saved ✓" on the button for
   * 1.2 seconds and clearing the form -- which is indistinguishable from the
   * form clearing for any other reason if you happen to look away, and this is
   * the one screen where "did that go in?" has to have an answer. Only the
   * cross-currency move ever said anything, because it had a rate to report.
   *
   * So it names the AMOUNT, the ACCOUNTS and the DIRECTION back to you: enough
   * to catch a wrong funder or a mistyped figure while the entry is still
   * fresh, since nothing in this app can edit or delete afterwards.
   */
  function writtenSummary(): string {
    const money = formatAmount(required, currency);
    const head =
      transferMode ? `Moved ${money} from ${funderLabel}
to ${itemLabel}`
        : inflow ? `Received ${money} into ${funderLabel}
from ${itemLabel}`
        : `Paid ${money} from ${funderLabel}
to ${itemLabel}`;
    const extras: string[] = [];
    if (moneyBack.length > 0) {
      extras.push(`after ${formatAmount(backTotal, currency)} back`);
    }
    // A date you did not choose is worth repeating; today is not.
    if (postDate !== todayIso()) {
      extras.push(
        new Date(`${postDate}T00:00:00`).toLocaleDateString(undefined, {
          day: 'numeric', month: 'short', year: 'numeric',
        }),
      );
    }
    return extras.length ? `${head}
${extras.join(' · ')}` : head;
  }

  const showSubtotal = moneyBack.length > 0 || funders.length > 1;

  function rowsFor(section: Section, colour?: string) {
    return list(section).map((r) => {
      const a = r.accountGuid ? byGuid(r.accountGuid) : undefined;
    // A money-back row is the only one that may go away entirely -- its
    // section disappears with it. Items and funders must keep at least one,
    // or the entry has no side. This only became reachable when a
    // cross-currency move started rendering the FROM section with a single
    // row in it, which had a delete control and nothing behind it.
      const removable = section === 'moneyBack' || list(section).length > 1;
      // The sentence under a scanned row is the one that catches a bad guess
      // before it reaches the book. "You chose this here before" and "the words
      // on the receipt looked like this" deserve very different amounts of
      // trust, and the second is the one that has been wrong.
      const basisNote = !a || !r.proposed ? null
        : r.basis === 'item' ? 'You chose this for this item here before.'
        : r.basis === 'merchant' ? 'You have always chosen this account at this merchant.'
        : 'Suggested from the receipt text — check it.';

      return (
        <View key={r.key}>
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Pressable onPress={() => setPicker({ section, key: r.key })}>
              <Text
                style={[
                  styles.rowName,
                  colour ? { color: colour } : null,
                  !a ? styles.rowNameEmpty : null,
                ]}
                numberOfLines={1}
              >
                {colour ? '↩ ' : ''}{a ? a.name : 'Choose an account'}
              </Text>
            </Pressable>
            {/* The line under the account is an editable MEMO, not a label.
                It was read-only, so a four-line entry could only be described
                once, at the transaction, and every split went in blank -- the
                account name was all you got back when reading the register.
                A scan prefills it with the receipt's own wording ("Ayam
                Nanking"), which is what makes a line recognisable against the
                paper; typed by hand it does the same job.

                The placeholder is the account's full path, so a row left alone
                still shows where it is going, exactly as before. */}
            {a ? (
              <TextInput
                style={styles.rowMemo}
                value={r.memo}
                onChangeText={(memo) => patch(section, r.key, { memo })}
                placeholder="Note for this line"
                placeholderTextColor={theme.disabled}
                numberOfLines={1}
              />
            ) : null}
          </View>
          <View>
          <View style={styles.amountWrap}>
            {colour ? <Text style={[styles.minus, { color: colour }]}>−</Text> : null}
            {/* Thousands separators differ by currency, so an amount is
                formatted by ITS OWN account's currency, not the entry's. In a
                cross-currency move the two rows genuinely disagree. */}
            <AmountInput
              value={r.raw}
              onChangeText={(raw) => patch(section, r.key, { raw })}
              currency={a?.commodity_mnemonic ?? currency}
              style={[styles.amount, colour ? { color: colour } : null]}
              placeholder={section === 'funders' && !crossCurrency ? 'rest' : '0'}
              placeholderTextColor={theme.inkFaint}
            />
          </View>
          {/* Under the number and right-aligned with it, not beside it: the
              field is right-aligned inside a fixed width, so a code placed to
              its left ends up stranded a whole column away from the digits. */}
          {showCcy && a ? (
            <Text style={styles.rowCcy}>{a.commodity_mnemonic}</Text>
          ) : null}
          </View>
          {removable ? (
            <Pressable
              style={styles.removeHit}
              onPress={() => askDrop(section, r)}
              accessibilityRole="button"
              accessibilityLabel="Remove this row"
            >
              <Text style={styles.remove}>×</Text>
            </Pressable>
          ) : null}
        </View>
        {basisNote ? (
          <Text style={[styles.basis, r.basis === 'tokens' && styles.basisWeak]}>{basisNote}</Text>
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
          {/* The title says which way the money is going, rather than
              repeating the tab's own name back at you.
              The handoff asked for a "compact" Out/In segmented and that was
              wrong: it is the most consequential control on the screen and was
              the smallest thing on it, easy to start an entry without noticing.
              The largest text here now states the direction and changes colour
              with it, and the control beside it is bigger. */}
          <Text style={[styles.h1, { color: tone }]}>
            {transferMode ? 'Move money' : inflow ? 'Money in' : 'Money out'}
          </Text>
          <View style={styles.segmented}>
            {(['outflow', 'inflow', 'transfer'] as const).map((d) => {
              const on = direction === d;
              return (
                <Pressable
                  key={d}
                  onPress={() => chooseDirection(d)}
                  style={[
                    styles.seg,
                    on && {
                      backgroundColor:
                        d === 'inflow' ? theme.moss
                          : d === 'outflow' ? theme.coral
                          : theme.ink,
                    },
                  ]}
                >
                  <Text style={[styles.segText, on && styles.segTextOn]}>
                    {d === 'outflow' ? 'Out' : d === 'inflow' ? 'In' : 'Move'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <View style={styles.chips}>
          <DateField value={postDate} onChange={setPostDate} variant="chip" />
          <Chip
            label={`${funderVerb} ${funderLabel} ▾`}
            onPress={() => setPicker({ section: 'funders', key: funders[0].key })}
          />
        </View>

        <View style={styles.sectionHead}>
          <SectionLabel>{itemsLabel}</SectionLabel>
          <Pressable
            style={[styles.scanPill, (inflow || transferMode || scanning) && styles.scanPillOff]}
            disabled={inflow || transferMode || scanning}
            onPress={() => Alert.alert('Scan a receipt', undefined, [
              { text: 'Photograph', onPress: () => void runScan('camera') },
              { text: 'Choose photo', onPress: () => void runScan('library') },
              { text: 'Cancel', style: 'cancel' },
            ])}
          >
            {scanning
              ? <ActivityIndicator size="small" color={theme.ink} />
              : <Icon name="scan" size={13} color={inflow || transferMode ? theme.disabled : theme.ink} />}
            <Text style={[styles.scanText, (inflow || transferMode || scanning) && { color: theme.disabled }]}>
              {scanning ? 'Reading…' : 'Scan'}
            </Text>
          </Pressable>
        </View>
        {rowsFor('items')}

        <View style={styles.links}>
          <Pressable onPress={() => setItems([...items, newRow()])}>
            <Text style={styles.link}>{transferMode ? '+ Add line' : '+ Add item'}</Text>
          </Pressable>
          {/* Money back has no meaning while moving your own money between
              your own accounts, and offering it invites a shape that cannot
              be saved. A refunded fee is a separate entry. */}
          {transferMode ? null : (
            <Pressable onPress={() => setMoneyBack([...moneyBack, newRow()])}>
              <Text style={[styles.link, { color: against }]}>↩ Money back</Text>
            </Pressable>
          )}
          <Pressable onPress={() => setFunders([...funders, newRow()])}>
            <Text style={styles.link}>
              {transferMode ? '+ Another source' : 'Split payment'}
            </Text>
          </Pressable>
        </View>

        {moneyBack.length > 0 ? (
          <>
            <SectionLabel style={[styles.sectionSolo, { color: against }]}>
              ↩ MONEY BACK
            </SectionLabel>
            {rowsFor('moneyBack', against)}
          </>
        ) : null}

        {/* Normally one funder needs no section of its own -- the chip at the
            top names it. A cross-currency move is the exception: the amount
            LEAVING is a second independent number, and there is nowhere else
            on the screen to type it. */}
        {funders.length > 1 || crossCurrency ? (
          <>
            <SectionLabel style={styles.sectionSolo}>{fundersLabel}</SectionLabel>
            {rowsFor('funders')}
            <Text style={styles.hint}>
              {crossCurrency
                ? `Both amounts are stated: ${fromCcy} leaving, ${toCcy} arriving. The rate follows from them.`
                : 'Leave the last one empty and it takes whatever is left.'}
            </Text>
          </>
        ) : null}

        {/* Read-only, and it must stay that way. See the note by `rate`. */}
        {crossCurrency ? (
          <View style={styles.rateBox}>
            <Text style={styles.rateLabel}>EXCHANGE RATE</Text>
            {rate ? (
              <>
                <Text style={styles.rateMain}>
                  1 {fromCcy} = {rateText(rate, toCcy)} {toCcy}
                </Text>
                <Text style={styles.rateInverse}>
                  1 {toCcy} = {rateText(1 / rate, fromCcy)} {fromCcy}
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

        {/* The whole entry's description, and it has to be unmistakably that.
            It sat directly under "+ Add item", where it read as a note for the
            item above -- which is exactly what a per-line memo IS, one row
            higher. Moved to the end, after the sections, and given a label of
            its own so the two kinds of text cannot be confused. */}
        <SectionLabel style={styles.sectionSolo}>DESCRIPTION</SectionLabel>
        <TextField
          style={styles.desc}
          placeholder="What the whole entry was, e.g. Lunch"
          value={description}
          onChangeText={setDescription}
        />

        {showSubtotal ? (
          <View style={styles.subtotal}>
            <SubRow label="Items" value={formatAmount(itemsTotal, currency)} />
            {moneyBack.length > 0 ? (
              <SubRow label="Money back" value={`− ${formatAmount(backTotal, currency)}`} colour={against} />
            ) : null}
            <SubRow label={inflow ? 'To receive' : 'To pay'} value={formatAmount(required, currency)} strong />
          </View>
        ) : null}

        {totalMismatch ? (
          <Text style={styles.warn}>
            These rows come to {formatAmount(required, currency)}, but the receipt says{' '}
            {formatAmount(printedTotal!, currency)}. Check the amounts before saving.
          </Text>
        ) : null}
        {scopeProblem ? <Text style={styles.warn}>{scopeProblem}</Text> : null}
        {!canWrite && blockedReason ? <Text style={styles.warn}>{blockedReason}</Text> : null}
      </ScrollView>

      <View style={[styles.footer, keyboard > 0 ? { marginBottom: keyboard } : null]}>
        <View style={styles.footerTotal}>
          <Text style={styles.footerSub} numberOfLines={1}>
            {crossCurrency
              ? `Arriving ${formatAmount(amt(items[0]), toCcy ?? 'IDR')}`
              : moneyBack.length > 0
              ? `${formatAmount(itemsTotal, currency)} − ${formatAmount(backTotal, currency)} back`
              : funders.length > 1
                ? (balanced ? 'Balanced' : 'Not balanced yet')
                : transferMode ? 'Moving' : inflow ? 'Total in' : 'Total out'}
          </Text>
          <Text style={[styles.footerAmount, { color: tone }]} numberOfLines={1}>
            {crossCurrency
              ? formatAmount(amt(funders[0]), fromCcy ?? 'IDR')
              : formatAmount(required, currency)}
          </Text>
        </View>
        <Pressable
          style={[
            styles.commit,
            { backgroundColor: tone },
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
            ? (transferMode ? 'Move it to' : inflow ? 'Income account' : 'Expense account')
            : picker?.section === 'moneyBack'
              ? 'Money back to'
              : funderVerb
        }
        types={
          picker?.section === 'items'
            ? itemTypes
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
  h1: { color: theme.ink, fontSize: 19, fontFamily: fonts.sansSemi },
  segmented: {
    flexDirection: 'row', backgroundColor: theme.surfaceSoft, borderRadius: 8, padding: 2,
  },
  seg: { paddingVertical: 7, paddingHorizontal: 18, borderRadius: 6 },
  segText: { color: theme.inkSoft, fontSize: 13, fontFamily: fonts.sansSemi },
  segTextOn: { color: theme.bg },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  // Spacing only. The field itself is TextField's 'form' variant.
  desc: { marginTop: 12 },
  sectionHead: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginTop: 18, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
  },
  sectionSolo: {
    marginTop: 18, paddingBottom: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairlineStrong,
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
    // minHeight, not padding: the handoff asks for a 44x44 minimum target and
    // an 8px-padded row of 12px text does not reach it. Padding alone would
    // also grow a two-line row past where it needs to be.
    minHeight: 44, paddingVertical: 6,
    borderBottomWidth: 1, borderBottomColor: theme.hairline,
  },
  rowMain: { flex: 1, marginRight: 8, justifyContent: 'center', minHeight: 44 },
  rowName: { color: theme.ink, fontSize: 12, fontFamily: fonts.sansMedium },
  // An unfinished row should not look like a finished one. Four rows deep,
  // "Choose an account" in the same ink as a real account name is something
  // you scroll past -- and the commit button only ever names the FIRST thing
  // missing, so the others stay invisible until you fix that one.
  rowNameEmpty: { color: theme.disabled, fontFamily: fonts.sans },
  rowPath: { color: theme.inkFaint, fontSize: 11, marginTop: 2, fontFamily: fonts.sans },
  // The account's full path used to be the placeholder here, which made an
  // empty memo read as a static label -- the field looked like data, so nobody
  // could tell it was typeable. The prompt now says what it is. The path is
  // gone from the row: it belongs to CHOOSING an account, which the picker
  // already shows in full, and the name is what identifies the line afterwards.
  rowMemo: {
    color: theme.inkSoft, fontSize: 11, fontFamily: fonts.sans,
    paddingVertical: 2, marginTop: 0, minHeight: 20,
  },
  amountWrap: { flexDirection: 'row', alignItems: 'center' },
  minus: { fontSize: 13, fontFamily: fonts.mono, marginRight: 1 },
  rowCcy: {
    color: theme.inkFaint, fontSize: 10, fontFamily: fonts.mono,
    textAlign: 'right', marginTop: -2,
  },
  amount: {
    color: theme.ink, fontSize: 13, fontFamily: fonts.mono,
    textAlign: 'right', minWidth: 96, paddingVertical: 4,
  },
  // 44x44, which is the handoff's stated minimum and was not being met. The
  // old target was a 17px glyph with 10px of slop, close enough to the amount
  // field to be hit by mistake -- which it was, twice.
  removeHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  remove: { color: theme.inkFaint, fontSize: 17, lineHeight: 20 },
  basis: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 15,
    marginTop: -2, marginBottom: 6, fontFamily: fonts.sans,
  },
  basisWeak: { color: theme.coral },
  links: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 12,
  },
  link: { color: theme.ink, fontSize: 11, fontFamily: fonts.sansMedium },
  hint: { color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 8, fontFamily: fonts.sans },
  rateBox: {
    backgroundColor: theme.surfaceSoft, borderRadius: 12, padding: 16, marginTop: 20,
  },
  rateLabel: {
    color: theme.inkFaint, fontSize: 11, letterSpacing: 1, marginBottom: 8,
    fontFamily: fonts.sans,
  },
  rateMain: {
    color: theme.ink, fontSize: 17, fontFamily: fonts.mono, fontVariant: ['tabular-nums'],
  },
  rateInverse: {
    color: theme.inkSoft, fontSize: 13, marginTop: 4, fontFamily: fonts.mono,
    fontVariant: ['tabular-nums'],
  },
  ratePending: { color: theme.inkFaint, fontSize: 14, fontFamily: fonts.sans },
  rateHint: {
    color: theme.inkFaint, fontSize: 11, lineHeight: 16, marginTop: 10, fontFamily: fonts.sans,
  },
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
    paddingVertical: 11, paddingHorizontal: 16,
    // Capped so a long label ("Record income to Ala Dompet") cannot squeeze
    // the total next to it down to "Rp 500...". The figure being about to be
    // written matters more than the whole button text fitting.
    flexShrink: 1, maxWidth: '52%',
  },
  commitOff: { opacity: 0.35 },
  commitText: { color: theme.bg, fontSize: 13, fontFamily: fonts.sansMedium },
});
