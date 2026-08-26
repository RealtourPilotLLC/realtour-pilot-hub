import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// Content Program billing — how each enrolled client pays (owner-entered
// terms on ContentEnrollment) + what they've actually paid (QuickBooks — the
// program's one payment rail; Stripe shows none of these customers). OWNER
// EYES ONLY: every caller must gate on role before rendering any of this.
// ---------------------------------------------------------------------------

export type BillingType = "PAID_IN_FULL" | "MONTHLY_CONTRACT" | "MONTH_TO_MONTH" | "TRIAL";

export const BILLING_TYPES: { value: BillingType; label: string }[] = [
  { value: "PAID_IN_FULL", label: "Paid in full" },
  { value: "MONTHLY_CONTRACT", label: "Monthly · contract" },
  { value: "MONTH_TO_MONTH", label: "Month to month" },
  { value: "TRIAL", label: "Trial" },
];

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** "Paid in full · 1 yr ($15,588)" / "$1,099/mo · 1-yr contract" / "$1,699/mo · month to month" / "Trial · $997". */
export function billingLabel(type: string | null, rate: number | null, months: number | null): string {
  if (!type) return "terms not set";
  const yrs = months === 12 ? "1 yr" : months ? `${months} mo` : null;
  switch (type) {
    case "PAID_IN_FULL":
      return `Paid in full${yrs ? ` · ${yrs}` : ""}${rate ? ` (${money(rate)})` : ""}`;
    case "MONTHLY_CONTRACT":
      return `${rate ? `${money(rate)}/mo` : "Monthly"} · ${yrs ? `${yrs} contract` : "contract"}`;
    case "MONTH_TO_MONTH":
      return `${rate ? `${money(rate)}/mo` : "Monthly"} · month to month`;
    case "TRIAL":
      return `Trial${rate ? ` · ${money(rate)}` : ""}${months && months !== 1 ? ` · ${months} mo` : ""}`;
    default:
      return type.toLowerCase().replace(/_/g, " ");
  }
}

/** Total value of the agreement as signed — null when open-ended. */
export function agreementValue(type: string | null, rate: number | null, months: number | null): number | null {
  if (!type || rate == null) return null;
  if (type === "PAID_IN_FULL" || type === "TRIAL") return rate;
  if (type === "MONTHLY_CONTRACT" && months) return rate * months;
  return null; // month-to-month: no fixed end
}

export type RevenueRow = {
  enrollmentId: string;
  clientName: string;
  status: string;
  trial: boolean;
  billingType: string | null;
  billingRate: number | null;
  billingMonths: number | null;
  collectedThisYear: number; // QuickBooks payments, ALL services for this client
};

// Aryeo team-folding sometimes doubles a surname ("Marcee McMullen McMullen") —
// collapse repeats before matching QuickBooks customer names.
function cleanName(name: string): string {
  const words = name.trim().split(/\s+/);
  return words.filter((w, i) => w.toLowerCase() !== words[i - 1]?.toLowerCase()).join(" ");
}

/** One row per ACTIVE enrollment: the terms + what QuickBooks actually collected this year. */
export async function programRevenue(): Promise<RevenueRow[]> {
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true, clientId: true, status: true, statusManual: true, notes: true,
      billingType: true, billingRate: true, billingMonths: true,
    },
  });
  const clients = await prisma.client.findMany({
    where: { id: { in: enrollments.map((e) => e.clientId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));

  // ONE pull of the year's payments, matched in memory — the per-client
  // aggregate loop was nine sequential scans of the QuickBooks table per page
  // open (audit).
  const pays = await prisma.qboTransaction.findMany({
    where: { type: { in: ["Payment", "SalesReceipt"] }, txnDate: { gte: yearStart } },
    select: { customerName: true, amount: true },
  });
  const rows: RevenueRow[] = [];
  for (const e of enrollments) {
    const name = cleanName(nameOf.get(e.clientId) ?? "");
    // Full-name contains — a bare first name would cross-match (Erica Walker
    // vs Erica Wright). Collected covers ALL the client's payments, not just
    // the program: that is deliberately "how much we make off this person".
    const lower = name.toLowerCase();
    const collected = name
      ? pays.reduce((sum, q) => (q.customerName?.toLowerCase().includes(lower) ? sum + q.amount : sum), 0)
      : 0;
    rows.push({
      enrollmentId: e.id,
      clientName: name || "Unknown",
      status: e.status,
      trial: e.billingType === "TRIAL" || (e.status === "ACTIVE" && e.statusManual && /trial/i.test(e.notes ?? "")),
      billingType: e.billingType,
      billingRate: e.billingRate,
      billingMonths: e.billingMonths,
      collectedThisYear: collected,
    });
  }
  // Biggest relationships first.
  rows.sort((a, b) => b.collectedThisYear - a.collectedThisYear);
  return rows;
}
