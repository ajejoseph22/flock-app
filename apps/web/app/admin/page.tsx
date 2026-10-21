import { communities, creators, entitlements, jobs, users, webhookEvents, workerHeartbeats } from "@flock/db";
import { and, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { Logo } from "@/components/site/logo";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireAdmin } from "@/lib/server/session";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };
export const dynamic = "force-dynamic";

/** Operator view. 404s unless the signed-in Telegram user ID is in ADMIN_TELEGRAM_USER_IDS. */
export default async function AdminPage() {
  await requireAdmin();
  const d = deps();
  const db = d.db;
  const since = new Date(d.now().getTime() - 24 * 3_600_000);

  const [[userCount], [creatorCount], [publishedCount], [activeEnts], webhookStats, jobStats, heartbeats, failedWebhooks, deadJobs] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(creators),
    db.select({ n: count() }).from(communities).where(eq(communities.status, "published")),
    db.select({ n: count() }).from(entitlements).where(eq(entitlements.status, "active")),
    db
      .select({ provider: webhookEvents.provider, status: webhookEvents.status, n: count() })
      .from(webhookEvents)
      .where(gt(webhookEvents.receivedAt, since))
      .groupBy(webhookEvents.provider, webhookEvents.status),
    db.select({ status: jobs.status, n: count() }).from(jobs).groupBy(jobs.status),
    db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastBeatAt)).limit(5),
    db.select().from(webhookEvents).where(eq(webhookEvents.status, "failed")).orderBy(desc(webhookEvents.receivedAt)).limit(20),
    db.select().from(jobs).where(inArray(jobs.status, ["dead"])).orderBy(desc(jobs.finishedAt)).limit(20),
  ]);
  const [lag] = await db
    .select({ oldest: sql<Date | null>`min(${jobs.runAt})` })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), sql`${jobs.runAt} <= now()`));

  return (
    <div className="min-h-dvh">
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Logo href="/admin" />
          <Badge tone="warning">Operator</Badge>
        </div>
      </header>
      <main id="main" className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-4">
          <Metric label="Users" value={userCount?.n ?? 0} />
          <Metric label="Creators" value={creatorCount?.n ?? 0} />
          <Metric label="Published communities" value={publishedCount?.n ?? 0} />
          <Metric label="Active entitlements" value={activeEnts?.n ?? 0} />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Workers</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {heartbeats.length === 0 ? (
                <p className="text-danger">No worker has ever reported in.</p>
              ) : (
                <ul className="divide-y">
                  {heartbeats.map((h) => {
                    const fresh = d.now().getTime() - h.lastBeatAt.getTime() < 2 * 60_000;
                    return (
                      <li key={h.workerId} className="flex justify-between gap-3 py-2">
                        <span className="font-mono text-xs">{h.workerId}</span>
                        <span className="flex items-center gap-2">
                          <Badge tone={fresh ? "success" : "danger"}>{fresh ? "Up" : "Stale"}</Badge>
                          <span className="text-xs text-muted-foreground">{formatDateTime(h.lastBeatAt)}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-3 text-xs text-muted-foreground">Oldest runnable queued job: {lag?.oldest ? formatDateTime(new Date(lag.oldest)) : "none"}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Queue and webhooks (24h)</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <p className="flex flex-wrap gap-2">
                {jobStats.map((j) => (
                  <Badge key={j.status} tone={j.status === "dead" ? "danger" : j.status === "failed" ? "warning" : "neutral"}>
                    jobs {j.status}: {j.n}
                  </Badge>
                ))}
              </p>
              <p className="flex flex-wrap gap-2">
                {webhookStats.map((w) => (
                  <Badge key={`${w.provider}-${w.status}`} tone={w.status === "failed" ? "danger" : "neutral"}>
                    {w.provider} {w.status}: {w.n}
                  </Badge>
                ))}
              </p>
            </CardContent>
          </Card>
        </div>
        <ErrorList
          title="Failed webhook events"
          rows={failedWebhooks.map((w) => ({ id: w.id, label: `${w.provider} ${w.type}`, error: w.lastError, at: w.receivedAt, attempts: w.attempts }))}
        />
        <ErrorList title="Dead jobs" rows={deadJobs.map((j) => ({ id: j.id, label: j.type, error: j.lastError, at: j.finishedAt ?? j.createdAt, attempts: j.attempts }))} />
      </main>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

function ErrorList({ title, rows }: { title: string; rows: { id: string; label: string; error: string | null; at: Date; attempts: number }[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y text-sm">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-2">
                <span className="flex justify-between gap-3">
                  <span className="font-medium">{r.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.attempts} attempts · {formatDateTime(r.at)}
                  </span>
                </span>
                {r.error && <code className="text-xs break-all text-danger">{r.error}</code>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
