// ---------------------------------------------------------------------------
// FIXTURE: one TEST client's content month, built the way production holds it.
//
//   const f = await buildContentMonth(prisma, { package: "Pro", topics: [...] });
//
// Client (name ends in TEST, so every synthetic-only guard accepts it) → ACTIVE
// ContentEnrollment on a package → ContentMonth → the month's shoot as a Project
// linked by contentMonthId, carrying the monthly SOCIAL_REEL row a "Video Pro"
// Aryeo line becomes → optional Appointments (content sessions ARE Aryeo
// appointments) → topics with their month selections → a portal OWNER seat and
// the enrollment's share token. Every id comes back.
//
// Takes the drill's prisma rather than importing it: this module is loaded
// before bootDrillDb has pointed DATABASE_URL at PGlite, so it must not touch
// @/lib/prisma at module scope. The package numbers are read from the app's
// own PACKAGE_RULES at call time, so the fixture cannot drift from them.
// ---------------------------------------------------------------------------
import type { PrismaClient, ProjectStatus } from "@prisma/client";
import { randomBytes } from "node:crypto";

export type FixturePackage = "Starter" | "Accelerator" | "Pro";

export type FixtureTopic = {
  title: string;
  /** The month selection. null = the topic sits in the bank, unselected. */
  selection?: "PROPOSED" | "SELECTED" | "RECONCILED" | "REMOVED" | null;
  /** Client lines from a planning call, stored as the selection's evidence —
   *  the shape the drafting sweep reads as FROM_CALL. */
  excerpts?: string[];
  source?: string;
  topicStatus?: string;
  clientVisible?: boolean;
};

export type ContentMonthFixtureOptions = {
  /** Must contain the word TEST; default "Fixture Client TEST". */
  name?: string;
  package?: FixturePackage;
  /** Override the package rule (e.g. a per-client exception). */
  videosPerMonth?: number;
  sessionsPerMonth?: number;
  sessionHours?: number;
  enrollmentStatus?: "ACTIVE" | "PAUSED" | "ENDED";
  monthKey?: string;
  monthStatus?: string;
  /** false = no shoot project. */
  project?: false | { title?: string; status?: ProjectStatus; shootDate?: Date | null };
  appointments?: { startAt: Date; durationMin?: number; status?: string }[];
  topics?: FixtureTopic[];
  /** false = no portal seat. */
  owner?: false | { email?: string; name?: string };
  /** false = the enrollment has never been given a link. */
  portalToken?: boolean;
};

export type ContentMonthFixture = {
  clientId: string;
  clientName: string;
  enrollmentId: string;
  monthId: string;
  monthKey: string;
  package: FixturePackage;
  videosPerMonth: number;
  sessionsPerMonth: number;
  projectId: string | null;
  deliverableId: string | null;
  appointmentIds: string[];
  topicIds: string[];
  /** Parallel to topicIds; null where the topic has no selection. */
  selectionIds: (string | null)[];
  clientUserId: string | null;
  membershipId: string | null;
  portalToken: string | null;
};

export async function buildContentMonth(prisma: PrismaClient, opts: ContentMonthFixtureOptions = {}): Promise<ContentMonthFixture> {
  const { isTestClientName } = await import("@/lib/testClients");
  const { PACKAGE_RULES } = await import("@/lib/contentProgram");
  const name = opts.name ?? "Fixture Client TEST";
  if (!isTestClientName(name)) throw new Error(`fixture client "${name}" must carry the word TEST`);
  const pkg = opts.package ?? "Accelerator";
  const rule = PACKAGE_RULES[pkg];
  const videosPerMonth = opts.videosPerMonth ?? rule.videosPerMonth;
  const sessionsPerMonth = opts.sessionsPerMonth ?? rule.sessionsPerMonth;
  const monthKey = opts.monthKey ?? "2026-10";
  const tag = randomBytes(4).toString("hex");

  const client = await prisma.client.create({
    data: { name, socialClient: true, socialPlan: pkg },
    select: { id: true },
  });
  const portalToken = opts.portalToken === false ? null : randomBytes(24).toString("base64url");
  const enrollment = await prisma.contentEnrollment.create({
    data: {
      clientId: client.id,
      status: opts.enrollmentStatus ?? "ACTIVE",
      package: pkg,
      videosPerMonth,
      sessionsPerMonth,
      sessionHours: opts.sessionHours ?? rule.sessionHours,
      startedAt: new Date("2026-08-01T04:00:00Z"),
      portalToken,
      portalTokenIssuedAt: portalToken ? new Date() : null,
    },
    select: { id: true },
  });
  const month = await prisma.contentMonth.create({
    data: { enrollmentId: enrollment.id, clientId: client.id, monthKey, videosOwed: videosPerMonth, status: opts.monthStatus ?? "OPEN" },
    select: { id: true },
  });

  let projectId: string | null = null;
  let deliverableId: string | null = null;
  const appointmentIds: string[] = [];
  if (opts.project !== false) {
    const p = opts.project ?? {};
    const firstSession = opts.appointments?.[0]?.startAt ?? null;
    const project = await prisma.project.create({
      data: {
        clientId: client.id,
        title: p.title ?? `${name} — ${monthKey} content`,
        status: p.status ?? "SCHEDULED",
        contentMonthId: month.id,
        // "Video Pro" is how the Aryeo line reads; MONTHLY_PLAN_RE keys on it,
        // which is what puts the job on the monthly 7–10 business-day clock.
        packageName: `Video ${pkg}`,
        shootDate: p.shootDate === undefined ? firstSession : p.shootDate,
      },
      select: { id: true },
    });
    projectId = project.id;
    const reel = await prisma.deliverable.create({
      data: { projectId: project.id, type: "SOCIAL_REEL", label: `Video ${pkg}`, productTitle: `Video ${pkg}`, quantity: videosPerMonth },
      select: { id: true },
    });
    deliverableId = reel.id;
    for (const [i, a] of (opts.appointments ?? []).entries()) {
      const appt = await prisma.appointment.create({
        data: {
          projectId: project.id,
          aryeoId: `fixture-${tag}-${i + 1}`,
          startAt: a.startAt,
          endAt: new Date(a.startAt.getTime() + (a.durationMin ?? 120) * 60_000),
          durationMin: a.durationMin ?? 120,
          status: a.status ?? "SCHEDULED",
          title: `Content session ${i + 1}`,
        },
        select: { id: true },
      });
      appointmentIds.push(appt.id);
    }
  } else if (opts.appointments?.length) {
    throw new Error("appointments need the month's project (project: false was given)");
  }

  const topicIds: string[] = [];
  const selectionIds: (string | null)[] = [];
  for (const [i, t] of (opts.topics ?? []).entries()) {
    const topic = await prisma.contentTopic.create({
      data: {
        enrollmentId: enrollment.id,
        clientId: client.id,
        monthId: t.selection ? month.id : null,
        title: t.title,
        source: t.source ?? "staff",
        status: t.topicStatus ?? (t.selection ? "SELECTED" : "IDEA"),
        clientVisible: t.clientVisible ?? false,
      },
      select: { id: true },
    });
    topicIds.push(topic.id);
    if (!t.selection) { selectionIds.push(null); continue; }
    const sel = await prisma.contentTopicSelection.create({
      data: {
        topicId: topic.id,
        monthId: month.id,
        enrollmentId: enrollment.id,
        clientId: client.id,
        status: t.selection,
        source: t.excerpts?.length ? "call" : (t.source ?? "staff"),
        rank: i + 1,
        evidenceJson: t.excerpts?.length
          ? JSON.stringify({ excerpts: t.excerpts.map((text) => ({ speaker: "client", source: "call", text })) })
          : null,
        committedAt: t.selection === "RECONCILED" ? new Date() : null,
      },
      select: { id: true },
    });
    selectionIds.push(sel.id);
  }

  let clientUserId: string | null = null;
  let membershipId: string | null = null;
  if (opts.owner !== false) {
    const o = opts.owner ?? {};
    const person = await prisma.clientUser.create({
      data: { email: (o.email ?? `owner-${tag}@example.com`).toLowerCase(), name: o.name ?? name, status: "ACTIVE" },
      select: { id: true },
    });
    clientUserId = person.id;
    const seat = await prisma.clientMembership.create({
      data: { clientUserId: person.id, enrollmentId: enrollment.id, clientId: client.id, role: "OWNER", acceptedAt: new Date() },
      select: { id: true },
    });
    membershipId = seat.id;
  }

  return {
    clientId: client.id,
    clientName: name,
    enrollmentId: enrollment.id,
    monthId: month.id,
    monthKey,
    package: pkg,
    videosPerMonth,
    sessionsPerMonth,
    projectId,
    deliverableId,
    appointmentIds,
    topicIds,
    selectionIds,
    clientUserId,
    membershipId,
    portalToken,
  };
}
