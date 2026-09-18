import { videoStepSpec, type VideoScriptMode } from "@/lib/pipeline";

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
  const spec = videoStepSpec(p.titles, {
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
  if (!spec.minimalReel && !p.debriefSubmittedAt) {
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
