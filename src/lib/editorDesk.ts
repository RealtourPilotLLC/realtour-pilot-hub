import type { QueueRow } from "@/components/editing/SimpleQueue";
import type { UnconfirmedClaim, WorkBar } from "@/lib/editorWork";

// ---------------------------------------------------------------------------
// THE EDITOR'S DESK, IN WORDS (Jordan, Sep 28: "the working on now button for
// the editors needs to be clearer … It says Kim is not working on anything,
// but I believe he is!").
//
// Kim had no Start button anywhere on his own Editing Room: the desk drew
// nothing until something was already active. This file is the plain part of
// the fix — which jobs go on the desk, what each one says, and every sentence
// the Start / Pause / Switch bar prints — kept pure so a drill can walk every
// case and so the client components and the page read the same rules.
//
// Pure and client-safe on purpose: no "server-only", no prisma, and only TYPE
// imports from editorWork (which is server-only). It never starts, pauses or
// writes anything; the buttons that use it call the §7.1 actions, and only
// when a person presses them.
// ---------------------------------------------------------------------------

/** One job on the editor's desk: a button that says "I'm on this now". */
export type DeskJob = {
  projectId: string;
  street: string;
  dueISO: string | null;
  late: boolean;
  /** The muted second line under the street, when it says something useful. */
  note: string | null;
  /** When THIS editor paused it (their own Pause, or a switch), else null. */
  pausedSinceISO: string | null;
  /** A job the old pill left "In editing" before the Start button existed —
   *  pressing it (while on nothing) confirms it rather than starting it
   *  (confirmCurrentWork). */
  claim: boolean;
  /** False = on the editor's list, but startEditing would refuse them (no
   *  edit card, revision or video of theirs on it yet). Drawn as one line
   *  ("Not assigned to you yet — ask the office"), never as a Start button. */
  startable: boolean;
};

/**
 * Rows that are not the editor's to start right now: no footage, no
 * instructions, a cut already with the office, or done. It is exactly
 * editorQueue's WAITING_ON_OFFICE ∪ {WAITING_ON_FOOTAGE, WAITING_ON_INSTRUCTIONS}
 * ∪ {"Completed"} (the c2 drill asserts the two agree), written out here
 * because editorQueue is a server module and this file is not.
 */
export const DESK_EXCLUDED = ["Waiting", "Waiting on instructions", "Ready for review", "Approved", "Completed"] as const;

const EXCLUDED = new Set<string>(DESK_EXCLUDED);

/**
 * …except that a cut with the office says nothing about the REST of the job
 * (Sep 28 review). editorQueue's pill picks the loudest state, so 107 E Old
 * Baltimore Pike — four videos, two approved, video 3 just uploaded — reads
 * "Ready for review" while video 4 is still Kim's to make. A job with the
 * office (these two words, editorQueue's WAITING_ON_OFFICE) stays on the desk
 * while it still owes this editor a video (the row's videosToEdit, a number —
 * never parsed from the words) or while this editor has it paused.
 */
const WITH_THE_OFFICE = new Set<string>(["Ready for review", "Approved"]);

const moreToEdit = (n: number) => `${n} more video${n === 1 ? "" : "s"} to edit`;

const NOTE_FOR_STATUS: Record<string, string> = {
  Revisions: "Revisions to do",
  "Check needed": "Finish the review check",
  "Extra video owed": "Extra video",
  "In editing — not confirmed": "Marked In editing — not confirmed",
};

/**
 * The editor's rows (already scoped to them and due-sorted by the queue),
 * reduced to the jobs they could say they are on. Order is kept. Legacy claims
 * ride on their row when it is here, and are appended at the end when it is
 * not, so the one-time "which one are you on?" answer is on the same list.
 */
export function toDeskJobs(
  rows: Pick<QueueRow, "id" | "street" | "dueISO" | "late" | "status" | "held" | "videoBreakdown" | "videosToEdit" | "startableBy" | "work">[],
  editorKey: string,
  claims: Pick<UnconfirmedClaim, "projectId" | "street" | "claimedAt">[],
): DeskJob[] {
  const claimed = new Set(claims.map((c) => c.projectId));
  const out: DeskJob[] = [];
  for (const r of rows) {
    if (r.held) continue;
    const minePaused = r.work.paused.find((p) => p.key === editorKey) ?? null;
    const withOffice = WITH_THE_OFFICE.has(r.status);
    if (EXCLUDED.has(r.status) && !(withOffice && (r.videosToEdit > 0 || minePaused))) continue;
    let note: string | null;
    if (r.status === "Paused" && minePaused) note = null; // the button says "Paused {time}" instead
    else if (withOffice) note = r.videosToEdit > 0 ? moreToEdit(r.videosToEdit) : null;
    else note = NOTE_FOR_STATUS[r.status] ?? r.videoBreakdown ?? null;
    out.push({
      projectId: r.id,
      street: r.street,
      dueISO: r.dueISO,
      late: r.late,
      note,
      pausedSinceISO: minePaused?.sinceISO ?? null,
      claim: claimed.has(r.id),
      // Unknown (null) is left to the server, which refuses with its own words.
      startable: r.startableBy === null || r.startableBy.includes(editorKey) || claimed.has(r.id),
    });
  }
  const here = new Set(out.map((j) => j.projectId));
  for (const c of claims) {
    if (here.has(c.projectId)) continue;
    here.add(c.projectId);
    out.push({
      projectId: c.projectId,
      street: c.street,
      dueISO: null,
      late: false,
      note: "Marked In editing — not confirmed",
      pausedSinceISO: null,
      claim: true,
      startable: true,
    });
  }
  return out;
}

/**
 * The editor's page header, from the SAME desk list (Sep 28 review): what they
 * could start, and how many of those are late. It can never say "Nothing to
 * edit" while the desk holds a job with a video still owed.
 */
export function deskHeader(jobs: Pick<DeskJob, "startable" | "late">[]): string {
  const mine = jobs.filter((j) => j.startable);
  const late = mine.filter((j) => j.late).length;
  return mine.length ? `${mine.length} to edit${late ? ` · ${late} late` : ""}` : "Nothing to edit right now";
}

const dayKey = (d: Date, tz: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/**
 * "12:40am" when the moment falls on today's calendar day IN `tz`, otherwise
 * "Sep 28 12:40am"; "" for nothing. The editor's own Start and Pause read in
 * their own timezone (Manila for Kim and John Mark) — Kim pressing Start at
 * 11:02pm and being told "since 11:02am" is the confusion this fixes. The
 * office always passes Eastern.
 */
export function deskClock(iso: string | null, tz: string, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    .format(d)
    .replace(/\s?([AP])M$/i, (_m, x: string) => `${x.toLowerCase()}m`);
  if (dayKey(d, tz) === dayKey(now, tz)) return t;
  const md = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(d);
  return `${md} ${t}`;
}

/** The office's clock, the same shape as editorWork.workClock ("12:40pm" today). */
export const OFFICE_TZ = "America/New_York";

/**
 * The editor's own clock, SAID to be theirs: "12:40am your time" (Sep 28
 * review). Their Start and Pause read in their own timezone, and the job page
 * also carries Eastern stamps (the tracker, the rounds) — an unlabelled
 * "12:40am" beside them read as the same clock. Eastern needs no label: it is
 * every other clock in the hub.
 */
export function yourClock(iso: string | null, tz: string, now: Date = new Date()): string {
  const t = deskClock(iso, tz, now);
  return t && tz !== OFFICE_TZ ? `${t} your time` : t;
}

/** How many videos on the job are still owed after the one just sent. */
export function stillWorkingRemaining(openSlotKeys: string[], sentKey: string): number {
  return openSlotKeys.filter((k) => k !== sentKey).length;
}

/** One video slot on the job page, as the post-upload question reads it. */
export type SlotForAsk = {
  key: string;
  /** The newest version's status; null = nothing handed in yet. */
  status: string | null;
  /** A PENDING version held for the editor's own check. */
  held: boolean;
  /** When the newest version was approved (APPROVED only). */
  approvedAtISO: string | null;
};

/**
 * The videos still owed on a job, for "Sent. Are you still working on this
 * job? N more videos to make here." Open = nothing in yet, sent back,
 * withdrawn, held for the editor's check — or APPROVED and the client asked
 * again about THAT video after it was approved (`askedAgain`, slot key → the
 * newest ask naming it; lib/videoAsks). Sep 28 review: an open revision is a
 * job-level flag, and counting every approved video under it asked Kim to
 * make three more videos on a job that owed none. An approved video no ask
 * names is done — the card undercounts before it overcounts.
 */
export function openSlotKeys(slots: SlotForAsk[], askedAgain: ReadonlyMap<string, Date | string>): string[] {
  return slots
    .filter((s) => {
      if (!s.status || s.status === "CHANGES_REQUESTED" || s.status === "WITHDRAWN") return true;
      if (s.status === "PENDING") return s.held;
      if (s.status !== "APPROVED") return false;
      const asked = askedAgain.get(s.key);
      if (!asked) return false;
      return !s.approvedAtISO || new Date(asked).getTime() > new Date(s.approvedAtISO).getTime();
    })
    .map((s) => s.key);
}

export type BarWords = { state: string; sub: string | null; button: "start" | "resume" | "pause" | "switch" | null };

/**
 * Every sentence the job page's Start / Pause bar prints. Editor mode reads in
 * the editor's own timezone and offers exactly one button; the office and a
 * read-only view read in Eastern and never get a button from here (the
 * office's labelled corrections are drawn by the bar itself).
 */
export function barWords(bar: WorkBar, tz: string, now: Date): BarWords {
  if (bar.mode === "editor") {
    const t = (iso: string | null) => yourClock(iso, tz, now);
    if (bar.mine.state === "ACTIVE") {
      return { state: bar.mine.sinceISO ? `You're on this job since ${t(bar.mine.sinceISO)}` : "You're on this job", sub: null, button: "pause" };
    }
    if (!bar.canStart) return { state: bar.blocked ?? "Not yours to start.", sub: null, button: null };
    if (bar.elsewhere) {
      return {
        state: `You're on ${bar.elsewhere.street} now.`,
        sub: `${bar.mine.state === "PAUSED" ? "This job is paused. " : ""}Switching pauses ${bar.elsewhere.street}.`,
        button: "switch",
      };
    }
    if (bar.mine.state === "PAUSED") {
      return { state: `Paused at ${t(bar.mine.sinceISO)}.`, sub: "Everything on it is where you left it.", button: "resume" };
    }
    return { state: "Working on this job now?", sub: null, button: "start" };
  }
  const t = (iso: string | null) => deskClock(iso, OFFICE_TZ, now);
  const { active, paused } = bar.people;
  if (active.length === 1) {
    const a = active[0];
    return { state: a.sinceISO ? `${a.name} on this job since ${t(a.sinceISO)}` : `${a.name} on this job`, sub: null, button: null };
  }
  if (active.length > 1) return { state: `${active.map((a) => a.name).join(", ")} on this job`, sub: null, button: null };
  if (paused.length) {
    return { state: `Paused — ${paused.map((p) => (p.sinceISO ? `${p.name} at ${t(p.sinceISO)}` : p.name)).join(", ")}`, sub: null, button: null };
  }
  return { state: "Nobody has pressed Start on this job", sub: null, button: null };
}

/** The four lines under "How this works", shared by the desk and the job bar.
 *  Line 3 promises nothing it cannot keep (Sep 28 review): the Dropbox "Send
 *  to Review" never asks, and a Start naming another video can outlive an
 *  upload — pressing Start again is always safe ("You're already on …"). */
export const HOW_START_WORKS = [
  "Start = you're editing this job now. Starting another job pauses this one.",
  "Pause = you stopped. Nothing on the job changes.",
  "After you send a version for review, press Start again if you're still working on the job.",
  "It's not a timer, and it's not used for pay.",
] as const;
