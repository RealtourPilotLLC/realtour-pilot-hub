import "server-only";
import { prisma } from "@/lib/prisma";
import { isAutomationEnabled, recordAutomationRun } from "@/lib/programAutomation";
import { enqueueTranscriptJob } from "@/lib/transcriptJobs";
import { parseStoredSections, releaseStrategyVersion } from "@/lib/contentStrategy";
import { draftStrategyFromTranscript } from "@/lib/contentGeneration";
import { queueStrategyReadyNotice } from "@/lib/scriptShare";
import { isTestClientName } from "@/lib/testClients";

// ---------------------------------------------------------------------------
// ONBOARDING (spec §21) — W2-F, Sep 17 2026.
//
// One ProgramOnboarding row per enrollment records the whole discovery →
// strategy chain: whether discovery is required, the booking, the source
// call, the brand inputs and asset completeness, the generated DRAFT, and the
// approval. This module only ADVANCES that record and ENQUEUES work:
//   · a BRAND_DISCOVERY call record whose transcript is CONFIRMED gets a
//     STRATEGY_DRAFT job (W1-B's ProgramTranscriptJob; W1-C's handler runs the
//     generation and refuses any call that is not brand discovery);
//   · when the draft ContentStrategyVersion exists, Jordan gets ONE bell to
//     review it — the draft is never approved, activated or released here;
//   · a monthly strategy call never touches this: only callType
//     BRAND_DISCOVERY records are read, so a monthly call cannot replace the
//     brand foundation by accident (spec §21's last acceptance line).
//
// The hourly sweep runs behind `strategy_generation` (missing row = off) and
// reports `skipped` while it is off — with the switch off nothing here is
// written, so the eleven live enrollments stay exactly as they are until
// Jordan turns the chain on. A staff click (draftStrategyNow) is a user
// action: it drafts through the same policy prompt with unattended=false and
// still lands as a DRAFT for review.
//
// Status ladder (never skipped past, never reversed except a cancelled
// booking): NOT_STARTED → DISCOVERY_BOOKED → DISCOVERY_HELD →
// TRANSCRIPT_PENDING → STRATEGY_DRAFTED → STRATEGY_IN_REVIEW →
// STRATEGY_APPROVED → BANK_GENERATED → COMPLETE. WAIVED sits beside the
// ladder for a client whose strategy arrives by import (discovery waived,
// explicitly, with a reason).
// ---------------------------------------------------------------------------

export const ONBOARDING_KEY = "strategy_generation" as const;

export type OnboardingStatus =
  | "NOT_STARTED" | "DISCOVERY_BOOKED" | "DISCOVERY_HELD" | "TRANSCRIPT_PENDING" | "STRATEGY_DRAFTED" | "STRATEGY_IN_REVIEW"
  | "STRATEGY_APPROVED" | "BANK_GENERATED" | "COMPLETE" | "WAIVED";
const LADDER: OnboardingStatus[] = ["NOT_STARTED", "DISCOVERY_BOOKED", "DISCOVERY_HELD", "TRANSCRIPT_PENDING", "STRATEGY_DRAFTED", "STRATEGY_IN_REVIEW", "STRATEGY_APPROVED", "BANK_GENERATED", "COMPLETE"];
const rank = (s: string) => LADDER.indexOf(s as OnboardingStatus);

export async function ensureOnboardingRecord(enrollmentId: string): Promise<{ id: string; created: boolean }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!e) throw new Error("Enrollment not found.");
  const existing = await prisma.programOnboarding.findUnique({ where: { enrollmentId }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  const row = await prisma.programOnboarding.create({ data: { enrollmentId, clientId: e.clientId }, select: { id: true } });
  return { id: row.id, created: true };
}

/** Discovery is waivable only explicitly, with a reason (spec §21 / schema row). */
export async function waiveDiscovery(enrollmentId: string, by: string, reason: string): Promise<void> {
  if (reason.trim().length < 3) throw new Error("Waiving discovery needs a reason.");
  const { id } = await ensureOnboardingRecord(enrollmentId);
  await prisma.programOnboarding.update({ where: { id }, data: { discoveryRequired: false, discoveryWaivedAt: new Date(), discoveryWaivedBy: by, discoveryWaivedReason: reason.trim(), status: "WAIVED" } });
}

// ---------------------------------------------------------------------------
// DISCOVERY AND PAYMENT ARRIVE IN EITHER ORDER (§4.3 / A01, Sep 21 2026)
//
// The website sells the program and then sends the buyer to the brand
// discovery Calendly link. Which of those two facts reaches the hub first is
// not ours to decide: Stripe is polled hourly, Calendly is synced on its own
// schedule, and Phase 0 found a live signup (Mike Flatley, Sep 3) that has
// never been paired with a call at all. So both directions land in one
// idempotent function, and the DESK TASK is the thing that tells the truth:
//   · payment, no booking      → open "book the discovery call" for Kyle
//   · payment, booking already → pin the call, CLOSE that task (§4.3: "remove
//                                the discovery-scheduling task when already
//                                booked")
//   · booking arrives later    → the hourly sweep calls this again and the
//                                task closes then
// Running it twice changes nothing the second time. Running it on a TEST
// client writes no desk row at all.
//
// It never merges identities. A discovery booking made from a different
// address than the one that paid (Arielle paid as arielleroemer@gmail.com and
// books as arielle.roemer@foxroach.com — live, today) is recorded as an
// UNVERIFIED alias proposal and handed to Kyle. A proposal is not a match:
// resolveInviteeIdentity only accepts aliases somebody verified.
// ---------------------------------------------------------------------------

const DISCOVERY_TASK_PREFIX = "program-discovery-booking:";

// THE IDENTITY QUESTION IS NOT THE SCHEDULING TASK (Sep 21 2026).
// It used to be raised under the scheduling dedupeKey, and the two conditions
// cancel each other out exactly: a payer/invitee conflict can only ever be
// raised when a booking EXISTS, and reconcileDiscoveryTasks closes anything on
// the scheduling key the moment a booking exists. Kyle would have been handed
// the question and had it closed underneath him by the next hourly sweep — and
// in the payment-first order, where the scheduling task is already OPEN, the
// question never even overwrote the row it was sharing. Its own prefix, and the
// invitee address in the key, so a second, different mismatch is a second
// question and the one a person already answered stays answered.
const IDENTITY_TASK_PREFIX = "program-identity-conflict:";

// SmartTask.status in this schema is OPEN | IN_PROGRESS | WAITING_* | BLOCKED |
// COMPLETED | CANCELLED (prisma/schema.prisma), and every consumer in the hub
// filters `status notIn ["COMPLETED","CANCELLED"]` — queries.ts:59 and about
// forty other sites. The first cut of this file closed its tasks by writing
// "DONE", a status nothing in the hub reads: measured read-only on Sep 21 2026,
// all 1,934 SmartTask rows are COMPLETED (1,523), CANCELLED (293), OPEN (116)
// or IN_PROGRESS (2), and not one says DONE or CLOSED. So a "closed" discovery
// task would have stayed OPEN on every list, count and board in the product,
// and a task a human genuinely COMPLETED was not in TASK_DONE either, so the
// reopen path never fired on it.
const TASK_DONE = ["COMPLETED", "CANCELLED"];
/** TASK_DONE plus the two statuses that first cut wrote. Nothing carries them
 *  today (0 rows, measured above) and nothing writes them any more — they are
 *  READ so that a row minted by that version is recognised as closed instead of
 *  nagging for ever. Retire, never delete. */
const TASK_DONE_INCLUDING_LEGACY = [...TASK_DONE, "DONE", "CLOSED"];

export type ActivationResult =
  | { outcome: "booked"; detail: string }
  | { outcome: "task_open"; detail: string }
  | { outcome: "conflict"; detail: string }
  | { outcome: "skipped"; detail: string }
  | { outcome: "error"; detail: string };

/**
 * Did the person who PAID and the person who BOOKED give different addresses?
 * Pure, so it can be exercised against real rows without touching any of them.
 *
 * Live today (Sep 21 2026): Arielle Roemer paid as arielleroemer@gmail.com and
 * books from arielle.roemer@foxroach.com, and that single mismatch is why one
 * of the two genuine client bookings on the account is unrouted. The answer is
 * a PROPOSAL and a question for the client, never a merge — §4.4, and
 * resolveInviteeIdentity accepts an alias only after a person verifies it.
 *
 * An address already on the client record (email or backupEmail) is not a
 * conflict: somebody already decided that one is theirs.
 */
export function payerInviteeConflict(input: {
  payer: string | null | undefined;
  invitee: string | null | undefined;
  knownEmails: (string | null | undefined)[];
}): { payer: string; invitee: string; message: string } | null {
  const payer = input.payer?.trim().toLowerCase() || null;
  const invitee = input.invitee?.trim().toLowerCase() || null;
  if (!payer || !invitee || payer === invitee) return null;
  const known = input.knownEmails.filter((e): e is string => !!e).map((e) => e.trim().toLowerCase());
  if (known.includes(invitee)) return null;
  return {
    payer,
    invitee,
    message: `The discovery call was booked from ${invitee} but the payment came from ${payer}. Confirm with them which address is theirs before either is treated as verified. Nothing was merged.`,
  };
}

/**
 * Called the moment a payment is verified, and again by the onboarding sweep.
 * Idempotent in both directions; writes nothing client-facing.
 */
export async function onProgramActivated(
  enrollmentId: string,
  opts: { payerEmail?: string | null; payerName?: string | null; checkoutId?: string | null } = {},
): Promise<ActivationResult> {
  const enrollment = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
  if (!enrollment) return { outcome: "error", detail: "Enrollment not found." };
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true, email: true, backupEmail: true } });
  const isTest = isTestClientName(client?.name);
  await ensureOnboardingRecord(enrollmentId);

  // Any brand-discovery booking on file for this client, whatever state the
  // matcher left it in — including one that is only a CANDIDATE, because "is
  // there a booking" and "do we know whose it is" are different questions and
  // only the first one closes Kyle's task.
  const booking = await prisma.programCallRecord.findFirst({
    where: {
      callType: "BRAND_DISCOVERY",
      status: { notIn: ["CANCELLED"] },
      OR: [{ enrollmentId }, { clientId: enrollment.clientId }],
    },
    orderBy: { scheduledStart: "desc" },
    select: { id: true, scheduledStart: true, status: true, inviteeEmail: true, matchState: true },
  });

  // A payer address the booking does not share is a §4.4 conflict: proposed,
  // never merged, and only a person may verify it.
  const conflict = payerInviteeConflict({
    payer: opts.payerEmail,
    invitee: booking?.inviteeEmail ?? null,
    knownEmails: [client?.email, client?.backupEmail],
  });
  if (conflict) {
    try {
      const { proposeClientEmailAlias } = await import("@/lib/contentCallRecords");
      await proposeClientEmailAlias(enrollment.clientId, enrollmentId, conflict.invitee, "signup");
    } catch { /* the alias proposal is a convenience; the task below is the record that matters */ }
  }

  if (booking) {
    // Pin it on the onboarding record and let the ladder read the facts.
    await advanceOnboarding(enrollmentId, { enqueue: false, requestedBy: "activation" }).catch(() => {});
    await closeDiscoveryTask(enrollmentId);
    if (conflict && !isTest) {
      await openProgramDeskTask({
        // Its own key, carrying the address in question — never the scheduling
        // key, which the booking that caused this conflict has just closed.
        dedupeKey: `${IDENTITY_TASK_PREFIX}${enrollmentId}:${conflict.invitee}`,
        clientId: enrollment.clientId,
        clientName: client?.name ?? "",
        title: `Confirm which address is ${client?.name ?? "this client"}'s`,
        lines: [conflict.message],
        assignedKey: "kyle",
        reasonCreated: "The discovery booking and the payment carried different email addresses",
        // A person who closes this has ANSWERED it, and the answer lives in the
        // alias ledger (ClientEmailAlias), not on the client row that
        // payerInviteeConflict reads — so re-deriving the conflict every hour
        // and reopening the task would be a permanent nag, not a reminder.
        reopenIfClosed: false,
      });
    }
    return conflict
      ? { outcome: "conflict", detail: conflict.message }
      : { outcome: "booked", detail: `discovery call ${booking.id} (${booking.status}) linked; the scheduling task is closed` };
  }

  if (isTest) return { outcome: "skipped", detail: "TEST client — no desk task raised" };
  await openProgramDeskTask({
    dedupeKey: `${DISCOVERY_TASK_PREFIX}${enrollmentId}`,
    clientId: enrollment.clientId,
    clientName: client?.name ?? "",
    title: `Book the brand discovery call — ${client?.name ?? "new program client"}`,
    lines: [
      "A Content Program signup is paid and active, and no brand discovery call is on the books yet.",
      "Discovery happens once, and the whole strategy is built from it, so nothing else in the program can start until it is held.",
      opts.payerEmail ? `Buyer: ${opts.payerName ?? "name not given at checkout"} <${opts.payerEmail}>` : "The checkout carried no email address.",
      opts.checkoutId ? `Stripe checkout ${opts.checkoutId}` : "",
      "",
      "This closes itself the moment a brand discovery booking appears on their record.",
    ].filter(Boolean),
    assignedKey: "kyle",
    reasonCreated: "A paid Content Program signup has no brand discovery call yet",
    // The one legitimate reopen in this file: a booking that was cancelled
    // after the task was closed puts the same job back on Kyle's list.
    reopenIfClosed: true,
  });
  return { outcome: "task_open", detail: "no discovery booking on file — the scheduling task is open for Kyle" };
}

/**
 * Raise (or refresh) one desk task for the program, identified by its own
 * dedupeKey. Never for a TEST client. The caller owns the key, because the two
 * tasks this file raises answer different questions and must not share one.
 */
async function openProgramDeskTask(input: {
  dedupeKey: string;
  clientId: string;
  clientName: string;
  title: string;
  lines: string[];
  assignedKey: string;
  reasonCreated: string;
  reopenIfClosed: boolean;
}): Promise<void> {
  if (isTestClientName(input.clientName)) return;
  const description = input.lines.join("\n");
  const title = input.title.slice(0, 140);
  const existing = await prisma.smartTask
    .findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true, status: true, title: true, description: true } })
    .catch(() => null);
  if (existing) {
    if (TASK_DONE_INCLUDING_LEGACY.includes(existing.status)) {
      if (!input.reopenIfClosed) return;
      await prisma.smartTask.update({ where: { id: existing.id }, data: { status: "OPEN", completedAt: null, title, description } }).catch(() => {});
      return;
    }
    // STILL OPEN, AND THE FACTS HAVE MOVED. The first cut returned here without
    // rewriting anything, so whichever version of a task was written first won
    // and every later one was dropped on the floor — which is how the identity
    // question stayed invisible in the payment-first order. Rewriting an open
    // machine-raised row is not overwriting a person's work: the description IS
    // the evidence, and stale evidence is worse than none.
    if (existing.title !== title || existing.description !== description) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { title, description } }).catch(() => {});
    }
    return;
  }
  await prisma.smartTask
    .create({
      data: {
        title, description, summary: input.title.slice(0, 200),
        taskType: "todo", status: "OPEN", source: "content_program", priority: "HIGH",
        clientId: input.clientId, dedupeKey: input.dedupeKey, assignedKey: input.assignedKey,
        dueAt: new Date(Date.now() + 2 * 864e5),
        reasonCreated: input.reasonCreated,
      },
    })
    .catch(() => {});
}

/** §4.3: the scheduling task disappears when the booking exists. Closed, not
 *  deleted — the hub retires rows, it does not erase them. COMPLETED is the
 *  word every other surface reads; the `notIn TASK_DONE` filter (rather than
 *  the legacy list) is deliberate, so any row the old code left saying "DONE"
 *  is normalised to COMPLETED the next time this runs. */
async function closeDiscoveryTask(enrollmentId: string): Promise<void> {
  await prisma.smartTask
    .updateMany({
      where: { dedupeKey: `${DISCOVERY_TASK_PREFIX}${enrollmentId}`, status: { notIn: TASK_DONE } },
      data: { status: "COMPLETED", completedAt: new Date() },
    })
    .catch(() => {});
}

type AdvanceResult = { id: string; from: string; to: string; actions: string[] };

/**
 * Read the chain, move the record forward, enqueue what is due. `enqueue`
 * false = bookkeeping only (the sweep passes true only while the switch is on).
 */
export async function advanceOnboarding(enrollmentId: string, opts: { now?: Date; enqueue: boolean; requestedBy?: string } = { enqueue: false }): Promise<AdvanceResult> {
  const now = opts.now ?? new Date();
  const { id } = await ensureOnboardingRecord(enrollmentId);
  const ob = await prisma.programOnboarding.findUnique({ where: { id } });
  if (!ob) throw new Error("Onboarding record not found.");
  const actions: string[] = [];
  const from = ob.status;
  const data: Record<string, unknown> = {};
  let status = ob.status as OnboardingStatus;
  const raise = (to: OnboardingStatus) => { if (rank(to) > rank(status)) status = to; };

  // ---- the discovery call (BRAND_DISCOVERY only — a monthly call is invisible here)
  const calls = await prisma.programCallRecord.findMany({
    where: { enrollmentId, callType: "BRAND_DISCOVERY", matchState: { in: ["MATCHED", "CONFIRMED_BY_STAFF", "AMBIGUOUS_CLIENT"] }, status: { notIn: ["CANCELLED", "RESCHEDULED"] } },
    orderBy: { scheduledStart: "desc" },
  });
  const pinned = ob.discoveryCallRecordId ? calls.find((c) => c.id === ob.discoveryCallRecordId) ?? null : null;
  const call = pinned ?? calls[0] ?? null;
  if (call && call.id !== ob.discoveryCallRecordId) { data.discoveryCallRecordId = call.id; actions.push(`discovery call → ${call.id}`); }
  // §4.3: a booking on file means the scheduling task has done its job,
  // whichever path noticed the booking first. Closing here (not only in
  // onProgramActivated) is what makes the booking-after-payment order work:
  // nobody has to re-run activation for Kyle's row to go away.
  if (call) await closeDiscoveryTask(enrollmentId);
  if (!call && ob.discoveryCallRecordId && (status === "DISCOVERY_BOOKED" || status === "NOT_STARTED")) {
    // The only backward move: the booking was cancelled before it happened.
    data.discoveryCallRecordId = null; status = "NOT_STARTED"; actions.push("discovery booking cancelled → NOT_STARTED");
  }

  const waived = !ob.discoveryRequired || !!ob.discoveryWaivedAt;
  if (!waived && call) {
    const held = call.status === "COMPLETED" || (call.status === "SCHEDULED" && !!(call.scheduledEnd ?? call.scheduledStart) && (call.scheduledEnd ?? call.scheduledStart)! < now);
    if (call.status === "SCHEDULED" && !held) raise("DISCOVERY_BOOKED");
    if (held) raise("DISCOVERY_HELD");
    if (call.transcriptState === "CONFIRMED" || call.transcriptState === "ANALYZED") {
      raise("TRANSCRIPT_PENDING");
      // The draft job is owed by the FACT — a confirmed brand-discovery
      // transcript that has not yet produced a strategy version — not by where
      // the ladder happens to sit. A client who already has an approved
      // strategy sits at STRATEGY_APPROVED, and the ladder never walks
      // backwards; gating the job on `status === "TRANSCRIPT_PENDING"` meant a
      // real re-discovery call for such a client silently produced nothing.
      // That is exactly the failure mode the Sep 8 outage taught us to refuse.
      // One draft per call record: the version's callRecordId is the guard here
      // and the job's dedupeKey (<callRecordId>:STRATEGY_DRAFT) is the guard in
      // the queue, so repeated sweeps cannot stack drafts. The draft is still
      // only ever a DRAFT — nothing here approves, activates or releases it, so
      // an existing approved strategy is never replaced by this.
      const alreadyDrafted = (await prisma.contentStrategyVersion.count({ where: { enrollmentId, callRecordId: call.id } })) > 0;
      if (opts.enqueue && !alreadyDrafted) {
        const job = await enqueueTranscriptJob({ callRecordId: call.id, kind: "STRATEGY_DRAFT", enrollmentId, requestedBy: opts.requestedBy ?? "onboarding" });
        if (job.created) actions.push(`STRATEGY_DRAFT job queued (${job.id})`);
      }
    }
  }

  // ---- the draft (from the discovery call, or a staff click)
  // THE CURRENT CALL'S DRAFT WINS over whatever is pinned on the record. The
  // pinned id is the LAST draft we recorded, which for a client who already
  // has an approved strategy is the old one — resolving the pin first meant a
  // genuine re-discovery call generated a new draft that this function then
  // never looked at. Read the fact (a draft for THIS call), fall back to the
  // pin only when the call has produced none.
  const callDraft = call
    ? await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, callRecordId: call.id, sourceKind: "discovery_call" }, orderBy: { versionNo: "desc" } })
    : null;
  const draft = callDraft ?? (ob.strategyDraftVersionId ? await prisma.contentStrategyVersion.findUnique({ where: { id: ob.strategyDraftVersionId } }) : null);
  if (draft) {
    const newlyRecorded = draft.id !== ob.strategyDraftVersionId;
    if (newlyRecorded) { data.strategyDraftVersionId = draft.id; data.strategyGenerationRunId = draft.aiRunId; actions.push(`draft v${draft.versionNo} recorded`); }
    raise("STRATEGY_DRAFTED");
    const missing = missingItemsFrom(draft.sectionsJson);
    data.missingItemsJson = JSON.stringify(missing);
    // RING THE BELL ON THE FACT, NOT THE LADDER POSITION. `status ===
    // "STRATEGY_DRAFTED"` can never be true for a client already at
    // STRATEGY_APPROVED (raise() never walks backwards), so gating on it meant
    // a re-discovery draft was generated and Jordan was never told — a silent
    // no-op, the worst shape there is. A draft that is still a DRAFT and has
    // just been recorded is one nobody has reviewed. The notify dedupeKey is
    // the version id, so the bell still rings at most once per draft however
    // many times the sweep passes.
    const awaitingReview = draft.status === "DRAFT" && (newlyRecorded || status === "STRATEGY_DRAFTED");
    if (awaitingReview) {
      const client = await prisma.client.findUnique({ where: { id: ob.clientId }, select: { name: true } });
      if (!isTestClientName(client?.name)) {
        const { notifyInApp } = await import("@/lib/notify");
        await notifyInApp({
          kind: "strategy_draft_ready",
          title: `Strategy draft ready — ${client?.name ?? "client"}`.slice(0, 90),
          body: `Drafted from the discovery call${missing.length ? ` · ${missing.length} gap(s) listed, not filled` : ""}. Review, edit and approve on the client file.`,
          href: `/content/${enrollmentId}?tab=strategy`,
          targets: [{ roles: ["OWNER"] }],
          dedupeKey: `strategy-draft:${draft.id}`,
        }).catch(() => {});
      }
      // Only the first-time path moves the ladder. A client already past this
      // rung keeps the rung they earned — they DO have an approved strategy;
      // what is new is a draft beside it, and the bell is what says so.
      if (status === "STRATEGY_DRAFTED") status = "STRATEGY_IN_REVIEW";
      actions.push(status === "STRATEGY_IN_REVIEW" ? "owner notified: draft in review" : `owner notified: a new draft (v${draft.versionNo}) is waiting beside the approved strategy`);
    }
    if (draft.status === "REJECTED") { data.lastError = "The draft was rejected — regenerate from the transcript or import an approved strategy."; data.lastErrorAt = now; }
  }

  // ---- approval (Jordan's act, recorded here — never performed here)
  const approved = await prisma.contentStrategyVersion.findFirst({ where: { enrollmentId, status: "APPROVED" }, orderBy: { approvedAt: "desc" } });
  if (approved) {
    if (approved.id !== ob.strategyApprovedVersionId) { data.strategyApprovedVersionId = approved.id; actions.push(`approved v${approved.versionNo} recorded`); }
    if (waived) status = status === "COMPLETE" ? status : "STRATEGY_APPROVED"; else raise("STRATEGY_APPROVED");
    const bank = await prisma.contentTopicRefreshRun.findFirst({ where: { enrollmentId, status: "SUCCEEDED", createdAt: { gte: approved.approvedAt ?? approved.createdAt } }, select: { id: true } });
    if (bank) {
      if (bank.id !== ob.initialBankRunId) data.initialBankRunId = bank.id;
      raise("BANK_GENERATED");
      if (approved.releasedAt) raise("COMPLETE");
    }
  } else if (waived && status !== "WAIVED" && rank(status) < rank("STRATEGY_APPROVED")) status = "WAIVED";

  // ---- assets (the checklist, honest: null = not on file)
  const client = await prisma.client.findUnique({ where: { id: ob.clientId }, select: { brandAssetsPath: true, brandColors: true, avatarUrl: true } });
  data.assetChecklistJson = JSON.stringify({ brandFolder: !!client?.brandAssetsPath, colors: !!client?.brandColors, headshot: !!client?.avatarUrl });

  if (status !== ob.status) { data.status = status; actions.push(`${ob.status} → ${status}`); }
  if (Object.keys(data).length) await prisma.programOnboarding.update({ where: { id }, data });
  return { id, from, to: status, actions };
}

/** The "Gaps the draft could not fill" section, as items — explicit, never padded. */
function missingItemsFrom(sectionsJson: string): string[] {
  const stored = parseStoredSections(sectionsJson);
  const gaps = stored?.sections.find((s) => s.id === "gaps" || /^gaps the draft/i.test(s.heading));
  if (!gaps) return [];
  return gaps.text.split("\n").map((l) => l.replace(/^•\s*/, "").trim()).filter(Boolean).slice(0, 40);
}

/**
 * HOURLY, behind `strategy_generation`. Bookkeeping + enqueue only; the
 * generation runs in W1-C's STRATEGY_DRAFT handler under `transcript_jobs`
 * and `ai_runs`. Every enrollment with a discovery record or an onboarding
 * row is visited; the rest are untouched (no row is minted for the eleven
 * live clients who never had a discovery call).
 */
export async function sweepOnboarding(opts: { now?: Date; max?: number } = {}): Promise<{ skipped: string; reconciled?: number } | { checked: number; advanced: number; actions: string[]; reconciled: number }> {
  // The discovery-scheduling desk task is reconciled FIRST, outside the
  // switch. `strategy_generation` gates AI drafting and the money it spends;
  // it must not also decide whether Kyle's task list tells the truth about a
  // call that is already on the calendar (§4.3).
  const reconciled = await reconcileDiscoveryTasks(opts.max ?? 25);
  if (!(await isAutomationEnabled(ONBOARDING_KEY))) return { skipped: "strategy_generation is off", reconciled };
  const now = opts.now ?? new Date();
  const withRecord = await prisma.programOnboarding.findMany({ where: { status: { notIn: ["COMPLETE"] } }, select: { enrollmentId: true }, take: opts.max ?? 25 });
  const withDiscovery = await prisma.programCallRecord.findMany({ where: { callType: "BRAND_DISCOVERY", enrollmentId: { not: null } }, select: { enrollmentId: true }, distinct: ["enrollmentId"] });
  const ids = [...new Set([...withRecord.map((r) => r.enrollmentId), ...withDiscovery.map((r) => r.enrollmentId!).filter(Boolean)])].slice(0, opts.max ?? 25);
  const actions: string[] = [];
  let advanced = 0;
  let error: string | null = null;
  for (const enrollmentId of ids) {
    try {
      const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { status: true } });
      if (!e || e.status === "ENDED") continue;
      const r = await advanceOnboarding(enrollmentId, { now, enqueue: true, requestedBy: "onboarding-cron" });
      if (r.from !== r.to || r.actions.length) { advanced++; actions.push(`${enrollmentId}: ${r.actions.join("; ")}`); }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      actions.push(`${enrollmentId}: ERROR ${error}`);
    }
  }
  await recordAutomationRun(ONBOARDING_KEY, error);
  return { checked: ids.length, advanced, actions: actions.slice(0, 20), reconciled };
}

/**
 * Close every discovery-scheduling task whose booking has since appeared.
 * Cheap, unconditional, and independent of any switch: it reads open tasks
 * and the call records they are waiting on, and closes the ones that are done.
 * Opens nothing — raising a task is activation's job, so a sweep can never
 * invent desk work for a client who never paid.
 *
 * SCHEDULING KEYS ONLY. The §4.4 identity question lives under
 * IDENTITY_TASK_PREFIX precisely so that this loop cannot reach it: "a booking
 * exists" is the reason that question was asked, not an answer to it.
 */
export async function reconcileDiscoveryTasks(max = 25): Promise<number> {
  const open = await prisma.smartTask.findMany({
    where: { dedupeKey: { startsWith: DISCOVERY_TASK_PREFIX }, status: { notIn: TASK_DONE } },
    select: { dedupeKey: true },
    take: max,
  });
  let closed = 0;
  for (const t of open) {
    const enrollmentId = (t.dedupeKey ?? "").slice(DISCOVERY_TASK_PREFIX.length);
    if (!enrollmentId) continue;
    const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true } });
    if (!e) continue;
    const booking = await prisma.programCallRecord.findFirst({
      where: { callType: "BRAND_DISCOVERY", status: { notIn: ["CANCELLED"] }, OR: [{ enrollmentId }, { clientId: e.clientId }] },
      select: { id: true },
    });
    if (!booking) continue;
    await closeDiscoveryTask(enrollmentId);
    closed++;
  }
  return closed;
}

/**
 * Staff click: draft the strategy NOW from the confirmed discovery transcript.
 * A user action (unattended=false), so it runs while the switches are off;
 * the result is still a DRAFT that Jordan reviews.
 */
export async function draftStrategyNow(enrollmentId: string, by: string): Promise<{ versionId: string; versionNo: number; gaps: number }> {
  const { id } = await ensureOnboardingRecord(enrollmentId);
  const ob = await prisma.programOnboarding.findUnique({ where: { id } });
  const call = ob?.discoveryCallRecordId
    ? await prisma.programCallRecord.findUnique({ where: { id: ob.discoveryCallRecordId } })
    : await prisma.programCallRecord.findFirst({ where: { enrollmentId, callType: "BRAND_DISCOVERY", transcriptState: { in: ["CONFIRMED", "ANALYZED"] } }, orderBy: { scheduledStart: "desc" } });
  if (!call || !call.clientId) throw new Error("No brand-discovery call with a confirmed transcript is on file for this client.");
  if (call.callType !== "BRAND_DISCOVERY") throw new Error("Only a brand-discovery call drafts the strategy — a monthly call never replaces the brand foundation.");
  const sources = await prisma.programTranscriptSource.findMany({ where: { callRecordId: call.id, matchState: "CONFIRMED", text: { not: null } }, orderBy: { version: "desc" }, select: { text: true } });
  const transcript = sources.map((s) => s.text ?? "").filter(Boolean).join("\n\n----\n\n");
  if (transcript.trim().length < 200) throw new Error("The confirmed transcript is empty or a stub — paste or upload the real one first.");
  const r = await draftStrategyFromTranscript({ enrollmentId, clientId: call.clientId, transcript, callRecordId: call.id, intakeText: ob?.intakeJson ?? null, requestedBy: by, unattended: false });
  await prisma.programOnboarding.update({ where: { id }, data: { strategyDraftVersionId: r.versionId, strategyGenerationRunId: r.runId, status: rank(ob?.status ?? "NOT_STARTED") < rank("STRATEGY_DRAFTED") ? "STRATEGY_DRAFTED" : undefined } });
  await advanceOnboarding(enrollmentId, { enqueue: false, requestedBy: by });
  return { versionId: r.versionId, versionNo: r.versionNo, gaps: r.gaps };
}

/**
 * Release an APPROVED strategy version to the portal and queue the
 * "strategy ready" email (behind `script_share_email`). Approval itself is
 * W1-C's approveStrategyVersion — this never approves.
 */
export async function releaseStrategyToPortal(strategyVersionId: string, by: string): Promise<{ released: boolean; email: "queued" | "suppressed"; message: string }> {
  const v = await prisma.contentStrategyVersion.findUnique({ where: { id: strategyVersionId }, select: { enrollmentId: true, status: true, releasedAt: true } });
  if (!v) throw new Error("Strategy version not found.");
  if (v.status !== "APPROVED") throw new Error("Approve the version before releasing it.");
  if (!v.releasedAt) await releaseStrategyVersion(strategyVersionId, by);
  const notice = await queueStrategyReadyNotice({ enrollmentId: v.enrollmentId, strategyVersionId, by });
  await advanceOnboarding(v.enrollmentId, { enqueue: false, requestedBy: by }).catch(() => {});
  if (!notice) return { released: true, email: "suppressed", message: "Released to the portal. Email suppressed: script_share_email is off — launch is not authorised." };
  return { released: true, email: "queued", message: notice.created ? "Released to the portal; the 'strategy ready' email is queued." : "Released to the portal; the email was already queued." };
}

export type OnboardingView = {
  id: string; status: string; discoveryRequired: boolean; waived: { at: Date; by: string | null; reason: string | null } | null;
  call: { id: string; status: string; scheduledStart: Date | null; transcriptState: string } | null;
  draft: { id: string; versionNo: number; status: string; createdAt: Date } | null;
  approved: { id: string; versionNo: number; approvedAt: Date | null; releasedAt: Date | null } | null;
  missingItems: string[]; assets: Record<string, boolean>; lastError: string | null;
};

export async function onboardingView(enrollmentId: string): Promise<OnboardingView | null> {
  const ob = await prisma.programOnboarding.findUnique({ where: { enrollmentId } });
  if (!ob) return null;
  const [call, draft, approved] = await Promise.all([
    ob.discoveryCallRecordId ? prisma.programCallRecord.findUnique({ where: { id: ob.discoveryCallRecordId }, select: { id: true, status: true, scheduledStart: true, transcriptState: true } }) : null,
    ob.strategyDraftVersionId ? prisma.contentStrategyVersion.findUnique({ where: { id: ob.strategyDraftVersionId }, select: { id: true, versionNo: true, status: true, createdAt: true } }) : null,
    ob.strategyApprovedVersionId ? prisma.contentStrategyVersion.findUnique({ where: { id: ob.strategyApprovedVersionId }, select: { id: true, versionNo: true, approvedAt: true, releasedAt: true } }) : null,
  ]);
  let missing: string[] = [];
  let assets: Record<string, boolean> = {};
  try { missing = JSON.parse(ob.missingItemsJson ?? "[]") as string[]; } catch { missing = []; }
  try { assets = JSON.parse(ob.assetChecklistJson ?? "{}") as Record<string, boolean>; } catch { assets = {}; }
  return {
    id: ob.id, status: ob.status, discoveryRequired: ob.discoveryRequired,
    waived: ob.discoveryWaivedAt ? { at: ob.discoveryWaivedAt, by: ob.discoveryWaivedBy, reason: ob.discoveryWaivedReason } : null,
    call, draft, approved, missingItems: missing, assets, lastError: ob.lastError,
  };
}
