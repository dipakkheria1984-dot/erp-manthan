/**
 * Money handling.
 *
 * Every amount in the database is an integer number of paise (₹1 = 100 paise).
 * Nothing in this system should ever hold a rupee value in a float — parse at
 * the edge with `rupeesToPaise`, format at the edge with `formatPaise`.
 */

export const PAISE_PER_RUPEE = 100;

export function rupeesToPaise(rupees: number | string): number {
  const value = typeof rupees === "string" ? Number(rupees.replace(/,/g, "")) : rupees;
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid amount: ${rupees}`);
  }
  return Math.round(value * PAISE_PER_RUPEE);
}

export function paiseToRupees(paise: number): number {
  return paise / PAISE_PER_RUPEE;
}

const inrFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "₹1,23,456.00" — for UI and PDFs. */
export function formatPaise(paise: number): string {
  return inrFormatter.format(paiseToRupees(paise));
}

/** "123456.00" — for CSV/Excel cells that should stay numeric-ish. */
export function formatPaisePlain(paise: number): string {
  return paiseToRupees(paise).toFixed(2);
}

const inrNumberFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * "₹1,23,456.00" for PDFs.
 *
 * PDFs embed DejaVu Sans (see src/lib/pdf.ts), which has ₹ (U+20B9), so this
 * matches the on-screen formatting. It stays a separate function because PDF
 * output is the one place a missing glyph is silent rather than obvious.
 */
export function formatPaisePdf(paise: number): string {
  return `₹${inrNumberFormatter.format(paiseToRupees(paise))}`;
}

/**
 * Split `totalPaise` into `count` installments without losing or inventing a
 * single paisa: the remainder is spread one paisa at a time across the earliest
 * installments.
 */
export function splitPaise(totalPaise: number, count: number): number[] {
  if (count < 1) throw new Error("Installment count must be at least 1");
  const base = Math.floor(totalPaise / count);
  const remainder = totalPaise - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Percentage of an amount, rounded to the nearest paisa. */
export function percentOf(paise: number, percent: number): number {
  return Math.round((paise * percent) / 100);
}
