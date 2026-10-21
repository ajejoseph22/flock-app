import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analyticsEvents } from "@flock/db";
import { AppError, createCommunity, ensureCreator, getOwnedCommunity, getSetupState, publishCommunity, startMerchantOnboarding, createPlan, startChatConnection } from "@flock/core";
import { createHarness, type Harness } from "./harness";
import { botPromoted, nextChatId, signIn } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

describe("creator onboarding", () => {
  it("creates a community and tracks the setup state step by step", async () => {
    const s = await signIn(h);
    const creator = await ensureCreator(h.deps.db, s.user);
    let state = await getSetupState(h.deps.db, creator.id);
    expect(state.steps.map((x) => [x.key, x.done])).toEqual([
      ["identity", true], ["community", false], ["telegram", false], ["stripe", false], ["plan", false], ["publish", false],
    ]);

    const community = await createCommunity(h.deps, creator.id, s.user.id, { name: "Signals", slug: "signals", benefits: ["A", "B"] });
    expect(community).toMatchObject({ status: "draft", slug: "signals", benefits: ["A", "B"] });
    await expect(publishCommunity(h.deps, creator.id, s.user.id)).rejects.toThrow(/Finish these steps/);

    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "supergroup", title: "Signals Group", ownerId: s.telegramUserId });
    await startChatConnection(h.deps, creator.id, { id: s.user.id, telegramUserId: s.telegramUserId }, "group");
    await botPromoted(h, chatId, s.telegramUserId, "Signals Group", "supergroup");
    await startMerchantOnboarding(h.deps, creator.id, s.user.id, { contactEmail: "c@example.com" });
    state = await getSetupState(h.deps.db, creator.id);
    expect(state.steps.find((x) => x.key === "telegram")?.done).toBe(true);
    expect(state.steps.find((x) => x.key === "stripe")?.done).toBe(false); // onboarding not finished

    await createPlan(h.deps, creator.id, s.user.id, { name: "Monthly", price: "9.99" });
    await expect(publishCommunity(h.deps, creator.id, s.user.id)).rejects.toThrow(/Connect Stripe/);

    await h.stripeMock.completeOnboarding([...h.stripeMock.accounts.keys()][0]!);
    await h.drain();
    await publishCommunity(h.deps, creator.id, s.user.id);
    expect((await getOwnedCommunity(h.deps.db, creator.id))?.status).toBe("published");

    const events = (await h.deps.db.select().from(analyticsEvents)).map((e) => e.name);
    for (const e of ["creator_registered", "community_created", "telegram_community_connected", "stripe_account_connected", "membership_plan_created", "membership_page_published"]) {
      expect(events).toContain(e);
    }
  });

  it("rejects duplicate and reserved slugs and enforces one community per creator", async () => {
    const a = await signIn(h);
    const ca = await ensureCreator(h.deps.db, a.user);
    await createCommunity(h.deps, ca.id, a.user.id, { name: "One", slug: "taken-slug" });
    await expect(createCommunity(h.deps, ca.id, a.user.id, { name: "Two", slug: "another" })).rejects.toMatchObject({ code: "community_limit" });
    const b = await signIn(h);
    const cb = await ensureCreator(h.deps.db, b.user);
    await expect(createCommunity(h.deps, cb.id, b.user.id, { name: "Xavier", slug: "taken-slug" })).rejects.toMatchObject({ code: "slug_taken" });
    await expect(createCommunity(h.deps, cb.id, b.user.id, { name: "Xavier", slug: "admin" })).rejects.toBeInstanceOf(AppError);
    await expect(createCommunity(h.deps, cb.id, b.user.id, { name: "Xavier", slug: "Bad Slug!" })).rejects.toBeInstanceOf(AppError);
  });

  it("tenant isolation: a creator can't load another creator's community", async () => {
    const a = await signIn(h);
    const ca = await ensureCreator(h.deps.db, a.user);
    const community = await createCommunity(h.deps, ca.id, a.user.id, { name: "Mine", slug: "mine-only" });
    const b = await signIn(h);
    const cb = await ensureCreator(h.deps.db, b.user);
    expect(await getOwnedCommunity(h.deps.db, cb.id, community.id)).toBeNull();
    expect(await getOwnedCommunity(h.deps.db, cb.id)).toBeNull();
  });
});
