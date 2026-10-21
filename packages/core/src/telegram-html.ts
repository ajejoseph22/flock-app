/** Escape text for Telegram's HTML parse mode. */
export function tgEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function displayTelegramName(u: { firstName: string; lastName?: string | null; telegramUsername?: string | null }): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (name) return name;
  return u.telegramUsername ? `@${u.telegramUsername}` : "Telegram user";
}
