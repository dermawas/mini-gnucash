// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

// Deterministic tax/discount allocation. Lifted VERBATIM from the retired
// Supabase Edge Function (supabase/functions/scan-receipt/index.ts).
//
// Why this is not the AI's job: GnuCash requires a transaction's splits to
// sum to exactly zero. Asking a language model to divide a receipt-level
// discount across twenty line items and have the result reconcile to the
// cent is asking for a ledger that silently doesn't balance. So the AI only
// ever reports raw observed figures, and the arithmetic happens here, with
// an explicit rounding-remainder correction that forces the sum to match.

import type { RawItem, AllocatedItem } from './types';

export function allocateAmounts(
  items: RawItem[],
  receiptDiscount: number,
  receiptTax: number
): { allocated: AllocatedItem[]; computedTotal: number } {
  const subtotal = items.reduce((sum, i) => sum + i.price, 0);

  if (subtotal <= 0 || items.length === 0) {
    return { allocated: [], computedTotal: 0 };
  }

  const allocated: AllocatedItem[] = items.map((item) => {
    const share = item.price / subtotal;
    const itemDiscount = Math.round(receiptDiscount * share);
    const itemTax = Math.round(receiptTax * share);
    return {
      ...item,
      allocated_price: item.price - itemDiscount + itemTax,
    };
  });

  // Rounding-remainder correction: force the sum to match exactly.
  const exactTotal = subtotal - receiptDiscount + receiptTax;
  const allocatedSum = allocated.reduce((s, i) => s + i.allocated_price, 0);
  const remainder = exactTotal - allocatedSum;
  if (remainder !== 0 && allocated.length > 0) {
    allocated[allocated.length - 1].allocated_price += remainder;
  }

  return { allocated, computedTotal: exactTotal };
}
