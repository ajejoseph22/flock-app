import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chatConnectionRequests, telegramChats } from "@flock/db";
import { createCommunity, disconnectCommunityChat, ensureCreator, recheckCommunityChat, startChatConnection } from "@flock/core";
import { eq } from "drizzle-orm";
import { createHarness, type Harness } from "./harness";
import { botPromoted, nextChatId, nextTelegramId, publishedCommunity, signIn, subscribe } from "./fixtures";

let h: Harness;
beforeAll(async () => (h = await createHarness()));
afterAll(async () => h.close());
beforeEach(async () => h.reset());

async function creatorWithCommunity() {
  const s = await signIn(h);
  const c = await ensureCreator(h.deps.db, s.user);
  const community = await createCommunity(h.deps, c.id, s.user.id, { name: "Club", slug: `club-${s.telegramUserId}` });
  return { s, c, community };
}

describe("Telegram chat connection", () => {
  it("connects only when the promoting user has a pending request and admin rights, storing the numeric chat id", async () => {
    const { s, c, community } = await creatorWithCommunity();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "channel", title: "Premium", ownerId: s.telegramUserId });
    const { request, deepLink } = await startChatConnection(h.deps, c.id, { id: s.user.id, telegramUserId: s.telegramUserId }, "channel");
    expect(deepLink).toBe("https://t.me/flock_test_bot?startchannel&admin=invite_users+restrict_members");
    await botPromoted(h, chatId, s.telegramUserId, "Premium");
    const [chat] = await h.deps.db.select().from(telegramChats).where(eq(telegramChats.communityId, community.id));
    expect(chat).toMatchObject({ telegramChatId: chatId, chatType: "channel", status: "connected", botCanInviteUsers: true, botCanRestrictMembers: true });
    const [req] = await h.deps.db.select().from(chatConnectionRequests).where(eq(chatConnectionRequests.id, request.id));
    expect(req!.status).toBe("completed");
  });

  it("ignores promotions by users without a pending request (no claiming by typing a username)", async () => {
    await creatorWithCommunity();
    const stranger = nextTelegramId();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "channel", title: "Someone else's", ownerId: stranger });
    await botPromoted(h, chatId, stranger, "Someone else's");
    expect(await h.deps.db.select().from(telegramChats)).toHaveLength(0);
  });

  it("rejects when the requester isn't an admin of that chat", async () => {
    const { s, c } = await creatorWithCommunity();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "channel", title: "Not mine", ownerId: nextTelegramId() });
    h.tg.setMember(chatId, s.telegramUserId, { status: "member" });
    const { request } = await startChatConnection(h.deps, c.id, { id: s.user.id, telegramUserId: s.telegramUserId }, "channel");
    await botPromoted(h, chatId, s.telegramUserId, "Not mine");
    const [req] = await h.deps.db.select().from(chatConnectionRequests).where(eq(chatConnectionRequests.id, request.id));
    expect(req).toMatchObject({ status: "failed", failureCode: "requester_not_admin" });
  });

  it("rejects when the bot lacks the ban right", async () => {
    const { s, c } = await creatorWithCommunity();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "channel", title: "Weak", ownerId: s.telegramUserId, botRights: { invite: true, restrict: false } });
    const { request } = await startChatConnection(h.deps, c.id, { id: s.user.id, telegramUserId: s.telegramUserId }, "channel");
    await botPromoted(h, chatId, s.telegramUserId, "Weak");
    const [req] = await h.deps.db.select().from(chatConnectionRequests).where(eq(chatConnectionRequests.id, request.id));
    expect(req).toMatchObject({ status: "failed", failureCode: "missing_restrict_right" });
    expect(h.tg.messagesTo(s.telegramUserId).at(-1)?.text).toMatch(/Ban users/);
  });

  it("a chat can belong to only one community", async () => {
    const a = await creatorWithCommunity();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "channel", title: "Shared", ownerId: a.s.telegramUserId });
    await startChatConnection(h.deps, a.c.id, { id: a.s.user.id, telegramUserId: a.s.telegramUserId }, "channel");
    await botPromoted(h, chatId, a.s.telegramUserId, "Shared");
    const b = await creatorWithCommunity();
    h.tg.setMember(chatId, b.s.telegramUserId, { status: "administrator", can_invite_users: true, can_restrict_members: true });
    const { request } = await startChatConnection(h.deps, b.c.id, { id: b.s.user.id, telegramUserId: b.s.telegramUserId }, "channel");
    await botPromoted(h, chatId, b.s.telegramUserId, "Shared");
    const [req] = await h.deps.db.select().from(chatConnectionRequests).where(eq(chatConnectionRequests.id, request.id));
    expect(req).toMatchObject({ status: "failed", failureCode: "chat_already_connected" });
  });

  it("detects bot removal and recovers on re-check", async () => {
    const { s, c, community } = await creatorWithCommunity();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "channel", title: "X", ownerId: s.telegramUserId });
    await startChatConnection(h.deps, c.id, { id: s.user.id, telegramUserId: s.telegramUserId }, "channel");
    await botPromoted(h, chatId, s.telegramUserId, "X");
    h.tg.setMember(chatId, h.deps.telegram.botId, { status: "left" });
    await h.telegram({
      my_chat_member: {
        chat: { id: chatId, type: "channel", title: "X" } as never,
        from: { id: s.telegramUserId, is_bot: false, first_name: "O" },
        date: 0,
        old_chat_member: { status: "administrator" } as never,
        new_chat_member: { status: "left", user: { id: h.deps.telegram.botId, is_bot: true, first_name: "Flock" } },
      },
    });
    await h.drain();
    let [chat] = await h.deps.db.select().from(telegramChats).where(eq(telegramChats.communityId, community.id));
    expect(chat!.status).toBe("needs_attention");
    h.tg.setMember(chatId, h.deps.telegram.botId, { status: "administrator", can_invite_users: true, can_restrict_members: true });
    expect((await recheckCommunityChat(h.deps, c.id)).status).toBe("connected");
    [chat] = await h.deps.db.select().from(telegramChats).where(eq(telegramChats.communityId, community.id));
    expect(chat!.status).toBe("connected");
  });

  it("follows group → supergroup migration", async () => {
    const { s, c, community } = await creatorWithCommunity();
    const chatId = nextChatId();
    h.tg.addChat({ id: chatId, type: "group", title: "G", ownerId: s.telegramUserId });
    await startChatConnection(h.deps, c.id, { id: s.user.id, telegramUserId: s.telegramUserId }, "group");
    await botPromoted(h, chatId, s.telegramUserId, "G", "supergroup");
    const newId = nextChatId();
    await h.telegram({ message: { message_id: 1, date: 0, chat: { id: chatId, type: "group", title: "G" }, migrate_to_chat_id: newId } as never });
    await h.drain();
    const [chat] = await h.deps.db.select().from(telegramChats).where(eq(telegramChats.communityId, community.id));
    expect(chat).toMatchObject({ telegramChatId: newId, chatType: "supergroup" });
  });

  it("can't disconnect a chat while paying members still need managing", async () => {
    const pc = await publishedCommunity(h);
    await subscribe(h, pc.community.slug);
    await expect(disconnectCommunityChat(h.deps, pc.creatorRow.id, pc.creator.user.id)).rejects.toMatchObject({ code: "has_members" });
  });
});
