// ---------------------------------------------------------------------------
// MIKE FLATLEY'S VIDEO 2 QUESTIONS, TO JAMES AND KIM (Oct 27 2026). Most of
// Mike's Oct 24 Video 2 note is questions Kim can't answer (what part two is,
// which guy opens it, whether his kids are in it). Asked whether to draft him
// a reply, Jordan: "No - but James and Kim should get notified and maybe ask
// James to clarify it for Kim."
//
// One bell row each, kind revision_addendum (their Job pings switch: Kim
// Slack, James text). James is asked to answer Kim in the job's Messages.
// Nothing goes to Mike. Deduped: re-running sends nothing new.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-mike-flatley-video2-questions-ping.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const PROJECT = "cmtrbh05d0009lb04gv7c0cdi";
const TASK = "cmvpbkn9w0005l2083of4cm3z";
const DEDUPE = `office-flatley-v2-questions-${TASK}-2026-10-27`;

async function main() {
  const prisma = await db();
  const [project, task, brief] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: PROJECT }, select: { title: true, status: true, client: { select: { name: true } } } }),
    prisma.smartTask.findUniqueOrThrow({ where: { id: TASK }, select: { status: true, assignedKey: true, projectId: true } }),
    prisma.revisionBrief.findFirst({ where: { projectId: PROJECT, taskId: TASK, headline: "Changes on Video 2 of 4" }, select: { itemsJson: true } }),
  ]);
  if (task.projectId !== PROJECT || !/Flatley/.test(project.client.name ?? "")) throw new Error("not Mike Flatley's revision");
  if (task.assignedKey !== "kim") throw new Error(`the revision is with ${task.assignedKey}, not Kim`);
  // His three questions, from the work order itself (not retyped).
  const ask = (JSON.parse(brief?.itemsJson ?? "{}") as { items?: { ask?: string }[] }).items?.[0]?.ask ?? "";
  const qs = ask.split("\n").map((l) => l.trim()).filter((l) => /^\d\./.test(l));
  if (qs.length !== 3) throw new Error(`expected Mike's 3 numbered points, found ${qs.length}: ${ask}`);
  const short = "1. What will the 2nd video (part two) be, what direction? 2. Open with the guy who says \"F real estate agents\" instead of the guy in a rush? 3. Are the kids in part two or not at all?";

  const { notifyInApp, creativeManagerTargets } = await import("../../src/lib/notify");
  const { escapeSlack } = await import("../../src/lib/text");
  const { appBase } = await import("../../src/lib/appUrl");
  const href = `/edit/${PROJECT}#messages`;
  const jamesHead = "Mike Flatley's Video 2 note asks 3 things Kim can't answer. Jordan asked if you can clarify them for Kim in the job's Messages.";
  const cm = await creativeManagerTargets({ head: jamesHead, ask: short, href });
  const kimDm = [
    escapeSlack("Heads up on Mike Flatley's Video 2: his note asks 3 questions (what the 2nd video is, whether to open with the \"F real estate agents\" guy, whether the kids are in part two). Jordan asked James to clarify them for you; his answer will be in the job's Messages."),
    `${appBase()}${href}`,
  ].join("\n");

  console.log(`job: ${project.title} (${project.status}); task with ${task.assignedKey} (${task.status})`);
  console.log("Mike's points:\n" + qs.map((q) => `  ${q}`).join("\n"));
  console.log(`\nKim (Slack):\n${kimDm}`);
  for (const t of cm) console.log(`\n${t.userKey} (James):\n${t.slackDm}`);
  if (!cm.length) throw new Error("no creative manager login resolved");
  if (!APPLY) { console.log("\ndry run: nothing sent. Re-run with --apply."); return; }

  const out = await notifyInApp({
    kind: "revision_addendum",
    title: "Mike Flatley · Video 2: questions for James to clarify",
    body: "Mike's Video 2 note asks what the 2nd video is, which guy opens it, and whether the kids are in part two.",
    href,
    targets: [{ roles: ["EDITOR"], userKey: "editor:kim", href, slackDm: kimDm }, ...cm],
    dedupeKey: DEDUPE,
  });
  console.log("\nsent:", JSON.stringify(out.bridged), "silenced:", out.silenced);
  const rows = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: DEDUPE } }, select: { id: true, userKey: true } });
  const legs = await prisma.notificationDelivery.findMany({ where: { notificationId: { in: rows.map((r) => r.id) } }, select: { channel: true, status: true, detail: true, teamMemberId: true } });
  for (const r of rows) console.log("row", r.userKey);
  for (const l of legs) console.log("leg", l.teamMemberId, l.channel, l.status, (l.detail ?? "").slice(0, 80));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
