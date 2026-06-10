// Reconcile loop (spec §9) — where Phase 1 quietly breaks if you skip it. Periodically
// reconciles the three truths (declared slots, discovered devices, confirmed bindings) and
// reaps dead locks, so the dashboard never confidently shows stale truth.
//
//   · Lock present but session heartbeat dead  -> TTL lapses, auto-free (the safety net).
//   · TV/camera heartbeat stopped              -> status recompute flips it offline/unhealthy.
//   · Camera stopped publishing while bound     -> `unhealthy`, NOT `free`.
//
// This is the safety net behind the heartbeat-driven transitions, not a substitute for
// them — presence is push, this just catches what falls through.
import type { Config } from "../config.js";
import type { EventBus } from "../lib/events.js";
import type { RegistryService } from "./registry.js";
import type { ReservationService } from "./reservation.js";
import { log } from "../lib/log.js";

export class ReconcileLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly registry: RegistryService,
    private readonly reservations: ReservationService,
    private readonly events: EventBus,
  ) {}

  start(): void {
    if (this.timer) return;
    const intervalMs = this.config.reconcileIntervalSeconds * 1000;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    // Kick once immediately so a fresh boot converges without waiting a full interval.
    void this.tick();
    log.info("reconcile loop started", { intervalMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      // 1. Reap dead locks first so a freed TV recomputes as free in step 2.
      const freed = await this.reservations.expireStale();
      for (const { tv_id, held_by } of freed) {
        this.events.emit("reservation.updated", { tv_id, reservation: null });
        log.info("reservation lapsed, auto-freed", { tv_id, prior_holder: held_by });
      }
      // 2. Recompute every TV's effective status (offline/unhealthy/no_camera transitions).
      await this.registry.recomputeAll();
    } catch (err) {
      log.error("reconcile tick failed", { err: String(err) });
    } finally {
      this.running = false;
    }
  }
}
