// Single source of truth for where the cloud control plane lives. The REST base URL comes
// from VITE_API_URL (defaulting to the dev cloud on :8080); the dashboard WS URL is derived
// from it by swapping the scheme (http->ws, https->wss) and appending the /dashboard path
// the cloud routes the upgrade on (cloud/src/app.ts).

const RAW_API_URL =
  (import.meta.env.VITE_API_URL ?? "http://localhost:8080").replace(/\/+$/, "");

export const API_BASE_URL = RAW_API_URL;

/** ws://host/dashboard or wss://host/dashboard, derived from the REST base URL. */
export const DASHBOARD_WS_URL = (() => {
  const u = new URL(RAW_API_URL);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/dashboard";
  return u.toString();
})();
