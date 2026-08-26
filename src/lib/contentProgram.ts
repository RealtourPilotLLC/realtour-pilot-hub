import "server-only";
import { prisma } from "@/lib/prisma";
import { MONTHLY_PLAN_RE } from "@/lib/pipeline";

// ---------------------------------------------------------------------------
// Content Creator Program — domain layer (Phase 1).
//
// The enrollment SIGNAL is Client.socialClient/socialPlan, synced from Aryeo
// customer custom fields ("Social Client" = Yes, "Social Content Plan" =
// Starter/Accelerator/Pro). That is the stable identifier the spec asked for —
// NOT product-title parsing. ContentEnrollment is the program's operating row
// on top of it: package rules, per-client overrides, pause state.
//
// Content sessions ARE Aryeo appointments → Projects. attachMonthlyProjects
// links each monthly-plan shoot to its ContentMonth, so the existing
// shoot→edit→review pipeline IS the production side of a month workspace.
// ---------------------------------------------------------------------------

// Package rule table (spec §2). Configurable later via overridesJson / admin UI;
// these are today's real packages.
export const PACKAGE_RULES: Record<string, { videosPerMonth: number; sessionsPerMonth: number; sessionHours: number }> = {
  Starter: { videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2 },
  Accelerator: { videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4 },
  Pro: { videosPerMonth: 8, sessionsPerMonth: 2, sessionHours: 4 },
};

// ET month key ("2026-08") for a date — months are ET like everything else.
export function etMonthKey(d: Date = new Date()): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(d);
  const y = p.find((x) => x.type === "year")!.value;
  const m = p.find((x) => x.type === "month")!.value;
  return `${y}-${m}`;
}

export function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

// ---------------------------------------------------------------------------
// Enrollment sync: every socialClient gets a ContentEnrollment; plan changes
// from Aryeo update the package (unless the row was set manually); clients no
// longer flagged get PAUSED, never deleted (history stays).
// ---------------------------------------------------------------------------
export async function syncEnrollments(): Promise<{ created: number; updated: number; paused: number }> {
  const social = (await prisma.client.findMany({
    where: { socialClient: true },
    select: { id: true, socialPlan: true, email: true, name: true },
  // Jordan's OWN client record carries the Aryeo Social Client flag (testing),
  // but the owner is not a program client — removed Aug 24 at his request and
  // excluded here so the sweep can never quietly re-enroll him.
  })).filter((c) => c.email?.toLowerCase() !== "info@realtourpilot.com" && c.name !== "Jordan Spackman");
  const existing = await prisma.contentEnrollment.findMany({
    select: { id: true, clientId: true, package: true, status: true, packageSource: true, statusManual: true },
  });
  const byClient = new Map(existing.map((e) => [e.clientId, e]));
  let created = 0, updated = 0, paused = 0;

  for (const c of social) {
    const plan = c.socialPlan && PACKAGE_RULES[c.socialPlan] ? c.socialPlan : "Accelerator";
    const rules = PACKAGE_RULES[plan];
    const cur = byClient.get(c.id);
    if (!cur) {
      await prisma.contentEnrollment.create({
        data: { clientId: c.id, package: plan, ...rules, startedAt: new Date(), packageSource: "aryeo" },
      });
      created++;
    } else if (!cur.statusManual && (cur.status === "PAUSED" || (cur.package !== plan && cur.packageSource === "aryeo"))) {
      // Re-flagged in Aryeo → reactivate; plan changed in Aryeo → follow it
      // (manual packages are the admin's override and are left alone).
      await prisma.contentEnrollment.update({
        where: { id: cur.id },
        data: { status: "ACTIVE", ...(cur.packageSource === "aryeo" ? { package: plan, ...PACKAGE_RULES[plan] } : {}) },
      });
      updated++;
    }
  }
  // No longer flagged in Aryeo → pause (subscription lapsed), never delete.
  const socialIds = new Set(social.map((c) => c.id));
  for (const e of existing) {
    if (e.statusManual) continue; // a human owns this status
    if (e.status === "ACTIVE" && !socialIds.has(e.clientId)) {
      await prisma.contentEnrollment.update({ where: { id: e.id }, data: { status: "PAUSED" } });
      paused++;
    }
  }
  return { created, updated, paused };
}

// ---------------------------------------------------------------------------
// Month creation: every ACTIVE enrollment gets the current month's workspace
// (spec §15 — staff never create months by hand). Idempotent.
// ---------------------------------------------------------------------------
export async function ensureCurrentMonths(): Promise<{ created: number }> {
  const key = etMonthKey();
  const active = await prisma.contentEnrollment.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, clientId: true, videosPerMonth: true, strategyCallRequired: true },
  });
  let created = 0;
  for (const e of active) {
    const exists = await prisma.contentMonth.findUnique({
      where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey: key } },
      select: { id: true },
    });
    if (exists) continue;
    await prisma.contentMonth.create({
      data: {
        enrollmentId: e.id,
        clientId: e.clientId,
        monthKey: key,
        videosOwed: e.videosPerMonth,
        strategyCallStatus: e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
      },
    });
    created++;
  }
  return { created };
}

// ---------------------------------------------------------------------------
// Attach monthly-plan shoots to their month workspace. A project belongs to a
// month when: its client is enrolled, its deliverables read as monthly content
// (MONTHLY_PLAN_RE — the same signal the whole pipeline uses), and its shoot
// date falls in that ET month. Only fills blanks — a manual attach is honored.
// ---------------------------------------------------------------------------
export async function attachMonthlyProjects(): Promise<{ attached: number }> {
  const enrollments = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } });
  if (enrollments.length === 0) return { attached: 0 };
  const clientIds = enrollments.map((e) => e.clientId);
  const byClient = new Map(enrollments.map((e) => [e.clientId, e.id]));

  const candidates = await prisma.project.findMany({
    where: {
      clientId: { in: clientIds },
      contentMonthId: null,
      status: { not: "CANCELLED" },
      shootDate: { not: null },
    },
    select: { id: true, clientId: true, shootDate: true, deliverables: { select: { label: true } } },
  });
  let attached = 0;
  for (const p of candidates) {
    if (!p.deliverables.some((d) => d.label && MONTHLY_PLAN_RE.test(d.label))) continue;
    const monthKey = etMonthKey(p.shootDate!);
    const enrollmentId = byClient.get(p.clientId)!;
    // Find-or-create the month (a shoot may land in a future or past month).
    let month = await prisma.contentMonth.findUnique({
      where: { enrollmentId_monthKey: { enrollmentId, monthKey } },
      select: { id: true },
    });
    if (!month) {
      const e = await prisma.contentEnrollment.findUnique({
        where: { id: enrollmentId },
        select: { videosPerMonth: true, strategyCallRequired: true },
      });
      month = await prisma.contentMonth.create({
        data: {
          enrollmentId,
          clientId: p.clientId,
          monthKey,
          videosOwed: e?.videosPerMonth ?? 4,
          strategyCallStatus: e?.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED",
          // A month minted for a pre-launch shoot is history, not a live workflow.
          ...(monthKey < etMonthKey() ? { historical: true, status: "IMPORTED" } : {}),
        },
        select: { id: true },
      });
    }
    await prisma.project.update({ where: { id: p.id }, data: { contentMonthId: month.id } });
    attached++;
  }
  return { attached };
}

// One sweep the cron (and the page's refresh action) calls.
export async function contentProgramSweep() {
  const enr = await syncEnrollments();
  const months = await ensureCurrentMonths();
  const attach = await attachMonthlyProjects();
  return { ...enr, monthsCreated: months.created, projectsAttached: attach.attached };
}

// ---------------------------------------------------------------------------
// The roster read — one row per enrollment with this month's live state and
// the needs-attention flags (spec §42–43). Production truth comes from the
// attached Projects (the pipeline), not a parallel status field.
// ---------------------------------------------------------------------------
export type ProgramRow = {
  enrollmentId: string;
  clientId: string;
  clientName: string;
  pkg: string;
  status: string; // enrollment status
  monthId: string | null;
  monthKey: string;
  videosOwed: number;
  strategyCallStatus: string;
  sessionsScheduled: number; // attached projects with a future/any shoot date this month
  sessionsRequired: number;
  shotCount: number; // attached projects past shoot date
  delivered: number; // videos delivered (DELIVERED projects' video count, capped)
  inReview: number; // pending review submissions on attached projects
  topicsSelected: number;
  scriptsReady: number;
  attention: string[]; // human-readable exception flags, worst first
  trial: boolean; // hand-set ACTIVE on a one-month trial
  lastMonthKey: string | null; // latest month with any program content
};

export async function getProgramRoster(): Promise<ProgramRow[]> {
  const key = etMonthKey();
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
    select: {
      id: true, clientId: true, package: true, status: true, statusManual: true, notes: true,
      sessionsPerMonth: true, strategyCallRequired: true, clientSuppliesTopics: true,
    },
  });
  // Last month that has ANY program content — the "when were they last active"
  // signal for the paused section.
  const lastMonths = await prisma.contentMonth.groupBy({
    by: ["enrollmentId"],
    where: { enrollmentId: { in: enrollments.map((e) => e.id) } },
    _max: { monthKey: true },
  });
  const lastMonthOf = new Map(lastMonths.map((l) => [l.enrollmentId, l._max.monthKey]));
  const clients = await prisma.client.findMany({
    where: { id: { in: enrollments.map((e) => e.clientId) } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));

  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, monthKey: key },
    select: { id: true, enrollmentId: true, videosOwed: true, strategyCallStatus: true },
  });
  const monthOf = new Map(months.map((m) => [m.enrollmentId, m]));
  const monthIds = months.map((m) => m.id);

  const [projects, topics, scripts] = await Promise.all([
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds } },
      select: {
        id: true, contentMonthId: true, status: true, shootDate: true,
        deliverables: { select: { type: true, label: true, quantity: true } },
        reviewSubmissions: { select: { status: true } },
      },
    }),
    prisma.contentTopic.groupBy({ by: ["monthId"], where: { monthId: { in: monthIds }, status: { in: ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"] } }, _count: true }),
    prisma.contentScript.groupBy({ by: ["monthId"], where: { monthId: { in: monthIds }, status: { in: ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"] } }, _count: true }),
  ]);
  const topicCount = new Map(topics.map((t) => [t.monthId, t._count]));
  const scriptCount = new Map(scripts.map((t) => [t.monthId, t._count]));
  const projByMonth = new Map<string, typeof projects>();
  for (const p of projects) {
    if (!p.contentMonthId) continue;
    const arr = projByMonth.get(p.contentMonthId) ?? [];
    arr.push(p);
    projByMonth.set(p.contentMonthId, arr);
  }

  const now = new Date();
  // Video units on a project — the meter's currency is VIDEOS, not sessions
  // (audit Aug 25: "1/5" was the best a healthy month could ever show).
  const videoUnits = (p: { deliverables: { type: string; quantity: number | null }[] }) =>
    p.deliverables
      .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
      .reduce((s, d) => s + Math.max(1, d.quantity ?? 1), 0);
  const rows: ProgramRow[] = [];
  for (const e of enrollments) {
    const m = monthOf.get(e.id) ?? null;
    // A session cancelled AFTER it attached still had contentMonthId — it must
    // not count as booked, or the no-session alarm never fires (audit).
    const ps = (m ? projByMonth.get(m.id) ?? [] : []).filter((p) => p.status !== "CANCELLED");
    const sessionsScheduled = ps.length;
    const shotCount = ps.filter((p) => p.shootDate && p.shootDate < now).length;
    const delivered = ps.filter((p) => p.status === "DELIVERED").reduce((s, p) => s + Math.max(1, videoUnits(p)), 0);
    const inReview = ps.reduce((s, p) => s + p.reviewSubmissions.filter((r) => r.status === "PENDING").length, 0);
    const topicsSelected = m ? topicCount.get(m.id) ?? 0 : 0;
    const scriptsReady = m ? scriptCount.get(m.id) ?? 0 : 0;

    const attention: string[] = [];
    if (e.status === "PAUSED") attention.push("Paused — no longer flagged in Aryeo");
    else if (m) {
      if (m.strategyCallStatus === "NOT_SCHEDULED") attention.push("Strategy call not scheduled");
      if (sessionsScheduled === 0) attention.push("No content session on the calendar");
      else if (sessionsScheduled < e.sessionsPerMonth) attention.push(`Needs ${e.sessionsPerMonth - sessionsScheduled} more session${e.sessionsPerMonth - sessionsScheduled === 1 ? "" : "s"}`);
      if (topicsSelected === 0 && !e.clientSuppliesTopics) attention.push("No topics selected");
      if (inReview > 0) attention.push(`${inReview} video${inReview === 1 ? "" : "s"} awaiting review`);
    }

    rows.push({
      enrollmentId: e.id,
      clientId: e.clientId,
      clientName: nameOf.get(e.clientId) ?? "Unknown",
      pkg: e.package,
      status: e.status,
      monthId: m?.id ?? null,
      monthKey: key,
      videosOwed: m?.videosOwed ?? 0,
      strategyCallStatus: m?.strategyCallStatus ?? (e.strategyCallRequired ? "NOT_SCHEDULED" : "NOT_REQUIRED"),
      sessionsScheduled,
      sessionsRequired: e.sessionsPerMonth,
      shotCount,
      delivered,
      inReview,
      topicsSelected,
      scriptsReady,
      attention,
      trial: e.status === "ACTIVE" && e.statusManual && /trial/i.test(e.notes ?? ""),
      lastMonthKey: lastMonthOf.get(e.id) ?? null,
    });
  }
  // Worst problems first, then by name.
  rows.sort((a, b) => b.attention.length - a.attention.length || a.clientName.localeCompare(b.clientName));
  return rows;
}
