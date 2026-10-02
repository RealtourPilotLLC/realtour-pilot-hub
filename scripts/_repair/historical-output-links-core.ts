import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

export const OUTPUT_LINK_UNLOCK = "ONLY_NAMED_HISTORICAL_OUTPUT_LINKS";
export type OutputLinkCandidate = { videoId: string; outputId: string; cutId: string; projectId: string; deliverableId: string; slot: number; enrollmentId: string; clientId: string; monthId: string };
type ReadDb = PrismaClient | Prisma.TransactionClient;
type LinkProof = { snapshotHash: string; preservedVideoHash: string; otherFactsHash: string; updatedAt: string; enrollmentStatus: string };
export type OutputLinkPlanRow = { candidate: OutputLinkCandidate; disposition: "ready" | "already" | "held"; reason: string; proof?: LinkProof };
export type OutputLinkPlan = { version: 1; scope: "named-historical-output-links"; createdAt: string; rows: OutputLinkPlanRow[] };

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function repairHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }
function preservedVideo(row: Record<string, unknown>) { return Object.fromEntries(Object.entries(row).filter(([k]) => k !== "outputId" && k !== "updatedAt")); }
const ledgerId = (c: OutputLinkCandidate) => `historical-output-link:${c.videoId}:${c.outputId}`;

async function facts(db: ReadDb, c: OutputLinkCandidate) {
  const [video, output, cut, project, deliverable, month, enrollment, rivals, chain, sources, decisions] = await Promise.all([
    db.contentVideo.findUnique({ where: { id: c.videoId } }),
    db.deliverableOutput.findUnique({ where: { id: c.outputId } }),
    db.reviewSubmission.findUnique({ where: { id: c.cutId } }),
    db.project.findUnique({ where: { id: c.projectId }, select: { id: true, clientId: true, contentMonthId: true, status: true, videosOwedOverride: true, videosFilmed: true } }),
    db.deliverable.findUnique({ where: { id: c.deliverableId }, select: { id: true, projectId: true, type: true, quantity: true, waivedAt: true, removedFromOrderAt: true } }),
    db.contentMonth.findUnique({ where: { id: c.monthId }, select: { id: true, enrollmentId: true, clientId: true, monthKey: true, videosOwed: true, status: true, historical: true } }),
    db.contentEnrollment.findUnique({ where: { id: c.enrollmentId }, select: { id: true, clientId: true, status: true, videosPerMonth: true } }),
    // Include archived rivals too. A stale duplicate is a hold, not a merge.
    db.contentVideo.findMany({ where: { OR: [{ outputId: c.outputId }, { projectId: c.projectId, deliverableId: c.deliverableId, slot: c.slot }] }, select: { id: true, outputId: true }, take: 3, orderBy: { id: "asc" } }),
    db.reviewSubmission.findMany({ where: { projectId: c.projectId, deliverableId: c.deliverableId, slot: c.slot }, take: 100, orderBy: { id: "asc" } }),
    db.contentVideoSource.findMany({ where: { videoId: c.videoId }, take: 100, orderBy: { id: "asc" } }),
    db.clientDecision.findMany({ where: { OR: [{ videoId: c.videoId }, { submissionId: c.cutId }] }, take: 100, orderBy: { id: "asc" } }),
  ]);
  return { video, output, cut, project, deliverable, month, enrollment, rivals, chain, sources, decisions };
}

async function prove(db: ReadDb, c: OutputLinkCandidate): Promise<OutputLinkPlanRow> {
  const f = await facts(db, c), held = (reason: string): OutputLinkPlanRow => ({ candidate: c, disposition: "held", reason });
  if (!f.video || !f.output || !f.cut || !f.project || !f.deliverable || !f.month || !f.enrollment) return held("An exact required source row is absent.");
  if (f.chain.length >= 100 || f.sources.length >= 100 || f.decisions.length >= 100) return held("Bounded history is incomplete; no repair can use a truncated proof.");
  if (f.video.enrollmentId !== c.enrollmentId || f.video.clientId !== c.clientId || f.video.monthId !== c.monthId || f.video.projectId !== c.projectId || f.video.deliverableId !== c.deliverableId || f.video.slot !== c.slot || f.video.currentSubmissionId !== c.cutId) return held("Video identity/current cut differs from the named source evidence.");
  if (f.video.status === "ARCHIVED" || (f.video.outputId !== null && f.video.outputId !== c.outputId)) return held("The named video is archived or already has another output identity.");
  if (f.output.projectId !== c.projectId || f.output.deliverableId !== c.deliverableId || f.output.slot !== c.slot || f.output.currentSubmissionId !== c.cutId || f.output.waivedAt || f.output.removedFromOrderAt) return held("Output coordinates/current cut or owed scope differs.");
  if (f.cut.projectId !== c.projectId || f.cut.deliverableId !== c.deliverableId || f.cut.slot !== c.slot || f.cut.videoId !== c.videoId || (f.cut.outputId !== null && f.cut.outputId !== c.outputId)) return held("The current exact cut does not prove this video/output identity.");
  if (f.chain.some((cut) => cut.videoId !== null && cut.videoId !== c.videoId) || f.chain.some((cut) => cut.outputId !== null && cut.outputId !== c.outputId)) return held("An existing cut version belongs to a different logical identity.");
  if (f.rivals.some((v) => v.id !== c.videoId)) return held("Another existing video claims these coordinates or output; no merge is permitted.");
  if (f.project.clientId !== c.clientId || f.project.contentMonthId !== c.monthId || f.project.status === "CANCELLED" || f.deliverable.projectId !== c.projectId || f.deliverable.waivedAt || f.deliverable.removedFromOrderAt || f.month.enrollmentId !== c.enrollmentId || f.month.clientId !== c.clientId || f.month.monthKey !== "2026-09" || f.video.monthKey !== f.month.monthKey || f.enrollment.clientId !== c.clientId) return held("Project/month/enrollment/client ownership or order scope differs.");
  const otherFacts = { output: f.output, cut: f.cut, project: f.project, deliverable: f.deliverable, month: f.month, enrollment: f.enrollment, chain: f.chain, sources: f.sources, decisions: f.decisions };
  return {
    candidate: c, disposition: f.video.outputId === c.outputId ? "already" : "ready", reason: "Exact existing coordinates and current cut agree; no topic/script/source-content assertion.",
    proof: { snapshotHash: repairHash({ video: f.video, ...otherFacts }), preservedVideoHash: repairHash(preservedVideo(f.video)), otherFactsHash: repairHash(otherFacts), updatedAt: f.video.updatedAt.toISOString(), enrollmentStatus: f.enrollment.status },
  };
}

export async function planHistoricalOutputLinks(db: ReadDb, candidates: readonly OutputLinkCandidate[]): Promise<OutputLinkPlan> {
  const rows: OutputLinkPlanRow[] = [];
  for (const candidate of candidates) rows.push(await prove(db, candidate));
  return { version: 1, scope: "named-historical-output-links", createdAt: new Date().toISOString(), rows };
}

export async function applyHistoricalOutputLinks(db: PrismaClient, plan: OutputLinkPlan, allowed: readonly OutputLinkCandidate[], opts: { unlock: string; expectedPlanHash: string; actorUserId: string }): Promise<{ changed: number; already: number }> {
  // No database operation is reached before both explicit mutation locks.
  if (opts.unlock !== OUTPUT_LINK_UNLOCK || opts.expectedPlanHash !== repairHash(plan)) throw new Error("Mutation remains locked: exact reviewed plan hash and named-output unlock are required.");
  if (plan.version !== 1 || plan.scope !== "named-historical-output-links" || !Array.isArray(plan.rows) || plan.rows.length !== allowed.length || repairHash(plan.rows.map((r) => r.candidate)) !== repairHash(allowed) || plan.rows.some((r) => r.disposition === "held" || !r.proof || !["ready", "already"].includes(r.disposition))) throw new Error("The reviewed plan does not match the exact allowed identities or contains a held proof.");
  if (!opts.actorUserId.trim()) throw new Error("An attributed active administrator is required.");
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('named-historical-output-links'))`;
    await tx.$queryRaw`SELECT "id" FROM "AppUser" WHERE "id" = ${opts.actorUserId} FOR SHARE`;
    const actor = await tx.appUser.findUnique({ where: { id: opts.actorUserId }, select: { id: true, email: true, role: true, status: true } });
    if (!actor || actor.status !== "ACTIVE" || !["OWNER", "ADMIN"].includes(actor.role)) throw new Error("The attributed account is not an active owner/administrator.");
    let changed = 0, already = 0;
    for (const row of plan.rows) {
      const c = row.candidate;
      await tx.$queryRaw`SELECT "id" FROM "ContentVideo" WHERE "id" = ${c.videoId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "DeliverableOutput" WHERE "id" = ${c.outputId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "ReviewSubmission" WHERE "id" = ${c.cutId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${c.projectId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "Deliverable" WHERE "id" = ${c.deliverableId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "ContentMonth" WHERE "id" = ${c.monthId} FOR SHARE`;
      await tx.$queryRaw`SELECT "id" FROM "ContentEnrollment" WHERE "id" = ${c.enrollmentId} FOR SHARE`;
      const current = await prove(tx, c);
      if (current.disposition === "held" || !current.proof) throw new Error(`Source proof changed for named candidate ${c.videoId}; nothing in this batch can be committed.`);
      const ledger = await tx.contentVideoCorrection.findUnique({ where: { id: ledgerId(c) } });
      if (current.disposition === "already") {
        if (row.disposition === "already" && current.proof.snapshotHash === row.proof!.snapshotHash) { already++; continue; }
        if (ledger?.videoId === c.videoId && ledger.field === "outputId" && ledger.fromValue === null && ledger.toValue === c.outputId && current.proof.preservedVideoHash === row.proof!.preservedVideoHash && current.proof.otherFactsHash === row.proof!.otherFactsHash) { already++; continue; }
        throw new Error(`Existing output link for ${c.videoId} has no unchanged matching repair history.`);
      }
      if (row.disposition !== "ready" || current.proof.snapshotHash !== row.proof!.snapshotHash || ledger) throw new Error(`Reviewed snapshot drifted for ${c.videoId}; make and review a new dry-run plan.`);
      const n = await tx.contentVideo.updateMany({ where: { id: c.videoId, outputId: null, updatedAt: new Date(row.proof!.updatedAt), clientId: c.clientId, enrollmentId: c.enrollmentId, monthId: c.monthId, projectId: c.projectId, deliverableId: c.deliverableId, slot: c.slot, currentSubmissionId: c.cutId }, data: { outputId: c.outputId } });
      if (n.count !== 1) throw new Error(`Compare-and-set refused candidate ${c.videoId}.`);
      await tx.contentVideoCorrection.create({ data: { id: ledgerId(c), videoId: c.videoId, enrollmentId: c.enrollmentId, field: "outputId", fromValue: null, toValue: c.outputId, by: actor.email, reason: "Mechanical existing output link: exact project/deliverable/slot/current cut. No topic/script/source-content assertion." } });
      await tx.auditLog.create({ data: { id: ledgerId(c), actor: actor.email, action: "historical_output_link", target: c.videoId, detail: JSON.stringify({ field: "outputId", from: null, to: c.outputId, projectId: c.projectId, cutId: c.cutId, evidenceHash: row.proof!.snapshotHash, planHash: opts.expectedPlanHash }) } });
      const after = await prove(tx, c);
      if (after.disposition !== "already" || after.proof?.preservedVideoHash !== row.proof!.preservedVideoHash || after.proof?.otherFactsHash !== row.proof!.otherFactsHash) throw new Error(`Preservation readback failed for ${c.videoId}.`);
      changed++;
    }
    return { changed, already };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, maxWait: 10_000, timeout: 30_000 });
}
