// Auth middleware. Bearer JWT -> request.user. requireAdmin gates force-release etc.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "../auth.js";
import { verifyToken } from "../auth.js";
import type { Config } from "../config.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function makeAuth(config: Config) {
  async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    const user = token ? verifyToken(token, config.jwtSecret) : null;
    if (!user) {
      await reply.code(401).send({ error: "unauthorized", message: "missing or invalid token" });
      return;
    }
    req.user = user;
  }

  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await requireAuth(req, reply);
    if (reply.sent) return;
    if (req.user!.role !== "admin") {
      await reply.code(403).send({ error: "forbidden", message: "admin role required" });
    }
  }

  return { requireAuth, requireAdmin };
}
