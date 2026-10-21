import { defineConfig, devices } from "@playwright/test";
import { APP_URL } from "./tests/e2e/env";

// Optional: point at a preinstalled Chromium instead of the Playwright-managed one.
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], launchOptions: chromiumPath ? { executablePath: chromiumPath } : {} } },
    {
      name: "mobile",
      testMatch: /marketing/,
      use: { ...devices["Pixel 7"], launchOptions: chromiumPath ? { executablePath: chromiumPath } : {} },
    },
  ],
  webServer: {
    command: "pnpm exec tsx tests/e2e/stack.ts",
    url: `${APP_URL}/api/health?worker=1`,
    timeout: 180_000,
    reuseExistingServer: false,
    stdout: "pipe",
    stderr: "pipe",
  },
});
