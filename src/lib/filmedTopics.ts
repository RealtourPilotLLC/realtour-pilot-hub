import "server-only";
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
// ---------------------------------------------------------------------------

export type SessionTopic = {
  topicId: string;
  title: string;
  pillarName: string | null;
  /** The script the client is expecting to say, when there is one. */
  scriptId: string | null;
  scriptTitle: string | null;
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
};

export type SessionTopics = {
  monthId: string;
  monthKey: string;
  enrollmentId: string;
  clientId: string;
  /** How many videos the month owes — the number the count box used to ask for. */
  owed: number;
  topics: SessionTopic[];
};

/**
 * The topics this filming session is for, or null when the project is not
 * content-program work (an ordinary listing shoot has no month and no topics).
 */
export async function topicsForSession(projectId: string): Promise<SessionTopics | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, contentMonthId: true } });
  if (!project?.contentMonthId) return null;
  const month = await prisma.contentMonth.findUnique({
    where: { id: project.contentMonthId },
    select: { id: true, monthKey: true, enrollmentId: true, clientId: true, videosOwed: true },
  });
  if (!month) return null;

  const selections = await prisma.contentTopicSelection.findMany({
    where: { monthId: month.id, status: { in: ["SELECTED", "RECONCILED", "CARRIED"] } },
    select: { topicId: true, rank: true, createdAt: true },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
  });
  if (!selections.length) return { monthId: month.id, monthKey: month.monthKey, enrollmentId: month.enrollmentId, clientId: month.clientId, owed: month.videosOwed, topics: [] };

  const topicIds = selections.map((s) => s.topicId);
  const [topics, scripts, videos, pillars] = await Promise.all([
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
    prisma.contentVideo.findMany({
      where: { monthId: month.id, topicId: { in: topicIds } },
      select: { id: true, topicId: true, filmedConfirmedAt: true, filmedConfirmedBy: true },
    }),
    prisma.contentPillar.findMany({ where: { enrollmentId: month.enrollmentId }, select: { id: true, name: true } }),
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

  return {
    monthId: month.id,
    monthKey: month.monthKey,
    enrollmentId: month.enrollmentId,
    clientId: month.clientId,
    owed: month.videosOwed,
    topics: selections.map((sel): SessionTopic => {
      const sc = scripts.find((x) => x.topicId === sel.topicId) ?? null;
      const v = videos.find((x) => x.topicId === sel.topicId) ?? null;
      const pid = pillarOf.get(sel.topicId) ?? null;
      return {
        topicId: sel.topicId,
        title: titleOf.get(sel.topicId) ?? "(untitled topic)",
        pillarName: pid ? pillarName.get(pid) ?? null : null,
        scriptId: sc?.id ?? null,
        scriptTitle: sc?.title ?? null,
        clientApproved: !!sc && verdicts.get(sc.id)?.decision === "APPROVED",
        filmedConfirmedAtISO: v?.filmedConfirmedAt?.toISOString() ?? null,
        filmedConfirmedBy: v?.filmedConfirmedBy ?? null,
        videoId: v?.id ?? null,
      };
    }),
  };
}

export type ConfirmResult = {
  confirmed: number;
  /** Topics that were already confirmed by somebody — left exactly as they were. */
  alreadyConfirmed: number;
  /** Topics the person did NOT tick. Not filmed, and not touched. */
  notFilmed: number;
  filmedAtISO: string | null;
  /** Set when the session's real end time is unknown — the date is honest about it. */
  dateUnverified: boolean;
};

/**
 * The photographer says which topics they filmed. The only moment anybody who
 * was there tells the hub.
 *
 * THE DATE. Preference order, and it stops rather than guessing further: the
 * appointment's own end time, then its start, then the project's shoot date.
 * When none of those exists the video is still recorded as filmed — it was —
 * but `dateUnverified` comes back true and the caller raises the "production
 * date needs verification" flag Jordan asked for rather than inventing one.
 *
 * Idempotent. Re-submitting the upload form does not re-stamp a topic somebody
 * already confirmed, and never moves a confirmation to a later time.
 */
export async function confirmFilmedTopics(
  projectId: string,
  topicIds: string[],
  by: string,
  opts: { now?: Date } = {},
): Promise<ConfirmResult> {
  const session = await topicsForSession(projectId);
  if (!session) return { confirmed: 0, alreadyConfirmed: 0, notFilmed: 0, filmedAtISO: null, dateUnverified: false };

  const wanted = new Set(topicIds.filter((id) => session.topics.some((t) => t.topicId === id)));
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { shootDate: true } });
  const appt = await prisma.appointment.findFirst({
    where: { projectId, status: { not: "CANCELED" } },
    orderBy: { startAt: "desc" },
    select: { startAt: true, endAt: true },
  });
  const filmedAt = appt?.endAt ?? appt?.startAt ?? project?.shootDate ?? null;
  const dateUnverified = !filmedAt;
  const stampedAt = opts.now ?? new Date();

  let confirmed = 0;
  let alreadyConfirmed = 0;
  for (const t of session.topics) {
    if (!wanted.has(t.topicId)) continue;
    if (t.filmedConfirmedAtISO) { alreadyConfirmed++; continue; }

    // Find the video row for this topic, or make one. The per-video row is what
    // the promise clock, the content meter and the portal all read.
    let videoId = t.videoId;
    if (!videoId) {
      const row = await prisma.contentVideo.create({
        data: {
          enrollmentId: session.enrollmentId,
          clientId: session.clientId,
          monthId: session.monthId,
          monthKey: session.monthKey,
          kind: "PROGRAM",
          countsTowardAllowance: true,
          title: t.title,
          topicId: t.topicId,
          scriptId: t.scriptId,
          projectId,
          status: "FILMED",
          source: "upload_portal",
        },
        select: { id: true },
      });
      videoId = row.id;
    }
    await prisma.contentVideo.update({
      where: { id: videoId },
      data: {
        topicId: t.topicId,
        scriptId: t.scriptId ?? undefined,
        projectId,
        // filmedAt only when we HAVE a real moment. A null here is the honest
        // answer and is what raises the verification flag downstream.
        ...(filmedAt ? { filmedAt } : {}),
        filmedConfirmedAt: stampedAt,
        filmedConfirmedBy: by,
        filmedSource: "upload_portal",
      },
    });
    // Only forward: a video already in editing or delivered is not walked back
    // to FILMED by a late confirmation.
    await prisma.contentVideo.updateMany({ where: { id: videoId, status: "PLANNED" }, data: { status: "FILMED" } });

    // The topic itself, and its history line.
    await prisma.contentTopic.updateMany({ where: { id: t.topicId, status: { in: ["SELECTED", "SCRIPTED"] } }, data: { status: "FILMED" } });
    const { recordTopicEvent } = await import("@/lib/contentTopics");
    await recordTopicEvent(t.topicId, session.enrollmentId, "FILMED", { kind: "STAFF", staffUserId: by }, {
      monthId: session.monthId,
      sourceRef: `Project:${projectId}`,
      note: dateUnverified ? "Confirmed filmed on the upload portal — the session's end time is missing, so the production date needs verification." : null,
    }).catch(() => {});
    confirmed++;
  }

  return {
    confirmed,
    alreadyConfirmed,
    notFilmed: session.topics.length - wanted.size,
    filmedAtISO: filmedAt?.toISOString() ?? null,
    dateUnverified,
  };
}
