import type { ChatMember, Update } from "@grammyjs/types";
import { communities, entitlements, telegramAccessGrants, users } from "@flock/db";
import { and, desc, eq } from "drizzle-orm";
import type { Deps } from "../deps";
import type { MemberStatus } from "../domain/access";
import { TelegramApiError } from "../errors";
import { tgEscape } from "../telegram-html";
import { handleJoinRequest, handleMemberUpdate, issueInvite } from "./access";
import { claimLoginChallenge, confirmLoginChallenge, LOGIN_PAYLOAD_PREFIX, rejectLoginChallenge, upsertTelegramUser } from "./auth";
import { handleBotMembershipUpdate, handleChatMigration } from "./chat-connection";

/** Update types the webhook is registered for (setWebhook allowed_updates). */
export const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member", "chat_member", "chat_join_request"] as const;

const CB_CONFIRM = "auth:ok:";
const CB_REJECT = "auth:no:";

function memberShape(m: ChatMember): { status: MemberStatus; isMember?: boolean; canInviteUsers?: boolean; canRestrictMembers?: boolean } {
  switch (m.status) {
    case "administrator":
      return { status: "administrator", canInviteUsers: m.can_invite_users, canRestrictMembers: m.can_restrict_members };
    case "restricted":
      return { status: "restricted", isMember: m.is_member };
    default:
      return { status: m.status };
  }
}

/** Process one Telegram update. Idempotent: replays converge (conditional updates, state-based access). */
export async function processTelegramUpdate(deps: Deps, update: Update): Promise<"processed" | "ignored"> {
  if (update.message) {
    const msg = update.message;
    if (msg.migrate_to_chat_id) {
      await handleChatMigration(deps, msg.chat.id, msg.migrate_to_chat_id);
      return "processed";
    }
    if (msg.chat.type !== "private" || !msg.from || msg.from.is_bot || !msg.text) return "ignored";
    const [command, ...rest] = msg.text.trim().split(/\s+/);
    const cmd = command?.toLowerCase().replace(/@.*$/, "");
    const from = { id: msg.from.id, username: msg.from.username ?? null, firstName: msg.from.first_name, lastName: msg.from.last_name ?? null };
    switch (cmd) {
      case "/start":
        await handleStart(deps, from, rest[0] ?? "");
        return "processed";
      case "/help":
        await reply(deps, from.id, helpText(deps));
        return "processed";
      case "/status":
        await handleStatus(deps, from);
        return "processed";
      case "/support":
        await handleSupport(deps, from.id);
        return "processed";
      default:
        await reply(deps, from.id, `I didn't recognise that. ${helpText(deps)}`);
        return "processed";
    }
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data ?? "";
    const from = { id: cq.from.id, username: cq.from.username ?? null, firstName: cq.from.first_name, lastName: cq.from.last_name ?? null };
    const message = cq.message;
    if (data.startsWith(CB_CONFIRM)) {
      const user = await confirmLoginChallenge(deps.db, data.slice(CB_CONFIRM.length), from, deps.now());
      await deps.telegram.answerCallbackQuery(cq.id, user ? "Signed in" : "This sign-in link has expired").catch(() => undefined);
      if (message) {
        await deps.telegram
          .editMessage(message.chat.id, message.message_id, user ? "✅ You're signed in to Flock. Return to your browser to continue." : "This sign-in link has expired or was already used. Start again on the website.")
          .catch(() => undefined);
      }
      return "processed";
    }
    if (data.startsWith(CB_REJECT)) {
      await rejectLoginChallenge(deps.db, data.slice(CB_REJECT.length), from.id);
      await deps.telegram.answerCallbackQuery(cq.id, "Sign-in cancelled").catch(() => undefined);
      if (message) {
        await deps.telegram
          .editMessage(message.chat.id, message.message_id, "Sign-in cancelled. If you didn't try to sign in, you can ignore this. Nobody gets access to your account without your confirmation.")
          .catch(() => undefined);
      }
      return "processed";
    }
    await deps.telegram.answerCallbackQuery(cq.id).catch(() => undefined);
    return "ignored";
  }

  if (update.my_chat_member) {
    const u = update.my_chat_member;
    const m = memberShape(u.new_chat_member);
    await handleBotMembershipUpdate(deps, {
      chat: { id: u.chat.id, type: u.chat.type, title: "title" in u.chat ? u.chat.title : undefined, username: "username" in u.chat ? u.chat.username : undefined },
      fromTelegramUserId: u.from.id,
      newStatus: m.status,
      canInviteUsers: m.canInviteUsers,
      canRestrictMembers: m.canRestrictMembers,
    });
    return "processed";
  }

  if (update.chat_member) {
    const u = update.chat_member;
    if (u.new_chat_member.user.is_bot) return "ignored";
    await handleMemberUpdate(deps, u.chat.id, u.new_chat_member.user.id, memberShape(u.new_chat_member));
    return "processed";
  }

  if (update.chat_join_request) {
    const r = update.chat_join_request;
    const outcome = await handleJoinRequest(deps, r.from.id, r.chat.id);
    return outcome === "unknown_chat" ? "ignored" : "processed";
  }

  return "ignored";
}

async function reply(deps: Deps, chatId: number, html: string, buttons?: Parameters<Deps["telegram"]["sendMessage"]>[2]) {
  try {
    await deps.telegram.sendMessage(chatId, html, buttons);
  } catch (err) {
    // A user who blocked the bot can't receive replies; that isn't a processing failure.
    if (err instanceof TelegramApiError && err.kind === "user_blocked_bot") return;
    throw err;
  }
}

function helpText(deps: Deps) {
  return [
    "<b>Flock</b> manages paid access to private Telegram communities.",
    "",
    "/status — your memberships and invite links",
    "/support — how to get help",
    "/help — this message",
    "",
    `Manage billing at ${deps.config.appUrl}/account`,
  ].join("\n");
}

async function handleStart(deps: Deps, from: { id: number; username: string | null; firstName: string; lastName: string | null }, payload: string) {
  if (payload.startsWith(LOGIN_PAYLOAD_PREFIX)) {
    const token = payload.slice(LOGIN_PAYLOAD_PREFIX.length);
    const claimed = /^[A-Za-z0-9_-]{43}$/.test(token) ? await claimLoginChallenge(deps.db, token, from.id, deps.now()) : null;
    await upsertTelegramUser(deps.db, from, { botChatStarted: true });
    if (!claimed) {
      await reply(deps, from.id, "This sign-in link has expired or was already used. Start again on the website.");
      return;
    }
    await reply(
      deps,
      from.id,
      [
        "<b>Sign in to Flock?</b>",
        "",
        `Confirm only if <b>you</b> just started signing in on ${tgEscape(new URL(deps.config.appUrl).host)}. Never confirm a sign-in link someone sent you: it would give them access to your Flock account.`,
      ].join("\n"),
      { buttons: [[{ text: "✅ Confirm sign-in", callbackData: `${CB_CONFIRM}${claimed.id}` }], [{ text: "Not me", callbackData: `${CB_REJECT}${claimed.id}` }]] },
    );
    return;
  }
  await upsertTelegramUser(deps.db, from, { botChatStarted: true });
  await reply(deps, from.id, `👋 Welcome to Flock.\n\nIf you've subscribed to a community, use /status to see your memberships and get your invite link.\n\n${helpText(deps)}`);
}

async function handleStatus(deps: Deps, from: { id: number; username: string | null; firstName: string; lastName: string | null }) {
  const user = await upsertTelegramUser(deps.db, from, { botChatStarted: true });
  const now = deps.now();
  const rows = await deps.db
    .select({ entitlement: entitlements, community: communities })
    .from(entitlements)
    .innerJoin(communities, eq(communities.id, entitlements.communityId))
    .where(eq(entitlements.userId, user.id))
    .orderBy(desc(entitlements.updatedAt))
    .limit(10);
  if (rows.length === 0) {
    await reply(deps, from.id, "You don't have any Flock memberships yet.");
    return;
  }
  const seen = new Set<string>();
  const lines: string[] = ["<b>Your memberships</b>", ""];
  const reinvite: string[] = [];
  for (const { entitlement, community } of rows) {
    if (seen.has(community.id)) continue;
    seen.add(community.id);
    const active = entitlement.status === "active" && entitlement.accessEndsAt !== null && entitlement.accessEndsAt > now;
    const [grant] = await deps.db
      .select()
      .from(telegramAccessGrants)
      .where(and(eq(telegramAccessGrants.userId, user.id), eq(telegramAccessGrants.communityId, community.id)))
      .limit(1);
    if (active) {
      const until = entitlement.reason === "canceled_until_period_end" ? `ends ${fmtDate(entitlement.accessEndsAt!)}` : "active";
      lines.push(`• <b>${tgEscape(community.name)}</b> — ${until}${grant?.state === "member" ? "" : " (not joined yet)"}`);
      if (grant?.state !== "member") reinvite.push(community.id);
    } else {
      lines.push(`• <b>${tgEscape(community.name)}</b> — ended`);
    }
  }
  if (reinvite.length) lines.push("", "I'm sending you a fresh invite link for each community you haven't joined.");
  await reply(deps, from.id, lines.join("\n"));
  for (const communityId of reinvite) {
    await issueInvite(deps, user.id, communityId).catch((err: unknown) => {
      deps.log.warn({ err: err instanceof Error ? err.message : String(err), communityId }, "status re-invite failed");
    });
  }
}

async function handleSupport(deps: Deps, telegramUserId: number) {
  const [user] = await deps.db.select().from(users).where(eq(users.telegramUserId, telegramUserId)).limit(1);
  const lines = ["<b>Getting help</b>", ""];
  if (user) {
    const rows = await deps.db
      .selectDistinct({ name: communities.name, support: communities.supportContact })
      .from(entitlements)
      .innerJoin(communities, eq(communities.id, entitlements.communityId))
      .where(eq(entitlements.userId, user.id));
    for (const r of rows) lines.push(`• ${tgEscape(r.name)}: ${r.support ? tgEscape(r.support) : "contact the community owner"}`);
    if (rows.length) lines.push("");
  }
  lines.push("For questions about the community's content, contact the community. For billing, refunds and cancellations, the community owner handles payments through their own Stripe account.");
  lines.push("", `Problems with Flock itself: ${tgEscape(deps.config.supportEmail)}`);
  await reply(deps, telegramUserId, lines.join("\n"));
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
