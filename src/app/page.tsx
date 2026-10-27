import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
// Oct 27 2026 Loom (26:50): a Messages button on the main dashboards.
import { MessagesButton } from "@/components/comms/MessagesButton";
import { authEnforced } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess, contentTier, homeFor } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { etFullDate, etTime } from "@/lib/datetime";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { listAssignees, viewerAssigneeKey, type Assignee } from "@/lib/assignees";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { buildDashboard, kyleDay, kylePerson, type KyleDay } from "@/lib/opsHome";
import { behindState, type BehindState } from "@/lib/behindAlert";
import { etMinutes } from "@/components/home/DailyChecklist";
import { HomeAnchorForward } from "@/components/home/HomeAnchorForward";
import { ExceptionsCard } from "@/components/ops/ExceptionsCard";
import { emptyExceptionBoard, opsExceptionsBoard, type ExceptionKind, type OpsExceptionBoard } from "@/lib/opsExceptions";
import { BehindLine } from "@/components/home/Checklist";
import { HealthStrip, KylesDayCard, NeedsAttention, ShootsInProgress, type Doors } from "@/components/home/Dashboard";
import { TodaysShoots } from "@/components/home/TodaysShoots";
import { ContentActionsCard } from "@/components/home/ContentActionsCard";
import { monthlyContentActions, type ContentActions } from "@/lib/contentActions";
import { officeDeskFor, type OfficeDesk as OfficeDeskData } from "@/lib/officeDesk";
import { OfficeDesk } from "@/components/desk/OfficeDesk";
import { OwnerHome } from "@/components/owner/OwnerHome";
import { AddTaskButton } from "@/components/desk/DeskControls";
import { creativeDeskFor, type CreativeDesk as CreativeDeskData } from "@/lib/creativeDesk";
import { CreativeDesk } from "@/components/creativeDesk/CreativeDesk";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE DASHBOARD — "/" for the owner and every office login (Oct 19 2026,
// night). Jordan: "The home page should really be a dashboard to oversee
// everything going on, and then the other pages are for more in-depth
// adjustments and changes. The biggest things are making sure we are
// delivering on time, responding to clients quickly, keeping track of special
// requests, delegating them to the right people/departments, and ensuring QC
// and reviews are done well and catching issues. I don't want to overload the
// users of this hub with analysis paralysis."
//
// One screen for Jordan and Kyle, and since Oct 21 2026 its creative cut for
// the creative manager (James; see creativeHome below). Editors and
// photographers keep their own homes, /editing and /shoot:
//   · flagged-for-you (a person raised it for this reader), then the red line
//     when we are behind (behindAlert);
//   · the health strip: On time, Clients waiting, Special requests, QC &
//     review, each a link, each green / amber / red;
//   · left: Today's shoots (the shoot card, components/home/TodaysShoots) and
//     Shoots in progress (the Shoots board's first rows, late first);
//   · right: Needs attention now (at most five, each with an owner and one
//     action), Kyle's day ("Your list" for Kyle; his checklist is its own
//     page now, /ops/checklist), and, for the owner only, Shoot issues;
//   · owner only, below everything: this week, and the money with the
//     30-day trends folded under it.
// No money for anyone but the owner: what people typed passes the figure
// scrub, and the money sections are the owner's alone.
//
// THE RULE FOR EVERY NUMBER (audit fault #9, Sep 2 2026) still holds: a count
// is computed with THE QUERY OF THE LIST IT LINKS TO (lib/opsHome says which
// function feeds each tile).
// ---------------------------------------------------------------------------

function SectionLoading({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-12 items-center rounded-2xl border border-dashed border-border bg-surface px-4 text-sm text-muted">
      {label}
    </div>
  );
}

// MONTHLY CONTENT, WHAT NEEDS YOU (Oct 20 2026): Jordan's and the creative manager's.
async function ContentActionsSection({ contentP }: { contentP: Promise<ContentActions | null> }) {
  return <ContentActionsCard data={await contentP} />;
}

async function KylesDaySection({ dayP, includeTest, doors }: { dayP: Promise<KyleDay | null>; includeTest: boolean; doors: Doors }) {
  return <KylesDayCard day={await dayP} includeTest={includeTest} doors={doors} />;
}

// ---------------------------------------------------------------------------
// PROBLEMS THE HUB CAUGHT (Oct 19 2026): the exceptions board's quiet failures
// (a stuck or unverified 1080p pass, an approved fix never sent, a job nobody
// is assigned, a missing file, a short photo batch, a library that could not
// be rebuilt, an order line nobody defined) lost their only screen when /ops
// became a redirect. They sit here, folded, for the office. The kinds the
// dashboard already shows (cuts waiting on review, follow-ups past their date,
// promises at risk, reopened work) are left out so nothing is said twice.
// ---------------------------------------------------------------------------
const SHOWN_ELSEWHERE: ExceptionKind[] = ["aging-review", "overdue-followup", "at-risk-promise", "reopened-work"];

async function CaughtProblems({ boardP, includeTest, canReview, canEdit }: { boardP: Promise<OpsExceptionBoard>; includeTest: boolean; canReview: boolean; canEdit: boolean }) {
  const board = await boardP;
  const rows = board.rows.filter((r) => !SHOWN_ELSEWHERE.includes(r.kind));
  const totals = Object.fromEntries(Object.entries(board.totals).map(([k, v]) => [k, SHOWN_ELSEWHERE.includes(k as ExceptionKind) ? { all: 0, high: 0 } : v])) as OpsExceptionBoard["totals"];
  const count = Object.values(totals).reduce((n, t) => n + t.all, 0);
  if (!board.unavailable && count === 0) return null;
  const high = Object.values(totals).reduce((n, t) => n + t.high, 0);
  return (
    <details className="panel-shadow rounded-2xl border border-border bg-surface" open={high > 0}>
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
        Problems the hub caught
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted tabular-nums">{board.unavailable ? "?" : count}</span>
        {high > 0 && <span className="text-xs font-medium text-danger">{high} urgent</span>}
      </summary>
      <div className="border-t border-border p-2">
        <ExceptionsCard rows={rows} totals={totals} unavailable={board.unavailable} includeTest={includeTest} canReview={canReview} canEdit={canEdit} />
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// KYLE'S DESK (Oct 23 2026, Jordan's spec): the office login's whole home.
// The old cards (the health strip, Today's shoots, Needs attention, "Kyle's
// day", the problems board) leave HIS view only; the owner and the creative
// manager keep theirs. lib/officeDesk builds it; every count is the length
// of the list it opens.
// ---------------------------------------------------------------------------
async function OfficeDeskSection({ deskP, includeTest }: { deskP: Promise<OfficeDeskData | null>; includeTest: boolean }) {
  const desk = await deskP;
  if (!desk) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">Your dashboard couldn&rsquo;t load. Refresh to try again.</p>;
  }
  return <OfficeDesk desk={desk} includeTest={includeTest} />;
}

// ---------------------------------------------------------------------------
// THE CREATIVE MANAGER'S DASHBOARD (Oct 23 2026, Jordan's spec §6): James's
// whole home. lib/creativeDesk builds it (A to H in the spec's order); the
// review seat and Kyle's desk are untouched. Read-only while the owner
// previews him.
// ---------------------------------------------------------------------------
async function CreativeDeskSection({ deskP, includeTest }: { deskP: Promise<CreativeDeskData | null>; includeTest: boolean }) {
  const desk = await deskP;
  if (!desk) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">Your dashboard couldn&rsquo;t load. Refresh to try again.</p>;
  }
  return <CreativeDesk desk={desk} includeTest={includeTest} />;
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
  // JORDAN'S DASHBOARD (Oct 23 2026, his spec §4 and mockup): the owner's
  // whole home, components/owner/OwnerHome (business oversight, then his own
  // work). The owner-only cards further down (the money line and strip, this
  // week, shoot issues) are no longer reached for him; the creative manager's
  // and the review seat's homes below are unchanged. An owner previewing
  // someone ("view as") has that person's role here, so he sees their home.
  if (isOwner) {
    return (
      <OwnerHome
        me={me ? { email: me.email, name: me.name, impersonating: me.impersonating } : null}
        includeTest={sp?.test === "1"}
      />
    );
  }
  // THE CREATIVE MANAGER'S DASHBOARD (Jordan, Oct 21 2026: "he should see and
  // oversee the whole creative process, but doesn't need the same tasks as
  // Kyle"). The same pieces, creative ones only: the red line, shoots on time,
  // special requests and QC & review; today's shoots and the shoots in
  // progress; Needs attention narrowed to videos, cuts to review and their
  // own old items; the monthly content card. Not Kyle's day, not Clients
  // waiting, not the problems board (sending, Aryeo, photo delivery), never
  // money.
  const creativeHome = me?.role === "CREATIVE_MANAGER";
  const includeTest = sp?.test === "1";
  const now0 = new Date();
  // James (Oct 23 2026): his own dashboard, nothing else.
  if (creativeHome && me) {
    const nowMinC = etMinutes(now0);
    const deskP = creativeDeskFor(me, { now: now0, includeTest }).catch((e: unknown) => { console.warn("creativeDesk failed", (e as Error).message); return null; });
    return (
      <div>
        <AutoRefresh seconds={120} />
        <HomeAnchorForward />
        <PageHeader
          eyebrow="Dashboard"
          title={`${nowMinC < 12 * 60 ? "Good morning" : nowMinC < 18 * 60 ? "Good afternoon" : "Good evening"}, ${me.name?.split(" ")[0] ?? "there"}`}
          subtitle={`Your shoots, creative quality, and team development. ${etFullDate(now0)} · updated ${etTime(now0)} ET`}
          actions={<><Link href="/schedule" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-sm font-semibold hover:bg-surface-2">View my schedule</Link><MessagesButton variant="dashboard" role={me.role} /></>}
        />
        <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
          {includeTest && (
            <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
              <p className="font-semibold">Showing real and test records on the dashboard</p>
            </div>
          )}
          <Suspense fallback={<SectionLoading label="Reading your day…" />}>
            <CreativeDeskSection deskP={deskP} includeTest={includeTest} />
          </Suspense>
        </div>
      </div>
    );
  }
  // The creative manager keeps his dashboard whatever his login's role (the
  // TeamMember flag, as the monthly content card reads it).
  const creativeManager = !isOwner && !!me?.teamMemberId
    ? !!(await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { creativeManager: true } }).catch(() => null))?.creativeManager
    : false;
  // So does the creative approver's seat (the Review Room's primary reviewer):
  // creative review is never the desk's work.
  const reviewSeat = !isOwner && !creativeManager && !!me?.teamMemberId
    ? (await import("@/lib/settings").then((m) => m.reviewRoomRules()).catch(() => null))?.creativeApproverTeamMemberId === me.teamMemberId
    : false;
  // Kyle and any other office login (Oct 23 2026): the desk, and nothing else.
  if (!isOwner && !creativeHome && !creativeManager && !reviewSeat) {
    const nowMin0 = etMinutes(now0);
    const first = me?.name?.split(" ")[0] ?? "there";
    const deskP = officeDeskFor(me, { now: now0, includeTest }).catch((e: unknown) => { console.warn("officeDesk failed", (e as Error).message); return null; });
    // "+ Add task" (Jordan's mockup, Oct 23 2026): for Kyle himself, or assigned to someone through delegation.
    const deskRoster: Assignee[] = await listAssignees().catch(() => []);
    const deskMe = me ? viewerAssigneeKey(me, deskRoster) : null;
    const addPeople = [
      ...deskRoster.filter((a) => a.key === deskMe),
      ...deskRoster.filter((a) => a.key !== deskMe && a.kind !== "vendor"),
    ].map((a) => ({ key: a.key, name: a.name }));
    return (
      <div>
        <AutoRefresh seconds={90} />
        <HomeAnchorForward />
        <PageHeader
          eyebrow="Dashboard"
          title={`${nowMin0 < 12 * 60 ? "Good morning" : nowMin0 < 18 * 60 ? "Good afternoon" : "Good evening"}, ${first}`}
          subtitle={<>Keep shoots prepared, clients informed, and media delivered.<span className="block text-[12px] text-muted-2">{etFullDate(now0)} · updated {etTime(now0)} ET</span></>}
          actions={<><MessagesButton variant="dashboard" role={me?.role} /><AddTaskButton people={addPeople} me={deskMe} readOnly={!!me?.impersonating} /></>}
        />
        <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
          {includeTest && (
            <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
              <p className="font-semibold">Showing real and test records on the dashboard</p>
            </div>
          )}
          <Suspense fallback={<SectionLoading label="Reading your day…" />}>
            <OfficeDeskSection deskP={deskP} includeTest={includeTest} />
          </Suspense>
        </div>
      </div>
    );
  }
  // One read of the test clients for the whole render (its sections share it).
  const excludedClientIds = includeTest ? [] : await syntheticClientIds();
  const roster: Assignee[] = await listAssignees().catch(() => []);
  const viewerKey = me ? viewerAssigneeKey(me, roster) : null;
  const now = new Date();

  // Every read starts here; the owner's sections stream behind their own
  // Suspense and each owns its failure.
  const ops = (await kylePerson(roster).catch(() => null)) ?? { key: "kyle", teamMemberId: null, name: "Kyle" };
  const viewer = { role: me?.role ?? "OWNER", key: viewerKey, teamMemberId: me?.teamMemberId ?? null };
  const behindP: Promise<BehindState | null> = behindState(now).catch((e: unknown) => { console.warn("behindState failed", (e as Error).message); return null; });
  const dayP: Promise<KyleDay | null> | null = creativeHome ? null : kyleDay({ now, excludeClientIds: excludedClientIds, ops, viewer, roster, scrub: !isOwner })
    .catch((e: unknown) => { console.warn("kyleDay failed", (e as Error).message); return null; });
  // Jordan and the creative manager (Jordan, Oct 20 2026) see what monthly content needs from them (creativeManager, read above).
  const contentP: Promise<ContentActions | null> | null = isOwner || creativeManager || creativeHome
    ? monthlyContentActions({ now, excludeClientIds: excludedClientIds }).catch((e: unknown) => { console.warn("monthlyContentActions failed", (e as Error).message); return null; })
    : null;
  const caughtP: Promise<OpsExceptionBoard> | null = creativeHome ? null : opsExceptionsBoard({ now, includeTest }).catch((e: unknown) => {
    console.warn("exceptions board failed", (e as Error).message);
    return { ...emptyExceptionBoard(), unavailable: true };
  });
  const [dash, behind] = await Promise.all([
    buildDashboard({ now, includeTest, excludeClientIds: excludedClientIds, viewer, ops, roster, scrub: !isOwner, focus: creativeHome ? "creative" : "office" }),
    behindP,
  ]);
  const nowMin = etMinutes(now);
  const firstName = me?.name?.split(" ")[0] ?? (isOwner ? "Jordan" : "there");
  // A per-user override can close a screen to this reader: its tile and actions show without the link.
  const doors = { review: !me || canAccess(me, "review"), ops: !me || canAccess(me, "ops"), photos: !me || canAccess(me, "photos"), communications: !me || canAccess(me, "communications"), pipeline: !me || canAccess(me, "pipeline"), tasks: !me || canAccess(me, "tasks") };
  // Kyle and any other office login (Oct 22 2026): their own dashboard order.
  const officeHome = !isOwner && !creativeHome;
  // Today's shoots: the day's hard commitments in full (access, door code,
  // weather, airspace, the last thing the client said).
  const todays = (
    <Suspense fallback={<SectionLoading label="Reading today’s shoots…" />}>
      <TodaysShoots includeTest={includeTest} id="shoots" />
    </Suspense>
  );
  return (
    <div>
      <AutoRefresh seconds={90} />
      <HomeAnchorForward />
      <PageHeader
        eyebrow="Dashboard"
        title={`${nowMin < 12 * 60 ? "Good morning" : nowMin < 18 * 60 ? "Good afternoon" : "Good evening"}, ${firstName}`}
        subtitle={`${etFullDate(now)} · updated ${etTime(now)} ET`}
        // Oct 23 2026 (Jordan: "I don't need the show test records button
        // anymore"): no button. Test (synthetic) clients stay hidden
        // (syntheticClientIds); a hand-typed ?test=1 still reads them.
      />
      <div className="mx-auto max-w-6xl space-y-4 p-4 pb-16 sm:p-6">
        {includeTest && (
          <div role="status" className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
            <p className="font-semibold">Showing real and test records on the dashboard</p>
            <p className="mt-1 text-muted">Shoots, the review queue, messages and the lists it opens keep this view when opened. Figures from the books keep Finance’s existing definitions.</p>
          </div>
        )}
        {/* No flagged banner (Jordan, Oct 19 2026: "we don't need this at the
            top of the screen. Only flagged issues should show up on the shoot
            itself."): a shoot's flags show on its own page. */}
        <BehindLine state={behind} href={homeRecordHref("/jobs?f=late", includeTest)} />
        <HealthStrip health={dash.health} includeTest={includeTest} doors={doors} creative={creativeHome} office={officeHome} />

        {/* EACH READER'S ORDER (Jordan, Oct 22 2026: "The 4 menus and alerts
            are good", the dashboards with them). Same cards, each person's
            own work first:
              · Jordan: what needs him, monthly content, shoot issues; then
                today's shoots, shoots in progress and Kyle's day; money last.
              · Kyle: today's shoots; then what needs him and his list, and
                the problems board. No Shoots in progress (Today's shoots and
                the Shoots door cover it).
              · James: what needs him (cuts to review, late videos) and the
                monthly content; then today's shoots and the shoots in
                progress (raws missing shows there). */}
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            {officeHome ? todays : <NeedsAttention attention={dash.attention} includeTest={includeTest} doors={doors} />}
            {!officeHome && contentP && (
              <Suspense fallback={<SectionLoading label="Reading the monthly content…" />}>
                <ContentActionsSection contentP={contentP} />
              </Suspense>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            {officeHome && <NeedsAttention attention={dash.attention} includeTest={includeTest} doors={doors} />}
            {!officeHome && todays}
            {!officeHome && <ShootsInProgress jobs={dash.jobs} includeTest={includeTest} doors={doors} />}
            {dayP && (
              <Suspense fallback={<SectionLoading label={`Reading ${ops.name}’s day…`} />}>
                <KylesDaySection dayP={dayP} includeTest={includeTest} doors={doors} />
              </Suspense>
            )}
            {officeHome && contentP && (
              <Suspense fallback={<SectionLoading label="Reading the monthly content…" />}>
                <ContentActionsSection contentP={contentP} />
              </Suspense>
            )}
            {caughtP && (
              <Suspense fallback={null}>
                <CaughtProblems boardP={caughtP} includeTest={includeTest} canReview={doors.review} canEdit={!me || canAccess(me, "editing")} />
              </Suspense>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

