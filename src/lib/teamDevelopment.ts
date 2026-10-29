import "server-only";
import { prisma } from "@/lib/prisma";
import { scrubMoney } from "@/lib/text";
import { etDate, etDayBoundsUtc, etDayKey } from "@/lib/datetime";
import { editorMeta } from "@/lib/editors";
import { tasksDelegatedBy } from "@/lib/delegation";

// ---------------------------------------------------------------------------
// TEAM DEVELOPMENT AND QUALITY (Oct 23 2026, Jordan's dashboard spec §6 D/E/G)
// for the creative manager's dashboard and /development. Three groups (field
// creatives, editors, admin QC), each built from REAL evidence:
//
//   · SIGNALS, read from the records the hub already keeps, never stored:
//       field  — the KPI evidence of the current period (late uploads, handoff
//                instructions, capture fixes and flags, missed coverage,
//                complaints: lib/kpiEvidence) and the free photo check's
//                findings the photographer owns that recur on two or more
//                shoots in 30 days (the photo coaching note's own filter);
//       editors — lib/editorQuality: reviewer-confirmed editing causes that
//                recur, and corrections that came back unfixed;
//       admin QC — QcRecord passes a client revision later reopened (a
//                revision is NOT proof QC missed something: said in words).
//   · RECORDED ITEMS (DevelopmentItem): what James did about it. Each keeps
//     its evidence (appended, never removed), its follow-up date and its
//     outcome, with every action in its log.
//   · READINESS (ReadinessAssessment): criteria (the KPI terms' own five, or
//     criteria James writes, labelled his), evidence, gaps, his
//     recommendation. "Recommend to Jordan" is a decision task for Jordan
//     (the delegation workflow); nothing here changes staffing or pay.
//
// No performance judgment without evidence: a signal is a count with its
// examples, never a grade; a group with nothing says so and offers "Record
// feedback". Every free-text line passes scrubMoney (James never sees a
// figure). Personnel development is the owner's and the creative manager's
// only (developmentSeat); every reader below assumes the caller checked.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;

export const DEV_GROUPS = [
  { key: "FIELD", label: "Field creatives", blurb: "Capture quality, client direction, uploads and handoffs" },
  { key: "EDITOR", label: "Editors", blurb: "Recurring editing issues, corrections against earlier feedback" },
  { key: "QC", label: "Admin QC", blurb: "QC calibration, missed issues, checklist alignment" },
] as const;
export type DevGroupKey = (typeof DEV_GROUPS)[number]["key"];
export const isDevGroup = (g: unknown): g is DevGroupKey => DEV_GROUPS.some((x) => x.key === g);

export const READINESS_TRACKS = [
  { key: "INDEPENDENT", label: "Independent work" },
  { key: "PREMIUM", label: "Premium projects" },
  { key: "SKILL", label: "A production skill" },
  { key: "SPECIALIST", label: "Creative Specialist progression" },
] as const;
export type ReadinessTrack = (typeof READINESS_TRACKS)[number]["key"];
export const isTrack = (t: unknown): t is ReadinessTrack => READINESS_TRACKS.some((x) => x.key === t);
export const trackLabel = (t: string, skill?: string | null) =>
  t === "SKILL" && skill ? `Skill: ${skill}` : READINESS_TRACKS.find((x) => x.key === t)?.label ?? t;

export const RECOMMENDATIONS = [
  { key: "READY", label: "Ready" },
  { key: "READY_WITH_SUPPORT", label: "Ready with support" },
  { key: "NOT_YET", label: "Not yet" },
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number]["key"];
export const isRecommendation = (r: unknown): r is Recommendation => RECOMMENDATIONS.some((x) => x.key === r);

/** Where the full lists live, and where Jordan's decision task points. */
export const DEVELOPMENT_HREF = "/development";
export const assessmentHref = (id: string) => `${DEVELOPMENT_HREF}?assessment=${id}`;
export const itemHref = (id: string) => `${DEVELOPMENT_HREF}?item=${id}`;

export type Evidence = { label: string; href: string | null; at: string | null; source: string };
export type DevLogKind =
  | "created" | "feedback" | "evidence" | "plan" | "practice" | "practice_recommended"
  | "follow_up_set" | "follow_up" | "verified" | "closed";
/** `notice`: the bell row that told the person (Oct 29 2026, lib/coachingNotice); `told`: how it reached them, in words, filled on read. */
export type DevLog = { at: string; by: string; kind: DevLogKind; note?: string | null; result?: string | null; notice?: string | null; told?: string | null };
export type Criterion = { key: string; label: string; source: "kpi" | "james"; covers: string | null; met: "yes" | "no" | "unknown"; evidence: string | null };

export type DevPerson = { id: string; name: string; group: DevGroupKey; editorKey: string | null; key: string | null };

export type DevItemView = {
  id: string;
  personId: string;
  personName: string;
  group: DevGroupKey;
  skill: string;
  standard: string | null;
  nextAction: string | null;
  followUpISO: string | null;
  /** the follow-up date has arrived (today or earlier, ET) and the item is open */
  followUpDue: boolean;
  practice: string | null;
  practiceDueISO: string | null;
  status: "OPEN" | "VERIFIED" | "CLOSED";
  progress: string | null;
  evidence: Evidence[];
  log: DevLog[];
  createdBy: string;
  createdISO: string;
  verifiedISO: string | null;
  verifiedBy: string | null;
  lastWords: string | null;
};

export type Signal = {
  key: string;
  group: DevGroupKey;
  personId: string;
  personName: string;
  skill: string;
  detail: string;
  /** where the numbers came from, in words */
  source: string;
  examples: Evidence[];
  /** the evidence count behind `detail`, and the same in a few words (Oct 27 2026: the dashboard's one-line rows and Process Improvements) */
  count: number;
  countWords: string;
  /** Oct 29 2026 (lib/qcCoaching): photo check findings at the property nobody has confirmed yet. Not evidence until someone does. */
  needsLook?: boolean;
  /** the photo check findings behind the row, each with the call on it (the panel's Photographer's to fix / Not an issue) */
  findings?: SignalFinding[];
  /** how often people called this check "not an issue" */
  tally?: string | null;
};

export type SignalFinding = {
  id: string;
  jobId: string;
  photoId: string | null;
  street: string;
  issue: string;
  atISO: string;
  /** a person's call on it as coaching evidence (qc_coach:<id>), or the photo desk's words that settled it */
  call: { verdict: "coach" | "not_theirs" | "wrong"; by: string; atISO: string; reason: string | null } | null;
  state: "counts" | "needs_look";
  why: string;
};

export type ReadinessView = {
  id: string;
  personId: string;
  personName: string;
  track: string;
  trackLabel: string;
  skill: string | null;
  criteria: Criterion[];
  met: number;
  gaps: string | null;
  recommendation: Recommendation | null;
  recommendationNote: string | null;
  status: "DRAFT" | "RECOMMENDED" | "WITHDRAWN";
  recommendedISO: string | null;
  createdBy: string;
  createdISO: string;
  log: DevLog[];
  /** Jordan's decision, read from the decision task (the delegation workflow) */
  decision: { state: string; words: string; update: string | null } | null;
  href: string;
};

// ---- parsing ---------------------------------------------------------------------------

const clean = (s: string | null | undefined, max = 240) => {
  // No em or en dashes on this screen (house rule): a typed " — " reads as a comma.
  const t = scrubMoney((s ?? "").replace(/\s+/g, " ").replace(/\s*[\u2014\u2013]\s*/g, ", ").trim());
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
export const cleanText = clean;

function parseList<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}
export const parseEvidence = (raw: string | null | undefined): Evidence[] =>
  parseList<Evidence>(raw).filter((e) => e && typeof e.label === "string").map((e) => ({ label: clean(e.label, 200), href: typeof e.href === "string" && e.href.startsWith("/") ? e.href : null, at: typeof e.at === "string" ? e.at : null, source: typeof e.source === "string" ? e.source : "james" }));
export const parseLog = (raw: string | null | undefined): DevLog[] =>
  parseList<DevLog>(raw).filter((l) => l && typeof l.at === "string").map((l) => ({ ...l, note: l.note ? clean(l.note, 600) : null }));
export const parseCriteria = (raw: string | null | undefined): Criterion[] =>
  parseList<Criterion>(raw).filter((c) => c && typeof c.label === "string").map((c) => ({
    key: String(c.key ?? c.label), label: clean(c.label, 140), source: c.source === "kpi" ? "kpi" : "james", covers: c.covers ? clean(c.covers, 400) : null,
    met: c.met === "yes" || c.met === "no" ? c.met : "unknown", evidence: c.evidence ? clean(c.evidence, 400) : null,
  }));

/** The KPI terms' five categories (lib/kpi HARRISON_CATEGORIES): the criteria
 *  that already exist. Labels and what each covers, never a weight or a band. */
export async function existingCriteria(): Promise<Criterion[]> {
  const { HARRISON_CATEGORIES } = await import("@/lib/kpi");
  return HARRISON_CATEGORIES.map((c) => ({ key: `kpi:${c.key}`, label: c.label, source: "kpi" as const, covers: clean(c.covers, 400), met: "unknown" as const, evidence: null }));
}

// ---- who ---------------------------------------------------------------------------------

/**
 * May this viewer read or write personnel development? The owner, and the
 * creative manager (the CREATIVE_MANAGER login, or the roster flag). A preview
 * ("view as") reads as the person previewed and never writes (the caller
 * checks `impersonating` for writes).
 */
export async function developmentSeat(me: { role: string; realRole?: string; teamMemberId: string | null; impersonating?: boolean } | null): Promise<boolean> {
  if (!me) return false;
  const role = me.impersonating ? me.role : me.realRole ?? me.role;
  if (role === "OWNER" || role === "CREATIVE_MANAGER") return true;
  if (!me.teamMemberId) return false;
  const tm = await prisma.teamMember.findUnique({ where: { id: me.teamMemberId }, select: { creativeManager: true } }).catch(() => null);
  return !!tm?.creativeManager;
}

/** The people each group coaches. Field creatives: active photographers on the
 *  roster, never the owner or the creative manager. Editors: the editor
 *  logins. Admin QC: the office people who get the ops alerts (Kyle). */
export async function developmentPeople(): Promise<DevPerson[]> {
  const [members, users] = await Promise.all([
    prisma.teamMember.findMany({ where: { active: true }, select: { id: true, name: true, role: true, creativeManager: true, opsAlerts: true } }),
    prisma.appUser.findMany({ where: { status: "ACTIVE" }, select: { name: true, role: true, teamMemberId: true, editorKey: true } }),
  ]);
  const ownerIds = new Set(users.filter((u) => u.role === "OWNER" && u.teamMemberId).map((u) => u.teamMemberId!));
  const isOwner = (m: { id: string; name: string }) => ownerIds.has(m.id) || /^jordan\b/i.test(m.name.trim());
  const slug = (n: string) => (n.trim().split(/\s+/)[0] ?? n).toLowerCase().replace(/[^a-z0-9]/g, "");
  const out: DevPerson[] = [];
  for (const m of members) {
    if (isOwner(m) || m.creativeManager) continue;
    if (m.role === "PHOTOGRAPHER") out.push({ id: m.id, name: m.name, group: "FIELD", editorKey: null, key: slug(m.name) });
    else if (m.opsAlerts && m.role === "MANAGER") out.push({ id: m.id, name: m.name, group: "QC", editorKey: null, key: slug(m.name) });
  }
  for (const u of users) {
    if (u.role !== "EDITOR" || !u.editorKey) continue;
    const tm = u.teamMemberId ? members.find((m) => m.id === u.teamMemberId) : null;
    out.push({ id: tm?.id ?? `editor:${u.editorKey}`, name: tm?.name ?? u.name ?? editorMeta(u.editorKey)?.name ?? u.editorKey, group: "EDITOR", editorKey: u.editorKey, key: u.editorKey });
  }
  return out;
}

// ---- recorded items --------------------------------------------------------------------

type ItemRow = Awaited<ReturnType<typeof prisma.developmentItem.findMany>>[number];

export function itemView(r: ItemRow, now: Date): DevItemView {
  const log = parseLog(r.logJson);
  const endToday = etDayBoundsUtc(etDayKey(now)).end;
  const last = [...log].reverse().find((l) => l.note);
  return {
    id: r.id,
    personId: r.personId,
    personName: r.personName,
    group: isDevGroup(r.group) ? r.group : "FIELD",
    skill: clean(r.skill, 160),
    standard: r.standard ? clean(r.standard, 400) : null,
    nextAction: r.nextAction ? clean(r.nextAction, 300) : null,
    followUpISO: r.followUpAt?.toISOString() ?? null,
    followUpDue: r.status === "OPEN" && !!r.followUpAt && r.followUpAt.getTime() < endToday.getTime(),
    practice: r.practice ? clean(r.practice, 300) : null,
    practiceDueISO: r.practiceDueAt?.toISOString() ?? null,
    status: r.status === "VERIFIED" || r.status === "CLOSED" ? r.status : "OPEN",
    progress: r.progress ? clean(r.progress, 400) : null,
    evidence: parseEvidence(r.evidenceJson),
    log,
    createdBy: r.createdBy,
    createdISO: r.createdAt.toISOString(),
    verifiedISO: r.verifiedAt?.toISOString() ?? null,
    verifiedBy: r.verifiedBy,
    lastWords: last?.note ?? null,
  };
}

/** Open items (and those verified or closed in the last 14 days, for the full page). */
export async function readDevelopmentItems(now: Date, opts: { includeRecent?: boolean } = {}): Promise<DevItemView[]> {
  const rows = await prisma.developmentItem.findMany({
    where: opts.includeRecent
      ? { OR: [{ status: "OPEN" }, { updatedAt: { gte: new Date(now.getTime() - 14 * DAY) } }] }
      : { status: "OPEN" },
    orderBy: [{ followUpAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: 300,
  });
  const views = rows.map((r) => itemView(r, now));
  // How each note reached the person (Oct 29 2026): "Harrison was texted at 5:12 PM".
  await import("@/lib/coachingNotice").then((m) => m.attachToldWords(views, new Date())).catch((e: unknown) => console.warn("teamDevelopment: notice words failed", (e as Error)?.message));
  return views;
}

// ---- readiness -----------------------------------------------------------------------

const DECISION_WORDS: Record<string, string> = {
  ASSIGNED: "Waiting on Jordan",
  ACCEPTED: "Jordan has it",
  IN_PROGRESS: "Jordan is deciding",
  BLOCKED: "Jordan's decision is blocked",
  READY_FOR_VERIFICATION: "Jordan is deciding",
  COMPLETED: "Jordan decided",
  CANCELLED: "Decision task cancelled",
};

export async function readReadiness(now: Date, opts: { decisionsBy?: string[] } = {}): Promise<ReadinessView[]> {
  void now;
  const rows = await prisma.readinessAssessment.findMany({ where: { status: { not: "WITHDRAWN" } }, orderBy: { updatedAt: "desc" }, take: 100 });
  // Jordan's decision: the decision task "Recommend to Jordan" created, found
  // by the link it carries (the delegation workflow keeps the task).
  const decisions = new Map<string, { state: string; update: string | null }>();
  const emails = [...new Set([...(opts.decisionsBy ?? []), ...rows.map((r) => r.recommendedBy).filter((x): x is string => !!x)])];
  if (rows.some((r) => r.status === "RECOMMENDED") && emails.length) {
    for (const email of emails) {
      const tasks = await tasksDelegatedBy(email).catch(() => []);
      for (const t of tasks) {
        const m = t.sourceHref?.match(/[?&]assessment=([a-z0-9]+)/i);
        if (m) decisions.set(m[1], { state: t.state, update: t.latestUpdate ? clean(t.latestUpdate, 300) : null });
      }
    }
  }
  return rows.map((r) => {
    const criteria = parseCriteria(r.criteriaJson);
    const d = decisions.get(r.id);
    return {
      id: r.id,
      personId: r.personId,
      personName: r.personName,
      track: r.track,
      trackLabel: trackLabel(r.track, r.skill),
      skill: r.skill,
      criteria,
      met: criteria.filter((c) => c.met === "yes").length,
      gaps: r.gaps ? clean(r.gaps, 600) : null,
      recommendation: isRecommendation(r.recommendation) ? r.recommendation : null,
      recommendationNote: r.recommendationNote ? clean(r.recommendationNote, 600) : null,
      status: r.status === "RECOMMENDED" || r.status === "WITHDRAWN" ? r.status : "DRAFT",
      recommendedISO: r.recommendedAt?.toISOString() ?? null,
      createdBy: r.createdBy,
      createdISO: r.createdAt.toISOString(),
      log: parseLog(r.logJson),
      decision: r.status !== "RECOMMENDED" ? null : d ? { state: d.state, words: DECISION_WORDS[d.state] ?? "Waiting on Jordan", update: d.update } : { state: "UNKNOWN", words: "Sent to Jordan; no decision recorded yet", update: null },
      href: assessmentHref(r.id),
    };
  });
}

// ---- signals ---------------------------------------------------------------------------

const streetOf = (t: string | null | undefined) => (t || "Job").split(",")[0].trim() || "Job";
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`}`;

/** KPI evidence kinds, grouped into the coaching subjects the spec names. */
const KPI_SUBJECT: Record<string, { key: string; skill: string }> = {
  late_photos: { key: "upload", skill: "Upload timing" },
  late_video: { key: "upload", skill: "Upload timing" },
  instructions: { key: "handoff", skill: "Handoff instructions" },
  brief_gap: { key: "handoff", skill: "Handoff instructions" },
  qc_fix: { key: "capture", skill: "Capture quality and coverage" },
  qc_flag: { key: "capture", skill: "Capture quality and coverage" },
  capture_revision: { key: "capture", skill: "Capture quality and coverage" },
  missed_coverage: { key: "capture", skill: "Capture quality and coverage" },
  complaint: { key: "client", skill: "Client direction and experience" },
};

async function fieldSignals(people: DevPerson[], now: Date): Promise<{ signals: Signal[]; unavailable: string[] }> {
  const out: Signal[] = [];
  const unavailable: string[] = [];
  if (!people.length) return { signals: out, unavailable };
  // 1 · the KPI evidence for the current period (entries against, counted or advisory).
  try {
    const [{ periodFor }, { loadEvidence }] = await Promise.all([import("@/lib/kpi"), import("@/lib/kpiEvidence")]);
    const period = periodFor(etDayKey(now));
    if (!period.legacy) {
      const windowEnd = now < period.end ? now : period.end;
      for (const p of people) {
        const ev = await loadEvidence(p.id, { startKey: period.startKey, endKey: period.endKey, start: period.start, windowEnd }, now);
        const by = new Map<string, { skill: string; rows: typeof ev.entries }>();
        for (const e of ev.entries) {
          if (e.effect !== "against") continue;
          const s = KPI_SUBJECT[e.kind];
          if (!s) continue;
          const g = by.get(s.key) ?? { skill: s.skill, rows: [] };
          g.rows.push(e);
          by.set(s.key, g);
        }
        for (const [k, g] of by) {
          const rows = [...g.rows].sort((a, b) => b.at.localeCompare(a.at));
          out.push({
            key: `field:${p.id}:kpi:${k}`,
            group: "FIELD",
            personId: p.id,
            personName: p.name,
            skill: g.skill,
            detail: `${plural(rows.length, "entry")} in the KPI evidence this period`,
            source: `KPI evidence, ${period.label}`,
            count: rows.length,
            countWords: `${rows.length} this period`,
            examples: rows.slice(0, 4).map((e) => ({ label: clean(`${e.title}${e.detail[0] ? `: ${e.detail[0]}` : ""}`, 160), href: e.projectId ? `/projects/${e.projectId}` : null, at: e.at, source: `field:${p.id}:kpi:${k}` })),
          });
        }
      }
    }
  } catch (e) {
    console.warn("teamDevelopment: KPI evidence failed", (e as Error).message);
    unavailable.push("KPI evidence");
  }
  // 2 · the free photo check: what the photographer owns, recurring on 2+ shoots in 30 days.
  try {
    const since = new Date(now.getTime() - 30 * DAY);
    const [{ photoDeliverySettings }, { GATE_BY }, { ruleById }] = await Promise.all([
      import("@/lib/photoDelivery/settings"), import("@/lib/photoDelivery/prep"), import("@/lib/photoDelivery/registry"),
    ]);
    const settings = await photoDeliverySettings();
    const gated: string[] = Object.values(GATE_BY);
    const projects = await prisma.project.findMany({ where: { photographerId: { in: people.map((p) => p.id) }, shootDate: { gte: since } }, select: { id: true, title: true, photographerId: true } });
    const jobs = projects.length ? await prisma.photoJob.findMany({ where: { projectId: { in: projects.map((p) => p.id) } }, select: { id: true, projectId: true } }) : [];
    const findings = jobs.length ? await prisma.photoQcFinding.findMany({
      where: { jobId: { in: jobs.map((j) => j.id) }, responsibility: "PHOTOGRAPHER", confidence: { gte: settings.displayConfidenceFloor }, status: { notIn: ["FALSE_POSITIVE", "OVERRIDDEN", "SUPERSEDED"] }, OR: [{ decidedBy: null }, { decidedBy: { notIn: gated } }] },
      select: { id: true, ruleId: true, jobId: true, photoId: true, specificIssue: true, status: true, decidedBy: true, statusReason: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }) : [];
    const projectOf = new Map(jobs.map((j) => [j.id, projects.find((p) => p.id === j.projectId)!]));
    // Oct 29 2026 (Jordan's call table, lib/qcCoaching): what is at the
    // property (a neighbor's car, a bin, a cord, staging) is evidence only
    // once a person says it was the photographer's to fix; anything a person
    // called "not an issue" is out. The rest waits on its own row, "to
    // confirm", which is never evidence: no coaching item can be made from it
    // (creativeDeskActions) and Process Improvements never counts it (its key
    // is photoqc-look, not photoqc).
    const { coachCalls, coachState, coachTally, tallyWords } = await import("@/lib/qcCoaching");
    const [calls, tally] = await Promise.all([coachCalls(findings.map((f) => f.id)), coachTally(now)]);
    type Bucket = { jobs: Set<string>; rows: SignalFinding[]; confirmed: number };
    const sigFinding = (f: (typeof findings)[number], state: SignalFinding["state"], why: string): SignalFinding => {
      const c = calls.get(f.id) ?? null;
      return {
        id: f.id, jobId: f.jobId, photoId: f.photoId, street: streetOf(projectOf.get(f.jobId)?.title), issue: clean(f.specificIssue, 140), atISO: f.createdAt.toISOString(),
        call: c ? { verdict: c.verdict, by: clean(c.by, 60), atISO: c.at, reason: c.reason ? clean(c.reason, 200) : null } : null, state, why: clean(why, 160),
      };
    };
    for (const p of people) {
      const counted = new Map<string, Bucket>();
      const toLook = new Map<string, Bucket>();
      for (const f of findings) {
        if (projectOf.get(f.jobId)?.photographerId !== p.id) continue;
        const call = calls.get(f.id) ?? null;
        const s = coachState(f, call, tally);
        if (s.state === "dismissed") continue;
        const into = s.state === "counts" ? counted : toLook;
        const e = into.get(f.ruleId) ?? { jobs: new Set<string>(), rows: [], confirmed: 0 };
        e.jobs.add(f.jobId);
        e.rows.push(sigFinding(f, s.state, s.why));
        if (call?.verdict === "coach") e.confirmed++;
        into.set(f.ruleId, e);
      }
      const labelOf = (ruleId: string) => clean(ruleById(ruleId)?.shortLabel ?? ruleId, 80);
      const exampleOf = (key: string) => (r: SignalFinding): Evidence => ({ label: `${r.street}: ${r.issue}`, href: `/ops/photo-delivery/${r.jobId}${r.photoId ? `?photo=${r.photoId}` : ""}`, at: r.atISO, source: key });
      const firstPerJob = (rows: SignalFinding[]) => rows.filter((r, i) => rows.findIndex((x) => x.jobId === r.jobId) === i);
      // A check a person confirmed is a row even on one shoot; otherwise 2+ shoots, as before.
      for (const [ruleId, e] of [...counted].filter(([, x]) => x.jobs.size >= 2 || x.confirmed > 0).sort((a, b) => b[1].jobs.size - a[1].jobs.size).slice(0, 3)) {
        const key = `field:${p.id}:photoqc:${ruleId}`;
        const confirmedWords = e.confirmed ? `, ${e.confirmed} confirmed by a person` : "";
        out.push({
          key,
          group: "FIELD",
          personId: p.id,
          personName: p.name,
          skill: `Photo check: ${labelOf(ruleId)}`,
          detail: `Found on ${e.jobs.size} ${e.jobs.size === 1 ? "shoot" : "shoots"} in the last 30 days${confirmedWords}`,
          source: "The free photo check (findings the photographer owns)",
          count: e.jobs.size,
          countWords: `${e.jobs.size} ${e.jobs.size === 1 ? "shoot" : "shoots"} in 30 days`,
          examples: firstPerJob(e.rows).slice(0, 4).map(exampleOf(key)),
          findings: e.rows.slice(0, 12),
          tally: tallyWords(tally.get(ruleId)),
        });
      }
      for (const [ruleId, e] of [...toLook].filter(([r, x]) => x.jobs.size + (counted.get(r)?.jobs.size ?? 0) >= 2).sort((a, b) => b[1].jobs.size - a[1].jobs.size).slice(0, 3)) {
        const key = `field:${p.id}:photoqc-look:${ruleId}`;
        out.push({
          key,
          group: "FIELD",
          personId: p.id,
          personName: p.name,
          skill: `Photo check to confirm: ${labelOf(ruleId)}`,
          detail: `Found on ${e.jobs.size} ${e.jobs.size === 1 ? "shoot" : "shoots"} in the last 30 days. None counts until someone says it was the photographer's to fix`,
          source: "The free photo check: what is at the property (cars, bins, objects, staging) needs a person's look first",
          count: e.jobs.size,
          countWords: `${e.jobs.size} to confirm`,
          examples: firstPerJob(e.rows).slice(0, 4).map(exampleOf(key)),
          needsLook: true,
          findings: e.rows.slice(0, 12),
          tally: tallyWords(tally.get(ruleId)),
        });
      }
    }
  } catch (e) {
    console.warn("teamDevelopment: photo check failed", (e as Error).message);
    unavailable.push("photo check findings");
  }
  return { signals: out, unavailable };
}

async function editorSignals(people: DevPerson[], now: Date, excludeClientIds: string[]): Promise<{ signals: Signal[]; unavailable: string[] }> {
  const out: Signal[] = [];
  if (!people.length) return { signals: out, unavailable: [] };
  try {
    const { editorQuality } = await import("@/lib/editorQuality");
    const from = new Date(now.getTime() - 60 * DAY);
    for (const p of people) {
      if (!p.editorKey) continue;
      const r = await editorQuality({ editorKey: p.editorKey, from, to: now, now, excludeClientIds });
      for (const g of r.recurring.groups.filter((x) => x.count >= 2)) {
        const key = `editor:${p.editorKey}:recurring:${g.category}|${g.product}`;
        out.push({
          key, group: "EDITOR", personId: p.id, personName: p.name,
          skill: `${clean(g.category, 60)} on ${clean(g.product, 60)}`,
          detail: `${g.count} times in 60 days, each traced by a reviewer to the edit`,
          source: "Revision issues with a reviewer-confirmed editing cause",
          count: g.count,
          countWords: `${g.count} times in 60 days`,
          examples: g.examples.slice(0, 4).map((x) => ({ label: `${x.street}: ${clean(x.text, 120)}`, href: x.href, at: x.atISO, source: key })),
        });
      }
      if (r.missed.count > 0) {
        const key = `editor:${p.editorKey}:missed`;
        out.push({
          key, group: "EDITOR", personId: p.id, personName: p.name,
          skill: "Corrections against earlier feedback",
          detail: `${r.missed.count} of ${r.missed.asked} asks came back unfixed in a later version (60 days)`,
          source: "The reviewer's check of each fix against the earlier notes",
          count: r.missed.count,
          countWords: `${r.missed.count} of ${r.missed.asked} unfixed`,
          examples: r.missed.examples.slice(0, 4).map((x) => ({ label: `${x.street}: ${clean(x.text, 120)}`, href: x.href, at: x.atISO, source: key })),
        });
      }
    }
    return { signals: out, unavailable: [] };
  } catch (e) {
    console.warn("teamDevelopment: editor quality failed", (e as Error).message);
    return { signals: out, unavailable: ["editor quality"] };
  }
}

async function qcSignals(people: DevPerson[], now: Date, excludeClientIds: string[]): Promise<{ signals: Signal[]; unavailable: string[] }> {
  const out: Signal[] = [];
  if (!people.length) return { signals: out, unavailable: [] };
  try {
    const since = new Date(now.getTime() - 30 * DAY);
    const keys = people.map((p) => p.key).filter((k): k is string => !!k);
    const rows = await prisma.qcRecord.findMany({
      where: { completedBy: { in: keys }, completedAt: { gte: since }, ...(excludeClientIds.length ? { project: { clientId: { notIn: excludeClientIds } } } : {}) },
      select: { projectId: true, completedBy: true, reopenedByRevisionAt: true, revisionReason: true, project: { select: { title: true } } },
      orderBy: { completedAt: "desc" },
      take: 500,
    });
    for (const p of people) {
      const mine = rows.filter((r) => r.completedBy === p.key);
      const reopened = mine.filter((r) => !!r.reopenedByRevisionAt);
      if (!reopened.length) continue;
      const key = `qc:${p.key}:reopened`;
      out.push({
        key, group: "QC", personId: p.id, personName: p.name,
        skill: "QC passes later reopened by a revision",
        detail: `${reopened.length} of ${mine.length} QC passes in 30 days. A revision does not prove QC missed it: review each example`,
        source: "QC records reopened by a client revision",
        count: reopened.length,
        countWords: `${reopened.length} of ${mine.length} passes in 30 days`,
        examples: reopened.slice(0, 4).map((r) => ({ label: `${streetOf(r.project?.title)}${r.revisionReason ? `: ${clean(r.revisionReason, 120)}` : ""}`, href: `/projects/${r.projectId}`, at: r.reopenedByRevisionAt!.toISOString(), source: key })),
      });
    }
    return { signals: out, unavailable: [] };
  } catch (e) {
    console.warn("teamDevelopment: QC records failed", (e as Error).message);
    return { signals: out, unavailable: ["QC records"] };
  }
}

export type DevelopmentRead = {
  people: DevPerson[];
  items: DevItemView[];
  /** evidence nobody has recorded anything about yet (a signal an open item already carries is left out) */
  signals: Signal[];
  readiness: ReadinessView[];
  criteria: Criterion[];
  /** sources that could not be read, in words (never shown as "nothing") */
  unavailable: string[];
  /** the recorded items could not be read (the table, before its schema push) */
  recordsUnavailable: boolean;
  readinessUnavailable: boolean;
};

export async function readDevelopment(opts: { now?: Date; excludeClientIds?: string[]; includeRecent?: boolean; decisionsBy?: string[] } = {}): Promise<DevelopmentRead> {
  const now = opts.now ?? new Date();
  const ex = opts.excludeClientIds ?? [];
  const unavailable: string[] = [];
  const people = await developmentPeople().catch((e: unknown) => { console.warn("teamDevelopment: roster failed", (e as Error).message); unavailable.push("the team roster"); return [] as DevPerson[]; });
  let recordsUnavailable = false;
  let readinessUnavailable = false;
  const [items, readiness, criteria, field, editors, qc] = await Promise.all([
    readDevelopmentItems(now, { includeRecent: opts.includeRecent }).catch((e: unknown) => { console.warn("teamDevelopment: items failed", (e as Error).message); recordsUnavailable = true; return [] as DevItemView[]; }),
    readReadiness(now, { decisionsBy: opts.decisionsBy }).catch((e: unknown) => { console.warn("teamDevelopment: readiness failed", (e as Error).message); readinessUnavailable = true; return [] as ReadinessView[]; }),
    existingCriteria().catch(() => [] as Criterion[]),
    fieldSignals(people.filter((p) => p.group === "FIELD"), now),
    editorSignals(people.filter((p) => p.group === "EDITOR"), now, ex),
    qcSignals(people.filter((p) => p.group === "QC"), now, ex),
  ]);
  unavailable.push(...field.unavailable, ...editors.unavailable, ...qc.unavailable);
  if (recordsUnavailable) unavailable.push("recorded coaching");
  if (readinessUnavailable) unavailable.push("readiness assessments");
  // A signal an open item already covers (its evidence, or the same person and
  // subject) is that item's: shown once.
  const open = items.filter((i) => i.status === "OPEN");
  const carried = new Set(open.flatMap((i) => i.evidence.map((e) => e.source)));
  const subject = new Set(open.map((i) => `${i.personId}|${i.skill.trim().toLowerCase()}`));
  const signals = [...field.signals, ...editors.signals, ...qc.signals].filter((s) => !carried.has(s.key) && !subject.has(`${s.personId}|${s.skill.trim().toLowerCase()}`));
  return { people, items, signals, readiness, criteria, unavailable, recordsUnavailable, readinessUnavailable };
}

/** "Fri, Oct 24" for a follow-up date, "today" / "overdue" said by the caller. */
export const followUpWords = (iso: string | null, now: Date): string | null => {
  if (!iso) return null;
  const k = etDayKey(new Date(iso));
  const today = etDayKey(now);
  if (k === today) return "Follow up today";
  if (k < today) return `Follow-up was ${etDate(iso)}`;
  return `Follow up ${etDate(iso)}`;
};
