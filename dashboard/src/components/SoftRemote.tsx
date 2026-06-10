// SOFT REMOTE (spec §6 step d, §10). A keypad of normalized RemoteKeys (keymap.ts). Each press
// => POST /tvs/:id/key {session_id, key}; a 403 (not_holder) disables the pad. The parent device
// view also binds physical arrow-key/Enter presses to the same sender via the `bindSender` prop.
import { useCallback, useEffect, useState } from "react";
import { CORE_REMOTE_KEYS, REMOTE_KEYS, type RemoteKey } from "@device-lab/contracts";
import * as api from "../lib/api.js";

interface Props {
  tvId: string;
  sessionId: string;
  /** Bubble up a lost-lock (403) so the device view can react. */
  onForbidden: () => void;
  /** Hands the lock-validated key sender to the parent for physical-key bindings. */
  bindSender?: (send: ((key: RemoteKey) => void) | null) => void;
}

// Extended keys = everything in the contract that isn't a core d-pad/transport core key.
const EXTENDED_KEYS = REMOTE_KEYS.filter((k) => !CORE_REMOTE_KEYS.includes(k));

export function SoftRemote({ tvId, sessionId, onForbidden, bindSender }: Props): JSX.Element {
  const [disabled, setDisabled] = useState(false);
  const [flash, setFlash] = useState<RemoteKey | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const sendKey = useCallback(
    async (key: RemoteKey) => {
      if (disabled) return;
      setFlash(key);
      setLastError(null);
      try {
        const { status, body } = await api.pressKey(tvId, { session_id: sessionId, key });
        if (status === 403 || body.reason === "not_holder") {
          // The lock protects the device connection — a non-holder press is rejected. Disable
          // the pad and tell the parent to exit (we've lost the lock).
          setDisabled(true);
          onForbidden();
        } else if (!body.ok) {
          setLastError(body.reason ?? "key failed");
        }
      } catch (err) {
        setLastError(err instanceof Error ? err.message : "key failed");
      } finally {
        setTimeout(() => setFlash((f) => (f === key ? null : f)), 150);
      }
    },
    [disabled, tvId, sessionId, onForbidden],
  );

  // Publish the sender to the parent (for physical keyboard bindings) while mounted/enabled.
  useEffect(() => {
    if (!bindSender) return;
    bindSender(disabled ? null : (key: RemoteKey) => void sendKey(key));
    return () => bindSender(null);
  }, [bindSender, sendKey, disabled]);

  const keyBtn = (key: RemoteKey, label?: string) => (
    <button
      key={key}
      disabled={disabled}
      className={flash === key ? "key-flash" : undefined}
      onClick={() => void sendKey(key)}
      title={key}
    >
      {label ?? key}
    </button>
  );

  return (
    <div className="remote">
      <h4>Soft remote</h4>
      {/* D-pad: UP / LEFT-OK-RIGHT / DOWN */}
      <div className="dpad">
        <span className="spacer" />
        {keyBtn("UP", "▲")}
        <span className="spacer" />
        {keyBtn("LEFT", "◀")}
        {keyBtn("OK", "OK")}
        {keyBtn("RIGHT", "▶")}
        <span className="spacer" />
        {keyBtn("DOWN", "▼")}
        <span className="spacer" />
      </div>

      {/* Core transport + nav */}
      <div className="key-grid">
        {keyBtn("BACK")}
        {keyBtn("HOME")}
        {keyBtn("MENU")}
        {keyBtn("PLAY")}
        {keyBtn("PAUSE")}
        {keyBtn("PLAY_PAUSE", "P/P")}
      </div>

      {/* Extended set — adapters may not support all; agent returns unsupported_key if not. */}
      <h4 style={{ marginTop: 14 }}>More</h4>
      <div className="key-grid">
        {EXTENDED_KEYS.filter((k) => k !== "MENU" && k !== "PLAY_PAUSE").map((k) => keyBtn(k))}
      </div>

      {disabled && (
        <div className="error-text" style={{ marginTop: 10 }}>
          Keypad disabled — you no longer hold the lock.
        </div>
      )}
      {lastError && !disabled && (
        <div className="error-text" style={{ marginTop: 10 }}>
          Last key: {lastError}
        </div>
      )}
    </div>
  );
}
