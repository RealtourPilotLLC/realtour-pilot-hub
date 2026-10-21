"use server";
import { revalidatePath } from "next/cache";
import { requireOwner } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { usd2 } from "@/lib/money";


// The ONLY money path out of the bonus engine (its own design rule #4: the
// engine computes, it never pays). Owner-only; idempotent per person+quarter;
// lands as a PayoutAdjustment on the next payout, visible on Payroll + My Pay.
//
// THE SERVER DECIDES THE AMOUNT (audit G1, Oct 20 2026). This used to pay
// whatever `amount` the browser sent, so a stale tab or a hand-made POST could
// write any figure onto someone's payout. The amount is recomputed here;
// `shownAmount` is only the figure the owner confirmed on screen, and a
// mismatch refuses rather than paying a number nobody looked at.
//
// ONE ENGINE (Jordan, Oct 21 2026). The recompute is kpi.ts scoreQuarter(),
// the scorecard the person sees on My Performance, paid in its fixed bands
// ($1,000 / $600 / $250). It used to be the retired lib/bonus.ts profit pool,
// which could pay a different figure from the one the photographer was shown.
export async function payQuarterlyBonus(
  teamMemberId: string,
  quarter: string,
  shownAmount?: number,
): Promise<{ ok: boolean; message: string }> {
  try { await requireOwner(); } catch (e) { return { ok: false, message: (e as Error).message }; }
  if (typeof teamMemberId !== "string" || !teamMemberId) return { ok: false, message: "Bad person." };
  if (typeof quarter !== "string" || !/^\d{4}-Q[1-4]$/.test(quarter)) return { ok: false, message: "Bad quarter." };

  const { quarterFromKey, scoreQuarter, bonusRoster, MAX_QUARTERLY_BONUS } = await import("@/lib/kpi");
  const q = quarterFromKey(quarter);
  if (!q) return { ok: false, message: "Bad quarter." };
  // The running quarter's score still moves; paying it now would cap this
  // person at a mid-quarter figure forever (per-quarter idempotency). Same
  // rule the tab shows as "payable when the quarter closes".
  if (q.end.getTime() >= Date.now()) return { ok: false, message: `${q.label} is still running. Pay it once the quarter closes.` };

  // Only someone the bonus covers (the same list the Bonus tab shows): never
  // the owner, never a former teammate, never an id typed by hand.
  const member = (await bonusRoster()).find((m) => m.id === teamMemberId);
  if (!member) return { ok: false, message: "That person isn't covered by the quarterly bonus." };

  const label = `Quarterly bonus ${quarter}`;
  const existing = await prisma.payoutAdjustment.findFirst({
    where: { teamMemberId, label: { startsWith: label } },
    select: { id: true },
  });
  if (existing) return { ok: false, message: "Already paid for this quarter." };

  const card = await scoreQuarter({ memberId: teamMemberId, name: member.name, quarter: q });
  const amount = Math.round(card.bonus * 100) / 100;
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, message: `Nothing to pay this person for ${q.label}.` };
  // The bands top out at MAX_QUARTERLY_BONUS, so anything above it is a fault
  // somewhere, never a bonus.
  if (amount > MAX_QUARTERLY_BONUS) return { ok: false, message: `That bonus is over the ${usd2(MAX_QUARTERLY_BONUS)} quarterly maximum. Check the scorecard.` };
  if (typeof shownAmount === "number" && Number.isFinite(shownAmount) && Math.abs(shownAmount - amount) >= 0.01) {
    return {
      ok: false,
      message: `The bonus is now ${usd2(amount)}, not the ${usd2(shownAmount)} on your screen (the scorecard moved). Reload and check it before paying.`,
    };
  }

  await prisma.payoutAdjustment.create({
    data: { teamMemberId, label, amount, date: new Date() },
  });
  revalidatePath("/sales");
  return { ok: true, message: `Bonus of ${usd2(amount)} queued. It lands on their next payout.` };
}
