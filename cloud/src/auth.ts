import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import jwt from "jsonwebtoken";

export type Role = "operator" | "admin";
export interface AuthUser {
  id: string;
  name: string;
  role: Role;
}

// --- Password hashing (scrypt; no external dep) ---
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1]!, "hex");
  const expected = Buffer.from(parts[2]!, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// --- Session JWTs ---
export function signToken(user: AuthUser, secret: string): string {
  return jwt.sign(
    { sub: user.id, name: user.name, role: user.role },
    secret,
    { expiresIn: "12h" },
  );
}

export function verifyToken(token: string, secret: string): AuthUser | null {
  try {
    const decoded = jwt.verify(token, secret) as {
      sub: string;
      name: string;
      role: Role;
    };
    return { id: decoded.sub, name: decoded.name, role: decoded.role };
  } catch {
    return null;
  }
}
