"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/auth/guards";
import { parseMoney } from "@/lib/money";

export type MoneyResult = { ok: boolean; message: string };

// Set how a team member is paid (photographers stay PER_SHOOT; Kim MONTHLY_FLAT,
// Remar/Kyle HOURLY). Owner-only.
export async function setTeamPay(
  teamMemberId: string,
  payType: "PER_SHOOT" | "MONTHLY_FLAT" | "HOURLY" | "NONE",
  monthlyPay?: number | string | null,
  hourlyRate?: number | string | null,
): Promise<MoneyResult> {
  await requireOwner();
  const m = parseMoney(monthlyPay);
  const h = parseMoney(hourlyRate);
  await prisma.teamMember.update({
    where: { id: teamMemberId },
    data: {
      payType,
      monthlyPay: payType === "MONTHLY_FLAT" ? m : null,
      hourlyRate: payType === "HOURLY" ? h : null,
    },
  });
  revalidatePath("/sales");
  return { ok: true, message: "Pay setup saved." };
}

// Record one pay-out to a non-photographer for a period (the bridge from bank to
// the P&L). amount is the source of truth; for HOURLY it defaults to hours×rate
// but the owner can override to what actually left the bank.
export async function recordPayrollEntry(input: {
  teamMemberId: string;
  periodStart: string; // yyyy-mm-dd
  payDateISO: string;
  basis: "MONTHLY_FLAT" | "HOURLY";
  hours?: number | string | null;
  rate?: number | string | null;
  amount: number | string;
  note?: string | null;
}): Promise<MoneyResult> {
  await requireOwner();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.periodStart)) return { ok: false, message: "Pick a pay period." };
  const payDate = new Date(input.payDateISO);
  if (isNaN(payDate.getTime())) return { ok: false, message: "Enter the pay date." };
  const amount = parseMoney(input.amount);
  if (amount == null || amount <= 0) return { ok: false, message: "Enter the amount paid." };
  const hours = parseMoney(input.hours);
  const rate = parseMoney(input.rate);
  await prisma.payrollEntry.upsert({
    where: { teamMemberId_periodStart: { teamMemberId: input.teamMemberId, periodStart: input.periodStart } },
    create: {
      teamMemberId: input.teamMemberId, periodStart: input.periodStart, payDate,
      basis: input.basis, hours, rate, amount, note: (input.note ?? "").trim() || null,
    },
    update: { payDate, basis: input.basis, hours, rate, amount, note: (input.note ?? "").trim() || null },
  });
  revalidatePath("/sales");
  return { ok: true, message: "Pay recorded." };
}

export async function deletePayrollEntry(id: string): Promise<MoneyResult> {
  await requireOwner();
  await prisma.payrollEntry.delete({ where: { id } }).catch(() => {});
  revalidatePath("/sales");
  return { ok: true, message: "Removed." };
}

// Log an expense (or personal draw). personal=true excludes it from the business P&L.
export async function addExpense(input: {
  amount: number | string;
  category: string;
  spentAtISO: string;
  vendor?: string | null;
  note?: string | null;
  personal?: boolean;
  recurring?: boolean;
}): Promise<MoneyResult> {
  await requireOwner();
  const amount = parseMoney(input.amount);
  if (amount == null || amount <= 0) return { ok: false, message: "Enter the amount." };
  const spentAt = new Date(input.spentAtISO);
  if (isNaN(spentAt.getTime())) return { ok: false, message: "Enter the date." };
  await prisma.expense.create({
    data: {
      amount, spentAt,
      category: (input.category || "other").trim(),
      vendor: (input.vendor ?? "").trim() || null,
      note: (input.note ?? "").trim() || null,
      personal: !!input.personal,
      recurring: !!input.recurring,
    },
  });
  revalidatePath("/sales");
  return { ok: true, message: "Expense added." };
}

export async function deleteExpense(id: string): Promise<MoneyResult> {
  await requireOwner();
  await prisma.expense.delete({ where: { id } }).catch(() => {});
  revalidatePath("/sales");
  return { ok: true, message: "Removed." };
}

// Record what's actually in the business checking account right now — anchors
// the cash-position / runway hero.
export async function setCashSnapshot(balance: number | string, asOfISO: string, note?: string | null): Promise<MoneyResult> {
  await requireOwner();
  const b = parseMoney(balance);
  if (b == null) return { ok: false, message: "Enter your bank balance (can be negative)." };
  const asOf = new Date(asOfISO);
  if (isNaN(asOf.getTime())) return { ok: false, message: "Enter the date." };
  await prisma.cashSnapshot.create({ data: { balance: b, asOf, note: (note ?? "").trim() || null } });
  revalidatePath("/sales");
  return { ok: true, message: "Bank balance saved." };
}
