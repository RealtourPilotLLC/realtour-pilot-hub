// ---------------------------------------------------------------------------
// A COMPLAINT'S PLAN, PURE HALF (Oct 29 2026). Jordan, on Tim Bonner's call
// (floor plan errors, a pending Zillow Showcase, and how Harrison framed the
// rooms): "I want a way for the system to handle and delegate this issue,
// and track it."
//
// A complaint (ClientIssue) keeps its states (clientIssuesCore). What it
// gains is a PLAN:
//   · STEPS: what, who, by when. Each step is a delegated task on that
//     person's list (lib/delegation), so it is done when its task is, on
//     every screen at once. "Mark corrected" waits until every step is done.
//   · THE HUB'S DRAFT: when a complaint is opened from a call or a text, the
//     hub reads the conversation and proposes a summary, the steps, the
//     client's standing preferences and what they said about the shoot. A
//     person approves the steps before any task exists.
//   · PREFERENCES go on the client's notes (the customer note, mirrored to
//     Aryeo), which the photographer's shoot screen and the editor's brief
//     already show: "so that we see his preferences moving forward and the
//     creative can see it on the job brief".
//   · THE KPI TRACKER: one button puts the complaint on a creative's
//     scorecard, with the client named ("so that the creative knows who said
//     it. I think it's important to be transparent").
// Jordan, Kyle and James all work the same record: "when one of us updates
// something, it reflects those changes for everyone".
// No prisma, no server-only: the panel, the dashboard and the drill read the
// same words.
// ---------------------------------------------------------------------------

export const STEP_KINDS = ["task", "coach", "prefs"] as const;
export type StepKind = (typeof STEP_KINDS)[number];
export const isStepKind = (v: unknown): v is StepKind => typeof v === "string" && (STEP_KINDS as readonly string[]).includes(v);

/** One step the hub proposes. */
export type DraftStep = {
  text: string;
  ownerKey: string | null;
  /** business days from the draft to its due date (0 = today) */
  dueBusinessDays: number | null;
  kind: StepKind;
  /** the conversation shows it is already done: how we know */
  alreadyDone: string | null;
};

export type ComplaintDraft = {
  v: 1;
  state: "drafting" | "ready" | "failed" | "approved" | "dismissed";
  at: string;
  by: string | null;
  model?: string | null;
  error?: string | null;
  summary: string;
  steps: DraftStep[];
  /** standing preferences for every future shoot and edit, one per line */
  preferences: string[];
  /** what the client said about the photographer's own work (for the KPI note), or null */
  shootFeedback: string | null;
  approvedAt?: string | null;
  approvedBy?: string | null;
};

/** A draft that has sat in "drafting" longer than this failed without saying so. */
export const DRAFT_STALE_MS = 4 * 60_000;

export function readDraft(json: string | null | undefined): ComplaintDraft | null {
  if (!json) return null;
  try {
    const j = JSON.parse(json) as Partial<ComplaintDraft>;
    if (!j || typeof j !== "object" || typeof j.at !== "string") return null;
    const state = j.state === "drafting" || j.state === "ready" || j.state === "failed" || j.state === "approved" || j.state === "dismissed" ? j.state : "failed";
    const steps = Array.isArray(j.steps)
      ? j.steps
          .filter((s): s is DraftStep => !!s && typeof s.text === "string" && s.text.trim().length > 0)
          .map((s) => ({
            text: s.text.trim(),
            ownerKey: typeof s.ownerKey === "string" && s.ownerKey ? s.ownerKey : null,
            dueBusinessDays: typeof s.dueBusinessDays === "number" && Number.isFinite(s.dueBusinessDays) ? Math.max(0, Math.min(10, Math.round(s.dueBusinessDays))) : null,
            kind: isStepKind(s.kind) ? s.kind : "task",
            alreadyDone: typeof s.alreadyDone === "string" && s.alreadyDone.trim() ? s.alreadyDone.trim() : null,
          }))
      : [];
    return {
      v: 1, state, at: j.at, by: typeof j.by === "string" ? j.by : null, model: typeof j.model === "string" ? j.model : null,
      error: typeof j.error === "string" ? j.error : null,
      summary: typeof j.summary === "string" ? j.summary : "",
      steps,
      preferences: Array.isArray(j.preferences) ? j.preferences.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim()) : [],
      shootFeedback: typeof j.shootFeedback === "string" && j.shootFeedback.trim() ? j.shootFeedback.trim() : null,
      approvedAt: typeof j.approvedAt === "string" ? j.approvedAt : null,
      approvedBy: typeof j.approvedBy === "string" ? j.approvedBy : null,
    };
  } catch {
    return null;
  }
}

/** A drafting claim nobody finished (the function died): it may be drafted again. */
export const draftIsStale = (d: ComplaintDraft | null, now: Date): boolean => !!d && d.state === "drafting" && now.getTime() - Date.parse(d.at) > DRAFT_STALE_MS;

// ---- steps --------------------------------------------------------------------------

export type StepTask = { status: string; completedAt: Date | string | null; assignedKey: string | null; dueAt: Date | string | null; title: string } | null;

export type StepView = {
  id: string;
  sort: number;
  text: string;
  kind: StepKind;
  ownerKey: string | null;
  ownerName: string | null;
  dueAtISO: string | null;
  taskId: string | null;
  done: boolean;
  doneAtISO: string | null;
  doneBy: string | null;
  doneNote: string | null;
  /** its task was cancelled (it left everyone's list) */
  cancelled: boolean;
  late: boolean;
};

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : typeof d === "string" ? d : d.toISOString());

/** A step's state, read from its task when it has one (pure). */
export function stepView(
  s: { id: string; sort: number; text: string; kind: string; ownerKey: string | null; ownerName: string | null; dueAt: Date | string | null; taskId: string | null; doneAt: Date | string | null; doneBy: string | null; doneNote: string | null },
  task: StepTask,
  names: (key: string) => string | null,
  now: Date,
): StepView {
  const fromTask = !!s.taskId && !!task;
  const done = fromTask ? task!.status === "COMPLETED" : !!s.doneAt;
  const cancelled = fromTask && task!.status === "CANCELLED";
  const ownerKey = fromTask ? task!.assignedKey ?? s.ownerKey : s.ownerKey;
  const dueAtISO = iso(fromTask ? task!.dueAt ?? s.dueAt : s.dueAt);
  return {
    id: s.id, sort: s.sort, text: s.text, kind: isStepKind(s.kind) ? s.kind : "task",
    ownerKey, ownerName: (ownerKey ? names(ownerKey) : null) ?? s.ownerName,
    dueAtISO, taskId: s.taskId,
    done, doneAtISO: done ? iso(fromTask ? task!.completedAt : s.doneAt) : null, doneBy: s.doneBy, doneNote: s.doneNote,
    cancelled,
    late: !done && !cancelled && !!dueAtISO && Date.parse(dueAtISO) < now.getTime(),
  };
}

export type Progress = {
  total: number;
  done: number;
  /** the first open step, soonest due first */
  next: StepView | null;
  late: number;
  /** "3 of 7 steps done · next: Kyle, Fix the floor plans (due Fri)" */
  words: string;
  allDone: boolean;
};

/** Steps that count: cancelled ones have left everyone's list. */
export const liveSteps = (steps: StepView[]) => steps.filter((s) => !s.cancelled);

export function progressOf(steps: StepView[], dueWords: (iso: string) => string): Progress {
  const live = liveSteps(steps);
  const open = live.filter((s) => !s.done).sort((a, b) => (a.dueAtISO ?? "9999").localeCompare(b.dueAtISO ?? "9999") || a.sort - b.sort);
  const done = live.length - open.length;
  const next = open[0] ?? null;
  const late = open.filter((s) => s.late).length;
  const words = live.length === 0
    ? "No steps yet"
    : next
      ? `${done} of ${live.length} steps done · next: ${next.ownerName ? `${next.ownerName}, ` : ""}${next.text}${next.dueAtISO ? ` (${next.late ? "late, was due" : "due"} ${dueWords(next.dueAtISO)})` : ""}`
      : `All ${live.length} steps done`;
  return { total: live.length, done, next, late, words, allDone: live.length > 0 && open.length === 0 };
}

/** Why "Mark corrected" waits, or null when it can go. */
export function correctedBlocker(steps: StepView[]): string | null {
  const open = liveSteps(steps).filter((s) => !s.done);
  if (open.length === 0) return null;
  return `${open.length === 1 ? "One step is" : `${open.length} steps are`} still open: ${open.slice(0, 3).map((s) => `${s.ownerName ? `${s.ownerName}, ` : ""}${s.text}`).join("; ")}${open.length > 3 ? "; and more" : ""}. Finish or remove ${open.length === 1 ? "it" : "them"} first.`;
}

/** What was done, from the finished steps: the correction's first words (pure). */
export function correctionFromSteps(steps: StepView[]): string {
  return liveSteps(steps).filter((s) => s.done).map((s) => `${s.text}${s.doneNote ? ` (${s.doneNote})` : ""}`).join("; ");
}

// ---- words ---------------------------------------------------------------------------

/** Client copy and notes never carry long dashes (house rule). */
export const noLongDashes = (s: string) => s.replace(/\s*[—–]\s*/g, ", ").replace(/,\s*,/g, ",");

export const firstNameOf = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || "the client";

/**
 * The block added to the client's notes: a heading that says where it came
 * from, then one preference a line (pure). The notes are what the shoot
 * screen and the editor brief show, so these read as instructions.
 */
export function prefsBlock(clientName: string | null, lines: string[], dayWords: string): string {
  const body = lines.map((l) => noLongDashes(l.trim().replace(/^[-•*]\s*/, ""))).filter(Boolean).map((l) => `- ${l}`);
  if (body.length === 0) return "";
  return [`${firstNameOf(clientName)}'s preferences (from ${dayWords}):`, ...body].join("\n");
}

/** The notes with the block added under what is there (pure). Nothing is ever replaced. */
export function appendToNotes(existing: string | null | undefined, block: string): string {
  const cur = (existing ?? "").trim();
  return cur ? `${cur}\n\n${block}` : block;
}

/** Lines typed in a box: one preference a line, bullets stripped (pure). */
export const prefLines = (text: string) => text.split(/\r?\n/).map((l) => l.trim().replace(/^[-•*]\s*/, "")).filter((l) => l.length > 0 && !/preferences \(from /i.test(l));

// ---- the KPI tracker -------------------------------------------------------------------

export type KpiLink = { memberId: string; memberName: string; periodKey: string; entryId: string; area: string; points: number; at: string; by: string };

export function readKpiLinks(json: string | null | undefined): KpiLink[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((k): k is KpiLink => !!k && typeof k.memberId === "string" && typeof k.entryId === "string") : [];
  } catch {
    return [];
  }
}

/** How a complaint can count on a scorecard: none is picked for you (it is somebody's pay). */
export const KPI_POINT_CHOICES: { points: number; label: string }[] = [
  { points: 0, label: "A note: shows, doesn't score" },
  { points: -3, label: "-3 points" },
  { points: -5, label: "-5 points" },
  { points: -10, label: "-10 points" },
];

const SOURCE_WORDS: Record<string, string> = { call: "on a call", text: "by text", email: "by email", portal: "on their portal", feedback: "", staff: "" };

/** The KPI entry's title, with the client named (pure). */
export const kpiTitle = (clientName: string | null, street: string | null) => `Client complaint from ${clientName ?? "a client"}${street ? `: ${street}` : ""}`.slice(0, 160);

/** Words kept to `n` characters, ending on a whole sentence when one fits past halfway, else on a whole word (pure). */
export function clipToSentence(text: string | null | undefined, n: number): string {
  const t = (text ?? "").replace(/[ \t]+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), /[.!?]$/.test(cut) ? cut.length - 1 : -1);
  if (end >= n / 2) return cut.slice(0, end + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[,;:]$/, "")}...`;
}

/** The KPI entry's note: who said it, how and when, then their words (pure).
 *  Words that open "Tim said ..." lose that opening: the note already says who. */
export function kpiNote(clientName: string | null, source: string | null, dayWords: string, words: string): string {
  const how = SOURCE_WORDS[source ?? ""] ?? "";
  let said = words.trim();
  const names = [clientName, clientName ? firstNameOf(clientName) : null].filter((x): x is string => !!x && x.trim().length > 1);
  if (names.length) {
    const esc = names.map((n) => n.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const lead = said.replace(new RegExp(`^(?:${esc})\\s+(?:said|says|told us)(?:\\s+that)?[,:]?\\s+`, "i"), "");
    if (lead !== said && lead.length > 0) said = lead[0].toUpperCase() + lead.slice(1);
  }
  return noLongDashes(`${clientName ?? "The client"} said${how ? ` ${how}` : ""} on ${dayWords}: ${said}`).slice(0, 1000);
}
