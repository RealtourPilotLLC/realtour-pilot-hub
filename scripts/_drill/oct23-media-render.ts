// Oct 23 2026: THE MEDIA LIBRARY AND THE LISTING PAGES, RENDERED. The real
// /media, /listings and /listings/<job> pages server-rendered to HTML as
// Jordan, Kyle, James, Jordan previewing James, and refused for a
// photographer and an editor. Each tab draws its groups in order with real
// titles, dates, clients and the four actions; Photos is one tile per
// address, a page at a time; search and dates narrow; the listing page shows
// the Aryeo listing (photos with a viewer and one-file downloads, videos,
// floor plan, 3D tour, files) plus the hub's master files, and says so when
// Aryeo does not answer. No money, no Dropbox address, nothing that posts, no
// Aryeo call for /media or /listings. The menu gains exactly one door, Media,
// under More. Disposable PGlite; Aryeo is faked at the fence; nothing leaves.
// The rendered pages are written to $TMPDIR/rtp-media-render/ for the visual check.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";
import { buildManyListings, buildMediaWorld } from "./_fixtures/mediaLibrary";

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/media";

const aryeoCalls: string[] = [];
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const LISTINGS: Record<string, unknown> = {
  "L-alpha": {
    id: "L-alpha", delivery_status: "DELIVERED", thumbnail_url: "https://cdn.aryeo.com/listings/10-alpha-st/thumb.jpg",
    images: [1, 2, 3].map((i) => ({ thumbnail_url: `https://cdn.aryeo.com/i/${i}-t.jpg`, large_url: `https://cdn.aryeo.com/i/${i}-l.jpg`, original_url: `https://cdn.aryeo.com/i/${i}.jpg`, caption: i === 1 ? "Front of the house" : null, filename: null, display_in_gallery: true }))
      .concat([{ thumbnail_url: "https://cdn.aryeo.com/i/hidden-t.jpg", large_url: "https://cdn.aryeo.com/i/hidden-l.jpg", original_url: "https://cdn.aryeo.com/i/hidden.jpg", caption: null, filename: null, display_in_gallery: false }]),
    videos: [
      { id: "v-reel", title: "Alpha Social Reel", thumbnail_url: "https://image.mux.com/alpha-reel/thumbnail.jpg", playback_url: "https://stream.mux.com/alpha-reel", download_url: "https://videos.aryeo.com/alpha-reel.mp4", duration: 48 },
      { id: "v-cine", title: "Alpha Cinematic", thumbnail_url: "https://image.mux.com/alpha-cine/thumbnail.jpg", playback_url: "https://stream.mux.com/alpha-cine", download_url: "https://videos.aryeo.com/alpha-cine.mov", duration: 92 },
    ],
    floor_plans: [{ title: "Main level", thumbnail_url: "https://cdn.aryeo.com/fp/1-t.png", large_url: "https://cdn.aryeo.com/fp/1-l.png", original_url: "https://cdn.aryeo.com/fp/1.png" }],
    interactive_content: [{ id: "ic1", content_type: "MATTERPORT", display_type: "BOTH", url: "https://my.matterport.com/show/?m=alpha", thumbnail_url: null }, { id: "ic2", url: "javascript:alert(1)" }],
    files: [{ id: "f1", title: "Property brochure", url: "https://cdn.aryeo.com/files/brochure.pdf" }],
  },
  "L-mo": { id: "L-mo", delivery_status: "DELIVERED", images: [], videos: [], floor_plans: [], interactive_content: [], files: [] },
};
const fence = fenceFetch((url) => {
  const m = /^https:\/\/api\.aryeo\.com\/v1\/listings\/([^?/]+)/.exec(url);
  if (m) {
    aryeoCalls.push(m[1]);
    const l = LISTINGS[decodeURIComponent(m[1])];
    return l ? json({ data: l }) : json({ message: "Server Error" }, 500);
  }
  return null;
});

const OUT = path.join(os.tmpdir(), "rtp-media-render");
const save = (name: string, html: string) => { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${name}.html`), html); } catch { /* the visual check is optional */ } };
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
type Props = Record<string, unknown>;
/** Every element of a component in a rendered page's tree (a client component's props are what the browser gets). */
function propsOf(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => propsOf(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => propsOf(part, name))];
}
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 4732), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-media-render" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("aryeo", "drill-key-not-a-real-one");
    const T = new Date();
    const w = await buildMediaWorld(prisma, T);
    await buildManyListings(prisma, T, 30);
    const { default: MediaPage } = await import("@/app/media/page");
    const { default: ListingsPage } = await import("@/app/listings/page");
    const { default: ListingPage } = await import("@/app/listings/[projectId]/page");

    const user = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@render.invalid`, role, status: "ACTIVE", ...extra } });
    const owner = await user("Jordan Spackman", "OWNER");
    const kyle = await user("Kyle Smith", "ADMIN");
    const james = await user("James Livingston", "CREATIVE_MANAGER");
    const harrison = await user("Harrison Wells", "PHOTOGRAPHER");
    const kim = await user("Kim Editor", "EDITOR", { editorKey: "kim", permissions: JSON.stringify({ media: true }) });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const media = async (sp: Record<string, string> = {}) => ssr(await MediaPage({ searchParams: Promise.resolve(sp) }));
    const tabCount = (html: string, tab: string) => html.match(new RegExp(`data-media-tab="${tab}"[\\s\\S]*?data-count="(\\d*)"`))?.[1] ?? "";
    const groups = (html: string) => [...html.matchAll(/data-media-group="([^"]+)"/g)].map((m) => m[1]);
    const tiles = (html: string) => [...html.matchAll(/data-media-video="([^"]+)"/g)].map((m) => m[1]);
    const clean = (html: string, who: string) => {
      c.ok(`${who}: no money, no Dropbox address, nothing that posts`, !/\$\s?\d/.test(html) && !/dropbox/i.test(html) && !/<form[^>]*method="post"/i.test(html));
    };

    // =====================================================================
    c.head("§1 · Jordan's /media opens on Standard videos");
    // =====================================================================
    await signIn(owner);
    const before = aryeoCalls.length;
    const std = await media();
    save("media-standard", std);
    c.ok("renders, Standard tab current", !std.startsWith("RENDER FAILED") && std.includes('data-tab="standard"') && /data-media-tab="standard"[^>]*aria-current="page"|aria-current="page"[^>]*data-media-tab="standard"/.test(std), std.slice(0, 200));
    c.ok("tab counts: 1 standard, 2 premium, 3 monthly, 31 photo addresses", tabCount(std, "standard") === "1" && tabCount(std, "premium") === "2" && tabCount(std, "monthly") === "3" && tabCount(std, "photos") === "31", ["standard", "premium", "monthly", "photos"].map((t) => tabCount(std, t)).join());
    c.ok("one group, Standard Cinematic Video, one horizontal tile: the Alpha cinematic", groups(std).join() === "standard_cinematic" && tiles(std).join() === `cut:${w.c2.id}` && std.includes('data-frame="horizontal"') && std.includes("Standard Cinematic Video"));
    const t = text(std);
    c.ok("the tile: its title (the address), the product above it, delivered date, the client", t.includes("10 Alpha St") && /Delivered [A-Z][a-z]{2} \d{1,2}, \d{4} Agent Alpha/.test(t), t.slice(t.indexOf("Standard Cinematic Video"), t.indexOf("Standard Cinematic Video") + 200));
    c.ok("…a real player: Play button, no file fetched until on screen or pressed (no <video> in the HTML)", std.includes(`aria-label="Play 10 Alpha St"`) && !/<video\b/.test(std));
    c.ok("…the four actions: Download (the media route), View larger, the listing, the client", std.includes(`href="/api/media/video/${w.c2.id}?dl=1"`) && std.includes(`aria-label="View 10 Alpha St larger"`) && std.includes(`href="/listings/${w.p1.id}"`) && std.includes(`href="/clients/${w.alpha.id}"`));
    c.ok("…every action is a 44px target", !/min-h-(?:8|9|10)\b/.test(std) && /size-11/.test(std));
    const form = std.match(/<form[^>]*>/)?.[0] ?? "";
    c.ok("a search box, a date picker and the order, all a plain GET form", form.includes('role="search"') && form.includes('method="get"') && form.includes('action="/media"') && std.includes('name="range"') && std.includes('name="sort"') && std.includes(`value="y${new Date().getFullYear()}"`), form);
    clean(std, "standard tab");
    c.ok("no Aryeo call to draw /media", aryeoCalls.length === before);

    // =====================================================================
    c.head("§2 · Premium and Monthly social");
    // =====================================================================
    const prem = await media({ tab: "premium" });
    save("media-premium", prem);
    c.ok("Premium: one group (Premium Social Media Reel), two vertical tiles, newest first", groups(prem).join() === "premium_social_reel" && tiles(prem).join() === `cut:${w.c1b.id},cut:${w.c7.id}` && prem.includes('data-frame="vertical"'), tiles(prem).join());
    c.ok("…the replaced first round of the reel is not shown, and the reel shows its length", !prem.includes(w.c1.id) && prem.includes(">0:48<"));
    const mon = await media({ tab: "monthly" });
    save("media-monthly", mon);
    c.ok("Monthly social: Video Accelerator first, then Branding packages", groups(mon).join() === "program_accelerator,branding_package", groups(mon).join());
    const mt = text(mon);
    c.ok("…the program video by its topic title and month; the Aryeo one with Aryeo's poster", mt.includes("Why Your Lot Decides Your Floor Plan") && mt.includes("October 2026") && mon.includes('src="https://image.mux.com/oneday/thumbnail.jpg"') && mon.includes('loading="lazy"'));
    c.ok("…the hub cut keeps the poster of its older Aryeo copy, which is not a second tile", mon.includes('src="https://image.mux.com/lot/thumbnail.jpg"') && tiles(mon).length === 3);
    c.ok("…the branding package video is 'video 3 of 16' at its address", mt.includes("893 Branding Ln · video 3 of 16"));
    clean(prem + mon, "premium and monthly tabs");

    // =====================================================================
    c.head("§3 · Photos: by address, a page at a time");
    // =====================================================================
    const ph = await media({ tab: "photos" });
    save("media-photos", ph);
    const phTiles = [...ph.matchAll(/data-listing-tile="([^"]+)"/g)].map((m) => m[1]);
    c.ok("24 address tiles, newest first, then 'Show 7 more'", phTiles.length === 24 && phTiles[0] === w.p1.id && text(ph).includes("Show 7 more") && ph.includes("n=48"), `${phTiles.length} ${text(ph).match(/Show \d+ more/)?.[0]}`);
    c.ok("the address shot twice is one tile, with its earlier shoot linked ('Also shot')", phTiles.filter((id) => id === w.p8.id).length === 0 && text(ph).includes("Also shot") && ph.includes(`href="/listings/${w.p8.id}"`));
    c.ok("each tile: cover (lazy), the count, the delivered date, opening the listing page", ph.includes('src="https://cdn.aryeo.com/listings/10-alpha-st/cover.jpg"') && text(ph).includes("41 photos") && ph.includes(`href="/listings/${w.p1.id}"`));
    const ph2 = await media({ tab: "photos", n: "48" });
    c.ok("Show more: all 31, no more button", count(ph2, /data-listing-tile=/g) === 31 && !/Show \d+ more/.test(text(ph2)));
    clean(ph, "photos tab");

    // =====================================================================
    c.head("§4 · search and dates");
    // =====================================================================
    const q1 = await media({ tab: "photos", q: "alpha" });
    c.ok("search 'alpha' on Photos: the one Alpha address", count(q1, /data-listing-tile=/g) === 1 && tabCount(q1, "photos") === "1" && tabCount(q1, "premium") === "1", ["standard", "premium", "monthly", "photos"].map((x) => tabCount(q1, x)).join());
    const q2 = await media({ q: "zzz no such place" });
    c.ok("a search that matches nothing says so, plainly", text(q2).includes("No videos match. Clear the search or pick another date."));
    const r1 = await media({ tab: "premium", range: "30d" });
    const r2 = await media({ tab: "premium", range: "y2020" });
    c.ok("last 30 days keeps both reels; 2020 has none", tiles(r1).length === 2 && tiles(r2).length === 0 && text(r2).includes("No videos match"));
    const old = await media({ tab: "premium", sort: "old" });
    c.ok("oldest first flips the order", tiles(old).join() === `cut:${w.c7.id},cut:${w.c1b.id}`);

    // =====================================================================
    c.head("§5 · who sees it");
    // =====================================================================
    await signIn(kyle);
    const k = await media({ tab: "premium" });
    c.ok("Kyle (office): the same library", !k.startsWith("RENDER FAILED") && tiles(k).length === 2);
    await signIn(james);
    const j = await media({ tab: "monthly" });
    c.ok("James (creative manager): the same library", !j.startsWith("RENDER FAILED") && tiles(j).length === 3);
    await signIn(owner, james.id);
    const v = await media();
    c.ok("Jordan previewing James: the library, read-only by nature (nothing on it writes)", !v.startsWith("RENDER FAILED") && tiles(v).length === 1 && !/<form[^>]*method="post"/i.test(v));
    const refused = async (u: { id: string; email: string; role: string }) => { await signIn(u); return MediaPage({ searchParams: Promise.resolve({}) }).then(() => "rendered", (e: Error) => e.message); };
    c.ok("a photographer is sent home, never shown it", /redirect/.test(await refused(harrison)));
    c.ok("an editor, even with a media key, is sent home", /redirect/.test(await refused(kim)));
    await signIn(owner, harrison.id);
    c.ok("Jordan previewing the photographer: sent home as the photographer would be", /redirect/.test(await MediaPage({ searchParams: Promise.resolve({}) }).then(() => "rendered", (e: Error) => e.message)));
    await signIn(owner);

    // =====================================================================
    c.head("§6 · /listings: every delivered listing");
    // =====================================================================
    const beforeIdx = aryeoCalls.length;
    const idx = ssr(await ListingsPage({ searchParams: Promise.resolve({}) }));
    save("listings-index", idx);
    const cards = [...idx.matchAll(/data-listing-tile="([^"]+)"/g)].map((m) => m[1]);
    c.ok("renders 24 listings newest first, then Show more", !idx.startsWith("RENDER FAILED") && cards.length === 24 && cards[0] === w.p1.id && /Show \d+ more/.test(text(idx)));
    c.ok("each says what was delivered ('Photos · Video · Floor plan')", text(idx).includes("Photos · Video · Floor plan"));
    const idxQ = ssr(await ListingsPage({ searchParams: Promise.resolve({ q: "video only" }) }));
    c.ok("searchable: 'video only' finds the video-only listing", [...idxQ.matchAll(/data-listing-tile="([^"]+)"/g)].map((m) => m[1]).join() === w.p9.id);
    c.ok("no Aryeo call to draw the index", aryeoCalls.length === beforeIdx);
    clean(idx, "listings index");

    // =====================================================================
    c.head("§7 · /listings/<job>: the property page, like Aryeo's");
    // =====================================================================
    const beforeL = aryeoCalls.length;
    const lpTree = await ListingPage({ params: Promise.resolve({ projectId: w.p1.id }) });
    const lp = ssr(lpTree);
    const galleries = propsOf(lpTree, "ListingGallery") as { photos: { downloadHref: string; large: string }[]; noun?: string }[];
    save("listing-page", lp);
    const lt = text(lp);
    c.ok("renders: one Aryeo read for the page", !lp.startsWith("RENDER FAILED") && aryeoCalls.length === beforeL + 1, lp.slice(0, 300));
    c.ok("hero: the cover photo, the street big, the town, delivered date, the agent", lp.includes('src="https://cdn.aryeo.com/listings/10-alpha-st/cover.jpg"') && /<h1[^>]*>10 Alpha St<\/h1>/.test(lp) && lt.includes("Townville, PA 19000") && /Delivered [A-Z][a-z]{2} \d{1,2}, \d{4}/.test(lt) && lt.includes("Agent Alpha"));
    c.ok("…what was delivered: 3 photos · 2 videos · Floor plan · 3D tour (a hidden gallery photo is not counted)", lt.includes("3 photos · 2 videos · Floor plan · 3D tour"));
    c.ok("photos: a grid that opens a full-screen viewer, and 'Download all 3 photos' (one file at a time)", count(lp, /aria-label="Open photo \d of 3/g) === 3 && lt.includes("Download all 3 photos") && lp.includes("<dialog"));
    c.ok("…each photo downloads full size, on its own, through the staff proxy with a readable name; the viewer shows the large size", galleries.length === 2 && galleries[0].photos.length === 3 && galleries[0].photos[0].downloadHref === `/api/media/download?url=${encodeURIComponent("https://cdn.aryeo.com/i/1.jpg")}&name=10-alpha-st-01.jpg` && galleries[0].photos[0].large === "https://cdn.aryeo.com/i/1-l.jpg" && galleries[1].noun === "floor plan" && galleries[1].photos[0].downloadHref.endsWith("&name=10-alpha-st-floor-plan-1.png"), JSON.stringify(galleries.map((g) => g.photos[0]?.downloadHref)));
    c.ok("videos: the two on the listing, with Aryeo's posters", lp.includes('data-media-group="listing-videos"') && lp.includes('src="https://image.mux.com/alpha-reel/thumbnail.jpg"') && lt.includes("Alpha Cinematic"));
    c.ok("…and the hub's master files under them (the reel's 1080p file and the cinematic), Watch and Download", count(lp, /data-media-file=/g) === 2 && lp.includes(`href="/api/media/video/${w.c1b.id}?dl=1"`) && lt.includes("Master files from the hub"));
    c.ok("…no 'Open listing' on its own page", !lp.includes(`href="/listings/${w.p1.id}"`));
    c.ok("floor plan, the 3D tour (a new tab), the brochure; an unsafe link is dropped", lt.includes("Floor plans") && lp.includes('href="https://my.matterport.com/show/?m=alpha"') && lt.includes("Matterport") && lt.includes("Property brochure") && !lp.includes("javascript:"));
    c.ok("the earlier shoot at this address is one press away", lt.includes("Other shoots at this address") && lp.includes(`href="/listings/${w.p8.id}"`));
    c.ok("the client, the job and Aryeo are linked", lp.includes(`href="/clients/${w.alpha.id}"`) && lp.includes(`href="/projects/${w.p1.id}"`) && lp.includes("realtourpilot.aryeo.com/admin/listings/L-alpha/edit"));
    clean(lp, "listing page");
    const lpMo = ssr(await ListingPage({ params: Promise.resolve({ projectId: w.p3.id }) }));
    save("listing-page-monthly", lpMo);
    c.ok("a content session with nothing on its listing: the hub's finished videos are the videos", lpMo.includes('data-media-group="hub-videos"') && lpMo.includes(`data-media-video="cut:${w.c5.id}"`) && !lpMo.includes("Nothing is on this Aryeo listing yet"));
    const lpDown = ssr(await ListingPage({ params: Promise.resolve({ projectId: w.p9.id }) }));
    c.ok("Aryeo not answering: the page says so in words, and still renders", !lpDown.startsWith("RENDER FAILED") && text(lpDown).includes("Aryeo didn't answer just now"));
    const lpNone = await ListingPage({ params: Promise.resolve({ projectId: "nosuchprojectid0000" }) }).then(() => "rendered", (e: Error) => e.message);
    c.ok("an unknown job: not found", /notFound/.test(lpNone));
    await signIn(harrison);
    c.ok("a photographer opening a listing page is sent home", /redirect/.test(await ListingPage({ params: Promise.resolve({ projectId: w.p1.id }) }).then(() => "rendered", (e: Error) => e.message)));
    await signIn(owner);

    // =====================================================================
    c.head("§8 · the job page links it; the menu has one new door");
    // =====================================================================
    const jobSrc = fs.readFileSync(path.join(__dirname, "../../src/app/projects/[id]/page.tsx"), "utf8");
    c.ok("the job page carries 'Listing page' for whoever may open the library", /href=\{`\/listings\/\$\{project\.id\}`\}/.test(jobSrc) && /mayOpenMedia\(viewer\)/.test(jobSrc) && jobSrc.includes("Listing page"));
    const { Sidebar } = await import("@/components/Sidebar");
    const menu = (role: string, permissions: string | null = null) => renderToStaticMarkup(createElement(Sidebar, { user: { name: "x", email: "x@render.invalid", role, permissions } }));
    const section = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-sidebar-group="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
    c.ok("Media is one door under More for the owner, the office and the creative manager, never a role door", ["OWNER", "ADMIN", "CREATIVE_MANAGER"].every((r) => { const h = menu(r); return count(h, /href="\/media"/g) === 1 && section(h, "more").includes('href="/media"') && !section(h, "work").includes('href="/media"') && h.includes(">Media<"); }));
    c.ok("…and no door for a photographer or an editor, even with a media key", ["PHOTOGRAPHER", "EDITOR"].every((r) => !menu(r, JSON.stringify({ media: true })).includes('href="/media"')));

    c.ok("nothing left the box but the faked Aryeo listing reads", fence.blocked.length === 0, fence.blocked.join());
    console.log(`\n  rendered pages: ${OUT}`);
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
