export {};
// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, content audit H4): Joe Sutow's October videos
// never count. The call's four topics had their selections removed (the hub's
// drafts stepped aside for the scripts Jordan uploaded on Oct 13) but stayed on
// the month as SCRIPTED with no script. The four uploaded picks were made while
// those four were still on the month, so they were stored as extras, and the
// upload portal made all four filmed videos EXTRA: the month reads "0 of 4
// delivered".
//
// With the app's own functions, in this order:
//   1. contentTopics.deselectTopic for each of the call's four topics: back to
//      the bank (SAVED, no month), on each topic's history;
//   2. contentTopics.reconcileMonthExtras for October: the four real picks lose
//      the extra flag, and the four videos the upload portal made EXTRA because
//      of it become PROGRAM videos that count (on each video's history);
//   3. any of the four videos still not counted after that (a person had
//      mapped it): contentVideos.correctVideoIdentity → PROGRAM.
// The dry run reads the same facts and prints what each step would do.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-joe-october.ts           # dry run (read-only)
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct22-audit-joe-october.ts --apply   # writes
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";
import { installNextStubs } from "../_drill/_harness";
installNextStubs();

const MONTH = "cmup0bq4q00qjjg04tb2fqhri"; // Joe Sutow, 2026-10
const DROPPED = ["cmv5ch7ux002g9kf4kvqeochv", "cmv5ch8lc002k9kf42iggnqvw", "cmv5ch96h002o9kf4a7arjz0y", "cmv5ch9m7002s9kf446iqj88w"];
const REAL_SELECTIONS = ["cmv6sgs89000el206brf3exrg", "cmv6sgsdf000ll206mkgma3r9", "cmv6sgsgt000sl206qr3fea6c", "cmv6sgsjt000zl206925p2ogl"];
const VIDEOS = ["cmv7ew3zh0009jo068l61k8sx", "cmv7ew406000ajo06u5rg4bxo", "cmv7ew40i000bjo06lebdar8g", "cmv7ew40t000cjo06xtr8kb6s"];
const BY = "info@realtourpilot.com";

async function main() {
  const prisma = await db();
  const month = await prisma.contentMonth.findUniqueOrThrow({ where: { id: MONTH }, select: { id: true, monthKey: true, enrollmentId: true, videosOwed: true } });
  const client = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: month.enrollmentId }, select: { clientId: true } }).then((e) => prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }));
  console.log(`${client?.name} · ${month.monthKey} · owes ${month.videosOwed}`);

  // 1 · the call's four topics.
  console.log("1 · the call's four topics back to the bank (deselectTopic):");
  for (const id of DROPPED) {
    const t = await prisma.contentTopic.findUniqueOrThrow({ where: { id }, select: { title: true, status: true, monthId: true } });
    const sel = await prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: id, monthId: MONTH } }, select: { status: true, removedReason: true } });
    const [script, footage, anyScript] = await Promise.all([
      prisma.contentScript.findFirst({ where: { topicId: id, monthId: MONTH, historical: false }, select: { id: true } }),
      prisma.contentVideo.findFirst({ where: { topicId: id, monthId: MONTH }, select: { id: true } }),
      prisma.contentScript.findFirst({ where: { topicId: id, historical: false }, select: { id: true } }),
    ]);
    const blocked = sel?.status !== "PROPOSED" && (script || footage);
    const after = t.monthId === MONTH ? (anyScript ? "stays SCRIPTED, month cleared" : "SAVED, month cleared") : "pointer already elsewhere";
    console.log(`   ${id} "${t.title}" · ${t.status} on ${t.monthId === MONTH ? "October" : t.monthId ?? "no month"} · selection ${sel?.status ?? "none"} (${sel?.removedReason ?? "-"}) → ${blocked ? "REFUSED (a script or footage on October)" : after}`);
  }

  // 2 · the allowance once they are gone, by the one rule (planningState.allowanceOrder).
  const { monthAllowances } = await import("../../src/lib/planningFacts");
  const { allowanceOrder } = await import("../../src/lib/planningState");
  const a = (await monthAllowances([MONTH])).get(MONTH)!;
  const nowSlots = a.slots;
  const thenSlots = allowanceOrder(a.entries.filter((e) => !DROPPED.includes(e.topicId)), month.videosOwed);
  const sels = await prisma.contentTopicSelection.findMany({ where: { id: { in: REAL_SELECTIONS } }, select: { id: true, topicId: true, overflow: true, rank: true } });
  console.log(`2 · the extra flag (reconcileMonthExtras): today the month reads ${[...nowSlots.values()].filter((s) => s === "IN").length} in, ${[...nowSlots.values()].filter((s) => s === "EXTRA").length} extra (the four removed topics still count as picks by their month pointer)`);
  for (const s of sels) console.log(`   selection ${s.id} rank ${s.rank} · stored extra=${s.overflow} → ${thenSlots.get(s.topicId) === "EXTRA" ? "stays extra" : "extra cleared"}`);
  const vids = await prisma.contentVideo.findMany({ where: { id: { in: VIDEOS } }, select: { id: true, title: true, kind: true, countsTowardAllowance: true, mappedBy: true, selectionId: true, status: true } });
  for (const v of vids) {
    const viaFlag = v.kind === "EXTRA" && !v.countsTowardAllowance && !v.mappedBy && REAL_SELECTIONS.includes(v.selectionId ?? "");
    console.log(`   video ${v.id} "${v.title}" · ${v.status} · ${v.kind}, counts=${v.countsTowardAllowance}, mapped by ${v.mappedBy ?? "nobody"} → ${v.kind === "PROGRAM" && v.countsTowardAllowance ? "already counted" : viaFlag ? "PROGRAM, counted (with its pick)" : "PROGRAM, counted (step 3, correctVideoIdentity)"}`);
  }
  const counted = await prisma.contentVideo.count({ where: { monthId: MONTH, countsTowardAllowance: true, status: { not: "ARCHIVED" } } });
  console.log(`   October counts ${counted} program video(s) today; ${counted + vids.filter((v) => !v.countsTowardAllowance).length} after.`);
  if (!APPLY) process.exit(0);

  const { deselectTopic, reconcileMonthExtras } = await import("../../src/lib/contentTopics");
  for (const id of DROPPED) {
    await deselectTopic(id, MONTH, { kind: "STAFF", staffUserId: BY });
    console.log(`   back in the bank: ${id}`);
  }
  const r = await reconcileMonthExtras(MONTH, { by: BY });
  console.log(`   extras reconciled: cleared ${r.cleared.length}, marked ${r.marked.length}, videos counted ${r.videos.length}`);
  const { correctVideoIdentity } = await import("../../src/lib/contentVideos");
  for (const v of await prisma.contentVideo.findMany({ where: { id: { in: VIDEOS } }, select: { id: true, kind: true, countsTowardAllowance: true } })) {
    if (v.kind === "PROGRAM" && v.countsTowardAllowance) continue;
    const x = await correctVideoIdentity(month.enrollmentId, v.id, { kind: "PROGRAM" }, BY, "One of October's four program videos (content audit H4, Oct 22 2026)");
    console.log(`   ${v.id}: ${x.message}`);
  }
  const after = await prisma.contentVideo.count({ where: { monthId: MONTH, countsTowardAllowance: true, status: { not: "ARCHIVED" } } });
  console.log(`October now counts ${after} program video(s).`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
