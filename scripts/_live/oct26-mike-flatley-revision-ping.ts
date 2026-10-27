// ---------------------------------------------------------------------------
// MIKE FLATLEY'S REOPENED REVISION, PINGED TO KIM AND JAMES (Oct 26 2026).
// Jordan: "I think James should be pinged as well as Kim" / "Or whoever is
// editing the project in the future but creative manager should know too."
// The code now does that for every new ask (d424faa); this is the one ping
// for the revision reopened earlier today (oct26-mike-flatley-revision-
// reopen.ts), whose first ping (9:55 AM) only reached Kim, and whose task then
// read as answered by the third video's upload.
//
// One bell row each, kind revision_raised, so their own Job pings switch
// decides Slack or text (Kim: Slack; James: text). Deduped: re-running sends
// nothing new.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-mike-flatley-revision-ping.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const PROJECT = "cmtrbh05d0009lb04gv7c0cdi";
const TASK = "cmvpbkn9w0005l2083of4cm3z";

async function main() {
  const prisma = await db();
  const [project, task, briefs] = await Promise.all([
    prisma.project.findUniqueOrThrow({ where: { id: PROJECT }, select: { title: true, status: true } }),
    prisma.smartTask.findUniqueOrThrow({ where: { id: TASK }, select: { status: true, assignedKey: true, projectId: true } }),
    prisma.revisionBrief.findMany({ where: { projectId: PROJECT, taskId: TASK }, select: { originalText: true, requestedBy: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (task.projectId !== PROJECT) throw new Error("task is not on Mike's job");
  if (task.status !== "OPEN" || project.status !== "REVISION") throw new Error(`expected the reopened revision; job ${project.status}, task ${task.status}`);
  if (task.assignedKey !== "kim") throw new Error(`the revision is with ${task.assignedKey}, not Kim`);
  // The job has no street ("[No address provided]"), so the words name Mike
  // and the videos. Each note is labelled with the video its receipt line names.
  const asks = briefs.map((b) => {
    const t = (b.originalText ?? "").replace(/\s+/g, " ").trim();
    const video = /Video (\d+) of \d+/.exec(t)?.[1];
    const at = t.indexOf("•");
    return { video: Number(video ?? 99), line: `${video ? `Video ${video}: ` : ""}${(at >= 0 ? t.slice(at + 1) : t).trim()}` };
  }).sort((a, b) => a.video - b.video).map((a) => a.line).filter(Boolean);
  // Each note's opening only, so both videos fit; the link opens the whole work order.
  const { clip: clipText } = await import("../../src/lib/text");
  const ask = asks.map((a) => clipText(a, 110)).join(" | ");
  const why = `the "mike 2.1.1" upload is version 2 of the third video, so his notes on Video 2 and Video 4 still need new cuts`;
  const kimHead = `Mike Flatley's revision is open again: ${why}.`;
  const jamesHead = `Mike Flatley's revision is open again: ${why}. Kim has it.`;

  const { notifyInApp, creativeManagerTargets } = await import("../../src/lib/notify");
  const { escapeSlack, clip } = await import("../../src/lib/text");
  const { appBase } = await import("../../src/lib/appUrl");
  const kimDm = [escapeSlack(kimHead), `> ${escapeSlack(clip(ask, 400))}`, `${appBase()}/edit/${PROJECT}`].join("\n");
  const cm = await creativeManagerTargets({ head: jamesHead, ask, href: `/projects/${PROJECT}` });

  console.log(`job: ${project.title} (${project.status}); task with ${task.assignedKey} (${task.status})`);
  console.log(`\nKim (Slack DM by her switch):\n${kimDm}`);
  console.log(`\nCreative manager rows: ${cm.length}`);
  for (const t of cm) console.log(`${t.userKey}:\n${t.slackDm}`);
  if (!cm.length) throw new Error("no creative manager login resolved");
  if (!APPLY) { console.log("\ndry run: nothing sent. Re-run with --apply."); return; }

  const out = await notifyInApp({
    kind: "revision_raised",
    title: `Revision open again — Mike Flatley · Video 2 and Video 4`,
    body: clip(`Mike Flatley: ${ask}`, 140),
    href: `/projects/${PROJECT}`,
    targets: [{ roles: ["EDITOR"], userKey: "editor:kim", href: `/edit/${PROJECT}`, slackDm: kimDm }, ...cm],
    dedupeKey: `office-reopen-${TASK}-2026-10-26`,
  });
  console.log("\nsent:", JSON.stringify(out.bridged), "silenced:", out.silenced);
  const rows = await prisma.notification.findMany({ where: { dedupeKey: { startsWith: `office-reopen-${TASK}-2026-10-26` } }, select: { id: true, userKey: true } });
  const legs = await prisma.notificationDelivery.findMany({ where: { notificationId: { in: rows.map((r) => r.id) } }, select: { channel: true, status: true, detail: true, teamMemberId: true } });
  for (const r of rows) console.log("row", r.userKey);
  for (const l of legs) console.log("leg", l.teamMemberId, l.channel, l.status, (l.detail ?? "").slice(0, 80));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
