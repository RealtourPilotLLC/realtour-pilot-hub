// ---------------------------------------------------------------------------
// Reading a submitted upload page back (Jordan, Sep 15 2026: "I'd like to be
// able to see the previous uploads in the upload portal like what was
// uploaded and the notes for them ... and also make adjustments to them").
//
// Pure helpers shared by the /upload rows, the Past uploads history and the
// job page's "What you submitted" card. Client-safe on purpose: no prisma, no
// server-only modules — only the sentinel constants and the evidence parser,
// both of which are already client-safe.
//
// The photographer's sectioned video brief is stored composed into ONE column
// (Project.videoInstructions — "VISION FOR THE EDIT\n…\n\nSUMMARY\n…", written
// by UploadPortal.composeVideoInstructions). The free-text "Anything else for
// the editor?" box is Project.editorBrief. parseEditorBriefSections reads
// either: a label only counts when it is an ENTIRE line (a legacy brief that
// merely contains the word "SUMMARY" mid-sentence must not be split).
// ---------------------------------------------------------------------------

import { parseEvidence } from "@/lib/statusEvidence";
import { NOTHING_TO_REMOVE_SENTINEL, FRONT_TO_BACK_SENTINEL, INTERIOR_EXTERIOR_SENTINEL } from "@/lib/debrief";

/** Section labels the portal composes, in the order the editor reads them. */
export const BRIEF_SECTION_TITLES: Record<string, string> = {
  "VISION FOR THE EDIT": "Vision for the edit",
  SUMMARY: "Summary",
  "SHOTS THAT MUST BE SHOWN": "Shots that must be shown",
  "THINGS TO AVOID": "Things to avoid",
  "AREAS TO AVOID": "Things to avoid", // pre-Sep-2 heading — same box
  "REALTOR REQUESTS": "Realtor requests",
  "ADDITIONAL NOTES": "Additional notes",
  "INTRO SCRIPT": "Intro script",
  "EDITING NOTES": "Editing notes",
};

export type BriefSection = { label: string; title: string; text: string };
export type ParsedBrief = {
  /** the "STYLE: …" line, when the brief carries one */
  style: string | null;
  /** the "COLOR PROFILE: …" line (iPhone / S-Log3, D-LogM) */
  colorProfile: string | null;
  /** labelled sections with content, in the order written */
  sections: BriefSection[];
  /** text before any label — a legacy free-text brief lands here whole */
  preface: string;
  empty: boolean;
};

/** Split a composed brief back into its labelled sections. Never throws;
 *  an empty / null input parses to `empty: true`. */
export function parseEditorBriefSections(text: string | null | undefined): ParsedBrief {
  const out: ParsedBrief = { style: null, colorProfile: null, sections: [], preface: "", empty: true };
  if (!text?.trim()) return out;
  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  const preface: string[] = [];
  let current: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const style = current === null ? line.match(/^STYLE:\s*(.+)$/) : null;
    if (style) { out.style = style[1].trim(); continue; }
    const color = line.match(/^COLOR PROFILE:\s*(.+)$/);
    if (color) { out.colorProfile = color[1].trim(); continue; }
    if (BRIEF_SECTION_TITLES[line]) {
      current = line;
      if (!buckets.has(line)) { buckets.set(line, []); order.push(line); }
      continue;
    }
    if (current) buckets.get(current)!.push(raw);
    else preface.push(raw);
  }
  for (const label of order) {
    const body = (buckets.get(label) ?? []).join("\n").trim();
    if (body) out.sections.push({ label, title: BRIEF_SECTION_TITLES[label], text: body });
  }
  out.preface = preface.join("\n").trim();
  out.empty = !out.style && !out.colorProfile && out.sections.length === 0 && !out.preface;
  return out;
}

/** Word-safe clip with an ellipsis (same shape as lib/text.ts clip, kept
 *  local so this module stays import-free for client bundles). */
export function clipNote(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, Math.max(1, max - 1));
  const cut = head.lastIndexOf(" ");
  return (cut > max * 0.6 ? head.slice(0, cut) : head).trimEnd() + "…";
}

export type NotesPreview = {
  /** the lead note — VISION FOR THE EDIT first, then SUMMARY, then whatever
   *  else the photographer wrote (intro script, editing notes, the free-text
   *  "anything else" box) */
  lead: { title: string; text: string } | null;
  /** "front to back" / "interior first, then exterior" / the typed order */
  shotOrder: string | null;
  /** "nothing" or the removal list */
  remove: string | null;
};

/** The one-glance notes line for a history row. `max` bounds the lead. */
export function notesPreview(
  p: { videoInstructions: string | null; editorBrief: string | null; shotOrderNotes: string | null; removalNotes: string | null },
  max = 160,
): NotesPreview {
  const brief = parseEditorBriefSections(p.videoInstructions);
  const pick = (label: string) => brief.sections.find((s) => s.label === label) ?? null;
  const first =
    pick("VISION FOR THE EDIT") ?? pick("SUMMARY") ?? pick("INTRO SCRIPT") ?? pick("EDITING NOTES") ?? brief.sections[0] ?? null;
  let lead: NotesPreview["lead"] = null;
  if (first) lead = { title: first.title, text: clipNote(first.text, max) };
  else if (brief.preface) lead = { title: "Video notes", text: clipNote(brief.preface, max) };
  else if (p.editorBrief?.trim()) lead = { title: "For the editor", text: clipNote(p.editorBrief, max) };
  return { lead, shotOrder: shotOrderSummary(p.shotOrderNotes), remove: removalSummary(p.removalNotes) };
}

/** The shot-order answer in a few words (sentinels → plain words). */
export function shotOrderSummary(shotOrderNotes: string | null | undefined, max = 120): string | null {
  if (!shotOrderNotes?.trim()) return null;
  if (shotOrderNotes === FRONT_TO_BACK_SENTINEL) return "front to back";
  if (shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL) return "interior first, then exterior";
  return clipNote(shotOrderNotes.replace(/^Out of order — /, "out of order — "), max);
}

/** The removal answer in a few words ("nothing" for the confirmed sentinel). */
export function removalSummary(removalNotes: string | null | undefined, max = 120): string | null {
  if (!removalNotes?.trim()) return null;
  if (removalNotes === NOTHING_TO_REMOVE_SENTINEL) return "nothing";
  return clipNote(removalNotes, max);
}

// ---- What was uploaded --------------------------------------------------

export type UploadMarkState = "uploaded" | "not_completed" | "pending";

/** One deliverable's mark, the way the portal's checklist reads it: a saved
 *  "couldn't complete" reason is authoritative, then the tick or a detected
 *  status (UPLOADED / IN_PROGRESS / DONE), else still pending. */
export function uploadMark(d: { uploadedAt: string | Date | null; status: string; notCompletedReason: string | null }): UploadMarkState {
  if (d.notCompletedReason) return "not_completed";
  if (d.uploadedAt != null || ["UPLOADED", "IN_PROGRESS", "DONE"].includes(d.status)) return "uploaded";
  return "pending";
}

export type RawCounts = { photos: number | null; drone: number | null; video: number | null };

/** Raw counts when known: the persisted AutoHDR count (photoCount.ts) first,
 *  else the status engine's last Dropbox read; video only from the engine. */
export function rawCounts(p: { rawPhotoCount: number | null; dronePhotoCount: number | null; statusEvidence: string | null }): RawCounts {
  const ev = parseEvidence(p.statusEvidence);
  const dbx = ev?.dropbox ?? null;
  return {
    photos: p.rawPhotoCount ?? dbx?.rawPhotos ?? null,
    drone: p.dronePhotoCount ?? null,
    video: dbx?.rawVideo ?? null,
  };
}

// ---- Who submitted / who edited -----------------------------------------
//
// The page never stored a submitter: the first submit wrote one FILE line and
// the payroll stamp. From Sep 15 the office may re-open a submitted page, so
// finalizeUpload leaves a NOTE naming whoever touched it when that person is
// not the shoot's photographer. These prefixes are the contract between the
// writer (upload/actions.ts) and the reader (submissionTrail below).

export const UPLOAD_COMPLETED_BODY = "Photographer completed upload. Editor brief is ready for the editors.";
export const UPLOAD_SUBMITTED_BY_PREFIX = "Upload page submitted by ";
export const UPLOAD_EDITED_BY_PREFIX = "Upload notes edited by ";

export type SubmissionTrail = {
  submittedBy: string | null;
  lastEdited: { by: string; atISO: string } | null;
};

/** Read the submitter and the last editor off the job's timeline. A
 *  photographer's own re-submit logs the same FILE line as the first submit,
 *  so any such line well after the payroll stamp counts as their edit. */
export function submissionTrail(
  activities: { type: string; body: string; createdAtISO: string }[],
  opts: { photographerName: string | null; submittedAtISO: string | null },
): SubmissionTrail {
  const nameOf = (body: string, prefix: string) => body.slice(prefix.length).replace(/\.$/, "").trim();
  let submittedBy: string | null = null;
  const edits: { by: string; atISO: string }[] = [];
  const submittedMs = opts.submittedAtISO ? Date.parse(opts.submittedAtISO) : NaN;
  for (const a of activities) {
    if (a.body.startsWith(UPLOAD_SUBMITTED_BY_PREFIX)) {
      // The earliest such line is the submit; anything later is an edit.
      if (!submittedBy) submittedBy = nameOf(a.body, UPLOAD_SUBMITTED_BY_PREFIX) || null;
      else edits.push({ by: nameOf(a.body, UPLOAD_SUBMITTED_BY_PREFIX), atISO: a.createdAtISO });
    } else if (a.body.startsWith(UPLOAD_EDITED_BY_PREFIX)) {
      edits.push({ by: nameOf(a.body, UPLOAD_EDITED_BY_PREFIX), atISO: a.createdAtISO });
    } else if (a.type === "FILE" && a.body === UPLOAD_COMPLETED_BODY) {
      const at = Date.parse(a.createdAtISO);
      if (Number.isFinite(submittedMs) && at > submittedMs + 120_000) {
        edits.push({ by: opts.photographerName ?? "the photographer", atISO: a.createdAtISO });
      }
    }
  }
  edits.sort((a, b) => Date.parse(b.atISO) - Date.parse(a.atISO));
  return { submittedBy: submittedBy ?? opts.photographerName, lastEdited: edits[0] ?? null };
}

// ---- The history row (serialisable — crosses the server action boundary) --

export type UploadHistoryRow = {
  id: string;
  street: string;
  clientName: string;
  clientAvatarUrl: string | null;
  shootISO: string | null;
  photographer: { id: string; name: string; avatarColor: string } | null;
  /** debriefSubmittedAt — the human submit; null = "uploaded, page never submitted" */
  submittedISO: string | null;
  uploadedISO: string | null;
  status: string;
  marks: { label: string; state: UploadMarkState; reason: string | null }[];
  counts: RawCounts;
  /** files uploaded through the page (UploadedFile rows) */
  files: number;
  /** human field flags on the job */
  flags: number;
  notes: NotesPreview;
};

export type UploadHistoryPage = {
  rows: UploadHistoryRow[];
  total: number;
  hasMore: boolean;
  offset: number;
};

/** One office filter chip: a photographer with history, and how much. */
export type UploadHistoryPhotographer = { id: string; name: string; avatarColor: string; count: number };
