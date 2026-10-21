import Link from "next/link";

export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M8 19.5c3-1 5.5-3.6 6.6-7.5 1.4 3.2 4.4 5.4 9.4 5.9-3.4 1.6-6.6 4.4-8.4 7.6-1.6-3-4.2-5.2-7.6-6Z" className="fill-primary-foreground" />
    </svg>
  );
}

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight" aria-label="Flock home">
      <LogoMark />
      <span className="text-lg">Flock</span>
    </Link>
  );
}
