import { createLoginChallenge, pollLoginChallenge, getSessionUser, ensureCreator, createCommunity, startChatConnection, startMerchantOnboarding, createPlan, publishCommunity, createCheckout } from "@flock/core";
import type { Harness } from "./harness";

let tgSeq = 100_000_000;
export const nextTelegramId = () => tgSeq++;
let chatSeq = 1_000_000_000_000;
export const nextChatId = () => -chatSeq++;

/** Full sign-in through the real bot flow: challenge → /start → confirm callback → browser poll. */
export async function signIn(h: Harness, profile: { id?: number; firstName?: string; username?: string } = {}) {
  const tgId = profile.id ?? nextTelegramId();
  const from = { id: tgId, is_bot: false, first_name: profile.firstName ?? "Test", username: profile.username ?? `user${tgId}` };
  const challenge = await createLoginChallenge(h.deps, { returnTo: "/dashboard" });
  const payload = new URL(challenge.deepLink).searchParams.get("start")!;
  await h.telegram({ message: { message_id: 1, date: 0, chat: { id: tgId, type: "private", first_name: from.first_name }, from, text: `/start ${payload}` } });
  await h.drain();
  const prompt = h.tg.messagesTo(tgId).at(-1)!;
  const confirm = prompt.reply_markup!.inline_keyboard[0]![0]!.callback_data!;
  await h.telegram({ callback_query: { id: `cb${tgId}`, from, chat_instance: "x", data: confirm, message: { message_id: prompt.message_id, date: 0, chat: { id: tgId, type: "private", first_name: from.first_name } } } as never });
  await h.drain();
  const poll = await pollLoginChallenge(h.deps, challenge.browserCookie, {});
  if (poll.state !== "signed_in") throw new Error(`sign-in failed: ${poll.state}`);
  const session = await getSessionUser(h.deps.db, poll.sessionToken, h.deps.now());
  return { user: session!.user, sessionToken: poll.sessionToken, telegramUserId: tgId, from };
}

/** Bot promoted to admin in `chatId` by `fromId` (Telegram's my_chat_member update). */
export async function botPromoted(h: Harness, chatId: number, fromId: number, title = "Test Channel", type: "channel" | "supergroup" = "channel") {
  await h.telegram({
    my_chat_member: {
      chat: { id: chatId, type, title } as never,
      from: { id: fromId, is_bot: false, first_name: "Owner" },
      date: 0,
      old_chat_member: { status: "left", user: { id: h.deps.telegram.botId, is_bot: true, first_name: "Flock" } },
      new_chat_member: {
        status: "administrator",
        user: { id: h.deps.telegram.botId, is_bot: true, first_name: "Flock" },
        can_be_edited: false, is_anonymous: false, can_manage_chat: true, can_delete_messages: false, can_manage_video_chats: false,
        can_restrict_members: true, can_promote_members: false, can_change_info: false, can_invite_users: true,
        can_post_stories: false, can_edit_stories: false, can_delete_stories: false, can_send_welcome_messages: false,
      },
    },
  });
  await h.drain();
}

/** A creator with a connected chat, an onboarded merchant, an active plan and a published page. */
export async function publishedCommunity(h: Harness, opts: { slug?: string; price?: string } = {}) {
  const creator = await signIn(h, { firstName: "Creator" });
  const c = await ensureCreator(h.deps.db, creator.user);
  const community = await createCommunity(h.deps, c.id, creator.user.id, { name: "Alpha Club", slug: opts.slug ?? `alpha-${creator.telegramUserId}`, description: "Research", benefits: ["Daily notes"] });
  const chatId = nextChatId();
  h.tg.addChat({ id: chatId, type: "channel", title: "Alpha Channel", ownerId: creator.telegramUserId });
  await startChatConnection(h.deps, c.id, { id: creator.user.id, telegramUserId: creator.telegramUserId }, "channel");
  await botPromoted(h, chatId, creator.telegramUserId, "Alpha Channel");
  await startMerchantOnboarding(h.deps, c.id, creator.user.id, { contactEmail: "creator@example.com" });
  const accountId = [...h.stripeMock.accounts.keys()].at(-1)!;
  await h.stripeMock.completeOnboarding(accountId);
  await h.drain();
  const plan = await createPlan(h.deps, c.id, creator.user.id, { name: "Monthly", description: "", price: opts.price ?? "19" });
  await publishCommunity(h.deps, c.id, creator.user.id);
  return { creator, creatorRow: c, community, chatId, accountId, plan };
}

/** A subscriber who signs in and pays through the mock hosted Checkout. Webhooks are delivered and drained. */
export async function subscribe(h: Harness, slug: string, opts: { fail?: boolean; subscriber?: Awaited<ReturnType<typeof signIn>> } = {}) {
  const sub = opts.subscriber ?? (await signIn(h, { firstName: "Buyer" }));
  const checkout = await createCheckout(h.deps, sub.user, slug);
  const sessionId = new URL(checkout.url).pathname.split("/").at(-1)!;
  const paid = await h.stripeMock.payCheckout(sessionId, { fail: opts.fail });
  await h.drain();
  return { ...sub, intentId: checkout.intentId, stripeSubscriptionId: paid.subscriptionId };
}

/** The subscriber taps the invite link and requests to join. */
export async function requestJoin(h: Harness, chatId: number, telegramUserId: number) {
  await h.telegram({
    chat_join_request: {
      chat: { id: chatId, type: "channel", title: "Alpha Channel" } as never,
      from: { id: telegramUserId, is_bot: false, first_name: "Buyer" },
      user_chat_id: telegramUserId,
      date: 0,
    },
  });
  await h.drain();
}
