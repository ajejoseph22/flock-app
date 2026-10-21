import { safeReturnTo } from "@flock/core/services/auth";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/site/logo";
import { currentUser } from "@/lib/server/session";
import { LoginFlow } from "./login-flow";

export const metadata: Metadata = { title: "Sign in", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo: raw } = await searchParams;
  const returnTo = safeReturnTo(raw) ?? null;
  if (await currentUser()) redirect(returnTo ?? "/account");
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <Logo />
      <LoginFlow returnTo={returnTo} />
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        Flock uses your Telegram account so the right person gets access. We only receive your Telegram name, username and ID.
      </p>
    </main>
  );
}
