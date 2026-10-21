import "server-only";
import { prisma } from "@/lib/prisma";
import { analyzeBrief, analysisTriesOf, analysisTryError, BRIEF_ANALYSIS_MAX_TRIES, isAnalysisRefusal } from "@/lib/revisionBrief";

// ---------------------------------------------------------------------------
// THE NET UNDER THE WORK ORDER (Oct 16 2026).
//
// A client's change request is read the moment it lands (revisionBrief.
// createRevisionBrief). When that reading fails, or dies with the request that
// was running it, the brief used to stay unread for ever: 24 texts since Sep 4
// reached the editor as one unsplit paragraph, or not at all (Kim, Oct 14: "it
// didn't appear on my end and needed to go deeper in the notes"). Here, every
// 15 minutes in the AI work job (/api/cron/topics), any brief still unread ten
// minutes after it arrived is read again, up to three tries in all, each
// failure kept on the row ("Try 2 of 3 failed: …").
//
// It never makes fresh work out of history. A brief is read only when its job
// is still open, or it is under a week old AND its revision card is still
// open. An ask on a finished job whose card a person already closed is left
// as it is: reading it now would put new open items, or a creative review, on
// work somebody signed off. The Re-read button on the card still does it by
// hand.
// ---------------------------------------------------------------------------

/** How long a brief is left to its own first reading. */
export const BRIEF_SWEEP_STALE_MS = 10 * 60_000;
/** A finished job's ask is only read while it is this fresh (and its card open). */
export const BRIEF_SWEEP_RECENT_MS = 7 * 86_400_000;
/** How far back the sweep looks at all. */
const SCAN_WINDOW_MS = 60 * 86_400_000;
/** One reading is one model call (up to ~60 s with retries): started only with this long left. */
export const BRIEF_SWEEP_MIN_START_MS = 75_000;

const FINISHED_JOB = new Set(["DELIVERED", "CANCELLED"]);
const CLOSED_TASK = new Set(["COMPLETED", "CANCELLED"]);

export type BriefSweepWhy = "already read" | "office" | "too new" | "refused" | "gave up" | "finished job" | "test client";
export type BriefSweepVerdict = { read: true } | { read: false; why: BriefSweepWhy };

/** Whether the sweep reads this brief now. Pure — the rule the drill pins. */
export function briefSweepVerdict(
  b: { source: string; createdAt: Date; analyzedAt: Date | null; analysisError: string | null; jobStatus: string | null; taskStatus: string | null; testClient?: boolean },
  now: Date,
): BriefSweepVerdict {
  if (b.analyzedAt) return { read: false, why: "already read" };
  if (b.source === "office") return { read: false, why: "office" };
  if (b.testClient) return { read: false, why: "test client" };
  const age = now.getTime() - b.createdAt.getTime();
  if (age < BRIEF_SWEEP_STALE_MS) return { read: false, why: "too new" };
  if (isAnalysisRefusal(b.analysisError)) return { read: false, why: "refused" };
  if (analysisTriesOf(b.analysisError) >= BRIEF_ANALYSIS_MAX_TRIES) return { read: false, why: "gave up" };
  // A revision card a person closed is finished work, whatever the job's status
  // says (audit, Oct 19: 671 Northbrook was in REVISION with its card done, and
  // the sweep opened two creative reviews on it).
  if (b.taskStatus && CLOSED_TASK.has(b.taskStatus)) return { read: false, why: "finished job" };
  const jobOpen = !!b.jobStatus && !FINISHED_JOB.has(b.jobStatus);
  if (jobOpen || age <= BRIEF_SWEEP_RECENT_MS) return { read: true };
  return { read: false, why: "finished job" };
}

export type BriefSweepResult = {
  looked: number;
  read: number;
  failed: number;
  gaveUp: number;
  finishedJob: number;
  refused: number;
  leftForNextRun: number;
  readIds: string[];
  failedIds: string[];
};

export async function sweepUnanalyzedBriefs(opts: { now?: Date; max?: number; budgetMs?: number; minStartMs?: number; /** drills only: their seeded clients are named TEST */ includeTestClients?: boolean } = {}): Promise<BriefSweepResult> {
  const now = opts.now ?? new Date();
  const startedAt = Date.now();
  const max = opts.max ?? 3;
  const minStart = opts.minStartMs ?? BRIEF_SWEEP_MIN_START_MS;
  const out: BriefSweepResult = { looked: 0, read: 0, failed: 0, gaveUp: 0, finishedJob: 0, refused: 0, leftForNextRun: 0, readIds: [], failedIds: [] };
  const rows = await prisma.revisionBrief.findMany({
    where: {
      analyzedAt: null,
      source: { not: "office" },
      createdAt: { lte: new Date(now.getTime() - BRIEF_SWEEP_STALE_MS), gte: new Date(now.getTime() - SCAN_WINDOW_MS) },
    },
    // Newest first: the ask a client is waiting on now matters most.
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, source: true, createdAt: true, analyzedAt: true, analysisError: true, taskId: true, project: { select: { status: true, clientId: true } } },
  });
  out.looked = rows.length;
  const { isSyntheticClientRow } = await import("@/lib/testClients");
  const clientIds = [...new Set(rows.map((r) => r.project?.clientId).filter((x): x is string => !!x))];
  const testClientIds = new Set(
    (clientIds.length ? await prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : []).filter(isSyntheticClientRow).map((c) => c.id),
  );
  const taskIds = [...new Set(rows.map((r) => r.taskId).filter((x): x is string => !!x))];
  const tasks = taskIds.length ? await prisma.smartTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, status: true } }) : [];
  const taskStatus = new Map(tasks.map((t) => [t.id, t.status as string]));
  for (const r of rows) {
    const v = briefSweepVerdict({ ...r, jobStatus: r.project?.status ?? null, taskStatus: r.taskId ? taskStatus.get(r.taskId) ?? null : null, testClient: !opts.includeTestClients && !!r.project?.clientId && testClientIds.has(r.project.clientId) }, now);
    if (!v.read) {
      if (v.why === "gave up") out.gaveUp++;
      else if (v.why === "finished job") out.finishedJob++;
      else if (v.why === "refused") out.refused++;
      continue;
    }
    if (out.read + out.failed >= max || (opts.budgetMs != null && opts.budgetMs - (Date.now() - startedAt) < minStart)) {
      out.leftForNextRun++;
      continue;
    }
    const tryNo = analysisTriesOf(r.analysisError) + 1;
    // The try is counted BEFORE the call (audit, Oct 19): a reading killed
    // with its function never reaches the counting below, and was retried
    // every 15 minutes for ever.
    await prisma.revisionBrief
      .updateMany({ where: { id: r.id, analyzedAt: null }, data: { analysisError: analysisTryError(tryNo, "the reading stopped without an answer") } })
      .catch(() => {});
    // Oct 21 2026 (audit H1): the reading ends by this run's clock.
    const ok = await analyzeBrief(r.id, opts.budgetMs != null ? { deadline: startedAt + opts.budgetMs } : undefined).catch(() => false);
    if (ok) {
      out.read++;
      out.readIds.push(r.id);
      // Now that the items say which video, a song they named can be placed.
      await import("@/lib/songRequests").then((m) => m.noteSongRequestsFromBrief(r.id)).catch(() => null);
      continue;
    }
    out.failed++;
    out.failedIds.push(r.id);
    // The try is counted on the row, with the reason, unless the reading was
    // refused (that is an answer) or somebody's reading landed meanwhile.
    const fresh = await prisma.revisionBrief.findUnique({ where: { id: r.id }, select: { analyzedAt: true, analysisError: true } }).catch(() => null);
    if (fresh && !fresh.analyzedAt && !isAnalysisRefusal(fresh.analysisError)) {
      await prisma.revisionBrief
        .updateMany({ where: { id: r.id, analyzedAt: null }, data: { analysisError: analysisTryError(tryNo, fresh.analysisError ?? "the reading stopped without an answer") } })
        .catch(() => {});
      if (tryNo >= BRIEF_ANALYSIS_MAX_TRIES) console.error("[revision brief sweep] gave up after the last try; the client's words stay on the card", r.id);
    }
  }
  return out;
}
