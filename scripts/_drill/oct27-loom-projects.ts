// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Jordan's Oct 27 2026 Loom, the PROJECTS items (the menu, the Projects
// page's lines, the Video Review Room's order, the program watch).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-projects.ts
//
//   M  the menu: the /jobs door reads "Projects" ("Shoots should be, maybe
//      listings or projects") on every role menu that has it; no "More" title
//      ("we can get rid of more and just leave everything showing"): the rest
//      sits under its plain group headings, all of it showing, nothing lost
//   P  the Projects page's words, pure: one line per piece, each saying what
//      it is waiting on or "Sent <date>" (photos, each video, floor plan, 3D
//      tour, anything else), revisions read "In revision", more than four
//      videos group into one counted line, a missing piece with no line of its
//      own gets one (never twice)
//   L  the list renders those lines: no hover-only title, nothing truncated,
//      no column header, the requests and holds as sentences, the grouped
//      videos under Details
//   R  the Video Review Room in Jordan's order: In revision, Ready to review,
//      Ready to send, Sent this week, then the history link; no With the
//      editors (oct19-video-review-room.ts renders it on seeded jobs)
//   W  the program watch: a delivered video leaves the list (no
//      "delivered-late" rows; oct15-program-watch.ts drives it on PGlite)
//
// ISOLATION: PGlite via the shared harness (the board's module imports
// Prisma), every outbound call fenced. The live database is never opened;
// nothing is sent.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
let pathname = "/";
const navigation = createRequire(__filename)("next/navigation") as { usePathname: () => string; useRouter: () => object };
navigation.usePathname = () => pathname;
navigation.useRouter = () => ({});

const ROOT = path.resolve(__dirname, "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Code without its comments, so a dated comment quoting Jordan never trips a check. */
const code = (rel: string) => src(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const html = (tree: unknown) => renderToStaticMarkup(tree as ReactElement);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const DASH = /[—–]|&mdash;|&ndash;/;

async function main() {
  const { stop } = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7466), env: { APP_SECRET: "oct27-loom-projects" } });
  const c = makeChecker();
  try {
    // =========================================================================
    c.head("M · the menu: Projects, and no More title");
    // =========================================================================
    const nav = await import("@/lib/sidebarNavigation");
    const { Sidebar } = await import("@/components/Sidebar");
    const menu = (role: string) => html(createElement(Sidebar, { user: { role, name: `Fixture ${role}`, email: "fixture@example.invalid", permissions: null }, scriptingUrl: "https://scripts.example.invalid" } as never));
    const sectionOf = (h: string, id: string) => {
      const m = h.match(new RegExp(`(<section[^>]*data-sidebar-group="${id}"[^>]*>)([\\s\\S]*?)</section>`));
      return { open: m?.[1] ?? "", body: m?.[2] ?? "" };
    };
    const doorLabel = (h: string, href: string) => (new RegExp(`<a\\b[^>]*href="${href.replace(/[?]/g, "\\?")}"[^>]*>[\\s\\S]*?<span class="flex-1">([^<]+)</span>`).exec(h) ?? [])[1] ?? null;
    c.ok("M1 the label is one constant: Projects", nav.PROJECTS_LABEL === "Projects");
    const menus = Object.fromEntries(["OWNER", "ADMIN", "CREATIVE_MANAGER", "EDITOR", "PHOTOGRAPHER"].map((r) => [r, menu(r)])) as Record<string, string>;
    c.ok("M2 the owner's, Kyle's and James's /jobs door reads Projects, never Shoots",
      ["OWNER", "ADMIN", "CREATIVE_MANAGER"].every((r) => doorLabel(sectionOf(menus[r], "work").body, "/jobs") === "Projects") &&
      Object.values(menus).every((h) => !/<span class="flex-1">Shoots<\/span>/.test(h)),
      ["OWNER", "ADMIN", "CREATIVE_MANAGER"].map((r) => doorLabel(menus[r], "/jobs")).join(", "));
    c.ok("M3 the old \"Shoots\" door is gone from the source too (Sidebar's own list and the role menus)",
      !/label:\s*"Shoots"/.test(code("src/lib/sidebarNavigation.ts")) && !/label:\s*"Shoots"/.test(code("src/components/Sidebar.tsx")));
    c.ok("M4 no menu shows a More title, a More fold or a More button", Object.values(menus).every((h) => !/>\s*More\s*</.test(h) && !/<details/.test(sectionOf(h, "more").body)));
    const more = ["OWNER", "ADMIN", "CREATIVE_MANAGER"].map((r) => sectionOf(menus[r], "more"));
    c.ok("M5 the rest is a named landmark with no heading of its own (aria-label Other pages)",
      more.every((s) => /aria-label="Other pages"/.test(s.open) && !/aria-labelledby/.test(s.open)), more.map((s) => s.open).join(" | "));
    const headings = (body: string) => [...body.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    c.ok("M6 the rest shows under plain group headings (the owner's: Money first, then Lists & schedule, Work, Clients, Team, Reference & help, Settings)",
      JSON.stringify(headings(more[0].body).slice(0, 2)) === JSON.stringify(["Money", "Lists & schedule"]) && ["Clients", "Settings"].every((x) => headings(more[0].body).includes(x)) &&
      more.every((s) => headings(s.body).length >= 3 && headings(s.body).every((x) => x.trim().length > 0 && x !== "More")),
      more.map((s) => headings(s.body).join("/")).join(" | "));
    const hrefs = (h: string) => [...h.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((m) => m[1].replace(/#.*$/, ""));
    c.ok("M7 everything still shows: the owner's rest holds Finance, Trends, My Day, the list, tasks, schedule, clients, settings, connections; each page once",
      ["/sales", "/trends", "/day", "/ops/checklist", "/tasks", "/schedule", "/clients", "/settings", "/connections"].every((x) => hrefs(more[0].body).includes(x)) &&
      Object.values(menus).every((h) => hrefs(h).length === new Set(hrefs(h)).size));
    c.ok("M8 money stays the owner's (not on Kyle's or James's menu)", ["ADMIN", "CREATIVE_MANAGER"].every((r) => !hrefs(menus[r]).some((x) => x === "/sales" || x === "/trends")));
    c.ok("M9 the role doors keep their own titled section (Daily work)", ["OWNER", "ADMIN", "CREATIVE_MANAGER"].every((r) => /aria-labelledby=/.test(sectionOf(menus[r], "work").open) && />Daily work</.test(menus[r])));
    pathname = "/jobs";
    c.ok("M10 on /jobs the Projects door is lit", /<a[^>]*(?:aria-current="page"[^>]*href="\/jobs"|href="\/jobs"[^>]*aria-current="page")/.test(menu("ADMIN")));
    pathname = "/";

    // =========================================================================
    c.head("P · the Projects page's words (pure)");
    // =========================================================================
    const jb = await import("@/lib/jobsBoard");
    const st = (label: string, tone: "done" | "active" | "waiting" | "late" | "none" = "active") => ({ label, tone });
    c.ok("P1 photos sent: 'Sent Oct 24' (the date they reached the client)", jb.photoPieceStatus(st("Delivered", "done"), { sentAt: new Date("2026-10-24T16:00:00Z") }) === "Sent Oct 24");
    c.ok("P2 photos not shot: 'Waiting on the shoot (Wed Oct 28)'; no date, no brackets",
      jb.photoPieceStatus(st("Not shot yet", "waiting"), { shootAt: new Date("2026-10-28T14:00:00Z") }) === "Waiting on the shoot (Wed Oct 28)" && jb.photoPieceStatus(st("Not shot yet", "waiting")) === "Waiting on the shoot",
      jb.photoPieceStatus(st("Not shot yet", "waiting"), { shootAt: new Date("2026-10-28T14:00:00Z") }));
    c.ok("P3 photos waiting on the upload say whose; in the check; waiting on review, late",
      jb.photoPieceStatus(st("Waiting for upload", "waiting"), { photographer: "Harrison Wells" }) === "Waiting on Harrison's upload" &&
      jb.photoPieceStatus(st("In QC")) === "In the photo check" && jb.photoPieceStatus(st("Ready to review", "late")) === "Waiting on review, late");
    const v = (phase: string, o: Partial<{ round: number; late: boolean; sentAt: Date; stage: string; label: string }> = {}) =>
      ({ key: `k-${phase}-${o.round ?? 0}-${o.label ?? ""}`, label: o.label ?? "Listing video", phase: phase as never, round: o.round ?? null, late: !!o.late, sentAt: o.sentAt ?? null, stage: o.stage ?? null });
    c.ok("P4 a video sent back reads 'In revision with Kim' (Jordan: \"this should just say, you know, in revision\")",
      jb.videoPieceStatus(v("changes", { round: 2 }), "Kim").status === "In revision with Kim" && !/With the editors|Changes asked/.test(jb.videoPieceStatus(v("changes"), null).status));
    c.ok("P5 a video's other states: Sent <date>, Version 2 waiting on review, Waiting on John to start (late, red), Kim is editing, Waiting on the shoot",
      jb.videoPieceStatus(v("sent", { sentAt: new Date("2026-10-24T16:00:00Z") }), "Kim").status === "Sent Oct 24" &&
      jb.videoPieceStatus(v("review", { round: 2 }), "Kim").status === "Version 2 waiting on review" &&
      jb.videoPieceStatus(v("not_cut", { stage: "Ready to edit", late: true }), "John").status === "Waiting on John to start, late" &&
      jb.videoPieceStatus(v("not_cut", { stage: "Ready to edit", late: true }), "John").tone === "late" &&
      jb.videoPieceStatus(v("editing"), "Kim").status === "Kim is editing" && jb.videoPieceStatus(v("not_shot"), "Kim").status === "Waiting on the shoot");
    c.ok("P6 approved and late stays green (late only short of approved)", jb.videoPieceStatus(v("ready", { late: true }), "Kim").tone === "done" && !/late/.test(jb.videoPieceStatus(v("ready", { late: true }), "Kim").status));
    const four = [v("sent", { label: "Reel 1", sentAt: new Date("2026-10-20T16:00:00Z") }), v("review", { label: "Reel 2", round: 1 }), v("changes", { label: "Reel 3", round: 2 }), v("not_cut", { label: "Reel 4" })];
    c.ok("P7 up to four videos: one line each, in order", jb.videoPieces(four, "Kim").map((p) => p.label).join() === "Reel 1,Reel 2,Reel 3,Reel 4" && jb.videoPieces(four, "Kim").every((p) => !p.each));
    const many = [...Array.from({ length: 30 }, (_, i) => v("sent", { label: `Video ${i + 1}`, sentAt: new Date("2026-10-20T16:00:00Z") })), ...Array.from({ length: 8 }, (_, i) => v("review", { label: `Video ${31 + i}`, round: 1 })), ...Array.from({ length: 3 }, (_, i) => v("changes", { label: `Video ${39 + i}`, round: 2, late: i < 2 }))];
    const grouped = jb.videoPieces(many, "Kim");
    c.ok("P8 more than four (Rick's 41): ONE counted line, furthest behind first, with how many are late; each video kept under it",
      grouped.length === 1 && grouped[0].label === "Videos (41)" && grouped[0].status === "3 in revision, 8 waiting on review, 30 sent (2 late)" && grouped[0].tone === "late" && grouped[0].each?.length === 41,
      `${grouped[0]?.label}: ${grouped[0]?.status}`);
    const w = jb.waitingPiece("Video 4 (Premium Social Media Reel 2): Waiting on a second shoot, half shot", 0);
    c.ok("P9 a video waiting on a second shoot: its own label and its words, not one long chip", w.label === "Video 4 (Premium Social Media Reel 2)" && w.status === "Waiting on a second shoot, half shot", JSON.stringify(w));
    c.ok("P10 the floor plan, 3D tour and the rest in words",
      jb.otherPieceStatus("Floor plan", st("Not in yet", "waiting"), { shootOver: true }) === "Waiting on CubiCasa" &&
      jb.otherPieceStatus("3D tour", st("Not in yet", "waiting"), { shootOver: false }) === "Waiting on the shoot" &&
      jb.otherPieceStatus("3D tour", st("Not in yet", "late"), { shootOver: true }) === "Not in yet, late" &&
      jb.otherPieceStatus("Floor plan", st("On the listing", "done"), { shootOver: true }) === "Sent, on the listing" &&
      jb.otherPieceStatus("Floor plan", st("Done", "done"), { shootOver: true, awaitingSend: true }) === "Ready, not sent yet" &&
      jb.otherPieceStatus("Floor plan", st("Marked delivered", "done"), { shootOver: true }) === "Marked delivered by the office");
    c.ok("P11 drone and twilight ride on the photos' line ('Photos, drone and twilight')", jb.photosLabel([]) === "Photos" && jb.photosLabel(["drone"]) === "Photos and drone" && jb.photosLabel(["drone", "twilight"]) === "Photos, drone and twilight");
    const row = { photos: st("Delivered", "done"), video: st("Not cut · Kim", "waiting"), waitingOnShoot: ["Video 2 (Premium Social Media Reel 2): Waiting on a second shoot"], shot: true, monthly: false };
    const pieces = jb.projectPiecesOf(row, {
      photoSentAt: new Date("2026-10-24T16:00:00Z"), videos: [v("changes", { label: "Listing video", round: 2 })], editor: "Kim",
      extra: { pieces: [{ label: "Floor plan", stage: st("Not in yet", "waiting") }], missing: ["Floor plan: not on the listing yet", "3D tour: not on the listing yet"], more: [{ label: "Virtual staging", stage: st("Ready to check") }], photoAddOns: ["drone"] },
    });
    c.ok("P12 one job, every piece once, in order: photos (with drone), each video, the one waiting on a second shoot, floor plan, the rest, then a missing tour with no line of its own",
      JSON.stringify(pieces.map((p) => [p.label, p.status])) === JSON.stringify([
        ["Photos and drone", "Sent Oct 24"],
        ["Listing video", "In revision with Kim"],
        ["Video 2 (Premium Social Media Reel 2)", "Waiting on a second shoot"],
        ["Floor plan", "Waiting on CubiCasa"],
        ["Virtual staging", "In, waiting on a check"],
        ["3D tour", "Not on the listing yet"],
      ]), JSON.stringify(pieces.map((p) => [p.label, p.status])));
    c.ok("P13 a caller without per-video facts (no `detail`) still gets the video as one whole line, with late said",jb.projectPiecesOf({ photos: null, video: st("Changes · Kim", "late"), shot: true, monthly: false }).map((p) => `${p.label}: ${p.status}`).join() === "Video: Changes · Kim, late");
    c.ok("P14 none of the words carry an em or en dash, 'undefined' or 'NaN'", !DASH.test(JSON.stringify([pieces, grouped])) && !/undefined|NaN/.test(JSON.stringify([pieces, grouped])));

    // =========================================================================
    c.head("L · the list renders those lines");
    // =========================================================================
    const { ShootsList } = await import("@/components/jobs/ShootsList");
    type Row = Parameters<typeof ShootsList>[0]["rows"][number];
    const base = { client: "Sam Sample", dueISO: new Date(Date.now() + 86_400_000).toISOString(), dueWords: "Wed 5 PM", late: false, dueToday: false, photos: null, video: null, requests: { open: 0, photo: 0, video: 0, needsOwner: 0 }, monthly: false, holding: null, delivered: false, dueThisWeek: true, videoSetup: null, shot: true } as const;
    const rows: Row[] = [
      { ...base, projectId: "p1", street: "34 Oakland Ave", href: "/projects/p1", pieces, requests: { open: 2, photo: 1, video: 1, needsOwner: 1 }, holding: "Waiting on video · Floor plan" } as Row,
      { ...base, projectId: "p2", street: "9 Rick Schultz Way", href: "/projects/p2", pieces: grouped, monthly: true, late: true, dueWords: "2 days late" } as Row,
    ];
    const lh = html(createElement(ShootsList, { rows, empty: "none" }));
    const lt = text(lh);
    c.ok("L1 one card per job, the street opening the job, then one line per piece", (lh.match(/data-shoot-row=/g) ?? []).length === 2 && lh.includes('href="/projects/p1"') && (lh.match(/data-piece=/g) ?? []).length >= 7 && /34 Oakland Ave Sam Sample Due Wed 5 PM/.test(lt), lt.slice(0, 300));
    c.ok("L2 each line reads label then status ('Listing video In revision with Kim', 'Floor plan Waiting on CubiCasa')", /Listing video In revision with Kim/.test(lt) && /Floor plan Waiting on CubiCasa/.test(lt) && /Photos and drone Sent Oct 24/.test(lt));
    c.ok("L3 no hover-only text, nothing truncated or clamped, no column header", !/\stitle="/.test(lh) && !/\btruncate\b|line-clamp|text-ellipsis/.test(lh) && !/Shoot Due Photos Video Requests/.test(lt) && !/sm:hidden|hidden sm:/.test(lh));
    c.ok("L4 the holds and the requests are sentences ('Holding it: Waiting on video, Floor plan'; 'Client requests: 2 open, 1 needs an owner')", /Holding it: Waiting on video, Floor plan/.test(lt) && /Client requests: 2 open, 1 needs an owner/.test(lt) && !/·/.test(text(lh.slice(lh.indexOf("data-holding"), lh.indexOf("</p>", lh.indexOf("data-holding"))))));
    c.ok("L5 the grouped videos: one line, then 'Details: each video' holding all 41", /Videos \(41\) 3 in revision, 8 waiting on review, 30 sent \(2 late\)/.test(lt) && /<details[^>]*>\s*<summary[^>]*>Details: each video<\/summary>/.test(lh) && (lh.slice(lh.indexOf("Details: each video")).match(/data-piece=/g) ?? []).length === 41);
    c.ok("L6 monthly content under its own heading; a late job says how late in red", lh.indexOf("data-monthly-heading") < lh.indexOf("9 Rick Schultz Way") && /font-semibold text-danger[^>]*>2 days late</.test(lh));
    c.ok("L7 no 'none', 'n/a' or dash in the list", !/\bnone\b|n\/a/.test(lt) && !DASH.test(lh));

    // =========================================================================
    c.head("R · the Video Review Room's order (source)");
    // =========================================================================
    const review = code("src/app/review/page.tsx");
    const at = (s: string) => review.indexOf(s);
    c.ok("R1 In revision, Ready to review, Ready to send, Sent this week, then the history link, in that order",
      at('title="In revision"') > 0 && at('title="In revision"') < at('title="Ready to review"') && at('title="Ready to review"') < at('title="Ready to send"') && at('title="Ready to send"') < at('title="Sent this week"') && at('title="Sent this week"') < at("History: approved and sent videos"));
    c.ok("R2 no With the editors section and no 'with editors' count left in the code", !/With the editors|with editors/i.test(review));
    c.ok("R3 In revision lists only the versions sent back (CHANGES_REQUESTED), each reading 'In revision'", /\.filter\(\(r\) => r\.cutStatus === "CHANGES_REQUESTED"\)/.test(review) && /`In revision\$\{/.test(review));

    // =========================================================================
    c.head("W · the program watch drops a delivered video");
    // =========================================================================
    const pw = code("src/lib/programWatch.ts");
    c.ok("W1 no delivered-late rows are built any more (a delivered video leaves the list)", !/level:\s*"delivered-late"/.test(pw) && !/DELIVERED_LATE_DAYS/.test(pw));

    c.ok("provider fence stayed closed", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
