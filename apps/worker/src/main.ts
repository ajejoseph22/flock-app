import { createServer } from "node:http";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { getConfig, ingestWebhookEvent, telegramUpdateExternalId, telegramUpdateType } from "@flock/core";
import { workerHeartbeats } from "@flock/db";
import { createTelegramApi, pollUpdates } from "@flock/telegram";
import { sql } from "drizzle-orm";
import { createWorkerDeps } from "./deps";
import { JobRunner } from "./runner";
import { startScheduler } from "./scheduler";

const VERSION = process.env.GIT_SHA?.slice(0, 7) ?? "dev";

async function main() {
  const config = getConfig();
  const { deps, handle } = createWorkerDeps(config);
  const workerId = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const log = deps.log.child({ workerId });
  log.info({ env: config.env, telegramMode: config.telegram.mode, version: VERSION }, "worker starting");

  await handle.db.execute(sql`select 1`);
  const startedAt = new Date();
  const beat = async () => {
    await handle.db
      .insert(workerHeartbeats)
      .values({ workerId, startedAt, lastBeatAt: new Date(), version: VERSION })
      .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastBeatAt: new Date() } });
  };
  await beat();
  const heartbeat = setInterval(() => beat().catch((err: unknown) => log.error({ err: String(err) }, "heartbeat failed")), 30_000);

  const runner = new JobRunner(deps, handle.pool, { workerId, concurrency: config.workerConcurrency });
  await runner.start();
  const stopScheduler = startScheduler(deps);

  const abort = new AbortController();
  if (config.telegram.mode === "polling") {
    log.info("telegram polling mode (development)");
    void pollUpdates(
      createTelegramApi({ token: config.telegram.botToken, apiRoot: config.telegram.apiRoot }),
      async (update) => {
        await ingestWebhookEvent(handle.db, {
          provider: "telegram",
          externalId: telegramUpdateExternalId(update),
          type: telegramUpdateType(update as unknown as Record<string, unknown>),
          payload: update,
        });
      },
      abort.signal,
      (m) => log.warn(m),
    );
  }

  const port = Number(process.env.PORT ?? process.env.WORKER_HEALTH_PORT ?? 8081);
  const server = createServer(async (req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404).end();
      return;
    }
    const loopHealthy = Date.now() - runner.lastTickAt < 60_000;
    const dbHealthy = await handle.db.execute(sql`select 1`).then(
      () => true,
      () => false,
    );
    const ok = loopHealthy && dbHealthy;
    res.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok, workerId, loopHealthy, dbHealthy, processed: runner.processed, version: VERSION }));
  });
  server.listen(port, () => log.info({ port }, "worker health server listening"));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "worker shutting down");
    abort.abort();
    stopScheduler();
    clearInterval(heartbeat);
    server.close();
    await runner.stop();
    await handle.db.delete(workerHeartbeats).where(sql`worker_id = ${workerId}`).catch(() => undefined);
    await handle.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("worker failed to start", err);
  process.exit(1);
});
