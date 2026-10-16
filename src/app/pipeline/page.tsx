import { requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { PageHeader } from "@/components/PageHeader";
import { DeliveryBoardView } from "@/components/tracker/DeliveryBoardView";
import { ProgramVideoWatch, type WatchViewRow } from "@/components/tracker/ProgramVideoWatch";
import { deliveryBoard } from "@/lib/deliveryBoard";
import { programWatchBoard } from "@/lib/programWatch";
import { MILESTONE_WORDS, metAt, staffWhen } from "@/lib/programWatchCore";
import Link from "next/link";

export const dynamic = "force-dynamic";

// PROJECT TRACKER — rebuilt as a delivery board.
//
// Jordan: "I want a screen that our content delivery / quality checking person
// AKA Kyle can come in to and see what projects we have due today, what is
// holding them up, and what is upcoming."
//
// The old page was a sortable spreadsheet of every job in the last fortnight.
// It could answer any question if you knew which column to read — which is the
// same as answering none of them at a glance. This one answers three, and the
// tabs ARE the three questions.
//
// Due dates come from the real per-product promises in src/lib/turnaround.ts,
// not one flat SLA: photos and floor plans next day, standard video in 48h,
// premium reels in 3-4 days, the monthly social packages in 7-10 BUSINESS days.

export default async function PipelinePage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  await requirePageAccess("pipeline");
  const includeTest = (await searchParams).test === "1";
  const now = new Date();
  const [board, watch, me] = await Promise.all([
    deliveryBoard({ includeTest }),
    // Oct 15 2026: program videos against their milestones (lib/programWatch).
    // A failed read hides the panel rather than the board.
    programWatchBoard({ now, includeTest }).catch((e: unknown) => { console.error("[pipeline] program watch failed", e); return null; }),
    getCurrentUser().catch(() => null),
  ]);
  const live = board.today.length + board.tomorrow.length + board.upcoming.length;
  const canEdit = !me || me.role === "OWNER" || me.role === "ADMIN";
  const watchRows: WatchViewRow[] = (watch?.rows ?? []).map((r) => ({
    outputId: r.outputId,
    projectId: r.projectId,
    enrollmentId: r.enrollmentId,
    clientName: r.clientName,
    monthWords: r.monthWords,
    title: r.title,
    level: r.level,
    why: r.why,
    promise: r.promisedAt ? staffWhen(r.promisedAt) : null,
    milestones: r.milestones.map((m) => {
      const met = metAt(m.key, r.facts);
      return {
        label: MILESTONE_WORDS[m.key].label,
        by: staffWhen(m.by),
        state: met ? (met > m.by ? "late" : "met") : m.by <= now ? "missed" : "ahead",
      };
    }),
    suggestion: r.suggestion,
    recorded: r.recorded ? { ...r.recorded, at: r.recorded.at?.toISOString() ?? null } : null,
  }));

  return (
    <div>
      <PageHeader
        title="Project Tracker"
        subtitle={`${live} in production · ${board.today.length} due today${
          board.overdueCount ? ` · ${board.overdueCount} past due` : ""
        }${includeTest ? " · test records shown" : ""}`}
        actions={<Link href={includeTest ? "/pipeline" : "/pipeline?test=1"} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">{includeTest ? "Hide test records" : "Show test records"}</Link>}
      />
      <div className="mx-auto max-w-4xl p-4 pb-16 sm:p-6">
        {watch && <ProgramVideoWatch rows={watchRows} rules={watch.rules} canEdit={canEdit} causesAvailable={watch.causesAvailable} />}
        <DeliveryBoardView board={board} />
      </div>
    </div>
  );
}
