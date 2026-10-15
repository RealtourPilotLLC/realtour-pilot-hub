// ---------------------------------------------------------------------------
// LIVE (Oct 15 2026): Marcee McMullen's call was analysed minutes before the
// fix that gives the analysis this month's chosen topics by name. It reported
// "What Sellers Need to Know — This Is Not the 2022 Market" (a dash), the
// topic chosen in her portal is "…Know: This Is Not the 2022 Market" (a
// colon) and has no match key (an Aug 24 row), so a twin was made and her
// words about it landed on the twin (an EXTRA), leaving the chosen topic with
// no call material. This moves the twin's call evidence onto the chosen topic
// (its month selection and a DISCUSSED history row, the two places the
// excerpts are read from) and takes the twin off the month and archives it.
// Dry run unless --apply.
// ---------------------------------------------------------------------------
export {};
import { prisma } from "@/lib/prisma";
const MONTH = "cmup0bq4j00qijg04sg9ibkn8";
const CHOSEN = "cmt7nj9li006d9kgnmkpl7yr0";
const TWIN = "cmv9qi91j0096ie0608jr80hv";
async function main() {
  const [chosenSel, twinSel, twinTopic, twinEvents] = await Promise.all([
    prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: CHOSEN, monthId: MONTH } } }),
    prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: TWIN, monthId: MONTH } } }),
    prisma.contentTopic.findUnique({ where: { id: TWIN } }),
    prisma.contentTopicEvent.findMany({ where: { topicId: TWIN, kind: "DISCUSSED" }, orderBy: { createdAt: "desc" } }),
  ]);
  const scripts = await prisma.contentScript.count({ where: { topicId: TWIN } });
  console.log("chosen selection", chosenSel?.status, "evidence", chosenSel?.evidenceJson ? chosenSel.evidenceJson.length : 0, "| twin selection", twinSel?.status, "evidence", twinSel?.evidenceJson?.length ?? 0, "call", twinSel?.callRecordId, "| twin events", twinEvents.length, "| twin scripts", scripts, "| twin", twinTopic?.title);
  if (!chosenSel || !twinSel || !twinTopic || !twinSel.evidenceJson?.includes('"text"')) throw new Error("not the state this fix expects");
  if (scripts) throw new Error("the twin already has a script: look first");
  if (!process.argv.includes("--apply")) return;
  const note = "Duplicate of the topic chosen in the portal (the call worded it with a dash); its call evidence was moved there";
  await prisma.$transaction([
    prisma.contentTopicSelection.update({ where: { id: chosenSel.id }, data: { evidenceJson: chosenSel.evidenceJson?.includes('"text"') ? chosenSel.evidenceJson : twinSel.evidenceJson, callRecordId: chosenSel.callRecordId ?? twinSel.callRecordId } }),
    prisma.contentTopicEvent.create({ data: { topicId: CHOSEN, enrollmentId: twinTopic.enrollmentId, kind: "DISCUSSED", monthId: MONTH, actorKind: "STAFF", staffUserId: "info@realtourpilot.com", sourceRef: twinEvents[0]?.sourceRef ?? (twinSel.callRecordId ? `ProgramCallRecord:${twinSel.callRecordId}` : null), evidenceJson: twinEvents[0]?.evidenceJson ?? twinSel.evidenceJson, note: "Talked through on the Oct 15 strategy call (moved from a duplicate the call analysis made)" } }),
    prisma.contentTopicSelection.update({ where: { id: twinSel.id }, data: { status: "REMOVED", removedAt: new Date(), removedBy: "info@realtourpilot.com", removedReason: note } }),
    prisma.contentTopic.update({ where: { id: TWIN }, data: { status: "ARCHIVED", approvalState: "ARCHIVED", archiveReason: note, monthId: null } }),
  ]);
  const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
  const w = (await scriptWorkForMonth(MONTH)).map((x) => `${x.readiness} ${x.title.slice(0, 60)}`);
  console.log(w.join("\n"));
}
main().then(() => process.exit(0)).catch((e) => { console.log("ERR", e.message); process.exit(1); });
