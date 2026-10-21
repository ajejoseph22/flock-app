import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness";
import { nextTelegramId, publishedCommunity, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

async function send(tgId: number, text: string) {
  await h.telegram({ message: { message_id: 1, date: 0, chat: { id: tgId, type: "private", first_name: "U" }, from: { id: tgId, is_bot: false, first_name: "U" }, text } });
  await h.drain();
  return h.tg.messagesTo(tgId).at(-1)!;
}

describe("bot commands", () => {
  it("/start, /help and /support respond without payment links", async () => {
    const id = nextTelegramId();
    for (const cmd of ["/start", "/help", "/support", "/whatever"]) {
      const m = await send(id, cmd);
      expect(m.text.length).toBeGreaterThan(10);
      expect(m.text).not.toMatch(/checkout|stripe\.com\/pay|buy\.stripe/i);
      expect(m.reply_markup).toBeUndefined();
    }
    expect((await send(id, "/support")).text).toContain("support@useflock.com");
  });

  it("/status lists memberships", async () => {
    const pc = await publishedCommunity(h);
    const buyer = await subscribe(h, pc.community.slug);
    const reply = h.tg.messagesTo(buyer.telegramUserId);
    await send(buyer.telegramUserId, "/status");
    const texts = h.tg.messagesTo(buyer.telegramUserId).slice(reply.length).map((m) => m.text);
    expect(texts.join("\n")).toContain("Alpha Club");
    expect(texts.join("\n")).toContain("not joined yet");
  });

  it("/status for a stranger says there are no memberships", async () => {
    expect((await send(nextTelegramId(), "/status")).text).toMatch(/don't have any/);
  });

  it("ignores messages in groups", async () => {
    const before = h.tg.sent.length;
    await h.telegram({ message: { message_id: 1, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, from: { id: 5, is_bot: false, first_name: "U" }, text: "/status" } });
    await h.drain();
    expect(h.tg.sent.length).toBe(before);
  });

  it("rejects webhook calls without the secret token", async () => {
    const { handleTelegramWebhook } = await import("@flock/telegram");
    const r = await handleTelegramWebhook({ db: h.deps.db, log: h.deps.log, expectedSecret: h.deps.config.telegram.webhookSecret, secretHeader: "wrong", rawBody: "{}" });
    expect(r.status).toBe(401);
    const r2 = await handleTelegramWebhook({ db: h.deps.db, log: h.deps.log, expectedSecret: h.deps.config.telegram.webhookSecret, secretHeader: null, rawBody: "{}" });
    expect(r2.status).toBe(401);
  });

  it("deduplicates redelivered Telegram updates", async () => {
    const { handleTelegramWebhook } = await import("@flock/telegram");
    const body = JSON.stringify({ update_id: 424242, message: { message_id: 1, date: 0, chat: { id: 77, type: "private", first_name: "U" }, from: { id: 77, is_bot: false, first_name: "U" }, text: "/help" } });
    const args = { db: h.deps.db, log: h.deps.log, expectedSecret: h.deps.config.telegram.webhookSecret, secretHeader: h.deps.config.telegram.webhookSecret, rawBody: body };
    expect((await handleTelegramWebhook(args)).body.duplicate).toBe(false);
    expect((await handleTelegramWebhook(args)).body.duplicate).toBe(true);
    await h.drain();
    expect(h.tg.messagesTo(77)).toHaveLength(1);
  });
});
