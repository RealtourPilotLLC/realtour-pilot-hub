export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (audit Oct 25 2026, area D). Kyle's "QC & deliver" cards
// (media_qa) that came back for the PHOTOS minutes after Photo Delivery
// approved and closed them: the approval closes the card, the photos reach the
// listing a few minutes later, and the hourly reconciler read that as "Photos
// landed on Aryeo after the card was closed by hand" (8 of the last 8
// approvals). The code fix (lib/photoDelivery/mediaCheck.ts) ticks the photos'
// evidence row with the close; this closes the cards already brought back.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct25-d-photo-qc-cards.ts           (dry run)
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct25-d-photo-qc-cards.ts --apply   (writes)
//
// Which cards: OPEN media_qa cards whose ONLY reopen reason is the photos
// (sourceDetail "reopened-for:Photos") on a job whose photo job is DELIVERED
// (Photo Delivery approved and delivered them) and not in revision. A card
// back for the video, a floor plan or a tour is left alone. Closed through
// Photo Delivery's own close (closeMediaCheckForPhotos): the reason on the
// card and the timeline, a QC record, the evidence row ticked.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { installNextStubs } from "../_drill/_harness";

installNextStubs();
const APPLY = process.argv.includes("--apply");

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const file of [path.resolve(__dirname, "../../.env"), process.env.DOTENV_PATH ?? ""]) {
    if (!file || !fs.existsSync(file)) continue;
    const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DATABASE_URL not found.");
}

async function main() {
  const url = new URL(databaseUrl());
  if (!APPLY) url.searchParams.set("options", [url.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  process.env.DATABASE_URL = url.toString();
  const { prisma } = await import("../../src/lib/prisma");
  if (!APPLY) {
    let refused = false;
    try {
      await prisma.appSetting.updateMany({ where: { key: "__oct25_d_readonly_probe__" }, data: { value: "x" } });
    } catch (e) {
      refused = /read-only|25006/.test(String(e));
    }
    if (!refused) throw new Error("The read-only guard is NOT proven: refusing to continue the dry run.");
    console.log("dry run: the connection is read-only (a write was refused). Add --apply to write.\n");
  }
  const cards = await prisma.smartTask.findMany({
    where: { taskType: "media_qa", status: { notIn: ["COMPLETED", "CANCELLED"] }, sourceDetail: "reopened-for:Photos" },
    select: { id: true, title: true, projectId: true, updatedAt: true },
  });
  const todo: { card: (typeof cards)[number]; jobId: string }[] = [];
  for (const card of cards) {
    if (!card.projectId) continue;
    const [project, job] = await Promise.all([
      prisma.project.findUnique({ where: { id: card.projectId }, select: { status: true } }),
      prisma.photoJob.findUnique({ where: { projectId: card.projectId }, select: { id: true, stage: true, deliveredAt: true } }),
    ]);
    const why = !job ? "no photo job" : job.stage !== "DELIVERED" ? `photo job is ${job.stage}` : project?.status === "REVISION" ? "the job is in revision" : null;
    console.log(`${why ? "LEAVE" : "CLOSE"}  ${card.title}  (card ${card.id}, back since ${card.updatedAt.toISOString().slice(0, 16)}Z)${why ? `: ${why}` : `: photos delivered ${job!.deliveredAt?.toISOString().slice(0, 16)}Z`}`);
    if (!why) todo.push({ card, jobId: job!.id });
  }
  console.log(`\n${todo.length} card${todo.length === 1 ? "" : "s"} to close, ${cards.length - todo.length} left as they are.`);
  if (!APPLY || !todo.length) {
    if (!APPLY) console.log("DRY RUN: nothing written.");
    process.exit(0);
  }
  const { closeMediaCheckForPhotos } = await import("../../src/lib/photoDelivery/mediaCheck");
  for (const t of todo) {
    const n = await closeMediaCheckForPhotos(t.jobId, { by: "audit", reason: "Photos approved and delivered in Photo Delivery (the card had come back by mistake; closed again, audit Oct 25 2026)", human: false });
    console.log(`closed ${n}: ${t.card.title}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
