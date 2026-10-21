import { getConnectionRequest } from "@flock/core";
import { deps } from "@/lib/server/deps";
import { json } from "@/lib/server/http";
import { creatorForAction } from "@/lib/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Polled by the setup page while the creator adds the bot in Telegram. Scoped to the creator's own requests. */
export async function GET(req: Request) {
  const ctx = await creatorForAction();
  if (!ctx) return json({ error: "unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "not found" }, 404);
  const d = deps();
  const request = await getConnectionRequest(d.db, ctx.creator.id, id);
  if (!request) return json({ error: "not found" }, 404);
  const expired = request.status === "pending" && request.expiresAt <= d.now();
  return json({
    status: expired ? "expired" : request.status,
    chatTitle: request.chatTitle,
    failureMessage: request.failureMessage,
  });
}
