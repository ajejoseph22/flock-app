import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { currentUser } from "@/lib/server/session";
import { Logo } from "./logo";

export async function SiteHeader() {
  const user = await currentUser();
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo />
        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
          <Link href="/#how-it-works" className="hidden rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground sm:block">
            How it works
          </Link>
          <Link href="/pricing" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
            Pricing
          </Link>
          {user ? (
            <Link href="/dashboard" className={buttonClasses("primary", "sm")}>
              Dashboard
            </Link>
          ) : (
            <>
              <Link href="/login" className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                Log in
              </Link>
              <Link href="/login?returnTo=%2Fdashboard" className={buttonClasses("primary", "sm")}>
                Start for free
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
