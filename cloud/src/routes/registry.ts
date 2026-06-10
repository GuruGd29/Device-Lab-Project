import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { makeAuth } from "../http/middleware.js";

// Registry / pools (spec §11): the two-pool view the dashboard renders.
export function registerRegistryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = makeAuth(ctx.config);

  app.get("/tvs", { preHandler: requireAuth }, async (req) => {
    return ctx.registry.listTvViews(req.user!.id);
  });

  app.get<{ Params: { id: string } }>(
    "/tvs/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const tv = await ctx.registry.getTvView(req.params.id, req.user!.id);
      if (!tv) return reply.code(404).send({ error: "not_found", message: "no such tv" });
      return tv;
    },
  );

  app.get("/cameras", { preHandler: requireAuth }, async () => {
    return ctx.registry.listCameras();
  });
}
