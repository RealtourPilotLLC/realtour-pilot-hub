// ---------------------------------------------------------------------------
// DRILL: the questions under each chosen topic, and how each topic is answered
// (Oct 15 2026, Jordan, after Marcee McMullen's strategy call).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-topic-questions.ts
//
// Jordan chose five topics in Marcee's portal WITH her on the call, pressed
// "Written answers" on one by mistake, and wanted: (1) an Undo; (2) each
// chosen topic's questions open underneath it, read out on the call when one
// is planned, answered in writing when the client plans on her own; (3) one
// topic ("Malvern", she needed more time) open for written answers on her
// portal while the others are scripted from the call.
//
//   1. The questions: six, filled in for the topic, no placeholders and no em
//      dashes, under every chosen topic of an open month in the portal; on a
//      month planned on a call they read "CALL".
//   2. "Written answers" on one topic of a call month: the topic is asked in
//      writing (its step NEEDS_ANSWERS, its script WAITING_ON_ANSWERS) while a
//      topic with call material is still scripted FROM_CALL.
//   3. Undo: nothing answered → the interview goes; answered → set aside and
//      kept; opening the questions again brings it back with the answers.
//   4. The portal: answers typed under the topic are saved (the questions open
//      on the first answer), sent with the same sufficiency rules, and only
//      the team may switch a topic between the call and writing.
//   5. The call analysis is given this month's chosen topics by name.
//
// ISOLATION: PGlite via the shared harness; production is never opened.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5823) });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { etMonthKey } = await import("@/lib/contentProgram");
    const CUR = etMonthKey();
    const SENIORS = "I Used to Think I Would Only Work With Seniors. Then This Happened.";
    const MALVERN = "Why I Think Malvern Is One of the Most Underrated Towns Near Philadelphia";
    const RENO = "How I Know What a Renovation Will Actually Cost Before You Make an Offer";
    const f = await buildContentMonth(prisma as unknown as PrismaClient, {
      name: "Marcee Call TEST", package: "Pro", monthKey: CUR, project: false,
      topics: [
        { title: SENIORS, selection: "SELECTED", source: "client" },
        { title: MALVERN, selection: "SELECTED", source: "client" },
        { title: RENO, selection: "SELECTED", source: "client", excerpts: ["I always walk the house with my contractor before we write the offer, so my buyers know the real number."] },
      ],
    });
    const [tSen, tMal, tReno] = f.topicIds;
    // The month was planned on a strategy call, held this morning.
    await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", monthId: f.monthId, targetMonthKey: CUR, scheduledStart: new Date(Date.now() - 3 * 3600_000), scheduledEnd: new Date(Date.now() - 2.5 * 3600_000), transcriptState: "AWAITING" } });
    const { recalcProgramMonth } = await import("@/lib/programMonths");
    await recalcProgramMonth(f.monthId);
    const planning = await import("@/lib/planningFacts").then((m) => m.planningForMonth(f.monthId));
    c.ok("the month is planned on a call, and the call was held", planning?.route === "CALL" && planning.call === "HELD", JSON.stringify({ route: planning?.route, call: planning?.call }));

    // ==================================================================
    c.head("1 · the six questions open under each chosen topic");
    const lib = await import("@/lib/contentInterview");
    const { portalTopics } = await import("@/lib/portal");
    const page = await portalTopics({ id: f.enrollmentId, clientId: f.clientId });
    const topicOf = (id: string) => page.groups.flatMap((g) => g.topics).find((t) => t.id === id);
    const qSen = topicOf(tSen)?.questions;
    c.ok("every chosen topic carries its questions", [tSen, tMal, tReno].every((id) => (topicOf(id)?.questions?.items.length ?? 0) === 6), JSON.stringify([tSen, tMal, tReno].map((id) => topicOf(id)?.questions?.items.length)));
    c.ok("…on a month planned on a call they are read out on the call (CALL)", [tSen, tMal, tReno].every((id) => topicOf(id)?.questions?.route === "CALL" && topicOf(id)?.questions?.callMonth === true));
    c.ok("…filled in for the topic: no placeholders, no em dashes", !!qSen && qSen.items[0].text.includes(SENIORS) && qSen.items.every((q) => !q.text.includes("{{") && !q.text.includes("—")), qSen?.items[0].text);

    // ==================================================================
    c.head("2 · one topic in writing, the rest from the call");
    const r1 = await lib.setTopicAnswerRoute(tMal, f.monthId, "WRITTEN", { staffUserId: "jordan@test" });
    const ivMal = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId: tMal, monthId: f.monthId } } });
    const selMal = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tMal, monthId: f.monthId } } });
    c.ok("Malvern is asked in writing: the route is kept on its selection and its written questions are open", r1.route === "WRITTEN" && selMal?.answerRoute === "WRITTEN" && ivMal?.sourceKind === "WRITTEN" && ivMal.status === "NOT_STARTED");
    const facts = await import("@/lib/planningFacts").then((m) => m.planningForMonth(f.monthId));
    const stepOf = (id: string) => facts?.planning.topics.find((t) => t.topicId === id)?.step;
    c.ok("…its step asks the client for answers; a topic with call material is being written", stepOf(tMal) === "NEEDS_ANSWERS" && stepOf(tReno) === "WRITING", JSON.stringify({ malvern: stepOf(tMal), reno: stepOf(tReno), seniors: stepOf(tSen) }));
    const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
    const work = await scriptWorkForMonth(f.monthId);
    const ready = (id: string) => work.find((w) => w.topicId === id)?.readiness;
    c.ok("…its script waits for her answers, the call topic is scripted from the call", ready(tMal) === "WAITING_ON_ANSWERS" && ready(tReno) === "FROM_CALL", JSON.stringify(work.map((w) => [w.title.slice(0, 20), w.readiness])));
    const page2 = await portalTopics({ id: f.enrollmentId, clientId: f.clientId });
    const malOnPage = page2.groups.flatMap((g) => g.topics).find((t) => t.id === tMal);
    c.ok("…the portal shows Malvern's questions as written answers", malOnPage?.questions?.route === "WRITTEN" && malOnPage.questions.interviewId === ivMal?.id);

    // ==================================================================
    c.head("3 · Undo");
    await lib.setTopicAnswerRoute(tSen, f.monthId, "WRITTEN", { staffUserId: "jordan@test" }); // the mistaken press
    const undo = await lib.setTopicAnswerRoute(tSen, f.monthId, "CALL", { staffUserId: "jordan@test" });
    const gone = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId: tSen, monthId: f.monthId } } });
    const selSen = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: tSen, monthId: f.monthId } } });
    c.ok("nothing answered: the written questions go, as if never opened, and the topic is back on the call", undo.withdrawn === "deleted" && !gone && selSen?.answerRoute === "CALL");
    // Answered, then undone: kept, set aside, and back when reopened.
    await lib.answerQuestion(ivMal!.id, "audienceProblem", { text: "Buyers skip Malvern because they think it is only for empty nesters.", kind: "TYPED", actor: { clientUserId: f.clientUserId } });
    const undo2 = await lib.setTopicAnswerRoute(tMal, f.monthId, "CALL", { staffUserId: "jordan@test" });
    const aside = await prisma.contentInterview.findUnique({ where: { id: ivMal!.id } });
    c.ok("answered: set aside (ABANDONED), and what she wrote is kept", undo2.withdrawn === "set-aside" && aside?.status === "ABANDONED" && (await prisma.contentInterviewAnswer.count({ where: { interviewId: ivMal!.id } })) === 1);
    const work2 = await scriptWorkForMonth(f.monthId);
    c.ok("…a set-aside interview no longer holds the script back", work2.find((w) => w.topicId === tMal)?.readiness !== "WAITING_ON_ANSWERS", work2.find((w) => w.topicId === tMal)?.readiness);
    await lib.setTopicAnswerRoute(tMal, f.monthId, "WRITTEN", { staffUserId: "jordan@test" });
    const back = await prisma.contentInterview.findUnique({ where: { id: ivMal!.id } });
    c.ok("asked in writing again: the same interview comes back with her answer (IN_PROGRESS)", back?.status === "IN_PROGRESS" && back.sourceKind === "WRITTEN");

    // ==================================================================
    c.head("4 · answering under the topic in the portal");
    const actions = await import("@/app/portal/actions");
    const auth = { token: f.portalToken };
    const deny = await actions.portalSetTopicAnswerRoute(auth, tReno, f.monthId, "WRITTEN");
    c.ok("only the team may switch a topic between the call and writing (a client link is refused)", !deny.ok && /Realtour Pilot team/.test(deny.message), deny.message);
    const sv = await actions.portalSaveTopicAnswer(auth, tMal, f.monthId, "pointOfView", "Malvern has the best walkable downtown on the Main Line for the money.");
    c.ok("a typed answer under the topic is saved", sv.ok && (await lib.currentAnswers(ivMal!.id)).some((a) => a.questionKey === "pointOfView" && /walkable downtown/.test(a.answerText ?? "")), sv.message);
    const sendThin = await actions.portalSendTopicAnswers(auth, tMal, f.monthId);
    c.ok("Send with thin answers: refused (or a follow-up first), never a script from nothing", !sendThin.ok, sendThin.message);
    const ivNow = await prisma.contentInterview.findUnique({ where: { id: ivMal!.id } });
    c.ok("…the questions she left empty were marked left blank, not lost", (await lib.currentAnswers(ivMal!.id)).length >= 6 && ivNow?.status !== "SUBMITTED");
    const pageW = await portalTopics({ id: f.enrollmentId, clientId: f.clientId });
    const malW = pageW.groups.flatMap((g) => g.topics).find((t) => t.id === tMal)?.questions;
    c.ok("the portal shows her saved answers under each question", !!malW && malW.items.find((q) => q.key === "pointOfView")?.answer?.includes("walkable downtown") === true && malW.items.find((q) => q.key === "audienceProblem")?.answer?.includes("empty nesters") === true);

    // ==================================================================
    c.head("5 · the call analysis knows this month's chosen topics by name");
    const src = await import("node:fs").then((fs) => fs.readFileSync(require.resolve("../../src/lib/contentGeneration.ts"), "utf8"));
    c.ok("the chosen titles go into the analysis prompt, to be reported EXACTLY", /TOPICS ALREADY CHOSEN FOR THIS MONTH/.test(src) && /\$\{chosenBlock\}TRANSCRIPT:/.test(src));

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
