import { videoStepSpec, type VideoScriptMode, type VideoStepSpec } from "@/lib/pipeline";
import { etAt, etDateTime, etDayKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// FILES IN IS NOT INSTRUCTIONS READY (audit WF-06, Sep 18 2026).
//
// `ensureEditorHandoff` mints editing work from FOOTAGE EVIDENCE — Dropbox
// files appearing in the job's folder. Its select carries no debriefSubmittedAt,
// no videoInstructions, no reelScript and no order titles, so it cannot tell a
// complete handoff from a pile of files, and the delivery board's blocker falls
// through to `ready_to_edit`: Kyle is told the job is ready to cut when nobody
// has said what to cut.
//
// The upload portal ALREADY enforces the right rule at the photographer's
// submit (upload/actions.ts, finalizeUpload) using videoStepSpec. The gap is
// that nothing reads it afterwards, so a job whose footage arrived any other
// way — the Dropbox sweep, a re-upload, a hand-placed folder — skips the gate
// entirely. This is that same spec, as a pure function, so the queue, the board
// and the handoff engine can all ask the one question.
//
// WHAT IT MUST NOT DO: demand anything of a plain social reel. pipeline.ts and
// upload/actions.ts both carry Jordan's words — "if it's a standard social
// reel, it doesn't need additional notes" — and a new mandatory form on the
// simple product is exactly the kind of change that makes people stop using a
// tool. `minimalReel` is ready the moment the footage is in.
// ---------------------------------------------------------------------------

/**
 * Boilerplate the upload portal composes into the instructions field. A brief
 * made only of these lines is an empty brief wearing a hat: the STYLE and
 * COLOR PROFILE lines are added by the UI, and the section headings are
 * printed whether or not anything was typed under them. Matched by PREFIX for
 * the two that carry a value, because COLOR PROFILE differs by video tier
 * ("iPhone" for standard, "S-Log3, D-LogM" for premium — Jordan, Sep 2).
 */
const BOILERPLATE_HEADINGS = new Set([
  "VISION FOR THE EDIT",
  "SUMMARY",
  "SHOTS THAT MUST BE SHOWN",
  "AREAS TO AVOID",
  "THINGS TO AVOID",
  "REALTOR REQUESTS",
  "ADDITIONAL NOTES",
  "INTRO SCRIPT",
  "EDITING NOTES",
]);

/** The photographer's OWN words, with the machine's lines stripped out. */
export function meaningfulBrief(text: string | null | undefined): string {
  return (text ?? "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t && !/^STYLE:/.test(t) && !/^COLOR PROFILE:/.test(t) && !BOILERPLATE_HEADINGS.has(t);
    })
    .join("")
    .trim();
}

export type HandoffInput = {
  /** Order item / deliverable titles — what was SOLD, which is what decides the spec. */
  titles: (string | null | undefined)[];
  /** A full video product (not just a reel) is on the order. */
  hasFullVideo: boolean;
  isPremium?: boolean;
  isMonthly?: boolean;
  /** The photographer pressed submit on the upload page. Distinct from uploadedAt, which the Dropbox sweep can stamp on its own. */
  debriefSubmittedAt: Date | null;
  /**
   * The VIDEO half's own handoff (O05, Sep 25 2026 — Project.videoHandoffAt).
   * Photos and video are submitted separately now, and the edit waits on the
   * video half only: a photographer who sent the photos tonight has not handed
   * the editor anything. Null on every job submitted the old way, which is why
   * the gap below coalesces with the whole-page stamp rather than replacing it.
   */
  videoSubmittedAt?: Date | null;
  /**
   * The resolved video step (pipeline.resolveVideoSpec — the Deliverable
   * .videoStyle stamp first, canceled lines and excused rows filtered). When a
   * caller has it, readiness asks exactly what the upload page asked; without
   * it the names decide, as they always have.
   */
  spec?: VideoStepSpec;
  videoInstructions: string | null;
  editorBrief: string | null;
  reelScript: string | null;
  reelHook: string | null;
  scriptConfirmedAt: Date | null;
  videosFilmed: number | null;
  /** Who shot it — the person a missing brief is owed by. */
  photographerName?: string | null;
  photographerKey?: string | null;
};

export type HandoffGap = {
  key: "debrief" | "instructions" | "script" | "intro" | "video-count";
  /** What is missing, in the words a person would use. */
  label: string;
  /** Whose move it is. */
  owedBy: "photographer" | "office";
};

export type HandoffReadiness = {
  ready: boolean;
  mode: VideoScriptMode;
  /** A plain social reel: nothing is demanded and nothing is missing. */
  minimalReel: boolean;
  gaps: HandoffGap[];
  /** One sentence for a card, or null when there is nothing to say. */
  blockedReason: string | null;
  ownerKey: string | null;
  ownerName: string | null;
};

/**
 * Is this job's handoff complete, what is missing, and whose move is it?
 *
 * Pure — no database, no clock — so the queue, the board and the handoff engine
 * can each call it on data they already hold and cannot disagree.
 */
export function handoffReadiness(p: HandoffInput): HandoffReadiness {
  const spec = p.spec ?? videoStepSpec(p.titles, {
    hasFullVideo: p.hasFullVideo,
    isPremium: p.isPremium,
    isMonthly: p.isMonthly,
  });

  const gaps: HandoffGap[] = [];

  // A plain reel earns "nothing demanded" — it is not a fallthrough. Everything
  // else owes at least the photographer's own words about the edit.
  if (!spec.minimalReel) {
    if (!meaningfulBrief(p.videoInstructions) && !meaningfulBrief(p.editorBrief)) {
      gaps.push({
        key: "instructions",
        label: "the flow and vision for the edit",
        owedBy: "photographer",
      });
    }
  }

  // A premium package's script can never be blank — it is the product.
  if (spec.requireScript && !(p.reelScript ?? "").trim() && !(p.reelHook ?? "").trim()) {
    gaps.push({ key: "script", label: "the script for this premium video", owedBy: "photographer" });
  }

  // An agent-intro package needs the intro typed exactly as it was delivered.
  if (spec.requireIntro && !(p.reelScript ?? "").trim() && !meaningfulBrief(p.videoInstructions)) {
    gaps.push({ key: "intro", label: "the agent's intro script, as delivered on camera", owedBy: "photographer" });
  }

  // A monthly batch cannot be cut without knowing how many were filmed.
  if (spec.requireVideoCount && !(p.videosFilmed && p.videosFilmed > 0)) {
    gaps.push({ key: "video-count", label: "how many videos were filmed", owedBy: "photographer" });
  }

  // The debrief is the photographer SAYING they are done. Asked last, and only
  // on jobs that owe a brief at all: on a plain reel the files arriving is the
  // whole handoff, and demanding a submit as well would be the new mandatory
  // form this must not become.
  if (!spec.minimalReel && !(p.videoSubmittedAt ?? p.debriefSubmittedAt)) {
    gaps.push({ key: "debrief", label: "the wrap-up on the upload page", owedBy: "photographer" });
  }

  const who = p.photographerName?.trim() || null;
  const blockedReason =
    gaps.length === 0
      ? null
      : `Waiting on ${gaps.map((g) => g.label).join(", ")}${who ? ` from ${who}` : ""}.`;

  return {
    ready: gaps.length === 0,
    mode: spec.mode,
    minimalReel: spec.minimalReel,
    gaps,
    blockedReason,
    // Every gap defined here is the photographer's; the field exists so the
    // office can own one later (a client reference, a style decision) without
    // the callers changing.
    ownerKey: gaps.length && gaps.every((g) => g.owedBy === "photographer") ? p.photographerKey ?? null : null,
    ownerName: gaps.length && gaps.every((g) => g.owedBy === "photographer") ? who : null,
  };
}

// ---------------------------------------------------------------------------
// PHOTOS AND VIDEO ARE HANDED OFF SEPARATELY (O05 / A31, Sep 25 2026).
//
// One job, two halves. The photographer can send the photos tonight and the
// video tomorrow, and each half moves on its own: Kyle's photo QC card stops
// waiting on a video brief, and the edit waits on the video half only.
// Project.debriefSubmittedAt keeps its meaning — the WHOLE wrap-up is in —
// because My Pay visibility and the wrap-up KPI read it, and Jordan has not
// changed either. Rows submitted before the split carry only that stamp, so
// every reader coalesces with it rather than needing a backfill.
// ---------------------------------------------------------------------------
export type HandoffCategory = "photos" | "video";
export const PHOTO_HANDOFF_TYPES: readonly string[] = ["PHOTOS", "DRONE", "TWILIGHT"];
export const VIDEO_HANDOFF_TYPES: readonly string[] = ["VIDEO", "SOCIAL_REEL"];

/** Which half of the wrap-up a deliverable belongs to (null = neither: a floor plan, a 3D tour). */
export function handoffCategoryOf(type: string): HandoffCategory | null {
  if (PHOTO_HANDOFF_TYPES.includes(type)) return "photos";
  if (VIDEO_HANDOFF_TYPES.includes(type)) return "video";
  return null;
}

type OwedRow = { type: string; notCompletedReason?: string | null; waivedAt?: Date | string | null; removedFromOrderAt?: Date | string | null };
/** The halves this job still owes a handoff for: a category with at least one
 *  row that is neither "couldn't complete", waived, nor off the order. */
export function liveHandoffCategories(rows: OwedRow[]): HandoffCategory[] {
  const out = new Set<HandoffCategory>();
  for (const d of rows) {
    if (d.notCompletedReason || d.waivedAt || d.removedFromOrderAt) continue;
    const c = handoffCategoryOf(d.type);
    if (c) out.add(c);
  }
  return (["photos", "video"] as const).filter((c) => out.has(c));
}

/** When each half was handed off — its own stamp, else the whole-page stamp. */
export function categoryHandoffAt(
  p: { photosHandoffAt?: Date | null; videoHandoffAt?: Date | null; debriefSubmittedAt?: Date | null },
  c: HandoffCategory,
): Date | null {
  return (c === "photos" ? p.photosHandoffAt : p.videoHandoffAt) ?? p.debriefSubmittedAt ?? null;
}

// ---------------------------------------------------------------------------
// THE VIDEO HALF IS DUE AT 8:00 AM THE NEXT DAY (Jordan, Sep 25 2026): "hey
// photos are uploaded but video is not. Please upload the video before 8am
// tomorrow … This is something that will affect their KPI's."
//
// "Tomorrow" is the calendar day after the photos went in, in Eastern time —
// a Saturday included, because that is what he said. Computed from the two
// stamps, never stored, so the reminder, the late mark and the KPI cannot hold
// three different deadlines. No pay effect: this is a reliability measure.
// ---------------------------------------------------------------------------
export const VIDEO_HALF_DUE_HOUR = 8;

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
}

/** 8:00 AM ET on the day after the photos were handed off. */
export function videoHalfDueAt(photosHandoffAt: Date): Date {
  return etAt(nextDayKey(etDayKey(photosHandoffAt)), VIDEO_HALF_DUE_HOUR);
}

export type VideoHalfClock = {
  due: Date;
  /** the video half is in, and it came in after `due` */
  submittedLate: boolean;
  /** still owed and `due` has passed */
  overdue: boolean;
  /** still owed (the whole wrap-up is not in) */
  owed: boolean;
};

/**
 * The deadline for a job whose photos went in AHEAD of the video. Null when
 * the clock never started: nothing was split (a whole-page submit), or the
 * video went in first. A job whose video was later excused (the whole wrap-up
 * stamped without a video half) owes nothing and is never late.
 *
 * `videoLive` (liveHandoffCategories(...).includes("video")): pass it whenever
 * the caller has the deliverables. A video every line of which was marked
 * "couldn't complete", waived by the office or taken off the order AFTER the
 * photos went in is not owed either — without this the clock read only the
 * stamps and scored that shoot a late upload for good (review, Sep 25).
 * Absent = the stamps decide, as before.
 */
export function videoHalfClock(
  p: { photosHandoffAt?: Date | null; videoHandoffAt?: Date | null; debriefSubmittedAt?: Date | null; videoLive?: boolean },
  now: Date = new Date(),
): VideoHalfClock | null {
  if (!p.photosHandoffAt) return null;
  if (p.videoHandoffAt && p.videoHandoffAt.getTime() <= p.photosHandoffAt.getTime()) return null;
  const due = videoHalfDueAt(p.photosHandoffAt);
  const owed = !p.videoHandoffAt && !p.debriefSubmittedAt && p.videoLive !== false;
  return {
    due,
    submittedLate: !!p.videoHandoffAt && p.videoHandoffAt.getTime() > due.getTime(),
    overdue: owed && now.getTime() > due.getTime(),
    owed,
  };
}

// ---------------------------------------------------------------------------
// WHAT IS ACTUALLY TRUE ABOUT THE FILES (§7.3, Sep 25 2026).
//
// Six different things used to be read as one: the photographer TICKING an
// item, Dropbox SHOWING files, the photographer SUBMITTING the half, the brief
// being COMPLETE, an editor STARTING, and a cut being HANDED IN. A tick with an
// empty folder read as "files arrived" on the delivery board, and the portal
// told a photographer who pressed "Submit anyway" past an empty-folder warning
// that "the editors know the files are in Dropbox". Each rung is its own
// field here, and an unreadable or stale-zero folder is UNKNOWN — never
// "missing" and never "in".
// ---------------------------------------------------------------------------
export type Tri = "yes" | "no" | "unknown";

export type CategoryEvidence = {
  category: HandoffCategory;
  /** the latest photographer tick (Deliverable.uploadedAt) on a live row of this half; null = none ticked */
  uploadReported: Date | null;
  /** fresh count > 0 = yes; fresh 0 = no; stale 0, unreadable or never read = unknown. A stale count > 0 is still real. */
  filesDetected: Tri;
  fileCount: number | null;
  /** the count was carried forward from an earlier read */
  stale: boolean;
  /** the half's own handoff stamp, else the whole-page stamp */
  handoffSubmitted: Date | null;
  /** video only: the handoff engine's verdict — ready (when), blocked (why), or not asked yet */
  readyToEdit: { at: Date } | { blocked: string } | null;
  /** video only: an editor SAID they started (explicit Start) — never inferred */
  editingStarted: Date | null;
  /** video only: cuts handed in (not uploading, not failed, not withdrawn) */
  outputSubmitted: number;
};

type DropboxEvidence = { rawPhotos?: number | null; rawVideo?: number | null; stale?: boolean } | null;

function dropboxOf(statusEvidence: string | null | undefined): DropboxEvidence {
  if (!statusEvidence) return null;
  try {
    const ev = JSON.parse(statusEvidence) as { dropbox?: DropboxEvidence };
    return ev?.dropbox ?? null;
  } catch {
    return null;
  }
}

function detected(count: number | null | undefined, stale: boolean): Tri {
  if (typeof count !== "number") return "unknown";
  if (count > 0) return "yes";
  return stale ? "unknown" : "no";
}

/** The evidence ladder, one entry per half this job owes. Pure. */
export function handoffEvidence(p: {
  deliverables: (OwedRow & { uploadedAt?: Date | null })[];
  statusEvidence?: string | null;
  photosHandoffAt?: Date | null;
  videoHandoffAt?: Date | null;
  debriefSubmittedAt?: Date | null;
  handoffReadyAt?: Date | null;
  handoffBlockedReason?: string | null;
  editingStartedAt?: Date | null;
  outputsSubmitted?: number;
}): CategoryEvidence[] {
  const dbx = dropboxOf(p.statusEvidence);
  const stale = !!dbx?.stale;
  return liveHandoffCategories(p.deliverables).map((category) => {
    const rows = p.deliverables.filter(
      (d) => handoffCategoryOf(d.type) === category && !d.notCompletedReason && !d.waivedAt && !d.removedFromOrderAt,
    );
    const ticks = rows.map((d) => d.uploadedAt).filter((x): x is Date => !!x);
    const count = dbx ? (category === "photos" ? dbx.rawPhotos : dbx.rawVideo) ?? null : null;
    return {
      category,
      uploadReported: ticks.length ? new Date(Math.max(...ticks.map((t) => t.getTime()))) : null,
      filesDetected: detected(count, stale),
      fileCount: typeof count === "number" ? count : null,
      stale,
      handoffSubmitted: categoryHandoffAt(p, category),
      readyToEdit:
        category !== "video"
          ? null
          : p.handoffBlockedReason
            ? { blocked: p.handoffBlockedReason }
            : p.handoffReadyAt
              ? { at: p.handoffReadyAt }
              : null,
      editingStarted: category === "video" ? p.editingStartedAt ?? null : null,
      outputSubmitted: category === "video" ? p.outputsSubmitted ?? 0 : 0,
    };
  });
}

/**
 * One rung of the ladder, in the words every surface prints (§7.3). `tone`
 * is how true it is: yes (it happened), no (it has not, or it was looked for
 * and not found), unknown (nobody could look). `detail` is the extra a screen
 * may show on hover — the blocker's own sentence — never part of the line.
 */
export type EvidenceRung = {
  key: "reported" | "found" | "handoff" | "ready" | "started" | "cuts";
  text: string;
  tone: Tri;
  detail?: string;
};

/**
 * The rungs of one half, in order. THE words: evidenceLine joins them, and the
 * edit tracker and the project summary both print them (lib/handoffLadder),
 * so those screens cannot describe the same files differently.
 */
export function evidenceRungs(e: CategoryEvidence, fmt: (d: Date) => string): EvidenceRung[] {
  const rungs: EvidenceRung[] = [];
  rungs.push(
    e.uploadReported
      ? { key: "reported", text: `upload reported ${fmt(e.uploadReported)}`, tone: "yes" }
      : { key: "reported", text: "no upload reported", tone: "no" },
  );
  rungs.push(
    e.filesDetected === "yes"
      ? { key: "found", text: `files found in Dropbox${e.fileCount ? ` (${e.fileCount})` : ""}`, tone: "yes" }
      : e.filesDetected === "no"
        ? { key: "found", text: "no files found in Dropbox", tone: "no" }
        : { key: "found", text: "Dropbox not confirmed", tone: "unknown" },
  );
  rungs.push(
    e.handoffSubmitted
      ? { key: "handoff", text: `handed off ${fmt(e.handoffSubmitted)}`, tone: "yes" }
      : { key: "handoff", text: "not handed off yet", tone: "no" },
  );
  if (e.category === "video") {
    if (e.readyToEdit && "at" in e.readyToEdit) rungs.push({ key: "ready", text: "ready to edit", tone: "yes" });
    else if (e.readyToEdit && "blocked" in e.readyToEdit) {
      rungs.push({ key: "ready", text: "not ready to edit", tone: "no", detail: e.readyToEdit.blocked });
    }
    if (e.editingStarted) rungs.push({ key: "started", text: `editing started ${fmt(e.editingStarted)}`, tone: "yes" });
    if (e.outputSubmitted > 0) {
      rungs.push({ key: "cuts", text: `${e.outputSubmitted} cut${e.outputSubmitted === 1 ? "" : "s"} handed in`, tone: "yes" });
    }
  }
  return rungs;
}

/** One plain line per half, for a brief or a tracker: only what is true. */
export function evidenceLine(e: CategoryEvidence, fmt: (d: Date) => string): string {
  const name = e.category === "photos" ? "Photos" : "Video";
  return `${name}: ${evidenceRungs(e, fmt).map((r) => r.text).join(" · ")}`;
}

/**
 * A half's evidence as it crosses from a server page to a client component
 * (dates as ISO strings). The upload portal gets THIS, not its own words: it
 * rebuilds the evidence (evidenceFromView) and prints ladderRows like the edit
 * tracker and the project summary, so the photographer, the editor and the
 * office read one set of words about one folder (§7.3, Sep 28). The portal's
 * own evidenceText said "ticked uploaded" and "Dropbox shows N files".
 */
export type EvidenceView = {
  category: HandoffCategory;
  uploadReportedISO: string | null;
  filesDetected: Tri;
  fileCount: number | null;
  stale: boolean;
  handoffISO: string | null;
  ready: { atISO: string } | { blocked: string } | null;
  editingStartedISO: string | null;
  outputSubmitted: number;
};

export function evidenceView(e: CategoryEvidence): EvidenceView {
  return {
    category: e.category,
    uploadReportedISO: e.uploadReported?.toISOString() ?? null,
    filesDetected: e.filesDetected,
    fileCount: e.fileCount,
    stale: e.stale,
    handoffISO: e.handoffSubmitted?.toISOString() ?? null,
    ready: !e.readyToEdit ? null : "at" in e.readyToEdit ? { atISO: e.readyToEdit.at.toISOString() } : { blocked: e.readyToEdit.blocked },
    editingStartedISO: e.editingStarted?.toISOString() ?? null,
    outputSubmitted: e.outputSubmitted,
  };
}

/** The view back as evidence. `handoffISO` overrides the half's handoff — the
 *  portal's own submit knows it before the page reloads. */
export function evidenceFromView(v: EvidenceView, handoffISO: string | null = v.handoffISO): CategoryEvidence {
  const at = (iso: string | null) => (iso ? new Date(iso) : null);
  return {
    category: v.category,
    uploadReported: at(v.uploadReportedISO),
    filesDetected: v.filesDetected,
    fileCount: v.fileCount,
    stale: v.stale,
    handoffSubmitted: at(handoffISO),
    readyToEdit: !v.ready ? null : "atISO" in v.ready ? { at: new Date(v.ready.atISO) } : { blocked: v.ready.blocked },
    editingStarted: at(v.editingStartedISO),
    outputSubmitted: v.outputSubmitted,
  };
}

/** A half of the ladder, ready for a screen: plain strings only, so it crosses to any component. */
export type LadderRow = { category: HandoffCategory; name: string; rungs: EvidenceRung[]; line: string };

/** The ladder as screens print it — Eastern times, the same words as evidenceLine. */
export function ladderRows(evidence: CategoryEvidence[], fmt: (d: Date) => string = (d) => etDateTime(d)): LadderRow[] {
  return evidence.map((e) => ({
    category: e.category,
    name: e.category === "photos" ? "Photos" : "Video",
    rungs: evidenceRungs(e, fmt),
    line: evidenceLine(e, fmt),
  }));
}

/** The timeline line a half's submit writes (O05) — "<prefix> by <who>." */
export const HALF_SUBMITTED_PREFIX: Record<HandoffCategory, string> = {
  photos: "Photos submitted on the upload page",
  video: "Video submitted on the upload page",
};

/**
 * The upload page's one sentence about the files after a submit (§7.3). It
 * used to say "the editors know the files are in Dropbox" every time — even
 * after "Submit anyway" past an empty-folder warning. Now: found, not found,
 * or not confirmed, and a forced submit is never read as proof.
 */
export function receiptSentence(evidence: { filesDetected: Tri }[], forced: boolean): string {
  if (forced || evidence.some((e) => e.filesDetected === "no")) {
    return "The last recorded Dropbox check did not show every file, so the office will check before editing starts.";
  }
  if (evidence.length > 0 && evidence.every((e) => e.filesDetected === "yes")) return "The last recorded Dropbox check showed files; the editor can confirm they are still there.";
  return "The hub has no confirmed file count for this view, so the office will check Dropbox.";
}
