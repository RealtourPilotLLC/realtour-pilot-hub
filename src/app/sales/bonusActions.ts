"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

const usd2 = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The ONLY money path out of the bonus engine (its own design rule #4: the
// engine computes, it never pays). Owner-only; idempotent per person+quarter;
// lands as a PayoutAdjustment on the next payout, visible on Payroll + My Pay.
//
// THE SERVER DECIDES THE AMOUNT (audit G1, Oct 20 2026). This used to pay
// whatever `amount` the browser sent, so a stale tab or a hand-made POST could
// write any figure up to $25,000 onto someone's payout. The amount is now
// recomputed here with the same quarterBonus() the Bonus tab renders from;
// `shownAmount` is only the figure the owner confirmed on screen, and a
// mismatch refuses rather than paying a number nobody looked at.
export async function payQuarterlyBonus(
  teamMemberId: string,
  quarter: string,
  shownAmount?: number,
): Promise<{ ok: boolean; message: string }> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (typeof teamMemberId !== "string" || !teamMemberId) return { ok: false, message: "Bad person." };
  if (typeof quarter !== "string" || !/^\d{4}-Q[1-4]$/.test(quarter)) return { ok: false, message: "Bad quarter." };

  const { quarterFromKey, quarterBonus } = await import("@/lib/bonus");
  const q = quarterFromKey(quarter);
  if (!q) return { ok: false, message: "Bad quarter." };
  // The running quarter's pool is partial; paying it now would cap this person
  // at a mid-quarter figure forever (per-quarter idempotency). Same rule the
  // tab shows as "payable when the quarter closes".
  if (q.end.getTime() >= Date.now()) return { ok: false, message: `${q.label} is still running. Pay it once the quarter closes.` };

  const label = `Quarterly bonus ${quarter}`;
  const existing = await prisma.payoutAdjustment.findFirst({
    where: { teamMemberId, label: { startsWith: label } },
    select: { id: true },
  });
  if (existing) return { ok: false, message: "Already paid for this quarter." };

  const { split } = await quarterBonus(q);
  const amount = Math.round((split[teamMemberId] ?? 0) * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: `Nothing to pay this person for ${q.label}.` };
  if (amount > 25_000) return { ok: false, message: "That bonus is over the $25,000 safety limit. Check the quarter's numbers." };
  if (typeof shownAmount === "number" && Number.isFinite(shownAmount) && Math.abs(shownAmount - amount) >= 0.01) {
    return {
      ok: false,
      message: `The bonus is now ${usd2(amount)}, not the ${usd2(shownAmount)} on your screen (the quarter's numbers moved). Reload and check it before paying.`,
    };
  }

  await prisma.payoutAdjustment.create({
    data: { teamMemberId, label, amount, date: new Date() },
  });
  revalidatePath("/sales");
  return { ok: true, message: `Bonus of ${usd2(amount)} queued. It lands on their next payout.` };
}
