// POWER CONTROLS (device view, holder-only). POST /tvs/:id/power {session_id, on}. Sits next to
// the soft remote. A not_holder ack escalates to the parent (we've lost the lock); other failures
// (tv_unreachable / unsupported) surface inline — some platforms can't power on a fully-off panel.
import { useCallback, useState } from "react";
import * as api from "../lib/api.js";

interface Props {
  tvId: string;
  sessionId: string;
  onForbidden: () => void;
}

export function PowerControls({ tvId, sessionId, onForbidden }: Props): JSX.Element {
  const [busy, setBusy] = useState<"on" | "off" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (on: boolean) => {
      setBusy(on ? "on" : "off");
      setError(null);
      try {
        const res = await api.power(tvId, sessionId, on);
        if (!res.ok) {
          if (res.reason === "not_holder") {
            onForbidden();
            return;
          }
          setError(api.actionReasonText(res.reason) ?? "power command failed");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "power command failed");
      } finally {
        setBusy(null);
      }
    },
    [tvId, sessionId, onForbidden],
  );

  return (
    <div className="power-controls">
      <span className="power-label">Power</span>
      <div className="power-buttons">
        <button className="sm" disabled={busy != null} onClick={() => void send(true)}>
          {busy === "on" ? "…" : "On"}
        </button>
        <button className="danger sm" disabled={busy != null} onClick={() => void send(false)}>
          {busy === "off" ? "…" : "Off"}
        </button>
      </div>
      {error && (
        <div className="error-text" style={{ marginTop: 6 }}>
          {error}
        </div>
      )}
    </div>
  );
}
