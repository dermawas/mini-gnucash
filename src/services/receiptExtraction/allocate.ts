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
  receiptTax: number,
  /**
   * Denominator to round to: 1 for whole units, 100 for two decimals. Use
   * `roundingUnit(currency, scu)` -- it is NOT the raw commodity_scu, because
   * IDR and JPY carry scu 100 but are written without minor units.
   */
  unit = 1
): { allocated: AllocatedItem[]; computedTotal: number } {
  // Integer arithmetic throughout, for two reasons.
  //
  // Rounding to whole MAJOR units, as this did before, is only ever right for
  // a currency with no minor unit. On USD a $1.50 discount over eight lines
  // rounded every share to a whole dollar: most lines got $0 and one got $2.
  // The remainder correction still made the total add up, so the ledger
  // balanced and the error hid in the per-line figures -- which are exactly
  // the numbers your expense categories are made of.
  //
  // Working in minor units also removes the float residue. In major units
  // `exactTotal - allocatedSum` could land on 1e-10 rather than 0, which is
  // truthy, so a meaningless correction was applied to a line every time.
  const denom = Number.isFinite(unit) && unit > 0 ? Math.round(unit) : 1;
  const toMinor = (v: number) => Math.round(v * denom);

  const prices = items.map((i) => toMinor(i.price));
  const subtotal = prices.reduce((sum, p) => sum + p, 0);

  if (subtotal <= 0 || items.length === 0) {
    return { allocated: [], computedTotal: 0 };
  }

  const discount = toMinor(receiptDiscount);
  const tax = toMinor(receiptTax);

  const minor = prices.map((price) => {
    const share = price / subtotal;
    return price - Math.round(discount * share) + Math.round(tax * share);
  });

  // Rounding-remainder correction: force the sum to match exactly.
  const exactTotal = subtotal - discount + tax;
  const remainder = exactTotal - minor.reduce((sum, v) => sum + v, 0);

  if (remainder !== 0) {
    // On the LARGEST line, not the last one. The last line is the worst
    // available choice: bags, packaging and loyalty lines are rung up last and
    // frequently cost nothing, so the correction would turn a zero line into a
    // charge -- or, when the remainder is negative, into a negative one, which
    // mgc_record_transaction rejects outright ("Line % has no amount"). The
    // largest line can always absorb it. First-largest wins, and the caller's
    // order is stable, so the choice is deterministic across runs.
    let target = 0;
    for (let i = 1; i < minor.length; i += 1) {
      if (minor[i] > minor[target]) target = i;
    }
    minor[target] += remainder;
  }

  const allocated: AllocatedItem[] = items.map((item, i) => ({
    ...item,
    allocated_price: minor[i] / denom,
  }));

  return { allocated, computedTotal: exactTotal / denom };
}
