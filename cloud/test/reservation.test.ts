// ─────────────────────────────────────────────────────────────────────────────
// Crown-jewel suite: the exclusive reservation lock (spec §7). These prove the lock is
// SERVER-SIDE and ATOMIC — two testers can never share one TV — and that all three
// release paths (explicit, TTL lapse, heartbeat-renewed lease) behave as specified.
// Runs against REAL Postgres; atomicity can't be demonstrated against an in-memory shim.
// ─────────────────────────────────────────────────────────────────────────────
import { beforeAll, beforeEach, afterAll, it, expect } from "vitest";
import type pg from "pg";
import { ReservationService } from "../src/services/reservation.js";
import { describeDb, makeTestPool, truncateAll, seedTv, sleep } from "./helpers.js";

describeDb("ReservationService — the exclusive lock", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = await makeTestPool();
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await truncateAll(pool);
    await seedTv(pool, { tvId: "tv-1", bind: true });
  });

  const svc = () => new ReservationService(pool, 120, 2400);

  it("acquires a free TV", async () => {
    const r = await svc().acquire("tv-1", "ravi");
    expect(r.acquired).toBe(true);
    if (r.acquired) {
      expect(r.reservation.held_by).toBe("ravi");
      expect(r.reservation.session_id).toBeTruthy();
      expect(r.resumed).toBe(false);
    }
  });

  it("ATOMIC: 25 distinct users racing for one free TV -> exactly ONE wins", async () => {
    const service = svc();
    const users = Array.from({ length: 25 }, (_, i) => `user-${i}`);
    const results = await Promise.all(users.map((u) => service.acquire("tv-1", u)));
    const winners = results.filter((r) => r.acquired);
    expect(winners.length).toBe(1);
    // Everyone else got a clean conflict pointing at the single holder.
    const losers = results.filter((r) => !r.acquired);
    expect(losers.length).toBe(24);
    for (const l of losers) {
      if (!l.acquired) expect(l.held_by).toBe((winners[0] as any).reservation.held_by);
    }
  });

  it("a second user is blocked while the first holds it (shows holder + ETA)", async () => {
    const service = svc();
    await service.acquire("tv-1", "ravi");
    const second = await service.acquire("tv-1", "mia");
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.held_by).toBe("ravi");
      expect(new Date(second.lock_expires_at).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("reconnect grace: the SAME user re-acquiring RESUMES the same session (not locked out)", async () => {
    const service = svc();
    const first = await service.acquire("tv-1", "ravi");
    if (!first.acquired) throw new Error("setup failed");
    const sid = first.reservation.session_id;
    const hard = first.reservation.hard_expires_at;

    const again = await service.acquire("tv-1", "ravi");
    expect(again.acquired).toBe(true);
    if (again.acquired) {
      expect(again.resumed).toBe(true);
      expect(again.reservation.session_id).toBe(sid); // same session, not a new one
      expect(again.reservation.hard_expires_at).toBe(hard); // original ceiling preserved
    }
  });

  it("TTL steal: once the lease lapses, a DIFFERENT user can claim it (the safety net)", async () => {
    const shortLease = new ReservationService(pool, 1, 2400); // 1s lease
    const a = await shortLease.acquire("tv-1", "ravi");
    expect(a.acquired).toBe(true);
    // Before lapse, mia is blocked.
    expect((await shortLease.acquire("tv-1", "mia")).acquired).toBe(false);
    await sleep(1200);
    // After lapse, mia steals it.
    const stolen = await shortLease.acquire("tv-1", "mia");
    expect(stolen.acquired).toBe(true);
    if (stolen.acquired) expect(stolen.reservation.held_by).toBe("mia");
  });

  it("heartbeat renews the lease for the holder", async () => {
    const shortLease = new ReservationService(pool, 2, 2400);
    const a = await shortLease.acquire("tv-1", "ravi");
    if (!a.acquired) throw new Error("setup failed");
    const before = new Date(a.reservation.lock_expires_at).getTime();
    await sleep(1000);
    const renewed = await shortLease.renew("tv-1", a.reservation.session_id);
    expect(renewed.ok).toBe(true);
    if (renewed.ok) {
      expect(new Date(renewed.lock_expires_at).getTime()).toBeGreaterThan(before);
    }
  });

  it("a non-holder session cannot renew", async () => {
    const service = svc();
    await service.acquire("tv-1", "ravi");
    const r = await service.renew("tv-1", "not-a-real-session");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_holder");
  });

  it("cannot renew a lapsed lease", async () => {
    const shortLease = new ReservationService(pool, 1, 2400);
    const a = await shortLease.acquire("tv-1", "ravi");
    if (!a.acquired) throw new Error("setup failed");
    await sleep(1200);
    const r = await shortLease.renew("tv-1", a.reservation.session_id);
    expect(r.ok).toBe(false); // lease is gone; this session can't revive it
  });

  it("cannot renew past the HARD ceiling even with a live lease", async () => {
    const shortHard = new ReservationService(pool, 60, 1); // long lease, 1s hard ceiling
    const a = await shortHard.acquire("tv-1", "ravi");
    if (!a.acquired) throw new Error("setup failed");
    await sleep(1200);
    const r = await shortHard.renew("tv-1", a.reservation.session_id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("expired");
  });

  it("explicit release frees the TV; a non-holder cannot release it", async () => {
    const service = svc();
    const a = await service.acquire("tv-1", "ravi");
    if (!a.acquired) throw new Error("setup failed");

    expect(await service.release("tv-1", "wrong-session")).toBe(false); // not yours
    expect(await service.isHolder("tv-1", a.reservation.session_id)).toBe(true);

    expect(await service.release("tv-1", a.reservation.session_id)).toBe(true);
    expect(await service.isHolder("tv-1", a.reservation.session_id)).toBe(false);
    // Now someone else can take it.
    expect((await service.acquire("tv-1", "mia")).acquired).toBe(true);
  });

  it("admin force-release frees a stuck lock and returns the prior holder", async () => {
    const service = svc();
    await service.acquire("tv-1", "ravi");
    const prior = await service.forceRelease("tv-1");
    expect(prior?.held_by).toBe("ravi");
    expect(await service.getActive("tv-1")).toBeNull();
  });

  it("expireStale reaps lapsed AND hard-expired locks and reports them freed", async () => {
    // Lapsed lease.
    await seedTv(pool, { tvId: "tv-2", cameraId: "cam-2", bind: true });
    const shortLease = new ReservationService(pool, 1, 2400);
    await shortLease.acquire("tv-1", "ravi");
    // Past hard ceiling.
    const shortHard = new ReservationService(pool, 60, 1);
    await shortHard.acquire("tv-2", "mia");

    await sleep(1300);
    const freed = await new ReservationService(pool, 1, 1).expireStale();
    const freedIds = freed.map((f) => f.tv_id).sort();
    expect(freedIds).toEqual(["tv-1", "tv-2"]);
  });

  it("isHolder gates control calls: only the live holding session passes", async () => {
    const service = svc();
    const a = await service.acquire("tv-1", "ravi");
    if (!a.acquired) throw new Error("setup failed");
    expect(await service.isHolder("tv-1", a.reservation.session_id)).toBe(true);
    expect(await service.isHolder("tv-1", "someone-elses-session")).toBe(false);
  });
});
