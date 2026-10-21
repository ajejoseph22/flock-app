import { constantTimeEqual, ingestWebhookEvent, telegramUpdateExternalId, telegramUpdateType, type Logger } from "@flock/core";
import type { Database } from "@flock/db";

export const MAX_TELEGRAM_PAYLOAD_BYTES = 256_000;

/** Verify the secret token header, persist the update, enqueue processing. */
export async function handleTelegramWebhook(input: {
  db: Database;
  log: Logger;
  expectedSecret: string;
  secretHeader: string | null;
  rawBody: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!input.secretHeader || !constantTimeEqual(input.secretHeader, input.expectedSecret)) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (Buffer.byteLength(input.rawBody) > MAX_TELEGRAM_PAYLOAD_BYTES) return { status: 413, body: { error: "payload too large" } };
  let update: { update_id: number } & Record<string, unknown>;
  try {
    update = JSON.parse(input.rawBody) as typeof update;
    if (typeof update.update_id !== "number") throw new Error("missing update_id");
  } catch {
    return { status: 400, body: { error: "invalid payload" } };
  }
  try {
    const r = await ingestWebhookEvent(input.db, { provider: "telegram", externalId: telegramUpdateExternalId(update), type: telegramUpdateType(update), payload: update });
    return { status: 200, body: { ok: true, duplicate: r.duplicate } };
  } catch (err) {
    // Non-2xx makes Telegram retry the delivery later.
    input.log.error({ err: err instanceof Error ? err.message : String(err) }, "telegram webhook ingest failed");
    return { status: 500, body: { error: "ingest failed" } };
  }
}
