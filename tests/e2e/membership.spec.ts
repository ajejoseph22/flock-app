import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { memberStatus, nextTelegramId, onboardCreator, requestToJoin, sendUpdate, signIn, stripeControl, stripeState, telegramState, waitForMessage } from "./helpers";
import { STRIPE_MOCK_URL } from "./env";

/**
 * The core paid-access loop, end to end through the real web app, worker, Postgres,
 * and the Stripe/Telegram SDK clients pointed at local MOCK providers.
 */
test.describe.serial("paid membership lifecycle", () => {
  const creator = { id: nextTelegramId(), first_name: "Cora", username: "cora_e2e" };
  const member = { id: nextTelegramId(), first_name: "Milo", username: "milo_e2e" };
  const slug = `e2e-${Date.now().toString(36)}`;
  let chatId = 0;
  let creatorCtx: BrowserContext;
  let memberCtx: BrowserContext;
  let creatorPage: Page;
  let memberPage: Page;
  let inviteLink = "";

  async function contexts(browser: Browser) {
    creatorCtx ??= await browser.newContext();
    memberCtx ??= await browser.newContext();
    creatorPage ??= await creatorCtx.newPage();
    memberPage ??= await memberCtx.newPage();
  }

  test.afterAll(async () => {
    await creatorCtx?.close();
    await memberCtx?.close();
  });

  test("creator completes onboarding and publishes", async ({ browser }) => {
    await contexts(browser);
    ({ chatId } = await onboardCreator(creatorPage, { creator, slug, name: "E2E Signals", price: "19" }));
    await creatorPage.goto("/dashboard");
    await expect(creatorPage.getByTestId("stat-active-members")).toHaveText("0");
  });

  test("visitor sees the public page and must sign in with Telegram to join", async ({ browser }) => {
    await contexts(browser);
    await memberPage.goto(`/join/${slug}`);
    await expect(memberPage.getByRole("heading", { level: 1, name: "E2E Signals" })).toBeVisible();
    await expect(memberPage.getByTestId("plan-price")).toContainText("$19");
    await memberPage.getByTestId("join-signin").click();
    await expect(memberPage).toHaveURL(new RegExp(`/login\\?returnTo=%2Fjoin%2F${slug}`));
    await signIn(memberPage, member);
    await expect(memberPage).toHaveURL(new RegExp(`/join/${slug}$`));
    await expect(memberPage.getByText("Joining as Milo")).toBeVisible();
  });

  test("the success redirect alone does not grant access", async ({ browser }) => {
    await contexts(browser);
    await memberPage.getByRole("button", { name: /Continue to payment/ }).click();
    await expect(memberPage.getByText("MOCK Stripe Checkout")).toBeVisible();
    const checkoutUrl = memberPage.url();
    const sessionId = new URL(checkoutUrl).pathname.split("/").pop()!;
    const session = (await (await memberPage.request.get(`${STRIPE_MOCK_URL}/_mock/state`)).json()).sessions.find((s: { id: string }) => s.id === sessionId);
    // Jump straight to the success URL without paying.
    await memberPage.goto(session.success_url);
    await expect(memberPage.getByTestId("status-title")).toHaveText("Confirming your payment");
    await memberPage.waitForTimeout(4000);
    await expect(memberPage.getByTestId("status-title")).toHaveText("Confirming your payment");
    await expect(memberPage.getByTestId("invite-link")).toHaveCount(0);
    await memberPage.goto(checkoutUrl);
  });

  test("paying on Stripe Checkout produces a personal invite", async ({ browser }) => {
    await contexts(browser);
    await memberPage.getByRole("button", { name: "Pay" }).click();
    await expect(memberPage).toHaveURL(new RegExp(`/join/${slug}/status\\?intent=`));
    await expect(memberPage.getByTestId("invite-link")).toBeVisible({ timeout: 20_000 });
    inviteLink = (await memberPage.getByTestId("invite-link").getAttribute("href"))!;
    expect(inviteLink).toMatch(/^https:\/\/t\.me\/\+/);
    // The bot also DMs the invite.
    await waitForMessage(memberPage.request, member.id, (m) => m.text.includes("E2E Signals"));
  });

  test("a forwarded invite link is declined for anyone else", async ({ browser }) => {
    await contexts(browser);
    const stranger = { id: nextTelegramId(), first_name: "Stranger" };
    await requestToJoin(memberPage.request, stranger, chatId, inviteLink);
    await expect.poll(async () => (await telegramState(memberPage.request)).calls.includes("declineChatJoinRequest"), { timeout: 15_000 }).toBe(true);
    expect(await memberStatus(memberPage.request, chatId, stranger.id)).toBe("left");
  });

  test("the paying member's join request is approved", async ({ browser }) => {
    await contexts(browser);
    await requestToJoin(memberPage.request, member, chatId, inviteLink);
    await expect.poll(() => memberStatus(memberPage.request, chatId, member.id), { timeout: 15_000 }).toBe("member");
    // Telegram then reports the membership change.
    await sendUpdate(memberPage.request, {
      chat_member: {
        chat: { id: chatId, type: "channel", title: "chat" },
        from: { id: member.id, is_bot: false, first_name: member.first_name },
        date: 0,
        old_chat_member: { status: "left", user: { ...member, is_bot: false } },
        new_chat_member: { status: "member", user: { ...member, is_bot: false } },
      },
    });
    await expect(memberPage.getByTestId("status-title")).toHaveText("Welcome to E2E Signals", { timeout: 20_000 });
  });

  test("creator sees the member, revenue and timeline", async ({ browser }) => {
    await contexts(browser);
    await creatorPage.goto("/dashboard");
    await expect(creatorPage.getByTestId("stat-active-members")).toHaveText("1");
    await expect(creatorPage.getByTestId("stat-mrr")).toHaveText("$19");
    await expect(creatorPage.getByText("Recent payments").locator("..").locator("..").getByText("Milo")).toBeVisible();

    await creatorPage.goto("/dashboard/members");
    const row = creatorPage.getByTestId("member-row").filter({ hasText: "Milo" });
    await expect(row.getByText("Active")).toBeVisible();
    await expect(row.getByText("In chat")).toBeVisible();
    await creatorPage.getByLabel("Search members").fill("milo_e2e");
    await creatorPage.getByRole("button", { name: "Apply" }).click();
    await expect(creatorPage.getByTestId("member-row")).toHaveCount(1);
    await creatorPage.getByRole("link", { name: "Milo" }).click();
    await expect(creatorPage.getByText("Join request approved")).toBeVisible();
    await expect(creatorPage.getByText("Access granted")).toBeVisible();
  });

  test("member manages billing from their account page", async ({ browser }) => {
    await contexts(browser);
    await memberPage.goto("/account");
    const card = memberPage.getByTestId("membership-card").filter({ hasText: "E2E Signals" });
    await expect(card.getByText("Active")).toBeVisible();
    await expect(card.getByText(/Renews/)).toBeVisible();
    await card.getByRole("button", { name: "Manage or cancel" }).click();
    await expect(memberPage.getByText(/MOCK billing portal/)).toBeVisible();
  });

  test("bot /status lists the membership", async ({ browser }) => {
    await contexts(browser);
    const before = Math.max(0, ...(await telegramState(memberPage.request)).sent.map((m) => m.message_id));
    await sendUpdate(memberPage.request, {
      message: { message_id: 9, date: 0, chat: { id: member.id, type: "private" }, from: { ...member, is_bot: false }, text: "/status" },
    });
    await waitForMessage(memberPage.request, member.id, (m) => m.message_id > before && m.text.includes("E2E Signals"));
  });

  test("when the paid period is over and the subscription ends, the bot removes the member", async ({ browser }) => {
    await contexts(browser);
    const subs = (await stripeState(memberPage.request)).subscriptions.filter((s) => s.status === "active");
    const sub = subs.at(-1)!;
    // Simulated time: the member canceled and the paid month ran out (like a Stripe test clock).
    await stripeControl(memberPage.request, `subscriptions/${sub.id}/expire-period`);
    await stripeControl(memberPage.request, `subscriptions/${sub.id}/end`);
    await expect.poll(() => memberStatus(memberPage.request, chatId, member.id), { timeout: 20_000 }).not.toBe("member");
    expect((await telegramState(memberPage.request)).calls).toContain("banChatMember");
    // The creator (chat owner) is never removed.
    expect(await memberStatus(memberPage.request, chatId, creator.id)).toBe("creator");

    await creatorPage.goto("/dashboard/members");
    const row = creatorPage.getByTestId("member-row").filter({ hasText: "Milo" });
    await expect(row.getByText("Ended", { exact: true })).toBeVisible();
    await expect(row.getByText("Removed")).toBeVisible();

    await memberPage.goto("/account");
    await expect(memberPage.getByTestId("membership-card").filter({ hasText: "E2E Signals" }).getByText(/Access ended/)).toBeVisible();
  });
});
