/**
 * Date helpers. Due dates and overdue calculations are day-granular, so we
 * normalise to local midnight before comparing — a payment made at 23:00 on the
 * due date is not overdue.
 *
 * ## Time zone
 *
 * The institute operates in IST, so every date the system shows or reasons
 * about is IST. Two things make that true:
 *
 *  1. **Display** — the formatters below pin `timeZone` to `Asia/Kolkata`, so a
 *     receipt or report reads the same wherever it is generated, even if the
 *     server happens to run in UTC.
 *  2. **Arithmetic** — `startOfDay`, `daysOverdue` and friends use the process
 *     time zone, so the host must run as IST. `src/instrumentation.ts` sets it
 *     at start-up, because Vercel reserves the `TZ` variable and its serverless
 *     functions start in UTC; `assertIstProcess()` warns loudly if that has not
 *     worked, because a UTC server would put a due date on the wrong side of
 *     midnight for the five and a half hours before IST midnight.
 */

/** The institute's operating time zone. Every displayed date is rendered in it. */
export const TIME_ZONE = "Asia/Kolkata";

/**
 * Warns once at start-up when the process is not running in IST. Date
 * *arithmetic* follows the process zone, so this is a real correctness issue,
 * not a cosmetic one.
 */
export function assertIstProcess(): void {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Asia/Calcutta is the older alias for the same zone.
  if (zone === "Asia/Kolkata" || zone === "Asia/Calcutta") return;
  console.warn(
    `[dates] The process time zone is ${zone}, not ${TIME_ZONE}. Due dates and overdue ` +
      `calculations follow the process zone, so this is wrong by five and a half hours. ` +
      `src/instrumentation.ts sets it at start-up; it has either not run yet or not taken ` +
      `effect. TZ is currently ${JSON.stringify(process.env.TZ)}.`,
  );
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Local midnight on the 1st of `date`'s month. */
export function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

/** The last instant of `date`'s month, so a due date on the 31st still falls inside it. */
export function endOfMonth(date: Date): Date {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + 1);
  d.setDate(0);
  return endOfDay(d);
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const day = d.getDate();
  d.setMonth(d.getMonth() + months);
  // Clamp end-of-month rollovers (31 Jan + 1 month => 28/29 Feb, not 2/3 Mar).
  if (d.getDate() < day) d.setDate(0);
  return d;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / MS_PER_DAY);
}

/** Days a due date is overdue as of `asOf`. Zero when not yet due. */
export function daysOverdue(dueDate: Date, asOf: Date = new Date()): number {
  return Math.max(0, daysBetween(dueDate, asOf));
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: TIME_ZONE });
}

/** "August 2026" — names the month a report was run for, on screen and in exports. */
export function formatMonth(date: Date): string {
  return date.toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: TIME_ZONE });
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: TIME_ZONE,
  });
}

/** `yyyy-MM-dd` for <input type="date"> values. */
export function toDateInput(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse a `yyyy-MM-dd` input value as local midnight. */
export function fromDateInput(value: string): Date {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}
