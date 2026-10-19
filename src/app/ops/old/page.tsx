import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { etAddDays, etDayKey } from "@/lib/datetime";
import { listAssignees, viewerAssigneeKey } from "@/lib/assignees";
import { isSyntheticClientRow } from "@/lib/testClients";
import { listOldItems, MAX_PUSH_DAYS, OLD_AFTER_DAYS, PUSHES_BEFORE_FLAG, WEEK_OLD_DAYS } from "@/lib/taskAging";
import { OldItemRow } from "@/components/home/OpsHomeParts";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/old — OLD ITEMS TO CLEAR (Oct 19 2026). The full list behind Home's
// "Old items to clear: N". An open task that names a person and is 3+ days
// past its date (lib/taskAging), oldest first, each with Done, Not needed or
// New date. Kyle lands on his own list; ?who=all (or a person's key) shows the
// team, which is where Jordan's Home and his morning list point.
// ---------------------------------------------------------------------------

type SP = { who?: string | string[]; test?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function OldItemsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/ops/old");
  const sp = await searchParams;
  const isOwner = !me || me.role === "OWNER";
  const includeTest = one(sp.test) === "1";
  const roster = await listAssignees().catch(() => []);
  const mine = me ? viewerAssigneeKey(me, roster) : null;
  const whoParam = one(sp.who);
  // The owner's default is the team; anyone else starts on their own list.
  const who = whoParam === "all" || (!whoParam && (isOwner || !mine)) ? "all" : whoParam && /^[a-z0-9_]{1,40}$/.test(whoParam) ? whoParam : mine;
  const excludedClientIds = includeTest ? [] : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const now = new Date();
  const read = await listOldItems(now, { personKey: who === "all" ? null : who, excludeClientIds: excludedClientIds, scrub: !isOwner, roster });
  const minDay = etDayKey(etAddDays(now, 1));
  const maxDay = etDayKey(etAddDays(now, MAX_PUSH_DAYS));
  const q = (w: string) => `/ops/old?who=${w}${includeTest ? "&test=1" : ""}`;
  const weekOld = read.items.filter((i) => i.daysPast >= WEEK_OLD_DAYS).length;
  const whoName = who === "all" ? "the team" : who === mine ? "you" : read.people.find((p) => p.key === who)?.name ?? who;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Old items to clear"
        subtitle={`${read.items.length} open item${read.items.length === 1 ? "" : "s"} for ${whoName}, ${OLD_AFTER_DAYS}+ days past their date · ${weekOld} over a week`}
      />
      <div className="mx-auto max-w-3xl space-y-4 p-4 pb-16 sm:p-6">
        <p className="text-sm text-muted">
          For each one: <b>Done</b> if it happened, <b>Not needed</b> if it never will, or pick a <b>new date</b>. A new date moves when it comes back here; it never
          changes the promise to the client. The {PUSHES_BEFORE_FLAG === 3 ? "third" : `${PUSHES_BEFORE_FLAG}th`} new date on the same item tells Jordan.
        </p>
        {/* Whose list. */}
        <nav aria-label="Whose old items" className="flex flex-wrap gap-2">
          {mine && <WhoChip href={q(mine)} active={who === mine} label={`Mine (${read.people.find((p) => p.key === mine)?.total ?? 0})`} />}
          <WhoChip href={q("all")} active={who === "all"} label={`Everyone (${read.people.reduce((n, p) => n + p.total, 0)})`} />
          {read.people.filter((p) => p.key !== mine).map((p) => (
            <WhoChip key={p.key} href={q(p.key)} active={who === p.key} label={`${p.name} (${p.total})`} />
          ))}
        </nav>
        {read.items.length === 0 ? (
          <p className="flex items-center gap-2 rounded-2xl border border-success/20 bg-success/[0.05] px-5 py-4 text-[15px] text-success">
            <CheckCircle2 aria-hidden className="size-5" /> Nothing old here.
          </p>
        ) : (
          <ul className="panel-shadow divide-y divide-border rounded-2xl border border-border bg-surface px-4">
            {read.items.map((i) => <OldItemRow key={i.id} item={i} minDay={minDay} maxDay={maxDay} showPerson={who === "all"} />)}
          </ul>
        )}
        <p className="text-[12px] text-muted-2">
          <Link href={includeTest ? "/?test=1" : "/"} className="hover:text-foreground">Back to Home</Link>
        </p>
      </div>
    </div>
  );
}

function WhoChip({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex min-h-11 items-center rounded-full border px-3 text-sm font-medium",
        active ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );
}
