import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CreateBindingResponse } from "@device-lab/contracts";
import type { AppContext } from "../context.js";
import { makeAuth } from "../http/middleware.js";

const CreateBindingBody = z.object({ camera_id: z.string().min(1) });

// Binding / calibration (spec §11). Calibrate = QR handshake; binding = manual confirm.
export function registerBindingRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = makeAuth(ctx.config);

  // POST /tvs/:id/calibrate — run the QR handshake; binding auto-written on a clean match.
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/calibrate",
    { preHandler: requireAuth },
    async (req, reply) => {
      if (!ctx.agentHub) {
        return reply.code(503).send({ error: "no_agent", message: "no lab agent connected" });
      }
      const result = await ctx.calibration.calibrate(req.params.id, req.user!.id);
      return reply.send(result);
    },
  );

  // POST /tvs/:id/binding { camera_id } — manual confirm fallback.
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/binding",
    { preHandler: requireAuth },
    async (req, reply) => {
      const parsed = CreateBindingBody.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "bad_request", message: "camera_id required" });
      }
      const r = await ctx.bindings.createManual(
        req.params.id,
        parsed.data.camera_id,
        req.user!.id,
      );
      if (!r.ok) {
        return reply.code(404).send({ error: r.reason, message: `binding failed: ${r.reason}` });
      }
      const body: CreateBindingResponse = {
        tv_id: req.params.id,
        camera_id: parsed.data.camera_id,
        method: "manual_confirm",
      };
      return reply.send(body);
    },
  );

  // DELETE /tvs/:id/binding — unassign (sever the link).
  app.delete<{ Params: { id: string } }>(
    "/tvs/:id/binding",
    { preHandler: requireAuth },
    async (req, reply) => {
      await ctx.bindings.unassign(req.params.id);
      return reply.send({ ok: true });
    },
  );
}
