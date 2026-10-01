"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Upload,
  CheckCircle2,
  Circle,
  XCircle,
  AlertTriangle,
  Star,
  Flag,
  FileText,
  Loader2,
  Check,
  NotebookPen,
  Plus,
  X,
  FolderOpen,
} from "lucide-react";
import { DELIVERABLE_META, type VideoStepSpec } from "@/lib/pipeline";
import { videoStyleName, type VideoStyleKey } from "@/lib/videoStyles";
import { photoRangeFor } from "@/lib/culling";
import {
  markDeliverableUploaded, markDeliverableNotCompleted, flagIssue, finalizeUpload, submitUploadFeedback, setProjectSquareFeet,
  checkUploadRawFiles, readUploadAttempt, readUploadSquareFeet,
  reportMissedShot, planGapRecovery, closeProductionGap, recordFieldPreference, decideFieldReport,
} from "@/app/upload/actions";
import { saveUploadDraft, discardUploadDraft } from "@/app/upload/draftActions";
import {
  createAutosaver, changedSubmittedFields, restoredTopicTicks, settleDraftSave, DRAFT_TOPIC_CHECK_FAILED,
  initialTopicAnswer, nextDeviceCopy, decideDeviceRestore,
  type AutosaveStatus, type DraftPayload, type SubmittedFields,
} from "@/lib/uploadDraft";
import { evidenceFromView, handoffCategoryOf, ladderRows, receiptSentence, videoHalfDueAt, type EvidenceView, type HandoffCategory } from "@/lib/handoff";
// §7.3: the files ladder, drawn exactly as the edit tracker and the project summary draw it.
import { EvidenceLadder } from "@/components/editing/EditTracker";
import type { GapView } from "@/lib/productionGaps";
import { cn } from "@/lib/utils";
import type { DeliverableType, DeliverableStatus } from "@prisma/client";
import { etDate, etDateTime, etTime } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { Markdown } from "@/components/ui/Markdown";
import { Avatar } from "@/components/ui/Avatar";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import { WhatYouSubmitted, type SubmittedItem } from "@/components/upload/WhatYouSubmitted";
import { parseUploadAttempt, uploadAttemptFingerprint, type UploadAttempt } from "@/lib/uploadReceipt";

// ---------------------------------------------------------------------------
// The shoot debrief portal (rebuilt Aug 31 2026 per Jordan; readability pass
// Sep 1: numbered steps a tired photographer can scan on a phone at 9 PM).
// Files go to Dropbox directly — THIS page is where the photographer and the
// office get aligned. The job is not done until every step is answered.
// ---------------------------------------------------------------------------

type AskAction =
  // scope: O05 — which half this submit hands off (absent = the whole page).
  // baseHash: O04 — "submit mine anyway" after a conflict re-sends with the
  // fingerprint the server just reported, so it lands on purpose.
  | { kind: "submit"; force: boolean; scope?: HandoffCategory; baseHash?: string; reviewFingerprint?: string }
  | { kind: "toggle"; id: string; next: boolean; prevReason: string | undefined };

type FieldReportView = { id: string; body: string; status: string; scope: string; basis: "client_said" | "observation" | null; createdAtISO: string };
const DRAFT_MIRROR_KEY = (projectId: string) => `upload-draft:${projectId}`;
const ATTEMPT_MIRROR_KEY = (projectId: string) => `upload-attempt:${projectId}`;
const SIZE_ATTEMPT_MIRROR_KEY = (projectId: string) => `upload-size-attempt:${projectId}`;

/**
 * §7.5 / §6.8: one video's brief as the upload page carries it — the same row
 * the editor's page, the printed brief and the shoot screen read
 * (deliverableOutputs.outputBriefsFor), money-scrubbed, nothing else.
 */
export type PortalOutputBrief = {
  outputId: string;
  index: number;
  label: string;
  /** the Style Guide name of what is being cut, when it differs from the label */
  format: string;
  topicTitle: string | null;
  version: number | null;
  /** "Brief v2 · saved by …, <when>" — the line every surface prints */
  versionLabel: string;
  updatedBy: string | null;
  updatedAtISO: string | null;
  directionSource: "own" | "job" | "none";
  sections: { key: string; label: string; text: string }[];
};
/** What the page's note action answers: the video's brief as it is now, when it could be read. */
export type BriefNoteResult = { ok: boolean; changed: boolean; message: string; brief: PortalOutputBrief | null };

type Deliverable = {
  id: string;
  type: DeliverableType;
  quantity: number;
  status: DeliverableStatus;
  uploadedAt: string | null;
  notCompletedReason: string | null;
  /** the office marked it "Not required" — owed by nobody (O05 review) */
  waivedAt?: string | null;
};

const DETECTED: DeliverableStatus[] = ["UPLOADED", "IN_PROGRESS", "DONE"];
function initialUploaded(d: Deliverable): boolean {
  // A saved "couldn't complete" reason is authoritative — a mis-tap-promoted
  // status must not re-render the row green on reload while /ops shows the
  // reason (review). Marking uploaded always clears the reason server-side,
  // so a genuine upload can never carry a stale one.
  if (d.notCompletedReason) return false;
  return d.uploadedAt != null || DETECTED.includes(d.status);
}

import { NOTHING_TO_REMOVE_SENTINEL as NOTHING_SENTINEL, FRONT_TO_BACK_SENTINEL, INTERIOR_EXTERIOR_SENTINEL } from "@/lib/debrief";

// ---------------------------------------------------------------------------
// Video instructions are STRUCTURED (Jordan, Sep 1: "sectioning it off so it's
// nice and organized for the editor vs a big paragraph"). Stored composed into
// the one videoInstructions column with these labels, so the editor brief PDF
// and /edit render it sectioned with zero schema churn — and parsed back out
// on re-open.
// ---------------------------------------------------------------------------
const VID_STYLES = {
  fast: "Fast-Paced",
  cinematic: "Timeless & Elegant (Cinematic)",
  // Monthly plans (Starter/Accelerator/Pro) are ALWAYS this — Jordan, Sep 1:
  // no dropdown, the style is fixed. Kept in the same map so it composes,
  // parses and renders through the identical STYLE: line as the others.
  branding: "Personal Branding",
} as const;
type VidStyle = keyof typeof VID_STYLES;
// Reverse lookup so compose/parse can never drift — a style added to
// VID_STYLES round-trips automatically (review: "Personal Branding" was
// composed but not parsed, so it vanished on re-open).
const STYLE_BY_LABEL = new Map<string, VidStyle>(
  (Object.entries(VID_STYLES) as [VidStyle, string][]).map(([k, v]) => [v, k]),
);
const VID_SECTIONS = [
  { key: "vision", label: "VISION FOR THE EDIT", title: "Vision for the edit", required: true, placeholder: "The feel and the story — e.g. luxury and calm; let the property breathe; the hook is the double-height foyer." },
  { key: "summary", label: "SUMMARY", title: "Summary", required: false, placeholder: "The shoot in two lines — what was captured, the flow, anything unusual." },
  { key: "mustShow", label: "SHOTS THAT MUST BE SHOWN", title: "Shots that must be shown", required: false, placeholder: "e.g. drone push-in over the pool · the kitchen island reveal · sunset patio clips at the end." },
  { key: "avoid", label: "THINGS TO AVOID", title: "Things to avoid", required: false, placeholder: "e.g. skip the unfinished office · avoid the neighbor's yard in the drone pass." },
  { key: "realtor", label: "REALTOR REQUESTS", title: "Realtor requests", required: false, placeholder: "Anything the agent asked for on site — features to hit, order, moments they want kept." },
  { key: "additional", label: "ADDITIONAL NOTES", title: "Additional notes", required: false, placeholder: "Anything else that shapes this edit." },
  // Agent-intro packages only (Jordan, Sep 1): the typed intro script +
  // simple editing notes replace the full section set. Same composed-column
  // storage, so the editor brief PDF and /edit render them for free.
  { key: "intro", label: "INTRO SCRIPT", title: "Intro script — exactly as the agent delivered it", required: true, placeholder: "Type the intro word for word as it was filmed — the editor cuts and captions to this." },
  { key: "editNotes", label: "EDITING NOTES", title: "Editing instructions / notes", required: false, placeholder: "Anything the editor should know — order, must-show moments, things to avoid." },
] as const;
type VidKey = (typeof VID_SECTIONS)[number]["key"];
// Which sections each package flavor shows (all compose/parse identically).
const AGENT_INTRO_KEYS: readonly VidKey[] = ["intro", "editNotes"];
const FULL_KEYS: readonly VidKey[] = ["vision", "summary", "mustShow", "avoid", "realtor", "additional"];
// A plain social reel needs no brief at all (Jordan, Sep 1: "if it's a
// standard social reel, it doesn't need additional notes") — one optional
// box, nothing demanded. Sep 2: this is ALSO the shape every standard-tier
// video gets (see BRIEF_BY_STYLE) — the box just becomes required when the
// order isn't a plain reel.
const MINIMAL_KEYS: readonly VidKey[] = ["editNotes"];
// The color profile follows the VIDEO TIER (Jordan, Sep 2): standard reels are
// shot on iPhone, premium is S-Log3 / D-LogM. It used to be one hard-coded
// S-Log3 line on every job, which told the editor a standard iPhone reel
// needed a log grade it never had.
const COLOR_PROFILE_LINE = {
  standard: "COLOR PROFILE: iPhone",
  premium: "COLOR PROFILE: S-Log3, D-LogM",
} as const;
type ColorTier = keyof typeof COLOR_PROFILE_LINE;

// ---------------------------------------------------------------------------
// THE VIDEO STYLE drives the brief (shared contract, Sep 2 2026). The Aryeo
// sync resolves Product.videoStyle onto Deliverable.videoStyle at order time
// and /upload/[id] hands the job's resolved key down — the same VideoStyleKey
// the Style Guide (src/lib/videoStyles.ts) and the editor brief read, so the
// photographer's form, the editor's "What to make" and the style examples can
// never describe three different videos. Before this, "Photography and
// Standard Reel w/ Agent intro" arrived as a "Social Reel" label and the
// intro script was only demanded when a name regex happened to match.
// ---------------------------------------------------------------------------
// style → field set → color line. ONE table, keyed by the shared union so a
// key added to VIDEO_STYLE_KEYS fails the build here until it gets a shape:
//   minimal     = the single editing-instructions box (MINIMAL_KEYS)
//   agent_intro = intro script (required) + editing notes (AGENT_INTRO_KEYS)
//   full        = the six sectioned fields + style picker (FULL_KEYS)
//   color "tier" = personal branding isn't a camera tier of its own (Jordan:
//                  STANDARD is iPhone, PREMIUM is S-Log3 / D-LogM, personal
//                  branding is the monthly plans) — it keeps following the
//                  Settings-mapped tier, exactly as before this table.
type BriefShape = "minimal" | "agent_intro" | "full";
const BRIEF_BY_STYLE: Record<VideoStyleKey, { shape: BriefShape; color: ColorTier | "tier" }> = {
  standard_reel:             { shape: "minimal",     color: "standard" },
  standard_reel_agent_intro: { shape: "agent_intro", color: "standard" },
  standard_cinematic:        { shape: "minimal",     color: "standard" },
  personal_branding:         { shape: "full",        color: "tier" },
  premium_social_reel:       { shape: "full",        color: "premium" },
  premium_cinematic:         { shape: "full",        color: "premium" },
};
// Parse-side match for EITHER line (mirrors the server's strip in
// upload/actions.ts). Compose re-adds the CURRENT tier's line, so a brief
// saved before a product was re-mapped in Settings heals itself on re-submit
// instead of carrying two profile lines.
const COLOR_PROFILE_RE = /^COLOR PROFILE:/;

function composeVideoInstructions(style: VidStyle | null, sections: Record<VidKey, string>, colorTier: ColorTier): string {
  const hasContent = style !== null || VID_SECTIONS.some((s) => sections[s.key]?.trim());
  // Nothing filled (photo-only jobs, untouched video forms) → EMPTY, so the
  // server never persists a brief that is just the auto color-profile line
  // (review: that vacuously satisfied the required-brief gate).
  if (!hasContent) return "";
  const parts: string[] = [];
  if (style) parts.push(`STYLE: ${VID_STYLES[style]}`);
  parts.push(COLOR_PROFILE_LINE[colorTier]);
  for (const s of VID_SECTIONS) {
    const v = sections[s.key]?.trim();
    if (v) parts.push(`${s.label}\n${v}`);
  }
  return parts.join("\n\n");
}

// Labels only count as section headers when they are an ENTIRE line — a legacy
// free-text brief that merely contains the word "SUMMARY" mid-sentence must
// not be mis-split and truncated on re-submit (review: silent prod data loss).
function parseVideoInstructions(text: string | null): { style: VidStyle | null; sections: Record<VidKey, string> } {
  const sections = Object.fromEntries(VID_SECTIONS.map((s) => [s.key, ""])) as Record<VidKey, string>;
  if (!text?.trim()) return { style: null, sections };
  let style: VidStyle | null = null;
  const lines = text.split("\n");
  const keyForLabel = new Map<string, VidKey>(VID_SECTIONS.map((s) => [s.label, s.key as VidKey]));
  // Briefs saved before Sep 2 2026 carry the old heading; read them into the
  // same box so nothing a photographer already wrote goes missing on re-open.
  keyForLabel.set("AREAS TO AVOID", "avoid");
  let current: VidKey | null = null;
  const prefix: string[] = []; // content before any label line (legacy text)
  for (const raw of lines) {
    const line = raw.trim();
    const styleMatch = line.match(/^STYLE:\s*(.+)$/);
    if (styleMatch && current === null) {
      const v = styleMatch[1].trim();
      style = STYLE_BY_LABEL.get(v) ?? style;
      continue;
    }
    if (COLOR_PROFILE_RE.test(line)) continue; // either tier's line — re-added from the live tier on compose
    const key = keyForLabel.get(line);
    if (key) { current = key; continue; }
    if (current) sections[current] += (sections[current] ? "\n" : "") + raw;
    else prefix.push(raw);
  }
  for (const s of VID_SECTIONS) sections[s.key] = sections[s.key].trim();
  const prefixText = prefix.join("\n").trim();
  if (prefixText) sections.vision = sections.vision ? `${prefixText}\n${sections.vision}` : prefixText;
  return { style, sections };
}

// One numbered step card: orange number while open, green check once its
// requirement is satisfied. The whole page reads as a checklist.
function StepCard({
  n, title, done, subtitle, children,
}: {
  n: number; title: string; done: boolean; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border bg-surface p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold",
            done ? "bg-success/15 text-success" : "bg-brand text-white",
          )}
        >
          {done ? <Check className="size-4.5" /> : n}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold leading-snug">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3 sm:pl-11">{children}</div>
    </section>
  );
}

// Small uppercase label that groups the standard into scannable chunks.
function MiniHeading({ children }: { children: React.ReactNode }) {
  return <div className="mb-1.5 mt-4 text-[11px] font-bold uppercase tracking-widest text-brand first:mt-0">{children}</div>;
}

// One group of the SOP §27 pre-upload checklist.
function CheckRow({ checked, onChange, title, text }: { checked: boolean; onChange: (v: boolean) => void; title: string; text: string }) {
  return (
    <label className={cn(
      "flex cursor-pointer items-start gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors",
      checked ? "border-success/40 bg-success-soft/30" : "border-border hover:bg-surface-2",
    )}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 shrink-0 accent-[var(--brand)]" />
      <span className="text-sm leading-snug">
        <span className={cn("font-semibold", checked && "text-success")}>{title}.</span>{" "}
        <span className="text-foreground/75">{text}</span>
      </span>
    </label>
  );
}

// CP-09: what the page says about a filmed-topics report that has not landed.
// The submit's own words (finalizeUpload's topicsPending) for one still
// retrying; a report that gave up is with the office, and says so — either
// way there is nothing for the photographer to redo.
function pendingTopicsMessage(state: string | null | undefined): string | null {
  if (!state || state === "APPLIED") return null;
  return state === "NEEDS_REVIEW"
    ? "Your footage is in and the editors have it. The topics you reported did not save on their own, so the office has them and is recording them by hand — nothing more you need to do."
    : "Your footage is in and the editors have it. The topics you ticked are saved, but the hub has not finished recording them yet — it retries on its own, so there is nothing more you need to do.";
}

// The page's own handle for a topic added on site — never part of the report's
// identity (the server hashes extras by title), so it only has to be unique on
// this page. randomUUID is missing outside a secure context; the fallback is
// plenty for ten rows.
function newExtraKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch { /* fall through */ }
  return `x${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// O04: the autosave's state, said plainly beside the submit button.
function draftChip(st: AutosaveStatus, canSave: boolean): React.ReactNode {
  if (!canSave) return null;
  if (st.kind === "saving") return <span className="ml-1.5 text-muted-2"> · Saving…</span>;
  if (st.kind === "saved") return <span className="ml-1.5 text-success"> · Draft saved {etTime(st.atISO)}</span>;
  // R02 (Sep 28 2026): a save held back because the topic list did not load
  // says so in the photographer's words; anything else keeps the old line.
  if (st.kind === "failed") {
    return (
      <span className="ml-1.5 text-warning">
        {" · "}{st.message === DRAFT_TOPIC_CHECK_FAILED ? DRAFT_TOPIC_CHECK_FAILED : "Unable to save — retrying (kept on this device)"}
      </span>
    );
  }
  if (st.kind === "conflict") return <span className="ml-1.5 text-warning"> · Another copy was saved — choose one above</span>;
  return null;
}

/**
 * §7.3 (Sep 28): what is true about the files, half by half, in THE words —
 * lib/handoff evidenceRungs through ladderRows, drawn by the edit tracker's own
 * EvidenceLadder, so the photographer reads what the editor and the office
 * read about the same folder. This page used to print its own line ("ticked
 * uploaded …", "Dropbox shows 12 files"). A tick is the photographer's word
 * ("upload reported"), never files; files are "found" only when Dropbox showed
 * them; a stale or failed read is "Dropbox not confirmed". The halves' handoff
 * times come from this page's own submit (halfAt) when it knows them first.
 */
export function PortalEvidence({ evidence, halfAt }: { evidence: EvidenceView[]; halfAt: { photos: string | null; video: string | null } }) {
  const rows = ladderRows(evidence.map((v) => evidenceFromView(v, (v.category === "photos" ? halfAt.photos : halfAt.video) ?? v.handoffISO)));
  return <EvidenceLadder rows={rows} className="mt-2.5" />;
}

// O04: a draft's style and sections, read back through the same keys the
// page composes with — anything the page does not know is dropped.
function draftStyle(p: DraftPayload): VidStyle | null {
  return p.vidStyle && p.vidStyle in VID_STYLES ? (p.vidStyle as VidStyle) : null;
}
function draftSections(p: DraftPayload): Record<VidKey, string> {
  return Object.fromEntries(VID_SECTIONS.map((sec) => [sec.key, p.vidSections[sec.key] ?? ""])) as Record<VidKey, string>;
}

export function UploadPortal({
  project,
  deliverables,
  specialRequests,
  flags: initialFlags,
  policy,
  script,
  foldersSlot,
  handoffFolders,
  submission,
  viewerIsOffice,
  payGateFromMs,
  sessionTopics,
  topicsUnavailable = false,
  draft,
  draftRevision,
  canSaveDraft,
  baseHash: loadedBaseHash,
  evidence,
  gaps,
  fieldReports,
  nowMs,
  outputBriefs = [],
  onBriefNote,
  briefNoteBlocked = null,
  briefNoteCap = 1000,
}: {
  project: {
    id: string;
    title: string;
    addressLine: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    packageName: string | null;
    shootDate: string | null;
    status: string;
    editorBrief: string | null;
    uploadedAt: string | null;
    /** the human submit (finalizeUpload) — null while only the sweep has stamped uploadedAt */
    debriefSubmittedAt: string | null;
    /** O05: each half's own handoff — null on a page submitted in one go */
    photosHandoffAt: string | null;
    photosHandoffBy: string | null;
    videoHandoffAt: string | null;
    videoHandoffBy: string | null;
    editorPdfPath: string | null;
    clientName: string;
    /** the agent's Aryeo headshot (Client.avatarUrl); null = initials disc */
    clientAvatarUrl: string | null;
    /** THE customer note, money-scrubbed (see src/lib/clientNotes.ts). */
    customerNote: string | null;
    photographerName: string | null;
    cullingConfirmedAt: string | null;
    shotOrderNotes: string | null;
    removalNotes: string | null;
    videoInstructions: string | null;
    videosFilmed: number | null;
    scriptConfirmedAt: string | null;
    scriptConfirmNote: string | null;
  };
  deliverables: Deliverable[];
  specialRequests: string[];
  flags: string[];
  policy: {
    photosOrdered: boolean;
    videoOrdered: boolean;
    photoTarget: number;
    range: { low: number; high: number; upper: number | null };
    rangeMode: "sop" | "legacy" | "override";
    squareFeet: number | null;
    /** the size band the client ordered, verbatim ("2,000-2,999 Sq. Ft.") —
     *  squareFeet holds the TOP of it, so the page must not imply we measured */
    squareFeetBand: string | null;
    /** what this order's video step must show and demand — see videoStepSpec */
    videoSpec: VideoStepSpec;
    /** THE resolved style (Deliverable.videoStyle, else the tier fallback —
     *  resolved once in /upload/[id]/page.tsx): picks the field set and the
     *  color-profile line via BRIEF_BY_STYLE; videoSpec was built from it */
    videoStyle: VideoStyleKey;
    /** videoTier(live deliverables) === "premium" — the camera tier behind the
     *  fallback, and the color line for a style that isn't a tier of its own
     *  (personal branding) */
    isPremium: boolean;
  };
  /** the shoot script pulled from Script Studio (null = none exists there) */
  script: { body: string; hook: string | null; url: string | null } | null;
  /** the Dropbox folders card, rendered by the server page */
  foldersSlot: React.ReactNode;
  /** Destination links only. A folder link is not evidence that files arrived. */
  handoffFolders: { key: string; label: string; url: string }[];
  /** the read-back of a submitted page (Sep 15) — who, when, add-ons, files */
  submission: {
    submittedBy: string | null;
    lastEdited: { by: string; atISO: string } | null;
    addOns: { item: string; note: string | null; addedBy: string | null; handled: boolean }[];
    files: { name: string; size: number }[];
  };
  /**
   * F12: the content-program topics this session is for, when it is one.
   * Null on an ordinary listing shoot — there is no month and no topic bank,
   * and the plain count box below is the whole of the question.
   */
  sessionTopics: {
    owed: number;
    topics: {
      topicId: string; title: string; pillarName: string | null; scriptTitle: string | null; clientApproved: boolean;
      filmedConfirmedAtISO: string | null; filmedConfirmedBy: string | null;
      /** CP-09: the session (project) the topic was confirmed at — null until somebody confirms it. */
      confirmedOnProjectId: string | null;
      /** CP-09: selected beyond the month's allowance — counted as an extra, never as planned */
      overflow: boolean;
      /** CP-09: the photographer's latest note to the editor about this topic on THIS job */
      note: string | null;
      /** CP-09: the topic's own raw folder under 02-RAW-Video, once one exists */
      folder: { label: string; url: string } | null;
    }[];
    /** CP-09: this job's last report, when it has not landed yet — what it said, so a reopened page shows it */
    pending: { state: string; topicIds: string[]; extras: { title: string; note: string }[] } | null;
  } | null;
  /**
   * R02: this is a content session, but its topic list FAILED to load (the
   * render's read threw). Not the same as no list: stored ticks are kept as
   * saved (never dropped), the page says so, and the video half waits for a
   * reload rather than being submitted by the bare count box.
   */
  topicsUnavailable?: boolean;
  /** owner/admin — the reopen button reads "Edit this upload" for them */
  viewerIsOffice: boolean;
  /** DEBRIEF_PAY_GATE_FROM (lib/payroll is server-only, so the page passes
   *  the number): shoots from this instant on are done only on the SUBMIT */
  payGateFromMs: number;
  /** O04: this viewer's unsent answers from an earlier visit (null = none worth restoring).
   *  baseHash = the submitted-fields fingerprint the draft was typed against. */
  draft: { revision: number; payload: DraftPayload; savedAtISO: string; baseHash?: string | null } | null;
  /** O04: the open draft's revision, whatever it holds (null = no open draft) */
  draftRevision: number | null;
  /** O04: signed in and not previewing — drafts are keyed to a person */
  canSaveDraft: boolean;
  /** O04: the submitted-fields fingerprint this page loaded with */
  baseHash: string;
  /** §7.3: received vs found vs handed off, per half */
  evidence: EvidenceView[];
  /** §7.6: missing work on this job */
  gaps: GapView[];
  /** §7.8: client preferences reported from the field, and where each stands */
  fieldReports: FieldReportView[];
  /** the page's one clock reading (a render must not read the clock) */
  nowMs: number;
  /** §7.5 / §6.8: each video's own brief, as the editor reads it (the page picks which to show) */
  outputBriefs?: PortalOutputBrief[];
  /** the page's server action: add an on-site note to one video's brief */
  onBriefNote?: (projectId: string, outputId: string, note: string) => Promise<BriefNoteResult>;
  /** why notes cannot be added from this view (a "view as" preview); null = they can */
  briefNoteBlocked?: string | null;
  /** one note's limit (deliverableOutputs.ON_SITE_NOTE_CAP; the server checks it again) */
  briefNoteCap?: number;
}) {
  const router = useRouter();
  // §7.5: the briefs live here, not in the card, so a note added before the
  // submit is still on the card the submitted page shows (and the other way round).
  const [briefs, setBriefs] = useState<PortalOutputBrief[]>(outputBriefs);
  const briefCard = (
    <VideoBriefs
      projectId={project.id}
      briefs={briefs}
      onSaved={(b) => setBriefs((all) => all.map((x) => (x.outputId === b.outputId ? b : x)))}
      action={onBriefNote ?? null}
      blocked={briefNoteBlocked}
      cap={briefNoteCap}
    />
  );
  const [uploaded, setUploaded] = useState<Record<string, boolean>>(
    Object.fromEntries(deliverables.map((d) => [d.id, initialUploaded(d)])),
  );
  // O04: a draft from an earlier visit seeds every answer below instead of
  // the submitted values — it is what the person last typed.
  const d0 = draft?.payload ?? null;
  const [editorBrief, setEditorBrief] = useState(d0 ? d0.editorBrief : project.editorBrief ?? "");
  const [flags, setFlags] = useState(initialFlags);
  const [flagInput, setFlagInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const submitBusyRef = useRef(false);
  const attemptRef = useRef<UploadAttempt | null>(null);
  const [pendingAttempt, setPendingAttempt] = useState<UploadAttempt | null>(null);
  const [checkingAttempt, setCheckingAttempt] = useState(false);
  const checkingAttemptRef = useRef(false);
  const [toggling, startToggle] = useTransition();
  // Collapsed = submitted. Before the Sep 2 payroll gate the sweep's
  // uploadedAt was the only stamp a finished job had, so those still read
  // as done off it; from the gate on, raws in Dropbox without a submit is an
  // OPEN page — it must not say "you're good to go … on your payroll" while
  // the /upload row says "Submit to add to payroll" (review, Sep 15).
  const [done, setDone] = useState(
    project.debriefSubmittedAt != null ||
      (project.uploadedAt != null && (project.shootDate == null || Date.parse(project.shootDate) < payGateFromMs)),
  );
  // The home's size drives which culling tier the page preaches. Kept in local
  // state so the range updates the moment it is saved, without a full reload.
  const [sqft, setSqft] = useState<string>(policy.squareFeet != null ? String(policy.squareFeet) : "");
  const [sqftSaved, setSqftSaved] = useState<number | null>(policy.squareFeet);
  // The band only describes the size while nobody has typed an exact one.
  const [bandText, setBandText] = useState<string | null>(policy.squareFeetBand);
  const [sqftBusy, setSqftBusy] = useState(false);
  const [sqftErr, setSqftErr] = useState<string | null>(null);
  const sqftBusyRef = useRef(false);
  const sqftSavedRef = useRef(policy.squareFeet);
  const sqftQueuedRef = useRef<number | null | undefined>(undefined);
  const sqftNeedsCheckRef = useRef(false);
  const [sqftNeedsCheck, setSqftNeedsCheck] = useState(false);
  const sqftAttemptRef = useRef<UploadAttempt | null>(null);
  // After a submit the whole checklist collapses to the confirmation — the page
  // is ~1,300px of answered steps, and scrolling back into it read as "did that
  // work?" (Jordan, Sep 3). Reopening is one tap for a correction.
  // A restored draft on a submitted page opens the checklist: the unsent
  // answers are the reason the person came back.
  const [reopened, setReopened] = useState(!!d0);
  const [pdfPath, setPdfPath] = useState<string | null>(project.editorPdfPath);
  // "Last edited by" on the read-back card — the server's answer until a
  // re-submit lands on this page, then "you" without a reload.
  const [lastEdited, setLastEdited] = useState(submission.lastEdited);
  const [err, setErr] = useState<string | null>(null);
  // CP-09: the footage went in but the filmed topics have not been recorded
  // yet (saved, and retried by the hub). Said plainly after the submit.
  const [topicsPending, setTopicsPending] = useState<string | null>(() => pendingTopicsMessage(sessionTopics?.pending?.state));
  const [processNote, setProcessNote] = useState("");
  const [processNoteSent, setProcessNoteSent] = useState(false);

  // --- Debrief state (prefilled from prior submits — re-opening never re-asks). ---
  // The SOP §27 pre-upload checklist: four groups, all four required.
  const confirmedBefore = !!project.cullingConfirmedAt;
  const [checks, setChecks] = useState(d0 ? d0.checks : { coverage: confirmedBefore, culling: confirmedBefore, quality: confirmedBefore, count: confirmedBefore });
  const cullOk = checks.coverage && checks.culling && checks.quality && checks.count;
  const setCheck = (k: keyof typeof checks) => (v: boolean) => setChecks((c) => ({ ...c, [k]: v }));
  const priorNothing = project.removalNotes === NOTHING_SENTINEL;
  const [removal, setRemoval] = useState(d0 ? d0.removal : priorNothing ? "" : project.removalNotes ?? "");
  const [nothingToRemove, setNothingToRemove] = useState(d0 ? d0.nothingToRemove : priorNothing);
  const priorStandardOrder =
    project.shotOrderNotes === FRONT_TO_BACK_SENTINEL || project.shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL;
  const [orderChoice, setOrderChoice] = useState<"front-to-back" | "interior-exterior" | "out-of-order" | null>(
    d0 ? d0.orderChoice
      : !project.shotOrderNotes ? null
      : project.shotOrderNotes === FRONT_TO_BACK_SENTINEL ? "front-to-back"
      : project.shotOrderNotes === INTERIOR_EXTERIOR_SENTINEL ? "interior-exterior"
      : "out-of-order",
  );
  // Strip the storage prefix on rehydrate — otherwise every re-submit would
  // re-wrap it ("Out of order — Out of order — …") — same pattern as scriptNote.
  const [orderNotes, setOrderNotes] = useState(
    d0 ? d0.orderNotes : priorStandardOrder ? "" : (project.shotOrderNotes ?? "").replace(/^Out of order — /, ""),
  );
  const parsedVid = parseVideoInstructions(project.videoInstructions);
  const [vidStyle, setVidStyle] = useState<VidStyle | null>(d0 ? draftStyle(d0) : parsedVid.style);
  const [vidSections, setVidSections] = useState<Record<VidKey, string>>(d0 ? draftSections(d0) : parsedVid.sections);
  // A job that already carries a brief (legacy free text, or a prior submit)
  // is never retro-blocked for the new required fields — same rule as the
  // server's first-finalize-only gates.
  const hadPriorBrief = !!project.videoInstructions?.trim();
  // What "answered" means depends on the package flavor: agent-intro packages
  // need the typed intro script; everything else needs vision + style.
  // Monthly plans: how many videos actually got filmed. The editor works from
  // this number (Jordan, Sep 1) — it's the only place the real batch size is
  // known, since the order carries one line item.
  const [videosFilmed, setVideosFilmed] = useState<string>(
    d0 ? d0.videosFilmed : project.videosFilmed != null ? String(project.videosFilmed) : "",
  );
  // F12: the topics this session is for. Pre-ticked ONLY where somebody has
  // already confirmed one — never a helpful default, because a pre-ticked box
  // the photographer skims past is the hub inventing a production fact.
  // CP-09: and only when it was confirmed at THIS session. A Pro month's second
  // session used to inherit the first session's ticks (and their count); a
  // topic confirmed elsewhere is that session's video, shown but not tickable.
  const confirmedElsewhere = (t: { confirmedOnProjectId: string | null }) =>
    !!t.confirmedOnProjectId && t.confirmedOnProjectId !== project.id;
  // A topic already RECORDED as filmed at this session stays ticked: a
  // re-submit never walks a confirmation back (the server keeps it and keeps
  // counting it), so an untick here would only make the page disagree with
  // the job. A correction is the office's, on the record.
  const recordedHere = (t: { confirmedOnProjectId: string | null }) => t.confirmedOnProjectId === project.id;
  // A report that has not landed yet is still the photographer's word about
  // this job: its ticks come back ticked, so re-sending the page unchanged is
  // the same report rather than a different answer.
  // A draft's ticks come back too — but only for topics this session can
  // still tick, and never un-ticking one already recorded here.
  // R02 (Sep 28 2026): when the list did not load, the ticks come back exactly
  // as saved. Filtering them against a list that failed to load emptied them,
  // and the next autosave stored the empty list over the real one.
  const ticksFrom = (ids: string[]) =>
    restoredTopicTicks({ unavailable: topicsUnavailable, topics: sessionTopics?.topics ?? [], ids, projectId: project.id });
  // Where the page's topic answer starts (lib/uploadDraft initialTopicAnswer —
  // the drill runs the same rule on the real page's props): the draft's answer
  // when it has one, else the job's own (the report not landed yet, the notes
  // on file). R02 follow-up (Sep 28 2026): with the list unavailable and no
  // draft answer, the page has NO topic answer — `unknown`, not "none". Its
  // empty fields are placeholders, and the draft says so (topicsUnknown) rather
  // than saving them over a report's ticks and extras.
  const [topic0] = useState(() => initialTopicAnswer({
    draft: d0,
    unavailable: topicsUnavailable,
    topics: sessionTopics?.topics ?? [],
    pending: sessionTopics?.pending ?? null,
    projectId: project.id,
  }));
  const [topicAnswerUnknown, setTopicAnswerUnknown] = useState(topic0.unknown);
  const [filmedTopicIds, setFilmedTopicIds] = useState<string[]>(topic0.ticks);
  const hasTopics = (sessionTopics?.topics.length ?? 0) > 0;
  const toggleTopic = (id: string) => {
    if (sessionTopics?.topics.some((t) => t.topicId === id && (confirmedElsewhere(t) || recordedHere(t)))) return;
    setFilmedTopicIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  };
  // CP-09: a note to the editor per topic (collapsed until asked for), and the
  // topics filmed on site that were not on the list. Both ride the same report
  // as the ticks, so they land — or wait and retry — together.
  const [topicNotes, setTopicNotes] = useState<Record<string, string>>(topic0.notes);
  const [notesOpen, setNotesOpen] = useState<string[]>(() => Object.keys(topicNotes));
  const [extraRows, setExtraRows] = useState<{ key: string; title: string; note: string }[]>(
    () => topic0.extras.map((x, i) => ({ key: topic0.source === "draft" ? newExtraKey() : `pending-${i}`, title: x.title, note: x.note })),
  );
  const liveExtras = extraRows
    .map((x) => ({ ...x, title: x.title.replace(/\s+/g, " ").trim() }))
    .filter((x) => x.title);
  // Answered by topic (ticks and/or extras) rather than by the bare count box.
  // Never while the list is unavailable: the ticks carried then are unchecked,
  // and the video half is held until a reload (missingItems below).
  const answersByTopic = !topicsUnavailable && (hasTopics || liveExtras.length > 0);
  const overflowOf = new Map((sessionTopics?.topics ?? []).map((t) => [t.topicId, t.overflow]));
  const plannedTicked = filmedTopicIds.filter((id) => !overflowOf.get(id)).length;
  const extraCount = filmedTopicIds.length - plannedTicked + liveExtras.length;
  const topicCount = filmedTopicIds.length + liveExtras.length;
  // With a topic list, the count IS the number of ticks plus the extras —
  // asking for it twice invites two different answers about the same shoot.
  const videosFilmedNum = answersByTopic
    ? topicCount || null
    : /^\d{1,3}$/.test(videosFilmed.trim())
      ? Number(videosFilmed.trim())
      : null;
  const spec = policy.videoSpec;
  // A fixed-style job composes with that style regardless of the picker state.
  // Scoped to a job that ACTUALLY ordered video: isMonthlyContentJob matches on
  // any deliverable label, so a "Content Day" photo-only job would otherwise
  // compose a phantom "STYLE: Personal Branding" brief and permanently waive
  // the vision gate (review).
  const effectiveStyle: VidStyle | null = spec.fixedStyle && policy.videoOrdered ? "branding" : vidStyle;
  // The FIELD SET and the color line follow the resolved VIDEO STYLE (Jordan,
  // Sep 2: "Standard reels should just have an editing instructions box,
  // while Premium has all of the editing instruction fields"; agent-intro
  // reels get the intro script + notes; monthly plans keep their Sep 1 rule —
  // every field, fixed style, video count). Aryeo names are too messy to
  // switch on — one order item is literally "Video" — so this reads the key
  // the page resolved from Deliverable.videoStyle (tier fallback when no row
  // is stamped yet), the same answer videoSpec was built from.
  const brief = BRIEF_BY_STYLE[policy.videoStyle];
  const colorTier: ColorTier = brief.color === "tier" ? (policy.isPremium ? "premium" : "standard") : brief.color;
  const vidInstructions = composeVideoInstructions(effectiveStyle, vidSections, colorTier);
  const fullFields = brief.shape === "full";
  // The one standard box is REQUIRED unless the order is a plain social reel
  // (Sep 1: those need nothing) or the intro script already carries the
  // photographer's words — the server gate demands their own text on every
  // other shape, so the page has to ask before the server refuses.
  const notesRequired = brief.shape === "minimal" && !spec.minimalReel && !spec.requireIntro;
  // Which sections this order shows. The intro rides on top for agent-intro
  // packages whatever the tier: an intro ADD-ON on a premium bundle keeps that
  // bundle's full brief — the listing video is separately directed (review
  // HIGH) — while on a standard bundle or standalone it's intro + notes only.
  const sectionKeys: readonly VidKey[] = spec.requireIntro
    ? (fullFields ? (["intro", ...FULL_KEYS] as VidKey[]) : AGENT_INTRO_KEYS)
    : fullFields ? FULL_KEYS : MINIMAL_KEYS;
  // Names exactly what THIS order must fill, so the closing warning can't say
  // "vision and style" on a shape whose only required field is the intro.
  const requiredLabels = [
    spec.requireIntro ? "The intro script" : null,
    spec.requireVideoCount ? (answersByTopic || topicsUnavailable ? "Which topics you filmed" : "The video count") : null,
    fullFields ? (spec.fixedStyle ? "vision" : "vision and style") : null,
    notesRequired ? "Your editing instructions" : null,
  ].filter(Boolean) as string[];
  const isRequiredKey = (k: VidKey) =>
    (k === "intro" && spec.requireIntro) || (k === "vision" && fullFields) || (k === "editNotes" && notesRequired);
  const countAnswered = !spec.requireVideoCount || project.videosFilmed != null || (videosFilmedNum ?? 0) > 0;
  const vidAnswered =
    countAnswered &&
    (hadPriorBrief ||
    ((!spec.requireIntro || !!vidSections.intro.trim()) &&
      (!fullFields || (!!vidSections.vision.trim() && effectiveStyle !== null)) &&
      (!notesRequired || !!vidSections.editNotes.trim())));
  const [scriptChoice, setScriptChoice] = useState<"as-written" | "edited" | null>(
    d0 ? d0.scriptChoice
      : project.scriptConfirmedAt
      ? project.scriptConfirmNote?.startsWith("Edited") ? "edited" : "as-written"
      : null,
  );
  const [scriptText, setScriptText] = useState(d0 && (d0.scriptChoice === "edited" || !script) && d0.scriptText ? d0.scriptText : script?.body ?? "");
  // Re-hydrate the "what changed" detail so a re-submit can't wipe it.
  const [scriptNote, setScriptNote] = useState(
    d0 ? d0.scriptNote
      : project.scriptConfirmNote?.startsWith("Edited on site — ")
      ? project.scriptConfirmNote.slice("Edited on site — ".length)
      : "",
  );

  // "Couldn't complete" answers (Jordan, Sep 1): an unchecked box with no
  // explanation tells the admin nothing — each item can carry the reason it
  // wasn't completed, which lands on the project timeline + Kyle's QC card.
  const [notDone, setNotDone] = useState<Record<string, string>>(
    Object.fromEntries(deliverables.filter((d) => d.notCompletedReason).map((d) => [d.id, d.notCompletedReason as string])),
  );
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reasonText, setReasonText] = useState("");
  // IN-PAGE confirmation, never window.confirm(). The portal is opened from a
  // text message, so it runs in mobile Safari / the Messages in-app browser —
  // and a native confirm() raised AFTER an await (outside the tap's gesture)
  // is suppressed or auto-answered "cancel" there. That's why Harrison's
  // "hold on" prompt wouldn't let him continue when he pressed OK (Jordan,
  // Sep 1). An inline panel is deterministic and readable on a phone.
  // The panel stores a SERIALISABLE intent, never a function: a stored closure
  // would capture the render it was created in, so anything typed while the
  // panel was open got silently dropped from the submit (review HIGH). The
  // yes button dispatches from the CURRENT render instead.
  const [ask, setAsk] = useState<{ body: string; yes: string; action: AskAction; review?: boolean } | null>(null);
  const [rawCheck, setRawCheck] = useState<Awaited<ReturnType<typeof checkUploadRawFiles>> | null>(null);
  const [checkingRaw, setCheckingRaw] = useState(false);
  const rawCheckRequest = useRef(0);

  // ---- O04: THE DRAFT AUTOSAVE -------------------------------------------
  // Every answer below is saved as the person types (1.2 s after they pause,
  // never more than 10 s behind), to their own server-side draft. Saving is
  // NOT submitting: it writes one UploadDraft row and nothing else, so it can
  // never finalize the job, notify an editor or put the shoot on payroll.
  // While the server cannot be reached the answers are mirrored on this device
  // and retried; a copy saved elsewhere since this page loaded is a conflict
  // the person resolves, never a silent overwrite.
  const draftPayload: DraftPayload = useMemo(
    () => ({
      editorBrief, checks, removal, nothingToRemove, orderChoice, orderNotes,
      vidStyle, vidSections, videosFilmed, filmedTopicIds, topicNotes,
      extraRows: extraRows.map((x) => ({ title: x.title, note: x.note })),
      scriptChoice, scriptText: scriptChoice === "edited" || !script ? scriptText : "", scriptNote,
      // R02 follow-up: no topic answer on this page — the server keeps the
      // stored draft's, and a later page takes the job's own.
      ...(topicAnswerUnknown ? { topicsUnknown: true as const } : {}),
    }),
    [editorBrief, checks, removal, nothingToRemove, orderChoice, orderNotes, vidStyle, vidSections, videosFilmed, filmedTopicIds, topicNotes, extraRows, scriptChoice, scriptText, scriptNote, script, topicAnswerUnknown],
  );
  const payloadJson = JSON.stringify(draftPayload);
  const payloadRef = useRef(draftPayload);
  const lastSavedJson = useRef(payloadJson);
  const revRef = useRef<number | null>(draftRevision);
  // O04 (review, Sep 25): a restored draft keeps the fingerprint IT was typed
  // against — for its autosaves and its submit — so a job that moved after it
  // was saved is refused and named at submit, never overwritten by it. Taking
  // this page's fresh fingerprint instead is what let a stale draft through.
  const draftBase = draft?.baseHash || null;
  const baseHashRef = useRef(draftBase ?? loadedBaseHash);
  /** When the answers the fingerprint describes were read — a change is only
   *  pinned on a person whose timeline line is newer. */
  const baseAtRef = useRef(draft && draftBase ? draft.savedAtISO : new Date(nowMs).toISOString());
  const [movedSinceDraft, setMovedSinceDraft] = useState(!!draftBase && draftBase !== loadedBaseHash);
  // O04: the fingerprint the next re-submit carries — the page's (or the
  // restored draft's), then each submit's own answer.
  const [submitHash, setSubmitHash] = useState(draftBase ?? loadedBaseHash);
  const saverRef = useRef<ReturnType<typeof createAutosaver> | null>(null);
  const [saveStatus, setSaveStatus] = useState<AutosaveStatus>({ kind: "idle" });
  // `device`: the conflict is between the copy kept on THIS device (now on the
  // page) and the server's, found when the page opened — its fingerprint is
  // taken only if the person keeps it (review of the R02 repair, Sep 28 2026).
  const [draftConflict, setDraftConflict] = useState<{
    revision: number; payload: DraftPayload; savedAtISO: string; by: string | null; submitted: boolean;
    device?: { typedAtISO: string; baseHash: string | null; baseAtISO: string | null };
  } | null>(null);
  const draftConflictRef = useRef<typeof draftConflict>(null);
  const holdDraftConflict = (value: typeof draftConflict) => { draftConflictRef.current = value; setDraftConflict(value); };
  const [restored, setRestored] = useState<{ atISO: string; from: "server" | "device" } | null>(
    draft ? { atISO: draft.savedAtISO, from: "server" } : null,
  );
  const mirrorKey = DRAFT_MIRROR_KEY(project.id);
  // The copy records the revision these answers were typed on and WHEN they
  // were typed — kept across retries of the same answers (lib/uploadDraft
  // nextDeviceCopy). It used to be re-stamped "now" on every failed attempt,
  // so a copy typed before another device's save looked newer than it and was
  // pushed over that save on the next reload (review of the R02 repair).
  const writeMirror = (json: string) => {
    try {
      window.localStorage.setItem(mirrorKey, nextDeviceCopy(window.localStorage.getItem(mirrorKey), {
        json, revision: revRef.current, nowISO: new Date().toISOString(), baseHash: baseHashRef.current, baseAtISO: baseAtRef.current,
      }));
    } catch { /* private window */ }
  };
  const clearMirror = () => {
    try { window.localStorage.removeItem(mirrorKey); } catch { /* private window */ }
  };
  /** Put a draft's answers back on the page (the conflict's "use that copy", a device copy). */
  function applyDraft(p: DraftPayload) {
    setEditorBrief(p.editorBrief);
    setChecks(p.checks);
    setRemoval(p.removal);
    setNothingToRemove(p.nothingToRemove);
    setOrderChoice(p.orderChoice);
    setOrderNotes(p.orderNotes);
    setVidStyle(draftStyle(p));
    setVidSections(draftSections(p));
    setVideosFilmed(p.videosFilmed);
    // R02 follow-up: a copy saved with no topic answer (topicsUnknown) says
    // nothing about the topics — the page keeps the answer it has. One that
    // has an answer brings it, and the page then HAS an answer to save.
    if (!p.topicsUnknown) {
      setFilmedTopicIds(ticksFrom(p.filmedTopicIds));
      setTopicNotes({ ...p.topicNotes });
      setExtraRows(p.extraRows.map((x) => ({ key: newExtraKey(), title: x.title, note: x.note })));
      setTopicAnswerUnknown(false);
    }
    setScriptChoice(p.scriptChoice);
    if (p.scriptChoice === "edited" || !script) setScriptText(p.scriptText || script?.body || "");
    setScriptNote(p.scriptNote);
  }
  useEffect(() => { payloadRef.current = draftPayload; }, [draftPayload]);
  useEffect(() => {
    if (!canSaveDraft) return;
    const saver = createAutosaver({
      onStatus: setSaveStatus,
      save: async () => {
        const payload = payloadRef.current;
        const json = JSON.stringify(payload);
        // The device copy goes ONLY when the server says these answers are
        // saved (settleDraftSave — the drill runs the same rule). R02: the
        // server used to say "saved" after stripping every topic tick when the
        // topic list failed to load, and this deleted the one copy that still
        // held them. It now answers "not saved, retryable" instead, the copy
        // stays, and the autosaver retries with the same revision.
        const device = { keep: () => writeMirror(JSON.stringify(payloadRef.current)), clear: () => {
          if (submitBusyRef.current || attemptRef.current || JSON.stringify(payloadRef.current) !== json) writeMirror(JSON.stringify(payloadRef.current));
          else clearMirror();
        } };
        try {
          const r = await saveUploadDraft(project.id, { revision: revRef.current, baseHash: baseHashRef.current, payload });
          const settled = settleDraftSave(r, device);
          if (settled.revision !== null) {
            revRef.current = settled.revision;
            lastSavedJson.current = json;
          }
          if (settled.conflict) holdDraftConflict(settled.conflict);
          return settled.outcome;
        } catch {
          device.keep();
          return { ok: false, message: "Unable to save" };
        }
      },
    });
    saverRef.current = saver;
    // A copy kept on THIS device while the server could not take it. Read
    // after mount (the server render has no device storage), on the next tick,
    // and decided by lib/uploadDraft decideDeviceRestore:
    //   · typed before the whole wrap-up's submit, or the same as the server's
    //     copy → nothing unsent in it, dropped (review, Sep 25). A copy from
    //     before one HALF may still hold the other half's unsent answers, so
    //     it is kept — its fingerprint makes the submit show what changed;
    //   · typed on the server's CURRENT copy (same revision), or there is none
    //     → it is what the person last typed: put back, and pushed by the
    //     change below;
    //   · the server's copy moved on since it was typed (another device saved)
    //     → the person chooses, in the conflict panel. Nothing is pushed until
    //     they do. This used to be "restore when the copy's stamp is newer" —
    //     a stamp every failed retry renewed (review of the R02 repair).
    const restoreTimer = setTimeout(() => {
      try {
        const d = decideDeviceRestore(window.localStorage.getItem(mirrorKey), {
          draft: draft ? { revision: draft.revision, savedAtISO: draft.savedAtISO, payload: draft.payload } : null,
          // An uncertain attempt may consume the draft after a later edit was
          // typed. Its old timestamp cannot prove that device text submitted.
          debriefSubmittedAtISO: parseUploadAttempt(window.localStorage.getItem(ATTEMPT_MIRROR_KEY(project.id))) ? null : project.debriefSubmittedAt,
        });
        if (d.action === "drop") { clearMirror(); return; }
        if (d.action === "none") return;
        const m = d.copy;
        if (d.action === "ask" && draft) {
          // Hold the autosave FIRST: putting the copy on the page is a change,
          // and a save now would be the silent overwrite this asks about.
          saver.stop();
          applyDraft(m.payload);
          setReopened(true);
          holdDraftConflict({
            revision: draft.revision, payload: draft.payload, savedAtISO: draft.savedAtISO, by: null, submitted: false,
            device: { typedAtISO: m.typedAtISO, baseHash: m.baseHash, baseAtISO: m.baseAtISO },
          });
          return;
        }
        applyDraft(m.payload);
        // The fingerprint the copy was typed against, when it carries one.
        if (m.baseHash) {
          baseHashRef.current = m.baseHash;
          setSubmitHash(m.baseHash);
          baseAtRef.current = m.baseAtISO ?? m.typedAtISO ?? baseAtRef.current;
          setMovedSinceDraft(m.baseHash !== loadedBaseHash);
        }
        setRestored({ atISO: m.typedAtISO || new Date().toISOString(), from: "device" });
        setReopened(true);
      } catch { /* unreadable mirror — the server copy stands */ }
    }, 0);
    const onHide = () => { if (document.visibilityState === "hidden") void saver.flush(); };
    const onOnline = () => { void saver.flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("online", onOnline);
    return () => {
      clearTimeout(restoreTimer);
      saver.stop();
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("online", onOnline);
    };
    // Built once per page: its save reads the latest answers through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSaveDraft, project.id]);
  useEffect(() => {
    if (!canSaveDraft || !saverRef.current) return;
    if (payloadJson === lastSavedJson.current) return;
    if (submitBusyRef.current || attemptRef.current) { writeMirror(payloadJson); return; }
    saverRef.current.change();
    // writeMirror reads the current baseline refs; its identity is not a
    // payload change and must not restart or release a held autosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadJson, canSaveDraft]);

  function keepMineAfterConflict() {
    if (submitBusyRef.current || attemptRef.current) return;
    if (!draftConflict) return;
    revRef.current = draftConflict.submitted ? null : draftConflict.revision;
    // The device copy won: it goes on with the fingerprint IT was typed against.
    const dev = draftConflict.device;
    if (dev) {
      if (dev.baseHash) {
        baseHashRef.current = dev.baseHash;
        setSubmitHash(dev.baseHash);
        baseAtRef.current = dev.baseAtISO ?? dev.typedAtISO;
        setMovedSinceDraft(dev.baseHash !== loadedBaseHash);
      }
      setRestored({ atISO: dev.typedAtISO, from: "device" });
    }
    holdDraftConflict(null);
    saverRef.current?.resume();
    saverRef.current?.change();
  }
  function takeTheirsAfterConflict() {
    if (submitBusyRef.current || attemptRef.current) return;
    if (!draftConflict) return;
    revRef.current = draftConflict.revision;
    lastSavedJson.current = JSON.stringify(draftConflict.payload);
    applyDraft(draftConflict.payload);
    clearMirror();
    holdDraftConflict(null);
    saverRef.current?.resume();
  }
  function discardDraft() {
    if (submitBusyRef.current || attemptRef.current) return;
    saverRef.current?.stop();
    clearMirror();
    startTransition(async () => {
      await discardUploadDraft(project.id).catch(() => null);
      window.location.reload();
    });
  }

  // O05: each half's own handoff, as this page knows it (updated by a submit).
  const [halfAt, setHalfAt] = useState<{ photos: string | null; video: string | null }>({
    photos: project.photosHandoffAt,
    video: project.videoHandoffAt,
  });
  // §7.3: the person pressed "Submit anyway" past an empty-folder warning.
  const [forcedSubmit, setForcedSubmit] = useState(false);

  const addr = [project.addressLine, project.city, project.state, project.zip].filter(Boolean).join(", ");
  const total = deliverables.length;
  const doneCount = Object.values(uploaded).filter(Boolean).length;
  const notDoneCount = deliverables.filter((d) => !uploaded[d.id] && notDone[d.id]).length;
  // "Remaining" = truly unanswered — a "couldn't complete + reason" item is
  // accounted for, so it doesn't nag on submit.
  const remaining = deliverables.filter((d) => !uploaded[d.id] && !notDone[d.id] && !d.waivedAt);
  const reviewFingerprint = JSON.stringify({ payloadJson, uploaded, notDone, flags, evidence });

  function toggle(id: string) {
    const next = !uploaded[id];
    const prevReason = notDone[id];
    // A saved "couldn't complete" reason must not be silently converted into
    // an upload by one stray tap on the amber row (review).
    if (next && prevReason) {
      setAsk({
        body: "Mark this as uploaded instead? That clears the “couldn’t complete” reason you saved.",
        yes: "Mark uploaded",
        action: { kind: "toggle", id, next, prevReason },
      });
      return;
    }
    applyToggle(id, next, prevReason);
  }

  function applyToggle(id: string, next: boolean, prevReason: string | undefined) {
    setUploaded((u) => ({ ...u, [id]: next }));
    if (next) {
      // Marking it uploaded supersedes an earlier "couldn't complete".
      setNotDone((m) => { const c = { ...m }; delete c[id]; return c; });
      if (reasonFor === id) setReasonFor(null);
    }
    startToggle(async () => {
      try {
        await markDeliverableUploaded(id, next);
      } catch {
        // Roll back BOTH optimistic changes — the DB still holds the reason.
        setUploaded((u) => ({ ...u, [id]: !next }));
        if (next && prevReason) setNotDone((m) => ({ ...m, [id]: prevReason }));
        setErr("Couldn’t save that — check your connection and try again.");
      }
    });
  }

  function saveNotCompleted(id: string, r: string) {
    const prevReason = notDone[id];
    const prevUploaded = uploaded[id];
    if (r) {
      setNotDone((m) => ({ ...m, [id]: r }));
      setUploaded((u) => ({ ...u, [id]: false }));
    } else {
      if (prevReason === undefined) return;
      // Withdraw — back to a plain "Not yet" row.
      setNotDone((m) => { const c = { ...m }; delete c[id]; return c; });
    }
    setReasonFor(null);
    setReasonText("");
    startToggle(async () => {
      try {
        const res = await markDeliverableNotCompleted(id, r);
        if (!res.ok) throw new Error(res.message ?? "save failed");
      } catch (e) {
        // Restore exactly what was there before, and reopen the editor with
        // the typed text so retry is one tap — a silently-lost reason is the
        // bare unchecked box this feature exists to prevent (review).
        setNotDone((m) => {
          const c = { ...m };
          if (prevReason === undefined) delete c[id];
          else c[id] = prevReason;
          return c;
        });
        setUploaded((u) => ({ ...u, [id]: prevUploaded }));
        if (r) { setReasonFor(id); setReasonText(r); }
        setErr(e instanceof Error && e.message !== "save failed" ? e.message : "Couldn’t save that — check your connection and try again.");
      }
    });
  }

  function submitFlag() {
    const body = flagInput.trim();
    if (!body) return;
    setFlags((prev) => [body, ...prev]);
    setFlagInput("");
    startTransition(async () => {
      await flagIssue(project.id, body);
    });
  }

  // Gate scoping follows the LIVE deliverables: a "couldn't complete" answer
  // excuses its whole category (the server mirrors this in finalizeUpload) —
  // a reel the agent canceled on site must not demand fabricated video
  // instructions or a script attestation (review HIGH).
  // An item the office marked "Not required" is owed by nobody either (O05
  // review): the page used to keep telling the photographer the reel was due
  // by 8 AM, and asking for its answers, after the office waived it.
  const liveType = (types: string[]) =>
    deliverables.some((d) => types.includes(d.type) && !d.waivedAt && (uploaded[d.id] || !notDone[d.id]));
  const photosLive = policy.photosOrdered && liveType(["PHOTOS", "DRONE", "TWILIGHT"]);
  const videoLive = policy.videoOrdered && liveType(["VIDEO", "SOCIAL_REEL"]);

  // O05: photos and video are handed off separately when a job owes both and
  // the whole wrap-up is not in yet. A job with one half keeps the one button.
  const splitMode = photosLive && videoLive && !done;

  // What still blocks the submit — same rules the server enforces. `scope`
  // narrows it to one half (O05); absent = the whole page, as before.
  function missingItems(scope?: HandoffCategory): string[] {
    const missing: string[] = [];
    const pOn = photosLive && scope !== "video";
    const vOn = videoLive && scope !== "photos";
    if (pOn && !cullOk) missing.push("the pre-upload checklist (all four boxes)");
    if (pOn && orderChoice === null) missing.push("answer the shot order");
    if (pOn && orderChoice === "out-of-order" && !orderNotes.trim()) missing.push("the order you shot the home (and why)");
    if (pOn && !removal.trim() && !nothingToRemove) missing.push("answer the removal notes");
    if (vOn && !hadPriorBrief) {
      if (spec.requireIntro && !vidSections.intro.trim()) missing.push("the agent's intro script — type it exactly as delivered");
      if (fullFields && !vidSections.vision.trim()) missing.push("the vision for the edit");
      if (fullFields && effectiveStyle === null) missing.push("pick an edit style");
      if (notesRequired && !vidSections.editNotes.trim()) missing.push("your editing instructions for the editor");
    }
    // R02: a content session whose topic list did not load can't hand the
    // video over — it would go without a filming report (no list, no ticks).
    // A reload brings the list back; the photos half is unaffected.
    if (vOn && topicsUnavailable) missing.push("reload the page (this job's topic list didn't load)");
    if (vOn && liveExtras.some((x) => !x.note.trim())) missing.push("a note for each extra video filmed on site");
    if (vOn && !topicsUnavailable && spec.requireVideoCount && project.videosFilmed == null && !((videosFilmedNum ?? 0) > 0)) {
      missing.push(answersByTopic ? "tick the topics you filmed (or add one you filmed on site)" : "how many videos you filmed");
    }
    if (vOn && script && !scriptChoice) missing.push("confirm the script");
    if (vOn && scriptChoice === "edited" && !scriptText.trim()) missing.push("the edited script text (or pick “Delivered as written”)");
    // Premium packages: the script can NOT be left blank (Jordan, Sep 1) —
    // when Studio has none, the photographer types what was delivered.
    if (vOn && spec.requireScript && !script && !hadPriorBrief && !scriptText.trim()) {
      missing.push("the script — this premium package can't be submitted without it");
    }
    return missing;
  }

  function finalize(scope?: HandoffCategory) {
    if (submitBusyRef.current || attemptRef.current) return;
    const missing = missingItems(scope);
    if (missing.length > 0) {
      setErr(`Not done yet — ${missing.join(" · ")}. ${scope ? `The ${scope} can't be submitted until every step for them is answered.` : "The job isn't finished until every step is answered."}`);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const rem = scope ? remaining.filter((d) => handoffCategoryOf(d.type) === scope) : remaining;
    // Re-read the actual Dropbox location for this review. A page-load count
    // is only historical evidence after someone spends time on the debrief.
    const request = ++rawCheckRequest.current;
    setRawCheck(null);
    setCheckingRaw(true);
    checkUploadRawFiles(project.id, scope).then((result) => {
      if (rawCheckRequest.current === request) setRawCheck(result);
    }).catch(() => {
      // A provider/read error is unknown, never an empty folder or a reason to
      // discard the photographer's answers.
    }).finally(() => {
      if (rawCheckRequest.current === request) setCheckingRaw(false);
    });
    setAsk({
      body: rem.length
        ? `${rem.length} item${rem.length === 1 ? " is" : "s are"} still unchecked. Review exactly what is going to the editor and what is still owed before you submit.`
        : "Review what is going to the editor. A checked box reports an upload; only a fresh Dropbox read confirms files.",
      yes: rem.length ? "Submit with these items still owed" : "Confirm handoff to editor",
      action: { kind: "submit", force: false, scope, reviewFingerprint },
      review: true,
    });
  }

  /** What the page showed as submitted when it loaded — what a conflict is described against. */
  const loadedFields: SubmittedFields = {
    editorBrief: project.editorBrief, videoInstructions: project.videoInstructions, removalNotes: project.removalNotes,
    shotOrderNotes: project.shotOrderNotes, reelScript: script?.body ?? null, scriptConfirmNote: project.scriptConfirmNote,
    videosFilmed: project.videosFilmed,
  };

  function keepAttempt(attempt: UploadAttempt | null) {
    attemptRef.current = attempt; setPendingAttempt(attempt);
    try {
      if (attempt) localStorage.setItem(ATTEMPT_MIRROR_KEY(project.id), JSON.stringify(attempt));
      else localStorage.removeItem(ATTEMPT_MIRROR_KEY(project.id));
    } catch { /* same-page receipt and draft stay intact without device storage */ }
  }
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (!mounted) return;
      try {
        const priorAttempt = parseUploadAttempt(localStorage.getItem(ATTEMPT_MIRROR_KEY(project.id)));
        if (priorAttempt) { attemptRef.current = priorAttempt; saverRef.current?.stop(); setPendingAttempt(priorAttempt); setErr("An earlier upload response is unconfirmed. Your answers are kept. Check that attempt before submitting again; editor notification is not confirmed here."); }
        const priorSize = parseUploadAttempt(localStorage.getItem(SIZE_ATTEMPT_MIRROR_KEY(project.id)));
        if (priorSize) { sqftAttemptRef.current = priorSize; sqftNeedsCheckRef.current = true; setSqftNeedsCheck(true); setSqftErr("An earlier size response is unconfirmed. Check that attempt before another save."); }
      } catch { /* storage may be unavailable */ }
    });
    return () => { mounted = false; };
  }, [project.id]);

  async function checkAttempt() {
    const attempt = attemptRef.current;
    if (!attempt || submitBusyRef.current || checkingAttemptRef.current) return;
    checkingAttemptRef.current = true; setCheckingAttempt(true);
    try {
      const receipt = await readUploadAttempt(project.id, attempt.attemptId, attempt.payloadFingerprint);
      if (receipt.state === "unknown") { setErr("This exact upload attempt is not confirmed. It may still be processing. Your answers are kept; check again before submitting, or ask the office to check the handoff."); return; }
      setHalfAt({ photos: receipt.handoff.photosAtISO, video: receipt.handoff.videoAtISO });
      if (!receipt.terminal) { setErr("Your answers were saved, but the earlier upload request has not confirmed it finished. Editor notification is unconfirmed. Your current answers are kept; check again before another submit."); return; }
      // Rebase on what this attempt wrote, never on somebody else's later
      // edit. A next submit still reaches the existing forced-conflict choice.
      setSubmitHash(receipt.baseHash); baseHashRef.current = receipt.baseHash; baseAtRef.current = receipt.atISO; setMovedSinceDraft(receipt.currentChanged);
      if (receipt.handoff.wholeDone) { setDone(true); setReopened(true); revRef.current = null; }
      keepAttempt(null);
      setErr(`Your submitted answers are confirmed saved. ${receipt.phase === "complete" ? "The request finished; this check does not confirm editor notification or file readiness." : "The request ended before its finishing handoff was confirmed; ask the office to check it."} Your current draft stays on this page${receipt.currentChanged ? "; the submitted answers have changed since this attempt" : ""}.`);
      if (!draftConflictRef.current) {
        saverRef.current?.resume();
        if (JSON.stringify(payloadRef.current) !== lastSavedJson.current) saverRef.current?.change();
      } else writeMirror(JSON.stringify(payloadRef.current));
    } catch { setErr("The upload receipt could not be checked. Your answers are kept; retry this check before another submit."); }
    finally { checkingAttemptRef.current = false; setCheckingAttempt(false); }
  }

  function runSubmit(force: boolean, scope?: HandoffCategory, baseHashOverride?: string) {
    if (submitBusyRef.current || attemptRef.current) return;
    submitBusyRef.current = true;
    setErr(null);
    const payload = {
      editorBrief,
      cullingConfirmed: cullOk,
      shotOrder: orderChoice ? { mode: orderChoice, notes: orderNotes } : null,
      removalNotes: removal,
      nothingToRemove,
      videoInstructions: vidInstructions,
      scriptConfirm: scriptChoice
        ? { state: scriptChoice, ...(scriptChoice === "edited" ? { script: scriptText, note: scriptNote } : {}) }
        : null,
      sawScript: !!script,
      // Package-scoped requirements (keys ABSENT on pre-update pages — the
      // server treats absence as "old tab, ask for a refresh", null as
      // "unanswered, block with the real message").
      videosFilmed: spec.requireVideoCount ? videosFilmedNum : undefined,
      filmedTopicIds: answersByTopic ? filmedTopicIds : undefined,
      // CP-09: a note only for a topic that is ticked (the server drops the
      // rest too), and the on-site extras by title — their key is only this
      // page's handle for them.
      ...(answersByTopic
        ? {
            topicNotes: Object.fromEntries(
              filmedTopicIds.map((id) => [id, (topicNotes[id] ?? "").trim().slice(0, 1000)] as const).filter(([, n]) => !!n),
            ),
            extraTopics: liveExtras.map((x) => ({ key: x.key, title: x.title.slice(0, 200), ...(x.note.trim() ? { note: x.note.trim().slice(0, 1000) } : {}) })),
          }
        : {}),
      introScript: spec.requireIntro ? vidSections.intro.trim() || null : undefined,
      providedScript: spec.requireScript && !script ? scriptText.trim() || null : undefined,
      ...(force ? { force: true } : {}),
      ...(scope ? { scope } : {}),
      baseHash: baseHashOverride ?? submitHash,
      baseAtISO: baseAtRef.current,
    };
    // A submit is not a draft save: hold the autosave while it runs, so the
    // answers being submitted are not written back as an unsent draft.
    saverRef.current?.stop();
    const submittedJson = payloadJson;
    const resumeAutosave = () => {
      if (attemptRef.current || draftConflictRef.current) { writeMirror(JSON.stringify(payloadRef.current)); return; }
      saverRef.current?.resume();
      if (payloadRef.current && JSON.stringify(payloadRef.current) !== lastSavedJson.current) saverRef.current?.change();
    };
    startTransition(async () => {
      let attempted = false;
      try {
        const attempt = { attemptId: crypto.randomUUID(), payloadFingerprint: await uploadAttemptFingerprint(payload) };
        keepAttempt(attempt); attempted = true;
        const res = await finalizeUpload(project.id, { ...payload, ...attempt });
        if (res.blocked || res.needsConfirm || res.conflict || res.attemptTerminal) {
          if (!res.attemptPending) keepAttempt(null);
        }
        if (res.blocked) { resumeAutosave(); setErr(res.blocked); window.scrollTo({ top: 0, behavior: "smooth" }); return; }
        if (res.needsConfirm) {
          resumeAutosave();
          // Ask IN PAGE and re-submit with force on "yes" — never a native
          // dialog here: this point is past an await, where mobile browsers
          // silently swallow confirm() (Harrison's stuck "hold on").
          setAsk({
            body: res.warning ?? "Some ordered items look missing. Submit anyway?",
            yes: "Submit anyway",
            action: { kind: "submit", force: true, scope },
          });
          return;
        }
        if (res.conflict) {
          resumeAutosave();
          // O04: somebody changed the submitted answers since this page loaded.
          const changed = changedSubmittedFields(loadedFields, res.conflict.current);
          const who = res.conflict.by ?? "someone";
          const when = res.conflict.atISO ? ` (${etDateTime(res.conflict.atISO)})` : "";
          setAsk({
            body: `Since this page opened, ${who} changed ${changed.length ? changed.join(", ") : "the submitted notes"}${when}. Submitting now replaces their version with what is on this page.`,
            yes: "Submit mine anyway",
            action: { kind: "submit", force, scope, baseHash: res.conflict.currentHash },
          });
          return;
        }
        if (res.pdfPath) setPdfPath(res.pdfPath);
        if (res.baseHash) { setSubmitHash(res.baseHash); baseHashRef.current = res.baseHash; baseAtRef.current = new Date().toISOString(); setMovedSinceDraft(false); }
        setTopicsPending(res.topicsPending?.message ?? null);
        setForcedSubmit(force);
        const whole = res.handoff ? res.handoff.wholeDone : true;
        if (res.handoff) setHalfAt({ photos: res.handoff.photosAtISO, video: res.handoff.videoAtISO });
        if (whole) {
          // The draft is spent: the server consumed it with this submit.
          revRef.current = null;
          lastSavedJson.current = submittedJson;
          const newerDraft = JSON.stringify(payloadRef.current) !== submittedJson;
          if (!newerDraft) clearMirror();
          setRestored(null);
          if (done) setLastEdited({ by: "you", atISO: new Date().toISOString() });
          setDone(true);
          setReopened(newerDraft); // keep later native input visible and recoverable
          // The read-back card uses the server's submitted values and time.
          // Without a refresh it could say "never submitted" beside the new
          // success banner until the photographer manually reloaded the page.
          if (!newerDraft && res.attemptTerminal) router.refresh();
        }
        if (!res.attemptTerminal) setErr("Your answers were saved, but the request's finished status could not be recorded. Editor notification is unconfirmed. Check this attempt before another submit, or ask the office to inspect the handoff.");
        resumeAutosave();
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch {
        resumeAutosave();
        setErr(attempted ? "The upload response was lost. Your answers are kept; they may already be saved and editor notification is unconfirmed. Check this exact attempt before submitting again." : "The upload request could not be prepared. Your answers are kept; please try again.");
      } finally { submitBusyRef.current = false; }
    });
  }

  // The tier the page preaches follows the size on file RIGHT NOW, so typing a
  // square footage re-tiers the target immediately. An office override still
  // wins, and a legacy shoot keeps its briefed ceiling.
  const liveRange = policy.rangeMode === "sop" ? photoRangeFor(sqftSaved) : policy.range;
  const collapsed = done && !reopened;
  // §7.3: say only what is true about the files. A tick is the photographer's
  // word; Dropbox showing the files is evidence; an unreadable folder is
  // neither, and "Submit anyway" past an empty-folder warning is not proof.
  const checkedCounts = rawCheck ? [rawCheck.photos?.count, rawCheck.video?.count].filter((x) => x !== undefined) : [];
  const filesSentence = rawCheck
    ? forcedSubmit || checkedCounts.some((n) => n === 0)
      ? "Dropbox did not confirm every file at the final handoff, so the office will check the folder before editing."
      : checkedCounts.length > 0 && checkedCounts.every((n) => typeof n === "number" && n > 0)
        ? "Dropbox showed files at the handoff check."
        : "Dropbox could not confirm every file at the handoff check, so the office will check."
    : receiptSentence(evidence, forcedSubmit);
  const handoffReceipt = (scope?: HandoffCategory) => {
    const photosIn = photosLive && scope !== "video";
    const videoIn = videoLive && scope !== "photos";
    const chosen = filmedTopicIds.map((id) => sessionTopics?.topics.find((t) => t.topicId === id)?.title ?? id);
    const unfilmed = (sessionTopics?.topics ?? [])
      .filter((t) => !confirmedElsewhere(t) && !filmedTopicIds.includes(t.topicId))
      .map((t) => t.title);
    const owed = remaining.filter((d) => !scope || handoffCategoryOf(d.type) === scope);
    const exceptions = deliverables.filter((d) => !uploaded[d.id] && notDone[d.id] && (!scope || handoffCategoryOf(d.type) === scope));
    const fileRows = evidence.filter((e) => (e.category === "photos" ? photosIn : videoIn));
    const notes = videoIn ? VID_SECTIONS.filter((s) => vidSections[s.key]?.trim()).map((s) => `${s.title}: ${vidSections[s.key].trim()}`) : [];
    return (
      <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border bg-surface p-3 text-xs leading-relaxed text-foreground/85" aria-label="Handoff details">
        <p><strong>Handing over:</strong> {photosIn && videoIn ? "Photos and video" : photosIn ? "Photos" : "Video"}</p>
        {videoIn && <p><strong>Filmed topics ({topicCount || videosFilmedNum || 0}):</strong> {answersByTopic
          ? [...chosen, ...liveExtras.map((x) => `${x.title} (off script: ${x.note.trim()})`)].join(" · ") || "none reported"
          : `${videosFilmedNum ?? "unknown"} videos reported; no topic list was available`}</p>}
        {videoIn && unfilmed.length > 0 && <p><strong>Not filmed at this session:</strong> {unfilmed.join(" · ")}. These are separate from missing file uploads; the office will plan any carryover.</p>}
        <div>
          <strong>File locations:</strong>
          {handoffFolders.filter((f) => (f.key === "rawPhotos" && photosIn) || (f.key === "rawVideo" && videoIn)).length ? (
            <ul className="ml-4 list-disc">
              {handoffFolders.filter((f) => (f.key === "rawPhotos" && photosIn) || (f.key === "rawVideo" && videoIn)).map((f) => (
                <li key={f.key}><a href={f.url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">{f.label} in Dropbox</a></li>
              ))}
            </ul>
          ) : <span> Dropbox folder link unavailable.</span>}
          {rawCheck && <p className="text-muted"><strong>Fresh Dropbox check:</strong> {etDateTime(rawCheck.checkedAtISO)}. {rawCheck.connected ? "Read from this job’s current Dropbox location." : "Dropbox connection unavailable; file counts are unknown."}</p>}
          {rawCheck?.photos && photosIn && <p className="text-muted">Photos: {rawCheck.photos.count === null ? "could not confirm files" : `Dropbox showed ${rawCheck.photos.count} file${rawCheck.photos.count === 1 ? "" : "s"} in RAW-Photos`}. A checked box is a report, not file verification.</p>}
          {rawCheck?.video && videoIn && <p className="text-muted">Video: {rawCheck.video.count === null ? "could not confirm files" : `Dropbox showed ${rawCheck.video.count} video file${rawCheck.video.count === 1 ? "" : "s"} under this job${rawCheck.video.where.length ? ` (${rawCheck.video.where.join(", ")})` : ""}`}. A checked box is a report, not file verification.</p>}
          {!rawCheck && checkingRaw && <p className="text-muted">Checking Dropbox now… File counts are not confirmed yet.</p>}
          {!rawCheck && !checkingRaw && ask?.review && <p className="text-muted">Fresh Dropbox check unavailable; file counts are not confirmed.</p>}
          {!rawCheck && fileRows.map((e) => <p key={e.category} className="text-muted">{e.category === "photos" ? "Photos" : "Video"}: {e.stale || e.filesDetected === "unknown"
            ? "Dropbox read unavailable or stale — files not confirmed"
            : e.filesDetected === "yes"
              ? `The last recorded Dropbox check showed ${e.fileCount ?? "some"} file${e.fileCount === 1 ? "" : "s"}`
              : "The last recorded Dropbox check showed no files"}. A checked upload box is a report, not file verification.</p>)}
          {!rawCheck && fileRows.length === 0 && <p className="text-muted">Dropbox file evidence was unavailable when this page loaded; files are not confirmed.</p>}
        </div>
        {(notes.length > 0 || editorBrief.trim() || (videoIn && scriptChoice)) && <div>
          <strong>Editing instructions:</strong>
          {notes.map((n) => <p key={n} className="whitespace-pre-wrap">{n}</p>)}
          {editorBrief.trim() && <p className="whitespace-pre-wrap">For the editor: {editorBrief.trim()}</p>}
          {videoIn && scriptChoice && <p className="whitespace-pre-wrap">Script {scriptChoice === "edited" ? "edited on site" : "delivered as written"}: {scriptChoice === "edited" ? scriptText.trim() : script?.body?.trim() || "the confirmed on-site text"}</p>}
        </div>}
        {exceptions.length > 0 && <p><strong>Could not complete:</strong> {exceptions.map((d) => `${DELIVERABLE_META[d.type].label} — ${notDone[d.id]}`).join(" · ")}</p>}
        {flags.length > 0 && <p><strong>Field flags:</strong> {flags.join(" · ")}</p>}
        <p><strong>Still owed:</strong> {owed.length ? owed.map((d) => DELIVERABLE_META[d.type].label).join(" · ") : "No unchecked deliverables in this handoff"}{scope && (scope === "photos" ? videoLive && !halfAt.video : photosLive && !halfAt.photos) ? `; the ${scope === "photos" ? "video" : "photos"} half is still owed` : ""}.</p>
      </div>
    );
  };
  // Where the size came from, said plainly: the ordered band is a range the
  // client picked, not a measurement, so the page never prints it as one.
  const sizeNote = bandText
    ? ` (${bandText.replace(/\s*\(.*\)$/, "")} on the order)`
    : sqftSaved
      ? ` (${sqftSaved.toLocaleString("en-US")} sq ft)`
      : "";

  async function saveSqft(raw: string) {
    const trimmed = raw.replace(/[^0-9]/g, "");
    const value = trimmed ? Number(trimmed) : null;
    if (sqftNeedsCheckRef.current) return;
    if (sqftBusyRef.current) { sqftQueuedRef.current = value; return; }
    if (value === sqftSavedRef.current) return;
    sqftBusyRef.current = true; setSqftBusy(true); setSqftErr(null);
    let next: number | null | undefined = value;
    try {
      while (next !== undefined) {
        const submitted: number | null = next; sqftQueuedRef.current = undefined;
        const attempt = { attemptId: crypto.randomUUID(), payloadFingerprint: await uploadAttemptFingerprint({ squareFeet: submitted }) };
        sqftAttemptRef.current = attempt;
        try { localStorage.setItem(SIZE_ATTEMPT_MIRROR_KEY(project.id), JSON.stringify(attempt)); } catch { /* retained in this page */ }
        const res = await setProjectSquareFeet(project.id, submitted, attempt);
        if (res.terminal || (!res.ok && !res.pending)) {
          sqftAttemptRef.current = null;
          try { localStorage.removeItem(SIZE_ATTEMPT_MIRROR_KEY(project.id)); } catch { /* best effort */ }
        }
        if (!res.ok) {
          sqftQueuedRef.current = undefined;
          if (res.pending) { sqftNeedsCheckRef.current = true; setSqftNeedsCheck(true); }
          setSqftErr(res.message ?? "Couldn't save that. Your current size is kept."); return;
        }
        sqftSavedRef.current = submitted; setSqftSaved(submitted); setBandText(null);
        if (!res.terminal) {
          sqftQueuedRef.current = undefined; sqftNeedsCheckRef.current = true; setSqftNeedsCheck(true);
          setSqftErr("The size is saved, but its finished status is unconfirmed. Check this attempt before another save."); return;
        }
        next = sqftQueuedRef.current;
        if (next === submitted) next = undefined;
      }
    } catch {
      // A queued later blur is not permission to replay an uncertain write.
      sqftQueuedRef.current = undefined;
      if (sqftAttemptRef.current) {
        sqftNeedsCheckRef.current = true; setSqftNeedsCheck(true);
        setSqftErr("The size save response was lost. Your typed figure is kept. Check the current size before saving again.");
      } else setSqftErr("The size request could not be prepared. Your typed figure is kept; choose Save current size to try again.");
    } finally { sqftBusyRef.current = false; setSqftBusy(false); }
  }
  async function checkSqft() {
    if (sqftBusyRef.current || !sqftNeedsCheckRef.current || !sqftAttemptRef.current) return;
    sqftBusyRef.current = true; setSqftBusy(true);
    try {
      const attempt = sqftAttemptRef.current;
      const current = await readUploadSquareFeet(project.id, attempt.attemptId, attempt.payloadFingerprint);
      if (current.state === "unknown" || !current.terminal) { setSqftErr("The earlier size request has not confirmed it finished. Your typed figure is kept; check again or ask the office to inspect it before saving."); return; }
      sqftSavedRef.current = current.squareFeet; setSqftSaved(current.squareFeet); if (current.squareFeet !== null) setBandText(null);
      sqftNeedsCheckRef.current = false; setSqftNeedsCheck(false);
      sqftAttemptRef.current = null;
      try { localStorage.removeItem(SIZE_ATTEMPT_MIRROR_KEY(project.id)); } catch { /* best effort */ }
      setSqftErr(`Current saved size: ${current.squareFeet === null ? "none" : `${current.squareFeet.toLocaleString("en-US")} sq ft`}. Your typed figure is kept. Choose Save current size if you want to apply it.`);
    } catch { setSqftErr("The current size could not be checked. Your typed figure is kept; retry this check before saving."); }
    finally { sqftBusyRef.current = false; setSqftBusy(false); }
  }

  const checkbox = "size-4 shrink-0 accent-[var(--brand)]";
  const choiceBtn = (active: boolean, tone: "ok" | "warn" = "ok") =>
    cn(
      "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium",
      active
        ? tone === "ok" ? "border-success bg-success/10 text-success" : "border-warning bg-warning/10 text-warning"
        : "border-border hover:bg-surface-2",
    );

  // Step numbering adapts — photo-only jobs never see the video step, video-
  // only jobs never see the photo steps (Jordan, Sep 1).
  let stepNo = 1;
  const removalAnswered = !!removal.trim() || nothingToRemove;
  const orderAnswered =
    orderChoice === "front-to-back" || orderChoice === "interior-exterior" ||
    (orderChoice === "out-of-order" && !!orderNotes.trim());
  const videoDone =
    vidAnswered &&
    (!script || hadPriorBrief || (scriptChoice !== null && (scriptChoice !== "edited" || !!scriptText.trim()))) &&
    // Premium: no Studio script → the typed script is part of "done".
    (!spec.requireScript || !!script || hadPriorBrief || !!scriptText.trim());

  return (
    <div className="space-y-4">
      {/* ---- The job, big and first. ---- */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{project.title.split(",")[0]}</h1>
        <p className="mt-1 text-sm text-muted">
          {addr && <span>{addr} · </span>}
          {/* Headshot beside the agent's name (Jordan, Sep 2: show the Aryeo
              profile photo wherever the client is mentioned). Inline-flex so
              the "address · name · date" line still wraps as one sentence. */}
          <span className="inline-flex items-center gap-1.5 align-middle">
            <Avatar name={project.clientName} src={project.clientAvatarUrl} size={18} />
            {project.clientName}
          </span>
          {project.shootDate && <span> · {etDateTime(project.shootDate)}</span>}
        </p>
        {project.packageName && <p className="mt-0.5 text-[13px] text-muted-2">{project.packageName}</p>}
      </div>

      {/* O04: where the unsent answers stand. A restored draft says so and
          can be thrown away; a copy saved elsewhere is a question, never a
          silent overwrite. */}
      {restored && !draftConflict && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-brand/30 bg-brand-soft/40 px-3.5 py-2.5 text-sm">
          <NotebookPen className="size-4 shrink-0 text-brand" />
          <span className="flex-1">
            {restored.from === "device"
              ? `Restored answers kept on this device (${etDateTime(restored.atISO)}) — they weren't submitted yet.`
              : `Restored answers you hadn't submitted (saved ${etDateTime(restored.atISO)}).`}
            {movedSinceDraft && " The submitted answers changed after these were saved, so submitting will show you what changed before it replaces anything."}
          </span>
          <button onClick={discardDraft} disabled={isPending || !!pendingAttempt} className="text-xs font-medium text-muted underline hover:text-foreground disabled:opacity-50">
            Discard
          </button>
        </div>
      )}
      {draftConflict && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          <p className="flex items-start gap-2 text-foreground/90">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>
              {draftConflict.submitted
                ? `These answers were submitted from another tab or device (${etDateTime(draftConflict.savedAtISO)}). What you typed here is still on this page.`
                : draftConflict.device
                  ? `This page shows answers kept on this device (typed ${etDateTime(draftConflict.device.typedAtISO)}). A different copy of your unsent answers was saved ${etDateTime(draftConflict.savedAtISO)}, probably on another device. Which one should be kept?`
                  : `Another copy of your unsent answers was saved ${etDateTime(draftConflict.savedAtISO)}${draftConflict.by ? ` by ${draftConflict.by}` : ""}, probably in another tab or on another device. Which one should be kept?`}
            </span>
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            {draftConflict.submitted ? (
              <>
                <button onClick={() => window.location.reload()} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg hover:opacity-90">
                  Reload to see what went in
                </button>
                <button onClick={keepMineAfterConflict} disabled={isPending || !!pendingAttempt} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
                  Keep editing here
                </button>
              </>
            ) : (
              <>
                <button onClick={keepMineAfterConflict} disabled={isPending || !!pendingAttempt} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50">
                  Keep this page&rsquo;s answers
                </button>
                <button onClick={takeTheirsAfterConflict} disabled={isPending || !!pendingAttempt} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
                  Load the other copy
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* O05: one half is in and the other is still owed. The video half has
          its own deadline (Jordan, Sep 25): 8:00 AM ET the next day. */}
      {!done && halfAt.photos && !halfAt.video && videoLive && (() => {
        const due = videoHalfDueAt(new Date(halfAt.photos));
        const past = due.getTime() < nowMs;
        return (
          <div className={cn("rounded-2xl border p-4", past ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10")}>
            <div className="flex items-center gap-2 font-semibold">
              <CheckCircle2 className="size-5 text-success" /> Photos submitted {etDateTime(halfAt.photos)}. The video is still owed.
            </div>
            <p className="mt-1 text-sm text-foreground/85">
              {past
                ? `It was due by 8:00 AM ${etDate(due)}. Upload the video and submit the video half now. A late video counts as a late upload on your score.`
                : `Upload the video to Dropbox and submit the video half before 8:00 AM ${etDate(due)}. A video that comes in after that counts as a late upload on your score.`}
            </p>
          </div>
        );
      })()}
      {!done && halfAt.video && !halfAt.photos && photosLive && (
        <div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="size-5 text-success" /> Video submitted {etDateTime(halfAt.video)}. The photos are still owed.
          </div>
          <p className="mt-1 text-sm text-foreground/85">Upload the photos and submit the photo half to finish this shoot.</p>
        </div>
      )}

      {/* Success banner + process feedback */}
      {done && (
        <div className="rounded-2xl border border-success/30 bg-success-soft/50 p-4">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-5" />
            <span className="font-semibold">Submitted — you&rsquo;re good to go</span>
          </div>
          {viewerIsOffice ? (
            <p className="mt-1 text-sm text-foreground/80">
              The notes are on the editor brief. {filesSentence} Everything submitted reads back below; reopen
              it to make a correction.
            </p>
          ) : (
            <p className="mt-1 text-sm text-foreground/80">
              Nothing else is needed from you on this shoot. Your notes are on the editor brief.{" "}
              {filesSentence} <strong>This shoot is on your payroll</strong> — you&rsquo;ll see it in My Pay.
            </p>
          )}
          {handoffReceipt()}
          <div className="mt-3 flex flex-wrap gap-2">
            {pdfPath && (
              <a href={pdfPath} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2">
                <FileText className="size-4" /> View editor brief
              </a>
            )}
            <Link href={`/projects/${project.id}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg hover:opacity-90">
              View project
            </Link>
          </div>
          {/* Post-job feedback on the PROCESS — Jordan reads every one. */}
          <div className="mt-3 border-t border-success/20 pt-3">
            {processNoteSent ? (
              <p className="text-[13px] text-success"><Check className="mr-1 inline size-3.5" />Feedback sent — thank you.</p>
            ) : (
              <>
                <p className="text-[13px] text-foreground/75">How was this upload process? Anything we should change?</p>
                <div className="mt-1.5 flex gap-2">
                  <input
                    value={processNote}
                    onChange={(e) => setProcessNote(e.target.value)}
                    placeholder="Optional — goes straight to Jordan."
                    className="flex-1 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm outline-none focus:border-brand"
                  />
                  <button
                    disabled={!processNote.trim() || isPending}
                    onClick={() => {
                      const note = processNote.trim();
                      // Confirm only AFTER the write lands — a dead cell
                      // connection must not eat feedback behind a thank-you.
                      startTransition(async () => {
                        const r = await submitUploadFeedback(project.id, note).catch(() => ({ ok: false }));
                        if (r.ok) setProcessNoteSent(true);
                        else setErr("Couldn't send the feedback — check your connection and try again.");
                      });
                    }}
                    className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Special requests reminder */}
      {specialRequests.length > 0 && (
        <div className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-warning">
            <Star className="size-4" /> Special requests for this shoot
          </div>
          <ul className="ml-6 list-disc space-y-0.5 text-sm text-foreground/85">
            {specialRequests.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {/* Standing customer notes — its OWN card. It used to render inside the
          special-requests box, so a client note only showed on the rare job
          that also had a special request; on every other shoot the note the
          office wrote reached nobody here. */}
      {project.customerNote && (
        <div className="rounded-2xl border border-border bg-surface p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <NotebookPen className="size-4 text-brand" /> Customer notes ·
            <Avatar name={project.clientName} src={project.clientAvatarUrl} size={16} />
            {project.clientName}
          </div>
          <p className="whitespace-pre-line text-sm text-foreground/85">{project.customerNote}</p>
        </div>
      )}

      {/* Error */}
      {err && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm text-danger">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div className="font-medium">{err}</div>
        </div>
      )}
      {pendingAttempt && <button type="button" disabled={isPending || checkingAttempt} onClick={() => { void checkAttempt(); }} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm font-medium disabled:opacity-50">{checkingAttempt ? "Checking upload status…" : "Check upload status"}</button>}

      {/* Everything below is the checklist itself — hidden once submitted,
          so the confirmation IS the page rather than a banner above a wall of
          answered steps. `collapsed` never hides the submit bar: a re-submit
          has to stay reachable. */}
      {collapsed ? (
        <>
          {/* CP-09: the submit landed, the topic record did not (yet). Not an
              error — nothing for the photographer to redo — so it reads as a
              note, and the hub's hourly retry finishes the job. */}
          {topicsPending && (
            <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="font-medium">{topicsPending}</div>
            </div>
          )}
          {/* The read-back (Jordan, Sep 15: "see ... what was uploaded and
              the notes for them"): every answer verbatim, above the reopen
              button, so nobody reopens a 1,300px form just to read it. Item
              states come from THIS page's state so a re-submit's changes
              show without a reload. */}
          <WhatYouSubmitted
            submittedAtISO={project.debriefSubmittedAt}
            uploadedAtISO={project.uploadedAt}
            submittedBy={submission.submittedBy ?? project.photographerName}
            lastEdited={lastEdited}
            items={deliverables.map((d): SubmittedItem => ({
              label: DELIVERABLE_META[d.type].label,
              quantity: d.quantity,
              state: uploaded[d.id] ? "uploaded" : notDone[d.id] ? "not_completed" : "pending",
              reason: uploaded[d.id] ? null : notDone[d.id] ?? null,
            }))}
            cullingConfirmedAtISO={project.cullingConfirmedAt}
            squareFeet={sqftSaved}
            squareFeetBand={bandText}
            shotOrderNotes={project.shotOrderNotes}
            removalNotes={project.removalNotes}
            videoInstructions={project.videoInstructions}
            videosFilmed={project.videosFilmed}
            scriptConfirmedAtISO={project.scriptConfirmedAt}
            scriptConfirmNote={project.scriptConfirmNote}
            scriptBody={script?.body ?? null}
            editorBrief={project.editorBrief}
            addOns={submission.addOns}
            files={submission.files}
            flags={flags}
            halves={[
              ...(halfAt.photos ? [{ label: "Photos", atISO: halfAt.photos, by: project.photosHandoffBy }] : []),
              ...(halfAt.video
                ? [{
                    label: "Video",
                    atISO: halfAt.video,
                    by: project.videoHandoffBy,
                    late: !!halfAt.photos && Date.parse(halfAt.video) > Date.parse(halfAt.photos) &&
                      Date.parse(halfAt.video) > videoHalfDueAt(new Date(halfAt.photos)).getTime(),
                  }]
                : []),
            ]}
          />
          <button
            onClick={() => { setReopened(true); }}
            className="w-full rounded-2xl border border-dashed border-border bg-surface-2/40 px-4 py-3 text-left text-sm text-muted hover:border-brand hover:text-foreground"
          >
            {viewerIsOffice ? (
              // The office's wording (Sep 15): they are correcting a record,
              // not finishing their own job. Reopening prefills exactly as it
              // does for the photographer; a re-submit here only rewrites the
              // notes (finalizeUpload leaves the hold, the status and the
              // payroll stamp alone for anyone but the shoot's photographer).
              <>
                <span className="font-medium text-foreground">Edit this upload</span>{" "}
                Reopen the checklist to change the notes or the checked-off items — every answer is prefilled.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">Need to change something?</span>{" "}
                Reopen the checklist — your answers are all still here.
              </>
            )}
          </button>
          {/* §7.5: each video's brief stays readable, and open to an on-site
              note, after the submit. Something the agent said often comes
              back to the photographer once the page is done. */}
          {policy.videoOrdered && briefs.length > 0 && (
            <section className="rounded-2xl border bg-surface p-4 sm:p-5">{briefCard}</section>
          )}
          {/* §7.6 / §7.8 stay reachable after the submit: a missed shot or a
              client request often comes up once the page is done, and the
              office plans recoveries from here. */}
          <section className="rounded-2xl border bg-surface p-4 sm:p-5">
            <MissingWork projectId={project.id} gaps={gaps} office={viewerIsOffice} />
            <FieldFeedback projectId={project.id} clientName={project.clientName} reports={fieldReports} office={viewerIsOffice} />
          </section>
        </>
      ) : (
      <>
      {/* ---- STEP: Upload to Dropbox ---- */}
      <StepCard
        n={stepNo++}
        title="Upload everything to Dropbox"
        done={doneCount >= total && total > 0}
        subtitle="Raw files in the Raw folders · culled extras in Backup Photos."
      >
        {foldersSlot}
        <PortalEvidence evidence={evidence} halfAt={halfAt} />
      </StepCard>

      {/* ---- STEP: The photo standard (the SOP, enforced) ---- */}
      {policy.photosOrdered && (
        <StepCard n={stepNo++} title="The photo standard — run your cull" done={cullOk}>
          <div className="rounded-xl bg-brand-soft/50 px-3.5 py-2.5 text-sm">
            {policy.rangeMode === "override" ? (
              <>
                <span className="font-semibold">This home&rsquo;s target: {policy.photoTarget} photos.</span>{" "}
                <span className="text-foreground/80">Set by the office for this property — it beats the size tier.</span>
              </>
            ) : policy.rangeMode === "legacy" ? (
              <>
                {/* A pre-SOP job keeps its more lenient briefed ceiling so a tier
                    change can't retro-fire cull tasks — but when the size IS
                    known, lead with the range the SOP would ask for. The ceiling
                    without the range reads as "shoot 80", which is the opposite
                    of the point. */}
                {sqftSaved ? (
                  <>
                    <span className="font-semibold">This home: aim for {photoRangeFor(sqftSaved).low}&ndash;{photoRangeFor(sqftSaved).high} finals.</span>{" "}
                    <span className="text-foreground/80">
                      Booked before the new standard, so nothing is enforced past ~{policy.photoTarget} —
                      but the range is the goal.{sizeNote}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-semibold">This shoot predates the new standard — ceiling ~{policy.photoTarget} finals.</span>{" "}
                    <span className="text-foreground/80">Cull to the SOP anyway: hero shots, one composition once.</span>
                  </>
                )}
              </>
            ) : liveRange.upper ? (
              <>
                <span className="font-semibold">This home: aim for {liveRange.low}&ndash;{liveRange.high} finals.</span>{" "}
                <span className="text-foreground/80">
                  {liveRange.upper} is the normal ceiling — and the ceiling is not a goal.
                  {sizeNote}
                </span>
              </>
            ) : (
              <>
                <span className="font-semibold">7,000+ sq ft — property dependent.</span>{" "}
                <span className="text-foreground/80">
                  Professional judgment: complete coverage without unnecessary repetition. The sweep checks in
                  around ~{policy.photoTarget} finals unless the office sets a target.
                </span>
              </>
            )}
          </div>

          {/* THE SIZE THIS TIER IS BUILT ON. Aryeo carries a square footage on
              7 of 1,701 listings, so without this every home shows the smallest
              range. The person standing in the house is the one who knows. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface-2/40 px-3.5 py-2.5">
            <label htmlFor="sqft" className="text-sm font-medium">
              Square footage
              {policy.rangeMode === "sop" && <span className="ml-1 font-normal text-muted">— sets the target above</span>}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="sqft"
                inputMode="numeric"
                value={sqft}
                onChange={(e) => setSqft(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={(e) => void saveSqft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
                placeholder="e.g. 2400"
                className="w-28 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand"
              />
              {sqftBusy
                ? <span className="text-xs text-muted">saving…</span>
                : sqftSaved != null && String(sqftSaved) === sqft
                  ? <span className="inline-flex items-center gap-1 text-xs text-success"><Check className="size-3.5" />saved</span>
                  : null}
              {sqftNeedsCheck ? <button type="button" disabled={sqftBusy} onClick={() => { void checkSqft(); }} className="min-h-11 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50">Check current size</button>
                : sqftErr && <button type="button" disabled={sqftBusy} onClick={() => { void saveSqft(sqft); }} className="min-h-11 rounded-lg border border-border px-3 py-2 text-xs disabled:opacity-50">Save current size</button>}
            </div>
            {sqftErr
              ? <span className="w-full text-xs text-danger">{sqftErr}</span>
              : policy.rangeMode === "override"
                ? <span className="w-full text-xs text-muted">The office set a target for this home, so the size tier doesn&rsquo;t apply — but it&rsquo;s still worth recording.</span>
                : bandText
                  ? <span className="w-full text-xs text-muted">The order says <strong>{bandText}</strong> — a range the client picked. Type the real figure if you know it and the target sharpens.</span>
                  : sqftSaved == null
                    ? <span className="w-full text-xs text-muted">Not on the order. Add it and the range above matches the house.</span>
                    : null}
          </div>

          <MiniHeading>The standard</MiniHeading>
          <ul className="space-y-1.5 text-sm leading-relaxed text-foreground/85">
            <li><strong>Every space gets one HERO SHOT</strong> — the photo you&rsquo;d pick if you could only show one. Supporting shots exist only to show what the hero can&rsquo;t.</li>
            <li><strong>One composition, once.</strong> No distance or zoom variations of the same angle.</li>
            <li><strong>Every photo must add new information.</strong> &ldquo;I like both&rdquo; is not a reason.</li>
            <li><strong>Open-concept areas are one space</strong> — not four rooms&rsquo; worth of angles.</li>
            <li><strong>5-bracket JPG.</strong> A bracket set counts as ONE composition. Not RAW, not 3-bracket.</li>
            <li><strong>Trash cans and pet items are a no-go.</strong> Fix it on site — don&rsquo;t lean on the editor.</li>
            <li><strong>Alternates go to Backup Photos</strong> — and cull that folder too.</li>
          </ul>

          <details className="mt-3 rounded-xl border border-border">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-muted hover:text-foreground">
              Room-by-room guide (guidelines, not quotas)
            </summary>
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full text-[13px]">
                <tbody className="divide-y divide-border/60">
                  {[
                    ["Front exterior", "2–4 · up to 5 with aerials"],
                    ["Rear exterior", "2–4 · up to 5 with aerials"],
                    ["Front door / entry", "1"],
                    ["Foyer / entrance", "1–2"],
                    ["Dining room", "1–2"],
                    ["Living / family room", "2–3"],
                    ["Kitchen", "3–5 · up to 6 when justified"],
                    ["Mudroom / laundry", "1–2"],
                    ["Powder room", "1"],
                    ["Full bathroom", "1 · 2 when necessary"],
                    ["Primary bathroom", "2–3"],
                    ["Primary bedroom", "2–3"],
                    ["Secondary bedroom", "1–2"],
                    ["Basement", "2–4 by layout"],
                    ["Office / bonus room", "1–2"],
                    ["Bar", "1–3"],
                    ["Deck / patio", "1–2"],
                    ["Pool", "2–3"],
                    ["Pool house / detached", "1–3 by importance"],
                    ["Other spaces", "1–2"],
                  ].map(([space, n]) => (
                    <tr key={space}>
                      <td className="px-3.5 py-1.5 text-foreground/85">{space}</td>
                      <td className="px-3.5 py-1.5 text-right text-muted tabular-nums">{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-border px-3.5 py-2 text-xs text-muted-2">
                Guidelines, not quotas — use professional judgment.{" "}
                <a href="/resources/photography-sop" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                  Full table in the SOP ↗
                </a>
              </p>
            </div>
          </details>

          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            Unnecessary photos cost real money — extra editing, plus an extra 1–2 hours per job of re-culling
            after the fact, which kills our turnaround time and pulls the admin and owner off other work. A{" "}
            <strong className="text-foreground/85">$1 production charge may be deducted per clearly unnecessary photo</strong>{" "}
            — duplicates, distance variations, backups uploaded as finals. You will never be charged for photos a
            property genuinely needed: this is not a photo-count penalty, and a property that truly needs more gets more.{" "}
            <a href="/resources/photography-sop" target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
              Read the full Photography SOP ↗
            </a>
          </p>

          <MiniHeading>Before you upload — confirm all four</MiniHeading>
          <div className="space-y-2">
            <CheckRow checked={checks.coverage} onChange={setCheck("coverage")} title="Coverage"
              text="Every important space is represented, each has its hero shot, exteriors and drone (if ordered) are complete." />
            <CheckRow checked={checks.culling} onChange={setCheck("culling")} title="Culling"
              text="Failures and test shots gone, duplicates and distance variations gone, every supporting photo adds something, backups separated." />
            <CheckRow checked={checks.quality} onChange={setCheck("quality")} title="Quality"
              text="Distractions were fixed on site — no avoidable trash cans, pets, or pet items in frame." />
            <CheckRow checked={checks.count} onChange={setCheck("count")} title="Count"
              text={policy.rangeMode !== "sop"
                ? `The gallery makes sense for this home (~${policy.photoTarget} target) — every photo has a reason to exist.`
                : policy.range.upper
                  ? `The gallery makes sense for this home (aim ${policy.range.low}–${policy.range.high}) — anything above has a reason to exist.`
                  : "The gallery size makes sense for this property — every photo has a reason to exist."} />
          </div>
        </StepCard>
      )}

      {/* ---- STEP: Shot order ---- */}
      {policy.photosOrdered && (
        <StepCard
          n={stepNo++}
          title="Shot order — front to back?"
          done={orderAnswered}
          subtitle="The gallery should walk the house the way a buyer would. Organizing photos of a house we've never been in burns serious office time — presentation is everything."
        >
          <div className="flex flex-wrap gap-2">
            <button onClick={() => { setOrderChoice("front-to-back"); setOrderNotes(""); }} className={choiceBtn(orderChoice === "front-to-back")}>
              <CheckCircle2 className="size-4" /> Front to back
            </button>
            <button onClick={() => { setOrderChoice("interior-exterior"); setOrderNotes(""); }} className={choiceBtn(orderChoice === "interior-exterior")}>
              <CheckCircle2 className="size-4" /> Interior front-to-back, then exterior
            </button>
            <button onClick={() => setOrderChoice("out-of-order")} className={choiceBtn(orderChoice === "out-of-order", "warn")}>
              Different order
            </button>
          </div>
          {orderChoice === "out-of-order" && (
            <div className="mt-2.5">
              <AutoTextarea
                value={orderNotes}
                onChange={(e) => setOrderNotes(e.target.value)}
                minRows={2}
                placeholder="Why, and the order you shot — e.g. contractor in the kitchen: started upstairs beds → baths → living/dining → kitchen last → exteriors."
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
              />
              <p className="mt-1 text-xs text-muted">
                Totally fine when the seller, a contractor, or the agent forces it — just tell us the order so nobody has to guess what&rsquo;s where.
              </p>
            </div>
          )}
        </StepCard>
      )}

      {/* ---- STEP: Removal notes ---- */}
      {policy.photosOrdered && (
        <StepCard
          n={stepNo++}
          title="Anything to remove in editing?"
          done={removalAnswered}
          subtitle="Pets, trash cans, vehicles, clutter that couldn’t be moved. Move what you can on site — we aren’t stagers, but we’re professionals with strong attention to detail."
        >
          <AutoTextarea
            value={removal}
            onChange={(e) => { setRemoval(e.target.value); if (e.target.value.trim()) setNothingToRemove(false); }}
            minRows={2}
            placeholder="e.g. Trash cans in exterior 3–4 · dog bed in the primary bedroom · neighbor's car in the driveway shots."
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={nothingToRemove}
              onChange={(e) => { setNothingToRemove(e.target.checked); if (e.target.checked) setRemoval(""); }}
              className={checkbox}
            />
            Nothing needs removal — I checked.
          </label>
        </StepCard>
      )}

      {/* ---- STEP: Video (only when a video is on the order). The step's
          shape follows the resolved VIDEO STYLE (BRIEF_BY_STYLE): premium
          styles show the full fields and REQUIRE the script; agent-intro reels
          require the typed intro script + just editing notes; standard reels
          and cinematics get the one box; monthly plans the fixed-style full
          set. The subtitle names the video the order actually bought (Jordan,
          Sep 2: "That should be shown as video type") + the camera it implies,
          so a photographer sees WHY the form has this shape. ---- */}
      {policy.videoOrdered && (
        <StepCard
          n={stepNo++}
          title={spec.requireIntro && !fullFields ? "Video — agent intro script & notes" : "Video — script & your instructions"}
          subtitle={`${videoStyleName(policy.videoStyle) ?? "Video"} · shot on ${colorTier === "premium" ? "S-Log3 / D-LogM" : "iPhone"}`}
          done={videoDone}
        >
          {/* §7.5: what the editor is told for each video, read here before
              the photographer writes their own instructions below. */}
          {briefs.length > 0 && <div className="mb-4 border-b border-border pb-3.5">{briefCard}</div>}
          {script ? (
            <div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[13px] font-medium text-muted">The shoot script (from Script Studio)</p>
                {script.url && (
                  <a href={script.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-brand hover:underline">
                    Open in Studio ↗
                  </a>
                )}
              </div>
              {/* Studio scripts are MARKDOWN (Jordan, Sep 1) — read it rendered,
                  and only open the formatting editor after "Changed on site". */}
              {scriptChoice === "edited" ? (
                <MarkdownEditor value={scriptText} onChange={setScriptText} minRows={5} className="mt-1.5" />
              ) : (
                <div className="mt-1.5 max-h-80 overflow-y-auto scroll-thin rounded-lg border border-border bg-surface-2/60 px-3 py-2">
                  <Markdown content={scriptText} />
                </div>
              )}
              <p className="mt-1.5 text-[13px] text-muted">
                Did the agent deliver it as written? If anything changed on site, pick &ldquo;Changed on site&rdquo; and fix the text — the editor cuts to what you confirm here.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={() => { setScriptChoice("as-written"); setScriptText(script.body); }} className={choiceBtn(scriptChoice === "as-written")}>
                  <CheckCircle2 className="size-4" /> Delivered as written
                </button>
                <button onClick={() => setScriptChoice("edited")} className={choiceBtn(scriptChoice === "edited", "warn")}>
                  Changed on site — edit it
                </button>
              </div>
              {scriptChoice === "edited" && (
                <input
                  value={scriptNote}
                  onChange={(e) => setScriptNote(e.target.value)}
                  placeholder="What changed? (one line — e.g. agent swapped the hook, dropped talking point 2)"
                  className="mt-2 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />
              )}
            </div>
          ) : spec.requireScript ? (
            <div>
              <p className="text-sm font-semibold">
                The script <span className="text-brand">— required for this package</span>
              </p>
              <p className="mt-0.5 text-[13px] text-muted">
                No script came through from Script Studio — type or paste the script exactly as it was delivered on camera. Premium packages can&rsquo;t be submitted without it.
              </p>
              <MarkdownEditor
                value={scriptText}
                onChange={setScriptText}
                minRows={4}
                placeholder="The full script, word for word as filmed."
                className="mt-1.5"
              />
            </div>
          ) : spec.requireIntro || sessionTopics || topicsUnavailable ? null : (
            // Not on a content session: its scripts come from the program
            // (the topic list below says which are signed off), never Studio.
            <p className="rounded-lg bg-surface-2/70 px-3 py-2 text-[13px] text-muted">
              No script found in Script Studio for this shoot. If the agent read from one, put it in the instructions below so the editor has it.
            </p>
          )}

          <div className={cn("border-border", (script || (!spec.requireIntro && !sessionTopics)) && "mt-4 border-t pt-3.5")}>
            {spec.minimalReel ? (
              <p className="text-sm font-semibold">
                Anything the editor should know? <span className="font-normal text-muted">— optional</span>
              </p>
            ) : notesRequired ? (
              // Standard tier (Jordan, Sep 2): one box — no style picker, no
              // sections — but still the photographer's own words.
              <>
                <p className="text-sm font-semibold">
                  Your instructions for the edit <span className="text-brand">— required</span>
                </p>
                <p className="mt-0.5 text-[13px] text-muted">
                  Standard-tier videos are cut from one box — the flow, the must-show moments, anything to avoid.
                </p>
              </>
            ) : spec.requireIntro && !fullFields ? (
              <p className="text-sm font-semibold">
                Intro script &amp; editing notes <span className="text-brand">— intro required</span>
              </p>
            ) : (
              <>
                <p className="text-sm font-semibold">
                  Your instructions for the edit <span className="text-brand">— required</span>
                </p>
                <p className="mt-0.5 text-[13px] text-muted">
                  Sectioned so the editor can act on it — fill what applies; vision and style are required.
                </p>

                {/* Monthly plans have ONE style — no dropdown (Jordan, Sep 1). */}
                {spec.fixedStyle ? (
                  <div className="mt-2.5">
                    <label className="text-[13px] font-medium text-muted">Edit style</label>
                    <p className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm font-medium">
                      <CheckCircle2 className="size-4 text-success" /> {VID_STYLES.branding}
                    </p>
                    <p className="mt-1 text-xs text-muted">Monthly content is always cut in the personal-branding style.</p>
                  </div>
                ) : (
                  <div className="mt-2.5">
                    <label className="text-[13px] font-medium text-muted">Edit style <span className="text-brand">*</span></label>
                    <select
                      value={vidStyle ?? ""}
                      onChange={(e) => setVidStyle((e.target.value || null) as VidStyle | null)}
                      className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand sm:max-w-xs"
                    >
                      <option value="">Pick a style…</option>
                      <option value="fast">{VID_STYLES.fast}</option>
                      <option value="cinematic">{VID_STYLES.cinematic}</option>
                    </select>
                    <p className="mt-1 text-xs text-muted">
                      Ask the realtor on site which they want — luxury often leans timeless &amp; elegant, but not always. Never guess, just ask.
                    </p>
                  </div>
                )}
              </>
            )}

            {/* F12 — WHICH TOPICS, not how many videos.
                A content session is filmed against a named list the client
                chose and (often) approved a script for. Ticking them is the
                only moment anybody who was there tells the hub what exists,
                and it is what links video → topic → script → the client's
                approval. Nothing is pre-ticked. An unticked topic was NOT
                filmed, and a month that reads one short is the truth. */}
            {/* CP-09 (batch C): each ticked topic can carry a note for the
                editor, a topic filmed on site can be added, and the count the
                editor cuts to is said as planned + extra. Everything here rides
                ONE report with the ticks (upload/actions.ts → filmedTopics.ts),
                so it all lands — or waits and retries — together. An extra is
                never refused: it goes to the editor like the others, and the
                office decides what it counts toward (capacity review). */}
            {/* R02: the list did not load. Not "no topics": the ticks saved
                earlier are kept exactly as they were, and the video half waits
                for a reload (see missingItems). */}
            {topicsUnavailable && (
              <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <span>This job&rsquo;s topic list didn&rsquo;t load. Reload the page before you submit the video — the topics you ticked earlier are kept.</span>
              </p>
            )}
            {spec.requireVideoCount && !!sessionTopics && (
              <div className="mt-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <label className="text-[13px] font-medium text-muted">
                    {/* With no list, the count box below is still the required
                        answer — adding what was filmed is the better one. */}
                    {hasTopics ? <>Which topics did you film? <span className="text-brand">*</span></> : "What did you film?"}
                  </label>
                  {topicCount > 0 && (
                    <span className="text-xs font-medium text-foreground">
                      {topicCount} video{topicCount === 1 ? "" : "s"}: {plannedTicked} planned + {extraCount} extra
                    </span>
                  )}
                </div>
                {hasTopics && (
                  <ul className="mt-1.5 space-y-1.5">
                    {sessionTopics.topics.map((t) => {
                      const on = filmedTopicIds.includes(t.topicId);
                      const elsewhere = confirmedElsewhere(t);
                      const recorded = recordedHere(t);
                      const noteOpen = notesOpen.includes(t.topicId);
                      return (
                        <li key={t.topicId}>
                          <button
                            type="button"
                            onClick={() => toggleTopic(t.topicId)}
                            disabled={elsewhere || recorded}
                            aria-disabled={elsewhere || recorded}
                            aria-pressed={on}
                            className={`flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left ${on ? "border-brand bg-brand-soft" : "border-border bg-surface-2"} ${elsewhere ? "cursor-not-allowed opacity-60" : recorded ? "cursor-default" : ""}`}
                          >
                            <span className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border ${on ? "border-brand bg-brand text-white" : "border-border"}`}>
                              {on ? <Check className="size-3" /> : null}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-sm font-medium">{t.title}</span>
                              <span className="block text-[11px] text-muted">
                                {t.pillarName ? `${t.pillarName} · ` : ""}
                                {t.scriptTitle ? (t.clientApproved ? "script signed off by the client" : "script written") : "no script yet"}
                                {t.overflow ? " · beyond this month's plan" : ""}
                                {elsewhere
                                  ? " · filmed at another session this month"
                                  : recorded
                                    ? ` · recorded for this session${t.filmedConfirmedBy ? ` by ${t.filmedConfirmedBy}` : ""}`
                                    : t.filmedConfirmedAtISO
                                      ? ` · already confirmed by ${t.filmedConfirmedBy ?? "the office"}`
                                      : ""}
                              </span>
                            </span>
                          </button>
                          {!elsewhere && (on || t.folder) && (
                            <div className="ml-7 mt-1 space-y-1">
                              {on && (noteOpen ? (
                                <AutoTextarea
                                  value={topicNotes[t.topicId] ?? ""}
                                  onChange={(e) => setTopicNotes((n) => ({ ...n, [t.topicId]: e.target.value }))}
                                  maxLength={1000}
                                  minRows={2}
                                  aria-label={`Note for the editor about ${t.title}`}
                                  placeholder="Note for the editor — the take to use, a line they flubbed, B-roll to lean on."
                                  className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                                />
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setNotesOpen((o) => [...o, t.topicId])}
                                  className="inline-flex items-center gap-1 py-1 text-xs font-medium text-brand hover:underline"
                                >
                                  <NotebookPen className="size-3.5" /> Note for the editor
                                </button>
                              ))}
                              {t.folder && (
                                <a
                                  href={t.folder.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex items-center gap-1 text-[11px] text-muted hover:text-foreground"
                                >
                                  <FolderOpen className="size-3 shrink-0" />
                                  <span className="truncate">Its clips go in 02-RAW-Video/{t.folder.label}</span>
                                </a>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                {/* Filmed on site, not on the list. A title is all it needs;
                    an empty row is simply not sent. */}
                {extraRows.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {extraRows.map((x, i) => (
                      <li key={x.key} className="rounded-lg border border-dashed border-brand/50 bg-brand-soft/40 p-2.5">
                        <div className="flex items-start gap-2">
                          <input
                            value={x.title}
                            onChange={(e) => setExtraRows((rows) => rows.map((r) => (r.key === x.key ? { ...r, title: e.target.value } : r)))}
                            maxLength={200}
                            aria-label={`Extra topic ${i + 1}`}
                            placeholder="What was this video about?"
                            className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                          />
                          <button
                            type="button"
                            onClick={() => setExtraRows((rows) => rows.filter((r) => r.key !== x.key))}
                            aria-label="Remove this topic"
                            className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-foreground"
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                        <AutoTextarea
                          value={x.note}
                          onChange={(e) => setExtraRows((rows) => rows.map((r) => (r.key === x.key ? { ...r, note: e.target.value } : r)))}
                          maxLength={1000}
                          minRows={1}
                          aria-label={`Note for the editor about extra topic ${i + 1}`}
                          placeholder="Describe the take, what changed from the plan, and anything the editor needs (required)"
                          className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                        />
                      </li>
                    ))}
                  </ul>
                )}
                {extraRows.length < 10 && (
                  <button
                    type="button"
                    onClick={() => setExtraRows((rows) => [...rows, { key: newExtraKey(), title: "", note: "" }])}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-sm font-medium text-muted hover:border-brand hover:text-foreground"
                  >
                    <Plus className="size-4" /> Add a topic you filmed
                  </button>
                )}
                <p className="mt-1.5 text-xs text-muted">
                  {hasTopics
                    ? "Tick only what you actually filmed. Anything you leave unticked stays on their list for next time — it is better for us to know one is missing than to find out when they ask for it. Filmed something that isn't listed? Add it: the editor gets it like the others, and the office sorts out what it counts toward."
                    : "No topics were planned for this session yet. Add each video you filmed by what it's about — or, if you'd rather, just give the count below."}
                </p>
              </div>
            )}

            {/* No topic list (a session booked before the month was planned):
                the batch size the editor cuts to, as before. */}
            {spec.requireVideoCount && !hasTopics && liveExtras.length === 0 && !topicsUnavailable && (
              <div className="mt-3">
                <label className="text-[13px] font-medium text-muted">
                  How many videos did you film? <span className="text-brand">*</span>
                </label>
                <input
                  inputMode="numeric"
                  value={videosFilmed}
                  onChange={(e) => setVideosFilmed(e.target.value.replace(/[^\d]/g, "").slice(0, 3))}
                  placeholder="e.g. 4"
                  className="mt-1 w-28 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                />
                <p className="mt-1 text-xs text-muted">
                  The number of DELIVERABLES — how many finished videos this session owes the client. The editor cuts exactly this many.
                </p>
              </div>
            )}

            <div className="mt-3 space-y-3">
              {sectionKeys.map((k) => VID_SECTIONS.find((sec) => sec.key === k)!).map((s) => (
                <div key={s.key}>
                  <label className="text-[13px] font-medium text-muted">
                    {s.title}{isRequiredKey(s.key) && <span className="text-brand"> *</span>}
                  </label>
                  <AutoTextarea
                    value={vidSections[s.key]}
                    onChange={(e) => setVidSections((v) => ({ ...v, [s.key]: e.target.value }))}
                    minRows={s.key === "vision" || s.key === "intro" ? 3 : 2}
                    placeholder={s.placeholder}
                    className="mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                  />
                </div>
              ))}
            </div>

            {requiredLabels.length > 0 && (
              <p className="mt-1.5 text-xs text-warning">
                {`${requiredLabels.length > 2 ? `${requiredLabels.slice(0, -1).join(", ")} and ${requiredLabels[requiredLabels.length - 1]}` : requiredLabels.join(" and ")} can’t be left blank${spec.requireIntro ? " — the editor cuts and captions to the intro" : ""}. Skipping the instructions forfeits future premium shoot assignments.`}
              </p>
            )}
          </div>
        </StepCard>
      )}

      {/* ---- STEP: Wrap up ---- */}
      <StepCard
        n={stepNo++}
        title="Check off & wrap up"
        done={done}
        subtitle="Tick each item once its files are in Dropbox, add anything else the editor should know, then submit."
      >
        <div className="space-y-2">
          {deliverables.map((d) => {
            const meta = DELIVERABLE_META[d.type];
            const on = uploaded[d.id];
            const reason = !on ? notDone[d.id] : undefined;
            const editing = reasonFor === d.id;
            return (
              <div key={d.id}>
                <button
                  onClick={() => toggle(d.id)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-colors",
                    on ? "border-success/40 bg-success-soft/30" : reason ? "border-warning/40 bg-warning/5" : "bg-surface hover:bg-surface-2",
                  )}
                >
                  {on ? (
                    <CheckCircle2 className="size-5 shrink-0 text-success" />
                  ) : reason ? (
                    <XCircle className="size-5 shrink-0 text-warning" />
                  ) : (
                    <Circle className="size-5 shrink-0 text-muted-2" />
                  )}
                  <span className="flex-1 text-sm font-medium">
                    {meta.label}
                    {d.quantity > 1 && <span className="text-muted"> ×{d.quantity}</span>}
                  </span>
                  <span className={cn("text-xs", reason ? "font-semibold text-warning" : "text-muted")}>
                    {on ? "Uploaded" : reason ? "Couldn't complete" : "Not yet"}
                  </span>
                </button>
                {reason && !editing && (
                  <p className="mt-1 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-foreground/80">
                    <span className="font-semibold text-warning">Why:</span> {reason}{" "}
                    <button
                      onClick={() => { setReasonFor(d.id); setReasonText(reason); }}
                      className="ml-1 font-medium text-muted underline"
                    >
                      edit
                    </button>
                    <button
                      onClick={() => saveNotCompleted(d.id, "")}
                      title="Remove the reason — it's just not done yet"
                      className="ml-2 font-medium text-muted underline"
                    >
                      clear
                    </button>
                  </p>
                )}
                {!on && !reason && !editing && (
                  <button
                    onClick={() => { setReasonFor(d.id); setReasonText(""); }}
                    className="mt-1 px-1 text-xs text-muted underline hover:text-foreground"
                  >
                    Can&rsquo;t complete this? Tell the admin why
                  </button>
                )}
                {editing && (
                  <div className="mt-1.5 flex gap-2">
                    <input
                      autoFocus
                      value={reasonText}
                      onChange={(e) => setReasonText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && reasonText.trim()) saveNotCompleted(d.id, reasonText.trim());
                        if (e.key === "Escape") { setReasonFor(null); setReasonText(""); }
                      }}
                      placeholder="Why couldn't it be completed? e.g. Seller refused the drone — needs a re-shoot"
                      className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
                    />
                    <button
                      disabled={toggling || !reasonText.trim()}
                      onClick={() => saveNotCompleted(d.id, reasonText.trim())}
                      className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => { setReasonFor(null); setReasonText(""); }}
                      className="rounded-lg px-2 py-2 text-sm text-muted hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4">
          <label className="block text-sm font-semibold">Anything else for the editor?</label>
          <AutoTextarea
            value={editorBrief}
            onChange={(e) => setEditorBrief(e.target.value)}
            minRows={2}
            placeholder="e.g. House faces west so exteriors are backlit — recover sky. Seller wants the pool emphasized. Skip the cluttered office."
            className="mt-1.5 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
            <Flag className="size-4 text-danger" /> Flag a problem
          </div>
          <div className="flex gap-2">
            <input
              value={flagInput}
              onChange={(e) => setFlagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitFlag()}
              placeholder="e.g. Couldn’t shoot the garage — heads up for the editor."
              className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <button onClick={submitFlag} className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2">
              Flag
            </button>
          </div>
          {flags.length > 0 && (
            <ul className="mt-2 space-y-1">
              {flags.map((f, i) => (
                <li key={i} className="flex items-center gap-2 rounded-lg bg-danger-soft/60 px-2.5 py-1.5 text-xs text-danger">
                  <AlertTriangle className="size-3.5" /> {f}
                </li>
              ))}
            </ul>
          )}
        </div>

        <MissingWork projectId={project.id} gaps={gaps} office={viewerIsOffice} />
        <FieldFeedback projectId={project.id} clientName={project.clientName} reports={fieldReports} office={viewerIsOffice} />
      </StepCard>
      </>
      )}

      {/* Submit — hidden while the confirmation is collapsed, so a submitted
          page ends on "you're good to go" rather than on another submit button. */}
      <div className={cn("sticky bottom-4 rounded-2xl border bg-surface p-4 shadow-lg", collapsed && !ask && "hidden")}>
        {/* In-page confirmation — replaces window.confirm(), which mobile and
            in-app browsers swallow after an await (Harrison's stuck "hold on"). */}
        {ask && (
          <div className="mb-3 rounded-xl border border-warning/40 bg-warning/10 p-3">
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-foreground/90">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{ask.body}</span>
            </p>
            {ask.review && ask.action.kind === "submit" && handoffReceipt(ask.action.scope)}
            <div className="mt-2.5 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isPending || !!pendingAttempt || (ask.review && checkingRaw)}
                onClick={() => {
                  const a = ask.action;
                  setAsk(null);
                  // Dispatched from THIS render, so it carries whatever the
                  // photographer has typed up to the moment they confirm.
                  if (a.kind === "submit") {
                    if (a.reviewFingerprint && a.reviewFingerprint !== reviewFingerprint) { finalize(a.scope); return; }
                    if (a.reviewFingerprint && rawCheck && Date.now() - Date.parse(rawCheck.checkedAtISO) > 120_000) { finalize(a.scope); return; }
                    runSubmit(a.force, a.scope, a.baseHash);
                  }
                  else applyToggle(a.id, a.next, a.prevReason);
                }}
                className="rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
              >
                {isPending ? "Submitting…" : ask.review && checkingRaw ? "Checking files…" : ask.yes}
              </button>
              <button
                onClick={() => { rawCheckRequest.current++; setCheckingRaw(false); setAsk(null); }}
                className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground"
              >
                Go back
              </button>
            </div>
          </div>
        )}
        {!done && !ask && (
          <p className="mb-2.5 text-[13px] font-medium text-brand">
            {splitMode
              ? "Submit the photos and the video each when they're ready. The shoot is added to your payroll once both are in."
              : "Once submitted, this shoot is added to your payroll."}
          </p>
        )}
        {!ask && (splitMode ? (
          // O05: one button per half, each with its own checks. A half that is
          // already in can be re-submitted to correct its notes.
          <div className="space-y-2">
            {(["photos", "video"] as const).map((half) => {
              const at = half === "photos" ? halfAt.photos : halfAt.video;
              const label = half === "photos" ? "photos" : "video";
              return (
                <div key={half} className="flex items-center justify-between gap-3">
                  <div className="text-sm text-muted">
                    {at ? (
                      <span className="inline-flex items-center gap-1 text-success">
                        <CheckCircle2 className="size-4" /> {half === "photos" ? "Photos" : "Video"} submitted {etTime(at)}
                      </span>
                    ) : (
                      <>{half === "photos" ? "Photos" : "Video"} not submitted yet</>
                    )}
                  </div>
                  <button
                    onClick={() => finalize(half)}
                    disabled={isPending || !!pendingAttempt}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-50",
                      at ? "border border-border bg-surface text-foreground" : "bg-brand text-brand-fg",
                    )}
                  >
                    {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                    {at ? `Re-submit ${label}` : `Submit ${label}`}
                  </button>
                </div>
              );
            })}
            <div className="text-xs text-muted-2">
              {doneCount}/{total} uploaded
              {notDoneCount > 0 && <span className="text-warning"> · {notDoneCount} couldn&rsquo;t be completed</span>}
              {project.photographerName && ` · ${project.photographerName}`}
              {draftChip(saveStatus, canSaveDraft)}
            </div>
          </div>
        ) : (
        <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-muted">
          {doneCount}/{total} uploaded
          {notDoneCount > 0 && <span className="text-warning"> · {notDoneCount} couldn&rsquo;t be completed</span>}
          {project.photographerName && ` · ${project.photographerName}`}
          {draftChip(saveStatus, canSaveDraft)}
        </div>
        <button
          onClick={() => finalize()}
          disabled={isPending || !!pendingAttempt}
          className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-fg transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {done ? "Re-submit to editors" : "Everything's uploaded — submit"}
        </button>
        </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// §7.6 MISSING WORK — the job's production gaps: a whole item that couldn't be
// delivered (from "couldn't complete" above) and a shot missed inside
// something that was. The photographer reports; the office plans the recovery
// (who, by when, and for a reshoot the shot list and scope) or closes it with
// the note that is the record. Nothing here books, waives or charges.
// ---------------------------------------------------------------------------
const RECOVERY_OPTIONS: { value: string; label: string }[] = [
  { value: "RESHOOT", label: "Reshoot" },
  { value: "CLIENT_SUPPLIES", label: "The client supplies it" },
  { value: "USE_EXISTING", label: "Use what we already have" },
  { value: "OFFICE_DECIDES", label: "The office decides" },
];

function MissingWork({ projectId, gaps, office }: { projectId: string; gaps: GapView[]; office: boolean }) {
  const [what, setWhat] = useState("");
  const [why, setWhy] = useState("");
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [recovery, setRecovery] = useState("RESHOOT");
  const [owner, setOwner] = useState("");
  const [dueDay, setDueDay] = useState("");
  const [shots, setShots] = useState("");
  const [scopeNote, setScopeNote] = useState("");
  const [closeFor, setCloseFor] = useState<string | null>(null);
  const [closeNote, setCloseNote] = useState("");

  const report = () => start(async () => {
    const r = await reportMissedShot(projectId, { what, reason: why }).catch(() => ({ ok: false, message: "Couldn't save that — check your connection and try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setWhat(""); setWhy(""); setOpen(false); }
  });
  const plan = (gapId: string) => start(async () => {
    const shotList = shots.split("\n").map((l) => l.trim()).filter(Boolean).map((shot) => ({ shot }));
    const r = await planGapRecovery(gapId, { recovery, ownerKey: owner, dueDay, shotList, scopeNote }).catch(() => ({ ok: false, message: "Couldn't save that — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) setPlanFor(null);
  });
  const close = (gapId: string, how: "RESOLVED" | "CANCELLED") => start(async () => {
    const r = await closeProductionGap(gapId, how, closeNote).catch(() => ({ ok: false, message: "Couldn't save that — try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setCloseFor(null); setCloseNote(""); }
  });
  const input = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand";

  return (
    <div className="mt-4">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold">
        <XCircle className="size-4 text-warning" /> Missing work
      </div>
      {gaps.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {gaps.map((g) => {
            const closed = g.state === "RESOLVED" || g.state === "CANCELLED";
            return (
              <li key={g.id} className={cn("rounded-lg border px-3 py-2 text-[13px]", closed ? "border-border bg-surface-2/40 text-muted" : g.overdue ? "border-danger/40 bg-danger/5" : "border-warning/40 bg-warning/5")}>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium text-foreground">{g.what}</span>
                  <span className="text-xs text-muted">{g.kind === "SHOT" ? "missed shot" : "not delivered"} · raised by {g.raisedBy}</span>
                  <span className={cn("ml-auto text-xs font-semibold", closed ? "text-muted" : g.overdue ? "text-danger" : "text-warning")}>
                    {g.state === "OPEN" ? "Needs a recovery plan"
                      : g.state === "PLANNED" ? `${RECOVERY_OPTIONS.find((o) => o.value === g.recovery)?.label ?? "Planned"}${g.ownerKey ? ` · ${g.ownerKey}` : ""}${g.dueISO ? ` · due ${etDate(g.dueISO)}` : ""}${g.overdue ? " · overdue" : ""}`
                      : g.state === "RESOLVED" ? "Resolved" : "Cancelled"}
                  </span>
                </div>
                <p className="mt-0.5 text-foreground/80">{g.reason}</p>
                {g.shotList.length > 0 && (
                  <ul className="ml-4 mt-1 list-disc text-xs text-foreground/80">
                    {g.shotList.map((l, i) => <li key={i}>{l.shot}{l.note ? ` — ${l.note}` : ""}</li>)}
                  </ul>
                )}
                {g.scopeNote && <p className="mt-0.5 text-xs text-muted">Scope: {g.scopeNote}</p>}
                {g.resolutionNote && <p className="mt-0.5 text-xs text-muted">{g.resolutionNote}</p>}
                {office && !closed && planFor !== g.id && closeFor !== g.id && (
                  <div className="mt-1.5 flex gap-3 text-xs">
                    <button onClick={() => { setPlanFor(g.id); setOwner(g.ownerKey ?? ""); setScopeNote(g.scopeNote ?? ""); setShots(g.shotList.map((l) => l.shot).join("\n")); }} className="font-medium text-brand underline">Plan recovery</button>
                    <button onClick={() => { setCloseFor(g.id); setCloseNote(""); }} className="font-medium text-muted underline">Close</button>
                  </div>
                )}
                {office && planFor === g.id && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex flex-wrap gap-2">
                      <select value={recovery} onChange={(e) => setRecovery(e.target.value)} className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm">
                        {RECOVERY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who owns it (e.g. kyle, harrison)" className="min-w-0 flex-1 rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm" />
                      <input type="date" value={dueDay} onChange={(e) => setDueDay(e.target.value)} className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-sm" />
                    </div>
                    {recovery === "RESHOOT" && (
                      <>
                        <AutoTextarea value={shots} onChange={(e) => setShots(e.target.value)} minRows={2} placeholder="The shot list, one shot per line" className={input} />
                        <input value={scopeNote} onChange={(e) => setScopeNote(e.target.value)} placeholder="Scope: what is and is not being reshot" className={input} />
                      </>
                    )}
                    <div className="flex gap-2">
                      <button disabled={pending} onClick={() => plan(g.id)} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50">Save plan</button>
                      <button onClick={() => setPlanFor(null)} className="rounded-lg px-2 py-1.5 text-sm text-muted">Cancel</button>
                    </div>
                  </div>
                )}
                {office && closeFor === g.id && (
                  <div className="mt-2 space-y-1.5">
                    <input value={closeNote} onChange={(e) => setCloseNote(e.target.value)} placeholder="How it was settled — this note is the record" className={input} />
                    <div className="flex flex-wrap gap-2">
                      <button disabled={pending || !closeNote.trim()} onClick={() => close(g.id, "RESOLVED")} className="rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-brand-fg disabled:opacity-50">Recovered</button>
                      <button disabled={pending || !closeNote.trim()} onClick={() => close(g.id, "CANCELLED")} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium disabled:opacity-50">No longer needed</button>
                      <button onClick={() => setCloseFor(null)} className="rounded-lg px-2 py-1.5 text-sm text-muted">Cancel</button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open ? (
        <div className="space-y-1.5">
          <input value={what} onChange={(e) => setWhat(e.target.value)} maxLength={200} placeholder="Which shot? e.g. Pool at dusk" className={input} />
          <input value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} placeholder="Why? e.g. Rain rolled in before sunset" className={input} />
          <div className="flex gap-2">
            <button disabled={pending || !what.trim() || !why.trim()} onClick={report} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">Tell the office</button>
            <button onClick={() => setOpen(false)} className="rounded-lg px-2 py-1.5 text-sm text-muted">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="px-1 text-xs text-muted underline hover:text-foreground">
          Missed a shot? Tell the office what and why
        </button>
      )}
      {msg && <p className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §7.8 FIELD FEEDBACK — a client preference or request from the shoot, with
// where it came from (they said it, or it was noticed) and how far it reaches
// (this job, or the client going forward). It is a PROPOSAL until the office
// confirms it; only then does it reach the editor brief.
// ---------------------------------------------------------------------------
function FieldFeedback({ projectId, clientName, reports, office }: { projectId: string; clientName: string; reports: FieldReportView[]; office: boolean }) {
  const [body, setBody] = useState("");
  const [basis, setBasis] = useState<"client_said" | "observation">("client_said");
  const [scope, setScope] = useState<"project" | "client">("project");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const send = () => start(async () => {
    const r = await recordFieldPreference(projectId, { body, basis, scope }).catch(() => ({ ok: false, message: "Couldn't save that — check your connection and try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) setBody("");
  });
  const decide = (id: string, d: "ACCEPT" | "REJECT") => start(async () => {
    const r = await decideFieldReport(id, d).catch(() => ({ ok: false, message: "Couldn't save that — try again." }));
    setMsg({ ok: r.ok, text: r.message });
  });
  const pill = (active: boolean) => cn("rounded-lg border px-2.5 py-1 text-xs font-medium", active ? "border-brand bg-brand-soft text-foreground" : "border-border text-muted hover:bg-surface-2");
  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <NotebookPen className="size-4 text-brand" /> Client preference or request
      </div>
      <p className="mb-1.5 text-xs text-muted">
        Something {clientName} asked for, or something you noticed about what they like. The office confirms it before it reaches the editor.
      </p>
      <AutoTextarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        minRows={1}
        maxLength={1000}
        placeholder="e.g. Wants the logo bottom-right on every reel"
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => setBasis("client_said")} className={pill(basis === "client_said")}>They asked for it</button>
        <button type="button" onClick={() => setBasis("observation")} className={pill(basis === "observation")}>I noticed it</button>
        <span className="mx-1 text-muted-2">·</span>
        <button type="button" onClick={() => setScope("project")} className={pill(scope === "project")}>Just this job</button>
        <button type="button" onClick={() => setScope("client")} className={pill(scope === "client")}>This client going forward</button>
        <button disabled={pending || !body.trim()} onClick={send} className="ml-auto rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
          Send to the office
        </button>
      </div>
      {reports.length > 0 && (
        <ul className="mt-2 space-y-1">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-border bg-surface-2/40 px-2.5 py-1.5 text-[13px]">
              <span className="text-foreground/85">{r.body}</span>
              <span className="ml-1.5 text-xs text-muted">
                {r.basis === "client_said" ? "they asked" : r.basis === "observation" ? "noticed on site" : "from the field"} · {r.scope === "PROJECT" ? "this job" : "going forward"} ·{" "}
                <span className={cn("font-semibold", r.status === "ACCEPTED" ? "text-success" : r.status === "REJECTED" ? "text-muted" : "text-warning")}>
                  {r.status === "ACCEPTED" ? "confirmed" : r.status === "REJECTED" ? "not used" : "waiting for the office"}
                </span>
              </span>
              {office && r.status === "PROPOSED" && (
                <span className="ml-2 inline-flex gap-2 text-xs">
                  <button disabled={pending} onClick={() => decide(r.id, "ACCEPT")} className="font-medium text-brand underline disabled:opacity-50">Confirm</button>
                  <button disabled={pending} onClick={() => decide(r.id, "REJECT")} className="font-medium text-muted underline disabled:opacity-50">Reject</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// §7.5 / §6.8 (Sep 28 2026): EACH VIDEO'S BRIEF, on the page the photographer
// fills after the shoot. It is the same brief the editor's page, the printed
// brief and the shoot screen read, with its version and who last saved it.
// The photographer can add what changed on site to one video: the note is
// added to that video's "Changed on site" with their name and the day, as a
// new version (deliverableOutputs.addOnSiteNote); it never replaces what the
// office wrote. The page decides which videos are shown and whether notes can
// be added (never from a "view as" preview); the server checks both again.
// ---------------------------------------------------------------------------
function VideoBriefs({
  projectId, briefs, onSaved, action, blocked, cap,
}: {
  projectId: string;
  briefs: PortalOutputBrief[];
  onSaved: (b: PortalOutputBrief) => void;
  action: ((projectId: string, outputId: string, note: string) => Promise<BriefNoteResult>) | null;
  blocked: string | null;
  cap: number;
}) {
  if (!briefs.length) return null;
  return (
    <div>
      <p className="text-sm font-semibold">{briefs.length > 1 ? "Each video's brief" : "This video's brief"}</p>
      <p className="mt-0.5 text-[13px] text-muted">
        What the editor is told for {briefs.length > 1 ? "each video" : "this video"}.{" "}
        {blocked ?? "If something changed on site, add it to that video: it goes on the brief with your name."}
      </p>
      <ul className="mt-2 space-y-2">
        {briefs.map((b) => (
          <VideoBriefRow key={b.outputId} projectId={projectId} brief={b} onSaved={onSaved} action={blocked ? null : action} cap={cap} />
        ))}
      </ul>
    </div>
  );
}

function VideoBriefRow({
  projectId, brief, onSaved, action, cap,
}: {
  projectId: string;
  brief: PortalOutputBrief;
  onSaved: (b: PortalOutputBrief) => void;
  /** null = this view cannot add notes (a preview): the brief is shown, read-only */
  action: ((projectId: string, outputId: string, note: string) => Promise<BriefNoteResult>) | null;
  cap: number;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () => {
    if (!action) return;
    const text = note.trim();
    if (!text) return;
    start(async () => {
      const r = await action(projectId, brief.outputId, text).catch(
        (): BriefNoteResult => ({ ok: false, changed: false, message: "Couldn't save the note. Check your connection and try again.", brief: null }),
      );
      if (r.brief) onSaved(r.brief);
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) { setNote(""); setOpen(false); }
    });
  };
  return (
    <li className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-sm font-medium">{brief.index}. {brief.label}</span>
        {brief.format !== brief.label && <span className="text-[11px] text-muted">{brief.format}</span>}
        {brief.topicTitle && <span className="text-[11px] text-muted">· {brief.topicTitle}</span>}
      </div>
      <p className="text-[11px] text-muted-2">{brief.versionLabel}</p>
      {brief.sections.length > 0 && (
        <dl className="mt-1.5 space-y-1 text-[13px] leading-relaxed">
          {brief.sections.map((x) => (
            <div key={x.key}>
              <dt className="text-xs font-medium text-muted">{x.label}</dt>
              <dd className="whitespace-pre-wrap text-foreground/90">{x.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {action && (open ? (
        <div className="mt-2">
          <AutoTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={cap}
            minRows={2}
            aria-label={`On-site note for ${brief.label}`}
            placeholder="What changed on site for this video? e.g. the agent asked us to skip the garage; use the second take of the intro."
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={pending || !note.trim()}
              onClick={save}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {pending && <Loader2 className="size-3.5 animate-spin" />} Add to this video&apos;s brief
            </button>
            <button type="button" onClick={() => { setOpen(false); setNote(""); }} className="text-xs font-medium text-muted hover:underline">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => { setOpen(true); setMsg(null); }}
          className="mt-1.5 inline-flex items-center gap-1 py-1 text-xs font-medium text-brand hover:underline"
        >
          <NotebookPen className="size-3.5" /> Add an on-site note
        </button>
      ))}
      {msg && <p className={cn("mt-1 text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}
    </li>
  );
}
