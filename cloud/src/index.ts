// Boot the Cloud Control Plane: config -> (optional) migrate -> context -> HTTP+WS server
// -> reconcile loop. Graceful shutdown on SIGINT/SIGTERM.
import { loadConfig } from "./config.js";
import { buildContext, shutdownContext } from "./context.js";
import { buildApp } from "./app.js";
import { runMigrations } from "./migrate.js";
import { log } from "./lib/log.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await buildContext(config);

  if (config.runMigrations) {
    const applied = await runMigrations(ctx.pool);
    log.info("startup migrations", { applied });
  }
  await ctx.builds.ensureUploadsDir();

  const app = await buildApp(ctx);
  await app.listen({ host: "0.0.0.0", port: config.port });
  ctx.reconcile.start();
  log.info("cloud control plane up", {
    port: config.port,
    nats: config.natsUrl ?? "in-process",
  });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    try {
      await app.close();
      await shutdownContext(ctx);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal boot error", { err: String(err) });
  process.exit(1);
});
