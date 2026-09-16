// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Flowform Lab

// The extraction prompt and structured-output schema, lifted VERBATIM from
// the retired Supabase Edge Function (supabase/functions/scan-receipt/index.ts)
// during the open-source pivot.
//
// This is accumulated, hard-won behaviour — do not "tidy" it without a real
// receipt to test against. In particular it encodes:
//   - Indonesian PPN/DPP informational tax-breakdown tables, which look like
//     an additional charge but are not (item prices already include the tax).
//   - Modifier/option lines ("Panas"/Hot, sizes, ice level) that must fold
//     into the preceding item's name rather than becoming their own item.
//   - Quantity lines ("2pc @ 19.900"), where the reported price must be the
//     LINE total, never the per-unit price.
//   - E-wallet topup detection, which suppresses item extraction entirely.
//
// Surgery on the lift from Ledgerize was deliberately minimal: the three
// topup_* schema properties are gone, and so are the two paragraphs telling
// the model to fill them. Everything else is untouched.
//
// `receipt_type` and its detection paragraph STAY. In Ledgerize a topup was a
// one-sided fee; here it is a transfer between two real accounts, with its own
// screen and its own RPC. Keeping detection means a topup photographed by
// mistake gets recognised and redirected, instead of being booked as an
// expense against whatever account happened to be selected. Deleting the
// paragraph would leave the enum with a value the model was never told how to
// choose.
//
// Changed 2026-09-10, when the scanner learned to take a PDF or a file as well
// as a photograph. Two edits, both minimal and both about the SOURCE rather
// than about extraction:
//   1. The opening line no longer says "image". It was the only sentence that
//      told the model to expect a photograph, and a PDF invoice arriving under
//      that instruction is being described wrongly before it is read.
//   2. A paragraph on statements. A PDF is the first source that can easily be
//      a card statement or a transaction history, which is MANY receipts, and
//      the schema has room for one. An empty `items` array is how the model
//      says so; `scanReceipt` turns that into a refusal rather than an entry
//      with a bank's name on it and no rows.
// Nothing about prices, tax, modifiers or quantity lines was touched.
//
// Keep this file import-free (pure strings and plain objects) so it stays
// portable and trivially testable.

export const EXTRACTION_PROMPT = `Extract structured data from this receipt. It may be a photograph of a printed receipt, a screenshot of a digital one, or a PDF invoice or e-receipt. If a PDF runs to more than one page but describes ONE purchase (an invoice with its terms, or a long itemised till roll), read every page as a single receipt.

This document must describe ONE purchase. If it is instead an account statement, a card statement, a transaction history, a monthly summary, or any list of several separate transactions, then return items as an empty array and printed_total as 0, and set receipt_type to "purchase". Do NOT merge several transactions into one receipt, and do NOT choose one of them to report on its own.

FIRST, decide receipt_type. Set it to "topup" ONLY for an e-wallet or bank topup/transfer confirmation — e.g. an ATM or mobile/internet banking screen confirming "Top Up GoPay", "Isi Ulang OVO", "Top Up DANA", "Top Up ShopeePay/LinkAja", or a bank transfer INTO one of those e-wallets — where money is being moved from the user's own bank account into their own e-wallet, not spent on goods or services from a merchant. These often look like a banking app screenshot or an ATM receipt rather than a printed shop receipt, typically showing a destination e-wallet name, the amount being topped up, and sometimes a separate admin/service fee line (e.g. "Biaya Admin", "Admin Fee", "Biaya Layanan", "Service Charge"). Set receipt_type to "purchase" for every other receipt (any receipt where the items are goods/services bought from a merchant), which is the overwhelmingly common case — when in doubt, choose "purchase".

If receipt_type is "topup": leave items as an empty array (do not try to invent line items for the topup itself), and set receipt_discount/receipt_tax to 0. Still report printed_total as whatever final total is shown.

If receipt_type is "purchase": follow all the item-extraction rules below as normal.

For EACH line item on a "purchase" receipt, give its name, its price (a plain number, no currency symbols), and a short suggested expense category (e.g. Groceries, Dining, Fuel, Household).

IMPORTANT — modifier/option lines: some receipts print a customization choice (e.g. "Panas"/Hot, "Dingin"/Cold, a size, spice level, ice level, or a topping/add-on with no charge of its own) on its own line directly under or after a food/drink item, without a price of its own. Do NOT report these as separate items — fold the modifier into the preceding item's name instead (e.g. name "Kopi Susu (Panas)", not two entries "Kopi Susu" and "Panas"). Only give a line its own entry in items if it has a genuine price of its own printed on the receipt (even a small add-on charge counts).

IMPORTANT — quantity lines: many receipts show a quantity and a per-unit price on one line (e.g. "2pc @ 19.900", "3 x 5,000", "Qty 2 @ 10.00"), sometimes with the line's total price printed on the same or next line and sometimes not printed at all. The \`price\` you report for that item MUST always be the TOTAL for that line (quantity × unit price) — e.g. "2pc @ 19.900" is price 39800, never 19900. If only the unit price and quantity are shown and no explicit line total is printed, calculate the total yourself (quantity × unit price) rather than reporting the unit price alone.

Do NOT attempt to calculate or apply any receipt-level discount or tax to individual item prices yourself — report the receipt-level discount and tax as separate total figures instead, and report the item price as shown per line (after any per-item discount already printed next to that specific item, but before any whole-receipt discount or tax). Also report the final printed total exactly as shown on the receipt. If a field is unclear or missing, make your best reasonable guess rather than leaving it blank, and use 0 for receipt_discount/receipt_tax if the receipt shows none.

IMPORTANT — receipt_tax must only be a positive amount that gets ADDED on top of the line items to reach the printed total (e.g. an explicit "Subtotal: X" followed by "+ Tax/PPN/Service: Y" that increases the total to X+Y). Many receipts (very commonly on Indonesian retail receipts) instead print item prices that ALREADY include tax, and show a separate tax breakdown table near the bottom (e.g. "Pajak/PPN Tarif", "DPP", "NBKP", "PPN") purely for informational/reporting purposes — that breakdown is NOT an additional charge. Before deciding on receipt_tax, mentally sum the line item prices: if that sum already equals (or is very close to) the printed total, the tax is already included in the item prices and receipt_tax MUST be 0, even if a tax breakdown table is visible. Only report a nonzero receipt_tax when adding it to the item prices is actually necessary to reach the printed total. The same logic applies to receipt_discount: only report it nonzero if a discount amount is visibly subtracted from a subtotal to reach a smaller final total, not for prices that are already shown net of any per-item promotional pricing.`;

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    merchant: {
      type: 'string',
      // Left undescribed until 2026-09-07, when a receipt was booked against
      // "Ruko D'Bali" -- the shophouse complex printed in the header -- rather
      // than the restaurant, Bahagia Chinese Food. With no description the
      // model was inferring the field's meaning from its name alone, and a
      // header commonly carries the business, its address and its branch on
      // consecutive lines.
      //
      // The stability sentence is doing separate work: the same Holland Bakery
      // photo returned "HOLLAND BAKERY" and then "HOLLAND BAKERY PONDOK
      // BAMBU" twenty minutes apart, which is what defeated merchantMemory.
      description: `The BUSINESS name, as the business trades under. NOT its address, NOT the mall, shophouse, plaza or complex it sits in, and NOT a branch or outlet suffix. A receipt header often carries several of these on consecutive lines — choose the one naming the business itself. For example "Bahagia Chinese Food", not "Ruko D'Bali"; "Holland Bakery", not "Holland Bakery Pondok Bambu". Report the same name for the same shop every time, so two photos of one merchant agree.`,
    },
    // Required, like every other field, because Gemini's responseSchema has no
    // optional. So the ABSENCE of a date needs a legal value to report, or the
    // model has to invent one -- and it does. A Gocar receipt on 2026-09-09
    // showed only "Hari ini, 16:51" and came back dated 2026-06-06, a date
    // that appears nowhere on the image. `entry.tsx` treats an empty string as
    // "no date" and leaves the field on today, which is the right answer for a
    // receipt that says "today".
    date: {
      type: 'string',
      description: 'The calendar date printed on the receipt, as YYYY-MM-DD. Return an EMPTY STRING if the receipt shows no explicit calendar date — one that says only "today", "hari ini", "kemarin" or a bare time of day has no date to read. Never infer, guess or complete a date that is not printed; an empty string is always better than a plausible invention.',
    },
    currency: { type: 'string', description: 'e.g. IDR, USD' },
    receipt_type: {
      type: 'string',
      enum: ['purchase', 'topup'],
      description:
        "'topup' for an e-wallet/bank topup or transfer confirmation (money moving into the user's own e-wallet, not a merchant purchase). 'purchase' for every other, normal receipt — the common case.",
    },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: {
            type: 'number',
            description: 'The TOTAL price for this line (quantity x unit price if the receipt shows a per-unit price), never just the per-unit price.',
          },
          suggested_category: { type: 'string' },
        },
        required: ['name', 'price', 'suggested_category'],
      },
    },
    receipt_discount: {
      type: 'number',
      description: 'Amount subtracted from the item subtotal to reach the printed total. 0 if none — do not report a discount already reflected in item prices.',
    },
    receipt_tax: {
      type: 'number',
      description: 'Amount ADDED to the item subtotal to reach the printed total. 0 if item prices already include tax (common on Indonesian receipts with a PPN/DPP breakdown table) — that breakdown is informational, not an additional charge.',
    },
    printed_total: { type: 'number' },
  },
  required: [
    'merchant',
    'date',
    'currency',
    'receipt_type',
    'items',
    'receipt_discount',
    'receipt_tax',
    'printed_total',
  ],
};
