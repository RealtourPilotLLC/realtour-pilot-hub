"use server";

import { requireOwner } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { parseMoney } from "@/lib/money";

export type ActionResult = { ok: boolean; message: string };

// Add a manual pay-period adjustment for a creative (camera payback, bonus, etc).
// Positive adds; negative subtracts.
export async function addAdjustment(
  memberId: string,
  label: string,
  amount: number,
  dateISO: string,
): Promise<ActionResult> {
  await requireOwner();
  const l = label.trim();
  if (!l) return { ok: false, message: "Add a label." };
  if (!isFinite(amount) || amount === 0) return { ok: false, message: "Enter a non-zero amount." };
  const date = new Date(dateISO);
  if (isNaN(date.getTime())) return { ok: false, message: "Invalid date." };
  await prisma.payoutAdjustment.create({
    data: { teamMemberId: memberId, label: l, amount, date },
  });
  revalidatePath("/sales");
  return { ok: true, message: "Adjustment added." };
}

export async function removeAdjustment(id: string): Promise<ActionResult> {
  await requireOwner();
  await prisma.payoutAdjustment.delete({ where: { id } }).catch(() => {});
  revalidatePath("/sales");
  return { ok: true, message: "Adjustment removed." };
}

// Set (or clear) a per-job override for a creative on a project.
export async function setJobOverride(
  projectId: string,
  teamMemberId: string,
  opts: { invoiceOverride?: number | string | null; flatAmount?: number | string | null; noMileage?: boolean; excluded?: boolean; note?: string | null },
): Promise<ActionResult> {
  await requireOwner();
  const invoiceOverride = parseMoney(opts.invoiceOverride);
  const flatAmount = parseMoney(opts.flatAmount);
  const noMileage = !!opts.noMileage;
  const excluded = !!opts.excluded;
  const note = (opts.note ?? "").trim() || null;

  // Nothing set → remove any existing override (back to automatic).
  if (invoiceOverride == null && flatAmount == null && !noMileage && !excluded && !note) {
    await prisma.jobPayOverride.deleteMany({ where: { projectId, teamMemberId } });
    revalidatePath("/sales");
    return { ok: true, message: "Override cleared — back to automatic." };
  }

  await prisma.jobPayOverride.upsert({
    where: { projectId_teamMemberId: { projectId, teamMemberId } },
    create: { projectId, teamMemberId, invoiceOverride, flatAmount, noMileage, excluded, note },
    update: { invoiceOverride, flatAmount, noMileage, excluded, note },
  });
  revalidatePath("/sales");
  return { ok: true, message: "Override saved." };
}

// Restore a removed (excluded) job — un-hide it from payout. If nothing else was
// overridden, drop the override entirely so it's back to fully automatic.
export async function restoreJob(projectId: string, teamMemberId: string): Promise<ActionResult> {
  await requireOwner();
  const ov = await prisma.jobPayOverride.findUnique({ where: { projectId_teamMemberId: { projectId, teamMemberId } } });
  if (!ov) { revalidatePath("/sales"); return { ok: true, message: "Restored." }; }
  const stillHasSettings = ov.invoiceOverride != null || ov.flatAmount != null || ov.noMileage || ov.manualAdd || (ov.note ?? "").trim();
  if (stillHasSettings) {
    await prisma.jobPayOverride.update({ where: { projectId_teamMemberId: { projectId, teamMemberId } }, data: { excluded: false } });
  } else {
    await prisma.jobPayOverride.delete({ where: { projectId_teamMemberId: { projectId, teamMemberId } } }).catch(() => {});
  }
  revalidatePath("/sales");
  return { ok: true, message: "Shoot restored." };
}

// Search existing projects (synced Aryeo orders) by address — for manually adding
// a shoot to someone's payout. Returns the order's invoice so it can be pulled in.
export async function searchPayableProjects(query: string): Promise<{ id: string; title: string; invoice: number; dateISO: string | null; photographer: string | null }[]> {
  await requireOwner();
  const q = query.trim();
  if (q.length < 3) return [];
  const rows = await prisma.project.findMany({
    where: { status: { not: "CANCELLED" }, title: { contains: q, mode: "insensitive" } },
    select: {
      id: true, title: true, payableInvoice: true, price: true, shootDate: true,
      photographer: { select: { name: true } },
      appointments: { where: { startAt: { not: null } }, orderBy: { startAt: "asc" }, take: 1, select: { startAt: true } },
    },
    orderBy: { shootDate: "desc" },
    take: 8,
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    invoice: r.payableInvoice ?? r.price ?? 0,
    dateISO: (r.appointments[0]?.startAt ?? r.shootDate)?.toISOString() ?? null,
    photographer: r.photographer?.name ?? null,
  }));
}

// Manually add a shoot to a creative's payout — pays them full for the job (from
// the pulled invoice), even if they aren't the appointment shooter. Tune amount
// afterward with the row's Edit (flat amount / invoice) if needed.
export async function addShootToPayroll(projectId: string, teamMemberId: string): Promise<ActionResult> {
  await requireOwner();
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { title: true } });
  if (!project) return { ok: false, message: "Couldn't find that order." };
  await prisma.jobPayOverride.upsert({
    where: { projectId_teamMemberId: { projectId, teamMemberId } },
    create: { projectId, teamMemberId, manualAdd: true, excluded: false },
    update: { manualAdd: true, excluded: false },
  });
  revalidatePath("/sales");
  return { ok: true, message: `Added ${project.title.split(",")[0]} to the payout.` };
}

// Build a clean, print-ready payout statement for ONE creative — what they see
// when they get paid. Shows final per-shoot pay + mileage + any adjustments and
// the total. Deliberately HIDES internal mechanics: no override badges, no
// invoice corrections, no "$0 invoice"/return-trip/discrepancy flags.
export async function creativeStatementHtml(
  memberId: string,
  startKey: string,
): Promise<{ ok: boolean; html?: string; message?: string }> {
  await requireOwner();
  const { computePayroll, payPeriodFor, periodBounds } = await import("@/lib/payroll");
  const period = payPeriodFor(startKey);
  const { start, end } = periodBounds(period);
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

// Set (or clear) the owner's mileage correction for one creative's day. The
// override becomes the figure pay is computed from; the routed figure stays on
// the row for reference. Clearing goes back to fully automatic.
export async function setMileageOverride(
  teamMemberId: string,
  dayKey: string,
  miles: number | string | null,
  note?: string | null,
): Promise<ActionResult> {
  await requireOwner();
  // A real calendar date, not just the shape of one.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || isNaN(new Date(dayKey + "T12:00:00Z").getTime()) ||
      new Date(dayKey + "T12:00:00Z").toISOString().slice(0, 10) !== dayKey) {
    return { ok: false, message: "Bad day key." };
  }
  const member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { id: true } });
  if (!member) return { ok: false, message: "Unknown team member." };

  // Clearing is EXPLICIT (the reset arrow sends null). A blank string from the
  // Save button is a mistake, not a clear — silently reverting pay to the
  // routed figure on an empty input bit the review.
  if (miles === null) {
    try {
      await prisma.mileageDay.update({
        where: { teamMemberId_dayKey: { teamMemberId, dayKey } },
        data: { overrideMiles: null, overrideNote: null },
      });
    } catch (e) {
      // No row = nothing was adjusted; anything else is a real failure.
      if ((e as { code?: string })?.code !== "P2025") return { ok: false, message: "Couldn't reset that day — try again." };
    }
    revalidatePath("/sales");
    return { ok: true, message: "Back to computed mileage." };
  }
  if (String(miles).trim() === "") {
    return { ok: false, message: "Enter the miles — or use the reset arrow to go back to automatic." };
  }

  // Parse the raw value — no character stripping ("-50" and "1e3" must be
  // rejected or parsed honestly, never mangled into a different number).
  const n = typeof miles === "number" ? miles : Number(String(miles).trim());
  if (!isFinite(n) || n < 0 || n > 2000) return { ok: false, message: "Enter miles between 0 and 2000." };
  const rounded = Math.round(n * 10) / 10;
  const cleanNote = (note ?? "").trim().slice(0, 200) || null;
  // The row may not exist yet (day never routed) — create it with a zero
  // computed figure and no sig, so the next payout load fills in the computed
  // value while the override already applies.
  await prisma.mileageDay.upsert({
    where: { teamMemberId_dayKey: { teamMemberId, dayKey } },
    create: { teamMemberId, dayKey, miles: 0, stops: 0, sig: null, overrideMiles: rounded, overrideNote: cleanNote },
    update: { overrideMiles: rounded, overrideNote: cleanNote },
  });
  revalidatePath("/sales");
  return { ok: true, message: `Mileage set to ${rounded} mi for that day.` };
}

// Recompute cached mileage for a date range (or everyone) — forces a fresh route
// computation on the next payout load. Owner corrections SURVIVE a recompute:
// override rows just get their route signature cleared so the computed figure
// refreshes underneath the override.
export async function recomputeMileage(memberId?: string): Promise<ActionResult> {
  await requireOwner();
  const scope = memberId ? { teamMemberId: memberId } : {};
  await prisma.mileageDay.deleteMany({ where: { ...scope, overrideMiles: null } });
  await prisma.mileageDay.updateMany({ where: { ...scope, overrideMiles: { not: null } }, data: { sig: null } });
  revalidatePath("/sales");
  return { ok: true, message: "Mileage cleared — will recompute on reload (your adjustments kept)." };
}
