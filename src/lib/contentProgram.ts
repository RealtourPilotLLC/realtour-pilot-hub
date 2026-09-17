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
      // Date floor: the program launched Aug 2026 — without it the sweep
      // re-examined ~305 unattachable historical shoots on every run (audit).
      shootDate: { gte: new Date("2026-06-01T00:00:00Z") },
    },
    select: { id: true, clientId: true, shootDate: true, deliverables: { where: { removedFromOrderAt: null }, select: { label: true } } },
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
  // Scheduled settings changes (a package effective next month) land BEFORE
  // the month is minted, so the 1st-of-month workspace carries the new
  // quantity. Dynamic import: enrollmentChanges imports this module.
  const { applyDueEnrollmentChanges } = await import("@/lib/enrollmentChanges");
  const changes = await applyDueEnrollmentChanges().catch(() => ({ applied: 0 }));
  const enr = await syncEnrollments();
  const months = await ensureCurrentMonths();
  const attach = await attachMonthlyProjects();
  return { ...enr, monthsCreated: months.created, projectsAttached: attach.attached, changesApplied: changes.applied };
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
  scriptsAwaiting: number; // drafts sitting in INTERNAL_REVIEW/DRAFT — Jordan's approve queue
  openSuggestions: number; // OPEN portal suggestions from the client on this month's scripts
  strategyCallAt: string | null; // ISO, when booked — lets the UI say "call Fri 2 PM"
  nextShootDate: string | null; // ISO, the next upcoming session this month
  strategyCallRequired: boolean;
  clientSuppliesTopics: boolean;
  behind: { monthKey: string; delivered: number; owed: number } | null; // last month under-delivered
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
      sessionsPerMonth: true, strategyCallRequired: true, clientSuppliesTopics: true, billingType: true,
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
    select: { id: true, enrollmentId: true, videosOwed: true, strategyCallStatus: true, strategyCallAt: true },
  });
  const monthOf = new Map(months.map((m) => [m.enrollmentId, m]));
  const monthIds = months.map((m) => m.id);

  // LAST month, for the behind-flag (Jordan, Aug 28: "sometimes clients get a
  // month behind or miss a month" — Marcee's July was filmed in August). A
  // month the owner marked SKIPPED, or an imported backfill month, never nags.
  const [y, mm] = key.split("-").map(Number);
  const prevKey = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  const prevMonths = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, monthKey: prevKey, historical: false, status: { notIn: ["SKIPPED", "IMPORTED"] } },
    select: { id: true, enrollmentId: true, videosOwed: true },
  });
  const prevOf = new Map(prevMonths.map((m) => [m.enrollmentId, m]));
  const prevDelivered = new Map<string, number>();
  if (prevMonths.length) {
    const prevProjects = await prisma.project.findMany({
      where: { contentMonthId: { in: prevMonths.map((m) => m.id) }, status: "DELIVERED" },
      select: { contentMonthId: true, deliverables: { where: { removedFromOrderAt: null }, select: { type: true, quantity: true } } },
    });
    for (const p of prevProjects) {
      const units = Math.max(1, p.deliverables
        .filter((d) => d.type === "VIDEO" || d.type === "SOCIAL_REEL")
        .reduce((s2, d) => s2 + Math.max(1, d.quantity ?? 1), 0));
      prevDelivered.set(p.contentMonthId!, (prevDelivered.get(p.contentMonthId!) ?? 0) + units);
    }
  }

  const [projects, topics, scripts] = await Promise.all([
    prisma.project.findMany({
      where: { contentMonthId: { in: monthIds } },
      select: {
        id: true, contentMonthId: true, status: true, shootDate: true,
        deliverables: { where: { removedFromOrderAt: null }, select: { type: true, label: true, quantity: true } },
        reviewSubmissions: { select: { status: true } },
      },
    }),
    prisma.contentTopic.groupBy({ by: ["monthId"], where: { monthId: { in: monthIds }, status: { in: ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"] } }, _count: true }),
    prisma.contentScript.groupBy({ by: ["monthId"], where: { monthId: { in: monthIds }, status: { in: ["APPROVED", "CLIENT_VISIBLE", "READY_TO_FILM"] } }, _count: true }),
  ]);
  // Jordan's approve queue + the client's open portal suggestions — the two
  // counts that make "what needs you" answerable without opening each client.
  const [awaitingScripts, monthScripts] = await Promise.all([
    prisma.contentScript.groupBy({ by: ["monthId"], where: { monthId: { in: monthIds }, status: { in: ["INTERNAL_REVIEW", "DRAFT"] } }, _count: true }),
    prisma.contentScript.findMany({ where: { monthId: { in: monthIds } }, select: { id: true, monthId: true } }),
  ]);
  const awaitingCount = new Map(awaitingScripts.map((t) => [t.monthId, t._count]));
  // ScriptSuggestion carries only scriptId (no relation) — map via the scripts.
  const monthOfScript = new Map(monthScripts.map((s) => [s.id, s.monthId]));
  const suggestionCount = new Map<string, number>();
  if (monthScripts.length) {
    const openSugg = await prisma.scriptSuggestion.groupBy({
      by: ["scriptId"],
      where: { status: "OPEN", scriptId: { in: monthScripts.map((s) => s.id) } },
      _count: true,
    });
    for (const s of openSugg) {
      const mid = monthOfScript.get(s.scriptId);
      if (mid) suggestionCount.set(mid, (suggestionCount.get(mid) ?? 0) + s._count);
    }
  }
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
    const scriptsAwaiting = m ? awaitingCount.get(m.id) ?? 0 : 0;
    const openSuggestions = m ? suggestionCount.get(m.id) ?? 0 : 0;
    const upcoming = ps
      .filter((p) => p.shootDate && p.shootDate >= now)
      .sort((a, b) => a.shootDate!.getTime() - b.shootDate!.getTime())[0];

    const attention: string[] = [];
    let behind: { monthKey: string; delivered: number; owed: number } | null = null;
    if (e.status === "PAUSED") attention.push("Paused — no longer flagged in Aryeo");
    else if (m) {
      if (m.strategyCallStatus === "NOT_SCHEDULED") attention.push("Strategy call not scheduled");
      if (sessionsScheduled === 0) attention.push("No content session on the calendar");
      else if (sessionsScheduled < e.sessionsPerMonth) attention.push(`Needs ${e.sessionsPerMonth - sessionsScheduled} more session${e.sessionsPerMonth - sessionsScheduled === 1 ? "" : "s"}`);
      if (topicsSelected === 0 && !e.clientSuppliesTopics) attention.push("No topics selected");
      if (inReview > 0) attention.push(`${inReview} video${inReview === 1 ? "" : "s"} awaiting review`);
      const prev = prevOf.get(e.id);
      if (prev && prev.videosOwed > 0) {
        const got = prevDelivered.get(prev.id) ?? 0;
        if (got < prev.videosOwed) {
          attention.push(`Behind — ${monthLabel(prevKey)} delivered ${got}/${prev.videosOwed}`);
          behind = { monthKey: prevKey, delivered: got, owed: prev.videosOwed };
        }
      }
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
      scriptsAwaiting,
      openSuggestions,
      strategyCallAt: m?.strategyCallAt?.toISOString() ?? null,
      nextShootDate: upcoming?.shootDate?.toISOString() ?? null,
      strategyCallRequired: e.strategyCallRequired,
      clientSuppliesTopics: e.clientSuppliesTopics,
      behind,
      attention,
      trial: e.status === "ACTIVE" && (e.billingType === "TRIAL" || (e.statusManual && /trial/i.test(e.notes ?? ""))),
      lastMonthKey: lastMonthOf.get(e.id) ?? null,
    });
  }
  // Worst problems first, then by name.
  rows.sort((a, b) => b.attention.length - a.attention.length || a.clientName.localeCompare(b.clientName));
  return rows;
}

// ---------------------------------------------------------------------------
// Who owns which duty (spec §16/§17, Jordan D11): Jordan owns STRATEGY and
// SCRIPTS approval, Kyle owns SCHEDULING and DELIVERY — as ProgramOwnerAssignment
// DEFAULT rows, overridable per enrollment or per month. The defaults are
// minted on first read (a settings row, not client data) so the workspace can
// always show an owner; an override is a scope=ENROLLMENT/MONTH row.
// ---------------------------------------------------------------------------
export type OwnerDuty = "STRATEGY" | "SCRIPTS" | "SCHEDULING" | "DELIVERY" | "ESCALATION" | "REMINDERS";
export const OWNER_DUTIES: OwnerDuty[] = ["STRATEGY", "SCRIPTS", "SCHEDULING", "DELIVERY", "ESCALATION", "REMINDERS"];
export type DutyOwner = { duty: OwnerDuty; appUserId: string | null; email: string | null; label: string; scope: "DEFAULT" | "ENROLLMENT" | "MONTH" };

async function ensureDefaultOwnerAssignments(): Promise<void> {
  const existing = await prisma.programOwnerAssignment.count({ where: { scope: "DEFAULT" } });
  if (existing > 0) return;
  const users = await prisma.appUser.findMany({ where: { status: "ACTIVE" }, select: { id: true, email: true, name: true, role: true } });
  // Jordan = the OWNER on the company address; Kyle = the ADMIN named Kyle.
  const jordan = users.find((u) => u.email === "info@realtourpilot.com") ?? users.find((u) => u.role === "OWNER") ?? null;
  const kyle = users.find((u) => u.role === "ADMIN" && /kyle/i.test(u.name ?? "")) ?? null;
  const rows: { duty: OwnerDuty; user: typeof jordan }[] = [
    { duty: "STRATEGY", user: jordan }, { duty: "SCRIPTS", user: jordan }, { duty: "ESCALATION", user: jordan },
    { duty: "SCHEDULING", user: kyle }, { duty: "DELIVERY", user: kyle }, { duty: "REMINDERS", user: kyle },
  ];
  for (const r of rows) {
    await prisma.programOwnerAssignment.upsert({
      where: { scope_scopeRef_duty: { scope: "DEFAULT", scopeRef: "", duty: r.duty } },
      create: { scope: "DEFAULT", scopeRef: "", duty: r.duty, appUserId: r.user?.id ?? null, label: r.user?.name ?? (r.user?.email ?? "unassigned"), setBy: "defaults" },
      update: {},
    }).catch(() => {});
  }
}

/** The owner of a duty for a month → enrollment → program default. */
export async function ownersFor(enrollmentId: string, monthId?: string | null): Promise<Record<OwnerDuty, DutyOwner>> {
  await ensureDefaultOwnerAssignments();
  const rows = await prisma.programOwnerAssignment.findMany({
    where: { endedAt: null, OR: [{ scope: "DEFAULT" }, { scope: "ENROLLMENT", scopeRef: enrollmentId }, ...(monthId ? [{ scope: "MONTH", scopeRef: monthId }] : [])] },
  });
  const userIds = [...new Set(rows.map((r) => r.appUserId).filter((x): x is string => !!x))];
  const users = userIds.length ? await prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : [];
  const out = {} as Record<OwnerDuty, DutyOwner>;
  for (const duty of OWNER_DUTIES) {
    const pick = rows.find((r) => r.duty === duty && r.scope === "MONTH") ?? rows.find((r) => r.duty === duty && r.scope === "ENROLLMENT") ?? rows.find((r) => r.duty === duty && r.scope === "DEFAULT");
    const u = pick?.appUserId ? users.find((x) => x.id === pick.appUserId) : null;
    out[duty] = { duty, appUserId: pick?.appUserId ?? null, email: u?.email ?? null, label: u?.name ?? pick?.label ?? "unassigned", scope: (pick?.scope as DutyOwner["scope"]) ?? "DEFAULT" };
  }
  return out;
}

/** Override who owns a duty for one enrollment (or one month). appUserId null = remove the override. */
export async function setOwnerOverride(scope: "ENROLLMENT" | "MONTH", scopeRef: string, duty: OwnerDuty, appUserId: string | null, by: string): Promise<void> {
  if (!appUserId) {
    await prisma.programOwnerAssignment.updateMany({ where: { scope, scopeRef, duty, endedAt: null }, data: { endedAt: new Date() } });
    return;
  }
  const u = await prisma.appUser.findUnique({ where: { id: appUserId }, select: { name: true, email: true } });
  await prisma.programOwnerAssignment.upsert({
    where: { scope_scopeRef_duty: { scope, scopeRef, duty } },
    create: { scope, scopeRef, duty, appUserId, label: u?.name ?? u?.email ?? null, setBy: by },
    update: { appUserId, label: u?.name ?? u?.email ?? null, setBy: by, endedAt: null, effectiveAt: new Date() },
  });
}

/**
 * May this person perform a duty on this enrollment? The assigned owner may;
 * so may any OWNER-role login (Jordan can always act, and can hand a duty to
 * Kyle by setting an override). Everyone else gets the owner's name back.
 */
export async function assertDutyOwner(duty: OwnerDuty, enrollmentId: string, monthId: string | null | undefined, me: { id?: string | null; email: string; realRole?: string | null; role?: string | null }): Promise<void> {
  if ((me.realRole ?? me.role) === "OWNER") return;
  const owner = (await ownersFor(enrollmentId, monthId))[duty];
  if (owner.appUserId && me.id && owner.appUserId === me.id) return;
  if (owner.email && owner.email.toLowerCase() === me.email.toLowerCase()) return;
  throw new Error(`${duty.toLowerCase()} approval is assigned to ${owner.label} — ask them, or change the owner on the Client file.`);
}
