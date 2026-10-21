/**
 * Local fake of the Telegram Bot API (MOCK — not a live provider).
 * Implements only the methods Flock calls, with enough state to exercise access logic.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type Status = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
interface Member {
  status: Status;
  can_invite_users?: boolean;
  can_restrict_members?: boolean;
  is_member?: boolean;
}
interface Chat {
  id: number;
  type: "channel" | "supergroup" | "group";
  title: string;
  members: Map<number, Member>;
}
interface SentMessage {
  chat_id: number;
  text: string;
  message_id: number;
  reply_markup?: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] };
}

export interface TelegramMockOptions {
  botId: number;
  botUsername: string;
}

export class TelegramMock {
  readonly chats = new Map<number, Chat>();
  readonly users = new Map<number, { id: number; first_name: string; username?: string }>();
  readonly sent: SentMessage[] = [];
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly inviteLinks = new Map<string, { chat_id: number; name?: string; revoked: boolean; creates_join_request: boolean }>();
  /** method → queued failures returned before normal handling. */
  readonly failures = new Map<string, { error_code: number; description: string; retry_after?: number }[]>();
  private server: Server | null = null;
  private nextMessageId = 1;
  private linkSeq = 1;
  url = "";

  constructor(readonly opts: TelegramMockOptions) {}

  reset() {
    this.chats.clear();
    this.users.clear();
    this.sent.length = 0;
    this.calls.length = 0;
    this.inviteLinks.clear();
    this.failures.clear();
  }

  addChat(chat: { id: number; type: Chat["type"]; title: string; ownerId: number; botRights?: { invite: boolean; restrict: boolean } | null }) {
    const members = new Map<number, Member>();
    members.set(chat.ownerId, { status: "creator" });
    if (chat.botRights !== null) {
      const rights = chat.botRights ?? { invite: true, restrict: true };
      members.set(this.opts.botId, { status: "administrator", can_invite_users: rights.invite, can_restrict_members: rights.restrict });
    }
    this.chats.set(chat.id, { id: chat.id, type: chat.type, title: chat.title, members });
  }

  setMember(chatId: number, userId: number, member: Member) {
    this.chats.get(chatId)?.members.set(userId, member);
  }

  memberStatus(chatId: number, userId: number): Status {
    return this.chats.get(chatId)?.members.get(userId)?.status ?? "left";
  }

  failNext(method: string, error_code: number, description: string, retry_after?: number) {
    const list = this.failures.get(method) ?? [];
    list.push({ error_code, description, ...(retry_after ? { retry_after } : {}) });
    this.failures.set(method, list);
  }

  messagesTo(chatId: number) {
    return this.sent.filter((m) => m.chat_id === chatId);
  }

  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  async start(port = 0): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop() {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", this.url);

    if (url.pathname.startsWith("/_mock/")) return this.control(url, raw, res);

    const match = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!match) return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
    const method = match[2]!;
    let params: Record<string, unknown>;
    try {
      params = raw ? (JSON.parse(raw) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
    } catch {
      params = {};
    }
    this.calls.push({ method, params });
    const failure = this.failures.get(method)?.shift();
    if (failure) {
      return json(res, failure.error_code >= 500 ? 500 : 200, {
        ok: false,
        error_code: failure.error_code,
        description: failure.description,
        ...(failure.retry_after ? { parameters: { retry_after: failure.retry_after } } : {}),
      });
    }
    try {
      const result = this.dispatch(method, params);
      json(res, 200, { ok: true, result });
    } catch (err) {
      const e = err as { code?: number; message: string };
      json(res, 200, { ok: false, error_code: e.code ?? 400, description: e.message });
    }
  }

  private chatOr400(id: unknown): Chat {
    const chat = this.chats.get(Number(id));
    if (!chat) throw Object.assign(new Error("Bad Request: chat not found"), { code: 400 });
    return chat;
  }

  private dispatch(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "getMe":
        return { id: this.opts.botId, is_bot: true, first_name: "Flock", username: this.opts.botUsername };
      case "getChat": {
        const chat = this.chatOr400(p.chat_id);
        return { id: chat.id, type: chat.type, title: chat.title };
      }
      case "getChatMember": {
        const chat = this.chatOr400(p.chat_id);
        const userId = Number(p.user_id);
        const m = chat.members.get(userId) ?? { status: "left" as const };
        const user = userId === this.opts.botId ? { id: userId, is_bot: true, first_name: "Flock" } : { id: userId, is_bot: false, first_name: this.users.get(userId)?.first_name ?? "User" };
        const base = { user, status: m.status };
        if (m.status === "administrator") {
          return {
            ...base,
            can_be_edited: false,
            is_anonymous: false,
            can_manage_chat: true,
            can_delete_messages: false,
            can_manage_video_chats: false,
            can_restrict_members: m.can_restrict_members ?? false,
            can_promote_members: false,
            can_change_info: false,
            can_invite_users: m.can_invite_users ?? false,
            can_post_stories: false,
            can_edit_stories: false,
            can_delete_stories: false,
          };
        }
        if (m.status === "creator") return { ...base, is_anonymous: false };
        if (m.status === "restricted") return { ...base, is_member: m.is_member ?? false, until_date: 0 };
        if (m.status === "kicked") return { ...base, until_date: 0 };
        return base;
      }
      case "createChatInviteLink": {
        const chat = this.chatOr400(p.chat_id);
        const bot = chat.members.get(this.opts.botId);
        if (bot?.status !== "administrator" || !bot.can_invite_users) throw Object.assign(new Error("Bad Request: not enough rights to manage chat invite link"), { code: 400 });
        const link = `https://t.me/+mock${this.linkSeq++}`;
        this.inviteLinks.set(link, { chat_id: chat.id, name: p.name as string | undefined, revoked: false, creates_join_request: Boolean(p.creates_join_request) });
        return { invite_link: link, creator: { id: this.opts.botId, is_bot: true, first_name: "Flock" }, creates_join_request: Boolean(p.creates_join_request), is_primary: false, is_revoked: false, name: p.name, expire_date: p.expire_date };
      }
      case "revokeChatInviteLink": {
        const l = this.inviteLinks.get(String(p.invite_link));
        if (l) l.revoked = true;
        return { invite_link: p.invite_link, creator: { id: this.opts.botId, is_bot: true, first_name: "Flock" }, creates_join_request: true, is_primary: false, is_revoked: true };
      }
      case "approveChatJoinRequest": {
        const chat = this.chatOr400(p.chat_id);
        const userId = Number(p.user_id);
        const current = chat.members.get(userId)?.status;
        if (current === "member" || current === "administrator" || current === "creator") throw Object.assign(new Error("Bad Request: USER_ALREADY_PARTICIPANT"), { code: 400 });
        chat.members.set(userId, { status: "member" });
        return true;
      }
      case "declineChatJoinRequest":
        this.chatOr400(p.chat_id);
        return true;
      case "banChatMember": {
        const chat = this.chatOr400(p.chat_id);
        const bot = chat.members.get(this.opts.botId);
        if (bot?.status !== "administrator" || !bot.can_restrict_members) throw Object.assign(new Error("Bad Request: not enough rights to restrict/unrestrict chat member"), { code: 400 });
        const target = chat.members.get(Number(p.user_id));
        if (target?.status === "creator" || target?.status === "administrator") throw Object.assign(new Error("Bad Request: can't remove chat owner"), { code: 400 });
        chat.members.set(Number(p.user_id), { status: "kicked" });
        return true;
      }
      case "unbanChatMember": {
        const chat = this.chatOr400(p.chat_id);
        const userId = Number(p.user_id);
        const current = chat.members.get(userId)?.status;
        if (p.only_if_banned && current !== "kicked") return true;
        chat.members.set(userId, { status: "left" });
        return true;
      }
      case "sendMessage": {
        const chatId = Number(p.chat_id);
        const message_id = this.nextMessageId++;
        this.sent.push({ chat_id: chatId, text: String(p.text), message_id, reply_markup: p.reply_markup as SentMessage["reply_markup"] });
        return { message_id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private", first_name: "User" }, text: p.text };
      }
      case "editMessageText": {
        const msg = this.sent.find((m) => m.message_id === Number(p.message_id));
        if (msg) msg.text = String(p.text);
        return { message_id: Number(p.message_id), date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: "private", first_name: "User" }, text: p.text };
      }
      case "answerCallbackQuery":
      case "setWebhook":
      case "deleteWebhook":
      case "setMyCommands":
        return true;
      case "getWebhookInfo":
        return { url: "", has_custom_certificate: false, pending_update_count: 0 };
      case "getUpdates":
        return [];
      default:
        throw Object.assign(new Error(`Not Implemented in mock: ${method}`), { code: 404 });
    }
  }

  /** Control endpoints so out-of-process tests (Playwright) can script Telegram state. */
  private control(url: URL, raw: string, res: ServerResponse) {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    switch (url.pathname) {
      case "/_mock/reset":
        this.reset();
        return json(res, 200, { ok: true });
      case "/_mock/chat":
        this.addChat(body as unknown as Parameters<TelegramMock["addChat"]>[0]);
        return json(res, 200, { ok: true });
      case "/_mock/member":
        this.setMember(Number(body.chatId), Number(body.userId), body.member as Member);
        return json(res, 200, { ok: true });
      case "/_mock/state": {
        const chats = [...this.chats.values()].map((c) => ({ id: c.id, title: c.title, members: Object.fromEntries(c.members) }));
        return json(res, 200, { chats, sent: this.sent, calls: this.calls.map((c) => c.method) });
      }
      default:
        return json(res, 404, { ok: false });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
