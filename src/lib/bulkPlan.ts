import "server-only";
import { prisma } from "@/lib/prisma";
import { etMonthKey } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// BULK CONTENT PLANS (Oct 15 2026).
//
// Jordan: "For Rick Schultz, on for monthly social. We are going to do 48
// videos and shoot for 8 videos per session, and do 1 session a week for the
// next six weeks or 6-8 weeks depending on availability. We may try to do more
// than 8 in a day and require less sessions. I want the system set up for like
// a bulk option which allows us to turn it on for rick, or other clients in
// the future." And: Rick sees every script, grouped per session, can open the
// next sessions, and marks them complete; the upload portal is the real record
// ("We cant rely on rick marking them off"), and the videographer can add
// videos from future sessions to today's upload.
//
// THE SHAPE. One ContentBulkPlan per client, anchored on ONE ContentMonth that
// holds every selection, script and video of the plan, so everything that
// already works per month (topicsForSession, confirmFilmedTopics, the editor
// brief, the library, the review windows) works unchanged. What is new:
//   · ContentTopicSelection.sessionNo — the session a script is planned for;
//     the order inside a session is the selection's rank (plan order, 1..N).
//   · Project.contentSessionNo — which session a shoot is, when the office
//     says so; otherwise the plan's shoots are numbered by date.
//   · ContentScript.clientMarkedDoneAt — the client's own tick. ADVISORY: a
//     script is filmed when the upload portal says so, never because of it.
//   · ContentEnrollment.programKind = "BULK" — the switch every monthly-only
//     sweep reads to leave this client alone (no new months, no planning
//     reminders, no topic banks, no carry-over into the next calendar month).
// ---------------------------------------------------------------------------

export const BULK_KIND = "BULK";
const DAY = 86_400_000;
/** Selections that hold a place in the plan (the month's allowance statuses minus the call's PROPOSED). */
const LIVE = ["SELECTED", "RECONCILED", "CARRIED"];

export type BulkActor = { email: string; appUserId?: string | null; name?: string | null };

// ---- reads every monthly sweep uses -------------------------------------------

/** Enrollments running a bulk plan. One query; monthly sweeps filter on it. */
export async function bulkEnrollmentIds(): Promise<Set<string>> {
  const rows = await prisma.contentEnrollment.findMany({ where: { programKind: BULK_KIND }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** Anchor months of every plan that is not cancelled — monthly sweeps leave them alone. */
export async function bulkMonthIds(): Promise<Set<string>> {
  const rows = await prisma.contentBulkPlan.findMany({ where: { status: { not: "CANCELLED" } }, select: { monthId: true } });
  return new Set(rows.map((r) => r.monthId));
}

export async function bulkPlanForMonth(monthId: string) {
  return prisma.contentBulkPlan.findUnique({ where: { monthId } });
}

export async function activeBulkPlanFor(enrollmentId: string) {
  return prisma.contentBulkPlan.findFirst({ where: { enrollmentId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
}

export async function latestBulkPlanFor(enrollmentId: string) {
  return prisma.contentBulkPlan.findFirst({ where: { enrollmentId, status: { not: "CANCELLED" } }, orderBy: { createdAt: "desc" } });
}

/**
 * The plan month a bulk client's shoot belongs to: their ACTIVE plan, when the
 * shoot falls between a week before its start and four weeks after its last
 * planned session (sessions slip; an extra week is common). Null otherwise —
 * the shoot is then attached by date as for any monthly client.
 */
export async function bulkMonthForShoot(clientId: string, shootDate: Date | null): Promise<string | null> {
  if (!shootDate) return null;
  const plan = await prisma.contentBulkPlan.findFirst({ where: { clientId, status: "ACTIVE" }, orderBy: { createdAt: "desc" } });
  if (!plan) return null;
  const start = plan.startsOn ? plan.startsOn.getTime() - 7 * DAY : plan.createdAt.getTime() - 7 * DAY;
  const last = plannedEnd(plan).getTime() + 28 * DAY;
  const t = shootDate.getTime();
  return t >= start && t <= last ? plan.monthId : null;
}

function plannedEnd(plan: { startsOn: Date | null; endsOn: Date | null; createdAt: Date; sessionsPlanned: number; cadenceDays: number }): Date {
  if (plan.endsOn) return plan.endsOn;
  const base = plan.startsOn ?? plan.createdAt;
  return new Date(base.getTime() + Math.max(0, plan.sessionsPlanned - 1) * Math.max(1, plan.cadenceDays) * DAY);
}

// ---- sessions ------------------------------------------------------------------

export type PlanShoot = { projectId: string; title: string; shootDateISO: string | null; status: string; sessionNo: number; explicit: boolean };

/**
 * The plan's shoots, each with its session number. The office's own number
 * (Project.contentSessionNo) wins; every other shoot takes the next free
 * number in date order. A cancelled shoot is not a session.
 */
export async function planShoots(monthId: string): Promise<PlanShoot[]> {
  const rows = await prisma.project.findMany({
    where: { contentMonthId: monthId, status: { not: "CANCELLED" } },
    orderBy: [{ shootDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true, shootDate: true, status: true, contentSessionNo: true },
  });
  const taken = new Set(rows.map((r) => r.contentSessionNo).filter((n): n is number => typeof n === "number" && n > 0));
  let next = 1;
  return rows.map((r) => {
    if (typeof r.contentSessionNo === "number" && r.contentSessionNo > 0) {
      return { projectId: r.id, title: r.title, shootDateISO: r.shootDate?.toISOString() ?? null, status: r.status, sessionNo: r.contentSessionNo, explicit: true };
    }
    while (taken.has(next)) next++;
    const n = next++;
    return { projectId: r.id, title: r.title, shootDateISO: r.shootDate?.toISOString() ?? null, status: r.status, sessionNo: n, explicit: false };
  });
}

/** Which session a shoot is, or null when the shoot is not on a bulk plan. */
export async function sessionOfProject(projectId: string): Promise<{ plan: NonNullable<Awaited<ReturnType<typeof bulkPlanForMonth>>>; sessionNo: number } | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { contentMonthId: true } });
  if (!p?.contentMonthId) return null;
  const plan = await bulkPlanForMonth(p.contentMonthId);
  if (!plan || plan.status === "CANCELLED") return null;
  const shoot = (await planShoots(p.contentMonthId)).find((s) => s.projectId === projectId);
  return shoot ? { plan, sessionNo: shoot.sessionNo } : null;
}

/** The office sets (or clears) which session a shoot is. */
export async function setProjectSession(projectId: string, sessionNo: number | null, by: string): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { contentMonthId: true } });
  if (!p?.contentMonthId || !(await bulkPlanForMonth(p.contentMonthId))) throw new Error("That shoot isn't on a bulk plan.");
  if (sessionNo !== null && (!Number.isInteger(sessionNo) || sessionNo < 1 || sessionNo > 60)) throw new Error("A session number is a whole number from 1.");
  await prisma.project.update({ where: { id: projectId }, data: { contentSessionNo: sessionNo } });
  void by;
}

// ---- the board -------------------------------------------------------------------

export type BulkItemState = "planned" | "client_done" | "filmed" | "editing" | "in_review" | "delivered";
export type BulkItem = {
  topicId: string;
  selectionId: string;
  rank: number;
  sessionNo: number | null;
  title: string;
  pillar: string | null;
  scriptId: string | null;
  /** The words the client sees are released (shared) to the portal. */
  released: boolean;
  clientMarkedDoneAtISO: string | null;
  clientMarkedDoneBy: string | null;
  state: BulkItemState;
  videoId: string | null;
  /** The session it was actually filmed at (may differ from the planned one). */
  filmedSessionNo: number | null;
  filmedProjectId: string | null;
};
export type BulkSession = {
  no: number;
  /** The shoot's own date when one is booked, else the plan's cadence date. */
  dateISO: string | null;
  booked: boolean;
  shoots: PlanShoot[];
  items: BulkItem[];
  /** Planned here and already filmed (anywhere). */
  filmed: number;
  /** Filmed AT this session (including ones pulled ahead from later sessions). */
  filmedHere: number;
};
export type BulkBoard = {
  plan: {
    id: string; monthId: string; enrollmentId: string; clientId: string; title: string | null; status: string;
    totalVideos: number; perSession: number; sessionsPlanned: number; cadenceDays: number;
    startsOnISO: string | null; endsOnISO: string | null; editingNote: string | null; sourceFile: string | null;
  };
  sessions: BulkSession[];
  unplanned: BulkItem[];
  totals: { planned: number; filmed: number; delivered: number; clientDone: number; released: number };
  /** The session the next shoot is for: the first one not yet filmed. */
  nextSessionNo: number | null;
};

const VIDEO_STATE: Record<string, BulkItemState> = {
  FILMED: "filmed", EDITING: "editing", CLIENT_REVIEW: "in_review", APPROVED: "in_review", DELIVERED: "delivered",
};

export async function bulkBoard(planId: string): Promise<BulkBoard | null> {
  const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId } });
  if (!plan) return null;
  return boardFor(plan);
}

export async function bulkBoardForMonth(monthId: string): Promise<BulkBoard | null> {
  const plan = await bulkPlanForMonth(monthId);
  return plan ? boardFor(plan) : null;
}

async function boardFor(plan: NonNullable<Awaited<ReturnType<typeof bulkPlanForMonth>>>): Promise<BulkBoard> {
  const [sels, shoots] = await Promise.all([
    prisma.contentTopicSelection.findMany({
      where: { monthId: plan.monthId, status: { in: LIVE } },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
      select: { id: true, topicId: true, rank: true, sessionNo: true },
    }),
    planShoots(plan.monthId),
  ]);
  const topicIds = sels.map((s) => s.topicId);
  const [topics, scripts, videos, pillars] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true, pillarId: true, pillar: true } }),
    prisma.contentScript.findMany({
      where: { monthId: plan.monthId, topicId: { in: topicIds }, historical: false },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, topicId: true, sharedVersionId: true, clientMarkedDoneAt: true, clientMarkedDoneBy: true },
    }),
    prisma.contentVideo.findMany({
      where: { monthId: plan.monthId, topicId: { in: topicIds }, status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, topicId: true, projectId: true, status: true, filmedConfirmedAt: true },
    }),
    prisma.contentPillar.findMany({ where: { enrollmentId: plan.enrollmentId }, select: { id: true, name: true } }),
  ]);
  const topicOf = new Map(topics.map((t) => [t.id, t]));
  const pillarName = new Map(pillars.map((p) => [p.id, p.name]));
  const sessionOfShoot = new Map(shoots.map((s) => [s.projectId, s.sessionNo]));
  const items: BulkItem[] = sels.map((s, i) => {
    const t = topicOf.get(s.topicId);
    const sc = scripts.find((x) => x.topicId === s.topicId) ?? null;
    const mine = videos.filter((v) => v.topicId === s.topicId);
    const v = mine.find((x) => x.filmedConfirmedAt) ?? mine[0] ?? null;
    const filmed = !!v?.filmedConfirmedAt;
    let state: BulkItemState = "planned";
    if (v && filmed) state = VIDEO_STATE[v.status] ?? "filmed";
    else if (sc?.clientMarkedDoneAt) state = "client_done";
    return {
      topicId: s.topicId,
      selectionId: s.id,
      rank: s.rank ?? i + 1,
      sessionNo: s.sessionNo,
      title: t?.title ?? "(untitled)",
      pillar: (t?.pillarId ? pillarName.get(t.pillarId) : null) ?? t?.pillar ?? null,
      scriptId: sc?.id ?? null,
      released: !!sc?.sharedVersionId,
      clientMarkedDoneAtISO: sc?.clientMarkedDoneAt?.toISOString() ?? null,
      clientMarkedDoneBy: sc?.clientMarkedDoneBy ?? null,
      state,
      videoId: v?.id ?? null,
      filmedSessionNo: filmed && v?.projectId ? sessionOfShoot.get(v.projectId) ?? null : null,
      filmedProjectId: filmed ? v?.projectId ?? null : null,
    };
  });
  const isFilmed = (x: BulkItem) => x.state !== "planned" && x.state !== "client_done";
  const maxPlanned = Math.max(0, ...items.map((x) => x.sessionNo ?? 0), ...shoots.map((s) => s.sessionNo));
  const count = Math.max(plan.sessionsPlanned, maxPlanned);
  const base = plan.startsOn ?? null;
  const sessions: BulkSession[] = [];
  for (let no = 1; no <= count; no++) {
    const mineShoots = shoots.filter((s) => s.sessionNo === no);
    const mineItems = items.filter((x) => x.sessionNo === no);
    const dateISO = mineShoots[0]?.shootDateISO ?? (base ? new Date(base.getTime() + (no - 1) * Math.max(1, plan.cadenceDays) * DAY).toISOString() : null);
    sessions.push({
      no, dateISO, booked: mineShoots.length > 0, shoots: mineShoots, items: mineItems,
      filmed: mineItems.filter(isFilmed).length,
      filmedHere: items.filter((x) => x.filmedSessionNo === no).length,
    });
  }
  const next = sessions.find((s) => s.items.some((x) => !isFilmed(x)))?.no ?? null;
  return {
    plan: {
      id: plan.id, monthId: plan.monthId, enrollmentId: plan.enrollmentId, clientId: plan.clientId, title: plan.title, status: plan.status,
      totalVideos: plan.totalVideos, perSession: plan.perSession, sessionsPlanned: plan.sessionsPlanned, cadenceDays: plan.cadenceDays,
      startsOnISO: plan.startsOn?.toISOString() ?? null, endsOnISO: plannedEnd(plan).toISOString(), editingNote: plan.editingNote, sourceFile: plan.sourceFile,
    },
    sessions,
    unplanned: items.filter((x) => x.sessionNo == null),
    totals: {
      planned: items.length,
      filmed: items.filter(isFilmed).length,
      delivered: items.filter((x) => x.state === "delivered").length,
      clientDone: items.filter((x) => !!x.clientMarkedDoneAtISO).length,
      released: items.filter((x) => x.released).length,
    },
    nextSessionNo: next,
  };
}

// ---- creating a plan ----------------------------------------------------------------

export type CreateBulkPlanInput = {
  enrollmentId: string;
  totalVideos: number;
  perSession: number;
  sessionsPlanned?: number | null;
  cadenceDays?: number | null;
  startsOn?: Date | null;
  /** The month that holds the plan; the current ET month when not given. */
  monthKey?: string | null;
  title?: string | null;
  editingNote?: string | null;
};

/**
 * Turn a client onto a bulk plan. Idempotent per client: an ACTIVE plan is
 * refused (change it, or cancel it first). The anchor month owes the plan's
 * total, needs no strategy call, and is planned by the office in writing.
 */
export async function createBulkPlan(input: CreateBulkPlanInput, actor: BulkActor): Promise<{ planId: string; monthId: string }> {
  const total = Math.trunc(Number(input.totalVideos));
  const per = Math.trunc(Number(input.perSession));
  if (!Number.isFinite(total) || total < 1 || total > 200) throw new Error("Total videos is a whole number from 1 to 200.");
  if (!Number.isFinite(per) || per < 1 || per > 40) throw new Error("Videos per session is a whole number from 1 to 40.");
  const sessions = input.sessionsPlanned ? Math.trunc(Number(input.sessionsPlanned)) : Math.ceil(total / per);
  if (!Number.isFinite(sessions) || sessions < 1 || sessions > 60) throw new Error("Sessions is a whole number from 1 to 60.");
  const cadence = input.cadenceDays ? Math.trunc(Number(input.cadenceDays)) : 7;
  if (!Number.isFinite(cadence) || cadence < 1 || cadence > 60) throw new Error("Days between sessions is a whole number from 1 to 60.");
  const monthKey = (input.monthKey ?? "").trim() || etMonthKey();
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error("The plan month looks like 2026-10.");

  const e = await prisma.contentEnrollment.findUnique({ where: { id: input.enrollmentId } });
  if (!e) throw new Error("That client isn't on the program.");
  if (await activeBulkPlanFor(e.id)) throw new Error("This client already has an active bulk plan — change that one instead.");

  let month = await prisma.contentMonth.findUnique({ where: { enrollmentId_monthKey: { enrollmentId: e.id, monthKey } } });
  const now = new Date();
  if (month) {
    if (await prisma.contentBulkPlan.findUnique({ where: { monthId: month.id } })) throw new Error(`${monthKey} already holds a bulk plan for this client.`);
    month = await prisma.contentMonth.update({
      where: { id: month.id },
      data: {
        videosOwed: total,
        status: "OPEN",
        ...(month.strategyCallStatus === "COMPLETED" || month.strategyCallStatus === "SCHEDULED" ? {} : { strategyCallStatus: "NOT_REQUIRED" }),
        planningMode: "WRITTEN", planningChosenAt: now, planningChosenBy: `office:${actor.email}`,
      },
    });
  } else {
    month = await prisma.contentMonth.create({
      data: { enrollmentId: e.id, clientId: e.clientId, monthKey, videosOwed: total, strategyCallStatus: "NOT_REQUIRED", planningMode: "WRITTEN", planningChosenAt: now, planningChosenBy: `office:${actor.email}` },
    });
  }
  const startsOn = input.startsOn ?? null;
  const endsOn = startsOn ? new Date(startsOn.getTime() + (sessions - 1) * cadence * DAY) : null;
  const plan = await prisma.contentBulkPlan.create({
    data: {
      enrollmentId: e.id, clientId: e.clientId, monthId: month.id, title: input.title?.trim().slice(0, 120) || null,
      totalVideos: total, perSession: per, sessionsPlanned: sessions, cadenceDays: cadence, startsOn, endsOn,
      status: "ACTIVE", editingNote: input.editingNote?.trim().slice(0, 2000) || null, createdBy: actor.email,
    },
  });
  // The client's switches: bulk, owned by a person (the Aryeo plan sweep must
  // never re-package or pause this client), and active so the portal is not read-only.
  const { recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  const changed: { field: string; from: unknown; to: unknown }[] = [];
  if (e.programKind !== BULK_KIND) changed.push({ field: "programKind", from: e.programKind ?? "MONTHLY", to: BULK_KIND });
  if (e.status !== "ACTIVE") changed.push({ field: "status", from: e.status, to: "ACTIVE" });
  await prisma.contentEnrollment.update({ where: { id: e.id }, data: { programKind: BULK_KIND, status: "ACTIVE", statusManual: true, packageSource: "manual" } });
  for (const c of changed) {
    await recordEnrollmentChange({ enrollmentId: e.id, clientId: e.clientId, field: c.field as "programKind" | "status", from: c.from, to: c.to, effectiveAt: now, effectiveMonthKey: monthKey, changedBy: actor.email, appliedAt: now, reason: `Bulk plan: ${total} videos, ${per} per session, ${sessions} sessions` });
  }
  // Shoots already booked in the plan window join it now (the sweep would on its next run).
  await attachBulkShoots(plan.id).catch(() => 0);
  return { planId: plan.id, monthId: month.id };
}

/** Change the plan's numbers (sessions slip, Rick films 10 in a day). Never moves a script by itself. */
export async function updateBulkPlan(planId: string, patch: { perSession?: number; sessionsPlanned?: number; cadenceDays?: number; startsOn?: Date | null; editingNote?: string | null; title?: string | null; totalVideos?: number; status?: "ACTIVE" | "COMPLETE" | "CANCELLED" }, actor: BulkActor): Promise<void> {
  const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("That plan isn't on file.");
  const data: Record<string, unknown> = {};
  const int = (v: unknown, lo: number, hi: number, what: string) => {
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${what} is a whole number from ${lo} to ${hi}.`);
    return n;
  };
  if (patch.perSession !== undefined) data.perSession = int(patch.perSession, 1, 40, "Videos per session");
  if (patch.sessionsPlanned !== undefined) data.sessionsPlanned = int(patch.sessionsPlanned, 1, 60, "Sessions");
  if (patch.cadenceDays !== undefined) data.cadenceDays = int(patch.cadenceDays, 1, 60, "Days between sessions");
  if (patch.totalVideos !== undefined) data.totalVideos = int(patch.totalVideos, 1, 200, "Total videos");
  if (patch.startsOn !== undefined) data.startsOn = patch.startsOn;
  if (patch.editingNote !== undefined) data.editingNote = patch.editingNote?.trim().slice(0, 2000) || null;
  if (patch.title !== undefined) data.title = patch.title?.trim().slice(0, 120) || null;
  if (patch.status !== undefined) {
    if (!["ACTIVE", "COMPLETE", "CANCELLED"].includes(patch.status)) throw new Error("Unknown plan status.");
    data.status = patch.status;
  }
  const next = { ...plan, ...data } as typeof plan;
  data.endsOn = next.startsOn ? new Date(next.startsOn.getTime() + Math.max(0, next.sessionsPlanned - 1) * next.cadenceDays * DAY) : null;
  await prisma.contentBulkPlan.update({ where: { id: planId }, data });
  if (data.totalVideos !== undefined) await prisma.contentMonth.update({ where: { id: plan.monthId }, data: { videosOwed: data.totalVideos as number } });
  void actor;
}

/** Attach the client's booked content shoots in the plan window to the plan month (only blanks). */
export async function attachBulkShoots(planId: string): Promise<number> {
  const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId } });
  if (!plan || plan.status !== "ACTIVE") return 0;
  const { MONTHLY_PLAN_RE } = await import("@/lib/pipeline");
  const rows = await prisma.project.findMany({
    where: { clientId: plan.clientId, contentMonthId: null, status: { not: "CANCELLED" }, shootDate: { not: null } },
    select: { id: true, shootDate: true, deliverables: { where: { removedFromOrderAt: null }, select: { label: true } } },
  });
  let n = 0;
  for (const p of rows) {
    if (!p.deliverables.some((d) => d.label && MONTHLY_PLAN_RE.test(d.label))) continue;
    if ((await bulkMonthForShoot(plan.clientId, p.shootDate)) !== plan.monthId) continue;
    const w = await prisma.project.updateMany({ where: { id: p.id, contentMonthId: null }, data: { contentMonthId: plan.monthId } });
    n += w.count;
  }
  return n;
}

// ---- importing the scripts ------------------------------------------------------------

export type BulkScriptInput = {
  title: string;
  /** The pillar as the document names it ("Personal Brand", "Seller Strategy"). */
  category?: string | null;
  hook: string;
  /** Spoken lines after the hook, in order (Rick: BEAT, PAYOFF). */
  lines: { role?: "re-hook" | "build-up" | "payoff" | null; text: string }[];
  /** The closing call to action (Rick: the on-screen CTA). */
  close: string;
  caption?: string | null;
};

export const BULK_IMPORT_KIND = "BULK_SCRIPTS";

/**
 * Add a client's already-written scripts to the plan, IN ORDER: script i is
 * planned for session ceil(i / perSession) after whatever the plan already
 * holds. The words are kept exactly (no AI). Each lands in the review queue
 * like any upload; `release` approves and shares them to the portal at once
 * (Jordan wrote or approved them), with the scripts-ready email held back:
 * the office tells the client.
 */
export async function importBulkScripts(planId: string, items: BulkScriptInput[], actor: BulkActor, opts: { release?: boolean; sourceFile?: string | null; approvalNote?: string | null } = {}): Promise<{ batchId: string; created: number; released: number; problems: { title: string; why: string }[] }> {
  const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("That plan isn't on file.");
  if (plan.status !== "ACTIVE") throw new Error("That plan is closed — reopen it first.");
  const clean = items
    .map((it) => ({ ...it, title: (it.title ?? "").trim().slice(0, 200), hook: (it.hook ?? "").trim(), close: (it.close ?? "").trim(), lines: (it.lines ?? []).filter((l) => l.text?.trim()) }))
    .filter((it) => it.title && it.hook);
  if (!clean.length) throw new Error("No scripts to add — each needs a title and a hook.");
  if (clean.length > 200) throw new Error("That's more than 200 scripts — split the document.");

  const { sha256 } = await import("@/lib/aiRuns");
  const contentHash = sha256(JSON.stringify({ plan: plan.id, items: clean.map((x) => [x.title, x.hook, x.lines.map((l) => l.text), x.close]) }));
  const prior = await prisma.contentImportBatch.findUnique({ where: { kind_contentHash: { kind: BULK_IMPORT_KIND, contentHash } }, select: { id: true } });
  if (prior) throw new Error("These scripts were already added to this plan — undo that import first to add them again.");

  const { createTopic, selectTopicForMonth } = await import("@/lib/contentTopics");
  const { createScriptVersion } = await import("@/lib/contentScripts");
  const { confirmedPillarIdFor } = await import("@/lib/contentPillars");
  const staff = { kind: "STAFF" as const, staffUserId: actor.appUserId ?? actor.email };
  const fileLabel = (opts.sourceFile ?? "").trim().slice(0, 200) || "Pasted scripts";

  const batch = await prisma.contentImportBatch.create({
    data: { kind: BULK_IMPORT_KIND, enrollmentId: plan.enrollmentId, clientId: plan.clientId, fileName: fileLabel, contentHash, proposedMonthKey: null, mode: "PREVIEW", uploadedBy: actor.email },
    select: { id: true },
  });
  const ledger: { planId: string; monthId: string; topicIds: string[]; createdTopicIds: string[]; scriptIds: string[]; by: string; at: string } = {
    planId: plan.id, monthId: plan.monthId, topicIds: [], createdTopicIds: [], scriptIds: [], by: actor.email, at: new Date().toISOString(),
  };
  const save = () => prisma.contentImportBatch.update({ where: { id: batch.id }, data: { previewJson: JSON.stringify(ledger) } });

  // Plan order continues after whatever is already planned.
  const existing = await prisma.contentTopicSelection.findMany({ where: { monthId: plan.monthId, status: { in: LIVE } }, select: { rank: true } });
  const startRank = Math.max(existing.length, ...existing.map((s) => s.rank ?? 0));
  const problems: { title: string; why: string }[] = [];
  try {
    for (const [i, it] of clean.entries()) {
      const rank = startRank + i + 1;
      const sessionNo = Math.ceil(rank / plan.perSession);
      const pillarId = await confirmedPillarIdFor(plan.enrollmentId, it.category ?? null, { activeOnly: true }).catch(() => null);
      const created = await createTopic({
        enrollmentId: plan.enrollmentId, title: it.title, pillarId, pillarLabel: pillarId ? null : it.category ?? null, concept: it.hook,
        source: "staff", status: "SELECTED", monthId: plan.monthId, approvalState: "APPROVED", approvedBy: actor.email, actor: staff,
        sourceRef: `bulk:${batch.id}`, note: `Bulk plan script ${rank} of the plan (${fileLabel})`,
      });
      ledger.topicIds.push(created.id);
      if (!created.existed) ledger.createdTopicIds.push(created.id);
      await selectTopicForMonth(created.id, plan.monthId, { source: "staff", actor: staff, status: "SELECTED" });
      await prisma.contentTopicSelection.update({ where: { topicId_monthId: { topicId: created.id, monthId: plan.monthId } }, data: { rank, sessionNo } });
      const roles: ("re-hook" | "build-up" | "payoff")[] = it.lines.length === 2 ? ["build-up", "payoff"] : ["re-hook", "build-up", "payoff"];
      const v = await createScriptVersion({
        enrollmentId: plan.enrollmentId, monthId: plan.monthId, topicId: created.id, source: "MANUAL", status: "INTERNAL_REVIEW", createdBy: actor.email, sourceFile: fileLabel,
        changeSummary: `From the bulk plan's script bank (${fileLabel}), words kept exactly`,
        parts: {
          title: it.title, categoryLabel: it.category ?? null, pillarId,
          hook: it.hook,
          points: it.lines.map((l, k) => ({ role: l.role ?? roles[k] ?? null, text: l.text.trim() })),
          close: it.close, captionCta: it.caption?.trim() || null,
          creativeDirection: plan.editingNote ?? null,
        },
      });
      ledger.scriptIds.push(v.scriptId);
      await save();
    }
  } catch (e) {
    await prisma.contentImportBatch.update({ where: { id: batch.id }, data: { mode: "APPLIED", appliedAt: new Date(), appliedBy: actor.email, itemsCreated: ledger.scriptIds.length, lastError: (e instanceof Error ? e.message : String(e)).slice(0, 1000), previewJson: JSON.stringify(ledger) } }).catch(() => {});
    throw new Error(`${e instanceof Error ? e.message : "Something went wrong"}${ledger.scriptIds.length ? ` — ${ledger.scriptIds.length} were added before it stopped; Undo on the plan takes them back.` : ""}`);
  }
  await prisma.contentImportBatch.update({ where: { id: batch.id }, data: { mode: "APPLIED", appliedAt: new Date(), appliedBy: actor.email, itemsCreated: ledger.scriptIds.length, previewJson: JSON.stringify(ledger) } });
  if (opts.sourceFile) await prisma.contentBulkPlan.update({ where: { id: plan.id }, data: { sourceFile: fileLabel } });

  let released = 0;
  if (opts.release) {
    const r = await releaseBulkScripts(plan.id, ledger.scriptIds, actor, opts.approvalNote ?? null);
    released = r.released;
    problems.push(...r.problems);
  }
  return { batchId: batch.id, created: ledger.scriptIds.length, released, problems };
}

/** Approve + share to the portal, the email held back (the office tells the client). */
export async function releaseBulkScripts(planId: string, scriptIds: string[] | null, actor: BulkActor, note: string | null): Promise<{ released: number; problems: { title: string; why: string }[] }> {
  const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("That plan isn't on file.");
  const scripts = await prisma.contentScript.findMany({
    where: { monthId: plan.monthId, historical: false, ...(scriptIds ? { id: { in: scriptIds } } : {}) },
    select: { id: true, title: true, currentVersionId: true, sharedVersionId: true },
  });
  const { approveScriptVersion, releaseScriptVersion } = await import("@/lib/contentScripts");
  const who = { email: actor.email, appUserId: actor.appUserId ?? null };
  const why = note?.trim() || "Bulk plan: the client's own script bank, approved by the office";
  const batchKey = `bulk:${plan.id}:${new Date().toISOString()}`;
  let released = 0;
  const problems: { title: string; why: string }[] = [];
  for (const s of scripts) {
    if (!s.currentVersionId) { problems.push({ title: s.title, why: "no version to approve" }); continue; }
    if (s.sharedVersionId === s.currentVersionId) continue;
    try {
      await approveScriptVersion(s.currentVersionId, who, why);
      await releaseScriptVersion(s.id, who, { batchKey, note: why, quiet: "bulk plan release: the office tells the client their scripts are on the portal" });
      released++;
    } catch (e) {
      problems.push({ title: s.title, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return { released, problems };
}

/** Undo a bulk import: the scripts, topics and plan places it made go (nothing filmed may be undone). */
export async function undoBulkImport(batchId: string, actor: BulkActor): Promise<{ removed: number }> {
  const b = await prisma.contentImportBatch.findUnique({ where: { id: batchId } });
  if (!b || b.kind !== BULK_IMPORT_KIND || b.mode !== "APPLIED") throw new Error("That import isn't on file any more.");
  const led = JSON.parse(b.previewJson ?? "{}") as { monthId?: string; topicIds?: string[]; createdTopicIds?: string[]; scriptIds?: string[] };
  if (!led.monthId) throw new Error("That import has no ledger.");
  const filmed = await prisma.contentVideo.count({ where: { monthId: led.monthId, topicId: { in: led.topicIds ?? [] }, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } } });
  if (filmed) throw new Error(`${filmed} of these scripts ${filmed === 1 ? "is" : "are"} already filmed — undo is only for scripts nobody has filmed.`);
  const now = new Date();
  await prisma.contentTopicSelection.updateMany({ where: { monthId: led.monthId, topicId: { in: led.topicIds ?? [] } }, data: { status: "REMOVED", rank: null, sessionNo: null, removedAt: now, removedBy: actor.email, removedReason: `BULK_IMPORT_UNDONE:${batchId}` } });
  await prisma.contentScript.updateMany({ where: { id: { in: led.scriptIds ?? [] } }, data: { monthId: null, status: "DRAFT", releaseState: "withheld", sharedVersionId: null } });
  await prisma.contentTopic.updateMany({ where: { id: { in: led.createdTopicIds ?? [] } }, data: { monthId: null, status: "ARCHIVED" } });
  await prisma.contentImportBatch.update({ where: { id: batchId }, data: { mode: "UNDONE", contentHash: `${b.contentHash}:undone:${now.getTime()}`, previewJson: JSON.stringify({ ...led, undoneBy: actor.email, undoneAt: now.toISOString() }) } });
  return { removed: (led.scriptIds ?? []).length };
}

// ---- moving scripts between sessions ------------------------------------------------------

async function selectionOnPlan(planId: string, topicId: string) {
  const plan = await prisma.contentBulkPlan.findUnique({ where: { id: planId } });
  if (!plan) throw new Error("That plan isn't on file.");
  const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId: plan.monthId } } });
  if (!sel || !LIVE.includes(sel.status)) throw new Error("That script isn't on this plan.");
  return { plan, sel };
}

/** Move one script to another session. Its plan order (rank) is kept, so it sorts into place. */
export async function moveToSession(planId: string, topicId: string, sessionNo: number, actor: BulkActor): Promise<void> {
  if (!Number.isInteger(sessionNo) || sessionNo < 1 || sessionNo > 60) throw new Error("A session number is a whole number from 1.");
  const { plan, sel } = await selectionOnPlan(planId, topicId);
  if (sel.sessionNo === sessionNo) return;
  await prisma.contentTopicSelection.update({ where: { id: sel.id }, data: { sessionNo } });
  if (sessionNo > plan.sessionsPlanned) await prisma.contentBulkPlan.update({ where: { id: plan.id }, data: { sessionsPlanned: sessionNo } });
  const { recordTopicEvent } = await import("@/lib/contentTopics");
  await recordTopicEvent(topicId, plan.enrollmentId, "CARRIED", { kind: "STAFF", staffUserId: actor.appUserId ?? actor.email }, { monthId: plan.monthId, note: `Bulk plan: moved from session ${sel.sessionNo ?? "none"} to session ${sessionNo} by ${actor.name ?? actor.email}` });
}

/** Move a script one place up or down in the plan order (swaps rank with its neighbour). */
export async function nudgeOrder(planId: string, topicId: string, dir: "up" | "down"): Promise<void> {
  const { plan, sel } = await selectionOnPlan(planId, topicId);
  const all = await prisma.contentTopicSelection.findMany({ where: { monthId: plan.monthId, status: { in: LIVE } }, orderBy: [{ rank: "asc" }, { createdAt: "asc" }], select: { id: true, rank: true, sessionNo: true } });
  const i = all.findIndex((x) => x.id === sel.id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= all.length) return;
  const a = all[i], b = all[j];
  const ra = a.rank ?? i + 1, rb = b.rank ?? j + 1;
  // Crossing a session line moves the script into the neighbour's session.
  await prisma.contentTopicSelection.update({ where: { id: a.id }, data: { rank: rb, sessionNo: b.sessionNo } });
  await prisma.contentTopicSelection.update({ where: { id: b.id }, data: { rank: ra, sessionNo: a.sessionNo } });
}

/**
 * Spread every script nobody has filmed yet across the sessions still to come,
 * `perSession` at a time, in plan order. Sessions that already happened (a
 * shoot dated in the past, or anything filmed at it) are left as they are.
 */
export async function rebalanceRemaining(planId: string, actor: BulkActor, opts: { perSession?: number | null } = {}): Promise<{ moved: number; fromSession: number }> {
  const board = await bulkBoard(planId);
  if (!board) throw new Error("That plan isn't on file.");
  const per = opts.perSession ? Math.trunc(Number(opts.perSession)) : board.plan.perSession;
  if (!Number.isFinite(per) || per < 1 || per > 40) throw new Error("Videos per session is a whole number from 1 to 40.");
  const now = Date.now();
  const done = board.sessions.filter((s) => s.filmedHere > 0 || s.shoots.some((sh) => sh.shootDateISO && new Date(sh.shootDateISO).getTime() < now - 12 * 3600_000)).map((s) => s.no);
  const fromSession = (done.length ? Math.max(...done) : 0) + 1;
  const open = [...board.sessions.flatMap((s) => s.items), ...board.unplanned]
    .filter((x) => x.state === "planned" || x.state === "client_done")
    .sort((a, b) => a.rank - b.rank);
  let moved = 0;
  for (const [i, x] of open.entries()) {
    const target = fromSession + Math.floor(i / per);
    if (x.sessionNo === target) continue;
    await prisma.contentTopicSelection.update({ where: { id: x.selectionId }, data: { sessionNo: target } });
    moved++;
  }
  const lastSession = fromSession + Math.max(0, Math.ceil(open.length / per) - 1);
  const keep = Math.max(lastSession, ...done, 1);
  await prisma.contentBulkPlan.update({ where: { id: planId }, data: { sessionsPlanned: keep, ...(opts.perSession ? { perSession: per } : {}) } });
  void actor;
  return { moved, fromSession };
}

/**
 * After a filming report lands for a bulk shoot: what was planned for this
 * session and NOT filmed moves to the next session (it keeps its plan order,
 * so it sits at the top of that session). Scripts pulled ahead from later
 * sessions are already filmed and need nothing. Idempotent.
 */
export async function carryForwardAfterFilming(projectId: string): Promise<{ carried: number; sessionNo: number | null }> {
  const at = await sessionOfProject(projectId);
  if (!at) return { carried: 0, sessionNo: null };
  // The session's videos now exist: date them by batch at once (Oct 27 2026,
  // lib/bulkBatches), not at the next hourly pass.
  await import("@/lib/bulkBatches").then((m) => m.stampBulkBatches({ monthId: at.plan.monthId })).catch(() => null);
  const board = await bulkBoardForMonth(at.plan.monthId);
  if (!board) return { carried: 0, sessionNo: at.sessionNo };
  const session = board.sessions.find((s) => s.no === at.sessionNo);
  if (!session) return { carried: 0, sessionNo: at.sessionNo };
  const left = session.items.filter((x) => x.state === "planned" || x.state === "client_done");
  if (!left.length) return { carried: 0, sessionNo: at.sessionNo };
  const { recordTopicEvent } = await import("@/lib/contentTopics");
  for (const x of left) {
    await prisma.contentTopicSelection.update({ where: { id: x.selectionId }, data: { sessionNo: at.sessionNo + 1 } });
    await recordTopicEvent(x.topicId, at.plan.enrollmentId, "CARRIED", { kind: "SYSTEM" }, { monthId: at.plan.monthId, note: `Bulk plan: not filmed at session ${at.sessionNo}, moved to session ${at.sessionNo + 1}` }).catch(() => {});
  }
  if (at.sessionNo + 1 > at.plan.sessionsPlanned) await prisma.contentBulkPlan.update({ where: { id: at.plan.id }, data: { sessionsPlanned: at.sessionNo + 1 } });
  return { carried: left.length, sessionNo: at.sessionNo };
}

// ---- the client's own tick ------------------------------------------------------------------

/**
 * The client marks a script done (or not). Advisory: the board shows it, the
 * office sees it, nothing counts it as filmed. Only a script released to the
 * client's portal, on a bulk plan of theirs, can be marked.
 */
export async function setClientMarkedDone(enrollmentId: string, scriptId: string, done: boolean, who: string): Promise<{ done: boolean }> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { id: true, enrollmentId: true, monthId: true, sharedVersionId: true, clientMarkedDoneAt: true } });
  if (!s || s.enrollmentId !== enrollmentId) throw new Error("That script isn't yours.");
  if (!s.sharedVersionId) throw new Error("That script isn't on your portal yet.");
  if (!s.monthId || !(await bulkPlanForMonth(s.monthId))) throw new Error("Marking scripts done is for session plans.");
  if (done === !!s.clientMarkedDoneAt) return { done };
  await prisma.contentScript.update({ where: { id: scriptId }, data: done ? { clientMarkedDoneAt: new Date(), clientMarkedDoneBy: who.slice(0, 200) } : { clientMarkedDoneAt: null, clientMarkedDoneBy: null } });
  return { done };
}

// ---- the client's own script format --------------------------------------------------------

/**
 * A client whose scripts are written in THEIR format (Rick's Hook / Beat /
 * Payoff), set by the office and ledgered. The house shape rule (exactly three
 * talking points) is then reported, not enforced; every other check stands.
 */
export async function clientScriptFormat(enrollmentId: string | null | undefined): Promise<string | null> {
  if (!enrollmentId) return null;
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { overridesJson: true } });
  if (!e?.overridesJson) return null;
  try {
    const v = JSON.parse(e.overridesJson) as { clientScriptFormat?: unknown };
    return typeof v.clientScriptFormat === "string" && v.clientScriptFormat.trim() ? v.clientScriptFormat.trim() : null;
  } catch {
    return null;
  }
}

export async function setClientScriptFormat(enrollmentId: string, label: string | null, by: string): Promise<void> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { clientId: true, overridesJson: true } });
  if (!e) throw new Error("Enrollment not found.");
  let cur: Record<string, unknown> = {};
  try { cur = e.overridesJson ? (JSON.parse(e.overridesJson) as Record<string, unknown>) : {}; } catch { cur = {}; }
  const value = label?.trim().slice(0, 120) || null;
  if ((cur.clientScriptFormat ?? null) === value) return;
  const next = { ...cur };
  if (value) next.clientScriptFormat = value; else delete next.clientScriptFormat;
  const now = new Date();
  const { recordEnrollmentChange } = await import("@/lib/enrollmentChanges");
  await recordEnrollmentChange({ enrollmentId, clientId: e.clientId, field: "overrides", from: { clientScriptFormat: cur.clientScriptFormat ?? null }, to: { clientScriptFormat: value }, effectiveAt: now, effectiveMonthKey: etMonthKey(), changedBy: by, appliedAt: now });
  await prisma.contentEnrollment.update({ where: { id: enrollmentId }, data: { overridesJson: Object.keys(next).length ? JSON.stringify(next) : null } });
}
