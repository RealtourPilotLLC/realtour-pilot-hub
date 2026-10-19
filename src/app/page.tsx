import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2, ChevronDown, Inbox } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess, contentTier, homeFor } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { cn, formatMoney } from "@/lib/utils";
import { foldNeeds } from "@/lib/homeNeeds";
import { etAddDays, etDate, etDayKey, etFullDate, etTime } from "@/lib/datetime";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { DayBlock } from "@/components/ops/DayBlock";
import { ExceptionsCard } from "@/components/ops/ExceptionsCard";
import { emptyExceptionBoard, opsExceptionsBoard, type OpsExceptionBoard } from "@/lib/opsExceptions";
import { PulseStrip } from "@/components/dashboard/PulseStrip";
import { QualityDials } from "@/components/dashboard/QualityDials";
import { QuickAdd } from "@/components/day/QuickAdd";
import { TodoRow } from "@/components/day/TodoRow";
import { FinishedList } from "@/components/day/FinishedList";
import { buildOpsDay, tallyLoops, scrubOpsDayMoney, type OpsDay } from "@/lib/opsDay";
import { deliveryBoard, type DeliveryBoard } from "@/lib/deliveryBoard";
import { ownerTodoLists } from "@/lib/ownerDay";
import { ownerPulse } from "@/lib/ownerPulse";
import { getStuckJobs, getShootWindow, getProactiveFlags, getOwnerStats, getOwnerPulse, getOwnerDials, getFlaggedForMe } from "@/lib/queries";
import { scrubMoney } from "@/lib/text";
import { listAssignees, slugForName, viewerAssigneeKey, type Assignee } from "@/lib/assignees";
import { isSyntheticClientRow } from "@/lib/testClients";
import { getReviewQueue, followUpHref } from "@/lib/reviewRoom";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { openLeadsFor } from "@/lib/leadDesk";
import { listOldItems, MAX_PUSH_DAYS, type OldItemsRead } from "@/lib/taskAging";
import { homeRoleOf, kyleChecklist, kylePerson, ownerWeek, type KyleChecklist, type OwnerWeek } from "@/lib/opsHome";
import { behindState, type BehindState } from "@/lib/behindAlert";
import { ownerShootIssues } from "@/lib/shootIssues";
import { ageText, deliveryUnavailable, etMinutes, listingQc, offPageNumbers, rushShoots } from "@/components/home/DailyChecklist";
import { HomeAnchorForward } from "@/components/home/HomeAnchorForward";
import { blockScreen } from "@/lib/homeAnchors";
import { BehindCard, FlaggedBanner, OwnerWeekCard, ShootIssuesCard, ShootsTodayLine } from "@/components/home/OpsHomeParts";
import { BehindLine, DailyChecklist, KylesDay, SummaryBox } from "@/components/home/Checklist";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// HOME — one screen per role.
//
// Oct 19 2026, evening (Jordan): "The home screen should have the daily
// checklist, but with a box up top that summarizes the photo delivery, video
// delivery, and comms needing responses. … keep it simplified. We just need
// Kyle to be able to keep track of what he got done and what's still
// outstanding at the end of the day."
//
//   KYLE (operations): flagged-for-you · a red line when we are behind
//     (behindAlert) · the summary box (photos, videos, messages: three
//     numbers, each opening its screen) · the daily checklist: one list for
//     today in five groups (Deliveries, Messages to answer, Special requests
//     to check, Scheduling to handle, Follow-ups due), then the items from
//     earlier days, Done today (folded) and Still open. Every old block anchor
//     ("/#loops", "/#video-review") is an anchor inside the group that holds
//     that work now (lib/homeAnchors). The five tiles, the old-items card, the
//     ten time blocks, stuck jobs, exceptions and the radar are off his Home
//     (stuck jobs and exceptions live on /ops with today's shoot cards).
//   JORDAN (owner): this week against last (on-time % only from 3 jobs) ·
//     what we're behind on (the red line, the same three numbers team-wide,
//     the team's old items) · shoot issues · Kyle's day (done today and still
//     open, from Kyle's own checklist; shown here, never sent as a message) ·
//     his own list · money, with the 30-day trends folded under it.
//   JAMES (the review seat): his review desk, unchanged in substance; its
//     old block anchors open the screens that hold that work now.
//
// THE RULE FOR EVERY NUMBER (audit fault #9, Sep 2 2026) still holds: a count
// is computed with THE QUERY OF THE LIST IT LINKS TO (lib/opsHome says which
// function feeds each number).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WHAT NEEDS YOU NOW — the top of the page, and the only thing on it that
// claims to be a to-do list. Rows are built from the SAME arrays the sections
// below render, so a row can never point at an empty list.
//
// ONE CLEAR FIRST ACTION (Jordan, Oct 5: "simple and clear, without creating
// information overload in a small space"). The queue that matters most for
// this viewer's role leads, large, with its own Open button; the next three
// sit under it; everything else folds into "N more". A red or amber queue is
// never folded (lib/homeNeeds.foldNeeds — review, Oct 5 night: an amber
// "videos ready to send" row could sit unseen in the fold). Finished videos
// still to go out are a row here now — the separate three-paragraph delivery
// card that sat above this one said the same count in more words.
// ---------------------------------------------------------------------------

type NeedGroup = "decide" | "waiting" | "risk";
type Need = {
  key: string;
  group: NeedGroup;
  count: number;
  label: string;
  detail?: string;
  href: string;
  tone: "brand" | "danger" | "warning" | "muted";
};

/** Rows under the lead before the rest fold. */
const NEXT_SHOWN = 3;
const TONE_RANK: Record<Need["tone"], number> = { danger: 0, warning: 1, brand: 2, muted: 3 };

/** The list itself — the lead, the next three, the fold. The card around it
 *  (title, this role's one-line orientation, any warning) is the page's. */
function NeedsToday({ needs }: { needs: Need[] }) {
  const { lead, next, later } = foldNeeds(needs, NEXT_SHOWN);
  return (
    <>
      {lead && <NeedRow n={lead} lead />}
      {next.length > 0 && (
        <div className="mt-2 divide-y divide-border">
          {next.map((n) => <NeedRow key={n.key} n={n} />)}
        </div>
      )}
      {later.length > 0 && (
        <details className="group/more mt-1 border-t border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium text-muted hover:text-foreground">
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 -rotate-90 transition-transform group-open/more:rotate-0" />
            <span data-fold-count>{later.length} more queue{later.length === 1 ? "" : "s"}</span>
          </summary>
          <div className="divide-y divide-border">{later.map((n) => <NeedRow key={n.key} n={n} />)}</div>
        </details>
      )}
    </>
  );
}

function NeedRow({ n, lead = false }: { n: Need; lead?: boolean }) {
  const tone =
    n.tone === "danger" ? "text-danger" : n.tone === "warning" ? "text-warning" : n.tone === "brand" ? "text-brand" : "text-foreground";
  if (lead) {
    return (
      <Link
        href={n.href}
        className="mt-3 flex min-h-16 items-center gap-3 rounded-xl border border-brand/40 bg-brand-soft/40 px-3 py-3 hover:bg-brand-soft/70 focus-visible:outline-2 focus-visible:outline-brand"
      >
        <span className={cn("w-10 shrink-0 text-right text-2xl font-semibold tabular-nums", tone)}>{n.count}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold leading-snug">{n.label}</span>
          {n.detail && <span className="block text-sm text-muted">{n.detail}</span>}
        </span>
        <span className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg bg-brand-action px-3 text-sm font-semibold text-white">
          Open <ArrowRight aria-hidden="true" className="size-4" />
        </span>
      </Link>
    );
  }
  return (
    <Link
      href={n.href}
      className="-mx-2 flex min-h-14 items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-2/70 focus-visible:outline-2 focus-visible:outline-brand"
    >
      <span className={cn("w-10 shrink-0 text-right text-lg font-semibold tabular-nums", tone)}>{n.count}</span>
      <span className="min-w-0 flex-1">
        <span className="text-sm font-medium leading-snug">{n.label}</span>
        {n.detail && <span className="block text-sm text-muted">{n.detail}</span>}
      </span>
      <ArrowRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-2" />
    </Link>
  );
}

// ---------------------------------------------------------------------------
// THE SECONDARY SECTIONS STREAM (Oct 5: "nothing slow blocks first paint").
// Each read starts with the page's own reads (so nothing waits for the main
// list to finish before it begins), and each section renders behind its own
// Suspense boundary: the quiet-failures board (~2 s on the live pool), the
// owner's week, what is behind, and the money. A failure inside one says so in
// its own place and never blanks the rest of Home.
// ---------------------------------------------------------------------------

type RadarRead = Awaited<ReturnType<typeof getProactiveFlags>> | null;

function SectionLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-12 items-center rounded-2xl border border-dashed border-border bg-surface px-4 text-sm text-muted">
      {label}
    </div>
  );
}

async function HomeExceptions({ exceptionsP, includeTest, canReview, canEdit }: {
  exceptionsP: Promise<OpsExceptionBoard>; includeTest: boolean; canReview: boolean; canEdit: boolean;
}) {
  const exceptions = await exceptionsP;
  return (
    <ExceptionsCard
      rows={exceptions.rows.map((r) => ({ ...r, href: homeRecordHref(r.href.startsWith("/#") ? blockScreen(r.href.slice(1)) : r.href, includeTest) }))}
      totals={exceptions.totals}
      unavailable={exceptions.unavailable}
      includeTest={includeTest}
      canReview={canReview}
      canEdit={canEdit}
    />
  );
}

type OwnerReads = {
  stats: Awaited<ReturnType<typeof getOwnerStats>> | null;
  pulse: Awaited<ReturnType<typeof getOwnerPulse>> | null;
  dials: Awaited<ReturnType<typeof getOwnerDials>> | null;
  money: Awaited<ReturnType<typeof ownerPulse>> | null;
};

// MONEY — owner only, and last on purpose. Jordan: money after action. The
// strip merges the old dashboard line (delivered, pipeline, top AR) with My
// Day's glance (bank, profit, owed), so there is one money answer on this page
// instead of two. Trends and quality dials fold under it (Oct 5).
async function OwnerBusiness({ ownerP, radarP, includeTest }: { ownerP: Promise<OwnerReads>; radarP: Promise<RadarRead>; includeTest: boolean }) {
  const [{ stats, pulse, dials, money }, radar] = await Promise.all([ownerP, radarP]);
  if (!stats && !money && !pulse && !dials) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">The business numbers couldn&rsquo;t load. Refresh to try again, or open Finance.</p>;
  }
  // EACH HALF SAYS WHEN IT FAILED (review, Oct 5 night): the books strip sat
  // inside the delivery line's block, so a failed delivery read took the
  // bank / profit / owed numbers with it, and a failed books read just left
  // them out — either way the money vanished without a word.
  const couldNotLoad = (what: string) => (
    <p role="status" data-money-unavailable className="px-5 py-3 text-sm text-muted">
      {what} couldn&rsquo;t load. Refresh to try again, or <Link href="/sales" className="text-brand hover:underline">open Finance</Link>.
    </p>
  );
  return (
    <>
      <section className="panel-shadow rounded-2xl border border-border bg-surface" data-owner-money>
          {stats ? (
          <Link href="/sales" className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border px-5 py-3.5 text-sm hover:bg-surface-2/60">
            <span><span className="text-muted">Delivered this month</span> <b>{formatMoney(stats.revenueThisMonth)}</b> <span className="text-muted-2">({stats.deliveredThisMonth})</span></span>
            <span><span className="text-muted">Pipeline</span> <b>{formatMoney(stats.pipelineRevenue)}</b> <span className="text-muted-2">({stats.activeCount} active)</span></span>
            {radar?.topAr && <span><span className="text-muted">Top AR</span> <b>{radar.topAr.name} {formatMoney(radar.topAr.total)}</b></span>}
            <ArrowRight className="ml-auto size-4 text-muted-2" />
          </Link>
          ) : couldNotLoad("Delivered this month and the pipeline")}
          {!money && couldNotLoad("The books (profit, bank, owed to you)")}
          {money && (
            <div className="px-5 py-4">
              {/* TWO CLOCKS, SAID OUT LOUD. The line above is the delivery
                  ledger — jobs delivered this month × what they were sold
                  for. These four are the BOOKS — money that actually landed
                  through a processor, minus categorised spend. They are
                  different numbers for the same month on purpose, and a
                  reader who isn't told that reads one of them as wrong. */}
              <p className="text-[11px] text-muted-2">
                From the books — money that landed, not jobs delivered.{" "}
                <Link href="/sales" className="hover:text-foreground">Finance →</Link>
              </p>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <MoneyStat label="Profit this month" value={usd0(money.profitMonth)} sub={money.marginPct != null ? `${Math.round(money.marginPct)}% margin · provisional` : "provisional"} tone={money.profitMonth >= 0 ? "good" : "bad"} />
                <MoneyStat label="In the bank" value={money.bankBalance == null ? "—" : usd0(money.bankBalance)} sub={money.bankLabel ?? "not connected"} tone={money.bankBalance != null && money.bankBalance < 0 ? "bad" : undefined} />
                <MoneyStat label="Owed to you" value={usd0(money.owedToYou)} sub={`${money.owedCount} unpaid`} tone={money.owedToYou > 0 ? "bad" : undefined} />
                <MoneyStat label="Money in this year" value={usd0(money.revenueYtd)} sub={`through ${money.monthLabel}`} />
              </div>
            </div>
          )}
      </section>
      {(pulse || dials) && (
        <details className="group/trends rounded-2xl border border-border bg-surface">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm font-semibold">
            <ChevronDown aria-hidden="true" className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open/trends:rotate-0" />
            Trends and quality
            <span className="font-normal text-muted">· last 30 days against the 30 before</span>
          </summary>
          <div className="space-y-3 border-t border-border p-3 sm:p-4">
            {/* Owner pulse — health trends (30d vs prior 30d). */}
            {pulse && <PulseStrip pulse={pulse} />}
            {/* Quality dials — a compact video-SLA roll-up + the QC dial. */}
            {dials && <QualityDials dials={dials} includeTest={includeTest} />}
          </div>
        </details>
      )}
    </>
  );
}

async function OwnerWeekSection({ weekP }: { weekP: Promise<OwnerWeek | null> }) {
  return <OwnerWeekCard week={await weekP} />;
}

async function OwnerBehindSection({ stateP, listP, oldP, includeTest }: {
  stateP: Promise<BehindState | null>; listP: Promise<KyleChecklist | null>; oldP: Promise<OldItemsRead | null>; includeTest: boolean;
}) {
  const [state, list, old] = await Promise.all([stateP, listP, oldP]);
  return <BehindCard state={state} summary={list?.summary ?? null} people={old?.people ?? null} includeTest={includeTest} />;
}

async function OwnerShootIssues({ issuesP }: { issuesP: Promise<Awaited<ReturnType<typeof ownerShootIssues>> | null> }) {
  return <ShootIssuesCard issues={await issuesP} />;
}

async function OwnerKylesDay({ listP, name, includeTest }: { listP: Promise<KyleChecklist | null>; name: string; includeTest: boolean }) {
  return <KylesDay list={await listP} name={name} includeTest={includeTest} />;
}

// ---------------------------------------------------------------------------

export default async function HomePage(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  const { searchParams } = props ?? {};
  // The viewer and the query string are independent — read together.
  const [me, sp] = await Promise.all([getCurrentUser().catch(() => null), searchParams ?? Promise.resolve(undefined)]);
  // Creatives never see the ops overview (middleware already bounces the roles;
  // this covers per-user "dashboard" permission overrides). Sessionless local
  // dev renders the full owner view.
  if (me && contentTier(me.role) === "CREATIVE") redirect(homeFor(me.role));
  // A revoked account keeps a valid JWT for up to 7 days, and "/" has no PAGES
  // entry so middleware only checks that the token verifies — fail closed here
  // rather than letting a null viewer read as owner (Sep 2 review).
  if (!me && authEnforced()) redirect("/login");
  const isOwner = !me || me.role === "OWNER";
  const canReview = !me || canAccess(me, "review");
  const includeTest = sp?.test === "1";
  const scopeHref = (href: string) => homeRecordHref(blockScreen(href), includeTest);
  const excludedClientIds = includeTest ? [] : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const scope = { excludeClientIds: excludedClientIds };
  const roster: Assignee[] = await listAssignees().catch(() => []);
  const viewerKey = me ? viewerAssigneeKey(me, roster) : null;

  // WHO the flags are for: the viewer's own assignee key, resolved the way
  // openLoopsList resolves it (roster match by TeamMember → email → first
  // name, else the first-name slug). An editor's explicit editorKey still
  // wins when there is one (audit5 F11).
  const [flaggedRaw, homeRole] = await Promise.all([
    getFlaggedForMe({
      assignedKey: me ? me.editorKey ?? viewerKey ?? (me.name ? slugForName(me.name) : null) : null,
      memberId: me?.teamMemberId ?? null,
      role: me?.role ?? "OWNER",
      excludeClientIds: excludedClientIds,
    }),
    homeRoleOf(me),
  ]);
  // No money on an ADMIN screen (Jordan's standing rule): a flag's title and
  // note are typed by a person and pass through the figure scrub.
  const flagged = (isOwner ? flaggedRaw : flaggedRaw.map((f) => ({ ...f, title: scrubMoney(f.title), note: f.note ? scrubMoney(f.note) : f.note }))).map((f) => ({ ...f, href: scopeHref(f.href) }));
  const now = new Date();
  const nowMin = etMinutes(now);
  const firstName = me?.name?.split(" ")[0] ?? (isOwner ? "Jordan" : "there");
  const todayKey = etDayKey(now);
  // A New date is a day after today, at most MAX_PUSH_DAYS out (the action checks too).
  const minDay = etDayKey(etAddDays(now, 1));
  const maxDay = etDayKey(etAddDays(now, MAX_PUSH_DAYS));
  const testToggle = <Link href={includeTest ? "/" : "/?test=1"} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">{includeTest ? "Hide test records" : "Show test records"}</Link>;
  const header = (
    <PageHeader
      eyebrow="Home"
      title={`${nowMin < 12 * 60 ? "Good morning" : nowMin < 18 * 60 ? "Good afternoon" : "Good evening"}, ${firstName}`}
      subtitle={`${etFullDate(now)} · updated ${etTime(now)} ET`}
      actions={testToggle}
    />
  );
  const testNotice = includeTest && <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm"><p className="font-semibold">Showing real and test records in Home workloads</p><p className="mt-1 text-muted">Tasks, Review Room, Client months, Editing Room, Schedule and delivery lists keep this view when opened. Figures from the books keep Finance’s existing definitions.</p></div>;
  const behindP: Promise<BehindState | null> = behindState(now).catch((e: unknown) => { console.warn("behindState failed", (e as Error).message); return null; });

  // ===========================================================================
  // KYLE — operations: the red line, the summary box, the daily checklist.
  // ===========================================================================
  if (homeRole === "operations") {
    const person = { key: viewerKey ?? (me?.teamMemberId ? null : "__unresolved__"), teamMemberId: me?.teamMemberId ?? null };
    const [list, behind] = await Promise.all([
      // No figures on his screen: what people typed passes the money scrub.
      kyleChecklist({ now, excludeClientIds: excludedClientIds, person, scrub: true, roster, you: me?.name?.split(" ")[0] ?? null, withRequestJobs: true }),
      behindP,
    ]);
    return (
      <div>
        <AutoRefresh seconds={90} />
        <HomeAnchorForward />
        {header}
        <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
          {testNotice}
          <FlaggedBanner flagged={flagged} />
          <BehindLine state={behind} href="#deliveries" />
          <SummaryBox summary={list.summary} includeTest={includeTest} />
          <DailyChecklist list={list} includeTest={includeTest} minDay={minDay} maxDay={maxDay} />
        </div>
      </div>
    );
  }

  // ===========================================================================
  // JORDAN — owner.
  // ===========================================================================
  if (homeRole === "owner") {
    // Every read starts here, and each streamed section owns its failure.
    const weekP = ownerWeek(now, scope).catch((e: unknown) => { console.warn("ownerWeek failed", (e as Error).message); return null; });
    const kyle = (await kylePerson(roster).catch(() => null)) ?? { key: "kyle", teamMemberId: null, name: "Kyle" };
    // Kyle's own checklist, as he sees it (figures and all, this is the owner).
    const listP: Promise<KyleChecklist | null> = kyleChecklist({ now, excludeClientIds: excludedClientIds, person: kyle, roster })
      .catch((e: unknown) => { console.warn("kyleChecklist failed", (e as Error).message); return null; });
    const oldP = listOldItems(now, { excludeClientIds: excludedClientIds, roster }).catch(() => null);
    const issuesP = ownerShootIssues(now).catch(() => null);
    const radarP: Promise<RadarRead> = getProactiveFlags(scope).catch(() => null);
    const ownerP: Promise<OwnerReads> = Promise.all([
      getOwnerStats(scope).catch(() => null),
      getOwnerPulse(scope).catch(() => null),
      getOwnerDials(scope).catch(() => null),
      ownerPulse(scope).catch(() => null),
    ]).then(([stats, pulse, dials, money]) => ({ stats, pulse, dials, money }));
    const todos = await ownerTodoLists().catch(() => null);
    return (
      <div>
        <AutoRefresh seconds={300} />
        <HomeAnchorForward />
        {header}
        <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
          {testNotice}
          <FlaggedBanner flagged={flagged} />
          <Suspense fallback={<SectionLoading label="Counting this week…" />}>
            <OwnerWeekSection weekP={weekP} />
          </Suspense>
          <Suspense fallback={<SectionLoading label="Checking what is behind…" />}>
            <OwnerBehindSection stateP={behindP} listP={listP} oldP={oldP} includeTest={includeTest} />
          </Suspense>
          <Suspense fallback={<SectionLoading label="Reading shoot issues…" />}>
            <OwnerShootIssues issuesP={issuesP} />
          </Suspense>
          <Suspense fallback={<SectionLoading label={`Reading ${kyle.name}’s day…`} />}>
            <OwnerKylesDay listP={listP} name={kyle.name} includeTest={includeTest} />
          </Suspense>

          {/* YOUR LIST — the owner's personal to-dos (the /day page's list).
              Capture, plan, close and undo ride the /day server actions. */}
          {todos && (
            <DayBlock
              id="my-list"
              defaultOpen
              dayKey={todayKey}
              className="panel-shadow group scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28"
              summaryClassName="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm"
              summary={
                <>
                  <Inbox aria-hidden="true" className="size-4 shrink-0 text-muted-2" />
                  <span className="font-semibold">Your list</span>
                  {todos.overdue.length > 0 && <span className="rounded-full bg-danger/15 px-2 py-0.5 text-[11px] font-semibold text-danger">{todos.overdue.length} past date</span>}
                  <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{todos.open.length}</span>
                  <ChevronDown aria-hidden="true" className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
                </>
              }
            >
              <div className="space-y-3 border-t border-border px-4 py-3.5">
                <QuickAdd />
                {todos.overdue.length > 0 && (
                  <div className="rounded-xl border border-danger/40 bg-danger/[0.04]">
                    <p className="border-b border-danger/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-danger">
                      Past their date · {todos.overdue.length}
                    </p>
                    <div className="divide-y divide-border/60">
                      {todos.overdue.map((t) => <TodoRow key={t.id} t={t} todayKey={todayKey} overdue />)}
                    </div>
                  </div>
                )}
                {todos.today.length > 0 && (
                  <div className="rounded-xl border border-border">
                    <p className="border-b border-border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-muted-2">
                      Planned for today · {todos.today.length}
                    </p>
                    <div className="divide-y divide-border/60">
                      {todos.today.map((t) => <TodoRow key={t.id} t={t} todayKey={todayKey} />)}
                    </div>
                  </div>
                )}
                {todos.unscheduled.length > 0 && (
                  <details className="group/unsched rounded-xl border border-border">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[11px] font-bold uppercase tracking-widest text-muted-2">
                      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 -rotate-90 transition-transform group-open/unsched:rotate-0" />
                      Not scheduled yet · {todos.unscheduled.length}
                    </summary>
                    <div className="divide-y divide-border/60 border-t border-border">
                      {todos.unscheduled.slice(0, 20).map((t) => <TodoRow key={t.id} t={t} todayKey={todayKey} />)}
                    </div>
                    {todos.unscheduled.length > 20 && (
                      <p className="border-t border-border px-3 py-1.5 text-[11px] text-muted-2">
                        {todos.unscheduled.length - 20} more captured. Plan a few onto a day to bring them up.
                      </p>
                    )}
                  </details>
                )}
                {todos.open.length === 0 && (
                  <p className="py-2 text-center text-sm text-muted">Nothing on your list. Capture something above.</p>
                )}
                <FinishedList rows={todos.finished} />
              </div>
            </DayBlock>
          )}

          {/* MONEY — owner only, last, streamed; the 30-day trends fold under it. */}
          <Suspense fallback={<SectionLoading label="Loading the business numbers…" />}>
            <OwnerBusiness ownerP={ownerP} radarP={radarP} includeTest={includeTest} />
          </Suspense>
        </div>
      </div>
    );
  }

  // ===========================================================================
  // JAMES — the creative review seat. His desk as before. Today's shoot cards
  // and stuck jobs live on /ops; a need row that used to jump to a checklist
  // block opens the screen that holds that work (homeAnchors.blockScreen).
  // ===========================================================================
  const exceptionsP: Promise<OpsExceptionBoard> = opsExceptionsBoard({ includeTest }).catch((e: unknown): OpsExceptionBoard => {
    console.warn("opsExceptions failed", (e as Error).message);
    return { ...emptyExceptionBoard(), unavailable: true };
  });
  const leadsP = openLeadsFor({ isOwner, key: viewerKey, teamMemberId: me?.teamMemberId ?? null })
    .catch(() => [] as { id: string; title: string; createdAt: Date }[]);
  const [dRaw, counts, stuck, shoots, boardRaw, reviewQueue] = await Promise.all([
    buildOpsDay(scope),
    offPageNumbers(excludedClientIds),
    getStuckJobs(scope),
    getShootWindow(scope), // only for "next shoot" in the calm card
    deliveryBoard(scope).catch((e: unknown): DeliveryBoard => {
      console.warn("deliveryBoard failed", (e as Error).message);
      return { today: [], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0, unavailable: true };
    }),
    getReviewQueue({ includeTest }).catch(() => null),
  ]);
  const d: OpsDay = scrubOpsDayMoney(dRaw);
  const board = boardRaw;
  const assignedReviews = (reviewQueue?.pending.filter((cut) => cut.reviewer?.id === me?.teamMemberId) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const revisionChecks = reviewQueue?.followUps.filter((row) => row.awaitingReReview > 0) ?? [];
  const qcOverdueRows = listingQc(d).filter((q) => q.bucket === "overdue");
  const qcOverdue = qcOverdueRows.length;
  // OVERDUE QC COUNTED ONCE (Oct 13 2026): a job whose QC card is past due is
  // also a job past its promised date on the tracker. It is counted on the QC
  // row only; the past-due row counts the late jobs that are NOT already there.
  const qcOverdueJobs = new Set(qcOverdueRows.map((q) => q.projectId));
  const pastDueOther = board.unavailable ? 0 : board.today.filter((j) => j.overdue && !qcOverdueJobs.has(j.id)).length;
  const qcToday = listingQc(d).filter((q) => q.bucket === "today").length;
  const loops = tallyLoops(d.openLoops);

  // ---- What needs you now ---------------------------------------------------
  const needs: Need[] = [];
  const add = (n: Need) => { if (n.count > 0) needs.push(n); };
  add({
    key: "cuts", group: "decide", count: d.videoReview.waiting.length,
    label: `cut${d.videoReview.waiting.length === 1 ? "" : "s"} waiting on a review`,
    detail: d.videoReview.waiting[0] ? `oldest: ${d.videoReview.waiting[0].street} · ${ageText(d.videoReview.waiting[0].sinceISO, now)}` : undefined,
    href: "#video-review", tone: "brand",
  });
  const ready = d.readySend.ready;
  const heldRenders = d.readySend.rendering.filter((r) => r.state === "held").length;
  const processing = d.readySend.rendering.length - heldRenders;
  const toSendExtras = [
    processing > 0 ? `${processing} more still processing` : null,
    heldRenders > 0 ? `${heldRenders} 1080p on hold — Kyle has the next step` : null,
  ].filter(Boolean).join(" · ");
  add({
    key: "tosend", group: "waiting", count: ready.length,
    label: `video${ready.length === 1 ? "" : "s"} ready to send to the client`,
    detail: ready[0] ? `oldest: ${ready[0].street} · ready ${ageText(ready[0].approvedAtISO, now)}${toSendExtras ? ` · ${toSendExtras}` : ""}` : undefined,
    href: "#video-review", tone: "warning",
  });
  const needsFinishing = d.readySend.needsFinishing?.length ?? 0;
  const notTold = d.readySend.notTold?.length ?? 0;
  const incidents = d.readySend.noticeIncidents?.length ?? 0;
  add({
    key: "delivery-steps", group: "waiting", count: needsFinishing + notTold + incidents,
    label: `delivery step${needsFinishing + notTold + incidents === 1 ? "" : "s"} to finish`,
    detail: [
      needsFinishing ? `${needsFinishing} to finish sending` : null,
      notTold ? `${notTold} client${notTold === 1 ? "" : "s"} not told yet` : null,
      incidents ? `${incidents} notice${incidents === 1 ? "" : "s"} failed` : null,
    ].filter(Boolean).join(" · "),
    href: "#video-review", tone: incidents > 0 ? "danger" : "warning",
  });
  add({
    key: "clients", group: "waiting", count: d.unanswered.count,
    label: `client${d.unanswered.count === 1 ? "" : "s"} waiting on a reply`,
    detail: d.unanswered.oldestHours != null
      ? d.unanswered.oldestHours >= 24
        ? `oldest has waited ${Math.round(d.unanswered.oldestHours / 24)} day${Math.round(d.unanswered.oldestHours / 24) === 1 ? "" : "s"}`
        : `oldest has waited ${d.unanswered.oldestHours}h`
      : undefined,
    href: "#comms-1", tone: d.unanswered.oldestHours != null && d.unanswered.oldestHours >= 24 ? "danger" : "brand",
  });
  const leads = await leadsP;
  add({
    key: "leads", group: "waiting", count: leads.length,
    label: `new lead${leads.length === 1 ? "" : "s"} waiting on a call or text back`,
    detail: leads[0] ? `oldest: ${scrubMoney(leads[0].title)} · ${ageText(leads[0].createdAt.toISOString(), now)}` : undefined,
    href: "/tasks?tab=work&type=lead", tone: "warning",
  });
  add({
    key: "texts", group: "waiting", count: counts.textsToSend,
    label: `client text${counts.textsToSend === 1 ? "" : "s"} drafted and ready to send`,
    href: "/communications?tab=outbox", tone: "brand",
  });
  add({
    key: "emails", group: "waiting", count: counts.emailsWaiting,
    label: `email sender${counts.emailsWaiting === 1 ? "" : "s"} on the board with no answer`,
    href: "/tasks?tab=comms&via=email", tone: "muted",
  });
  add({
    key: "past-due", group: "risk", count: pastDueOther,
    label: `job${pastDueOther === 1 ? "" : "s"} past their promised date`,
    detail: qcOverdue > 0 ? `at the top of the tracker's Due-today tab · not counting ${qcOverdue} with QC past due (its own row)` : "at the top of the tracker's Due-today tab",
    href: "#pipeline", tone: "danger",
  });
  add({ key: "qc-overdue", group: "risk", count: qcOverdue, label: `QC card${qcOverdue === 1 ? "" : "s"} past due`, href: "#overdue", tone: "danger" });
  add({
    key: "stuck", group: "risk", count: stuck.length,
    label: `job${stuck.length === 1 ? "" : "s"} stuck in production`,
    detail: "late vs promise, a revision going stale, or shot but never delivered",
    href: "#stuck", tone: "danger",
  });
  add({
    key: "loops", group: "risk", count: loops.actNow,
    label: `follow-up${loops.actNow === 1 ? "" : "s"} owed today`,
    detail: loops.elsewhere > 0 ? `${loops.elsewhere} more sit with someone else` : undefined,
    href: "#loops", tone: "warning",
  });
  add({ key: "qc-today", group: "risk", count: qcToday, label: `QC card${qcToday === 1 ? "" : "s"} due today`, href: "#qc-am", tone: "warning" });
  add({ key: "debriefs", group: "risk", count: d.closeout.todayDebriefsMissing, label: `shot job${d.closeout.todayDebriefsMissing === 1 ? "" : "s"} with no upload page submitted`, href: "#shoots", tone: "warning" });
  add({
    key: "tomorrow", group: "risk", count: d.closeout.tomorrowGaps,
    label: `gap${d.closeout.tomorrowGaps === 1 ? "" : "s"} on tomorrow's shoots`,
    detail: "no street address, unassigned, or no access notes on file",
    href: "#prep", tone: "warning",
  });
  add({ key: "late", group: "risk", count: counts.late, label: `task${counts.late === 1 ? "" : "s"} running late on the board`, href: "/tasks?tab=work&who=all", tone: "warning" });
  add({ key: "assign", group: "risk", count: counts.toAssign, label: `to-do${counts.toAssign === 1 ? "" : "s"} with nobody's name on ${counts.toAssign === 1 ? "it" : "them"}`, href: "/tasks?tab=work&who=needs-assigning", tone: "muted" });
  // Personal review responsibility comes from the assigned cut, not an ADMIN label.
  if (reviewQueue) {
    needs.unshift({ key: "review-mine", group: "decide", count: assignedReviews.length,
      label: assignedReviews.length ? `cut${assignedReviews.length === 1 ? "" : "s"} assigned to you · open the oldest` : "cuts assigned to you for review",
      detail: assignedReviews[0] ? `${assignedReviews[0].street} · waiting ${ageText(assignedReviews[0].createdAt, now)}` : "Your assigned review queue is clear.",
      href: assignedReviews[0] ? `/review/${assignedReviews[0].projectId}?cut=${assignedReviews[0].id}` : "/review", tone: "brand" });
    const otherReviews = reviewQueue.pending.length - assignedReviews.length;
    if (otherReviews > 0) needs.push({ key: "review-coverage", group: "decide", count: otherReviews,
      label: `other cut${otherReviews === 1 ? "" : "s"} waiting on review`, detail: "Coverage: check the active owner in Review Room before taking over.", href: "/review", tone: "muted" });
    if (revisionChecks.length) needs.splice(1, 0, { key: "verify", group: "decide", count: revisionChecks.length,
      label: `job${revisionChecks.length === 1 ? "" : "s"} with fixes to verify · open the first`, detail: "Team review queue · confirm the requested changes on the exact cut.",
      href: followUpHref(revisionChecks[0]), tone: "brand" });
  }
  // James's order: the cuts assigned to him lead.
  const priority = ["review-mine", "verify", "cuts", "stuck", "loops"];
  const rank = (key: string) => priority.includes(key) ? priority.indexOf(key) : priority.length;
  const orderedNeeds = needs
    .filter((n) => !(reviewQueue && n.key === "cuts"))
    .map((n, i) => ({ n, i }))
    .sort((a, b) => rank(a.n.key) - rank(b.n.key) || TONE_RANK[a.n.tone] - TONE_RANK[b.n.tone] || a.i - b.i)
    .map(({ n }) => ({ ...n, href: scopeHref(n.href) }));
  const nextShoot = shoots.week[0] ?? null;
  const upcomingToday = d.todayShoots.find((s) => s.timeISO && Date.parse(s.endISO ?? s.timeISO) >= now.getTime()) ?? null;
  const notices = [
    !reviewQueue ? "The review queue could not be loaded. Open Review Room to retry." : null,
    deliveryUnavailable(d) ? "Delivery follow-up could not be fully checked. Open the Video Review Room to see what is known." : null,
  ].filter((x): x is string => !!x);

  return (
    <div>
      <AutoRefresh seconds={90} />
      <HomeAnchorForward />
      {header}
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        {testNotice}
        <FlaggedBanner flagged={flagged} />
        <ShootsTodayLine
          count={d.todayShoots.length}
          next={upcomingToday ? { timeISO: upcomingToday.timeISO, street: upcomingToday.title.split(",")[0], photographer: upcomingToday.photographer } : null}
          untimed={d.todayShoots.filter((s) => !s.timeISO).map((s) => s.title.split(",")[0])}
          rush={rushShoots(d.todayShoots).length}
          href={scopeHref("/ops#shoots")}
        />
        <section id="needs-you" aria-labelledby="needs-you-title" className="panel-shadow scroll-mt-32 rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <h2 id="needs-you-title" className="text-base font-semibold">What needs you now</h2>
            <p className="text-sm text-muted">Your creative review desk</p>
          </div>
          {notices.length > 0 && (
            <div className="mt-2 space-y-1">
              {notices.map((t) => <p key={t} role="status" className="text-sm font-medium text-warning">{t}</p>)}
            </div>
          )}
          {orderedNeeds.length === 0 ? (
            <div className="py-4 text-center">
              <CheckCircle2 className="mx-auto size-8 text-success" />
              <p className="mt-2 text-sm font-semibold">Nothing is waiting on you right now.</p>
              <p className="mt-1 text-xs text-muted">
                Next shoot: {nextShoot ? `${etDate(nextShoot.shootDate)} ${etTime(nextShoot.shootDate)} ET · ${nextShoot.title.split(",")[0]} · ${nextShoot.photographer?.name ?? "unassigned"}` : "none scheduled"}
              </p>
            </div>
          ) : (
            <NeedsToday needs={orderedNeeds} />
          )}
        </section>
        {/* The quiet failures — streamed (the slowest read on this page). */}
        <Suspense fallback={<SectionLoading label="Checking review, assignment and delivery exceptions…" />}>
          <HomeExceptions exceptionsP={exceptionsP} includeTest={includeTest} canReview={canReview} canEdit={!me || canAccess(me, "editing")} />
        </Suspense>
      </div>
    </div>
  );
}

// "-$1,995", never "$-1,995" — an overdrawn balance is the one figure on this
// page a person reads at a glance and must not have to parse.
const usd0 = (n: number) => {
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}$${Math.abs(r).toLocaleString("en-US")}`;
};

function MoneyStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</div>
      <div className={cn("mt-0.5 text-xl font-semibold tabular-nums", tone === "good" && "text-success", tone === "bad" && "text-danger")}>
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
