import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { connect, type NatsConnection, StringCodec } from "nats";
import { PUBSUB_SUBJECTS } from "@device-lab/contracts";
import type { Camera, InstallJob, TvView } from "@device-lab/contracts";
import { log } from "./log.js";

export interface ReservationUpdatedEvent {
  tv_id: string;
  reservation:
    | { held_by: string; lock_expires_at: string; hard_expires_at: string }
    | null;
}
export interface CalibrationUpdateEvent {
  tv_id: string;
  status: "scanning" | "bound" | "no_match" | "timeout";
  camera_id?: string;
  confidence?: number;
}
export interface InstallUpdateEvent {
  tv_id: string;
  job: InstallJob;
}

export interface AppEvents {
  "tv.updated": TvView;
  "camera.updated": Camera;
  "reservation.updated": ReservationUpdatedEvent;
  "calibration.update": CalibrationUpdateEvent;
  "install.update": InstallUpdateEvent;
}

type Handler<T> = (payload: T) => void;

/**
 * Typed in-process event bus, optionally mirrored over NATS so multiple cloud
 * instances share presence/reservation fan-out. NATS is best-effort: if it's down the
 * single instance still works. Each instance tags its publishes so it ignores its own
 * echoes coming back over NATS.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly instanceId = randomUUID();
  private nats: NatsConnection | null = null;
  private readonly sc = StringCodec();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  static async create(natsUrl: string | null): Promise<EventBus> {
    const bus = new EventBus();
    if (natsUrl) {
      try {
        bus.nats = await connect({ servers: natsUrl, name: "device-lab-cloud" });
        log.info("event bus connected to NATS", { natsUrl });
        bus.subscribeNats();
      } catch (err) {
        log.warn("NATS unavailable; running in-process only", {
          err: String(err),
        });
      }
    }
    return bus;
  }

  on<K extends keyof AppEvents>(event: K, handler: Handler<AppEvents[K]>): void {
    this.emitter.on(event, handler as Handler<unknown>);
  }

  /** Emit locally and (best-effort) mirror to NATS for other instances. */
  emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): void {
    this.emitter.emit(event, payload);
    this.publishNats(event, payload);
  }

  private subjectFor(event: keyof AppEvents): string | null {
    switch (event) {
      case "tv.updated":
        return PUBSUB_SUBJECTS.tvUpdated;
      case "camera.updated":
        return PUBSUB_SUBJECTS.cameraUpdated;
      case "reservation.updated":
        return PUBSUB_SUBJECTS.reservationUpdated;
      case "calibration.update":
        return PUBSUB_SUBJECTS.calibrationUpdate;
      case "install.update":
        return PUBSUB_SUBJECTS.installUpdate;
      default:
        return null;
    }
  }

  private publishNats(event: keyof AppEvents, payload: unknown): void {
    if (!this.nats) return;
    const subject = this.subjectFor(event);
    if (!subject) return;
    this.nats.publish(
      subject,
      this.sc.encode(JSON.stringify({ origin: this.instanceId, payload })),
    );
  }

  private subscribeNats(): void {
    if (!this.nats) return;
    const subjects: Array<[string, keyof AppEvents]> = [
      [PUBSUB_SUBJECTS.tvUpdated, "tv.updated"],
      [PUBSUB_SUBJECTS.cameraUpdated, "camera.updated"],
      [PUBSUB_SUBJECTS.reservationUpdated, "reservation.updated"],
      [PUBSUB_SUBJECTS.calibrationUpdate, "calibration.update"],
      [PUBSUB_SUBJECTS.installUpdate, "install.update"],
    ];
    for (const [subject, event] of subjects) {
      const sub = this.nats.subscribe(subject);
      (async () => {
        for await (const m of sub) {
          try {
            const { origin, payload } = JSON.parse(this.sc.decode(m.data));
            if (origin === this.instanceId) continue; // ignore our own echo
            this.emitter.emit(event, payload);
          } catch {
            /* ignore malformed */
          }
        }
      })();
    }
  }

  async close(): Promise<void> {
    if (this.nats) await this.nats.drain();
  }
}
