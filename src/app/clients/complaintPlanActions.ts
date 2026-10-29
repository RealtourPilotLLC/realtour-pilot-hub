"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { authEnforced, requireCreativeLead } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { canSeeMoney } from "@/lib/auth/access";
import { displayNameFor } from "@/lib/actorName";
import type { Actor } from "@/lib/delegation";
import type { OpenComplaint, PlanView, StepInput } from "@/lib/clientIssuePlan";

// ---------------------------------------------------------------------------
// A COMPLAINT'S PLAN: the writes and the reads its panel makes (Oct 29 2026,
// lib/clientIssuePlan). The owner, the office (Kyle) and the creative manager
// (James) all work the same complaint: "I'd want Kyle to have these options
// too. James also needs to be able to see this as well since he is the
// creative manager. All of our accounts should work in tandem on it though
// and when one of us updates something, it reflects those changes for
// everyone." One record, read fresh on every load; the panel re-reads it
// while it is open. A "view as" preview writes nothing; anyone but the owner
// reads it money-scrubbed.
// ---------------------------------------------------------------------------

type Result = { ok: boolean; message: string };
const ID = /^[a-z0-9]{10,40}$/i;

type Seat = { ok: true; actor: Actor; by: string; scrub: boolean } | { ok: false; message: string };

async function seat(): Promise<Seat> {
  try { await requireCreativeLead(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const me = await getCurrentUser().catch(() => null);
  const { LOCAL_OWNER_ACTOR, actorFor } = await import("@/lib/delegation");
  if (!me) return authEnforced() ? { ok: false, message: "Please sign in to do that." } : { ok: true, actor: LOCAL_OWNER_ACTOR, by: "Jordan", scrub: false };
  const actor = await actorFor(me);
  return { ok: true, actor, by: (await displayNameFor(me)) ?? me.name ?? me.email, scrub: !canSeeMoney(me.role) };
}

/** Reads allow the owner's "view as" preview (it writes nothing). */
async function readSeat(): Promise<{ ok: true; scrub: boolean; keys: Set<string> } | { ok: false; message: string }> {
  try { await requireCreativeLead(); } catch {
    // requireRole refuses a preview; a preview may still read, as the person it shows.
    const me = await getCurrentUser().catch(() => null);
    if (!me?.impersonating || !["OWNER", "ADMIN", "CREATIVE_MANAGER"].includes(me.role)) return { ok: false, message: "You don't have access to this." };
  }
  const me = await getCurrentUser().catch(() => null);
  if (!me) return authEnforced() ? { ok: false, message: "Please sign in." } : { ok: true, scrub: false, keys: new Set(["jordan"]) };
  const { addressableKeys } = await import("@/lib/auth/guards");
  const keys = await addressableKeys(me).catch(() => new Set<string>());
  return { ok: true, scrub: !canSeeMoney(me.role), keys };
}

async function revalidateFor(issueId: string | null | undefined) {
  if (issueId) {
    const row = await prisma.clientIssue.findUnique({ where: { id: issueId }, select: { clientId: true } }).catch(() => null);
    if (row?.clientId) revalidatePath(`/clients/${row.clientId}`);
  }
  for (const p of ["/", "/quality", "/tasks"]) revalidatePath(p);
}

// ---- reads ---------------------------------------------------------------------------

export async function loadComplaintPlanAction(issueId: string): Promise<{ ok: true; plan: PlanView } | { ok: false; message: string }> {
  const s = await readSeat();
  if (!s.ok) return s;
  if (!ID.test(issueId ?? "")) return { ok: false, message: "That complaint isn't there." };
  const { loadPlan } = await import("@/lib/clientIssuePlan");
  const plan = await loadPlan(issueId, { scrubMoney: s.scrub });
  return plan ? { ok: true, plan } : { ok: false, message: "That complaint isn't there any more." };
}

export async function listOpenComplaintsAction(): Promise<{ ok: true; rows: OpenComplaint[] } | { ok: false; message: string }> {
  const s = await readSeat();
  if (!s.ok) return s;
  const { openComplaintPlans } = await import("@/lib/clientIssuePlan");
  return { ok: true, rows: await openComplaintPlans({ scrubMoney: s.scrub, myKeys: s.keys }) };
}

// ---- the hub's draft ---------------------------------------------------------------------

export async function draftComplaintPlanAction(issueId: string, opts: { force?: boolean } = {}): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(issueId ?? "")) return { ok: false, message: "That complaint isn't there." };
  const { draftPlan } = await import("@/lib/clientIssuePlan");
  const r = await draftPlan(issueId, s.by, { force: opts.force === true });
  await revalidateFor(issueId);
  return r;
}

export async function dismissComplaintDraftAction(issueId: string): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  const { dismissDraft } = await import("@/lib/clientIssuePlan");
  const r = await dismissDraft(issueId, s.by);
  await revalidateFor(issueId);
  return r;
}

export async function approveComplaintDraftAction(issueId: string, input: { summary?: string | null; steps: StepInput[] }): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(issueId ?? "") || !Array.isArray(input?.steps) || input.steps.length > 12) return { ok: false, message: "That plan can't be read." };
  const { approveDraft } = await import("@/lib/clientIssuePlan");
  const r = await approveDraft(s.actor, issueId, { summary: input.summary ?? null, steps: input.steps.map(cleanStep) });
  await revalidateFor(issueId);
  return r;
}

export async function saveComplaintSummaryAction(issueId: string, summary: string): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  const { saveSummary } = await import("@/lib/clientIssuePlan");
  const r = await saveSummary(issueId, String(summary ?? ""), s.by);
  await revalidateFor(issueId);
  return r;
}

// ---- steps ---------------------------------------------------------------------------------

function cleanStep(x: StepInput): StepInput {
  return {
    text: String(x?.text ?? ""),
    ownerKey: String(x?.ownerKey ?? ""),
    dueISO: typeof x?.dueISO === "string" && x.dueISO ? x.dueISO : null,
    kind: x?.kind === "coach" || x?.kind === "prefs" ? x.kind : "task",
    alreadyDone: typeof x?.alreadyDone === "string" && x.alreadyDone.trim() ? x.alreadyDone : null,
  };
}

export async function addComplaintStepAction(issueId: string, input: StepInput): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(issueId ?? "")) return { ok: false, message: "That complaint isn't there." };
  const { addStep } = await import("@/lib/clientIssuePlan");
  const r = await addStep(s.actor, issueId, cleanStep(input));
  await revalidateFor(issueId);
  return { ok: r.ok, message: r.message };
}

export async function completeComplaintStepAction(stepId: string, note?: string | null): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(stepId ?? "")) return { ok: false, message: "That step isn't there." };
  const { completeStep } = await import("@/lib/clientIssuePlan");
  const r = await completeStep(s.actor, stepId, note ?? null);
  await revalidateFor(r.issueId);
  return { ok: r.ok, message: r.message };
}

export async function removeComplaintStepAction(stepId: string, why: string): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(stepId ?? "")) return { ok: false, message: "That step isn't there." };
  const { removeStep } = await import("@/lib/clientIssuePlan");
  const r = await removeStep(s.actor, stepId, String(why ?? ""));
  await revalidateFor(r.issueId);
  return { ok: r.ok, message: r.message };
}

// ---- preferences and the KPI tracker ---------------------------------------------------------

export async function addComplaintPrefsAction(issueId: string, text: string): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(issueId ?? "")) return { ok: false, message: "That complaint isn't there." };
  const { addPrefsToNotes } = await import("@/lib/clientIssuePlan");
  const r = await addPrefsToNotes(issueId, String(text ?? ""), s.by);
  await revalidateFor(issueId);
  return r;
}

export async function addComplaintToKpiAction(issueId: string, input: { memberId: string; area: string; points: number; title: string; note: string }): Promise<Result> {
  const s = await seat();
  if (!s.ok) return s;
  if (!ID.test(issueId ?? "") || !ID.test(input?.memberId ?? "")) return { ok: false, message: "Pick who it goes on." };
  const { addToKpi } = await import("@/lib/clientIssuePlan");
  const r = await addToKpi(issueId, { memberId: input.memberId, area: String(input.area ?? ""), points: Number(input.points), title: String(input.title ?? ""), note: String(input.note ?? "") }, s.by);
  if (r.ok) { revalidatePath("/sales"); revalidatePath("/my-pay"); }
  await revalidateFor(issueId);
  return r;
}
