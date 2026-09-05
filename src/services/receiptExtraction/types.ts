// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

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

export type RawItem = {
  name: string;
  // Per-line price, after any per-item discount already printed next to that
  // specific line, but before any receipt-level discount/tax.
  price: number;
  // An input to account matching only. Never stored: the ledger records the
  // account the user confirmed, not a phrase a language model produced.
  suggested_category: string;
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
