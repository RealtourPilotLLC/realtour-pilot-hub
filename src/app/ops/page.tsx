import { Suspense } from "react";
import Link from "next/link";
import { Camera, ChevronDown, Compass } from "lucide-react";
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
import { buildOpsDay, ownerUnansweredView, scrubOpsDayMoney } from "@/lib/opsDay";
import { deliveryBoard, type DeliveryBoard } from "@/lib/deliveryBoard";
import { emptyExceptionBoard, opsExceptionsBoard, type OpsExceptionBoard } from "@/lib/opsExceptions";
import { getProactiveFlags, getShootWindow, getStuckJobs } from "@/lib/queries";
import { newClientsForDashboard } from "@/lib/newClients";
import { scrubMoney } from "@/lib/text";
import { isSyntheticClientRow } from "@/lib/testClients";
import { homeRecordHref } from "@/lib/homeRecordScope";
import {
  BLOCKS, Block, ChecklistJumps, RushChip, ShootList, blockKeyForNow, etMinutes, offPageNumbers, rushShoots,
} from "@/components/home/DailyChecklist";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops — THE DAILY CHECKLIST (Oct 19 2026).
//
// Jordan: "There's just too much on one screen. It should be organized into
// separate screens." The ten time blocks (Tower, QC, Overdue, Comms, Prep,
// Loops, Video Review, Pipeline, Monthly, Closeout) lived open on Kyle's Home;
// they live here now, with the pieces that only made sense beside them:
// today's shoot cards (#shoots), stuck jobs (#stuck), the quiet-failure
// exceptions (#exceptions), and new clients with the risk radar.
//
// Every block id is unchanged, so "/ops#loops" lands, and an old
// "/#video-review" link is forwarded here by Home (HomeAnchorForward). Until
// today this route was a redirect stub to Home; the guard below is kept from
// it: someone who holds `ops` but had Home ("dashboard") revoked is told where
// they stand instead of being shown the operating day.
// ---------------------------------------------------------------------------

/** An exception row that pointed at a block on Home now points at the block here. */
const hereAnchor = (href: string) => (href.startsWith("/#") ? href.slice(1) : href.startsWith("/?test=1#") ? href.slice("/?test=1".length) : href);

async function ChecklistExceptions({ exceptionsP, includeTest, canReview, canEdit }: {
  exceptionsP: Promise<OpsExceptionBoard>; includeTest: boolean; canReview: boolean; canEdit: boolean;
}) {
  const exceptions = await exceptionsP;
  return (
    <ExceptionsCard
      rows={exceptions.rows.map((r) => ({ ...r, href: hereAnchor(homeRecordHref(r.href, includeTest)) }))}
      totals={exceptions.totals}
      unavailable={exceptions.unavailable}
      includeTest={includeTest}
      canReview={canReview}
      canEdit={canEdit}
    />
  );
}

async function ChecklistRadar({ radarP, newClientsP, isOwner, includeTest }: {
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

export default async function DailyChecklistPage(props: { searchParams?: Promise<{ test?: string | string[] }> }) {
  await requirePageAccess("ops");
  const [me, sp] = await Promise.all([getCurrentUser().catch(() => null), props?.searchParams ?? Promise.resolve(undefined)]);

  if (me && !canAccess(me, "dashboard")) {
    return (
      <div>
        <PageHeader title="Daily checklist" subtitle="Needs Home access" />
        <div className="mx-auto max-w-2xl p-4 sm:p-6">
          <div className="panel-shadow rounded-2xl border border-border bg-surface p-6 text-center">
            <Compass className="mx-auto size-8 text-brand" />
            <p className="mt-2 text-sm font-semibold">The daily checklist goes with the Home screen.</p>
            <p className="mt-1 text-xs text-muted">
              Your account doesn&rsquo;t have Home switched on yet. Ask Jordan to grant &ldquo;Dashboard&rdquo; on the People page.
            </p>
            <Link href="/tasks" className="mt-4 inline-flex min-h-11 items-center rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
              Go to your tasks
            </Link>
          </div>
        </div>
      </div>
    );
  }

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
  const [dRaw, counts, stuck, shoots, boardRaw] = await Promise.all([
    // The operating day. It records the delivery follow-up lanes' health as it
    // reads them (readyToSend recordFollowUpHealth): that write now happens on
    // this screen, where the lanes are shown, and no longer on every Home load.
    buildOpsDay(scope),
    offPageNumbers(excludedClientIds),
    getStuckJobs(scope),
    getShootWindow(scope), // the week-ahead strip under today's shoots
    // A failed read is NOT a clean board: the Pipeline block says it could not
    // load and the "0 past due" reassurance is withheld (audit, Sep 17).
    deliveryBoard(scope).catch((e: unknown): DeliveryBoard => {
      console.warn("deliveryBoard failed", (e as Error).message);
      return { today: [], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0, unavailable: true };
    }),
  ]);
  // No money on an ADMIN screen; on the owner's, the emails Kyle has leave
  // "waiting" for a "Kyle has it" line (Oct 14 2026).
  const d = isOwner ? ownerUnansweredView(dRaw) : scrubOpsDayMoney(dRaw);
  const scrubJobs = (rows: DeliveryBoard["today"]) => rows.map((j) => (j.notes ? { ...j, notes: scrubMoney(j.notes) } : j));
  const board: DeliveryBoard = isOwner
    ? boardRaw
    : { ...boardRaw, today: scrubJobs(boardRaw.today), tomorrow: scrubJobs(boardRaw.tomorrow), upcoming: scrubJobs(boardRaw.upcoming), delivered: scrubJobs(boardRaw.delivered) };
  const now = new Date(d.nowISO);
  const currentKey = blockKeyForNow(etMinutes(now));
  const todayKey = etDayKey(now);
  const rushToday = rushShoots(d.todayShoots).length;
  const scopeHref = (href: string) => homeRecordHref(href, includeTest);

  return (
    <div>
      <AutoRefresh seconds={90} />
      <DayBlockJumps />
      <PageHeader
        eyebrow="Operations"
        title="Daily checklist"
        subtitle={`${etFullDate(now)} · updated ${etTime(now)} ET`}
        actions={<Link href={includeTest ? "/ops" : "/ops?test=1"} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">{includeTest ? "Hide test records" : "Show test records"}</Link>}
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
        <p className="text-sm text-muted">
          The day in time blocks. The block you are in opens by itself; tap any block to open it.{" "}
          <Link href={scopeHref("/")} className="font-medium text-brand hover:underline">Home</Link> has the five jobs and what is behind.
        </p>

        {/* TODAY'S SHOOTS — the day's hard commitments in full (access, door
            code, weather, airspace, the last thing the client said). */}
        <DayBlock
          id="shoots"
          defaultOpen={false}
          dayKey={todayKey}
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

        {/* The time blocks, with what is waiting in each. */}
        <section id="operating-routine" aria-label="Daily checklist blocks" className="scroll-mt-32 space-y-2.5">
          <ChecklistJumps d={d} board={board} currentKey={currentKey} />
          {BLOCKS.map((b) => (
            <Block key={b.key} def={b} current={b.key === currentKey} d={d} board={board} counts={counts} dayKey={todayKey} includeTest={includeTest} />
          ))}
        </section>

        {/* Stuck jobs: PROJECT-level fires (late vs promise, stale revision,
            shot but undelivered), not overdue admin tasks. */}
        <div id="stuck" className="scroll-mt-32 md:scroll-mt-28">
          {stuck.length > 0 ? <StuckJobs jobs={stuck} /> : <p className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-success">No jobs stuck in production.</p>}
        </div>

        {/* The quiet failures, streamed (the slowest read on this screen). */}
        <div id="exceptions" className="scroll-mt-32 md:scroll-mt-28">
          <Suspense fallback={<p role="status" className="flex min-h-12 items-center rounded-2xl border border-dashed border-border bg-surface px-4 text-sm text-muted">Checking review, assignment and delivery exceptions…</p>}>
            <ChecklistExceptions exceptionsP={exceptionsP} includeTest={includeTest} canReview={!me || canAccess(me, "review")} canEdit={!me || canAccess(me, "editing")} />
          </Suspense>
        </div>

        {/* New clients (say hello) and fresh risk (at most three). */}
        <Suspense fallback={null}>
          <ChecklistRadar radarP={radarP} newClientsP={newClientsP} isOwner={isOwner} includeTest={includeTest} />
        </Suspense>
      </div>
    </div>
  );
}
