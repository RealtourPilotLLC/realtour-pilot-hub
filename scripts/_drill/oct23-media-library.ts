// Oct 23 2026: THE MEDIA LIBRARY'S DATA (Jordan: "a really nice media page so
// we can see all of the videos that we have done and download them. Organized
// by media type, and date … Create listing pages too"). Proves, on a
// disposable PGlite with the network fenced:
//   §1 which tab and group each finished video sits in (premium, standard,
//      monthly by package, branding packages), with the real Style Guide names;
//   §2 "done": sent or delivered (or in the client's portal), the newest round
//      of each owed video only, test clients and cancelled jobs left out;
//   §3 the monthly library: the topic's title, one logical video once, the
//      hub's newer cut beating an older Aryeo copy and keeping its poster;
//   §4 photos by address (an address shot twice is one tile), listings;
//   §5 search, date range and sort;
//   §6 who may open it (owner, office, creative manager; never a photographer
//      or an editor, whatever a key says), the proxy's /listings mapping;
//   §7 the file route: refusals (401, 403, 404, 409), the Topaz file through a
//      fresh Dropbox link, the hub's copy relayed, and NO hand-off stamp.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { buildMediaWorld } from "./_fixtures/mediaLibrary";

const jar = installNextStubs();
const DBX_TMP = "https://dbx.invalid/tmp";
const dbxCalls: string[] = [];
const blobFetches: string[] = [];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-access-not-real" });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const ep = url.slice("https://api.dropboxapi.com/2/".length);
    const arg = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (ep === "users/get_current_account") return json({ root_info: {} });
    if (ep === "files/get_temporary_link") { dbxCalls.push(String(arg.path)); return json({ link: `${DBX_TMP}${encodeURI(String(arg.path))}`, metadata: {} }); }
    return json({ error_summary: `drill: unscripted ${ep}` }, 400);
  }
  if (/^https:\/\/drillstore\.public\.blob\.vercel-storage\.com\//.test(url)) {
    blobFetches.push(url);
    return new Response("HUBBYTES", { status: 200, headers: { "content-type": "video/quicktime", "content-length": "8" } });
  }
  return null;
});

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 4731), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-media-library" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { SESSION_COOKIE, signSession } = await import("@/lib/auth/jwt");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("dropbox", "drill-refresh-not-real");
    const core = await import("@/lib/mediaLibraryCore");
    const lib = await import("@/lib/mediaLibrary");
    const { VIDEO_STYLE } = await import("@/lib/integrations/aryeo");
    const T = new Date();
    const w = await buildMediaWorld(prisma, T);

    const tm = (name: string, role: string) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@media.invalid` } });
    const user = async (name: string, role: string, permissions: string | null = null) => {
      const t = await tm(name, role === "ADMIN" || role === "CREATIVE_MANAGER" ? "MANAGER" : "PHOTOGRAPHER");
      return prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}.${role.toLowerCase()}@media.invalid`, role, teamMemberId: t.id, status: "ACTIVE", permissions } });
    };
    const owner = await user("Jordan Spackman", "OWNER");
    const kyle = await user("Kyle Smith", "ADMIN");
    const james = await user("James Livingston", "CREATIVE_MANAGER");
    const harrison = await user("Harrison Wells", "PHOTOGRAPHER");
    const kim = await prisma.appUser.create({ data: { name: "Kim Editor", email: "kim@media.invalid", role: "EDITOR", editorKey: "kim", status: "ACTIVE", permissions: JSON.stringify({ media: true }) } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const signOut = () => jar.cookies.delete(SESSION_COOKIE);

    // =====================================================================
    c.head("§1 · tabs and groups come from the video's own Style Guide type");
    // =====================================================================
    c.ok("the type names are the hub's own (integrations/aryeo VIDEO_STYLE)", JSON.stringify(core.MEDIA_TYPE_NAME) === JSON.stringify(VIDEO_STYLE));
    const place = (style: string | null, monthly = false, pkg?: string) => core.placeVideo({ style, monthly, pkg: pkg ? core.programPackageOf(pkg) : null });
    c.ok("premium_social_reel and premium_cinematic → Premium videos, each its own group", place("premium_social_reel").tab === "premium" && place("premium_cinematic").tab === "premium" && place("premium_social_reel").groupLabel === "Premium Social Media Reel" && place("premium_cinematic").groupLabel === "Premium Cinematic Video");
    c.ok("the three standard types → Standard videos, by type", ["standard_reel", "standard_reel_agent_intro", "standard_cinematic"].every((s) => place(s).tab === "standard" && place(s).groupKey === s) && place("standard_reel_agent_intro").groupLabel === "Standard Reel with Agent Intro");
    c.ok("a premium reel on a monthly client's job stays premium (premium wins over monthly)", place("premium_social_reel", true, "Video Accelerator - 4HR Session").tab === "premium");
    c.ok("a program video → Monthly social, grouped by its session package", place("personal_branding", true, "Video Accelerator - 4HR Session").groupLabel === "Video Accelerator" && place(null, true, "VIDEO PRO - 8HR Session").groupLabel === "Video Pro" && place("personal_branding", true, "Video Starter - 2HR Session").groupLabel === "Video Starter");
    c.ok("…a bulk plan and an unnamed session have groups of their own", core.programPackageOf("Video Accelerator", "Accelerator", "BULK").label === "Bulk plan" && core.programPackageOf("Full Day Content Shoot", null).label === "Content sessions" && core.programPackageOf("Full Day Content Shoot", "Pro").label === "Video Pro");
    c.ok("a branding package sold outside the program → Monthly social, 'Branding packages'", place("personal_branding").tab === "monthly" && place("personal_branding").groupLabel === "Branding packages");
    c.ok("a listing cut with no recorded type → Standard, and it says so", place(null).tab === "standard" && /type not recorded/.test(place(null).groupLabel));

    const all = await lib.loadFinishedVideos();
    const byKey = new Map(all.map((v) => [v.key, v]));
    const onTab = (t: string) => all.filter((v) => v.placement.tab === t);
    c.ok("Premium: the Alpha reel (round 2) and the Gamma reel on the monthly job", onTab("premium").map((v) => v.key).sort().join() === [`cut:${w.c1b.id}`, `cut:${w.c7.id}`].sort().join(), onTab("premium").map((v) => v.key).join());
    c.ok("Standard: the Alpha cinematic video", onTab("standard").map((v) => v.key).join() === `cut:${w.c2.id}`, onTab("standard").map((v) => v.key).join());
    c.ok("Monthly: the program cut, the Aryeo-only program video and the branding video", onTab("monthly").map((v) => v.key).sort().join() === [`cut:${w.c5.id}`, `pv:${w.pvOneDay.id}`, `cut:${w.c6.id}`].sort().join(), onTab("monthly").map((v) => v.key).join());
    const monthlyGroups = core.groupPlaced(onTab("monthly"), "new");
    c.ok("Monthly groups in order: Video Accelerator, then Branding packages", monthlyGroups.map((g) => g.label).join() === "Video Accelerator,Branding packages", monthlyGroups.map((g) => g.label).join());

    // =====================================================================
    c.head("§2 · done means it went out; the newest round only; real clients only");
    // =====================================================================
    c.ok("round 1 of the reel (replaced by round 2) is not shown", !byKey.has(`cut:${w.c1.id}`));
    c.ok("a cut waiting on a verdict is never in the library", !byKey.has(`cut:${w.c3.id}`));
    c.ok("an approved cut not sent, on a job still in review, is not in the library", !byKey.has(`cut:${w.c4.id}`));
    c.ok("a test client's video and a cancelled job's are left out", !byKey.has(`cut:${w.c8.id}`) && !byKey.has(`cut:${w.c9.id}`));
    const reel = byKey.get(`cut:${w.c1b.id}`)!;
    c.ok("the reel's date is the day it was sent, worded on the server", reel.dateISO === w.c1b.sentToClientAt!.toISOString() && /^Delivered [A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(reel.dateText ?? ""), reel.dateText ?? "");
    const cine = byKey.get(`cut:${w.c2.id}`)!;
    c.ok("the cinematic video (no send stamp, job delivered) is dated by the job's delivery", cine.dateISO === w.p1.deliveredAt!.toISOString());
    c.ok("title = the address; the product sold rides above it; client and listing named", reel.title === "10 Alpha St" && reel.eyebrow === "Social Influencer" && reel.clientName === "Agent Alpha" && reel.projectId === w.p1.id);
    c.ok("shape from the 1080p file (vertical reel), the cinematic horizontal; length from the render", reel.orientation === "vertical" && cine.orientation === "horizontal" && reel.durationSec === 47.6);
    c.ok("hub files play and download through the media route (no Dropbox address in the data)", reel.playSrc === `/api/media/video/${w.c1b.id}` && reel.downloadHref === `/api/media/video/${w.c1b.id}?dl=1` && !JSON.stringify(all).includes("dropbox"));
    const brand = byKey.get(`cut:${w.c6.id}`)!;
    c.ok("a branding package video with no name is 'video 3 of 16' at its address, never a made-up title", brand.title === "893 Branding Ln · video 3 of 16" && brand.eyebrow === "Custom Branding Video Package 16 Videos Total");
    c.ok("the done rule: approved + sent/delivered/portal; approval alone is not done", core.cutDone({ status: "APPROVED", sentToClientAt: null, decidedAt: T, topazDeliveredAt: null, outputDeliveredAt: null, projectStatus: "REVIEW", projectDeliveredAt: null, portalPublishedAt: null }).done === false && core.cutDone({ status: "APPROVED", sentToClientAt: null, decidedAt: T, topazDeliveredAt: T, outputDeliveredAt: null, projectStatus: "REVIEW", projectDeliveredAt: null, portalPublishedAt: null }).done === true && core.cutDone({ status: "CHANGES_REQUESTED", sentToClientAt: T, decidedAt: T, topazDeliveredAt: null, outputDeliveredAt: null, projectStatus: "DELIVERED", projectDeliveredAt: T, portalPublishedAt: null }).done === false);
    const fileOf = (topaz: Parameters<typeof core.finishedFileOf>[0]["topaz"], blob = "https://x.public.blob.vercel-storage.com/a.mov") => core.finishedFileOf({ fileName: "a.mov", blobUrl: blob, assetPath: "/Final/a.mov", finalPath: null, topaz });
    c.ok("the finished file: the checked Topaz file first, else the hub's copy, else the Dropbox path", fileOf({ state: "done", finalPath: "/F/a 1080p.mp4", savedAt: T, outputCheck: "verified" })?.kind === "dropbox" && fileOf({ state: "done", finalPath: "/F/a 1080p.mp4", savedAt: T, outputCheck: "verified" })?.source === "topaz" && fileOf({ state: "skipped", finalPath: null, savedAt: null, outputCheck: null })?.kind === "blob" && fileOf(null, null as unknown as string)?.kind === "dropbox");
    c.ok("…a reviewer who kept the original, or an unchecked render, gets the editor's file", fileOf({ state: "done", finalPath: "/F/a.mp4", savedAt: T, outputCheck: "resolved-original" })?.source === "editor" && fileOf({ state: "done", finalPath: "/F/a.mp4", savedAt: T, outputCheck: "unverified" })?.source === "editor");

    // =====================================================================
    c.head("§3 · the monthly library: titles, one video once, posters");
    // =====================================================================
    const lot = byKey.get(`cut:${w.c5.id}`)!;
    c.ok("the program cut shows its topic's title, the month above it, 'Published' when the portal got it", lot.title === "Why Your Lot Decides Your Floor Plan" && lot.eyebrow === "October 2026" && /^Published /.test(lot.dateText ?? ""), `${lot.title} / ${lot.eyebrow} / ${lot.dateText}`);
    c.ok("the older Aryeo copy of the same video is not a second tile, and its poster is kept", !all.some((v) => v.key.startsWith("pv:") && v.contentVideoId === w.cv1.id) && lot.poster === "https://image.mux.com/lot/thumbnail.jpg");
    const oneDay = byKey.get(`pv:${w.pvOneDay.id}`)!;
    c.ok("an Aryeo-delivered program video plays Aryeo's own file, Aryeo's poster, downloads through the staff proxy", oneDay.playSrc === "https://videos.aryeo.com/oneday.mp4" && oneDay.poster === "https://image.mux.com/oneday/thumbnail.jpg" && oneDay.downloadHref.startsWith("/api/media/download?url=https%3A%2F%2Fvideos.aryeo.com%2Foneday.mp4&name=one-day-in-townville-1.mp4") && oneDay.title === "One Day in Townville #1");
    c.ok("a file name is cleaned for show, never rewritten", core.cleanVideoTitle("Done_Rev_1033 Preserve Ln (Mike)_Video2.mov") === "Done Rev 1033 Preserve Ln (Mike) Video2" && core.cleanVideoTitle("  Mike  Flatley   Video 2 ") === "Mike Flatley Video 2" && core.cleanVideoTitle("") === null);
    const scoped = await lib.loadFinishedVideos({ projectIds: [w.p1.id] });
    c.ok("a listing page's read is that job's videos only", scoped.map((v) => v.key).sort().join() === [`cut:${w.c1b.id}`, `cut:${w.c2.id}`].sort().join());

    // =====================================================================
    c.head("§4 · photos by address; delivered listings");
    // =====================================================================
    const listings = await lib.loadDeliveredListings();
    const ids = listings.map((l) => l.projectId);
    c.ok("delivered listings: with an Aryeo listing, real clients, newest first", !ids.includes(w.p10.id) && !ids.includes(w.p6.id) && ids.indexOf(w.p1.id) < ids.indexOf(w.p8.id) && ids.includes(w.p9.id));
    const l1 = listings.find((l) => l.projectId === w.p1.id)!;
    c.ok("a listing's cover and photo count come from what the status engine stored", l1.cover === w.p1.coverImageUrl && l1.photoCount === 41 && l1.delivered.join() === "Photos,Video,Floor plan", l1.delivered.join());
    const l9 = listings.find((l) => l.projectId === w.p9.id)!;
    c.ok("a listing the engine found no photos on says Video only and is no photo tile", !l9.hasPhotos && l9.delivered.join() === "Video");
    const photos = lib.photosByAddress(listings);
    const alphaTile = photos.find((p) => p.title.startsWith("10 Alpha St"));
    c.ok("the address shot twice is ONE photo tile: the newest shoot, the earlier one listed on it", photos.filter((p) => p.title.startsWith("10 Alpha St")).length === 1 && alphaTile?.projectId === w.p1.id && alphaTile.earlier.map((e) => e.projectId).join() === w.p8.id);
    c.ok("an older job the engine never read counts when it ordered photos (no made-up count or cover)", (() => { const l8 = listings.find((l) => l.projectId === w.p8.id)!; return l8.hasPhotos && l8.photoCount === null && l8.cover === null; })());
    c.ok("no photo tile for the video-only listing", !photos.some((p) => p.projectId === w.p9.id));
    c.ok("the address key ignores case, punctuation and the ZIP", core.addressKey("10 Alpha St., Townville, PA 19000") === core.addressKey("10 alpha st townville"));

    // =====================================================================
    c.head("§5 · search, dates, order");
    // =====================================================================
    c.ok("search: every word, case and punctuation ignored, over address/client/title", core.matchesQuery("alpha townville", ["10 Alpha St, Townville", "Agent X"]) && core.matchesQuery("AGENT alpha", ["x", "Agent Alpha"]) && !core.matchesQuery("beta", ["10 Alpha St"]) && core.matchesQuery("", ["anything"]));
    const r30 = core.parseRange("30d", T);
    c.ok("last 30 days keeps the reel, drops the year-old shoot", core.inRange(reel.dateISO, r30) && !core.inRange(listings.find((l) => l.projectId === w.p8.id)!.dateISO, r30));
    const thisYear = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric" }).format(T));
    const ry = core.parseRange(`y${thisYear}`, T);
    c.ok("a calendar year (ET) is a range; junk is all dates", ry.key === `y${thisYear}` && core.inRange(T, ry) && !core.inRange(new Date(T.getTime() - 800 * D), ry) && core.parseRange("drop table", T).key === "all");
    const sorted = [...photos].sort(core.byDate("old", (p) => p.dateISO));
    c.ok("oldest first puts the oldest delivered first; undated last", (Date.parse(sorted[0].dateISO ?? "") || 0) <= (Date.parse(sorted[1]?.dateISO ?? "") || Infinity));
    c.ok("pages: 24, then +24, capped; junk is one page", core.pageCount(undefined) === 24 && core.pageCount("48") === 48 && core.pageCount("30") === 48 && core.pageCount("-1") === 24 && core.pageCount("999999") === 2400);
    c.ok("the year picker offers this year back to the oldest item", core.rangeYears([new Date(T.getTime() - 400 * D)], T)[0] === thisYear && core.rangeYears([new Date(T.getTime() - 400 * D)], T).length >= 2);

    // =====================================================================
    c.head("§6 · who may open it");
    // =====================================================================
    const { mayOpenMedia } = await import("@/lib/mediaAccess");
    const { canAccess, PAGES } = await import("@/lib/auth/access");
    c.ok("owner, office and creative manager may; photographer and editor may not", mayOpenMedia({ role: "OWNER" }) && mayOpenMedia({ role: "ADMIN" }) && mayOpenMedia({ role: "CREATIVE_MANAGER" }) && !mayOpenMedia({ role: "PHOTOGRAPHER" }) && !mayOpenMedia({ role: "EDITOR" }));
    c.ok("an editor's media:true key does not open it (staff-only for now); a revoked key closes it for the office", !mayOpenMedia({ role: "EDITOR", permissions: JSON.stringify({ media: true }) }) && !mayOpenMedia({ role: "ADMIN", permissions: JSON.stringify({ media: false }) }) && canAccess({ role: "EDITOR", permissions: JSON.stringify({ media: true }) }, "media"));
    c.ok("one 'Media' page key at /media", PAGES.filter((p) => p.key === "media").length === 1 && PAGES.find((p) => p.key === "media")?.href === "/media" && PAGES.find((p) => p.key === "media")?.label === "Media");
    const { proxy } = await import("@/proxy");
    const { NextRequest } = await import("next/server");
    const visit = async (path: string, u: { id: string; email: string; role: string; permissions?: string | null }) => {
      const token = await signSession({ uid: u.id, email: u.email, role: u.role, permissions: u.permissions ?? null });
      const res = await proxy(new NextRequest(`http://localhost${path}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
      return { status: res.status, to: res.headers.get("location") };
    };
    const plainEditor = await prisma.appUser.create({ data: { name: "John Editor", email: "john@media.invalid", role: "EDITOR", editorKey: "john", status: "ACTIVE" } });
    const hVisit = await visit(`/listings/${w.p1.id}`, harrison);
    const eVisit = await visit("/listings", plainEditor);
    const jVisit = await visit(`/listings/${w.p1.id}`, james);
    const mVisit = await visit("/media?tab=photos", kyle);
    c.ok("the proxy maps /listings to the media key: a photographer is sent home (/shoot), an editor too (/editing)", hVisit.status === 307 && /\/shoot$/.test(hVisit.to ?? "") && eVisit.status === 307 && /\/editing$/.test(eVisit.to ?? ""), JSON.stringify([hVisit, eVisit]));
    c.ok("…the creative manager and the office pass", jVisit.status === 200 && mVisit.status === 200, JSON.stringify([jVisit, mVisit]));
    // An editor holding a media key gets past the proxy (a key is a key), and the page itself sends her home.
    const { requireMediaPage } = await import("@/lib/mediaAccess");
    await signIn(kim);
    const kimPage = await requireMediaPage("/media").then(() => "let in", (e: Error) => e.message);
    await signIn(kyle);
    const kylePage = await requireMediaPage("/media").then((u) => u?.role ?? "none", (e: Error) => e.message);
    c.ok("…an editor with a media key is turned away by the page itself; the office is let in", /redirect/.test(kimPage) && kylePage === "ADMIN", `${kimPage} / ${kylePage}`);

    // =====================================================================
    c.head("§7 · the file route");
    // =====================================================================
    const { GET } = await import("@/app/api/media/video/[id]/route");
    const call = async (id: string, dl = false, headers: Record<string, string> = {}) => {
      const res = await GET(new NextRequest(`http://localhost/api/media/video/${id}${dl ? "?dl=1" : ""}`, { headers }), { params: Promise.resolve({ id }) });
      return { status: res.status, location: res.headers.get("location"), cache: res.headers.get("cache-control"), disposition: res.headers.get("content-disposition"), body: res.status < 300 ? await res.text() : await res.text().catch(() => "") };
    };
    signOut();
    c.ok("signed out: 401", (await call(w.c1b.id)).status === 401);
    await signIn(harrison);
    c.ok("a photographer: 403 (even for a video of a job they could see elsewhere)", (await call(w.c1b.id)).status === 403);
    await signIn(kim);
    c.ok("an editor with a media key: 403", (await call(w.c1b.id)).status === 403);
    await signIn(owner, harrison.id);
    c.ok("the owner previewing the photographer: 403 (the preview gets what they would)", (await call(w.c1b.id)).status === 403);
    await signIn(owner);
    c.ok("a malformed id: 404", (await call("../etc/passwd")).status === 404);
    c.ok("a cut still in review: 404, in words", (await call(w.c3.id)).status === 404 && /approved/.test((await call(w.c3.id)).body));
    c.ok("approved but not gone to the client: 409, in words", (await call(w.c4.id)).status === 409 && /hasn't gone to the client/.test((await call(w.c4.id)).body));
    dbxCalls.length = 0;
    const topazDl = await call(w.c1b.id, true);
    c.ok("the reel (Topaz 1080p): a 302 to a Dropbox link minted on this press, never cached", topazDl.status === 302 && (topazDl.location ?? "").startsWith(DBX_TMP) && topazDl.cache === "private, no-store" && dbxCalls.join() === "/Final Video/Alpha reel v2 1080p.mp4", JSON.stringify(topazDl));
    const again = await call(w.c1b.id, true);
    c.ok("…and a second press mints again (nothing kept)", again.status === 302 && dbxCalls.length === 2);
    const blobDl = await call(w.c2.id, true);
    const blobPlay = await call(w.c2.id, false, { range: "bytes=0-3" });
    c.ok("the cinematic video (the editor's file in the hub's store): relayed, attachment to download, inline to play", blobDl.status === 200 && blobDl.body === "HUBBYTES" && /^attachment; filename="Alpha cinematic.mp4"/.test(blobDl.disposition ?? "") && /^inline/.test(blobPlay.disposition ?? "") && blobFetches.length === 2, JSON.stringify([blobDl.disposition, blobPlay.disposition]));
    const portalOnly = await call(w.c5.id, true);
    c.ok("the program cut the portal holds is in the library and downloads", portalOnly.status === 200 && portalOnly.body === "HUBBYTES");
    await signIn(kyle);
    c.ok("the office downloads too", (await call(w.c6.id, true)).status === 200);
    await signIn(james);
    c.ok("so does the creative manager", (await call(w.c7.id, true)).status === 302);
    await signIn(owner, james.id);
    c.ok("the owner previewing the creative manager gets what James would", (await call(w.c1b.id)).status === 302);
    const stamped = await prisma.reviewSubmission.findMany({ where: { downloadedAt: { not: null } }, select: { id: true } });
    c.ok("NO hand-off stamp: taking a copy from the library never marks a cut 'downloaded'", stamped.length === 0, stamped.map((s) => s.id).join());
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const routeSrc = readFileSync(join(__dirname, "../../src/app/api/media/video/[id]/route.ts"), "utf8");
    c.ok("…and the route has no write in it (no markCutDownloaded, no prisma write)", !/markCutDownloaded|\.update\(|\.create\(|\.upsert\(|\.delete\(/.test(routeSrc));

    c.ok("nothing left the box but the faked Dropbox and store", fence.blocked.length === 0, fence.blocked.join());
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
