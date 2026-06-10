import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { CreateBuildResponse, Platform } from "@device-lab/contracts";
import type { AppContext } from "../context.js";
import { makeAuth } from "../http/middleware.js";
import { verifyToken } from "../auth.js";
import { packageKindFromFilename } from "../services/builds.js";
import { log } from "../lib/log.js";

// Build library: upload (multipart), list, delete, and an agent-facing download.
export function registerBuildRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { requireAuth } = makeAuth(ctx.config);

  // POST /builds  (multipart form-data: file=<apk|wgt|ipk>, optional app_id=<pkg id>)
  app.post("/builds", { preHandler: requireAuth }, async (req, reply) => {
    if (!req.isMultipart()) {
      return reply.code(400).send({ error: "bad_request", message: "multipart form-data required" });
    }
    const buildId = randomUUID();
    let appId: string | null = null;
    let saved:
      | { filename: string; kind: "apk" | "wgt" | "ipk"; path: string; size: number }
      | null = null;

    for await (const part of req.parts()) {
      if (part.type === "file") {
        const kind = packageKindFromFilename(part.filename);
        if (!kind) {
          part.file.resume(); // drain
          return reply
            .code(400)
            .send({ error: "bad_package", message: "file must be .apk, .wgt, or .ipk" });
        }
        const path = ctx.builds.storagePathFor(buildId, kind);
        await pipeline(part.file, createWriteStream(path));
        if (part.file.truncated) {
          await unlink(path).catch(() => {});
          return reply
            .code(413)
            .send({ error: "too_large", message: "build exceeds the upload size limit" });
        }
        const s = await stat(path);
        saved = { filename: part.filename, kind, path, size: s.size };
      } else if (part.fieldname === "app_id" && typeof part.value === "string") {
        appId = part.value || null;
      }
    }

    if (!saved) {
      return reply.code(400).send({ error: "no_file", message: "a 'file' field is required" });
    }
    const build = await ctx.builds.record({
      build_id: buildId,
      filename: saved.filename,
      package_kind: saved.kind,
      size_bytes: saved.size,
      storage_path: saved.path,
      app_id: appId,
      uploaded_by: req.user!.id,
    });
    log.info("build uploaded", { build_id: build.build_id, platform: build.platform, size: build.size_bytes });
    const body: CreateBuildResponse = { build };
    return reply.send(body);
  });

  // GET /builds[?platform=tizen]
  app.get<{ Querystring: { platform?: Platform } }>(
    "/builds",
    { preHandler: requireAuth },
    async (req) => ctx.builds.list(req.query.platform),
  );

  // DELETE /builds/:id
  app.delete<{ Params: { id: string } }>(
    "/builds/:id",
    { preHandler: requireAuth },
    async (req, reply) => {
      const ok = await ctx.builds.delete(req.params.id);
      return reply.code(ok ? 200 : 404).send({ ok });
    },
  );

  // GET /builds/:id/download — the lab agent fetches the bytes here. Authorized by either a
  // user JWT or the agent shared secret (the agent isn't a logged-in user).
  app.get<{ Params: { id: string } }>("/builds/:id/download", async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const user = token ? verifyToken(token, ctx.config.jwtSecret) : null;
    const agentOk = req.headers["x-agent-secret"] === ctx.config.agentSharedSecret;
    if (!user && !agentOk) {
      return reply.code(401).send({ error: "unauthorized", message: "token or agent secret required" });
    }
    const s = await ctx.builds.getStorage(req.params.id);
    if (!s) return reply.code(404).send({ error: "not_found", message: "no such build" });
    reply.header("content-disposition", `attachment; filename="${s.filename}"`);
    reply.type("application/octet-stream");
    return reply.send(createReadStream(s.storage_path));
  });
}
