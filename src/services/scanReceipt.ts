// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Photograph a receipt and turn it into rows the Entry screen can hold.
//
// The logic here was inside `app/scan/review.tsx`, where it could only ever
// serve that one screen. Lifting it out is what lets Scan become an INPUT
// METHOD rather than a destination: the same call fills the Entry screen,
// where the result can then have a money-back row added, be split across two
// funding accounts, or be corrected -- none of which the review screen could
// do.
//
// What it returns is a PROPOSAL, exactly as before. Nothing here reaches the
// ledger, no account is chosen without the user seeing it, and the matcher's
// basis travels with each line so the screen can say how much to trust it.

import * as ImagePicker from 'expo-image-picker';
import { extractReceipt } from './receiptExtraction';
import { getAiModel } from './aiKey';
import { adoptLegacyKey, keysForScan, markExhausted, clearExhausted } from './aiKeys';
import { matchLine } from './accountMatch';
import { loadMemory, recall } from './merchantMemory';
import { roundingUnit } from '../utils/currency';
import type { Account } from './api';

/** Why an account was proposed, so the screen can say how firm it is. */
export type MatchBasis = 'tokens' | 'item' | 'merchant';

export type ScannedLine = {
  name: string;
  amount: number;
  accountGuid: string | null;
  /** True while the account is the matcher's guess, not a user's choice. */
  proposed: boolean;
  basis: MatchBasis | null;
};

export type ScanOutcome =
  | { kind: 'cancelled' }
  | { kind: 'error'; title: string; message: string }
  /** A wallet topup is a transfer, not an expense. The caller redirects. */
  | { kind: 'topup'; message: string }
  | {
      kind: 'ok';
      merchant: string;
      date: string;
      photoUri: string | null;
      lines: ScannedLine[];
      /**
       * The receipt's discount, as its own amount. It is NOT spread across the
       * lines any more -- see the note in receiptExtraction/index.ts about the
       * Bahagia Chinese Food entry, where spreading turned a 35.000 dish into
       * 19.091. The caller puts it in a money-back row.
       *
       * The ACCOUNT is deliberately not guessed. The model knows an amount came
       * off; it has no idea whether that belongs to a discount income account
       * or against the expense, and that choice has tax consequences the app
       * should not make silently.
       */
      discount: number;
      printedTotal: number;
      computedTotal: number;
      totalMismatch: boolean;
    };

export async function scanReceipt(params: {
  source: 'camera' | 'library';
  /** The funding account's currency; decides which expenses can be matched. */
  currency: string | null;
  scu?: number;
  /** Postable expense accounts, already filtered by the caller. */
  candidates: Account[];
}): Promise<ScanOutcome> {
  const { source, currency, scu, candidates } = params;

  // Folds a key saved before the key list existed into it. A no-op afterwards.
  await adoptLegacyKey();
  const keys = await keysForScan();
  if (keys.length === 0) {
    return {
      kind: 'error',
      title: 'No Gemini key',
      message: 'Receipt scanning uses your own Gemini API key. Add one in Settings.',
    };
  }

  if (source === 'camera') {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      return {
        kind: 'error',
        title: 'Camera not allowed',
        message: 'Grant camera access to photograph a receipt.',
      };
    }
  }

  const picked =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync({ base64: true, quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({ base64: true, quality: 0.7 });

  if (picked.canceled || !picked.assets?.length) return { kind: 'cancelled' };
  const asset = picked.assets[0];
  if (!asset.base64) {
    return {
      kind: 'error',
      title: 'Could not read that image',
      message: 'Try again, or pick a different photo.',
    };
  }

  // Walk the keys. `keysForScan` has already put them in round-robin order and
  // moved the cursor on, so this loop only decides when to give up.
  //
  // Only an `exhausted` failure moves to the next key. Anything else -- a bad
  // key, a malformed request, no connection -- would fail identically on all
  // of them, and trying anyway would spend the other keys' quota to arrive at
  // the same answer three times over.
  const model = await getAiModel();
  const unit = roundingUnit(currency ?? 'IDR', scu);

  let result: Awaited<ReturnType<typeof extractReceipt>> | null = null;
  let exhausted = 0;

  for (const key of keys) {
    result = await extractReceipt({
      base64Image: asset.base64,
      mimeType: asset.mimeType ?? 'image/jpeg',
      apiKey: key.secret,
      model,
      roundingUnit: unit,
    });

    if (result.ok) {
      // A success is the only thing that clears the Settings flag. It has to
      // be a real one: a key that answered is demonstrably back, whereas a
      // cooldown elapsing proves nothing.
      await clearExhausted(key.id);
      break;
    }
    if (result.kind === 'exhausted') {
      await markExhausted(key.id);
      exhausted += 1;
      continue;
    }
    break;
  }

  if (!result || !result.ok) {
    // When every key is out, say that rather than repeating a message written
    // for one key. "Try again shortly" is misleading advice when the answer is
    // that all of them are spent.
    const message =
      exhausted > 0 && exhausted === keys.length
        ? keys.length === 1
          ? "Your Gemini key has hit its rate limit or quota. Try again shortly, or add another key in Settings."
          : `All ${keys.length} of your Gemini keys have hit their limits. Try again shortly. If they ran out together, they may share one Google project's quota.`
        : (result?.message ?? "Couldn't read that receipt.");
    return { kind: 'error', title: 'Could not read that receipt', message };
  }

  // A topup moves money between two of the user's own accounts. Recording it
  // as an expense against a category is the wrong shape and would invent a
  // rate, so it is reported rather than guessed at.
  if (result.receipt_type === 'topup') {
    return {
      kind: 'topup',
      message:
        'Money moving into your own wallet is a transfer, not an expense. Switch this entry to Move: it takes both amounts and derives the rate itself.',
    };
  }

  const memory = await loadMemory();
  const lines: ScannedLine[] = result.items.map((item) => {
    const match = matchLine(
      item,
      candidates,
      currency,
      recall(memory, result.merchant ?? '', item.name),
    );
    return {
      name: item.name,
      amount: item.allocated_price,
      accountGuid: match?.account.guid ?? null,
      proposed: !!match,
      basis: (match?.basis as MatchBasis | undefined) ?? null,
    };
  });

  return {
    kind: 'ok',
    merchant: result.merchant ?? '',
    date: result.date,
    photoUri: asset.uri ?? null,
    lines,
    discount: result.receipt_discount,
    printedTotal: result.printed_total,
    computedTotal: result.computed_total,
    totalMismatch: result.total_mismatch,
  };
}
