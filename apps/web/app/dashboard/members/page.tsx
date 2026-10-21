import { getOwnedCommunity, listMembers, type MemberSort } from "@flock/core";
import { Search, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { accessLabel, telegramLabel } from "@/components/dashboard/labels";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/format";
import { deps } from "@/lib/server/deps";
import { requireCreator } from "@/lib/server/session";

export const metadata: Metadata = { title: "Members" };

const SORTS: { value: MemberSort; label: string }[] = [
  { value: "joined", label: "Join date" },
  { value: "renewal", label: "Renewal / end date" },
  { value: "name", label: "Name" },
  { value: "status", label: "Status" },
];

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string; dir?: string }> }) {
  const { creator } = await requireCreator("/dashboard/members");
  const params = await searchParams;
  const d = deps();
  const community = await getOwnedCommunity(d.db, creator.id);
  if (!community) {
    return (
      <>
        <PageHeader title="Members" />
        <EmptyState icon={<Users />} title="No community yet">
          <Link href="/dashboard/setup" className="underline">
            Create your community
          </Link>{" "}
          to start accepting members.
        </EmptyState>
      </>
    );
  }
  const sort = SORTS.some((s) => s.value === params.sort) ? (params.sort as MemberSort) : "joined";
  const dir = params.dir === "asc" ? "asc" : "desc";
  const q = (params.q ?? "").slice(0, 100);
  const members = await listMembers(d.db, community.id, { q, sort, dir });

  return (
    <>
      <PageHeader title="Members" description="Everyone who has subscribed, with their access state in Telegram." />
      <form className="mb-4 flex flex-col gap-2 sm:flex-row" role="search">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <label htmlFor="q" className="sr-only">
            Search members
          </label>
          <Input id="q" name="q" defaultValue={q} placeholder="Search by name, @username or Telegram ID" className="pl-9" />
        </div>
        <label htmlFor="sort" className="sr-only">
          Sort by
        </label>
        <Select id="sort" name="sort" defaultValue={sort} className="sm:w-48">
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              Sort: {s.label}
            </option>
          ))}
        </Select>
        <label htmlFor="dir" className="sr-only">
          Direction
        </label>
        <Select id="dir" name="dir" defaultValue={dir} className="sm:w-36">
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </Select>
        <button type="submit" className={buttonClasses("outline")}>
          Apply
        </button>
      </form>

      {members.length === 0 ? (
        <EmptyState icon={<Users />} title={q ? "No members match your search" : "No members yet"}>
          {q ? "Try a different name or username." : "Share your membership page to get your first members."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Member</th>
                <th scope="col" className="px-4 py-3 font-medium">Access</th>
                <th scope="col" className="px-4 py-3 font-medium">Telegram</th>
                <th scope="col" className="px-4 py-3 font-medium">Joined</th>
                <th scope="col" className="px-4 py-3 font-medium">Renews / ends</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {members.map((m) => {
                const a = accessLabel(m.entitlementStatus, m.entitlementReason);
                const t = telegramLabel(m.accessState);
                return (
                  <tr key={m.userId} className="hover:bg-muted/40" data-testid="member-row">
                    <td className="px-4 py-3">
                      <Link href={`/dashboard/members/${m.userId}`} className="font-medium hover:underline">
                        {m.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{m.username ? `@${m.username}` : `ID ${m.telegramUserId}`}</p>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={a.tone}>{a.label}</Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={t.tone}>{t.label}</Badge>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{formatDate(m.joinedAt ?? m.subscribedAt)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {m.nextDate ? `${m.nextDateKind === "renews" ? "Renews" : m.nextDateKind === "ends" ? "Ends" : "Ended"} ${formatDate(m.nextDate)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
