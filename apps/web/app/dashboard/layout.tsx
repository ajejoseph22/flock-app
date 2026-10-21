import { ensureCreator, getSetupState } from "@flock/core";
import { ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { DashboardNav } from "@/components/dashboard/nav";
import { Logo } from "@/components/site/logo";
import { UserMenu } from "@/components/site/user-menu";
import { deps } from "@/lib/server/deps";
import { currentUser } from "@/lib/server/session";

export const metadata: Metadata = { title: { default: "Dashboard", template: "%s · Flock" }, robots: { index: false } };

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Each page enforces sign-in with its own return path; the layout just renders nothing extra when signed out.
  const user = await currentUser();
  if (!user) return children;
  const d = deps();
  const creator = await ensureCreator(d.db, user);
  const setup = await getSetupState(d.db, creator.id);
  const setupIncomplete = setup.steps.some((s) => !s.done);
  return (
    <div className="flex min-h-dvh flex-col">
      {!d.config.stripe.livemode && (
        <div className="bg-warning-soft px-4 py-1.5 text-center text-xs font-medium text-warning">Stripe test mode: no real money moves.</div>
      )}
      <header className="border-b bg-card">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Logo href="/dashboard" />
            {setup.community && (
              <span className="hidden truncate text-sm text-muted-foreground sm:inline">
                {setup.community.name}
                {setup.community.isDemo && <span className="ml-2 rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning">Demo data</span>}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {setup.community?.status === "published" && (
              <Link href={`/join/${setup.community.slug}`} target="_blank" className="hidden items-center gap-1 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted md:flex">
                View page <ExternalLink className="size-3.5" aria-hidden />
              </Link>
            )}
            <UserMenu user={user} />
          </div>
        </div>
      </header>
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:flex-row md:gap-10 md:py-10">
        <aside className="md:w-52 md:shrink-0">
          <DashboardNav setupIncomplete={setupIncomplete} />
        </aside>
        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
