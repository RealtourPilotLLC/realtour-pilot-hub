"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireOwner } from "@/lib/auth/guards";
import {
  confirmCallRecordClient, ignoreCallRecord, setCallRecordTargetMonth,
  verifyClientEmailAlias, dismissClientEmailAlias, confirmTranscriptSource, rejectTranscriptSource,
} from "@/lib/contentCallRecords";

// ---------------------------------------------------------------------------
// The monitoring page's write surface (spec §13/§20/§24).
//
// Every action here RESOLVES AN AMBIGUITY A MACHINE REFUSED TO GUESS: which
// client a call belongs to, whether an email address really is theirs, whether
// a transcript document is the one from that call, which month a call was
// planning. Each is explicit, attributable and logged by the library it calls
// — there is no "fix all", no bulk anything, and nothing here decides an
// ownership question on its own.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const fail = (e: unknown): Result => ({ ok: false, message: e instanceof Error ? e.message : "Something went wrong." });

async function who(): Promise<string> {
  const { getCurrentUser } = await import("@/lib/auth/user");
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "dev@local";
}
function touch() {
  revalidatePath("/content/monitoring");
  revalidatePath("/content");
}

export async function confirmCallClientAction(recordId: string, clientId: string, alsoVerifyEmail: boolean): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try {
    await confirmCallRecordClient(recordId, clientId, await who(), { verifyInviteeEmailAsAlias: alsoVerifyEmail });
    touch();
    return { ok: true, message: alsoVerifyEmail ? "Matched, and that address is now a verified alias for them." : "Matched to that client." };
  } catch (e) { return fail(e); }
}

export async function ignoreCallAction(recordId: string, note: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!note.trim()) return { ok: false, message: "Say why it is being set aside — an unexplained dismissal is how a real call gets lost." };
  try { await ignoreCallRecord(recordId, await who(), note.trim()); touch(); return { ok: true, message: "Set aside, with your note on the record." }; }
  catch (e) { return fail(e); }
}

export async function setCallMonthAction(recordId: string, monthKey: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return { ok: false, message: "Pick a month." };
  try { await setCallRecordTargetMonth(recordId, monthKey, await who()); touch(); return { ok: true, message: `Recorded as planning ${monthKey}.` }; }
  catch (e) { return fail(e); }
}

export async function verifyAliasAction(aliasId: string): Promise<Result> {
  try { await requireAdmin(); } catch (e) { return fail(e); }
  try { await verifyClientEmailAlias(aliasId, await who()); touch(); return { ok: true, message: "Verified — calls from that address match this client from now on." }; }
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
  try { await rejectTranscriptSource(sourceId, await who()); touch(); return { ok: true, message: "Rejected — it stays on file, unlinked." }; }
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
    // Honest about what re-queuing does while the switch is off: nothing yet.
    const on = await isAutomationEnabled("transcript_jobs");
    return { ok: true, message: on ? "Re-queued — the next sweep will pick it up." : "Re-queued. The transcript_jobs switch is off, so it will sit in the queue until somebody turns it on." };
  } catch (e) { return fail(e); }
}
