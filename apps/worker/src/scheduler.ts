import { enqueueOnce, type Deps } from "@flock/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const bucket = (ms: number, now: number) => new Date(Math.floor(now / ms) * ms).toISOString();

/**
 * Recurring work is enqueued as ordinary jobs with a time-bucket key, so N worker replicas
 * produce exactly one job per bucket and the work gets the same retries and visibility.
 */
export async function scheduleTick(deps: Deps, now = Date.now()) {
  await enqueueOnce(deps.db, "cron.expiry_sweep", {}, `cron:expiry:${bucket(MINUTE, now)}`);
  await enqueueOnce(deps.db, "cron.reconcile", {}, `cron:reconcile:${bucket(HOUR, now)}`);
  await enqueueOnce(deps.db, "cron.retention", {}, `cron:retention:${bucket(DAY, now)}`);
}

export function startScheduler(deps: Deps): () => void {
  const tick = () => scheduleTick(deps).catch((err: unknown) => deps.log.error({ err: err instanceof Error ? err.message : String(err) }, "scheduler tick failed"));
  void tick();
  const timer = setInterval(tick, 20_000);
  return () => clearInterval(timer);
}
