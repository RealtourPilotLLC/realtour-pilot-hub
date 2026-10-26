export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 26 2026): fill the skit clients' banks per pillar and
// format, for Bernadette Rabel (Mix), Janice Pigga, Joseph Sutow and Mike
// Flatley (Skits). Jordan: "anyone that does skits, needs skit concepts as
// video topics ... switch back and forth between direct to camera and skits
// for each pillar."
//
// For each client, in this order:
//   1. (Skits accounts) the bank topics written BEFORE the account was set to
//      Skits, with no format of their own, still in the bank and never
//      scripted (contentTopics.preSkitsBankTopics). They are talking-to-camera
//      topics that have read as skits since the switch; --apply marks each one
//      Talking to camera (setTopicFormat, on the topic's history). No script
//      is touched.
//   2. The refills: one REFRESH run per pillar and format below target (the
//      main format at the policy count, the other at 5), pending suggestions
//      counted as stock, the weekly cooldown waived for this one-off
//      (contentTopics.queuePillarRefills). It only QUEUES; the 15-minute AI
//      job runs them two at a time behind `topic_refresh` and `ai_runs`, and
//      THAT spends API. Each run reads the client's strategy-call notes.
//
// The dry run is read-only (the guard proves it with a refused write) and
// prints what --apply would do. The refill plan it prints is the bank as it
// stands, BEFORE step 1's marking; --apply plans after marking. Jordan runs
// --apply himself.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-banks.ts           # dry run (read-only)
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct26-skit-banks.ts --apply   # marks + queues
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

export const CLIENTS = ["Bernadette Rabel", "Janice Pigga", "Joseph Sutow", "Mike Flatley"] as const;
const BY = "staff:oct26-skit-banks";

async function main() {
  const prisma = await db();
  const ct = await import("../../src/lib/contentTopics");
  const gen = await import("../../src/lib/contentGeneration");
  const vf = await import("../../src/lib/contentPolicy/videoFormat");
  let marked = 0, queued = 0;
  for (const name of CLIENTS) {
    const clients = await prisma.client.findMany({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true, name: true } });
    if (clients.length !== 1) { console.log(`\n${name}: ${clients.length} clients by that name: skipped`); continue; }
    const client = clients[0];
    const e = await prisma.contentEnrollment.findFirst({ where: { clientId: client.id, status: "ACTIVE" }, select: { id: true, overridesJson: true, clientSuppliesTopics: true, programKind: true } });
    if (!e) { console.log(`\n${client.name}: no ACTIVE enrollment: skipped`); continue; }
    const style = vf.videoStyleFromOverrides(e.overridesJson);
    console.log(`\n=== ${client.name} · enrollment ${e.id} · style ${style}`);
    if (!vf.skitsOn(style)) { console.log("  not a Skits or Mix account: nothing to do"); continue; }
    if (e.clientSuppliesTopics || e.programKind === "BULK") { console.log("  plans their own content or is a bulk plan: no topic bank to fill"); continue; }

    // What each refresh will read from their calls.
    const calls = await gen.strategyCallNotesFor(e.id, client.id);
    console.log(`  strategy-call notes for the prompt: ${calls.calls.length ? calls.calls.map((c) => `${c.kind} ${c.dateISO} (${c.notes.split(/\s+/).filter(Boolean).length} words)`).join("; ") : "none on file"}${calls.stripped ? ` · ${calls.stripped} line(s) scrubbed` : ""}`);

    // 1. Talking-to-camera topics from before the switch to Skits.
    const pre = await ct.preSkitsBankTopics(e.id);
    if (pre.since) {
      console.log(`  set to Skits ${pre.since.toISOString()}: ${pre.topics.length} older bank topic(s) with no format read as skits${pre.topics.length ? `; --apply marks them Talking to camera, e.g. ${pre.topics.slice(0, 4).map((t) => `"${t.title}"`).join(", ")}` : ""}`);
      if (APPLY) {
        for (const t of pre.topics) { const r = await ct.setTopicFormat(t.id, "DIRECT", { kind: "STAFF" }); if (r.changed) marked++; }
        console.log(`  marked ${pre.topics.length} Talking to camera`);
      }
    }

    // 2. The refills, per pillar and format.
    for (const p of await ct.bankStock(e.id)) {
      console.log(`  ${p.pillarName}: ${(p.formats ?? []).map((f) => `${vf.FORMAT_PLURAL[f.format]} ${f.usable} usable + ${f.pending} pending of ${f.target}${f.need ? ` (needs ${f.need})` : ""}`).join(", ")}`);
    }
    const plan = await ct.planPillarRefills(e.id, { ignoreCooldown: true });
    if (plan.wholeBankActive) { console.log("  a whole-bank refresh is already queued or running: it covers every pillar, nothing queued"); continue; }
    for (const r of plan.plans) console.log(`  ${r.skip ? "skip" : APPLY ? "queue" : "would queue"}: ${r.reason}, keep ${r.need}${r.skip ? ` (${r.skip})` : ""}`);
    if (!plan.plans.some((r) => !r.skip)) console.log("  every pillar is at target in both formats: nothing to queue");
    if (!APPLY) continue;
    const res = await ct.queuePillarRefills(e.id, { requestedBy: BY, ignoreCooldown: true });
    queued += res.queued;
    for (const r of res.plans.filter((x) => x.runId)) console.log(`  ${r.joined ? "joined" : "queued"} run ${r.runId}: ${r.reason}`);
  }
  console.log(APPLY ? `\ndone: ${marked} topic(s) marked Talking to camera, ${queued} refill run(s) queued. The 15-minute AI job runs them two at a time.` : "\ndry run: nothing written. Add --apply to mark and queue.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
