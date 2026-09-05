// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital

export const CURRENCIES: Record<string, { symbol: string; name: string; locale: string }> = {
  IDR: { symbol: 'Rp', name: 'Indonesian Rupiah', locale: 'id-ID' },
  USD: { symbol: '$', name: 'US Dollar', locale: 'en-US' },
  EUR: { symbol: '€', name: 'Euro', locale: 'de-DE' },
  SGD: { symbol: 'S$', name: 'Singapore Dollar', locale: 'en-SG' },
  GBP: { symbol: '£', name: 'British Pound', locale: 'en-GB' },
  MYR: { symbol: 'RM', name: 'Malaysian Ringgit', locale: 'ms-MY' },
  AUD: { symbol: 'A$', name: 'Australian Dollar', locale: 'en-AU' },
  JPY: { symbol: '¥', name: 'Japanese Yen', locale: 'ja-JP' },
};

export function formatCurrency(amount: number, currency: string = 'IDR'): string {
  const config = CURRENCIES[currency] ?? CURRENCIES.IDR;
  return new Intl.NumberFormat(config.locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: currency === 'IDR' || currency === 'JPY' ? 0 : 2,
  }).format(amount);
}

export function formatAmount(amount: number, currency: string = 'IDR'): string {
  const config = CURRENCIES[currency] ?? CURRENCIES.IDR;
  return `${config.symbol} ${new Intl.NumberFormat(config.locale).format(amount)}`;
}

export function parseCurrencyInput(input: string): number {
  const cleaned = input.replace(/[^0-9.]/g, '');
  return parseFloat(cleaned) || 0;
}

function getLocaleSeparators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale).formatToParts(1234.5);
  return {
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
  };
}

// Live-formats a raw numeric string (digits + at most one '.') into the
// thousand-separated display form for the given currency's locale, e.g.
// "1000000" -> "1.000.000" for IDR (id-ID uses '.' as the group separator)
// or "1,000,000" for USD. Keeps a trailing decimal point/partial fraction
// as typed rather than dropping it, so it doesn't fight the user mid-entry.
export function formatAmountInput(raw: string, currency: string = 'IDR'): string {
  if (!raw) return '';
  const config = CURRENCIES[currency] ?? CURRENCIES.IDR;
  const { group, decimal } = getLocaleSeparators(config.locale);
  // A leading '-' shows up when editing a receipt-scanned voided/negative
  // line item (see GitHub issue #7) — the numeric keyboard itself never
  // lets a user type one, so this only ever reflects a value that started
  // out negative.
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [intPart, decPart] = unsigned.split('.');
  const groupedInt = (intPart || '').replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const formatted = decPart !== undefined ? `${groupedInt}${decimal}${decPart}` : groupedInt;
  return negative ? `-${formatted}` : formatted;
}

// Inverse of formatAmountInput: strips locale-specific group/decimal
// separators back out of whatever the TextInput reports, returning a plain
// digits-plus-'.' string safe to hand to parseFloat. Used as the onChangeText
// bridge so the underlying stored value never depends on locale formatting.
export function cleanAmountInput(formatted: string, currency: string = 'IDR'): string {
  const config = CURRENCIES[currency] ?? CURRENCIES.IDR;
  const { group, decimal } = getLocaleSeparators(config.locale);
  const negative = formatted.trim().startsWith('-');
  let cleaned = formatted.split(group).join('');
  if (decimal !== '.') {
    cleaned = cleaned.split(decimal).join('.');
  }
  cleaned = cleaned.replace(/[^0-9.]/g, '');
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }
  return negative ? `-${cleaned}` : cleaned;
}