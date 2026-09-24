// ---------------------------------------------------------------------------
// DRILL: CP-09 — the photographer's filmed topics survive, land once, and bind
// to the editor's owed-video slots (completion audit, Sep 24 2026; batch A).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/cp09-filming-handoff.ts
//
// What it proves, OLD behaviour first wherever it can be observed:
//
//   1. OLD — the real finalizeUpload as of 9defa7a (loaded byte for byte from
//      git), with every ContentVideo insert refused: the submit succeeds, and
//      NOTHING anywhere holds the ticks. No row, no retry, no flag.
//   2. NEW — the same submit: it still succeeds, says `topicsPending`, and the
//      ticks, the note and the on-site extra are on file in ContentFilmingReport
//      (FAILED, attempt 1), with ONE flag on the job.
//   3. The block lifts; the hourly sweep (after the backoff, not before) applies
//      it: topics PROGRAM with the real session's date, the extra created once
//      as an overflow EXTRA, one capacity-review task, nothing sent anywhere.
//   4. Idempotent: a second sweep and an identical re-submit change nothing; a
//      different answer is a new report.
//   5. Binding: slots 1..3 carry t1, t2 and the extra with the photographer's
//      notes; the editor's labels are the topic titles and follow a rename;
//      routing still sends the monthly row to Kim; no Deliverable is made.
//   6. The library: the first cut on slot 1 attaches to t1's own video.
//   7. Races: two applies of one report claim it once; two reports on one job
//      make one video per topic; a dead lease is picked up, a live one is not.
//   8. OLD vs NEW — a Pro month with session 2 booked next week: dated session 2
//      (the future) before, session 1 now; an overflow tick counted toward the
//      allowance before, EXTRA now.
//   9. OLD vs NEW — a legacy month topic and a second session in the month.
//  10. Six failures stop the retries and put it in front of Kyle.
//  11. The real GET /api/cron/sync applies a due report, before contentLibrary.
//
// ISOLATION. PGlite on 127.0.0.1:5502 (DRILL_PORT overrides) through the shared
// harness; production is never opened. Every non-loopback call is fenced. Faults
// are a plpgsql RAISE (P0001), never a unique collision.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth, type ContentMonthFixture } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5502);
const REPO = path.resolve(__dirname, "../..");
/** The commit before CP-09: what the audit measured. */
const BASE = "9defa7a";

installNextStubs();
const fence = fenceFetch();

/**
 * The OLD code, loaded for real: filmedTopics.ts and upload/actions.ts as they
 * were at BASE, written to a temp dir with their `@/` imports pointed at this
 * tree (so everything they call is the same module the new code calls — one
 * Prisma client, one database), and the old actions pointed at the OLD
 * filmedTopics. node_modules is symlinked in so bare imports resolve.
 */
function writeBaseCopies(): { dir: string; filmedTopics: string; actions: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cp09-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
  const point = (src: string, special: Record<string, string>) =>
    src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${special[p] ?? path.join(REPO, "src", p)}${q}`);
  const filmedTopics = path.join(dir, "filmedTopics.base.ts");
  fs.writeFileSync(filmedTopics, point(show("src/lib/filmedTopics.ts"), {}));
  const actions = path.join(dir, "uploadActions.base.ts");
  fs.writeFileSync(actions, point(show("src/app/upload/actions.ts"), { "lib/filmedTopics": filmedTopics.replace(/\.ts$/, "") }));
  return { dir, filmedTopics, actions };
}

/** The temp copies go when the drill does — the symlink first, so nothing can follow it. */
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
  const base = writeBaseCopies();
  type BaseFT = {
    topicsForSession: (id: string) => Promise<{ topics: { topicId: string; filmedConfirmedAtISO: string | null }[] } | null>;
    confirmFilmedTopics: (projectId: string, ids: string[], by: string, opts?: { now?: Date }) => Promise<{ confirmed: number; filmedAtISO: string | null }>;
  };
  const oldFT = (await import(base.filmedTopics)) as BaseFT;
  const oldActions = (await import(base.actions)) as { finalizeUpload: (id: string, data: unknown) => Promise<Record<string, unknown>> };
  const ft = await import("@/lib/filmedTopics");
  const { finalizeUpload } = await import("@/app/upload/actions");
  const { outputsForProject } = await import("@/lib/deliverableOutputs");
  const { mintEditTask } = await import("@/lib/tasks");
  const { establishSession } = await import("@/lib/auth/session");
  const { syncEnrollmentVideos } = await import("@/lib/contentVideos");

  // ---- the world every section shares -----------------------------------
  await prisma.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ personalBranding: "kim" }) } });
  const kyle = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-drill@example.com" }, select: { id: true } });
  const harrison = await prisma.appUser.create({ data: { email: "harrison-drill@example.com", name: "Harrison", role: "PHOTOGRAPHER", status: "ACTIVE" }, select: { id: true } });
  await establishSession(harrison.id); // the stubbed cookie jar now carries his session
  const HOUR = 3_600_000;
  const A1 = new Date(Math.floor((Date.now() - 26 * HOUR) / 60_000) * 60_000); // yesterday, 2h session
  const A1_END = new Date(A1.getTime() + 120 * 60_000);
  const NEXT_WEEK = new Date(A1.getTime() + 8 * 24 * HOUR);

  const month = (name: string, over: Partial<Parameters<typeof buildContentMonth>[1]> = {}) =>
    buildContentMonth(prisma, {
      name: `${name} TEST`,
      package: "Starter",
      videosPerMonth: 3,
      owner: false,
      appointments: [{ startAt: A1 }],
      topics: [
        { title: `${name}: pricing in week one`, selection: "SELECTED" },
        { title: `${name}: the inspection talk`, selection: "SELECTED" },
        { title: `${name}: staging on a budget`, selection: "SELECTED" },
      ],
      ...over,
    });
  const script = async (f: ContentMonthFixture, i: number, approved: boolean) => {
    const sc = await prisma.contentScript.create({
      data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: f.topicIds[i], title: `Script ${i + 1}`, body: "body", status: "APPROVED", releaseState: "released" },
      select: { id: true },
    });
    const v = await prisma.contentScriptVersion.create({
      data: { scriptId: sc.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, title: `Script ${i + 1}`, hook: "h", pointsJson: "[]", close: "c", body: "b", source: "AI", status: "SHARED" },
      select: { id: true },
    });
    await prisma.contentScript.update({
      where: { id: sc.id },
      data: { sharedVersionId: v.id, sharedAt: new Date(), ...(approved ? { clientApprovedVersionId: v.id, clientApprovedAt: new Date() } : {}) },
    });
    if (approved) {
      await prisma.contentScriptRelease.create({
        data: { scriptId: sc.id, scriptVersionId: v.id, enrollmentId: f.enrollmentId, clientId: f.clientId, action: "CLIENT_APPROVED", actorEmail: "client@example.com" },
      });
    }
    return { scriptId: sc.id, versionId: v.id };
  };
  const block = async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION cp09_refuse() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'drill: ContentVideo insert refused'; END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER cp09_refuse BEFORE INSERT ON "ContentVideo" FOR EACH ROW EXECUTE FUNCTION cp09_refuse()`);
  };
  const unblock = () => prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS cp09_refuse ON "ContentVideo"`);
  const EXTRA_TITLE = "Open-house mistakes";
  const submitFor = (f: ContentMonthFixture, notes: Record<string, string> = { [f.topicIds[0]]: "drone opener" }) => ({
    editorBrief: "x",
    force: true,
    cullingConfirmed: true,
    videoInstructions: "VISION FOR THE EDIT\nfast cuts",
    filmedTopicIds: [f.topicIds[0], f.topicIds[1]],
    topicNotes: notes,
    extraTopics: [{ key: "k1", title: EXTRA_TITLE, note: "kitchen" }],
  });
  const filmingFlags = (projectId: string) => prisma.activity.count({ where: { projectId, type: "FLAG", body: { startsWith: "Filmed topics" } } });
  const reportFor = (f: ContentMonthFixture, payload: { filmedTopicIds: string[]; topicNotes?: Record<string, string>; extraTopics?: unknown }) =>
    ft.prepareFilmingReport(f.projectId!, payload, { name: "Harrison", email: "harrison-drill@example.com" }).then(async (prep) => {
      await prisma.contentFilmingReport.createMany({ data: [prep!.row], skipDuplicates: true });
      return (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { projectId_payloadHash: { projectId: f.projectId!, payloadHash: prep!.payloadHash } } })).id;
    });

  // =========================================================================
  c.head("1 · OLD (9defa7a): a confirmation write fails after the footage submit");
  // =========================================================================
  const f0 = await month("Old Submit");
  await block();
  let oldRes: Record<string, unknown> | null = null;
  let oldThrew: unknown = null;
  try {
    oldRes = await oldActions.finalizeUpload(f0.projectId!, submitFor(f0));
  } catch (e) {
    oldThrew = e;
  }
  c.ok("the old submit resolves — the photographer is told it worked", !oldThrew && !!oldRes && !oldRes.blocked, String(oldThrew ?? JSON.stringify(oldRes)));
  c.ok("…and says nothing about the topics", !!oldRes && !("topicsPending" in oldRes));
  const p0 = await prisma.project.findUniqueOrThrow({ where: { id: f0.projectId! }, select: { debriefSubmittedAt: true } });
  c.ok("the debrief itself was written", !!p0.debriefSubmittedAt);
  c.ok("OLD: no video row holds the ticks", (await prisma.contentVideo.count({ where: { enrollmentId: f0.enrollmentId } })) === 0);
  c.ok("OLD: and no other row does either — nothing any sweep could retry from", (await prisma.contentFilmingReport.count({ where: { projectId: f0.projectId! } })) === 0);
  c.ok("OLD: no topic was marked filmed and nobody was told", (await prisma.contentTopicEvent.count({ where: { topicId: { in: f0.topicIds }, kind: "FILMED" } })) === 0 && (await prisma.activity.count({ where: { projectId: f0.projectId!, type: "FLAG" } })) === 0);

  // =========================================================================
  c.head("2 · NEW: the same failure — the submit succeeds and the answer is kept");
  // =========================================================================
  const f1 = await month("New Submit");
  const s1 = await script(f1, 0, true);
  const s2 = await script(f1, 1, false);
  const [t1, t2] = f1.topicIds;
  const outBefore = fence.blocked.length;
  const res1 = await finalizeUpload(f1.projectId!, submitFor(f1));
  c.ok("the submit resolves, not blocked", !res1.blocked && !res1.needsConfirm, JSON.stringify(res1).slice(0, 160));
  c.ok("…and says the topics are pending, in words", !!res1.topicsPending && res1.topicsPending.count === 3 && /retries on its own/.test(res1.topicsPending.message), JSON.stringify(res1.topicsPending));
  const p1 = await prisma.project.findUniqueOrThrow({ where: { id: f1.projectId! }, select: { debriefSubmittedAt: true, videosFilmed: true, status: true } });
  c.ok("the debrief was written and the job moved on", !!p1.debriefSubmittedAt && p1.status === "SHOT", p1.status);
  c.ok("videosFilmed is the server's count: 2 ticks + 1 extra", p1.videosFilmed === 3, String(p1.videosFilmed));
  const r1rows = await prisma.contentFilmingReport.findMany({ where: { projectId: f1.projectId! } });
  const r1 = r1rows[0];
  c.ok("exactly one ContentFilmingReport", r1rows.length === 1);
  c.ok("…FAILED after one attempt, with a retry time and the error", r1?.state === "FAILED" && r1.attempts === 1 && !!r1.nextAttemptAt && /refused/.test(r1.lastError ?? ""), `${r1?.state}/${r1?.attempts} ${r1?.lastError?.slice(0, 60)}`);
  c.ok("…holding exactly the ticks", JSON.stringify([...JSON.parse(r1.topicIdsJson)].sort()) === JSON.stringify([t1, t2].sort()));
  const extras1 = JSON.parse(r1.extrasJson ?? "[]") as { key: string; title: string; note: string }[];
  c.ok("…the on-site extra, with its note", extras1.length === 1 && extras1[0].title === EXTRA_TITLE && extras1[0].note === "kitchen", r1.extrasJson ?? "");
  c.ok("…and the note on t1", JSON.parse(r1.notesJson ?? "{}")[t1] === "drone opener");
  c.ok("…and who said it (the email, not just the name)", r1.submittedByEmail === "harrison-drill@example.com" && r1.submittedBy === "Harrison", `${r1.submittedBy} <${r1.submittedByEmail}>`);
  c.ok("…and which leg was filmed", r1.appointmentId === (await prisma.appointment.findUniqueOrThrow({ where: { id: f1.appointmentIds[0] } })).aryeoId);
  c.ok("no video row yet — the insert really was refused", (await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } })) === 0);
  c.ok("ONE flag on the job", (await filmingFlags(f1.projectId!)) === 1);

  // =========================================================================
  c.head("3 · the block lifts; the hourly sweep lands it — after the backoff");
  // =========================================================================
  await unblock();
  const early = await ft.sweepFilmingReports({ now: new Date(Date.now() + 10 * 60_000) });
  c.ok("ten minutes later the sweep leaves it alone (15-minute backoff)", early.due === 0, JSON.stringify(early));
  const t16 = new Date(Date.now() + 16 * 60_000);
  const swept = await ft.sweepFilmingReports({ now: t16 });
  c.ok("sixteen minutes later it applies it", swept.due === 1 && swept.applied === 1, JSON.stringify(swept));
  const r1b = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r1.id } });
  c.ok("the report is APPLIED, attempt 2, no lease left", r1b.state === "APPLIED" && r1b.attempts === 2 && !r1b.leaseUntil && !!r1b.appliedAt, `${r1b.state}/${r1b.attempts}`);
  const vids = await prisma.contentVideo.findMany({ where: { enrollmentId: f1.enrollmentId } });
  const vOf = (topicId: string) => vids.filter((v) => v.topicId === topicId);
  c.ok("t1 and t2: one PROGRAM video each, counted toward the allowance", [t1, t2].every((t) => vOf(t).length === 1 && vOf(t)[0].kind === "PROGRAM" && vOf(t)[0].countsTowardAllowance));
  c.ok("…confirmed, by his email", [t1, t2].every((t) => !!vOf(t)[0].filmedConfirmedAt && vOf(t)[0].filmedConfirmedBy === "harrison-drill@example.com"));
  c.ok("…dated by the session that was filmed (A1's end)", [t1, t2].every((t) => vOf(t)[0].filmedAt?.getTime() === A1_END.getTime()), vOf(t1)[0]?.filmedAt?.toISOString());
  c.ok("…with the selection they came from", vOf(t1)[0].selectionId === f1.selectionIds[0] && vOf(t2)[0].selectionId === f1.selectionIds[1]);
  c.ok("t1's approved script: the exact version the client approved is recorded", vOf(t1)[0].scriptId === s1.scriptId && vOf(t1)[0].scriptVersionId === s1.versionId);
  c.ok("t2's unapproved script: the script, but no approved version", vOf(t2)[0].scriptId === s2.scriptId && vOf(t2)[0].scriptVersionId === null);
  const extraTopics = await prisma.contentTopic.findMany({ where: { enrollmentId: f1.enrollmentId, title: EXTRA_TITLE } });
  c.ok("the extra became ONE topic, PROPOSED (the office never approved it)", extraTopics.length === 1 && extraTopics[0].approvalState === "PROPOSED" && extraTopics[0].status === "FILMED", `${extraTopics.length} ${extraTopics[0]?.approvalState}/${extraTopics[0]?.status}`);
  const extraId = extraTopics[0].id;
  const extraSel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: extraId, monthId: f1.monthId } } });
  c.ok("…selected for the month as OVERFLOW (the month was full)", extraSel?.status === "SELECTED" && extraSel.overflow === true);
  c.ok("…with one EXTRA video that does not count toward the allowance", vOf(extraId).length === 1 && vOf(extraId)[0].kind === "EXTRA" && !vOf(extraId)[0].countsTowardAllowance);
  c.ok("the ticked topics are FILMED", (await prisma.contentTopic.count({ where: { id: { in: [t1, t2] }, status: "FILMED" } })) === 2);
  const capTasks = await prisma.smartTask.findMany({ where: { projectId: f1.projectId!, taskType: "content_capacity_review" } });
  c.ok("exactly one capacity-review task, on Kyle's desk", capTasks.length === 1 && capTasks[0].assignedKey === "kyle" && capTasks[0].ownerId === kyle.id && capTasks[0].priority === "MEDIUM");
  c.ok("…naming the extra and why", /Open-house mistakes — filmed on site, beyond this month's allowance/.test(capTasks[0]?.description ?? ""), capTasks[0]?.description ?? "");
  c.ok("…and the three choices, nothing charged", /this month, next month, or is billed as an extra/.test(capTasks[0]?.summary ?? "") && JSON.parse(capTasks[0]?.checklist ?? "[]").length === 3);
  c.ok("the office got a bell for it", (await prisma.notification.count({ where: { kind: "content_capacity_review" } })) === 1);
  c.ok("still one flag on the job — the landing added none", (await filmingFlags(f1.projectId!)) === 1);
  c.ok("nothing tried to leave the machine", fence.blocked.length === outBefore, fence.blocked.slice(outBefore).join(", "));

  // =========================================================================
  c.head("4 · idempotent: sweep again, submit the same again, then a different answer");
  // =========================================================================
  const snapshot = async () => ({
    videos: await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } }),
    topics: await prisma.contentTopic.count({ where: { enrollmentId: f1.enrollmentId } }),
    tasks: await prisma.smartTask.count({ where: { projectId: f1.projectId! } }),
    reports: await prisma.contentFilmingReport.count({ where: { projectId: f1.projectId! } }),
    attempts: (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r1.id } })).attempts,
    flags: await filmingFlags(f1.projectId!),
    events: await prisma.contentTopicEvent.count({ where: { enrollmentId: f1.enrollmentId } }),
  });
  const before4 = await snapshot();
  const again = await ft.sweepFilmingReports({ now: new Date(Date.now() + 2 * HOUR) });
  c.ok("a second sweep finds nothing due", again.due === 0, JSON.stringify(again));
  const res4 = await finalizeUpload(f1.projectId!, submitFor(f1));
  c.ok("an identical re-submit succeeds with nothing pending", !res4.blocked && !res4.topicsPending, JSON.stringify(res4).slice(0, 120));
  const after4 = await snapshot();
  c.ok("…and changes nothing: reports, attempts, videos, topics, tasks, flags, history", JSON.stringify(after4) === JSON.stringify(before4), `${JSON.stringify(before4)} → ${JSON.stringify(after4)}`);
  c.ok("videosFilmed stays 3 (the landed extra is not counted twice)", (await prisma.project.findUniqueOrThrow({ where: { id: f1.projectId! } })).videosFilmed === 3);
  const res4b = await finalizeUpload(f1.projectId!, submitFor(f1, { [t1]: "drone opener", [t2]: "shoot it by the window" }));
  c.ok("a DIFFERENT answer (a note added) lands at once", !res4b.topicsPending, JSON.stringify(res4b).slice(0, 120));
  const reports4 = await prisma.contentFilmingReport.findMany({ where: { projectId: f1.projectId! }, orderBy: { createdAt: "asc" } });
  c.ok("…as a second report, APPLIED on its first attempt", reports4.length === 2 && reports4[1].state === "APPLIED" && reports4[1].attempts === 1);
  c.ok("…without a second video or a second task", (await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } })) === before4.videos && (await prisma.smartTask.count({ where: { projectId: f1.projectId!, taskType: "content_capacity_review" } })) === 1);
  const one = await prisma.$queryRawUnsafe<{ one: number }[]>("SELECT 1 AS one");
  c.ok("the database connection is still up after every collision", one[0]?.one === 1, `${server.patchStats.strippedReady} unique violations survived so far`);

  // =========================================================================
  c.head("5 · the editor's slots: topic, note, live title, and Kim still routed");
  // =========================================================================
  const outs = await prisma.deliverableOutput.findMany({ where: { projectId: f1.projectId! }, orderBy: { slot: "asc" } });
  c.ok("three slots, carrying t1, t2 and the extra in rank order", outs.length === 3 && outs[0].topicId === t1 && outs[1].topicId === t2 && outs[2].topicId === extraId, outs.map((o) => `${o.slot}:${o.topicId === t1 ? "t1" : o.topicId === t2 ? "t2" : o.topicId === extraId ? "extra" : o.topicId}`).join(" "));
  c.ok("slot 1 carries 'drone opener', slot 3 'kitchen'", outs[0].filmingNote === "drone opener" && outs[2].filmingNote === "kitchen");
  c.ok("slot 2 took the later report's note", outs[1].filmingNote === "shoot it by the window", String(outs[1].filmingNote));
  const cv = await prisma.contentVideo.findMany({ where: { enrollmentId: f1.enrollmentId }, select: { topicId: true, outputId: true, deliverableId: true, slot: true } });
  c.ok("each topic video points at its slot (deliverable, slot, output)", [t1, t2, extraId].every((t, i) => { const v = cv.find((x) => x.topicId === t); return v?.outputId === outs[i].id && v.deliverableId === f1.deliverableId && v.slot === i + 1; }));
  const titles = new Map((await prisma.contentTopic.findMany({ where: { id: { in: [t1, t2, extraId] } } })).map((t) => [t.id, t.title]));
  let rows = await outputsForProject(f1.projectId!);
  c.ok("the editor reads the topic titles, not 'Video 2 of 3'", rows.map((r) => r.label).join(" | ") === [t1, t2, extraId].map((t) => titles.get(t)).join(" | "), rows.map((r) => r.label).join(" | "));
  c.ok("…with the topic and note on each row", rows[0].topicId === t1 && rows[0].topicTitle === titles.get(t1) && rows[0].filmingNote === "drone opener");
  await prisma.contentTopic.update({ where: { id: t2 }, data: { title: "The inspection talk, renamed" } });
  rows = await outputsForProject(f1.projectId!);
  c.ok("a renamed topic renames its video at once", rows[1].label === "The inspection talk, renamed", rows[1].label);
  c.ok("no Deliverable was made for the extra", (await prisma.deliverable.count({ where: { projectId: f1.projectId! } })) === 1);
  await mintEditTask(f1.projectId!);
  const edit = await prisma.smartTask.findFirst({ where: { projectId: f1.projectId!, taskType: "edit_video" }, select: { assignedKey: true } });
  c.ok("the monthly row's edit still goes to Kim", edit?.assignedKey === "kim", String(edit?.assignedKey));

  // =========================================================================
  c.head("6 · the library: the first cut on slot 1 is t1's video, not a new one");
  // =========================================================================
  const videosBefore6 = await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } });
  const cut = await prisma.reviewSubmission.create({
    data: { projectId: f1.projectId!, deliverableId: f1.deliverableId, slot: 1, round: 1, status: "PENDING", source: "upload", fileName: "pricing-v1.mp4" },
    select: { id: true },
  });
  await syncEnrollmentVideos({ id: f1.enrollmentId, clientId: f1.clientId });
  const link = await prisma.contentVideoSource.findUnique({ where: { kind_ref: { kind: "REVIEW_CUT", ref: cut.id } } });
  c.ok("the cut's library source is t1's own video", !!link && link.videoId === vOf(t1)[0].id, `${link?.videoId} vs ${vOf(t1)[0].id}`);
  c.ok("…and no second video was minted for it", (await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId } })) === videosBefore6);
  const archived6 = await prisma.contentVideo.count({ where: { enrollmentId: f1.enrollmentId, filmedConfirmedAt: { not: null }, status: "ARCHIVED" } });
  // Section 3 of the design (the archival exemption in contentVideos.ts) is the
  // CP-01 builder's, not this drill's to assert — reported, not scored.
  console.log(`    NOTE: after the library sweep ${archived6} confirmed video(s) are ARCHIVED${archived6 ? " — CP-01's survivor exemption is not in this tree yet" : " — the survivor exemption is in place"}.`);

  // =========================================================================
  c.head("7 · races: one claim, one video per topic, dead leases picked up");
  // =========================================================================
  const f2 = await month("Race One");
  const rr = await reportFor(f2, { filmedTopicIds: f2.topicIds });
  const [ra, rb] = await Promise.all([ft.applyFilmingReport(rr), ft.applyFilmingReport(rr)]);
  c.ok("two applies of one fresh report: exactly one claims it", [ra, rb].filter((r) => r.claimed).length === 1, `${ra.claimed}/${ra.state} ${rb.claimed}/${rb.state}`);
  c.ok("…it is APPLIED on one attempt", (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: rr } })).attempts === 1);
  const v2 = await prisma.contentVideo.findMany({ where: { enrollmentId: f2.enrollmentId }, select: { topicId: true } });
  c.ok("…one video per topic", v2.length === 3 && f2.topicIds.every((t) => v2.filter((v) => v.topicId === t).length === 1), String(v2.length));
  const f3 = await month("Race Two");
  const rA = await reportFor(f3, { filmedTopicIds: [f3.topicIds[0], f3.topicIds[1]] });
  const rB = await reportFor(f3, { filmedTopicIds: [f3.topicIds[0], f3.topicIds[1]], topicNotes: { [f3.topicIds[0]]: "wide first" } });
  const both = await Promise.all([ft.applyFilmingReport(rA), ft.applyFilmingReport(rB)]);
  c.ok("two different reports on one job, at once: both land", both.every((r) => r.state === "APPLIED"), both.map((r) => r.state).join("/"));
  const v3 = await prisma.contentVideo.findMany({ where: { enrollmentId: f3.enrollmentId }, select: { topicId: true, outputId: true } });
  c.ok("…and the lock gives one video per topic, each on its own slot", v3.length === 2 && new Set(v3.map((v) => v.topicId)).size === 2 && new Set(v3.map((v) => v.outputId)).size === 2 && v3.every((v) => !!v.outputId));
  const rDead = await reportFor(f3, { filmedTopicIds: [f3.topicIds[2]] });
  await prisma.contentFilmingReport.update({ where: { id: rDead }, data: { state: "APPLYING", attempts: 1, leaseUntil: new Date(Date.now() - 60_000) } });
  const rLive = await reportFor(f3, { filmedTopicIds: [f3.topicIds[0]], topicNotes: { [f3.topicIds[0]]: "still running" } });
  const liveLease = new Date(Date.now() + 4 * 60_000);
  await prisma.contentFilmingReport.update({ where: { id: rLive }, data: { state: "APPLYING", attempts: 1, leaseUntil: liveLease } });
  await ft.sweepFilmingReports();
  const dead = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: rDead } });
  const live = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: rLive } });
  c.ok("a runner that died holding the lease: the sweep takes it over and lands it", dead.state === "APPLIED" && dead.attempts === 2, `${dead.state}/${dead.attempts}`);
  c.ok("a runner still inside its lease is left alone", live.state === "APPLYING" && live.attempts === 1 && live.leaseUntil?.getTime() === liveLease.getTime(), `${live.state}/${live.attempts}`);
  await prisma.contentFilmingReport.update({ where: { id: rLive }, data: { state: "APPLIED", leaseUntil: null } }); // retire it for the later sweeps

  // =========================================================================
  c.head("8 · OLD vs NEW: a Pro month's future session, and an overflow tick");
  // =========================================================================
  const pro = (name: string) =>
    month(name, {
      package: "Pro",
      videosPerMonth: undefined,
      appointments: [{ startAt: A1 }, { startAt: NEXT_WEEK }],
    });
  const f4 = await pro("Pro Old");
  const f5 = await pro("Pro New");
  for (const f of [f4, f5]) await prisma.contentTopicSelection.update({ where: { id: f.selectionIds[2]! }, data: { overflow: true } });
  const nextWeekEnd = new Date(NEXT_WEEK.getTime() + 120 * 60_000);
  const old8 = await oldFT.confirmFilmedTopics(f4.projectId!, [f4.topicIds[0], f4.topicIds[2]], "Harrison");
  const oldV = await prisma.contentVideo.findMany({ where: { enrollmentId: f4.enrollmentId } });
  c.ok("OLD: filmed after session 1, dated by session 2 — next week", old8.filmedAtISO === nextWeekEnd.toISOString(), old8.filmedAtISO ?? "null");
  const oldOver = oldV.find((v) => v.topicId === f4.topicIds[2]);
  c.ok("OLD: the overflow tick is a PROGRAM video counted toward the allowance", oldOver?.kind === "PROGRAM" && oldOver.countsTowardAllowance === true);
  c.ok("OLD: filmedConfirmedBy is the display name", oldOver?.filmedConfirmedBy === "Harrison");
  // A leg Aryeo sent with no status is not a cancellation (the old filter skipped it).
  await prisma.appointment.update({ where: { id: f5.appointmentIds[0] }, data: { status: null } });
  const new8 = await ft.confirmFilmedTopics(f5.projectId!, [f5.topicIds[0], f5.topicIds[2]], "Harrison", { byEmail: "harrison-drill@example.com" });
  c.ok("NEW: dated by session 1, the one that was filmed (even with a null status)", new8.filmedAtISO === A1_END.toISOString(), new8.filmedAtISO ?? "null");
  const newV = await prisma.contentVideo.findMany({ where: { enrollmentId: f5.enrollmentId } });
  const newOver = newV.find((v) => v.topicId === f5.topicIds[2]);
  c.ok("NEW: the overflow tick is EXTRA and does not count toward the allowance", newOver?.kind === "EXTRA" && newOver.countsTowardAllowance === false && new8.overflow.length === 1);
  c.ok("NEW: the in-plan tick is still PROGRAM", newV.find((v) => v.topicId === f5.topicIds[0])?.kind === "PROGRAM");
  c.ok("NEW: filmedConfirmedBy is the email", newOver?.filmedConfirmedBy === "harrison-drill@example.com");

  // =========================================================================
  c.head("9 · OLD vs NEW: a legacy month topic, and the month's second session");
  // =========================================================================
  const f6 = await month("Two Sessions");
  const legacy = await prisma.contentTopic.create({
    data: { enrollmentId: f6.enrollmentId, clientId: f6.clientId, monthId: f6.monthId, title: "Two Sessions: a legacy scripted topic", status: "SCRIPTED" },
    select: { id: true },
  });
  const oldList = await oldFT.topicsForSession(f6.projectId!);
  c.ok("OLD: a topic held on the month only by its pointer is missing from the list", !!oldList && !oldList.topics.some((t) => t.topicId === legacy.id));
  const newList = await ft.topicsForSession(f6.projectId!);
  const legacyRow = newList?.topics.find((t) => t.topicId === legacy.id);
  c.ok("NEW: it is on the list, after the selected topics, with no selection", !!legacyRow && legacyRow.selectionId === null && newList!.topics[newList!.topics.length - 1].topicId === legacy.id);
  const p2 = await prisma.project.create({ data: { clientId: f6.clientId, title: "Two Sessions TEST — session 2", status: "SCHEDULED", contentMonthId: f6.monthId, packageName: "Video Starter" }, select: { id: true } });
  await ft.confirmFilmedTopics(f6.projectId!, [f6.topicIds[0]], "Harrison", { byEmail: "harrison-drill@example.com" });
  const oldP2 = await oldFT.topicsForSession(p2.id);
  const oldPreTicked = (oldP2?.topics ?? []).filter((t) => t.filmedConfirmedAtISO).map((t) => t.topicId);
  c.ok("OLD: session 2's page would pre-tick the topic session 1 filmed", oldPreTicked.includes(f6.topicIds[0]));
  const newP2 = await ft.topicsForSession(p2.id);
  const t1OnP2 = newP2?.topics.find((t) => t.topicId === f6.topicIds[0]);
  c.ok("NEW: session 2 sees it as session 1's (confirmedOnProjectId)", t1OnP2?.confirmedOnProjectId === f6.projectId);
  c.ok("NEW: …so the pre-tick rule (this project only) leaves it unticked", !(newP2?.topics ?? []).filter((t) => t.confirmedOnProjectId === p2.id).some((t) => t.topicId === f6.topicIds[0]));
  const prep9 = await ft.prepareFilmingReport(p2.id, { filmedTopicIds: [f6.topicIds[0], legacy.id] }, { name: "Harrison" });
  c.ok("NEW: …and a stale tick of it is not counted on session 2 (1 video, the legacy topic)", prep9?.videosFilmed === 1, String(prep9?.videosFilmed));

  // =========================================================================
  c.head("10 · six failures: stop retrying, put it in front of Kyle");
  // =========================================================================
  const f7 = await month("Gives Up");
  const r7 = await reportFor(f7, { filmedTopicIds: [f7.topicIds[0]] });
  await block();
  let t = Date.now();
  const gaps: number[] = [];
  let last: Awaited<ReturnType<typeof ft.applyFilmingReport>> | null = null;
  for (let i = 1; i <= 6; i++) {
    t += 3 * 24 * HOUR;
    last = await ft.applyFilmingReport(r7, { now: new Date(t) });
    const row = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r7 } });
    if (row.nextAttemptAt) gaps.push(Math.round((row.nextAttemptAt.getTime() - t) / 60_000));
  }
  c.ok("the backoff doubles from 15 minutes", JSON.stringify(gaps) === JSON.stringify([15, 30, 60, 120, 240]), JSON.stringify(gaps));
  const r7row = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r7 } });
  c.ok("the sixth failure is NEEDS_REVIEW, with no next attempt", last?.state === "NEEDS_REVIEW" && r7row.state === "NEEDS_REVIEW" && r7row.attempts === 6 && !r7row.nextAttemptAt);
  const fix = await prisma.smartTask.findMany({ where: { projectId: f7.projectId!, taskType: "content_filming_report" } });
  c.ok("one task on Kyle's desk, listing what was filmed", fix.length === 1 && fix[0].assignedKey === "kyle" && fix[0].ownerId === kyle.id && fix[0].description?.includes("Gives Up: pricing in week one") === true, fix[0]?.description?.slice(0, 80));
  c.ok("…and one bell for the office", (await prisma.notification.count({ where: { kind: "content_filming_report" } })) === 1);
  const seventh = await ft.applyFilmingReport(r7, { now: new Date(t + 24 * HOUR) });
  const sweep10 = await ft.sweepFilmingReports({ now: new Date(t + 48 * HOUR) });
  c.ok("nothing retries it after that — not a direct call, not the sweep", !seventh.claimed && sweep10.due === 0 && (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r7 } })).attempts === 6);
  await unblock();

  // =========================================================================
  c.head("11 · the real GET /api/cron/sync lands a due report, before the library");
  // =========================================================================
  const routeSrc = fs.readFileSync(path.join(REPO, "src/app/api/cron/sync/route.ts"), "utf8");
  c.ok("the filmingReports step runs before contentLibrary", routeSrc.indexOf('step("filmingReports"') > 0 && routeSrc.indexOf('step("filmingReports"') < routeSrc.indexOf('step("contentLibrary"'));
  const f8 = await month("Cron Lands");
  const r8 = await reportFor(f8, { filmedTopicIds: [f8.topicIds[0], f8.topicIds[1]] });
  await prisma.contentFilmingReport.update({ where: { id: r8 }, data: { state: "FAILED", attempts: 1, nextAttemptAt: new Date(Date.now() - 60_000), lastError: "drill: an earlier failure" } });
  const { GET } = await import("@/app/api/cron/sync/route");
  const { NextRequest } = await import("next/server");
  const res11 = await GET(new NextRequest("http://127.0.0.1/api/cron/sync", { headers: { authorization: "Bearer drill-secret" } }));
  const body11 = (await res11.json()) as Record<string, unknown>;
  const step11 = body11.filmingReports as { applied?: number } | undefined;
  c.ok("the route answered 200 and ran the step without error", res11.status === 200 && !!step11 && !("filmingReportsError" in body11), String(body11.filmingReportsError ?? res11.status));
  c.ok("…and landed the report", (step11?.applied ?? 0) >= 1 && (await prisma.contentFilmingReport.findUniqueOrThrow({ where: { id: r8 } })).state === "APPLIED", JSON.stringify(step11));
  c.ok("…whose topics are bound to the job's slots", (await prisma.contentVideo.count({ where: { enrollmentId: f8.enrollmentId, outputId: { not: null } } })) === 2);

  console.log(`\n    fence: ${fence.blocked.length} outbound call(s) blocked in total${fence.blocked.length ? ` (${[...new Set(fence.blocked.map((u) => { try { return new URL(u).host; } catch { return u.slice(0, 40); } }))].join(", ")})` : ""}; ${quiet.count} Prisma error line(s) quietened; socket patch ${JSON.stringify(server.patchStats)}`);
  c.summary();
  quiet.restore();
  removeBaseCopies(base.dir);
  await stop();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    fence.restore();
    process.exit(process.exitCode ?? 0);
  });
