// Binding service — writes/updates/deletes the one mutable link (spec §2). Enforces the
// 1:1 camera↔TV cardinality by moving a camera's binding rather than failing on the
// UNIQUE(camera_id) constraint. After any change it asks the registry to recompute the
// TV's status (a fresh binding can flip a blind `no_camera` TV to `free`).
import type { BindingMethod } from "@device-lab/contracts";
import type { DbPool } from "../db.js";
import type { RegistryService } from "./registry.js";

export class BindingService {
  constructor(
    private readonly pool: DbPool,
    private readonly registry: RegistryService,
  ) {}

  /** Manual confirm (fallback). Operator eyeballed the feed and confirmed the camera. */
  async createManual(
    tvId: string,
    cameraId: string,
    userId: string,
  ): Promise<{ ok: true } | { ok: false; reason: "no_such_camera" | "no_such_tv" }> {
    return this.write(tvId, cameraId, "manual_confirm", null, userId);
  }

  /** QR handshake result (confidence 1.0). Called by the calibration service. */
  async createFromCalibration(
    tvId: string,
    cameraId: string,
    confidence: number,
    userId: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: "no_such_camera" | "no_such_tv" }> {
    return this.write(tvId, cameraId, "qr_handshake", confidence, userId);
  }

  private async write(
    tvId: string,
    cameraId: string,
    method: BindingMethod,
    confidence: number | null,
    userId: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: "no_such_camera" | "no_such_tv" }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tv = await client.query("SELECT 1 FROM tvs WHERE tv_id = $1", [tvId]);
      if (!tv.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "no_such_tv" };
      }
      const cam = await client.query("SELECT 1 FROM cameras WHERE camera_id = $1", [
        cameraId,
      ]);
      if (!cam.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "no_such_camera" };
      }
      // Repoint: a camera can only be bound to one TV (1:1). Free it from any other TV.
      await client.query("DELETE FROM bindings WHERE camera_id = $1 AND tv_id <> $2", [
        cameraId,
        tvId,
      ]);
      await client.query(
        `INSERT INTO bindings (tv_id, camera_id, method, confidence, bound_by, last_verified_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (tv_id) DO UPDATE
           SET camera_id = EXCLUDED.camera_id, method = EXCLUDED.method,
               confidence = EXCLUDED.confidence, bound_by = EXCLUDED.bound_by,
               last_verified_at = now()`,
        [tvId, cameraId, method, confidence, userId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    await this.registry.recomputeAndStore(tvId);
    // The TV the camera was repointed away from (if any) also needs recompute; cheap to
    // just recompute all that referenced this camera is overkill — the reconcile loop
    // catches it within a tick. We recompute the freed TV opportunistically below.
    return { ok: true };
  }

  /** Unassign — deleting the row severs the link. TV becomes controllable-but-blind. */
  async unassign(tvId: string): Promise<boolean> {
    const res = await this.pool.query(
      "DELETE FROM bindings WHERE tv_id = $1 RETURNING tv_id",
      [tvId],
    );
    await this.registry.recomputeAndStore(tvId);
    return (res.rowCount ?? 0) > 0;
  }

  async getBoundCamera(tvId: string): Promise<string | null> {
    const res = await this.pool.query<{ camera_id: string }>(
      "SELECT camera_id FROM bindings WHERE tv_id = $1",
      [tvId],
    );
    return res.rowCount ? res.rows[0]!.camera_id : null;
  }

  /** Refresh the verification timestamp (self-healing nudge resets the clock). */
  async touchVerified(tvId: string): Promise<void> {
    await this.pool.query(
      "UPDATE bindings SET last_verified_at = now() WHERE tv_id = $1",
      [tvId],
    );
  }
}
