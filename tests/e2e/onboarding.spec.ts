import { expect, test } from "@playwright/test";
import { nextTelegramId, signIn } from "./helpers";

test("a creator without a Telegram chat gets steps to start one", async ({ page }) => {
  const creator = { id: nextTelegramId(), first_name: "Nia" };
  await signIn(page, creator, "/dashboard");
  await page.goto("/dashboard/setup");
  await page.getByLabel("Community name").fill("Starter Notes");
  await page.getByLabel("Page address").fill(`e2e-start-${Date.now().toString(36)}`);
  await page.getByLabel("Description").fill("E2E test community.");
  await page.getByLabel("Benefits").fill("Daily notes");
  await page.getByRole("button", { name: "Create community" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByTestId("has-chat-no").click();
  await expect(page.getByText("Start a private chat in Telegram")).toBeVisible();
  await page.getByTestId("created-chat").click();
  await expect(page.getByRole("button", { name: /Private channel/ })).toBeVisible();
  if (process.env.SHOT_DIR) await page.screenshot({ path: `${process.env.SHOT_DIR}/app-connect.png`, fullPage: true });
});
