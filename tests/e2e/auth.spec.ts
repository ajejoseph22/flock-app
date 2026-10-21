import { expect, test } from "@playwright/test";
import { nextTelegramId, sendUpdate, signIn, waitForMessage } from "./helpers";

test.describe("Telegram sign-in", () => {
  test("signs in after confirming in the bot, and signs out", async ({ page }) => {
    const user = { id: nextTelegramId(), first_name: "Ada", username: "ada_e2e" };
    await signIn(page, user, "/account");
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByText("Signed in as Ada")).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Faccount/);
  });

  test("protected pages redirect to login with a return path", async ({ page }) => {
    await page.goto("/dashboard/members");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fdashboard%2Fmembers/);
  });

  test("tapping 'Not me' in the bot rejects the sign-in", async ({ page }) => {
    const user = { id: nextTelegramId(), first_name: "Ben" };
    await page.goto("/login");
    const href = (await page.getByTestId("telegram-login-link").getAttribute("href"))!;
    const payload = new URL(href).searchParams.get("start")!;
    await sendUpdate(page.request, {
      message: { message_id: 1, date: 0, chat: { id: user.id, type: "private", first_name: user.first_name }, from: { ...user, is_bot: false }, text: `/start ${payload}` },
    });
    const prompt = await waitForMessage(page.request, user.id, (m) => Boolean(m.reply_markup));
    const reject = prompt.reply_markup!.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("auth:no:"))!;
    await sendUpdate(page.request, {
      callback_query: { id: "cq-reject", from: { ...user, is_bot: false }, chat_instance: "e2e", data: reject.callback_data, message: { message_id: prompt.message_id, date: 0, chat: { id: user.id, type: "private" } } },
    });
    await expect(page.getByText("Sign-in was declined in Telegram")).toBeVisible({ timeout: 15_000 });
    await page.goto("/account");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a sign-in link can't be confirmed by a different Telegram account", async ({ page }) => {
    const owner = { id: nextTelegramId(), first_name: "Chi" };
    const attacker = { id: nextTelegramId(), first_name: "Mallory" };
    await page.goto("/login");
    const href = (await page.getByTestId("telegram-login-link").getAttribute("href"))!;
    const payload = new URL(href).searchParams.get("start")!;
    await sendUpdate(page.request, {
      message: { message_id: 1, date: 0, chat: { id: owner.id, type: "private" }, from: { ...owner, is_bot: false }, text: `/start ${payload}` },
    });
    const prompt = await waitForMessage(page.request, owner.id, (m) => Boolean(m.reply_markup));
    const confirm = prompt.reply_markup!.inline_keyboard.flat().find((b) => b.callback_data?.startsWith("auth:ok:"))!;
    await sendUpdate(page.request, {
      callback_query: { id: "cq-attack", from: { ...attacker, is_bot: false }, chat_instance: "e2e", data: confirm.callback_data },
    });
    await page.waitForTimeout(3000);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText("Waiting for you to confirm in Telegram")).toBeVisible();
  });
});
