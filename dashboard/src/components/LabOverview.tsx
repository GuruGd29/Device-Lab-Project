// LAB OVERVIEW (spec §10 screen 1). Two pools — TVs + cameras — each card live-updated from the
// store (which is fed only by WS pushes; no polling). Hosts the Assign/Calibrate modal, the
// Device View, and the admin force-release action.
import { useState } from "react";
import type { TvView } from "@device-lab/contracts";
import { usePools } from "../store/poolStore.js";
import { useAuth } from "../store/authStore.js";
import { useNow } from "../hooks/useNow.js";
import * as api from "../lib/api.js";
import { TvCard } from "./TvCard.js";
import { CameraCard } from "./CameraCard.js";
import { AssignModal } from "./AssignModal.js";
import { DeviceView } from "./DeviceView.js";

export function LabOverview(): JSX.Element {
  const { tvs, cameras, loaded } = usePools();
  const { user, isAdmin } = useAuth();
  // Cards' "~Nm left" only needs coarse ticks; 15s keeps it fresh without churn.
  const now = useNow(15_000);

  const [assignTv, setAssignTv] = useState<TvView | null>(null);
  const [testTv, setTestTv] = useState<TvView | null>(null);
  const [forceMsg, setForceMsg] = useState<string | null>(null);

  if (!user) return <></>;

  // Keep the modal's tv prop in sync with the live store so binding/status changes reflect.
  const liveAssignTv = assignTv ? (tvs.find((t) => t.tv_id === assignTv.tv_id) ?? assignTv) : null;
  const liveTestTv = testTv ? (tvs.find((t) => t.tv_id === testTv.tv_id) ?? testTv) : null;

  async function onForceRelease(tv: TvView): Promise<void> {
    setForceMsg(null);
    try {
      const res = await api.forceRelease(tv.tv_id);
      setForceMsg(
        `Force-released ${tv.tv_id}${res.prior_holder ? ` (was held by ${res.prior_holder})` : ""}.`,
      );
    } catch (err) {
      setForceMsg(err instanceof Error ? err.message : "force-release failed");
    }
  }

  return (
    <div className="main">
      {forceMsg && <div className="banner info">{forceMsg}</div>}

      <section className="pool-section">
        <h2>TV pool ({tvs.length})</h2>
        {!loaded ? (
          <div className="hint">Connecting to the control plane…</div>
        ) : tvs.length === 0 ? (
          <div className="hint">No TVs reported by any lab agent yet.</div>
        ) : (
          <div className="card-grid">
            {tvs.map((tv) => (
              <TvCard
                key={tv.tv_id}
                tv={tv}
                myUserId={user.id}
                isAdmin={isAdmin}
                now={now}
                onTest={setTestTv}
                onAssign={setAssignTv}
                onForceRelease={(t) => void onForceRelease(t)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="pool-section">
        <h2>Camera pool ({cameras.length})</h2>
        {!loaded ? (
          <div className="hint">Connecting…</div>
        ) : cameras.length === 0 ? (
          <div className="hint">No cameras reported yet.</div>
        ) : (
          <div className="card-grid">
            {cameras.map((c) => (
              <CameraCard key={c.camera_id} camera={c} />
            ))}
          </div>
        )}
      </section>

      {liveAssignTv && <AssignModal tv={liveAssignTv} onClose={() => setAssignTv(null)} />}
      {liveTestTv && <DeviceView tv={liveTestTv} onClose={() => setTestTv(null)} />}
    </div>
  );
}
