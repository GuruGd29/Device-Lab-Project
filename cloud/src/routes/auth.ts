import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { LoginResponse } from "@device-lab/contracts";
import type { AppContext } from "../context.js";
import { signToken, verifyPassword, type Role } from "../auth.js";

const LoginBody = z.object({ username: z.string(), password: z.string() });

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/auth/login", async (req, reply) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "bad_request", message: "username and password required" });
    }
    const { username, password } = parsed.data;
    const res = await ctx.pool.query<{
      user_id: string;
      display_name: string;
      password_hash: string;
      role: Role;
    }>(
      "SELECT user_id, display_name, password_hash, role FROM users WHERE username = $1",
      [username],
    );
    const row = res.rows[0];
    if (!row || !verifyPassword(password, row.password_hash)) {
      return reply.code(401).send({ error: "unauthorized", message: "invalid credentials" });
    }
    const user = { id: row.user_id, name: row.display_name, role: row.role };
    const body: LoginResponse = { token: signToken(user, ctx.config.jwtSecret), user };
    return reply.send(body);
  });
}
