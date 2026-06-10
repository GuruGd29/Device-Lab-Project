import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  ReleaseRequest,
  ReservationHeartbeatResponse,
  ReserveResponse,
} from "@device-lab/contracts";
import type { AppContext } from "../context.js";
import { makeAuth } from "../http/middleware.js";
import { log } from "../lib/log.js";

const SessionBody = z.object({ session_id: z.string().min(1) });

// Reservation lock endpoints (spec §7 + §11). The atomic logic lives in ReservationService;
// these handlers orchestrate the side effects: recompute TV status (free<->in_use) and push
// reservation events so every dashboard updates its "in use by … until …" UI live.
export function registerReservationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth, requireAdmin } = makeAuth(ctx.config);

  // POST /tvs/:id/reserve — atomic claim. 200 on acquire/resume, 409 if held by someone else.
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/reserve",
    { preHandler: requireAuth },
    async (req, reply) => {
      const tvId = req.params.id;
      const result = await ctx.reservations.acquire(tvId, req.user!.id);
      if (!result.acquired) {
        const body: ReserveResponse = {
          ok: false,
          held_by: result.held_by,
          lock_expires_at: result.lock_expires_at,
          hard_expires_at: result.hard_expires_at,
        };
        return reply.code(409).send(body);
      }
      const r = result.reservation;
      await ctx.registry.recomputeAndStore(tvId); // free -> in_use, emits tv.updated
      ctx.events.emit("reservation.updated", {
        tv_id: tvId,
        reservation: {
          held_by: r.held_by,
          lock_expires_at: r.lock_expires_at,
          hard_expires_at: r.hard_expires_at,
        },
      });
      // Make sure the persistent vendor control session is warm before keys fly.
      ctx.agentHub.connectTv(tvId).catch(() => {});
      log.info(result.resumed ? "reservation resumed" : "reservation acquired", {
        tv_id: tvId,
        held_by: r.held_by,
      });
      const body: ReserveResponse = {
        ok: true,
        session_id: r.session_id,
        lock_expires_at: r.lock_expires_at,
        hard_expires_at: r.hard_expires_at,
      };
      return reply.send(body);
    },
  );

  // POST /tvs/:id/heartbeat { session_id } — renew the short lease.
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/heartbeat",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = SessionBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", message: "session_id required" });
      }
      const r = await ctx.reservations.renew(req.params.id, parsed.data.session_id);
      if (!r.ok) {
        const body: ReservationHeartbeatResponse = { ok: false, reason: r.reason };
        return reply.code(409).send(body);
      }
      ctx.events.emit("reservation.updated", {
        tv_id: req.params.id,
        reservation: {
          held_by: req.user!.id,
          lock_expires_at: r.lock_expires_at,
          hard_expires_at: r.hard_expires_at,
        },
      });
      const body: ReservationHeartbeatResponse = { ok: true, lock_expires_at: r.lock_expires_at };
      return reply.send(body);
    },
  );

  // POST /tvs/:id/release { session_id } — explicit release.
  app.post<{ Params: { id: string }; Body: ReleaseRequest }>(
    "/tvs/:id/release",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = SessionBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", message: "session_id required" });
      }
      const released = await ctx.reservations.release(req.params.id, parsed.data.session_id);
      if (released) await emitFreed(ctx, req.params.id);
      return reply.send({ ok: released });
    },
  );

  // POST /tvs/:id/force-release — admin override for a genuinely stuck lock.
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/force-release",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const prior = await ctx.reservations.forceRelease(req.params.id);
      await emitFreed(ctx, req.params.id);
      log.warn("force-release", { tv_id: req.params.id, prior_holder: prior?.held_by, by: req.user!.id });
      return reply.send({ ok: true, prior_holder: prior?.held_by ?? null });
    },
  );
}

async function emitFreed(ctx: AppContext, tvId: string): Promise<void> {
  await ctx.registry.recomputeAndStore(tvId); // in_use -> free, emits tv.updated
  ctx.events.emit("reservation.updated", { tv_id: tvId, reservation: null });
}
