// Token + user persistence. The cloud issues a JWT from POST /auth/login; we persist it in
// localStorage so an operator's session survives a reload, and attach it as
// "Authorization: Bearer <token>" on every REST call (see api.ts) and in the dashboard.hello
// WS frame (see ws.ts). Spec §10/§11.
import type { LoginResponse } from "@device-lab/contracts";

type AuthUser = LoginResponse["user"];

const TOKEN_KEY = "devicelab.token";
const USER_KEY = "devicelab.user";

export interface StoredAuth {
  token: string;
  user: AuthUser;
}

export function loadAuth(): StoredAuth | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const userJson = localStorage.getItem(USER_KEY);
  if (!token || !userJson) return null;
  try {
    const user = JSON.parse(userJson) as AuthUser;
    return { token, user };
  } catch {
    return null;
  }
}

export function saveAuth(auth: StoredAuth): void {
  localStorage.setItem(TOKEN_KEY, auth.token);
  localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
