import type { ReactNode } from "react";
import Link from "next/link";
import { Camera, ChevronDown } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforcedNow } from "@/lib/auth/enforced";
import { etDayKey } from "@/lib/datetime";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { scrubShoot, todayShootCards, type OpsShoot } from "@/lib/opsDay";
import { getShootWindow, syntheticClientIds, type ShootWindow } from "@/lib/queries";
import { DayBlock } from "@/components/ops/DayBlock";
import { WeekStrip } from "@/components/dashboard/WeekStrip";
import { RushChip, ShootList, rushShoots } from "@/components/home/DailyChecklist";

// ---------------------------------------------------------------------------
// TODAY'S SHOOTS, THE CARD (Oct 19 2026). Jordan, about the card that shows
// each shoot's address, client, services, creative, contact, lockbox code,
// who's there, special instructions and requests, weather, airspace and
// messages: "This should be on the home screen too."
//
//   · todayShootsBlock: the card's markup, ONE copy. /ops#shoots calls it with
//     the cards its Ops Day build already read; called as a function, so the
//     page's tree holds the DayBlock and the ShootList themselves.
//   · <TodaysShoots />: the card as a drop-in server component for any screen
//     (Home). It reads the same shoot cards /ops renders (opsDay
//     todayShootCards, the read buildOpsDay itself uses) and the same
//     week-ahead strip (queries.getShootWindow). Reads only: it never runs
//     buildOpsDay, which also records the delivery follow-up health. Open by
//     default when there are shoots today, one line "No shoots today"
//     otherwise. No figures for anyone but the owner (scrubShoot).
// ---------------------------------------------------------------------------

export function todayShootsBlock(o: {
  /** the anchor: "shoots" on /ops, "todays-shoots" elsewhere */
  id: string;
  shoots: OpsShoot[];
  week: ShootWindow["week"];
  /** ET calendar day, for the fold's remembered state */
  dayKey: string;
  includeTest: boolean;
  /** one line "No shoots today" instead of an empty card */
  oneLineWhenEmpty?: boolean;
}): ReactNode {
  if (o.oneLineWhenEmpty && o.shoots.length === 0) {
    return (
      <div id={o.id} data-todays-shoots="none" className="flex min-h-12 scroll-mt-32 items-center gap-2 rounded-2xl border border-border bg-surface px-5 py-3 text-sm md:scroll-mt-28">
        <Camera aria-hidden="true" className="size-4 shrink-0 text-muted-2" />
        <span className="text-muted">No shoots today</span>
        <Link href={homeRecordHref("/schedule", o.includeTest)} className="ml-auto inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">Schedule</Link>
      </div>
    );
  }
  return (
    <DayBlock
      id={o.id}
      defaultOpen
      dayKey={o.dayKey}
      className="panel-shadow group scroll-mt-32 rounded-2xl border border-border bg-surface md:scroll-mt-28"
      summaryClassName="flex min-h-12 cursor-pointer list-none items-center gap-2 px-5 py-3 text-sm"
      summary={
        <>
          <Camera aria-hidden="true" className="size-4 shrink-0 text-muted-2" />
          <span className="font-semibold">Today&rsquo;s shoots</span>
          <span className="hidden text-muted sm:inline">· access, weather and the week ahead</span>
          <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium tabular-nums">{o.shoots.length}</span>
          <RushChip n={rushShoots(o.shoots).length} small />
          <ChevronDown aria-hidden="true" className="size-4 shrink-0 -rotate-90 text-muted-2 transition-transform group-open:rotate-0" />
        </>
      }
    >
      <div className="border-t border-border px-4 py-3.5">
        <ShootList shoots={o.shoots} empty="No shoots on today's calendar." showDebrief />
      </div>
      <WeekStrip week={o.week} includeTest={o.includeTest} />
    </DayBlock>
  );
}

/** The Today's shoots card for any screen. Every prop is optional. */
export async function TodaysShoots({ includeTest = false, id = "todays-shoots" }: { includeTest?: boolean; id?: string } = {}) {
  const me = await getCurrentUser().catch(() => null);
  // Sessionless local dev reads as the owner, like every page; with sign-in
  // enforced, a missing viewer sees no figures.
  const isOwner = me ? me.role === "OWNER" : !authEnforcedNow();
  const read = await (async () => {
    // The dashboard's own read of the test clients, shared within the render (audit A3).
    const excludeClientIds = includeTest ? [] : await syntheticClientIds();
    return Promise.all([todayShootCards({ excludeClientIds }), getShootWindow({ excludeClientIds })]);
  })().catch((e: unknown) => {
    console.warn("TodaysShoots failed", (e as Error).message);
    return null;
  });
  if (!read) {
    return (
      <p id={id} role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">
        Today&rsquo;s shoots couldn&rsquo;t load. Refresh to try again, or <Link href={homeRecordHref("/schedule", includeTest)} className="text-brand hover:underline">open the schedule</Link>.
      </p>
    );
  }
  const [today, window] = read;
  return todayShootsBlock({
    id,
    shoots: isOwner ? today : today.map(scrubShoot),
    week: window.week,
    dayKey: etDayKey(new Date()),
    includeTest,
    oneLineWhenEmpty: true,
  });
}
