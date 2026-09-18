import "server-only";

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, recordAutomationRun, getAutomation } from "@/lib/programAutomation";
// The provider fetches the audio itself, so it needs a URL that carries its own
// permission — never the store's read-write token (RTP-01).
import { fetchableCutUrl } from "@/lib/reviewCuts";
import {
  activeTranscriptionProvider,
  transcriptionStatus,
  TranscriptionError,
  type TranscriptionProvider,
} from "@/lib/integrations/transcription";

// ---------------------------------------------------------------------------
// Cut transcripts (spec §9, §10) — Sep 16 2026.
//
// "Generate a transcript from the actual cut and store it against that
// version, with human correction support. Changing the cut invalidates
// readiness of transcript-derived drafts until they are checked or
// regenerated." And the acceptance line that shapes every function here:
// "transcripts from different cuts cannot be confused."
//
// The cut version IS the ReviewSubmission row (round N of deliverable × slot).
// A ContentCutTranscript row is one transcription of one such cut;
// `version` counts re-runs against the SAME cut (unique [submissionId,
// version]), and `contentHash` pins which bytes were transcribed.
//
// Tonight nothing can transcribe: there is no speech-to-text key (see
// integrations/transcription.ts) and the cut_transcripts switch has no row
// (missing = OFF). So requestCutTranscript() writes a row that SAYS so —
// BLOCKED_NO_PROVIDER — instead of pretending to queue work, and the driver
// returns without touching a row unless the switch is on AND a provider is
// configured. That is the whole point: a request made today is not lost, and
// nothing can run by accident.
//
// Status values (String column; the schema comment lists the first six, the
// two BLOCKED_* values are added here so the monitoring screen can say WHY
// nothing is happening instead of showing a QUEUED row that never moves):
//   BLOCKED_NO_PROVIDER    no speech-to-text key exists — the request waits
//   BLOCKED_AUTOMATION_OFF a key exists but the cut_transcripts switch is off
//   QUEUED → RUNNING → SUCCEEDED | FAILED | NEEDS_REVIEW | CANCELLED
// ---------------------------------------------------------------------------

export const CUT_TRANSCRIPT_STATUS = {
  BLOCKED_NO_PROVIDER: "BLOCKED_NO_PROVIDER",
  BLOCKED_AUTOMATION_OFF: "BLOCKED_AUTOMATION_OFF",
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  CANCELLED: "CANCELLED",
} as const;
export type CutTranscriptStatus = (typeof CUT_TRANSCRIPT_STATUS)[keyof typeof CUT_TRANSCRIPT_STATUS];

const BLOCKED = [CUT_TRANSCRIPT_STATUS.BLOCKED_NO_PROVIDER, CUT_TRANSCRIPT_STATUS.BLOCKED_AUTOMATION_OFF];
const LIVE = [...BLOCKED, CUT_TRANSCRIPT_STATUS.QUEUED, CUT_TRANSCRIPT_STATUS.RUNNING];

const MAX_ATTEMPTS = 5;
const LEASE_MS = 10 * 60 * 1000;

type CutRow = {
  id: string;
  projectId: string;
  round: number;
  status: string;
  contentHash: string | null;
  videoId: string | null;
  blobUrl: string | null;
  blobPathname: string | null;
  sizeBytes: number | null;
  fileName: string | null;
  deliverableId: string | null;
  slot: number;
};

const CUT_SELECT = {
  id: true, projectId: true, round: true, status: true, contentHash: true, videoId: true,
  blobUrl: true, blobPathname: true, sizeBytes: true, fileName: true, deliverableId: true, slot: true,
} as const;

/**
 * What identifies THESE bytes. ReviewSubmission.contentHash (sha256 of the
 * stored file, spec §8) is the real answer, but no code writes it yet (Sep 16:
 * every row is null). Until that writer lands, fall back to a hash of the
 * things that change when a different file is put behind the same row — the
 * blob pathname, its size and name — so "the cut changed under it" is still
 * detectable, if less precisely. Prefixed so a reader can tell which kind it is.
 */
export function cutIdentityHash(cut: Pick<CutRow, "id" | "contentHash" | "blobUrl" | "blobPathname" | "sizeBytes" | "fileName">): string {
  if (cut.contentHash) return cut.contentHash;
  const h = createHash("sha256")
    .update(["ident", cut.id, cut.blobPathname ?? "", cut.blobUrl ?? "", String(cut.sizeBytes ?? ""), cut.fileName ?? ""].join("\n"))
    .digest("hex");
  return `ident:${h}`;
}

async function loadCut(submissionId: string): Promise<CutRow | null> {
  return prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: CUT_SELECT });
}

// The video a cut belongs to: the CPOS column on the submission first, then the
// ContentVideo whose pointers name this submission. Null is fine — a listing
// cut that was never mapped into the program has no video, and still may want
// a transcript one day.
async function videoIdForCut(cut: CutRow): Promise<string | null> {
  if (cut.videoId) return cut.videoId;
  const v = await prisma.contentVideo.findFirst({
    where: { OR: [{ currentSubmissionId: cut.id }, { approvedSubmissionId: cut.id }, { finalSubmissionId: cut.id }] },
    select: { id: true },
  });
  return v?.id ?? null;
}

export type RequestCutTranscriptResult = {
  id: string;
  submissionId: string;
  version: number;
  status: string;
  provider: string | null;
  /** Plain words for the person who pressed the button. */
  says: string;
  /** true when an existing live row was returned instead of a new one. */
  reused: boolean;
};

/**
 * Ask for a transcript of one cut. Idempotent: a live row (blocked, queued,
 * running) for the same bytes is returned rather than duplicated; a SUCCEEDED
 * row for the same bytes is returned too unless `regenerate` is set, in which
 * case a new version row is created (spec §9: a regenerate is a new row —
 * never an overwrite, so a human correction on the old one survives).
 *
 * The status the new row gets is the truth about tonight:
 *   no provider key           → BLOCKED_NO_PROVIDER
 *   key, switch off (or none) → BLOCKED_AUTOMATION_OFF
 *   key + switch on           → QUEUED (the driver picks it up)
 */
export async function requestCutTranscript(
  submissionId: string,
  by: string | null,
  opts: { regenerate?: boolean } = {},
): Promise<RequestCutTranscriptResult> {
  const cut = await loadCut(submissionId);
  if (!cut) throw new Error("That cut no longer exists.");
  const hash = cutIdentityHash(cut);

  const rows = await prisma.contentCutTranscript.findMany({
    where: { submissionId },
    orderBy: { version: "desc" },
    select: { id: true, version: true, status: true, contentHash: true, provider: true, invalidatedAt: true },
  });
  const sameBytes = rows.filter((r) => r.contentHash === hash && !r.invalidatedAt);
  const live = sameBytes.find((r) => (LIVE as string[]).includes(r.status));
  if (live) {
    return { id: live.id, submissionId, version: live.version, status: live.status, provider: live.provider, reused: true, says: saysFor(live.status, live.provider) };
  }
  const done = sameBytes.find((r) => r.status === CUT_TRANSCRIPT_STATUS.SUCCEEDED);
  if (done && !opts.regenerate) {
    return { id: done.id, submissionId, version: done.version, status: done.status, provider: done.provider, reused: true, says: "A transcript of this exact cut already exists." };
  }

  // Rows for OTHER bytes of this same submission are, by definition, of a cut
  // that has since changed — mark them so no reader serves them as current.
  await invalidateTranscriptsForCut(submissionId, "cut changed", hash);

  const provider = await activeTranscriptionProvider();
  const enabled = provider ? await isAutomationEnabled("cut_transcripts") : false;
  const status = !provider
    ? CUT_TRANSCRIPT_STATUS.BLOCKED_NO_PROVIDER
    : enabled
      ? CUT_TRANSCRIPT_STATUS.QUEUED
      : CUT_TRANSCRIPT_STATUS.BLOCKED_AUTOMATION_OFF;
  const version = (rows[0]?.version ?? 0) + 1;
  const now = new Date();
  const row = await prisma.contentCutTranscript.create({
    data: {
      submissionId,
      videoId: await videoIdForCut(cut),
      projectId: cut.projectId,
      version,
      sourceRound: cut.round,
      contentHash: hash,
      provider: provider?.id ?? null,
      status,
      nextAttemptAt: status === CUT_TRANSCRIPT_STATUS.QUEUED ? now : null,
      // The block reason rides in lastError so the monitoring screen can show
      // it in the same column as a real failure. Not an error, but the only
      // free-text column the row has, and it is cleared the moment a run starts.
      lastError: status === CUT_TRANSCRIPT_STATUS.QUEUED ? null : `${saysFor(status, provider?.id ?? null)}${by ? ` (requested by ${by})` : ""}`,
      lastErrorAt: status === CUT_TRANSCRIPT_STATUS.QUEUED ? null : now,
    },
    select: { id: true, version: true, status: true, provider: true },
  });
  return { id: row.id, submissionId, version: row.version, status: row.status, provider: row.provider, reused: false, says: saysFor(row.status, row.provider) };
}

function saysFor(status: string, provider: string | null): string {
  switch (status) {
    case CUT_TRANSCRIPT_STATUS.BLOCKED_NO_PROVIDER:
      return "Waiting: no speech-to-text service is connected. Add an OpenAI Whisper or Deepgram key on Connections and this request will run once cut transcripts are switched on.";
    case CUT_TRANSCRIPT_STATUS.BLOCKED_AUTOMATION_OFF:
      return `Waiting: ${provider ?? "a provider"} is connected but cut transcripts are switched off. Nothing runs until the switch is on.`;
    case CUT_TRANSCRIPT_STATUS.QUEUED:
      return "Queued — the next transcript run will pick it up.";
    case CUT_TRANSCRIPT_STATUS.RUNNING:
      return "Transcribing now.";
    case CUT_TRANSCRIPT_STATUS.SUCCEEDED:
      return "Transcript ready.";
    case CUT_TRANSCRIPT_STATUS.NEEDS_REVIEW:
      return "Needs a person: the provider could not use this file as it is.";
    case CUT_TRANSCRIPT_STATUS.FAILED:
      return "Failed — see the error on the row.";
    default:
      return status;
  }
}

/**
 * The cut changed under its transcripts (a new file behind the row, or a new
 * round replacing this one). Marks every transcript of this submission whose
 * bytes are not `keepHash` as invalidated, and every caption draft built on
 * them STALE — spec §9/§10: readiness is lost until someone checks or
 * regenerates. Rows are never deleted; a corrected transcript of an old cut is
 * still history.
 */
export async function invalidateTranscriptsForCut(submissionId: string, reason: string, keepHash?: string | null): Promise<number> {
  const now = new Date();
  const stale = await prisma.contentCutTranscript.findMany({
    where: { submissionId, invalidatedAt: null, ...(keepHash ? { NOT: { contentHash: keepHash } } : {}) },
    select: { id: true, status: true },
  });
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.id);
  await prisma.contentCutTranscript.updateMany({
    where: { id: { in: ids } },
    data: { invalidatedAt: now, lastError: `Invalidated: ${reason}`, lastErrorAt: now },
  });
  // Anything still waiting to run is pointless now — cancel rather than let
  // the driver transcribe bytes nobody will use.
  await prisma.contentCutTranscript.updateMany({
    where: { id: { in: ids }, status: { in: LIVE as string[] } },
    data: { status: CUT_TRANSCRIPT_STATUS.CANCELLED, leaseUntil: null, leaseBy: null, nextAttemptAt: null },
  });
  await prisma.contentCaptionDraft.updateMany({
    where: { transcriptId: { in: ids }, status: { in: ["DRAFT", "CHOSEN"] } },
    data: { status: "STALE", staleReason: `cut changed (${reason})` },
  });
  return ids.length;
}

/**
 * A new round of a cut replaces the previous round of the SAME deliverable ×
 * slot (Sep 1 upload flow). Every transcript of the earlier rounds is of a cut
 * that is no longer current. Call this from wherever a round is created; it is
 * safe to call repeatedly.
 */
export async function invalidateTranscriptsForSupersededRounds(newSubmissionId: string): Promise<number> {
  const cut = await loadCut(newSubmissionId);
  if (!cut || !cut.deliverableId) return 0;
  const older = await prisma.reviewSubmission.findMany({
    where: { projectId: cut.projectId, deliverableId: cut.deliverableId, slot: cut.slot, round: { lt: cut.round } },
    select: { id: true, round: true },
  });
  let n = 0;
  for (const o of older) n += await invalidateTranscriptsForCut(o.id, `round ${cut.round} replaced round ${o.round}`);
  return n;
}

/**
 * Human correction (spec §9). Kept BESIDE the machine text, never over it:
 * the planned script, what the machine heard and what a person says was said
 * stay three distinguishable things.
 */
export async function correctCutTranscript(
  transcriptId: string,
  input: { correctedText: string; by: string; note?: string | null },
): Promise<void> {
  const text = input.correctedText.trim();
  if (!text) throw new Error("A correction can't be empty — to drop a correction, restore the machine text instead.");
  const row = await prisma.contentCutTranscript.findUnique({ where: { id: transcriptId }, select: { id: true, status: true, text: true } });
  if (!row) throw new Error("That transcript no longer exists.");
  if (row.status !== CUT_TRANSCRIPT_STATUS.SUCCEEDED && !row.text) {
    throw new Error("There is no machine transcript to correct yet.");
  }
  await prisma.contentCutTranscript.update({
    where: { id: transcriptId },
    data: { correctedText: text, correctedBy: input.by, correctedAt: new Date(), correctionNote: input.note ?? null },
  });
}

/** Undo a correction: the machine text is current again. The row keeps its history through updatedAt only. */
export async function clearCutTranscriptCorrection(transcriptId: string): Promise<void> {
  await prisma.contentCutTranscript.update({
    where: { id: transcriptId },
    data: { correctedText: null, correctedBy: null, correctedAt: null, correctionNote: null },
  });
}

export type TranscriptForCut = {
  text: string | null;
  /** "corrected" wins over "provider"; null when there is nothing usable. */
  source: "provider" | "corrected" | null;
  /** When text is null (or stale), the one sentence a caption assistant should show instead of inventing. */
  gap: string | null;
  transcriptId: string | null;
  /** The bytes this transcript is of, so a caller can pin what it built on. */
  contentHash: string | null;
  language: string | null;
};

/**
 * What §10's caption assistant reads. The rule it encodes: the transcript must
 * be OF THE CURRENT BYTES of this cut, or it is a gap — the script must not
 * make the caption claim something the final video no longer supports, and a
 * transcript of the previous cut is exactly that hazard.
 */
export async function transcriptForCut(submissionId: string): Promise<TranscriptForCut> {
  const none = (gap: string): TranscriptForCut => ({ text: null, source: null, gap, transcriptId: null, contentHash: null, language: null });
  const cut = await loadCut(submissionId);
  if (!cut) return none("This cut no longer exists.");
  const hash = cutIdentityHash(cut);
  const rows = await prisma.contentCutTranscript.findMany({
    where: { submissionId, invalidatedAt: null },
    orderBy: { version: "desc" },
    select: { id: true, status: true, contentHash: true, text: true, correctedText: true, language: true, provider: true, lastError: true },
  });
  const current = rows.filter((r) => r.contentHash === hash);
  const usable = current.find((r) => r.status === CUT_TRANSCRIPT_STATUS.SUCCEEDED && (r.correctedText || r.text));
  if (usable) {
    const corrected = Boolean(usable.correctedText);
    return {
      text: corrected ? usable.correctedText! : usable.text!,
      source: corrected ? "corrected" : "provider",
      gap: null,
      transcriptId: usable.id,
      contentHash: usable.contentHash,
      language: usable.language,
    };
  }
  const staleDone = rows.find((r) => r.status === CUT_TRANSCRIPT_STATUS.SUCCEEDED && r.contentHash !== hash);
  if (staleDone) return none("The cut changed after it was transcribed — regenerate the transcript before using it.");
  const pending = current.find((r) => (LIVE as string[]).includes(r.status));
  if (pending) return none(`No transcript yet — ${saysFor(pending.status, pending.provider)}`);
  const failed = current.find((r) => r.status === CUT_TRANSCRIPT_STATUS.FAILED || r.status === CUT_TRANSCRIPT_STATUS.NEEDS_REVIEW);
  if (failed) return none(`No transcript — the last attempt failed${failed.lastError ? `: ${failed.lastError}` : "."}`);
  return none("No transcript of this cut has been requested.");
}

// ---------------------------------------------------------------------------
// THE DRIVER. A cron may call this later. It does NOTHING unless the
// cut_transcripts switch is on (missing row = off) AND a provider is
// configured — and it says which one stopped it, so a monitoring screen can
// show "skipped: automation off" rather than a run that silently did zero.
// ---------------------------------------------------------------------------

export type CutTranscriptDriverResult = {
  skipped: "automation_off" | "no_provider" | null;
  provider: string | null;
  promoted: number;
  claimed: number;
  succeeded: number;
  failed: number;
  retried: number;
  invalidated: number;
};

export async function runCutTranscriptDriver(opts: { limit?: number; leaseBy?: string } = {}): Promise<CutTranscriptDriverResult> {
  const result: CutTranscriptDriverResult = { skipped: null, provider: null, promoted: 0, claimed: 0, succeeded: 0, failed: 0, retried: 0, invalidated: 0 };
  if (!(await isAutomationEnabled("cut_transcripts"))) return { ...result, skipped: "automation_off" };
  const provider = await activeTranscriptionProvider();
  if (!provider) return { ...result, skipped: "no_provider" };
  result.provider = provider.id;

  const now = new Date();
  // Requests made while nothing could run are real requests. With the switch on
  // and a key in hand they become queued work — attempts untouched.
  const promoted = await prisma.contentCutTranscript.updateMany({
    where: { status: { in: BLOCKED as string[] }, invalidatedAt: null },
    data: { status: CUT_TRANSCRIPT_STATUS.QUEUED, provider: provider.id, nextAttemptAt: now, lastError: null, lastErrorAt: null },
  });
  result.promoted = promoted.count;

  const candidates = await prisma.contentCutTranscript.findMany({
    where: {
      status: CUT_TRANSCRIPT_STATUS.QUEUED,
      invalidatedAt: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, Math.min(opts.limit ?? 5, 20)),
    select: { id: true },
  });
  const leaseBy = opts.leaseBy ?? `cutTranscripts:${process.pid}`;
  let lastError: string | null = null;

  for (const c of candidates) {
    // Atomic claim: only the row that is STILL queued and unleased moves to
    // RUNNING, so two overlapping runs cannot transcribe the same cut twice.
    const claim = await prisma.contentCutTranscript.updateMany({
      where: {
        id: c.id,
        status: CUT_TRANSCRIPT_STATUS.QUEUED,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: {
        status: CUT_TRANSCRIPT_STATUS.RUNNING,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        leaseBy,
        startedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
        lastErrorAt: null,
      },
    });
    if (claim.count !== 1) continue;
    result.claimed++;
    const outcome = await transcribeOne(c.id, provider);
    if (outcome === "succeeded") result.succeeded++;
    else if (outcome === "retried") result.retried++;
    else if (outcome === "invalidated") result.invalidated++;
    else {
      result.failed++;
      lastError = outcome;
    }
  }
  await recordAutomationRun("cut_transcripts", lastError);
  return result;
}

async function transcribeOne(id: string, provider: TranscriptionProvider): Promise<"succeeded" | "retried" | "invalidated" | string> {
  const row = await prisma.contentCutTranscript.findUnique({
    where: { id },
    select: { id: true, submissionId: true, contentHash: true, attempts: true },
  });
  if (!row) return "row vanished";
  const cut = await loadCut(row.submissionId);
  const release = { leaseUntil: null, leaseBy: null };

  // The bytes must still be the bytes this row was made for. If the cut moved
  // on, this row is history, not work.
  if (!cut || cutIdentityHash(cut) !== row.contentHash) {
    await prisma.contentCutTranscript.update({
      where: { id },
      data: { ...release, status: CUT_TRANSCRIPT_STATUS.CANCELLED, invalidatedAt: new Date(), lastError: "Invalidated: the cut changed before transcription ran", lastErrorAt: new Date() },
    });
    return "invalidated";
  }
  // Only the hub's own store is reachable by a provider: /api/review/cut/…/stream
  // needs a signed-in staff session, which Deepgram does not have.
  if (!cut.blobUrl) {
    await prisma.contentCutTranscript.update({
      where: { id },
      data: { ...release, status: CUT_TRANSCRIPT_STATUS.NEEDS_REVIEW, lastError: "This cut has no hosted file in the hub's store (folder-discovered cuts play from Dropbox). Upload it through the Review Room to transcribe it.", lastErrorAt: new Date(), finishedAt: new Date() },
    });
    return "no hosted file";
  }

  // THE PROVIDER'S SERVERS FETCH THIS URL (RTP-01, handover §2). Same shape
  // as Meta's container fetch: a speech-to-text provider pulls the file from
  // its own network with no credential of ours, so on a private store the
  // object's own address answers 401 and every transcript fails with somebody
  // else's error message.
  //
  // The handoff is a presigned GET scoped to this one pathname, for two hours —
  // long enough for a queued job to be picked up and a long cut to be pulled,
  // short enough that a link in a provider's logs stops working the same
  // morning. NOT a proxy route: that would have to be reachable without our
  // session to be any use to them.
  //
  // Nothing here turns transcription on. There is still no speech-to-text key
  // and the `cut_transcripts` switch has no row, so this code is not reached
  // today; it is written now so the day it IS configured is not the day this is
  // discovered.
  const source = await fetchableCutUrl(cut, { ttlMs: 2 * 3600_000, purpose: "transcription" });
  if (!source.ok) {
    await prisma.contentCutTranscript.update({
      where: { id },
      data: { ...release, status: CUT_TRANSCRIPT_STATUS.NEEDS_REVIEW, lastError: `The hub could not give the transcription provider a link to this cut's file — ${source.message}`, lastErrorAt: new Date(), finishedAt: new Date() },
    });
    return "no readable file";
  }
  try {
    const r = await provider.transcribe({ url: source.url, submissionId: cut.id });
    const text = r.text.trim();
    await prisma.contentCutTranscript.update({
      where: { id },
      data: {
        ...release,
        status: text ? CUT_TRANSCRIPT_STATUS.SUCCEEDED : CUT_TRANSCRIPT_STATUS.NEEDS_REVIEW,
        provider: provider.id,
        text,
        segmentsJson: r.segments ? JSON.stringify(r.segments) : null,
        wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
        durationSec: r.durationSec ?? null,
        language: r.language ?? null,
        finishedAt: new Date(),
        nextAttemptAt: null,
        lastError: text ? null : "The provider returned no speech — check the cut has an audio track.",
        lastErrorAt: text ? null : new Date(),
      },
    });
    return "succeeded";
  } catch (e) {
    const err = e instanceof TranscriptionError ? e : new TranscriptionError(e instanceof Error ? e.message : String(e), "provider_error", false);
    const attempts = row.attempts + 1;
    const now = new Date();
    if (err.retryable && attempts < MAX_ATTEMPTS) {
      // Exponential backoff, capped at an hour: 2, 4, 8, 16 minutes.
      const delayMs = Math.min(60, 2 ** attempts) * 60 * 1000;
      await prisma.contentCutTranscript.update({
        where: { id },
        data: { ...release, status: CUT_TRANSCRIPT_STATUS.QUEUED, nextAttemptAt: new Date(now.getTime() + delayMs), lastError: err.message, lastErrorAt: now },
      });
      return "retried";
    }
    const status = err.kind === "too_large" || err.kind === "unreachable_media" || err.kind === "not_configured"
      ? CUT_TRANSCRIPT_STATUS.NEEDS_REVIEW
      : CUT_TRANSCRIPT_STATUS.FAILED;
    await prisma.contentCutTranscript.update({
      where: { id },
      data: { ...release, status, nextAttemptAt: null, finishedAt: now, lastError: err.message, lastErrorAt: now },
    });
    return err.message;
  }
}

/** Rows for a monitoring screen (no text bodies). */
export async function cutTranscriptRows(opts: { limit?: number } = {}) {
  return prisma.contentCutTranscript.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 20, 100),
    select: {
      id: true, submissionId: true, videoId: true, projectId: true, version: true, status: true, provider: true,
      attempts: true, nextAttemptAt: true, lastError: true, lastErrorAt: true, wordCount: true, durationSec: true,
      correctedAt: true, invalidatedAt: true, createdAt: true, finishedAt: true,
    },
  });
}

// ---- the Connections card --------------------------------------------------------

export type TranscriptionCardData = {
  providers: Awaited<ReturnType<typeof transcriptionStatus>>;
  activeProviderId: string | null;
  automation: { enabled: boolean; missing: boolean };
  waiting: number;
};

/** Everything TranscriptionCard shows: per-provider key state, the switch, and how many requests are parked. */
export async function transcriptionCardData(): Promise<TranscriptionCardData> {
  const [providers, active, auto, waiting] = await Promise.all([
    transcriptionStatus(),
    activeTranscriptionProvider(),
    getAutomation("cut_transcripts"),
    prisma.contentCutTranscript.count({ where: { status: { in: BLOCKED as string[] }, invalidatedAt: null } }).catch(() => 0),
  ]);
  return { providers, activeProviderId: active?.id ?? null, automation: { enabled: auto.enabled, missing: auto.missing }, waiting };
}
