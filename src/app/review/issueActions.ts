"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireCutReviewer } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import type { IssueActor } from "@/lib/revisionIssues";

// ---------------------------------------------------------------------------
// THE REVIEWER'S HAND ON REVISION ISSUES (unified handoff §8.3, Sep 25).
//
// "James or the covering reviewer confirms classifications. AI can suggest,
// not silently judge fault. Split mixed-cause requests." Every door here is
// the review desk's — requireCutReviewer: owner/admin, or a named review seat
// (§8.1) — and every change is an event with who and when, so a classification
// stays correctable and the KPIs re-score from the current value. The editor's
// half (marking a fix done) is their self-check, not a button here. Nothing in
// this file touches pay, bonus, QC reopen dials or the client's billable rounds.
// ---------------------------------------------------------------------------

async function desk(issueId?: string): Promise<{ ok: true; actor: IssueActor } | { ok: false; message: string }> {
  try {
    await requireCutReviewer();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  // Nobody classifies, verifies or clears an issue on their own version — it
  // is the number their own quality card is scored on (review fix, Sep 25).
  if (issueId) {
    const i = await prisma.revisionIssue.findUnique({ where: { id: issueId }, select: { versionEditorKey: true } }).catch(() => null);
    const { refuseOwnWork } = await import("@/lib/reviewerAssignment");
    const own = refuseOwnWork(await getCurrentUser().catch(() => null), i?.versionEditorKey ?? null, "issue");
    if (own) return { ok: false, message: own };
  }
  const me = await getCurrentUser().catch(() => null);
  return { ok: true, actor: { name: me?.name ?? me?.email ?? "Reviewer", userId: me?.id ?? null } };
}

async function refreshIssue(id: string): Promise<void> {
  const i = await prisma.revisionIssue.findUnique({ where: { id }, select: { projectId: true } }).catch(() => null);
  if (i) {
    revalidatePath(`/edit/${i.projectId}`);
    revalidatePath(`/review/${i.projectId}`);
  }
  revalidatePath("/quality");
}

export async function classifyIssueAction(
  id: string,
  input: { cause: string; note?: string | null; severity?: string | null; category?: string | null; reviewMiss?: boolean | null },
): Promise<{ ok: boolean; message: string }> {
  const who = await desk(id);
  if (!who.ok) return who;
  const { classifyIssue } = await import("@/lib/revisionIssues");
  const r = await classifyIssue(id, input, who.actor);
  if (r.ok) await refreshIssue(id);
  return r;
}

export async function markIssueNotNeededAction(id: string, reason: string): Promise<{ ok: boolean; message: string }> {
  const who = await desk(id);
  if (!who.ok) return who;
  const { markIssueNotApplicable } = await import("@/lib/revisionIssues");
  const r = await markIssueNotApplicable(id, String(reason ?? ""), who.actor);
  if (r.ok) await refreshIssue(id);
  return r;
}

export async function verifyIssueAction(id: string): Promise<{ ok: boolean; message: string }> {
  const who = await desk(id);
  if (!who.ok) return who;
  const { verifyIssues } = await import("@/lib/revisionIssues");
  const i = await prisma.revisionIssue.findUnique({ where: { id }, select: { addressedInSubmissionId: true } });
  const n = await verifyIssues([id], i?.addressedInSubmissionId ?? null, who.actor);
  await refreshIssue(id);
  return n ? { ok: true, message: "Verified." } : { ok: false, message: "Only a fix the editor marked done can be verified." };
}

export async function reopenIssueAction(id: string, note?: string | null): Promise<{ ok: boolean; message: string }> {
  const who = await desk(id);
  if (!who.ok) return who;
  const { reopenIssue } = await import("@/lib/revisionIssues");
  const r = await reopenIssue(id, who.actor, typeof note === "string" ? note : null);
  if (r.ok) await refreshIssue(id);
  return r;
}

export async function mergeIssueAction(id: string, intoId: string): Promise<{ ok: boolean; message: string }> {
  const who = await desk(id);
  if (!who.ok) return who;
  const { mergeDuplicate } = await import("@/lib/revisionIssues");
  const r = await mergeDuplicate(id, intoId, who.actor);
  if (r.ok) await refreshIssue(id);
  return r;
}

export async function splitIssueAction(id: string, parts: string[]): Promise<{ ok: boolean; message: string }> {
  const who = await desk(id);
  if (!who.ok) return who;
  const { splitIssue } = await import("@/lib/revisionIssues");
  const r = await splitIssue(id, Array.isArray(parts) ? parts.map(String) : [], who.actor);
  if (r.ok) await refreshIssue(id);
  return { ok: r.ok, message: r.message };
}
