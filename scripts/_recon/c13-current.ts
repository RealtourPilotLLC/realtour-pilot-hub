/** Read-only replay of the named C13 September contradictions. No changes or sends. */
import { prisma } from "@/lib/prisma";
import { programOverview } from "@/lib/programOverview";
import { monthProgressMany, progressKey } from "@/lib/monthProgress";
import { portalTopics } from "@/lib/portal";

async function main() {
  const names = ["Erica", "John", "Mike", "Rick"];
  const clients = await prisma.client.findMany({
    where: { OR: names.map((name) => ({ name: { startsWith: name, mode: "insensitive" as const } })) },
    select: { id: true, name: true },
  });
  const enrollments = await prisma.contentEnrollment.findMany({
    where: { clientId: { in: clients.map((c) => c.id) }, status: "ACTIVE" },
    select: { id: true, clientId: true },
  });
  const months = await prisma.contentMonth.findMany({
    where: { enrollmentId: { in: enrollments.map((e) => e.id) }, monthKey: "2026-09" },
    select: { id: true, enrollmentId: true, monthKey: true },
  });
  const progress = await monthProgressMany(months.map((m) => ({ enrollmentId: m.enrollmentId, monthId: m.id, monthKey: m.monthKey })));
  const evidence = await Promise.all(months.map(async (m) => {
    const e = enrollments.find((e) => e.id === m.enrollmentId)!;
    const [topics, selections, scripts, videos, portal] = await Promise.all([
      prisma.contentTopic.findMany({ where: { monthId: m.id }, select: { id: true, status: true } }),
      prisma.contentTopicSelection.findMany({ where: { monthId: m.id }, select: { topicId: true, status: true } }),
      prisma.contentScript.findMany({ where: { monthId: m.id }, select: { topicId: true, videoId: true, status: true, currentVersionId: true, historical: true } }),
      prisma.contentVideo.findMany({ where: { enrollmentId: e.id, monthKey: m.monthKey, status: { not: "ARCHIVED" } }, select: { topicId: true, countsTowardAllowance: true, status: true } }),
      portalTopics(e),
    ]);
    const visible = portal.groups.flatMap((g) => g.topics).filter((t) => t.selection?.monthId === m.id);
    return { enrollmentId: e.id,
      topicRows: topics.length, selectedTopicRows: topics.filter((t) => ["SELECTED", "SCRIPTED", "FILMED", "EDITING", "DELIVERED"].includes(t.status)).length,
      liveSelections: selections.filter((s) => ["SELECTED", "CARRIED", "RECONCILED"].includes(s.status)).length,
      scripts: { total: scripts.length, current: scripts.filter((s) => !s.historical).length, linkedTopic: scripts.filter((s) => !!s.topicId).length, linkedVideo: scripts.filter((s) => !!s.videoId).length },
      videos: { total: videos.length, allowance: videos.filter((v) => v.countsTowardAllowance).length, linkedTopic: videos.filter((v) => !!v.topicId).length, delivered: videos.filter((v) => v.status === "DELIVERED").length },
      portal: { selected: portal.months.find((x) => x.id === m.id)?.selected ?? null, visibleSelections: visible.length },
    };
  }));
  const rows = await programOverview({ monthKey: "2026-09", enrollmentIds: enrollments.map((e) => e.id), includeTest: false });
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), rows: rows.rows.map((r) => ({
    client: r.clientName,
    month: r.monthKey,
    next: r.nextAction.text,
    ownerDuty: r.nextAction.ownerDuty,
    blocked: r.nextAction.blocked,
    topics: { selected: r.work.topicsSelected, needed: r.work.topicsNeeded },
    scripts: { draft: r.work.scriptsDrafting, staffReview: r.work.scriptsReviewNeeded, approvedOrShared: r.work.scriptsApproved },
    sessions: { required: r.session.required, confirmed: r.session.confirmed, filmedConfirmed: r.session.filmedConfirmed, missing: r.session.missing },
    videos: { owed: r.production.owed, filmed: r.production.filmed, delivered: r.production.delivered },
    flags: r.flags,
    linkEvidence: evidence.find((e) => e.enrollmentId === r.enrollmentId),
    monthProgress: (() => {
      const m = months.find((m) => m.enrollmentId === r.enrollmentId);
      const p = m ? progress.get(progressKey(m.enrollmentId, m.id, m.monthKey)) : null;
      return p ? { next: p.nextAction?.text, blocked: p.nextAction?.blocked, ownerDuty: p.nextAction?.ownerDuty,
        call: { status: p.call.status, required: p.call.required }, planningRoute: p.planning?.route,
        topics: p.topics, scripts: p.scripts, sessions: { required: p.sessions.required, filmed: p.sessions.filmedConfirmed, missing: p.sessions.missing },
        production: { counted: p.production.counted, produced: p.production.produced, delivered: p.production.delivered } } : null;
    })(),
  })) }, null, 2));
}

main().finally(() => prisma.$disconnect());
