import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authChallenges, sessions } from "@flock/db";
import { createLoginChallenge, getSessionUser, hitRateLimit, pollLoginChallenge, revokeSession, safeReturnTo, sha256 } from "@flock/core";
import { eq } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";
import { nextTelegramId, signIn } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

async function startAndClaim(tgId: number) {
  const c = await createLoginChallenge(h.deps, {});
  const payload = new URL(c.deepLink).searchParams.get("start")!;
  const from = { id: tgId, is_bot: false, first_name: "T" };
  await h.telegram({ message: { message_id: 1, date: 0, chat: { id: tgId, type: "private", first_name: "T" }, from, text: `/start ${payload}` } });
  await h.drain();
  return { c, payload, from, prompt: h.tg.messagesTo(tgId).at(-1)! };
}

describe("Telegram sign-in", () => {
  it("signs in through deep link + confirm, storing only hashes", async () => {
    const s = await signIn(h, { firstName: "Ada", username: "ada" });
    expect(s.user).toMatchObject({ firstName: "Ada", telegramUsername: "ada", botChatStarted: true });
    const rows = await h.deps.db.select().from(authChallenges);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("consumed");
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const [session] = await h.deps.db.select().from(sessions);
    expect(session!.tokenHash).toBe(sha256(s.sessionToken));
    expect(session!.tokenHash).not.toContain(s.sessionToken);
  });

  it("is single use: a consumed challenge can't mint a second session", async () => {
    const tgId = nextTelegramId();
    const { c, from, prompt } = await startAndClaim(tgId);
    const cb = prompt.reply_markup!.inline_keyboard[0]![0]!.callback_data!;
    await h.telegram({ callback_query: { id: "1", from, chat_instance: "x", data: cb } as never });
    await h.drain();
    expect((await pollLoginChallenge(h.deps, c.browserCookie, {})).state).toBe("signed_in");
    expect((await pollLoginChallenge(h.deps, c.browserCookie, {})).state).toBe("invalid");
  });

  it("only the browser holding the challenge secret can consume it", async () => {
    const tgId = nextTelegramId();
    const { c, from, prompt } = await startAndClaim(tgId);
    await h.telegram({ callback_query: { id: "1", from, chat_instance: "x", data: prompt.reply_markup!.inline_keyboard[0]![0]!.callback_data! } as never });
    await h.drain();
    const forged = `${c.challengeId}.not-the-secret`;
    expect((await pollLoginChallenge(h.deps, forged, {})).state).toBe("invalid");
    expect((await pollLoginChallenge(h.deps, c.browserCookie, {})).state).toBe("signed_in");
  });

  it("a different Telegram user can't confirm someone else's claimed challenge", async () => {
    const { c, prompt } = await startAndClaim(nextTelegramId());
    const attacker = { id: nextTelegramId(), is_bot: false, first_name: "Mallory" };
    await h.telegram({ callback_query: { id: "2", from: attacker, chat_instance: "x", data: prompt.reply_markup!.inline_keyboard[0]![0]!.callback_data! } as never });
    await h.drain();
    expect((await pollLoginChallenge(h.deps, c.browserCookie, {})).state).toBe("claimed");
  });

  it("'Not me' rejects the challenge", async () => {
    const tgId = nextTelegramId();
    const { c, from, prompt } = await startAndClaim(tgId);
    await h.telegram({ callback_query: { id: "3", from, chat_instance: "x", data: prompt.reply_markup!.inline_keyboard[1]![0]!.callback_data! } as never });
    await h.drain();
    expect((await pollLoginChallenge(h.deps, c.browserCookie, {})).state).toBe("rejected");
  });

  it("expires after 10 minutes", async () => {
    const c = await createLoginChallenge(h.deps, {});
    h.clock.advanceHours(0.2);
    const payload = new URL(c.deepLink).searchParams.get("start")!;
    const tgId = nextTelegramId();
    await h.telegram({ message: { message_id: 1, date: 0, chat: { id: tgId, type: "private", first_name: "T" }, from: { id: tgId, is_bot: false, first_name: "T" }, text: `/start ${payload}` } });
    await h.drain();
    expect(h.tg.messagesTo(tgId).at(-1)?.text).toMatch(/expired/);
    expect((await pollLoginChallenge(h.deps, c.browserCookie, {})).state).toBe("expired");
  });

  it("logout revokes the session server-side", async () => {
    const s = await signIn(h);
    expect(await getSessionUser(h.deps.db, s.sessionToken, h.deps.now())).not.toBeNull();
    await revokeSession(h.deps.db, s.sessionToken);
    expect(await getSessionUser(h.deps.db, s.sessionToken, h.deps.now())).toBeNull();
  });

  it("expired sessions are rejected", async () => {
    const s = await signIn(h);
    h.clock.advanceDays(31);
    expect(await getSessionUser(h.deps.db, s.sessionToken, h.deps.now())).toBeNull();
  });

  it("rate limits by key and window", async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) expect(await hitRateLimit(h.deps.db, "k", 3, 60_000, now)).toBe(true);
    expect(await hitRateLimit(h.deps.db, "k", 3, 60_000, now)).toBe(false);
    expect(await hitRateLimit(h.deps.db, "k", 3, 60_000, new Date(now.getTime() + 61_000))).toBe(true);
  });

  it("only allows same-site relative return targets", () => {
    expect(safeReturnTo("/join/x")).toBe("/join/x");
    expect(safeReturnTo("https://evil.com")).toBeNull();
    expect(safeReturnTo("//evil.com")).toBeNull();
    expect(safeReturnTo("/\\evil.com")).toBeNull();
  });

  it("challenge tokens never appear in the DB in raw form", async () => {
    const c = await createLoginChallenge(h.deps, {});
    const token = new URL(c.deepLink).searchParams.get("start")!.slice(2);
    const [row] = await h.deps.db.select().from(authChallenges).where(eq(authChallenges.id, c.challengeId));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain(c.browserCookie.split(".")[1]);
  });
});
