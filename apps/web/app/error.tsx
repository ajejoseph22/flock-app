"use client";

import { Logo } from "@/components/site/logo";
import { Button } from "@/components/ui/button";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div>
        <h1 className="text-2xl font-display font-bold tracking-[-0.025em]">Something went wrong</h1>
        <p className="mt-2 text-muted-foreground">Please try again. If it keeps happening, contact support{error.digest ? ` and mention code ${error.digest}` : ""}.</p>
      </div>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
