import "server-only";
import { prisma } from "@/lib/prisma";
import { endOfBusinessDaysET } from "@/lib/datetime";
import { redactMoney } from "@/lib/hubTools";
import {
  ISSUE_SOURCES, canMove, readHistory, readIds,
  type ClientIssueState, type IssueHistory,
} from "@/lib/clientIssuesCore";

// ---------------------------------------------------------------------------
// THE CLIENT COMPLAINT RECORD, SERVER HALF (Oct 15 2026). States and words in
// clientIssuesCore.ts.
//
//   createClientIssue / updateClientIssue   the record
//   moveClientIssue        OPEN → CORRECTED (opens Kyle's check-in task, due
//                          two business days later) → CONFIRMED_SATISFIED |
//                          UNRESOLVED; reopen from either end
//   openIssueFromFeedback  a NEGATIVE Feedback row opens one, once
//                          (ClientIssue.feedbackId is unique)
//   listClientIssues       for the client file and /quality
// Kyle never sees dollar amounts: every line written onto his task goes
// through redactMoney. Nothing here messages a client.
// ---------------------------------------------------------------------------

type By = string | null;
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/[ \t]+/g, " ").trim().slice(0, n);
const CHECKIN_PREFIX = "client-issue-checkin:";

function pushHistory(json: string | null | undefined, by: By, what: string, at = new Date()): string {
  const h = readHistory(json);
  h.push({ at: at.toISOString(), by, what: clip(what, 300) });
  return JSON.stringify(h.slice(-60));
}

export type NewClientIssue = {
  clientId: string;
  title: string;
  whatHappened: string;
  source?: string | null;
  sourceRef?: string | null;
  projectIds?: string[];
  impact?: string | null;
  cause?: string | null;
  ownerKey?: string | null;
  ownerName?: string | null;
  dueAt?: Date | null;
  linked?: Record<string, string[]> | null;
  feedbackId?: string | null;
  createdBy: By;
};

export async function createClientIssue(i: NewClientIssue): Promise<{ ok: boolean; message: string; id?: string }> {
  const title = clip(i.title, 200);
  const what = clip(i.whatHappened, 6000);
  if (title.length < 3 || what.length < 3) return { ok: false, message: "Give it a short title and say what happened." };
  const client = await prisma.client.findUnique({ where: { id: i.clientId }, select: { id: true } });
  if (!client) return { ok: false, message: "That client no longer exists." };
  const projectIds = (i.projectIds ?? []).filter((x) => typeof x === "string" && x).slice(0, 50);
  const source = (ISSUE_SOURCES as readonly string[]).includes(i.source ?? "") ? i.source! : "staff";
  const row = await prisma.clientIssue.create({
    data: {
      clientId: client.id, title, whatHappened: what, source, sourceRef: clip(i.sourceRef, 300) || null,
      projectIdsJson: projectIds.length ? JSON.stringify(projectIds) : null,
      impact: clip(i.impact, 2000) || null, cause: clip(i.cause, 60) || null,
      ownerKey: clip(i.ownerKey, 40) || null, ownerName: clip(i.ownerName, 120) || null, dueAt: i.dueAt ?? null,
      linkedJson: i.linked ? JSON.stringify(i.linked) : null, feedbackId: i.feedbackId ?? null,
      historyJson: pushHistory(null, i.createdBy, `Opened (${source})`), createdBy: i.createdBy,
    },
    select: { id: true },
  });
  return { ok: true, message: "Complaint recorded.", id: row.id };
}

export type IssuePatch = Partial<{ title: string; whatHappened: string; impact: string | null; cause: string | null; correction: string | null; processChange: string | null; ownerKey: string | null; ownerName: string | null; dueAt: Date | null; projectIds: string[]; linked: Record<string, string[]> | null }>;

export async function updateClientIssue(id: string, patch: IssuePatch, by: By): Promise<{ ok: boolean; message: string }> {
  const cur = await prisma.clientIssue.findUnique({ where: { id }, select: { historyJson: true, dismissedAt: true } });
  if (!cur) return { ok: false, message: "That complaint no longer exists." };
  const data: Record<string, unknown> = {};
  const changed: string[] = [];
  const text = (k: keyof IssuePatch, n: number, label: string) => {
    if (patch[k] === undefined) return;
    data[k] = clip(patch[k] as string | null, n) || null;
    changed.push(label);
  };
  if (patch.title !== undefined) { const t = clip(patch.title, 200); if (t.length < 3) return { ok: false, message: "The title is too short." }; data.title = t; changed.push("title"); }
  if (patch.whatHappened !== undefined) { const t = clip(patch.whatHappened, 6000); if (t.length < 3) return { ok: false, message: "Say what happened." }; data.whatHappened = t; changed.push("what happened"); }
  text("impact", 2000, "impact");
  text("cause", 60, "cause");
  text("correction", 4000, "correction");
  text("processChange", 2000, "process change");
  text("ownerKey", 40, "owner");
  if (patch.ownerName !== undefined) data.ownerName = clip(patch.ownerName, 120) || null;
  if (patch.dueAt !== undefined) { data.dueAt = patch.dueAt; changed.push("due date"); }
  if (patch.projectIds !== undefined) { data.projectIdsJson = patch.projectIds.length ? JSON.stringify(patch.projectIds.slice(0, 50)) : null; changed.push("jobs"); }
  if (patch.linked !== undefined) { data.linkedJson = patch.linked ? JSON.stringify(patch.linked) : null; changed.push("links"); }
  if (!changed.length) return { ok: true, message: "No change." };
  data.historyJson = pushHistory(cur.historyJson, by, `Edited: ${changed.join(", ")}`);
  await prisma.clientIssue.update({ where: { id }, data });
  return { ok: true, message: "Saved." };
}

/**
 * Move a complaint along. CORRECTED needs the correction in words and opens
 * Kyle's check-in task; CONFIRMED_SATISFIED / UNRESOLVED close it.
 */
export async function moveClientIssue(id: string, to: ClientIssueState, input: { by: By; correction?: string | null; processChange?: string | null; note?: string | null; now?: Date }): Promise<{ ok: boolean; message: string }> {
  const now = input.now ?? new Date();
  const cur = await prisma.clientIssue.findUnique({ where: { id } });
  if (!cur) return { ok: false, message: "That complaint no longer exists." };
  if (cur.dismissedAt) return { ok: false, message: "That one was dismissed." };
  if (!canMove(cur.state, to)) return { ok: false, message: "That step doesn't follow from where it is." };
  const data: Record<string, unknown> = { state: to };
  const note = clip(input.note, 1000) || null;
  if (to === "CORRECTED") {
    // A plan's open steps come first (Oct 29 2026, lib/clientIssuePlan).
    const { openStepsBlocker } = await import("@/lib/clientIssuePlan");
    const blocker = await openStepsBlocker(id);
    if (blocker) return { ok: false, message: blocker };
    const correction = clip(input.correction ?? cur.correction, 4000);
    if (correction.length < 3) return { ok: false, message: "Say what was done to correct it." };
    data.correction = correction;
    if (input.processChange !== undefined) data.processChange = clip(input.processChange, 2000) || null;
    data.correctedAt = now;
    data.correctedBy = input.by;
    const taskId = await openCheckInTask({ ...cur, correction }, now);
    data.checkInTaskId = taskId;
  }
  if (to === "CONFIRMED_SATISFIED" || to === "UNRESOLVED") {
    if (to === "UNRESOLVED" && !note) return { ok: false, message: "Say what is still wrong for them." };
    data.confirmedAt = now;
    data.confirmedBy = input.by;
    data.confirmationNote = note;
    if (cur.checkInTaskId) await prisma.smartTask.updateMany({ where: { id: cur.checkInTaskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: now } });
  }
  if (to === "OPEN") {
    data.confirmedAt = null; data.confirmedBy = null; data.confirmationNote = note;
  }
  const words = to === "CORRECTED" ? "Corrected; Kyle checks in with the client in two business days" : to === "CONFIRMED_SATISFIED" ? "Client confirmed they are satisfied" : to === "UNRESOLVED" ? "Client is not satisfied" : "Reopened";
  data.historyJson = pushHistory(cur.historyJson, input.by, `${words}${note ? `: ${note}` : ""}`, now);
  await prisma.clientIssue.update({ where: { id }, data });
  return { ok: true, message: `${words}.` };
}

/** Kyle's check-in, two business days after the correction. A task only. */
async function openCheckInTask(issue: { id: string; clientId: string; title: string; whatHappened: string; correction: string | null; projectIdsJson: string | null }, now: Date): Promise<string | null> {
  try {
    const client = await prisma.client.findUnique({ where: { id: issue.clientId }, select: { name: true } });
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } }).catch(() => null);
    const projectId = readIds(issue.projectIdsJson)[0] ?? null;
    const dedupeKey = `${CHECKIN_PREFIX}${issue.id}`;
    const dueAt = endOfBusinessDaysET(now, 2, 10);
    const data = {
      taskType: "client_checkin",
      title: `Check in with ${client?.name ?? "the client"}: is it right now?`.slice(0, 200),
      summary: redactMoney(clip(`We corrected: ${issue.correction ?? ""}`, 300)),
      description: redactMoney([
        `What they raised: ${clip(issue.title, 200)}`,
        clip(issue.whatHappened, 1200),
        "",
        `What we did: ${clip(issue.correction, 1200)}`,
        "",
        "Ask the client whether it is right now, in your own words. Then record the answer on their client page (Client satisfied, or Not resolved). This task never sends anything by itself.",
      ].join("\n")),
      reasonCreated: "A complaint was corrected; confirm with the client",
      source: "client_issue",
      priority: "HIGH",
      status: "OPEN",
      assignedKey: "kyle",
      ownerId: kyle?.id ?? null,
      clientId: issue.clientId,
      projectId: projectId && (await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } }))?.id ? projectId : null,
      dueAt,
      completedAt: null,
    };
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
    if (existing) {
      await prisma.smartTask.update({ where: { id: existing.id }, data });
      return existing.id;
    }
    return (await prisma.smartTask.create({ data: { ...data, dedupeKey }, select: { id: true } })).id;
  } catch (e) {
    console.error("[client issues] check-in task failed", issue.id, e);
    return null;
  }
}

export async function dismissClientIssue(id: string, reason: string, by: By): Promise<{ ok: boolean; message: string }> {
  const why = clip(reason, 400);
  if (why.length < 3) return { ok: false, message: "Say why it isn't a complaint." };
  const cur = await prisma.clientIssue.findUnique({ where: { id }, select: { historyJson: true, checkInTaskId: true } });
  if (!cur) return { ok: false, message: "That complaint no longer exists." };
  await prisma.clientIssue.update({ where: { id }, data: { dismissedAt: new Date(), dismissedBy: by, dismissReason: why, historyJson: pushHistory(cur.historyJson, by, `Dismissed: ${why}`) } });
  if (cur.checkInTaskId) await prisma.smartTask.updateMany({ where: { id: cur.checkInTaskId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "CANCELLED", completedAt: new Date() } });
  return { ok: true, message: "Dismissed. It stays on the record." };
}

/**
 * A NEGATIVE Feedback row opens a complaint, once. Never throws; returns the
 * complaint id (new or existing) or null.
 */
export async function openIssueFromFeedback(feedbackId: string): Promise<string | null> {
  try {
    const existing = await prisma.clientIssue.findUnique({ where: { feedbackId }, select: { id: true } });
    if (existing) return existing.id;
    const fb = await prisma.feedback.findUnique({ where: { id: feedbackId }, select: { id: true, sentiment: true, body: true, rating: true, source: true, sourceRef: true, authorName: true, dismissedAt: true, project: { select: { id: true, title: true, clientId: true } } } });
    if (!fb || fb.sentiment !== "NEGATIVE" || fb.dismissedAt || !fb.project) return null;
    const r = await createClientIssue({
      clientId: fb.project.clientId,
      title: `Unhappy about ${fb.project.title.split(",")[0].trim()}`,
      whatHappened: `${fb.authorName ? `${fb.authorName}: ` : ""}${fb.body}${fb.rating ? ` (${fb.rating}/5)` : ""}`,
      source: "feedback",
      sourceRef: fb.sourceRef ? `CommLog:${fb.sourceRef}` : `Feedback:${fb.id}`,
      projectIds: [fb.project.id],
      linked: { feedbackIds: [fb.id] },
      feedbackId: fb.id,
      createdBy: "hub",
    });
    return r.id ?? null;
  } catch (e) {
    // A racing second call hits the unique feedbackId: read the winner.
    const again = await prisma.clientIssue.findUnique({ where: { feedbackId }, select: { id: true } }).catch(() => null);
    if (!again) console.error("[client issues] from feedback failed", feedbackId, e);
    return again?.id ?? null;
  }
}

export type ClientIssueView = {
  id: string; clientId: string; clientName: string | null; title: string; whatHappened: string; summary: string | null; impact: string | null; cause: string | null;
  correction: string | null; processChange: string | null; ownerName: string | null; ownerKey: string | null; dueAtISO: string | null;
  state: ClientIssueState; source: string; projectIds: string[]; createdAtISO: string; correctedAtISO: string | null;
  confirmedAtISO: string | null; confirmationNote: string | null; checkInTaskId: string | null; history: IssueHistory[];
};

/** Complaints, newest first. `scrubMoney` for anyone but the owner. */
export async function listClientIssues(opts: { clientId?: string; states?: ClientIssueState[]; scrubMoney: boolean; take?: number }): Promise<ClientIssueView[]> {
  const rows = await prisma.clientIssue.findMany({
    where: { dismissedAt: null, ...(opts.clientId ? { clientId: opts.clientId } : {}), ...(opts.states ? { state: { in: opts.states } } : {}) },
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 50,
  });
  const names = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const s = (t: string | null) => (t == null ? null : opts.scrubMoney ? redactMoney(t) : t);
  return rows.map((r) => ({
    id: r.id, clientId: r.clientId, clientName: names.get(r.clientId) ?? null, title: s(r.title) ?? "", whatHappened: s(r.whatHappened) ?? "", summary: s(r.summary),
    impact: s(r.impact), cause: r.cause, correction: s(r.correction), processChange: s(r.processChange), ownerName: r.ownerName, ownerKey: r.ownerKey,
    dueAtISO: r.dueAt?.toISOString() ?? null, state: r.state as ClientIssueState, source: r.source, projectIds: readIds(r.projectIdsJson),
    createdAtISO: r.createdAt.toISOString(), correctedAtISO: r.correctedAt?.toISOString() ?? null, confirmedAtISO: r.confirmedAt?.toISOString() ?? null,
    confirmationNote: s(r.confirmationNote), checkInTaskId: r.checkInTaskId,
    history: readHistory(r.historyJson).map((h) => ({ ...h, what: s(h.what) ?? "" })),
  }));
}
