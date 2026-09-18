/**
 * R02 blast radius — READ-ONLY against production.
 *
 * Feeds the REAL computeStatus the REAL rows of every project the hourly sweep
 * carries, and prints its verdict per job. Run it once before the change and
 * once after; the diff is the whole population whose status or sentence moves.
 *
 *   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/R02/blast-radius.ts > /tmp/r02-<before|after>.json
 *
 * The Aryeo / Dropbox halves come from the CACHED evidence blob rather than a
 * live listing read: this is a DIFFERENTIAL measurement, both runs see the
 * identical inputs, and buying 300 listing reads to measure a code change is
 * not worth the API budget. (The engine itself always reads live — see
 * gatherSignals.) Nothing here writes.
 */
import { prisma } from "../../../src/lib/prisma";
import { computeStatus, expectedCategories, videoTier, type StatusSignals, type MediaCategory } from "../../../src/lib/projectStatus";
import { parseEvidence } from "../../../src/lib/statusEvidence";
import { OWED_DELIVERABLE_WHERE, slaTierOf, videoAnchorFor } from "../../../src/lib/tasks";
import { shootPendingFor } from "../../../src/lib/projectStatus";

const VIDEO_TYPES = new Set(["VIDEO", "SOCIAL_REEL"]);

async function main() {
  const projects = await prisma.project.findMany({
    where: {
      source: "ARYEO",
      aryeoMissingAt: null,
      OR: [
        { status: { in: ["BOOKED", "SCHEDULED", "SHOT", "EDITING", "REVIEW", "REVISION"] } },
        { status: "DELIVERED", deliveredAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) } },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true, title: true, status: true, shootDate: true, deliveredAt: true, deliveredBy: true, deliveredVia: true,
      packageName: true, tierOverride: true, revisionRequestedAt: true, revisionNote: true, statusEvidence: true,
      deliverables: { where: OWED_DELIVERABLE_WHERE, select: { id: true, type: true, label: true, status: true, quantity: true } },
      appointments: { select: { status: true, startAt: true, postponedAt: true } },
    },
  });

  const ids = projects.map((p) => p.id);
  const outputs = await prisma.deliverableOutput.findMany({
    where: { projectId: { in: ids }, waivedAt: null, removedFromOrderAt: null },
    select: { projectId: true, deliverableId: true, slot: true, category: true, deliveredAt: true },
  });
  const byProject = new Map<string, typeof outputs>();
  for (const o of outputs) byProject.set(o.projectId, [...(byProject.get(o.projectId) ?? []), o]);

  const rows: unknown[] = [];
  for (const p of projects) {
    const ev = parseEvidence(p.statusEvidence);
    const expected = expectedCategories(p.deliverables);
    const sla = slaTierOf(p);

    // The unit tally, exactly as gatherSignals builds it (video lane only).
    const rows0 = byProject.get(p.id) ?? [];
    const vids = rows0.filter((o) => (o.category ?? "").toUpperCase() === "VIDEO");
    const quantityOwed = p.deliverables
      .filter((d) => VIDEO_TYPES.has(d.type))
      .reduce((n, d) => n + Math.max(1, d.quantity ?? 1), 0);
    const owed = vids.length > 0 ? vids.length : quantityOwed;
    const units =
      expected.has("VIDEO") && owed > 0
        ? [
            {
              category: "VIDEO" as MediaCategory,
              owed,
              withClient: vids.filter((o) => o.deliveredAt).length,
              finished: 0,
              source: vids.length > 0 ? "outputs" : "quantity",
              outstandingKeys: vids.filter((o) => !o.deliveredAt).map((o) => `${o.deliverableId}:${o.slot}`),
            },
          ]
        : [];

    const sig = {
      expected,
      aryeo: ev?.aryeo ? { ...ev.aryeo, cover: null } : null,
      dropbox: ev?.dropbox ?? null,
      dropboxUnavailable: !ev?.dropbox,
      fulfilled: !!p.deliveredAt,
      officeConfirmed: !!(p.deliveredAt && (p.deliveredBy || ["board", "queue-pill", "override", "office-hand"].includes((p.deliveredVia ?? "").toLowerCase()))),
      deliveryActor: p.deliveredBy ?? p.deliveredVia ?? null,
      scheduled: p.appointments.some((a) => (a.status || "").toUpperCase() === "SCHEDULED"),
      anyAppt: p.appointments.some((a) => (a.status || "").toUpperCase() !== "CANCELED"),
      datedAppt: p.appointments.some((a) => (a.status || "").toUpperCase() !== "CANCELED" && a.startAt !== null),
      postponed: p.appointments.some(
        (a) => !(a.status || "").toUpperCase().startsWith("CANCEL") && ((a.status || "").toUpperCase() === "UNSCHEDULED" || (!!a.postponedAt && a.startAt === null)),
      ),
      shootDate: p.shootDate,
      videoAnchor: videoAnchorFor(p),
      shootPending: shootPendingFor(p),
      revisionOpen: !!p.revisionRequestedAt && !(p.deliveredAt && p.revisionRequestedAt.getTime() <= p.deliveredAt.getTime()),
      revisionNote: p.revisionNote,
      videoTier: videoTier(p.deliverables) === null ? null : sla === "premium" ? "premium" : "standard",
      monthlyContent: sla === "branding",
      videoType: p.deliverables.find((d) => expectedCategories([d]).has("VIDEO"))?.type ?? null,
      units,
    } as unknown as StatusSignals;

    const r = computeStatus(sig);
    rows.push({
      id: p.id,
      title: (p.title ?? "").split(",")[0].trim(),
      was: p.status,
      computed: r.status,
      reason: r.evidence.reason,
      missing: r.evidence.missing,
      awaitingSend: r.evidence.awaitingSend,
      owed: units[0]?.owed ?? null,
      unitSource: units[0]?.source ?? null,
      aryeoVideos: ev?.aryeo?.videos ?? null,
      deliveredActor: p.deliveredBy ?? p.deliveredVia ?? null,
    });
  }
  console.log(JSON.stringify(rows, null, 1));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
