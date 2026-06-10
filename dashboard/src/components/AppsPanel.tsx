// APPS PANEL (device view, holder-only) — the "other TV options".
//
//   · Refresh apps -> POST /tvs/:id/list-apps {session_id} -> AppInfo[]
//   · Each app row: Launch (POST /launch-app) + Uninstall (POST /uninstall-app)
//   · Launch by app id -> a free-text input + Launch button (for apps not in the listing)
//
// All actions require the LOCK HOLDER server-side; a 403 means we lost the lock (the parent
// device view also exits on a forbidden soft-remote key). 502 => tv_unreachable / agent offline.
import { useCallback, useState } from "react";
import type { AppInfo, TvActionResponse } from "@device-lab/contracts";
import * as api from "../lib/api.js";
import { ApiRequestError } from "../lib/api.js";

interface Props {
  tvId: string;
  sessionId: string;
  /** Bubble up a hard "not_holder" so the device view can end the session. */
  onForbidden: () => void;
}

export function AppsPanel({ tvId, sessionId, onForbidden }: Props): JSX.Element {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [launchId, setLaunchId] = useState("");
  const [busyApp, setBusyApp] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const list = await api.listApps(tvId, sessionId);
      setApps(list);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 403) {
        onForbidden();
        return;
      }
      if (err instanceof ApiRequestError && err.status === 502) {
        setListError("TV unreachable — the lab agent is offline or timed out.");
        return;
      }
      setListError(err instanceof Error ? err.message : "could not list apps");
    } finally {
      setLoading(false);
    }
  }, [tvId, sessionId, onForbidden]);

  // Map a TvActionResponse onto a friendly message; escalate not_holder to the parent.
  const handleAck = useCallback(
    (res: TvActionResponse, okText: string): boolean => {
      if (res.ok) {
        setActionMsg({ kind: "ok", text: okText });
        return true;
      }
      if (res.reason === "not_holder") {
        onForbidden();
        return false;
      }
      setActionMsg({ kind: "err", text: api.actionReasonText(res.reason) ?? "action failed" });
      return false;
    },
    [onForbidden],
  );

  const doLaunch = useCallback(
    async (appId: string) => {
      const id = appId.trim();
      if (!id) return;
      setBusyApp(id);
      setActionMsg(null);
      try {
        const res = await api.launchApp(tvId, sessionId, id);
        handleAck(res, `Launched ${id}.`);
      } catch (err) {
        setActionMsg({ kind: "err", text: err instanceof Error ? err.message : "launch failed" });
      } finally {
        setBusyApp(null);
      }
    },
    [tvId, sessionId, handleAck],
  );

  const doUninstall = useCallback(
    async (appId: string) => {
      setBusyApp(appId);
      setActionMsg(null);
      try {
        const res = await api.uninstallApp(tvId, sessionId, appId);
        if (handleAck(res, `Uninstalled ${appId}.`)) {
          // Optimistically drop it from the listing; a Refresh re-syncs from the TV.
          setApps((prev) => (prev ? prev.filter((a) => a.app_id !== appId) : prev));
        }
      } catch (err) {
        setActionMsg({ kind: "err", text: err instanceof Error ? err.message : "uninstall failed" });
      } finally {
        setBusyApp(null);
      }
    },
    [tvId, sessionId, handleAck],
  );

  return (
    <section className="panel apps-panel">
      <div className="panel-head">
        <h4>Installed apps</h4>
        <button className="link-btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh apps"}
        </button>
      </div>

      {/* Launch by app id */}
      <form
        className="field-row"
        onSubmit={(e) => {
          e.preventDefault();
          void doLaunch(launchId);
        }}
      >
        <input
          placeholder="launch by app id (e.g. com.example.app)"
          value={launchId}
          onChange={(e) => setLaunchId(e.target.value)}
          aria-label="launch by app id"
        />
        <button className="primary sm" type="submit" disabled={!launchId.trim() || busyApp != null}>
          Launch
        </button>
      </form>

      {listError && <div className="error-text">{listError}</div>}

      {apps === null && !listError && !loading && (
        <div className="hint">Refresh to list the apps installed on this TV.</div>
      )}
      {apps !== null && apps.length === 0 && (
        <div className="hint">No apps reported by the TV.</div>
      )}

      {apps && apps.length > 0 && (
        <ul className="row-list">
          {apps.map((a) => (
            <li key={a.app_id} className="row-item">
              <div className="row-item-main">
                <div className="row-item-title">
                  {a.name ?? a.app_id}
                  {a.running ? <span className="running-dot" title="running" /> : null}
                </div>
                <div className="row-item-sub">
                  {a.app_id}
                  {a.version ? ` · v${a.version}` : ""}
                </div>
              </div>
              <div className="row-item-actions">
                <button
                  className="primary sm"
                  disabled={busyApp != null}
                  onClick={() => void doLaunch(a.app_id)}
                >
                  {busyApp === a.app_id ? "…" : "Launch"}
                </button>
                <button
                  className="danger sm"
                  disabled={busyApp != null}
                  onClick={() => void doUninstall(a.app_id)}
                >
                  Uninstall
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {actionMsg && (
        <div className={actionMsg.kind === "ok" ? "ok-text" : "error-text"} style={{ marginTop: 8 }}>
          {actionMsg.text}
        </div>
      )}
    </section>
  );
}
