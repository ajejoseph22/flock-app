import { workerHeartbeats } from "@flock/db";
import { desc, sql } from "drizzle-orm";
import { deps } from "@/lib/server/deps";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKER_STALE_MS = 2 * 60_000;

/** Liveness + DB check. `?worker=1` also requires a recent worker heartbeat (for uptime monitors, not the deploy healthcheck). */
export async function GET(req: Request) {
  const d = deps();
  try {
    await d.db.execute(sql`select 1`);
  } catch {
    return json({ ok: false, db: "down" }, 503);
  }
  const checkWorker = new URL(req.url).searchParams.get("worker") === "1";
  if (!checkWorker) return json({ ok: true, db: "up" });
  const [beat] = await d.db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastBeatAt)).limit(1);
  const fresh = Boolean(beat && d.now().getTime() - beat.lastBeatAt.getTime() < WORKER_STALE_MS);
  return json({ ok: fresh, db: "up", worker: fresh ? "up" : "stale", lastBeatAt: beat?.lastBeatAt ?? null }, fresh ? 200 : 503);
}
