import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { WebSocketServer } from "ws";
import type { AppContext } from "./context.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerRegistryRoutes } from "./routes/registry.js";
import { registerBindingRoutes } from "./routes/binding.js";
import { registerReservationRoutes } from "./routes/reservation.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";
import { registerBuildRoutes } from "./routes/builds.js";
import { registerTvActionRoutes } from "./routes/tvActions.js";
import { log } from "./lib/log.js";

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  await app.register(cors, { origin: true, credentials: true });
  // Build uploads stream to disk; cap at the configured max.
  await app.register(multipart, { limits: { fileSize: ctx.config.maxUploadBytes, files: 1 } });

  app.get("/healthz", async (_req, reply) => {
    // Liveness + DB reachability — used by docker-compose and load balancers.
    try {
      await ctx.pool.query("SELECT 1");
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: String(err) });
    }
  });

  registerAuthRoutes(app, ctx);
  registerRegistryRoutes(app, ctx);
  registerBindingRoutes(app, ctx);
  registerReservationRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);
  registerBuildRoutes(app, ctx);
  registerTvActionRoutes(app, ctx);

  // ── WebSocket endpoints: /agent (control tunnel) and /dashboard (presence + signaling) ──
  // Both use noServer mode; we route the HTTP upgrade by pathname. Media never flows here.
  const agentWss = new WebSocketServer({ noServer: true });
  const dashboardWss = new WebSocketServer({ noServer: true });
  agentWss.on("connection", (ws) => ctx.agentHub.handleConnection(ws));
  dashboardWss.on("connection", (ws) => ctx.dashboardHub.handleConnection(ws));

  app.server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (pathname === "/agent") {
      agentWss.handleUpgrade(request, socket, head, (ws) => agentWss.emit("connection", ws, request));
    } else if (pathname === "/dashboard") {
      dashboardWss.handleUpgrade(request, socket, head, (ws) =>
        dashboardWss.emit("connection", ws, request),
      );
    } else {
      socket.destroy();
    }
  });

  app.addHook("onClose", async () => {
    agentWss.close();
    dashboardWss.close();
    log.info("websocket servers closed");
  });

  return app;
}
