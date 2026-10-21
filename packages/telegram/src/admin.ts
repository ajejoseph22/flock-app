import { ALLOWED_UPDATES } from "@flock/core";
import type { Update } from "@grammyjs/types";
import type { Api } from "grammy";

/** Register the production webhook with a secret token (verified on every request). */
export async function registerWebhook(api: Api, url: string, secretToken: string) {
  await api.setWebhook(url, { secret_token: secretToken, allowed_updates: [...ALLOWED_UPDATES], drop_pending_updates: false, max_connections: 40 });
  await api.setMyCommands([
    { command: "status", description: "Your memberships and invite links" },
    { command: "support", description: "How to get help" },
    { command: "help", description: "What this bot does" },
  ]);
  return api.getWebhookInfo();
}

/**
 * Long-polling loop for local development (D-014). Each update is handed to `onUpdate`,
 * which must persist it (same ingest path as the webhook) before the offset advances.
 */
export async function pollUpdates(api: Api, onUpdate: (update: Update) => Promise<void>, signal: AbortSignal, log: (msg: string) => void = () => undefined) {
  await api.deleteWebhook({ drop_pending_updates: false });
  let offset = 0;
  while (!signal.aborted) {
    try {
      const updates = await api.getUpdates({ offset, timeout: 25, allowed_updates: [...ALLOWED_UPDATES] }, signal as Parameters<Api["getUpdates"]>[1]);
      for (const u of updates) {
        await onUpdate(u);
        offset = u.update_id + 1;
      }
    } catch (err) {
      if (signal.aborted) return;
      log(`polling error: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
}
