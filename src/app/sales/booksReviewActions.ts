"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

// The QuickBooks review desk (audit Aug 25: the classifier wrote careful
// plain-English reviewNotes for 60 flagged rows and NO screen ever rendered
// them — only 6 rows had ever been reviewed, via the database). These actions
// annotate OUR ledger copy only; QuickBooks itself stays read-only.

export type FlaggedQboRow = {
  id: string;
  txnDate: string;
  type: string;
  amount: number;
  customerName: string | null;
  accountName: string | null;
  memo: string | null;
  category: string | null;
  reviewNote: string | null;
  personal: boolean;
};

export async function listFlaggedQbo(): Promise<FlaggedQboRow[]> {
  await requireOwner();
  const rows = await prisma.qboTransaction.findMany({
    where: { needsReview: true },
    orderBy: { txnDate: "desc" },
    take: 200,
    select: {
      id: true, txnDate: true, type: true, amount: true, customerName: true,
      accountName: true, memo: true, category: true, reviewNote: true, personal: true,
    },
  });
  return rows.map((r) => ({ ...r, txnDate: r.txnDate.toISOString().slice(0, 10) }));
}

/** Resolve one flagged ledger row: confirm/correct its category + business-vs-
 *  personal, stamp reviewedAt, clear the flag. Locked against the nightly
 *  re-classify by the flag itself (categoriseBooks skips reviewed rows). */
export async function resolveQboRow(
  id: string,
  d: { category?: string | null; personal?: boolean },
): Promise<{ ok: boolean; message: string }> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const category = d.category === undefined ? undefined : (d.category?.trim().slice(0, 80) || null);
  await prisma.qboTransaction.update({
    where: { id },
    data: {
      ...(category !== undefined ? { category } : {}),
      ...(d.personal !== undefined ? { personal: d.personal } : {}),
      needsReview: false,
      reviewedAt: new Date(),
    },
  });
  revalidatePath("/sales");
  return { ok: true, message: "Reviewed." };
}
