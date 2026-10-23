import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { APP_URL, BOT_ID, E2E_ENV, STRIPE_MOCK_URL, TELEGRAM_MOCK_URL } from "./env";

let updateSeq = Math.floor(Date.now() / 1000) % 1_000_000;
let idSeq = 0;

/** Unique fake Telegram identities per test run. */
export function nextTelegramId() {
  return 6_000_000 + (Date.now() % 1_000_000) * 10 + idSeq++;
}
export function nextChatId() {
  return -1_002_000_000_000 - (Date.now() % 1_000_000) * 10 - idSeq++;
}

export interface TgUser {
  id: number;
  first_name: string;
  username?: string;
}

/** Act as Telegram: deliver an update to the app's real webhook endpoint with the secret header. */
export async function sendUpdate(request: APIRequestContext, update: Record<string, unknown>) {
  const res = await request.post(`${APP_URL}/api/webhooks/telegram`, {
    headers: { "x-telegram-bot-api-secret-token": E2E_ENV.TELEGRAM_WEBHOOK_SECRET! },
    data: { update_id: ++updateSeq, ...update },
  });
  expect(res.status()).toBe(200);
}

interface MockMessage {
  chat_id: number;
  text: string;
  message_id: number;
  reply_markup?: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] };
}

export async function telegramState(request: APIRequestContext) {
  const res = await request.get(`${TELEGRAM_MOCK_URL}/_mock/state`);
  return (await res.json()) as { chats: { id: number; members: Record<string, { status: string }> }[]; sent: MockMessage[]; calls: string[] };
}

export async function waitForMessage(request: APIRequestContext, chatId: number, predicate: (m: MockMessage) => boolean) {
  let found: MockMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await telegramState(request)).sent.filter((m) => m.chat_id === chatId).find(predicate);
        return Boolean(found);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return found!;
}

export async function memberStatus(request: APIRequestContext, chatId: number, userId: number) {
  const state = await telegramState(request);
  return state.chats.find((c) => c.id === chatId)?.members[String(userId)]?.status ?? "left";
}

/** Full Telegram sign-in: open /login, "press Start" in the bot, tap Confirm. */
export async function signIn(page: Page, user: TgUser, returnTo?: string) {
  if (returnTo !== undefined || !page.url().includes("/login")) {
    await page.goto(returnTo ? `/login?returnTo=${encodeURIComponent(returnTo)}` : "/login");
  }
  const link = page.getByTestId("telegram-login-link");
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  const payload = new URL(href).searchParams.get("start")!;
  expect(payload).toMatch(/^l_[\w-]{20,}$/);
  const request = page.request;
  await sendUpdate(request, {
    message: { message_id: 1, date: 0, chat: { id: user.id, type: "private", first_name: user.first_name }, from: { ...user, is_bot: false }, text: `/start ${payload}` },
  });
  const prompt = await waitForMessage(request, user.id, (m) => Boolean(m.reply_markup?.inline_keyboard.flat().some((b) => b.callback_data?.startsWith("auth:ok:"))));
  const confirm = prompt.reply_markup!.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("auth:ok:"))!;
  await sendUpdate(request, {
    callback_query: {
      id: `cq${Date.now()}`,
      from: { ...user, is_bot: false },
      chat_instance: "e2e",
      data: confirm.callback_data,
      message: { message_id: prompt.message_id, date: 0, chat: { id: user.id, type: "private", first_name: user.first_name } },
    },
  });
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

/** Creator onboarding through the real UI and provider mocks. Returns the published slug and chat. */
export async function onboardCreator(page: Page, opts: { creator: TgUser; slug: string; name: string; price: string; chatType?: "channel" | "group" }) {
  const request = page.request;
  const chatId = nextChatId();
  const chatType = opts.chatType ?? "channel";
  await signIn(page, opts.creator, "/dashboard");
  await page.goto("/dashboard/setup");

  await page.getByLabel("Community name").fill(opts.name);
  await page.getByLabel("Page address").fill(opts.slug);
  await page.getByLabel("Description").fill("E2E test community.");
  await page.getByLabel("Benefits").fill("Daily notes\nWeekly Q&A");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // Telegram: the creator owns a private chat in (mock) Telegram and adds the bot as admin.
  await request.post(`${TELEGRAM_MOCK_URL}/_mock/chat`, {
    data: { id: chatId, type: chatType === "channel" ? "channel" : "supergroup", title: `${opts.name} chat`, ownerId: opts.creator.id },
  });
  await page.getByTestId("has-chat-yes").click();
  await page.getByRole("button", { name: chatType === "channel" ? /Private channel/ : /Private group/ }).click();
  await expect(page.getByTestId("add-bot-link")).toBeVisible();
  await sendUpdate(request, {
    my_chat_member: {
      chat: { id: chatId, type: chatType === "channel" ? "channel" : "supergroup", title: `${opts.name} chat` },
      from: { ...opts.creator, is_bot: false },
      date: 0,
      old_chat_member: { status: "left", user: { id: BOT_ID, is_bot: true, first_name: "Flock" } },
      new_chat_member: {
        status: "administrator",
        user: { id: BOT_ID, is_bot: true, first_name: "Flock" },
        can_be_edited: false,
        is_anonymous: false,
        can_manage_chat: true,
        can_delete_messages: false,
        can_manage_video_chats: false,
        can_restrict_members: true,
        can_promote_members: false,
        can_change_info: false,
        can_invite_users: true,
        can_post_stories: false,
        can_edit_stories: false,
        can_delete_stories: false,
      },
    },
  });
  await expect(page.getByTestId("setup-step-3").getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });

  // Stripe: hosted onboarding (mock completes immediately and returns to Flock).
  await page.getByLabel("Contact email").fill("creator@example.com");
  await page.getByRole("button", { name: /Continue to Stripe/ }).click();
  await page.waitForURL(/\/dashboard\/setup\?stripe=returned/);
  await expect(page.getByText("Back from Stripe")).toBeVisible();
  await expect(page.getByTestId("setup-step-4").getByText("Ready")).toBeVisible();

  await page.getByLabel("Monthly price").fill(opts.price);
  await page.getByRole("button", { name: "Create plan" }).click();
  await expect(page.getByTestId("setup-step-5").getByText(/\/ month/)).toBeVisible();

  await page.getByRole("button", { name: "Publish page" }).click();
  await expect(page.getByTestId("public-link")).toContainText(`/join/${opts.slug}`);
  return { chatId, slug: opts.slug };
}

/** Act as the member's Telegram client: open the invite link → send a join request. */
export async function requestToJoin(request: APIRequestContext, user: TgUser, chatId: number, inviteLink: string) {
  await sendUpdate(request, {
    chat_join_request: {
      chat: { id: chatId, type: "channel", title: "chat" },
      from: { ...user, is_bot: false },
      user_chat_id: user.id,
      date: Math.floor(Date.now() / 1000),
      invite_link: { invite_link: inviteLink, creator: { id: BOT_ID, is_bot: true, first_name: "Flock" }, creates_join_request: true, is_primary: false, is_revoked: false },
    },
  });
}

export async function stripeState(request: APIRequestContext) {
  const res = await request.get(`${STRIPE_MOCK_URL}/_mock/state`);
  return (await res.json()) as { subscriptions: { id: string; status: string; account: string }[]; emitted: { type: string }[] };
}

export async function stripeControl(request: APIRequestContext, path: string, body: Record<string, unknown> = {}) {
  const res = await request.post(`${STRIPE_MOCK_URL}/_mock/${path}`, { data: body });
  expect(res.ok()).toBe(true);
}
