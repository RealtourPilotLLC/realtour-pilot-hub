import "server-only";

import { prisma } from "@/lib/prisma";
import { appBase } from "@/lib/appUrl";
import { getSetting, putSetting } from "@/lib/settings";
import { etDayKey, etMinutesOfDay, etWeekday } from "@/lib/datetime";
import { ruleById } from "./registry";
import { creditView } from "./credits";
import { opsRecipients } from "./notifyOps";

// ---------------------------------------------------------------------------
// THE MONDAY PHOTO DIGEST (docs/photo-delivery/01 §12 item 8). Monday 8 AM ET,
// one Slack DM (or text, per the person's channel) to Jordan and Kyle:
// galleries delivered last week, on time against each job's promise, the
// median turnaround, what AI QC found most and per photographer, AutoHDR
// credits used and the runway. The QC spend in DOLLARS goes to Jordan only:
// Kyle (ADMIN) never sees money (access.ts canSeeMoney).
// Facts only, from hub rows; no em dashes. Sent once per ET Monday (AppSetting).
// ---------------------------------------------------------------------------

const SENT_KEY = "photo_delivery:digest_sent_week";

export type PhotoDigest = { lines: string[]; ownerOnlyLines: string[]; weekKey: string };

export async function buildPhotoDigest(now = new Date()): Promise<PhotoDigest> {
  const end = new Date(now);
  const start = new Date(now.getTime() - 7 * 86_400_000);
  const delivered = await prisma.photoJob.findMany({
    where: { deliveredAt: { gte: start, lt: end } },
    select: { id: true, projectId: true, deliveredAt: true, slaDueAt: true, lastQcRunId: true },
  });
  const projects = await prisma.project.findMany({
    where: { id: { in: delivered.map((d) => d.projectId) } },
    select: { id: true, shootDate: true, promisedDueAt: true, photographerId: true },
  });
  const pById = new Map(projects.map((p) => [p.id, p]));
  let onTime = 0, withPromise = 0;
  const turnaroundH: number[] = [];
  for (const d of delivered) {
    const p = pById.get(d.projectId);
    const due = p?.promisedDueAt ?? d.slaDueAt;
    if (due && d.deliveredAt) {
      withPromise++;
      if (d.deliveredAt <= due) onTime++;
    }
    if (p?.shootDate && d.deliveredAt) turnaroundH.push((d.deliveredAt.getTime() - p.shootDate.getTime()) / 3_600_000);
  }
  turnaroundH.sort((a, b) => a - b);
  const median = turnaroundH.length ? turnaroundH[Math.floor(turnaroundH.length / 2)] : null;

  // What QC found (above the display floor), by rule and by photographer.
  const findings = await prisma.photoQcFinding.findMany({
    where: { createdAt: { gte: start, lt: end }, confidence: { gte: 0.5 }, status: { not: "SUPERSEDED" } },
    select: { ruleId: true, responsibility: true, jobId: true, status: true },
  });
  const byRule = new Map<string, number>();
  for (const f of findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1);
  const topRules = [...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, n]) => `${ruleById(id)?.shortLabel ?? id} (${n})`);
  const falsePositives = findings.filter((f) => f.status === "FALSE_POSITIVE").length;
  const jobs = await prisma.photoJob.findMany({ where: { id: { in: [...new Set(findings.map((f) => f.jobId))] } }, select: { id: true, projectId: true } });
  const jobProject = new Map(jobs.map((j) => [j.id, j.projectId]));
  const shooterOf = new Map((await prisma.project.findMany({ where: { id: { in: jobs.map((j) => j.projectId) } }, select: { id: true, photographerId: true } })).map((p) => [p.id, p.photographerId]));
  const names = new Map((await prisma.teamMember.findMany({ where: { id: { in: [...new Set([...shooterOf.values()].filter(Boolean) as string[])] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name.split(" ")[0]]));
  const perShooter = new Map<string, number>();
  for (const f of findings) {
    if (f.responsibility !== "PHOTOGRAPHER") continue;
    const who = shooterOf.get(jobProject.get(f.jobId) ?? "") ?? null;
    const name = who ? names.get(who) ?? "Unassigned" : "Unassigned";
    perShooter.set(name, (perShooter.get(name) ?? 0) + 1);
  }
  const ledger = await prisma.autohdrCreditEntry.findMany({ where: { at: { gte: start, lt: end }, kind: { not: "BALANCE_SNAPSHOT" } }, select: { credits: true, kind: true } });
  // Everything spent (the pipeline's own spends, AutoHDR's own edits booked as
  // adjustments), net of refunds; a refill is not negative spend.
  const used = -ledger.filter((l) => !(l.kind === "ADJUSTMENT" && l.credits > 0)).reduce((s, l) => s + l.credits, 0);
  const cv = await creditView(now).catch(() => null);
  const qcRuns = await prisma.photoQcRun.findMany({ where: { startedAt: { gte: start, lt: end } }, select: { costUsd: true } });
  const qcCost = qcRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0);

  const lines = [
    `Photo delivery, last 7 days: ${delivered.length} galler${delivered.length === 1 ? "y" : "ies"} delivered.`,
    withPromise ? `On time: ${onTime} of ${withPromise} (${Math.round((onTime / withPromise) * 100)}%).` : "On time: no promised times recorded.",
    median != null ? `Median shoot to delivery: ${Math.round(median)} h.` : "",
    findings.length ? `AI QC flagged ${findings.length} issue${findings.length === 1 ? "" : "s"}${topRules.length ? `; most common: ${topRules.join(", ")}` : ""}.` : "AI QC: no issues recorded this week.",
    perShooter.size ? `On-site issues by photographer: ${[...perShooter.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ${c}`).join(", ")}.` : "",
    falsePositives ? `Marked not an issue: ${falsePositives} (feeds QC tuning).` : "",
    `AutoHDR credits used: ${Math.max(0, Math.round(used))}${cv?.balance != null ? `; balance ${cv.balance}${cv.runwayDays != null ? `, about ${cv.runwayDays} days left` : ""}` : ""}.`,
    `${appBase()}/ops/photo-delivery`,
  ].filter(Boolean);
  const ownerOnlyLines = qcRuns.length ? [`AI QC cost: $${qcCost.toFixed(2)} for ${qcRuns.length} run${qcRuns.length === 1 ? "" : "s"}.`] : [];
  return { lines, ownerOnlyLines, weekKey: etDayKey(now) };
}

/** Called every 5 minutes; sends once, on Monday from 8 AM ET. */
export async function maybeSendPhotoDigest(now = new Date()): Promise<{ sent: boolean; reason: string }> {
  if (etWeekday(now) !== "Mon" || etMinutesOfDay(now) < 8 * 60) return { sent: false, reason: "not Monday 8 AM ET yet" };
  const key = etDayKey(now);
  // An object, not a bare string: getSetting merges the stored JSON into the
  // fallback object, which would scatter a string into characters.
  const last = await getSetting<{ day: string | null }>(SENT_KEY, { day: null });
  if (last.day === key) return { sent: false, reason: "already sent this Monday" };
  // Claim first, so two ticks can't both send.
  await putSetting(SENT_KEY, { day: key }, "system");
  const d = await buildPhotoDigest(now);
  const { ownerId, kyleId } = await opsRecipients();
  const { notifyStaffSms } = await import("@/lib/notify");
  const text = d.lines.join("\n");
  if (ownerId) await notifyStaffSms([ownerId], [text, ...d.ownerOnlyLines].join("\n"), "photo_weekly_digest");
  if (kyleId && kyleId !== ownerId) await notifyStaffSms([kyleId], text, "photo_weekly_digest");
  return { sent: true, reason: `sent to ${[ownerId && "owner", kyleId && "kyle"].filter(Boolean).join(" and ")}` };
}
