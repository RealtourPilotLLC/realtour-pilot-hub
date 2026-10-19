import { Suspense } from "react";
import Link from "next/link";
import { Camera, ChevronDown } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canAccess } from "@/lib/auth/access";
import { prisma } from "@/lib/prisma";
import { etDayKey, etFullDate, etTime } from "@/lib/datetime";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { DayBlock, DayBlockJumps } from "@/components/ops/DayBlock";
import { ExceptionsCard } from "@/components/ops/ExceptionsCard";
import { ProactiveFlags } from "@/components/dashboard/ProactiveFlags";
import { StuckJobs } from "@/components/dashboard/StuckJobs";
import { WeekStrip } from "@/components/dashboard/WeekStrip";
import { NewClientCard } from "@/components/clients/NewClientCard";
import { buildOpsDay, scrubOpsDayMoney } from "@/lib/opsDay";
import { emptyExceptionBoard, opsExceptionsBoard, type OpsExceptionBoard } from "@/lib/opsExceptions";
import { getProactiveFlags, getShootWindow, getStuckJobs } from "@/lib/queries";
import { newClientsForDashboard } from "@/lib/newClients";
import { isSyntheticClientRow } from "@/lib/testClients";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { HomeAnchorForward } from "@/components/home/HomeAnchorForward";
import { blockScreen } from "@/lib/homeAnchors";
import { RushChip, ShootList, rushShoots } from "@/components/home/DailyChecklist";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops — TODAY'S SHOOTS, STUCK JOBS AND EXCEPTIONS (Oct 19 2026, evening).
//
// The daily checklist went back to Kyle's Home as one simplified list (Jordan:
// "The home screen should have the daily checklist … I think we should just
// keep it simplified"). The ten time blocks are gone; what only this screen
// held stays here, one door from Jordan's "What we're behind on" and the menu:
// today's shoot cards (#shoots: access, door code, weather, airspace, the last
// thing the client said, the week ahead), stuck jobs (#stuck), the quiet
// failures (#exceptions), and new clients with the risk radar.
//
// An old block link ("/ops#loops", "/ops?test=1#video-review") is sent back to
// Home by HomeAnchorForward, where the checklist group that holds that work
// carries the same anchor (lib/homeAnchors).
// ---------------------------------------------------------------------------

/** An exception row that pointed at an old block on Home opens the screen
 *  that holds that work now ("/#video-review" → the Video Review Room). */
const exceptionHref = (href: string) => (href.startsWith("/#") ? blockScreen(href.slice(1)) : href);

async function OpsExceptions({ exceptionsP, includeTest, canReview, canEdit }: {
  exceptionsP: Promise<OpsExceptionBoard>; includeTest: boolean; canReview: boolean; canEdit: boolean;
}) {
  const exceptions = await exceptionsP;
  return (
    <ExceptionsCard
      rows={exceptions.rows.map((r) => ({ ...r, href: homeRecordHref(exceptionHref(r.href), includeTest) }))}
      totals={exceptions.totals}
      unavailable={exceptions.unavailable}
      includeTest={includeTest}
      canReview={canReview}
      canEdit={canEdit}
    />
  );
}

async function OpsRadar({ radarP, newClientsP, isOwner, includeTest }: {
  radarP: Promise<Awaited<ReturnType<typeof getProactiveFlags>> | null>;
  newClientsP: Promise<Awaited<ReturnType<typeof newClientsForDashboard>>>;
  isOwner: boolean;
  includeTest: boolean;
}) {
  const [radar, newClients] = await Promise.all([radarP, newClientsP]);
  // Radar minus money: the AR kind ("X owes $Y", a /billing link) never
  // reaches a non-owner (access.ts canSeeMoney; audit5 F9).
  const flags = (radar?.flags ?? []).filter((f) => isOwner || f.kind !== "ar").map((f) => ({ ...f, href: homeRecordHref(f.href, includeTest) }));
  return (
    <>
      <NewClientCard clients={newClients} />
      {flags.length > 0 && <ProactiveFlags flags={flags} />}
    </>
  );
}

export default async function ShootsAndExceptionsPage(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  await requirePageAccess("ops");
  const [me, sp] = await Promise.all([getCurrentUser().catch(() => null), props?.searchParams ?? Promise.resolve(undefined)]);
  const isOwner = !me || me.role === "OWNER";
  const includeTest = sp?.test === "1";
  const excludedClientIds = includeTest ? [] : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const scope = { excludeClientIds: excludedClientIds };
  const exceptionsP: Promise<OpsExceptionBoard> = opsExceptionsBoard({ includeTest }).catch((e: unknown): OpsExceptionBoard => {
    console.warn("opsExceptions failed", (e as Error).message);
    return { ...emptyExceptionBoard(), unavailable: true };
  });
  const radarP = getProactiveFlags(scope).catch(() => null);
  const newClientsP = newClientsForDashboard({ includeTest }).catch(() => []);
  const [dRaw, stuck, shoots] = await Promise.all([
    // Today's shoot cards (and, as it reads them, the delivery follow-up
    // lanes' health: readyToSend recordFollowUpHealth).
    buildOpsDay(scope),
    getStuckJobs(scope),
    getShootWindow(scope), // the week-ahead strip under today's shoots
  ]);
  // No money on an ADMIN screen.
  const d = isOwner ? dRaw : scrubOpsDayMoney(dRaw);
  const now = new Date(d.nowISO);
  const rushToday = rushShoots(d.todayShoots).length;

  return (
    <div>
      <AutoRefresh seconds={90} />
      <HomeAnchorForward />
      <DayBlockJumps />
      <PageHeader
        eyebrow="Operations"
        title="Shoots and exceptions"
        subtitle={`${etFullDate(now)} · updated ${etTime(now)} ET`}
        actions={<Link href={includeTest ? "/ops" : "/ops?test=1"} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">{includeTest ? "Hide test records" : "Show test records"}</Link>}
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        <p className="text-sm text-muted">
          Today&rsquo;s shoot cards, jobs stuck in production and the quiet failures. The daily checklist is on{" "}
          <Link href={homeRecordHref("/", includeTest)} className="font-medium text-brand hover:underline">Home</Link>.
        </p>

        {/* TODAY'S SHOOTS — the day's hard commitments in full (access, door
            code, weather, airspace, the last thing the client said). */}
        <DayBlock
          id="shoots"
          defaultOpen
          dayKey={etDayKey(now)}
          className="panel-shadow group scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28"
          summaryClassName="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm"
          summary={
            <>
              <Camera aria-hidden="true" className="size-4 shrink-0 text-muted-2" />
              <span className="font-semibold">Today&rsquo;s shoots</span>
              <span className="hidden text-muted sm:inline">· access, weather and the week ahead</span>
              <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{d.todayShoots.length}</span>
              <RushChip n={rushToday} small />
              <ChevronDown aria-hidden="true" className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
            </>
          }
        >
          <div className="border-t border-border px-4 py-3.5">
            <ShootList shoots={d.todayShoots} empty="No shoots on today's calendar." showDebrief />
          </div>
          <WeekStrip week={shoots.week} includeTest={includeTest} />
        </DayBlock>

        {/* Stuck jobs: PROJECT-level fires (late vs promise, stale revision,
            shot but undelivered), not overdue admin tasks. */}
        <div id="stuck" className="scroll-mt-32 md:scroll-mt-28">
          {stuck.length > 0 ? <StuckJobs jobs={stuck} /> : <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-success">No jobs stuck in production.</p>}
        </div>

        {/* The quiet failures, streamed (the slowest read on this screen). */}
        <div id="exceptions" className="scroll-mt-32 md:scroll-mt-28">
          <Suspense fallback={<p role="status" className="flex min-h-12 items-center rounded-2xl border border-dashed border-border bg-surface px-4 text-sm text-muted">Checking review, assignment and delivery exceptions…</p>}>
            <OpsExceptions exceptionsP={exceptionsP} includeTest={includeTest} canReview={!me || canAccess(me, "review")} canEdit={!me || canAccess(me, "editing")} />
          </Suspense>
        </div>

        {/* New clients (say hello) and fresh risk (at most three). */}
        <Suspense fallback={null}>
          <OpsRadar radarP={radarP} newClientsP={newClientsP} isOwner={isOwner} includeTest={includeTest} />
        </Suspense>
      </div>
    </div>
  );
}
