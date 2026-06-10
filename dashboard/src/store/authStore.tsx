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

function decodeJwt(token: string): AuthUser | null {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      window
        .atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    const decoded = JSON.parse(jsonPayload);
    return {
      id: decoded.sub,
      name: decoded.name || decoded.username || "operator",
      role: decoded.role || "operator",
    };
  } catch (e) {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [auth, setAuth] = useState(() => {
    // 1. Check URL query parameters first for iframe quick-link integration
    try {
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get("token");
      if (urlToken) {
        const user = decodeJwt(urlToken);
        if (user) {
          const stored = { token: urlToken, user };
          saveAuth(stored);
          // Clean token from address bar to prevent leakage
          window.history.replaceState({}, document.title, window.location.pathname);
          return stored;
        }
      }
    } catch (_) {}

    // 2. Fall back to standard localStorage
    return loadAuth();
  });

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

  // Support postMessage from parent iframe to dynamically login
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "SET_TOKEN") {
        const token = event.data.token;
        const user = decodeJwt(token);
        if (user) {
          const stored = { token, user };
          saveAuth(stored);
          setAuth(stored);
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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
