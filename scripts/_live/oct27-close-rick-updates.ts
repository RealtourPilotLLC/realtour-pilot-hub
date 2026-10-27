import { APPLY, db } from "./_oct22-guard";

// Jordan, Oct 27 2026 ("1-4 OK"): close Kyle's two "Send Rick Schultz an
// update" tasks. Both drafts quote dates from before the batches of 8 (Oct 26
// and Nov 3, 9:27 AM), and nobody tells Rick the batch schedule yet.
const IDS = ["cmvpaokhg0025kz08s9ay0bvs", "cmvlgfwbg000bjv08pddmicya"];
const WHY = "Closed Oct 27 2026 on Jordan's OK: the draft quoted dates from before Rick's batches of 8, and nobody tells Rick the batch schedule yet.";

async function main() {
  const prisma = await db();
  const { closingNote } = await import("../../src/lib/programTaskCloser");
  const now = new Date();
  const rows = await prisma.smartTask.findMany({ where: { id: { in: IDS } }, select: { id: true, title: true, status: true, taskType: true, description: true } });
  for (const t of rows) {
    console.log(`${t.id} · ${t.status} · ${t.taskType} · ${t.title}`);
    if (t.status === "COMPLETED" || t.status === "CANCELLED" || !t.title.startsWith("Send Rick Schultz an update")) { console.log("  skipped"); continue; }
    if (APPLY) {
      await prisma.smartTask.update({ where: { id: t.id }, data: { status: "COMPLETED", completedAt: now, description: `${t.description ? `${t.description}\n\n` : ""}${closingNote(WHY, now)}`.slice(0, 20_000) } });
      console.log("  closed");
    } else console.log("  would close");
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
