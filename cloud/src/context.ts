// Composition root — constructs every service once and wires the dependency graph.
// Order matters: low-level (pool, events) → services → hubs → calibration → reconcile.
import { createPool, type DbPool } from "./db.js";
import type { Config } from "./config.js";
import { EventBus } from "./lib/events.js";
import { RegistryService } from "./services/registry.js";
import { ReservationService } from "./services/reservation.js";
import { BindingService } from "./services/binding.js";
import { CalibrationService } from "./services/calibration.js";
import { ReconcileLoop } from "./services/reconcile.js";
import { BuildsService } from "./services/builds.js";
import { InstallService } from "./services/install.js";
import { AgentHub } from "./ws/agentHub.js";
import { DashboardHub } from "./ws/dashboardHub.js";

export interface AppContext {
  config: Config;
  pool: DbPool;
  events: EventBus;
  registry: RegistryService;
  reservations: ReservationService;
  bindings: BindingService;
  calibration: CalibrationService;
  builds: BuildsService;
  install: InstallService;
  agentHub: AgentHub;
  dashboardHub: DashboardHub;
  reconcile: ReconcileLoop;
}

export async function buildContext(config: Config): Promise<AppContext> {
  const pool = createPool(config.databaseUrl);
  const events = await EventBus.create(config.natsUrl);

  const registry = new RegistryService(pool, config, events);
  const reservations = new ReservationService(
    pool,
    config.leaseTtlSeconds,
    config.hardSessionSeconds,
  );
  const bindings = new BindingService(pool, registry);
  const agentHub = new AgentHub(pool, config, registry);
  const calibration = new CalibrationService(agentHub, bindings, events);
  const builds = new BuildsService(pool, config);
  const install = new InstallService(pool, events);
  // Route agent install.progress frames into the install service (DB + live dashboard push).
  agentHub.onInstallProgress((p) =>
    void install.applyProgress(p.job_id, p.status, p.progress, p.message),
  );
  const dashboardHub = new DashboardHub(
    config,
    registry,
    reservations,
    bindings,
    agentHub,
    events,
  );
  const reconcile = new ReconcileLoop(config, registry, reservations, events);

  return {
    config,
    pool,
    events,
    registry,
    reservations,
    bindings,
    calibration,
    builds,
    install,
    agentHub,
    dashboardHub,
    reconcile,
  };
}

export async function shutdownContext(ctx: AppContext): Promise<void> {
  ctx.reconcile.stop();
  await ctx.events.close();
  await ctx.pool.end();
}
