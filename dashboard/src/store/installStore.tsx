// Live install-job store. The cloud pushes {type:"install.update", tv_id, job} over the dashboard
// WS as an install progresses (queued -> downloading -> installing -> installed/failed). This
// small store subscribes to those frames and keeps the latest InstallJob per job_id (and tracks
// which job is current for each tv_id) so the BuildsPanel can render a live progress bar without
// polling. Polling GET /install-jobs/:id remains a fallback in the panel when the WS is quiet.
//
// Kept separate from poolStore because install jobs are a different lifecycle than presence and
// only matter inside a device view the operator holds.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import type { CloudToDashboard, InstallJob } from "@device-lab/contracts";
import { dashboardSocket } from "../lib/ws.js";

interface InstallState {
  /** Latest known job by job_id. */
  jobs: Record<string, InstallJob>;
  /** The most-recent job_id we've seen for a given tv_id. */
  currentByTv: Record<string, string>;
}

type InstallAction =
  | { type: "job"; job: InstallJob }
  | { type: "clear"; tvId: string };

function reducer(state: InstallState, action: InstallAction): InstallState {
  switch (action.type) {
    case "job": {
      const job = action.job;
      // Ignore an out-of-order frame for an older job that's already terminal-superseded:
      // we always key by job_id, and we only move currentByTv forward to this job's id.
      return {
        jobs: { ...state.jobs, [job.job_id]: job },
        currentByTv: { ...state.currentByTv, [job.tv_id]: job.job_id },
      };
    }
    case "clear": {
      const current = state.currentByTv[action.tvId];
      if (!current) return state;
      const nextCurrent = { ...state.currentByTv };
      delete nextCurrent[action.tvId];
      return { ...state, currentByTv: nextCurrent };
    }
    default:
      return state;
  }
}

interface InstallContextValue {
  state: InstallState;
  /** Merge a job we learned about via REST (POST /install / GET /install-jobs) into the store. */
  upsertJob: (job: InstallJob) => void;
  /** Drop the "current" pointer for a TV (e.g. when leaving the device view). */
  clearTv: (tvId: string) => void;
}

const InstallContext = createContext<InstallContextValue | null>(null);

export function InstallStoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, { jobs: {}, currentByTv: {} });

  useEffect(() => {
    const off = dashboardSocket.onMessage((msg: CloudToDashboard) => {
      if (msg.type !== "install.update") return;
      // job is typed as unknown on the wire; the cloud sends a real InstallJob.
      dispatch({ type: "job", job: msg.job as InstallJob });
    });
    return off;
  }, []);

  const upsertJob = useCallback((job: InstallJob) => dispatch({ type: "job", job }), []);
  const clearTv = useCallback((tvId: string) => dispatch({ type: "clear", tvId }), []);

  const value = useMemo<InstallContextValue>(
    () => ({ state, upsertJob, clearTv }),
    [state, upsertJob, clearTv],
  );
  return <InstallContext.Provider value={value}>{children}</InstallContext.Provider>;
}

function useInstallContext(): InstallContextValue {
  const ctx = useContext(InstallContext);
  if (!ctx) throw new Error("useInstall* must be used within InstallStoreProvider");
  return ctx;
}

/** The current install job for a TV (the one most recently dispatched), or null. */
export function useInstallJob(tvId: string | null): {
  job: InstallJob | null;
  upsertJob: (job: InstallJob) => void;
  clearTv: (tvId: string) => void;
} {
  const { state, upsertJob, clearTv } = useInstallContext();
  const jobId = tvId ? state.currentByTv[tvId] : undefined;
  const job = jobId ? (state.jobs[jobId] ?? null) : null;
  return { job, upsertJob, clearTv };
}
