// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, audit H4e): 538 Onward Ave (Joseph Sutow) owes
// two videos, and the second one was set up by the order sync at 6:28 PM, six
// hours after the upload page was submitted and the edit card minted.
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//     NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct22-onward-second-video.ts           # dry run
//     NODE_OPTIONS=--conditions=react-server node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/_live/oct22-onward-second-video.ts --apply   # writes, pings, may text
//
// What --apply does, through the app's own code (lib/videoAddedMidJob, the
// path the order sync now takes for a video added mid-job):
//   1. the edit card's title and text are refreshed (tasks.mintEditTask):
//      "Edit 2 videos — 538 Onward Ave", naming both reels;
//   2. John (the job's editor) gets his "job pings" bell for video 2, which
//      his notification settings bridge to his DM or text;
//   3. Harrison is asked for video 2's instructions by the morning nudge
//      (missingInstructions.sweepMissingInstructions, scoped to this job): a
//      text from the company line now if it is past 10 AM ET and outside his
//      quiet time, else at the cron's next tick after 10 AM; James copied.
// Dry run (the default): a READ-ONLY database connection, nothing written,
// nothing sent; it prints what each step would do.
// ---------------------------------------------------------------------------
import { installNextStubs } from "../_drill/_harness";

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL not set: run with node --env-file=.env.");
  if (!/default_transaction_read_only/.test(url)) {
    process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}options=-c%20default_transaction_read_only%3Don`;
  }
}
installNextStubs();

const et = (d: Date | null | undefined) =>
  d ? d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "none";

async function main() {
  const { prisma } = await import("../../src/lib/prisma");
  const { cutSlots } = await import("../../src/lib/reviewCuts");
  const { videoInstructionsFor } = await import("../../src/lib/deliverableOutputs");
  const { announceVideosAddedMidJob } = await import("../../src/lib/videoAddedMidJob");
  const { missingInstructionsFor, sweepMissingInstructions } = await import("../../src/lib/missingInstructions");

  const p = await prisma.project.findFirst({
    where: { title: { startsWith: "538 Onward Ave" }, client: { name: { contains: "Sutow" } } },
    select: { id: true, title: true, status: true, videoHandoffAt: true, videoHandoffBy: true, photographer: { select: { name: true } }, editor: { select: { name: true } } },
  });
  if (!p) throw new Error("538 Onward Ave not found");
  if (p.status === "CANCELLED") throw new Error("job is cancelled: not touched");
  console.log(`=== ${p.title} (${p.id}) · ${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} ===`);
  console.log(`status ${p.status} · video half handed in ${et(p.videoHandoffAt)} by ${p.videoHandoffBy ?? "?"} · photographer ${p.photographer?.name ?? "none"} · editor ${p.editor?.name ?? "none"}`);

  const slots = await cutSlots(p.id);
  const rows = await videoInstructionsFor(p.id);
  for (const r of rows) console.log(`  video ${r.number}: ${r.label} · set up ${et(r.createdAt)} · own words: ${r.own ? `${r.own.split(/\s+/).length} words` : "none"}`);
  const later = rows.filter((r) => r.number > 1 && r.createdAt && p.videoHandoffAt && r.createdAt > p.videoHandoffAt);
  if (!later.length) {
    console.log("No video was set up after the video half went in: nothing to do.");
    process.exit(0);
  }

  const card = await prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${p.id}` }, select: { status: true, title: true, summary: true, assignedKey: true } });
  console.log(`\n1. Edit card (${card?.status ?? "none"}, ${card?.assignedKey ?? "unassigned"}):`);
  console.log(`   now:   ${card?.title} | ${(card?.summary ?? "").slice(0, 140)}`);
  console.log(`   after: Edit ${slots.length} videos — ${p.title.split(",")[0]} | ${slots.length} videos for ${p.title.split(",")[0]} (${slots.map((s) => s.label).join(", ")}). Raws are in — cut each video. …`);

  const keys = later.map((r) => r.key);
  const missing = await missingInstructionsFor(p.id);
  console.log(`\n3. What the morning nudge asks ${p.photographer?.name ?? "the photographer"} for: ${missing ? [...missing.video, ...missing.photos].join("; ") || "nothing" : "?"}`);
  const prior = await prisma.appSetting.findMany({ where: { key: { startsWith: `instructions_missing:${p.id}:` } }, select: { key: true, value: true } });
  console.log(`   earlier asks on this job: ${prior.map((x) => x.key.split(":").slice(2).join(":")).join(", ") || "none"}`);

  if (!APPLY) {
    const plan = await announceVideosAddedMidJob(p.id, keys, { source: "oct22-onward-second-video", dryRun: true });
    console.log(`\n2. Editor ping: ${plan?.editor.name ?? "the office"} would be told about ${plan?.videos.join(" and ")} (${plan?.card}).`);
    console.log("\ndry run: nothing written, nothing sent (add --apply)");
    process.exit(0);
  }

  const done = await announceVideosAddedMidJob(p.id, keys, { source: "oct22-onward-second-video" });
  console.log(`\n1+2. ${JSON.stringify(done)}`);
  const after = await prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${p.id}` }, select: { title: true, summary: true } });
  console.log(`   card now: ${after?.title} | ${(after?.summary ?? "").slice(0, 160)}`);
  const run = await sweepMissingInstructions(new Date(), { projectIds: [p.id] });
  console.log(`3. nudge: ${JSON.stringify(run)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
