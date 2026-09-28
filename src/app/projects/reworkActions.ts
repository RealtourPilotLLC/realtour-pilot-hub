"use server";

import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";

// Rework cost entry (§10 AU-26, Sep 26) — OWNER ONLY, like every figure on the
// job's money panel. Evidence is picked from what the hub already holds; the
// hub never attaches a refund or credit on its own, and nothing here writes to
// Stripe, QuickBooks or Aryeo.

export type ReworkActionResult = { ok: boolean; message: string };

async function actor(): Promise<string> {
  const me = await getCurrentUser().catch(() => null);
  return me?.email ?? "local-dev";
}

export async function addReworkCostAction(input: {
  projectId: string;
  kind: string;
  amount: string | number;
  basis: string;
  evidenceRef: string;
  issueCause?: string | null;
  note?: string | null;
}): Promise<ReworkActionResult> {
  await requireOwner();
  const dollars = typeof input.amount === "number" ? input.amount : Number(String(input.amount).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(dollars) || dollars <= 0) return { ok: false, message: "Enter the amount in dollars." };
  const { addReworkCost } = await import("@/lib/reworkCost");
  const r = await addReworkCost({
    projectId: input.projectId,
    kind: input.kind,
    amountCents: Math.round(dollars * 100),
    basis: input.basis,
    evidenceRef: input.evidenceRef,
    issueCause: input.issueCause || null,
    note: input.note ?? null,
    enteredBy: await actor(),
  });
  revalidatePath(`/projects/${input.projectId}`);
  return { ok: r.ok, message: r.message };
}

export async function voidReworkCostAction(projectId: string, id: string): Promise<ReworkActionResult> {
  await requireOwner();
  const { prisma } = await import("@/lib/prisma");
  // The row must belong to the job the panel is showing — an id from another
  // job is refused rather than voided out of sight.
  const row = await prisma.reworkCost.findUnique({ where: { id }, select: { projectId: true } });
  if (!row || row.projectId !== projectId) return { ok: false, message: "That row isn't on this job." };
  const { voidReworkCost } = await import("@/lib/reworkCost");
  const r = await voidReworkCost(id, await actor());
  revalidatePath(`/projects/${projectId}`);
  return r;
}
