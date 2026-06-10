// BUILDS PANEL (device view, holder-only). Upload a platform build into the shared library and
// install it onto the TV you currently hold.
//
//   · Upload: drag/drop or file picker, filtered to the package kind this TV installs
//     (apk=androidtv, wgt=tizen, ipk=webos). POST /builds (multipart) with live upload progress.
//   · Library: GET /builds?platform=<tv.platform> — only builds that target THIS TV's family,
//     each with Install + Delete. A platform mismatch is impossible by construction, and the
//     cloud also rejects it (reason "unsupported"); we surface that cleanly if it ever happens.
//   · Install: POST /tvs/:id/install {session_id, build_id} -> {job_id, status}. Progress then
//     streams live via the install.update WS frame (installStore); we also POLL
//     GET /install-jobs/:id as a fallback until the job reaches a terminal state.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Build, InstallJob, PackageKind, Platform } from "@device-lab/contracts";
import { PLATFORM_TO_PACKAGE } from "@device-lab/contracts";
import * as api from "../lib/api.js";
import { ApiRequestError } from "../lib/api.js";
import { useInstallJob } from "../store/installStore.js";

interface Props {
  tvId: string;
  platform: Platform;
  sessionId: string;
}

const KIND_LABEL: Record<PackageKind, string> = {
  apk: "Android APK (.apk)",
  wgt: "Tizen widget (.wgt)",
  ipk: "webOS package (.ipk)",
};

const STATUS_TEXT: Record<InstallJob["status"], string> = {
  queued: "Queued — waiting on the lab agent…",
  downloading: "Downloading the build to the agent…",
  installing: "Installing on the TV…",
  installed: "Installed.",
  failed: "Install failed.",
};

function isTerminal(s: InstallJob["status"]): boolean {
  return s === "installed" || s === "failed";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function BuildsPanel({ tvId, platform, sessionId }: Props): JSX.Element {
  const expectedKind = PLATFORM_TO_PACKAGE[platform];

  const [builds, setBuilds] = useState<Build[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [appId, setAppId] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [installError, setInstallError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);

  const { job, upsertJob, clearTv } = useInstallJob(tvId);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const list = await api.listBuilds(platform);
      setBuilds(list);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "could not load builds");
    } finally {
      setLoading(false);
    }
  }, [platform]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Drop the live-job pointer for this TV when the panel unmounts (leaving the device view).
  useEffect(() => () => clearTv(tvId), [tvId, clearTv]);

  // ── Polling fallback ────────────────────────────────────────────────────────
  // Once a job is in flight, poll GET /install-jobs/:id every 2s until terminal. The WS frame
  // usually wins; polling guarantees progress even if the socket hiccups. We always upsert into
  // the store so the rendered job stays consistent with the live source.
  useEffect(() => {
    if (!job || isTerminal(job.status)) return;
    const jobId = job.job_id;
    const id = setInterval(() => {
      void api
        .getInstallJob(jobId)
        .then((fresh) => upsertJob(fresh))
        .catch(() => {
          /* transient — keep the last known state, the WS may still deliver */
        });
    }, 2000);
    return () => clearInterval(id);
  }, [job, upsertJob]);

  // Refresh the library when an install completes (a brand-new app may now be present, and the
  // operator likely wants to install another build next).
  const lastTerminalRef = useRef<string | null>(null);
  useEffect(() => {
    if (job && isTerminal(job.status) && lastTerminalRef.current !== job.job_id) {
      lastTerminalRef.current = job.job_id;
      setInstallingId(null);
    }
  }, [job]);

  // ── Upload ──────────────────────────────────────────────────────────────────
  const matchesKind = useCallback(
    (file: File): boolean => {
      const ext = file.name.split(".").pop()?.toLowerCase();
      return ext === expectedKind;
    },
    [expectedKind],
  );

  const doUpload = useCallback(
    async (file: File) => {
      setUploadError(null);
      if (!matchesKind(file)) {
        setUploadError(
          `Wrong package type — this TV (${platform}) installs ${KIND_LABEL[expectedKind]}.`,
        );
        return;
      }
      setUploading(true);
      setUploadPct(0);
      try {
        await api.uploadBuild(file, appId.trim() || null, (p) =>
          setUploadPct(p.fraction != null ? Math.round(p.fraction * 100) : null),
        );
        setAppId("");
        if (fileInputRef.current) fileInputRef.current.value = "";
        await refresh();
      } catch (err) {
        if (err instanceof ApiRequestError) {
          setUploadError(
            err.status === 413
              ? "Build exceeds the upload size limit."
              : err.message || "upload failed",
          );
        } else {
          setUploadError(err instanceof Error ? err.message : "upload failed");
        }
      } finally {
        setUploading(false);
        setUploadPct(null);
      }
    },
    [appId, expectedKind, matchesKind, platform, refresh],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) void doUpload(file);
    },
    [doUpload],
  );

  // ── Install ───────────────────────────────────────────────────────────────────
  const doInstall = useCallback(
    async (build: Build) => {
      setInstallError(null);
      setInstallingId(build.build_id);
      try {
        const res = await api.install(tvId, sessionId, build.build_id);
        if (res.ok) {
          // Seed the store immediately so the progress bar shows before the first WS frame.
          upsertJob({
            job_id: res.job.job_id,
            tv_id: tvId,
            build_id: build.build_id,
            status: res.job.status,
            progress: 0,
            message: null,
            requested_by: "",
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        } else {
          setInstallingId(null);
          setInstallError(res.message);
        }
      } catch (err) {
        setInstallingId(null);
        setInstallError(err instanceof Error ? err.message : "install failed");
      }
    },
    [tvId, sessionId, upsertJob],
  );

  const doDelete = useCallback(
    async (build: Build) => {
      try {
        await api.deleteBuild(build.build_id);
        await refresh();
      } catch (err) {
        setListError(err instanceof Error ? err.message : "delete failed");
      }
    },
    [refresh],
  );

  const installInFlight = !!job && !isTerminal(job.status);
  const progressPct = job ? Math.round(job.progress * 100) : 0;

  return (
    <section className="panel builds-panel">
      <div className="panel-head">
        <h4>Builds &amp; install</h4>
        <span className="kind-pill" title={`This TV installs ${KIND_LABEL[expectedKind]}`}>
          {platform} · .{expectedKind}
        </span>
      </div>

      {/* Upload zone */}
      <div
        className={`dropzone${dragOver ? " over" : ""}${uploading ? " busy" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        aria-label={`Upload a ${expectedKind} build`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={`.${expectedKind}`}
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void doUpload(f);
          }}
        />
        {uploading ? (
          <div className="dz-uploading">
            <div>Uploading…</div>
            <div className="progress">
              <div
                className="progress-bar"
                style={{ width: uploadPct != null ? `${uploadPct}%` : "100%" }}
              />
            </div>
            <div className="hint">{uploadPct != null ? `${uploadPct}%` : "sending…"}</div>
          </div>
        ) : (
          <>
            <div className="dz-title">Drop a {KIND_LABEL[expectedKind]} here</div>
            <div className="hint">or click to choose a file · only .{expectedKind} is accepted</div>
          </>
        )}
      </div>

      <div className="field-row">
        <input
          placeholder="app id (optional, e.g. com.example.app)"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          disabled={uploading}
          aria-label="app id (optional)"
        />
      </div>
      {uploadError && <div className="error-text">{uploadError}</div>}

      {/* Library for this platform */}
      <div className="panel-subhead">
        <span>Library ({builds.length})</span>
        <button className="link-btn" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {listError && <div className="error-text">{listError}</div>}
      {!loading && builds.length === 0 && !listError && (
        <div className="hint">No {platform} builds uploaded yet.</div>
      )}
      <ul className="row-list">
        {builds.map((b) => (
          <li key={b.build_id} className="row-item">
            <div className="row-item-main">
              <div className="row-item-title" title={b.filename}>
                {b.filename}
              </div>
              <div className="row-item-sub">
                .{b.package_kind} · {formatBytes(b.size_bytes)}
                {b.app_id ? ` · ${b.app_id}` : ""}
              </div>
            </div>
            <div className="row-item-actions">
              <button
                className="primary sm"
                disabled={installInFlight || installingId === b.build_id}
                onClick={() => void doInstall(b)}
                title={installInFlight ? "An install is already in progress" : "Install on this TV"}
              >
                {installingId === b.build_id ? "Installing…" : "Install"}
              </button>
              <button
                className="danger sm"
                disabled={installInFlight}
                onClick={() => void doDelete(b)}
                title="Delete this build from the library"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      {installError && <div className="error-text">{installError}</div>}

      {/* Live install progress */}
      {job && (
        <div className={`install-status ${job.status}`}>
          <div className="install-status-head">
            <span>{STATUS_TEXT[job.status]}</span>
            <span className="mono">{progressPct}%</span>
          </div>
          <div className="progress">
            <div
              className={`progress-bar ${job.status}`}
              style={{ width: `${job.status === "queued" ? Math.max(progressPct, 4) : progressPct}%` }}
            />
          </div>
          {job.message && (
            <div className={job.status === "failed" ? "error-text" : "hint"} style={{ marginTop: 6 }}>
              {job.message}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
