// Live one-off (Oct 23 2026, Jordan: Erica Walker's idea "Reverse offers for
// sellers": "add it and let her answer questions in the hub about it so it can
// be added"). Her October is full (5 of 5, scripts for the Oct 29 session), so
// the topic goes on NOVEMBER, chosen, answered in writing on her portal
// (setTopicAnswerRoute WRITTEN opens the questions). --apply writes.
import { prisma } from "@/lib/prisma";
import { createTopic, selectTopicForMonth } from "@/lib/contentTopics";
import { setTopicAnswerRoute } from "@/lib/contentInterview";
const E = "cmt7h6b0300059kcj990r34x7";
const NOV = "cmvies00s000d9kf5rxkurqsd";
const JORDAN = "cmqv2zj7d00009kxlx2puezph";
const WORDS = "Reverse offers for sellers ( how sellers in this market should be sending offers to buyers not just waiting for an offer from a buyer)";
(async () => {
  if (!process.argv.includes("--apply")) { console.log("dry run: would add 'Reverse Offers for Sellers' to Erica's November, written answers"); await prisma.$disconnect(); return; }
  const actor = { kind: "STAFF" as const, staffUserId: JORDAN };
  const t = await createTopic({
    enrollmentId: E, title: "Reverse Offers for Sellers",
    concept: "Why sellers in this market should be sending offers to buyers, not just waiting for an offer from a buyer.",
    source: "client", clientWording: WORDS, approvalState: "APPROVED", approvedBy: JORDAN, actor: actor as never,
    note: "Erica's idea in the portal (Oct 22); Jordan: add it for her to answer in the hub",
  });
  console.log("topic", t);
  const sel = await selectTopicForMonth(t.id, NOV, { source: "staff", actor: actor as never, status: "SELECTED" });
  console.log("selected", JSON.stringify(sel));
  const r = await setTopicAnswerRoute(t.id, NOV, "WRITTEN", { staffUserId: JORDAN });
  console.log("route", JSON.stringify(r));
  await prisma.$disconnect();
})();
