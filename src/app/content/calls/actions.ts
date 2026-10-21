"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import {
  assignStrategyCall, unassignStrategyCall, ignoreStrategyCall, syncCallRecordsFromCalendly,
  confirmCallRecordClient, setCallRecordTargetMonth, verifyClientEmailAlias, dismissClientEmailAlias, confirmTranscriptSource, rejectTranscriptSource,
} from "@/lib/contentCallRecords";
import { DESK_LOOK_AHEAD_DAYS, DESK_LOOK_BACK_DAYS } from "@/lib/strategyCallDesk";

// ---------------------------------------------------------------------------
// Content → Strategy calls (Oct 6 2026). Owner or admin. Each action is one
// explicit staff decision on one call; nothing here messages a client, writes
// to Calendly or touches a booking. The page updates optimistically and only
// reads these results to confirm (or roll back) what it already shows.
//
// ONE CALL QUEUE (Jordan, Oct 21 2026; audit D12). Monitoring carried a second
// queue that filed calls on clients by its own rules. Its questions (who was
// on a call the matcher could not place, an email address proposed as a
// client's, a transcript with no call) are answered on this page now, by the
// actions below, and a call is set aside through ignoreStrategyCallAction
// alone: a reason is required and a brand discovery call is refused.
// Permissions are as they were on Monitoring: owner or admin, and re-queuing
// a failed transcript job is the owner's.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string; monthStatus?: string | null };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function who(): Promise<string> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}
function touch() {
  revalidatePath("/content/calls");
  revalidatePath("/content");
}

export async function assignStrategyCallAction(recordId: string, clientId: string, monthKey: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!clientId) return { ok: false, message: "Pick a client." };
  try {
    const r = await assignStrategyCall(recordId, { clientId, monthKey }, await who());
    touch();
    return { ok: true, message: `Filed on ${monthKey}.`, monthStatus: r.strategyCallStatus };
  } catch (e) { return fail(e); }
}

export async function unassignStrategyCallAction(recordId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await unassignStrategyCall(recordId, await who()); touch(); return { ok: true, message: "Unassigned — the month is back as it was." }; }
  catch (e) { return fail(e); }
}

/**
 * Oct 20 2026 (audit D12): ONE RULE for setting a call aside — a reason is
 * required (kept on the record), and a brand discovery call is never set
 * aside from a program-call queue (ignoreStrategyCall refuses it). Since
 * Oct 21 2026 this is the only set-aside: the review section below the desk
 * uses it too.
 */
export async function ignoreStrategyCallAction(recordId: string, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  const why = typeof note === "string" ? note.trim() : "";
  if (!why) return { ok: false, message: "Say why it is being set aside — an unexplained dismissal is how a real call gets lost." };
  try { await ignoreStrategyCall(recordId, await who(), why.slice(0, 500)); touch(); return { ok: true, message: "Set aside as not a program call, with your note on the record." }; }
  catch (e) { return fail(e); }
}

/**
 * Re-read Calendly for the page's window (30 days back, 14 ahead) through the
 * hourly sync's own path: upserts call records, files verified clients, never
 * messages anyone. The one-off backfill for calls booked before the generic
 * type was mapped.
 */
export async function refreshStrategyCallsAction(): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    const r = await syncCallRecordsFromCalendly({ lookBackDays: DESK_LOOK_BACK_DAYS, lookAheadDays: DESK_LOOK_AHEAD_DAYS });
    touch();
    if ("skipped" in r) return { ok: false, message: r.skipped };
    return { ok: r.errors === 0, message: `Read ${r.scanned} bookings: ${r.created} new, ${r.updated} updated, ${r.matched} on a client${r.errors ? `, ${r.errors} failed (${r.lastError})` : ""}.` };
  } catch (e) { return fail(e); }
}

// ---- the review questions (moved from Monitoring, Oct 21 2026) ---------------
// Each RESOLVES AN AMBIGUITY A MACHINE REFUSED TO GUESS: which client a call
// belongs to, whether an email address really is theirs, whether a transcript
// document is the one from that call, which month a call was planning. Each is
// explicit, attributable and logged by the library it calls; there is no "fix
// all" and no bulk anything.

export async function confirmCallClientAction(recordId: string, clientId: string, alsoVerifyEmail: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    await confirmCallRecordClient(recordId, clientId, await who(), { verifyInviteeEmailAsAlias: alsoVerifyEmail });
    touch();
    return { ok: true, message: alsoVerifyEmail ? "Matched, and that address is now a verified alias for them." : "Matched to that client." };
  } catch (e) { return fail(e); }
}

export async function setCallMonthAction(recordId: string, monthKey: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return { ok: false, message: "Pick a month." };
  try { await setCallRecordTargetMonth(recordId, monthKey, await who()); touch(); return { ok: true, message: `Recorded as planning ${monthKey}.` }; }
  catch (e) { return fail(e); }
}

export async function verifyAliasAction(aliasId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await verifyClientEmailAlias(aliasId, await who()); touch(); return { ok: true, message: "Verified. Calls from that address match this client from now on." }; }
  catch (e) { return fail(e); }
}

export async function dismissAliasAction(aliasId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await dismissClientEmailAlias(aliasId); touch(); return { ok: true, message: "Dismissed. It will not be proposed again." }; }
  catch (e) { return fail(e); }
}

export async function confirmTranscriptAction(sourceId: string, recordId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await confirmTranscriptSource(sourceId, recordId, await who()); touch(); return { ok: true, message: "Linked to that call." }; }
  catch (e) { return fail(e); }
}

export async function rejectTranscriptAction(sourceId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await rejectTranscriptSource(sourceId, await who()); touch(); return { ok: true, message: "Rejected. It stays on file, unlinked." }; }
  catch (e) { return fail(e); }
}

/** Owner-only: re-queue a transcript job that failed. */
export async function retryTranscriptJobAction(jobId: string): Promise<Result> {
  try { await requireOwner(); } catch (e) { return fail(e); }
  try {
    const { prisma } = await import("@/lib/prisma");
    const { isAutomationEnabled } = await import("@/lib/programAutomation");
    const job = await prisma.programTranscriptJob.findUnique({ where: { id: jobId }, select: { state: true } });
    if (!job) return { ok: false, message: "That job no longer exists." };
    if (job.state !== "FAILED" && job.state !== "NEEDS_REVIEW") return { ok: false, message: "Only a failed job (or one handed back for review) can be re-queued." };
    await prisma.programTranscriptJob.update({ where: { id: jobId }, data: { state: "QUEUED", leaseUntil: null, leaseBy: null, nextAttemptAt: null, reviewReason: null } });
    touch();
    revalidatePath("/content/monitoring");
    // Honest about what re-queuing does while the switch is off: nothing yet.
    const on = await isAutomationEnabled("transcript_jobs");
    return { ok: true, message: on ? "Re-queued. The next sweep will pick it up." : "Re-queued. The transcript_jobs switch is off, so it will sit in the queue until somebody turns it on." };
  } catch (e) { return fail(e); }
}
