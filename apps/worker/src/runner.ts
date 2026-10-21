import { AppError, claimJobs, completeJob, failJob, recoverStaleJobs, runJob, scrubSecrets, StripeGatewayError, TelegramApiError, JOBS_CHANNEL, type ClaimedJob, type Deps } from "@flock/core";
import type pg from "pg";
import { ZodError } from "zod";

export interface RunnerOptions {
  workerId: string;
  concurrency: number;
  pollIntervalMs?: number;
}

/** Decide retry policy from the error type. */
export function failurePolicy(err: unknown): { retryAfterMs?: number; permanent?: boolean } {
  if (err instanceof TelegramApiError && err.kind === "rate_limited") return { retryAfterMs: Math.max(1, err.retryAfterSeconds ?? 5) * 1000 + 250 };
  if (err instanceof AppError || err instanceof ZodError) return { permanent: true };
  if (err instanceof StripeGatewayError && err.kind === "not_found") return { permanent: true };
  return {};
}

/**
 * Claims jobs with SKIP LOCKED, runs up to `concurrency` at once, wakes on NOTIFY and polls as a fallback.
 */
export class JobRunner {
  private inflight = 0;
  private stopping = false;
  private wake: (() => void) | null = null;
  lastTickAt = Date.now();
  processed = 0;

  constructor(
    private readonly deps: Deps,
    private readonly pool: pg.Pool,
    private readonly opts: RunnerOptions,
  ) {}

  async start(): Promise<void> {
    await this.listen();
    void this.loop();
  }

  private async listen() {
    try {
      const client = await this.pool.connect();
      client.on("notification", () => this.wake?.());
      client.on("error", (err) => {
        this.deps.log.warn({ err: err.message }, "LISTEN connection lost; relying on polling");
      });
      await client.query(`LISTEN ${JOBS_CHANNEL}`);
      this.listenClient = client;
    } catch (err) {
      this.deps.log.warn({ err: err instanceof Error ? err.message : String(err) }, "LISTEN unavailable; polling only");
    }
  }
  private listenClient: pg.PoolClient | null = null;

  private async loop() {
    let lastRecovery = 0;
    while (!this.stopping) {
      this.lastTickAt = Date.now();
      try {
        if (Date.now() - lastRecovery > 60_000) {
          const recovered = await recoverStaleJobs(this.deps.db);
          if (recovered) this.deps.log.warn({ recovered }, "recovered stale jobs");
          lastRecovery = Date.now();
        }
        const capacity = this.opts.concurrency - this.inflight;
        if (capacity > 0) {
          const jobs = await claimJobs(this.deps.db, this.opts.workerId, capacity);
          for (const job of jobs) void this.execute(job);
          if (jobs.length === capacity) continue; // more work may be waiting
        }
      } catch (err) {
        this.deps.log.error({ err: err instanceof Error ? err.message : String(err) }, "job loop error");
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.opts.pollIntervalMs ?? 2_000);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  private async execute(job: ClaimedJob) {
    this.inflight++;
    const started = Date.now();
    const log = this.deps.log.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    try {
      const result = await runJob(this.deps, job.type, job.payload);
      await completeJob(this.deps.db, job.id);
      this.processed++;
      log.info({ ms: Date.now() - started, result: summarize(result) }, "job succeeded");
    } catch (err) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err));
      const outcome = await failJob(this.deps.db, job, message, failurePolicy(err)).catch(() => "unknown");
      log[outcome === "retry" ? "warn" : "error"]({ ms: Date.now() - started, err: message, outcome }, "job failed");
    } finally {
      this.inflight--;
      this.wake?.();
    }
  }

  async stop(timeoutMs = 25_000) {
    this.stopping = true;
    this.wake?.();
    const deadline = Date.now() + timeoutMs;
    while (this.inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    this.listenClient?.release();
  }
}

function summarize(result: unknown): unknown {
  if (result === undefined || result === null) return null;
  if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") return result;
  if (typeof result === "object" && "outcome" in result) return (result as { outcome: unknown }).outcome;
  return typeof result === "object" ? Object.keys(result).length : null;
}
