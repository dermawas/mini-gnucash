// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

// On-device receipt extraction. Lifted from Ledgerize, which replaced a
// retired `scan-receipt` Supabase Edge Function with this.
//
// ---------------------------------------------------------------------------
// On the standing "no API key on the client" rule
// ---------------------------------------------------------------------------
// No AI API key belonging to Forstra may ever ship to a client. That rule is
// about *Forstra's* keys and it still holds: one project-owned key on many
// devices is one extraction away from someone else's bill.
//
// A key the user obtained themselves, stored on their own device, billed to
// their own Google account, protecting their own quota, is a different risk
// class. The worst case is that the device's owner reads their own key.
// Nothing is pooled, so nothing is shared.
//
// This is not a relaxation of the rule. Do not read it as licence to embed a
// project-owned key here later, and do not put ANY key in this repository —
// it is public from its first commit, and scripts/check-no-secrets.sh exists
// to make that failure loud.
// ---------------------------------------------------------------------------
//
// What this returns is a PROPOSAL. Nothing here reaches the ledger without a
// tap, and none of it does arithmetic that affects double-entry: the AI
// reports observed figures, allocate.ts does the maths, and the transfer and
// transaction RPCs do the balancing.

import { allocateAmounts } from './allocate';
import { callGemini, DEFAULT_GEMINI_MODEL } from './gemini';
import type { AllocatedItem } from './types';

export { DEFAULT_GEMINI_MODEL } from './gemini';
export type { RawItem, AllocatedItem, RawExtraction } from './types';

export type ReceiptScan = {
  receipt_type: 'purchase' | 'topup';
  merchant: string;
  date: string;
  currency: string;
  items: AllocatedItem[];
  receipt_discount: number;
  receipt_tax: number;
  computed_total: number;
  printed_total: number;
  /** Set when allocation and the printed total disagree beyond tolerance. */
  total_mismatch: boolean;
};

export type ExtractReceiptResult =
  | ({ ok: true } & ReceiptScan)
  | { ok: false; error: string; message: string };

export async function extractReceipt(params: {
  base64Image: string;
  mimeType: string;
  apiKey: string;
  model?: string;
}): Promise<ExtractReceiptResult> {
  const { base64Image, mimeType, apiKey } = params;
  const model = params.model?.trim() || DEFAULT_GEMINI_MODEL;

  if (!apiKey) {
    return {
      ok: false,
      error: 'no_api_key',
      message: 'No Gemini API key configured. Add one in Settings.',
    };
  }

  const result = await callGemini(apiKey, model, base64Image, mimeType);
  if (!result.ok) {
    return { ok: false, error: 'scan_failed', message: result.error };
  }

  const extraction = result.data;

  // A topup is a TRANSFER here, not an expense, so there is nothing to
  // allocate and nothing this screen can record. It is still reported rather
  // than swallowed: the review screen sends the user to the transfer screen,
  // which is the only place a movement between two real accounts can be
  // written without inventing a rate.
  if (extraction.receipt_type === 'topup') {
    return {
      ok: true,
      receipt_type: 'topup',
      merchant: extraction.merchant,
      date: extraction.date,
      currency: extraction.currency,
      items: [],
      receipt_discount: 0,
      receipt_tax: 0,
      computed_total: 0,
      printed_total: extraction.printed_total ?? 0,
      total_mismatch: false,
    };
  }

  // Deterministic allocation (local math, never the AI's arithmetic).
  //
  // Note: no zero-price filter on purpose — a $0 line can be a real,
  // deliberately-listed item (e.g. a free paper bag), not just a stray
  // modifier. Filtering by price cannot tell those apart; the fix for
  // modifier lines like "Panas"/Hot lives in the extraction prompt instead,
  // which folds them into the parent item's name based on context.

  // Safety net independent of prompt accuracy: if the raw item prices alone
  // already sum close to the printed total, that is hard evidence no
  // additional discount/tax should be applied on top — regardless of what the
  // AI reported (e.g. it can misread an informational PPN/DPP tax-breakdown
  // table, common on Indonesian receipts, as an amount to add, when the item
  // prices already include that tax).
  const rawSubtotal = extraction.items.reduce((sum, i) => sum + i.price, 0);
  const printedTotalForCheck = extraction.printed_total ?? 0;
  const rawSubtotalAlreadyMatches =
    Math.abs(rawSubtotal - printedTotalForCheck) <= Math.max(1, rawSubtotal * 0.02);

  const allocation = allocateAmounts(
    extraction.items,
    rawSubtotalAlreadyMatches ? 0 : extraction.receipt_discount ?? 0,
    rawSubtotalAlreadyMatches ? 0 : extraction.receipt_tax ?? 0,
  );

  const printedTotal = extraction.printed_total ?? 0;
  const tolerance = Math.max(1, allocation.computedTotal * 0.02);

  return {
    ok: true,
    receipt_type: 'purchase',
    merchant: extraction.merchant,
    date: extraction.date,
    currency: extraction.currency,
    items: allocation.allocated,
    receipt_discount: rawSubtotalAlreadyMatches ? 0 : extraction.receipt_discount ?? 0,
    receipt_tax: rawSubtotalAlreadyMatches ? 0 : extraction.receipt_tax ?? 0,
    computed_total: allocation.computedTotal,
    printed_total: printedTotal,
    total_mismatch: Math.abs(allocation.computedTotal - printedTotal) > tolerance,
  };
}
