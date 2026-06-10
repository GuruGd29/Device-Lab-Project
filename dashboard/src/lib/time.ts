// Lease/countdown formatting helpers. Reservation expiries are ISO8601 strings (domain.ts);
// the dashboard renders "~Nm left" on cards (spec §7 "In use by Ravi, ~22 min left") and a
// live mm:ss countdown in the device view.

/** Whole minutes remaining until an ISO timestamp, clamped at 0. */
export function minutesLeft(isoExpiry: string, now: number = Date.now()): number {
  const ms = new Date(isoExpiry).getTime() - now;
  return Math.max(0, Math.round(ms / 60000));
}

/** Milliseconds remaining until an ISO timestamp, clamped at 0. */
export function msLeft(isoExpiry: string, now: number = Date.now()): number {
  return Math.max(0, new Date(isoExpiry).getTime() - now);
}

/** mm:ss countdown string. */
export function formatCountdown(isoExpiry: string, now: number = Date.now()): string {
  const totalSeconds = Math.floor(msLeft(isoExpiry, now) / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Human local time, e.g. "3:42:09 PM" — used in "in use until <time>". */
export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}
