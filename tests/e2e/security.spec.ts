import { expect, test } from "@playwright/test";
import { APP_URL } from "./env";
import { nextTelegramId, signIn } from "./helpers";

test.describe("security boundaries", () => {
  test("webhooks reject unsigned or wrongly signed requests", async ({ request }) => {
    const stripe = await request.post(`${APP_URL}/api/webhooks/stripe/connect`, {
      headers: { "stripe-signature": "t=1,v1=deadbeef" },
      data: { id: "evt_forged", type: "checkout.session.completed", account: "acct_x", data: { object: {} } },
    });
    expect(stripe.status()).toBe(400);
    const telegram = await request.post(`${APP_URL}/api/webhooks/telegram`, {
      headers: { "x-telegram-bot-api-secret-token": "wrong-secret-wrong-secret-wrong-secret" },
      data: { update_id: 1 },
    });
    expect(telegram.status()).toBe(401);
  });

  test("auth endpoints refuse cross-site requests", async ({ request }) => {
    const res = await request.post(`${APP_URL}/api/auth/challenge`, { headers: { origin: "https://evil.example" }, data: {} });
    expect(res.status()).toBe(403);
  });

  test("admin is hidden from non-admins", async ({ page }) => {
    await signIn(page, { id: nextTelegramId(), first_name: "Nadia" }, "/account");
    const res = await page.goto("/admin");
    expect(res?.status()).toBe(404);
  });

  test("admin sees operational health", async ({ page }) => {
    await signIn(page, { id: 5550001, first_name: "Ops" }, "/admin");
    await expect(page.getByText("Operator")).toBeVisible();
    await expect(page.getByText("Workers")).toBeVisible();
    await expect(page.getByText("Up", { exact: true }).first()).toBeVisible();
  });

  test("a creator can't open another community's member", async ({ page }) => {
    await signIn(page, { id: nextTelegramId(), first_name: "Eve" }, "/dashboard");
    const res = await page.goto("/dashboard/members/00000000-0000-4000-8000-000000000000");
    expect(res?.status()).toBe(404);
  });

  test("health endpoint reports database and worker", async ({ request }) => {
    const res = await request.get(`${APP_URL}/api/health?worker=1`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: "up", worker: "up" });
  });
});
