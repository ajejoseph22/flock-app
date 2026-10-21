import { classifyTelegramError, TelegramApiError, type InlineButton, type TelegramGateway, type TgChatMember } from "@flock/core";
import { Api, GrammyError, HttpError } from "grammy";
import type { ChatMember, InlineKeyboardButton } from "@grammyjs/types";

export interface TelegramGatewayOptions {
  token: string;
  botId: number;
  botUsername: string;
  /** Only for local mocks; ignored in production by config. */
  apiRoot?: string;
}

export function createTelegramApi(opts: Pick<TelegramGatewayOptions, "token" | "apiRoot">): Api {
  return new Api(opts.token, opts.apiRoot ? { apiRoot: opts.apiRoot } : undefined);
}

function toKeyboard(buttons?: InlineButton[][]): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  if (!buttons) return undefined;
  return {
    inline_keyboard: buttons.map((row) => row.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData }))),
  };
}

export function mapChatMember(m: ChatMember): TgChatMember {
  switch (m.status) {
    case "administrator":
      return { status: "administrator", canInviteUsers: m.can_invite_users, canRestrictMembers: m.can_restrict_members, isAnonymous: m.is_anonymous };
    case "creator":
      return { status: "creator", isAnonymous: m.is_anonymous };
    case "restricted":
      return { status: "restricted", isMember: m.is_member };
    default:
      return { status: m.status };
  }
}

/** Normalise grammY errors into TelegramApiError so services can decide retry vs. permanent. */
async function call<T>(method: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GrammyError) {
      throw new TelegramApiError(classifyTelegramError(err.error_code, err.description), method, err.error_code, err.description, err.parameters.retry_after);
    }
    if (err instanceof HttpError) {
      throw new TelegramApiError("transient", method, 0, err.message);
    }
    throw err;
  }
}

export function createTelegramGateway(opts: TelegramGatewayOptions): TelegramGateway {
  const api = createTelegramApi(opts);
  return {
    botId: opts.botId,
    botUsername: opts.botUsername,
    getChat: (chatId) =>
      call("getChat", async () => {
        const c = await api.getChat(chatId);
        return { id: c.id, type: c.type, title: "title" in c ? c.title : undefined, username: "username" in c ? c.username : undefined };
      }),
    getChatMember: (chatId, userId) => call("getChatMember", async () => mapChatMember(await api.getChatMember(chatId, userId))),
    createJoinRequestLink: (chatId, { name, expireDate }) =>
      call("createChatInviteLink", async () => {
        const link = await api.createChatInviteLink(chatId, {
          name: name.slice(0, 32),
          expire_date: Math.floor(expireDate.getTime() / 1000),
          creates_join_request: true,
        });
        return link.invite_link;
      }),
    revokeInviteLink: (chatId, inviteLink) => call("revokeChatInviteLink", async () => void (await api.revokeChatInviteLink(chatId, inviteLink))),
    approveJoinRequest: (chatId, userId) => call("approveChatJoinRequest", async () => void (await api.approveChatJoinRequest(chatId, userId))),
    declineJoinRequest: (chatId, userId) => call("declineChatJoinRequest", async () => void (await api.declineChatJoinRequest(chatId, userId))),
    banChatMember: (chatId, userId) => call("banChatMember", async () => void (await api.banChatMember(chatId, userId, { revoke_messages: false }))),
    unbanChatMember: (chatId, userId, { onlyIfBanned }) =>
      call("unbanChatMember", async () => void (await api.unbanChatMember(chatId, userId, { only_if_banned: onlyIfBanned }))),
    sendMessage: (chatId, html, o) =>
      call("sendMessage", async () => {
        const m = await api.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: toKeyboard(o?.buttons) });
        return { messageId: m.message_id };
      }),
    editMessage: (chatId, messageId, html, o) =>
      call("editMessageText", async () => {
        await api.editMessageText(chatId, messageId, html, { parse_mode: "HTML", reply_markup: toKeyboard(o?.buttons) });
      }),
    answerCallbackQuery: (id, text) => call("answerCallbackQuery", async () => void (await api.answerCallbackQuery(id, text ? { text } : undefined))),
  };
}
