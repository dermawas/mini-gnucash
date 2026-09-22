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
// Changed 2026-09-17, when the scanner learned to take SEVERAL pictures of one
// receipt. One edit, the OVERLAP paragraph below, and it is the whole reason
// the feature needs a prompt change at all.
//
// Consecutive phone screenshots of a long receipt are not clean pages. They
// repeat: the status bar and the app's own header sit at the top of every
// shot, a fixed button bar at the bottom of every shot, and the scroll
// position rarely lands so that one shot ends exactly where the next begins.
// A real example, a Klik Indomaret order screenshotted in three, had its total
// visible on two of them -- once as "Total Rp128.200" under the basket and
// again as "Total Pembayaran Rp128.200" in the payment block. Those are the
// same money. Told nothing, a model can read a repeated line as a second
// purchase of the same thing, which lands as a duplicate row in the ledger.
//
// Nothing about prices, tax, modifiers or quantity lines was touched here
// either. The arithmetic still happens in allocate.ts.
//
// Changed 2026-09-22, when the scanner was given the chart of accounts. Until
// then it could only name a loose category ("Groceries"), and accountMatch.ts
// had to guess the account from shared words: six items on one Indomaret
// receipt all came back "Groceries", and the book has fourteen accounts under
// Groceries. Now `buildExtractionPrompt` adds the list of accounts the entry can
// use, and the owner's own notes, and every item names one of those accounts.
// NOTHING ABOVE WAS EDITED. Both additions are appended after the extraction
// rules, so the hard-won part reads exactly as it did. The same text goes to
// Gemini and to Claude, so an account never depends on which one answered.
//
// Keep this file import-free (pure strings and plain objects) so it stays
// portable and trivially testable.

export const EXTRACTION_PROMPT = `Extract structured data from this receipt. It may be a photograph of a printed receipt, a screenshot of a digital one, or a PDF invoice or e-receipt. If a PDF runs to more than one page but describes ONE purchase (an invoice with its terms, or a long itemised till roll), read every page as a single receipt.

SEVERAL PICTURES: you may be given more than one image. When you are, they are pieces of ONE receipt, given in reading order, the top of the receipt first. Read them as a single continuous document, not as separate receipts, and return ONE result covering all of them.

The pieces usually OVERLAP, because they are screenshots taken while scrolling. The same line item, subtotal, discount or total can therefore appear on two consecutive images. Every such repeat is the SAME thing seen twice, never a second one: count it ONCE. In particular, if a total appears under the item list on one image and again in a payment summary on the next, that is one total, not two.

Ignore anything that belongs to the phone or the app rather than to the receipt, and expect it to repeat on every image: the status bar (clock, battery, signal), the app's title or navigation bar, and any fixed button at the bottom of the screen. A row cut in half at the edge of one image is normally whole on the neighbouring one; read it there rather than guessing at it, and never report a price you could only see part of.

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
          // Checked against the real accounts on the phone before it is
          // offered, so a name the model made up is simply not used.
          account: {
            type: 'string',
            description: 'The one entry from the ACCOUNT LIST this item should be booked to, copied exactly. An empty string if none fits.',
          },
        },
        required: ['name', 'price', 'suggested_category', 'account'],
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

/** Long enough for a paragraph of rules, short enough that it cannot crowd out the receipt. */
export const MAX_SCAN_NOTE = 1000;

/**
 * The extraction rules above, then the accounts this entry can use, then the
 * owner's own notes.
 *
 * `accounts` are full paths, `03-Expenses:Groceries:Bread`, already narrowed to
 * the funding account's currency: offering one the entry could not be saved to
 * would be offering a dead end. The whole book's expense list is about 7 KB, so
 * it goes every time rather than being guessed down first.
 *
 * The notes are for what no receipt says. A Grab ride in Bandung belongs to a
 * business, and the same ride in Jakarta does not; only the person keeping the
 * book knows that, so they get to say it once and have it apply to every scan.
 */
export function buildExtractionPrompt(accounts: string[], note: string): string {
  const list = accounts.length
    ? accounts.join('\n')
    : '(none: give an empty string for every account)';
  let prompt = `${EXTRACTION_PROMPT}

ACCOUNT: for each item, also give \`account\`, the one entry from the ACCOUNT LIST below that this item should be booked to, copied exactly, character for character. If no entry fits well, give an empty string. Never make up an account that is not in the list. Still give suggested_category as well.

ACCOUNT LIST:
${list}`;

  const trimmed = note.trim().slice(0, MAX_SCAN_NOTE);
  if (trimmed) {
    prompt += `

NOTES FROM THE PERSON WHO KEEPS THIS BOOK. They know things a receipt does not show, such as what a purchase was for. Follow them when choosing an account:
${trimmed}`;
  }
  return prompt;
}
