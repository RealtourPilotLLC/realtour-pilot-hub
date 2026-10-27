import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { scrubMoney } from "@/lib/text";
import { listAssignees, viewerAssigneeKey, type Assignee } from "@/lib/assignees";
import { syntheticClientIds } from "@/lib/syntheticClients";
import { parseAccessBrief } from "@/lib/opsDay";
import { categoryHandoffAt, handoffEvidence, liveHandoffCategories, type HandoffCategory } from "@/lib/handoff";
import { isFieldFlag } from "@/lib/debrief";
import { contentHref } from "@/lib/contentNav";
import { etDate, etDateTime, etDayBoundsUtc, etDayKey, etDayStartUtc, etFullDate, etMonthKey, etTime } from "@/lib/datetime";
import { DEV_GROUPS, developmentSeat, readDevelopment, type DevelopmentRead, type DevGroupKey, type DevItemView, type Evidence, type Signal } from "@/lib/teamDevelopment";
import { delegationFor, tasksAssignedTo, type DelegatedTask, type DelegationState } from "@/lib/delegation";
import { handoffClosedKey, handoffSig, isClosedOut, readClosedHandoffs } from "@/lib/handoffCloseOut";
import { resolveVideoSpec } from "@/lib/pipeline";
import { videoTier } from "@/lib/projectStatus";

// ---------------------------------------------------------------------------
// THE CREATIVE MANAGER'S DASHBOARD (Oct 23 2026, Jordan's spec §6): James's
// "/" in the spec's order. A builds from B to H; every section reads its own
// records and fails on its own (a source that could not be read is named and
// never shown as zero or as "all clear").
//
//   A  Today at a glance: his shoots today, cuts ready for him, coaching
//      follow-ups due, urgent assigned work. Each number IS the length of the
//      list it points at (the drill holds it).
//   B  Production: his own upcoming visits (shot list, agent direction,
//      special requests, Kyle's confirmation, and the shoot-day brief when it
//      waits for his Got it), then his shoots whose handoff is incomplete, then
//      the team's (the field creatives he supervises), apart. Capture and
//      upload come from EVIDENCE only (the field Done, the capture and upload
//      ticks, the upload page's submit, what Dropbox showed); a visit whose END
//      has passed with none of it says exactly that, as a handoff to finish.
//   C  Creative review: cuts ready for him (or nobody's) and review work that
//      is delayed past the room's cover window. Approve acts on ONE version
//      through the Review Room's own approveCut; approved goes to Kyle's
//      Ready to send, never to the client.
//   D  Team development and quality (lib/teamDevelopment), owner and James.
//   E  Readiness assessments (lib/teamDevelopment); James recommends.
//   F  Creative preparation: listing and monthly work with the ownership
//      mode read from the real records (ProgramOwnerAssignment, who wrote the
//      version, who films the session); deadlines from the shoot or session.
//   G  Process improvements: recurring friction the hub already measures
//      (team signals with their counts) and the SmartTasks of taskType
//      "process_improvement" that track the fixes.
//   H  Assigned to me and handoffs: the delegation workflow plus his own open
//      tasks, and the end-of-day check (AppSetting per day per person; a tick
//      never completes a task).
// No money anywhere (scrubMoney on every typed line). The owner's "view as"
// reads it all and writes nothing (readOnly).
// ---------------------------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Rows shown in a section before "View all". */
export const SHOWN = 3;

export const CLOSEOUT_ITEMS = [
  { key: "uploads", label: "My uploads and handoffs complete" },
  { key: "reviews", label: "Due reviews handled, or exceptions documented" },
  { key: "coaching", label: "Coaching follow-ups recorded" },
  { key: "blockers", label: "Blockers have an owner and a next step" },
] as const;
export type CreativeCloseoutKey = (typeof CLOSEOUT_ITEMS)[number]["key"];
/** One ET day's end-of-day check for one person (like Kyle's office_closeout). */
export const creativeCloseoutKey = (personKey: string, dayKey: string) => `creative_closeout:${personKey}:${dayKey}`;
export type CreativeCloseoutRecord = { ticks: Partial<Record<CreativeCloseoutKey, { at: string; by: string }>> };

/** Process improvements are tasks of this type (one shared task record). */
export const IMPROVEMENT_TASK_TYPE = "process_improvement";
/** Their next step and expected outcome, beside the task (like office_waiting). */
export const improvementMetaKey = (taskId: string) => `creative_improvement:${taskId}`;
export type ImprovementMeta = { area: string; nextStep: string | null; outcome: string | null; policy: boolean; at: string; by: string; /** the friction row it was started from (Oct 27 2026) */ friction?: string | null };
export const IMPROVEMENT_AREAS = ["Shot lists", "Uploads and handoffs", "Creative briefs", "Review procedure", "Client direction", "Training materials", "Quality checklists"] as const;

// ---- types --------------------------------------------------------------------------------

export type Tone = "ok" | "todo" | "info" | "off";
export type Chip = { key: string; label: string; tone: Tone };
export type LinkOut = { label: string; href: string; external?: boolean };

export type ShootRow = {
  id: string;
  projectId: string;
  street: string;
  clientName: string | null;
  whenISO: string;
  endISO: string;
  dayKey: string;
  today: boolean;
  whenWords: string;
  services: string[];
  chips: Chip[];
  /** the creative preparation still missing, in words (the chips that need someone) */
  missing: string[];
  requests: string[];
  links: LinkOut[];
  /** the visit has begun (filming now, or over) */
  started: boolean;
  /** the visit's END has passed with nothing recorded from the field: the handoff is due */
  over: boolean;
  /** the row's one status chip (the mockup's pill), or none */
  status: { label: string; tone: Tone } | null;
  /** the shoot-day brief is waiting for his Got it (Kyle's desk sees an unconfirmed one): the day and the version shown */
  briefAck: { day: string; digest: string; again: boolean } | null;
  /** the upload page, at the part that finishes the handoff */
  finishHref: string;
};

export type HandoffRow = {
  projectId: string;
  street: string;
  clientName: string | null;
  photographer: string;
  mine: boolean;
  visitISO: string | null;
  /** one line: where the handoff stands, from evidence */
  status: string;
  tone: "todo" | "info";
  lines: Chip[];
  missing: string[];
  exceptions: string[];
  links: LinkOut[];
  /** the row as it reads now (lib/handoffCloseOut): a closed-out row comes back when this changes */
  sig: string;
  /** the upload page, scrolled to what is missing (#capture, #submit) */
  finishHref: string;
};

export type CutRow = {
  id: string;
  projectId: string;
  street: string;
  clientName: string | null;
  version: number;
  label: string | null;
  editor: string | null;
  reviewer: string | null;
  mine: boolean;
  enteredISO: string;
  waitedHours: number | null;
  waitedWords: string;
  delayed: boolean;
  heldForCheck: boolean;
  dueISO: string | null;
  dueWords: string | null;
  priorNotes: { total: number; open: number };
  asks: string[];
  href: string;
  why: string | null;
};

export type OwnershipMode = "JORDAN_OWNS" | "JAMES_DRAFTS" | "JAMES_OWNS";
export const MODE_WORDS: Record<OwnershipMode, string> = {
  JORDAN_OWNS: "Jordan owns",
  JAMES_DRAFTS: "You draft, Jordan approves",
  JAMES_OWNS: "You own",
};
export type PrepRow = {
  key: string;
  kind: "listing" | "monthly";
  /** the listing job (Add input goes to its job chat) */
  projectId: string | null;
  title: string;
  /** one grey line: when it is due, and where it stands */
  detail: string;
  clientName: string | null;
  mode: OwnershipMode;
  writer: string;
  approver: string;
  /** what James contributes, in words */
  role: string;
  /** where the mode came from, in words (the record it was read from) */
  source: string;
  deadlineISO: string | null;
  deadlineWords: string | null;
  status: string;
  links: LinkOut[];
};

export type ImprovementRow = {
  taskId: string;
  /** the friction row it was started from, if any */
  friction: string | null;
  problem: string;
  area: string | null;
  owner: string;
  nextStep: string | null;
  outcome: string | null;
  policy: boolean;
  status: string;
  dueISO: string | null;
  mine: boolean;
};

/**
 * RECURRING FRICTION (Oct 27 2026, Jordan: "Process improvement - figure out
 * what needs to go here"). Only what the hub already counts, from the team
 * signals (KPI evidence, the photo check, reviewer-traced revision causes),
 * added up across people: never a guess, never a row without its count. Its
 * one action starts an improvement task he can track (taskId once it exists).
 */
export type FrictionRow = {
  key: string;
  title: string;
  evidence: string;
  count: number;
  area: (typeof IMPROVEMENT_AREAS)[number];
  /** the button's words: what the improvement is */
  action: string;
  problem: string;
  nextStep: string;
  examples: Evidence[];
  taskId: string | null;
};

export type AssignedRow = {
  taskId: string;
  title: string;
  outcome: string | null;
  assignedBy: string | null;
  dueISO: string | null;
  dueWords: string | null;
  overdue: boolean;
  urgent: boolean;
  state: DelegationState | "OPEN" | "WAITING";
  stateWords: string;
  blocker: string | null;
  nextStep: string | null;
  latestUpdate: string | null;
  needsVerification: boolean;
  /** created through the delegation workflow (Accept/Update/... apply) */
  delegated: boolean;
  /** a CP-06 brand confirmation: it closes itself when the editors tap Got it (never by hand) */
  closesItself: boolean;
  href: string;
};

export type CloseoutLine = { key: CreativeCloseoutKey; label: string; auto: boolean | null; words: string; tick: { atISO: string; by: string } | null; done: boolean };

export type DevGroupView = {
  key: DevGroupKey;
  label: string;
  blurb: string;
  people: { id: string; name: string }[];
  items: DevItemView[];
  signals: Signal[];
};

export type CreativeDesk = {
  nowISO: string;
  dayKey: string;
  dateWords: string;
  person: { name: string; first: string; teamMemberId: string | null; key: string | null };
  ownerKey: string | null;
  readOnly: boolean;
  /** the owner and the creative manager only (D and E) */
  development: boolean;
  unavailable: string[];
  glance: { shoots: number | null; reviews: number | null; followUps: number | null; urgent: number | null; line: string };
  production: { mine: ShootRow[]; handoffs: HandoffRow[]; team: HandoffRow[]; unavailable: boolean; myShootsHref: string; /** rows he closed out, hidden until something on them changes */ closedOut: number; /** the full view behind the card */ fullHref: string };
  review: { ready: CutRow[]; delayed: CutRow[]; coverHours: number; unavailable: boolean };
  team: { groups: DevGroupView[]; dueIds: string[]; unavailable: string[]; recordsUnavailable: boolean } | null;
  readiness: { items: DevelopmentRead["readiness"]; criteria: DevelopmentRead["criteria"]; people: { id: string; name: string }[]; unavailable: boolean } | null;
  prep: { items: PrepRow[]; unavailable: boolean };
  improvements: { items: ImprovementRow[]; frictions: FrictionRow[]; unavailable: boolean };
  /** people: who a task of his can be handed to (Delegate), the team without vendors */
  assigned: { items: AssignedRow[]; people: { key: string; name: string }[]; unavailable: boolean };
  closeout: { dayKey: string; lines: CloseoutLine[] };
};

// ---- helpers ------------------------------------------------------------------------------

const clean = (s: string | null | undefined, max = 200) => {
  // No em or en dashes on this screen (house rule): a typed " — " reads as a comma.
  const t = scrubMoney((s ?? "").replace(/\s+/g, " ").replace(/\s*[\u2014\u2013]\s*/g, ", ").trim());
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const streetOf = (t: string | null | undefined) => clean((t || "Job").split(",")[0].trim() || "Job", 80);
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`}`;
const first = (n: string | null | undefined) => (n ?? "").trim().split(/\s+/)[0] || "";
const liveAppt = (a: { status: string | null; startAt: Date | null }) => !!a.startAt && (a.status ?? "").toUpperCase() !== "CANCELED";

function apptItems(rawJson: string | null): string[] {
  try {
    const j = JSON.parse(rawJson ?? "{}") as { items?: { title?: string; is_canceled?: boolean }[] };
    return (j.items ?? []).filter((i) => i && i.title && !i.is_canceled).map((i) => String(i.title));
  } catch {
    return [];
  }
}

export function dueWordsFor(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const k = etDayKey(d);
  const today = etDayKey(now);
  if (d.getTime() < now.getTime()) return k === today ? `Was due ${etTime(d)}` : `Was due ${etDate(d)}`;
  return k === today ? `Today ${etTime(d)}` : etDateTime(d);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (mk: string) => MONTHS[Number(mk.slice(5, 7)) - 1] ?? mk;

const waitedWords = (h: number | null) => (h == null ? "waiting" : h < 1 ? "under an hour" : h < 48 ? `${Math.round(h)} working hours` : `${Math.round(h / 9)} working days`);

/** Script Studio's status, in words for the creative. */
const STUDIO_WORDS: Record<string, string> = {
  awaiting_intake: "waiting on the agent's intake",
  hooks_proposed: "being written",
  generating: "being written",
  awaiting_review: "waiting on your review",
  approved: "approved",
  sent_to_client: "sent to the agent",
  client_approved: "approved by the agent",
  client_revision_requested: "the agent asked for changes",
  revising: "being revised",
  done: "final",
};
const STUDIO_READY = new Set(["approved", "sent_to_client", "client_approved", "done"]);

// ---- B · production -----------------------------------------------------------------------

type Ctx = { now: Date; tmId: string | null; appUserId: string | null; email: string | null; ex: string[]; myKey: string | null };

const PROD_SELECT = {
  id: true, title: true, status: true, addressLine: true, shootDate: true, photographerId: true, contentMonthId: true, packageName: true,
  photographer: { select: { name: true } },
  orderItems: { where: { isCanceled: false }, select: { title: true } },
  client: { select: { name: true } },
  scriptingId: true, scriptingStatus: true, scriptingUrl: true, scriptingScript: true, reelScript: true, reelShotList: true,
  debriefSubmittedAt: true, photosHandoffAt: true, videoHandoffAt: true, statusEvidence: true, handoffReadyAt: true, handoffBlockedReason: true,
  deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, videoStyle: true, notCompletedReason: true, waivedAt: true, removedFromOrderAt: true, uploadedAt: true, capturedAt: true } },
} satisfies Prisma.ProjectSelect;
type ProdProject = Prisma.ProjectGetPayload<{ select: typeof PROD_SELECT }>;

/** The full Production view behind the card (Oct 27 2026). */
export const PRODUCTION_HREF = "/production";

async function readProduction(ctx: Ctx): Promise<CreativeDesk["production"]> {
  const { now, tmId, ex } = ctx;
  const myShootsHref = tmId ? `/shoot?as=${tmId}` : "/shoot";
  if (!tmId) return { mine: [], handoffs: [], team: [], unavailable: false, myShootsHref, closedOut: 0, fullHref: PRODUCTION_HREF };
  const dayStart = etDayStartUtc(now);
  const today = etDayKey(now);
  const clientScope = ex.length ? { clientId: { notIn: ex } } : {};
  const liveProject = { status: { notIn: ["CANCELLED", "ON_HOLD"] as ("CANCELLED" | "ON_HOLD")[] }, ...clientScope };

  // Every visit of HIS from three weeks back to a week ahead (one read).
  const visits = await prisma.appointment.findMany({
    where: {
      status: "SCHEDULED",
      startAt: { gte: new Date(dayStart.getTime() - 21 * DAY), lt: new Date(dayStart.getTime() + 8 * DAY) },
      OR: [{ assignedToId: tmId }, { assignedToId: null, project: { photographerId: tmId } }],
      project: liveProject,
    },
    orderBy: { startAt: "asc" },
    take: 120,
    select: { id: true, startAt: true, endAt: true, status: true, description: true, rawJson: true, completedAt: true, projectId: true },
  });
  const projectIds = [...new Set(visits.map((v) => v.projectId))];
  const [projects, drafts] = await Promise.all([
    projectIds.length ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: PROD_SELECT }) : Promise.resolve([]),
    projectIds.length ? prisma.uploadDraft.findMany({ where: { projectId: { in: projectIds }, consumedAt: null }, select: { projectId: true, authorKey: true, savedAt: true } }) : Promise.resolve([]),
  ]);
  const byId = new Map(projects.map((p) => [p.id, p]));
  // WHAT THE FIELD RECORDED FOR ONE VISIT (never its clock): the visit's own
  // Done, or a capture tick, an upload tick, a saved upload draft or a handoff
  // stamp made after the visit began (a split job's earlier visit is not this one's).
  const visitEvidence = (v: (typeof visits)[number]) => {
    const p = byId.get(v.projectId);
    if (!p || !v.startAt) return false;
    if (v.completedAt) return true;
    const from = v.startAt.getTime() - HOUR;
    const stamps = [p.debriefSubmittedAt, p.photosHandoffAt, p.videoHandoffAt, ...p.deliverables.flatMap((d) => [d.capturedAt, d.uploadedAt]), ...drafts.filter((d) => d.projectId === p.id).map((d) => d.savedAt)];
    return stamps.some((t) => !!t && t.getTime() >= from);
  };

  // Upcoming: today or later, with nothing recorded from the field for that visit yet.
  const upcoming = visits.filter((v) => !!v.startAt && v.startAt >= dayStart && byId.has(v.projectId) && !visitEvidence(v));
  const upIds = upcoming.map((v) => v.projectId);
  const [briefs, briefReads, confirmations, asks, monthScripts, outputs] = await Promise.all([
    upcoming.length ? import("@/lib/photographerBrief").then((m) => m.briefStatusForAppointments(upcoming.map((v) => v.id))).catch(() => null) : Promise.resolve(null),
    upcoming.length && ctx.appUserId ? prisma.shootBriefRead.findMany({ where: { projectId: { in: upIds }, readerUserId: ctx.appUserId }, select: { projectId: true, readAt: true } }) : Promise.resolve([]),
    upcoming.length ? prisma.smartTask.findMany({ where: { projectId: { in: upIds }, taskType: "confirmation_text" }, orderBy: { createdAt: "desc" }, select: { projectId: true, status: true, dueAt: true, completedAt: true } }) : Promise.resolve([]),
    upcoming.length ? prisma.clientAsk.findMany({ where: { projectId: { in: upIds }, kind: "SPECIAL_REQUEST", state: "OPEN" }, orderBy: { askedAt: "asc" }, select: { projectId: true, summary: true, text: true, askedAt: true } }) : Promise.resolve([]),
    (() => {
      const monthIds = [...new Set(upcoming.map((v) => byId.get(v.projectId)?.contentMonthId).filter((x): x is string => !!x))];
      return monthIds.length
        ? prisma.contentScript.groupBy({ by: ["monthId"], where: { monthId: { in: monthIds }, historical: false, status: { in: ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"] } }, _count: true })
        : Promise.resolve([] as { monthId: string | null; _count: number }[]);
    })(),
    upcoming.length ? prisma.deliverableOutput.findMany({ where: { projectId: { in: upIds }, briefJson: { not: null } }, select: { projectId: true } }) : Promise.resolve([]),
  ]);

  const mine: ShootRow[] = upcoming.map((v) => {
    const p = byId.get(v.projectId)!;
    const start = v.startAt!;
    const dayKey = etDayKey(start);
    // FILMING IS NOT A GAP (Jordan, Oct 27 2026: "He's filming it today, so
    // of course nothing was recorded yet"). The visit is over only at its
    // END: the appointment's, or, when Aryeo sent none, the end of that day
    // (a full-day session is never "over" at lunchtime; the next morning an
    // unrecorded visit is a handoff row).
    const end = v.endAt && v.endAt.getTime() > start.getTime() ? v.endAt : etDayBoundsUtc(dayKey).end;
    const started = start.getTime() <= now.getTime();
    const over = end.getTime() <= now.getTime();
    const acc = parseAccessBrief(v.description);
    const services = apptItems(v.rawJson);
    const live = p.deliverables.filter((d) => !d.notCompletedReason && !d.waivedAt);
    const video = live.some((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL");
    const chips: Chip[] = [];
    // Kyle's confirmation (the desk's own rule: the text due in the 3 days
    // before the visit). None on file is nothing he can act on: no line
    // (Oct 27 2026, the noise Jordan asked to drop).
    const conf = confirmations.find((t) => t.projectId === p.id && (!t.dueAt || (t.dueAt.getTime() <= start.getTime() && t.dueAt.getTime() >= start.getTime() - 3 * DAY))) ?? null;
    if (conf) chips.push(conf.status === "COMPLETED" ? { key: "confirm", label: "Confirmation sent", tone: "ok" }
      : conf.status === "CANCELLED" ? { key: "confirm", label: "Confirmed another way", tone: "ok" }
      : { key: "confirm", label: "Not confirmed yet (Kyle)", tone: "info" });
    // ACCESS IS KYLE'S (Jordan, Oct 26 2026: "no access details are not
    // needed for him - really for kyle. But monthly content doesnt need
    // access info"). Kyle's desk and the night-before task chase it; the
    // creative's list says only what is on file, and nothing on a session.
    if (!p.contentMonthId && (acc.lockbox || acc.access || acc.presence)) chips.push({ key: "access", label: "Access noted", tone: "ok" });
    // THE SHOOT-DAY BRIEF, ONLY WHEN IT NEEDS HIM (Jordan, Oct 27 2026:
    // "Brief sent, got it to tap - No idea what that is or why it matters").
    // It matters once: the text went out and Kyle's desk shows the brief as
    // unconfirmed until he taps Got it. So a sent (or changed) brief for a
    // visit not yet begun is the row's button, "Mark brief read" (the brief
    // page's own Got it); a confirmed one is a tick; off, not sent yet or
    // Kyle's to fix says nothing here. "Shoot brief to read" is gone ("why
    // does that matter?"): nobody waits on that receipt.
    const b = briefs?.get(v.id) ?? null;
    const briefWaits = !!b && (b.state === "sent" || b.state === "changed") && !started;
    if (b?.state === "acknowledged") chips.push({ key: "brief", label: "Brief confirmed", tone: "ok" });
    const read = briefReads.filter((r) => r.projectId === p.id).sort((a, b) => b.readAt.getTime() - a.readAt.getTime())[0] ?? null;
    // A shot list is said when there is one, never when there isn't
    // (Jordan, Oct 27 2026: "if there is none, then just don't show that").
    if (video && (!!p.reelShotList?.trim() || outputs.some((o) => o.projectId === p.id))) chips.push({ key: "shotlist", label: "Shot list ready", tone: "ok" });
    if (p.scriptingId) {
      const st = p.scriptingStatus ?? "";
      chips.push(STUDIO_READY.has(st) || !!p.scriptingScript?.trim()
        ? { key: "direction", label: `Agent script ${STUDIO_WORDS[st] ?? "ready"}`, tone: "ok" }
        : { key: "direction", label: `Agent script ${STUDIO_WORDS[st] ?? "not ready"}`, tone: "todo" });
    } else if (p.contentMonthId) {
      const n = monthScripts.find((m) => m.monthId === p.contentMonthId)?._count ?? 0;
      chips.push(n > 0 ? { key: "direction", label: `${plural(n, "script")} approved for the session`, tone: "ok" } : { key: "direction", label: "No approved scripts for the session yet", tone: "todo" });
    } else if (video && resolveVideoSpec({ deliverables: p.deliverables, orderItems: p.orderItems, packageName: p.packageName, isPremium: videoTier(live) === "premium" }).spec.requireScript) {
      // Oct 26 2026: only a video that takes a script waits on one (the
      // listing-script rule, 9b89919). "Agent direction to write" asked him to
      // write lines for an agent-intro reel, which has no script: the agent's
      // words are typed at upload exactly as delivered.
      chips.push(p.reelScript?.trim() ? { key: "direction", label: "Script ready", tone: "ok" } : { key: "direction", label: "Script not in yet (Script Writing)", tone: "info" });
    }
    // The visit is OVER and the field has recorded nothing: said as exactly
    // that (never "shot", never "uploaded"), with Finish handoff on the row.
    // While it is still on, nothing is missing yet.
    if (over) chips.unshift({ key: "field", label: "Nothing recorded from the field yet", tone: "todo" });
    const askRows = asks.filter((a) => a.projectId === p.id);
    const reqs = askRows.map((a) => clean(a.summary?.trim() || a.text, 140));
    // A special request is in the shoot brief (its must-gets), listed on the
    // row itself. Said as a count; the brief receipt is no longer chased.
    const unread = askRows.filter((a) => !read || a.askedAt > read.readAt).length;
    if (askRows.length) chips.push(unread === 0 ? { key: "requests", label: `${plural(askRows.length, "special request")}, in the brief you read`, tone: "ok" }
      : { key: "requests", label: `${plural(askRows.length, "special request")} in the brief`, tone: "info" });
    const isToday = dayKey === today;
    const status: ShootRow["status"] = over ? { label: "Handoff due", tone: "todo" }
      : started ? { label: "Filming now", tone: "info" }
      : briefWaits ? { label: b?.state === "changed" ? "Brief changed" : "Brief to confirm", tone: "todo" }
      : isToday ? { label: "Today", tone: "info" }
      : null;
    return {
      id: v.id,
      projectId: p.id,
      street: streetOf(p.title),
      clientName: p.client ? clean(p.client.name, 80) : null,
      whenISO: start.toISOString(),
      endISO: end.toISOString(),
      dayKey,
      today: isToday,
      whenWords: `${isToday ? "Today" : etDate(start)} ${etTime(start)}`,
      services: services.length ? services.map((s) => clean(s, 60)) : [...new Set(live.map((d) => clean(d.label ?? d.type, 60)))],
      chips,
      missing: [...(briefWaits ? ["Shoot-day brief to confirm"] : []), ...chips.filter((c) => c.tone === "todo").map((c) => c.label)],
      requests: reqs,
      links: [
        { label: "Open brief", href: `/shoot/${p.id}` },
        { label: "Daily brief", href: `/shoot/brief/${dayKey}` },
        ...(p.scriptingUrl ? [{ label: "Script Studio", href: p.scriptingUrl, external: true }] : []),
      ],
      started,
      over,
      status,
      // The version to confirm is filled in below (one build per day).
      briefAck: briefWaits ? { day: dayKey, digest: "", again: b?.state === "changed" } : null,
      finishHref: `/upload/${p.id}#capture`,
    };
  });
  // The day's brief as his Got it page builds it: its digest is the version
  // he confirms (acknowledgeBrief refuses any other). A day that can't be
  // built keeps no button; the brief page still has its own Got it.
  const ackDays = [...new Set(mine.filter((s) => s.briefAck).map((s) => s.dayKey))];
  if (ackDays.length) {
    const built = await import("@/lib/photographerBrief").then((m) => m.buildBriefDays(ackDays, { now, teamMemberIds: [tmId] })).catch(() => null);
    for (const s of mine) {
      if (!s.briefAck) continue;
      const digest = built?.briefs.find((x) => x.teamMemberId === tmId && x.day === s.dayKey)?.digest ?? "";
      s.briefAck = /^[a-f0-9]{32}$/.test(digest) ? { ...s.briefAck, digest } : null;
    }
  }

  // Handoffs: his own visits before today (or today, once the field recorded
  // something) whose handoff is not complete.
  const handedProjects = projects.filter((p) => {
    if (p.status === "DELIVERED") return false;
    const pv = visits.filter((v) => v.projectId === p.id && liveAppt(v));
    const past = pv.some((v) => v.startAt! < dayStart);
    const recorded = pv.some((v) => v.startAt! >= dayStart && visitEvidence(v));
    const stillAhead = upcoming.some((v) => v.projectId === p.id);
    return (past || recorded) && !stillAhead;
  });
  const allHandoffs = await handoffRows(handedProjects, visits, drafts, ctx, true);

  // The team he supervises: the other field creatives' last two weeks.
  const team = await readTeamHandoffs(ctx).catch((e: unknown) => { console.warn("creativeDesk: team handoffs failed", (e as Error).message); return null; });
  // The rows he closed out (lib/handoffCloseOut), while they read as they did then.
  const closedRow = ctx.myKey ? await prisma.appSetting.findUnique({ where: { key: handoffClosedKey(ctx.myKey) }, select: { value: true } }).catch(() => null) : null;
  const closed = readClosedHandoffs(closedRow?.value);
  const open = (rows: HandoffRow[]) => rows.filter((r) => !isClosedOut(r, closed, now));
  const handoffs = open(allHandoffs);
  const teamOpen = open(team ?? []);
  const closedOut = allHandoffs.length - handoffs.length + (team ?? []).length - teamOpen.length;
  return { mine, handoffs: handoffs.slice(0, 40), team: teamOpen, unavailable: team === null, myShootsHref, closedOut, fullHref: PRODUCTION_HREF };
}

async function handoffRows(
  projects: ProdProject[],
  visits: { projectId: string; startAt: Date | null; status: string | null; completedAt: Date | null }[],
  drafts: { projectId: string; savedAt: Date }[],
  ctx: Ctx,
  mine: boolean,
): Promise<HandoffRow[]> {
  if (!projects.length) return [];
  const ids = projects.map((p) => p.id);
  const [{ missingInstructionsFor }, flags] = await Promise.all([
    import("@/lib/missingInstructions"),
    prisma.activity.findMany({ where: { projectId: { in: ids }, type: "FLAG" }, orderBy: { createdAt: "desc" }, select: { projectId: true, body: true } }),
  ]);
  // Every job's missing-instructions read at once (each is its own few
  // queries; one after another they were most of this desk's wait).
  const missingOf = new Map(await Promise.all(projects.map(async (p) => [p.id, await missingInstructionsFor(p.id).catch(() => null)] as const)));
  const out: HandoffRow[] = [];
  for (const p of projects) {
    const halves = liveHandoffCategories(p.deliverables);
    const open = halves.filter((h) => !categoryHandoffAt(p, h));
    const missing = missingOf.get(p.id) ?? null;
    const missingWords = missing ? [...missing.video, ...missing.photos].map((m) => clean(m, 120)) : [];
    if (!open.length && !missingWords.length) continue;
    const pv = visits.filter((v) => v.projectId === p.id && liveAppt(v)).sort((a, b) => a.startAt!.getTime() - b.startAt!.getTime());
    const lastVisit = pv.filter((v) => v.startAt! < ctx.now).at(-1)?.startAt ?? p.shootDate ?? null;
    const ev = handoffEvidence({ deliverables: p.deliverables, statusEvidence: p.statusEvidence, photosHandoffAt: p.photosHandoffAt, videoHandoffAt: p.videoHandoffAt, debriefSubmittedAt: p.debriefSubmittedAt, handoffReadyAt: p.handoffReadyAt, handoffBlockedReason: p.handoffBlockedReason });
    const draft = drafts.find((d) => d.projectId === p.id) ?? null;
    const fieldDone = pv.some((v) => !!v.completedAt);
    const lines: Chip[] = [];
    const half = (c: HandoffCategory) => ev.find((e) => e.category === c);
    for (const c of halves) {
      const e = half(c)!;
      const name = c === "photos" ? "Photos" : "Video";
      if (e.handoffSubmitted) lines.push({ key: `${c}-in`, label: `${name} handed off ${etDate(e.handoffSubmitted)}`, tone: "ok" });
      else if (e.uploadReported || e.filesDetected === "yes") lines.push({ key: `${c}-in`, label: `${name}: files in, upload page not submitted`, tone: "todo" });
      else lines.push({ key: `${c}-in`, label: `${name}: no upload recorded`, tone: "todo" });
    }
    if (halves.includes("video")) {
      const v = half("video")!;
      if (v.readyToEdit && "at" in v.readyToEdit) lines.push({ key: "ready", label: "Ready for the editor", tone: "ok" });
      else if (v.readyToEdit && "blocked" in v.readyToEdit) lines.push({ key: "ready", label: `Editor handoff blocked: ${clean(v.readyToEdit.blocked, 100)}`, tone: "todo" });
    }
    const exceptions = [
      ...p.deliverables.filter((d) => d.notCompletedReason).map((d) => `Couldn't complete ${clean(d.label ?? d.type, 40)}: ${clean(d.notCompletedReason, 120)}`),
      ...flags.filter((f) => f.projectId === p.id && isFieldFlag(f.body)).slice(0, 2).map((f) => `Flagged: ${clean(f.body, 140)}`),
    ];
    const anyEvidence = fieldDone || draft || ev.some((e) => e.uploadReported || e.filesDetected === "yes" || e.handoffSubmitted) || p.deliverables.some((d) => d.capturedAt);
    const status = open.length
      ? anyEvidence
        ? draft && !ev.some((e) => e.handoffSubmitted) ? "Upload started, not submitted" : `${open.map((h) => (h === "photos" ? "Photos" : "Video")).join(" and ")} not handed off yet`
        : `Nothing recorded since the visit${lastVisit ? ` on ${etDate(lastVisit)}` : ""}`
      : `Handed off; instructions missing`;
    out.push({
      projectId: p.id,
      street: streetOf(p.title),
      clientName: p.client ? clean(p.client.name, 80) : null,
      photographer: clean(p.photographer?.name ?? "Unassigned", 60),
      mine,
      visitISO: lastVisit?.toISOString() ?? null,
      status,
      tone: "todo",
      lines,
      missing: missingWords,
      exceptions,
      sig: handoffSig({ status, lines, missing: missingWords, exceptions }),
      // Straight to the part of the upload page that is missing: what was
      // captured (nothing recorded yet), or the notes and submit (Oct 27 2026).
      finishHref: `/upload/${p.id}#${anyEvidence ? "submit" : "capture"}`,
      links: [
        { label: open.length ? "Upload" : "Finish handoff", href: `/upload/${p.id}` },
        { label: "Flag an issue", href: `/shoot/${p.id}` },
      ],
    });
  }
  return out;
}

async function readTeamHandoffs(ctx: Ctx): Promise<HandoffRow[]> {
  const { now, tmId, ex } = ctx;
  const [owners, team] = await Promise.all([
    prisma.appUser.findMany({ where: { role: "OWNER", status: "ACTIVE", teamMemberId: { not: null } }, select: { teamMemberId: true } }),
    prisma.teamMember.findMany({ where: { active: true, role: "PHOTOGRAPHER", creativeManager: false }, select: { id: true, name: true } }),
  ]);
  const ownerIds = new Set(owners.map((o) => o.teamMemberId!));
  const field = team.filter((t) => t.id !== tmId && !ownerIds.has(t.id) && !/^jordan\b/i.test(t.name.trim())).map((t) => t.id);
  if (!field.length) return [];
  const dayStart = etDayStartUtc(now);
  const visits = await prisma.appointment.findMany({
    where: {
      status: "SCHEDULED",
      startAt: { gte: new Date(dayStart.getTime() - 14 * DAY), lt: now },
      OR: [{ assignedToId: { in: field } }, { assignedToId: null, project: { photographerId: { in: field } } }],
      project: { status: { notIn: ["CANCELLED", "ON_HOLD", "DELIVERED"] }, ...(ex.length ? { clientId: { notIn: ex } } : {}) },
    },
    select: { projectId: true, startAt: true, status: true, completedAt: true },
    take: 200,
  });
  const ids = [...new Set(visits.map((v) => v.projectId))];
  if (!ids.length) return [];
  const [projects, drafts] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: ids } }, select: PROD_SELECT }),
    prisma.uploadDraft.findMany({ where: { projectId: { in: ids }, consumedAt: null }, select: { projectId: true, savedAt: true } }),
  ]);
  const rows = await handoffRows(projects, visits, drafts, ctx, false);
  return rows.sort((a, b) => (a.visitISO ?? "").localeCompare(b.visitISO ?? "")).slice(0, 60);
}

// ---- C · creative review ---------------------------------------------------------------------

async function readReview(ctx: Ctx, includeTest: boolean): Promise<CreativeDesk["review"]> {
  const [{ getReviewQueue }, settings, coverage] = await Promise.all([
    import("@/lib/reviewRoom"),
    import("@/lib/settings").then((m) => m.reviewRoomRules()),
    import("@/lib/coverage").then(async (m) => ({ rules: await m.coverageRules(), between: m.coveredHoursBetween })),
  ]);
  const q = await getReviewQueue({ includeTest });
  const coverHours = settings.coverOfferHours;
  const live = [...q.pending, ...q.waitingOnCheck];
  const ids = [...new Set(live.map((s) => s.projectId))];
  const [projects, notes, asks, assigned] = await Promise.all([
    ids.length ? prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, promisedDueAt: true, promisedTargetAt: true } }) : Promise.resolve([]),
    ids.length ? prisma.mediaNote.findMany({ where: { projectId: { in: ids }, parentId: null, lane: "EDITOR", NOT: { authorKey: { startsWith: "editor:" } } }, select: { projectId: true, status: true, createdAt: true } }) : Promise.resolve([]),
    ids.length ? prisma.clientAsk.findMany({ where: { projectId: { in: ids }, kind: "SPECIAL_REQUEST", state: "OPEN", NOT: { medium: "photo" } }, select: { projectId: true, summary: true, text: true } }) : Promise.resolve([]),
    live.length ? prisma.reviewSubmission.findMany({ where: { id: { in: live.map((s) => s.id) } }, select: { id: true, reviewerAssignedAt: true } }) : Promise.resolve([]),
  ]);
  const row = (s: (typeof live)[number]): CutRow => {
    const p = projects.find((x) => x.id === s.projectId);
    const due = p?.promisedTargetAt ?? p?.promisedDueAt ?? null;
    const entered = new Date(s.createdAt);
    const since = assigned.find((a) => a.id === s.id)?.reviewerAssignedAt ?? entered;
    const hours = coverage.between(since, ctx.now, coverage.rules);
    const prior = notes.filter((n) => n.projectId === s.projectId && n.createdAt < entered);
    const mine = !!ctx.tmId && s.reviewer?.id === ctx.tmId;
    const delayed = hours >= coverHours;
    return {
      id: s.id,
      projectId: s.projectId,
      street: streetOf(s.street),
      clientName: s.clientName ? clean(s.clientName, 80) : null,
      version: s.round,
      label: s.fileName ? clean(s.fileName, 80) : null,
      editor: s.editorName ? clean(s.editorName, 60) : null,
      reviewer: s.reviewer ? clean(s.reviewer.name, 60) : null,
      mine,
      enteredISO: entered.toISOString(),
      waitedHours: Math.round(hours * 10) / 10,
      waitedWords: waitedWords(hours),
      delayed,
      heldForCheck: s.heldForCheck,
      dueISO: due?.toISOString() ?? null,
      dueWords: due ? dueWordsFor(due.toISOString(), ctx.now) : null,
      priorNotes: { total: prior.length, open: prior.filter((n) => n.status === "OPEN").length },
      asks: asks.filter((a) => a.projectId === s.projectId).map((a) => clean(a.summary?.trim() || a.text, 140)),
      href: `/review/${s.projectId}?cut=${s.id}`,
      why: s.heldForCheck ? "Waiting on the editor's own check before it can be reviewed" : delayed ? `Past the room's ${coverHours}-hour cover window` : null,
    };
  };
  const byAge = (a: CutRow, b: CutRow) => a.enteredISO.localeCompare(b.enteredISO);
  // Ready for him: his, or nobody's (he is the creative approver), and checked.
  const ready = q.pending.filter((s) => !s.heldForCheck && (!s.reviewer || (!!ctx.tmId && s.reviewer.id === ctx.tmId))).map(row).sort(byAge);
  // Delayed elsewhere: someone else's cut past the cover window, or an
  // editor's check that has held a version that long. Never a copy of a row above.
  const delayed = live
    .filter((s) => !ready.some((r) => r.id === s.id))
    .map(row)
    .filter((r) => r.delayed)
    .sort(byAge);
  return { ready, delayed, coverHours, unavailable: false };
}

// ---- F · creative preparation ------------------------------------------------------------------

async function readPrep(ctx: Ctx, people: { jordan: string; me: string }): Promise<PrepRow[]> {
  const { now, tmId, appUserId, email, ex } = ctx;
  const out: PrepRow[] = [];
  const dayStart = etDayStartUtc(now);
  const horizon = new Date(dayStart.getTime() + 14 * DAY);
  const clientScope = ex.length ? { clientId: { notIn: ex } } : {};

  // LISTING: his upcoming listing shoots with an agent script in Script
  // Studio. Script Studio writes it, James approves it there and films it
  // (Jordan, Oct 27 2026 Loom: "I don't need to approve the scripts, James can
  // approve them").
  if (tmId) {
    const listing = await prisma.appointment.findMany({
      where: { status: "SCHEDULED", startAt: { gte: dayStart, lt: horizon }, OR: [{ assignedToId: tmId }, { assignedToId: null, project: { photographerId: tmId } }], project: { scriptingId: { not: null }, status: { notIn: ["CANCELLED", "ON_HOLD", "DELIVERED"] }, ...clientScope } },
      orderBy: { startAt: "asc" },
      take: 20,
      select: { startAt: true, project: { select: { id: true, title: true, scriptingStatus: true, scriptingUrl: true, client: { select: { name: true } } } } },
    });
    const seen = new Set<string>();
    for (const a of listing) {
      if (seen.has(a.project.id)) continue;
      seen.add(a.project.id);
      const st = a.project.scriptingStatus ?? "";
      const deadlineWords = a.startAt ? `Shoot ${etDayKey(a.startAt) === etDayKey(now) ? `today ${etTime(a.startAt)}` : etDateTime(a.startAt)}` : null;
      const status = st ? `Script ${STUDIO_WORDS[st] ?? st.replace(/_/g, " ")}` : "No script status yet";
      out.push({
        key: `listing:${a.project.id}`,
        kind: "listing",
        projectId: a.project.id,
        detail: [deadlineWords, status].filter(Boolean).join(" · "),
        title: `Listing script · ${streetOf(a.project.title)}`,
        clientName: a.project.client ? clean(a.project.client.name, 80) : null,
        mode: "JAMES_OWNS",
        writer: "Script Studio",
        approver: people.me,
        role: "You approve it and film it",
        source: "Script Studio (listing scripts are written there; you approve them)",
        deadlineISO: a.startAt?.toISOString() ?? null,
        deadlineWords,
        status,
        // Open script: Script Studio when the job links one, else the brief's script part.
        links: [
          ...(a.project.scriptingUrl ? [{ label: "Open script", href: a.project.scriptingUrl, external: true }] : [{ label: "Open script", href: `/shoot/${a.project.id}#script` }]),
          { label: "Open brief", href: `/shoot/${a.project.id}` },
        ],
      });
    }
  }

  // MONTHLY: the ownership records, read directly (ownersFor would mint
  // defaults; this read writes nothing): MONTH, then ENROLLMENT, then DEFAULT.
  const enrollments = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", ...clientScope }, select: { id: true, clientId: true } });
  if (!enrollments.length) return out;
  const clientNames = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(enrollments.map((e) => e.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name] as const));
  const monthKeys = [etMonthKey(now), etMonthKey(new Date(dayStart.getTime() + 32 * DAY))];
  const months = await prisma.contentMonth.findMany({ where: { enrollmentId: { in: enrollments.map((e) => e.id) }, monthKey: { in: monthKeys } }, select: { id: true, enrollmentId: true, monthKey: true, strategyCallAt: true, strategyCallStatus: true } });
  const owners = await prisma.programOwnerAssignment.findMany({
    where: { endedAt: null, duty: { in: ["SCRIPTS", "STRATEGY"] }, OR: [{ scope: "DEFAULT" }, { scope: "ENROLLMENT", scopeRef: { in: enrollments.map((e) => e.id) } }, ...(months.length ? [{ scope: "MONTH", scopeRef: { in: months.map((m) => m.id) } }] : [])] },
    select: { scope: true, scopeRef: true, duty: true, appUserId: true, teamMemberId: true, label: true },
  });
  const ownerOf = (duty: "SCRIPTS" | "STRATEGY", enrollmentId: string, monthId: string | null) =>
    (monthId ? owners.find((o) => o.duty === duty && o.scope === "MONTH" && o.scopeRef === monthId) : undefined) ??
    owners.find((o) => o.duty === duty && o.scope === "ENROLLMENT" && o.scopeRef === enrollmentId) ??
    owners.find((o) => o.duty === duty && o.scope === "DEFAULT") ??
    null;
  const isMe = (o: { appUserId: string | null; teamMemberId: string | null } | null) => !!o && ((!!appUserId && o.appUserId === appUserId) || (!!tmId && o.teamMemberId === tmId));
  const ownerName = (o: { label: string | null } | null) => (o?.label ? first(o.label) : "Unassigned");

  // The filming sessions he shoots (production input), the next two weeks.
  const sessions = tmId ? await prisma.programSessionRequest.findMany({
    where: { status: "CONFIRMED", slotStart: { gte: dayStart, lt: horizon }, enrollmentId: { in: enrollments.map((e) => e.id) }, projectId: { not: null } },
    select: { enrollmentId: true, monthId: true, slotStart: true, projectId: true },
    orderBy: { slotStart: "asc" },
  }) : [];
  const sessionProjects = sessions.length ? await prisma.project.findMany({ where: { id: { in: sessions.map((s) => s.projectId!) } }, select: { id: true, photographerId: true, appointments: { where: { status: "SCHEDULED" }, select: { assignedToId: true } } } }) : [];
  const filmsIt = (projectId: string | null) => {
    const p = sessionProjects.find((x) => x.id === projectId);
    return !!p && !!tmId && (p.photographerId === tmId || p.appointments.some((a) => a.assignedToId === tmId));
  };
  // The versions he wrote that wait on someone's approval.
  const drafted = email ? await prisma.contentScriptVersion.findMany({
    where: { createdBy: { equals: email, mode: "insensitive" }, status: { in: ["DRAFT", "INTERNAL_REVIEW"] } },
    select: { scriptId: true, createdAt: true },
    take: 100,
  }) : [];
  const draftedScripts = drafted.length ? await prisma.contentScript.findMany({ where: { id: { in: drafted.map((d) => d.scriptId) }, historical: false }, select: { id: true, enrollmentId: true, monthId: true, currentVersionId: true } }) : [];
  const approvedCount = months.length ? await prisma.contentScript.groupBy({ by: ["monthId"], where: { monthId: { in: months.map((m) => m.id) }, historical: false, status: { in: ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"] } }, _count: true }) : [];

  for (const e of enrollments) {
    const name = clientNames.get(e.clientId);
    const client = name ? clean(name, 80) : null;
    for (const mk of monthKeys) {
      const m = months.find((x) => x.enrollmentId === e.id && x.monthKey === mk) ?? null;
      const scripts = ownerOf("SCRIPTS", e.id, m?.id ?? null);
      const strategy = ownerOf("STRATEGY", e.id, m?.id ?? null);
      const sess = sessions.filter((s) => s.enrollmentId === e.id && (s.monthId ? s.monthId === m?.id : !!s.slotStart && etMonthKey(s.slotStart) === mk));
      const mySession = sess.find((s) => filmsIt(s.projectId)) ?? null;
      const myDrafts = draftedScripts.filter((d) => d.enrollmentId === e.id && (d.monthId ? d.monthId === m?.id : mk === monthKeys[0]));
      const ownsScripts = isMe(scripts);
      const ownsStrategy = isMe(strategy);
      if (!ownsScripts && !ownsStrategy && !myDrafts.length && !mySession) continue;
      const n = m ? approvedCount.find((x) => x.monthId === m.id)?._count ?? 0 : 0;
      const sessionAt = mySession?.slotStart ?? sess[0]?.slotStart ?? null;
      // Script approval is due the day before the session (programReminders' default).
      const deadline = sessionAt ? new Date(sessionAt.getTime() - DAY) : m?.strategyCallAt && m.strategyCallAt > now ? m.strategyCallAt : null;
      const deadlineWords = sessionAt ? `Scripts approved by ${etDateTime(deadline!)} (session ${etDate(sessionAt)})` : m?.strategyCallAt && m.strategyCallAt > now ? `Strategy call ${etDateTime(m.strategyCallAt)}` : null;
      const mode: OwnershipMode = ownsScripts ? "JAMES_OWNS" : myDrafts.length ? "JAMES_DRAFTS" : "JORDAN_OWNS";
      const monthLabel = monthName(mk);
      const status = `${plural(n, "script")} approved for ${monthLabel}`;
      out.push({
        key: `monthly:${e.id}:${mk}`,
        kind: "monthly",
        // The session's job (Add input goes to its job chat), when it has one.
        projectId: mySession?.projectId ?? sess[0]?.projectId ?? null,
        detail: [status, deadlineWords].filter(Boolean).join(" · "),
        title: `Monthly scripts · ${monthLabel}`,
        clientName: client,
        mode,
        writer: ownsScripts || myDrafts.length ? people.me : ownerName(scripts),
        approver: ownsScripts ? people.me : ownerName(scripts),
        role: mode === "JAMES_OWNS" ? `Script approval is yours for this client${ownsStrategy ? ", and the strategy" : ""}`
          : mode === "JAMES_DRAFTS" ? `${plural(myDrafts.length, "draft")} of yours waiting on ${ownerName(scripts)}'s approval`
          : mySession ? "You film the session: production input" : ownsStrategy ? "Strategy approval is yours" : "Production input",
        source: mode === "JAMES_OWNS" ? `Program owners: script approval assigned to you (${scripts?.scope.toLowerCase()})`
          : mode === "JAMES_DRAFTS" ? "Script versions you wrote, not yet approved"
          : mySession ? "The filming session is booked with you" : "Program owners",
        deadlineISO: deadline?.toISOString() ?? null,
        deadlineWords,
        status,
        links: [
          { label: "Scripts", href: contentHref(e.id, { tab: "plan", view: "scripts", month: mk, now }) },
          { label: "Discovery and strategy", href: contentHref(e.id, { tab: "plan", view: "strategy", month: mk, now }) },
          { label: "Preferences", href: contentHref(e.id, { tab: "brand", now }) },
        ],
      });
    }
  }
  return out.sort((a, b) => (a.deadlineISO ?? "9").localeCompare(b.deadlineISO ?? "9"));
}

// ---- G · process improvements, H · assigned --------------------------------------------------------

const OPEN_TASK = { status: { notIn: ["COMPLETED", "CANCELLED"] } };

async function readImprovements(ctx: Ctx, roster: Assignee[]): Promise<ImprovementRow[]> {
  const tasks = await prisma.smartTask.findMany({
    where: { taskType: IMPROVEMENT_TASK_TYPE, ...OPEN_TASK },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: 100,
    select: { id: true, title: true, summary: true, description: true, assignedKey: true, status: true, dueAt: true },
  });
  if (!tasks.length) return [];
  const metas = await prisma.appSetting.findMany({ where: { key: { in: tasks.map((t) => improvementMetaKey(t.id)) } }, select: { key: true, value: true } });
  const deleg = await delegationFor(tasks.map((t) => t.id)).catch(() => new Map<string, DelegatedTask>());
  return tasks.map((t) => {
    let meta: ImprovementMeta | null = null;
    try { const raw = metas.find((m) => m.key === improvementMetaKey(t.id))?.value; meta = raw ? (JSON.parse(raw) as ImprovementMeta) : null; } catch { meta = null; }
    const d = deleg.get(t.id);
    const owner = roster.find((r) => r.key === (d?.assigneeKey ?? t.assignedKey))?.name ?? (t.assignedKey ? t.assignedKey : "Unassigned");
    return {
      taskId: t.id,
      friction: meta?.friction ?? null,
      problem: clean(t.summary || t.title, 200),
      area: meta?.area ? clean(meta.area, 40) : null,
      owner: clean(owner, 40),
      nextStep: clean(d?.nextStep ?? meta?.nextStep ?? null, 200) || null,
      outcome: clean(d?.outcome ?? meta?.outcome ?? t.description ?? null, 200) || null,
      policy: !!meta?.policy,
      status: d ? STATE_WORDS[d.state] : t.status === "OPEN" ? "Open" : t.status.replace(/_/g, " ").toLowerCase(),
      dueISO: t.dueAt?.toISOString() ?? null,
      mine: (d?.assigneeKey ?? t.assignedKey) === ctx.myKey,
    };
  });
}

/**
 * RECURRING FRICTION, from the team signals the hub already counts (Oct 27
 * 2026, Jordan: "Process improvement - figure out what needs to go here and
 * what should be in here"). Coaching (D) is about one person; this is the
 * same evidence added up across people, as a process to fix: late uploads,
 * handoffs without instructions, a photo check finding on many shoots, a
 * revision cause the editors repeat. A row needs at least two counted cases;
 * a QC pass reopened by a revision stays in coaching (a revision does not
 * prove QC missed it). Never a number the hub did not count.
 */
export function frictionsFrom(signals: Signal[], improvements: ImprovementRow[]): FrictionRow[] {
  type Kind = { title: (n: number) => string; evidence: (n: number) => string; area: FrictionRow["area"]; action: string; problem: string; nextStep: string };
  const KPI: Record<string, Kind> = {
    upload: { title: () => "Late uploads", evidence: (n) => `${plural(n, "late upload")} this KPI period`, area: "Uploads and handoffs", action: "Fix late uploads", problem: "Shoot uploads land after their deadline", nextStep: "Find where the time goes between the visit and the upload, then set the fix with the field team" },
    handoff: { title: () => "Handoffs without instructions", evidence: (n) => `${plural(n, "handoff")} missing instructions this KPI period`, area: "Uploads and handoffs", action: "Fix handoff notes", problem: "Handoffs reach the editors without their instructions", nextStep: "Make the instructions part of the upload page's submit for the field team" },
    capture: { title: () => "Capture misses", evidence: (n) => `${n} capture ${n === 1 ? "miss" : "misses"} this KPI period`, area: "Shot lists", action: "Tighten the shot list", problem: "Shots missed or redone after the visit", nextStep: "Add the missed shots to the shot list and the shoot brief" },
    client: { title: () => "Client direction complaints", evidence: (n) => `${plural(n, "complaint")} this KPI period`, area: "Client direction", action: "Fix client direction", problem: "Clients unhappy with direction on the shoot", nextStep: "Agree what the field team says and does on arrival" },
  };
  const groups = new Map<string, { kind: Kind; count: number; people: Set<string>; examples: Evidence[] }>();
  const add = (key: string, kind: Kind, s: Signal) => {
    const g = groups.get(key) ?? { kind, count: 0, people: new Set<string>(), examples: [] };
    g.count += s.count;
    g.people.add(first(s.personName) || s.personName);
    g.examples.push(...s.examples);
    groups.set(key, g);
  };
  for (const s of signals) {
    if (!(s.count > 0)) continue;
    const parts = s.key.split(":");
    if (s.group === "FIELD" && parts[2] === "kpi" && KPI[parts[3]]) add(`friction:kpi:${parts[3]}`, KPI[parts[3]], s);
    else if (s.group === "FIELD" && parts[2] === "photoqc") {
      const label = s.skill.replace(/^Photo check:\s*/, "");
      add(`friction:photoqc:${parts.slice(3).join(":")}`, { title: () => `Photo check: ${label}`, evidence: (n) => `Found on ${plural(n, "shoot")} in 30 days`, area: "Quality checklists", action: "Add to the shoot checklist", problem: `The photo check keeps finding "${label}" on shoots`, nextStep: `Add "${label}" to the field checklist and the shoot brief` }, s);
    } else if (s.group === "EDITOR" && s.key.includes(":recurring:")) {
      add(`friction:edit:${s.key.split(":recurring:")[1]}`, { title: () => `Repeat revision: ${s.skill}`, evidence: (n) => `${plural(n, "revision")} in 60 days traced to the edit`, area: "Quality checklists", action: "Add to the edit checklist", problem: `Revisions keep coming back for ${s.skill}`, nextStep: `Add ${s.skill} to the editors' check before review` }, s);
    } else if (s.group === "EDITOR" && s.key.endsWith(":missed")) {
      add("friction:edit:missed", { title: () => "Fixes that came back unfixed", evidence: (n) => `${n} ${n === 1 ? "fix" : "fixes"} missed in a later version, 60 days`, area: "Review procedure", action: "Fix the revision check", problem: "Asked-for fixes come back unfixed in the next version", nextStep: "Have every revision checked against the earlier notes before it goes back to review" }, s);
    }
  }
  return [...groups]
    .filter(([, g]) => g.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([key, g]) => ({
      key,
      title: clean(g.kind.title(g.count), 120),
      evidence: clean(`${g.kind.evidence(g.count)} · ${[...g.people].join(", ")}`, 160),
      count: g.count,
      area: g.kind.area,
      action: g.kind.action,
      problem: clean(g.kind.problem, 200),
      nextStep: clean(g.kind.nextStep, 200),
      examples: g.examples.slice(0, 4),
      taskId: improvements.find((i) => i.friction === key)?.taskId ?? null,
    }));
}

export const STATE_WORDS: Record<DelegationState | "OPEN" | "WAITING", string> = {
  ASSIGNED: "Awaiting acceptance",
  ACCEPTED: "Accepted",
  IN_PROGRESS: "In progress",
  BLOCKED: "Blocked",
  READY_FOR_VERIFICATION: "Ready for Jordan to verify",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  OPEN: "Open",
  WAITING: "Waiting",
};

/** The first hub page a task's text names, e.g. "(/edit/abc)" or "/content/xyz". */
const pathIn = (text: string | null | undefined): string | null => {
  const m = /(?:^|[\s(])(\/(?:content|projects|edit|review|upload|shoot|clients|scripts)\/[A-Za-z0-9_-]+(?:[?#][^\s)]*)?)/.exec(text ?? "");
  return m ? m[1] : null;
};

async function readAssigned(ctx: Ctx, roster: Assignee[], exclude: Set<string>): Promise<AssignedRow[]> {
  if (!ctx.myKey) return [];
  const [delegated, own] = await Promise.all([
    tasksAssignedTo(ctx.myKey),
    // EVERY OPEN TASK OF HIS (Oct 27 2026): his key, or his Team row on a
    // task with no key (taskAging's rule), whatever engine minted it: brand
    // updates to confirm, a content program's mid-month check, a tag.
    prisma.smartTask.findMany({
      where: { OR: [{ assignedKey: ctx.myKey }, ...(ctx.tmId ? [{ assignedKey: null, ownerId: ctx.tmId }] : [])], ...OPEN_TASK, NOT: { taskType: IMPROVEMENT_TASK_TYPE } },
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: 100,
      select: { id: true, title: true, summary: true, description: true, status: true, dueAt: true, flaggedBy: true, blockedReason: true, projectId: true, clientId: true, dedupeKey: true },
    }),
  ]);
  const extra = await delegationFor(own.map((t) => t.id).filter((id) => !delegated.some((d) => d.taskId === id))).catch(() => new Map<string, DelegatedTask>());
  const endToday = etDayBoundsUtc(etDayKey(ctx.now)).end;
  const rows = new Map<string, AssignedRow>();
  const fromDelegated = (d: DelegatedTask): AssignedRow => {
    const due = d.dueAt ? new Date(d.dueAt) : null;
    const overdue = !!due && due < ctx.now && d.state !== "COMPLETED";
    return {
      taskId: d.taskId,
      title: clean(d.title, 160),
      outcome: d.outcome ? clean(d.outcome, 200) : null,
      assignedBy: d.assignedBy ? clean(roster.find((r) => r.email?.toLowerCase() === d.assignedBy?.toLowerCase())?.name ?? d.assignedBy, 60) : null,
      dueISO: d.dueAt,
      dueWords: dueWordsFor(d.dueAt, ctx.now),
      overdue,
      urgent: overdue || d.state === "BLOCKED" || (!!due && due < endToday),
      state: d.state,
      stateWords: STATE_WORDS[d.state],
      blocker: d.blocker ? clean(d.blocker, 200) : null,
      nextStep: d.nextStep ? clean(d.nextStep, 200) : null,
      latestUpdate: d.latestUpdate ? clean(d.latestUpdate, 200) : null,
      needsVerification: d.needsVerification,
      delegated: true,
      closesItself: false,
      href: d.sourceHref && d.sourceHref.startsWith("/") ? d.sourceHref : d.projectId ? `/projects/${d.projectId}` : "/tasks",
    };
  };
  for (const d of delegated) {
    if (d.state === "COMPLETED" || d.state === "CANCELLED" || exclude.has(d.taskId)) continue;
    rows.set(d.taskId, fromDelegated(d));
  }
  for (const t of own) {
    if (rows.has(t.id) || exclude.has(t.id)) continue;
    const d = extra.get(t.id);
    if (d) { if (d.state !== "COMPLETED" && d.state !== "CANCELLED") rows.set(t.id, fromDelegated(d)); continue; }
    const overdue = !!t.dueAt && t.dueAt < ctx.now;
    const state: AssignedRow["state"] = t.status === "BLOCKED" ? "BLOCKED" : t.status === "IN_PROGRESS" ? "IN_PROGRESS" : t.status.startsWith("WAITING") ? "WAITING" : "OPEN";
    rows.set(t.id, {
      taskId: t.id,
      title: clean(t.title, 160),
      outcome: t.summary ? clean(t.summary, 200) : null,
      assignedBy: t.flaggedBy ? clean(t.flaggedBy, 60) : null,
      dueISO: t.dueAt?.toISOString() ?? null,
      dueWords: t.dueAt ? dueWordsFor(t.dueAt.toISOString(), ctx.now) : null,
      overdue,
      urgent: overdue || state === "BLOCKED" || (!!t.dueAt && t.dueAt < endToday),
      state,
      stateWords: STATE_WORDS[state],
      blocker: t.blockedReason ? clean(t.blockedReason, 200) : null,
      nextStep: null,
      latestUpdate: null,
      needsVerification: false,
      delegated: false,
      closesItself: !!t.dedupeKey?.startsWith("brand-ack:"),
      // The page the task itself names (a brand update's edit brief, a
      // program's /content page), else its job, else its client.
      href: pathIn(t.description) ?? (t.projectId ? `/projects/${t.projectId}` : t.clientId ? `/clients/${t.clientId}` : "/tasks"),
    });
  }
  return [...rows.values()].sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.dueISO ?? "9").localeCompare(b.dueISO ?? "9"));
}

// ---- the whole desk -------------------------------------------------------------------------

export type DeskViewer = { id?: string | null; name?: string | null; email?: string | null; role: string; realRole?: string; teamMemberId: string | null; impersonating?: boolean };

export async function buildCreativeDesk(me: DeskViewer, opts: { now?: Date; includeTest?: boolean; only?: "development" | "production" } = {}): Promise<CreativeDesk> {
  const now = opts.now ?? new Date();
  const dayKey = etDayKey(now);
  const unavailable: string[] = [];
  const warn = (what: string) => (e: unknown) => { console.warn(`creativeDesk: ${what} failed`, (e as Error)?.message); unavailable.push(what); return null; };
  const [roster, ex] = await Promise.all([
    listAssignees().catch(() => [] as Assignee[]),
    opts.includeTest ? Promise.resolve([] as string[]) : syntheticClientIds().catch(() => [] as string[]),
  ]);
  const myKey = viewerAssigneeKey(me, roster);
  const ownerKey = roster.find((r) => r.kind === "owner")?.key ?? null;
  const jordanName = roster.find((r) => r.kind === "owner")?.name ?? "Jordan";
  const ctx: Ctx = { now, tmId: me.teamMemberId, appUserId: me.id ?? null, email: me.email ?? null, ex, myKey };
  const seat = await developmentSeat({ role: me.role, realRole: me.realRole, teamMemberId: me.teamMemberId, impersonating: me.impersonating });

  // /development reads only D, E and G (its own full lists); /production
  // only B (Oct 27 2026: the full view behind the Production card).
  const devOnly = opts.only === "development";
  const prodOnly = opts.only === "production";
  const emptyProduction: CreativeDesk["production"] = { mine: [], handoffs: [], team: [], unavailable: false, myShootsHref: "/shoot", closedOut: 0, fullHref: PRODUCTION_HREF };
  const [production, review, dev, prep, improvements] = await Promise.all([
    devOnly ? Promise.resolve(emptyProduction) : readProduction(ctx).catch(warn("your shoots")),
    devOnly || prodOnly ? Promise.resolve({ ready: [], delayed: [], coverHours: 9, unavailable: false }) : readReview(ctx, !!opts.includeTest).catch(warn("the review queue")),
    seat && !prodOnly ? readDevelopment({ now, excludeClientIds: ex, includeRecent: devOnly, decisionsBy: me.email ? [me.email] : [] }).catch(warn("team development")) : Promise.resolve(null),
    devOnly || prodOnly ? Promise.resolve([] as PrepRow[]) : readPrep(ctx, { jordan: jordanName, me: first(me.name) || "You" }).catch(warn("creative preparation")),
    prodOnly ? Promise.resolve([] as ImprovementRow[]) : readImprovements(ctx, roster).catch(warn("process improvements")),
  ]);
  const assigned = devOnly || prodOnly ? [] as AssignedRow[] : await readAssigned(ctx, roster, new Set((improvements ?? []).map((i) => i.taskId))).catch(warn("your assigned tasks"));
  // G: recurring friction, from the same signals D shows per person.
  const frictions = dev && improvements ? frictionsFrom(dev.signals, improvements) : [];

  // D: three groups, each with its own people, recorded items and signals.
  const team: CreativeDesk["team"] = dev ? {
    groups: DEV_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      blurb: g.blurb,
      people: dev.people.filter((p) => p.group === g.key).map((p) => ({ id: p.id, name: p.name })),
      items: dev.items.filter((i) => i.group === g.key && i.status === "OPEN"),
      signals: dev.signals.filter((s) => s.group === g.key),
    })),
    dueIds: dev.items.filter((i) => i.followUpDue).map((i) => i.id),
    unavailable: dev.unavailable,
    recordsUnavailable: dev.recordsUnavailable,
  } : null;
  const readiness: CreativeDesk["readiness"] = dev ? {
    items: dev.readiness,
    criteria: dev.criteria,
    people: dev.people.filter((p) => p.group === "FIELD" || p.group === "EDITOR").map((p) => ({ id: p.id, name: p.name })),
    unavailable: dev.readinessUnavailable,
  } : null;

  // H: the end-of-day check.
  const rec = myKey ? await prisma.appSetting.findUnique({ where: { key: creativeCloseoutKey(myKey, dayKey) } }).catch(() => null) : null;
  let ticks: CreativeCloseoutRecord["ticks"] = {};
  try { ticks = rec?.value ? ((JSON.parse(rec.value) as CreativeCloseoutRecord).ticks ?? {}) : {}; } catch { ticks = {}; }
  const ownHandoffs = production?.handoffs ?? null;
  const dueReviews = review ? review.ready.filter((r) => r.delayed || (!!r.dueISO && Date.parse(r.dueISO) < etDayBoundsUtc(dayKey).end.getTime())) : null;
  const dueFollowUps = team ? team.dueIds.length : null;
  const blocked = assigned ? assigned.filter((a) => a.state === "BLOCKED") : null;
  const derived: Record<CreativeCloseoutKey, { auto: boolean | null; words: string }> = {
    uploads: ownHandoffs == null ? { auto: null, words: "Your shoots couldn't be read" }
      : ownHandoffs.length === 0 ? { auto: true, words: "Every shoot of yours is handed off" }
      : { auto: false, words: `${plural(ownHandoffs.length, "handoff")} still open` },
    reviews: dueReviews == null ? { auto: null, words: "The review queue couldn't be read" }
      : dueReviews.length === 0 ? { auto: true, words: "No review of yours is due or past the window" }
      : { auto: false, words: `${plural(dueReviews.length, "cut")} due or past the window: review, or note the exception and tick` },
    coaching: dueFollowUps == null ? { auto: null, words: "Coaching couldn't be read" }
      : dueFollowUps === 0 ? { auto: true, words: "No coaching follow-up due" }
      : { auto: false, words: `${plural(dueFollowUps, "follow-up")} due: record each, or tick once noted` },
    blockers: blocked == null ? { auto: null, words: "Your tasks couldn't be read" }
      : blocked.length === 0 ? { auto: true, words: "Nothing of yours is blocked" }
      : { auto: null, words: `${plural(blocked.length, "blocked task")}: give each an owner and a next step, then tick` },
  };
  const lines: CloseoutLine[] = CLOSEOUT_ITEMS.map((c) => {
    const t = ticks[c.key] ?? null;
    const d = derived[c.key];
    return { key: c.key, label: c.label, auto: d.auto, words: d.words, tick: t ? { atISO: t.at, by: t.by } : null, done: d.auto === true || !!t };
  });

  // A: the glance, each number the length of a list below.
  const shootsToday = production ? production.mine.filter((s) => s.today).length : null;
  const reviews = review ? review.ready.length : null;
  const followUps = team ? team.dueIds.length : null;
  const urgent = assigned ? assigned.filter((a) => a.urgent).length : null;
  const parts = [
    shootsToday != null ? (shootsToday ? plural(shootsToday, "shoot") + " today" : null) : null,
    reviews ? `${plural(reviews, "cut")} ready for your review` : null,
    followUps ? `${plural(followUps, "coaching follow-up")} due` : null,
    urgent ? `${plural(urgent, "assigned task")} due or blocked` : null,
  ].filter(Boolean) as string[];
  const unknown = [shootsToday, reviews, urgent].some((n) => n == null) || (seat && followUps == null);
  const line = parts.length
    ? `${parts.join(", ")}.${unknown ? " Some sections couldn't be read: their counts may be missing items." : ""}`
    : unknown ? "Some sections couldn't be read, so this may be missing items." : "Nothing due today. Upcoming work is below.";

  return {
    nowISO: now.toISOString(),
    dayKey,
    dateWords: etFullDate(now),
    person: { name: me.name ?? "You", first: first(me.name) || "there", teamMemberId: me.teamMemberId, key: myKey },
    ownerKey,
    readOnly: !!me.impersonating,
    development: seat,
    unavailable,
    glance: { shoots: shootsToday, reviews, followUps: seat ? followUps : null, urgent, line },
    production: production ?? { mine: [], handoffs: [], team: [], unavailable: true, myShootsHref: me.teamMemberId ? `/shoot?as=${me.teamMemberId}` : "/shoot", closedOut: 0, fullHref: PRODUCTION_HREF },
    review: review ?? { ready: [], delayed: [], coverHours: 9, unavailable: true },
    team,
    readiness,
    prep: { items: prep ?? [], unavailable: prep === null },
    improvements: { items: improvements ?? [], frictions, unavailable: improvements === null },
    assigned: { items: assigned ?? [], people: roster.filter((r) => r.kind !== "vendor" && r.key !== myKey).map((r) => ({ key: r.key, name: clean(r.name, 60) })), unavailable: assigned === null },
    closeout: { dayKey, lines },
  };
}

/** The desk for the signed-in creative manager (or the owner previewing him). */
export async function creativeDeskFor(me: DeskViewer | null, opts: { now?: Date; includeTest?: boolean; only?: "development" | "production" } = {}): Promise<CreativeDesk | null> {
  if (!me) return null;
  return buildCreativeDesk(me, opts);
}
