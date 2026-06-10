import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type {
  GetInstallJobResponse,
  InstallResponse,
  ListAppsResponse,
  TvActionResponse,
} from "@device-lab/contracts";
import type { AppContext } from "../context.js";
import { makeAuth } from "../http/middleware.js";
import { log } from "../lib/log.js";

// "Other TV options" + build install (spec-adjacent device management). EVERY action here
// commands the TV control session, so EVERY one is validated against the lock holder — the
// same rule as soft-remote keys (a non-holder is a hard 403).
export function registerTvActionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = makeAuth(ctx.config);
  const Session = z.object({ session_id: z.string().min(1) });
  const SessionApp = Session.extend({ app_id: z.string().min(1) });

  const notHolder = (reply: import("fastify").FastifyReply): TvActionResponse => {
    void reply.code(403);
    return { ok: false, reason: "not_holder" };
  };

  // POST /tvs/:id/install { session_id, build_id }
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/install",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = Session.extend({ build_id: z.string().min(1) }).safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: "bad_request", message: "session_id and build_id required" });
      }
      const { session_id, build_id } = body.data;
      const tvId = req.params.id;
      if (!(await ctx.reservations.isHolder(tvId, session_id))) return reply.send(notHolder(reply));

      const build = await ctx.builds.get(build_id);
      if (!build) {
        return reply.code(404).send({ ok: false, reason: "no_such_build" } satisfies TvActionResponse);
      }
      const tv = await ctx.registry.getTvView(tvId, req.user!.id);
      if (tv && tv.platform !== build.platform) {
        return reply.code(400).send({
          ok: false,
          reason: "unsupported",
          message: `build targets ${build.platform}, but ${tvId} is ${tv.platform}`,
        });
      }

      const job = await ctx.install.create(tvId, build_id, req.user!.id);
      try {
        await ctx.agentHub.installBuild({
          tvId,
          buildId: build_id,
          jobId: job.job_id,
          downloadUrl: ctx.builds.downloadUrl(build_id),
          packageKind: build.package_kind,
          appId: build.app_id,
        });
      } catch {
        await ctx.install.applyProgress(job.job_id, "failed", 0, "lab agent offline");
        return reply.code(502).send({ ok: false, reason: "tv_unreachable" } satisfies TvActionResponse);
      }
      log.info("install dispatched", { tv_id: tvId, build_id, job_id: job.job_id });
      const out: InstallResponse = { job_id: job.job_id, status: job.status };
      return reply.send(out);
    },
  );

  // GET /install-jobs/:job_id — poll status (also pushed live via the dashboard WS).
  app.get<{ Params: { job_id: string } }>(
    "/install-jobs/:job_id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const job = await ctx.install.get(req.params.job_id);
      if (!job) return reply.code(404).send({ error: "not_found", message: "no such job" });
      return job satisfies GetInstallJobResponse;
    },
  );

  // POST /tvs/:id/launch-app { session_id, app_id }
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/launch-app",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = SessionApp.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request", message: "session_id and app_id required" });
      if (!(await ctx.reservations.isHolder(req.params.id, body.data.session_id))) return reply.send(notHolder(reply));
      return runAck(reply, () => ctx.agentHub.launchApp(req.params.id, body.data.app_id));
    },
  );

  // POST /tvs/:id/uninstall-app { session_id, app_id }
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/uninstall-app",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = SessionApp.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request", message: "session_id and app_id required" });
      if (!(await ctx.reservations.isHolder(req.params.id, body.data.session_id))) return reply.send(notHolder(reply));
      return runAck(reply, () => ctx.agentHub.uninstallApp(req.params.id, body.data.app_id));
    },
  );

  // POST /tvs/:id/power { session_id, on }
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/power",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = Session.extend({ on: z.boolean() }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request", message: "session_id and on required" });
      if (!(await ctx.reservations.isHolder(req.params.id, body.data.session_id))) return reply.send(notHolder(reply));
      return runAck(reply, () => ctx.agentHub.power(req.params.id, body.data.on));
    },
  );

  // POST /tvs/:id/list-apps { session_id } -> AppInfo[]
  app.post<{ Params: { id: string } }>(
    "/tvs/:id/list-apps",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = Session.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "bad_request", message: "session_id required" });
      if (!(await ctx.reservations.isHolder(req.params.id, body.data.session_id))) {
        return reply.code(403).send({ error: "not_holder", message: "you do not hold this TV" });
      }
      try {
        const apps = await ctx.agentHub.listApps(req.params.id);
        return reply.send(apps satisfies ListAppsResponse);
      } catch {
        return reply.code(502).send({ error: "tv_unreachable", message: "agent offline or timed out" });
      }
    },
  );
}

/** Run an agent app-action that resolves to an ack; map to the uniform TvActionResponse. */
async function runAck(
  reply: import("fastify").FastifyReply,
  fn: () => Promise<{ ok: boolean; error?: string }>,
): Promise<TvActionResponse> {
  try {
    const ack = await fn();
    if (!ack.ok) {
      void reply.code(502);
      return { ok: false, reason: ack.error === "unsupported" ? "unsupported" : "tv_unreachable" };
    }
    return { ok: true };
  } catch {
    void reply.code(502);
    return { ok: false, reason: "tv_unreachable" };
  }
}
