import Link from "next/link";
import { Logo } from "@/components/site/logo";
import { buttonClasses } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-6 px-4 text-center">
      <Logo />
      <div>
        <h1 className="text-2xl font-display font-bold tracking-[-0.025em]">Page not found</h1>
        <p className="mt-2 text-muted-foreground">This page doesn&apos;t exist, or it isn&apos;t published.</p>
      </div>
      <Link href="/" className={buttonClasses("outline")}>
        Go home
      </Link>
    </main>
  );
}
