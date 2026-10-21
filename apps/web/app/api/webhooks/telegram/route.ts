import { handleTelegramWebhook } from "@flock/telegram";
import { deps } from "@/lib/server/deps";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const d = deps();
  const result = await handleTelegramWebhook({
    db: d.db,
    log: d.log,
    expectedSecret: d.config.telegram.webhookSecret,
    secretHeader: req.headers.get("x-telegram-bot-api-secret-token"),
    rawBody: await req.text(),
  });
  return json(result.body, result.status);
}
