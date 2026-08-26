"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

// The ONLY money path out of the bonus engine (its own design rule #4: the
// engine computes, it never pays). Owner-only; idempotent per person+quarter;
// lands as a PayoutAdjustment on the next payout, visible on Payroll + My Pay.
export async function payQuarterlyBonus(
  teamMemberId: string,
  quarter: string,
  amount: number,
): Promise<{ ok: boolean; message: string }> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 25_000) return { ok: false, message: "Bad amount." };
  if (!/^\d{4}-Q[1-4]$/.test(quarter)) return { ok: false, message: "Bad quarter." };
  const label = `Quarterly bonus ${quarter}`;
  const existing = await prisma.payoutAdjustment.findFirst({
    where: { teamMemberId, label: { startsWith: label } },
    select: { id: true },
  });
  if (existing) return { ok: false, message: "Already paid for this quarter." };
  await prisma.payoutAdjustment.create({
    data: { teamMemberId, label, amount: Math.round(amount * 100) / 100, date: new Date() },
  });
  revalidatePath("/sales");
  return { ok: true, message: `Bonus queued — it lands on their next payout.` };
}
