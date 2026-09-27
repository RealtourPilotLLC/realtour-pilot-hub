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
};

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
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
    filmedTopicIds: topicIds,
    topicNotes,
    extraRows,
    scriptChoice: script === "as-written" || script === "edited" ? script : null,
    scriptText: str(r.scriptText, DRAFT_LIMITS.script),
    scriptNote: str(r.scriptNote, DRAFT_LIMITS.scriptNote),
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
