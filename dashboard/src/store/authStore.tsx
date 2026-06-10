// Auth/session context. Owns the JWT + user, persists them (localStorage), wires the token into
// the REST client and opens the dashboard WS on login, and tears everything down on logout.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { LoginResponse } from "@device-lab/contracts";
import * as api from "../lib/api.js";
import { clearAuth, loadAuth, saveAuth } from "../lib/auth.js";
import { dashboardSocket } from "../lib/ws.js";

type AuthUser = LoginResponse["user"];

interface AuthContextValue {
  user: AuthUser | null;
  isAdmin: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [auth, setAuth] = useState(() => loadAuth());

  // Keep the REST client token + WS connection in sync with the current session. Runs on mount
  // (restoring a persisted session) and whenever auth changes.
  useEffect(() => {
    if (auth) {
      api.setApiToken(auth.token);
      dashboardSocket.connect(auth.token);
    } else {
      api.setApiToken(null);
      dashboardSocket.disconnect();
    }
  }, [auth]);

  const login = useCallback(async (username: string, password: string) => {
    const res = await api.login(username, password);
    const stored = { token: res.token, user: res.user };
    saveAuth(stored);
    setAuth(stored);
  }, []);

  const logout = useCallback(() => {
    clearAuth();
    setAuth(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: auth?.user ?? null,
      isAdmin: auth?.user.role === "admin",
      login,
      logout,
    }),
    [auth, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
