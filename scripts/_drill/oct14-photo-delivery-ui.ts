// ---------------------------------------------------------------------------
// DRILL: THE PHOTO DELIVERY PAGE (Oct 14 2026, docs/photo-delivery/01
// sections 7.5, 8.3, 9). The decision writes behind the queue, the job page
// and review mode (src/lib/photoDelivery/decisions.ts) and the page loaders
// (src/app/ops/photo-delivery/data.ts), on a seeded job:
//
//   1. Findings: ignoring a MAJOR needs a reason (a MINOR does not); a group
//      decision applies to every finding in it; ids from another job, or
//      from two jobs at once, are refused; every write logs a PhotoJobEvent.
//   2. Photos: excluding needs a reason, sets the photo's own open findings
//      aside (and putting it back reopens exactly those); an excluded photo
//      cannot be the hero; excluding the hero clears it; the delivery order
//      persists and refuses foreign or doubled ids.
//   3. The stage rule: the LAST major-or-critical decision moves QC_REVIEW to
//      READY (a below-floor finding never blocks); reopening one sends READY
//      back to QC_REVIEW. Holds move to ON_HOLD and back.
//   4. Client QC profile: rule overrides validated against the registry, a
//      reason each, long dashes stripped from the client-facing message.
//   5. Loaders: the queue's columns, counts, filters, the 7-day delivered
//      window and the cancelled-shoot rule; the job page hides dollars from
//      an admin and shows them to the owner.
//   6. Static: no em or en dash in any file of the page, and every server
//      action calls its guard (owner-only where the plan says so); the fix
//      runner switch, the "replace on Aryeo" list, prices only from the cart,
//      and no client component pulling in a server module.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness (DRILL_PORT, default
// 6947). Production is never opened; every outbound call is fenced.
//   node scripts/_drill/run-all.cjs scripts/_drill/oct14-photo-delivery-ui.ts
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const REPO = path.resolve(__dirname, "../..");
const PORT = Number(process.env.DRILL_PORT ?? 6947);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LONG_DASH = /[\u2013\u2014]/;

function filesUnder(rel: string): string[] {
  const root = path.join(REPO, rel);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** The body of each `export async function` in a "use server" file. */
function exportedBodies(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /export async function (\w+)\s*\(/g;
  const starts: { name: string; at: number }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) starts.push({ name: m[1], at: m.index });
  starts.forEach((s, i) => out.set(s.name, src.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : src.length)));
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const d = await import("@/lib/photoDelivery/decisions");
    const data = await import("@/app/ops/photo-delivery/data");
    const { groupFindings } = await import("@/components/photoDelivery/format");
    const now = new Date();

    // ---- seed --------------------------------------------------------------------------------
    const client = await prisma.client.create({ data: { name: "Drill Photo Client TEST" } });
    const other = await prisma.client.create({ data: { name: "Other Client TEST" } });
    const pg = await prisma.teamMember.create({ data: { name: "Drill Photographer", email: "drill-photo-ui@example.com" } });
    const project = async (title: string, over: Record<string, unknown> = {}) =>
      prisma.project.create({ data: { title, addressLine: title.split(",")[0], clientId: client.id, photographerId: pg.id, shootDate: new Date(now.getTime() - DAY), ...over } });
    const p1 = await project("12 Drill Lane, Testville, PA", { aryeoListingId: "lst-drill-1", aryeoOrderId: "ord-drill-1" });
    const job = await prisma.photoJob.create({ data: { projectId: p1.id, stage: "QC_REVIEW", slaDueAt: new Date(now.getTime() + 20 * HOUR), qcShadow: true } });
    const photo = (name: string, seq: number, roomType: string) =>
      prisma.photoAsset.create({ data: { jobId: job.id, name, sequence: seq, roomType, status: "ACTIVE", sourceKind: "ARYEO", sourceUrl: `https://cdn.aryeo.com/drill/${name}`, contentHash: `h-${name}`, width: 6000, height: 4000 } });
    const A = await photo("A.jpg", 0, "EXTERIOR_FRONT");
    const B = await photo("B.jpg", 1, "KITCHEN");
    const C = await photo("C.jpg", 2, "LIVING");
    const D = await photo("D.jpg", 3, "BEDROOM");
    const run = await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1-2026-10-13", passesJson: JSON.stringify(["CV", "P0", "P1", "P4"]), costUsd: 1.84, photoCount: 4, finishedAt: now } });
    await prisma.photoJob.update({ where: { id: job.id }, data: { lastQcRunId: run.id, qcVerdict: "HOLD" } });
    const finding = (o: { photoId: string | null; ruleId: string; groupKey: string; severity: string; confidence: number; pass?: string; privacy?: boolean; raw?: unknown }) =>
      prisma.photoQcFinding.create({
        data: {
          qcRunId: run.id, jobId: job.id, photoId: o.photoId, ruleId: o.ruleId, groupKey: o.groupKey, pass: o.pass ?? "P1_PHOTO", source: o.pass === "P4_ORDER" ? "P4" : "P1",
          specificIssue: `${o.ruleId} seen`, explanation: "Seeded by the drill.", severity: o.severity, confidence: o.confidence, responsibility: "EDITOR",
          fixStrategy: "AUTOREMOVE_MASK", privacySensitive: !!o.privacy, bboxJson: o.photoId ? JSON.stringify([100, 200, 900, 1200]) : null, rawJson: o.raw ? JSON.stringify(o.raw) : null,
        },
      });
    const fA = await finding({ photoId: A.id, ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", severity: "MAJOR", confidence: 0.9 });
    const fB = await finding({ photoId: B.id, ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", severity: "MAJOR", confidence: 0.8 });
    const fMinor = await finding({ photoId: C.id, ruleId: "PREP_LOOSE_CORDS_CABLES", groupKey: "CORDS", severity: "MINOR", confidence: 0.7 });
    const fLow = await finding({ photoId: D.id, ruleId: "PREP_SHOES_FOOTWEAR", groupKey: "SHOES", severity: "MAJOR", confidence: 0.3 });
    const fPriv = await finding({ photoId: C.id, ruleId: "PREP_PERSONAL_PHOTOS", groupKey: "PERSONAL_PHOTOS", severity: "CRITICAL", confidence: 0.95, privacy: true });
    const fP4 = await finding({ photoId: null, ruleId: "ORD_DRONE_INCLUDED", groupKey: "count:aerial", severity: "MAJOR", confidence: 0.9, pass: "P4_ORDER", raw: { status: "NOT_MET" } });
    // A second job (for the cross-job refusals).
    const p2 = await project("40 Other Road, Testville, PA");
    const job2 = await prisma.photoJob.create({ data: { projectId: p2.id, stage: "QC_REVIEW", slaDueAt: new Date(now.getTime() + 30 * HOUR) } });
    const run2 = await prisma.photoQcRun.create({ data: { jobId: job2.id, trigger: "INITIAL", status: "DONE", rulesVersion: "v1" } });
    const x2 = await prisma.photoAsset.create({ data: { jobId: job2.id, name: "X.jpg", sequence: 0, status: "ACTIVE", contentHash: "h-x" } });
    const f2 = await prisma.photoQcFinding.create({ data: { qcRunId: run2.id, jobId: job2.id, photoId: x2.id, ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", pass: "P1_PHOTO", source: "P1", specificIssue: "bin", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "AUTOREMOVE_MASK" } });

    const stageOf = async (id = job.id) => (await prisma.photoJob.findUnique({ where: { id }, select: { stage: true } }))?.stage;
    const statusOf = async (id: string) => prisma.photoQcFinding.findUnique({ where: { id }, select: { status: true, statusReason: true, decidedBy: true, decidedAt: true } });
    const events = async (id = job.id) => prisma.photoJobEvent.count({ where: { jobId: id } });

    // =======================================================================
    c.head("1 · finding decisions");
    // =======================================================================
    let ev = await events();
    const noReason = await d.decideFindings({ findingIds: [fA.id], status: "IGNORED", reason: "", by: "Kyle" });
    c.ok("ignoring a MAJOR without a reason is refused", !noReason.ok && /reason/i.test(noReason.message), noReason.message);
    c.ok("... and nothing changed or was logged", (await statusOf(fA.id))?.status === "OPEN" && (await events()) === ev);
    const fpNoReason = await d.decideFindings({ findingIds: [fA.id], status: "FALSE_POSITIVE", reason: " ", by: "Kyle" });
    c.ok("calling a MAJOR a false positive also needs a reason", !fpNoReason.ok);
    const group = await d.decideFindings({ jobId: job.id, findingIds: [fA.id, fB.id], status: "IGNORED", reason: "Client preference: the bins stay", by: "Kyle" });
    const sa = await statusOf(fA.id);
    const sb = await statusOf(fB.id);
    c.ok("a group decision applies to every finding in it", group.ok && group.ok && group.changed === 2 && sa?.status === "IGNORED" && sb?.status === "IGNORED", JSON.stringify(group));
    c.ok("... with who, when and why on each", sa?.decidedBy === "Kyle" && sb?.decidedBy === "Kyle" && !!sa?.decidedAt && sa?.statusReason === "Client preference: the bins stay" && sb?.statusReason === sa?.statusReason);
    c.ok("... and one activity line", (await events()) === ev + 1);
    c.ok("the job stays in QC_REVIEW while a major or critical is open", (await stageOf()) === "QC_REVIEW");
    const minor = await d.decideFindings({ findingIds: [fMinor.id], status: "IGNORED", reason: null, by: "Kyle" });
    c.ok("a MINOR can be ignored without a reason", minor.ok && (await statusOf(fMinor.id))?.status === "IGNORED", minor.message);
    const wrongJob = await d.decideFindings({ jobId: job2.id, findingIds: [fP4.id], status: "OVERRIDDEN", reason: "forged", by: "Kyle" });
    c.ok("a finding sent with another job's id is refused", !wrongJob.ok && (await statusOf(fP4.id))?.status === "OPEN", wrongJob.message);
    const twoJobs = await d.decideFindings({ findingIds: [fP4.id, f2.id], status: "SENT_TO_EDITOR", by: "Kyle" });
    c.ok("findings from two jobs in one call are refused", !twoJobs.ok && (await statusOf(f2.id))?.status === "OPEN", twoJobs.message);
    const ghost = await d.decideFindings({ findingIds: ["does-not-exist-123"], status: "IGNORED", reason: "x y z", by: "Kyle" });
    c.ok("an unknown finding id is refused", !ghost.ok);
    const bogus = await d.decideFindings({ findingIds: [fA.id], status: "FIXED" as never, by: "Kyle" });
    c.ok("a status outside the decision list is refused", !bogus.ok);

    // =======================================================================
    c.head("2 · photos: exclude, hero, order");
    // =======================================================================
    ev = await events();
    const exNo = await d.setPhotoExcluded(C.id, true, "", "Kyle", job.id);
    c.ok("excluding a photo needs a reason", !exNo.ok && (await prisma.photoAsset.findUnique({ where: { id: C.id } }))?.status === "ACTIVE");
    const exForeign = await d.setPhotoExcluded(x2.id, true, "Duplicate", "Kyle", job.id);
    c.ok("a photo of another job is refused", !exForeign.ok && (await prisma.photoAsset.findUnique({ where: { id: x2.id } }))?.status === "ACTIVE");
    const exC = await d.setPhotoExcluded(C.id, true, "Privacy: family photos on the wall", "Kyle", job.id);
    const cRow = await prisma.photoAsset.findUnique({ where: { id: C.id } });
    const privRow = await statusOf(fPriv.id);
    c.ok("excluding persists the status and the reason", exC.ok && cRow?.status === "EXCLUDED" && cRow?.excludeReason === "Privacy: family photos on the wall", exC.message);
    c.ok("the photo's open critical is set aside with the exclusion as the reason", privRow?.status === "OVERRIDDEN" && privRow.statusReason?.startsWith(d.EXCLUDED_REASON_PREFIX) === true && privRow.decidedBy === "Kyle");
    c.ok("an already-decided finding on it is left alone", (await statusOf(fMinor.id))?.status === "IGNORED");
    c.ok("excluding logged an event", (await events()) === ev + 1);
    c.ok("still QC_REVIEW: the coverage MAJOR is open", (await stageOf()) === "QC_REVIEW");

    const heroEx = await d.setHero(job.id, C.id, "Kyle");
    c.ok("an excluded photo cannot be the hero", !heroEx.ok);
    const heroForeign = await d.setHero(job.id, x2.id, "Kyle");
    c.ok("another job's photo cannot be the hero", !heroForeign.ok);
    ev = await events();
    const heroA = await d.setHero(job.id, A.id, "Kyle");
    c.ok("setting the hero persists and logs", heroA.ok && (await prisma.photoJob.findUnique({ where: { id: job.id } }))?.heroPhotoId === A.id && (await events()) === ev + 1);
    const exA = await d.setPhotoExcluded(A.id, true, "Duplicate of B", "Kyle", job.id);
    c.ok("excluding the hero clears the hero", exA.ok && (await prisma.photoJob.findUnique({ where: { id: job.id } }))?.heroPhotoId === null, exA.message);
    const inA = await d.setPhotoExcluded(A.id, false, null, "Kyle", job.id);
    c.ok("putting a photo back makes it ACTIVE again", inA.ok && (await prisma.photoAsset.findUnique({ where: { id: A.id } }))?.status === "ACTIVE");
    c.ok("... and the decided finding on it stays decided (it was IGNORED, not set aside by the exclusion)", (await statusOf(fA.id))?.status === "IGNORED");
    await d.setHero(job.id, A.id, "Kyle");

    // Exclusion of D (whose only finding is below the floor) and back: exactly that finding reopens.
    await d.setPhotoExcluded(D.id, true, "Weak angle", "Kyle", job.id);
    c.ok("a below-floor finding is also set aside by the exclusion", (await statusOf(fLow.id))?.status === "OVERRIDDEN");
    await d.setPhotoExcluded(D.id, false, null, "Kyle", job.id);
    c.ok("putting the photo back reopens exactly the findings the exclusion set aside", (await statusOf(fLow.id))?.status === "OPEN" && (await statusOf(fA.id))?.status === "IGNORED");

    ev = await events();
    const ord = await d.setDeliveryOrder(job.id, [B.id, A.id, D.id], "Kyle");
    const ordRow = await prisma.photoJob.findUnique({ where: { id: job.id }, select: { orderJson: true } });
    c.ok("the delivery order persists as photo ids", ord.ok && ordRow?.orderJson === JSON.stringify([B.id, A.id, D.id]) && (await events()) === ev + 1, ordRow?.orderJson ?? "");
    const ordForeign = await d.setDeliveryOrder(job.id, [B.id, x2.id], "Kyle");
    c.ok("an order naming another job's photo is refused", !ordForeign.ok && (await prisma.photoJob.findUnique({ where: { id: job.id } }))?.orderJson === ordRow?.orderJson);
    const ordDup = await d.setDeliveryOrder(job.id, [B.id, B.id], "Kyle");
    c.ok("an order with a photo twice is refused", !ordDup.ok);

    // =======================================================================
    c.head("3 · the stage rule and holds");
    // =======================================================================
    const last = await d.decideFindings({ jobId: job.id, findingIds: [fP4.id], status: "OVERRIDDEN", reason: "Drone add-on cancelled by the client", by: "Jordan" });
    c.ok("the last major decided moves QC_REVIEW to READY", last.ok && last.stage === "READY" && (await stageOf()) === "READY", JSON.stringify(last));
    c.ok("a below-floor MAJOR left open never blocks", (await statusOf(fLow.id))?.status === "OPEN");
    const lastEvent = await prisma.photoJobEvent.findFirst({ where: { jobId: job.id }, orderBy: { at: "desc" } });
    c.ok("the move itself is in the activity log", /QC_REVIEW → READY/.test(lastEvent?.action ?? ""), lastEvent?.action);
    const reopen = await d.decideFindings({ findingIds: [fA.id], status: "OPEN", by: "Jordan" });
    const reopened = await statusOf(fA.id);
    c.ok("reopening a major sends READY back to QC_REVIEW", reopen.ok && reopen.stage === "QC_REVIEW" && reopened?.status === "OPEN" && reopened.decidedBy === null && reopened.statusReason === null, JSON.stringify(reopen));
    await d.decideFindings({ findingIds: [fA.id], status: "SENT_TO_EDITOR", by: "Jordan" });
    c.ok("sending it to the editor resolves it again: READY", (await stageOf()) === "READY");
    await d.setPhotoExcluded(C.id, false, null, "Kyle", job.id);
    c.ok("putting the privacy photo back reopens its critical: QC_REVIEW", (await statusOf(fPriv.id))?.status === "OPEN" && (await stageOf()) === "QC_REVIEW");
    await d.setPhotoExcluded(C.id, true, "Privacy: family photos on the wall", "Kyle", job.id);
    c.ok("excluding it again: READY", (await stageOf()) === "READY");

    const holdNo = await d.holdJob(job.id, "", "Kyle");
    c.ok("a hold needs a reason", !holdNo.ok && (await stageOf()) === "READY");
    const hold = await d.holdJob(job.id, "Agent asked us to wait for staging", "Kyle");
    const held = await prisma.photoJob.findUnique({ where: { id: job.id }, select: { stage: true, holdReason: true, holdResumeStage: true, holdNote: true } });
    c.ok("hold: ON_HOLD, MANUAL, remembers READY", hold.ok && held?.stage === "ON_HOLD" && held.holdReason === "MANUAL" && held.holdResumeStage === "READY" && held.holdNote === "Agent asked us to wait for staging", JSON.stringify(held));
    const hold2 = await d.holdJob(job.id, "again", "Kyle");
    c.ok("holding a held job is refused", !hold2.ok);
    const rel = await d.releaseJobHold(job.id, "Kyle");
    c.ok("release: back to READY, hold fields cleared", rel.ok && (await stageOf()) === "READY" && (await prisma.photoJob.findUnique({ where: { id: job.id } }))?.holdReason === null, rel.message);
    const rel2 = await d.releaseJobHold(job.id, "Kyle");
    c.ok("releasing a job that is not held is refused", !rel2.ok);
    const qc = await d.requestQcRerun(job.id, "Kyle");
    c.ok("a QC re-run request raises qcRequestedAt and logs", qc.ok && !!(await prisma.photoJob.findUnique({ where: { id: job.id } }))?.qcRequestedAt);

    // =======================================================================
    c.head("4 · client QC profile");
    // =======================================================================
    const badRule = await d.saveClientQcProfile(client.id, { ruleOverrides: [{ ruleId: "NOT_A_RULE", disabled: true, reason: "test" }] }, "Jordan");
    c.ok("an override for a rule that does not exist is refused", !badRule.ok, badRule.message);
    const noWhy = await d.saveClientQcProfile(client.id, { ruleOverrides: [{ ruleId: "PREP_TRASH_CANS", disabled: true, reason: "" }] }, "Jordan");
    c.ok("an override without a reason is refused", !noWhy.ok);
    const neither = await d.saveClientQcProfile(client.id, { ruleOverrides: [{ ruleId: "PREP_TRASH_CANS", reason: "because" }] }, "Jordan");
    c.ok("an override that neither disables nor re-grades is refused", !neither.ok);
    const badSla = await d.saveClientQcProfile(client.id, { slaHours: 0 }, "Jordan");
    c.ok("SLA hours outside 1 to 336 are refused", !badSla.ok);
    ev = await events();
    const saved = await d.saveClientQcProfile(
      client.id,
      {
        slaHours: 12,
        notes: "Bins are fine at the curb on trash day.",
        deliveryMessage: "Your photos are ready \u2014 enjoy! Realtour Pilot Team",
        ruleOverrides: [
          { ruleId: "PREP_TRASH_CANS", severity: "MINOR", reason: "Curbside bins are normal here" },
          { ruleId: "PREP_SHOES_FOOTWEAR", disabled: true, reason: "Client stages shoes on purpose" },
        ],
      },
      "Jordan",
    );
    const prof = await prisma.clientQcProfile.findUnique({ where: { clientId: client.id } });
    const overrides = JSON.parse(prof?.ruleOverridesJson ?? "[]") as { ruleId: string; severity?: string; disabled?: boolean }[];
    c.ok("a valid profile saves", saved.ok && prof?.slaHours === 12 && prof.notes === "Bins are fine at the curb on trash day." && prof.updatedBy === "Jordan", saved.message);
    c.ok("the client-facing message never keeps a long dash", !!prof?.deliveryMessage && !LONG_DASH.test(prof.deliveryMessage) && prof.deliveryMessage.includes("ready, enjoy"), prof?.deliveryMessage ?? "");
    c.ok("overrides persist (re-grade and disable)", overrides.length === 2 && overrides.some((o) => o.ruleId === "PREP_TRASH_CANS" && o.severity === "MINOR") && overrides.some((o) => o.ruleId === "PREP_SHOES_FOOTWEAR" && o.disabled === true));
    c.ok("the change is logged on the client's open jobs", (await events()) > ev && (await prisma.photoJobEvent.count({ where: { jobId: job2.id, action: { startsWith: "client QC profile updated" } } })) === 1);
    const missing = await d.saveClientQcProfile("no-such-client-1234", { slaHours: 5 }, "Jordan");
    c.ok("a profile for a client that does not exist is refused", !missing.ok);

    // =======================================================================
    c.head("5 · loaders");
    // =======================================================================
    // More jobs, one per board column (plus the edges).
    const mk = async (title: string, stage: string, over: Record<string, unknown> = {}, projOver: Record<string, unknown> = {}) => {
      const p = await project(title, projOver);
      return prisma.photoJob.create({ data: { projectId: p.id, stage, ...over } });
    };
    const jEditing = await mk("1 Risk Way, Testville, PA", "EDITING", { slaDueAt: new Date(now.getTime() + 1 * HOUR) });
    const jEdited = await mk("2 Landed Ct, Testville, PA", "EDITED", { slaDueAt: new Date(now.getTime() + 40 * HOUR) });
    const jFixing = await mk("3 Fix St, Testville, PA", "FIXING", { slaDueAt: new Date(now.getTime() + 10 * HOUR) });
    const jMismatch = await mk("4 Diff Ave, Testville, PA", "DELIVERY_MISMATCH", { slaDueAt: new Date(now.getTime() - 2 * HOUR) });
    const jRecent = await mk("5 Done Rd, Testville, PA", "DELIVERED", { deliveredAt: new Date(now.getTime() - 2 * DAY) });
    await mk("6 Old Rd, Testville, PA", "DELIVERED", { deliveredAt: new Date(now.getTime() - 10 * DAY), stageChangedAt: new Date(now.getTime() - 10 * DAY) });
    await mk("7 Cancelled Pl, Testville, PA", "EDITING", {}, { status: "CANCELLED" });
    const jOther = await mk("8 Elsewhere Dr, Testville, PA", "ON_HOLD", { holdReason: "CREDITS" }, { clientId: other.id, photographerId: null });
    const batch = await prisma.photoFixBatch.create({ data: { jobId: jFixing.id, mode: "ALL", estimatedCredits: 3, approvedBy: "Kyle", status: "RUNNING" } });
    const fp = await prisma.photoAsset.create({ data: { jobId: jFixing.id, name: "F.jpg", sequence: 0, status: "ACTIVE" } });
    await prisma.photoFixOperation.createMany({
      data: [
        { batchId: batch.id, jobId: jFixing.id, photoId: fp.id, findingIdsJson: "[]", strategy: "AUTOREMOVE_MASK", status: "VERIFIED", estimatedCredits: 0 },
        { batchId: batch.id, jobId: jFixing.id, photoId: fp.id, findingIdsJson: "[]", strategy: "REEDIT_PROMPT", status: "SUBMITTED", estimatedCredits: 1, seq: 1 },
      ],
    });
    // job2: the same bin on a second photo is ONE ticket, not two issues.
    const x3 = await prisma.photoAsset.create({ data: { jobId: job2.id, name: "Y.jpg", sequence: 1, status: "ACTIVE", contentHash: "h-y" } });
    await prisma.photoQcFinding.create({ data: { qcRunId: run2.id, jobId: job2.id, photoId: x3.id, ruleId: "PREP_TRASH_CANS", groupKey: "TRASH_CAN", pass: "P1_PHOTO", source: "P1", specificIssue: "bin", explanation: "x", severity: "MAJOR", confidence: 0.9, responsibility: "EDITOR", fixStrategy: "AUTOREMOVE_MASK" } });
    // A fix that landed after the photo went on the listing: Kyle swaps it in Aryeo.
    const fixed = await prisma.photoVersion.create({ data: { photoId: B.id, label: "AutoHDR fix: bins removed", source: "FIX", contentHash: "h-B-fix", derivJson: JSON.stringify({ file: "photo-fixes/drill/B.jpg" }) } });
    // Back to QC_REVIEW on the main job, so its card carries open counts.
    await d.decideFindings({ findingIds: [fP4.id], status: "OPEN", by: "Jordan" });

    const q = await data.loadQueue({ now });
    const col = (k: string) => q.columns.find((x) => x.key === k)!;
    const ids = (k: string) => col(k).cards.map((x) => x.id);
    c.ok("the columns, in pipeline order", q.columns.map((x) => x.key).join(",") === "editing,qc,decision,fixing,hold,ready,delivering,delivered", q.columns.map((x) => x.key).join(","));
    c.ok("Editing has the editing job; the cancelled shoot is not on the board", ids("editing").join() === jEditing.id, JSON.stringify(ids("editing")));
    c.ok("QC running holds the landed (EDITED) gallery", ids("qc").join() === jEdited.id);
    c.ok("Needs decision: both QC_REVIEW jobs, soonest SLA first", ids("decision").join() === [job.id, job2.id].join(), JSON.stringify(ids("decision")));
    c.ok("Fixing, On hold, Delivering (with the mismatch)", ids("fixing").join() === jFixing.id && ids("hold").join() === jOther.id && ids("delivering").join() === jMismatch.id);
    c.ok("Delivered shows the last 7 days only", ids("delivered").join() === jRecent.id, JSON.stringify(ids("delivered")));
    c.ok("total counts every card on the board", q.total === 8 && q.shown === 8, `${q.total}/${q.shown}`);
    const card = col("decision").cards.find((x) => x.id === job.id)!;
    c.ok("issue counts: open findings at or above the floor only", card.issues.MAJOR === 1 && card.issues.CRITICAL === 0 && card.issues.MINOR === 0, JSON.stringify(card.issues));
    c.ok("the card's thumbnail is the hero, with the Aryeo fallback", card.hero?.photoId === A.id && card.hero.fallbackUrl === "https://cdn.aryeo.com/drill/A.jpg");
    c.ok("photo count is the included photos", card.photoCount === 3, String(card.photoCount));
    c.ok("shadow badge data, street, client, photographer", card.shadow && card.street === "12 Drill Lane" && card.clientName === "Drill Photo Client TEST" && card.photographerName === "Drill Photographer");
    const card2 = col("decision").cards.find((x) => x.id === job2.id)!;
    c.ok("issues count as tickets: the same bin on two photos is ONE issue, re-graded MINOR by the client's override (section 4)", card2.issues.MINOR === 1 && card2.issues.MAJOR === 0 && card2.issues.CRITICAL === 0, JSON.stringify(card2.issues));
    const fixCard = col("fixing").cards[0];
    c.ok("the fix status reads the latest batch", fixCard.fix?.status === "RUNNING" && /1 of 2/.test(fixCard.fix.label), fixCard.fix?.label);
    c.ok("at risk: inside 6 hours or late, never delivered", col("editing").cards[0].atRisk && col("delivering").cards[0].atRisk && !card.atRisk && !col("delivered").cards[0].atRisk);
    const risk = await data.loadQueue({ now, filters: { atRisk: true } });
    c.ok("the at-risk filter keeps only those", risk.shown === 2 && risk.total === 8, `${risk.shown}`);
    const byClient = await data.loadQueue({ now, filters: { client: other.id } });
    c.ok("the client filter", byClient.shown === 1 && byClient.columns.find((x) => x.key === "hold")!.cards[0].id === jOther.id);
    const byPg = await data.loadQueue({ now, filters: { photographer: pg.id } });
    c.ok("the photographer filter", byPg.shown === 7, String(byPg.shown));
    c.ok("filter options list the board's clients and photographers", q.clients.length === 2 && q.photographers.length === 1);

    const admin = { role: "ADMIN", name: "Kyle", isOwner: false, canSeeMoney: false };
    const owner = { role: "OWNER", name: "Jordan", isOwner: true, canSeeMoney: true };
    const asAdmin = await data.loadJobDetail(job.id, { viewer: admin, now });
    const asOwner = await data.loadJobDetail(job.id, { viewer: owner, now });
    c.ok("the job page loads", !!asAdmin && !!asOwner);
    c.ok("an admin gets no dollars (run cost, cart, credit rate)", asAdmin!.header.lastRunCostUsd === null && asAdmin!.runs.every((r) => r.costUsd === null) && (asAdmin!.cart?.usdPerCredit ?? null) === null);
    c.ok("the owner sees the run cost", asOwner!.header.lastRunCostUsd === 1.84 && asOwner!.runs[0].costUsd === 1.84);
    const order = asAdmin!.photos.map((p) => p.name).join(",");
    c.ok("gallery: hero first, then the saved order, excluded last", order === "A.jpg,B.jpg,D.jpg,C.jpg", order);
    c.ok("positions and delivery names for included photos only", asAdmin!.photos[0].position === 1 && !!asAdmin!.photos[0].deliveryName && asAdmin!.photos[3].position === null);
    const groups = groupFindings(asAdmin!.findings.filter((f) => f.pass !== "P4_ORDER"));
    const trash = groups.find((g) => g.ruleId === "PREP_TRASH_CANS");
    c.ok("findings group by rule and groupKey across photos", !!trash && trash.findings.length === 2 && trash.photoIds.length === 2 && trash.title === "Trash or recycling bin", JSON.stringify(trash?.photoIds));
    c.ok("the P4 finding carries its coverage status", asAdmin!.findings.find((f) => f.id === fP4.id)?.coverageStatus === "NOT_MET");
    c.ok("the box is parsed for overlays", JSON.stringify(asAdmin!.findings.find((f) => f.id === fPriv.id)?.bbox) === "[100,200,900,1200]");
    c.ok("the gate and steps load", !!asAdmin!.gate && asAdmin!.gate.advisory && !!asAdmin!.steps && asAdmin!.steps.order.length === 3, asAdmin!.gateError ?? asAdmin!.stepsError ?? "");
    c.ok("the cart loads, blocked plainly (AutoHDR not connected)", !!asAdmin!.cart && asAdmin!.cart.blockers.some((b) => /not connected/i.test(b)), asAdmin!.cartError ?? JSON.stringify(asAdmin!.cart?.blockers));
    c.ok("the cart says plainly that fixes are switched off (fixRunnerEnabled off)", !!asAdmin!.cart && asAdmin!.cart.blockers.some((b) => /switched off/i.test(b)));
    const rep = asAdmin!.steps?.replacements ?? [];
    c.ok("the deliver steps list the fixed photo to replace on Aryeo, with its download", rep.length === 1 && rep[0].photoId === B.id && rep[0].versionId === fixed.id && rep[0].downloadUrl === `/api/photo-fixes/${fixed.id}`, JSON.stringify(rep));
    const trashMeta = asAdmin!.groupMeta["PREP_TRASH_CANS::TRASH_CAN"];
    c.ok("the job page carries the QC engine's verdict per group (client override applied)", !!trashMeta && trashMeta.severity === "MINOR" && trashMeta.holds === false, JSON.stringify(trashMeta));
    c.ok("a missing job is null (the page answers 404)", (await data.loadJobDetail("no-such-job-12345", { viewer: admin, now })) === null);
    const credits = await data.loadCreditsPage(admin, { now });
    c.ok("the credits page loads without dollars for an admin", credits.credit.usdPerCredit === null && credits.credit.connected === false && Array.isArray(credits.spend) && credits.spend.length >= 5);
    const ownerCredits = await data.loadCreditsPage(owner, { now });
    c.ok("... and with the rate for the owner", ownerCredits.credit.usdPerCredit === 0.5);
    const profiles = await data.loadClientProfiles();
    c.ok("client profiles list clients with photo jobs, with their saved profile", profiles.length === 2 && profiles.find((p) => p.clientId === client.id)?.slaHours === 12 && profiles.find((p) => p.clientId === client.id)!.overrides.length === 2);
    const { RULES } = await import("@/lib/photoDelivery/registry");
    const options = data.ruleOptions();
    const actions = await import("@/app/ops/photo-delivery/actions");
    const { photoDeliverySettings } = await import("@/lib/photoDelivery/settings");
    c.ok("fixRunnerEnabled defaults off", (await photoDeliverySettings()).fixRunnerEnabled === false);
    const saveOn = await actions.saveSettingsAction({ fixRunnerEnabled: true, adminCreditCap: 30 });
    const afterSave = await photoDeliverySettings();
    c.ok("the settings action saves fixRunnerEnabled and the cap (gate open: drill, not production)", saveOn.ok && afterSave.fixRunnerEnabled && afterSave.adminCreditCap === 30, saveOn.message);
    const badCap = await actions.saveSettingsAction({ adminCreditCap: -5 });
    c.ok("an out-of-range value is refused and nothing changes", !badCap.ok && (await photoDeliverySettings()).adminCreditCap === 30, badCap.message);
    await actions.saveSettingsAction({ fixRunnerEnabled: false });
    // Oct 15 2026 (settings audit): the four dead switches are gone. A stored value that still has them reads fine,
    // and the "daily limit on automatic fixes" field saves the cap the fix policy really reads.
    const { getSetting, putSetting } = await import("@/lib/settings");
    const storedNow = await getSetting<Record<string, unknown>>("photo_delivery:settings", {});
    await putSetting("photo_delivery:settings", { ...storedNow, autoFixZeroCredit: true, aryeoTags: true, p3AllPhotos: true, dailyAutoCreditCap: 0 }, "drill");
    const legacy = await photoDeliverySettings();
    c.ok("a stored value with the retired keys still reads, without them", legacy.adminCreditCap === 30 && !("aryeoTags" in legacy) && !("dailyAutoCreditCap" in legacy) && legacy.autoFixDailyMaxCredits === 100 && legacy.paidQcAuto === false);
    const daily = await actions.saveSettingsAction({ autoFixDailyMaxCredits: 40 });
    c.ok("the daily limit saves to autoFixDailyMaxCredits, and saving drops the retired keys", daily.ok && (await photoDeliverySettings()).autoFixDailyMaxCredits === 40 && !("aryeoTags" in (await getSetting<Record<string, unknown>>("photo_delivery:settings", {}))), daily.message);
    await actions.saveSettingsAction({ autoFixDailyMaxCredits: 100 });
    c.ok("the rule picker lists every registry rule", options.length === RULES.length && RULES.length > 400 && options.every((o) => o.id && o.label && o.section), `${options.length} of ${RULES.length}`);

    // =======================================================================
    c.head("6 · static checks");
    // =======================================================================
    const pageFiles = [...filesUnder("src/app/ops/photo-delivery"), ...filesUnder("src/components/photoDelivery"), path.join(REPO, "src/lib/photoDelivery/decisions.ts")];
    const dashed = pageFiles.filter((f) => LONG_DASH.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(REPO, f));
    c.ok(`no em or en dash in any of the ${pageFiles.length} page files`, pageFiles.length >= 5 && dashed.length === 0, dashed.join(", "));
    const actionFiles = filesUnder("src/app/ops/photo-delivery").filter((f) => /^\s*["']use server["']/.test(fs.readFileSync(f, "utf8")));
    c.ok("there is a server action file", actionFiles.length >= 1, actionFiles.map((f) => path.relative(REPO, f)).join(", "));
    const unguarded: string[] = [];
    const bodies = new Map<string, string>();
    for (const f of actionFiles) {
      for (const [name, body] of exportedBodies(fs.readFileSync(f, "utf8"))) {
        bodies.set(name, body);
        if (!/await require(Admin|Owner)\(\)/.test(body)) unguarded.push(`${path.relative(REPO, f)}:${name}`);
      }
    }
    c.ok(`every server action calls a guard (${bodies.size} actions)`, bodies.size >= 10 && unguarded.length === 0, unguarded.join(", "));
    const ownerOnly = ["overrideDeliverAction", "saveSettingsAction", "saveClientProfileAction", "saveThresholdsAction"];
    c.ok("override, settings, profiles and thresholds are owner-only", ownerOnly.every((n) => /await requireOwner\(\)/.test(bodies.get(n) ?? "")), ownerOnly.filter((n) => !/requireOwner/.test(bodies.get(n) ?? "")).join(", "));
    c.ok("the fix approval passes the real role (Kyle's cap applies)", /approveFixBatch\(\{[^}]*role[^}]*\}\)/.test(bodies.get("approveFixesAction") ?? "") && /realRole/.test(fs.readFileSync(actionFiles[0], "utf8")));
    const pages = filesUnder("src/app/ops/photo-delivery").filter((f) => f.endsWith("page.tsx"));
    const unguardedPages = pages.filter((f) => !/requirePageAccess\("ops"\)/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(REPO, f));
    c.ok(`every page checks access (${pages.length} pages)`, pages.length >= 4 && unguardedPages.length === 0, unguardedPages.join(", "));
    const settingsPage = pages.find((f) => f.endsWith(path.join("settings", "page.tsx")));
    c.ok("the settings page is owner-only", !!settingsPage && /isOwner|role !== "OWNER"/.test(fs.readFileSync(settingsPage, "utf8")));

    const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
    c.ok("settings: the fixes choice is labelled and explained, and writes both stored switches", /Only when someone approves/.test(read("src/components/photoDelivery/SettingsForm.tsx")) && /not even one approved in the Fix Cart/.test(read("src/components/photoDelivery/SettingsForm.tsx")) && /fixRunnerEnabled: v\.fixes !== "off"/.test(read("src/components/photoDelivery/SettingsForm.tsx")) && /autoFix: v\.fixes === "auto"/.test(read("src/components/photoDelivery/SettingsForm.tsx")));
    const deliver = read("src/components/photoDelivery/DeliverPanel.tsx");
    c.ok("deliver panel: the replacements list, hidden when empty, with a download per photo", /Replace these on the Aryeo listing/.test(deliver) && /replacements\.length > 0 &&/.test(deliver) && /href=\{r\.downloadUrl\}/.test(deliver));
    const cartSrc = read("src/components/photoDelivery/FixCartPanel.tsx");
    c.ok("fix cart: prices come from the cart (line credits, the balance), never typed in", /l\.credits/.test(cartSrc) && /cart\.balance/.test(cartSrc) && !/credit_cost|\b(autoremove|reedit|declutter)\b[^\n]*\b[0-9]+ ?(cr|credits?)\b/i.test(cartSrc));
    const clientFiles = [...filesUnder("src/components/photoDelivery")].filter((f) => /^\s*["']use client["']/.test(fs.readFileSync(f, "utf8")));
    const leaky = clientFiles.filter((f) => /from "@\/lib\/(prisma|photoDelivery\/(registry|qc|jobState|credits|fixes|delivery|settings))/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(REPO, f));
    c.ok(`no client component imports a server module or the rules JSON (${clientFiles.length} client files)`, clientFiles.length >= 10 && leaky.length === 0, leaky.join(", "));
    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
