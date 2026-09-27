import "server-only";
import { prisma } from "@/lib/prisma";
import { etDateTime } from "@/lib/datetime";
import { liveHandoffCategories, type HandoffCategory } from "@/lib/handoff";

// ---------------------------------------------------------------------------
// THE WHOLE WRAP-UP IS IN (O05 review, Sep 25 2026).
//
// Project.debriefSubmittedAt means "every half this job owes is handed off" —
// My Pay shows the shoot off it (payroll debriefPending) and the wrap-up KPI
// counts it. Once photos and video went in separately, only the upload page's
// scoped submit decided it, so a video EXCUSED after the photos half — the
// photographer's own "couldn't complete", the office's "Not required", Aryeo
// dropping the line — left the stamp null for good: the shoot vanished from
// the photographer's pay, the KPI scored it a late upload for a video nobody
// wanted, and /upload said "video pending" forever. Before the split the one
// submit stamped the whole, so that state could not happen.
//
// One claim, shared: the submit calls it after its own write, and every road
// that stops a half being owed (tasks.confirmNotRequiredTask, which the three
// excusal paths all pass through) calls it too, with the hourly sweep as the
// net. updateMany on `debriefSubmittedAt: null` makes the completion a claim —
// two callers at once stamp it once, and only the winner writes the line.
// ---------------------------------------------------------------------------

export type WrapUpResult = {
  /** the whole wrap-up is in (now or already) */
  wholeDone: boolean;
  /** THIS call stamped it */
  completedNow: boolean;
  photosAt: Date | null;
  videoAt: Date | null;
  /** the halves the job still owes, as read */
  halves: HandoffCategory[];
};

/**
 * Stamp the whole wrap-up when every half this job still owes is handed off.
 *
 * `fromSubmit`: the caller IS a human submit (finalizeUpload), so the stamp is
 * `at` and nothing is written to the timeline here (the submit writes its own
 * lines). Otherwise — an excusal — it needs at least one half actually handed
 * off (an excuse is never a submit: a job nobody wrapped up is not completed
 * by the office waiving its reel), the stamp is the moment the last half went
 * in (the photographer's work ended then, not when the office clicked), and
 * the timeline says why it completed. Never throws.
 */
export async function completeWrapUpIfWhole(
  projectId: string,
  opts: { at?: Date; fromSubmit?: boolean; why?: string | null } = {},
): Promise<WrapUpResult | null> {
  try {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        debriefSubmittedAt: true, photosHandoffAt: true, videoHandoffAt: true,
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, notCompletedReason: true, waivedAt: true } },
      },
    });
    if (!p) return null;
    const halves = liveHandoffCategories(p.deliverables);
    const base = { photosAt: p.photosHandoffAt, videoAt: p.videoHandoffAt, halves };
    if (p.debriefSubmittedAt) return { ...base, wholeDone: true, completedNow: false };
    const stamps = [p.photosHandoffAt, p.videoHandoffAt].filter((d): d is Date => !!d);
    if (!opts.fromSubmit && stamps.length === 0) return { ...base, wholeDone: false, completedNow: false };
    if (!halves.every((c) => (c === "photos" ? p.photosHandoffAt : p.videoHandoffAt))) {
      return { ...base, wholeDone: false, completedNow: false };
    }
    const at = opts.at ?? (stamps.length ? new Date(Math.max(...stamps.map((d) => d.getTime()))) : new Date());
    const claimed = await prisma.project.updateMany({
      where: { id: projectId, debriefSubmittedAt: null },
      data: { debriefSubmittedAt: at },
    });
    const completedNow = claimed.count === 1;
    if (completedNow && !opts.fromSubmit) {
      const inWords = [p.photosHandoffAt ? "the photos" : null, p.videoHandoffAt ? "the video" : null].filter(Boolean).join(" and ");
      const outWords = [!p.photosHandoffAt ? "the photos" : null, !p.videoHandoffAt ? "the video" : null].filter(Boolean).join(" and ");
      const why = opts.why?.trim() ? ` (${opts.why.trim()})` : "";
      await prisma.activity
        .create({
          data: {
            projectId,
            type: "SYSTEM",
            body: `Wrap-up complete: ${inWords} went in ${etDateTime(at)}${outWords ? ` and ${outWords} ${outWords.includes(" and ") || outWords === "the photos" ? "are" : "is"} no longer owed${why}` : why}, so the shoot counts as wrapped up.`.slice(0, 1000),
          },
        })
        .catch(() => {});
    }
    return { ...base, wholeDone: true, completedNow };
  } catch {
    return null;
  }
}

/**
 * THE HOURLY NET: jobs with a half handed off and the whole still open, whose
 * owed halves are all in — an excusal that reached the database some other
 * way (a hand edit, the outputs engine retiring a line) is completed within
 * the hour. Read-light: only jobs with a half stamp and no whole stamp.
 */
export async function reconcileWrapUps(opts: { max?: number } = {}): Promise<{ checked: number; completed: number }> {
  const rows = await prisma.project.findMany({
    where: { debriefSubmittedAt: null, OR: [{ photosHandoffAt: { not: null } }, { videoHandoffAt: { not: null } }] },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
    take: opts.max ?? 200,
  });
  let completed = 0;
  for (const r of rows) {
    const res = await completeWrapUpIfWhole(r.id, { why: "found by the hourly check" });
    if (res?.completedNow) completed++;
  }
  return { checked: rows.length, completed };
}
