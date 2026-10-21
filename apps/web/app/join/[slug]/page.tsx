import { displayTelegramName, getActiveEntitlement, getCreatorByUserId, getPublicCommunity } from "@flock/core";
import { Check, Megaphone, MessagesSquare, Send } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/site/logo";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { currentUser, loginUrl } from "@/lib/server/session";
import { JoinButton } from "./join-button";

type Params = Promise<{ slug: string }>;

async function load(slug: string) {
  const user = await currentUser();
  const creator = user ? await getCreatorByUserId(deps().db, user.id) : null;
  const data = await getPublicCommunity(deps().db, slug.toLowerCase(), { previewCreatorId: creator?.id ?? null });
  return { user, data };
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const { data } = await load(slug);
  if (!data) return { title: "Not found" };
  return {
    title: data.community.name,
    description: data.community.description.slice(0, 160) || `Join ${data.community.name} on Telegram.`,
    robots: data.community.status === "published" && !data.community.isDemo ? undefined : { index: false },
  };
}

export default async function JoinPage({ params, searchParams }: { params: Params; searchParams: Promise<{ checkout?: string }> }) {
  const { slug } = await params;
  const { checkout } = await searchParams;
  const { user, data } = await load(slug);
  if (!data) notFound();
  const { community, plan } = data;
  const d = deps();
  const entitlement = user ? await getActiveEntitlement(d.db, user.id, community.id, d.now()) : null;
  const ChatIcon = data.chatType === "channel" ? Megaphone : MessagesSquare;

  return (
    <div className="flex min-h-dvh flex-col">
      {data.isOwnerPreview && community.status !== "published" && (
        <div className="bg-warning-soft px-4 py-2 text-center text-sm text-warning">Preview: only you can see this page until you publish it.</div>
      )}
      {community.isDemo && <div className="bg-warning-soft px-4 py-2 text-center text-sm text-warning">Demo community with sample data. Checkout is disabled.</div>}
      <main id="main" className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10 sm:py-16">
        {checkout === "canceled" && <Alert tone="info" title="Checkout canceled">You haven&apos;t been charged.</Alert>}
        <div className="flex flex-col items-center gap-4 text-center">
          {community.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- creator-supplied https URL; no remote image allowlist
            <img src={community.avatarUrl} alt="" className="size-20 rounded-2xl object-cover" referrerPolicy="no-referrer" />
          ) : (
            <div className="flex size-20 items-center justify-center rounded-2xl bg-primary-soft text-3xl font-semibold text-accent" aria-hidden>
              {community.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-3xl font-display font-bold tracking-[-0.025em] text-balance">{community.name}</h1>
            <p className="mt-1 text-sm text-muted-foreground">by {data.creatorName}</p>
          </div>
          {data.chatType && (
            <p className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
              <ChatIcon className="size-3.5" aria-hidden /> Private Telegram {data.chatType === "channel" ? "channel" : "group"}
            </p>
          )}
        </div>

        {community.description && <p className="text-center whitespace-pre-line text-muted-foreground">{community.description}</p>}

        <div className="flex flex-col gap-5 rounded-xl border bg-card p-6 shadow-sm">
          {plan ? (
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium">{plan.name}</p>
              <p className="text-2xl font-semibold" data-testid="plan-price">
                {formatMoney(plan.amountMinor, plan.currency)}
                <span className="text-sm font-normal text-muted-foreground"> / month</span>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No membership plan yet.</p>
          )}
          {community.benefits.length > 0 && (
            <ul className="flex flex-col gap-2 text-sm">
              {community.benefits.map((b) => (
                <li key={b} className="flex gap-2">
                  <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                  {b}
                </li>
              ))}
            </ul>
          )}

          {entitlement ? (
            <div className="flex flex-col gap-3">
              <Alert tone="success" title="You're a member">Your access is active.</Alert>
              <Link href="/account" className={buttonClasses("outline", "md", "w-full")}>
                View my membership
              </Link>
            </div>
          ) : !data.acceptingMembers ? (
            <Alert tone="warning" title="Not accepting new members right now">
              {data.isOwnerPreview ? "Finish setup and publish the page to accept members." : "Please check back later."}
            </Alert>
          ) : user ? (
            <div className="flex flex-col gap-2">
              <JoinButton slug={community.slug} label="Continue to payment" />
              <p className="text-center text-xs text-muted-foreground">
                Joining as <span className="font-medium text-foreground">{displayTelegramName(user)}</span>.{" "}
                <form action="/api/auth/logout" method="post" className="inline">
                  <input type="hidden" name="returnTo" value={loginUrl(`/join/${community.slug}`)} />
                  <button type="submit" className="underline">
                    Not you?
                  </button>
                </form>
              </p>
            </div>
          ) : (
            <Link href={loginUrl(`/join/${community.slug}`)} className={buttonClasses("primary", "lg", "w-full")} data-testid="join-signin">
              <Send aria-hidden /> Continue with Telegram
            </Link>
          )}
          <p className="text-center text-xs text-muted-foreground">
            Billed monthly through Stripe. Cancel any time. After paying you get a personal invite link for this Telegram account.
          </p>
        </div>

        {community.supportContact && <p className="text-center text-sm text-muted-foreground">Questions? Contact {community.supportContact}</p>}
      </main>
      <footer className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
        <span>Memberships powered by</span>
        <Logo />
      </footer>
    </div>
  );
}
