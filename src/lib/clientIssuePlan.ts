import "server-only";
import { prisma } from "@/lib/prisma";
import { redactMoney } from "@/lib/hubTools";
import { addBusinessDayKeysET, etDate, etDateYear, etDayKey, etEndOfDay } from "@/lib/datetime";
import { listAssignees } from "@/lib/assignees";
import type { Actor } from "@/lib/delegation";
import { readHistory, readIds, type ClientIssueState } from "@/lib/clientIssuesCore";
import {
  KPI_POINT_CHOICES, appendToNotes, correctedBlocker, correctionFromSteps, draftIsStale, firstNameOf, isStepKind, kpiNote, kpiTitle,
  noLongDashes, prefLines, prefsBlock, progressOf, readDraft, readKpiLinks, stepView,
  type ComplaintDraft, type DraftStep, type KpiLink, type Progress, type StepKind, type StepTask, type StepView,
} from "@/lib/clientIssuePlanCore";

// ---------------------------------------------------------------------------
// A COMPLAINT'S PLAN, SERVER HALF (Oct 29 2026). The words and the rules are
// in clientIssuePlanCore.ts; this file reads and writes them.
//
//   loadPlan               everything the complaint panel shows, for any of
//                          the three seats (owner, office, creative manager)
//   draftPlan              the hub reads the complaint and the conversation
//                          around it and proposes a summary, steps, the
//                          client's standing preferences and what they said
//                          about the shoot; ONE draft at a time (a claim)
//   approveDraft           a person's OK: the steps they kept become tasks
//   addStep / completeStep / removeStep
//                          each step is a delegated task (lib/delegation
//                          assignTask), so it lands on that person's list
//                          and dashboard and is done when its task is
//   addPrefsToNotes        the preferences go on the client's notes (Aryeo
//                          mirrored), which the shoot screen and the editor's
//                          brief show; the "add preferences" steps close
//   addToKpi               a manual entry on a creative's scorecard with the
//                          client named; one per person per complaint
//   progressFor / openComplaintPlans
//                          the dashboards' one line per complaint
// Nothing here messages a client. Anyone but the owner reads it money-scrubbed.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const clip = (s: string | null | undefined, n: number) => (s ?? "").replace(/[ \t]+/g, " ").trim().slice(0, n);
const street = (title: string | null | undefined) => (title ?? "").split(",")[0].trim() || null;

/** Where a step's task points: the complaint on the client's page. Unique per step (the delegation key). */
export const stepHref = (clientId: string, issueId: string, stepId: string) => `/clients/${clientId}?step=${stepId}#issue-${issueId}`;

function pushHistory(json: string | null | undefined, by: string | null, what: string, at = new Date()): string {
  const h = readHistory(json);
  h.push({ at: at.toISOString(), by, what: clip(what, 300) });
  return JSON.stringify(h.slice(-60));
}

// ---- the views -------------------------------------------------------------------------

export type PlanView = {
  issueId: string;
  clientId: string;
  clientName: string | null;
  clientFirst: string;
  title: string;
  state: ClientIssueState;
  summary: string | null;
  whatHappened: string;
  createdAtISO: string;
  projects: { id: string; street: string }[];
  steps: StepView[];
  progress: Progress;
  draft: ComplaintDraft | null;
  /** each draft step's due day (ET key), counted in business days from now */
  draftDueDays: string[];
  /** the hub may be asked to draft (a fresh complaint with no plan yet) */
  canDraft: boolean;
  correctedBlocker: string | null;
  correctionFromSteps: string;
  prefs: { addedText: string | null; addedAtISO: string | null; addedBy: string | null; suggestion: string[]; notesNow: string | null };
  kpi: {
    links: KpiLink[];
    people: { id: string; name: string }[];
    defaultMemberId: string | null;
    title: string;
    note: string;
    areas: { key: string; label: string }[];
    choices: typeof KPI_POINT_CHOICES;
  };
  roster: { key: string; name: string }[];
  photosHref: string | null;
};

/** The ask, call or text nearest before the complaint (how the client raised it). */
async function sourceChannel(clientId: string, at: Date): Promise<"call" | "text" | "email" | null> {
  const row = await prisma.commLog.findFirst({
    where: { clientId, direction: "in", occurredAt: { gte: new Date(at.getTime() - 15 * 60_000), lte: new Date(at.getTime() + 60_000) } },
    orderBy: { occurredAt: "desc" },
    select: { channel: true },
  }).catch(() => null);
  return row?.channel === "call" || row?.channel === "text" || row?.channel === "email" ? row.channel : null;
}

const SOURCE_NOUN: Record<string, string> = { call: "the call", text: "the texts", email: "the email" };

/** The job's photographer: assigned on the job, else its first visit's (the shoot pages' order). */
async function photographerOf(projectId: string | null): Promise<string | null> {
  if (!projectId) return null;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { photographerId: true } });
  if (p?.photographerId) return p.photographerId;
  const appt = await prisma.appointment.findFirst({ where: { projectId, assignedToId: { not: null } }, orderBy: { startAt: "asc" }, select: { assignedToId: true } });
  return appt?.assignedToId ?? null;
}

async function stepsOf(issueIds: string[], now: Date, names?: (k: string) => string | null): Promise<Map<string, StepView[]>> {
  const out = new Map<string, StepView[]>();
  if (issueIds.length === 0) return out;
  const rows = await prisma.clientIssueStep.findMany({ where: { issueId: { in: issueIds }, removedAt: null }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] });
  const taskIds = rows.map((r) => r.taskId).filter((x): x is string => !!x);
  const tasks = new Map(
    (taskIds.length ? await prisma.smartTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, status: true, completedAt: true, assignedKey: true, dueAt: true, title: true } }) : [])
      .map((t) => [t.id, t] as const),
  );
  let nameOf = names;
  if (!nameOf) {
    const roster = await listAssignees().catch(() => []);
    nameOf = (k: string) => roster.find((a) => a.key === k)?.name ?? null;
  }
  for (const r of rows) {
    const task: StepTask = r.taskId ? tasks.get(r.taskId) ?? null : null;
    const list = out.get(r.issueId) ?? [];
    list.push(stepView(r, task, nameOf, now));
    out.set(r.issueId, list);
  }
  return out;
}

/** One line per complaint for the dashboards (steps, next, late). */
export async function progressFor(issueIds: string[], now = new Date()): Promise<Map<string, { progress: Progress; steps: StepView[] }>> {
  const steps = await stepsOf(issueIds, now);
  const out = new Map<string, { progress: Progress; steps: StepView[] }>();
  for (const id of issueIds) {
    const s = steps.get(id) ?? [];
    out.set(id, { progress: progressOf(s, (iso) => etDate(iso)), steps: s });
  }
  return out;
}

/** Everything the complaint panel shows. `scrubMoney` for anyone but the owner. */
export async function loadPlan(issueId: string, opts: { scrubMoney: boolean; now?: Date }): Promise<PlanView | null> {
  const now = opts.now ?? new Date();
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId } });
  if (!issue || issue.dismissedAt) return null;
  const s = (t: string | null) => (t == null ? null : opts.scrubMoney ? redactMoney(t) : t);
  const [client, roster] = await Promise.all([
    prisma.client.findUnique({ where: { id: issue.clientId }, select: { name: true, generalNotes: true } }),
    listAssignees().catch(() => []),
  ]);
  const names = (k: string) => roster.find((a) => a.key === k)?.name ?? null;
  const projectIds = readIds(issue.projectIdsJson);
  const projects = projectIds.length
    ? (await prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true } })).map((p) => ({ id: p.id, street: street(p.title) ?? p.title }))
    : [];
  const steps = (await stepsOf([issueId], now, names)).get(issueId) ?? [];
  const draft = readDraft(issue.planJson);
  const scrubDraft = draft && opts.scrubMoney
    ? { ...draft, summary: redactMoney(draft.summary), steps: draft.steps.map((x) => ({ ...x, text: redactMoney(x.text), alreadyDone: x.alreadyDone ? redactMoney(x.alreadyDone) : null })), preferences: draft.preferences.map(redactMoney), shootFeedback: draft.shootFeedback ? redactMoney(draft.shootFeedback) : null }
    : draft;
  const fresh = now.getTime() - issue.createdAt.getTime() < 21 * 86_400_000;
  const canDraft = (!draft || draft.state === "failed" || draftIsStale(draft, now)) && steps.length === 0 && issue.state === "OPEN" && fresh;

  // The KPI tracker: who it can go on, who shot the job, and the words, with the client named.
  const { bonusRoster } = await import("@/lib/kpi");
  const people = await bonusRoster().catch(() => []);
  const shooter = await photographerOf(projectIds[0] ?? null);
  const channel = await sourceChannel(issue.clientId, issue.createdAt);
  const words = draft?.shootFeedback ?? issue.summary ?? issue.whatHappened;
  const kpiWords = clip(words, 700);
  const title = kpiTitle(client?.name ?? null, projects[0]?.street ?? null);
  return {
    issueId, clientId: issue.clientId, clientName: client?.name ?? null, clientFirst: firstNameOf(client?.name),
    title: s(issue.title) ?? "", state: issue.state as ClientIssueState, summary: s(issue.summary), whatHappened: s(issue.whatHappened) ?? "",
    createdAtISO: issue.createdAt.toISOString(), projects,
    steps: opts.scrubMoney ? steps.map((x) => ({ ...x, text: redactMoney(x.text), doneNote: x.doneNote ? redactMoney(x.doneNote) : null })) : steps,
    progress: progressOf(steps, (iso) => etDate(iso)),
    draft: scrubDraft, canDraft,
    draftDueDays: (scrubDraft?.steps ?? []).map((x) => addBusinessDayKeysET(now, x.dueBusinessDays ?? 1)),
    correctedBlocker: correctedBlocker(steps), correctionFromSteps: correctionFromSteps(steps),
    prefs: {
      addedText: s(issue.prefsText), addedAtISO: issue.prefsAddedAt?.toISOString() ?? null, addedBy: issue.prefsAddedBy,
      suggestion: (scrubDraft?.preferences ?? []),
      notesNow: client?.generalNotes ? s((await import("@/lib/clientNotes")).noteToText(client.generalNotes)) : null,
    },
    kpi: {
      links: readKpiLinks(issue.kpiJson),
      people,
      defaultMemberId: shooter && people.some((p) => p.id === shooter) ? shooter : null,
      title,
      note: s(kpiNote(client?.name ?? null, channel ?? issue.source, etDateYear(issue.createdAt), kpiWords)) ?? "",
      areas: [
        { key: "client", label: "Client experience" },
        { key: "quality", label: "Quality and QC" },
        { key: "professionalism", label: "Professionalism" },
        { key: "reliability", label: "Reliability and communication" },
      ],
      choices: KPI_POINT_CHOICES,
    },
    roster: roster.filter((a) => a.kind !== "vendor").map((a) => ({ key: a.key, name: a.name })),
    photosHref: projects[0] ? `/projects/${projects[0].id}` : null,
  };
}

// ---- the hub's draft -------------------------------------------------------------------

const DRAFT_SYSTEM = `You help the office of Realtour Pilot, a real estate media company (listing photos, video, drone, 2D floor plans, Zillow 3D tours and Zillow Showcase), work a client complaint. You read the complaint and the conversation around it and return a plan for the team. Nothing you write is sent to the client.

Rules:
- Plain, short words. Never use em dashes or en dashes. Never mention prices or dollar amounts.
- summary: 2 to 4 sentences. What the client is unhappy about and what they asked for. Keep concrete corrections (a wrong label, a missing item, something pending) apart from matters of taste or preference. Do not judge whether the client is right.
- steps: 3 to 8. Each is ONE thing ONE person does, starting with a verb, under 120 characters, naming the property or item. ownerKey is one key from the team list. Pick the owner by role: client care (the ADMIN) talks to the client and handles floor plans, Zillow, uploads, delivery and revisions; the OWNER decides on photo quality, retakes, refunds and coaches photographers; the CREATIVE_MANAGER handles creative direction and coaching the field team and editors. Photographers and editors only own a step that is their own production work.
- Never plan a reshoot, retake, refund or discount as a step. If the client asked for retakes or complained about the photos, the step is for the OWNER to review the named photos and decide whether anything needs a retake.
- When the client criticised the photographer's work, add one step with kind "coach" for the OWNER: coach the photographer with notes on the specific photos.
- When the client stated preferences for future work, add one step with kind "prefs" for the ADMIN: add the client's preferences to their client notes.
- Do not add a step to check in with the client afterwards: the hub opens that check-in itself once the complaint is marked corrected.
- alreadyDone: when the conversation shows our side already did a step, say how we know in a few words (who, when). Otherwise an empty string.
- dueBusinessDays: 0 for today, 1 for the next business day, up to 5.
- preferences: standing preferences for every FUTURE shoot or edit for this client, written as short instructions to the photographer or editor, in the client's terms. Only what they want every time, not one-off fixes for this job. An empty list when there are none.
- shootFeedback: what the client said about the photographer's own work on this shoot, specific (which rooms, what was wrong), neutral, in the client's terms, 1 to 3 sentences. Do not add your own judgement. An empty string when they said nothing about the shoot.`;

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          ownerKey: { type: "string" },
          dueBusinessDays: { type: "integer" },
          kind: { type: "string", enum: ["task", "coach", "prefs"] },
          alreadyDone: { type: "string" },
        },
        required: ["text", "ownerKey", "dueBusinessDays", "kind", "alreadyDone"],
      },
    },
    preferences: { type: "array", items: { type: "string" } },
    shootFeedback: { type: "string" },
  },
  required: ["summary", "steps", "preferences", "shootFeedback"],
};

/** The conversation around the complaint, oldest first, capped (calls are long). */
async function conversationAround(clientId: string, at: Date): Promise<string> {
  const rows = await prisma.commLog.findMany({
    where: { clientId, occurredAt: { gte: new Date(at.getTime() - 3 * 86_400_000), lte: new Date(at.getTime() + 2 * 86_400_000) }, channel: { in: ["text", "call", "email"] } },
    orderBy: { occurredAt: "asc" },
    select: { channel: true, direction: true, contactName: true, body: true, occurredAt: true },
    take: 120,
  });
  const lines = rows.map((r) => {
    const who = r.direction === "in" ? r.contactName || "Client" : "Us";
    const body = r.channel === "call" ? clip(r.body, 18_000) : clip(r.body, 1_500);
    return `[${r.occurredAt.toISOString()} ${r.channel}] ${who}: ${body}`;
  });
  let text = lines.join("\n");
  if (text.length > 40_000) text = text.slice(text.length - 40_000);
  return text;
}

const ROLE_WORDS: Record<string, string> = { OWNER: "OWNER", ADMIN: "ADMIN (client care)", CREATIVE_MANAGER: "CREATIVE_MANAGER", PHOTOGRAPHER: "photographer", EDITOR: "editor" };

/**
 * The hub drafts the plan. One draft at a time: the claim is the planJson
 * row itself (written only while empty, failed or stale). Never throws.
 */
export async function draftPlan(issueId: string, by: string | null, opts: { force?: boolean; now?: Date } = {}): Promise<Result> {
  const now = opts.now ?? new Date();
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId } });
  if (!issue || issue.dismissedAt) return { ok: false, message: "That complaint no longer exists." };
  const cur = readDraft(issue.planJson);
  if (cur?.state === "drafting" && !draftIsStale(cur, now)) return { ok: true, message: "The hub is already drafting it." };
  if (cur && !opts.force && cur.state !== "failed" && !draftIsStale(cur, now)) return { ok: true, message: "There is a draft already." };
  const claim: ComplaintDraft = { v: 1, state: "drafting", at: now.toISOString(), by, summary: "", steps: [], preferences: [], shootFeedback: null };
  const took = await prisma.clientIssue.updateMany({ where: { id: issueId, planJson: issue.planJson }, data: { planJson: JSON.stringify(claim) } });
  if (took.count !== 1) return { ok: true, message: "Someone else just started a draft." };

  try {
    const projectIds = readIds(issue.projectIdsJson);
    const [client, projects, users, roster, tasks, shooterId] = await Promise.all([
      prisma.client.findUnique({ where: { id: issue.clientId }, select: { name: true, generalNotes: true } }),
      projectIds.length ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, title: true, status: true } }) : Promise.resolve([]),
      prisma.appUser.findMany({ where: { status: "ACTIVE" }, select: { role: true, teamMemberId: true } }),
      listAssignees(),
      projectIds.length
        ? prisma.smartTask.findMany({ where: { projectId: { in: projectIds }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, select: { title: true, assignedKey: true }, take: 30 })
        : Promise.resolve([]),
      photographerOf(projectIds[0] ?? null),
    ]);
    const roleOf = new Map(users.filter((u) => u.teamMemberId).map((u) => [u.teamMemberId!, u.role]));
    const team = roster
      .filter((a) => a.kind !== "vendor")
      .map((a) => `${a.key}: ${a.name}, ${ROLE_WORDS[(a.teamMemberId && roleOf.get(a.teamMemberId)) || ""] ?? (a.kind === "owner" ? "OWNER" : a.kind)}`);
    const shooter = shooterId ? roster.find((a) => a.teamMemberId === shooterId)?.name ?? null : null;
    const convo = await conversationAround(issue.clientId, issue.createdAt);
    const prompt = [
      `Client: ${client?.name ?? "unknown"}`,
      `Complaint opened ${issue.createdAt.toISOString()}: ${issue.title}`,
      `What the hub recorded: ${clip(issue.whatHappened, 2000)}`,
      projects.length ? `Jobs: ${projects.map((p) => `${p.title} (${p.status.toLowerCase()})`).join("; ")}` : "",
      shooter ? `Photographer on the job: ${shooter}` : "",
      client?.generalNotes ? `The client's notes already on file: ${clip(redactMoney(client.generalNotes), 1500)}` : "The client's notes on file: none",
      tasks.length ? `Already on the team's lists for this job: ${tasks.map((t) => `${clip(t.title, 120)} (${t.assignedKey ?? "unassigned"})`).join("; ")}` : "",
      `Team (key: name, role):\n${team.join("\n")}`,
      `The conversation (oldest first):\n${convo || "(nothing on file)"}`,
    ].filter(Boolean).join("\n\n");
    const { aiJsonWithUsage } = await import("@/lib/integrations/ai");
    const out = await aiJsonWithUsage<{ summary: string; steps: { text: string; ownerKey: string; dueBusinessDays: number; kind: string; alreadyDone: string }[]; preferences: string[]; shootFeedback: string }>({
      system: DRAFT_SYSTEM, prompt, schema: DRAFT_SCHEMA, maxTokens: 3000, feature: "client_issue_plan",
    });
    const keys = new Set(roster.map((a) => a.key));
    const r = out.result;
    const draft: ComplaintDraft = {
      v: 1, state: "ready", at: new Date().toISOString(), by, model: out.model,
      summary: noLongDashes(clip(r.summary, 1500)),
      steps: (r.steps ?? []).slice(0, 10).map((x): DraftStep => ({
        text: noLongDashes(clip(x.text, 200)),
        ownerKey: keys.has(String(x.ownerKey ?? "").toLowerCase()) ? String(x.ownerKey).toLowerCase() : null,
        dueBusinessDays: Number.isFinite(x.dueBusinessDays) ? Math.max(0, Math.min(5, Math.round(x.dueBusinessDays))) : 1,
        kind: isStepKind(x.kind) ? x.kind : "task",
        alreadyDone: x.alreadyDone?.trim() ? noLongDashes(clip(x.alreadyDone, 200)) : null,
      })).filter((x) => x.text.length > 2),
      preferences: (r.preferences ?? []).map((p) => noLongDashes(clip(p, 240))).filter((p) => p.length > 2).slice(0, 12),
      shootFeedback: r.shootFeedback?.trim() ? noLongDashes(clip(r.shootFeedback, 700)) : null,
    };
    await prisma.clientIssue.update({ where: { id: issueId }, data: { planJson: JSON.stringify(draft) } });
    return { ok: true, message: "Drafted. Check the steps, then create them." };
  } catch (e) {
    const failed: ComplaintDraft = { ...claim, state: "failed", error: clip((e as Error)?.message ?? "The AI didn't answer.", 300) };
    await prisma.clientIssue.update({ where: { id: issueId }, data: { planJson: JSON.stringify(failed) } }).catch(() => {});
    return { ok: false, message: `The hub couldn't draft it: ${failed.error}` };
  }
}

/** Set the draft aside (the steps are added by hand instead). */
export async function dismissDraft(issueId: string, by: string | null): Promise<Result> {
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { planJson: true, historyJson: true } });
  const d = readDraft(issue?.planJson);
  if (!issue || !d) return { ok: false, message: "There is no draft." };
  await prisma.clientIssue.update({ where: { id: issueId }, data: { planJson: JSON.stringify({ ...d, state: "dismissed" }), historyJson: pushHistory(issue.historyJson, by, "Set the hub's draft aside") } });
  return { ok: true, message: "Set aside. Add the steps by hand." };
}

export type StepInput = { text: string; ownerKey: string; dueISO?: string | null; kind?: StepKind; alreadyDone?: string | null; taskId?: string | null };

/** A person's OK on the draft: the summary, and the steps they kept. */
export async function approveDraft(actor: Actor, issueId: string, input: { summary?: string | null; steps: StepInput[] }): Promise<Result> {
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { planJson: true, historyJson: true, summary: true } });
  if (!issue) return { ok: false, message: "That complaint no longer exists." };
  const d = readDraft(issue.planJson);
  if (d?.state === "approved") return { ok: true, message: "Already approved." };
  if (!input.steps.length) return { ok: false, message: "Keep at least one step, or set the draft aside." };
  const summary = clip(input.summary, 1500);
  // Claim the approval first, so a double press makes the steps once.
  const approved = d ? { ...d, state: "approved" as const, approvedAt: new Date().toISOString(), approvedBy: actor.name } : null;
  const took = await prisma.clientIssue.updateMany({
    where: { id: issueId, planJson: issue.planJson },
    data: { ...(approved ? { planJson: JSON.stringify(approved) } : {}), ...(summary ? { summary } : {}), historyJson: pushHistory(issue.historyJson, actor.name, `Approved the plan (${input.steps.length} step${input.steps.length === 1 ? "" : "s"})`) },
  });
  if (took.count !== 1) return { ok: false, message: "Someone else just changed this plan. Reload it." };
  const made: string[] = [];
  const failed: string[] = [];
  for (const s of input.steps) {
    const r = await addStep(actor, issueId, s);
    (r.ok ? made : failed).push(r.ok ? s.text : `${s.text} (${r.message})`);
  }
  return failed.length
    ? { ok: made.length > 0, message: `${made.length} step${made.length === 1 ? "" : "s"} made. These weren't: ${failed.join("; ")}` }
    : { ok: true, message: `${made.length} step${made.length === 1 ? "" : "s"} made and on everyone's lists.` };
}

/** Save the plain summary (what the dashboards show instead of the raw words). */
export async function saveSummary(issueId: string, summary: string, by: string | null): Promise<Result> {
  const text = clip(summary, 1500);
  if (text.length < 10) return { ok: false, message: "Write a sentence or two." };
  const cur = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { historyJson: true } });
  if (!cur) return { ok: false, message: "That complaint no longer exists." };
  await prisma.clientIssue.update({ where: { id: issueId }, data: { summary: noLongDashes(text), historyJson: pushHistory(cur.historyJson, by, "Summary updated") } });
  return { ok: true, message: "Saved." };
}

// ---- steps -------------------------------------------------------------------------------

/**
 * One step. Already done (from the conversation, or by hand): recorded done,
 * no task. Otherwise a delegated task on that person's list (an existing
 * task when `taskId` names one), keyed to the step so it is made once.
 */
export async function addStep(actor: Actor, issueId: string, input: StepInput, now = new Date()): Promise<Result & { stepId?: string }> {
  const text = noLongDashes(clip(input.text, 200));
  if (text.length < 3) return { ok: false, message: "Say what the step is." };
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { id: true, clientId: true, title: true, projectIdsJson: true, state: true, dismissedAt: true, historyJson: true } });
  if (!issue || issue.dismissedAt) return { ok: false, message: "That complaint no longer exists." };
  const roster = await listAssignees();
  const owner = roster.find((a) => a.key === (input.ownerKey ?? "").toLowerCase()) ?? null;
  if (!owner && !input.alreadyDone) return { ok: false, message: "Pick who does it." };
  const kind: StepKind = isStepKind(input.kind) ? input.kind : "task";
  const last = await prisma.clientIssueStep.findFirst({ where: { issueId }, orderBy: { sort: "desc" }, select: { sort: true } });
  const due = input.dueISO ? (/^\d{4}-\d{2}-\d{2}$/.test(input.dueISO) ? etEndOfDay(input.dueISO) : new Date(input.dueISO)) : null;
  const step = await prisma.clientIssueStep.create({
    data: {
      issueId, sort: (last?.sort ?? 0) + 1, text, kind, ownerKey: owner?.key ?? null, ownerName: owner?.name ?? null,
      dueAt: due && !Number.isNaN(due.getTime()) ? due : null, createdBy: actor.name,
      ...(input.alreadyDone ? { doneAt: now, doneBy: actor.name, doneNote: noLongDashes(clip(input.alreadyDone, 300)) } : {}),
    },
  });
  if (input.alreadyDone) {
    await prisma.clientIssue.update({ where: { id: issueId }, data: { historyJson: pushHistory(issue.historyJson, actor.name, `Step recorded done: ${text}`) } });
    return { ok: true, message: "Recorded as done.", stepId: step.id };
  }
  const projectId = readIds(issue.projectIdsJson)[0] ?? null;
  const client = await prisma.client.findUnique({ where: { id: issue.clientId }, select: { name: true } });
  const { assignTask } = await import("@/lib/delegation");
  const r = await assignTask(actor, {
    title: `${firstNameOf(client?.name)} complaint: ${text}`.slice(0, 140),
    outcome: `${text}. Part of the complaint "${clip(issue.title, 120)}": tick it here or on the complaint and it shows done everywhere.`,
    assigneeKey: owner!.key,
    dueAt: step.dueAt?.toISOString() ?? null,
    sourceTaskId: input.taskId ?? null,
    clientId: issue.clientId,
    projectId,
    sourceHref: stepHref(issue.clientId, issueId, step.id),
  }, { now, source: "client_issue" });
  if (!r.ok || !r.taskId) {
    await prisma.clientIssueStep.delete({ where: { id: step.id } }).catch(() => {});
    return { ok: false, message: r.message };
  }
  await prisma.clientIssueStep.update({ where: { id: step.id }, data: { taskId: r.taskId } });
  await prisma.clientIssue.update({ where: { id: issueId }, data: { historyJson: pushHistory(issue.historyJson, actor.name, `Step added for ${owner!.name}: ${text}`) } });
  return { ok: true, message: r.message, stepId: step.id };
}

/** Tick a step: its task completes (the delegation's own rules on who may), or a step without one is recorded done. */
export async function completeStep(actor: Actor, stepId: string, note?: string | null): Promise<Result & { issueId?: string }> {
  const step = await prisma.clientIssueStep.findUnique({ where: { id: stepId } });
  if (!step || step.removedAt) return { ok: false, message: "That step is gone." };
  const words = clip(note, 300) || null;
  if (step.taskId) {
    const { completeTask } = await import("@/lib/delegation");
    const r = await completeTask(actor, step.taskId, words ?? "Done (ticked on the complaint)");
    if (r.ok && words) await prisma.clientIssueStep.update({ where: { id: stepId }, data: { doneNote: words, doneBy: actor.name } });
    return { ok: r.ok, message: r.message, issueId: step.issueId };
  }
  await prisma.clientIssueStep.update({ where: { id: stepId }, data: { doneAt: new Date(), doneBy: actor.name, doneNote: words } });
  return { ok: true, message: "Done.", issueId: step.issueId };
}

/** Take a step off the plan: its open task is cancelled (the assigner or the owner may), else it is just removed. */
export async function removeStep(actor: Actor, stepId: string, why: string): Promise<Result & { issueId?: string }> {
  const reason = clip(why, 300);
  if (reason.length < 3) return { ok: false, message: "Say why it isn't needed." };
  const step = await prisma.clientIssueStep.findUnique({ where: { id: stepId } });
  if (!step || step.removedAt) return { ok: false, message: "That step is gone." };
  if (step.taskId) {
    const t = await prisma.smartTask.findUnique({ where: { id: step.taskId }, select: { status: true } });
    if (t && !["COMPLETED", "CANCELLED"].includes(t.status)) {
      const { cancelTask } = await import("@/lib/delegation");
      const r = await cancelTask(actor, step.taskId, reason);
      if (!r.ok) return { ok: false, message: r.message };
    }
  }
  await prisma.clientIssueStep.update({ where: { id: stepId }, data: { removedAt: new Date(), removedBy: actor.name, doneNote: reason } });
  const issue = await prisma.clientIssue.findUnique({ where: { id: step.issueId }, select: { historyJson: true } });
  if (issue) await prisma.clientIssue.update({ where: { id: step.issueId }, data: { historyJson: pushHistory(issue.historyJson, actor.name, `Step removed (${reason}): ${step.text}`) } });
  return { ok: true, message: "Removed from the plan and from their list.", issueId: step.issueId };
}

/** The steps still open on a complaint ("Mark corrected" waits for these). */
export async function openStepsBlocker(issueId: string): Promise<string | null> {
  const steps = (await stepsOf([issueId], new Date())).get(issueId) ?? [];
  return correctedBlocker(steps);
}

// ---- preferences -------------------------------------------------------------------------

/**
 * Add the preferences to the client's notes (the customer note, pushed to
 * Aryeo): the shoot screen, the upload page and the editor's brief all show
 * it. Added under what is there, never replacing it. The plan's "add the
 * preferences" steps close as done by the hub.
 */
export async function addPrefsToNotes(issueId: string, text: string, by: string): Promise<Result> {
  const lines = prefLines(text);
  if (lines.length === 0) return { ok: false, message: "Write at least one preference." };
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { clientId: true, createdAt: true, source: true, historyJson: true } });
  if (!issue) return { ok: false, message: "That complaint no longer exists." };
  const client = await prisma.client.findUnique({ where: { id: issue.clientId }, select: { name: true, generalNotes: true } });
  if (!client) return { ok: false, message: "Client not found." };
  const channel = await sourceChannel(issue.clientId, issue.createdAt);
  const block = prefsBlock(client.name, lines, `${SOURCE_NOUN[channel ?? ""] ?? "the complaint"} on ${etDateYear(issue.createdAt)}`);
  const { writeCustomerNote } = await import("@/lib/customerNoteWrite");
  const w = await writeCustomerNote(issue.clientId, appendToNotes(client.generalNotes, block));
  if (!w.ok && !w.message.startsWith("Saved in the hub")) return { ok: false, message: w.message };
  const now = new Date();
  await prisma.clientIssue.update({
    where: { id: issueId },
    data: { prefsText: block, prefsAddedAt: now, prefsAddedBy: by, historyJson: pushHistory(issue.historyJson, by, `Added ${lines.length} preference${lines.length === 1 ? "" : "s"} to the client's notes`) },
  });
  // The "add the preferences" steps are done: the hub closes their tasks.
  const prefSteps = await prisma.clientIssueStep.findMany({ where: { issueId, kind: "prefs", removedAt: null }, select: { id: true, taskId: true, doneAt: true } });
  const { hubChange } = await import("@/lib/delegation");
  for (const s of prefSteps) {
    if (s.taskId) await hubChange(s.taskId, { kind: "completed", text: `${by} added the preferences to the client's notes`, data: { status: "COMPLETED", completedAt: now } }, now).catch(() => null);
    else if (!s.doneAt) await prisma.clientIssueStep.update({ where: { id: s.id }, data: { doneAt: now, doneBy: by } });
  }
  return { ok: true, message: w.ok ? `Added to ${firstNameOf(client.name)}'s notes and to Aryeo. The photographer and the editor see them on their briefs.` : `${w.message} The preferences are on the client's page.` };
}

// ---- the KPI tracker -----------------------------------------------------------------------

/**
 * Put the complaint on a creative's scorecard: a manual entry (lib/kpiStore)
 * with the client named, in the period the complaint was made (today's when
 * that one is paid). Disputable by the creative like any entry; Jordan or the
 * creative manager decides. One per person per complaint.
 */
export async function addToKpi(issueId: string, input: { memberId: string; area: string; points: number; title: string; note: string }, by: string): Promise<Result> {
  const issue = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { id: true, clientId: true, createdAt: true, projectIdsJson: true, kpiJson: true, historyJson: true } });
  if (!issue) return { ok: false, message: "That complaint no longer exists." };
  if (!KPI_POINT_CHOICES.some((c) => c.points === input.points)) return { ok: false, message: "Pick how it counts." };
  const links = readKpiLinks(issue.kpiJson);
  const { bonusRoster, periodFor, scorePeriod } = await import("@/lib/kpi");
  const person = (await bonusRoster()).find((m) => m.id === input.memberId);
  if (!person) return { ok: false, message: "Pick a creative the KPI tracker covers." };
  if (links.some((l) => l.memberId === person.id)) return { ok: false, message: `It's already on ${person.name.split(" ")[0]}'s tracker.` };
  const title = noLongDashes(clip(input.title, 160));
  if (title.length < 3) return { ok: false, message: "Give it a short title." };
  const note = noLongDashes(clip(input.note, 1000));
  const paid = async (key: string) => !!(await prisma.payoutAdjustment.findFirst({ where: { teamMemberId: person.id, label: { startsWith: `Quarterly bonus ${key}` } }, select: { id: true } }));
  let day = etDayKey(issue.createdAt);
  let period = periodFor(day);
  if (period.legacy || (await paid(period.key))) { day = etDayKey(new Date()); period = periodFor(day); }
  if (period.legacy || (await paid(period.key))) return { ok: false, message: `${period.label} is paid, so its scorecard is closed.` };
  const card = await scorePeriod({ memberId: person.id, period });
  if (!card.terms.categories.flatMap((c) => c.areas).includes(input.area as never)) return { ok: false, message: "Pick one of this person's categories." };
  const projectId = readIds(issue.projectIdsJson)[0] ?? null;
  const project = projectId ? await prisma.project.findUnique({ where: { id: projectId }, select: { title: true, addressLine: true } }) : null;
  const projectLabel = project ? (project.addressLine?.trim() && !/^\[No address/i.test(project.addressLine) ? project.addressLine.trim() : street(project.title) ?? project.title).slice(0, 160) : null;
  const client = await prisma.client.findUnique({ where: { id: issue.clientId }, select: { name: true } });
  const { updateReview } = await import("@/lib/kpiStore");
  let entryId = "";
  const r = await updateReview(person.id, period.key, by, (rev) => {
    if (rev.manual.some((m) => m.issueId === issueId)) return "It's already on this tracker.";
    const id = crypto.randomUUID();
    entryId = `manual:${id}`;
    rev.manual.push({ id, area: input.area, day, title, note, points: input.points, projectId, projectLabel, by, at: new Date().toISOString(), issueId, client: client?.name ?? null });
    return { next: rev, log: { entryId, what: `Entry added from a client complaint (${input.points > 0 ? "+" : ""}${input.points}): ${title.slice(0, 120)}` } };
  });
  if (!r.ok) return { ok: false, message: r.message };
  const link: KpiLink = { memberId: person.id, memberName: person.name, periodKey: period.key, entryId, area: input.area, points: input.points, at: new Date().toISOString(), by };
  await prisma.clientIssue.update({
    where: { id: issueId },
    data: { kpiJson: JSON.stringify([...links, link]), historyJson: pushHistory(issue.historyJson, by, `Added to ${person.name}'s KPI tracker (${input.points === 0 ? "a note" : `${input.points} points`})`) },
  });
  return { ok: true, message: `On ${person.name.split(" ")[0]}'s KPI tracker now, with ${firstNameOf(client?.name)} named. They can see it and dispute it.` };
}

// ---- the dashboards ------------------------------------------------------------------------

export type OpenComplaint = {
  issueId: string;
  clientId: string;
  clientName: string | null;
  title: string;
  summary: string | null;
  state: ClientIssueState;
  createdAtISO: string;
  progress: Progress;
  /** open steps on this person's list */
  mine: number;
  needsPlan: boolean;
};

/** Open complaints (not yet confirmed), newest first, for Kyle's and James's desks. */
export async function openComplaintPlans(opts: { scrubMoney: boolean; myKeys?: Set<string>; take?: number; now?: Date }): Promise<OpenComplaint[]> {
  const now = opts.now ?? new Date();
  const rows = await prisma.clientIssue.findMany({
    where: { dismissedAt: null, state: { in: ["OPEN", "CORRECTED", "UNRESOLVED"] } },
    orderBy: { createdAt: "desc" },
    take: opts.take ?? 20,
    select: { id: true, clientId: true, title: true, summary: true, state: true, createdAt: true },
  });
  const names = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const plans = await progressFor(rows.map((r) => r.id), now);
  const s = (t: string | null) => (t == null ? null : opts.scrubMoney ? redactMoney(t) : t);
  return rows.map((r) => {
    const p = plans.get(r.id)!;
    return {
      issueId: r.id, clientId: r.clientId, clientName: names.get(r.clientId) ?? null, title: s(r.title) ?? "", summary: s(r.summary),
      state: r.state as ClientIssueState, createdAtISO: r.createdAt.toISOString(),
      progress: opts.scrubMoney ? { ...p.progress, words: redactMoney(p.progress.words) } : p.progress,
      mine: opts.myKeys ? p.steps.filter((x) => !x.done && !x.cancelled && x.ownerKey && opts.myKeys!.has(x.ownerKey)).length : 0,
      needsPlan: p.steps.length === 0 && r.state === "OPEN",
    };
  });
}
