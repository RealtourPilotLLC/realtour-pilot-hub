// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): Marcee McMullen's October, after her strategy call.
// Jordan pressed "Written answers" on "I Used to Think I Would Only Work With
// Seniors" by mistake: undone (back to the call; nothing was answered, so its
// questions go). "Why I Think Malvern Is One of the Most Underrated Towns Near
// Philadelphia": she needed more time, so it is opened for written answers on
// her portal and its script waits for them. The other three are scripted from
// the call. Dry run unless --apply.
// ---------------------------------------------------------------------------
export {};
import { prisma } from "@/lib/prisma";
const MONTH = "cmup0bq4j00qijg04sg9ibkn8";
async function main() {
  const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: MONTH, status: { not: "REMOVED" } }, select: { topicId: true, answerRoute: true } });
  const topics = await prisma.contentTopic.findMany({ where: { id: { in: sels.map((s) => s.topicId) } }, select: { id: true, title: true } });
  const find = (re: RegExp) => topics.find((t) => re.test(t.title));
  const seniors = find(/Only Work With Seniors/i), malvern = find(/Malvern Is One of the Most Underrated/i);
  if (!seniors || !malvern) throw new Error("topics not found");
  const ivSen = await prisma.contentInterview.findUnique({ where: { topicId_monthId: { topicId: seniors.id, monthId: MONTH } }, select: { id: true, status: true, answeredCount: true } });
  console.log("seniors interview", JSON.stringify(ivSen), "| malvern", malvern.title);
  if (!process.argv.includes("--apply")) return;
  const { setTopicAnswerRoute } = await import("@/lib/contentInterview");
  const a = await setTopicAnswerRoute(seniors.id, MONTH, "CALL", { staffUserId: "info@realtourpilot.com" });
  const b = await setTopicAnswerRoute(malvern.id, MONTH, "WRITTEN", { staffUserId: "info@realtourpilot.com" });
  console.log("seniors:", JSON.stringify(a), "| malvern:", JSON.stringify(b));
}
main().then(() => process.exit(0)).catch((e) => { console.log("ERR", e.message); process.exit(1); });
