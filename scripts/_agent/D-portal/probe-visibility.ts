// READ-ONLY probe. Group D, directive 1. Three questions:
//  1. If scriptForEnrollment swaps CLIENT_VISIBLE_SCRIPT for scriptVisibility,
//     does any client LOSE access to a script they can legitimately read today?
//  2. How many released scripts are unreachable from any ContentVideo (the
//     reason the portal's "your script is ready" promise is currently untrue)?
//  3. How many topics carry a script — the bound on the per-topic resolve.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const OLD = ["CLIENT_VISIBLE", "READY_TO_FILM", "FILMED", "DELIVERED"]; // post-1b24065
const OLD_PRE = ["APPROVED", ...OLD]; // pre-1b24065, for reference

function scriptVisibility(s: { status: string; releaseState: string | null; historical: boolean }) {
  if (s.releaseState === "withheld") return null;
  if (s.releaseState === "released") return "released";
  if (s.releaseState === "historical" || s.historical) return "historical";
  return OLD.includes(s.status) ? "released" : null;
}

async function main() {
  const rows = await prisma.contentScript.findMany({
    select: { id: true, enrollmentId: true, clientId: true, topicId: true, videoId: true, status: true, releaseState: true, historical: true, sharedVersionId: true, approvedVersionId: true, currentVersionId: true, title: true },
  });
  console.log(`ContentScript rows total: ${rows.length}`);

  const byState = new Map<string, number>();
  for (const r of rows) {
    const k = `${r.releaseState ?? "null"} / ${r.status} / hist=${r.historical}`;
    byState.set(k, (byState.get(k) ?? 0) + 1);
  }
  console.log("\n-- releaseState / status / historical --");
  for (const [k, v] of [...byState].sort((a, b) => b[1] - a[1])) console.log(`  ${v.toString().padStart(4)}  ${k}`);

  // Q1: the gate swap on scriptForEnrollment.
  let lose = 0, gain = 0, same = 0;
  const loseRows: typeof rows = [];
  const gainRows: typeof rows = [];
  for (const r of rows) {
    const old = OLD.includes(r.status);
    const neu = scriptVisibility(r) !== null;
    if (old && !neu) { lose++; loseRows.push(r); }
    else if (!old && neu) { gain++; gainRows.push(r); }
    else same++;
  }
  console.log(`\n-- scriptForEnrollment gate swap (CLIENT_VISIBLE_SCRIPT -> scriptVisibility) --`);
  console.log(`  unchanged: ${same}`);
  console.log(`  WOULD LOSE access: ${lose}`);
  for (const r of loseRows.slice(0, 20)) console.log(`    ${r.id} status=${r.status} releaseState=${r.releaseState} hist=${r.historical} "${r.title.slice(0, 50)}"`);
  console.log(`  would GAIN access: ${gain}`);
  const gainByReason = new Map<string, number>();
  for (const r of gainRows) { const k = `${r.releaseState ?? "null"}/hist=${r.historical}`; gainByReason.set(k, (gainByReason.get(k) ?? 0) + 1); }
  for (const [k, v] of [...gainByReason].sort((a, b) => b[1] - a[1])) console.log(`    ${v.toString().padStart(4)}  ${k}`);

  // Same question against the PRE-1b24065 list, so "loses access today" is
  // judged against what a client could actually reach before this run began.
  let losePre = 0;
  for (const r of rows) if (OLD_PRE.includes(r.status) && scriptVisibility(r) === null) losePre++;
  console.log(`  (vs the pre-Sep-18 list incl. APPROVED: would lose ${losePre})`);

  // Q2: released scripts, and whether anything renders them today.
  const released = rows.filter((r) => scriptVisibility(r) === "released");
  const historical = rows.filter((r) => scriptVisibility(r) === "historical");
  console.log(`\n-- verdicts over all rows --`);
  console.log(`  released: ${released.length}   historical: ${historical.length}   invisible: ${rows.length - released.length - historical.length}`);
  console.log(`  released WITH a topicId: ${released.filter((r) => r.topicId).length}`);
  console.log(`  released with NO version row id at all: ${released.filter((r) => !r.sharedVersionId && !r.approvedVersionId && !r.currentVersionId).length}`);

  const videos = await prisma.contentVideo.findMany({ select: { id: true, topicId: true, scriptId: true, enrollmentId: true } });
  console.log(`\n-- ContentVideo reachability (the only body renderer today) --`);
  console.log(`  ContentVideo rows: ${videos.length}; with topicId: ${videos.filter((v) => v.topicId).length}; with scriptId: ${videos.filter((v) => v.scriptId).length}`);
  const reach = (r: (typeof rows)[number]) => videos.filter((v) => v.enrollmentId === r.enrollmentId && ((r.videoId && v.id === r.videoId) || v.scriptId === r.id || (r.topicId && v.topicId === r.topicId))).length;
  const unreachable = released.filter((r) => reach(r) === 0);
  console.log(`  released scripts reachable by ZERO videos: ${unreachable.length} of ${released.length}`);
  for (const r of unreachable.slice(0, 10)) console.log(`    ${r.id} topic=${r.topicId} "${r.title.slice(0, 50)}"`);
  const histUnreachable = historical.filter((r) => reach(r) === 0);
  console.log(`  historical scripts reachable by ZERO videos: ${histUnreachable.length} of ${historical.length}`);

  // Q3: how many topics per enrollment carry any script at all (bounds the
  // per-topic resolve loop portalTopics will run).
  const perEnroll = new Map<string, Set<string>>();
  for (const r of rows) if (r.topicId) {
    const s = perEnroll.get(r.enrollmentId) ?? new Set<string>();
    s.add(r.topicId);
    perEnroll.set(r.enrollmentId, s);
  }
  const sizes = [...perEnroll.values()].map((s) => s.size).sort((a, b) => b - a);
  console.log(`\n-- topics carrying a script, per enrollment --`);
  console.log(`  enrollments with any: ${sizes.length}; max ${sizes[0] ?? 0}; total ${sizes.reduce((a, b) => a + b, 0)}`);
  console.log(`  sizes: ${sizes.join(", ")}`);

  // Q4: mismatched client scoping — does any script's clientId differ from its enrollment's?
  const enrolls = await prisma.contentEnrollment.findMany({ select: { id: true, clientId: true } });
  const clientOf = new Map(enrolls.map((e) => [e.id, e.clientId]));
  const misScoped = rows.filter((r) => clientOf.has(r.enrollmentId) && clientOf.get(r.enrollmentId) !== r.clientId);
  console.log(`\n-- scripts whose clientId != their enrollment's clientId: ${misScoped.length}`);
  for (const r of misScoped.slice(0, 10)) console.log(`    ${r.id} enroll=${r.enrollmentId} script.client=${r.clientId} enroll.client=${clientOf.get(r.enrollmentId)}`);
}
main().finally(() => prisma.$disconnect());
