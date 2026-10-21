import { ArrowRight, BadgeCheck, CreditCard, LinkIcon, Lock, RefreshCw, Send, ShieldCheck, UserMinus, Users } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";

const steps = [
  { icon: Send, title: "Sign in with Telegram", body: "No passwords. Confirm in the Flock bot and you're in." },
  { icon: Users, title: "Connect your channel or group", body: "Add the Flock bot as an admin. We verify it has exactly the rights it needs." },
  { icon: CreditCard, title: "Connect Stripe", body: "Payments go to your own Stripe account. Flock never holds your money." },
  { icon: LinkIcon, title: "Share your membership page", body: "Set a monthly price, publish, and share one link anywhere." },
];

const features = [
  { icon: BadgeCheck, title: "Access only after real payment", body: "Members get a personal, single-use invite only after Stripe confirms the payment. A redirect is never enough." },
  { icon: UserMinus, title: "Automatic removal", body: "When a membership ends, is refunded or disputed, the bot removes the member. Admins are never touched." },
  { icon: RefreshCw, title: "Self-healing", body: "Hourly reconciliation with Stripe and Telegram catches missed webhooks and permission changes." },
  { icon: Lock, title: "Forwarded links don't work", body: "Every invite requires a join request, and the bot only approves the person who paid." },
  { icon: ShieldCheck, title: "Your Stripe, your customers", body: "Direct charges on your connected account. Members manage billing in Stripe's own portal." },
  { icon: Users, title: "A clear member list", body: "See who is active, who is in their grace period, who is ending, and why." },
];

const faqs = [
  { q: "Does Flock take a cut of my sales?", a: "No. Flock charges no transaction fee. Stripe's standard processing fees apply on your own Stripe account." },
  { q: "Do my members need an account?", a: "They sign in with Telegram, the same way you do. That's how we know which Telegram account to let in." },
  { q: "Can people pay inside Telegram?", a: "No. Members pay on Stripe Checkout on the web. The bot only handles invites, status and support." },
  { q: "What happens if a renewal fails?", a: "Stripe retries the card. Members keep access during a short grace period, then the bot removes them if payment doesn't recover." },
  { q: "Channels or groups?", a: "Both: private channels and private groups (supergroups). The bot needs permission to invite users and ban users." },
];

export default function HomePage() {
  return (
    <>
      <section className="relative overflow-hidden border-b">
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(60rem_30rem_at_70%_-10%,var(--primary-soft),transparent)]" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:py-28">
          <div className="flex flex-col gap-6">
            <p className="w-fit rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">Now in early access, free to use</p>
            <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Your Telegram community. Your subscription business.</h1>
            <p className="max-w-xl text-lg text-muted-foreground text-pretty">
              Charge a monthly membership for your private Telegram channel or group. Flock takes payments through your Stripe account, sends each member a
              personal invite, and removes them automatically when their membership ends.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link href="/login?returnTo=%2Fdashboard" className={buttonClasses("primary", "lg")}>
                Start for free <ArrowRight aria-hidden />
              </Link>
              <Link href="#how-it-works" className={buttonClasses("outline", "lg")}>
                See how it works
              </Link>
            </div>
          </div>
          <ProductPreview />
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-20 px-4 py-20 sm:px-6">
        <h2 className="text-3xl font-semibold tracking-tight">Live in four steps</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">Set up takes a few minutes. Stripe may ask for identity details before you can accept payments.</p>
        <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.title} className="flex flex-col gap-3 rounded-lg border bg-card p-5">
              <div className="flex items-center gap-3">
                <span className="flex size-8 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary">{i + 1}</span>
                <s.icon className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <h3 className="font-medium">{s.title}</h3>
              <p className="text-sm text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="border-y bg-muted/50">
        <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <h2 className="text-3xl font-semibold tracking-tight">Access control you don&apos;t have to babysit</h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">The hard part of a paid community is keeping the member list honest. That&apos;s what Flock is built around.</p>
          <div className="mt-10 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="flex flex-col gap-2">
                <f.icon className="size-5 text-primary" aria-hidden />
                <h3 className="font-medium">{f.title}</h3>
                <p className="text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-20 sm:px-6">
        <h2 className="text-3xl font-semibold tracking-tight">Questions</h2>
        <dl className="mt-8 divide-y rounded-lg border bg-card">
          {faqs.map((f) => (
            <div key={f.q} className="p-5">
              <dt className="font-medium">{f.q}</dt>
              <dd className="mt-1 text-sm text-muted-foreground">{f.a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
        <div className="flex flex-col items-start gap-4 rounded-xl bg-primary px-6 py-10 text-primary-foreground sm:flex-row sm:items-center sm:justify-between sm:px-10">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">Turn your channel into a membership</h2>
            <p className="mt-1 opacity-90">Free during early access. No transaction fees from Flock.</p>
          </div>
          <Link href="/login?returnTo=%2Fdashboard" className={buttonClasses("outline", "lg", "border-transparent text-foreground")}>
            Start for free
          </Link>
        </div>
      </section>
    </>
  );
}

/** Illustrative UI, not real data. Labelled as such for screen readers and visually. */
function ProductPreview() {
  const rows = [
    { name: "Member A", status: "Active", tone: "text-success bg-success-soft", date: "Renews in 12 days" },
    { name: "Member B", status: "Grace period", tone: "text-warning bg-warning-soft", date: "Payment retrying" },
    { name: "Member C", status: "Ending", tone: "text-muted-foreground bg-muted", date: "Access ends in 3 days" },
  ];
  return (
    <figure className="rounded-xl border bg-card p-4 shadow-lg shadow-primary/5 sm:p-6" aria-label="Illustration of the Flock member list">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Members</p>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tracking-wide text-muted-foreground uppercase">Illustration</span>
      </div>
      <ul className="mt-4 divide-y">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3">
              <span className="size-8 rounded-full bg-primary-soft" aria-hidden />
              <span className="text-sm">{r.name}</span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.tone}`}>{r.status}</span>
              <span className="text-xs text-muted-foreground">{r.date}</span>
            </div>
          </li>
        ))}
      </ul>
      <figcaption className="mt-4 rounded-md bg-muted p-3 text-xs text-muted-foreground">
        When a membership ends, the bot removes the member from your Telegram chat and records why.
      </figcaption>
    </figure>
  );
}
