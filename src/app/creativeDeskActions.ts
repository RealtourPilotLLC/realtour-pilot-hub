"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { assignTaskAction } from "@/app/delegation/actions";
import { tasksDelegatedBy } from "@/lib/delegation";
import { listAssignees, viewerAssigneeKey } from "@/lib/assignees";
import { etAt, etDayKey, etDateTime } from "@/lib/datetime";
import {
  CLOSEOUT_ITEMS, IMPROVEMENT_AREAS, IMPROVEMENT_TASK_TYPE, creativeCloseoutKey, improvementMetaKey,
  type CreativeCloseoutKey, type CreativeCloseoutRecord, type ImprovementMeta,
} from "@/lib/creativeDesk";
import { HANDOFF_CLOSE_REASONS, handoffClosedKey, pruneClosedHandoffs, readClosedHandoffs, type HandoffCloseReason } from "@/lib/handoffCloseOut";
import {
  assessmentHref, cleanText, developmentPeople, developmentSeat, existingCriteria, isDevGroup, isRecommendation, isTrack, itemHref,
  parseCriteria, parseEvidence, parseLog, readDevelopment, trackLabel,
  type Criterion, type DevGroupKey, type DevLog, type Evidence,
} from "@/lib/teamDevelopment";

// ---------------------------------------------------------------------------
// THE CREATIVE MANAGER'S DASHBOARD: its writes (Oct 23 2026). Everything else
// on the dashboard calls the actions the screens already use (the Review
// Room's approveCut, the delegation workflow's Accept / Update / Flag blocker
// / Submit for verification / Complete / Escalate). These are the few the
// dashboard adds:
//   · the end-of-day check: one AppSetting row per person per ET day
//     (creative_closeout:<key>:<YYYY-MM-DD>), each tick with who and when. A
//     tick completes nothing;
//   · coaching (DevelopmentItem): record feedback, update the plan, schedule
//     and record a follow-up, assign practice (field creatives: the creative
//     manager trains them) or recommend it (editors and admin QC: Jordan's
//     call), verify an improvement. Evidence is appended, never removed;
//   · readiness (ReadinessAssessment): start, assess, recommend to Jordan (a
//     decision task for Jordan; nothing about staffing or pay is written);
//   · process improvements (a SmartTask of type process_improvement, its next
//     step and outcome beside it), and escalating a cut decision to Jordan;
//   · closing out a handoff row on his list (Oct 26 2026, lib/handoffCloseOut):
//     a reason, a note on the job, nothing else on the job changed.
// Every write refuses the owner's "view as" preview, is limited to the owner
// and the creative manager, and writes its AuditLog row first.
// ---------------------------------------------------------------------------

export type CreativeResult = { ok: boolean; message: string };

const ID = /^[a-z0-9]{10,40}$/i;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const PREVIEW = "You're previewing another login. Exit the preview to make changes.";

type Seat = { ok: true; me: CurrentUser | null; by: string; email: string | null; owner: boolean } | { ok: false; message: string };

/** The owner or the creative manager, never a preview. */
async function seat(): Promise<Seat> {
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: PREVIEW };
  if (authEnforced()) {
    if (!me) return { ok: false, message: "Please sign in to do that." };
    if (!(await developmentSeat({ role: me.realRole, realRole: me.realRole, teamMemberId: me.teamMemberId }))) return { ok: false, message: "This is the owner's and the creative manager's." };
  }
  return { ok: true, me, by: me?.realName ?? me?.name ?? me?.email ?? "local", email: me?.email ?? null, owner: !me || me.realRole === "OWNER" };
}

const text = (s: unknown, max: number) => (typeof s === "string" ? cleanText(s, max) : "");
const dayToDate = (day: unknown): Date | null => (typeof day === "string" && DAY_KEY.test(day) ? etAt(day, 9) : null);
const firstName = (n: string) => n.trim().split(/\s+/)[0] || n;

async function audit(actor: string, action: string, target: string, detail: Record<string, unknown>) {
  await prisma.auditLog.create({ data: { actor, action, target, detail: JSON.stringify(detail) } });
}

function done(message: string): CreativeResult {
  revalidatePath("/");
  revalidatePath("/development");
  return { ok: true, message };
}

// ---- the end-of-day check -------------------------------------------------------------

export async function creativeCloseoutTickAction(dayKey: string, key: CreativeCloseoutKey, on: boolean): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!DAY_KEY.test(String(dayKey)) || dayKey !== etDayKey(new Date())) return { ok: false, message: "Only today's check can be changed. Reload the page." };
  if (!CLOSEOUT_ITEMS.some((c) => c.key === key)) return { ok: false, message: "That isn't on the end-of-day check." };
  const roster = await listAssignees().catch(() => []);
  const person = s.me ? viewerAssigneeKey(s.me, roster) : "james";
  if (!person) return { ok: false, message: "Your login isn't linked to a team member, so there is no check to tick." };
  const k = creativeCloseoutKey(person, dayKey);
  const row = await prisma.appSetting.findUnique({ where: { key: k } });
  let rec: CreativeCloseoutRecord = { ticks: {} };
  try { rec = row?.value ? { ticks: (JSON.parse(row.value) as CreativeCloseoutRecord).ticks ?? {} } : { ticks: {} }; } catch { rec = { ticks: {} }; }
  const at = new Date().toISOString();
  if (on) rec.ticks[key] = { at, by: s.by };
  else delete rec.ticks[key];
  await audit(s.by, on ? "creative_closeout_tick" : "creative_closeout_untick", `${person}:${dayKey}:${key}`, { person, dayKey, key, at });
  await prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: JSON.stringify(rec), updatedBy: s.email ?? s.by }, update: { value: JSON.stringify(rec), updatedBy: s.email ?? s.by } });
  return done(on ? "Ticked. Nothing else changed." : "Unticked.");
}

// ---- closing out a handoff row ------------------------------------------------------------

export async function closeOutHandoffAction(projectId: string, sig: string, reason: HandoffCloseReason, note?: string | null): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(projectId)) || typeof sig !== "string" || !/^[a-z0-9]{1,16}$/.test(sig)) return { ok: false, message: "That row isn't recognised. Reload the page." };
  const why = HANDOFF_CLOSE_REASONS.find((r) => r.key === reason);
  if (!why) return { ok: false, message: "Pick why it's closed out." };
  const roster = await listAssignees().catch(() => []);
  const person = s.me ? viewerAssigneeKey(s.me, roster) : "james";
  if (!person) return { ok: false, message: "Your login isn't linked to a team member, so there is no list to close this on." };
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, photographer: { select: { name: true } } } });
  if (!project) return { ok: false, message: "That job wasn't found. Reload the page." };
  const words = reason === "followed_up" ? `followed up with ${firstName(project.photographer?.name ?? "the photographer")}` : why.label.toLowerCase();
  const n = text(note, 300) || null;
  const now = new Date();
  const k = handoffClosedKey(person);
  const row = await prisma.appSetting.findUnique({ where: { key: k } });
  const closed = readClosedHandoffs(row?.value);
  pruneClosedHandoffs(closed, now);
  closed[projectId] = { at: now.toISOString(), by: s.by, reason, note: n, sig, until: why.snoozeDays ? new Date(now.getTime() + why.snoozeDays * 86_400_000).toISOString() : null };
  await audit(s.by, "creative_handoff_close_out", projectId, { person, reason, note: n, sig });
  await prisma.appSetting.upsert({ where: { key: k }, create: { key: k, value: JSON.stringify(closed), updatedBy: s.email ?? s.by }, update: { value: JSON.stringify(closed), updatedBy: s.email ?? s.by } });
  await prisma.activity.create({ data: { projectId, type: "NOTE", body: `${firstName(s.by)} closed out this handoff on the creative dashboard: ${words}${n ? `. ${n}` : "."}`.slice(0, 1000), authorId: s.me?.teamMemberId ?? null } });
  return done(why.snoozeDays ? `Closed out. It comes back in ${why.snoozeDays} days if nothing has changed.` : "Closed out. It comes back if anything new turns up on this job.");
}

// ---- coaching ---------------------------------------------------------------------------

async function itemOrRefusal(id: string) {
  if (!ID.test(String(id))) return null;
  return prisma.developmentItem.findUnique({ where: { id } });
}

async function appendLog(id: string, raw: string, line: DevLog, data: Record<string, unknown> = {}) {
  const log = parseLog(raw);
  log.push(line);
  await prisma.developmentItem.update({ where: { id }, data: { ...data, logJson: JSON.stringify(log) } });
}

export type FeedbackInput = {
  /** add to an existing item; otherwise a new one is created */
  itemId?: string | null;
  personId?: string | null;
  group?: DevGroupKey | null;
  skill?: string | null;
  note: string;
  /** a signal's key: its examples become the item's evidence (re-read on the server) */
  signalKey?: string | null;
  /** an example James adds himself */
  exampleLabel?: string | null;
  exampleHref?: string | null;
  standard?: string | null;
  nextAction?: string | null;
  followUpDay?: string | null;
};

/** Record feedback: a new coaching item with its evidence, or a note on an existing one. */
export async function recordFeedbackAction(input: FeedbackInput): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  const note = text(input?.note, 1200);
  if (note.length < 3) return { ok: false, message: "Write the feedback you gave (what you saw and what good looks like)." };
  const at = new Date().toISOString();
  const typed: Evidence[] = [];
  const exLabel = text(input.exampleLabel, 200);
  const exHref = typeof input.exampleHref === "string" && input.exampleHref.trim().startsWith("/") ? input.exampleHref.trim().slice(0, 300) : null;
  if (exLabel) typed.push({ label: exLabel, href: exHref, at, source: "james" });

  if (input.itemId) {
    const item = await itemOrRefusal(input.itemId);
    if (!item) return { ok: false, message: "That coaching item no longer exists." };
    if (item.status !== "OPEN") return { ok: false, message: "That item is closed. Start a new one for new feedback." };
    const evidence = [...parseEvidence(item.evidenceJson), ...typed];
    await audit(s.by, "development_feedback", item.id, { note, typed });
    await appendLog(item.id, item.logJson, { at, by: s.by, kind: "feedback", note }, { evidenceJson: JSON.stringify(evidence), progress: note });
    return done(`Feedback recorded for ${firstName(item.personName)}.`);
  }

  if (!isDevGroup(input.group)) return { ok: false, message: "Pick the group: field creatives, editors or admin QC." };
  const people = await developmentPeople();
  const person = people.find((p) => p.id === input.personId && p.group === input.group);
  if (!person) return { ok: false, message: "Pick someone from that group." };
  let evidence: Evidence[] = [];
  let skill = text(input.skill, 160);
  if (input.signalKey) {
    // The evidence is the hub's, re-read here: never what the page sent.
    const dev = await readDevelopment({ excludeClientIds: [] });
    const sig = dev.signals.find((x) => x.key === input.signalKey && x.personId === person.id);
    if (!sig) return { ok: false, message: "That evidence has changed or is already on a coaching item. Reload the page." };
    evidence = sig.examples.length ? sig.examples : [{ label: `${sig.skill}: ${sig.detail}`, href: null, at, source: sig.key }];
    if (!evidence.some((e) => e.source === sig.key)) evidence = evidence.map((e) => ({ ...e, source: sig.key }));
    skill = skill || sig.skill;
  }
  if (!skill) return { ok: false, message: "Name the skill or issue." };
  evidence = [...evidence, ...typed];
  if (!evidence.length) evidence = [{ label: `Your observation: ${cleanText(note, 160)}`, href: null, at, source: "james" }];
  const followUpAt = dayToDate(input.followUpDay);
  const log: DevLog[] = [{ at, by: s.by, kind: "created", note }];
  if (followUpAt) log.push({ at, by: s.by, kind: "follow_up_set", note: `Follow up ${etDateTime(followUpAt)}` });
  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.developmentItem.create({
      data: {
        personId: person.id, personName: person.name, group: person.group, skill,
        standard: text(input.standard, 400) || null, nextAction: text(input.nextAction, 300) || null, followUpAt,
        progress: note, evidenceJson: JSON.stringify(evidence), logJson: JSON.stringify(log), createdBy: s.by,
      },
    });
    await tx.auditLog.create({ data: { actor: s.by, action: "development_item_created", target: created.id, detail: JSON.stringify({ personId: person.id, group: person.group, skill, evidence: evidence.length, followUpAt }) } });
    return created;
  });
  return done(`Recorded for ${firstName(item.personName)}${followUpAt ? `, follow-up ${etDateTime(followUpAt)}` : ""}.`);
}

/** Update the development plan: the expected standard, the next action, the follow-up date. */
export async function updatePlanAction(itemId: string, input: { standard?: string | null; nextAction?: string | null; followUpDay?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  const item = await itemOrRefusal(itemId);
  if (!item) return { ok: false, message: "That coaching item no longer exists." };
  if (item.status !== "OPEN") return { ok: false, message: "That item is closed." };
  const data: Record<string, unknown> = {};
  const parts: string[] = [];
  if (input.standard !== undefined) { data.standard = text(input.standard, 400) || null; parts.push(`standard: ${data.standard ?? "cleared"}`); }
  if (input.nextAction !== undefined) { data.nextAction = text(input.nextAction, 300) || null; parts.push(`next: ${data.nextAction ?? "cleared"}`); }
  if (input.followUpDay !== undefined) {
    const f = input.followUpDay ? dayToDate(input.followUpDay) : null;
    if (input.followUpDay && !f) return { ok: false, message: "Pick a follow-up date." };
    data.followUpAt = f;
    parts.push(f ? `follow up ${etDateTime(f)}` : "no follow-up date");
  }
  if (!parts.length) return { ok: false, message: "Nothing to change." };
  const at = new Date().toISOString();
  await audit(s.by, "development_plan", item.id, { ...data });
  await appendLog(item.id, item.logJson, { at, by: s.by, kind: input.followUpDay !== undefined && parts.length === 1 ? "follow_up_set" : "plan", note: parts.join("; ") }, data);
  return done("Plan updated.");
}

/** Record a coaching follow-up: what happened, whether it improved, and the next date (or none). */
export async function recordFollowUpAction(itemId: string, input: { note: string; result: "improved" | "not_yet" | "noted"; nextDay?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  const item = await itemOrRefusal(itemId);
  if (!item) return { ok: false, message: "That coaching item no longer exists." };
  if (item.status !== "OPEN") return { ok: false, message: "That item is closed." };
  const note = text(input?.note, 1200);
  if (note.length < 3) return { ok: false, message: "Write what you saw at the follow-up." };
  const result = input.result === "improved" || input.result === "not_yet" ? input.result : "noted";
  const next = input.nextDay ? dayToDate(input.nextDay) : null;
  if (input.nextDay && !next) return { ok: false, message: "Pick the next follow-up date." };
  const at = new Date().toISOString();
  await audit(s.by, "development_follow_up", item.id, { note, result, next });
  await appendLog(item.id, item.logJson, { at, by: s.by, kind: "follow_up", note, result }, { progress: note, followUpAt: next });
  return done(next ? `Follow-up recorded. Next one ${etDateTime(next)}.` : "Follow-up recorded.");
}

/** Verify an improvement: only with words saying what was seen (and, if there is one, the example). */
export async function verifyImprovementAction(itemId: string, input: { note: string; exampleLabel?: string | null; exampleHref?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  const item = await itemOrRefusal(itemId);
  if (!item) return { ok: false, message: "That coaching item no longer exists." };
  if (item.status !== "OPEN") return { ok: false, message: "That item is already closed." };
  const note = text(input?.note, 1200);
  if (note.length < 3) return { ok: false, message: "Say what shows the improvement (the job or example you checked)." };
  const at = new Date().toISOString();
  const href = typeof input.exampleHref === "string" && input.exampleHref.trim().startsWith("/") ? input.exampleHref.trim().slice(0, 300) : null;
  const evidence = [...parseEvidence(item.evidenceJson), { label: `Improvement seen: ${text(input.exampleLabel, 160) || cleanText(note, 160)}`, href, at, source: "verified" }];
  await audit(s.by, "development_verified", item.id, { note, href });
  await appendLog(item.id, item.logJson, { at, by: s.by, kind: "verified", note }, { status: "VERIFIED", verifiedAt: new Date(at), verifiedBy: s.by, progress: note, followUpAt: null, evidenceJson: JSON.stringify(evidence) });
  return done(`Improvement verified for ${firstName(item.personName)}.`);
}

/**
 * Practice. Field creatives: the creative manager trains them, so the practice
 * is ASSIGNED (recorded here, sent through the delegation workflow to them).
 * Editors and admin QC: assigning work to them is not his, so it is a
 * RECOMMENDATION, sent to Jordan as a decision.
 */
export async function assignPracticeAction(itemId: string, input: { practice: string; dueDay?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  const item = await itemOrRefusal(itemId);
  if (!item) return { ok: false, message: "That coaching item no longer exists." };
  if (item.status !== "OPEN") return { ok: false, message: "That item is closed." };
  const practice = text(input?.practice, 300);
  if (practice.length < 3) return { ok: false, message: "Describe the practice activity." };
  const due = input.dueDay ? dayToDate(input.dueDay) : null;
  if (input.dueDay && !due) return { ok: false, message: "Pick a due date." };
  const at = new Date().toISOString();
  const field = item.group === "FIELD";
  const roster = await listAssignees().catch(() => []);
  // Recorded first: the record stands even if the task cannot be sent.
  await audit(s.by, field ? "development_practice" : "development_practice_recommended", item.id, { practice, due });
  await appendLog(item.id, item.logJson, { at, by: s.by, kind: field ? "practice" : "practice_recommended", note: practice }, { practice, practiceDueAt: due });
  if (field) {
    const key = roster.find((r) => r.teamMemberId === item.personId)?.key ?? null;
    if (!key) return { ok: false, message: `Practice recorded on the plan, but ${firstName(item.personName)} has no task login to send it to.` };
    // Straight to them (audit, Oct 23 2026): through the assign action a
    // creative manager naming anyone but himself is a recommendation to
    // Jordan, so Harrison's practice went to Jordan while this said
    // "assigned". Training field creatives is his own work: the delegation
    // rule takes this one trainee, read from the item above (traineeKey).
    // No verification step on the task itself: James's desk has nowhere to
    // verify a task he handed out, so a submitted practice would sit there.
    // Harrison marks it done (James is told), and James's verification is
    // this coaching item's own "Verify improvement", with its evidence.
    const { actorFor, assignTask, LOCAL_OWNER_ACTOR } = await import("@/lib/delegation");
    const actor = s.me ? await actorFor(s.me) : LOCAL_OWNER_ACTOR;
    const r = await assignTask(actor, { title: `Practice: ${practice}`.slice(0, 140), outcome: "Practice done, ready for feedback", assigneeKey: key, dueAt: due?.toISOString(), needsVerification: false, note: item.standard ? `The standard: ${item.standard}` : undefined }, { traineeKey: key }).catch((e: unknown) => {
      console.warn("practice assign failed", (e as Error)?.message);
      return { ok: false, message: "That didn't go through. Try again." };
    });
    return r.ok ? done(`Practice assigned to ${firstName(item.personName)}.`) : { ok: false, message: `Practice recorded on the plan. It could not be sent to ${firstName(item.personName)}: ${r.message}` };
  }
  const owner = roster.find((r) => r.kind === "owner")?.key ?? null;
  if (!owner) return { ok: false, message: "Practice recorded as your recommendation. There is no owner login to send it to." };
  const r = await assignTaskAction({ title: "Practice recommendation from James", outcome: "Your decision on a practice activity James recommends", assigneeKey: owner, dueAt: due?.toISOString(), sourceHref: itemHref(item.id), note: "Assigning practice to editors and admin QC is your call. The recommendation and its evidence are on the coaching item." });
  return r.ok ? done("Recommended to Jordan as a decision.") : { ok: false, message: `Practice recorded as your recommendation. The decision task for Jordan could not be created: ${r.message}` };
}

// ---- readiness ------------------------------------------------------------------------------

export async function startAssessmentAction(input: { personId: string; track: string; skill?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!isTrack(input?.track)) return { ok: false, message: "Pick what the assessment is for." };
  const skill = text(input.skill, 80);
  if (input.track === "SKILL" && !skill) return { ok: false, message: "Name the production skill." };
  const people = await developmentPeople();
  const person = people.find((p) => p.id === input.personId && (p.group === "FIELD" || p.group === "EDITOR"));
  if (!person) return { ok: false, message: "Pick a field creative or an editor." };
  const open = await prisma.readinessAssessment.findFirst({ where: { personId: person.id, track: input.track, status: "DRAFT", ...(skill ? { skill } : {}) }, select: { id: true } });
  if (open) return { ok: false, message: "There is already an assessment in progress for that. Open it instead." };
  // The criteria that exist: the KPI terms' five categories.
  const criteria = await existingCriteria();
  const at = new Date().toISOString();
  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.readinessAssessment.create({ data: { personId: person.id, personName: person.name, track: input.track, skill: skill || null, criteriaJson: JSON.stringify(criteria), logJson: JSON.stringify([{ at, by: s.by, kind: "created", note: trackLabel(input.track, skill) }]), createdBy: s.by } });
    await tx.auditLog.create({ data: { actor: s.by, action: "readiness_started", target: row.id, detail: JSON.stringify({ personId: person.id, track: input.track, skill }) } });
    return row;
  });
  return done(`Assessment started for ${firstName(created.personName)}: ${trackLabel(created.track, created.skill)}.`);
}

export type AssessmentInput = {
  criteria?: { key: string; met: "yes" | "no" | "unknown"; evidence?: string | null }[];
  /** a criterion James writes; it is labelled his */
  addCriterion?: string | null;
  gaps?: string | null;
  recommendation?: string | null;
  note?: string | null;
};

export async function saveAssessmentAction(id: string, input: AssessmentInput): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(id))) return { ok: false, message: "That assessment id is not valid." };
  const a = await prisma.readinessAssessment.findUnique({ where: { id } });
  if (!a || a.status === "WITHDRAWN") return { ok: false, message: "That assessment no longer exists." };
  if (a.status === "RECOMMENDED") return { ok: false, message: "This one is with Jordan. Start a new assessment to change it." };
  const criteria: Criterion[] = parseCriteria(a.criteriaJson);
  for (const c of input?.criteria ?? []) {
    const hit = criteria.find((x) => x.key === c.key);
    if (!hit) continue;
    hit.met = c.met === "yes" || c.met === "no" ? c.met : "unknown";
    hit.evidence = text(c.evidence, 400) || null;
  }
  const added = text(input?.addCriterion, 140);
  if (added) criteria.push({ key: `james:${Date.now().toString(36)}`, label: added, source: "james", covers: null, met: "unknown", evidence: null });
  const unsupported = criteria.filter((c) => c.met !== "unknown" && !c.evidence);
  if (unsupported.length) return { ok: false, message: `Add the evidence for: ${unsupported.map((c) => c.label).join("; ")}. A criterion is met or not only on evidence.` };
  const recommendation = input?.recommendation == null || input.recommendation === "" ? a.recommendation : isRecommendation(input.recommendation) ? input.recommendation : null;
  const at = new Date().toISOString();
  const log = parseLog(a.logJson);
  log.push({ at, by: s.by, kind: "plan", note: [added ? `added criterion: ${added}` : null, recommendation && recommendation !== a.recommendation ? `recommendation: ${recommendation}` : null, "criteria and gaps saved"].filter(Boolean).join("; ") });
  await audit(s.by, "readiness_saved", a.id, { criteria: criteria.map((c) => ({ key: c.key, met: c.met })), recommendation, added });
  await prisma.readinessAssessment.update({
    where: { id: a.id },
    data: {
      criteriaJson: JSON.stringify(criteria),
      gaps: input?.gaps !== undefined ? text(input.gaps, 800) || null : a.gaps,
      recommendation,
      recommendationNote: input?.note !== undefined ? text(input.note, 800) || null : a.recommendationNote,
      logJson: JSON.stringify(log),
    },
  });
  return done("Assessment saved.");
}

/**
 * Recommend to Jordan: the recommendation is recorded, then a decision task
 * is created for Jordan through the delegation workflow. NOTHING ELSE: no
 * role, seat, schedule, rate or pay is touched, here or anywhere it leads.
 * A retry after a failed task never records the recommendation twice and
 * never creates a second task.
 */
export async function recommendToJordanAction(id: string): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(id))) return { ok: false, message: "That assessment id is not valid." };
  const a = await prisma.readinessAssessment.findUnique({ where: { id } });
  if (!a || a.status === "WITHDRAWN") return { ok: false, message: "That assessment no longer exists." };
  const criteria = parseCriteria(a.criteriaJson);
  if (!isRecommendation(a.recommendation)) return { ok: false, message: "Choose your recommendation first (Ready, Ready with support, or Not yet), and save." };
  if (!criteria.some((c) => c.met !== "unknown")) return { ok: false, message: "Assess at least one criterion, with its evidence, before recommending." };
  if (criteria.some((c) => c.met !== "unknown" && !c.evidence)) return { ok: false, message: "Every assessed criterion needs its evidence." };
  const roster = await listAssignees().catch(() => []);
  const owner = roster.find((r) => r.kind === "owner")?.key ?? null;
  if (!owner) return { ok: false, message: "There is no owner login to send the decision to." };
  const href = assessmentHref(a.id);
  const at = new Date().toISOString();
  if (a.status !== "RECOMMENDED") {
    const log = parseLog(a.logJson);
    log.push({ at, by: s.by, kind: "plan", note: `Recommended to Jordan: ${a.recommendation}` });
    await audit(s.by, "readiness_recommended", a.id, { recommendation: a.recommendation, track: a.track });
    await prisma.readinessAssessment.update({ where: { id: a.id }, data: { status: "RECOMMENDED", recommendedAt: new Date(at), recommendedBy: s.email ?? s.by, logJson: JSON.stringify(log) } });
  } else if (s.email) {
    // Already recommended: only (re)create the decision task if there is none.
    const existing = (await tasksDelegatedBy(s.email).catch(() => [])).find((t) => t.sourceHref === href && t.state !== "CANCELLED");
    if (existing) return { ok: true, message: "Already with Jordan." };
  }
  const r = await assignTaskAction({
    title: "Readiness recommendation from James",
    outcome: "Your decision. Nothing about staffing or pay changes until you decide and act.",
    assigneeKey: owner,
    sourceHref: href,
    note: "James assessed against the criteria and recommends. Open the assessment for the person, the criteria, the evidence and the gaps.",
  });
  if (!r.ok) {
    await audit(s.by, "readiness_decision_task_failed", a.id, { message: r.message });
    return { ok: false, message: `Recommendation saved. The decision task for Jordan could not be created: ${r.message}. Press Recommend to Jordan again to retry.` };
  }
  return done("Recommended to Jordan. It is his decision now.");
}

// ---- process improvements --------------------------------------------------------------------

export async function addImprovementAction(input: { problem: string; area: string; nextStep?: string | null; outcome?: string | null; policy?: boolean; dueDay?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  const problem = text(input?.problem, 300);
  if (problem.length < 5) return { ok: false, message: "Describe the problem the improvement fixes." };
  const area = (IMPROVEMENT_AREAS as readonly string[]).includes(input.area) ? input.area : null;
  if (!area) return { ok: false, message: "Pick the area." };
  const due = input.dueDay ? dayToDate(input.dueDay) : null;
  const roster = await listAssignees().catch(() => []);
  const key = s.me ? viewerAssigneeKey(s.me, roster) : "james";
  const at = new Date().toISOString();
  const meta: ImprovementMeta = { area, nextStep: text(input.nextStep, 300) || null, outcome: text(input.outcome, 300) || null, policy: !!input.policy, at, by: s.by };
  const task = await prisma.$transaction(async (tx) => {
    const t = await tx.smartTask.create({
      data: { taskType: IMPROVEMENT_TASK_TYPE, source: "manual", status: "OPEN", priority: "MEDIUM", title: `Improve: ${problem}`.slice(0, 140), summary: problem, description: meta.outcome, assignedKey: key, assignedManually: true, dueAt: due, reasonCreated: `Process improvement logged by ${s.by}` },
    });
    await tx.appSetting.create({ data: { key: improvementMetaKey(t.id), value: JSON.stringify(meta), updatedBy: s.email ?? s.by } });
    await tx.auditLog.create({ data: { actor: s.by, action: "improvement_added", target: t.id, detail: JSON.stringify(meta) } });
    return t;
  });
  return done(`Improvement logged${meta.policy ? ". It changes policy, so Jordan approves it before it takes effect" : ""}.${task ? "" : ""}`);
}

export async function updateImprovementAction(taskId: string, input: { nextStep?: string | null; outcome?: string | null }): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(taskId))) return { ok: false, message: "That task id is not valid." };
  const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { id: true, taskType: true, status: true } });
  if (!t || t.taskType !== IMPROVEMENT_TASK_TYPE) return { ok: false, message: "That improvement no longer exists." };
  if (t.status === "COMPLETED" || t.status === "CANCELLED") return { ok: false, message: "That improvement is closed." };
  const row = await prisma.appSetting.findUnique({ where: { key: improvementMetaKey(t.id) } });
  let meta: ImprovementMeta;
  try { meta = row?.value ? (JSON.parse(row.value) as ImprovementMeta) : { area: "Quality checklists", nextStep: null, outcome: null, policy: false, at: new Date().toISOString(), by: s.by }; } catch { meta = { area: "Quality checklists", nextStep: null, outcome: null, policy: false, at: new Date().toISOString(), by: s.by }; }
  if (input.nextStep !== undefined) meta.nextStep = text(input.nextStep, 300) || null;
  if (input.outcome !== undefined) meta.outcome = text(input.outcome, 300) || null;
  meta.at = new Date().toISOString();
  meta.by = s.by;
  await audit(s.by, "improvement_updated", t.id, { nextStep: meta.nextStep, outcome: meta.outcome });
  await prisma.appSetting.upsert({ where: { key: improvementMetaKey(t.id) }, create: { key: improvementMetaKey(t.id), value: JSON.stringify(meta), updatedBy: s.email ?? s.by }, update: { value: JSON.stringify(meta), updatedBy: s.email ?? s.by } });
  if (input.outcome !== undefined) await prisma.smartTask.update({ where: { id: t.id }, data: { description: meta.outcome } });
  return done("Improvement updated.");
}

/** Finish an improvement with its outcome. One that changes policy is Jordan's to approve. */
export async function finishImprovementAction(taskId: string, outcome: string): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(taskId))) return { ok: false, message: "That task id is not valid." };
  const words = text(outcome, 400);
  if (words.length < 3) return { ok: false, message: "Say what changed (the outcome)." };
  const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { id: true, taskType: true, status: true } });
  if (!t || t.taskType !== IMPROVEMENT_TASK_TYPE) return { ok: false, message: "That improvement no longer exists." };
  if (t.status === "COMPLETED" || t.status === "CANCELLED") return { ok: true, message: "Already finished." };
  const row = await prisma.appSetting.findUnique({ where: { key: improvementMetaKey(t.id) } });
  let policy = false;
  try { policy = row?.value ? !!(JSON.parse(row.value) as ImprovementMeta).policy : false; } catch { policy = false; }
  if (policy && !s.owner) return { ok: false, message: "This one changes policy, so Jordan approves it. Use Ask Jordan to approve." };
  await audit(s.by, "improvement_finished", t.id, { outcome: words });
  const moved = await prisma.smartTask.updateMany({ where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date(), description: words } });
  return moved.count ? done("Improvement finished.") : { ok: true, message: "Already finished." };
}

/** A policy-affecting improvement goes to Jordan for approval (a decision task). */
export async function askJordanImprovementAction(taskId: string): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(taskId))) return { ok: false, message: "That task id is not valid." };
  const t = await prisma.smartTask.findUnique({ where: { id: taskId }, select: { id: true, taskType: true, title: true, summary: true } });
  if (!t || t.taskType !== IMPROVEMENT_TASK_TYPE) return { ok: false, message: "That improvement no longer exists." };
  const roster = await listAssignees().catch(() => []);
  const owner = roster.find((r) => r.kind === "owner")?.key ?? null;
  if (!owner) return { ok: false, message: "There is no owner login to send it to." };
  await audit(s.by, "improvement_sent_to_owner", t.id, {});
  const r = await assignTaskAction({ title: `Approve a process change: ${t.summary ?? t.title}`.slice(0, 140), outcome: "Approve or decline the change", assigneeKey: owner, sourceTaskId: t.id, sourceHref: "/development#improvements" });
  return r.ok ? done("Sent to Jordan for approval.") : { ok: false, message: `Could not send it to Jordan: ${r.message}` };
}

// ---- creative review: escalate a decision ------------------------------------------------------

/** Escalate a creative decision on one cut to Jordan (a decision task carrying the cut). */
export async function escalateCutAction(submissionId: string, why: string): Promise<CreativeResult> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(String(submissionId))) return { ok: false, message: "That cut id is not valid." };
  const reason = text(why, 600);
  if (reason.length < 3) return { ok: false, message: "Say what needs Jordan's decision." };
  const sub = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { id: true, projectId: true, round: true, status: true, project: { select: { title: true, clientId: true } } } });
  if (!sub) return { ok: false, message: "That cut no longer exists." };
  const roster = await listAssignees().catch(() => []);
  const owner = roster.find((r) => r.kind === "owner")?.key ?? null;
  if (!owner) return { ok: false, message: "There is no owner login to send it to." };
  const street = (sub.project?.title || "a job").split(",")[0].trim();
  await audit(s.by, "cut_decision_escalated", sub.id, { reason, round: sub.round });
  const r = await assignTaskAction({
    title: `Creative decision: ${street}, version ${sub.round}`.slice(0, 140),
    outcome: "Your decision on this version",
    assigneeKey: owner,
    projectId: sub.projectId,
    clientId: sub.project?.clientId ?? undefined,
    sourceHref: `/review/${sub.projectId}?cut=${sub.id}`,
    note: reason,
  });
  return r.ok ? done("Escalated to Jordan. The version stays in review until a decision is made.") : { ok: false, message: `Could not escalate it: ${r.message}` };
}
