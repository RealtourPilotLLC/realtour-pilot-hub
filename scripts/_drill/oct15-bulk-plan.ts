// ---------------------------------------------------------------------------
// DRILL: bulk content plans (Oct 15 2026, Jordan, for Rick Schultz).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-bulk-plan.ts
//
// "We are going to do 48 videos and shoot for 8 videos per session, and do 1
// session a week ... I want the system set up for like a bulk option ... I
// want him to be able to ... see the scripts ... grouped per session, but be
// able to go into the next session and see the scripts for that one too, and
// also mark them complete ... The videographer upload portal should cover that
// problem, but they need a way to add on more videos from future sessions."
//
//   1. The script bank reader: a labelled document (furniture, section
//      headings, a delivery note) read in order, words exact.
//   2. Turning the plan on: the month owes the total, no call, office-planned;
//      the client is BULK, owned by a person, active.
//   3. Import + release: rank 1..N, sessionNo by perSession, the client's own
//      Hook/Beat/Payoff format approved (house shape not enforced for THIS
//      client only), on the portal with the email held back.
//   4. Shoots: "Full Day Content Shoot" is monthly content; the plan's shoots
//      attach to the plan month in any calendar month and number by date; the
//      office can set a session by hand.
//   5. The upload page: this session first, later sessions flagged; a script
//      from a later session can be ticked; the report lands; the unfilmed
//      session-1 script moves to session 2; the pulled-ahead one reads as
//      filmed at session 1.
//   6. The client's tick: advisory, only on their released bulk scripts.
//   7. The portal view, rebalance, undo refused once filmed.
//   8. The monthly sweeps leave a bulk client alone.
//
// ISOLATION: PGlite via the shared harness; production is never opened.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch();

// A synthetic bank in the same shape as a real one (no client's words in git).
const BANK = [
  "Test Bank TEST — Video Script Bank",
  "Oct 1, 2026 · @Test Agent",
  "DELIVERY NOTE: Talk fast. Cut every 1-2 seconds. CTA by second 12.",
  ...Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const section = n === 6 ? ["SELLER SIDE"] : [];
    const page = n % 3 === 0 ? ["Test Bank TEST — Video Script Bank", `Page ${n / 3} of 4`, `-- ${n / 3} of 4 --`] : [];
    return [
      ...section,
      `VIDEO ${n}: Drill Script ${n}`,
      `Test Agent | ${n <= 5 ? "Personal Brand" : "Seller Strategy"}`,
      `HOOK "Hook line number ${n}, said fast."`,
      `BEAT "Beat line ${n} that runs on`,
      `over two lines."`,
      `PAYOFF "Payoff ${n}. Then you decide."`,
      `ON-SCREEN / CTA Call first. Link in bio.`,
      `CAPTION Caption for video ${n}. 👇`,
      ...page,
    ];
  }).flat(),
].join("\n");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5841) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const lib = await import("@/lib/bulkPlan");
    const CUR = etMonthKey();

    // ==================================================================
    c.head("1 · the script bank reader");
    const { parseScriptBank } = await import("@/lib/bulkScriptBank");
    const bank = parseScriptBank(BANK);
    c.ok("ten scripts, in order, no problems", bank.scripts.length === 10 && bank.scripts.every((s, i) => s.n === i + 1) && bank.problems.length === 0, JSON.stringify(bank.problems));
    c.ok("the delivery note is read once", bank.note === "Talk fast. Cut every 1-2 seconds. CTA by second 12.", bank.note ?? "");
    const s1 = bank.scripts[0];
    c.ok("words exact: hook unquoted, a two-line beat joined, payoff, on-screen CTA, caption", s1.hook === "Hook line number 1, said fast." && s1.lines[0].text === "Beat line 1 that runs on over two lines." && s1.lines[1].text === "Payoff 1. Then you decide." && s1.close === "Call first. Link in bio." && s1.caption === "Caption for video 1. 👇", JSON.stringify(s1));
    c.ok("the category after the pipe is the pillar; a repeated CTA is content, not page furniture", bank.scripts[6].category === "Seller Strategy" && bank.scripts.every((s) => s.close === "Call first. Link in bio."));
    c.ok("page furniture and section headings are dropped", bank.scripts.every((s) => !/Page \d|Video Script Bank|SELLER SIDE/.test(JSON.stringify([s.title, s.hook, s.lines, s.close, s.caption]))) && bank.scripts[5].section === "SELLER SIDE");

    // ==================================================================
    c.head("2 · turning the plan on");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Bulk Rick TEST", package: "Accelerator", monthKey: CUR, project: false, enrollmentStatus: "PAUSED" });
    const staff = { email: "jordan@test", appUserId: null, name: "Jordan" };
    const start = new Date(Date.now() + 5 * 864e5);
    const { planId, monthId } = await lib.createBulkPlan({ enrollmentId: f.enrollmentId, totalVideos: 10, perSession: 4, cadenceDays: 7, startsOn: start, monthKey: CUR, title: "Drill bulk plan" }, staff);
    const month = await prisma.contentMonth.findUniqueOrThrow({ where: { id: monthId } });
    const en = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: f.enrollmentId } });
    const plan = await prisma.contentBulkPlan.findUniqueOrThrow({ where: { id: planId } });
    c.ok("the plan month IS the client's month, owing the total, no call, planned by the office", monthId === f.monthId && month.videosOwed === 10 && month.strategyCallStatus === "NOT_REQUIRED" && month.planningMode === "WRITTEN");
    c.ok("3 sessions of 4 (10 videos), ending 14 days after the first", plan.sessionsPlanned === 3 && plan.endsOn?.getTime() === start.getTime() + 14 * 864e5);
    c.ok("the client is BULK, ACTIVE, and owned by a person (the Aryeo sweep can't re-package or pause them)", en.programKind === "BULK" && en.status === "ACTIVE" && en.statusManual && en.packageSource === "manual");
    let refused = "";
    await lib.createBulkPlan({ enrollmentId: f.enrollmentId, totalVideos: 5, perSession: 5 }, staff).catch((e: Error) => { refused = e.message; });
    c.ok("a second active plan is refused", /already has an active bulk plan/.test(refused), refused);

    // ==================================================================
    c.head("3 · import + release in the client's own format");
    const { validateNewScript } = await import("@/lib/contentPolicy");
    const { canonicalFromParts } = await import("@/lib/contentScripts");
    const twoLine = canonicalFromParts({ title: "x", hook: "Stop.", points: [{ role: "build-up", text: "a" }, { role: "payoff", text: "b" }], close: "Call." });
    c.ok("house rule: a two-line script is blocked for everyone else…", validateNewScript(twoLine).findings.some((x) => x.code === "talking-points.count" && x.severity === "block"));
    c.ok("…and reported, not blocked, for a client on their own format", !validateNewScript(twoLine, { clientFormat: "Hook, Beat, Payoff" }).findings.some((x) => x.severity === "block" && x.code.startsWith("talking-points")));
    await lib.setClientScriptFormat(f.enrollmentId, "Hook, Beat, Payoff", staff.email);
    await lib.updateBulkPlan(planId, { editingNote: bank.note }, staff);
    const r = await lib.importBulkScripts(planId, bank.scripts, staff, { release: true, sourceFile: "Drill bank.pdf" });
    c.ok("ten scripts added and all ten released", r.created === 10 && r.released === 10 && r.problems.length === 0, JSON.stringify(r.problems).slice(0, 300));
    const sels = await prisma.contentTopicSelection.findMany({ where: { monthId }, orderBy: { rank: "asc" }, select: { rank: true, sessionNo: true, topicId: true } });
    c.ok("plan order 1..10, sessions 1,1,1,1,2,2,2,2,3,3", sels.map((s) => s.rank).join(",") === "1,2,3,4,5,6,7,8,9,10" && sels.map((s) => s.sessionNo).join(",") === "1,1,1,1,2,2,2,2,3,3", sels.map((s) => `${s.rank}:${s.sessionNo}`).join(" "));
    const scripts = await prisma.contentScript.findMany({ where: { monthId }, select: { id: true, topicId: true, sharedVersionId: true, releaseState: true } });
    const releases = await prisma.contentScriptRelease.findMany({ where: { scriptId: { in: scripts.map((s) => s.id) }, action: "SHARE" }, select: { notificationState: true, note: true } });
    c.ok("every script is on the portal (shared, released)", scripts.length === 10 && scripts.every((s) => s.sharedVersionId && s.releaseState === "released"));
    c.ok("…and no email was queued (the office tells the client)", releases.length === 10 && releases.every((x) => x.notificationState !== "QUEUED" && /Email suppressed/.test(x.note ?? "")), JSON.stringify(releases[0]));
    const v1 = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: scripts.find((s) => s.topicId === sels[0].topicId)!.id }, orderBy: { versionNo: "desc" } });
    c.ok("the words are kept exactly; the editing note rides on each script as direction", v1.hook === "Hook line number 1, said fast." && v1.close === "Call first. Link in bio." && /Talk fast/.test(v1.creativeDirection ?? ""), JSON.stringify({ hook: v1.hook, close: v1.close, dir: v1.creativeDirection }));
    let dup = "";
    await lib.importBulkScripts(planId, bank.scripts, staff).catch((e: Error) => { dup = e.message; });
    c.ok("the same bank twice is refused", /already added/.test(dup), dup);

    // ==================================================================
    c.head("4 · shoots: the product, attachment, session numbers");
    const { MONTHLY_PLAN_RE } = await import("@/lib/pipeline");
    c.ok("“Full Day Content Shoot” reads as monthly content", MONTHLY_PLAN_RE.test("Full Day Content Shoot"));
    const mk = async (days: number) => {
      const p = await prisma.project.create({ data: { clientId: f.clientId, title: `Session shoot +${days}`, status: "SCHEDULED", shootDate: new Date(start.getTime() + days * 864e5) }, select: { id: true } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Full Day Content Shoot", productTitle: "Full Day Content Shoot", quantity: 1 } });
      return p.id;
    };
    const pA = await mk(0), pB = await mk(7), pLate = await mk(60);
    const { attachMonthlyProjects } = await import("@/lib/contentProgram");
    await attachMonthlyProjects();
    const [a, b, late] = await Promise.all([pA, pB, pLate].map((id) => prisma.project.findUniqueOrThrow({ where: { id }, select: { contentMonthId: true } })));
    c.ok("shoots inside the plan window join the plan month (whatever calendar month)", a.contentMonthId === monthId && b.contentMonthId === monthId);
    c.ok("a shoot well past the plan is not swallowed by it", late.contentMonthId !== monthId);
    const shoots = await lib.planShoots(monthId);
    c.ok("sessions numbered by date: 1, 2", shoots.find((s) => s.projectId === pA)?.sessionNo === 1 && shoots.find((s) => s.projectId === pB)?.sessionNo === 2);
    await lib.setProjectSession(pB, 3, staff.email);
    c.ok("the office can say a shoot is session 3", (await lib.planShoots(monthId)).find((s) => s.projectId === pB)?.sessionNo === 3);
    await lib.setProjectSession(pB, null, staff.email);

    // ==================================================================
    c.head("5 · the upload page and the filming report");
    const ft = await import("@/lib/filmedTopics");
    const sess = await ft.topicsForSession(pA);
    const now1 = sess?.topics.filter((t) => !t.laterSession) ?? [];
    const later1 = sess?.topics.filter((t) => t.laterSession) ?? [];
    c.ok("session 1's page: its 4 scripts first, the other 6 flagged as later sessions", sess?.bulk?.sessionNo === 1 && now1.length === 4 && later1.length === 6 && later1.every((t) => (t.sessionNo ?? 0) > 1), JSON.stringify({ bulk: sess?.bulk, now: now1.length, later: later1.length }));
    const t = (rank: number) => sels[rank - 1].topicId;
    // Filmed 3 of session 1, plus number 9 (session 3) pulled ahead.
    const prep = await ft.prepareFilmingReport(pA, { filmedTopicIds: [t(1), t(2), t(3), t(9)] }, { name: "James", email: "james@test" });
    c.ok("the report takes a later session's script", !!prep && prep.videosFilmed === 4, JSON.stringify(prep?.videosFilmed));
    await prisma.contentFilmingReport.createMany({ data: [prep!.row], skipDuplicates: true });
    const rep = await prisma.contentFilmingReport.findUniqueOrThrow({ where: { projectId_payloadHash: { projectId: pA, payloadHash: prep!.payloadHash } } });
    const applied = await ft.applyFilmingReport(rep.id);
    c.ok("the report lands and confirms 4 videos", applied.state === "APPLIED" && applied.confirmed === 4, JSON.stringify(applied));
    const board = await lib.bulkBoard(planId);
    const item = (rank: number) => [...(board?.sessions.flatMap((s) => s.items) ?? []), ...(board?.unplanned ?? [])].find((x) => x.rank === rank);
    c.ok("number 4 (planned for session 1, not filmed) moved to session 2", item(4)?.sessionNo === 2 && item(4)?.state === "planned");
    c.ok("number 9 stays planned for session 3 but reads as filmed at session 1", item(9)?.sessionNo === 3 && item(9)?.state === "filmed" && item(9)?.filmedSessionNo === 1);
    c.ok("totals: 4 filmed of 10", board?.totals.filmed === 4 && board.totals.planned === 10);
    const sessB = await ft.topicsForSession(pB);
    c.ok("session 2's page: its scripts plus the carried one; nothing filmed at session 1 is listed again", (sessB?.topics ?? []).every((x) => ![t(1), t(2), t(3), t(9)].includes(x.topicId)) && (sessB?.topics ?? []).filter((x) => !x.laterSession).some((x) => x.topicId === t(4)));
    const { sessionBriefFor } = await import("@/lib/deliverableOutputs");
    const brief = await sessionBriefFor(pB);
    c.ok("the shoot screen brief lists only today's scripts", !!brief && brief.topics.length === (sessB?.topics ?? []).filter((x) => !x.laterSession).length, String(brief?.topics.length));

    // ==================================================================
    c.head("6 · the client's own tick");
    const sc5 = scripts.find((s) => s.topicId === t(5))!;
    await lib.setClientMarkedDone(f.enrollmentId, sc5.id, true, "Rick (portal)");
    const b2 = await lib.bulkBoard(planId);
    const i5 = b2?.sessions.flatMap((s) => s.items).find((x) => x.rank === 5);
    c.ok("a tick reads as the client's, never as filmed", i5?.state === "client_done" && b2?.totals.filmed === 4 && b2.totals.clientDone === 1);
    let other = "";
    const plainMonth = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Monthly Other TEST", package: "Accelerator", monthKey: CUR, project: false, topics: [{ title: "Plain topic", selection: "SELECTED" }] });
    const { createScriptVersion } = await import("@/lib/contentScripts");
    const pv = await createScriptVersion({ enrollmentId: plainMonth.enrollmentId, monthId: plainMonth.monthId, topicId: plainMonth.topicIds[0], source: "MANUAL", createdBy: "x", parts: { title: "Plain", hook: "h", points: [{ role: "re-hook", text: "a" }, { role: "build-up", text: "b" }, { role: "payoff", text: "c" }], close: "c" } });
    await lib.setClientMarkedDone(f.enrollmentId, pv.scriptId, true, "x").catch((e: Error) => { other = e.message; });
    c.ok("another client's script can't be ticked", /isn't yours/.test(other), other);

    // ==================================================================
    c.head("7 · the portal view, rebalance, undo");
    const { portalBulkView } = await import("@/lib/portalBulk");
    const pv2 = await portalBulkView(f.enrollmentId);
    c.ok("the portal groups by session, opens on the next session to film, words shown", !!pv2 && pv2.sessions.length >= 3 && pv2.focusSessionNo === 2 && pv2.sessions.every((s) => s.items.every((x) => !!x.body)), JSON.stringify({ focus: pv2?.focusSessionNo, n: pv2?.sessions.length }));
    c.ok("…the client's tick and our states are separate words", pv2?.sessions.flatMap((s) => s.items).find((x) => x.title === "Drill Script 5")?.state === "marked_done" && pv2?.sessions.flatMap((s) => s.items).find((x) => x.title === "Drill Script 9")?.state === "filmed");
    const { homeActions } = await import("@/lib/portalHome");
    const ha = homeActions({
      status: "ACTIVE", readOnly: false, perms: { suggest: true, session: true, approve: true, request: true, profile: true } as never,
      review: { count: 0, single: null, soonestDeadlineLabel: null }, scripts: [{ topicId: "x", title: "Drill Script 6" }], unread: 0, planning: null, clientPlanned: null,
      month: { monthKey: CUR, label: "x", owed: 10, selected: 2 }, filmingStarted: true, topicHistoryNeedsReview: false, toAnswer: [],
      session: { offerBooking: true, required: 3, missing: 1, deferred: false, earliestLabel: null }, addressNeeded: 0,
      ready: { count: 0, withFile: false, single: null }, setup: null, lateSession: null,
      bulk: { focusSessionNo: 2, scripts: 4, dateLabel: null },
    } as never, "/portal/x");
    const kinds = [ha.primary, ...ha.more].filter(Boolean).map((x) => x!.kind);
    c.ok("portal Home: 'Read your scripts for session 2', no script-approval, topic or booking nags", kinds.includes("READ_SESSION") && !kinds.includes("APPROVE_SCRIPTS") && !kinds.includes("PICK_TOPICS") && !kinds.includes("BOOK_SESSION"), kinds.join(","));
    const rb = await lib.rebalanceRemaining(planId, staff, { perSession: 3 });
    const b3 = await lib.bulkBoard(planId);
    const open3 = b3!.sessions.flatMap((s) => s.items).filter((x) => x.state === "planned" || x.state === "client_done");
    c.ok("spreading the rest at 3 a session starts after the filmed session and keeps plan order", rb.fromSession === 2 && open3.sort((x, y) => x.rank - y.rank).map((x) => x.sessionNo).join(",") === "2,2,2,3,3,3", `${rb.fromSession} ${open3.map((x) => `${x.rank}:${x.sessionNo}`).join(" ")}`);
    const batch = await prisma.contentImportBatch.findFirstOrThrow({ where: { kind: lib.BULK_IMPORT_KIND, enrollmentId: f.enrollmentId, mode: "APPLIED" } });
    let undo = "";
    await lib.undoBulkImport(batch.id, staff).catch((e: Error) => { undo = e.message; });
    c.ok("undo is refused once anything in the import is filmed", /already filmed/.test(undo), undo);

    // ==================================================================
    c.head("8 · the monthly sweeps leave a bulk client alone");
    // Move the plan month off the current calendar month, so a monthly client would get a new one.
    await prisma.contentMonth.update({ where: { id: monthId }, data: { monthKey: "2025-01" } });
    const { ensureCurrentMonths } = await import("@/lib/contentProgram");
    await ensureCurrentMonths();
    c.ok("no new calendar month is minted for a BULK client", (await prisma.contentMonth.count({ where: { enrollmentId: f.enrollmentId, monthKey: CUR } })) === 0);
    c.ok("…while a monthly client still gets theirs", (await prisma.contentMonth.count({ where: { enrollmentId: plainMonth.enrollmentId, monthKey: CUR } })) === 1);
    await prisma.contentMonth.update({ where: { id: monthId }, data: { monthKey: CUR } });
    const { carryUnfilmedTopics } = await import("@/lib/contentTopics");
    const carry = await carryUnfilmedTopics(f.enrollmentId, { dryRun: true });
    c.ok("nothing from earlier months rolls into a plan month", carry.candidates.length === 0);
    const { sessionsRequiredForMonth } = await import("@/lib/programMonths");
    c.ok("the plan month owes the plan's sessions", (await sessionsRequiredForMonth(monthId)) === (await prisma.contentBulkPlan.findUniqueOrThrow({ where: { id: planId } })).sessionsPlanned);
    const src = await import("node:fs").then((fs) => ({
      rem: fs.readFileSync(require.resolve("../../src/lib/programReminders.ts"), "utf8"),
      desk: fs.readFileSync(require.resolve("../../src/lib/programDeskTasks.ts"), "utf8"),
      draft: fs.readFileSync(require.resolve("../../src/lib/contentDrafting.ts"), "utf8"),
      topics: fs.readFileSync(require.resolve("../../src/lib/contentTopics.ts"), "utf8"),
    }));
    c.ok("reminders: a bulk month runs only its address and review lanes", /if \(bulkMonth && lane === "PRIMARY"\) continue;/.test(src.rem) && /const scripts = bulkMonth \? \[\]/.test(src.rem));
    const NOT_BULK = /OR: \[\{ programKind: null \}, \{ programKind: \{ not: "BULK" \} \}\]/g;
    c.ok("no script-approval chase, no AI drafting/questions, no topic-bank refresh for BULK clients", (src.desk.match(NOT_BULK) ?? []).length === 1 && (src.draft.match(NOT_BULK) ?? []).length === 2 && (src.topics.match(NOT_BULK) ?? []).length >= 3);
    // THE NULL TRAP: Prisma's NOT on a nullable column also drops NULL rows, so
    // `NOT: { programKind: "BULK" }` would skip every MONTHLY client (null).
    const kept = await prisma.contentEnrollment.findMany({ where: { status: "ACTIVE", OR: [{ programKind: null }, { programKind: { not: "BULK" } }] }, select: { id: true } });
    c.ok("the filter keeps every monthly client and leaves only the bulk one out", kept.some((e) => e.id === plainMonth.enrollmentId) && !kept.some((e) => e.id === f.enrollmentId));

    c.head("isolation");
    c.ok("no outbound call escaped", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
