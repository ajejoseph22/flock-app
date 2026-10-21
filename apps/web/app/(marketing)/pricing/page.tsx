import { PLATFORM_PLANS } from "@flock/core/pricing";
import { formatMoney } from "@flock/core/domain/money";
import { Check } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";

export const metadata: Metadata = { title: "Pricing" };

export default function PricingPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-semibold tracking-tight">Simple pricing</h1>
        <p className="mt-3 text-lg text-muted-foreground">
          Flock is free during early access. When paid plans launch, existing creators get advance notice. Flock never takes a percentage of your sales.
        </p>
      </div>
      <div className="mt-12 grid gap-4 lg:grid-cols-3">
        {PLATFORM_PLANS.map((p) => {
          const isBeta = p.key === "beta";
          return (
            <div key={p.key} className={`flex flex-col gap-5 rounded-xl border bg-card p-6 ${isBeta ? "border-primary ring-1 ring-primary" : ""}`}>
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                {isBeta ? (
                  <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-primary">Available now</span>
                ) : (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">After early access</span>
                )}
              </div>
              <p className="text-sm text-muted-foreground">{p.blurb}</p>
              <p className="text-3xl font-semibold">
                {formatMoney(p.priceMonthlyMinor, p.currency)}
                <span className="text-sm font-normal text-muted-foreground"> / month</span>
              </p>
              <ul className="flex flex-col gap-2 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-auto pt-2">
                {isBeta ? (
                  <Link href="/login?returnTo=%2Fdashboard" className={buttonClasses("primary", "md", "w-full")}>
                    Start for free
                  </Link>
                ) : (
                  <p className="text-center text-xs text-muted-foreground">Not yet available</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-8 text-sm text-muted-foreground">
        Stripe&apos;s payment processing fees are charged by Stripe on your own account. See{" "}
        <a className="underline" href="https://stripe.com/pricing" rel="noopener noreferrer" target="_blank">
          Stripe pricing
        </a>
        .
      </p>
    </div>
  );
}
