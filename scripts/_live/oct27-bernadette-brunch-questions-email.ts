// ---------------------------------------------------------------------------
// BERNADETTE'S BRUNCH QUESTIONS, EMAILED (Oct 27 2026). Jordan, asked "Should
// I email Bernadette her brunch questions link?": "Yes". The topic went to
// written answers by hand on Oct 26 (oct26-bernadette-brunch-questions.ts)
// with four questions and no email. This sends the question request email
// with the one-tap link to that topic's questions
// (programReminders.sendTopicQuestionsEmail): recorded on her October
// reminder ledger, sent once, same gates as a person's press.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-bernadette-brunch-questions-email.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const TOPIC = "cmv7eb84c002j9kgdo2pesji3";
const MONTH = "cmup0bq4d00qhjg042qm8dbii";

async function main() {
  const prisma = await db();
  const iv = await prisma.contentInterview.findUniqueOrThrow({ where: { topicId_monthId: { topicId: TOPIC, monthId: MONTH } }, select: { id: true, status: true, submittedAt: true, clientId: true } });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: iv.clientId }, select: { name: true } });
  if (!/Rabel/.test(client.name ?? "")) throw new Error(`not Bernadette: ${client.name}`);
  const { questionSheets } = await import("../../src/lib/contentInterview");
  const sheet = (await questionSheets([{ topicId: TOPIC, monthId: MONTH }])).get(`${TOPIC}:${MONTH}`);
  const sent = await prisma.programReminder.findMany({ where: { dedupeKey: { contains: `TOPIC_QUESTIONS:${iv.id}` } }, select: { state: true, sentAt: true } });
  console.log(`${client.name}: interview ${iv.status}${iv.submittedAt ? " (answered)" : ""}; already emailed: ${sent.length ? JSON.stringify(sent) : "no"}`);
  console.log("she will see:\n" + (sheet?.questions ?? []).map((q, i) => `  ${i + 1}. ${q.text}`).join("\n"));
  if (!APPLY) { console.log("dry run: nothing sent. Re-run with --apply."); return; }
  const { sendTopicQuestionsEmail } = await import("../../src/lib/programReminders");
  const r = await sendTopicQuestionsEmail(iv.id, { email: "Claude (for Jordan)" });
  console.log("result:", JSON.stringify(r));
  if (r.reminderId) {
    const row = await prisma.programReminder.findUniqueOrThrow({ where: { id: r.reminderId }, select: { state: true, toRef: true, sentAt: true, outboxMessageId: true } });
    console.log("ledger:", JSON.stringify(row));
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
