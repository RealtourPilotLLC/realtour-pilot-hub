import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listAssignees, firstName, type Assignee } from "@/lib/assignees";
import { endOfBusinessDaysET, etDateTime, etDayKey, etEndOfDay } from "@/lib/datetime";
import { scrubMoney } from "@/lib/text";
import { appBase } from "@/lib/appUrl";
import type { CurrentUser } from "@/lib/auth/user";

// ---------------------------------------------------------------------------
// DELEGATION (Oct 23 2026, Jordan's dashboards spec §5). One canonical task,
// shared by every dashboard: Jordan's "Delegated by me", James's "Assigned to
// me" and Kyle's desk all read THE SAME SmartTask row, so an update made on
// one screen is the state every other screen shows.
//
// IT IS THE EXISTING SmartTask, NOT A NEW TASK SYSTEM.
//   · Assigning from a record that already has a task (an email thread's reply
//     task, a meeting's prep task, a client issue's check-in) puts the
//     delegation ON that task: sourceTaskId.
//   · A record with no task gets one, keyed to the record (dedupeKey
//     "deleg:<sourceHref>"), so assigning the same record twice re-uses it
//     (a second person is a reassignment, with the history kept).
//   · A free-form "Assign task" keys on (assigner, assignee, title, ET day),
//     so a double press makes one task, not two.
//
// WHERE THE STATE LIVES (four nullable SmartTask columns, schema comment):
//   delegatedBy  the assigner's login email (who keeps oversight)
//   delegatedAt  when it was first assigned
//   acceptedAt   when the CURRENT assignee accepted (reassignment clears it)
//   delegation   JSON: the expected outcome, needsVerification, the source
//                record, when acceptance is expected, the next step, the
//                latest update, the completion evidence, and every event
// plus the task's own status (OPEN · IN_PROGRESS · BLOCKED with blockedReason
// · WAITING_VERIFICATION · COMPLETED · CANCELLED), assignedKey and dueAt.
//
// THE LIFECYCLE: Assigned → In progress → (Blocked) → Ready for verification
// → Completed. Verification only when the task asks for it. An update is not
// completion; a submission is not verification. Every change is an event
// with who and when.
//
// NO ACCEPTANCE STEP (Jordan, Oct 30 2026: "I don't want anything to wait for
// acceptance if I assign it to them it's assigned to them"). Assigning stamps
// acceptedAt; a task assigned before that reads as assigned too (stateOf).
//
// RESURFACING: a task past its due time, or blocked past its follow-up, comes
// back to the ASSIGNER (the dashboard flags it at read time;
// resurfaceDelegations() rings their bell once a day).
// ---------------------------------------------------------------------------

export type DelegationState = "ASSIGNED" | "ACCEPTED" | "IN_PROGRESS" | "BLOCKED" | "READY_FOR_VERIFICATION" | "COMPLETED" | "CANCELLED";

export type DelegatedTask = {
  taskId: string;
  title: string;
  outcome: string | null;
  assigneeKey: string | null;
  assigneeName: string | null;
  assignedBy: string | null;
  assignedAt: string | null;
  dueAt: string | null;
  state: DelegationState;
  needsVerification: boolean;
  latestUpdate: string | null;
  blocker: string | null;
  nextStep: string | null;
  clientId: string | null;
  projectId: string | null;
  sourceHref: string | null;
};

/** The words for each state (one place, every screen). */
export const STATE_WORDS: Record<DelegationState, string> = {
  ASSIGNED: "Assigned",
  ACCEPTED: "Assigned",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  READY_FOR_VERIFICATION: "Ready for verification",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

/** The SmartTask status a submitted task waits in (WAITING_* is the schema's family). */
export const VERIFY_STATUS = "WAITING_VERIFICATION";
const CLOSED = ["COMPLETED", "CANCELLED"];
/** A new assignee is expected to accept by the end of the next business day
 *  (5 PM ET), or by the due time when that is sooner. Jordan's call to change. */
export const ACCEPT_WITHIN_BUSINESS_DAYS = 1;
/** A blocker comes back to the assigner the next business day. */
export const BLOCKER_FOLLOW_UP_BUSINESS_DAYS = 1;
/** Delegated-by-me keeps closed work this long, so completion evidence is visible. */
export const CLOSED_VISIBLE_DAYS = 7;
/** "Request update" at most this often per task. */
export const UPDATE_REQUEST_GAP_MS = 60 * 60_000;
/** Vendors and role placeholders cannot accept anything. */
const NOT_A_PERSON = new Set(["autohdr", "cubicasa", "luma", "creative_director"]);

export type EventKind =
  | "assigned" | "accepted" | "started" | "update" | "blocked" | "unblocked" | "submitted" | "returned"
  | "completed" | "escalated" | "recommended" | "reassigned" | "cancelled" | "reopened" | "update_requested";

export type DelegationEvent = { at: string; by: string; kind: EventKind; text?: string | null; from?: string | null; to?: string | null };

export type DelegationRecord = {
  v: 1;
  /** the assigner's display name ("Jordan") */
  byName: string;
  outcome: string | null;
  needsVerification: boolean;
  sourceHref: string | null;
  /** ISO: when acceptance is expected (reset on reassignment) */
  acceptBy: string | null;
  /** ISO: when the assigner should hear back (a blocker's follow-up) */
  followUpAt: string | null;
  nextStep: string | null;
  latestUpdate: { at: string; by: string; text: string } | null;
  evidence: string | null;
  /** open escalation to the owner, cleared when the owner acts */
  escalated: { at: string; by: string; why: string } | null;
  /** a creative manager's recommendation the owner decides */
  recommended: { at: string; by: string; assigneeKey: string; assigneeName: string; why: string | null } | null;
  updateRequestedAt: string | null;
  events: DelegationEvent[];
};

// ---- pure ----------------------------------------------------------------------------

export function parseDelegation(raw: string | null | undefined): DelegationRecord | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<DelegationRecord>;
    if (!j || typeof j !== "object") return null;
    return {
      v: 1,
      byName: typeof j.byName === "string" ? j.byName : "Someone",
      outcome: typeof j.outcome === "string" ? j.outcome : null,
      needsVerification: j.needsVerification === true,
      sourceHref: typeof j.sourceHref === "string" ? j.sourceHref : null,
      acceptBy: typeof j.acceptBy === "string" ? j.acceptBy : null,
      followUpAt: typeof j.followUpAt === "string" ? j.followUpAt : null,
      nextStep: typeof j.nextStep === "string" ? j.nextStep : null,
      latestUpdate: j.latestUpdate && typeof j.latestUpdate.text === "string" ? j.latestUpdate : null,
      evidence: typeof j.evidence === "string" ? j.evidence : null,
      escalated: j.escalated && typeof j.escalated.why === "string" ? j.escalated : null,
      recommended: j.recommended && typeof j.recommended.assigneeKey === "string" ? j.recommended : null,
      updateRequestedAt: typeof j.updateRequestedAt === "string" ? j.updateRequestedAt : null,
      events: Array.isArray(j.events) ? j.events.filter((e) => e && typeof e.at === "string" && typeof e.kind === "string") : [],
    };
  } catch {
    return null;
  }
}

/** The state, from the task's own status and acceptance. */
export function stateOf(t: { status: string; acceptedAt: Date | string | null }): DelegationState {
  if (t.status === "COMPLETED") return "COMPLETED";
  if (t.status === "CANCELLED") return "CANCELLED";
  if (t.status === VERIFY_STATUS) return "READY_FOR_VERIFICATION";
  if (t.status === "BLOCKED") return "BLOCKED";
  if (t.status === "IN_PROGRESS") return "IN_PROGRESS";
  // Assigned is the assignee's (no acceptance step, Oct 30 2026), stamped or not.
  return "ACCEPTED";
}

export const isOpenState = (s: DelegationState) => s !== "COMPLETED" && s !== "CANCELLED";

/** When a new assignee is expected to accept: the end of the next business day, or the due time if sooner. */
export function acceptDeadline(now: Date, dueAt: Date | null): Date {
  const eod = endOfBusinessDaysET(now, ACCEPT_WITHIN_BUSINESS_DAYS);
  return dueAt && dueAt.getTime() < eod.getTime() && dueAt.getTime() > now.getTime() ? dueAt : eod;
}

/** What should happen next, in words, when nobody typed a next step. */
function defaultNextStep(state: DelegationState, assignee: string, rec: DelegationRecord): string | null {
  switch (state) {
    case "ASSIGNED":
    case "ACCEPTED": return `${assignee} to do it`;
    case "IN_PROGRESS": return rec.needsVerification ? `${assignee} to finish and submit for verification` : `${assignee} to finish`;
    case "BLOCKED": return `${rec.byName} to clear the blocker or decide`;
    case "READY_FOR_VERIFICATION": return `${rec.byName} to verify`;
    default: return null;
  }
}

/** Why a delegated task is back on the assigner's plate now (null = it is not). */
export type Resurface = { kind: "not_accepted" | "overdue" | "blocked" | "escalated" | "verify" | "recommended"; words: string };
export function resurfaceOf(d: DelegatedTask & { acceptByISO?: string | null; followUpISO?: string | null; escalatedWhy?: string | null; recommendedTo?: string | null }, now: Date): Resurface | null {
  if (!isOpenState(d.state)) return null;
  const nowMs = now.getTime();
  if (d.recommendedTo) return { kind: "recommended", words: `Recommended for ${d.recommendedTo}: your decision` };
  if (d.escalatedWhy) return { kind: "escalated", words: `Escalated: ${d.escalatedWhy}` };
  if (d.state === "READY_FOR_VERIFICATION") return { kind: "verify", words: "Submitted: ready for you to verify" };
  if (d.dueAt && Date.parse(d.dueAt) < nowMs) return { kind: "overdue", words: `Overdue since ${etDateTime(d.dueAt)}` };
  if (d.state === "ASSIGNED" && d.acceptByISO && Date.parse(d.acceptByISO) < nowMs) return { kind: "not_accepted", words: `Not accepted yet (expected by ${etDateTime(d.acceptByISO)})` };
  if (d.state === "BLOCKED" && d.followUpISO && Date.parse(d.followUpISO) < nowMs) return { kind: "blocked", words: `Still blocked: ${d.blocker ?? "no reason given"}` };
  return null;
}

// ---- reads ---------------------------------------------------------------------------

const TASK_SELECT = {
  id: true, title: true, status: true, assignedKey: true, dueAt: true, clientId: true, projectId: true, blockedReason: true,
  delegatedBy: true, delegatedAt: true, acceptedAt: true, delegation: true, completedAt: true, updatedAt: true,
  summary: true, description: true,
} satisfies Prisma.SmartTaskSelect;
type TaskRow = Prisma.SmartTaskGetPayload<{ select: typeof TASK_SELECT }>;

/** A delegated task with the assigner-side extras the dashboards flag on. */
export type DelegatedTaskView = DelegatedTask & {
  assignedByEmail: string | null;
  acceptByISO: string | null;
  followUpISO: string | null;
  escalatedWhy: string | null;
  recommendedTo: string | null;
  evidence: string | null;
  closedAtISO: string | null;
  events: DelegationEvent[];
  /** The task's own notes (what the engine or the assigner wrote on it), when
   *  they say more than the title and the outcome (Oct 30 2026, Jordan: "I
   *  don't even know where the notes are"). */
  notes: string | null;
};

/** The task's own words, when they add anything to the title and outcome. */
function notesOf(t: { title: string; summary: string | null; description: string | null }, outcome: string | null): string | null {
  const same = (a: string, b: string | null) => !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const raw = (t.description ?? "").trim() || (t.summary ?? "").trim();
  if (!raw || same(raw, t.title) || same(raw, outcome)) return null;
  // An assignment's own description is "outcome\n\nnote": the outcome is shown already.
  const rest = outcome && raw.startsWith(outcome.trim()) ? raw.slice(outcome.trim().length).trim() : raw;
  return rest ? rest.slice(0, 1500) : null;
}

function viewOf(t: TaskRow, roster: Assignee[], opts: { scrub?: boolean } = {}): DelegatedTaskView {
  const rec = parseDelegation(t.delegation) ?? { v: 1 as const, byName: "Someone", outcome: null, needsVerification: false, sourceHref: null, acceptBy: null, followUpAt: null, nextStep: null, latestUpdate: null, evidence: null, escalated: null, recommended: null, updateRequestedAt: null, events: [] };
  const clean = (s: string | null) => (s && opts.scrub ? scrubMoney(s) : s);
  const state = stateOf(t);
  const assigneeName = t.assignedKey ? roster.find((a) => a.key === t.assignedKey)?.name ?? firstName(t.assignedKey) : null;
  const who = assigneeName ?? "Nobody";
  // Reopened by an engine (a new client message merged into a completed
  // reply task): the record's last word is "completed", the row is open.
  const last = [...rec.events].reverse().find((e) => e.kind !== "update" && e.kind !== "update_requested");
  const reopened = isOpenState(state) && last?.kind === "completed";
  const latest = reopened
    ? "Reopened: new activity after it was completed"
    : rec.latestUpdate ? `${firstName(rec.latestUpdate.by)}: ${rec.latestUpdate.text}` : null;
  // When the CURRENT assignee got it: the last assignment or reassignment.
  const handed = [...rec.events].reverse().find((e) => e.kind === "assigned" || e.kind === "reassigned" || e.kind === "recommended");
  return {
    taskId: t.id,
    title: clean(t.title) ?? t.title,
    outcome: clean(rec.outcome),
    assigneeKey: t.assignedKey,
    assigneeName,
    assignedBy: rec.byName,
    assignedAt: handed?.at ?? t.delegatedAt?.toISOString() ?? null,
    dueAt: t.dueAt?.toISOString() ?? null,
    state,
    needsVerification: rec.needsVerification,
    latestUpdate: clean(latest),
    blocker: state === "BLOCKED" ? clean(t.blockedReason) ?? "No reason given" : null,
    nextStep: clean(state === "BLOCKED" ? rec.nextStep ?? defaultNextStep(state, who, rec) : isOpenState(state) ? defaultNextStep(state, who, rec) : null),
    clientId: t.clientId,
    projectId: t.projectId,
    sourceHref: rec.sourceHref,
    assignedByEmail: t.delegatedBy,
    acceptByISO: rec.acceptBy,
    followUpISO: rec.followUpAt,
    escalatedWhy: rec.escalated ? clean(rec.escalated.why) : null,
    recommendedTo: rec.recommended ? rec.recommended.assigneeName : null,
    evidence: clean(rec.evidence),
    closedAtISO: state === "COMPLETED" ? (t.completedAt ?? t.updatedAt).toISOString() : state === "CANCELLED" ? t.updatedAt.toISOString() : null,
    events: rec.events.map((e) => ({ ...e, text: clean(e.text ?? null) })),
    notes: clean(notesOf(t, rec.outcome)),
  };
}

const order = (a: DelegatedTaskView, b: DelegatedTaskView) =>
  Number(isOpenState(b.state)) - Number(isOpenState(a.state)) ||
  (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") ||
  (b.assignedAt ?? "").localeCompare(a.assignedAt ?? "");

/** The delegation view of these tasks (only the ones somebody delegated). */
export async function delegationFor(taskIds: string[], opts: { scrub?: boolean } = {}): Promise<Map<string, DelegatedTaskView>> {
  const ids = [...new Set(taskIds.filter((x) => typeof x === "string" && x))];
  const out = new Map<string, DelegatedTaskView>();
  if (!ids.length) return out;
  const [rows, roster] = await Promise.all([
    prisma.smartTask.findMany({ where: { id: { in: ids }, delegatedAt: { not: null } }, select: TASK_SELECT }),
    listAssignees(),
  ]);
  for (const r of rows) out.set(r.id, viewOf(r, roster, opts));
  return out;
}

/**
 * The open tasks delegated to this person (their roster key: "kyle",
 * "james"), soonest due first. OPEN WORK ONLY (completed and cancelled ones
 * are history), so a count of this list is a count of their open
 * assignments. Includes the ones they submitted for verification (state
 * READY_FOR_VERIFICATION: the next move is the assigner's).
 */
export async function tasksAssignedTo(assigneeKey: string, opts: { scrub?: boolean } = {}): Promise<DelegatedTaskView[]> {
  const key = (assigneeKey ?? "").trim().toLowerCase();
  if (!key) return [];
  const [rows, roster] = await Promise.all([
    prisma.smartTask.findMany({ where: { assignedKey: key, delegatedAt: { not: null }, status: { notIn: CLOSED } }, select: TASK_SELECT, take: 200 }),
    listAssignees(),
  ]);
  return rows.map((r) => viewOf(r, roster, opts)).sort(order);
}

/**
 * What this person delegated (their login email): every open assignment, and
 * the ones closed in the last CLOSED_VISIBLE_DAYS (completion evidence),
 * open first, soonest due first. Filter on `state` for the open ones.
 */
export async function tasksDelegatedBy(userEmail: string, opts: { scrub?: boolean; now?: Date } = {}): Promise<DelegatedTaskView[]> {
  return tasksDelegatedByAny([userEmail], opts);
}

/** tasksDelegatedBy for a person with more than one login (the owner signs in
 *  as info@ and as a personal address): every one of their emails. */
export async function tasksDelegatedByAny(userEmails: string[], opts: { scrub?: boolean; now?: Date } = {}): Promise<DelegatedTaskView[]> {
  const emails = [...new Set(userEmails.map((e) => (e ?? "").trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return [];
  const since = new Date((opts.now ?? new Date()).getTime() - CLOSED_VISIBLE_DAYS * 86_400_000);
  const [rows, roster] = await Promise.all([
    prisma.smartTask.findMany({
      where: { delegatedBy: { in: emails }, OR: [{ status: { notIn: CLOSED } }, { updatedAt: { gte: since } }] },
      select: TASK_SELECT,
      take: 300,
    }),
    listAssignees(),
  ]);
  return rows.map((r) => viewOf(r, roster, opts)).sort(order);
}

/** Open delegated tasks assigned to anyone (Jordan's team coverage). */
export async function openDelegations(opts: { scrub?: boolean } = {}): Promise<DelegatedTaskView[]> {
  const [rows, roster] = await Promise.all([
    prisma.smartTask.findMany({ where: { delegatedAt: { not: null }, status: { notIn: CLOSED } }, select: TASK_SELECT, take: 500 }),
    listAssignees(),
  ]);
  return rows.map((r) => viewOf(r, roster, opts)).sort(order);
}

// ---- who is acting -------------------------------------------------------------------

export type Actor = {
  email: string;
  name: string;
  role: string;
  /** every roster key this person answers to (lib/auth/guards addressableKeys) */
  keys: Set<string>;
  teamMemberId: string | null;
};

export type Result = { ok: boolean; message: string; taskId?: string };

const say = (ok: boolean, message: string, taskId?: string): Result => ({ ok, message, ...(taskId ? { taskId } : {}) });
const isLead = (a: Actor) => a.role === "OWNER" || a.role === "ADMIN";

/** May this actor put work on `assigneeKey`'s plate directly? "recommend" =
 *  only as a recommendation the owner decides (the creative manager naming
 *  someone other than themselves: no personnel authority from a title).
 *  `traineeKey` (audit, Oct 23 2026): the field creative a coaching item's
 *  practice is for. Training field creatives is the creative manager's own
 *  work (spec §3), so that one practice task goes to them directly. Only the
 *  server passes it (app/creativeDeskActions assignPracticeAction, after it
 *  read the item); the assign server action never does. */
export function assignRight(actor: Actor, assigneeKey: string, ctx: { traineeKey?: string | null } = {}): "yes" | "recommend" | "no" {
  if (isLead(actor)) return "yes";
  if (actor.role === "CREATIVE_MANAGER") return actor.keys.has(assigneeKey) || (!!ctx.traineeKey && ctx.traineeKey === assigneeKey) ? "yes" : "recommend";
  return "no";
}

/** The acting person, from the signed-in login (callers refuse a preview first).
 *  One definition for the delegation actions and the creative desk's own. */
export async function actorFor(me: CurrentUser): Promise<Actor> {
  const { addressableKeys } = await import("@/lib/auth/guards");
  const keys = await addressableKeys(me).catch(() => new Set<string>());
  const name = (me.name ?? me.email).trim().split(/\s+/)[0] || me.email;
  return { email: me.email.toLowerCase(), name, role: me.realRole, keys, teamMemberId: me.teamMemberId };
}

/** Local development with sign-in off acts as the owner (the hub's own rule). */
export const LOCAL_OWNER_ACTOR: Actor = { email: "owner@localhost", name: "Jordan", role: "OWNER", keys: new Set(["jordan"]), teamMemberId: null };

type Person = { key: string; name: string; teamMemberId: string | null; userKey: string | null; role: string; email: string | null };

async function personFor(key: string, roster?: Assignee[]): Promise<Person | null> {
  const k = (key ?? "").trim().toLowerCase();
  if (!k || NOT_A_PERSON.has(k)) return null;
  const list = roster ?? (await listAssignees());
  const a = list.find((x) => x.key === k);
  if (!a || a.kind === "vendor") return null;
  if (a.teamMemberId) {
    const login = await prisma.appUser.findFirst({ where: { teamMemberId: a.teamMemberId, status: "ACTIVE" }, select: { role: true, email: true } });
    return { key: k, name: a.name, teamMemberId: a.teamMemberId, userKey: `tm:${a.teamMemberId}`, role: login?.role ?? "ADMIN", email: login?.email ?? a.email ?? null };
  }
  const editor = await prisma.appUser.findFirst({ where: { editorKey: k, status: "ACTIVE" }, select: { role: true, email: true } });
  return { key: k, name: a.name, teamMemberId: null, userKey: editor ? `editor:${k}` : null, role: editor?.role ?? "EDITOR", email: editor?.email ?? null };
}

/** The owner (Jordan): who escalations and recommendations go to. */
async function ownerPerson(roster?: Assignee[]): Promise<Person | null> {
  const owner = await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, orderBy: { createdAt: "asc" }, select: { teamMemberId: true } });
  const list = roster ?? (await listAssignees());
  const a = owner?.teamMemberId ? list.find((x) => x.teamMemberId === owner.teamMemberId) : list.find((x) => x.kind === "owner");
  return a ? personFor(a.key, list) : null;
}

/** The assigner, as a person to notify (their login email → roster). */
async function assignerPerson(email: string | null, roster?: Assignee[]): Promise<Person | null> {
  if (!email) return null;
  const u = await prisma.appUser.findFirst({ where: { email: { equals: email, mode: "insensitive" } }, select: { teamMemberId: true, editorKey: true } });
  const list = roster ?? (await listAssignees());
  const a = u?.teamMemberId ? list.find((x) => x.teamMemberId === u.teamMemberId) : u?.editorKey ? list.find((x) => x.key === u.editorKey) : null;
  return a ? personFor(a.key, list) : null;
}

// ---- notifications (the app's own bell and Slack/text bridge) --------------------------

async function ring(to: Person | null, n: { kind: string; title: string; body?: string; href: string; slack?: string; dedupe: string }): Promise<void> {
  if (!to?.userKey) return;
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const roles = [(to.role || "ADMIN") as "OWNER" | "ADMIN" | "CREATIVE_MANAGER" | "EDITOR" | "PHOTOGRAPHER"];
    const money = to.role !== "OWNER";
    const clean = (s: string | undefined) => (s && money ? scrubMoney(s) : s);
    await notifyInApp({
      kind: n.kind,
      title: clean(n.title)!.slice(0, 90),
      body: clean(n.body),
      href: n.href,
      targets: [{ roles, userKey: to.userKey, href: n.href, ...(n.slack ? { slackDm: clean(n.slack) } : {}) }],
      dedupeKey: n.dedupe,
    });
  } catch (e) {
    console.warn("delegation notify failed", n.kind, (e as Error)?.message);
  }
}

const hrefFor = (rec: DelegationRecord, projectId: string | null) => rec.sourceHref ?? (projectId ? `/projects/${projectId}` : "/");

/** Where this person acts on the task itself: their own dashboard with the
 *  task open (app/page ?task=), the Tasks board for anyone without one
 *  (Oct 30 2026, Jordan: "I should get a link ... and it should take me to
 *  where I can take an action on it"). */
export function taskHrefFor(role: string | null | undefined, taskId: string): string {
  const id = encodeURIComponent(taskId);
  return role === "OWNER" || role === "ADMIN" || role === "CREATIVE_MANAGER" ? `/?task=${id}` : `/tasks?task=${id}`;
}

// ---- writes --------------------------------------------------------------------------

/** Read, change, write back only if nobody else wrote in between (one retry). */
async function mutate(
  taskId: string,
  fn: (t: TaskRow & { delegationRec: DelegationRecord | null }) => { data: Prisma.SmartTaskUpdateManyMutationInput; rec?: DelegationRecord; after?: () => Promise<void>; message: string } | Result,
): Promise<Result> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: TASK_SELECT });
    if (!t) return say(false, "That task no longer exists.");
    const out = fn({ ...t, delegationRec: parseDelegation(t.delegation) });
    if ("ok" in out) return out;
    const data = { ...out.data, ...(out.rec ? { delegation: JSON.stringify(trimmed(out.rec)) } : {}) };
    const r = await prisma.smartTask.updateMany({ where: { id: taskId, updatedAt: t.updatedAt }, data });
    if (r.count === 1) {
      if (out.after) await out.after().catch((e: unknown) => console.warn("delegation after-step failed", (e as Error)?.message));
      return say(true, out.message, taskId);
    }
  }
  return say(false, "Someone else changed this task at the same moment. Refresh and try again.");
}

/** Keep the record bounded: the newest 200 events. */
function trimmed(rec: DelegationRecord): DelegationRecord {
  return rec.events.length > 200 ? { ...rec, events: rec.events.slice(-200) } : rec;
}

const ev = (actor: Actor, kind: EventKind, extra: Partial<DelegationEvent> = {}, now = new Date()): DelegationEvent => ({ at: now.toISOString(), by: actor.name, kind, ...extra });
const isAssignee = (actor: Actor, t: { assignedKey: string | null }) => !!t.assignedKey && actor.keys.has(t.assignedKey);
const isAssigner = (actor: Actor, t: { delegatedBy: string | null }) => !!t.delegatedBy && t.delegatedBy === actor.email.toLowerCase();
const clip = (s: string | null | undefined, n: number) => ((s ?? "").trim() ? (s ?? "").trim().slice(0, n) : null);

export type AssignInput = {
  title: string;
  outcome?: string | null;
  assigneeKey: string;
  dueAt?: string | null;
  needsVerification?: boolean;
  sourceTaskId?: string | null;
  clientId?: string | null;
  projectId?: string | null;
  sourceHref?: string | null;
  note?: string | null;
  /** The row's own words (the client's message, the job's facts) so the task carries its notes
   *  (Jordan, Oct 30 2026: "I don't even know where the notes are"). */
  context?: string | null;
};

/** "2026-10-24" (5 PM ET that day) or an ISO instant; null when absent or unreadable. */
export function readDue(v: string | null | undefined): Date | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return etEndOfDay(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A safe in-app link (a path on this hub), or null. */
export function safeHref(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.startsWith("/") && !s.startsWith("//") && s.length <= 300 ? s : null;
}

/**
 * Assign work. Re-uses the record's task (sourceTaskId, or the one keyed to
 * sourceHref) so there is ONE canonical task; a different assignee on an
 * open delegated task is a reassignment (history kept). A creative manager
 * naming someone else records a RECOMMENDATION the owner decides: the task
 * goes to the owner, never to the person named. A creative manager naming
 * the owner sends him a decision (an escalation), never "a recommendation for
 * Jordan". `traineeKey`: see assignRight (server callers only). `decision`:
 * the owner named by anyone is a decision on his plate, the same as the
 * creative manager's (lib/sendToJordan: Kyle's Send to Jordan too).
 */
export async function assignTask(actor: Actor, input: AssignInput, opts: { now?: Date; source?: string; taskType?: string; traineeKey?: string | null; decision?: boolean } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const title = clip(input.title, 140);
  if (!title) return say(false, "Give the task a name.");
  const roster = await listAssignees();
  const target = await personFor(input.assigneeKey, roster);
  if (!target) return say(false, "Pick a person on the team to assign it to.");
  let right = assignRight(actor, target.key, { traineeKey: opts.traineeKey });
  if (right === "no") return say(false, "You can't assign work. Escalate it instead.");
  // A DECISION SENT UP (audit, Oct 23 2026). The creative manager's readiness
  // and practice recommendations, process approvals and cut escalations all
  // name Jordan. Those used to be recorded as "a recommendation for Jordan":
  // his dashboard read "Recommended for Jordan Spackman: your decision", its
  // "Assign to Jordan" changed nothing and the flag never cleared. Naming the
  // owner is an escalation he decides, on his plate.
  const owner = right === "recommend" || opts.decision ? await ownerPerson(roster) : null;
  const upToOwner = !!owner && owner.key === target.key;
  if (upToOwner) right = "yes";
  const due = readDue(input.dueAt);
  if (input.dueAt && !due) return say(false, "That due date isn't readable.");
  const sourceHref = safeHref(input.sourceHref);
  const outcome = clip(input.outcome, 600);
  const note = clip(input.note, 600);
  const context = clip(input.context, 1500);

  // ---- a recommendation: the owner decides --------------------------------
  let assignee = target;
  let recommended: DelegationRecord["recommended"] = null;
  if (right === "recommend") {
    if (!owner) return say(false, "Couldn't find Jordan's login to send the recommendation to.");
    assignee = owner;
    recommended = { at: now.toISOString(), by: actor.name, assigneeKey: target.key, assigneeName: target.name, why: note };
  }

  // ---- the canonical task -----------------------------------------------
  let existing: TaskRow | null = null;
  if (input.sourceTaskId) {
    existing = await prisma.smartTask.findUnique({ where: { id: input.sourceTaskId }, select: TASK_SELECT });
    if (!existing) return say(false, "That task no longer exists.");
    if (CLOSED.includes(existing.status)) return say(false, "That task is already closed. Open its record to start new work.");
  }
  // The creative manager acts on his own tasks only (requireTaskAccess, the
  // existing permission): a task someone else holds is not his to take or
  // hand on (audit, Oct 23 2026). A delegated one goes through reassignTask,
  // which turns that into a recommendation.
  if (existing && actor.role === "CREATIVE_MANAGER" && !existing.delegatedAt && existing.assignedKey && !actor.keys.has(existing.assignedKey)) {
    const holder = roster.find((a) => a.key === existing!.assignedKey)?.name ?? firstName(existing.assignedKey);
    return say(false, `That task is ${holder}'s. Escalate it if it needs to move.`);
  }
  const dedupeKey = input.sourceTaskId
    ? null
    : sourceHref
      ? `deleg:${sourceHref}`.slice(0, 190)
      : `deleg:manual:${actor.email.toLowerCase()}:${assignee.key}:${title.toLowerCase().replace(/\s+/g, " ")}:${etDayKey(now)}`.slice(0, 190);
  if (!existing && dedupeKey) existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: TASK_SELECT });

  const acceptBy = acceptDeadline(now, due ?? existing?.dueAt ?? null);
  const assignedEvent = ev(actor, recommended ? "recommended" : upToOwner ? "escalated" : "assigned", { to: recommended ? target.name : assignee.name, text: recommended ? `Recommended ${target.name}; Jordan decides${note ? `. ${note}` : ""}` : note }, now);
  const escalated: DelegationRecord["escalated"] = upToOwner ? { at: now.toISOString(), by: actor.name, why: note ?? outcome ?? title } : null;
  const sent = recommended
    ? `Sent to ${assignee.name} as a recommendation for ${target.name}. ${assignee.name} decides.`
    : upToOwner ? `Sent to ${assignee.name} to decide. They have been notified.` : `Assigned to ${assignee.name}. They have been notified.`;

  if (existing) {
    const rec = parseDelegation(existing.delegation);
    const open = !CLOSED.includes(existing.status);
    if (existing.delegatedAt && open && existing.assignedKey === assignee.key && !recommended) {
      const state = stateOf(existing);
      return say(true, `Already with ${assignee.name} (${STATE_WORDS[state].toLowerCase()}). Nothing new was sent.`, existing.id);
    }
    if (existing.delegatedAt && open && rec) {
      // Delegated already, to someone else: this is a reassignment.
      return reassignTask(actor, existing.id, recommended ? target.key : assignee.key, { now, roster });
    }
    // Not delegated yet (or a closed keyed task coming back): the delegation goes on THIS task.
    const reopening = CLOSED.includes(existing.status);
    const fresh: DelegationRecord = {
      v: 1, byName: actor.name, outcome, needsVerification: input.needsVerification === true, sourceHref: sourceHref ?? rec?.sourceHref ?? null,
      acceptBy: acceptBy.toISOString(), followUpAt: null, nextStep: null, latestUpdate: null, evidence: null, escalated, recommended, updateRequestedAt: null,
      events: [...(rec?.events ?? []), ...(reopening ? [ev(actor, "reopened", { text: "Assigned again after it was closed" }, now)] : []), assignedEvent],
    };
    const r = await mutate(existing.id, () => ({
      data: {
        delegatedBy: actor.email.toLowerCase(), delegatedAt: now, acceptedAt: now, assignedKey: assignee.key, ownerId: assignee.teamMemberId, assignedManually: true,
        ...(due ? { dueAt: due } : {}), ...(reopening ? { status: "OPEN", completedAt: null } : existing!.status === VERIFY_STATUS ? { status: "OPEN" } : {}),
        ...(input.clientId && !existing!.clientId ? { clientId: input.clientId } : {}), ...(input.projectId && !existing!.projectId ? { projectId: input.projectId } : {}),
        ...(context && !existing!.description?.trim() ? { description: context } : {}),
      },
      rec: fresh,
      after: () => notifyAssigned(actor, assignee, existing!.id, existing!.title, fresh, existing!.projectId ?? input.projectId ?? null, due ?? existing!.dueAt, now, { decision: upToOwner }),
      message: sent,
    }));
    return r;
  }

  const rec: DelegationRecord = {
    v: 1, byName: actor.name, outcome, needsVerification: input.needsVerification === true, sourceHref,
    acceptBy: acceptBy.toISOString(), followUpAt: null, nextStep: null, latestUpdate: null, evidence: null, escalated, recommended, updateRequestedAt: null,
    events: [assignedEvent],
  };
  let id: string;
  try {
    const row = await prisma.smartTask.create({
      data: {
        taskType: opts.taskType ?? "delegated",
        title,
        summary: (outcome ?? title).slice(0, 500),
        description: [...new Set([outcome, note, context].filter(Boolean))].join("\n\n") || null,
        reasonCreated: `Assigned by ${actor.name}`,
        source: opts.source ?? "delegation",
        sourceDetail: sourceHref,
        priority: "MEDIUM",
        dueAt: due,
        assignedKey: assignee.key,
        ownerId: assignee.teamMemberId,
        assignedManually: true,
        // projectId only: a clientId would make the task a merge target for the
        // client's next message (brain MERGEABLE_TYPES is by type, and this
        // type is not on it, but the column stays honest either way).
        projectId: input.projectId || null,
        clientId: input.clientId || null,
        dedupeKey,
        delegatedBy: actor.email.toLowerCase(),
        delegatedAt: now,
        acceptedAt: now,
        delegation: JSON.stringify(rec),
      },
      select: { id: true },
    });
    id = row.id;
  } catch {
    // The same press twice (the dedupe key is unique): the other write is this task.
    const again = dedupeKey ? await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } }) : null;
    if (!again) return say(false, "Couldn't save the task. Try again.");
    return say(true, `Already with ${assignee.name}. Nothing new was sent.`, again.id);
  }
  await notifyAssigned(actor, assignee, id, title, rec, input.projectId ?? null, due, now, { decision: upToOwner });
  return say(true, sent, id);
}

async function notifyAssigned(actor: Actor, to: Person, taskId: string, title: string, rec: DelegationRecord, projectId: string | null, due: Date | null, now: Date, opts: { decision?: boolean } = {}): Promise<void> {
  const dueWords = due ? ` · due ${etDateTime(due)}` : "";
  const what = rec.recommended ? `${actor.name} recommends ${rec.recommended.assigneeName}: ${title}` : opts.decision ? `${actor.name} needs your decision: ${title}` : `${actor.name} assigned you: ${title}`;
  const href = taskHrefFor(to.role, taskId);
  await ring(to, {
    kind: "task_assigned",
    title: what,
    body: [rec.outcome, dueWords.trim()].filter(Boolean).join(" ") || undefined,
    href,
    // The link opens the task (its notes, the record, Mark complete); assigned is theirs, nothing to accept.
    slack: `${what}${rec.outcome ? `\nOutcome: ${rec.outcome}` : ""}${dueWords ? `\nDue ${etDateTime(due)}` : ""}\n${appBase()}${href}`,
    dedupe: `deleg-assign-${taskId}-${to.key}-${rec.events.length}-${now.getTime()}`,
  });
}

/** Hand the task to someone else. History is kept; it is the new person's at once. */
export async function reassignTask(actor: Actor, taskId: string, assigneeKey: string, opts: { now?: Date; roster?: Assignee[] } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const roster = opts.roster ?? (await listAssignees());
  const target = await personFor(assigneeKey, roster);
  if (!target) return say(false, "Pick a person on the team to hand it to.");
  let from: Person | null = null;
  let notifyTo: Person = target;
  let message = "";
  let recRecommendation = false;
  const r = await mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task was never assigned. Use Assign.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    if (t.assignedKey === target.key) return say(true, `It's already with ${target.name}.`, taskId);
    let right = assignRight(actor, target.key);
    // The creative manager never TAKES work someone else holds and he didn't
    // assign (existing permission: his own tasks only). Moving it onto
    // himself is a recommendation Jordan decides (audit, Oct 23 2026).
    if (right === "yes" && actor.role === "CREATIVE_MANAGER" && !isAssignee(actor, t) && !isAssigner(actor, t)) right = "recommend";
    // The assignee may hand it BACK to whoever assigned it (setTaskAssignee's
    // old rule: the holder can return work); moving it anywhere else is the
    // assigner's or the office's call, or a recommendation the owner decides.
    const handBack = isAssignee(actor, t) && !!t.delegatedBy && !!target.email && target.email.toLowerCase() === t.delegatedBy;
    let recommended = rec.recommended;
    if (right === "yes" || handBack) {
      recommended = null;
    } else if (right === "recommend") {
      recRecommendation = true;
      recommended = { at: now.toISOString(), by: actor.name, assigneeKey: target.key, assigneeName: target.name, why: null };
    } else if (isAssignee(actor, t)) {
      return say(false, `Only ${rec.byName} can move this to ${target.name}. Escalate it if it needs to move.`);
    } else {
      return say(false, "You can't move this task.");
    }
    if (recRecommendation) {
      const next: DelegationRecord = { ...rec, recommended, events: [...rec.events, ev(actor, "recommended", { to: target.name, text: `Recommended moving it to ${target.name}; Jordan decides` }, now)] };
      message = `Recommendation recorded: ${target.name}. Jordan decides.`;
      return { data: {}, rec: next, after: async () => { notifyTo = (await ownerPerson(roster)) ?? target; await ring(notifyTo, { kind: "task_assigned", title: `${actor.name} recommends ${target.name}: ${t.title}`, href: hrefFor(rec, t.projectId), slack: `${actor.name} recommends moving "${t.title}" to ${target.name}. Your decision, on your dashboard.`, dedupe: `deleg-rec-${taskId}-${target.key}-${now.getTime()}` }); }, message };
    }
    const fromName = t.assignedKey ? roster.find((a) => a.key === t.assignedKey)?.name ?? firstName(t.assignedKey) : "nobody";
    const next: DelegationRecord = {
      ...rec,
      recommended: null,
      escalated: actor.role === "OWNER" ? null : rec.escalated,
      acceptBy: acceptDeadline(now, t.dueAt).toISOString(),
      followUpAt: null,
      nextStep: null,
      events: [...rec.events, ev(actor, "reassigned", { from: fromName, to: target.name }, now)],
    };
    message = `Moved to ${target.name}. ${fromName === "nobody" ? "" : `${fromName} is no longer on it. `}${target.name} has been notified.`;
    const prevKey = t.assignedKey;
    return {
      data: { assignedKey: target.key, ownerId: target.teamMemberId, acceptedAt: now, status: "OPEN", blockedReason: null, assignedManually: true },
      rec: next,
      after: async () => {
        await notifyAssigned(actor, target, taskId, t.title, next, t.projectId, t.dueAt, now);
        from = prevKey ? await personFor(prevKey, roster) : null;
        if (from && from.key !== target.key) await ring(from, { kind: "delegation_update", title: `Moved to ${target.name}: ${t.title}`, href: "/", dedupe: `deleg-moved-${taskId}-${prevKey}-${now.getTime()}` });
      },
      message,
    };
  });
  return r;
}

/** The assignee accepts. Accepted is not started, and not done. */
export async function acceptTask(actor: Actor, taskId: string, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated, so there is nothing to accept.");
    if (!isAssignee(actor, t)) return say(false, "Only the person it's assigned to can accept it.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    if (t.acceptedAt) return say(true, "Already accepted.", taskId);
    const next: DelegationRecord = { ...rec, events: [...rec.events, ev(actor, "accepted", {}, now)] };
    return {
      data: { acceptedAt: now },
      rec: next,
      after: async () => ring(await assignerPerson(t.delegatedBy), { kind: "delegation_update", title: `${actor.name} accepted: ${t.title}`, href: "/", dedupe: `deleg-acc-${taskId}-${now.getTime()}` }),
      message: "Accepted. It's on your list.",
    };
  });
}

/** A progress note from the assignee (or the assigner). Starts the work when it hadn't started. */
export async function updateTask(actor: Actor, taskId: string, note: string, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const text = clip(note, 600);
  if (!text) return say(false, "Write the update first.");
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    const mine = isAssignee(actor, t);
    if (!mine && !isAssigner(actor, t) && !isLead(actor)) return say(false, "Only the assignee or the person who assigned it can update it.");
    const starts = mine && (t.status === "OPEN");
    const unblocks = mine && t.status === "BLOCKED";
    const next: DelegationRecord = {
      ...rec,
      latestUpdate: { at: now.toISOString(), by: actor.name, text },
      escalated: actor.role === "OWNER" ? null : rec.escalated,
      followUpAt: unblocks ? null : rec.followUpAt,
      nextStep: unblocks ? null : rec.nextStep,
      events: [...rec.events, ...(starts && !t.acceptedAt ? [ev(actor, "accepted", {}, now)] : []), ...(unblocks ? [ev(actor, "unblocked", {}, now)] : []), ...(starts ? [ev(actor, "started", {}, now)] : []), ev(actor, "update", { text }, now)],
    };
    return {
      data: { ...(starts || unblocks ? { status: "IN_PROGRESS", blockedReason: null } : {}), ...(mine && !t.acceptedAt ? { acceptedAt: now } : {}) },
      rec: next,
      after: async () => {
        if (mine) await ring(await assignerPerson(t.delegatedBy), { kind: "delegation_update", title: `${actor.name}: ${text}`.slice(0, 90), body: t.title, href: "/", dedupe: `deleg-upd-${taskId}-${now.getTime()}` });
        else if (t.assignedKey) await ring(await personFor(t.assignedKey), { kind: "delegation_update", title: `${actor.name} on "${t.title}": ${text}`.slice(0, 90), href: hrefFor(rec, t.projectId), dedupe: `deleg-upd-${taskId}-${now.getTime()}` });
      },
      message: "Update saved. The task stays open.",
    };
  });
}

/** The assignee says what is in the way. It comes back to the assigner. */
export async function flagBlocker(actor: Actor, taskId: string, why: string, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const text = clip(why, 400);
  if (!text) return say(false, "Say what is blocking it.");
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (!isAssignee(actor, t) && !isLead(actor)) return say(false, "Only the person it's assigned to can flag a blocker.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    const follow = endOfBusinessDaysET(now, BLOCKER_FOLLOW_UP_BUSINESS_DAYS);
    const next: DelegationRecord = {
      ...rec,
      followUpAt: follow.toISOString(),
      latestUpdate: { at: now.toISOString(), by: actor.name, text: `Blocked: ${text}` },
      nextStep: `${rec.byName} to clear the blocker or decide`,
      events: [...rec.events, ev(actor, "blocked", { text }, now)],
    };
    return {
      data: { status: "BLOCKED", blockedReason: text, ...(isAssignee(actor, t) && !t.acceptedAt ? { acceptedAt: now } : {}) },
      rec: next,
      after: async () => ring(await assignerPerson(t.delegatedBy), { kind: "task_assigned", title: `Blocked: ${t.title}`, body: `${actor.name}: ${text}`, href: "/", slack: `${actor.name} is blocked on "${t.title}": ${text}`, dedupe: `deleg-blk-${taskId}-${now.getTime()}` }),
      message: `Blocker flagged. ${rec.byName} has been told.`,
    };
  });
}

/** The assignee hands finished work in for verification (only when it asks for it). */
export async function submitForVerification(actor: Actor, taskId: string, evidence?: string | null, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (!isAssignee(actor, t)) return say(false, "Only the person it's assigned to can submit it.");
    if (!rec.needsVerification) return say(false, "This one doesn't need verification. Mark it complete.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    if (t.status === VERIFY_STATUS) return say(true, "Already submitted. It's waiting on verification.", taskId);
    const proof = clip(evidence, 600);
    const next: DelegationRecord = { ...rec, evidence: proof ?? rec.evidence, events: [...rec.events, ev(actor, "submitted", { text: proof }, now)] };
    return {
      data: { status: VERIFY_STATUS, blockedReason: null, ...(!t.acceptedAt ? { acceptedAt: now } : {}) },
      rec: next,
      after: async () => ring(await assignerPerson(t.delegatedBy), { kind: "task_assigned", title: `Ready to verify: ${t.title}`, body: proof ? `${actor.name}: ${proof}` : actor.name, href: "/", slack: `${actor.name} submitted "${t.title}" for verification.${proof ? `\n${proof}` : ""}`, dedupe: `deleg-sub-${taskId}-${now.getTime()}` }),
      message: `Submitted. ${rec.byName} verifies it; it isn't complete until then.`,
    };
  });
}

/**
 * Complete. When the task needs verification, only the assigner (or the
 * owner) completes it, and that IS the verification; the assignee submits.
 */
export async function completeTask(actor: Actor, taskId: string, evidence?: string | null, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const proof = clip(evidence, 600);
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (CLOSED.includes(t.status)) return say(true, "Already closed.", taskId);
    const mine = isAssignee(actor, t);
    const oversee = isAssigner(actor, t) || actor.role === "OWNER";
    if (rec.needsVerification && !oversee) {
      return say(false, mine ? "This one needs verification: press Submit for verification." : "Only the person who assigned it can verify it.");
    }
    if (!mine && !oversee) return say(false, "Only the assignee or the person who assigned it can complete it.");
    const verified = rec.needsVerification && oversee;
    const next: DelegationRecord = {
      ...rec,
      evidence: proof ?? rec.evidence,
      escalated: null,
      recommended: null,
      events: [...rec.events, ev(actor, "completed", { text: verified ? `Verified${proof ? `: ${proof}` : ""}` : proof }, now)],
    };
    return {
      data: { status: "COMPLETED", completedAt: now, blockedReason: null },
      rec: next,
      after: async () => {
        if (mine && !oversee) await ring(await assignerPerson(t.delegatedBy), { kind: "delegation_update", title: `${actor.name} completed: ${t.title}`, body: proof ?? undefined, href: "/", dedupe: `deleg-done-${taskId}` });
        else if (t.assignedKey && !mine) await ring(await personFor(t.assignedKey), { kind: "delegation_update", title: `${verified ? "Verified" : "Closed"} by ${actor.name}: ${t.title}`, href: "/", dedupe: `deleg-done-${taskId}` });
      },
      message: verified ? "Verified and completed." : "Completed.",
    };
  });
}

/** Send back a submission (verification failed): it returns to the assignee. */
export async function returnForChanges(actor: Actor, taskId: string, why: string, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const text = clip(why, 400);
  if (!text) return say(false, "Say what still needs doing.");
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (!isAssigner(actor, t) && actor.role !== "OWNER") return say(false, "Only the person who assigned it can send it back.");
    if (t.status !== VERIFY_STATUS) return say(false, "It hasn't been submitted for verification.");
    const next: DelegationRecord = { ...rec, latestUpdate: { at: now.toISOString(), by: actor.name, text: `Sent back: ${text}` }, events: [...rec.events, ev(actor, "returned", { text }, now)] };
    return {
      data: { status: "IN_PROGRESS" },
      rec: next,
      after: async () => { if (t.assignedKey) await ring(await personFor(t.assignedKey), { kind: "task_assigned", title: `Sent back: ${t.title}`, body: text, href: hrefFor(rec, t.projectId), slack: `${actor.name} sent back "${t.title}": ${text}`, dedupe: `deleg-ret-${taskId}-${now.getTime()}` }); },
      message: "Sent back. It's open again with the assignee.",
    };
  });
}

/** Escalate to the owner: the assignee (or the creative manager) needs a decision. */
export async function escalateTask(actor: Actor, taskId: string, why: string, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const text = clip(why, 400);
  if (!text) return say(false, "Say what needs deciding.");
  if (actor.role === "OWNER") return say(false, "You're the one escalations go to. Decide it, reassign it or update it.");
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated. Assign it first, or ask Jordan directly.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    if (!isAssignee(actor, t) && !isAssigner(actor, t) && !isLead(actor) && actor.role !== "CREATIVE_MANAGER") return say(false, "You can't escalate this task.");
    const next: DelegationRecord = { ...rec, escalated: { at: now.toISOString(), by: actor.name, why: text }, events: [...rec.events, ev(actor, "escalated", { text }, now)] };
    return {
      data: {},
      rec: next,
      after: async () => ring(await ownerPerson(), { kind: "task_assigned", title: `Escalated by ${actor.name}: ${t.title}`, body: text, href: "/", slack: `${actor.name} escalated "${t.title}": ${text}`, dedupe: `deleg-esc-${taskId}-${now.getTime()}` }),
      message: "Escalated to Jordan. The task stays with its assignee until he decides.",
    };
  });
}

/** The assigner asks for an update: a ping to the assignee, at most hourly. */
export async function requestUpdate(actor: Actor, taskId: string, note?: string | null, opts: { now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const text = clip(note, 300);
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (CLOSED.includes(t.status)) return say(false, "This task is closed.");
    if (!isAssigner(actor, t) && !isLead(actor)) return say(false, "Only the person who assigned it can ask for an update.");
    if (rec.updateRequestedAt && now.getTime() - Date.parse(rec.updateRequestedAt) < UPDATE_REQUEST_GAP_MS) return say(true, `Already asked at ${etDateTime(rec.updateRequestedAt)}. Nothing new was sent.`, taskId);
    const next: DelegationRecord = { ...rec, updateRequestedAt: now.toISOString(), events: [...rec.events, ev(actor, "update_requested", { text }, now)] };
    return {
      data: {},
      rec: next,
      after: async () => { if (t.assignedKey) await ring(await personFor(t.assignedKey), { kind: "task_assigned", title: `${actor.name} asks for an update: ${t.title}`, body: text ?? undefined, href: hrefFor(rec, t.projectId), slack: `${actor.name} asks for an update on "${t.title}"${text ? `: ${text}` : ""}. Reply with Update on your dashboard.`, dedupe: `deleg-ask-${taskId}-${now.getTime()}` }); },
      message: "Asked. The assignee has been notified.",
    };
  });
}

/** Who may take a step off a complaint plan, whoever assigned its task (lib/auth/guards requireCreativeLead). */
const PLAN_LEAD_ROLES = ["OWNER", "ADMIN", "CREATIVE_MANAGER"];

/**
 * The assigner (or the owner) calls it off. `planStep`: the task is a step of
 * a complaint plan, which every lead on the complaint shares (Kyle, Oct 29
 * 2026: "Remove button is not working" on a step the hub had assigned for
 * Jordan): any lead may take it off, and the history says it left the plan.
 */
export async function cancelTask(actor: Actor, taskId: string, why: string, opts: { now?: Date; planStep?: boolean } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const text = clip(why, 300);
  if (!text) return say(false, "Say why it's no longer needed.");
  const planLead = !!opts.planStep && PLAN_LEAD_ROLES.includes(actor.role);
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!t.delegatedAt || !rec) return say(false, "This task wasn't delegated.");
    if (CLOSED.includes(t.status)) return say(true, "Already closed.", taskId);
    if (!isAssigner(actor, t) && actor.role !== "OWNER" && !planLead) return say(false, "Only the person who assigned it can cancel it.");
    const next: DelegationRecord = { ...rec, escalated: null, recommended: null, events: [...rec.events, ev(actor, "cancelled", { text: opts.planStep ? `Taken off the complaint plan: ${text}` : text }, now)] };
    return {
      data: { status: "CANCELLED", blockedReason: null },
      rec: next,
      after: async () => { if (t.assignedKey) await ring(await personFor(t.assignedKey), { kind: "delegation_update", title: `No longer needed: ${t.title}`, body: text, href: "/", dedupe: `deleg-cancel-${taskId}` }); },
      message: "Cancelled. It has left everyone's list.",
    };
  });
}

/**
 * A change the HUB makes to a delegated task (a meeting moved, so its prep
 * moved; a meeting was cancelled, so its prep was). Recorded on the task's
 * history as "the hub", and the assignee is told. Non-delegated tasks get
 * the data change only.
 */
export async function hubChange(taskId: string, change: { kind: EventKind; text: string; data: Prisma.SmartTaskUpdateManyMutationInput; tell?: string }, now: Date = new Date()): Promise<Result> {
  return mutate(taskId, (t) => {
    const rec = t.delegationRec;
    if (!rec) return { data: change.data, message: change.text };
    const next: DelegationRecord = { ...rec, events: [...rec.events, { at: now.toISOString(), by: "the hub", kind: change.kind, text: change.text }] };
    return {
      data: change.data,
      rec: next,
      after: async () => { if (change.tell && t.assignedKey) await ring(await personFor(t.assignedKey), { kind: "delegation_update", title: change.tell, href: hrefFor(rec, t.projectId), slack: change.tell, dedupe: `deleg-hub-${taskId}-${now.getTime()}` }); },
      message: change.text,
    };
  });
}

// ---- resurfacing ---------------------------------------------------------------------

/**
 * Bring missed acceptances, overdue assignments and stale blockers back to
 * the assigner: one bell per task, per reason, per ET day (the dedupe key).
 * The dashboards flag the same rows at read time; this is the push for an
 * assigner who is not looking. Read-only on the tasks themselves.
 */
export async function resurfaceDelegations(now: Date = new Date()): Promise<{ checked: number; rang: number }> {
  const open = await openDelegations();
  const day = etDayKey(now);
  let rang = 0;
  const roster = await listAssignees();
  for (const d of open) {
    const why = resurfaceOf(d, now);
    if (!why || why.kind === "escalated" || why.kind === "recommended" || why.kind === "verify") continue; // those rang when they happened
    const to = await assignerPerson(d.assignedByEmail, roster);
    if (!to) continue;
    await ring(to, {
      kind: "delegation_followup",
      title: `${why.kind === "not_accepted" ? "Not accepted" : why.kind === "overdue" ? "Overdue" : "Still blocked"}: ${d.title}`,
      body: `${d.assigneeName ?? "Nobody"} · ${why.words}`,
      href: "/",
      dedupe: `deleg-resurface-${d.taskId}-${why.kind}-${day}`,
    });
    rang++;
  }
  return { checked: open.length, rang };
}
