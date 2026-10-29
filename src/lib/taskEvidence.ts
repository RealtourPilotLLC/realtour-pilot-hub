import "server-only";
import { prisma } from "@/lib/prisma";
import { TASK_DONE_INCLUDING_LEGACY } from "@/lib/programDeskTasks";
import { closingNote } from "@/lib/programTaskCloser";

// ---------------------------------------------------------------------------
// TASKS CLOSE THEMSELVES ON EVIDENCE (Jordan, Oct 27 2026: Kyle's desk carried
// work that was already done, a reply he had already sent, a floor plan that
// was already on the listing). The hub's existing closers cover the moment a
// hub action does the work; this is the hourly backstop that reads the
// record, for the rows a webhook, a scan or a second inbox missed.
//
//   task                         closes when (the evidence)
//   ---------------------------  -------------------------------------------------
//   client_reply (text, call)    a person's outbound text or call to that client
//                                after their last message (not a robot, not
//                                OpenPhone's greeting, not a holding line)
//   client_reply (email)         our outbound email on the same subject after
//                                their last email (any of our inboxes)
//   Chase CubiCasa floor plan    the floor plan is on the Aryeo listing, or every
//   (vendor-chase-…-floorplan)   floor plan the job owes is marked Done in the hub
//   Confirm <editor> has <client>'s  nothing on it is for an editor (shoot details) or
//   brand update (brand-ack:…)        an editor worked from the brief since the change
//                                     (lib/brandAckEvidence, Oct 29 2026)
//
// It never guesses:
//   · a task a person assigned by hand (assignedManually), delegated, or
//     flagged is left for that person;
//   · a client with two open reply tasks on different jobs closes only the
//     job our reply was filed on, and a reply filed on another job never
//     answers this one (a guessed filing, CommLog.projectGuess, is no filing);
//   · no inbound on record for the task = nothing to measure against = open.
// Every close writes the evidence onto the task (the program closer's
// "Closed by the hub on <day>: …" line), so the Done tab says why.
//
// Already closing on their own before this (not repeated here):
//   · confirmation_text / delivery_text: completed by the send itself
//     (clientTextSweeps; a hand-sent text by the OpenPhone receiver);
//   · Rebook: closed by the appointment sync when a scheduled date returns
//     (integrations/aryeo.ts, `rebook-<projectId>`);
//   · revision: resolveRevision when the corrected cut is delivered (comms.ts);
//   · an email reply sent from the hub closes its thread's task at once
//     (emailActions.ts), a text sent from the hub at once (closeReplyForOutbound),
//     and the Gmail scan closes a thread whose last message is ours.
// ---------------------------------------------------------------------------

const OPEN = { notIn: TASK_DONE_INCLUDING_LEGACY };
const REPLY_SOURCES: Record<string, ("text" | "call" | "email")[]> = {
  gmail: ["email"],
  openphone: ["text", "call"],
  "openphone-call": ["text", "call"],
};
const LOOKBACK_MS = 45 * 24 * 3600_000;

const etWhen = (d: Date) =>
  d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export type EvidenceVerdict = {
  taskId: string;
  title: string;
  kind: "reply" | "floorplan" | "brand";
  /** what proves it, in words (null = keep it open) */
  evidence: string | null;
  /** why it stays open, when it does */
  kept?: string;
  /** the moment the work happened (the reply's time; now for a floor plan) */
  at: Date | null;
};

type Comm = { channel: string; direction: string; clientId: string | null; projectId: string | null; projectGuess: boolean; subject: string | null; body: string; source: string; occurredAt: Date };

/** The reply verdict for open client_reply tasks (all of them, or `taskIds`). Pure read. */
export async function replyVerdicts(opts: { taskIds?: string[]; now?: Date } = {}): Promise<EvidenceVerdict[]> {
  const now = opts.now ?? new Date();
  const tasks = await prisma.smartTask.findMany({
    where: {
      taskType: "client_reply",
      status: OPEN,
      clientId: { not: null },
      source: { in: Object.keys(REPLY_SOURCES) },
      ...(opts.taskIds ? { id: { in: opts.taskIds } } : {}),
    },
    select: { id: true, title: true, clientId: true, projectId: true, source: true, createdAt: true, assignedManually: true, delegatedAt: true, flaggedAt: true },
  });
  if (tasks.length === 0) return [];
  const clientIds = [...new Set(tasks.map((t) => t.clientId as string))];
  // Every open reply task per client (not only the ones judged here), so the
  // multi-job rule sees a hand-assigned sibling too.
  const siblings = await prisma.smartTask.findMany({
    where: { taskType: "client_reply", status: OPEN, clientId: { in: clientIds } },
    select: { clientId: true, projectId: true, source: true },
  });
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const comms: Comm[] = await prisma.commLog.findMany({
    where: { clientId: { in: clientIds }, channel: { in: ["text", "call", "email"] }, occurredAt: { gte: since } },
    orderBy: { occurredAt: "asc" },
    select: { channel: true, direction: true, clientId: true, projectId: true, projectGuess: true, subject: true, body: true, source: true, occurredAt: true },
  });
  const { outboundIsAnswer, threadSubject } = await import("@/lib/replyQueue");
  const { isHoldingReply } = await import("@/lib/holdingReply");

  const out: EvidenceVerdict[] = [];
  for (const t of tasks) {
    const base = { taskId: t.id, title: t.title, kind: "reply" as const, at: null };
    if (t.assignedManually) { out.push({ ...base, evidence: null, kept: "a person assigned it" }); continue; }
    if (t.delegatedAt) { out.push({ ...base, evidence: null, kept: "it was delegated" }); continue; }
    if (t.flaggedAt) { out.push({ ...base, evidence: null, kept: "it is flagged" }); continue; }
    const family = REPLY_SOURCES[t.source ?? ""] ?? [];
    const fam = (c: Comm) => c.clientId === t.clientId && (family as string[]).includes(c.channel);
    const sameFamilySiblings = siblings.filter((s) => s.clientId === t.clientId && (REPLY_SOURCES[s.source ?? ""] ?? []).some((ch) => (family as string[]).includes(ch)));
    const multiJob = new Set(sameFamilySiblings.map((s) => s.projectId ?? "none")).size > 1;
    if (multiJob && !t.projectId) { out.push({ ...base, evidence: null, kept: "the client has open replies on more than one job and this one names none" }); continue; }
    // A row's job counts only when it was filed, not guessed (projectGuess).
    const jobOf = (c: Comm) => (c.projectGuess ? null : c.projectId);
    // Several open jobs: only rows filed on this task's job. One: any row,
    // except one filed on a DIFFERENT job (a reply about job A never answers
    // job B's question, even after A's task has closed).
    const onJob = (c: Comm) => (multiJob ? jobOf(c) === t.projectId : !(jobOf(c) && t.projectId && jobOf(c) !== t.projectId));
    const inbound = comms.filter((c) => fam(c) && c.direction === "in" && onJob(c));
    // The message that opened the task must be on record (sent at or before it).
    const asked = inbound.filter((c) => c.occurredAt.getTime() <= t.createdAt.getTime() + 2 * 60_000);
    if (asked.length === 0) { out.push({ ...base, evidence: null, kept: "no message from the client on record to measure a reply against" }); continue; }
    const lastIn = inbound[inbound.length - 1];
    const want = family.includes("email") ? threadSubject(lastIn.subject) : null;
    if (family.includes("email") && !want) { out.push({ ...base, evidence: null, kept: "their last email has no subject to match a reply to" }); continue; }
    const answer = comms.find(
      (c) =>
        fam(c) &&
        c.direction === "out" &&
        onJob(c) &&
        c.occurredAt.getTime() > lastIn.occurredAt.getTime() &&
        (want === null || threadSubject(c.subject) === want) &&
        outboundIsAnswer(c) &&
        !isHoldingReply(c.body),
    );
    if (!answer) { out.push({ ...base, evidence: null, kept: "no reply from us after their last message" }); continue; }
    const how = answer.channel === "email" ? "by email" : answer.channel === "call" ? "with a call" : "by text";
    const said = answer.channel === "call" ? "" : ` ("${answer.body.replace(/\s+/g, " ").trim().slice(0, 80)}")`;
    out.push({ ...base, evidence: `we replied ${how} on ${etWhen(answer.occurredAt)}${said}, after the client's last message (${etWhen(lastIn.occurredAt)})`, at: answer.occurredAt });
  }
  return out;
}

const FLOORPLAN_CHASE = /^vendor-chase-.+-floorplan$/;

/** The floor-plan verdict for one project: arrived (with the words why) or null. */
export async function floorPlanArrived(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { statusEvidence: true, deliverables: { where: { type: "FLOORPLAN", removedFromOrderAt: null, waivedAt: null }, select: { status: true } } },
  });
  if (!p) return null;
  const { parseEvidence } = await import("@/lib/statusEvidence");
  const ev = parseEvidence(p.statusEvidence);
  if ((ev?.aryeo?.floorPlans ?? 0) > 0 || (ev?.present ?? []).includes("Floor plan")) return "the floor plan is on the Aryeo listing";
  if (p.deliverables.length > 0 && p.deliverables.every((d) => d.status === "DONE")) return "the floor plan is marked Done in the hub";
  return null;
}

/** The floor-plan chase verdicts (all open chases, or one project's). Pure read. */
export async function floorPlanVerdicts(opts: { projectId?: string } = {}): Promise<EvidenceVerdict[]> {
  const chases = await prisma.smartTask.findMany({
    where: { status: OPEN, dedupeKey: { startsWith: "vendor-chase-", endsWith: "-floorplan" }, ...(opts.projectId ? { projectId: opts.projectId } : {}) },
    select: { id: true, title: true, projectId: true, dedupeKey: true, assignedManually: true, delegatedAt: true },
  });
  const out: EvidenceVerdict[] = [];
  const now = new Date();
  for (const t of chases) {
    const base = { taskId: t.id, title: t.title, kind: "floorplan" as const, at: null };
    if (!t.projectId || !FLOORPLAN_CHASE.test(t.dedupeKey ?? "")) continue;
    if (t.assignedManually || t.delegatedAt) { out.push({ ...base, evidence: null, kept: "a person assigned it" }); continue; }
    const why = await floorPlanArrived(t.projectId).catch(() => null);
    out.push(why ? { ...base, evidence: why, at: now } : { ...base, evidence: null, kept: "no floor plan on the listing or in the hub yet" });
  }
  return out;
}

/** Write the closes for a set of verdicts: COMPLETED, dated to the evidence,
 *  the evidence appended to the description. Fenced on the task still being
 *  open and still not hand-assigned, so a person's close or pick wins. */
export async function applyVerdicts(verdicts: EvidenceVerdict[], now = new Date()): Promise<number> {
  let closed = 0;
  for (const v of verdicts) {
    if (!v.evidence) continue;
    const t = await prisma.smartTask.findUnique({ where: { id: v.taskId }, select: { description: true } }).catch(() => null);
    const note = closingNote(v.evidence, now);
    const r = await prisma.smartTask.updateMany({
      where: { id: v.taskId, status: OPEN, assignedManually: false },
      data: { status: "COMPLETED", completedAt: v.at ?? now, description: `${t?.description ? `${t.description}\n\n` : ""}${note}`.slice(0, 20_000) },
    });
    closed += r.count;
  }
  return closed;
}

/** THE HOURLY PASS (cron/sync "taskEvidence"). `dryRun` reports and writes nothing. */
export async function sweepTaskEvidence(opts: { dryRun?: boolean; now?: Date } = {}): Promise<{ checked: number; closed: number; verdicts: EvidenceVerdict[] }> {
  const now = opts.now ?? new Date();
  // Brand-update cards (Oct 29 2026, lib/brandAckEvidence): the editor has worked from the brief since the change.
  const { brandAckVerdicts } = await import("@/lib/brandAckEvidence");
  const verdicts = [...(await replyVerdicts({ now })), ...(await floorPlanVerdicts()), ...(await brandAckVerdicts())];
  const closed = opts.dryRun ? 0 : await applyVerdicts(verdicts, now);
  return { checked: verdicts.length, closed, verdicts };
}

/** IMMEDIATE: a floor plan was just marked Done in the hub (actions.setDeliverableStatus). */
export async function closeFloorPlanChaseNow(projectId: string): Promise<number> {
  return applyVerdicts(await floorPlanVerdicts({ projectId }));
}
