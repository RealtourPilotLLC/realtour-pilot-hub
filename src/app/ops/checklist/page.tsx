import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { getCurrentUser } from "@/lib/auth/user";
import { etAddDays, etDayKey, etFullDate, etTime } from "@/lib/datetime";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { CHECKLIST_PATH } from "@/lib/homeAnchors";
import { listAssignees, viewerAssigneeKey, type Assignee } from "@/lib/assignees";
import { MAX_PUSH_DAYS } from "@/lib/taskAging";
import { kyleChecklist, kylePerson } from "@/lib/opsHome";
import { behindState, type BehindState } from "@/lib/behindAlert";
import { BehindLine, DailyChecklist } from "@/components/home/Checklist";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// YOUR LIST — the daily checklist, its own page since Oct 19 2026 (night),
// when "/" became the dashboard (Jordan: "the other pages are for more
// in-depth adjustments and changes"). The dashboard's "Kyle's day" card
// ("Your list" for Kyle) opens it.
//
// The same checklist Kyle had on his Home that evening, unchanged in content
// (components/home/Checklist, lib/opsHome.kyleChecklist): one list for today
// in five groups (Deliveries, Messages to answer, Special requests to check,
// Scheduling to handle, Follow-ups due), From earlier days, Done today, Still
// open. The summary box above it is gone: the dashboard's health strip says
// the same and more.
//
// WHOSE LIST: an office login (ADMIN) sees their own (deliveries, messages,
// requests and scheduling are the office's, so everyone's list holds the same
// ones; follow-ups and earlier items are theirs). The owner sees Kyle's, and
// so does anyone who opens it with ?who=kyle (the dashboard's "Open Kyle's
// list"). Old links ("/#loops", "/ops#video-review", /ops/requests) land on
// the group that holds that work (lib/homeAnchors).
// ---------------------------------------------------------------------------

export default async function YourListPage(props: { searchParams?: Promise<{ test?: string | string[]; who?: string | string[] }> }) {
  await requirePageAccess("ops");
  const [me, sp] = await Promise.all([getCurrentUser().catch(() => null), props?.searchParams ?? Promise.resolve(undefined)]);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect(homeFor(me.role));
  const isOwner = !me || me.role === "OWNER";
  const includeTest = sp?.test === "1";
  const excludedClientIds = includeTest ? [] : await syntheticClientIds();
  const roster: Assignee[] = await listAssignees().catch(() => []);
  const viewerKey = me ? viewerAssigneeKey(me, roster) : null;
  const ops = (await kylePerson(roster).catch(() => null)) ?? { key: "kyle", teamMemberId: null, name: "Kyle" };
  const viewerIsOps = !!me && ((!!ops.teamMemberId && ops.teamMemberId === me.teamMemberId) || (!!viewerKey && viewerKey === ops.key));
  const forOps = isOwner || sp?.who === "kyle" || viewerIsOps;
  // An office login with no roster match still gets their own (empty) follow-ups, never someone else's.
  const person = forOps ? ops : { key: viewerKey ?? (me?.teamMemberId ? null : "__unresolved__"), teamMemberId: me?.teamMemberId ?? null };
  const now = new Date();
  const [list, behind] = await Promise.all([
    // No figures for anyone but the owner: what people typed passes the money scrub.
    kyleChecklist({ now, excludeClientIds: excludedClientIds, person, scrub: !isOwner, roster, you: viewerIsOps || !forOps ? me?.name?.split(" ")[0] ?? null : null, withRequestJobs: true }),
    behindState(now).catch((e: unknown): BehindState | null => { console.warn("behindState failed", (e as Error).message); return null; }),
  ]);
  // A New date is a day after today, at most MAX_PUSH_DAYS out (the action checks too).
  const minDay = etDayKey(etAddDays(now, 1));
  const maxDay = etDayKey(etAddDays(now, MAX_PUSH_DAYS));
  const mine = !forOps || viewerIsOps;
  const self = `${CHECKLIST_PATH}${sp?.who === "kyle" && !isOwner && !viewerIsOps ? "?who=kyle" : ""}`;
  const toggleHref = includeTest ? self : homeRecordHref(self, true);
  return (
    <div>
      <AutoRefresh seconds={90} />
      <PageHeader
        eyebrow="Daily checklist"
        title={mine ? "Your list" : `${ops.name}’s list`}
        // The counts are said once, on the list's own header (audit A25).
        subtitle={`${etFullDate(now)} · updated ${etTime(now)} ET`}
        actions={
          <Link href={toggleHref} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            {includeTest ? "Hide test records" : "Show test records"}
          </Link>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        <p className="text-sm">
          <Link href={homeRecordHref("/", includeTest)} className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">Back to the dashboard</Link>
        </p>
        <BehindLine state={behind} href="#deliveries" />
        <DailyChecklist list={list} includeTest={includeTest} minDay={minDay} maxDay={maxDay} />
      </div>
    </div>
  );
}
