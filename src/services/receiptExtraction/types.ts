// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

// Raw shapes the AI returns, before this module's deterministic allocation
// runs over them. Lifted from Ledgerize, which lifted them in turn from the
// retired Supabase Edge Function.
//
// The topup fields are gone. In Ledgerize a topup was a one-sided fee entry
// because it did not track wallet balances; here a topup is a TRANSFER
// between two real accounts, and transfers have their own screen and their
// own RPC. `receipt_type` is still extracted, though, so a topup photographed
// by mistake can be recognised and sent to the right screen rather than
// silently booked as an expense.

/**
 * One picture or document on its way to Gemini, already base64 encoded.
 *
 * A LIST of these is what gets sent, not one, because a long receipt on a
 * phone screen does not fit in a single screenshot and the apps that show
 * them rarely offer a PDF. Several shots of one receipt are pages of one
 * document, and Gemini reads them that way when they arrive as consecutive
 * inline parts under a single prompt.
 *
 * The mime type travels WITH the bytes rather than being passed once for the
 * whole list. A gallery selection can genuinely mix them: a PNG screenshot
 * taken by one app and a JPEG taken by another, in the same receipt.
 */
export type ScanImage = {
  base64: string;
  mimeType: string;
};

export type RawItem = {
  name: string;
  // Per-line price, after any per-item discount already printed next to that
  // specific line, but before any receipt-level discount/tax.
  price: number;
  // An input to account matching only. Never stored: the ledger records the
  // account the user confirmed, not a phrase a language model produced.
  suggested_category: string;
  // The account the model picked from the list it was given, as a full path.
  // Optional because a model can leave it out; accountMatch.ts uses it only if
  // it names a real candidate, and falls back to the words otherwise.
  account?: string;
};

export type RawExtraction = {
  merchant: string;
  date: string;
  currency: string;
  receipt_type: 'purchase' | 'topup';
  items: RawItem[];
  receipt_discount: number; // 0 if none
  receipt_tax: number; // 0 if none
  printed_total: number;
};

export type AllocatedItem = RawItem & {
  allocated_price: number;
};

export type TokenUsage = { inputTokens: number; outputTokens: number };

/** Which scanner read a receipt, and what it needs to be reached. */
export type ScanEngine =
  | { kind: 'gemini'; apiKey: string; model?: string }
  | { kind: 'claude'; url: string; token: string };

/** How much of the day's Claude allowance is spent, as the server counts it. */
export type ClaudeQuota = { used: number; limit: number };
