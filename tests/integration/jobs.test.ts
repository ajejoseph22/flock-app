import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jobs } from "@flock/db";
import { claimJobs, completeJob, enqueue, enqueueOnce, failJob, recoverStaleJobs } from "@flock/core";
import { eq, sql } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe("durable job queue", () => {
  it("concurrent workers never claim the same job (SKIP LOCKED)", async () => {
    for (let i = 0; i < 40; i++) await enqueue(h.deps.db, "access.reconcile", { userId: `u${i}`, communityId: "c" });
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => claimJobs(h.deps.db, `w${i}`, 10)));
    const ids = results.flat().map((j) => j.id);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it("dedupes queued jobs by key but allows a new one while the first is running", async () => {
    const a = await enqueue(h.deps.db, "access.reconcile", { userId: "u", communityId: "c" }, { dedupeKey: "k" });
    const b = await enqueue(h.deps.db, "access.reconcile", { userId: "u", communityId: "c" }, { dedupeKey: "k" });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    await claimJobs(h.deps.db, "w", 1); // a is now running
    const c = await enqueue(h.deps.db, "access.reconcile", { userId: "u", communityId: "c" }, { dedupeKey: "k" });
    expect(c).not.toBeNull();
  });

  it("enqueue participates in the caller's transaction", async () => {
    await expect(
      h.deps.db.transaction(async (tx) => {
        await enqueue(tx, "cron.retention", {});
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await h.deps.db.select().from(jobs)).toHaveLength(0);
  });

  it("retries with backoff, honours retry_after, then dead-letters", async () => {
    await enqueue(h.deps.db, "cron.retention", {}, { maxAttempts: 2 });
    let [job] = await claimJobs(h.deps.db, "w", 1);
    expect(await failJob(h.deps.db, job!, "boom", { retryAfterMs: 30_000 })).toBe("retry");
    const [row] = await h.deps.db.select().from(jobs).where(eq(jobs.id, job!.id));
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect(await claimJobs(h.deps.db, "w", 1)).toHaveLength(0); // not due yet
    await h.deps.db.execute(sql`update jobs set run_at = now()`);
    [job] = await claimJobs(h.deps.db, "w", 1);
    expect(await failJob(h.deps.db, job!, "boom again")).toBe("dead");
  });

  it("recovers jobs whose worker died mid-run", async () => {
    await enqueue(h.deps.db, "cron.retention", {});
    const [job] = await claimJobs(h.deps.db, "w", 1);
    await h.deps.db.execute(sql`update jobs set locked_at = now() - interval '10 minutes'`);
    expect(await recoverStaleJobs(h.deps.db)).toBe(1);
    const [again] = await claimJobs(h.deps.db, "w2", 1);
    expect(again!.id).toBe(job!.id);
    expect(again!.attempts).toBe(2);
    await completeJob(h.deps.db, again!.id);
  });

  it("scheduled buckets run once across replicas", async () => {
    const results = await Promise.all([1, 2, 3].map(() => enqueueOnce(h.deps.db, "cron.expiry_sweep", {}, "cron:expiry:2026-01-01T00:00")));
    expect(results.filter(Boolean)).toHaveLength(1);
    const [job] = await claimJobs(h.deps.db, "w", 1);
    await completeJob(h.deps.db, job!.id);
    expect(await enqueueOnce(h.deps.db, "cron.expiry_sweep", {}, "cron:expiry:2026-01-01T00:00")).toBe(false);
  });
});
