import { getCheckoutStatus, getPublicCommunity, requestCheckoutVerification } from "@flock/core";
import { communities } from "@flock/db";
import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Logo } from "@/components/site/logo";
import { deps } from "@/lib/server/deps";
import { requireUser } from "@/lib/server/session";
import { StatusView } from "./status-view";

export const metadata: Metadata = { title: "Your membership", robots: { index: false } };

export default async function CheckoutStatusPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ intent?: string }> }) {
  const { slug } = await params;
  const { intent } = await searchParams;
  const user = await requireUser(`/join/${slug}/status?intent=${encodeURIComponent(intent ?? "")}`);
  if (!intent || !/^[0-9a-f-]{36}$/.test(intent)) notFound();
  const d = deps();
  const status = await getCheckoutStatus(d, user.id, intent);
  if (!status) notFound();
  const [community] = await d.db.select().from(communities).where(eq(communities.id, status.intent.communityId)).limit(1);
  if (!community || community.slug !== slug) notFound();
  if (status.view.state === "confirming") await requestCheckoutVerification(d.db, intent);
  const pub = await getPublicCommunity(d.db, slug);

  return (
    <main id="main" className="flex min-h-dvh flex-col items-center justify-center gap-8 px-4 py-12">
      <Logo />
      <StatusView
        intentId={intent}
        initial={JSON.parse(JSON.stringify(status.view))}
        communityName={community.name}
        slug={slug}
        chatType={pub?.chatType ?? null}
        supportContact={community.supportContact}
      />
    </main>
  );
}
