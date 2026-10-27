// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Render the real Sidebar before/after grouping; only Next's location is injected.
// No database, cookies, network, notification writes or client actions are used.
import React from "react";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShellUser } from "../../src/components/Sidebar";
import { activeSidebarHref, groupSidebarDestinations } from "../../src/lib/sidebarNavigation";

const BASE = "9d86c14f824c3861d324c6503bdf98893a1576be";
const REPO = path.resolve(__dirname, "../..");
let pathname = "/";
const navigation = createRequire(__filename)("next/navigation") as { usePathname: () => string; useRouter: () => object };
navigation.usePathname = () => pathname;
navigation.useRouter = () => ({});
const user = (role: string, permissions?: Record<string, boolean>): ShellUser => ({ role, name: `Fixture ${role}`, email: "fixture@example.invalid", permissions: permissions ? JSON.stringify(permissions) : null });
const cases: [string, ShellUser | null][] = [
  ["owner", user("OWNER")], ["admin", user("ADMIN")], ["editor", user("EDITOR")], ["photographer", user("PHOTOGRAPHER")], ["open development", null],
  ["James personal-pay grant", user("ADMIN", { mypay: true, sales: false, trends: false })],
  ["admin financial exception", user("ADMIN", { sales: true, trends: true, connections: true })],
  ["admin revoked destinations", user("ADMIN", { dashboard: false, review: false, resources: false, settings: false, feedback: false, content: false })],
  ["editor explicit grants", user("EDITOR", { review: true, mypay: true, feedback: true, users: true, settings: true, connections: true })],
  ["photographer resources/review grants", user("PHOTOGRAPHER", { resources: true, review: true, feedback: true })],
  ["photographer pay and upload revoked", user("PHOTOGRAPHER", { mypay: false, upload: false })],
  ["unknown role", user("UNKNOWN")],
];
// A door that opens a section of its page (Kyle's Video Delivery →
// /review#ready-to-send, Oct 22 2026) is still that destination.
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((match) => match[1].replace(/#.*$/, "")).sort();
const group = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-sidebar-group="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? "";
let checked = 0;
function check(label: string, condition: boolean) { assert.ok(condition, label); checked++; console.log(`PASS ${label}`); }

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "u4-sidebar-before-"));
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("Sidebar SSR must not call a provider"); };
  try {
    // Freeze the prior shipped filter implementation, not a mirrored rule list.
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(temp, "node_modules"));
    const oldFile = path.join(temp, "Sidebar.tsx");
    const old = execFileSync("git", ["show", `${BASE}:src/components/Sidebar.tsx`], { cwd: REPO, encoding: "utf8" });
    fs.writeFileSync(oldFile, 'import React from "react";\nvoid React;\n' + old.replace(/(["'])@\/([^"']+)\1/g, (_match, quote: string, file: string) => `${quote}${path.join(REPO, "src", file)}${quote}`));
    const { Sidebar: Before } = await import(oldFile) as typeof import("../../src/components/Sidebar");
    const { Sidebar } = await import("../../src/components/Sidebar");
    const render = (component: typeof Sidebar, who: ShellUser | null, scriptingUrl: string | null = "https://scripts.example.invalid") => renderToStaticMarkup(React.createElement(component, { user: who, scriptingUrl }));
    for (const [name, who] of cases) {
      const before = render(Before, who);
      const after = render(Sidebar, who);
      // Oct 14 2026: "Client activity" (/content/activity) and "Photo Delivery"
      // (/ops/photo-delivery, owner + office via the ops PageKey) are the
      // destinations added since BASE. Oct 19 2026 (night): the Shoots board
      // (/jobs, ops PageKey) and the owner's My Day (/day, which left the
      // dashboard). /ops (now a redirect to the dashboard) and /ops/messages
      // (merged into /communications) are no destinations any more. Oct 21
      // 2026: Your list (/ops/checklist, owner + office) under More → Lists.
      // Oct 23 2026: Media (/media, owner, office, creative manager) under More → Work.
      const ADDED = new Set(["/content/activity", "/ops/photo-delivery", "/jobs", "/day", "/ops/checklist", "/media"]);
      // Oct 22 2026 (Jordan's approved role menus): menu entries taken OFF a
      // role (still reachable by URL, no permission changed): the Style Guide
      // and Communication coaching for the office, the Editing Room for
      // photographers.
      const role = who?.role ?? null;
      const REMOVED = new Set(role === "ADMIN" ? ["/resources/video-styles", "/coaching"] : role === "PHOTOGRAPHER" ? ["/editing"] : []);
      check(`${name}: same authorized destinations as before grouping (less the entries the approved menus take off)`, JSON.stringify(hrefs(before).filter((h) => !REMOVED.has(h))) === JSON.stringify(hrefs(after).filter((h) => !ADDED.has(h))));
      check(`${name}: every destination still appears once`, hrefs(after).length === new Set(hrefs(after)).size);
    }
    const owner = render(Sidebar, user("OWNER"));
    const admin = render(Sidebar, user("ADMIN"));
    const editor = render(Sidebar, user("EDITOR"));
    const photographer = render(Sidebar, user("PHOTOGRAPHER"));
    // Oct 22 2026 (Jordan: "The 4 menus and alerts are good"): each role its
    // own doors, everything else folded under More; editors keep the groups.
    const doorHrefs = (html: string) => [...group(html, "work").matchAll(/href="([^"]+)"/g)].map((m) => m[1]).join();
    const doorLabels = (html: string) => [...group(html, "work").matchAll(/<span class="flex-1">([^<]+)<\/span>/g)].map((m) => m[1]).join();
    const creative = render(Sidebar, user("CREATIVE_MANAGER"));
    const MENUS: [string, string, string, string][] = [
      // Oct 23 2026 (Jordan): "Photo Delivery" and "Video Delivery" on every role menu that has them.
      ["owner", owner, "/,/review,/editing,/content,/ops/photo-delivery,/communications,/jobs", "Dashboard,Video Delivery,Editing Room,Monthly Content,Photo Delivery,Messages,Projects"],
      ["open development", render(Sidebar, null), "/,/review,/editing,/content,/ops/photo-delivery,/communications,/jobs", "Dashboard,Video Delivery,Editing Room,Monthly Content,Photo Delivery,Messages,Projects"],
      // Kyle's door read "Ready to send": Video Delivery now, still opening that section.
      ["ADMIN (Kyle)", admin, "/,/ops/checklist,/communications,/ops/photo-delivery,/review#ready-to-send,/editing,/jobs", "Dashboard,Your list,Messages,Photo Delivery,Video Delivery,Editing Room,Projects"],
      // Oct 22 2026: Photo Delivery (the view-only desk) joins James's doors where the owner's menu has it.
      // Oct 27 2026 (Jordan's decisions: the team sees its own pay): the door reads My Pay unless pay is hidden.
      ["CREATIVE_MANAGER (James)", creative, "/,/review,/editing,/content,/ops/photo-delivery,/upload,/jobs,/my-pay", "Dashboard,Video Delivery,Editing Room,Monthly Content,Photo Delivery,Uploads,Projects,My Pay"],
      ["PHOTOGRAPHER (Harrison)", photographer, "/shoot,/upload,/review,/my-pay,/resources", "My Shoots,Upload,My Videos,My Pay,Help"],
    ];
    // Oct 27 2026 (Jordan's Loom): the /jobs door reads "Projects" (it read "Shoots"); the rest of the menu shows
    // under plain group headings with no "More" title over them (the section keeps its data-sidebar-group="more").
    for (const [who, html, hrefList, labelList] of MENUS) {
      check(`${who}: own doors in order (${labelList}), then More`, [...html.matchAll(/data-sidebar-group="([^"]+)"/g)].map((match) => match[1]).join() === "work,more" && doorHrefs(html) === hrefList && doorLabels(html) === labelList && !group(html, "work").includes("<details"));
    }
    check("ADMIN: More is open (Jordan, Oct 23 2026) and holds everything else the login can open (nothing removed but Style Guide and coaching)", !group(admin, "more").includes("<details") && ["/tasks", "/upload", "/content", "/content/activity", "/clients", "/users", "/quality", "/resources", "/training", "/assistant", "/settings", "/schedule"].every((h) => hrefs(group(admin, "more")).includes(h)) && !hrefs(admin).includes("/resources/video-styles") && !hrefs(admin).includes("/coaching"));
    check("owner: More holds the rest, money first, My Day included", !group(owner, "more").includes("<details") && ["/tasks", "/clients", "/sales", "/trends", "/day", "/connections", "/schedule"].every((h) => hrefs(group(owner, "more")).includes(h)) && [...group(owner, "more").matchAll(/data-sidebar-subgroup="([^"]+)"/g)].map((m) => m[1])[0] === "money");
    check("ADMIN: reporting a hub issue is one click away in the open menu", group(admin, "more").includes('href="/feedback"'));
    // Oct 23 2026 (Jordan: "Instead of Photo and Video, I want it to be Photo Delivery and Video Delivery").
    const allLabels = (html: string) => [...html.matchAll(/<span class="flex-1">([^<]+)<\/span>/g)].map((m) => m[1]);
    const doorList = (html: string) => doorLabels(html).split(",");
    check("'Video Delivery' and 'Photo Delivery' on every role menu that has them (Kyle's door too); a photographer keeps My Videos", [owner, admin, creative].every((html) => doorList(html).includes("Video Delivery") && doorList(html).includes("Photo Delivery")) && doorList(photographer).includes("My Videos") && !doorList(photographer).includes("Video Delivery"));
    check("…and no menu, for any login, still says Photos, Videos, Photo delivery or Ready to send", cases.every(([, who]) => !allLabels(render(Sidebar, who)).some((l) => ["Photos", "Videos", "Photo delivery", "Ready to send"].includes(l))) && allLabels(render(Sidebar, user("EDITOR", { review: true }))).includes("Video Delivery"));
    check("the retired screens are no menu entry for anyone", !cases.some(([, who]) => render(Sidebar, who).includes("Video Review Room")) && cases.every(([, who]) => !hrefs(render(Sidebar, who)).some((h) => ["/ops", "/ops/messages", "/ops/video-delivery", "/ops/requests", "/ops/scheduling", "/ops/old"].includes(h))));
    check("office-only screens stay off creatives' menus (no dashboard, no Shoots, no Photos)", [editor, photographer].every((html) => !hrefs(html).some((h) => h.startsWith("/ops") || h === "/jobs" || h === "/")) && !editor.includes('data-sidebar-group="work"'));
    check("editors keep their groups: Production stays directly visible", !group(editor, "production").includes("<details") && group(editor, "production").includes('href="/editing"'));
    check("photographers: no Editing Room door (their briefs open from the shoot)", !hrefs(photographer).includes("/editing"));
    check("More is open for every role menu, no fold (Jordan, Oct 23 2026)", [owner, admin, creative, photographer].every((html) => !group(html, "more").includes("<details")));
    check("Monthly Content and Clients are under More for the office; Monthly Content is a door for the owner and the creative manager", ["/content", "/clients"].every((h) => hrefs(group(admin, "more")).includes(h)) && [owner, creative].every((html) => hrefs(group(html, "work")).includes("/content")));
    // Oct 23 2026 (Jordan: "don't change the menu"): the media library adds exactly one door, under More.
    check("Media: one door under More (never a role door) for the owner, the office and the creative manager; none for editors or photographers, even with a media key", [owner, admin, creative].every((html) => hrefs(group(html, "more")).filter((h) => h === "/media").length === 1 && !hrefs(group(html, "work")).includes("/media")) && [editor, photographer, render(Sidebar, user("EDITOR", { media: true })), render(Sidebar, user("PHOTOGRAPHER", { media: true }))].every((html) => !hrefs(html).includes("/media")));
    check("Client activity under More for the owner, the office and the creative manager, and nobody else", [owner, admin, creative].every((html) => hrefs(group(html, "more")).includes("/content/activity")) && [editor, photographer].every((html) => !hrefs(html).includes("/content/activity")) && !hrefs(render(Sidebar, user("EDITOR", { content: true }))).includes("/content/activity"));
    check("disclosure summaries participate in the existing drawer focus selector", [...owner.matchAll(/<summary\b([^>]*)>/g)].every((match) => match[1].includes('tabindex="0"')));
    const both = renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(Sidebar, { user: user("OWNER") }), React.createElement(Sidebar, { user: user("OWNER") })));
    const ids = [...both.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    check("desktop and drawer instances have unique labelled group IDs", ids.length > 0 && ids.length === new Set(ids).size);
    check("issue report stays in the open menu", group(owner, "more").includes('href="/feedback"') && owner.includes("Report a hub problem"));
    check("admin keeps operational destinations without default financial access", !hrefs(admin).includes("/sales") && !hrefs(admin).includes("/trends") && !hrefs(admin).includes("/my-pay") && !hrefs(admin).includes("/connections"));
    check("photographer-specific exclusions remain; the SOP Center is their Help door", !hrefs(photographer).includes("/resources/video-styles") && !hrefs(photographer).includes("/quality") && !hrefs(photographer).includes("/coaching") && doorLabels(photographer).includes("Help") && hrefs(photographer).includes("/my-pay"));
    check("editor keeps appropriate reference and production doors", editor.includes("SOP Center") && hrefs(editor).includes("/resources/video-styles") && hrefs(editor).includes("/editing") && !hrefs(editor).includes("/upload"));
    check("Script Writing remains owner-only and configured-only", owner.includes("Script Writing") && !admin.includes("Script Writing") && !render(Sidebar, user("OWNER"), null).includes("Script Writing") && /href="https:\/\/scripts.example.invalid"[^>]*target="_blank"|target="_blank"[^>]*href="https:\/\/scripts.example.invalid"/.test(owner));
    check("theme, notices and sign-out footer stay present", owner.includes('action="/api/auth/logout"') && owner.includes('method="post"') && owner.includes('title="Sign out"') && owner.includes('title="Switch to light mode"') && owner.includes("Notifications"));
    pathname = "/resources/video-styles/premium";
    const style = render(Sidebar, user("OWNER"));
    check("active nested reference opens More with one current link", !group(style, "more").includes("<details") && (style.match(/aria-current="page"/g) ?? []).length === 1 && /<a[^>]*(?:aria-current="page"[^>]*href="\/resources\/video-styles"|href="\/resources\/video-styles"[^>]*aria-current="page")/.test(style));
    const editorStyle = render(Sidebar, user("EDITOR"));
    check("…and the editor's own Reference group opens the same way", !group(editorStyle, "reference").includes("<details") && (editorStyle.match(/aria-current="page"/g) ?? []).length === 1);
    const noWorkGrant = render(Sidebar, user("EDITOR", { editing: false }));
    check("revoked work access still leaves the first authorized drawer link visible", !group(noWorkGrant, "team").includes("<details") && !hrefs(noWorkGrant).includes("/editing"));
    pathname = "/content/client/month";
    // Oct 22 2026: Monthly Content is the owner's own door now (lit, More
    // stays folded); the office still finds it under More, which opens.
    check("current client work lights the owner's Monthly Content door and opens the office's More", /<a[^>]*(?:aria-current="page"[^>]*href="\/content"|href="\/content"[^>]*aria-current="page")/.test(group(render(Sidebar, user("OWNER")), "work")) && !group(render(Sidebar, user("ADMIN")), "more").includes("<details"));
    pathname = "/jobs/123";
    check("a Projects page (/jobs) lights the Projects door",/<a[^>]*(?:aria-current="page"[^>]*href="\/jobs"|href="\/jobs"[^>]*aria-current="page")/.test(render(Sidebar, user("ADMIN"))));
    const destinations = [{ href: "/resources" }, { href: "/resources/video-styles" }, { href: "https://scripts.example.invalid", external: true }];
    check("longest path respects boundaries and external destinations", activeSidebarHref(destinations, "/resources/video-styles/premium") === "/resources/video-styles" && activeSidebarHref(destinations, "/resources-old") === null && activeSidebarHref(destinations, "https://scripts.example.invalid") === null);
    check("grouping retains authorized future destinations without mutating inputs", groupSidebarDestinations([{ href: "/future" }], "/future")[0]?.items[0].href === "/future" && destinations[0].href === "/resources");
    check("rendering does not fetch notifications or providers", fetches === 0);
    console.log(`\n${checked} passed, 0 failed`);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
