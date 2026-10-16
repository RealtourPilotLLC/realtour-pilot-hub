// ---------------------------------------------------------------------------
// LIVE: Rick Schultz's bulk plan (Oct 15 2026, Jordan: 48 videos, 8 a
// session, one session a week, his scripts "already written, and in order").
//
//   DRY RUN (default, writes nothing):
//     set -a; source .env; set +a; NODE_OPTIONS=--conditions=react-server \
//       npx tsx scripts/_fix/oct15/rick-bulk-plan.ts <script-bank.txt>
//   APPLY:  … --apply
//
// 1. His two booked sessions (Oct 20, Oct 27) were ordered as "Full Day
//    Content Shoot", which the hub filed as OTHER (no video work): their
//    deliverable becomes VIDEO, personal branding.
// 2. The plan: 48 videos, 8 a session, every 7 days from Oct 20, on his
//    October month; the delivery note becomes the editing note; his own
//    Hook / Beat / Payoff format is kept.
// 3. The 48 scripts, in order, approved and on his portal. NO email: Jordan
//    tells Rick.
// 4. The booked sessions join the plan.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";

const RICK_CLIENT = "cmqiks8n7003j9k9qj43v4ti1";
const RICK_ENROLLMENT = "cmt7n9kdl000w9kunldguh6hl";
const SESSIONS = ["cmv88mh2500h0if067baesczl", "cmv88p3zk00xyif06tr30vscr"]; // Oct 20, Oct 27
const APPLY = process.argv.includes("--apply");
const bankPath = process.argv.slice(2).find((a) => !a.startsWith("--"));

async function main() {
  if (!bankPath) throw new Error("Pass the script bank's text file.");
  const { prisma } = await import("@/lib/prisma");
  const { parseScriptBank } = await import("@/lib/bulkScriptBank");
  const lib = await import("@/lib/bulkPlan");
  const { resolveVideoStyle } = await import("@/lib/integrations/aryeo");

  const bank = parseScriptBank(readFileSync(bankPath, "utf8"));
  console.log(`bank: ${bank.scripts.length} scripts, problems: ${JSON.stringify(bank.problems)}`);
  console.log(`note: ${bank.note}`);
  if (bank.scripts.length !== 48 || bank.problems.length) throw new Error("Expected 48 clean scripts.");

  const en = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: RICK_ENROLLMENT } });
  if (en.clientId !== RICK_CLIENT) throw new Error("Enrollment/client mismatch.");
  const existing = await lib.latestBulkPlanFor(RICK_ENROLLMENT);
  console.log(`enrollment: ${en.status} ${en.programKind ?? "MONTHLY"} · existing plan: ${existing?.id ?? "none"}`);

  const dels = await prisma.deliverable.findMany({ where: { projectId: { in: SESSIONS } }, select: { id: true, projectId: true, type: true, label: true, videoStyle: true } });
  console.log("session deliverables:", dels.map((d) => `${d.projectId.slice(-6)} ${d.type} ${d.label} ${d.videoStyle ?? "-"}`).join(" | "));
  const style = resolveVideoStyle("VIDEO", { title: "Full Day Content Shoot" });
  console.log(`style for Full Day Content Shoot: ${style}`);

  // Title collisions with Rick's existing topics (createTopic reuses a same-title topic).
  const { topicDedupeHash } = await import("@/lib/contentTopics");
  const hashes = bank.scripts.map((s) => topicDedupeHash(s.title));
  const clash = await prisma.contentTopic.findMany({ where: { enrollmentId: RICK_ENROLLMENT, dedupeHash: { in: hashes } }, select: { title: true, status: true } });
  console.log(`topics that already exist with the same title: ${clash.length}`, clash.map((c) => `${c.title} (${c.status})`).join("; "));

  if (!APPLY) { console.log("\nDRY RUN — nothing written. Re-run with --apply."); await prisma.$disconnect(); return; }

  for (const d of dels) {
    if (d.type === "OTHER" && /full day content shoot/i.test(d.label ?? "")) {
      await prisma.deliverable.update({ where: { id: d.id }, data: { type: "VIDEO", videoStyle: style } });
    }
  }
  const staff = { email: "info@realtourpilot.com", appUserId: null, name: "Jordan (set up by Claude)" };
  const planId = existing?.id ?? (await lib.createBulkPlan({
    enrollmentId: RICK_ENROLLMENT, totalVideos: 48, perSession: 8, cadenceDays: 7,
    startsOn: new Date("2026-10-20T13:00:00Z"), monthKey: "2026-10", title: "Rick's 48 videos", editingNote: bank.note,
  }, staff)).planId;
  await lib.setClientScriptFormat(RICK_ENROLLMENT, "Hook, Beat, Payoff (Rick's own script bank)", staff.email);
  const r = await lib.importBulkScripts(planId, bank.scripts, staff, { release: true, sourceFile: "Reeltor Rick — Video Script Bank.pdf" });
  console.log(`imported ${r.created}, released ${r.released}, problems ${JSON.stringify(r.problems)}`);
  const attached = await lib.attachBulkShoots(planId);
  console.log(`booked sessions attached: ${attached}`);
  const board = await lib.bulkBoard(planId);
  for (const s of board?.sessions ?? []) console.log(`  session ${s.no} ${s.dateISO?.slice(0, 10)} ${s.booked ? "booked" : "planned"} · ${s.items.length} scripts · first: ${s.items[0]?.title}`);
  console.log("totals", JSON.stringify(board?.totals));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
