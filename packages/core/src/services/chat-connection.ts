import { chatConnectionRequests, communities, entitlements, telegramChats, users, type DbOrTx } from "@flock/db";
import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { ANALYTICS } from "../analytics-events";
import type { Deps } from "../deps";
import { AppError, NotFoundError, TelegramApiError } from "../errors";
import type { TgChat, TelegramGateway } from "../gateways";
import { tgEscape } from "../telegram-html";
import { audit, track } from "./audit";
import { getOwnedCommunity } from "./communities";

export const CONNECTION_REQUEST_TTL_MS = 30 * 60_000;
/** Telegram's placeholder sender for anonymous group admins. */
export const GROUP_ANONYMOUS_BOT_ID = 1087968824;
const REQUIRED_RIGHTS = "invite_users+restrict_members";

export type ConnectChatType = "channel" | "group";

export function addBotDeepLink(botUsername: string, chatType: ConnectChatType): string {
  return chatType === "channel"
    ? `https://t.me/${botUsername}?startchannel&admin=${REQUIRED_RIGHTS}`
    : `https://t.me/${botUsername}?startgroup=flock&admin=${REQUIRED_RIGHTS}`;
}

export async function startChatConnection(
  deps: Pick<Deps, "db" | "config" | "now">,
  creatorId: string,
  user: { id: string; telegramUserId: number },
  chatType: ConnectChatType,
) {
  const community = await getOwnedCommunity(deps.db, creatorId);
  if (!community) throw new NotFoundError("Create a community first.");
  const [existing] = await deps.db.select({ id: telegramChats.id }).from(telegramChats).where(eq(telegramChats.communityId, community.id));
  if (existing) throw new AppError("already_connected", "This community already has a connected chat. Disconnect it first.");

  return deps.db.transaction(async (tx) => {
    await tx
      .update(chatConnectionRequests)
      .set({ status: "canceled" })
      .where(and(eq(chatConnectionRequests.communityId, community.id), eq(chatConnectionRequests.status, "pending")));
    const [request] = await tx
      .insert(chatConnectionRequests)
      .values({
        communityId: community.id,
        requestedByUserId: user.id,
        telegramUserId: user.telegramUserId,
        chatType,
        expiresAt: new Date(deps.now().getTime() + CONNECTION_REQUEST_TTL_MS),
      })
      .returning();
    if (!request) throw new Error("insert failed");
    return { request, deepLink: addBotDeepLink(deps.config.telegram.botUsername, chatType) };
  });
}

export async function getConnectionRequest(db: DbOrTx, creatorId: string, requestId: string) {
  const [row] = await db
    .select({ request: chatConnectionRequests })
    .from(chatConnectionRequests)
    .innerJoin(communities, eq(communities.id, chatConnectionRequests.communityId))
    .where(and(eq(chatConnectionRequests.id, requestId), eq(communities.creatorId, creatorId)))
    .limit(1);
  return row?.request ?? null;
}

export interface ChatVerification {
  ok: boolean;
  failureCode?: "bot_not_admin" | "missing_invite_right" | "missing_restrict_right" | "requester_not_admin" | "unsupported_chat" | "chat_unreachable";
  message?: string;
  chat?: TgChat;
  botCanInviteUsers: boolean;
  botCanRestrictMembers: boolean;
}

/** Verify the bot's rights and (optionally) that `ownerTelegramUserId` administers the chat. */
export async function verifyChat(telegram: TelegramGateway, chatId: number, ownerTelegramUserId: number | null): Promise<ChatVerification> {
  let chat: TgChat;
  try {
    chat = await telegram.getChat(chatId);
  } catch (err) {
    if (err instanceof TelegramApiError && !err.retryable) {
      return { ok: false, failureCode: "chat_unreachable", message: "Flock can't see this chat. Add the bot as an admin again.", botCanInviteUsers: false, botCanRestrictMembers: false };
    }
    throw err;
  }
  if (chat.type === "private") {
    return { ok: false, failureCode: "unsupported_chat", message: "Only channels and groups can be connected.", chat, botCanInviteUsers: false, botCanRestrictMembers: false };
  }
  const bot = await telegram.getChatMember(chatId, telegram.botId);
  const botCanInviteUsers = bot.status === "administrator" && bot.canInviteUsers === true;
  const botCanRestrictMembers = bot.status === "administrator" && bot.canRestrictMembers === true;
  const base = { chat, botCanInviteUsers, botCanRestrictMembers };
  if (bot.status !== "administrator") {
    return { ...base, ok: false, failureCode: "bot_not_admin", message: `@${telegram.botUsername} must be an administrator of the chat.` };
  }
  if (!botCanInviteUsers) {
    return { ...base, ok: false, failureCode: "missing_invite_right", message: "Give the Flock bot the “Invite users via link” admin right." };
  }
  if (!botCanRestrictMembers) {
    return { ...base, ok: false, failureCode: "missing_restrict_right", message: "Give the Flock bot the “Ban users” admin right so it can remove expired members." };
  }
  if (ownerTelegramUserId !== null) {
    const owner = await telegram.getChatMember(chatId, ownerTelegramUserId);
    if (owner.status !== "creator" && owner.status !== "administrator") {
      return { ...base, ok: false, failureCode: "requester_not_admin", message: "Only an owner or admin of this chat can connect it." };
    }
  }
  return { ...base, ok: true };
}

export interface BotMembershipUpdate {
  chat: TgChat;
  fromTelegramUserId: number;
  newStatus: string;
  canInviteUsers?: boolean;
  canRestrictMembers?: boolean;
}

/** Handle `my_chat_member`: the bot's own status changed in a chat. */
export async function handleBotMembershipUpdate(deps: Deps, update: BotMembershipUpdate): Promise<void> {
  const { db, telegram, now } = deps;
  if (update.chat.type === "private") return;
  const [existing] = await db.select().from(telegramChats).where(eq(telegramChats.telegramChatId, update.chat.id)).limit(1);

  if (existing) {
    await refreshConnectedChat(deps, existing.id);
    // Someone else trying to claim an already-connected chat gets a clear failure, not a silent wait.
    const [competing] = await db
      .select()
      .from(chatConnectionRequests)
      .where(and(eq(chatConnectionRequests.telegramUserId, update.fromTelegramUserId), eq(chatConnectionRequests.status, "pending"), gt(chatConnectionRequests.expiresAt, now())))
      .limit(1);
    if (competing && competing.communityId !== existing.communityId) {
      const message = "This chat is already connected to another Flock community. Contact support if you own it.";
      await db
        .update(chatConnectionRequests)
        .set({ status: "failed", failureCode: "chat_already_connected", failureMessage: message, telegramChatId: update.chat.id, chatTitle: update.chat.title ?? null })
        .where(eq(chatConnectionRequests.id, competing.id));
      await notifyQuietly(deps, update.fromTelegramUserId, `Couldn't connect <b>${tgEscape(update.chat.title ?? "this chat")}</b>: ${message}`);
    }
    return;
  }
  if (update.newStatus !== "administrator") return;

  if (update.fromTelegramUserId === GROUP_ANONYMOUS_BOT_ID) {
    deps.log.info({ chatId: update.chat.id }, "bot promoted by anonymous admin; cannot match a connection request");
    return;
  }

  const [request] = await db
    .select()
    .from(chatConnectionRequests)
    .where(
      and(
        eq(chatConnectionRequests.telegramUserId, update.fromTelegramUserId),
        eq(chatConnectionRequests.status, "pending"),
        gt(chatConnectionRequests.expiresAt, now()),
      ),
    )
    .orderBy(desc(chatConnectionRequests.createdAt))
    .limit(1);

  if (!request) {
    await notifyQuietly(
      deps,
      update.fromTelegramUserId,
      `Flock was added as an admin to <b>${tgEscape(update.chat.title ?? "a chat")}</b>, but there's no pending connection for your account.\n\nOpen your Flock dashboard, choose <b>Connect Telegram</b>, then add the bot again.`,
    );
    return;
  }

  const verification = await verifyChat(telegram, update.chat.id, update.fromTelegramUserId);
  const failRequest = async (code: string, message: string) => {
    await db
      .update(chatConnectionRequests)
      .set({ status: "failed", failureCode: code, failureMessage: message, telegramChatId: update.chat.id, chatTitle: update.chat.title ?? null })
      .where(eq(chatConnectionRequests.id, request.id));
    await notifyQuietly(deps, update.fromTelegramUserId, `Couldn't connect <b>${tgEscape(update.chat.title ?? "this chat")}</b>: ${tgEscape(message)}`);
  };

  if (!verification.ok || !verification.chat) {
    await failRequest(verification.failureCode ?? "verification_failed", verification.message ?? "Verification failed.");
    return;
  }
  const chat = verification.chat;
  const chatType = chat.type === "channel" ? "channel" : chat.type === "supergroup" ? "supergroup" : "group";

  const result = await db.transaction(async (tx) => {
    const [community] = await tx.select().from(communities).where(eq(communities.id, request.communityId)).limit(1);
    if (!community) return "gone" as const;
    const [taken] = await tx.select({ id: telegramChats.id }).from(telegramChats).where(eq(telegramChats.telegramChatId, chat.id)).limit(1);
    if (taken) return "taken" as const;
    const [hasChat] = await tx.select({ id: telegramChats.id }).from(telegramChats).where(eq(telegramChats.communityId, community.id)).limit(1);
    if (hasChat) return "community_has_chat" as const;
    await tx.insert(telegramChats).values({
      communityId: community.id,
      telegramChatId: chat.id,
      chatType,
      title: chat.title ?? "Untitled chat",
      username: chat.username ?? null,
      status: "connected",
      botCanInviteUsers: verification.botCanInviteUsers,
      botCanRestrictMembers: verification.botCanRestrictMembers,
      connectedByUserId: request.requestedByUserId,
      lastVerifiedAt: now(),
    });
    await tx
      .update(chatConnectionRequests)
      .set({ status: "completed", telegramChatId: chat.id, chatTitle: chat.title ?? null })
      .where(eq(chatConnectionRequests.id, request.id));
    await audit(tx, {
      actorType: "telegram",
      actorUserId: request.requestedByUserId,
      creatorId: community.creatorId,
      communityId: community.id,
      action: "telegram.chat_connected",
      details: { telegramChatId: chat.id, title: chat.title, chatType },
    });
    await track(tx, ANALYTICS.telegramConnected, { userId: request.requestedByUserId, creatorId: community.creatorId, communityId: community.id }, { chatType });
    return "connected" as const;
  });

  if (result === "taken") {
    await failRequest("chat_already_connected", "This chat is already connected to another Flock community. Contact support if you own it.");
  } else if (result === "community_has_chat") {
    await failRequest("community_has_chat", "Your community already has a connected chat.");
  } else if (result === "connected") {
    await notifyQuietly(deps, update.fromTelegramUserId, `✅ <b>${tgEscape(chat.title ?? "Your chat")}</b> is connected to Flock. Head back to your dashboard to finish setup.`);
  }
}

/** Re-read Telegram and update a connected chat's status. Used by "Re-check", my_chat_member and reconciliation. */
export async function refreshConnectedChat(deps: Pick<Deps, "db" | "telegram" | "now" | "log">, telegramChatRowId: string) {
  const [row] = await deps.db.select().from(telegramChats).where(eq(telegramChats.id, telegramChatRowId)).limit(1);
  if (!row) throw new NotFoundError();
  const v = await verifyChat(deps.telegram, row.telegramChatId, null);
  const status = v.ok ? "connected" : "needs_attention";
  const changed = status !== row.status || (v.message ?? null) !== row.statusReason;
  const [community] = await deps.db.select().from(communities).where(eq(communities.id, row.communityId)).limit(1);
  await deps.db
    .update(telegramChats)
    .set({
      status,
      statusReason: v.ok ? null : (v.message ?? "Needs attention"),
      botCanInviteUsers: v.botCanInviteUsers,
      botCanRestrictMembers: v.botCanRestrictMembers,
      title: v.chat?.title ?? row.title,
      username: v.chat?.username ?? row.username,
      lastVerifiedAt: deps.now(),
    })
    .where(eq(telegramChats.id, row.id));
  if (changed) {
    await audit(deps.db, {
      actorType: "telegram",
      creatorId: community?.creatorId,
      communityId: row.communityId,
      action: v.ok ? "telegram.chat_healthy" : "telegram.chat_needs_attention",
      details: { reason: v.failureCode ?? null },
    });
  }
  return { status, reason: v.message ?? null };
}

export async function recheckCommunityChat(deps: Deps, creatorId: string) {
  const community = await getOwnedCommunity(deps.db, creatorId);
  if (!community) throw new NotFoundError();
  const [row] = await deps.db.select().from(telegramChats).where(eq(telegramChats.communityId, community.id)).limit(1);
  if (!row) throw new NotFoundError("No chat connected.");
  return refreshConnectedChat(deps, row.id);
}

export async function disconnectCommunityChat(deps: Pick<Deps, "db">, creatorId: string, actorUserId: string) {
  const community = await getOwnedCommunity(deps.db, creatorId);
  if (!community) throw new NotFoundError();
  const [active] = await deps.db
    .select({ id: entitlements.id })
    .from(entitlements)
    .where(and(eq(entitlements.communityId, community.id), eq(entitlements.status, "active")))
    .limit(1);
  if (active) throw new AppError("has_members", "You have active paying members. Flock must keep managing this chat until their access ends.");
  await deps.db.transaction(async (tx) => {
    await tx.delete(telegramChats).where(eq(telegramChats.communityId, community.id));
    await tx.update(communities).set({ status: "draft" }).where(eq(communities.id, community.id));
    await audit(tx, { actorType: "user", actorUserId, creatorId, communityId: community.id, action: "telegram.chat_disconnected" });
  });
}

/** A basic group was upgraded to a supergroup and got a new ID. */
export async function handleChatMigration(deps: Pick<Deps, "db">, fromChatId: number, toChatId: number) {
  const rows = await deps.db
    .update(telegramChats)
    .set({ telegramChatId: toChatId, chatType: "supergroup" })
    .where(eq(telegramChats.telegramChatId, fromChatId))
    .returning({ communityId: telegramChats.communityId });
  for (const r of rows) {
    await audit(deps.db, { actorType: "telegram", communityId: r.communityId, action: "telegram.chat_migrated", details: { fromChatId, toChatId } });
  }
}

/** Send a DM, swallowing delivery failures (user never started the bot, blocked it, …). */
export async function notifyQuietly(deps: Pick<Deps, "telegram" | "log" | "db">, telegramUserId: number, html: string, buttons?: { text: string; url: string }[][]) {
  try {
    await deps.telegram.sendMessage(telegramUserId, html, buttons ? { buttons } : undefined);
    return true;
  } catch (err) {
    if (err instanceof TelegramApiError && err.kind === "user_blocked_bot") {
      await deps.db.update(users).set({ botBlockedAt: new Date() }).where(eq(users.telegramUserId, telegramUserId));
    }
    deps.log.info({ telegramUserId, err: err instanceof Error ? err.message : String(err) }, "telegram notify failed");
    return false;
  }
}

export async function expireConnectionRequests(db: DbOrTx, now: Date) {
  const pending = await db
    .select({ id: chatConnectionRequests.id, expiresAt: chatConnectionRequests.expiresAt })
    .from(chatConnectionRequests)
    .where(eq(chatConnectionRequests.status, "pending"));
  const expired = pending.filter((p) => p.expiresAt <= now).map((p) => p.id);
  if (expired.length) await db.update(chatConnectionRequests).set({ status: "expired" }).where(inArray(chatConnectionRequests.id, expired));
}
