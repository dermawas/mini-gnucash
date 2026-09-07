// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Forstra Digital
//
// Deciding, and sanity-checking, the date a scanned receipt is posted under.
//
// Pure and dependency-free on purpose, so it can be exercised for real rather
// than against a re-implementation. That distinction is not academic here:
// `merchantMemory.ts` was verified offline against a copy that was fed stable
// inputs, passed, and then failed on the first phone because the real inputs
// were not stable at all.

/** Today, as YYYY-MM-DD in local time. */
export function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The receipt's own date, or today when it is missing or unparseable. */
export function postDate(receiptDate: string): { date: string; fellBack: boolean } {
  const today = todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receiptDate)) return { date: today, fellBack: true };
  const parsed = new Date(`${receiptDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return { date: today, fellBack: true };
  return { date: receiptDate, fellBack: false };
}

/**
 * Matches `THRESHOLD_DAYS` in `gnucash-date-check.sh` on the hub, which sweeps
 * weekly for a large gap between post_date and enter_date. Keeping the two the
 * same means the app warns about exactly what the server would later flag,
 * rather than the pair drifting apart.
 */
export const DATE_WARN_DAYS = 30;

export function isValidIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) return false;
  // Rejects 2026-02-31, which Date would roll forward into March.
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` === v;
}

/**
 * Why the thresholds are asymmetric.
 *
 * A receipt cannot be for a purchase that has not happened, so ANY future date
 * is wrong -- no tolerance. A past date often is not: a Holland Bakery receipt
 * was legitimately 38 days old when scanned, and refusing that would have been
 * worse than the problem. So the past only warns, and only past the threshold.
 *
 * Written after a real one. On 2026-09-07 the first write to the production
 * book was a GoCar ride that the model dated 2023-10-24 -- 1,049 days out. The
 * splits, accounts and total were all correct; only the date was wrong, and
 * nothing on this screen said so. It had to be fixed with SQL afterwards.
 */
export function dateConcern(date: string): string | null {
  if (!isValidIsoDate(date)) return 'That is not a real date. Use YYYY-MM-DD.';
  const days = Math.round(
    (new Date(`${date}T00:00:00`).getTime() - new Date(`${todayIso()}T00:00:00`).getTime())
      / 86400000,
  );
  if (days > 0) {
    return `This is dated ${days} day${days === 1 ? '' : 's'} in the future. A receipt cannot be, so the date was almost certainly misread — correct it before saving.`;
  }
  if (-days > DATE_WARN_DAYS) {
    return `This is dated ${-days} days ago. That is fine for an old receipt, but check it — a misread year looks exactly like this.`;
  }
  return null;
}
