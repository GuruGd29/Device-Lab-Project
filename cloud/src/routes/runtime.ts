import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isRemoteKey } from "@device-lab/contracts";
import type {
  KeyPressResponse,
  StreamResponse,
  TestBlockReason,
} from "@device-lab/contracts";
import type { AppContext } from "../context.js";
import { makeAuth } from "../http/middleware.js";

const KeyBody = z.object({ session_id: z.string().min(1), key: z.string() });

// Runtime loop (spec §6 + §11): resolve a TV's stream, and relay soft-remote keys —
// EVERY control call is validated against the lock holder.
export function registerRuntimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = makeAuth(ctx.config);

  // GET /tvs/:id/stream — resolve binding -> sfu track + signaling url. Blocks (with the
  // reason) if there's no healthy bound camera or the TV is unreachable.
  app.get<{ Params: { id: string } }>(
    "/tvs/:id/stream",
    { preHandler: requireAuth },
    async (req, reply) => {
      const tvId = req.params.id;
      const tv = await ctx.registry.getTvView(tvId, req.user!.id);
      if (!tv) return reply.code(404).send({ error: "not_found", message: "no such tv" });

      const block = (reason: TestBlockReason): StreamResponse => ({ blocked: true, reason });
      if (tv.status === "offline") return reply.send(block("tv_offline"));
      if (!tv.binding) return reply.send(block("no_binding"));
      if (tv.binding.camera_status === "offline") return reply.send(block("camera_offline"));
      if (tv.binding.camera_status === "unhealthy" || tv.status === "unhealthy") {
        return reply.send(block("camera_unhealthy"));
      }

      const cam = await ctx.pool.query<{ sfu_publish_track: string | null }>(
        "SELECT sfu_publish_track FROM cameras WHERE camera_id = $1",
        [tv.binding.camera_id],
      );
      const sfuTrack = cam.rows[0]?.sfu_publish_track;
      if (!sfuTrack) return reply.send(block("camera_unhealthy"));

      const body: StreamResponse = {
        tv_id: tvId,
        camera_id: tv.binding.camera_id,
        sfu_track: sfuTrack,
        signaling_url: dashboardWsUrl(req),
        host_agent_id: tv.host_agent_id,
      };
      return reply.send(body);
    },
  );

  // POST /tvs/:id/key { session_id, key } — relay a normalized key. 403 from a non-holder.
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/key",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = KeyBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", message: "session_id and key required" });
      }
      const { session_id, key } = parsed.data;
      if (!isRemoteKey(key)) {
        const body: KeyPressResponse = { ok: false, reason: "unsupported_key" };
        return reply.code(400).send(body);
      }
      // The lock protects the device connection itself — a press from a non-holder is 403.
      const holder = await ctx.reservations.isHolder(req.params.id, session_id);
      if (!holder) {
        const body: KeyPressResponse = { ok: false, reason: "not_holder" };
        return reply.code(403).send(body);
      }
      try {
        const ack = await ctx.agentHub.pressKey(req.params.id, key);
        const body: KeyPressResponse = ack.ok
          ? { ok: true }
          : { ok: false, reason: "tv_unreachable" };
        return reply.code(ack.ok ? 200 : 502).send(body);
      } catch {
        const body: KeyPressResponse = { ok: false, reason: "tv_unreachable" };
        return reply.code(502).send(body);
      }
    },
  );
}

function dashboardWsUrl(req: { headers: Record<string, unknown>; protocol: string }): string {
  const host = (req.headers["host"] as string) ?? "localhost:8080";
  const wsProto = req.protocol === "https" ? "wss" : "ws";
  return `${wsProto}://${host}/dashboard`;
}
