import "server-only";
import { prisma } from "@/lib/prisma";
import { parseEvidence, owedNow } from "@/lib/statusEvidence";
import { pinnedPromise } from "@/lib/turnaround";
import { etDateTime } from "@/lib/datetime";
import { noDashes, scrubMoney } from "@/lib/text";

// ---------------------------------------------------------------------------
// DELIVERY WATCH BEFORE THE PROMISE (Oct 14 2026 comms audit).
//
// Photo-only on-time delivery fell from 43% in July to about 25% in Sep/Oct,
// and the slippage is AFTER upload. The only alarm (deliveryWatch.ts) fires 26
// hours after the shoot, when the ~20 hour promise is already missed, and the
// client's most urgent recurring message is "when will it be ready?".
//
// So, for every live job with a pinned promise (Project.promisedDueAt, read
// through pinnedPromise so a rebooked visit voids it):
//   · WHEN: once 3 COVERED hours or fewer are left before the promise
//     (coverage.ts). Inside cover that is "3 working hours before"; for a
//     next-morning promise the 3 covered hours fall the afternoon before, and
//     a promise set after hours with no covered time left before it is told
//     at once (the evening before). Anyone may be pinged at any hour.
//   · WHAT: one Slack DM to Kyle (kyleNotice.noticeForKyle: his bell row plus
//     the DM) with where the job stands: raws in, the AutoHDR stage when the
//     photo-delivery system has a PhotoJob for it (read only, never written),
//     edited photos on the listing, an open QC card, delivered or not.
//   · AND a client update DRAFTED (atRiskUpdates.autoDraftAtRiskUpdate) on his
//     list, naming only the recorded promise. Nothing is sent to the client.
//   · ONCE per job per promise: an AppSetting claim keyed on both, so a moved
//     promise is watched again and two sweeps at once send once.
// The same stage line rides onto a reply task when a client asks "when will
// it be ready" (attachPromiseToReplyTask, called from comms.ts).
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const WATCH_HOURS = 3;
const CLAIM_PREFIX = "promise-watch:";

// The photo-delivery system's stages in plain words (its own labels live in
// photoDelivery/jobState.ts, which this file only reads the rows of).
const PHOTO_JOB_WORDS: Record<string, string> = {
  EDITING: "AutoHDR editing",
  EDIT_FAILED: "AutoHDR edit failed",
  EDITED: "edited, QC not run yet",
  QC_RUNNING: "QC running",
  QC_REVIEW: "QC needs a decision",
  FIXING: "fixes running",
  ON_HOLD: "on hold",
  READY: "ready to deliver",
  DELIVERING: "delivering",
  DELIVERY_MISMATCH: "delivery mismatch",
  DELIVERED: "delivered",
  REVISION_REQUESTED: "revision requested",
};

export type JobStage = {
  /** "raws in (240), AutoHDR: QC needs a decision, 42 finals, 0 photos on the listing, QC card open, not delivered" */
  words: string;
  delivered: boolean;
  source: "photo-job" | "evidence";
};

/** Where each job stands, in one line. Read-only; a missing PhotoJob table or row falls back to the evidence. */
export async function describeJobStages(projectIds: string[]): Promise<Map<string, JobStage>> {
  const out = new Map<string, JobStage>();
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const [projects, qc, photoJobs] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, deliveredAt: true, statusEvidence: true } }),
    prisma.smartTask.findMany({ where: { projectId: { in: ids }, taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { projectId: true } }),
    // The sibling photo-delivery system's table. Read inside its own catch:
    // a database without it (or a read that fails) is "no PhotoJob".
    prisma.photoJob
      .findMany({ where: { projectId: { in: ids } }, select: { projectId: true, stage: true, finalsCount: true } })
      .catch(() => [] as { projectId: string; stage: string; finalsCount: number }[]),
  ]);
  const qcOpen = new Set(qc.map((t) => t.projectId));
  const pj = new Map(photoJobs.map((j) => [j.projectId, j]));
  for (const p of projects) {
    const ev = parseEvidence(p.statusEvidence);
    const job = pj.get(p.id);
    const parts: string[] = [];
    if (ev?.dropbox) {
      const n = ev.dropbox.rawPhotos;
      parts.push(n > 0 ? `raws in (${n}${ev.dropbox.stale ? ", last good read" : ""})` : ev.dropbox.stale ? "raws not readable right now" : "no raws yet");
    } else {
      parts.push("raws not checked yet");
    }
    if (job) parts.push(`${PHOTO_JOB_WORDS[job.stage] ?? job.stage.toLowerCase()}${job.finalsCount > 0 ? `, ${job.finalsCount} finals` : ""}`);
    if (ev?.aryeo) parts.push(ev.aryeo.photos > 0 ? `${ev.aryeo.photos} edited photos on the listing` : "no edited photos on the listing yet");
    if (qcOpen.has(p.id)) parts.push("QC card open");
    const owed = owedNow(ev);
    const delivered =
      p.status === "DELIVERED" || !!p.deliveredAt || job?.stage === "DELIVERED" ||
      (ev?.aryeo?.delivery === "DELIVERED" && owed.categories.length === 0);
    parts.push(delivered ? "delivered" : "not delivered");
    out.set(p.id, { words: parts.join(", "), delivered, source: job ? "photo-job" : "evidence" });
  }
  return out;
}

const isContentSession = (titles: string[]) => titles.some((t) => /video (starter|accelerator|pro)|content (session|day)/i.test(t));

export type PromiseWatchResult = {
  checked: number; alerted: number; drafted: number; closedDrafts: number; skipped?: string; jobs: string[];
  /** PROGRAM videos (Oct 15 2026, lib/programWatch): milestones, not only the last 3 hours. */
  program?: import("@/lib/programWatch").ProgramWatchResult | { error: string };
};

/**
 * Every 5 minutes (cron/gmail). The job-level watch below, then the program
 * videos (Oct 15 2026, lib/programWatch.sweepProgramWatch), which this file's
 * job query has always left out (`contentMonthId: null`): a monthly video is
 * flagged the moment it misses a milestone, and told to Kyle the same way,
 * with a drafted client update and nothing sent. The Delivery watch switch
 * turns both off; the program half has its own switch as well.
 */
export async function sweepPromiseWatch(now: Date = new Date()): Promise<PromiseWatchResult> {
  const jobs = await sweepJobPromises(now);
  if (jobs.skipped) return jobs;
  const program = await import("@/lib/programWatch")
    .then((m) => m.sweepProgramWatch(now))
    .catch((e: unknown) => ({ error: e instanceof Error ? e.message.slice(0, 200) : "program watch failed" }));
  return { ...jobs, program };
}

async function sweepJobPromises(now: Date): Promise<PromiseWatchResult> {
  const { closeDeliveredWatchDrafts } = await import("@/lib/atRiskUpdates");
  // Desk truth outside the switch: a watch draft whose job went out closes.
  const closedDrafts = (await closeDeliveredWatchDrafts().catch(() => ({ closed: 0 }))).closed;
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  if (!rules.promiseWatch.enabled) return { checked: 0, alerted: 0, drafted: 0, closedDrafts, skipped: "switched off (Settings, Internal alerts, Delivery watch)", jobs: [] };
  const { coveredHoursBetween } = await import("@/lib/coverage");
  const cover = rules.coverage;
  // Five days covers a Friday-afternoon look at a Tuesday-morning promise
  // through any weekend; covered hours decide inside it.
  const candidates = await prisma.project.findMany({
    where: {
      promisedDueAt: { gt: now, lte: new Date(now.getTime() + 5 * 24 * HOUR) },
      status: { notIn: ["DELIVERED", "CANCELLED", "ON_HOLD"] },
      deliveredAt: null,
      aryeoMissingAt: null,
      contentMonthId: null, // the program's portal videos run on their own clock
    },
    select: {
      id: true, title: true, shootDate: true, promisedDueAt: true,
      client: { select: { name: true } },
      orderItems: { where: { isCanceled: false }, select: { title: true } },
      deliverables: { where: { removedFromOrderAt: null }, select: { label: true } },
    },
    orderBy: { promisedDueAt: "asc" },
    take: 200,
  });
  const due = candidates.filter((p) => {
    if (isContentSession([...p.orderItems.map((i) => i.title), ...p.deliverables.map((d) => d.label ?? "")])) return false;
    const promise = pinnedPromise(p);
    if (!promise || promise <= now) return false;
    return coveredHoursBetween(now, promise, cover) <= WATCH_HOURS;
  });
  if (due.length === 0) return { checked: candidates.length, alerted: 0, drafted: 0, closedDrafts, jobs: [] };

  const stages = await describeJobStages(due.map((p) => p.id));
  const { noticeForKyle } = await import("@/lib/kyleNotice");
  const { autoDraftAtRiskUpdate } = await import("@/lib/atRiskUpdates");
  const { appBase } = await import("@/lib/appUrl");
  let alerted = 0, drafted = 0;
  const jobs: string[] = [];
  for (const p of due) {
    const promise = pinnedPromise(p)!;
    const stage = stages.get(p.id);
    // Already out the door (the status sweep just has not caught up): nothing to warn about.
    if (stage?.delivered) continue;
    const claimed = await prisma.appSetting
      .create({ data: { key: `${CLAIM_PREFIX}${p.id}:${promise.toISOString()}`, value: now.toISOString(), updatedBy: "promise-watch" } })
      .then(() => true)
      .catch(() => false);
    if (!claimed) continue;
    const street = (p.title ?? "").split(",")[0].trim() || "a job";
    const draft = await autoDraftAtRiskUpdate({ projectId: p.id, promisedAt: promise, stage: stage?.words ?? null, now }).catch(() => null);
    if (draft?.ok && draft.created) drafted++;
    const hoursLeft = Math.max(0, Math.round(((promise.getTime() - now.getTime()) / HOUR) * 10) / 10);
    const draftLine = draft?.ok ? ` A client update is drafted on your list, not sent: ${appBase()}/tasks?tab=other&task=${draft.taskId}` : "";
    const text = noDashes(scrubMoney(
      `Promise check: ${street} (${p.client.name}) is due ${etDateTime(promise)} ET, ${hoursLeft}h from now. Where it stands: ${stage?.words ?? "unknown"}. ${appBase()}/projects/${p.id}.${draftLine}`,
    ));
    await noticeForKyle({
      kind: "promise_watch",
      title: noDashes(`Due ${etDateTime(promise)}: ${street}`).slice(0, 90),
      body: noDashes(scrubMoney(stage?.words ?? "")).slice(0, 140),
      href: `/projects/${p.id}`,
      dedupeKey: `promise-watch-${p.id}-${promise.getTime()}`,
      slack: text,
    });
    alerted++;
    jobs.push(street);
  }
  return { checked: candidates.length, alerted, drafted, closedDrafts, jobs };
}

// ---- "when will it be ready?" -------------------------------------------------

const READY_QUESTION_RE =
  /\b(when (?:will|would|can|do|does|should|are|is)\b[^?.!]{0,60}\b(?:ready|done|back|delivered|finished|up|available|out|come|coming|get|have|see|receive|expect)|eta\b|any (?:update|news|word)s?\b|how (?:much )?longer|status (?:on|of|update)|where (?:are|is) (?:the |my |our )?(?:photos?|pictures?|pics|videos?|reels?|edits?|gallery|floor ?plans?|tour)|still waiting|by when|what time (?:will|would|can|should))/i;
// "Is it ready?", "are my videos done yet", "just checking in on the reels"
// (Oct 15 2026, the chase counter): the plain ways a client asks again.
const READY_QUESTION_RE_2 =
  /\b((?:is|are) (?:it|they|these|those|(?:the|my|our) (?:photos?|pictures?|pics|videos?|reels?|edits?|gallery|floor ?plans?|tour|content)) (?:ready|done|finished|back|up|delivered)\b|(?:just )?(?:checking|following) (?:in|up) on (?:the |my |our )?(?:photos?|pictures?|pics|videos?|reels?|edits?|gallery|floor ?plans?|tour|content|order|status|progress))/i;

/** A client asking when their work will be ready. Pure. */
export function isReadyQuestion(text: string): boolean {
  const t = (text ?? "").trim();
  return READY_QUESTION_RE.test(t) || READY_QUESTION_RE_2.test(t);
}

const PROMISE_LINE = "Promise on file:";

/**
 * The one line a staff task carries about a job's promise and where it
 * stands. A PROGRAM job (Oct 15 2026) names each of its videos' own promise
 * and stage instead, from lib/programWatch, because "no promise pinned" was
 * what a monthly client's "any update?" task said. Internal words, no money.
 */
export async function promiseLineFor(projectId: string, now: Date = new Date()): Promise<string> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, promisedDueAt: true, shootDate: true, contentMonthId: true } });
  if (!p) return `${PROMISE_LINE} unknown job.`;
  if (p.contentMonthId) {
    const lines = await import("@/lib/programWatch").then((m) => m.programPromiseLines(p.id, now)).catch(() => [] as string[]);
    if (lines.length) return noDashes(scrubMoney(`${PROMISE_LINE} ${lines.join("; ")}.`)).slice(0, 400);
  }
  const promise = pinnedPromise(p);
  const stage = (await describeJobStages([p.id])).get(p.id);
  const when = promise ? `${etDateTime(promise)} ET${promise < now ? " (already past)" : ""}` : "no promise pinned yet";
  return noDashes(scrubMoney(`${PROMISE_LINE} ${when}. Now: ${stage?.words ?? "unknown"}.`));
}

/**
 * Put the job's promise and stage on the reply task a "when will it be ready?"
 * message opened, so Kyle answers with a time instead of looking it up.
 * Internal words only (the task is staff-facing), no money, once per task
 * (a later question refreshes the same line). Never throws.
 */
export async function attachPromiseToReplyTask(input: { taskId: string; projectId: string; now?: Date }): Promise<boolean> {
  try {
    const now = input.now ?? new Date();
    const [task, p] = await Promise.all([
      prisma.smartTask.findUnique({ where: { id: input.taskId }, select: { id: true, summary: true, taskType: true, status: true } }),
      prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true, promisedDueAt: true, shootDate: true, deliveredAt: true, status: true } }),
    ]);
    if (!task || !p || task.taskType !== "client_reply" || ["COMPLETED", "CANCELLED"].includes(task.status)) return false;
    const line = await promiseLineFor(p.id, now);
    const rest = (task.summary ?? "").split("\n").filter((l) => !l.startsWith(PROMISE_LINE)).join("\n");
    await prisma.smartTask.update({ where: { id: task.id }, data: { summary: `${line}\n${rest}`.trim().slice(0, 500) } });
    return true;
  } catch (e) {
    console.warn("attachPromiseToReplyTask failed", e);
    return false;
  }
}
