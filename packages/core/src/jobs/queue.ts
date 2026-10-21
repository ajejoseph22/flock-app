import { jobs, type DbOrTx } from "@flock/db";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { JobPayloads, JobType } from "./types";

export const JOBS_CHANNEL = "flock_jobs";

export interface EnqueueOptions {
  /** Skip if a queued job with this key exists. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/**
 * Enqueue a job. Pass a transaction to make the enqueue atomic with the state change that caused it (D-002).
 * Returns the job id, or null if deduplicated.
 */
export async function enqueue<T extends JobType>(
  db: DbOrTx,
  type: T,
  payload: JobPayloads[T],
  options: EnqueueOptions = {},
): Promise<string | null> {
  const rows = await db
    .insert(jobs)
    .values({
      type,
      payload: payload as Record<string, unknown>,
      dedupeKey: options.dedupeKey ?? null,
      runAt: options.runAt ?? new Date(),
      maxAttempts: options.maxAttempts ?? 10,
    })
    .onConflictDoNothing({
      target: jobs.dedupeKey,
      where: sql`${jobs.status} = 'queued' and ${jobs.dedupeKey} is not null`,
    })
    .returning({ id: jobs.id });
  if (rows[0]) {
    await db.execute(sql`select pg_notify(${JOBS_CHANNEL}, ${type})`);
  }
  return rows[0]?.id ?? null;
}

/**
 * Enqueue a job keyed by `onceKey` only if no job with that key has ever existed (any status).
 * Used for scheduled work so several worker replicas don't run the same time bucket twice.
 */
export async function enqueueOnce<T extends JobType>(db: DbOrTx, type: T, payload: JobPayloads[T], onceKey: string): Promise<boolean> {
  const result = await db.execute(sql`
    insert into ${jobs} (type, payload, dedupe_key, max_attempts)
    select ${type}, ${JSON.stringify(payload)}::jsonb, ${onceKey}, 3
    where not exists (select 1 from ${jobs} where dedupe_key = ${onceKey})
    on conflict do nothing
  `);
  const inserted = (result.rowCount ?? 0) > 0;
  if (inserted) await db.execute(sql`select pg_notify(${JOBS_CHANNEL}, ${type})`);
  return inserted;
}

export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** Atomically claim up to `limit` due jobs for this worker. */
export async function claimJobs(db: DbOrTx, workerId: string, limit: number): Promise<ClaimedJob[]> {
  const result = await db.execute<{ id: string; type: JobType; payload: Record<string, unknown>; attempts: number; max_attempts: number }>(sql`
    update ${jobs} set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1
    where id in (
      select id from ${jobs}
      where status = 'queued' and run_at <= now()
      order by run_at
      limit ${limit}
      for update skip locked
    )
    returning id, type, payload, attempts, max_attempts
  `);
  return result.rows.map((r) => ({ id: r.id, type: r.type, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts }));
}

export async function completeJob(db: DbOrTx, jobId: string): Promise<void> {
  await db.update(jobs).set({ status: "succeeded", finishedAt: new Date(), lockedAt: null, lastError: null }).where(eq(jobs.id, jobId));
}

/** Exponential backoff: 5s, 10s, 20s … capped at 1h, ±20% jitter. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(5_000 * 2 ** Math.max(0, attempt - 1), 3_600_000);
  return Math.round(base * (0.8 + random() * 0.4));
}

/**
 * Record a failure. Retries with backoff (or `retryAfterMs`) until max attempts, then marks `dead`.
 * `permanent` failures go straight to `failed` without retry.
 */
export async function failJob(
  db: DbOrTx,
  job: Pick<ClaimedJob, "id" | "attempts" | "maxAttempts">,
  error: string,
  options: { retryAfterMs?: number; permanent?: boolean } = {},
): Promise<"retry" | "dead" | "failed"> {
  const message = error.slice(0, 2_000);
  if (options.permanent) {
    await db.update(jobs).set({ status: "failed", lastError: message, finishedAt: new Date(), lockedAt: null }).where(eq(jobs.id, job.id));
    return "failed";
  }
  if (job.attempts >= job.maxAttempts) {
    await db.update(jobs).set({ status: "dead", lastError: message, finishedAt: new Date(), lockedAt: null }).where(eq(jobs.id, job.id));
    return "dead";
  }
  const delay = options.retryAfterMs ?? backoffMs(job.attempts);
  await db
    .update(jobs)
    .set({ status: "queued", lastError: message, runAt: new Date(Date.now() + delay), lockedAt: null, lockedBy: null })
    .where(eq(jobs.id, job.id));
  return "retry";
}

/** Requeue jobs whose worker died mid-run. */
export async function recoverStaleJobs(db: DbOrTx, staleAfterMs = 5 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null, lastError: "recovered after stale lock" })
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)))
    .returning({ id: jobs.id });
  return rows.length;
}

/** Delete finished jobs older than the retention window. */
export async function pruneJobs(db: DbOrTx, olderThan: Date): Promise<number> {
  const rows = await db
    .delete(jobs)
    .where(and(inArray(jobs.status, ["succeeded", "failed", "dead"]), lt(jobs.finishedAt, olderThan)))
    .returning({ id: jobs.id });
  return rows.length;
}
