// ---------------------------------------------------------------------------
// DRILL: is everything owed actually in the client's library? (Oct 15 2026)
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct15-library-check.ts
//
// Marcee McMullen's portal library was missing videos: her August listing held
// six videos (four tips re-delivered as "… V2", "Car Video", "Why I Love Bow
// Tree") while her library had four rows on the OLD index keys, still playing
// the first versions.
//
//   1. The re-edit match (pure): exactly the row's title plus a version suffix.
//   2. The sync, switch OFF (the default): nothing re-pointed, each one
//      reported; what the listing holds is kept for the nightly check.
//   3. The nightly check: a month whose library does not match its listing is
//      raised with what is missing, said plainly; a month short by count names
//      the approved cut not published and the video with no cut; months not
//      due yet are left alone; the 3-day sweep does not run it, the daily does.
//   4. The exceptions board shows it, reading no provider.
//   5. Switch ON: a replaced row is re-pointed (key, title, links), never
//      duplicated; a row whose re-edit already has its own row is retired by
//      key, not deleted; two candidates are left alone.
//   6. The record clears itself when the month is whole.
//
// ISOLATION: PGlite via the shared harness; Aryeo's listing read answered
// in-process (a GET only; nothing is written to Aryeo).
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7163);
installNextStubs();

type FakeVideo = { id: string; title: string; playback_url: string; download_url: string; thumbnail_url: string };
const listings = new Map<string, FakeVideo[]>();
const listingReads: string[] = [];
const writes: string[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://api.aryeo.com/v1/")) return null;
  if ((init?.method ?? "GET") !== "GET") { writes.push(url); return json({ error: "drill: no writes" }); }
  const m = /\/listings\/([^/?]+)/.exec(url);
  if (!m) return json({ data: [] });
  listingReads.push(m[1]);
  return json({ data: { id: m[1], delivery_status: "DELIVERED", videos: listings.get(m[1]) ?? [], images: [], floor_plans: [] } });
});
const v = (listing: string, n: string, title: string): FakeVideo => ({ id: `${listing}-vid-${n}`, title, playback_url: `https://cdn.invalid/${listing}/${n}.m3u8`, download_url: `https://cdn.invalid/${listing}/${n}.mp4`, thumbnail_url: `https://cdn.invalid/${listing}/${n}.jpg` });
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("aryeo", "drill-aryeo-key-not-real");
  const lib = await import("@/lib/portalLibrary");
  const pw = await import("@/lib/programWatch");
  const NOW = new Date("2026-10-15T14:00:00Z");

  // =========================================================================
  c.head("1 · The re-edit match");
  // =========================================================================
  const mk = (title: string, id = title) => ({ id, title, playback: "p", download: "d" });
  c.ok("\"Tip #1\" → \"Tip #1 V2\"", lib.reEditsOf("Tip #1", [mk("Tip #1 V2"), mk("Car Video")]).length === 1);
  c.ok("…and \"v2\", \"(2)\", \"- V3\" count as version suffixes", ["Tip #1 v2", "Tip #1 (2)", "Tip #1 - V3"].every((t) => lib.reEditsOf("Tip #1", [mk(t)]).length === 1));
  c.ok("\"Tip #1 V1\" → \"Tip #1 V2\"", lib.reEditsOf("Tip #1 V1", [mk("Tip #1 V2")]).length === 1);
  c.ok("not \"Tip #10 V2\", not a same-title file with no suffix, not a video with no id", lib.reEditsOf("Tip #1", [mk("Tip #10 V2"), mk("Tip #1"), { id: null, title: "Tip #1 V2", playback: "p", download: "d" }]).length === 0);
  c.ok("two re-edits of one title are both returned (the caller then leaves it alone)", lib.reEditsOf("Tip #5", [mk("Tip #5 V2"), mk("Tip #5 (2)")]).length === 2);

  // =========================================================================
  c.head("2 · The sync, re-point switch OFF (the default)");
  // =========================================================================
  const client = await prisma.client.create({ data: { name: "Mara Quinn", socialClient: true }, select: { id: true } });
  const en = await prisma.contentEnrollment.create({ data: { clientId: client.id, status: "ACTIVE", package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, startedAt: new Date("2026-06-01T12:00:00Z") }, select: { id: true } });
  const aug = await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: client.id, monthKey: "2026-08", videosOwed: 4 }, select: { id: true } });
  const L1 = "019f6bb4-aaaa";
  const augJob = await prisma.project.create({ data: { clientId: client.id, title: "Mara Quinn August content", status: "DELIVERED", contentMonthId: aug.id, shootDate: new Date("2026-08-04T14:00:00Z"), deliveredAt: new Date("2026-08-20T15:00:00Z"), promisedDueAt: new Date("2026-08-18T21:00:00Z"), aryeoListingId: L1 }, select: { id: true } });
  const augD = await prisma.deliverable.create({ data: { projectId: augJob.id, type: "SOCIAL_REEL", label: "Video Accelerator", quantity: 4 }, select: { id: true } });
  const tips = ["Fairy God Realtor Tip #1", "Fairy God Realtor Tip #2", "Fairy God Realtor Tip #3", "Fairy God Realtor Tip #4"];
  for (let i = 0; i < 4; i++) {
    const out = await prisma.deliverableOutput.create({ data: { deliverableId: augD.id, projectId: augJob.id, slot: i + 1, category: "VIDEO", title: tips[i] }, select: { id: true } });
    // The library as it stood: the OLD index key, the FIRST version's links.
    const pv = await prisma.portalVideo.create({ data: { enrollmentId: en.id, monthId: aug.id, projectId: augJob.id, title: tips[i], playback: `https://cdn.invalid/${L1}/old-${i}.m3u8`, download: `https://cdn.invalid/${L1}/old-${i}.mp4`, source: "aryeo", externalKey: `aryeo:${L1}:${i}`, deliveredAt: new Date("2026-08-20T15:00:00Z") }, select: { id: true, externalKey: true } });
    const cv = await prisma.contentVideo.create({ data: { enrollmentId: en.id, clientId: client.id, monthId: aug.id, monthKey: "2026-08", kind: "PROGRAM", title: tips[i], status: "DELIVERED", deliveredAt: new Date("2026-08-20T15:00:00Z"), outputId: out.id, projectId: augJob.id }, select: { id: true } });
    await prisma.contentVideoSource.create({ data: { videoId: cv.id, kind: "PORTAL_VIDEO", ref: pv.externalKey, portalVideoId: pv.id } });
  }
  listings.set(L1, [...tips.map((t, i) => v(L1, `t${i + 1}`, `${t} V2`)), v(L1, "car", "Car Video"), v(L1, "bow", "Why I Love Bow Tree")]);
  const rowsBefore = await prisma.portalVideo.findMany({ where: { enrollmentId: en.id }, orderBy: { externalKey: "asc" } });
  const s1 = await lib.syncEnrollmentLibrary(en.id);
  const rep = s1.repoints ?? [];
  c.ok("each replaced row is reported as \"would re-point\" to its V2, and nothing is re-pointed", rep.length === 4 && rep.every((r) => r.action === "would-repoint" && / V2$/.test(r.toTitle ?? "")), JSON.stringify(rep.map((r) => [r.title, r.action, r.toTitle])));
  const oldRows = await prisma.portalVideo.findMany({ where: { id: { in: rowsBefore.map((r) => r.id) } } });
  c.ok("…the old rows are untouched (key, title, links)", oldRows.every((r) => rowsBefore.some((b) => b.id === r.id && b.externalKey === r.externalKey && b.title === r.title && b.playback === r.playback)));
  const cache = await prisma.appSetting.findUnique({ where: { key: `${lib.LISTING_MEDIA_PREFIX}${L1}` } });
  const cached = cache ? JSON.parse(cache.value) as { videos: { id: string; title: string }[]; repoints: unknown[] } : null;
  c.ok("what the listing holds is kept for the nightly check (6 videos, 4 reports)", cached?.videos.length === 6 && cached.repoints.length === 4);

  // October: due, short by count. One approved cut not published, one with no cut.
  const oct = await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: client.id, monthKey: "2026-10", videosOwed: 2 }, select: { id: true } });
  const octJob = await prisma.project.create({ data: { clientId: client.id, title: "Mara Quinn October content", status: "EDITING", contentMonthId: oct.id, shootDate: new Date("2026-09-28T14:00:00Z"), promisedDueAt: new Date("2026-10-12T21:00:00Z"), deliveryDue: new Date("2026-10-12T21:00:00Z") }, select: { id: true } });
  const octD = await prisma.deliverable.create({ data: { projectId: octJob.id, type: "SOCIAL_REEL", label: "Video Starter", quantity: 2 }, select: { id: true } });
  const ok1 = await prisma.deliverableOutput.create({ data: { deliverableId: octD.id, projectId: octJob.id, slot: 1, category: "VIDEO", title: "Market Minute" }, select: { id: true } });
  const ok2 = await prisma.deliverableOutput.create({ data: { deliverableId: octD.id, projectId: octJob.id, slot: 2, category: "VIDEO", title: "Open House Tips" }, select: { id: true } });
  await prisma.reviewSubmission.create({ data: { projectId: octJob.id, deliverableId: octD.id, slot: 1, round: 1, kind: "video", status: "APPROVED", fileName: "market-minute.mp4", decidedAt: new Date("2026-10-09T15:00:00Z") } });
  // November: not due (its promise is ahead).
  const nov = await prisma.contentMonth.create({ data: { enrollmentId: en.id, clientId: client.id, monthKey: "2026-11", videosOwed: 2 }, select: { id: true } });
  const novJob = await prisma.project.create({ data: { clientId: client.id, title: "Mara Quinn November content", status: "SCHEDULED", contentMonthId: nov.id, shootDate: new Date("2026-11-02T14:00:00Z"), promisedDueAt: new Date("2026-11-16T22:00:00Z"), deliveryDue: new Date("2026-11-16T22:00:00Z") }, select: { id: true } });
  const novD = await prisma.deliverable.create({ data: { projectId: novJob.id, type: "SOCIAL_REEL", label: "Video Starter", quantity: 2 }, select: { id: true } });
  await prisma.deliverableOutput.create({ data: { deliverableId: novD.id, projectId: novJob.id, slot: 1, category: "VIDEO" } });

  // =========================================================================
  c.head("3 · The nightly check");
  // =========================================================================
  const r1 = await lib.checkLibraryCompleteness({ now: NOW });
  const recOf = async (monthId: string) => {
    const row = await prisma.appSetting.findUnique({ where: { key: `${lib.LIBRARY_SHORT_PREFIX}${monthId}` } });
    return row ? (JSON.parse(row.value) as import("@/lib/portalLibrary").LibraryShortRecord) : null;
  };
  const augRec = await recOf(aug.id);
  console.log(`\n--- August ---\n${augRec?.missing.join("\n")}\n---`);
  c.ok("August: 4 owed, 4 in the library, but it does not match the listing: raised", !!augRec && augRec.short === 0 && augRec.due === 4 && augRec.inLibrary === 4 && !augRec.resolvedAt);
  c.ok("…naming the two videos the client cannot see", !!augRec?.missing.some((l) => /"Car Video" is on the Aryeo listing but not on the client's library page yet/.test(l)) && augRec?.missing.some((l) => /"Why I Love Bow Tree"/.test(l)));
  c.ok("…and each tip still playing its first version, with its re-edit named", tips.every((t) => augRec?.missing.some((l) => l.startsWith(`"${t}" still plays the old file; the listing now has "${t} V2"`))));
  c.ok("…said once each (a V2 is not also reported as missing)", !augRec?.missing.some((l) => /Tip #1 V2" is on the Aryeo listing/.test(l)));
  const octRec = await recOf(oct.id);
  console.log(`\n--- October ---\n${octRec?.missing.join("\n")}\n---`);
  c.ok("October: due (promise passed), 2 owed, 0 in the library, short by 2", octRec?.short === 2 && octRec.due === 2 && octRec.inLibrary === 0);
  c.ok("…the approved cut not published, and the video with no cut, in plain words", !!octRec?.missing.some((l) => /^"Market Minute" was approved on Fri, Oct 9 and is not published to the library$/.test(l)) && octRec?.missing.some((l) => /^"Open House Tips" has no cut yet$/.test(l)), JSON.stringify(octRec?.missing));
  c.ok("November (not due) is left alone", !(await recOf(nov.id)));
  c.ok("no dashes in anything raised", !DASH.test(JSON.stringify([augRec?.missing, octRec?.missing])));
  c.ok("the check counted what it raised", r1.raised === 2 && r1.short === 1, JSON.stringify(r1));
  const readsBefore = listingReads.length;
  const sweep3 = await lib.sweepPortalLibraries({ days: 3 });
  c.ok("the hourly 3-day sweep does not run the check", !("completeness" in sweep3));
  const sweep60 = await lib.sweepPortalLibraries({ days: 60 });
  c.ok("the once-a-day 60-day sweep does, after re-reading the recent listing", !!sweep60.completeness && !("error" in sweep60.completeness) && listingReads.length > readsBefore, JSON.stringify(sweep60));

  // =========================================================================
  c.head("4 · The exceptions board");
  // =========================================================================
  const { opsExceptionsBoard, EXCEPTION_LABEL } = await import("@/lib/opsExceptions");
  const readsAt = listingReads.length;
  const board = await opsExceptionsBoard({ now: NOW });
  const rows = board.rows.filter((r) => r.kind === "library-missing");
  console.log(rows.map((r) => `${r.severity} ${r.title}: ${r.why}`).join("\n"));
  c.ok("both months are on Kyle's board as \"Video missing from the client's library\"", rows.length === 2 && EXCEPTION_LABEL["library-missing"] === "Video missing from the client's library" && board.totals["library-missing"].all === 2);
  c.ok("…October, short, is HIGH and says it in one line", rows.some((r) => r.severity === "high" && /^October: 2 owed, 0 in the library\. "Market Minute" was approved/.test(r.why)));
  c.ok("…August says the library does not match the listing", rows.some((r) => /^August: the library does not match the listing\./.test(r.why)));
  c.ok("…linking to the client's videos, owned by Kyle", rows.every((r) => r.owner === "Kyle" && r.href === `/content/${en.id}?tab=production&view=videos`));
  c.ok("…and the board read no provider", listingReads.length === readsAt);

  // =========================================================================
  c.head("5 · Re-point switch ON");
  // =========================================================================
  await pw.saveProgramWatchRules({ libraryRepoint: true }, "drill");
  // A second client whose library has NOT been synced since the re-edit.
  const c2 = await prisma.client.create({ data: { name: "Nia Brooks", socialClient: true }, select: { id: true } });
  const en2 = await prisma.contentEnrollment.create({ data: { clientId: c2.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-06-01T12:00:00Z") }, select: { id: true } });
  const m2 = await prisma.contentMonth.create({ data: { enrollmentId: en2.id, clientId: c2.id, monthKey: "2026-09", videosOwed: 2 }, select: { id: true } });
  const L2 = "019f6bb4-bbbb";
  const j2 = await prisma.project.create({ data: { clientId: c2.id, title: "Nia Brooks September content", status: "DELIVERED", contentMonthId: m2.id, deliveredAt: new Date("2026-09-25T15:00:00Z"), aryeoListingId: L2 }, select: { id: true } });
  const mkRow = (i: number, title: string) => prisma.portalVideo.create({ data: { enrollmentId: en2.id, monthId: m2.id, projectId: j2.id, title, playback: `https://cdn.invalid/${L2}/old-${i}.m3u8`, download: `https://cdn.invalid/${L2}/old-${i}.mp4`, source: "aryeo", externalKey: `aryeo:${L2}:${i}`, deliveredAt: new Date("2026-09-25T15:00:00Z") }, select: { id: true } });
  const nRow = await mkRow(0, "Neighborhood Walk");
  const fRow = await mkRow(1, "First Time Buyer");
  listings.set(L2, [v(L2, "n2", "Neighborhood Walk V2"), v(L2, "f2", "First Time Buyer V2"), v(L2, "f3", "First Time Buyer (2)")]);
  const s2 = await lib.syncEnrollmentLibrary(en2.id);
  const n = await prisma.portalVideo.findUnique({ where: { id: nRow.id } });
  c.ok("a replaced row is re-pointed: the re-edit's key, title and links", n?.externalKey === `aryeo:${L2}:${L2}-vid-n2` && n.title === "Neighborhood Walk V2" && n.playback === `https://cdn.invalid/${L2}/n2.m3u8` && n.download === `https://cdn.invalid/${L2}/n2.mp4`, JSON.stringify(n));
  c.ok("…and the sync did not mint the re-edit a second time beside it", (await prisma.portalVideo.count({ where: { enrollmentId: en2.id, title: "Neighborhood Walk V2" } })) === 1);
  const f = await prisma.portalVideo.findUnique({ where: { id: fRow.id } });
  c.ok("two re-edits of one title: left alone and reported", f?.externalKey === `aryeo:${L2}:1` && (s2.repoints ?? []).some((r) => r.title === "First Time Buyer" && r.action === "left-alone" && /2 re-edits/.test(r.why)), JSON.stringify(s2.repoints));
  const countBefore = await prisma.portalVideo.count({ where: { enrollmentId: en.id } });
  const s3 = await lib.syncEnrollmentLibrary(en.id);
  const retired = await prisma.portalVideo.findMany({ where: { id: { in: rowsBefore.map((r) => r.id) } } });
  c.ok("Mara's tips, whose V2s already have their own rows: the old rows are retired by key, not deleted", retired.length === 4 && retired.every((r) => r.externalKey.startsWith(`retired:aryeo:${L1}:`)) && (await prisma.portalVideo.count({ where: { enrollmentId: en.id } })) === countBefore && (s3.repoints ?? []).filter((r) => r.action === "retired").length === 4, JSON.stringify(s3.repoints?.map((r) => r.action)));
  c.ok("nothing was ever written to Aryeo", writes.length === 0);

  // =========================================================================
  c.head("6 · The record clears itself");
  // =========================================================================
  for (const [o, title] of [[ok1.id, "Market Minute"], [ok2.id, "Open House Tips"]] as const) {
    await prisma.contentVideo.create({ data: { enrollmentId: en.id, clientId: client.id, monthId: oct.id, monthKey: "2026-10", kind: "PROGRAM", title, status: "CLIENT_REVIEW", releasedToClientAt: new Date("2026-10-15T12:00:00Z"), outputId: o, projectId: octJob.id } });
  }
  await lib.checkLibraryCompleteness({ now: NOW });
  const octAfter = await recOf(oct.id);
  c.ok("October is whole: its record is resolved (kept, not deleted)", !!octAfter?.resolvedAt);
  const open = await lib.openLibraryShortRecords();
  c.ok("…and off the open list", !open.some((r) => r.monthId === oct.id));

  c.ok("the fence held (only the faked listing reads)", fence.blocked.length === 0, fence.blocked.join(", "));
  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
