"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";

export type ActionResult = { ok: boolean; message: string };

// Add a manual pay-period adjustment for a creative (camera payback, bonus, etc).
// Positive adds; negative subtracts.
export async function addAdjustment(
  memberId: string,
  label: string,
  amount: number,
  dateISO: string,
): Promise<ActionResult> {
  const l = label.trim();
  if (!l) return { ok: false, message: "Add a label." };
  if (!isFinite(amount) || amount === 0) return { ok: false, message: "Enter a non-zero amount." };
  const date = new Date(dateISO);
  if (isNaN(date.getTime())) return { ok: false, message: "Invalid date." };
  await prisma.payoutAdjustment.create({
    data: { teamMemberId: memberId, label: l, amount, date },
  });
  revalidatePath("/payouts");
  return { ok: true, message: "Adjustment added." };
}

export async function removeAdjustment(id: string): Promise<ActionResult> {
  await prisma.payoutAdjustment.delete({ where: { id } }).catch(() => {});
  revalidatePath("/payouts");
  return { ok: true, message: "Adjustment removed." };
}

// Set (or clear) a per-job override for a creative on a project.
export async function setJobOverride(
  projectId: string,
  teamMemberId: string,
  opts: { invoiceOverride?: number | null; flatAmount?: number | null; noMileage?: boolean; excluded?: boolean; note?: string | null },
): Promise<ActionResult> {
  const invoiceOverride = opts.invoiceOverride != null && isFinite(opts.invoiceOverride) ? opts.invoiceOverride : null;
  const flatAmount = opts.flatAmount != null && isFinite(opts.flatAmount) ? opts.flatAmount : null;
  const noMileage = !!opts.noMileage;
  const excluded = !!opts.excluded;
  const note = (opts.note ?? "").trim() || null;

  // Nothing set → remove any existing override (back to automatic).
  if (invoiceOverride == null && flatAmount == null && !noMileage && !excluded && !note) {
    await prisma.jobPayOverride.deleteMany({ where: { projectId, teamMemberId } });
    revalidatePath("/payouts");
    return { ok: true, message: "Override cleared — back to automatic." };
  }

  await prisma.jobPayOverride.upsert({
    where: { projectId_teamMemberId: { projectId, teamMemberId } },
    create: { projectId, teamMemberId, invoiceOverride, flatAmount, noMileage, excluded, note },
    update: { invoiceOverride, flatAmount, noMileage, excluded, note },
  });
  revalidatePath("/payouts");
  return { ok: true, message: "Override saved." };
}

// Build a clean, print-ready payout statement for ONE creative — what they see
// when they get paid. Shows final per-shoot pay + mileage + any adjustments and
// the total. Deliberately HIDES internal mechanics: no override badges, no
// invoice corrections, no "$0 invoice"/return-trip/discrepancy flags.
export async function creativeStatementHtml(
  memberId: string,
  startKey: string,
): Promise<{ ok: boolean; html?: string; message?: string }> {
  const { computePayroll, payPeriodFor } = await import("@/lib/payroll");
  const period = payPeriodFor(startKey);
  const start = new Date(period.startKey + "T00:00:00.000Z");
  const end = new Date(period.endKey + "T23:59:59.999Z");
  const people = await computePayroll(start, end);
  const p = people.find((x) => x.member.id === memberId);
  if (!p) return { ok: false, message: "No payout for this creative in this period." };

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const dKey = (k: string, o: Intl.DateTimeFormatOptions) => new Date(k + "T12:00:00Z").toLocaleDateString("en-US", o);
  const dISO = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }) : "—");

  const rangeLabel = `${dKey(period.startKey, { month: "long", day: "numeric" })} – ${dKey(period.endKey, { month: "long", day: "numeric", year: "numeric" })}`;
  const paysLabel = dKey(period.payoutKey, { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  const rows = p.jobs
    .map(
      (j) => `<tr>
        <td>${dISO(j.shootISO)}</td>
        <td>${esc(j.title.split(",")[0])}</td>
        <td class="num">${usd(j.shootPay)}</td>
        <td class="num">${j.mileageShare > 0 ? usd(j.mileageShare) : "—"}</td>
        <td class="num strong">${usd(j.jobTotal)}</td>
      </tr>`,
    )
    .join("");

  const adjustments = p.adjustments.length
    ? `<table class="lines"><tbody>${p.adjustments
        .map((a) => `<tr><td>${esc(a.label)}</td><td class="num ${a.amount < 0 ? "neg" : ""}">${a.amount < 0 ? "−" : "+"}${usd(Math.abs(a.amount))}</td></tr>`)
        .join("")}</tbody></table>`
    : "";

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payout — ${esc(p.member.name)} — ${esc(period.startKey)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Arial, sans-serif; color: #0f172a; background: #f1f5f9; margin: 0; padding: 24px; }
  .sheet { max-width: 720px; margin: 0 auto; background: #fff; border-radius: 14px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  .brand { font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #4f46e5; }
  h1 { font-size: 22px; margin: 2px 0 0; }
  .meta { color: #475569; font-size: 14px; margin-top: 10px; line-height: 1.5; }
  .meta b { color: #0f172a; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; border-bottom: 2px solid #e2e8f0; padding: 0 8px 8px; }
  th.num, td.num { text-align: right; }
  td { padding: 9px 8px; border-bottom: 1px solid #f1f5f9; }
  td.strong { font-weight: 700; }
  .neg { color: #b91c1c; }
  .totals { margin-top: 18px; border-top: 2px solid #e2e8f0; padding-top: 12px; }
  .totals .row { display: flex; justify-content: space-between; font-size: 14px; padding: 3px 8px; color: #475569; }
  .totals .grand { font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 6px; }
  .section-label { margin-top: 22px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #64748b; }
  table.lines { margin-top: 6px; }
  table.lines td { border: none; padding: 4px 8px; }
  .foot { margin-top: 28px; font-size: 11px; color: #94a3b8; }
  .btn { display: inline-block; margin: 0 auto 18px; }
  button { font: inherit; background: #4f46e5; color: #fff; border: 0; border-radius: 8px; padding: 8px 16px; font-weight: 600; cursor: pointer; }
  @media print { body { background: #fff; padding: 0; } .sheet { box-shadow: none; border-radius: 0; } .btn { display: none; } }
</style></head>
<body>
  <div class="btn" style="text-align:center"><button onclick="window.print()">Print / Save as PDF</button></div>
  <div class="sheet">
    <div class="brand">RealTour Pilot</div>
    <h1>Payout Statement</h1>
    <div class="meta">
      <div><b>${esc(p.member.name)}</b></div>
      <div>Pay period: <b>${rangeLabel}</b></div>
      <div>Payout date: <b>${paysLabel}</b></div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Property</th><th class="num">Shoot</th><th class="num">Mileage</th><th class="num">Total</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#94a3b8">No shoots this period.</td></tr>'}</tbody>
    </table>
    ${adjustments ? `<div class="section-label">Adjustments</div>${adjustments}` : ""}
    <div class="totals">
      <div class="row"><span>Shoot pay</span><span>${usd(p.shootPayTotal)}</span></div>
      <div class="row"><span>Mileage</span><span>${usd(p.mileageTotal)}</span></div>
      ${p.adjustmentTotal !== 0 ? `<div class="row"><span>Adjustments</span><span>${p.adjustmentTotal < 0 ? "−" : "+"}${usd(Math.abs(p.adjustmentTotal))}</span></div>` : ""}
      <div class="row grand"><span>Total payout</span><span>${usd(p.total)}</span></div>
    </div>
    <div class="foot">RealTour Pilot · ${rangeLabel}</div>
  </div>
</body></html>`;

  return { ok: true, html };
}

// Recompute cached mileage for a date range (or everyone) — forces a fresh route
// computation on the next payout load.
export async function recomputeMileage(memberId?: string): Promise<ActionResult> {
  await prisma.mileageDay.deleteMany({ where: memberId ? { teamMemberId: memberId } : {} });
  revalidatePath("/payouts");
  return { ok: true, message: "Mileage cleared — will recompute on reload." };
}
