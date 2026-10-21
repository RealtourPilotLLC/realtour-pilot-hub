import "server-only";
import type { Prisma } from "@prisma/client";

import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { AV_HOLD_SEC, avSyncOf, avSyncWords, type AvSync, type AvTiming } from "@/lib/mp4Probe";
import { dbx } from "@/lib/integrations/dropbox";
import { probeVideoMetadata } from "@/lib/integrations/topaz";
import { probeableUrl } from "@/lib/reviewCuts";

type Cut = NonNullable<Awaited<ReturnType<typeof loadCut>>>;

const FINAL_CUT_SELECT = {
  id: true, projectId: true, kind: true, status: true, deliverableId: true, slot: true, round: true,
  assetPath: true, finalPath: true, blobUrl: true, contentHash: true, sourceRev: true,
  sentToClientAt: true, sentToClientBy: true, decidedAt: true,
  project: { select: { aryeoListingId: true, status: true, contentMonthId: true } },
  deliverable: { select: { type: true, videoStyle: true, productTitle: true, label: true } },
  topazJob: { select: { id: true, state: true, finalPath: true, savedAt: true } },
} satisfies Prisma.ReviewSubmissionSelect;

export async function loadCut(submissionId: string, db: Prisma.TransactionClient = prisma) {
  return db.reviewSubmission.findUnique({ where: { id: submissionId }, select: FINAL_CUT_SELECT });
}

/** Same source identity as the mutation reader, one batch for a display queue. */
export async function loadCuts(submissionIds: string[], db: Prisma.TransactionClient = prisma) {
  const rows = submissionIds.length ? await db.reviewSubmission.findMany({ where: { id: { in: submissionIds } }, select: FINAL_CUT_SELECT }) : [];
  return new Map(rows.map(cut => [cut.id, cut]));
}

/** The identity of the source file Kyle is taking to Aryeo. A render that
 * lands later, or a changed path/hash, invalidates an earlier attestation. */
export function sourceFingerprint(cut: Cut): string | null {
  const job = cut.topazJob;
  if (job && !["done", "failed", "cancelled", "skipped"].includes(job.state)) return null;
  const source = job?.state === "done" && job.finalPath && job.savedAt
    ? ["topaz", job.id, job.finalPath, job.savedAt.toISOString()]
    : cut.blobUrl ? ["hub", cut.blobUrl, cut.contentHash, cut.sourceRev]
    : cut.assetPath ? ["dropbox", cut.assetPath, cut.contentHash, cut.sourceRev]
    : cut.finalPath ? ["final", cut.finalPath, cut.contentHash, cut.sourceRev] : null;
  return source ? createHash("sha256").update(JSON.stringify([cut.id, cut.round, cut.project.aryeoListingId, source])).digest("hex") : null;
}

export async function currentApproved(cut: Cut, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  if (cut.status !== "APPROVED" || ["CANCELLED", "ON_HOLD"].includes(cut.project.status)) return false;
  if (cut.deliverableId) {
    const latest = await db.reviewSubmission.findFirst({
      where: { projectId: cut.projectId, deliverableId: cut.deliverableId, slot: cut.slot,
        withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
      orderBy: [{ round: "desc" }, { createdAt: "desc" }], select: { id: true },
    });
    const output = await db.deliverableOutput.findFirst({
      where: { projectId: cut.projectId, deliverableId: cut.deliverableId, slot: cut.slot, waivedAt: null, removedFromOrderAt: null },
      select: { id: true, currentSubmissionId: true, approvedSubmissionId: true },
    });
    return latest?.id === cut.id && !!output
      && (!output.currentSubmissionId || output.currentSubmissionId === cut.id)
      && (!output.approvedSubmissionId || output.approvedSubmissionId === cut.id);
  }
  // Legacy folder cuts are keyed by file path. Do not pretend two distinct
  // paths on one job are the same video or let an older round certify a newer.
  if (!cut.assetPath) return false;
  const latest = await db.reviewSubmission.findFirst({
    where: { projectId: cut.projectId, deliverableId: null, assetPath: cut.assetPath,
      withdrawnAt: null, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
    orderBy: [{ round: "desc" }, { createdAt: "desc" }], select: { id: true },
  });
  return latest?.id === cut.id;
}

// THE MANUAL FINAL-FILE CHECK IS GONE (Jordan, Oct 21 2026). The staff
// attestation flow that lived here (listingChoices, recordListingCheck,
// manualListingCheckReady, finalChoices, finalCheckReceipt, recordFinalCheck,
// manualFinalCheckReady and the six FINAL_CHECK_KEYS) lost its last screen and
// its server actions in the Oct 20 audit, and no screen could reach it. Kyle's
// Mark as sent rests on the upload receipt (lib/deliveryUploads), the hub's
// own Aryeo send checks the listing itself (lib/videoAryeoPush), and monthly
// videos publish to the portal on the checked 1080p file (lib/monthlyFinal).
// Old FinalRenditionCheck rows stay as history; readyToSend still reads them.

// ---------------------------------------------------------------------------
// THE FINISHED FILE'S SOUND, FROM ITS HEADER (Oct 16 2026).
//
// About eighteen videos since June reached review or a client with a sound
// problem; one went out SILENT (Sep 17) and one client heard the sound "about
// half a second behind the picture after posting" (Oct 12). Both are facts the
// file's own header states exactly — is there a sound track, and where do sound
// and picture start and stop on the timeline (lib/mp4Probe, via the header read
// integrations/topaz probeVideoMetadata already makes: a few small range reads
// and the moov box, never the file).
//
// finalFileSoundCheck(submissionId) reads the SAME file the client would get
// (sourceFingerprint's order: the 1080p render once filed, else the hub's copy
// of the editor's upload, else the Dropbox original) and answers:
//   ok         has sound, and sound and picture line up within AV_HOLD_SEC;
//   hold       no sound, or more than AV_HOLD_SEC apart — with the reason in
//              plain words. Anything that sends this file to a client on its
//              own (the automatic Aryeo upload/deliver) stops here and leaves
//              it to a person, the same way a held 1080p render waits;
//   unchecked  nothing honest to say (unreadable, no file yet, a header with
//              no timing). NOT a hold: a check that couldn't run never raises
//              an alarm, and the caller decides what "unread" means for it.
// A 1080p render a PERSON already listened to and chose (resolved-processed)
// is theirs: it answers ok without re-judging what they accepted.
//
// Exported for the delivery steps to call; it changes nothing by itself.
// ---------------------------------------------------------------------------

export type FinalSoundCheck =
  | { verdict: "ok"; message: string; av: AvSync | null }
  | { verdict: "hold"; message: string; reason: string; av: AvSync | null }
  | { verdict: "unchecked"; message: string };

/** What a header read hands the judge (VideoMeta's audio + timing). */
export type FinalSoundFacts = { audio: { present: boolean; codec: string | null }; timing?: AvTiming | null } | null;

/** The rule, pure: the header's facts → ok / hold / unchecked. */
export function judgeFinalSound(facts: FinalSoundFacts): FinalSoundCheck {
  if (!facts) return { verdict: "unchecked", message: "The finished file's header couldn't be read, so its sound wasn't checked." };
  if (!facts.audio.present) {
    const reason = "this video has no sound";
    return { verdict: "hold", reason, av: null, message: `Held: ${reason}. Ask the editor for a new export with the sound on before it goes to the client.` };
  }
  const av = avSyncOf(facts.timing);
  if (!av) return { verdict: "unchecked", message: "The finished file has sound; where it sits against the picture couldn't be read." };
  if (!av.hasAudio) {
    const reason = "this video's sound track is empty";
    return { verdict: "hold", reason, av, message: `Held: ${reason}. Ask the editor for a new export with the sound on before it goes to the client.` };
  }
  const words = avSyncWords(av, AV_HOLD_SEC);
  if (words) {
    return { verdict: "hold", reason: words, av, message: `Held: ${words}. Ask the editor for a new export before it goes to the client.` };
  }
  return { verdict: "ok", av, message: "The finished file has sound, and it lines up with the picture." };
}

type HeaderProbe = (url: string, knownSize?: number | null) => Promise<FinalSoundFacts>;

/** The finished file's sound — see the block above. `probe` is the header
 *  reader (probeVideoMetadata by default); drills pass their own. */
export async function finalFileSoundCheck(submissionId: string, opts: { probe?: HeaderProbe } = {}): Promise<FinalSoundCheck> {
  const unchecked = (message: string): FinalSoundCheck => ({ verdict: "unchecked", message });
  try {
    const cut = await loadCut(submissionId);
    if (!cut) return unchecked("That cut no longer exists.");
    const job = cut.topazJob;
    if (job && !["done", "failed", "cancelled", "skipped"].includes(job.state)) return unchecked("The 1080p pass hasn't finished, so there is no final file to check yet.");
    const processed = job?.state === "done" && !!job.finalPath && !!job.savedAt;
    if (processed) {
      const row = await prisma.topazJob.findUnique({ where: { id: job!.id }, select: { outputCheck: true, resolvedBy: true } });
      if (row?.outputCheck === "resolved-processed") {
        return { verdict: "ok", av: null, message: `${row.resolvedBy ?? "A reviewer"} listened to this 1080p file and chose it.` };
      }
    }
    let url: string | null = null;
    if (processed) url = await dropboxLink(job!.finalPath!);
    else if (cut.blobUrl) url = await probeableUrl(cut.blobUrl).catch(() => null);
    else if (cut.assetPath ?? cut.finalPath) url = await dropboxLink((cut.assetPath ?? cut.finalPath)!);
    if (!url) return unchecked("The finished file couldn't be opened, so its sound wasn't checked.");
    const probe: HeaderProbe = opts.probe ?? probeVideoMetadata;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const facts = await Promise.race([
      probe(url, null).catch(() => null),
      new Promise<null>((r) => { timer = setTimeout(() => r(null), 30_000); }),
    ]);
    if (timer) clearTimeout(timer);
    return judgeFinalSound(facts);
  } catch {
    return unchecked("The finished file's sound couldn't be checked just now.");
  }
}

async function dropboxLink(path: string): Promise<string | null> {
  return dbx<{ link?: string }>("files/get_temporary_link", { path }).then((r) => r.link ?? null).catch(() => null);
}
