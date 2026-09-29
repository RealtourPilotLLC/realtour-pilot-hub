// ---------------------------------------------------------------------------
// UPLOAD DRAFTS (O04 / A30, Sep 25 2026).
//
// The wrap-up on /upload/<id> used to live in React state and nowhere else: the
// photographer's video brief, cull ticks, shot order, removal notes, topic
// ticks and notes, and the script answer were written ONLY by finalizeUpload.
// A closed tab, a dead phone or a failed submit threw all of it away, and the
// page said "Couldn't submit … try again" to someone who now had to retype a
// brief at 10 PM. (Ticks, "couldn't complete" reasons, square footage and
// flags were already saved on the spot — they are not part of a draft.)
//
// A draft is SCRATCH, never a submit. Saving one writes a single UploadDraft
// row and nothing else: no Project column, no Activity line, no task, no bell,
// no filming report — and so it can never satisfy the pay gate, finalize the
// job or tell an editor anything. One row per (job, author): the office's
// "Edit this upload" keeps its own, so two people never overwrite each other's
// unsent answers.
//
// This module is pure and client-safe (the portal runs the autosaver from it);
// the database half lives in app/upload/draftActions.ts.
// ---------------------------------------------------------------------------

/** Same numbers the submit clips to (upload/actions.ts, lib/filmedTopics FILMING_LIMITS). */
export const DRAFT_LIMITS = {
  editorBrief: 6000,
  section: 6000,
  removal: 4000,
  orderNotes: 2000,
  note: 1000,
  script: 20_000,
  scriptNote: 500,
  topics: 40,
  extras: 10,
  titleChars: 200,
  /** a hard ceiling on the stored JSON, whatever the shape */
  json: 120_000,
} as const;

export type DraftOrderChoice = "front-to-back" | "interior-exterior" | "out-of-order";
export type DraftScriptChoice = "as-written" | "edited";

export type DraftPayload = {
  editorBrief: string;
  checks: { coverage: boolean; culling: boolean; quality: boolean; count: boolean };
  removal: string;
  nothingToRemove: boolean;
  orderChoice: DraftOrderChoice | null;
  orderNotes: string;
  vidStyle: string | null;
  vidSections: Record<string, string>;
  videosFilmed: string;
  filmedTopicIds: string[];
  topicNotes: Record<string, string>;
  extraRows: { title: string; note: string }[];
  scriptChoice: DraftScriptChoice | null;
  scriptText: string;
  scriptNote: string;
  /**
   * R02 follow-up (Sep 28 2026): this draft carries NO topic answer. Set by a
   * page that could not read the job's topic list and had no earlier answer to
   * carry (no open draft), so its empty ticks, notes and extras are "unknown",
   * not "none". The three topic fields are empty and mean nothing; a save
   * keeps the stored draft's answer instead, and a page restoring this draft
   * takes the job's own answer (its pending report, its notes). Absent = the
   * draft's topic fields ARE its answer, as before.
   */
  topicsUnknown?: true;
};

const str =(v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const SECTION_KEY_RE = /^[a-zA-Z]{2,24}$/;

/**
 * The browser's draft, as the server will store it. Nothing is trusted as
 * given: every string is clipped to the submit's own caps, unknown keys are
 * dropped, ids must look like ids. Never throws — garbage becomes an empty
 * draft, not a 500 on an autosave.
 */
export function normalizeDraftPayload(raw: unknown): DraftPayload {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const checksIn = (r.checks && typeof r.checks === "object" ? r.checks : {}) as Record<string, unknown>;
  const order = r.orderChoice;
  const script = r.scriptChoice;
  const sections: Record<string, string> = {};
  if (r.vidSections && typeof r.vidSections === "object" && !Array.isArray(r.vidSections)) {
    for (const [k, v] of Object.entries(r.vidSections as Record<string, unknown>).slice(0, 16)) {
      if (!SECTION_KEY_RE.test(k)) continue;
      const s = str(v, DRAFT_LIMITS.section);
      if (s) sections[k] = s;
    }
  }
  const topicIds = Array.isArray(r.filmedTopicIds)
    ? [...new Set(r.filmedTopicIds.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].slice(0, DRAFT_LIMITS.topics)
    : [];
  const topicNotes: Record<string, string> = {};
  if (r.topicNotes && typeof r.topicNotes === "object" && !Array.isArray(r.topicNotes)) {
    for (const [k, v] of Object.entries(r.topicNotes as Record<string, unknown>).slice(0, DRAFT_LIMITS.topics * 2)) {
      if (!ID_RE.test(k)) continue;
      const s = str(v, DRAFT_LIMITS.note);
      if (s.trim()) topicNotes[k] = s;
    }
  }
  const extraRows: { title: string; note: string }[] = [];
  for (const x of Array.isArray(r.extraRows) ? r.extraRows : []) {
    if (extraRows.length >= DRAFT_LIMITS.extras) break;
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    const title = str(e.title, DRAFT_LIMITS.titleChars);
    const note = str(e.note, DRAFT_LIMITS.note);
    if (title.trim() || note.trim()) extraRows.push({ title, note });
  }
  // No topic answer (R02 follow-up): the topic fields are emptied so an
  // "unknown" draft can never be read as an answer of none.
  const unknown = r.topicsUnknown === true;
  return {
    editorBrief: str(r.editorBrief, DRAFT_LIMITS.editorBrief),
    checks: {
      coverage: checksIn.coverage === true,
      culling: checksIn.culling === true,
      quality: checksIn.quality === true,
      count: checksIn.count === true,
    },
    removal: str(r.removal, DRAFT_LIMITS.removal),
    nothingToRemove: r.nothingToRemove === true,
    orderChoice: order === "front-to-back" || order === "interior-exterior" || order === "out-of-order" ? order : null,
    orderNotes: str(r.orderNotes, DRAFT_LIMITS.orderNotes),
    vidStyle: typeof r.vidStyle === "string" && /^[a-z_]{1,24}$/.test(r.vidStyle) ? r.vidStyle : null,
    vidSections: sections,
    videosFilmed: typeof r.videosFilmed === "string" ? r.videosFilmed.replace(/[^\d]/g, "").slice(0, 3) : "",
    filmedTopicIds: unknown ? [] : topicIds,
    topicNotes: unknown ? {} : topicNotes,
    extraRows: unknown ? [] : extraRows,
    scriptChoice: script === "as-written" || script === "edited" ? script : null,
    scriptText: str(r.scriptText, DRAFT_LIMITS.script),
    scriptNote: str(r.scriptNote, DRAFT_LIMITS.scriptNote),
    ...(unknown ? { topicsUnknown: true as const } : {}),
  };
}

/** Does this draft say anything at all? An empty draft is not worth a restore banner. */
export function draftHasContent(p: DraftPayload): boolean {
  return !!(
    p.editorBrief.trim() || p.removal.trim() || p.nothingToRemove || p.orderChoice || p.orderNotes.trim() ||
    p.vidStyle || Object.values(p.vidSections).some((v) => v.trim()) || p.videosFilmed ||
    p.filmedTopicIds.length || Object.keys(p.topicNotes).length || p.extraRows.length ||
    p.scriptChoice || p.scriptNote.trim() ||
    p.checks.coverage || p.checks.culling || p.checks.quality || p.checks.count
  );
}

// ---------------------------------------------------------------------------
// R02 (external review, Sep 28 2026): A TOPIC LIST THAT COULD NOT BE READ IS
// NOT AN EMPTY ONE.
//
// A save checks the draft's topic ids against the job's own topic list, so an
// invented id is never stored. The check used to turn a FAILED read of that
// list into "this job has no topics": every tick and every topic note was
// filtered out, the stripped draft was written as a new revision, the page was
// told "saved", and it then deleted the device copy that still held the ticks.
// The upload page's own render did the same, and its next autosave wrote []
// over the stored ticks even once the database was healthy again.
//
// Now "the list could not be read" is its own answer everywhere: the server
// writes nothing and says so (retryable), the page keeps the device copy and
// retries, and a page rendered without the list echoes the stored ticks back
// untouched instead of dropping them.
// ---------------------------------------------------------------------------

/** The photographer's words for a save held back because the topic list could not be read. */
export const DRAFT_TOPIC_CHECK_FAILED = "Couldn't save your topic ticks just now — they're kept on this device. Trying again…";

/** Another copy of this person's draft was saved first (another tab, another device). */
export type DraftConflict = {
  revision: number;
  payload: DraftPayload;
  savedAtISO: string;
  by: string | null;
  /** The draft was consumed by a submit from another tab — the server copy is
   *  what went in, not an unsent answer. */
  submitted: boolean;
};

/** What saveUploadDraft answers (app/upload/draftActions.ts). */
export type SaveDraftResult =
  | { ok: true; revision: number; savedAtISO: string }
  | { ok: false; conflict: DraftConflict }
  /** retryable: nothing is wrong with the answers — the server could not check
   *  them just now (the topic list did not load). The same save will land. */
  | { ok: false; message: string; retryable?: true };

/**
 * What the page does with one save's answer, and with its device copy. Pure,
 * so the drill runs the page's exact rule: the device copy is deleted ONLY
 * when the server says the answers are saved. Any other answer — a conflict,
 * a refusal, a topic list that did not load — keeps it, because until the
 * server holds the answers that copy may be the only one.
 */
export function settleDraftSave(
  r: SaveDraftResult,
  device: { keep: () => void; clear: () => void },
): { outcome: SaveOutcome; revision: number | null; conflict: DraftConflict | null } {
  if (r.ok) {
    device.clear();
    return { outcome: { ok: true, savedAtISO: r.savedAtISO }, revision: r.revision, conflict: null };
  }
  device.keep();
  if ("conflict" in r) return { outcome: { ok: false, conflict: true }, revision: null, conflict: r.conflict };
  return { outcome: { ok: false, message: r.message }, revision: null, conflict: null };
}

/**
 * Which topics come back ticked when answers are put back on the page (a saved
 * draft, a device copy, the other copy after a conflict, a report that has not
 * landed yet).
 *
 * With the job's topic list: only topics this session can still tick, and a
 * topic already RECORDED as filmed here stays ticked (a re-submit never walks
 * a confirmation back). A topic confirmed at another session is that
 * session's video and never comes back ticked here.
 *
 * WITHOUT it (`unavailable`: the list failed to load, which is not the same as
 * a job with no list): the ids come back exactly as they were saved. The page
 * cannot show them, but it must not drop them either — the next autosave would
 * store the drop. The server checks them against the real list on its next
 * healthy save, so nothing invented is ever kept.
 */
export function restoredTopicTicks(o: {
  unavailable: boolean;
  topics: readonly { topicId: string; confirmedOnProjectId: string | null }[];
  ids: readonly string[];
  projectId: string;
}): string[] {
  if (o.unavailable) return [...o.ids];
  const recordedHere = (t: { confirmedOnProjectId: string | null }) => t.confirmedOnProjectId === o.projectId;
  const confirmedElsewhere = (t: { confirmedOnProjectId: string | null }) => !!t.confirmedOnProjectId && t.confirmedOnProjectId !== o.projectId;
  return o.topics
    .filter((t) => recordedHere(t) || (o.ids.includes(t.topicId) && !confirmedElsewhere(t)))
    .map((t) => t.topicId);
}

// ---------------------------------------------------------------------------
// R02 FOLLOW-UP (review of the R02 repair, Sep 28 2026): A PAGE THAT DOES NOT
// KNOW THE TOPIC ANSWER MUST NOT SAVE ONE.
//
// The repair kept a stored draft's ticks when the page could not read the
// topic list. It missed the page with NO open draft — the common case after a
// whole submit whose filming report has not landed yet, which is exactly when
// the same outage also fails the page's read. That page seeded its ticks,
// notes and extras from values it did not have ([] / {} / []), and the first
// autosave (a typo fixed in the brief — no topic ids, so no topic check)
// stored them as the answer. On the healthy reload the banner had asked for,
// that draft's empty answer won over the report's: nothing ticked, no extra,
// while the report still said two topics and an extra — and a photographer who
// re-ticks from memory files a second, different report.
//
// Now the page carries "no topic answer" as its own state (topicsUnknown on
// the draft): the server keeps the stored draft's answer rather than writing
// the empty one, and a page restoring such a draft takes the job's own answer.
// ---------------------------------------------------------------------------

/** The topic half of the page's answers, and where it came from. */
export type TopicAnswer = {
  ticks: string[];
  notes: Record<string, string>;
  extras: { title: string; note: string }[];
  /** "draft": the saved draft's answer; "job": the job's own (a report that has not landed, the notes on file). */
  source: "draft" | "job";
  /** The page has no topic answer at all: the list did not load and no draft carried one. */
  unknown: boolean;
};

/**
 * The topic answer a freshly opened upload page starts from — the portal's
 * own rule, pure so the drill runs it on the real page's props. A draft's
 * answer wins when it HAS one; a draft saved without one (topicsUnknown) falls
 * through to the job's own, as if there were no draft. With the list
 * unavailable and no draft answer, the result is `unknown`: its empty fields
 * are placeholders the page must never save as an answer.
 */
export function initialTopicAnswer(o: {
  draft: DraftPayload | null;
  unavailable: boolean;
  topics: readonly { topicId: string; confirmedOnProjectId: string | null; note?: string | null }[];
  pending: { topicIds: readonly string[]; extras: readonly { title: string; note: string }[] } | null;
  projectId: string;
}): TopicAnswer {
  const ticks = (ids: readonly string[]) => restoredTopicTicks({ unavailable: o.unavailable, topics: o.topics, ids, projectId: o.projectId });
  if (o.draft && !o.draft.topicsUnknown) {
    return {
      ticks: ticks(o.draft.filmedTopicIds),
      notes: { ...o.draft.topicNotes },
      extras: o.draft.extraRows.map((x) => ({ title: x.title, note: x.note })),
      source: "draft",
      unknown: false,
    };
  }
  return {
    ticks: ticks(o.pending?.topicIds ?? []),
    notes: Object.fromEntries(o.topics.filter((t) => t.note?.trim()).map((t) => [t.topicId, t.note as string])),
    extras: (o.pending?.extras ?? []).map((x) => ({ title: x.title, note: x.note })),
    source: "job",
    unknown: o.unavailable,
  };
}

/**
 * The server's half: a save that carries no topic answer keeps the one the
 * stored draft has (the row it is about to replace, at the same revision).
 * With nothing stored, the draft stays "no topic answer" — never "none".
 */
export function carryTopicAnswer(next: DraftPayload, stored: DraftPayload | null): DraftPayload {
  if (!next.topicsUnknown || !stored || stored.topicsUnknown) return next;
  const out: DraftPayload = {
    ...next,
    filmedTopicIds: [...stored.filmedTopicIds],
    topicNotes: { ...stored.topicNotes },
    extraRows: stored.extraRows.map((x) => ({ title: x.title, note: x.note })),
  };
  delete out.topicsUnknown;
  return out;
}

// ---------------------------------------------------------------------------
// THE DEVICE COPY (O04, Sep 25; review of the R02 repair, Sep 28 2026).
//
// While the server has not taken the answers, the page keeps them in this
// browser. The copy used to carry only `savedAtISO`, re-stamped on EVERY
// failed attempt — each retry, each conflict — and a reload restored it
// whenever that stamp was newer than the server's draft, then pushed it onto
// the server's newest revision with no conflict. So a phone that typed on
// revision 1, failed, and kept retrying past a laptop's save of revision 2
// silently overwrote the laptop's answers the next time the phone's page was
// opened: the one thing the conflict panel exists to stop. R02 made it more
// likely (a failed topic read now keeps and re-stamps the copy every retry,
// where it used to "save" and clear it).
//
// Now the copy records the REVISION it was typed on and WHEN it was typed
// (kept across retries of the same answers). A reload restores it silently
// only onto that same revision; if the server moved on since, the person is
// asked, with the existing conflict panel.
// ---------------------------------------------------------------------------

/** One device copy, as read back. */
export type DeviceCopy = {
  payload: DraftPayload;
  /** When these answers were typed (the first attempt that held them). */
  typedAtISO: string;
  /** When the copy was last written (every failed attempt). */
  savedAtISO: string;
  /** The server revision the answers were typed on; null = none yet;
   *  undefined = a copy written before Sep 28 2026, which did not record it. */
  baseRevision?: number | null;
  baseHash: string | null;
  baseAtISO: string | null;
};

/**
 * The device copy to store after an attempt the server did not take.
 * `revision` is the revision that attempt was made on (the page's revRef);
 * the typing time is kept when the answers are the same as the copy already
 * held, so a retry never makes old answers look new.
 */
export function nextDeviceCopy(
  prevRaw: string | null,
  o: { json: string; revision: number | null; nowISO: string; baseHash: string | null; baseAtISO: string | null },
): string {
  let typedAtISO = o.nowISO;
  try {
    const prev = prevRaw ? (JSON.parse(prevRaw) as Record<string, unknown>) : null;
    if (prev && typeof prev === "object" && JSON.stringify(prev.payload) === o.json) {
      const was = typeof prev.typedAtISO === "string" ? prev.typedAtISO : typeof prev.savedAtISO === "string" ? prev.savedAtISO : null;
      if (was) typedAtISO = was;
    }
  } catch { /* an unreadable copy is replaced by a fresh one */ }
  return JSON.stringify({
    typedAtISO,
    savedAtISO: o.nowISO,
    baseRevision: o.revision,
    baseHash: o.baseHash,
    baseAtISO: o.baseAtISO,
    payload: JSON.parse(o.json) as unknown,
  });
}

export type DeviceRestore =
  | { action: "none" }
  /** Nothing unsent in it: older than the whole submit, or the same as the server's copy. */
  | { action: "drop" }
  /** Typed on the server's current copy (or there is none): put back silently. */
  | { action: "restore"; copy: DeviceCopy }
  /** The server's copy moved on since this was typed: the person chooses. */
  | { action: "ask"; copy: DeviceCopy };

/**
 * What a freshly opened page does with the copy on this device, given the
 * server's open draft (`draft`: null when there is none with content).
 */
export function decideDeviceRestore(
  raw: string | null,
  o: { draft: { revision: number; savedAtISO: string; payload: DraftPayload } | null; debriefSubmittedAtISO: string | null },
): DeviceRestore {
  if (!raw) return { action: "none" };
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { action: "none" };
  }
  if (!m || typeof m !== "object" || !m.payload || typeof m.payload !== "object") return { action: "none" };
  const savedAtISO = typeof m.savedAtISO === "string" ? m.savedAtISO : "";
  const typedAtISO = typeof m.typedAtISO === "string" ? m.typedAtISO : savedAtISO;
  const base = m.baseRevision;
  const copy: DeviceCopy = {
    payload: normalizeDraftPayload(m.payload),
    typedAtISO,
    savedAtISO: savedAtISO || typedAtISO,
    baseRevision: "baseRevision" in m && (base === null || (typeof base === "number" && Number.isInteger(base))) ? (base as number | null) : undefined,
    baseHash: typeof m.baseHash === "string" ? m.baseHash : null,
    baseAtISO: typeof m.baseAtISO === "string" ? m.baseAtISO : null,
  };
  // A copy typed before the whole wrap-up's submit is not unsent any more:
  // that submit is what went in (review, Sep 25). By when it was TYPED — a
  // retry after the submit used to make it look newer.
  if (o.debriefSubmittedAtISO && typedAtISO < o.debriefSubmittedAtISO) return { action: "drop" };
  // No server copy with anything in it: nothing to overwrite.
  if (!o.draft) return { action: "restore", copy };
  if (JSON.stringify(copy.payload) === JSON.stringify(o.draft.payload)) return { action: "drop" };
  // A copy from before this rule knows no revision. Its stamp may be a retry's,
  // so a newer stamp proves nothing: ask rather than overwrite.
  if (copy.baseRevision === undefined) return typedAtISO > o.draft.savedAtISO ? { action: "ask", copy } : { action: "none" };
  return copy.baseRevision === o.draft.revision ? { action: "restore", copy } : { action: "ask", copy };
}

// cyrb53 — a small, stable, non-cryptographic string hash. This is change
// detection ("did somebody else save a different brief since you loaded the
// page?"), not a secret, so it only has to agree with itself on both sides.
function cyrb53(s: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The submitted answers a re-submit could overwrite — and the two other writers of them. */
export type SubmittedFields = {
  editorBrief: string | null;
  videoInstructions: string | null;
  removalNotes: string | null;
  shotOrderNotes: string | null;
  reelScript: string | null;
  scriptConfirmNote: string | null;
  videosFilmed: number | null;
};

/** The fingerprint of what is SUBMITTED on the job right now. Loaded with the
 *  page, sent back with a re-submit: if the Editing Room's brief editor (or
 *  another tab) changed any of it in between, the re-submit is refused
 *  instead of silently writing over that edit. */
export function submittedFieldsHash(p: SubmittedFields): string {
  return cyrb53(
    JSON.stringify([
      (p.editorBrief ?? "").trim(),
      (p.videoInstructions ?? "").trim(),
      (p.removalNotes ?? "").trim(),
      (p.shotOrderNotes ?? "").trim(),
      (p.reelScript ?? "").trim(),
      (p.scriptConfirmNote ?? "").trim(),
      p.videosFilmed ?? null,
    ]),
  );
}

/** Which of those fields differ, in the words the conflict panel uses. */
export function changedSubmittedFields(a: SubmittedFields, b: SubmittedFields): string[] {
  const names: [keyof SubmittedFields, string][] = [
    ["editorBrief", "the note for the editor"],
    ["videoInstructions", "the video instructions"],
    ["removalNotes", "the removal notes"],
    ["shotOrderNotes", "the shot order"],
    ["reelScript", "the script"],
    ["scriptConfirmNote", "the script confirmation"],
    ["videosFilmed", "the video count"],
  ];
  const norm = (v: unknown) => (typeof v === "string" ? v.trim() : v ?? null);
  return names.filter(([k]) => norm(a[k]) !== norm(b[k])).map(([, label]) => label);
}

// ---------------------------------------------------------------------------
// THE AUTOSAVER — a small state machine with its clock and its save call
// injected, so it runs the same in the browser and in a node drill.
//
//   change()  → Saving… after a 1.2 s pause in typing, and never later than
//               10 s after the first unsaved change (someone typing a long
//               brief without stopping still gets saved).
//   a failed save → "Unable to save — retrying", retried with backoff, and
//               the caller mirrors the answer on the device meanwhile.
//   flush()   → save now (the tab is being hidden, the connection came back).
//   a conflict → stops; the page asks the person which copy wins.
// ---------------------------------------------------------------------------
export type AutosaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; atISO: string }
  | { kind: "failed"; message: string; retryInMs: number }
  | { kind: "conflict" };

export type SaveOutcome =
  | { ok: true; savedAtISO: string }
  | { ok: false; conflict: true }
  | { ok: false; conflict?: false; message: string };

export type Timers = {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
};

export const AUTOSAVE_DEBOUNCE_MS = 1200;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
const RETRY_STEPS_MS = [3000, 8000, 20_000, 45_000];

export function createAutosaver(opts: {
  save: () => Promise<SaveOutcome>;
  onStatus: (s: AutosaveStatus) => void;
  timers?: Timers;
  debounceMs?: number;
  maxWaitMs?: number;
}) {
  const timers: Timers = opts.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };
  const debounceMs = opts.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const maxWaitMs = opts.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  let dirty = false;
  let inFlight = false;
  let firstDirtyAt: number | null = null;
  let timer: unknown = null;
  let failures = 0;
  let stopped = false;
  let status: AutosaveStatus = { kind: "idle" };
  const emit = (s: AutosaveStatus) => { status = s; opts.onStatus(s); };
  const arm = (ms: number) => {
    if (timer !== null) timers.clear(timer);
    timer = timers.set(() => { timer = null; void run(); }, ms);
  };

  async function run(): Promise<void> {
    if (stopped || !dirty) return;
    if (inFlight) return; // the running save re-checks `dirty` when it lands
    inFlight = true;
    dirty = false;
    firstDirtyAt = null;
    emit({ kind: "saving" });
    let out: SaveOutcome;
    try {
      out = await opts.save();
    } catch (e) {
      out = { ok: false, message: e instanceof Error ? e.message : "Unable to save" };
    }
    inFlight = false;
    if (stopped) return;
    if (out.ok) {
      failures = 0;
      emit({ kind: "saved", atISO: out.savedAtISO });
      if (dirty) arm(debounceMs); // typed while the save was in flight
      return;
    }
    if ("conflict" in out && out.conflict) {
      stopped = true;
      emit({ kind: "conflict" });
      return;
    }
    dirty = true; // the change is still unsaved
    const wait = RETRY_STEPS_MS[Math.min(failures, RETRY_STEPS_MS.length - 1)];
    failures++;
    emit({ kind: "failed", message: (out as { message: string }).message, retryInMs: wait });
    arm(wait);
  }

  return {
    /** Something the person typed changed the draft. */
    change() {
      if (stopped) return;
      dirty = true;
      const now = timers.now();
      if (firstDirtyAt === null) firstDirtyAt = now;
      const waited = now - firstDirtyAt;
      arm(Math.max(0, Math.min(debounceMs, maxWaitMs - waited)));
    },
    /** Save now if anything is unsaved. */
    flush(): Promise<void> {
      if (timer !== null) { timers.clear(timer); timer = null; }
      return run();
    },
    /** The person chose which copy wins; saving may carry on. */
    resume() { stopped = false; failures = 0; },
    /** Submitted or discarded — nothing more to save. */
    stop() { stopped = true; if (timer !== null) { timers.clear(timer); timer = null; } },
    get status() { return status; },
    get dirty() { return dirty; },
  };
}
