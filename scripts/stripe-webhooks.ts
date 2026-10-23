/**
 * Check, or create, the three Stripe webhook destinations for one environment.
 *
 *   STRIPE_SECRET_KEY=sk_test_… pnpm stripe:webhooks --app-url https://staging.useflock.com
 *   STRIPE_SECRET_KEY=sk_test_… pnpm stripe:webhooks --app-url https://staging.useflock.com --create
 *
 * Needs only STRIPE_SECRET_KEY (a full test key, or a restricted key with Webhook write) and the app URL,
 * so it runs before the app can boot. `--create` adds the missing destinations and prints each signing
 * secret once, with the variable to paste it into. It never edits or deletes an existing destination.
 * Live keys are refused unless `--live` is passed.
 */
import { createStripeClient, createWebhookDestination, inspectWebhookDestinations } from "@flock/payments";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !/^(sk|rk)_(test|live)_/.test(key)) throw new Error("Set STRIPE_SECRET_KEY to a Stripe secret or restricted key.");
  if (key.includes("_live_") && !process.argv.includes("--live")) throw new Error("Refusing to touch live mode without --live.");
  const appUrl = (arg("--app-url") ?? process.env.APP_URL)?.replace(/\/$/, "");
  if (!appUrl?.startsWith("https://")) throw new Error("Pass --app-url https://… (Stripe needs a public https URL).");

  const stripe = createStripeClient({ secretKey: key });
  const statuses = await inspectWebhookDestinations(stripe, appUrl);
  const create = process.argv.includes("--create");
  const secrets: string[] = [];
  let problems = 0;

  for (const s of statuses) {
    if (!s.id) {
      if (!create) {
        console.log(`✘ ${s.spec.label}: missing (${s.url})`);
        problems++;
        continue;
      }
      const made = await createWebhookDestination(stripe, s.spec, s.url);
      console.log(`✔ ${s.spec.label}: created ${made.id} (${s.url})`);
      secrets.push(`${s.spec.secretEnv}=${made.secret}`);
      continue;
    }
    const issues = [
      !s.enabled && "disabled",
      s.missingEvents.length > 0 && `missing events: ${s.missingEvents.join(", ")}`,
      s.apiVersionMismatch && `API version ${s.apiVersionMismatch} (expected the SDK's pinned version)`,
    ].filter(Boolean);
    if (issues.length) problems++;
    console.log(`${issues.length ? "✘" : "✔"} ${s.spec.label}: ${s.id} (${s.url})${issues.length ? ` — ${issues.join("; ")}` : ""}`);
  }

  if (secrets.length) {
    console.log("\nSigning secrets. Stripe shows them only once: paste each into the app's environment now.\n");
    for (const line of secrets) console.log(`  ${line}`);
  }
  if (problems) {
    console.log(`\n${problems} destination(s) need attention.${create ? " Fix or delete them in the Stripe dashboard, then rerun." : " Rerun with --create to add the missing ones."}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
