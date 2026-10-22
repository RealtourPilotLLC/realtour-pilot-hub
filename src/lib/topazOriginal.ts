// ---------------------------------------------------------------------------
// THE EDITOR'S ORIGINAL AS THE FINISHED FILE (Jordan, Oct 22 2026).
//
// "How do I adjust the topaz settings? It did a bad job on the video for 711
// Boehms and I noticed it looked bad on a few other videos as well. No need to
// fix the videos, I just want to prevent it going forward and have more
// control over the settings."
//
// Measured that afternoon on the last 30 renders: every source was ALREADY
// 1080p (1920x1080 or 1080x1920) at about 15 Mbit, H.264 picture, AAC sound.
// Topaz was not upscaling anything. It re-processed a clean, finished file at
// the same size, and on 711 Boehms Church Rd a frame comparison showed it made
// it worse: crunchy, speckled foliage (over-sharpened), waxy faces and hands
// (noise reduction on footage that had none), slightly darker shadows.
//
// So one new way for the editor's original to BE the deliverable, alongside
// the old ones (no pass at all; a pass that was skipped or failed):
//
//   "original-final"  the hub's own rule, set once in Settings and applied to
//                     every video — the file is already finished
//                     (alreadyFinishedRule below). Nothing is sent to Topaz,
//                     nothing is spent, and the original goes out as is.
//
// (A per-video "send the original instead" was built and dropped the same day,
// Jordan: "I don't want to adjust topaz settings for each video, just in
// general, so in my settings." Do not add a per-video Topaz control back.)
//
// It is FIRST-CLASS: everywhere a checked 1080p render flows today, it flows
// too, handing over the editor's original instead — Ready to send
// (readyToSend.fileFor / portalStepFor), the Upload to Aryeo and send button
// (videoAryeoPush gates), and a monthly video's portal (monthlyFinal
// verified1080p → cutEntitlement.clientCutFiles kind "original" →
// monthlyFinalSnapshot proves the original's Dropbox backup). The held-render
// decision ("resolved-original") is untouched and keeps its old meaning.
//
// Pure — no server-only import — so the client components (the Ready card,
// the Review Room, Settings) and the server read ONE set of words and ONE rule.
// ---------------------------------------------------------------------------

/** The outputCheck values that mean "the editor's original is the trusted,
 *  sendable file" (portal and Aryeo button included). */
export const ORIGINAL_IS_FINAL = ["original-final"] as const;
export type OriginalCheck = (typeof ORIGINAL_IS_FINAL)[number];

/** The rule ends the job `skipped` (nothing was sent to Topaz). A `done`
 *  job's file is always the render. */
const ORIGINAL_STATES = new Set(["skipped"]);

/** Is the editor's original the trusted deliverable for this 1080p job? */
export function editorOriginalIsFinal(j: { state: string; outputCheck?: string | null } | null | undefined): boolean {
  return !!j && ORIGINAL_STATES.has(j.state) && (ORIGINAL_IS_FINAL as readonly string[]).includes(j.outputCheck ?? "");
}

/** What the screen says when the hub's rule skipped the pass. Jordan's words. */
export const ALREADY_FINISHED_SAYS = "Already 1080p: the editor's file goes out as is.";

// ---------------------------------------------------------------------------
// THE RULE. Pure over what the file's own header says (integrations/topaz
// probeVideoMetadata: width/height after rotation, the video sample entry's
// four-character code, the first audio track's).
//
//   skip  the short side equals the output short side (1080), the picture is
//         H.264 (avc1/avc3) or HEVC (hvc1/hev1), and the sound is AAC (mp4a)
//         or there is none.
//   run   anything else — 4K, smaller than 1080, ProRes, PCM sound, a header
//         that could not be read — exactly as before Oct 22.
//
// The sound CHECK is separate (finalRendition.judgeFinalSound, run on the
// original by the lane, the same check a finished render gets): a finished-
// looking file with no sound, or with its sound out of step, is NOT skipped —
// it runs the pass exactly as before, which ends with the existing held-file
// listen ("I listened, use this file"). The hub never trusts a silent or
// out-of-step file on its own word.
// ---------------------------------------------------------------------------

const H264 = new Set(["avc1", "avc3"]);
const HEVC = new Set(["hvc1", "hev1"]);

export type FinishedFacts = {
  width: number;
  height: number;
  /** the video sample entry's four-character code ("avc1", "hvc1", "apcn"…) */
  codec: string | null;
  audio: { present: boolean; codec: string | null };
};

export type FinishedVerdict = { skip: true; why: string } | { skip: false; why: string };

/** Should this source skip the pass because it is already the finished file? */
export function alreadyFinishedRule(facts: FinishedFacts | null, s: { skipFinished1080p: boolean; outputShortSide: number }): FinishedVerdict {
  if (!s.skipFinished1080p) return { skip: false, why: "the already-finished rule is switched off in Settings" };
  if (!facts || !(facts.width > 0 && facts.height > 0)) return { skip: false, why: "the file's header couldn't be read" };
  const short = Math.min(facts.width, facts.height);
  if (short !== s.outputShortSide) {
    return { skip: false, why: short > s.outputShortSide ? `it is ${facts.width}x${facts.height}, bigger than ${s.outputShortSide}p` : `it is ${facts.width}x${facts.height}, smaller than ${s.outputShortSide}p` };
  }
  const codec = (facts.codec ?? "").toLowerCase();
  if (!H264.has(codec) && !HEVC.has(codec)) return { skip: false, why: `its picture is "${facts.codec ?? "unknown"}", not H.264 or HEVC` };
  if (facts.audio.present && facts.audio.codec !== "mp4a") return { skip: false, why: `its sound is "${facts.audio.codec ?? "unknown"}", not AAC` };
  return {
    skip: true,
    why: `${facts.width}x${facts.height} ${H264.has(codec) ? "H.264" : "HEVC"}${facts.audio.present ? " with AAC sound" : " with no sound track"}`,
  };
}

/** Topaz's API has no way to render part of a video (checked Oct 22 2026: the
 *  create-request schema has no trim, start or end field, and prob-4 takes no
 *  frame range), so a test always renders the whole video. Said on screen. */
export const WHOLE_VIDEO_NOTE = "Topaz's API can't render only part of a video, so the test renders the whole thing.";
