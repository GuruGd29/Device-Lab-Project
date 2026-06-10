// Install jobs — tracks pushing one build onto one TV. The atomic side (job row) lives here;
// the route validates the lock holder and relays the command to the agent, and the agent's
// install.progress frames flow back through applyProgress -> DB + live dashboard push.
import { randomUUID } from "node:crypto";
import type { InstallJob, InstallStatus } from "@device-lab/contracts";
import type { DbPool } from "../db.js";
import { iso } from "../db.js";
import type { EventBus } from "../lib/events.js";

interface JobRow {
  job_id: string;
  tv_id: string;
  build_id: string;
  status: InstallStatus;
  progress: number;
  message: string | null;
  requested_by: string;
  created_at: Date;
  updated_at: Date;
}

function toJob(r: JobRow): InstallJob {
  return {
    job_id: r.job_id,
    tv_id: r.tv_id,
    build_id: r.build_id,
    status: r.status,
    progress: r.progress,
    message: r.message,
    requested_by: r.requested_by,
    created_at: iso(r.created_at)!,
    updated_at: iso(r.updated_at)!,
  };
}

export class InstallService {
  constructor(
    private readonly pool: DbPool,
    private readonly events: EventBus,
  ) {}

  async create(tvId: string, buildId: string, requestedBy: string): Promise<InstallJob> {
    const jobId = randomUUID();
    const res = await this.pool.query<JobRow>(
      `INSERT INTO install_jobs (job_id, tv_id, build_id, status, progress, requested_by)
       VALUES ($1,$2,$3,'queued',0,$4) RETURNING *`,
      [jobId, tvId, buildId, requestedBy],
    );
    const job = toJob(res.rows[0]!);
    this.events.emit("install.update", { tv_id: tvId, job });
    return job;
  }

  /** Apply an install.progress frame from the agent; persist + push live to dashboards. */
  async applyProgress(
    jobId: string,
    status: InstallStatus,
    progress: number,
    message?: string,
  ): Promise<void> {
    const res = await this.pool.query<JobRow>(
      `UPDATE install_jobs
          SET status = $2, progress = $3, message = $4, updated_at = now()
        WHERE job_id = $1 RETURNING *`,
      [jobId, status, Math.max(0, Math.min(1, progress)), message ?? null],
    );
    if (!res.rowCount) return;
    const job = toJob(res.rows[0]!);
    this.events.emit("install.update", { tv_id: job.tv_id, job });
  }

  async get(jobId: string): Promise<InstallJob | null> {
    const res = await this.pool.query<JobRow>(
      "SELECT * FROM install_jobs WHERE job_id = $1",
      [jobId],
    );
    return res.rowCount ? toJob(res.rows[0]!) : null;
  }

  /** Most recent job per TV (for the device-view panel). */
  async latestForTv(tvId: string): Promise<InstallJob | null> {
    const res = await this.pool.query<JobRow>(
      "SELECT * FROM install_jobs WHERE tv_id = $1 ORDER BY created_at DESC LIMIT 1",
      [tvId],
    );
    return res.rowCount ? toJob(res.rows[0]!) : null;
  }
}
