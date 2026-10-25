"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { displayNameFor } from "@/lib/actorName";
import { isClientIssueState } from "@/lib/clientIssuesCore";
import { isEntitlementKind } from "@/lib/entitlementsCore";

// ---------------------------------------------------------------------------
// The client file's three new cards (Oct 15 2026): the creative guardrails
// (lib/creativeGuard.ts), the entitlement ledger (lib/entitlements.ts) and the
// complaint record (lib/clientIssues.ts). Owner and office write the ledger
// and the complaints; the guardrails are the owner's, the office's or the
// creative approver's (James). A "view as" preview writes nothing.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };

async function who(): Promise<string | null> {
  const u = await getCurrentUser().catch(() => null);
  return u ? (await displayNameFor(u)) ?? u.email : null;
}

async function office(): Promise<Result | null> {
  try { await requireAdmin(); return null; } catch (e) { return { ok: false, message: (e as Error).message }; }
}

/** "2026-10-20" → 5 PM ET that day; anything else as a date. */
async function dueFrom(v: string | null | undefined): Promise<Date | null> {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { const { etAt } = await import("@/lib/datetime"); return etAt(v, 17); }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function revalidateClient(clientId: string | null | undefined) {
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

// ---- creative guardrails -----------------------------------------------------

export async function saveCreativeGuard(input: { enrollmentId: string; provenFormats?: string[]; experimentCap?: number | null; addDiscontinued?: { name: string; reason?: string | null } | null; removeDiscontinued?: string | null }): Promise<Result> {
  const me = await getCurrentUser().catch(() => null);
  if (me?.impersonating) return { ok: false, message: "You're previewing another user — exit the preview to make changes." };
  const refused = await office();
  if (refused) {
    const { isCreativeApprover } = await import("@/lib/reviewChecklist");
    if (!(await isCreativeApprover(me, { authEnforced: authEnforced() }))) return refused;
  }
  const { setCreativeGuard } = await import("@/lib/creativeGuard");
  const r = await setCreativeGuard(input.enrollmentId, {
    provenFormats: input.provenFormats, experimentCap: input.experimentCap, addDiscontinued: input.addDiscontinued ?? null, removeDiscontinued: input.removeDiscontinued ?? null,
  }, await who());
  if (r.ok) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(e?.clientId);
  }
  return { ok: r.ok, message: r.message };
}

// ---- entitlements -------------------------------------------------------------

export async function addEntitlementAction(input: { enrollmentId: string; kind: string; qty?: number; monthKey?: string | null; targetMonthKey?: string | null; description: string; agreedBy?: string | null; source?: string | null; sourceRef?: string | null }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  if (!isEntitlementKind(input.kind)) return { ok: false, message: "Pick what was agreed." };
  const { addEntitlement } = await import("@/lib/entitlements");
  const r = await addEntitlement({ ...input, createdBy: await who() });
  if (r.ok) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(e?.clientId);
  }
  return { ok: r.ok, message: r.message };
}

export async function changeEntitlementAction(input: { id: string; to: "OPEN" | "SCHEDULED" | "FULFILLED" | "VOID"; note?: string | null }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  const { voidEntitlement, setEntitlementState } = await import("@/lib/entitlements");
  const by = await who();
  const r = input.to === "VOID" ? await voidEntitlement(input.id, by, input.note ?? "") : await setEntitlementState(input.id, input.to, by, input.note ?? null);
  if (r.ok) {
    const row = await prisma.programEntitlement.findUnique({ where: { id: input.id }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(row?.clientId);
  }
  return r;
}

export async function setTermAction(input: { enrollmentId: string; termStartMonth: string | null; termEndMonth: string | null }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  const { setTerm } = await import("@/lib/entitlements");
  const r = await setTerm(input.enrollmentId, { termStartMonth: input.termStartMonth || null, termEndMonth: input.termEndMonth || null }, await who());
  if (r.ok) {
    const e = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(e?.clientId);
  }
  return r;
}

// ---- complaints --------------------------------------------------------------

export async function createClientIssueAction(input: { clientId: string; title: string; whatHappened: string; source?: string | null; impact?: string | null; cause?: string | null; ownerKey?: string | null; ownerName?: string | null; dueISO?: string | null; projectIds?: string[] }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  const { createClientIssue } = await import("@/lib/clientIssues");
  const r = await createClientIssue({ ...input, dueAt: await dueFrom(input.dueISO), createdBy: await who() });
  if (r.ok) { await revalidateClient(input.clientId); revalidatePath("/quality"); }
  return { ok: r.ok, message: r.message };
}

export async function updateClientIssueAction(input: { id: string; impact?: string | null; cause?: string | null; correction?: string | null; processChange?: string | null; ownerKey?: string | null; ownerName?: string | null; dueISO?: string | null }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  const { updateClientIssue } = await import("@/lib/clientIssues");
  const due = input.dueISO === undefined ? undefined : await dueFrom(input.dueISO);
  const r = await updateClientIssue(input.id, {
    impact: input.impact, cause: input.cause, correction: input.correction, processChange: input.processChange, ownerKey: input.ownerKey, ownerName: input.ownerName,
    ...(due === undefined ? {} : { dueAt: due }),
  }, await who());
  if (r.ok) {
    const row = await prisma.clientIssue.findUnique({ where: { id: input.id }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(row?.clientId); revalidatePath("/quality");
  }
  return r;
}

export async function moveClientIssueAction(input: { id: string; to: string; correction?: string | null; processChange?: string | null; note?: string | null }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  if (!isClientIssueState(input.to)) return { ok: false, message: "That isn't a step." };
  const { moveClientIssue } = await import("@/lib/clientIssues");
  const r = await moveClientIssue(input.id, input.to, { by: await who(), correction: input.correction, processChange: input.processChange, note: input.note });
  if (r.ok) {
    const row = await prisma.clientIssue.findUnique({ where: { id: input.id }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(row?.clientId); revalidatePath("/quality");
  }
  return r;
}

export async function dismissClientIssueAction(input: { id: string; reason: string }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  const { dismissClientIssue } = await import("@/lib/clientIssues");
  const r = await dismissClientIssue(input.id, input.reason, await who());
  if (r.ok) {
    const row = await prisma.clientIssue.findUnique({ where: { id: input.id }, select: { clientId: true } }).catch(() => null);
    await revalidateClient(row?.clientId); revalidatePath("/quality");
  }
  return r;
}

// ---- client issue signals (Jordan's dashboard, Oct 24 2026) --------------------

/** Close a signal on the Client issues card (lib/issueSignals): repeated revision
 *  rounds with the client's answer and the cause, or a one-line decision. */
export async function closeIssueSignalAction(input: { rowId: string; outcome: string; cause?: string | null; note?: string | null }): Promise<Result> {
  const refused = await office();
  if (refused) return refused;
  if (!["HAPPY", "COMPLAINT", "DONE"].includes(input.outcome)) return { ok: false, message: "That isn't a way to close it." };
  const me = await getCurrentUser().catch(() => null);
  const { LOCAL_OWNER_ACTOR, actorFor } = await import("@/lib/delegation");
  const actor = me ? await actorFor(me).catch(() => null) : authEnforced() ? null : LOCAL_OWNER_ACTOR;
  const { closeIssueSignal } = await import("@/lib/issueSignals");
  const r = await closeIssueSignal({ rowId: input.rowId, outcome: input.outcome as "HAPPY" | "COMPLAINT" | "DONE", cause: input.cause, note: input.note }, { name: await who(), email: me?.email ?? null, actor });
  if (r.ok) {
    for (const p of ["/", "/tasks", "/quality"]) revalidatePath(p);
    await revalidateClient(r.clientId);
  }
  return { ok: r.ok, message: r.message };
}
