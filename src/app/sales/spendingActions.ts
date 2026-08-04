"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

// Owner-only re-tagging for the Categories tab. Every hand-tag sets
// financeLocked=true so the nightly auto-categorizer never overwrites the
// owner's decision. See src/lib/financeCategories.ts.

const KINDS = new Set(["BUSINESS", "PERSONAL", "EXCLUDE", "REVIEW"]);

/** Move an ENTIRE category to a different kind (business ↔ personal ↔ exclude). */
export async function retagCategoryAction(category: string, toKind: string) {
  await requireOwner();
  if (!KINDS.has(toKind)) throw new Error("Bad kind");
  await prisma.plaidTransaction.updateMany({
    where: { financeCategory: category },
    data: { financeKind: toKind, financeLocked: true },
  });
  revalidatePath("/sales");
}

/** Re-tag a SINGLE transaction (kind, and optionally move it to another category). */
export async function retagTxnAction(id: string, toKind: string, toCategory?: string) {
  await requireOwner();
  if (!KINDS.has(toKind)) throw new Error("Bad kind");
  await prisma.plaidTransaction.update({
    where: { id },
    data: { financeKind: toKind, financeLocked: true, ...(toCategory ? { financeCategory: toCategory } : {}) },
  });
  revalidatePath("/sales");
}

/** Re-tag MANY transactions at once (bulk select → move to a category). */
export async function retagTxnsBulkAction(ids: string[], toKind: string, toCategory?: string) {
  await requireOwner();
  if (!KINDS.has(toKind)) throw new Error("Bad kind");
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new Error("Bad selection");
  await prisma.plaidTransaction.updateMany({
    where: { id: { in: ids } },
    data: { financeKind: toKind, financeLocked: true, ...(toCategory ? { financeCategory: toCategory } : {}) },
  });
  revalidatePath("/sales");
}

/** The transactions inside one category (for the drill-in), biggest first. */
export async function fetchCategoryTxnsAction(category: string, startKey: string, endKey: string) {
  await requireOwner();
  const from = new Date(`${startKey}T00:00:00Z`);
  const to = new Date(`${endKey}T23:59:59Z`);
  const rows = await prisma.plaidTransaction.findMany({
    where: { financeCategory: category, amount: { gt: 0 }, date: { gte: from, lte: to } },
    orderBy: { amount: "desc" },
    take: 250,
    select: { id: true, name: true, amount: true, date: true, financeKind: true, financeLocked: true },
  });
  return rows.map((r) => ({
    id: r.id, name: r.name ?? "—", amount: r.amount,
    date: r.date.toISOString().slice(0, 10), kind: r.financeKind ?? "REVIEW", locked: r.financeLocked,
  }));
}

/** Re-run the auto-categorizer (leaves any hand-locked rows untouched). */
export async function recategorizeAllAction() {
  await requireOwner();
  const { categorizeAllPlaid } = await import("@/lib/financeCategories");
  await categorizeAllPlaid();
  revalidatePath("/sales");
}
