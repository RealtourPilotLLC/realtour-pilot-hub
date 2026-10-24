// Oct 24 2026: THE ARYEO LISTING MEDIA INDEX (Jordan: "we should have a lot
// more premium videos and monthly social content in the gallery"). Proves, on
// a disposable PGlite with Aryeo faked at the network fence:
//   §1 the listing's media shape → index rows (ids, Aryeo's own urls, no
//      invented title or url, a video with no id or no file left out, the
//      cover, UUIDv7 times), and the diff (create / update / remove / restore);
//   §2 the one-time backfill: idle until started; a small batch a tick, one
//      read at a time, spaced; resumable from its cursor; a 429 waits a
//      minute, doubling, with no read meanwhile; a 404 is skipped; a failing
//      listing is retried, then skipped; one tick at a time (the lease); a
//      pause written mid-tick wins; it writes only the index and its own row;
//   §3 kept current: the listing reads the hub already makes (the status
//      pass, Ready to send's re-read) upsert the same rows; media taken off a
//      listing is marked removed and leaves the library, and comes back;
//   §4 the library: every older video on its tab and group by the job's own
//      video types; no duplicates against the hub's files (Aryeo id via the
//      upload receipt, title + length, every owed video already the hub's)
//      or the portal's rows; a shared listing once; test, cancelled and
//      undelivered jobs left out; Aryeo's title and poster; no Aryeo call;
//   §5 covers fill the Photos tab and /listings;
//   §6 the file door /api/media/aryeo/<row>: staff only, Watch → Aryeo's
//      file, Download → the staff proxy, a removed video 404s, nothing written.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { buildIndexWorld, listing, video } from "./_fixtures/listingMediaIndex";

const jar = installNextStubs();
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

// ---- the fake Aryeo: listing reads only, scripted refusals ----
let LISTINGS: Record<string, unknown> = {};
const calls: { id: string; at: number }[] = [];
const script: { tooMany: number; netFail: Set<string>; onRead?: (id: string) => Promise<void> } = { tooMany: 0, netFail: new Set() };
const fence = fenceFetch(async (url) => {
  const m = /^https:\/\/api\.aryeo\.com\/v1\/listings\/([^?/]+)/.exec(url);
  if (!m) return null;
  const id = decodeURIComponent(m[1]);
  calls.push({ id, at: Date.now() });
  if (script.onRead) await script.onRead(id);
  if (script.tooMany > 0) { script.tooMany--; return json({ message: "Too Many Attempts." }, 429); }
  if (script.netFail.has(id)) throw new TypeError("fetch failed (drill: the network dropped)");
  if (id === "L-GONE") return json({ message: "Not Found" }, 404);
  const l = LISTINGS[id];
  return json({ data: l ?? { id, delivery_status: "DELIVERED", images: [], videos: [], floor_plans: [], interactive_content: [], files: [] } });
});

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 4741), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct24-listing-media-index" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { SESSION_COOKIE } = await import("@/lib/auth/jwt");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", "drill-key-not-a-real-one");
    const core = await import("@/lib/listingMediaCore");
    const ix = await import("@/lib/listingMediaIndex");
    const lib = await import("@/lib/mediaLibrary");
    const T = new Date();
    const w = await buildIndexWorld(prisma, T);
    LISTINGS = w.LISTINGS;

    // =====================================================================
    c.head("§1 · a listing read → index rows");
    // =====================================================================
    const readA = core.listingIndexOf(LISTINGS["L-A"] as Record<string, unknown>, T);
    const a1 = readA.videos?.[0];
    c.ok("two videos, by Aryeo's id, title and length as Aryeo gives them", readA.videos?.length === 2 && a1?.aryeoMediaId === w.id.a1 && a1.title === "Premium Social Media Reel" && a1.durationSec === 61 && readA.videos?.[1].title === "Premium Social Media Reel (REVISED)");
    c.ok("…Aryeo's own file, stream and poster, kept exactly (unsigned, no expiry)", a1?.downloadUrl === `https://videos.aryeo.com/listings/b92b4dd7-9846-4be3-8e8e-4677bcf3aec9/${w.id.a1}.mp4` && a1.playbackUrl === `https://stream.mux.com/${w.id.a1}` && a1.thumbnailUrl === `https://image.mux.com/${w.id.a1}/thumbnail.png?width=800&height=450&smart_crop=true&time=1`);
    c.ok("the cover is the listing's own image (the second here), with the gallery count", readA.cover?.aryeoMediaId === "img-100-old-premium-rd-2" && readA.cover.thumbnailUrl === "https://cdn.aryeo.com/listings/100-old-premium-rd/resized/thumbnail/thumbnail-img-2.jpeg" && readA.cover.photoCount === 5 && readA.cover.downloadUrl === "https://cdn.aryeo.com/listings/100-old-premium-rd/img-2.jpeg");
    const readF = core.listingIndexOf(LISTINGS["L-F"] as Record<string, unknown>, T);
    c.ok("a video with no id, or with no file to watch, is left out (never keyed by position)", readF.videos?.length === 1 && readF.videos[0].aryeoMediaId === w.id.f1);
    const readG = core.listingIndexOf(LISTINGS["L-G"] as Record<string, unknown>, T);
    c.ok("an untitled video keeps no title (none is invented)", readG.videos?.[1].title === null);
    const readH = core.listingIndexOf(LISTINGS["L-H"] as Record<string, unknown>, T);
    c.ok("a UUIDv7 id dates the video (when it went up); an older id carries no time", Math.abs((readH.videos?.[1].deliveredAt?.getTime() ?? 0) - (T.getTime() - 18 * D)) < 1000 && a1?.deliveredAt === null && core.uuidV7Time("not-a-uuid") === null);
    c.ok("orientation only when the title says it", core.listingIndexOf(LISTINGS["L-C"] as Record<string, unknown>, T).videos?.[1].orientation === "vertical" && a1?.orientation === null && core.orientationFromTitle("Horizontal (Website)") === "horizontal");
    c.ok("a read without a videos array is unknown, not empty; no images array: cover unknown", core.listingIndexOf({ id: "x" }).videos === null && core.listingIndexOf({ id: "x" }).cover === undefined && core.listingIndexOf({ id: "x", images: [] }).cover === null);
    c.ok("only https addresses are kept", core.listingIndexOf({ videos: [{ id: "v", download_url: "http://videos.aryeo.com/a.mp4", playback_url: "javascript:alert(1)" }] }).videos?.length === 0);
    const held = (rows: ReturnType<typeof core.listingIndexOf>["videos"]) => (rows ?? []).map((r, i) => ({ ...r, id: `h${i}`, removedAt: null }));
    const dSame = core.diffIndex(held(readA.videos), { videos: readA.videos, cover: undefined });
    const dGone = core.diffIndex(held(readA.videos), { videos: readA.videos!.slice(0, 1), cover: undefined });
    const dUnknown = core.diffIndex(held(readA.videos), { videos: null, cover: undefined });
    const dBack = core.diffIndex([{ ...held(readA.videos)[0], removedAt: T }], { videos: readA.videos!.slice(0, 1), cover: undefined });
    c.ok("diff: the same read writes nothing; a vanished video is removed; an unknown read removes nothing; a returning one is restored", dSame.create.length + dSame.update.length + dSame.remove.length === 0 && dSame.seen.length === 2 && dGone.remove.join() === "h1" && dUnknown.remove.length === 0 && dBack.update[0]?.data.removedAt === null);
    c.ok("a job with two types: the title decides; none said → the higher type; never a type not bought", core.classifyListingVideo("Premium Cinematic Video", ["premium_social_reel", "premium_cinematic"]) === "premium_cinematic" && core.classifyListingVideo("Premium Social Media Reel", ["premium_cinematic", "premium_social_reel"]) === "premium_social_reel" && core.classifyListingVideo("Cinematic Video", ["premium_social_reel", "standard_cinematic"]) === "standard_cinematic" && core.classifyListingVideo("Standard Reel With Agent Tour", ["premium_social_reel", "standard_reel_agent_intro"]) === "standard_reel_agent_intro" && core.classifyListingVideo("Video #1 - 135 Magnolia Dr", ["standard_cinematic", "premium_social_reel"]) === "premium_social_reel" && core.classifyListingVideo("Anything", ["standard_reel"]) === "standard_reel" && core.classifyListingVideo("Premium Reel", []) === null);

    // =====================================================================
    c.head("§2 · the one-time backfill");
    // =====================================================================
    const guarded = async () => ({
      projects: JSON.stringify(await prisma.project.findMany({ select: { id: true, status: true, updatedAt: true, statusEvidence: true, coverImageUrl: true }, orderBy: { id: "asc" } })),
      other: JSON.stringify(await Promise.all([prisma.portalVideo.count(), prisma.reviewSubmission.count(), prisma.deliverable.count(), prisma.auditLog.count(), prisma.contentVideo.count(), prisma.smartTask.count()])),
    });
    const before = await guarded();
    const notStarted = await ix.listingMediaBackfillTick({ max: 5, gapMs: 0 });
    c.ok("not started: the cron's tick is idle and reads nothing", notStarted.idle === "not started" && calls.length === 0);
    const eligible = (await prisma.project.findMany({ where: ix.BACKFILL_WHERE, select: { id: true, aryeoListingId: true }, orderBy: { id: "asc" } }));
    await ix.startListingMediaBackfill("drill");
    script.netFail.add("L-FLAKY");
    const t1 = await ix.listingMediaBackfillTick({ max: 3, gapMs: 60 });
    const gaps = calls.slice(1).map((x, i) => x.at - calls[i].at);
    c.ok("tick 1: three listings, the first three jobs by id, one at a time, spaced", t1.read === 3 && calls.map((x) => x.id).join() === eligible.slice(0, 3).map((p) => p.aryeoListingId).join() && gaps.every((g) => g >= 55), `${calls.map((x) => x.id).join()} gaps ${gaps.join()}`);
    let st = await ix.listingMediaBackfillState();
    c.ok("…its cursor is the third job, the count is every delivered listing", st?.cursor === eligible[2].id && st.done === 3 && st.total === eligible.length && t1.total === eligible.length && st.leaseUntil === null, JSON.stringify(st));
    calls.length = 0;
    await ix.listingMediaBackfillTick({ max: 3, gapMs: 0 });
    c.ok("tick 2 resumes at the cursor (nothing read twice)", calls.map((x) => x.id).join() === eligible.slice(3, 6).map((p) => p.aryeoListingId).join(), calls.map((x) => x.id).join());

    // A 429: stop, wait a minute (no read meanwhile), then a doubled wait if refused again.
    calls.length = 0;
    script.tooMany = 1;
    const t429 = await ix.listingMediaBackfillTick({ max: 3, gapMs: 0 });
    st = await ix.listingMediaBackfillState();
    const wait1 = Date.parse(st?.backoffUntil ?? "") - Date.now();
    c.ok("Aryeo says 429: the tick stops at once, the cursor stays, the next read waits ~1 minute", calls.length === 1 && st?.cursor === eligible[5].id && st.backoffMs === 60_000 && wait1 > 50_000 && wait1 <= 60_000 && /429/.test(st.lastError ?? "") && t429.waitingUntil === st.backoffUntil, JSON.stringify({ calls: calls.length, st }));
    calls.length = 0;
    const waiting = await ix.listingMediaBackfillTick({ max: 3, gapMs: 0 });
    c.ok("…a tick inside the wait reads nothing", /slow down/.test(waiting.idle ?? "") && calls.length === 0);
    script.tooMany = 1;
    const later = (ms: number) => () => new Date(Date.now() + ms);
    await ix.listingMediaBackfillTick({ max: 3, gapMs: 0, now: later(61_000) });
    st = await ix.listingMediaBackfillState();
    c.ok("…refused again after the wait: the wait doubles (2 minutes), at most 30", st?.backoffMs === 120_000 && core.nextBackoffMs(20 * 60_000) === 30 * 60_000 && core.nextBackoffMs(0) === 60_000);
    calls.length = 0;
    await ix.listingMediaBackfillTick({ max: 3, gapMs: 0, now: later(200_000) });
    st = await ix.listingMediaBackfillState();
    c.ok("…after the wait it carries on from the same job, and the wait resets", calls[0]?.id === eligible[6].aryeoListingId && st?.backoffMs === 0 && st.backoffUntil === null && st.cursor === eligible[8].id, JSON.stringify({ first: calls[0]?.id, st }));

    // One tick at a time.
    calls.length = 0;
    const [ta, tb] = await Promise.all([ix.listingMediaBackfillTick({ max: 2, gapMs: 20 }), ix.listingMediaBackfillTick({ max: 2, gapMs: 20 })]);
    c.ok("two ticks at once: one reads, the other stands aside (the lease)", [ta, tb].filter((t) => t.idle === "another tick is reading").length === 1 && calls.length === 2 && new Set(calls.map((x) => x.id)).size === 2, JSON.stringify([ta.idle, tb.idle, calls.length]));
    st = await ix.listingMediaBackfillState();
    await prisma.appSetting.update({ where: { key: core.BACKFILL_KEY }, data: { value: JSON.stringify({ ...st, leaseUntil: new Date(Date.now() + 60_000).toISOString() }) } });
    calls.length = 0;
    const leased = await ix.listingMediaBackfillTick({ max: 2, gapMs: 0 });
    await prisma.appSetting.update({ where: { key: core.BACKFILL_KEY }, data: { value: JSON.stringify({ ...st, leaseUntil: new Date(Date.now() - 1000).toISOString() }) } });
    const lapsed = await ix.listingMediaBackfillTick({ max: 1, gapMs: 0 });
    c.ok("a tick that died holding the lease blocks only until the lease lapses", leased.idle === "another tick is reading" && lapsed.read === 1 && calls.length === 1);

    // A pause written while a tick is reading wins; resuming re-reads that listing harmlessly.
    calls.length = 0;
    script.onRead = async () => { script.onRead = undefined; await ix.pauseListingMediaBackfill("drill"); };
    const paused = await ix.listingMediaBackfillTick({ max: 5, gapMs: 0 });
    st = await ix.listingMediaBackfillState();
    const pausedAt = st?.cursor;
    c.ok("a pause written mid-tick stops the tick after that listing and stays paused", paused.read === 1 && st?.state === "paused" && calls.length === 1);
    calls.length = 0;
    const idlePaused = await ix.listingMediaBackfillTick({ max: 5, gapMs: 0 });
    c.ok("…paused, the tick reads nothing", idlePaused.idle === "paused" && calls.length === 0);
    await ix.startListingMediaBackfill("drill");

    // Run it out: the 404 and the flaky listing on the way.
    let guard = 0;
    let last = await ix.listingMediaBackfillTick({ max: 6, gapMs: 0 });
    while (!last.finished && guard++ < 40) last = await ix.listingMediaBackfillTick({ max: 6, gapMs: 0 });
    st = await ix.listingMediaBackfillState();
    c.ok("run to the end: every delivered listing read once, done", last.finished && st?.state === "done" && st.done === eligible.length && !!st.finishedAt && st.cursor !== pausedAt, JSON.stringify(st));
    c.ok("…the 404 listing skipped in words; the flaky one retried twice, then skipped", st?.skipped.some((s) => s.id === w.pGone.id && /404/.test(s.why)) === true && st.skipped.some((s) => s.id === w.pFlaky.id && /three times/.test(s.why)) === true && calls.filter((x) => x.id === "L-FLAKY").length >= 3, JSON.stringify(st?.skipped));
    calls.length = 0;
    const afterDone = await ix.listingMediaBackfillTick({ max: 6, gapMs: 0 });
    c.ok("done: further ticks are idle and read nothing", afterDone.idle === "done" && calls.length === 0);
    const rows = await prisma.listingMediaItem.findMany({ select: { projectId: true, aryeoMediaId: true, kind: true } });
    const keys = rows.map((r) => `${r.projectId}:${r.aryeoMediaId}`);
    c.ok("no duplicate rows (one per job and Aryeo id), every video and cover the fake listings hold", new Set(keys).size === keys.length && rows.filter((r) => r.kind === "VIDEO").length === 24 && rows.filter((r) => r.kind === "PHOTO_COVER").length === 5, `${rows.filter((r) => r.kind === "VIDEO").length} videos, ${rows.filter((r) => r.kind === "PHOTO_COVER").length} covers`);
    const again = await ix.indexListingRead(w.pA.id, "L-A", LISTINGS["L-A"]);
    c.ok("re-reading a listing writes nothing new (idempotent)", "created" in again && again.created === 0 && again.updated === 0 && again.removed === 0);
    const after = await guarded();
    c.ok("the backfill wrote only the index and its own progress row (jobs, portal, cuts, receipts untouched)", before.projects === after.projects && before.other === after.other);
    const cronSrc = (await import("node:fs")).readFileSync((await import("node:path")).join(__dirname, "../../src/app/api/cron/aryeo/route.ts"), "utf8");
    c.ok("the 15-minute Aryeo job runs the tick last, 36 reads 0.4 s apart inside 60 s", /step\("listingMediaBackfill"[\s\S]*listingMediaBackfillTick\(\{ max: 36, budgetMs: 60_000, gapMs: 400 \}\)/.test(cronSrc) && cronSrc.lastIndexOf('step("listingMediaBackfill"') > cronSrc.lastIndexOf('step("scripting"'));

    // =====================================================================
    c.head("§3 · kept current by the reads the hub already makes");
    // =====================================================================
    const { refreshListingEvidence, syncProjectStatuses } = await import("@/lib/projectStatus");
    calls.length = 0;
    await syncProjectStatuses({ projectId: w.pR.id }).catch((e) => console.log("status pass:", (e as Error).message.slice(0, 120)));
    const rRows = await prisma.listingMediaItem.findMany({ where: { projectId: w.pR.id } });
    const rNow = await prisma.project.findUniqueOrThrow({ where: { id: w.pR.id }, select: { status: true, deliveredAt: true } });
    c.ok("(the job is still not delivered: the listing says UNDELIVERED)", rNow.status !== "DELIVERED" && !rNow.deliveredAt, JSON.stringify(rNow));
    c.ok("the hourly status pass's own listing read indexes the job (no extra Aryeo call)", rRows.length === 1 && rRows[0].aryeoMediaId === w.id.r1 && calls.filter((x) => x.id === "L-R").length === 1, `${rRows.length} rows, ${calls.map((x) => x.id).join()}`);
    LISTINGS["L-A"] = listing("L-A", [{ id: w.id.a1, title: "Premium Social Media Reel", duration: 61 }], (LISTINGS["L-A"] as { images: never[] }).images, 1);
    await refreshListingEvidence(w.pA.id);
    const a2 = await prisma.listingMediaItem.findFirst({ where: { projectId: w.pA.id, aryeoMediaId: w.id.a2 } });
    c.ok("Ready to send's re-read: a video taken off the listing is marked removed (kept, not deleted)", !!a2?.removedAt);
    let all = await lib.loadFinishedVideos();
    c.ok("…and leaves the library", !all.some((v) => v.key === `aryeo:${a2?.id}`));

    // =====================================================================
    c.head("§4 · the library: every older video, on its tab, once");
    // =====================================================================
    const tile = (projectId: string, mediaId: string) => prisma.listingMediaItem.findFirstOrThrow({ where: { projectId, aryeoMediaId: mediaId } }).then((r) => all.find((v) => v.key === `aryeo:${r.id}`));
    const onTab = (t: string) => all.filter((v) => v.placement.tab === t);
    calls.length = 0;
    LISTINGS["L-A"] = listing("L-A", [{ id: w.id.a1, title: "Premium Social Media Reel", duration: 61 }, { id: w.id.a2, title: "Premium Social Media Reel (REVISED)", duration: 64 }], (LISTINGS["L-A"] as { images: never[] }).images, 1);
    await refreshListingEvidence(w.pA.id);
    all = await lib.loadFinishedVideos();
    const listings = await lib.loadDeliveredListings();
    c.ok("drawing the library and the listings calls Aryeo not once (beyond the one re-read above)", calls.length === 1);
    const ta1 = await tile(w.pA.id, w.id.a1);
    const ta2 = await tile(w.pA.id, w.id.a2);
    c.ok("a video put back on its listing comes back", !!ta2 && ta2.title === "Premium Social Media Reel (REVISED)");
    c.ok("Premium: the older premium reels, each version on the listing, under Premium Social Media Reel", ta1?.placement.tab === "premium" && ta1.placement.groupKey === "premium_social_reel" && ta2?.placement.groupKey === "premium_social_reel");
    c.ok("…Aryeo's title, Aryeo's poster, its length, the address and client, delivered on the job's date", ta1?.title === "Premium Social Media Reel" && ta1.poster === `https://image.mux.com/${w.id.a1}/thumbnail.png?width=800&height=450&smart_crop=true&time=1` && ta1.durationSec === 61 && ta1.place === w.pA.title && ta1.clientName === "Older Olive" && ta1.dateISO === w.pA.deliveredAt!.toISOString() && /^Delivered /.test(ta1.dateText ?? "") && ta1.eyebrow === "Premium Social Media Reel");
    c.ok("…played and downloaded through the staff route, no Aryeo or Dropbox address in the tile", ta1?.playSrc.startsWith("/api/media/aryeo/") === true && ta1.downloadHref === `${ta1.playSrc}?dl=1` && !JSON.stringify(onTab("premium").filter((v) => v.key.startsWith("aryeo:"))).match(/videos\.aryeo\.com|dropbox/i));
    const tb1 = await tile(w.pB.id, w.id.b1);
    const tb2 = await tile(w.pB.id, w.id.b2);
    c.ok("a job sold two types: each video under the type its title names", tb1?.placement.groupKey === "premium_cinematic" && tb2?.placement.groupKey === "premium_social_reel");
    const tc1 = await tile(w.pC.id, w.id.c1);
    const tc2 = await tile(w.pC.id, w.id.c2);
    const td1 = await tile(w.pD.id, w.id.d1);
    const tf1 = await tile(w.pF.id, w.id.f1);
    c.ok("Standard: rows with only a label resolve by the hub's own reading (Video → cinematic, Social Reel → reel, vertical)", tc1?.placement.groupKey === "standard_cinematic" && tc2?.placement.groupKey === "standard_reel" && tc2.orientation === "vertical");
    c.ok("…the agent-intro reel under its own type; a job with no video row under 'type not recorded'", td1?.placement.groupKey === "standard_reel_agent_intro" && tf1?.placement.tab === "standard" && tf1.placement.groupKey === "listing_other");
    const te1 = await tile(w.pE.id, w.id.e1);
    const tg1 = await tile(w.pG.id, w.id.g1);
    const tg2 = await tile(w.pG.id, w.id.g2);
    const tip = await tile(w.p3.id, w.id.moTip);
    c.ok("Monthly social: a social-plan client's session by her plan (Video Accelerator)", te1?.placement.tab === "monthly" && te1.placement.groupLabel === "Video Accelerator");
    c.ok("…a branding package outside the program under Branding packages; an untitled one is named by its address, nothing invented", tg1?.placement.groupKey === "branding_package" && tg1.title === "Video 1" && tg2?.title === "700 Branding Blvd");
    c.ok("…a program video only on the listing joins its month (Video Accelerator, October 2026)", tip?.placement.groupKey === "program_accelerator" && tip.eyebrow === "October 2026" && tip.title === "Tip #3 Staging Sells");
    const reel = all.find((v) => v.key === `cut:${w.c1b.id}`);
    c.ok("the hub's reel is not doubled by the Aryeo copy its receipt names, and takes Aryeo's poster", !(await tile(w.p1.id, w.id.alphaReel)) && reel?.poster === `https://image.mux.com/${w.id.alphaReel}/thumbnail.png?width=800&height=450&smart_crop=true&time=1`);
    c.ok("the cinematic video and its revision on the listing are the hub's cinematic file (every owed video is the hub's)", !(await tile(w.p1.id, w.id.alphaCine)) && !(await tile(w.p1.id, w.id.alphaCineRev)) && all.some((v) => v.key === `cut:${w.c2.id}`));
    const cq = all.find((v) => v.key === `cut:${w.cQ.id}`);
    c.ok("two reels owed, one the hub's: the copy with its title and length is dropped, the other stays", !(await tile(w.pQ.id, w.id.q1)) && (await tile(w.pQ.id, w.id.q2))?.placement.groupKey === "standard_reel" && cq?.poster === `https://image.mux.com/${w.id.q1}/thumbnail.png?width=800&height=450&smart_crop=true&time=1`);
    const oneDay = all.find((v) => v.key === `pv:${w.pvOneDay.id}`);
    c.ok("a video the portal already shows (keyed by Aryeo's id) is not a second tile; the portal's tile gains its length", !(await tile(w.p3.id, w.id.moOneDay)) && !(await tile(w.p3.id, w.id.moLot)) && oneDay?.durationSec === 51);
    const h1 = await tile(w.pH1.id, w.id.h1);
    const h2 = await tile(w.pH2.id, w.id.h2);
    c.ok("a listing shared by two jobs: each video once, under the job it was delivered for", !!h1 && !!h2 && !(await tile(w.pH2.id, w.id.h1)) && !(await tile(w.pH1.id, w.id.h2)) && Math.abs(Date.parse(h2.dateISO ?? "") - (T.getTime() - 18 * D)) < 1000, JSON.stringify([h1?.projectId, h2?.projectId]));
    c.ok("test clients, cancelled and undelivered jobs are left out", !(await tile(w.p6.id, w.id.t1)) && !(await tile(w.pR.id, w.id.r1)) && !all.some((v) => v.title === "Cancelled video"));
    const counts = Object.fromEntries(["standard", "premium", "monthly"].map((t) => [t, onTab(t).length]));
    c.ok("the tabs: standard 9, premium 6, monthly 7 (hub, portal and index together)", counts.standard === 9 && counts.premium === 6 && counts.monthly === 7, JSON.stringify(counts));
    const keysAll = all.map((v) => v.key);
    c.ok("no tile twice", new Set(keysAll).size === keysAll.length);
    const scoped = await lib.loadFinishedVideos({ projectIds: [w.pB.id] });
    c.ok("a listing page's scoped read is that job's videos only", scoped.length === 2 && scoped.every((v) => v.projectId === w.pB.id));

    // =====================================================================
    c.head("§5 · covers fill the Photos tab and /listings");
    // =====================================================================
    const card = (id: string) => listings.find((l) => l.projectId === id);
    c.ok("an older job with no stored cover shows its listing's cover and photo count", card(w.pA.id)?.cover === "https://cdn.aryeo.com/listings/100-old-premium-rd/resized/thumbnail/thumbnail-img-2.jpeg" && card(w.pA.id)?.photoCount === 5 && card(w.pA.id)?.hasPhotos === true);
    c.ok("…a photos-only job too; a job's own stored cover still wins", card(w.pF.id)?.cover?.includes("600-photos-only-ct") === true && card(w.pF.id)?.photoCount === 12 && card(w.p1.id)?.cover === w.p1.coverImageUrl);
    const photos = lib.photosByAddress(listings);
    c.ok("the Photos tab has those addresses as tiles with a cover", photos.some((p) => p.projectId === w.pA.id && !!p.cover) && photos.some((p) => p.projectId === w.pF.id && !!p.cover));
    const head = await lib.loadListingHeader(w.pA.id);
    c.ok("a listing page falls back to the indexed cover when Aryeo does not answer", head?.indexCover === card(w.pA.id)?.cover);

    // =====================================================================
    c.head("§6 · the file door: staff only");
    // =====================================================================
    const { GET } = await import("@/app/api/media/aryeo/[id]/route");
    const { NextRequest } = await import("next/server");
    const call = async (id: string, dl = false) => {
      const res = await GET(new NextRequest(`http://localhost/api/media/aryeo/${id}${dl ? "?dl=1" : ""}`), { params: Promise.resolve({ id }) });
      return { status: res.status, location: res.headers.get("location"), cache: res.headers.get("cache-control"), body: res.status >= 300 && res.status < 400 ? "" : await res.text() };
    };
    const user = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@index.invalid`, role, status: "ACTIVE", ...extra } });
    const owner = await user("Jordan Spackman", "OWNER");
    const kyle = await user("Kyle Smith", "ADMIN");
    const harrison = await user("Harrison Wells", "PHOTOGRAPHER");
    const kim = await user("Kim Editor", "EDITOR", { editorKey: "kim", permissions: JSON.stringify({ media: true }) });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const rowA1 = await prisma.listingMediaItem.findFirstOrThrow({ where: { projectId: w.pA.id, aryeoMediaId: w.id.a1 } });
    jar.cookies.delete(SESSION_COOKIE);
    c.ok("signed out: 401", (await call(rowA1.id)).status === 401);
    await signIn(harrison);
    c.ok("a photographer: 403", (await call(rowA1.id)).status === 403);
    await signIn(kim);
    c.ok("an editor holding a media key: 403", (await call(rowA1.id)).status === 403);
    await signIn(owner, harrison.id);
    c.ok("the owner previewing the photographer: 403", (await call(rowA1.id)).status === 403);
    await signIn(owner);
    const watch = await call(rowA1.id);
    c.ok("Watch: a 302 to the file on Aryeo's own host, never cached", watch.status === 302 && watch.location === rowA1.downloadUrl && watch.cache === "private, no-store", JSON.stringify(watch));
    await signIn(kyle);
    const dl = await call(rowA1.id, true);
    c.ok("Download (the office): a 302 to the staff download proxy with a readable name", dl.status === 302 && dl.location === `http://localhost/api/media/download?url=${encodeURIComponent(rowA1.downloadUrl!)}&name=premium-social-media-reel.mp4`, dl.location ?? "");
    await prisma.listingMediaItem.update({ where: { id: rowA1.id }, data: { removedAt: new Date() } });
    const gone = await call(rowA1.id);
    c.ok("a video no longer on its listing: 404, in words", gone.status === 404 && /no longer on its Aryeo listing/.test(gone.body));
    const rowR = await prisma.listingMediaItem.findFirstOrThrow({ where: { projectId: w.pR.id } });
    c.ok("an undelivered job's video: 404", (await call(rowR.id)).status === 404);
    const rowB1 = await prisma.listingMediaItem.findFirstOrThrow({ where: { projectId: w.pB.id, aryeoMediaId: w.id.b1 } });
    await prisma.listingMediaItem.update({ where: { id: rowB1.id }, data: { downloadUrl: "https://evil.example.com/b1.mp4" } });
    c.ok("an address not on Aryeo's media hosts is never followed: 404", (await call(rowB1.id)).status === 404);
    c.ok("a malformed id: 404; a cover row is not a video: 404", (await call("../etc/passwd")).status === 404 && (await call((await prisma.listingMediaItem.findFirstOrThrow({ where: { kind: "PHOTO_COVER" } })).id)).status === 404);
    const routeSrc = (await import("node:fs")).readFileSync((await import("node:path")).join(__dirname, "../../src/app/api/media/aryeo/[id]/route.ts"), "utf8");
    c.ok("the route writes nothing and calls no Aryeo API", !/\.update\(|\.create\(|\.upsert\(|\.delete\(|api\.aryeo\.com|Aryeo\.listing/.test(routeSrc));
    void video;

    c.ok("nothing left the box but the faked Aryeo listing reads", fence.blocked.length === 0, fence.blocked.join());
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
