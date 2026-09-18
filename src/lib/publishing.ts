import "server-only";

import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, recordAutomationRun, getAutomation } from "@/lib/programAutomation";
import { appBase } from "@/lib/appUrl";
import { encryptSecret, decryptSecret } from "@/lib/integrations/crypto";
import * as ig from "@/lib/integrations/instagram";
import { cutIdentityHash } from "@/lib/cutTranscripts";
// META fetches the file itself, so it needs a URL that carries its own
// permission — never the store's read-write token (RTP-01).
import { fetchableCutUrl } from "@/lib/reviewCuts";

// ---------------------------------------------------------------------------
// Publishing jobs (spec §12) — Sep 16 2026.
//
// One ProgramPublishingJob = one explicit decision to put ONE approved cut with
// ONE caption on ONE connected account. The rules this file exists to keep:
//
//   · createPublishingJob REFUSES unless the account is CONNECTED (with a token
//     that still decrypts), the Meta adapter is configured, AND the
//     `publishing` switch is on (missing row = off). Tonight all three are
//     false, so it refuses — and says which one stopped it.
//   · Retries never duplicate a post. Three layers: the dedupeKey is UNIQUE in
//     Postgres (account : cut : bytes : caption); the container id is written
//     to the row BEFORE publish is called; and a publish that timed out puts
//     the job in RECONCILE, where the container's status is read before
//     anything is retried — a PUBLISHED container is never published again,
//     even if the media id has to be found by hand (resolvePublishingJobByHand);
//     an open job with nextAttemptAt = null is parked for a person and is
//     never claimed by the driver.
//   · Success means confirmed receipt: SUCCEEDED requires providerMediaId.
//   · Disconnecting an account cancels every job of it that has not published.
//   · A new cut version or a caption change after approval invalidates the
//     job: the row records the cut bytes and caption hash it was approved
//     against, the driver re-checks both right before it talks to Meta, and
//     the two invalidate* helpers do the same from the write side.
//
// State machine (String column): QUEUED → RUNNING → AWAITING_PROVIDER (a
// container exists, Instagram is processing the video) → SUCCEEDED | FAILED,
// with RECONCILE (a publish call timed out: read before retry), CANCELLED
// (account disconnected / staff cancelled) and INVALIDATED (cut or caption
// changed after approval — needs a renewed decision, i.e. a NEW job).
// DRAFT and APPROVED exist in the schema for a client-side "review before
// queue" step the portal may add; this file creates jobs already approved.
// ---------------------------------------------------------------------------

export const JOB_STATE = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  AWAITING_PROVIDER: "AWAITING_PROVIDER",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
  RECONCILE: "RECONCILE",
  INVALIDATED: "INVALIDATED",
} as const;

/** States in which a job has NOT published and can still be stopped. */
const STOPPABLE = [JOB_STATE.QUEUED, JOB_STATE.AWAITING_PROVIDER, JOB_STATE.RECONCILE];
const OPEN = [JOB_STATE.QUEUED, JOB_STATE.RUNNING, JOB_STATE.AWAITING_PROVIDER, JOB_STATE.RECONCILE];

/** Claims allowed while there is NO container yet (creating one, or transient errors before it exists). */
const MAX_ATTEMPTS = 6;
/**
 * Claims allowed once a container EXISTS. Each of these is one cheap Graph
 * read (the status poll every minute while Instagram processes the video, or
 * a transient error on that read), so the budget is larger — but it is a
 * budget: Meta keeps a container for 24 h, and a job must not poll for a day.
 * 30 polls at one minute is ~30 min, well past a normal Reel's processing.
 */
const MAX_CONTAINER_ATTEMPTS = 30;
const LEASE_MS = 5 * 60 * 1000;
const MAX_REEL_BYTES = 1024 * 1024 * 1024; // 1 GB, Meta's documented Reels ceiling

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Exponential backoff in minutes, capped at an hour so a high attempt count never means "next year". */
export function backoffMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(0, attempts), 60);
}

/**
 * When a FAILED / CANCELLED / INVALIDATED job is re-opened by a renewed
 * decision, should its recorded container be dropped? Keeping the id is the
 * right default — a cancelled RECONCILE row may hold a PUBLISHED container
 * that must be READ, never re-made. But a container Instagram reported as
 * ERROR or EXPIRED is dead: reading it again fails the same way forever, and
 * the only way forward for the same bytes + caption is a fresh container.
 * providerResponseJson is where the driver records that terminal status.
 */
export function shouldDropContainerOnReopen(providerContainerId: string | null, providerResponseJson: string | null): boolean {
  if (!providerContainerId || !providerResponseJson) return false;
  try {
    const v = JSON.parse(providerResponseJson) as { container?: unknown; status?: { status?: unknown } };
    const terminal = v.status?.status === "ERROR" || v.status?.status === "EXPIRED";
    return terminal && (v.container == null || v.container === providerContainerId);
  } catch {
    return false;
  }
}

/** What the job was approved against. Stored in mediaValidationJson beside the media checks. */
type ApprovalSnapshot = {
  cutHash: string;
  captionHash: string;
  captionDraftId: string | null;
  media: { blobUrl: string | null; sizeBytes: number | null; width: number | null; height: number | null; checks: string[]; warnings: string[] };
};

function parseSnapshot(json: string | null): ApprovalSnapshot | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as ApprovalSnapshot;
    return v && typeof v.cutHash === "string" && typeof v.captionHash === "string" ? v : null;
  } catch {
    return null;
  }
}

// ---- accounts ----------------------------------------------------------------

export type Refusal = { ok: false; reason: string; message: string };

/**
 * Store what an OAuth round trip produced. One row per Instagram professional
 * account the login can publish to, all under the enrollment the staff member
 * chose before the redirect. The user token is encrypted at rest with the same
 * key material as every other integration secret.
 */
export async function connectPublishingAccounts(input: {
  enrollmentId: string;
  token: ig.IgToken;
  accounts: ig.IgAccount[];
  by: { staffUserId?: string | null; clientUserId?: string | null };
}): Promise<{ ok: true; accountIds: string[] } | Refusal> {
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { id: true, clientId: true, timezone: true } });
  if (!enrollment) return { ok: false, reason: "no_enrollment", message: "That program enrollment no longer exists." };
  if (input.accounts.length === 0) {
    return { ok: false, reason: "no_ig_account", message: "That Facebook login has no Instagram Business or Creator account linked to any of its Pages — nothing to connect." };
  }
  const ids: string[] = [];
  for (const a of input.accounts) {
    const row = await prisma.programPublishingAccount.upsert({
      where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: a.igUserId } },
      create: {
        enrollmentId: enrollment.id,
        clientId: enrollment.clientId,
        provider: "INSTAGRAM",
        providerAccountId: a.igUserId,
        handle: a.username,
        displayName: a.name ?? a.pageName,
        accountType: "business",
        credentialEncrypted: encryptSecret(JSON.stringify({ accessToken: input.token.accessToken, pageId: a.pageId })),
        scopesJson: JSON.stringify(ig.META_SCOPES),
        tokenExpiresAt: input.token.expiresAt,
        timezone: enrollment.timezone ?? "America/New_York",
        status: "CONNECTED",
        connectedAt: new Date(),
        connectedByStaffUserId: input.by.staffUserId ?? null,
        connectedByClientUserId: input.by.clientUserId ?? null,
        lastValidatedAt: new Date(),
      },
      update: {
        // A reconnect of an account that was disconnected or expired: same row,
        // fresh token, history columns untouched except the new connect stamp.
        enrollmentId: enrollment.id,
        clientId: enrollment.clientId,
        handle: a.username,
        displayName: a.name ?? a.pageName,
        credentialEncrypted: encryptSecret(JSON.stringify({ accessToken: input.token.accessToken, pageId: a.pageId })),
        scopesJson: JSON.stringify(ig.META_SCOPES),
        tokenExpiresAt: input.token.expiresAt,
        status: "CONNECTED",
        connectedAt: new Date(),
        connectedByStaffUserId: input.by.staffUserId ?? null,
        connectedByClientUserId: input.by.clientUserId ?? null,
        disconnectedAt: null,
        disconnectedBy: null,
        revokedAt: null,
        lastValidatedAt: new Date(),
        lastError: null,
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return { ok: true, accountIds: ids };
}

type AccountCredential = { accessToken: string; pageId: string | null };

async function accountCredential(accountId: string): Promise<{ account: { id: string; providerAccountId: string; status: string; enrollmentId: string; clientId: string; timezone: string | null; tokenExpiresAt: Date | null }; cred: AccountCredential | null } | null> {
  const account = await prisma.programPublishingAccount.findUnique({
    where: { id: accountId },
    select: { id: true, providerAccountId: true, status: true, enrollmentId: true, clientId: true, timezone: true, tokenExpiresAt: true, credentialEncrypted: true },
  });
  if (!account) return null;
  let cred: AccountCredential | null = null;
  if (account.credentialEncrypted) {
    try {
      const v = JSON.parse(decryptSecret(account.credentialEncrypted)) as Partial<AccountCredential>;
      if (typeof v.accessToken === "string" && v.accessToken) cred = { accessToken: v.accessToken, pageId: typeof v.pageId === "string" ? v.pageId : null };
    } catch {
      cred = null; // undecryptable = not connected, the same rule the Connections page uses
    }
  }
  const { credentialEncrypted: _drop, ...rest } = account;
  void _drop;
  return { account: rest, cred };
}

/** Is this account usable right now? CONNECTED, token decrypts, not expired. */
export async function accountConnected(accountId: string): Promise<boolean> {
  const r = await accountCredential(accountId);
  if (!r || !r.cred || r.account.status !== "CONNECTED") return false;
  if (r.account.tokenExpiresAt && r.account.tokenExpiresAt.getTime() < Date.now()) return false;
  return true;
}

/**
 * Disconnect (spec §12): the stored token is dropped, every job that has not
 * published is CANCELLED, and the grant is revoked at Meta when asked (best
 * effort — a revoke that fails still leaves the account disconnected here,
 * which is the half that stops queued posts).
 */
export async function disconnectPublishingAccount(accountId: string, by: string | null, opts: { revoke?: boolean } = {}): Promise<{ cancelled: number; revoked: boolean | null }> {
  const r = await accountCredential(accountId);
  if (!r) throw new Error("That account no longer exists.");
  let revoked: boolean | null = null;
  if (opts.revoke && r.cred) {
    const rv = await ig.revokeAccess(r.cred.accessToken);
    revoked = rv.ok ? rv.value.revoked : false;
  }
  const now = new Date();
  await prisma.programPublishingAccount.update({
    where: { id: accountId },
    data: { status: opts.revoke ? "REVOKED" : "DISCONNECTED", credentialEncrypted: null, disconnectedAt: now, disconnectedBy: by, ...(opts.revoke ? { revokedAt: now } : {}) },
  });
  const cancelled = await cancelJobsForAccount(accountId, opts.revoke ? "consent revoked" : "account disconnected");
  return { cancelled, revoked };
}

/** Every unpublished job on the account stops. RUNNING jobs are re-checked by the driver before each provider call. */
export async function cancelJobsForAccount(accountId: string, reason: string): Promise<number> {
  const now = new Date();
  const r = await prisma.programPublishingJob.updateMany({
    where: { accountId, state: { in: STOPPABLE as string[] }, providerMediaId: null },
    data: { state: JOB_STATE.CANCELLED, invalidatedAt: now, invalidatedReason: reason, leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: now },
  });
  return r.count;
}

// ---- job creation ------------------------------------------------------------

export type CreatePublishingJobInput = {
  submissionId: string;
  captionDraftId: string;
  accountId: string;
  /** null = publish on the next driver run; a future instant = hold until then. */
  scheduledFor?: Date | null;
  /** IANA zone the person chose the time in (spec §12 "chosen timezone"). */
  tz?: string | null;
  approvedBy: { staffUserId?: string | null; clientUserId?: string | null };
};

export type CreatePublishingJobResult =
  | { ok: true; jobId: string; state: string; reused: boolean; dedupeKey: string }
  | Refusal;

export async function createPublishingJob(input: CreatePublishingJobInput): Promise<CreatePublishingJobResult> {
  // Gate 1: the switch. Missing row = off. Checked before ANY other read so a
  // refused call tonight does not even look at the account.
  if (!(await isAutomationEnabled("publishing"))) {
    return { ok: false, reason: "automation_off", message: "Publishing is switched off. No job was created." };
  }
  // Gate 2: the adapter has app credentials. Without them a job could never run.
  if (!(await ig.configured())) {
    return { ok: false, reason: "not_configured", message: "Instagram publishing is not configured (no Meta app credentials). No job was created." };
  }
  // Gate 3: the account is connected and its token still decrypts.
  const acct = await accountCredential(input.accountId);
  if (!acct) return { ok: false, reason: "no_account", message: "That publishing account no longer exists." };
  if (acct.account.status !== "CONNECTED" || !acct.cred) {
    return { ok: false, reason: "account_not_connected", message: "That Instagram account is not connected — reconnect it before queueing a post." };
  }
  if (acct.account.tokenExpiresAt && acct.account.tokenExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "token_expired", message: "That Instagram connection has expired — reconnect it before queueing a post." };
  }
  if (!input.approvedBy.staffUserId && !input.approvedBy.clientUserId) {
    return { ok: false, reason: "no_approver", message: "A publish needs a named approver." };
  }

  // The exact cut. Must be APPROVED in the Review Room (Jordan's QC) — a
  // client-visible portal approval is recorded separately (ClientDecision).
  const cut = await prisma.reviewSubmission.findUnique({
    where: { id: input.submissionId },
    select: { id: true, projectId: true, status: true, contentHash: true, blobUrl: true, blobPathname: true, sizeBytes: true, fileName: true, sourceWidth: true, sourceHeight: true, videoId: true, clientApprovedDecisionId: true },
  });
  if (!cut) return { ok: false, reason: "no_cut", message: "That cut no longer exists." };
  if (cut.status !== "APPROVED") return { ok: false, reason: "cut_not_approved", message: "Only an approved cut can be published." };

  // The caption, snapshotted. It must be a draft OF THIS CUT that is not stale.
  const caption = await prisma.contentCaptionDraft.findUnique({
    where: { id: input.captionDraftId },
    select: { id: true, submissionId: true, videoId: true, enrollmentId: true, clientId: true, body: true, status: true, kind: true },
  });
  if (!caption) return { ok: false, reason: "no_caption", message: "That caption draft no longer exists." };
  if (caption.submissionId !== cut.id) return { ok: false, reason: "caption_other_cut", message: "That caption was written for a different cut — pick a caption of this cut." };
  if (caption.status === "STALE" || caption.status === "ARCHIVED") {
    return { ok: false, reason: "caption_stale", message: "That caption is stale (the cut changed) or archived — regenerate or choose another." };
  }
  if (caption.enrollmentId !== acct.account.enrollmentId) {
    return { ok: false, reason: "cross_client", message: "That caption belongs to a different client than this Instagram account." };
  }
  const captionText = caption.body.trim();
  if (!captionText) return { ok: false, reason: "empty_caption", message: "The caption is empty." };

  // Media validation against what Meta documents for Reels. Only what we can
  // check from the row is checked; the rest Instagram reports as a container
  // ERROR, which the driver surfaces verbatim.
  const checks: string[] = [];
  const warnings: string[] = [];
  if (!cut.blobUrl || !/^https:\/\//.test(cut.blobUrl)) {
    return { ok: false, reason: "no_public_url", message: "This cut has no https file URL in the hub's store, so Instagram could not fetch it. Upload it through the Review Room first." };
  }
  // Deliberately not "public https url" any more. Queue time only establishes
  // that the hub HOLDS the file; whether Meta can fetch it is decided at
  // publish time, where the link it is given is minted (runPublishingJob).
  checks.push("https file url in the hub's store");
  if (cut.sizeBytes != null) {
    if (cut.sizeBytes > MAX_REEL_BYTES) return { ok: false, reason: "too_large", message: "This file is over Instagram's 1 GB limit for Reels." };
    checks.push(`size ${(cut.sizeBytes / 1024 / 1024).toFixed(0)} MB ≤ 1 GB`);
  } else warnings.push("file size unknown");
  if (cut.sourceWidth && cut.sourceHeight) {
    const ratio = cut.sourceWidth / cut.sourceHeight;
    if (ratio < 0.01 || ratio > 10) return { ok: false, reason: "aspect_ratio", message: "This video's aspect ratio is outside what Instagram accepts." };
    checks.push(`${cut.sourceWidth}×${cut.sourceHeight}`);
    if (Math.abs(ratio - 9 / 16) > 0.02) warnings.push("not 9:16 — Instagram will letterbox or crop the Reel");
  } else warnings.push("dimensions unknown");
  const ext = (cut.fileName ?? cut.blobPathname ?? "").toLowerCase();
  if (ext && !/\.(mp4|mov)$/.test(ext)) warnings.push("not an .mp4/.mov filename — Instagram accepts MP4 and MOV");

  const cutHash = cutIdentityHash(cut);
  const captionHash = sha(captionText);
  const dedupeKey = `${acct.account.id}:${cut.id}:${cutHash.slice(-16)}:${captionHash.slice(0, 16)}`;

  // The same decision made twice is one job. A SUCCEEDED job is the post; a
  // second click must not make a second post.
  const existing = await prisma.programPublishingJob.findUnique({ where: { dedupeKey }, select: { id: true, state: true, providerContainerId: true, providerResponseJson: true } });
  if (existing) {
    if (existing.state === JOB_STATE.SUCCEEDED) return { ok: false, reason: "already_published", message: "This cut with this caption has already been published to that account." };
    if ((OPEN as string[]).includes(existing.state)) return { ok: true, jobId: existing.id, state: existing.state, reused: true, dedupeKey };
    // FAILED / CANCELLED / INVALIDATED: a renewed decision is a new attempt on
    // the same key. Re-open that row rather than fight the unique. A container
    // that Instagram declared ERROR/EXPIRED is dropped so the retry can make a
    // fresh one; any other recorded container is kept and READ first.
    const dropContainer = shouldDropContainerOnReopen(existing.providerContainerId, existing.providerResponseJson);
    const now = new Date();
    const re = await prisma.programPublishingJob.update({
      where: { id: existing.id },
      data: {
        state: JOB_STATE.QUEUED,
        attempts: 0,
        ...(dropContainer ? { providerContainerId: null, providerResponseJson: null } : {}),
        nextAttemptAt: input.scheduledFor ?? now,
        scheduledFor: input.scheduledFor ?? null,
        timezone: input.tz ?? acct.account.timezone ?? "America/New_York",
        approvedAt: now,
        approvedByStaffUserId: input.approvedBy.staffUserId ?? null,
        approvedByClientUserId: input.approvedBy.clientUserId ?? null,
        invalidatedAt: null,
        invalidatedReason: null,
        lastError: null,
        lastErrorAt: null,
        finishedAt: null,
        leaseUntil: null,
        leaseBy: null,
      },
      select: { id: true, state: true },
    });
    return { ok: true, jobId: re.id, state: re.state, reused: false, dedupeKey };
  }

  const videoId = caption.videoId || cut.videoId;
  if (!videoId) return { ok: false, reason: "no_video", message: "This cut is not mapped to a program video yet — map it in the client file first." };

  const snapshot: ApprovalSnapshot = {
    cutHash,
    captionHash,
    captionDraftId: caption.id,
    media: { blobUrl: cut.blobUrl, sizeBytes: cut.sizeBytes, width: cut.sourceWidth, height: cut.sourceHeight, checks, warnings },
  };
  const now = new Date();
  const job = await prisma.programPublishingJob.create({
    data: {
      accountId: acct.account.id,
      enrollmentId: acct.account.enrollmentId,
      clientId: acct.account.clientId,
      videoId,
      submissionId: cut.id,
      captionDraftId: caption.id,
      captionText,
      mediaValidationJson: JSON.stringify(snapshot),
      scheduledFor: input.scheduledFor ?? null,
      timezone: input.tz ?? acct.account.timezone ?? "America/New_York",
      approvedByStaffUserId: input.approvedBy.staffUserId ?? null,
      approvedByClientUserId: input.approvedBy.clientUserId ?? null,
      approvedAt: now,
      state: JOB_STATE.QUEUED,
      nextAttemptAt: input.scheduledFor ?? now,
      dedupeKey,
    },
    select: { id: true, state: true },
  });
  return { ok: true, jobId: job.id, state: job.state, reused: false, dedupeKey };
}

// ---- invalidation (spec §12: renewed decision required) ----------------------------

/** A new cut version (or new bytes behind this submission): every unpublished job on it needs a fresh decision. */
export async function invalidateJobsForCut(submissionId: string, reason = "new cut version"): Promise<number> {
  const now = new Date();
  const r = await prisma.programPublishingJob.updateMany({
    where: { submissionId, state: { in: STOPPABLE as string[] }, providerMediaId: null },
    data: { state: JOB_STATE.INVALIDATED, invalidatedAt: now, invalidatedReason: reason, leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: now },
  });
  return r.count;
}

/** The caption changed after approval: the approved words are no longer the words. */
export async function invalidateJobsForCaption(captionDraftId: string, reason = "caption changed"): Promise<number> {
  const now = new Date();
  const r = await prisma.programPublishingJob.updateMany({
    where: { captionDraftId, state: { in: STOPPABLE as string[] }, providerMediaId: null },
    data: { state: JOB_STATE.INVALIDATED, invalidatedAt: now, invalidatedReason: reason, leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: now },
  });
  return r.count;
}

/** Staff stop, before anything published. */
export async function cancelPublishingJob(jobId: string, by: string | null): Promise<boolean> {
  const now = new Date();
  const r = await prisma.programPublishingJob.updateMany({
    where: { id: jobId, state: { in: STOPPABLE as string[] }, providerMediaId: null },
    data: { state: JOB_STATE.CANCELLED, invalidatedAt: now, invalidatedReason: `cancelled${by ? ` by ${by}` : ""}`, leaseUntil: null, leaseBy: null, nextAttemptAt: null, finishedAt: now },
  });
  return r.count === 1;
}

/**
 * The human half of the parked RECONCILE case: a person confirmed on Instagram
 * that the post exists and pasted its media id. Only a RECONCILE row with no
 * media id can be resolved this way — a job that never reached Meta, or one
 * already confirmed, is refused. This never calls the provider.
 */
export async function resolvePublishingJobByHand(jobId: string, input: { mediaId: string; permalink?: string | null }, by: string | null): Promise<boolean> {
  const mediaId = input.mediaId.trim();
  if (!/^\d{5,}$/.test(mediaId)) return false; // Instagram media ids are numeric
  const now = new Date();
  const r = await prisma.programPublishingJob.updateMany({
    where: { id: jobId, state: JOB_STATE.RECONCILE, providerMediaId: null },
    data: {
      state: JOB_STATE.SUCCEEDED,
      providerMediaId: mediaId,
      providerPermalink: input.permalink?.trim() || null,
      providerResponseJson: JSON.stringify({ reconciled: true, byHand: true, by, mediaId }),
      leaseUntil: null,
      leaseBy: null,
      nextAttemptAt: null,
      finishedAt: now,
      lastError: null,
      lastErrorAt: null,
    },
  });
  return r.count === 1;
}

// ---- the driver ----------------------------------------------------------------

export type PublishingDriverResult = {
  skipped: "automation_off" | "not_configured" | null;
  claimed: number;
  succeeded: number;
  awaiting: number;
  failed: number;
  invalidated: number;
  reconcile: number;
};

/**
 * A cron may call this later. Does nothing unless the `publishing` switch is
 * on AND the adapter is configured. Each claimed job is re-verified against
 * the account, the cut bytes and the caption hash it was approved with
 * immediately before any provider call.
 */
export async function runPublishingDriver(opts: { limit?: number; leaseBy?: string } = {}): Promise<PublishingDriverResult> {
  const result: PublishingDriverResult = { skipped: null, claimed: 0, succeeded: 0, awaiting: 0, failed: 0, invalidated: 0, reconcile: 0 };
  if (!(await isAutomationEnabled("publishing"))) return { ...result, skipped: "automation_off" };
  if (!(await ig.configured())) return { ...result, skipped: "not_configured" };

  // nextAttemptAt is the driver's whole contract: a job runs when it is due,
  // and a NULL nextAttemptAt on an open job means "parked for a person" — the
  // PUBLISHED-but-unmatched RECONCILE case below sets exactly that so it is
  // never re-claimed (every new job and every retry sets a real instant).
  const now = new Date();
  const candidates = await prisma.programPublishingJob.findMany({
    where: { state: { in: STOPPABLE as string[] }, nextAttemptAt: { lte: now } },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: Math.max(1, Math.min(opts.limit ?? 5, 20)),
    select: { id: true, state: true },
  });
  const leaseBy = opts.leaseBy ?? `publishing:${process.pid}`;
  let lastError: string | null = null;

  for (const c of candidates) {
    const claim = await prisma.programPublishingJob.updateMany({
      where: { id: c.id, state: c.state, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
      data: { state: JOB_STATE.RUNNING, leaseUntil: new Date(Date.now() + LEASE_MS), leaseBy, startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claim.count !== 1) continue;
    result.claimed++;
    const o = await publishOne(c.id, c.state);
    if (o === "succeeded") result.succeeded++;
    else if (o === "awaiting") result.awaiting++;
    else if (o === "invalidated") result.invalidated++;
    else if (o === "reconcile") result.reconcile++;
    else {
      result.failed++;
      lastError = o;
    }
  }
  await recordAutomationRun("publishing", lastError);
  return result;
}

async function publishOne(jobId: string, claimedFrom: string): Promise<"succeeded" | "awaiting" | "invalidated" | "reconcile" | string> {
  const job = await prisma.programPublishingJob.findUnique({
    where: { id: jobId },
    select: { id: true, accountId: true, submissionId: true, captionDraftId: true, captionText: true, mediaValidationJson: true, attempts: true, providerContainerId: true, providerMediaId: true, coverRef: true },
  });
  if (!job) return "row vanished";
  const release = { leaseUntil: null, leaseBy: null };
  const now = () => new Date();

  const stop = async (state: string, error: string, extra: Record<string, unknown> = {}) => {
    await prisma.programPublishingJob.update({ where: { id: jobId }, data: { ...release, state, lastError: error, lastErrorAt: now(), finishedAt: now(), nextAttemptAt: null, ...extra } });
  };
  const retryLater = async (state: string, error: string, minutes: number, extra: Record<string, unknown> = {}) => {
    await prisma.programPublishingJob.update({ where: { id: jobId }, data: { ...release, state, lastError: error, lastErrorAt: now(), nextAttemptAt: new Date(Date.now() + minutes * 60_000), ...extra } });
  };

  // Already confirmed (a crash between publish and the SUCCEEDED write): finish the bookkeeping only.
  if (job.providerMediaId) {
    await prisma.programPublishingJob.update({ where: { id: jobId }, data: { ...release, state: JOB_STATE.SUCCEEDED, finishedAt: now(), nextAttemptAt: null, lastError: null, lastErrorAt: null } });
    return "succeeded";
  }

  // Re-verify the decision right before touching Meta.
  const acct = await accountCredential(job.accountId);
  if (!acct || acct.account.status !== "CONNECTED" || !acct.cred) {
    await stop(JOB_STATE.CANCELLED, "The Instagram account was disconnected before this post ran.", { invalidatedAt: now(), invalidatedReason: "account disconnected" });
    return "invalidated";
  }
  if (acct.account.tokenExpiresAt && acct.account.tokenExpiresAt.getTime() < Date.now()) {
    await stop(JOB_STATE.FAILED, "The Instagram connection expired — reconnect the account and approve the post again.");
    await prisma.programPublishingAccount.update({ where: { id: acct.account.id }, data: { status: "EXPIRED", lastError: "token expired" } }).catch(() => {});
    return "token expired";
  }
  const snap = parseSnapshot(job.mediaValidationJson);
  if (!snap) {
    await stop(JOB_STATE.FAILED, "This job has no approval record of which cut and caption were approved — approve it again.");
    return "no approval snapshot";
  }
  const cut = await prisma.reviewSubmission.findUnique({
    where: { id: job.submissionId },
    select: { id: true, status: true, contentHash: true, blobUrl: true, blobPathname: true, sizeBytes: true, fileName: true },
  });
  if (!cut || cut.status !== "APPROVED" || cutIdentityHash(cut) !== snap.cutHash) {
    await stop(JOB_STATE.INVALIDATED, "The cut changed (or lost its approval) after this post was approved — approve the new version to publish it.", { invalidatedAt: now(), invalidatedReason: "new cut version" });
    return "invalidated";
  }
  if (job.captionDraftId) {
    const draft = await prisma.contentCaptionDraft.findUnique({ where: { id: job.captionDraftId }, select: { body: true, status: true } });
    if (!draft || sha(draft.body.trim()) !== snap.captionHash || draft.status === "STALE" || draft.status === "ARCHIVED") {
      await stop(JOB_STATE.INVALIDATED, "The caption changed after this post was approved — approve the new wording to publish it.", { invalidatedAt: now(), invalidatedReason: "caption changed" });
      return "invalidated";
    }
  }
  const token = acct.cred.accessToken;
  const igUserId = acct.account.providerAccountId;

  // RECONCILE, or any claim that already has a container: READ before retry.
  let containerId = job.providerContainerId;
  if (containerId) {
    const st = await ig.containerStatus({ containerId, accessToken: token });
    if (!st.ok) {
      if (st.reason === "not_configured") { await stop(JOB_STATE.FAILED, st.message); return st.message; }
      if (st.retryable && job.attempts < MAX_CONTAINER_ATTEMPTS) { await retryLater(claimedFrom === JOB_STATE.RECONCILE ? JOB_STATE.RECONCILE : JOB_STATE.AWAITING_PROVIDER, st.message, backoffMinutes(job.attempts)); return "awaiting"; }
      await stop(JOB_STATE.FAILED, st.message);
      return st.message;
    }
    switch (st.value.status) {
      case "PUBLISHED": {
        // The post EXISTS. Find it; never publish again. If it cannot be
        // matched with certainty the job stays in RECONCILE for a person.
        const recent = await ig.recentMedia({ igUserId, accessToken: token, limit: 15 });
        const matches = recent.ok ? recent.value.filter((m) => (m.caption ?? "").trim() === job.captionText.trim()) : [];
        if (matches.length === 1) {
          await prisma.programPublishingJob.update({
            where: { id: jobId },
            data: { ...release, state: JOB_STATE.SUCCEEDED, providerMediaId: matches[0].id, providerPermalink: matches[0].permalink, providerResponseJson: JSON.stringify({ reconciled: true, media: matches[0] }), finishedAt: now(), nextAttemptAt: null, lastError: null, lastErrorAt: null },
          });
          return "succeeded";
        }
        // nextAttemptAt: null parks it — the candidate query only takes due
        // instants, so this row is not claimed again until a person resolves it
        // (resolvePublishingJobByHand) or cancels it.
        await prisma.programPublishingJob.update({
          where: { id: jobId },
          data: { ...release, state: JOB_STATE.RECONCILE, nextAttemptAt: null, providerResponseJson: JSON.stringify({ container: containerId, status: st.value, candidates: recent.ok ? recent.value.slice(0, 5) : [] }), lastError: "Instagram reports this container PUBLISHED but the post could not be matched with certainty. Confirm it on Instagram and record the media id by hand — retrying is blocked so it cannot post twice.", lastErrorAt: now() },
        });
        return "reconcile";
      }
      case "FINISHED":
        break; // fall through to publish below
      case "IN_PROGRESS":
        if (job.attempts >= MAX_CONTAINER_ATTEMPTS) {
          await stop(JOB_STATE.FAILED, `Instagram was still processing this video after ${MAX_CONTAINER_ATTEMPTS} checks (~${MAX_CONTAINER_ATTEMPTS} min). Approve it again to check the same container once more, or upload a smaller export.`, { providerResponseJson: JSON.stringify({ container: containerId, status: st.value }) });
          return "processing timeout";
        }
        await retryLater(JOB_STATE.AWAITING_PROVIDER, "Instagram is still processing the video.", 1);
        return "awaiting";
      case "ERROR":
        await stop(JOB_STATE.FAILED, `Instagram rejected the video: ${st.value.detail ?? "no detail given"}.`, { providerResponseJson: JSON.stringify({ container: containerId, status: st.value }) });
        return "container error";
      case "EXPIRED":
        // 24h passed; a fresh container is the only way forward. Recorded so
        // a re-opened row drops this id instead of reading it again.
        await prisma.programPublishingJob.update({ where: { id: jobId }, data: { providerResponseJson: JSON.stringify({ container: containerId, status: st.value }) } });
        containerId = null;
        break;
      default:
        if (job.attempts >= MAX_CONTAINER_ATTEMPTS) {
          await stop(JOB_STATE.FAILED, `Instagram kept answering with an unknown container status (${st.value.detail ?? "no detail"}) — the adapter needs a look before this is retried.`, { providerResponseJson: JSON.stringify({ container: containerId, status: st.value }) });
          return "unknown container status";
        }
        await retryLater(JOB_STATE.AWAITING_PROVIDER, "Instagram gave an unknown container status.", 5);
        return "awaiting";
    }
  }

  if (!containerId) {
    // META'S SERVERS FETCH THIS URL (RTP-01, handover §2 — the row the Sep 17
    // handover missed entirely). `video_url` is pulled from Meta's network with no
    // credential of ours, so handing over the store object's own address only
    // works while that store is public: on a private one Meta gets a 401, the
    // container is never created, and nothing anywhere says "Meta could not read
    // the file" — it surfaces as a publishing job that failed.
    //
    // The handoff chosen is a SHORT-LIVED PRESIGNED GET scoped to this one
    // pathname, not a proxy route: Meta pulls a whole reel at its own pace and
    // a proxy would put a multi-hundred-megabyte transfer through a function
    // with a 300s ceiling on an endpoint that, to be fetchable by Meta, could
    // not be behind our session gate — which is the very thing being closed.
    // Six hours covers the container's own processing window; the job's retry
    // mints a fresh link rather than reusing a stale one. On today's public
    // store this returns the same URL the line above used to pass.
    const source = await fetchableCutUrl(cut, { ttlMs: 6 * 3600_000, purpose: "instagram container" });
    if (!source.ok) {
      await stop(JOB_STATE.FAILED, `Instagram could not be given a link to this cut's file — ${source.message}`);
      return "no url";
    }
    const created = await ig.createMediaContainer({ igUserId, accessToken: token, videoUrl: source.url, caption: job.captionText, coverUrl: job.coverRef ?? null });
    if (!created.ok) {
      if (created.reason === "not_configured") { await stop(JOB_STATE.FAILED, created.message); return created.message; }
      if (created.retryable && job.attempts < MAX_ATTEMPTS) { await retryLater(JOB_STATE.QUEUED, created.message, backoffMinutes(job.attempts)); return "awaiting"; }
      await stop(JOB_STATE.FAILED, created.message);
      return created.message;
    }
    containerId = created.value.containerId;
    // Written BEFORE any publish call, so a crash from here on is reconciled
    // by reading this container rather than by making another.
    await prisma.programPublishingJob.update({ where: { id: jobId }, data: { providerContainerId: containerId, state: JOB_STATE.AWAITING_PROVIDER } });
    const st = await ig.containerStatus({ containerId, accessToken: token });
    if (!st.ok || st.value.status !== "FINISHED") {
      await retryLater(JOB_STATE.AWAITING_PROVIDER, st.ok ? "Instagram is processing the video." : st.message, 1);
      return "awaiting";
    }
  }

  // Publish. A timeout here is the dangerous case: Meta may have published.
  // The job goes to RECONCILE and the next run reads the container first.
  let pub: Awaited<ReturnType<typeof ig.publishContainer>>;
  try {
    pub = await ig.publishContainer({ igUserId, creationId: containerId, accessToken: token });
  } catch (e) {
    await retryLater(JOB_STATE.RECONCILE, `Publish call did not complete (${e instanceof Error ? e.message : "unknown"}) — will check the container before anything is retried.`, 2);
    return "reconcile";
  }
  if (!pub.ok) {
    if (pub.reason === "not_configured") { await stop(JOB_STATE.FAILED, pub.message); return pub.message; }
    if (pub.reason === "network") {
      await retryLater(JOB_STATE.RECONCILE, `${pub.message} — will check the container before anything is retried.`, 2);
      return "reconcile";
    }
    if (pub.retryable && job.attempts < MAX_CONTAINER_ATTEMPTS) { await retryLater(JOB_STATE.AWAITING_PROVIDER, pub.message, backoffMinutes(job.attempts)); return "awaiting"; }
    await stop(JOB_STATE.FAILED, pub.message);
    return pub.message;
  }
  // Confirmed receipt: the media id is the proof. Written before the permalink
  // read so a failure there cannot lose the confirmation.
  await prisma.programPublishingJob.update({
    where: { id: jobId },
    data: { providerMediaId: pub.value.mediaId, providerResponseJson: JSON.stringify({ mediaId: pub.value.mediaId, container: containerId }) },
  });
  const link = await ig.mediaPermalink({ mediaId: pub.value.mediaId, accessToken: token });
  await prisma.programPublishingJob.update({
    where: { id: jobId },
    data: { ...release, state: JOB_STATE.SUCCEEDED, providerPermalink: link.ok ? link.value.permalink : null, finishedAt: now(), nextAttemptAt: null, lastError: null, lastErrorAt: null },
  });
  return "succeeded";
}

// ---- reads for the Connections card ------------------------------------------------

export type PublishingAccountRow = {
  id: string;
  clientName: string;
  handle: string | null;
  displayName: string | null;
  status: string;
  connectedAt: string;
  tokenExpiresAt: string | null;
  lastError: string | null;
  openJobs: number;
};

export async function publishingAccountRows(): Promise<PublishingAccountRow[]> {
  const accounts = await prisma.programPublishingAccount.findMany({
    orderBy: { connectedAt: "desc" },
    select: { id: true, clientId: true, handle: true, displayName: true, status: true, connectedAt: true, tokenExpiresAt: true, lastError: true },
  });
  if (accounts.length === 0) return [];
  const clients = await prisma.client.findMany({ where: { id: { in: [...new Set(accounts.map((a) => a.clientId))] } }, select: { id: true, name: true } });
  const names = new Map(clients.map((c) => [c.id, c.name]));
  const open = await prisma.programPublishingJob.groupBy({ by: ["accountId"], where: { state: { in: OPEN as string[] } }, _count: { _all: true } });
  const openBy = new Map(open.map((o) => [o.accountId, o._count._all]));
  return accounts.map((a) => ({
    id: a.id,
    clientName: names.get(a.clientId) ?? "Unknown client",
    handle: a.handle,
    displayName: a.displayName,
    status: a.status,
    connectedAt: a.connectedAt.toISOString(),
    tokenExpiresAt: a.tokenExpiresAt ? a.tokenExpiresAt.toISOString() : null,
    lastError: a.lastError,
    openJobs: openBy.get(a.id) ?? 0,
  }));
}

export async function publishingJobRows(opts: { limit?: number } = {}) {
  return prisma.programPublishingJob.findMany({
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.limit ?? 20, 100),
    select: { id: true, accountId: true, submissionId: true, state: true, scheduledFor: true, timezone: true, attempts: true, lastError: true, providerPermalink: true, invalidatedReason: true, createdAt: true, finishedAt: true },
  });
}

export type InstagramCardData = {
  configured: boolean;
  appId: string | null;
  credentialSource: "connection" | "env" | null;
  requirements: Array<{ key: string; label: string; detail: string }>;
  automation: { enabled: boolean; missing: boolean };
  accounts: PublishingAccountRow[];
  enrollments: Array<{ id: string; clientName: string }>;
  redirectUri: string;
};

/** Everything InstagramCard shows. The app SECRET never leaves the adapter; the app id is not a secret. */
export async function instagramCardData(): Promise<InstagramCardData> {
  const [creds, auto, accounts, enrollments] = await Promise.all([
    ig.metaAppCredentials(),
    getAutomation("publishing"),
    publishingAccountRows().catch(() => []),
    prisma.contentEnrollment.findMany({ where: { status: "ACTIVE" }, select: { id: true, clientId: true } }).catch(() => []),
  ]);
  const clients = enrollments.length
    ? await prisma.client.findMany({ where: { id: { in: enrollments.map((e) => e.clientId) } }, select: { id: true, name: true } }).catch(() => [])
    : [];
  const names = new Map(clients.map((c) => [c.id, c.name]));
  return {
    configured: Boolean(creds),
    appId: creds?.appId ?? null,
    credentialSource: creds?.source ?? null,
    requirements: ig.REQUIREMENTS.map((r) => ({ ...r })),
    automation: { enabled: auto.enabled, missing: auto.missing },
    accounts,
    enrollments: enrollments
      .map((e) => ({ id: e.id, clientName: names.get(e.clientId) ?? "Unknown client" }))
      .sort((a, b) => a.clientName.localeCompare(b.clientName)),
    redirectUri: `${appBase()}/connections`,
  };
}
