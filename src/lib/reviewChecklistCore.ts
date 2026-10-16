// ---------------------------------------------------------------------------
// THE REVIEWER'S TWO-PART CHECK, PURE HALF (Oct 15 2026). No prisma, no
// server-only: the Review Room checklist, the server that records it and the
// drill read the same list and the same rule.
//
// The editor already attests to their own export before it reaches review
// (selfCheck.ts). What the REVIEWER signed was one green button that stood for
// everything at once, so "approved" could mean "the audio is fine" or "this is
// the client's style" and nobody could tell which. Two blocks now, each saved
// with who checked it and when, against the exact version:
//
//   TECH      is the file right? Levels, spelling and names, framing, black
//             frames, the export, the right version and count. Pre-filled from
//             the editor's own check so the reviewer confirms, not retypes.
//   CREATIVE  is it right for THIS client? Hook, pacing, the approved script,
//             their brand graphics and fonts, the approved concept and format.
//             On program and premium videos only James (the creative approver)
//             or Jordan may sign it: creative direction is not the office's.
// ---------------------------------------------------------------------------

export const CHECK_BLOCKS = ["TECH", "CREATIVE"] as const;
export type CheckBlock = (typeof CHECK_BLOCKS)[number];
export const isCheckBlock = (v: unknown): v is CheckBlock => v === "TECH" || v === "CREATIVE";

export const CHECKLIST_KEY: Record<CheckBlock, string> = { TECH: "tech@v1", CREATIVE: "creative@v1" };
export const BLOCK_TITLE: Record<CheckBlock, string> = { TECH: "Technical check", CREATIVE: "Creative check" };

export type ReviewCheckItem = {
  key: string;
  label: string;
  help?: string;
  /** May this line be answered "doesn't apply" (with a reason)? */
  naAllowed: boolean;
  /** The editor self-check line this one is pre-filled from (selfCheck.ts keys). */
  fromSelfCheck?: string;
};

export const TECH_ITEMS: readonly ReviewCheckItem[] = [
  { key: "audio_music", label: "Voice and music levels are right: the voice is clear, the music sits under it, nothing clips or cuts off.", naAllowed: true, fromSelfCheck: "audio_visual" },
  { key: "spelling_names", label: "Names, spelling, numbers and on-screen text are correct.", help: "Agent and brokerage names, the address, phone numbers, every caption.", naAllowed: true, fromSelfCheck: "captions_text" },
  { key: "framing", label: "Framing is right: nothing cropped badly, verticals straight, nothing in shot that shouldn't be.", naAllowed: false, fromSelfCheck: "audio_visual" },
  { key: "black_frames", label: "No black frames, flashes or frozen frames at the start, the end or the cuts.", naAllowed: false, fromSelfCheck: "watched_full" },
  { key: "export", label: "The export is right: 1080p, the right shape for where it is going, and it plays.", naAllowed: false, fromSelfCheck: "export_upload" },
  { key: "version_count", label: "It is the right video and the newest version, and the job has the number of videos it owes.", naAllowed: false, fromSelfCheck: "export_upload" },
];

export const CREATIVE_ITEMS: readonly ReviewCheckItem[] = [
  { key: "hook", label: "The first seconds give a reason to keep watching.", naAllowed: false },
  { key: "pacing", label: "The pacing fits this client: not dragging, not rushed.", naAllowed: false },
  { key: "script", label: "It follows the approved script.", help: "The approved version is on this page.", naAllowed: true },
  { key: "brand", label: "Brand graphics and fonts are the client's own.", help: "Their brand kit is on this page.", naAllowed: true },
  { key: "concept", label: "It matches the approved concept and the client's proven format, with nothing from a series they stopped.", naAllowed: false },
];

export const ITEMS_FOR: Record<CheckBlock, readonly ReviewCheckItem[]> = { TECH: TECH_ITEMS, CREATIVE: CREATIVE_ITEMS };

export type CheckAnswer = { key: string; answer: "OK" | "NA"; reason?: string | null };

/** A "doesn't apply" says why, in at least this many characters. */
export const NA_REASON_MIN = 6;

/** Pure: every line answered, N/A only where allowed and with a reason. */
export function validateAnswers(block: CheckBlock, answers: CheckAnswer[]): { ok: true; answers: CheckAnswer[] } | { ok: false; message: string } {
  const byKey = new Map(answers.map((a) => [a.key, a]));
  const out: CheckAnswer[] = [];
  for (const item of ITEMS_FOR[block]) {
    const a = byKey.get(item.key);
    if (!a || (a.answer !== "OK" && a.answer !== "NA")) return { ok: false, message: `Tick every line of the ${BLOCK_TITLE[block].toLowerCase()} first.` };
    if (a.answer === "NA") {
      if (!item.naAllowed) return { ok: false, message: `"${item.label}" can't be skipped.` };
      const reason = (a.reason ?? "").trim();
      if (reason.length < NA_REASON_MIN) return { ok: false, message: "Say in a few words why a line doesn't apply." };
      out.push({ key: item.key, answer: "NA", reason: reason.slice(0, 300) });
    } else out.push({ key: item.key, answer: "OK", reason: null });
  }
  return { ok: true, answers: out };
}

/** Program (monthly) and premium videos need the creative approver's sign-off. */
export function creativeApproverRequired(cut: { monthly: boolean; premium: boolean }): boolean {
  return cut.monthly || cut.premium;
}

/**
 * The editor's self-check answers as the TECH block's starting state. A line
 * the editor answered "doesn't apply" starts as N/A with their reason; a line
 * they ticked starts ticked. Pure.
 */
export function prefillFromSelfCheck(selfCheck: { key: string; answer: string; reason: string | null }[] | null | undefined): Record<string, CheckAnswer> {
  const out: Record<string, CheckAnswer> = {};
  if (!selfCheck?.length) return out;
  const by = new Map(selfCheck.map((s) => [s.key, s]));
  for (const item of TECH_ITEMS) {
    const s = item.fromSelfCheck ? by.get(item.fromSelfCheck) : undefined;
    if (!s) continue;
    if (s.answer === "NA" && item.naAllowed) out[item.key] = { key: item.key, answer: "NA", reason: s.reason };
    else if (s.answer === "YES" || s.answer === "OK") out[item.key] = { key: item.key, answer: "OK", reason: null };
  }
  return out;
}

/** What the Review Room shows about one block on one version. */
export type BlockState = {
  block: CheckBlock;
  saved: { by: string; atISO: string; role: string | null; answers: CheckAnswer[]; note: string | null } | null;
  /** saved, but on a file that has since changed */
  stale: boolean;
};

/**
 * Why Approve is not available yet, in plain words, or null. Pure, so the
 * button and the server say the same thing.
 */
export function approvalBlockedReason(s: { tech: BlockState; creative: BlockState; creativeRequired: boolean; creativeSignedByApprover: boolean }): string | null {
  const techOk = !!s.tech.saved && !s.tech.stale;
  const creativeOk = !!s.creative.saved && !s.creative.stale && (!s.creativeRequired || s.creativeSignedByApprover);
  if ((s.tech.saved && s.tech.stale) && (s.creative.saved && s.creative.stale)) return "The file changed after the checks. Check it again before approving.";
  if (!techOk && !creativeOk) return s.creativeRequired ? "Save the technical check, and the creative check from James or Jordan, before approving." : "Save the technical and creative checks before approving.";
  if (!techOk) return s.tech.stale ? "The file changed after the technical check. Check it again before approving." : "Save the technical check before approving.";
  if (!creativeOk) {
    if (s.creative.stale) return "The file changed after the creative check. Check it again before approving.";
    return s.creativeRequired ? "This video needs the creative check from James or Jordan before it is approved." : "Save the creative check before approving.";
  }
  return null;
}
