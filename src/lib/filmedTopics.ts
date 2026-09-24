import "server-only";
import crypto from "crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WHICH TOPICS WERE ACTUALLY FILMED (spec §9, F12) — Sep 22 2026.
//
// The upload portal asked the photographer ONE question about a content
// session: "How many videos did you film?" — a single integer for the whole
// shoot. So the hub knew that four videos exist and had no idea which four of
// the month's topics they are. Every downstream link the program depends on —
// this video is that topic, which is that script, which the client approved —
// had to be guessed afterwards or left empty, and the Phase 0 read found it
// empty: the Script/Topic → Video join is the one edge in §15's chain with
// nothing in it.
//
// It also decided a date. 100% of the filming dates in production are DERIVED
// from Project.shootDate, and Jordan's ruling on Sep 21 was explicit: never
// invent a production date, and an unknown deadline must never read as on time.
// A photographer ticking the topics they filmed is the only moment anybody who
// was there says so, which is why the confirmation is stamped separately
// (filmedConfirmedAt/By/Source) from the inferred filmedAt and why the hourly
// sweep will not overwrite it.
//
// WHAT IT DOES NOT DO. It does not mark a topic filmed because a video exists,
// does not tick anything on the photographer's behalf, and does not touch a
// topic they left unticked — an unticked topic was NOT filmed, and a month that
// reads one short is the truth the board needs, not a gap to paper over.
//
// ---------------------------------------------------------------------------
// CP-09 (audit Sep 24 2026): THE TICKS COULD BE LOST, AND NOTHING COULD GET
// THEM BACK.
//
// finalizeUpload wrote the project, then called confirmFilmedTopics inside a
// catch that swallowed everything, and the ticks themselves were stored
// nowhere else. Its comment said "the hourly sweep still sees the project" —
// but no sweep can reconstruct which boxes a photographer ticked from the fact
// that a project exists. One failed write and the photographer's only report
// of what was filmed was gone, silently.
//
// Now the report is a ROW (ContentFilmingReport), written in the same
// transaction as the debrief, and applying it is a separate, retryable step:
//   · applyFilmingReport claims it (a lease, so two runs never apply it at
//     once), creates any extra topic filmed on site, confirms the topics,
//     binds each confirmed video to one of the editor's owed-video slots, and
//     files the office's capacity review for anything beyond the plan;
//   · a failure is FAILED with a backoff, and sweepFilmingReports (hourly, in
//     cron/sync before the library sweep) tries again until it lands — after
//     six attempts it stops and puts it in front of Kyle rather than retrying
//     for ever;
//   · the same payload submitted twice is ONE report (unique projectId +
//     payloadHash), and every write below is find-or-create under a per-project
//     advisory lock, so a retry never makes a second video.
// ---------------------------------------------------------------------------

/** The id shape every other content-program reader accepts (scriptDecisions, clientDecisions). */
const ID_RE = /^[a-z0-9]{10,40}$/i;
/** Server-side caps on what one submit may carry — a month has a dozen topics, not hundreds. */
export const FILMING_LIMITS = { topics: 40, extras: 10, titleChars: 200, noteChars: 1000 } as const;
const HOUR = 3_600_000;
/**
 * A leg that STARTS within this window of the submit counts as the one filmed:
 * the photographer may press Submit from the car before the booked end time, or
 * a phone clock may be a little off. Anything later is a future leg — a Pro
 * month's second session booked for next week — and never dates this footage.
 */
const LEG_HORIZON_MS = 6 * HOUR;
const LEASE_MS = 5 * 60_000;
const RETRY_BASE_MS = 15 * 60_000;
/** After this many failed attempts the report stops retrying and goes to a person. */
export const FILMING_REPORT_MAX_ATTEMPTS = 6;
/** Aryeo spells it CANCELED; the second spelling is belt and braces. */
const CANCELLED = ["CANCELED", "CANCELLED"];
/** A topic held on the month by its legacy pointer (ContentTopic.monthId) at one of these stages is this month's. */
const HELD_ON_MONTH = ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"];
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "CARRIED"];

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export type SessionTopic = {
  topicId: string;
  title: string;
  pillarName: string | null;
  /** The script the client is expecting to say, when there is one. */
  scriptId: string | null;
  scriptTitle: string | null;
  /** The version currently shared with the client — what a confirmation records as filmed when it was approved. */
  scriptSharedVersionId: string | null;
  /**
   * The client signed off on THE WORDS THAT ARE SHARED (F09). Read through
   * scriptDecisionsFor so this agrees with the portal and the staff panel —
   * a client who asked for a change must never read as approved here (R1).
   */
  clientApproved: boolean;
  /** A person has already confirmed this one was filmed, and when. */
  filmedConfirmedAtISO: string | null;
  filmedConfirmedBy: string | null;
  videoId: string | null;
  /**
   * CP-09: WHICH SESSION it was confirmed at. A Pro month is two sessions and
   * can be two projects; a topic confirmed at the first is that session's, and
   * the second session's page must neither pre-tick it nor count it again.
   */
  confirmedOnProjectId: string | null;
  /** The month selection behind it — null for a legacy topic held on the month by ContentTopic.monthId alone. */
  selectionId: string | null;
  /** Selected beyond the package's allowance (ContentTopicSelection.overflow). */
  overflow: boolean;
  /** The topic's raw-footage folder on THIS project, once one exists (topic folders are batch C). */
  folderPath: string | null;
  /** The photographer's latest note to the editor about this topic on THIS project. */
  note: string | null;
};

/** A filming report on this project that has not landed yet — the page says so rather than pretending. */
export type PendingFilmingReport = {
  id: string;
  state: string;
  attempts: number;
  lastError: string | null;
  createdAtISO: string;
  nextAttemptAtISO: string | null;
};

export type SessionTopics = {
  monthId: string;
  monthKey: string;
  enrollmentId: string;
  clientId: string;
  /** How many videos the month owes — the number the count box used to ask for. */
  owed: number;
  topics: SessionTopic[];
  pendingReport: PendingFilmingReport | null;
};

/**
 * The topics this filming session is for, or null when the project is not
 * content-program work (an ordinary listing shoot has no month and no topics).
 *
 * CP-09: the month's topics are its SELECTIONS plus any topic held on the month
 * only by the legacy pointer (ContentTopic.monthId at SELECTED..DELIVERED —
 * content/actions.ts still writes that shape, and programOverview counts it).
 * Reading selections alone gave such a month an empty list, and the page fell
 * back to the bare count box. A topic whose selection for this month was
 * REMOVED stays out: the removal is the office's decision, and the legacy
 * pointer lagging behind it is not a second opinion.
 */
export async function topicsForSession(projectId: string): Promise<SessionTopics | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, contentMonthId: true } });
  if (!project?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({
    where: { id: project.contentMonthId },
    select: { id: true, monthKey: true, enrollmentId: true, clientId: true, videosOwed: true },
  });
  if (!month) return null;

  const [allSelections, legacy, pendingRow] = await Promise.all([
    prisma.contentTopicSelection.findMany({
      where: { monthId: month.id },
      select: { id: true, topicId: true, status: true, rank: true, createdAt: true, overflow: true },
      orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    }),
    prisma.contentTopic.findMany({
      where: { monthId: month.id, enrollmentId: month.enrollmentId, status: { in: HELD_ON_MONTH } },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.contentFilmingReport.findFirst({
      where: { projectId, state: { not: "APPLIED" } },
      orderBy: { createdAt: "desc" },
      select: { id: true, state: true, attempts: true, lastError: true, createdAt: true, nextAttemptAt: true },
    }),
  ]);
  const pendingReport: PendingFilmingReport | null = pendingRow
    ? {
        id: pendingRow.id,
        state: pendingRow.state,
        attempts: pendingRow.attempts,
        lastError: pendingRow.lastError,
        createdAtISO: pendingRow.createdAt.toISOString(),
        nextAttemptAtISO: pendingRow.nextAttemptAt?.toISOString() ?? null,
      }
    : null;
  const hasSelectionRow = new Set(allSelections.map((s) => s.topicId));
  const order: { topicId: string; selectionId: string | null; overflow: boolean }[] = [
    ...allSelections.filter((s) => LIVE_SELECTION.includes(s.status)).map((s) => ({ topicId: s.topicId, selectionId: s.id, overflow: s.overflow })),
    ...legacy.filter((t) => !hasSelectionRow.has(t.id)).map((t) => ({ topicId: t.id, selectionId: null, overflow: false })),
  ];
  const base = { monthId: month.id, monthKey: month.monthKey, enrollmentId: month.enrollmentId, clientId: month.clientId, owed: month.videosOwed, pendingReport };
  if (!order.length) return { ...base, topics: [] };

  const topicIds = order.map((s) => s.topicId);
  const [topics, scripts, videos, pillars, folders, reports] = await Promise.all([
    prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true, pillarId: true } }),
    // ONE script per topic, chosen deterministically. Nothing in the schema
    // makes (monthId, topicId) unique, and an unordered findMany + `.find()`
    // means two scripts on one topic answer differently between two renders of
    // the same page. Newest first, and the `.find()` below takes that one.
    prisma.contentScript.findMany({
      where: { monthId: month.id, topicId: { in: topicIds }, historical: false },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: { id: true, topicId: true, title: true, sharedVersionId: true },
    }),
    // An ARCHIVED video is not the topic's video any more (the library sweep
    // archives duplicates); reading one here would report a confirmation that
    // no count anywhere includes.
    prisma.contentVideo.findMany({
      where: { monthId: month.id, topicId: { in: topicIds }, status: { not: "ARCHIVED" } },
      orderBy: { createdAt: "asc" },
      select: { id: true, topicId: true, projectId: true, filmedConfirmedAt: true, filmedConfirmedBy: true },
    }),
    prisma.contentPillar.findMany({ where: { enrollmentId: month.enrollmentId }, select: { id: true, name: true } }),
    prisma.contentTopicFolder.findMany({ where: { projectId, topicId: { in: topicIds } }, select: { topicId: true, dropboxPath: true } }),
    prisma.contentFilmingReport.findMany({ where: { projectId }, orderBy: { createdAt: "desc" }, take: 20, select: { notesJson: true } }),
  ]);
  // R1 — ONE RULE FOR "DID THE CLIENT APPROVE THIS".
  //
  // This used to compute it here, from `clientApprovedVersionId === sharedVersionId`.
  // The portal and the staff panel read the newest ledger row instead, and a
  // change request never cleared that pointer — so a client could ask for a
  // change and the person holding the camera would still be told they had
  // signed off on it. The filming brief is the LAST place that should be
  // guessing, so it asks the same function the other two do.
  const { scriptDecisionsFor } = await import("@/lib/scriptDecisions");
  const verdicts = scripts.length
    ? await scriptDecisionsFor(month.enrollmentId, scripts.map((sc) => sc.id)).catch(() => new Map())
    : new Map();
  const titleOf = new Map(topics.map((t) => [t.id, t.title]));
  const pillarOf = new Map(topics.map((t) => [t.id, t.pillarId]));
  const pillarName = new Map(pillars.map((p) => [p.id, p.name]));
  const folderOf = new Map(folders.map((f) => [f.topicId, f.dropboxPath]));
  // The newest report that says something about a topic is its note.
  const noteOf = new Map<string, string>();
  for (const r of reports) {
    for (const [id, note] of Object.entries(parseJson<Record<string, string>>(r.notesJson, {}))) {
      if (!noteOf.has(id) && typeof note === "string" && note.trim()) noteOf.set(id, note);
    }
  }

  return {
    ...base,
    topics: order.map((sel): SessionTopic => {
      const sc = scripts.find((x) => x.topicId === sel.topicId) ?? null;
      // The CONFIRMED row wins when a topic has more than one live video.
      const mine = videos.filter((x) => x.topicId === sel.topicId);
      const v = mine.find((x) => x.filmedConfirmedAt) ?? mine[0] ?? null;
      const pid = pillarOf.get(sel.topicId) ?? null;
      return {
        topicId: sel.topicId,
        title: titleOf.get(sel.topicId) ?? "(untitled topic)",
        pillarName: pid ? pillarName.get(pid) ?? null : null,
        scriptId: sc?.id ?? null,
        scriptTitle: sc?.title ?? null,
        scriptSharedVersionId: sc?.sharedVersionId ?? null,
        clientApproved: !!sc && verdicts.get(sc.id)?.decision === "APPROVED",
        filmedConfirmedAtISO: v?.filmedConfirmedAt?.toISOString() ?? null,
        filmedConfirmedBy: v?.filmedConfirmedBy ?? null,
        videoId: v?.id ?? null,
        confirmedOnProjectId: v?.filmedConfirmedAt ? v.projectId : null,
        selectionId: sel.selectionId,
        overflow: sel.overflow,
        folderPath: folderOf.get(sel.topicId) ?? null,
        note: noteOf.get(sel.topicId) ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// THE DATE
// ---------------------------------------------------------------------------

export type FilmedLeg = { aryeoId: string; startAt: Date | null; endAt: Date | null };

/**
 * The appointment leg this footage came from: the latest non-cancelled leg that
 * has STARTED (within LEG_HORIZON_MS). The old read took the latest leg by
 * start time, future ones included — so a Pro month's submit after session 1,
 * with session 2 booked for next week, was dated next week (audit CP-09).
 *
 * A null status is not a cancellation. Prisma's `{ not: "CANCELED" }` compiles
 * to `status <> 'CANCELED'`, which is NULL — false — for a null status, so the
 * old filter silently skipped every leg Aryeo sent without one.
 */
export async function filmedLegFor(projectId: string, now: Date = new Date()): Promise<FilmedLeg | null> {
  return prisma.appointment.findFirst({
    where: {
      projectId,
      startAt: { lte: new Date(now.getTime() + LEG_HORIZON_MS) },
      OR: [{ status: null }, { status: { notIn: CANCELLED } }],
    },
    orderBy: { startAt: "desc" },
    select: { aryeoId: true, startAt: true, endAt: true },
  });
}

/**
 * When it was filmed. Preference order, and it stops rather than guessing
 * further: the leg the report named at submit, then the latest leg that has
 * started, then a shoot date already in the past. None of those → null, and
 * the caller raises the "production date needs verification" flag Jordan asked
 * for rather than inventing one.
 */
async function filmingMoment(projectId: string, now: Date, appointmentId: string | null | undefined): Promise<Date | null> {
  if (appointmentId) {
    const a = await prisma.appointment.findUnique({
      where: { aryeoId: appointmentId },
      select: { projectId: true, status: true, startAt: true, endAt: true },
    });
    const at = a && a.projectId === projectId && !CANCELLED.includes(a.status ?? "") ? a.endAt ?? a.startAt : null;
    if (at) return at;
  }
  const leg = await filmedLegFor(projectId, now);
  if (leg?.endAt ?? leg?.startAt) return (leg!.endAt ?? leg!.startAt)!;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { shootDate: true } });
  return p?.shootDate && p.shootDate.getTime() <= now.getTime() ? p.shootDate : null;
}

// ---------------------------------------------------------------------------
// CONFIRMING
// ---------------------------------------------------------------------------

export type ConfirmResult = {
  confirmed: number;
  /** Topics that were already confirmed by somebody — left exactly as they were. */
  alreadyConfirmed: number;
  /** Topics the person did NOT tick. Not filmed, and not touched. */
  notFilmed: number;
  /** Ticked ids that are not on this month's list any more (a stale tab) — recorded nowhere, reported here. */
  ignored: string[];
  /** Titles confirmed BEYOND the month's allowance — filed as EXTRA, for the office's capacity review. */
  overflow: string[];
  filmedAtISO: string | null;
  /** Set when the session's real end time is unknown — the date is honest about it. */
  dateUnverified: boolean;
};

/**
 * The photographer says which topics they filmed. The only moment anybody who
 * was there tells the hub.
 *
 * THE DATE is filmingMoment's: the report's own leg, else the latest leg that
 * has started, else a past shoot date. When none exists the video is still
 * recorded as filmed — it was — but `dateUnverified` comes back true.
 *
 * ONE VIDEO PER TOPIC. Each topic is find-or-create INSIDE one transaction
 * holding the project's filming lock, reading the videos after the lock is
 * taken. The old loop was a string of unrelated writes: a failure half way left
 * some topics confirmed and lost the rest, and two submits racing could each
 * mint a video for the same topic (nothing in the schema stops it).
 *
 * WHAT A CONFIRMED ROW SAYS. kind EXTRA with countsTowardAllowance false when
 * the selection was overflow (it used to count every confirmation toward "N of
 * owed", extras included); the selection it came from; the script and — when
 * the client approved the words that are shared — that exact version; and the
 * EMAIL of the person confirming, which is what the schema says the column
 * holds (it was getting the display name).
 *
 * Idempotent. Re-submitting does not re-stamp a topic somebody already
 * confirmed, and never moves a confirmation to a later time.
 */
export async function confirmFilmedTopics(
  projectId: string,
  topicIds: string[],
  by: string,
  opts: { now?: Date; appointmentId?: string | null; byEmail?: string | null } = {},
): Promise<ConfirmResult> {
  const session = await topicsForSession(projectId);
  if (!session) return { confirmed: 0, alreadyConfirmed: 0, notFilmed: 0, ignored: [], overflow: [], filmedAtISO: null, dateUnverified: false };

  const byId = new Map(session.topics.map((t) => [t.topicId, t]));
  const asked = [...new Set(topicIds)];
  const wanted = asked.filter((id) => byId.has(id));
  const ignored = asked.filter((id) => !byId.has(id));
  const stampedAt = opts.now ?? new Date();
  const filmedAt = await filmingMoment(projectId, stampedAt, opts.appointmentId);
  const dateUnverified = !filmedAt;
  const who = (opts.byEmail?.trim() || by).slice(0, 200);
  const { lockFilmingForProject } = await import("@/lib/deliverableOutputs");

  // Everything the transaction needs is read above it: PGlite (the drills) is
  // one session, and Postgres would only make a query outside `tx` wait on the
  // lock this transaction holds.
  const outcome = await prisma.$transaction(
    async (tx) => {
      await lockFilmingForProject(tx, projectId);
      const newly: string[] = [];
      const overflow: string[] = [];
      let already = 0;
      for (const id of wanted) {
        const t = byId.get(id)!;
        // Read INSIDE the lock: a run that got here first has made the row this one must use.
        const rows = await tx.contentVideo.findMany({
          where: { monthId: session.monthId, topicId: id, status: { not: "ARCHIVED" } },
          orderBy: { createdAt: "asc" },
          select: { id: true, filmedConfirmedAt: true },
        });
        if (rows.some((r) => r.filmedConfirmedAt)) {
          already++;
          continue;
        }
        const approvedVersionId = t.clientApproved ? t.scriptSharedVersionId : null;
        // Find the video row for this topic, or make one. The per-video row is what
        // the promise clock, the content meter and the portal all read.
        let videoId = rows[0]?.id ?? null;
        if (!videoId) {
          const row = await tx.contentVideo.create({
            data: {
              enrollmentId: session.enrollmentId,
              clientId: session.clientId,
              monthId: session.monthId,
              monthKey: session.monthKey,
              kind: t.overflow ? "EXTRA" : "PROGRAM",
              countsTowardAllowance: !t.overflow,
              title: t.title,
              topicId: t.topicId,
              selectionId: t.selectionId,
              scriptId: t.scriptId,
              scriptVersionId: approvedVersionId,
              projectId,
              status: "FILMED",
              source: "upload_portal",
            },
            select: { id: true },
          });
          videoId = row.id;
        }
        await tx.contentVideo.update({
          where: { id: videoId },
          data: {
            topicId: t.topicId,
            ...(t.selectionId ? { selectionId: t.selectionId } : {}),
            ...(t.scriptId ? { scriptId: t.scriptId } : {}),
            ...(approvedVersionId ? { scriptVersionId: approvedVersionId } : {}),
            projectId,
            // filmedAt only when we HAVE a real moment. A null here is the honest
            // answer and is what raises the verification flag downstream.
            ...(filmedAt ? { filmedAt } : {}),
            filmedConfirmedAt: stampedAt,
            filmedConfirmedBy: who,
            filmedSource: "upload_portal",
          },
        });
        // Only forward: a video already in editing or delivered is not walked back
        // to FILMED by a late confirmation.
        await tx.contentVideo.updateMany({ where: { id: videoId, status: "PLANNED" }, data: { status: "FILMED" } });
        await tx.contentTopic.updateMany({ where: { id: t.topicId, status: { in: ["SELECTED", "SCRIPTED"] } }, data: { status: "FILMED" } });
        if (t.overflow) overflow.push(t.title);
        newly.push(id);
      }
      return { newly, overflow, already };
    },
    { maxWait: 15_000, timeout: 30_000 },
  );

  // The history lines, after the commit: recordTopicEvent writes through the
  // shared client, so inside the transaction it would queue behind the lock.
  // Best-effort, as it always was — the video row is the record.
  const { recordTopicEvent } = await import("@/lib/contentTopics");
  for (const id of outcome.newly) {
    await recordTopicEvent(id, session.enrollmentId, "FILMED", { kind: "STAFF", staffUserId: who }, {
      monthId: session.monthId,
      sourceRef: `Project:${projectId}`,
      note: dateUnverified ? "Confirmed filmed on the upload portal — the session's end time is missing, so the production date needs verification." : null,
    }).catch(() => {});
  }

  return {
    confirmed: outcome.newly.length,
    alreadyConfirmed: outcome.already,
    notFilmed: session.topics.length - wanted.length,
    ignored,
    overflow: outcome.overflow,
    filmedAtISO: filmedAt?.toISOString() ?? null,
    dateUnverified,
  };
}

// ---------------------------------------------------------------------------
// THE REPORT — what the photographer said, kept until it has been applied.
// ---------------------------------------------------------------------------

/** A topic filmed on site that was not on the month's list. `key` is the page's own handle for it. */
export type FilmingExtra = { key: string; title: string; note: string | null };
export type FilmingPayload = { topicIds: string[]; extras: FilmingExtra[]; notes: Record<string, string> };

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The submitted ticks, notes and extras, as the server will store them. The
 * browser's values are never trusted as given: ids must look like ids, notes
 * are only kept for a topic that was ticked, extras are capped and de-duplicated
 * by title, and every string is clipped.
 */
export function normalizeFilmingPayload(input: { filmedTopicIds: unknown; topicNotes?: unknown; extraTopics?: unknown }): FilmingPayload {
  const raw = Array.isArray(input.filmedTopicIds) ? input.filmedTopicIds : [];
  const topicIds = [...new Set(raw.filter((x): x is string => typeof x === "string" && ID_RE.test(x)))].slice(0, FILMING_LIMITS.topics);
  const notes: Record<string, string> = {};
  if (input.topicNotes && typeof input.topicNotes === "object" && !Array.isArray(input.topicNotes)) {
    for (const [id, v] of Object.entries(input.topicNotes as Record<string, unknown>)) {
      if (!topicIds.includes(id) || typeof v !== "string") continue;
      const note = v.trim().slice(0, FILMING_LIMITS.noteChars);
      if (note) notes[id] = note;
    }
  }
  const extras: FilmingExtra[] = [];
  const titles = new Set<string>();
  const keys = new Set<string>();
  for (const item of Array.isArray(input.extraTopics) ? input.extraTopics : []) {
    if (extras.length >= FILMING_LIMITS.extras) break;
    if (!item || typeof item !== "object") continue;
    const r = item as { key?: unknown; title?: unknown; note?: unknown };
    const title = typeof r.title === "string" ? squash(r.title).slice(0, FILMING_LIMITS.titleChars) : "";
    if (!title || titles.has(title.toLowerCase())) continue;
    titles.add(title.toLowerCase());
    let key = typeof r.key === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.key) ? r.key : `x${sha(title.toLowerCase()).slice(0, 12)}`;
    if (keys.has(key)) key = `${key.slice(0, 50)}-${sha(title.toLowerCase()).slice(0, 8)}`;
    keys.add(key);
    const note = typeof r.note === "string" ? r.note.trim().slice(0, FILMING_LIMITS.noteChars) || null : null;
    extras.push({ key, title, note });
  }
  return { topicIds, extras, notes };
}

/**
 * The payload's identity. Extras are identified by their TITLE, not the page's
 * key: a reloaded page mints new keys for the same two extras, and that is the
 * same report, not a second one.
 */
export function filmingPayloadHash(p: FilmingPayload): string {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return sha(
    JSON.stringify({
      t: [...p.topicIds].sort(cmp),
      e: p.extras.map((x) => [x.title.toLowerCase(), x.note ?? ""]).sort((a, b) => cmp(a[0], b[0])),
      n: Object.keys(p.notes).sort(cmp).map((k) => [k, p.notes[k]]),
    }),
  );
}

export type PreparedFilmingReport = {
  /** The ContentFilmingReport row, ready for createMany. */
  row: Prisma.ContentFilmingReportCreateManyInput;
  payloadHash: string;
  /** What the editor cuts to: the videos confirmed on THIS project ∪ the ticks, plus extras not yet on file. */
  videosFilmed: number;
  /** How many topics this answer names (ticks + extras) — what the page tells the photographer is pending. */
  topicCount: number;
};

/**
 * Everything finalizeUpload needs to write the report in the same transaction
 * as the debrief. Null when there is nothing to report on: a project with no
 * content month, or an answer with no ticks and no extras ("none of them" is
 * still a real answer, but there is nothing to apply).
 */
export async function prepareFilmingReport(
  projectId: string,
  input: { filmedTopicIds: unknown; topicNotes?: unknown; extraTopics?: unknown },
  who: { name: string; email?: string | null },
  now: Date = new Date(),
): Promise<PreparedFilmingReport | null> {
  const payload = normalizeFilmingPayload(input);
  if (!payload.topicIds.length && !payload.extras.length) return null;
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { contentMonthId: true } });
  if (!project?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({ where: { id: project.contentMonthId }, select: { id: true, enrollmentId: true } });
  if (!month) return null;
  const [leg, confirmedHere, confirmedElsewhere, applied] = await Promise.all([
    filmedLegFor(projectId, now),
    prisma.contentVideo.findMany({
      where: { projectId, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } },
      select: { id: true, topicId: true },
    }),
    // A topic confirmed at ANOTHER session of this month is that session's
    // video. A stale tab still ticking it must not count it twice.
    payload.topicIds.length
      ? prisma.contentVideo.findMany({
          where: { monthId: month.id, topicId: { in: payload.topicIds }, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" }, NOT: { projectId } },
          select: { topicId: true },
        })
      : Promise.resolve([] as { topicId: string | null }[]),
    prisma.contentFilmingReport.findMany({ where: { projectId, state: "APPLIED" }, select: { extrasJson: true } }),
  ]);
  const elsewhere = new Set(confirmedElsewhere.map((v) => v.topicId));
  const units = new Set(confirmedHere.map((v) => v.topicId ?? `video:${v.id}`));
  for (const id of payload.topicIds) if (!elsewhere.has(id)) units.add(id);
  // An extra an earlier report already turned into a topic is inside
  // `confirmedHere` by now; re-sending the same page must not count it twice.
  const landed = new Set(applied.flatMap((r) => parseJson<FilmingExtra[]>(r.extrasJson, []).map((x) => x.title.toLowerCase())));
  const newExtras = payload.extras.filter((x) => !landed.has(x.title.toLowerCase())).length;
  const payloadHash = filmingPayloadHash(payload);
  return {
    payloadHash,
    videosFilmed: units.size + newExtras,
    topicCount: payload.topicIds.length + payload.extras.length,
    row: {
      projectId,
      monthId: month.id,
      enrollmentId: month.enrollmentId,
      appointmentId: leg?.aryeoId ?? null,
      submittedBy: who.name.slice(0, 200),
      submittedByEmail: who.email?.trim().slice(0, 200) || null,
      topicIdsJson: JSON.stringify(payload.topicIds),
      extrasJson: payload.extras.length ? JSON.stringify(payload.extras) : null,
      notesJson: Object.keys(payload.notes).length ? JSON.stringify(payload.notes) : null,
      payloadHash,
      state: "PENDING",
    },
  };
}

// ---------------------------------------------------------------------------
// APPLYING IT — claimed, retried, and never twice.
// ---------------------------------------------------------------------------

export type FilmingReportState = "PENDING" | "APPLYING" | "APPLIED" | "FAILED" | "NEEDS_REVIEW";

export type ApplyFilmingResult = {
  state: FilmingReportState | "MISSING";
  /** false when another run holds it, or it had already landed — nothing was done by THIS call. */
  claimed: boolean;
  confirmed: number;
  extras: number;
  bound: number;
  unbound: string[];
  error: string | null;
};

/** What a landed report records (resultJson). Also the progress a retry resumes from. */
type ReportProgress = {
  /** extra key → the topic it became; a retry reuses it rather than making another */
  extraTopicIds?: Record<string, string>;
  /** extra key → the topic-less video it became (its title matched a ruled-out topic) */
  extraVideoIds?: Record<string, string>;
  confirmed?: number;
  alreadyConfirmed?: number;
  ignored?: string[];
  overflow?: string[];
  bound?: number;
  unbound?: string[];
  filmedAtISO?: string | null;
  dateUnverified?: boolean;
};

const REASON = {
  added: "filmed on site — not on the month's plan",
  addedBeyond: "filmed on site, beyond this month's allowance",
  beyond: "ticked, but selected beyond this month's allowance",
  ruledOut: "filmed on site, but the office had rejected or archived a topic with this title — kept as an extra video with no topic",
  noSlot: "confirmed filmed, but the job has no free video slot for it — raise videos owed or place it by hand",
} as const;

/**
 * Apply one report. Safe to call from anywhere at any time: the claim below is
 * the only door in, so a submit, the hourly sweep and a second sweep racing on
 * the same row apply it once between them.
 */
export async function applyFilmingReport(reportId: string, opts: { now?: Date } = {}): Promise<ApplyFilmingResult> {
  const now = opts.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  // THE CLAIM. A waiting row (PENDING, FAILED) or one whose runner died holding
  // it (APPLYING past its lease). A FAILED row's nextAttemptAt is the SWEEP's
  // pacing, not a lock: the photographer pressing Submit again is a retry too.
  const claim = await prisma.contentFilmingReport.updateMany({
    where: {
      id: reportId,
      OR: [
        { state: { in: ["PENDING", "FAILED"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
        { state: "APPLYING", leaseUntil: { lt: now } },
      ],
    },
    data: { state: "APPLYING", leaseUntil, attempts: { increment: 1 } },
  });
  if (claim.count === 0) {
    const r = await prisma.contentFilmingReport.findUnique({ where: { id: reportId }, select: { state: true, resultJson: true, extrasJson: true, lastError: true } });
    const done = parseJson<ReportProgress>(r?.resultJson, {});
    return {
      state: (r?.state as FilmingReportState | undefined) ?? "MISSING",
      claimed: false,
      confirmed: done.confirmed ?? 0,
      extras: parseJson<FilmingExtra[]>(r?.extrasJson, []).length,
      bound: done.bound ?? 0,
      unbound: done.unbound ?? [],
      error: r?.lastError ?? null,
    };
  }
  const report = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: reportId } });
  // Every later write is fenced on THIS claim: a run that outlived its lease
  // and was taken over must not stamp over the run that took it.
  const fence = { id: reportId, state: "APPLYING", leaseUntil };
  try {
    const result = await runFilmingReport(report, now, fence);
    const landed = await prisma.contentFilmingReport.updateMany({
      where: fence,
      data: { state: "APPLIED", appliedAt: now, leaseUntil: null, nextAttemptAt: null, lastError: null, resultJson: JSON.stringify(result) },
    });
    const extras = parseJson<FilmingExtra[]>(report.extrasJson, []).length;
    // Fenced out: this run outlived its lease and another took the report over.
    // Everything above is find-or-create, so its work stands; the state is the
    // other run's to write.
    const state = landed.count
      ? "APPLIED"
      : (((await prisma.contentFilmingReport.findUnique({ where: { id: reportId }, select: { state: true } }))?.state ?? "MISSING") as FilmingReportState | "MISSING");
    return { state, claimed: true, confirmed: result.confirmed ?? 0, extras, bound: result.bound ?? 0, unbound: result.unbound ?? [], error: null };
  } catch (e) {
    // Prisma's messages are a dozen lines of framing around one fact; one line
    // is what the office card and the log need.
    const error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim().slice(0, 1000);
    const giveUp = report.attempts >= FILMING_REPORT_MAX_ATTEMPTS;
    const moved = await prisma.contentFilmingReport.updateMany({
      where: fence,
      data: giveUp
        ? { state: "NEEDS_REVIEW", lastError: error, leaseUntil: null, nextAttemptAt: null }
        : { state: "FAILED", lastError: error, leaseUntil: null, nextAttemptAt: new Date(now.getTime() + RETRY_BASE_MS * 2 ** Math.max(0, report.attempts - 1)) },
    });
    console.warn(`[filming-report] ${report.id} on ${report.projectId} attempt ${report.attempts}: ${error}`);
    if (giveUp && moved.count) await escalateFilmingReport(report, error).catch(() => {});
    return { state: giveUp ? "NEEDS_REVIEW" : "FAILED", claimed: true, confirmed: 0, extras: 0, bound: 0, unbound: [], error };
  }
}

type ReportRow = Awaited<ReturnType<typeof prisma.contentFilmingReport.findUniqueOrThrow>>;

async function runFilmingReport(report: ReportRow, now: Date, fence: Prisma.ContentFilmingReportWhereInput): Promise<ReportProgress> {
  const ticks = parseJson<string[]>(report.topicIdsJson, []).filter((id) => typeof id === "string");
  const extras = parseJson<FilmingExtra[]>(report.extrasJson, []);
  const notes = parseJson<Record<string, string>>(report.notesJson, {});
  const progress = parseJson<ReportProgress>(report.resultJson, {});
  const extraTopicIds: Record<string, string> = { ...(progress.extraTopicIds ?? {}) };
  const extraVideoIds: Record<string, string> = { ...(progress.extraVideoIds ?? {}) };
  const who = report.submittedByEmail || report.submittedBy;
  const actor = { kind: "STAFF" as const, staffUserId: who };
  const saveProgress = () =>
    prisma.contentFilmingReport.updateMany({ where: fence, data: { resultJson: JSON.stringify({ extraTopicIds, extraVideoIds }) } });

  const project = await prisma.project.findUnique({ where: { id: report.projectId }, select: { contentMonthId: true } });
  const monthId = report.monthId ?? project?.contentMonthId ?? null;
  const month = monthId
    ? await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true } })
    : null;
  if (!month) throw new Error("The report's content month no longer exists — nothing to confirm the topics against.");

  // 1. EXTRAS — a topic filmed on site. It becomes a real topic on the month
  //    (PROPOSED: the office never approved it) and a selection, whose capacity
  //    check marks it overflow when the month is already full. Nothing is
  //    billed and nothing is blocked; the office decides in the capacity review.
  const capacity: { title: string; reason: string }[] = [];
  const flags: string[] = [];
  const extraNotes: Record<string, string> = {};
  const extraTitleByTopic = new Map<string, string>();
  if (extras.length) {
    const { createTopic, selectTopicForMonth } = await import("@/lib/contentTopics");
    for (const x of extras) {
      if (extraVideoIds[x.key]) {
        // Resolved on an earlier attempt; its lines still belong in this run's review and flag.
        capacity.push({ title: x.title, reason: REASON.ruledOut });
        flags.push(`"${x.title}" matches a topic the office rejected or archived — kept as an extra video with no topic.`);
        continue;
      }
      let topicId = extraTopicIds[x.key] ?? null;
      if (!topicId) {
        const sourceRef = `FilmingReport:${report.id}#${x.key}`;
        const earlier = await prisma.contentTopic.findFirst({ where: { enrollmentId: month.enrollmentId, sourceRef }, select: { id: true } });
        topicId =
          earlier?.id ??
          (
            await createTopic({
              enrollmentId: month.enrollmentId,
              title: x.title,
              source: "staff",
              status: "SELECTED",
              approvalState: "PROPOSED",
              monthId: month.id,
              sourceRef,
              actor,
              note: `Filmed on site — added by ${report.submittedBy} on the upload page.`,
            })
          ).id;
      }
      // createTopic returns an existing same-titled topic. One the office
      // REJECTED or ARCHIVED cannot be selected (selectTopicForMonth refuses,
      // on purpose), and reintroducing it is the office's call — so the footage
      // is kept as an extra video with no topic, and a person is told.
      const t = await prisma.contentTopic.findUnique({ where: { id: topicId }, select: { status: true, approvalState: true } });
      const ruledOut = !t || ["REJECTED", "ARCHIVED"].includes(t.status) || ["REJECTED", "ARCHIVED"].includes(t.approvalState ?? "");
      if (ruledOut) {
        extraVideoIds[x.key] = await topiclessExtra(report, month, x, who, now);
        delete extraTopicIds[x.key];
        await saveProgress();
        capacity.push({ title: x.title, reason: REASON.ruledOut });
        flags.push(`"${x.title}" matches a topic the office rejected or archived — kept as an extra video with no topic.`);
        continue;
      }
      extraTopicIds[x.key] = topicId;
      await saveProgress();
      const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId, monthId: month.id } }, select: { status: true } });
      if (!sel || !LIVE_SELECTION.includes(sel.status)) {
        await selectTopicForMonth(topicId, month.id, { source: "staff", actor, status: "SELECTED", evidence: { filmingReportId: report.id } });
      }
      if (x.note) extraNotes[topicId] = x.note;
      extraTitleByTopic.set(topicId, x.title);
    }
  }

  // 2. CONFIRM the ticks and the extras' topics together.
  const ids = [...new Set([...ticks, ...Object.values(extraTopicIds)])];
  const confirm = await confirmFilmedTopics(report.projectId, ids, report.submittedBy, {
    now,
    appointmentId: report.appointmentId,
    byEmail: report.submittedByEmail,
  });
  if (confirm.dateUnverified && confirm.confirmed > 0) {
    flags.push(`${confirm.confirmed} topic(s) confirmed filmed by ${report.submittedBy}, but this session's appointment has no start or end time — the production date needs verification.`);
  }
  if (confirm.ignored.length) {
    flags.push(`${confirm.ignored.length} ticked topic(s) are no longer on this month's list, so they were not recorded — check with ${report.submittedBy}.`);
  }
  // What goes to the capacity review is read from what is ON FILE, not from
  // what this attempt newly wrote: a retry after a failure further down finds
  // the topics already confirmed, and the office still has to hear about them.
  // "Beyond the allowance" is the selection's own overflow flag.
  const here = ids.length
    ? await prisma.contentVideo.findMany({
        where: { projectId: report.projectId, topicId: { in: ids }, filmedConfirmedAt: { not: null }, status: { not: "ARCHIVED" } },
        select: { topicId: true },
      })
    : [];
  const hereIds = [...new Set(here.map((v) => v.topicId).filter((x): x is string => !!x))];
  const [beyondRows, titleRows] = hereIds.length
    ? await Promise.all([
        prisma.contentTopicSelection.findMany({ where: { monthId: month.id, topicId: { in: hereIds }, overflow: true }, select: { topicId: true } }),
        prisma.contentTopic.findMany({ where: { id: { in: hereIds } }, select: { id: true, title: true } }),
      ])
    : [[], []];
  const beyond = new Set(beyondRows.map((s) => s.topicId));
  const titleOf = new Map(titleRows.map((t) => [t.id, t.title]));
  for (const id of hereIds) {
    const title = titleOf.get(id) ?? extraTitleByTopic.get(id) ?? "(untitled topic)";
    if (extraTitleByTopic.has(id)) capacity.push({ title, reason: beyond.has(id) ? REASON.addedBeyond : REASON.added });
    else if (beyond.has(id)) capacity.push({ title, reason: REASON.beyond });
  }

  // 3. BIND each confirmed video to one of the editor's owed-video slots, so
  //    the cut that arrives for that slot is THIS topic's video.
  const { bindTopicVideosToSlots } = await import("@/lib/deliverableOutputs");
  const bind = await bindTopicVideosToSlots(report.projectId, { notes: { ...notes, ...extraNotes } });
  for (const title of bind.unbound) capacity.push({ title, reason: REASON.noSlot });
  if (bind.unbound.length) {
    flags.push(`${bind.unbound.length} filmed video(s) have no free slot on this job (${bind.unbound.join(", ")}) — not guessed; the office has a task.`);
  }

  // 4. (batch C) ensureTopicFolders — per-topic raw folders under 02-RAW-Video,
  //    behind the topic_folders switch. Not in this build.

  // 5. THE OFFICE decides what anything beyond the plan counts toward.
  if (capacity.length) {
    const { fileCapacityReview } = await import("@/lib/tasks");
    await fileCapacityReview(report.projectId, capacity);
  }
  // ONE flag per landed report, written last so a retry never repeats it.
  if (flags.length) {
    await prisma.activity.create({ data: { projectId: report.projectId, type: "FLAG", body: `Filmed topics: ${flags.join(" ")}`.slice(0, 2000) } });
  }

  return {
    extraTopicIds,
    extraVideoIds,
    confirmed: confirm.confirmed,
    alreadyConfirmed: confirm.alreadyConfirmed,
    ignored: confirm.ignored,
    overflow: confirm.overflow,
    bound: bind.bound,
    unbound: bind.unbound,
    filmedAtISO: confirm.filmedAtISO,
    dateUnverified: confirm.dateUnverified,
  };
}

/** The extra video for footage whose title belongs to a ruled-out topic: filmed, on this job, no topic, never counted. */
async function topiclessExtra(
  report: ReportRow,
  month: { id: string; enrollmentId: string; clientId: string; monthKey: string },
  x: FilmingExtra,
  who: string,
  now: Date,
): Promise<string> {
  const existing = await prisma.contentVideo.findFirst({
    where: { projectId: report.projectId, topicId: null, kind: "EXTRA", title: x.title, filmedSource: "upload_portal", status: { not: "ARCHIVED" } },
    select: { id: true },
  });
  if (existing) return existing.id;
  const filmedAt = await filmingMoment(report.projectId, now, report.appointmentId);
  const row = await prisma.contentVideo.create({
    data: {
      enrollmentId: month.enrollmentId,
      clientId: month.clientId,
      monthId: month.id,
      monthKey: month.monthKey,
      kind: "EXTRA",
      countsTowardAllowance: false,
      title: x.title,
      projectId: report.projectId,
      status: "FILMED",
      source: "upload_portal",
      ...(filmedAt ? { filmedAt } : {}),
      filmedConfirmedAt: now,
      filmedConfirmedBy: who,
      filmedSource: "upload_portal",
      notes: x.note,
    },
    select: { id: true },
  });
  return row.id;
}

/**
 * Six attempts and it still will not land: stop retrying and give it to a
 * person, with everything the photographer said so nobody has to ask them
 * again. Same shape as tasks.ts createProjectFollowupTask — Kyle's desk, one
 * row per job (the dedupe key is tasks.ts dedupe([projectId, "filming_report"])).
 */
async function escalateFilmingReport(report: ReportRow, error: string): Promise<void> {
  const p = await prisma.project.findUnique({ where: { id: report.projectId }, select: { title: true, clientId: true } });
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } }, select: { id: true } });
  const ids = parseJson<string[]>(report.topicIdsJson, []);
  const titles = ids.length ? (await prisma.contentTopic.findMany({ where: { id: { in: ids } }, select: { title: true } })).map((t) => t.title) : [];
  const extras = parseJson<FilmingExtra[]>(report.extrasJson, []).map((x) => `${x.title} (added on site)`);
  const street = (p?.title ?? "this job").split(",")[0];
  const key = crypto.createHash("sha1").update([report.projectId, "filming_report"].join("|")).digest("hex").slice(0, 24);
  const summary = `${report.submittedBy} reported the filmed topics, and the hub could not record them after ${report.attempts} tries. The footage submit itself went through.`;
  const description = [
    "What the photographer said was filmed:",
    ...[...titles, ...extras].map((t) => `• ${t}`),
    "",
    `Last error: ${error.slice(0, 400)}`,
  ].join("\n");
  const data = {
    taskType: "content_filming_report",
    title: `Filmed topics did not save — ${street}`.slice(0, 120),
    summary: summary.slice(0, 500),
    description,
    reasonCreated: `ContentFilmingReport ${report.id} reached NEEDS_REVIEW`,
    source: "system",
    priority: "HIGH",
    dueAt: new Date(Date.now() + 4 * HOUR),
    clientId: p?.clientId ?? null,
    projectId: report.projectId,
    propertyAddress: p?.title ?? null,
    ownerId: kyle?.id ?? null,
    assignedKey: "kyle",
    dedupeKey: key,
  };
  const made = await prisma.smartTask.createMany({ data: [data], skipDuplicates: true });
  if (!made.count) {
    await prisma.smartTask.updateMany({ where: { dedupeKey: key }, data: { status: "OPEN", completedAt: null, summary: data.summary, description } });
  }
  const { notifyInApp } = await import("@/lib/notify");
  await notifyInApp({
    kind: "content_filming_report",
    title: `Filmed topics did not save — ${street}`,
    body: `${titles.length + extras.length} topic(s) need recording by hand.`,
    href: `/projects/${report.projectId}`,
    targets: [{ roles: ["OWNER", "ADMIN"] }],
    dedupeKey: `filming-report-${report.id}`,
  }).catch(() => {});
}

/**
 * The hourly retry (cron/sync `filmingReports`, before the library sweep so
 * the videos it confirms are there when the library rebuilds). Due PENDING and
 * FAILED rows, and APPLYING rows whose runner died holding the lease — one at a
 * time. Database-only and contacts nobody, so it needs no switch (the same
 * reasoning as sweepContentVideoLibraries).
 */
export async function sweepFilmingReports(opts: { limit?: number; now?: Date } = {}): Promise<{ due: number; applied: number; failed: number; needsReview: number; busy: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.contentFilmingReport.findMany({
    where: {
      OR: [
        { state: { in: ["PENDING", "FAILED"] }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { state: "APPLYING", leaseUntil: { lt: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 20,
    select: { id: true },
  });
  const out = { due: due.length, applied: 0, failed: 0, needsReview: 0, busy: 0 };
  for (const r of due) {
    const res = await applyFilmingReport(r.id, { now });
    if (!res.claimed) out.busy++;
    else if (res.state === "APPLIED") out.applied++;
    else if (res.state === "NEEDS_REVIEW") out.needsReview++;
    else out.failed++;
  }
  return out;
}
