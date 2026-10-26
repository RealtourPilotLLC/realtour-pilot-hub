// ---------------------------------------------------------------------------
// Oct 26 2026, Bernadette Rabel's follow-up call: she answers "The Best Brunch
// Spots in the Lehigh Valley, According to Someone Who Takes This Very
// Seriously" in writing (call at 00:42:59: "I'll answer the questions").
// Jordan: "Analyze the topic and make sure the questions for the topic make
// sense." The house questions ("what do people usually get wrong...") don't
// fit a local favorites list, so:
//   1. the topic goes to written answers (contentInterview.setTopicAnswerRoute,
//      the office's "Answer this one in writing instead"); no email is sent;
//   2. the hub's own question planner runs once (so the plan is a planned one
//      and the sweep leaves it alone), labelled claude: (never her AI cap);
//   3. four questions written for this video are the ones asked, in the
//      house order (stance, the list, a connection, a moment to film).
// Dry run without --apply.
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const TOPIC = "cmv7eb84c002j9kgdo2pesji3";
const MONTH = "cmup0bq4d00qhjg042qm8dbii";
const BY = "claude:oct26-brunch-questions";
const QUESTIONS: { key: string; text: string }[] = [
  { key: "pointOfView", text: "You take brunch very seriously. What makes a brunch spot worth it to you? Think the coffee, the eggs Benedict, the wait, the vibe, or the one thing that gets a place crossed off your list." },
  { key: "talkingPoints", text: "Which spots make your list? Give us your top three (up to five if you can't choose), the town each one is in, what you always order there, and who it's perfect for: a weekend date, the kids, a big group or visiting family." },
  { key: "evidence", text: "Do you have a personal connection to any of these places? For example you know the owners, a client works there, or it's where you take buyers who are new to the area. It's fine if not." },
  { key: "story", text: "Any funny or memorable brunch moment, or one thing we could film at a spot, like a dish arriving, your usual table, or what Jay always orders?" },
];

(async () => {
  const prisma = await db();
  const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: TOPIC, monthId: MONTH } }, select: { status: true, answerRoute: true } });
  const iv0 = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId: TOPIC, monthId: MONTH } }, select: { id: true, status: true, aiRunId: true } });
  const script = await prisma.contentScript.findFirst({ where: { topicId: TOPIC, status: { not: "WITHDRAWN" } }, select: { id: true } });
  console.log("selection:", JSON.stringify(sel), "| interview:", JSON.stringify(iv0), "| script:", script?.id ?? "none");
  if (!sel || sel.status !== "SELECTED") throw new Error("the brunch topic is not a live pick on October");
  if (script) throw new Error("a script already exists: leave the questions alone");
  for (const q of QUESTIONS) if (/[—–]/.test(q.text)) throw new Error("dash in " + q.key);
  if (!APPLY) { console.log("would switch to WRITTEN and ask:\n" + QUESTIONS.map((q, i) => `${i + 1}. [${q.key}] ${q.text}`).join("\n")); return; }

  const ci = await import("../../src/lib/contentInterview");
  const r = await ci.setTopicAnswerRoute(TOPIC, MONTH, "WRITTEN", { staffUserId: BY });
  console.log("route:", r.route, "interview:", r.interviewId);
  const gen = await import("../../src/lib/contentGeneration");
  const planned = await gen.planInterviewQuestions(r.interviewId!, { requestedBy: BY, unattended: false });
  console.log("hub planner run:", planned.runId, planned.questions, "questions");
  const iv = await prisma.contentInterview.findUniqueOrThrow({ where: { id: r.interviewId! }, select: { questionPlanJson: true, aiRunId: true } });
  const rows = JSON.parse(iv.questionPlanJson ?? "[]") as { key: string; text: string; [k: string]: unknown }[];
  console.log("the hub planner's wording:\n" + rows.filter((x) => !x.key.includes(":fu:")).map((x) => `  [${x.key}] ${x.text}`).join("\n"));
  const mine = new Map(QUESTIONS.map((q) => [q.key, q.text]));
  const askedAt = new Date().toISOString();
  const next = rows.map((x) => (x.key.includes(":fu:") ? x : { ...x, text: mine.get(x.key) ?? x.text, asked: mine.has(x.key), askedAt }));
  await prisma.contentInterview.update({ where: { id: r.interviewId! }, data: { questionPlanJson: JSON.stringify(next) } });
  const sheet = (await ci.questionSheets([{ topicId: TOPIC, monthId: MONTH }])).get(`${TOPIC}:${MONTH}`);
  console.log("what she sees now:\n" + (sheet?.questions ?? []).map((q, i) => `  ${i + 1}. ${q.text}`).join("\n"));
  const after = await prisma.contentInterview.findUniqueOrThrow({ where: { id: r.interviewId! }, select: { aiRunId: true, status: true, sourceKind: true } });
  console.log("interview:", JSON.stringify(after));
  await prisma.$disconnect();
})();
