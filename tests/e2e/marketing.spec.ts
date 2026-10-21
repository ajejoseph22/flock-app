import { expect, test } from "@playwright/test";

test.describe("marketing site", () => {
  test("home page explains the product and links to sign-up", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Your Telegram community. Your subscription business." })).toBeVisible();
    const cta = page.getByRole("link", { name: /Start for free/ }).first();
    await expect(cta).toHaveAttribute("href", "/login?returnTo=%2Fdashboard");
    await page.getByRole("link", { name: "See how it works" }).click();
    await expect(page.getByRole("heading", { name: "Live in four steps" })).toBeInViewport();
    // No fabricated social proof: the only product picture is labelled as an illustration.
    await expect(page.getByText("Illustration", { exact: true })).toBeVisible();
  });

  test("pricing shows the free early-access plan as the only available plan", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { name: "Simple pricing" })).toBeVisible();
    await expect(page.getByText("Available now")).toHaveCount(1);
    await expect(page.getByText("After early access")).toHaveCount(2);
  });

  test("legal and contact pages render, with drafts clearly marked", async ({ page }) => {
    for (const [path, heading] of [
      ["/terms", "Terms of Service"],
      ["/privacy", "Privacy Policy"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.getByText(/has not yet been reviewed by a lawyer/)).toBeVisible();
    }
    await page.goto("/contact");
    await expect(page.getByRole("link", { name: "support@useflock.co" })).toBeVisible();
  });

  test("unknown membership pages 404", async ({ page }) => {
    const res = await page.goto("/join/does-not-exist-xyz");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  });
});
