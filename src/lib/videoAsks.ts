import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WHICH APPROVED VIDEOS THE CLIENT HAS ASKED ABOUT AGAIN (Sep 28 review).
//
// The edit page's "Sent. Are you still working on this job? N more videos to
// make here." counted every approved video as owed whenever ANY video-lane
// revision was open on the job — a job-level flag. A four-video month with one
// client change on video 2 told Kim "3 more videos to make" right after he
// uploaded that one fix, on a job that owed nothing more.
//
// The per-video linkage already exists (audit WF-03, Sep 18): a revision task
// can name the one video it is about (SmartTask.outputId), and each ask filed
// under it can too (RevisionBrief.outputId, or the exact cut it answers,
// RevisionBrief.submissionId, CP-03). This reads those and answers, per slot
// key (`${deliverableId}:${slot}`, the identity every cut reader uses), when
// the newest ask naming that video was raised. An ask that names no video
// names none here: the caller never counts an approved video off a guess.
//
// READ-ONLY. Never throws — an unreadable answer is an empty map (the card
// then undercounts, and an undercount only means it doesn't ask).
// ---------------------------------------------------------------------------

export async function slotsAskedAgain(
  projectId: string,
  /** The OPEN video-lane revision tasks on the job (videoLaneRevisionWhere). */
  tasks: { id: string; outputId: string | null; createdAt: Date }[],
  /** The job's rounds, to place an ask pinned to an exact cut. */
  rounds: { id: string; deliverableId: string | null; slot: number | null }[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (tasks.length === 0) return out;
  try {
    const briefs = await prisma.revisionBrief.findMany({
      where: { projectId, taskId: { in: tasks.map((t) => t.id) } },
      select: { outputId: true, submissionId: true, createdAt: true },
    });
    const asks = [
      ...tasks.map((t) => ({ outputId: t.outputId, submissionId: null as string | null, at: t.createdAt })),
      ...briefs.map((b) => ({ outputId: b.outputId, submissionId: b.submissionId, at: b.createdAt })),
    ];
    const outIds = [...new Set(asks.map((a) => a.outputId).filter((x): x is string => !!x))];
    const outs = outIds.length
      ? await prisma.deliverableOutput.findMany({ where: { id: { in: outIds }, projectId }, select: { id: true, deliverableId: true, slot: true } })
      : [];
    const byOutput = new Map(outs.map((o) => [o.id, `${o.deliverableId}:${o.slot}`]));
    const byRound = new Map(rounds.filter((r) => r.deliverableId).map((r) => [r.id, `${r.deliverableId}:${r.slot ?? 1}`]));
    for (const a of asks) {
      const key = (a.outputId ? byOutput.get(a.outputId) : undefined) ?? (a.submissionId ? byRound.get(a.submissionId) : undefined);
      if (!key) continue;
      const had = out.get(key);
      if (!had || had < a.at) out.set(key, a.at);
    }
    return out;
  } catch (e) {
    console.error("[videoAsks] read failed", projectId, e);
    return new Map();
  }
}
