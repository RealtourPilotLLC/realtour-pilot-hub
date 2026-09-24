// ---------------------------------------------------------------------------
// DRILL: CP-03 — revision requests are per VIDEO (completion audit, Sep 24 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp03-per-video-revisions.ts
//
// A client reviewing a four-video batch could not send changes on video 2
// because video 1's request had just gone (a per-PROJECT 15-minute throttle);
// notes added to an open request only relabelled PortalComment rows no editor
// ever reads; the receipt was tied to its task and brief by a ±5 s window; the
// portal's brief threw away the cut it knew about, so approving the fix for
// one video could close ANOTHER video's still-open ask.
//
// What it proves, OLD first (the OLD clientDecisions.ts and reviewCuts.ts are
// loaded for real from 9defa7a, their `@/` imports pointed at this tree):
//   0. OLD — video 2 refused behind video 1; added notes reach no brief, no
//      task line, no bell; approving video 2's fix closes video 1's ask; the
//      "Editor working on changes" chip lights every video of the job.
//   1. Four videos back to back: four rounds, four pinned briefs, one task
//      with four labelled lines, a ping to the editor for each.
//   2. A double submit with one request key: one decision, one round, one
//      brief, one overall note, and the socket survives.
//   3. More notes on an open request reach the SAME request, with a ping.
//   4. Each video's fix answers its own round; the job's revision closes only
//      when the last one is answered — in any order.
//   5. The anti-abuse cap is separate: new rounds per hour; addenda pass.
//   6. Routing that fails after the request is recorded is repaired, once.
//   7. The chip and the DONE receipt are per video.
//
// ISOLATION: PGlite on 127.0.0.1:5504 via the shared harness; production is
// never opened, every outbound call is fenced and counted.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5504);
const REPO = path.resolve(__dirname, "../..");
const BASE = "9defa7a";

installNextStubs();
const fence = fenceFetch();

function writeBaseCopies(): { dir: string; clientDecisions: string; reviewCuts: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp03-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const clientDecisions = path.join(dir, "clientDecisions.base.ts");
  fs.writeFileSync(clientDecisions, point(show("src/lib/clientDecisions.ts")));
  const reviewCuts = path.join(dir, "reviewCuts.base.ts");
  fs.writeFileSync(reviewCuts, point(show("src/lib/reviewCuts.ts")));
  return { dir, clientDecisions, reviewCuts };
}
function removeBaseCopies(dir: string) {
  try {
    fs.unlinkSync(path.join(dir, "node_modules"));
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* a leftover temp dir is harmless */ }
}

async function main() {
  const { server, stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const cd = await import("@/lib/clientDecisions");
  const rr = await import("@/app/review/actions");
  const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
  const { streamUrlFor, slotKeyOf, videoLaneRevisionWhere } = await import("@/lib/reviewCuts");
  const { getRevisionBriefs } = await import("@/lib/revisionBrief");
  const base = writeBaseCopies();
  type PortalViewer = import("@/lib/portal").PortalViewer;
  const old = (await import(base.clientDecisions)) as {
    requestChangesOnCut: (v: PortalViewer, s: string, n: string) => Promise<{ ok: boolean; message: string }>;
    cutHistory: (v: PortalViewer, s: string) => Promise<{ submissionId: string; revisionOpen: boolean }[]>;
  };
  const oldCuts = (await import(base.reviewCuts)) as {
    correctedCutApproved: (p: string, o: { cutCreatedAt: Date; round?: number; cut?: { id: string; deliverableId?: string | null; slot?: number | null; assetPath?: string | null } }) => Promise<{ closed: number; resolved: boolean }>;
  };

  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ standardVideo: "kim", premiumVideo: "kim", personalBranding: "kim" }) } });
  await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" } });
  let seq = 0;

  type World = { f: ContentMonthFixture; viewer: PortalViewer; videos: string[] };
  const world = async (name: string, over: Partial<Parameters<typeof buildContentMonth>[1]> = {}): Promise<World> => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, "");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: `${name} TEST`, package: "Accelerator", videosPerMonth: 4, monthKey: "2026-10", owner: { email: `${slug}@example.com`, name }, ...over,
    });
    await ensureOutputsForProject(f.projectId!);
    const videos: string[] = [];
    for (let slot = 1; slot <= 4; slot++) {
      const v = await prisma.contentVideo.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, monthKey: f.monthKey, projectId: f.projectId, deliverableId: f.deliverableId, slot, status: "EDITING", title: `Video ${slot}` }, select: { id: true } });
      videos.push(v.id);
    }
    const enrollment = { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth };
    return { f, videos, viewer: { enrollment, actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: `${slug}@example.com`, name, membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN" } as PortalViewer };
  };
  const mkCut = async (w: World, slot: number, round: number) => {
    const row = await prisma.reviewSubmission.create({
      // Made NOW: a corrected cut is made after the ask it answers, and the
      // per-video close reads exactly that order.
      data: { projectId: w.f.projectId!, deliverableId: w.f.deliverableId, slot, round, status: "PENDING", fileName: `video${slot}-v${round}.mp4`, source: "upload", submittedByKey: "kim", videoId: w.videos[slot - 1], createdAt: new Date(Date.now() + seq++) },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id) } });
    return row.id;
  };
  const release = async (id: string) => {
    const r = await rr.approveCut(id);
    if (!r.ok) throw new Error(`release ${id}: ${r.message}`);
    return r;
  };
  const note = (w: World, sub: string, body: string) =>
    prisma.portalComment.create({ data: { submissionId: sub, projectId: w.f.projectId!, enrollmentId: w.f.enrollmentId, timeSec: 7, body, status: "OPEN", clientUserId: w.f.clientUserId }, select: { id: true } });
  const laneTasks = (projectId: string) => prisma.smartTask.findMany({ where: videoLaneRevisionWhere(projectId, { anyStatus: true }) });

  // =========================================================================
  c.head("0 · OLD (9defa7a): per-project throttle, silent addenda, one video closing another");
  // =========================================================================
  {
    const O = await world("Otto Old");
    const cuts: string[] = [];
    for (let s = 1; s <= 3; s++) { cuts.push(await mkCut(O, s, 1)); await release(cuts[s - 1]); }
    await note(O, cuts[0], "Video 1: tighten the intro");
    const r1 = await old.requestChangesOnCut(O.viewer, cuts[0], "");
    await note(O, cuts[1], "Video 2: swap the music");
    const r2 = await old.requestChangesOnCut(O.viewer, cuts[1], "");
    c.ok("OLD: video 1's request goes", r1.ok, r1.message);
    c.ok("OLD: video 2, a different video, is REFUSED behind it (the per-project throttle)", !r2.ok && /last request/.test(r2.message), r2.message);

    const task0 = (await laneTasks(O.f.projectId!))[0];
    const briefs0 = await prisma.revisionBrief.count({ where: { projectId: O.f.projectId! } });
    const bells0 = await prisma.notification.count({ where: { userKey: "editor:kim" } });
    await note(O, cuts[0], "Video 1: and the logo is too small");
    const add = await old.requestChangesOnCut(O.viewer, cuts[0], "");
    const task1 = (await laneTasks(O.f.projectId!))[0];
    c.ok("OLD: the client is told the new note was added to the request", add.ok && /added to it/.test(add.message), add.message);
    c.ok("OLD: …but no new brief, no line on the editor's task, no bell", (await prisma.revisionBrief.count({ where: { projectId: O.f.projectId! } })) === briefs0 && task1.description === task0.description && (await prisma.notification.count({ where: { userKey: "editor:kim" } })) === bells0);
    const hist3 = await old.cutHistory(O.viewer, cuts[2]);
    c.ok("OLD: video 3 — nobody asked about it — reads 'Editor working on changes'", hist3.find((h) => h.submissionId === cuts[2])?.revisionOpen === true);

    // Two asks more than 15 minutes apart, then the fix for video 2 alone.
    await prisma.revisionBrief.updateMany({ where: { projectId: O.f.projectId! }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    const r2b = await old.requestChangesOnCut(O.viewer, cuts[1], "");
    c.ok("OLD: sixteen minutes later video 2's request goes", r2b.ok, r2b.message);
    const v2fix = await mkCut(O, 2, 2);
    await prisma.reviewSubmission.update({ where: { id: v2fix }, data: { status: "APPROVED", decidedAt: new Date(), decidedBy: "Jordan" } });
    const res = await oldCuts.correctedCutApproved(O.f.projectId!, { cutCreatedAt: new Date(), round: 2, cut: { id: v2fix, deliverableId: O.f.deliverableId, slot: 2 } });
    const open = (await laneTasks(O.f.projectId!)).filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED");
    c.ok("OLD: approving video 2's fix CLOSED the revision — video 1's ask with it, video 1 never re-cut", res.closed > 0 && open.length === 0, JSON.stringify(res));
  }

  // =========================================================================
  c.head("1 · four videos, back to back — four rounds, four pinned briefs, four pings");
  // =========================================================================
  const F = await world("Fay Four");
  const v1: string[] = [];
  const decisions: string[] = [];
  {
    for (let s = 1; s <= 4; s++) { v1.push(await mkCut(F, s, 1)); await release(v1[s - 1]); await note(F, v1[s - 1], `Video ${s}: please change the opening shot`); }
    const results = [];
    for (let s = 1; s <= 4; s++) results.push(await cd.requestChangesOnCut(F.viewer, v1[s - 1], ""));
    c.ok("four ok results, no waiting between them", results.every((r) => r.ok), results.map((r) => r.message.slice(0, 30)).join(" | "));
    const outputs = await prisma.deliverableOutput.findMany({ where: { projectId: F.f.projectId! } });
    let pinned = 0;
    for (let s = 1; s <= 4; s++) {
      const d = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: v1[s - 1], decision: "REQUEST_CHANGES" } });
      decisions.push(d.id);
      const b = d.revisionBriefId ? await prisma.revisionBrief.findUnique({ where: { id: d.revisionBriefId } }) : null;
      const out = outputs.find((o) => o.slot === s);
      const items = b?.itemsJson ? (JSON.parse(b.itemsJson).items as { cuts: string[] }[]) : [];
      const key = slotKeyOf(F.f.deliverableId!, s);
      if (b && b.outputId === out?.id && b.decisionId === d.id && items.length > 0 && items.every((i) => i.cuts.length === 1 && i.cuts[0] === key) && d.receiptState === "ROUTED") pinned++;
    }
    c.ok("4 REQUEST_CHANGES decisions, each with its own brief: that video's output, items scoped to its slot", pinned === 4, String(pinned));
    const tasks = (await laneTasks(F.f.projectId!)).filter((t) => t.status !== "COMPLETED");
    const lines = (tasks[0]?.description ?? "").split("\n").filter((l) => /^\[Video \d/.test(l) || /\[Video \d/.test(l));
    c.ok("ONE video-lane task, on kim", tasks.length === 1 && tasks[0].assignedKey === "kim", `${tasks.length}/${tasks[0]?.assignedKey}`);
    c.ok("  …holding four '[Video n' lines", lines.length === 4 && [1, 2, 3, 4].every((n) => lines.some((l) => l.includes(`[Video ${n} of 4]`))), lines.map((l) => l.slice(0, 22)).join(" | "));
    const rounds = await prisma.contentRevisionRound.findMany({ where: { projectId: F.f.projectId! } });
    c.ok("four ContentRevisionRound rows, ordinal 1, four distinct videos", rounds.length === 4 && rounds.every((r) => r.ordinal === 1) && new Set(rounds.map((r) => r.videoKey)).size === 4);
    let pinged = 0;
    for (const r of rounds) if ((await prisma.notification.count({ where: { userKey: "editor:kim", dedupeKey: { startsWith: `portal-round-${r.id}` } } })) === 1) pinged++;
    c.ok("editor:kim is rung for every one of the four (dedupe portal-round-<id>)", pinged === 4, String(pinged));
    c.ok("getRevisionBriefs(project) returns the 4 briefs", (await getRevisionBriefs(F.f.projectId!, true)).length === 4);
    c.ok("no model was needed: deterministic items, no AI host even tried", !fence.blocked.some((u) => /anthropic|openai/i.test(u)));
  }

  // =========================================================================
  c.head("2 · a double submit is one request");
  // =========================================================================
  {
    const D = await world("Dee Double");
    const d1 = await mkCut(D, 1, 1);
    await release(d1);
    const n1 = await note(D, d1, "cut the pause at 0:07");
    const n2 = await note(D, d1, "brighter end card");
    const key = "rk-11111111-2222-3333-4444-555555555555";
    const rejected0 = server.patchStats.rejected;
    const [a, b] = await Promise.all([
      cd.requestChangesOnCut(D.viewer, d1, "Overall: more energy", { requestKey: key }),
      cd.requestChangesOnCut(D.viewer, d1, "Overall: more energy", { requestKey: key }),
    ]);
    const decs = await prisma.clientDecision.findMany({ where: { submissionId: d1 } });
    c.ok("both calls answer ok (one is the receipt of the other)", a.ok && b.ok, `${a.message} | ${b.message}`);
    c.ok("exactly one decision, one round", decs.length === 1 && (await prisma.contentRevisionRound.count({ where: { submissionId: d1 } })) === 1);
    c.ok("one RevisionBrief with that decision", (await prisma.revisionBrief.count({ where: { decisionId: decs[0].id } })) === 1);
    c.ok("one overall-note comment", (await prisma.portalComment.count({ where: { submissionId: d1, body: "Overall: more energy" } })) === 1);
    const notes = await prisma.portalComment.findMany({ where: { id: { in: [n1.id, n2.id] } } });
    c.ok("each note SENT, once, on that decision", notes.every((n) => n.status === "SENT" && n.decisionId === decs[0].id));
    c.ok("one task on the job", (await laneTasks(D.f.projectId!)).length === 1);
    c.ok("the socket survived (no rejected query)", server.patchStats.rejected === rejected0 && (await prisma.$queryRaw<{ one: number }[]>`SELECT 1 AS one`)[0].one === 1);
    const counts = async () => [await prisma.clientDecision.count(), await prisma.revisionBrief.count(), await prisma.portalComment.count(), await prisma.contentRevisionRound.count(), await prisma.notification.count()].join(",");
    const before = await counts();
    const retry = await cd.requestChangesOnCut(D.viewer, d1, "Overall: more energy", { requestKey: key });
    c.ok("a retry with the same key: duplicate, and no row written anywhere", retry.ok && retry.duplicate === true && (await counts()) === before, `${retry.ok && retry.duplicate} ${before} → ${await counts()}`);
  }

  // =========================================================================
  c.head("3 · more notes on an open request reach the SAME request, and ring");
  // =========================================================================
  {
    const extra = await note(F, v1[1], "Video 2: also the caption is misspelled — 'recieve'");
    const task0 = (await laneTasks(F.f.projectId!))[0];
    await prisma.smartTask.update({ where: { id: task0.id }, data: { status: "IN_PROGRESS" } });
    const r = await cd.requestChangesOnCut(F.viewer, v1[1], "");
    const briefs = await prisma.revisionBrief.findMany({ where: { decisionId: decisions[1] }, orderBy: { createdAt: "asc" } });
    const add = briefs[1];
    const out2 = await prisma.deliverableOutput.findFirstOrThrow({ where: { projectId: F.f.projectId!, slot: 2 } });
    const task1 = (await laneTasks(F.f.projectId!))[0];
    c.ok("duplicate:true, 'your editor has been notified'", r.ok && r.duplicate === true && /editor has been notified/.test(r.message), r.message);
    c.ok("a NEW brief on the same task, decision and output", briefs.length === 2 && add.taskId === task0.id && add.outputId === out2.id);
    c.ok("  …sourceDetail decision:<id>:addendum:1", add?.sourceDetail === `decision:${decisions[1]}:addendum:1`, add?.sourceDetail ?? "null");
    c.ok("the editor's task now carries the new note, and is back to OPEN", (task1.description ?? "").includes("recieve") && task1.status === "OPEN", task1.status);
    c.ok("a portal-addendum bell for editor:kim", (await prisma.notification.count({ where: { userKey: "editor:kim", dedupeKey: { startsWith: `portal-addendum-${decisions[1]}-1` } } })) === 1);
    c.ok("still ONE round for video 2", (await prisma.contentRevisionRound.count({ where: { submissionId: v1[1] } })) === 1);
    c.ok("the note is SENT on the open decision", (await prisma.portalComment.findUniqueOrThrow({ where: { id: extra.id } })).decisionId === decisions[1]);
  }

  // =========================================================================
  c.head("4 · each fix answers its own video; the ask closes with the last one");
  // =========================================================================
  {
    const v2: string[] = [];
    for (let s = 1; s <= 4; s++) v2.push(await mkCut(F, s, 2));
    const round = (s: number) => prisma.contentRevisionRound.findFirstOrThrow({ where: { submissionId: v1[s - 1] } });
    const openLane = async () => (await laneTasks(F.f.projectId!)).filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED").length;
    await release(v2[3]);
    c.ok("video 4's fix FIRST: round 4 ANSWERED", (await round(4)).state === "ANSWERED");
    c.ok("  …and the revision stays open — video 1's ask is untouched (the OLD path closed it)", (await openLane()) === 1 && (await round(1)).state === "OPEN");
    await release(v2[0]);
    const act = await prisma.activity.findFirst({ where: { projectId: F.f.projectId!, body: { startsWith: "Corrected cut approved. The revision stays open" } }, orderBy: { createdAt: "desc" } });
    c.ok("video 1's fix: round 1 ANSWERED, the task stays open", (await round(1)).state === "ANSWERED" && (await openLane()) === 1);
    c.ok("  …and the timeline says video 2's request is still open", !!act && act.body.includes("Video 2 of 4"), act?.body ?? "none");
    await release(v2[1]);
    c.ok("video 2's fix: still open (video 3)", (await openLane()) === 1 && (await round(2)).state === "ANSWERED");
    await release(v2[2]);
    const proj = await prisma.project.findUniqueOrThrow({ where: { id: F.f.projectId! } });
    c.ok("the last video's fix: the task COMPLETED", (await openLane()) === 0 && (await laneTasks(F.f.projectId!)).every((t) => t.status === "COMPLETED"));
    c.ok("  …and resolveRevision ran (the job's revision stamp cleared)", proj.revisionRequestedAt === null);
    c.ok("every round answered by its own video's next version", (await prisma.contentRevisionRound.findMany({ where: { projectId: F.f.projectId! } })).every((r) => r.state === "ANSWERED" && v2.includes(r.answeredBySubmissionId ?? "")));
  }

  // =========================================================================
  c.head("5 · the anti-abuse cap is its own thing: new rounds per hour, addenda pass");
  // =========================================================================
  {
    await prisma.programAutomation.create({ data: { key: "revision_policy", enabled: true, enabledBy: "drill", enabledAt: new Date(Date.now() - 3_600_000), configJson: JSON.stringify({ maxNewRoundsPerHour: 1 }) } });
    const A = await world("Abe Abuse", { videosPerMonth: 1 });
    const cuts: string[] = [];
    for (let s = 1; s <= 3; s++) { cuts.push(await mkCut(A, s, 1)); await release(cuts[s - 1]); await note(A, cuts[s - 1], `note on ${s}`); }
    const r1 = await cd.requestChangesOnCut(A.viewer, cuts[0], "");
    const r2 = await cd.requestChangesOnCut(A.viewer, cuts[1], "");
    const r3 = await cd.requestChangesOnCut(A.viewer, cuts[2], "");
    c.ok("cap = max(1 per hour, videosPerMonth × 2 = 2): rounds 1 and 2 go", r1.ok && r2.ok, `${r1.message} | ${r2.message}`);
    c.ok("the third NEW round within the hour is refused", !r3.ok && /last hour/.test(r3.message), r3.message);
    c.ok("  …its note stays OPEN, its window stays OPEN", (await prisma.portalComment.findFirstOrThrow({ where: { submissionId: cuts[2] } })).status === "OPEN" && (await prisma.contentReviewWindow.findUniqueOrThrow({ where: { submissionId: cuts[2] } })).state === "OPEN");
    await note(A, cuts[0], "one more on video 1");
    const add = await cd.requestChangesOnCut(A.viewer, cuts[0], "");
    c.ok("an addendum on an already-routed video still succeeds", add.ok && /editor has been notified/.test(add.message), add.message);
    await prisma.programAutomation.delete({ where: { key: "revision_policy" } });
  }

  // =========================================================================
  c.head("6 · routing that fails after the request is recorded is repaired, once");
  // =========================================================================
  {
    const R = await world("Ray Repair");
    const r1 = await mkCut(R, 1, 1);
    await release(r1);
    await note(R, r1, "fix the colour");
    // THE EDITOR LANE GOES DOWN ONCE. raiseRevisionDetailed writes the job's
    // timeline line unguarded, so a trigger that refuses the FIRST Activity
    // insert on this job makes it throw — once: nextval() does not roll back
    // with the failed statement, so the second attempt goes through.
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE drill_lane_down`);
    await prisma.$executeRawUnsafe(`CREATE FUNCTION drill_lane_down() RETURNS trigger AS $$ BEGIN IF NEW."projectId" = '${R.f.projectId}' AND nextval('drill_lane_down') = 1 THEN RAISE EXCEPTION 'drill: the editor lane is down'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER drill_lane_down BEFORE INSERT ON "Activity" FOR EACH ROW EXECUTE FUNCTION drill_lane_down()`);
    const r = await cd.requestChangesOnCut(R.viewer, r1, "");
    const d = await prisma.clientDecision.findFirstOrThrow({ where: { submissionId: r1 } });
    c.ok("the client is told it was received", r.ok && /Received/.test(r.message), r.message);
    c.ok("  …the decision stays RECEIVED with no brief, the round is recorded", d.receiptState === "RECEIVED" && !d.revisionBriefId && (await prisma.contentRevisionRound.count({ where: { decisionId: d.id } })) === 1);
    const soon = await cd.repairPortalRevisionRequests({ now: new Date(Date.now() + 30_000) });
    c.ok("the repair waits two minutes before touching it", soon.routed === 0);
    const rep = await cd.repairPortalRevisionRequests({ now: new Date(Date.now() + 3 * 60_000) });
    const d2 = await prisma.clientDecision.findUniqueOrThrow({ where: { id: d.id } });
    c.ok("the repair routes it: ROUTED, with its pinned brief and task", rep.routed === 1 && d2.receiptState === "ROUTED" && !!d2.revisionBriefId && !!d2.revisionTaskId, JSON.stringify(rep));
    const again = await cd.repairPortalRevisionRequests({ now: new Date(Date.now() + 6 * 60_000) });
    c.ok("a second repair run is a no-op", again.routed === 0 && (await prisma.revisionBrief.count({ where: { decisionId: d.id } })) === 1, JSON.stringify(again));
  }

  // =========================================================================
  c.head("7 · the chip and the DONE receipt are per video");
  // =========================================================================
  {
    const S = await world("Sue Scope");
    const cuts: string[] = [];
    for (let s = 1; s <= 3; s++) { cuts.push(await mkCut(S, s, 1)); await release(cuts[s - 1]); }
    await note(S, cuts[0], "video 1 only");
    await cd.requestChangesOnCut(S.viewer, cuts[0], "");
    const h3 = await cd.cutHistory(S.viewer, cuts[2]);
    const h1 = await cd.cutHistory(S.viewer, cuts[0]);
    c.ok("cut 3 (nobody asked): revisionOpen false", h3.find((h) => h.isCurrent)?.revisionOpen === false);
    c.ok("cut 1 (asked): revisionOpen true", h1.find((h) => h.isCurrent)?.revisionOpen === true);
    const oldH3 = await old.cutHistory(S.viewer, cuts[2]);
    c.ok("  (OLD read cut 3 as 'Editor working on changes')", oldH3.find((h) => h.submissionId === cuts[2])?.revisionOpen === true);
    // Video 2 gets its own open request, so the JOB keeps an open revision task.
    await note(S, cuts[1], "video 2 too");
    await cd.requestChangesOnCut(S.viewer, cuts[1], "");
    const fix1 = await mkCut(S, 1, 2);
    await release(fix1);
    const hist = await cd.cutHistory(S.viewer, fix1);
    const oldRound = hist.find((h) => h.submissionId === cuts[0]);
    const req = oldRound?.decisions.find((x) => x.decision === "REQUEST_CHANGES");
    c.ok("cut 1's receipt is DONE once its round is answered — with video 2's task still open", req?.receiptState === "DONE" && (await laneTasks(S.f.projectId!)).some((t) => t.status !== "COMPLETED"), req?.receiptState);
  }

  c.head("isolation");
  c.ok("nothing left the machine", fence.faked.length === 0, `blocked ${fence.blocked.length}: ${[...new Set(fence.blocked.map((u) => u.replace(/^(\w+:\/\/[^/]+).*/, "$1")))].join(", ")}`);
  console.log(`  (prisma error lines swallowed: ${quiet.count})`);

  c.summary();
  quiet.restore();
  removeBaseCopies(base.dir);
  await stop();
}

main().catch(async (e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(() => {
  fence.restore();
  process.exit(process.exitCode ?? 0);
});
