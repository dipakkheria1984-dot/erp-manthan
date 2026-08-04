/**
 * Runs once per server instance, before any request is handled.
 *
 * Its only job is the time zone. The institute operates in IST and date
 * *arithmetic* — due dates, days overdue, the boundary a late-fee slab is
 * measured from — follows the process zone, so a server running in UTC puts
 * due dates on the wrong side of midnight for the five and a half hours before
 * IST midnight.
 *
 * Setting `TZ` in the environment would be the obvious fix, but Vercel reserves
 * that variable name and rejects it. Node re-reads the zone whenever
 * `process.env.TZ` is assigned, so doing it here — before the server takes any
 * traffic — achieves the same thing wherever the app is hosted.
 *
 * `assertIstProcess()` in src/lib/env.ts still warns if this has somehow not
 * taken effect by the time that module loads.
 */
export function register() {
  // Assigning TZ is a Node API; on the Edge runtime there is nothing to set.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Respect an explicitly configured zone on hosts that do allow TZ.
  if (process.env.TZ) return;

  process.env.TZ = "Asia/Kolkata";
}
