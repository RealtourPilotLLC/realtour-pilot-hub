// ---------------------------------------------------------------------------
// DRILL ASSET-DEPENDENCY: a file the work cannot start without (§10
// assets/special corrections — J3). Unified handoff, batch 5, Sep 26 2026.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   PATH=/Users/jordanspackman/.nvm/versions/node/v20.20.2/bin:$PATH \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/asset-dependency.ts
//
// Drives the SHIPPED code against an isolated PGlite on 127.0.0.1:5790 (or
// DRILL_PORT), and tasks.ts / projectBrief.ts / revisionBrief.ts as they were
// at 17df024 (never HEAD) for the old behaviour. Production is never opened;
// every outbound call is fenced; the model is intercepted — it answers with
// nothing and the prompt it was handed is kept for §5.
//
//   §0  old code (17df024): a Lot Lines order made no task and the brief
//       named nothing in the way
//   §1  a dependency on video 2 appears in video 2's brief only
//   §2  the hourly sweep: Lot Lines → find-the-plat (Kyle) and draw-from-it
//       (Jordan, blocked on the file) — two tasks, deduped on a rerun
//   §3  attaching the file closes retrieval ONLY and unblocks the drawing;
//       a retrieval closed from the task board releases it too
//   §4  the line comes off the order: the system's pair goes; a person's stays
//   §5  the revision prompt forbids stating property facts (old prompt did not)
//   §6  nothing client-facing; fences
//
// THE CLOCK IS PINNED to Saturday Sep 26 2026, 7:30 PM ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5790);
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");

const RealDate = Date;
const PARK = RealDate.UTC(2026, 8, 26, 23, 30, 0); // Sat Sep 26 2026 19:30 EDT
const clockOffsetMs = PARK - RealDate.now();
const drillNow = () => RealDate.now() + clockOffsetMs;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(drillNow());
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return drillNow;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

installNextStubs();

// The model boundary: every prompt is kept; the answer is an empty work order.
const prompts: { system: string; prompt: string }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJson") return t[k];
      return async (o: { system?: string; prompt?: string }) => {
        prompts.push({ system: o.system ?? "", prompt: o.prompt ?? "" });
        return { headline: "Lot lines on the aerial", items: [], keep: [], references: [], questions: [] };
      };
    },
  }),
);
const fence = fenceFetch();

const BASE_DIR = path.join(REPO, "node_modules/.cache", `asset-baseline-${BASE}`);
function baseline(rel: string): string {
  const src = execFileSync("git", ["show", `${BASE}:${rel}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 << 20 });
  fs.mkdirSync(BASE_DIR, { recursive: true });
  const out = path.join(BASE_DIR, rel.replace(/[/[\]]/g, "_"));
  fs.writeFileSync(out, src.replace(/(["'])@\//g, `$1${REPO}/src/`));
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { etAt } = await import("@/lib/datetime");
  const { putSetting } = await import("@/lib/settings");
  const deps = await import("@/lib/assetDependencies");
  const { generateTasksForProject } = await import("@/lib/tasks");
  const { projectBrief } = await import("@/lib/projectBrief");
  const { analyzeRevisionText } = await import("@/lib/revisionBrief");
  const { ensureOutputsSafely } = await import("@/lib/deliverableOutputs");
  const oldTasks = (await import(baseline("src/lib/tasks.ts"))) as typeof import("@/lib/tasks");
  const oldBrief = (await import(baseline("src/lib/projectBrief.ts"))) as typeof import("@/lib/projectBrief");
  const oldRevision = (await import(baseline("src/lib/revisionBrief.ts"))) as typeof import("@/lib/revisionBrief");

  const et = (month: number, day: number, hour: number, minute = 0) =>
    etAt(`2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, hour, minute);
  const ASSET_TYPES = ["asset_dependency", "asset_interpretation"];

  // ---- the world -----------------------------------------------------------
  const client = await prisma.client.create({ data: { name: "Drill Agent", phone: "+15555550100" }, select: { id: true } });
  const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Cabrera", email: "kyle-tm@drill.invalid", role: "MANAGER" }, select: { id: true } });
  const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", email: "jordan-tm@drill.invalid", role: "PHOTOGRAPHER" }, select: { id: true } });
  const johnTm = await prisma.teamMember.create({ data: { name: "John Mark", email: "john@drill.invalid", role: "EDITOR" }, select: { id: true } });
  await putSetting("review_room", { creativeApproverTeamMemberId: null, backupReviewerTeamMemberId: kyleTm.id, fallbackReviewerTeamMemberId: jordanTm.id });

  // A two-video job (for §1) and a Lot Lines job (for §2-§4).
  const reels = await prisma.project.create({
    data: {
      title: "1 Ash St, Royersford, PA", clientId: client.id, status: "SHOT", aryeoOrderId: "drill-asset-1",
      shootDate: et(9, 24, 10), photographerId: harrison.id, editorId: johnTm.id, editorManual: true,
      deliveryDue: et(9, 29, 12), promisedDueAt: et(9, 29, 12),
      statusEvidence: JSON.stringify({ present: ["Photos"], missing: ["Video"], dropbox: { rawVideo: 12, rawPhotos: 40, finalVideo: 0 } }),
    },
    select: { id: true },
  });
  await prisma.orderItem.create({ data: { projectId: reels.id, title: "Standard Social Reel", quantity: 2 } });
  await prisma.deliverable.create({ data: { projectId: reels.id, type: "SOCIAL_REEL", label: "Standard Reel", quantity: 2, status: "UPLOADED", uploadedAt: new Date() } });
  await ensureOutputsSafely(reels.id, "drill");
  const outs = await prisma.deliverableOutput.findMany({ where: { projectId: reels.id }, orderBy: { slot: "asc" }, select: { id: true, slot: true } });

  const lot = await prisma.project.create({
    data: {
      title: "8 Hazel St, Royersford, PA", clientId: client.id, status: "SCHEDULED", aryeoOrderId: "drill-asset-2",
      shootDate: et(9, 30, 10), photographerId: harrison.id, addressLine: "8 Hazel St",
    },
    select: { id: true },
  });
  await prisma.orderItem.create({ data: { projectId: lot.id, title: "Drone Photography" } });
  const lotLine = await prisma.orderItem.create({ data: { projectId: lot.id, title: "Lot Lines" }, select: { id: true } });
  await prisma.deliverable.create({ data: { projectId: lot.id, type: "DRONE", label: "Drone Photos", quantity: 1 } });
  await prisma.deliverable.create({ data: { projectId: lot.id, type: "OTHER", label: "Lot Lines", productTitle: "Lot Lines", quantity: 1 } });
  const assetTasks = (projectId: string) =>
    prisma.smartTask.findMany({ where: { projectId, taskType: { in: ASSET_TYPES } }, orderBy: { taskType: "asc" }, select: { id: true, taskType: true, status: true, assignedKey: true, ownerId: true, outputId: true, deliverableType: true, blockedReason: true, sourceDetail: true, dedupeKey: true, source: true } });

  // =========================================================================
  c.head(`§0 · old code (${BASE}): a Lot Lines order made no task, and the brief named nothing`);
  // =========================================================================
  {
    await oldTasks.generateTasksForProject(lot.id);
    c.ok("the old hourly sweep made no find-the-file or draw-from-it task", (await assetTasks(lot.id)).length === 0);
    const ob = await oldBrief.projectBrief(lot.id);
    c.ok("…and the old brief had no line for it", !!ob && !/plat|survey|lot line/i.test(`${ob.blocker ?? ""} ${ob.nextAction}`), `${ob?.blocker} · ${ob?.nextAction}`);
  }

  // =========================================================================
  c.head("§1 · a dependency on video 2 appears in video 2's brief only");
  // =========================================================================
  {
    c.ok("the job owes two videos, as two outputs", outs.length === 2, String(outs.length));
    const r = await deps.recordAssetDependency({ projectId: reels.id, outputId: outs[1].id, slug: "client-logo", need: "the client's logo file", by: "Kyle Cabrera" });
    const tasks = await assetTasks(reels.id);
    c.ok("one find-the-file task, on Kyle, tied to video 2 (outputId)", r.ok && tasks.length === 1 && tasks[0].assignedKey === "kyle" && tasks[0].ownerId === kyleTm.id && tasks[0].outputId === outs[1].id && tasks[0].source === "manual", r.message);
    const brief = await projectBrief(reels.id);
    const v2 = deps.dependenciesForOutput(brief?.assetNeeds ?? [], outs[1].id);
    const v1 = deps.dependenciesForOutput(brief?.assetNeeds ?? [], outs[0].id);
    c.ok("video 2's brief lists it; video 1's does not", v2.length === 1 && /Waiting on the client's logo file \(Kyle to find it\)/.test(v2[0].sentence) && v1.length === 0, v2[0]?.sentence);
    const bad = await deps.recordAssetDependency({ projectId: reels.id, outputId: "not-an-output", slug: "x", need: "y", by: "Kyle" });
    c.ok("a video from another job is refused", !bad.ok && /isn't on this job/.test(bad.message));
  }

  // =========================================================================
  c.head("§2 · the hourly sweep: Lot Lines → two tasks, deduped on a rerun");
  // =========================================================================
  let retrievalId = "";
  {
    await generateTasksForProject(lot.id);
    const t = await assetTasks(lot.id);
    const retrieval = t.find((x) => x.taskType === "asset_dependency");
    const interpretation = t.find((x) => x.taskType === "asset_interpretation");
    retrievalId = retrieval?.id ?? "";
    c.ok("retrieval: OPEN, Kyle's, on the OTHER category, no single video", retrieval?.status === "OPEN" && retrieval.assignedKey === "kyle" && retrieval.deliverableType === "OTHER" && retrieval.outputId === null && retrieval.source === "system");
    c.ok("interpretation: a separate task, Jordan's, BLOCKED naming the missing reference",
      interpretation?.status === "BLOCKED" && interpretation.assignedKey === "jordan" && interpretation.ownerId === jordanTm.id && interpretation.blockedReason === "Waiting on the recorded plat or survey for the lot lines",
      interpretation?.blockedReason ?? "");
    await generateTasksForProject(lot.id);
    await generateTasksForProject(lot.id);
    c.ok("two more sweeps: still exactly two", (await assetTasks(lot.id)).length === 2);
    const brief = await projectBrief(lot.id);
    c.ok("the job's brief says what is in the way — the missing file, never a description of the boundary", /Waiting on the recorded plat or survey for the lot lines \(Kyle to find it\)/.test(brief?.blocker ?? "") && !/feet|acre|north|south|east|west/i.test(brief?.blocker ?? ""), brief?.blocker ?? "");
    const tl = await prisma.activity.findMany({ where: { projectId: lot.id }, select: { body: true } });
    c.ok("one timeline line for the pair", tl.filter((a) => /Needs the recorded plat/.test(a.body)).length === 1);
  }

  // =========================================================================
  c.head("§3 · attaching the file closes retrieval only");
  // =========================================================================
  {
    const none = await deps.attachAssetReference(retrievalId, "  ", "Kyle Cabrera");
    c.ok("an empty reference is refused", !none.ok);
    const r = await deps.attachAssetReference(retrievalId, "https://www.dropbox.com/drill/8-hazel-plat.pdf", "Kyle Cabrera");
    const t = await assetTasks(lot.id);
    const retrieval = t.find((x) => x.taskType === "asset_dependency");
    const interpretation = t.find((x) => x.taskType === "asset_interpretation");
    c.ok("retrieval COMPLETED with the reference kept", r.ok && retrieval?.status === "COMPLETED" && retrieval.sourceDetail === "https://www.dropbox.com/drill/8-hazel-plat.pdf", r.message);
    c.ok("interpretation is still open work — unblocked, not closed, and carries the file", interpretation?.status === "OPEN" && interpretation.blockedReason === null && interpretation.sourceDetail === "https://www.dropbox.com/drill/8-hazel-plat.pdf");
    const again = await deps.attachAssetReference(retrievalId, "https://www.dropbox.com/drill/other.pdf", "Kyle Cabrera");
    c.ok("a second press attaches once", again.ok && again.message === "Already attached." && (await prisma.smartTask.findUnique({ where: { id: retrievalId } }))?.sourceDetail === "https://www.dropbox.com/drill/8-hazel-plat.pdf");
    const brief = await projectBrief(lot.id);
    c.ok("the brief now names the drawing, from the attached file only", /Draw the lot lines from the attached plat or survey \(Jordan\) — from the attached file only/.test(brief?.blocker ?? ""), brief?.blocker ?? "");

    // A retrieval closed some other way (the task board's Done) releases too.
    await deps.recordAssetDependency({ projectId: lot.id, category: "OTHER", slug: "hoa-map", need: "the HOA's common-area map", interpretation: { what: "Mark the common areas from the attached map" }, by: "Kyle Cabrera" });
    const hoa = (await assetTasks(lot.id)).filter((x) => x.dedupeKey?.includes("hoa-map"));
    await prisma.smartTask.update({ where: { id: hoa.find((x) => x.taskType === "asset_dependency")!.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await generateTasksForProject(lot.id);
    const hoaAfter = (await assetTasks(lot.id)).find((x) => x.dedupeKey?.endsWith("hoa-map:interpret"));
    c.ok("a retrieval ticked Done on the board: the next sweep unblocks its interpretation", hoaAfter?.status === "OPEN" && hoaAfter.blockedReason === null);
  }

  // =========================================================================
  c.head("§3b · the office's two presses (server actions), editors refused");
  // =========================================================================
  {
    const { setSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/editing/actions");
    const kyleU = await prisma.appUser.create({ data: { email: "kyle@drill.invalid", name: "Kyle Cabrera", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id }, select: { id: true, email: true, name: true, role: true } });
    const johnU = await prisma.appUser.create({ data: { email: "john@drill.invalid", name: "John Mark", role: "EDITOR", status: "ACTIVE", teamMemberId: johnTm.id, editorKey: "john" }, select: { id: true, email: true, name: true, role: true } });
    await setSession({ uid: johnU.id, email: johnU.email, role: johnU.role, name: johnU.name ?? undefined });
    const refused = await actions.recordAssetDependencyAction({ projectId: reels.id, outputId: outs[0].id, slug: "brand-font", need: "the client's brand font" });
    c.ok("an editor cannot record one", !refused.ok && (await assetTasks(reels.id)).length === 1);
    await setSession({ uid: kyleU.id, email: kyleU.email, role: kyleU.role, name: kyleU.name ?? undefined });
    const rec = await actions.recordAssetDependencyAction({ projectId: reels.id, outputId: outs[0].id, slug: "brand-font", need: "the client's brand font" });
    const font = (await assetTasks(reels.id)).find((t) => t.dedupeKey?.includes("brand-font"));
    c.ok("Kyle records video 1's font through the action; it is tied to video 1", rec.ok && font?.outputId === outs[0].id && font.source === "manual", rec.message);
    const att = await actions.attachAssetReferenceAction(font!.id, "https://www.dropbox.com/drill/font.zip");
    c.ok("…and attaches it through the action", att.ok && (await prisma.smartTask.findUnique({ where: { id: font!.id } }))?.status === "COMPLETED");
  }

  // =========================================================================
  c.head("§4 · the line comes off the order");
  // =========================================================================
  {
    // Reset the lot-lines pair to open so the retirement is visible.
    await prisma.smartTask.updateMany({ where: { projectId: lot.id, dedupeKey: { contains: "lot-lines-plat" } }, data: { status: "OPEN", completedAt: null } });
    await prisma.orderItem.update({ where: { id: lotLine.id }, data: { isCanceled: true } });
    await generateTasksForProject(lot.id);
    const t = await assetTasks(lot.id);
    c.ok("the system's lot-lines pair is cancelled with the reason", t.filter((x) => x.dedupeKey?.includes("lot-lines-plat")).every((x) => x.status === "CANCELLED"));
    c.ok("the dependency a person recorded (the HOA map) is theirs, and stays", t.filter((x) => x.dedupeKey?.includes("hoa-map")).some((x) => x.status === "OPEN"));
  }

  // =========================================================================
  c.head("§5 · the revision prompt forbids stating property facts");
  // =========================================================================
  {
    const ask = { text: "Can you add the lot lines on the drone shot? The property goes back to the tree line I think.", twoSided: false, propertyAddress: "8 Hazel St" };
    await oldRevision.analyzeRevisionText(ask);
    await analyzeRevisionText(ask);
    const [oldP, newP] = prompts.slice(-2);
    c.ok(`old (${BASE}): the prompt had no rule about property lines`, !!oldP && !/NEVER STATE PROPERTY FACTS/.test(oldP.system) && !/plat or survey/i.test(oldP.system));
    c.ok("new: rule 11 — boundaries only from a plat or survey the client supplies, never estimated", !!newP && /11\. NEVER STATE PROPERTY FACTS/.test(newP.system) && /Never state, estimate or describe where a boundary runs/.test(newP.system));
  }

  // =========================================================================
  c.head("§6 · nothing client-facing; fences");
  // =========================================================================
  c.ok("no text queued, no bell to anybody about a dependency", (await prisma.pendingSms.count()) === 0 && (await prisma.notification.count({ where: { OR: [{ title: { contains: "plat" } }, { title: { contains: "logo" } }] } })) === 0);
  c.ok("no outbound call left the building", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
