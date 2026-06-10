// ─────────────────────────────────────────────────────────────────────────────
// THE EXCLUSIVE RESERVATION LOCK (spec §7) — the crown jewel.
//
// Two testers on one TV = two control connections fighting over a single authorized
// vendor session; the second BREAKS the first. So the lock protects the device
// connection itself, not just UX. It MUST be server-side and atomic: claiming is ONE
// statement. Check-then-set in two steps is the classic race bug.
//
// This service touches ONLY the reservations table — no event emission, no status
// recompute — so it stays trivially testable in isolation. Orchestration (recompute TV
// status, emit events, tear down media/control) lives in the route + reconcile layers.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from "node:crypto";
import type { Reservation } from "@device-lab/contracts";
import type { DbPool } from "../db.js";
import { iso } from "../db.js";

interface ReservationRow {
  tv_id: string;
  held_by: string;
  session_id: string;
  acquired_at: Date;
  lock_expires_at: Date;
  hard_expires_at: Date;
}

function toReservation(r: ReservationRow): Reservation {
  return {
    tv_id: r.tv_id,
    held_by: r.held_by,
    session_id: r.session_id,
    acquired_at: iso(r.acquired_at)!,
    lock_expires_at: iso(r.lock_expires_at)!,
    hard_expires_at: iso(r.hard_expires_at)!,
  };
}

export type AcquireResult =
  | { acquired: true; reservation: Reservation; resumed: boolean }
  | {
      acquired: false;
      held_by: string;
      lock_expires_at: string;
      hard_expires_at: string;
    };

export type RenewResult =
  | { ok: true; lock_expires_at: string; hard_expires_at: string }
  | { ok: false; reason: "not_holder" | "expired" };

export class ReservationService {
  constructor(
    private readonly pool: DbPool,
    private readonly leaseSeconds: number,
    private readonly hardSeconds: number,
  ) {}

  /**
   * Atomically claim the lock. ONE statement — whoever's row write succeeds wins.
   *
   *  - Free / dead lease / past hard ceiling  -> acquired (fresh session).
   *  - Already held by the SAME user, lease still live -> resumed (same session_id +
   *    original hard ceiling kept; only the lease is renewed). This is the reconnect-grace
   *    path (spec §7.3): a Wi-Fi blip or tab reload must not lock you out of your own TV.
   *  - Held by SOMEONE ELSE with a live lease -> not acquired; returns holder + ETA for
   *    the "in use by … until …" UI (never a dead grey button).
   *
   * The CASE expressions decide resume-vs-fresh; the WHERE decides who may write at all.
   * Crucially the "it's mine" branch ALSO requires the hard ceiling to be in the future —
   * a session past its hard window cannot renew itself.
   */
  async acquire(tvId: string, userId: string): Promise<AcquireResult> {
    const candidateSession = randomUUID();
    const sql = `
      INSERT INTO reservations (tv_id, held_by, session_id, lock_expires_at, hard_expires_at)
      VALUES ($1, $2, $3,
              now() + ($4 || ' seconds')::interval,
              now() + ($5 || ' seconds')::interval)
      ON CONFLICT (tv_id) DO UPDATE
        SET held_by = EXCLUDED.held_by,
            session_id = CASE
              WHEN reservations.held_by = EXCLUDED.held_by
               AND reservations.lock_expires_at > now()
              THEN reservations.session_id ELSE EXCLUDED.session_id END,
            acquired_at = CASE
              WHEN reservations.held_by = EXCLUDED.held_by
               AND reservations.lock_expires_at > now()
              THEN reservations.acquired_at ELSE now() END,
            hard_expires_at = CASE
              WHEN reservations.held_by = EXCLUDED.held_by
               AND reservations.lock_expires_at > now()
              THEN reservations.hard_expires_at ELSE EXCLUDED.hard_expires_at END,
            lock_expires_at = EXCLUDED.lock_expires_at
        WHERE reservations.lock_expires_at < now()        -- steal a dead lease
           OR reservations.hard_expires_at < now()        -- or one past the hard ceiling
           OR (reservations.held_by = EXCLUDED.held_by     -- or it's already mine…
               AND reservations.hard_expires_at > now())   -- …and still within my window
      RETURNING tv_id, held_by, session_id, acquired_at, lock_expires_at, hard_expires_at;
    `;
    const res = await this.pool.query<ReservationRow>(sql, [
      tvId,
      userId,
      candidateSession,
      this.leaseSeconds,
      this.hardSeconds,
    ]);

    if (res.rowCount === 1) {
      const row = res.rows[0]!;
      const reservation = toReservation(row);
      // Resume == we kept a session_id other than the fresh candidate we proposed.
      const resumed = row.session_id !== candidateSession;
      return { acquired: true, reservation, resumed };
    }

    // 0 rows: someone else holds a live lock. Fetch holder for the 409 body (best-effort).
    const cur = await this.getActive(tvId);
    if (cur) {
      return {
        acquired: false,
        held_by: cur.held_by,
        lock_expires_at: cur.lock_expires_at,
        hard_expires_at: cur.hard_expires_at,
      };
    }
    // Extremely rare race: holder released between our INSERT and this SELECT. Retry once.
    return this.acquire(tvId, userId);
  }

  /** Renew the short lease (heartbeat path). Cannot revive a lapsed lease or exceed hard. */
  async renew(tvId: string, sessionId: string): Promise<RenewResult> {
    const sql = `
      UPDATE reservations
         SET lock_expires_at = now() + ($3 || ' seconds')::interval
       WHERE tv_id = $1 AND session_id = $2
         AND lock_expires_at > now()
         AND hard_expires_at > now()
      RETURNING lock_expires_at, hard_expires_at;
    `;
    const res = await this.pool.query<{
      lock_expires_at: Date;
      hard_expires_at: Date;
    }>(sql, [tvId, sessionId, this.leaseSeconds]);
    if (res.rowCount === 1) {
      const row = res.rows[0]!;
      return {
        ok: true,
        lock_expires_at: iso(row.lock_expires_at)!,
        hard_expires_at: iso(row.hard_expires_at)!,
      };
    }
    // Distinguish "you never held it" from "your lease/ceiling lapsed".
    const stillThere = await this.pool.query(
      "SELECT 1 FROM reservations WHERE tv_id = $1 AND session_id = $2",
      [tvId, sessionId],
    );
    return {
      ok: false,
      reason: stillThere.rowCount ? "expired" : "not_holder",
    };
  }

  /** Explicit release. Only the holding session may release its own lock. */
  async release(tvId: string, sessionId: string): Promise<boolean> {
    const res = await this.pool.query(
      "DELETE FROM reservations WHERE tv_id = $1 AND session_id = $2 RETURNING tv_id",
      [tvId, sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Admin override for a genuinely stuck lock. Returns the prior holder, if any. */
  async forceRelease(tvId: string): Promise<{ held_by: string } | null> {
    const res = await this.pool.query<{ held_by: string }>(
      "DELETE FROM reservations WHERE tv_id = $1 RETURNING held_by",
      [tvId],
    );
    return res.rowCount ? { held_by: res.rows[0]!.held_by } : null;
  }

  /**
   * Reap dead locks (lease lapsed OR past hard ceiling). The acquire() statement already
   * auto-steals these, but the reconcile loop deletes them so the TV flips to `free`
   * promptly and we can emit a release event even when nobody is waiting to re-acquire.
   * Returns the freed TVs.
   */
  async expireStale(): Promise<Array<{ tv_id: string; held_by: string }>> {
    const res = await this.pool.query<{ tv_id: string; held_by: string }>(
      `DELETE FROM reservations
        WHERE lock_expires_at < now() OR hard_expires_at < now()
        RETURNING tv_id, held_by`,
    );
    return res.rows;
  }

  /** The live reservation for a TV, or null if none / lapsed. */
  async getActive(tvId: string): Promise<Reservation | null> {
    const res = await this.pool.query<ReservationRow>(
      `SELECT tv_id, held_by, session_id, acquired_at, lock_expires_at, hard_expires_at
         FROM reservations
        WHERE tv_id = $1 AND lock_expires_at > now() AND hard_expires_at > now()`,
      [tvId],
    );
    return res.rowCount ? toReservation(res.rows[0]!) : null;
  }

  /**
   * Authorization check for EVERY control call (key press, stream subscribe). A press
   * from a non-holder is a hard 403 — the dashboard is a liar's mirror; never trust it.
   */
  async isHolder(tvId: string, sessionId: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM reservations
        WHERE tv_id = $1 AND session_id = $2
          AND lock_expires_at > now() AND hard_expires_at > now()`,
      [tvId, sessionId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
