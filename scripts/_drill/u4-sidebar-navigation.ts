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
const hrefs = (html: string) => [...html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)].map((match) => match[1]).sort();
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
      check(`${name}: same authorized destinations as before grouping`, JSON.stringify(hrefs(before)) === JSON.stringify(hrefs(after)));
      check(`${name}: every destination still appears once`, hrefs(after).length === new Set(hrefs(after)).size);
    }
    const owner = render(Sidebar, user("OWNER"));
    const admin = render(Sidebar, user("ADMIN"));
    const editor = render(Sidebar, user("EDITOR"));
    const photographer = render(Sidebar, user("PHOTOGRAPHER"));
    check("owner has the six requested groups in order", [...owner.matchAll(/data-sidebar-group="([^"]+)"/g)].map((match) => match[1]).join() === "daily,production,clients,team,reference,administration");
    check("Daily work and Production remain directly visible", !group(owner, "daily").includes("<details") && !group(owner, "production").includes("<details") && group(owner, "daily").includes('href="/tasks"') && group(owner, "production").includes('href="/review"'));
    check("secondary owner groups start collapsed", ["team", "reference", "administration"].every((id) => group(owner, id).includes("<details") && !/<details[^>]*\sopen(?:[\s=>])/.test(group(owner, id))));
    // Oct 5 2026: Clients (Content Program + Clients) is open by default — the
    // office is onboarding clients this week. For every role that has it.
    check("Clients group is open by default with both doors visible", ["OWNER", "ADMIN"].every((role) => { const html = render(Sidebar, user(role)); return !group(html, "clients").includes("<details") && group(html, "clients").includes('href="/content"') && group(html, "clients").includes('href="/clients"'); }));
    check("disclosure summaries participate in the existing drawer focus selector", [...owner.matchAll(/<summary\b([^>]*)>/g)].every((match) => match[1].includes('tabindex="0"')));
    const both = renderToStaticMarkup(React.createElement(React.Fragment, null, React.createElement(Sidebar, { user: user("OWNER") }), React.createElement(Sidebar, { user: user("OWNER") })));
    const ids = [...both.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    check("desktop and drawer instances have unique labelled group IDs", ids.length > 0 && ids.length === new Set(ids).size);
    check("issue report remains outside the collapsed administration detail", group(owner, "administration").indexOf('href="/feedback"') > group(owner, "administration").indexOf("</details>") && owner.includes("Report a hub issue"));
    check("admin keeps operational destinations without default financial access", !hrefs(admin).includes("/sales") && !hrefs(admin).includes("/trends") && !hrefs(admin).includes("/my-pay") && !hrefs(admin).includes("/connections"));
    check("photographer-specific exclusions and SOP label remain", !hrefs(photographer).includes("/resources/video-styles") && !hrefs(photographer).includes("/quality") && !hrefs(photographer).includes("/coaching") && photographer.includes("SOP Center") && hrefs(photographer).includes("/my-pay"));
    check("editor keeps appropriate reference and production doors", editor.includes("SOP Center") && hrefs(editor).includes("/resources/video-styles") && hrefs(editor).includes("/editing") && !hrefs(editor).includes("/upload"));
    check("Script Writing remains owner-only and configured-only", owner.includes("Script Writing") && !admin.includes("Script Writing") && !render(Sidebar, user("OWNER"), null).includes("Script Writing") && /href="https:\/\/scripts.example.invalid"[^>]*target="_blank"|target="_blank"[^>]*href="https:\/\/scripts.example.invalid"/.test(owner));
    check("theme, notices and sign-out footer stay present", owner.includes('action="/api/auth/logout"') && owner.includes('method="post"') && owner.includes('title="Sign out"') && owner.includes('title="Switch to light mode"') && owner.includes("Notifications"));
    pathname = "/resources/video-styles/premium";
    const style = render(Sidebar, user("OWNER"));
    check("active nested reference opens its group with one current link", !group(style, "reference").includes("<details") && (style.match(/aria-current="page"/g) ?? []).length === 1 && /<a[^>]*(?:aria-current="page"[^>]*href="\/resources\/video-styles"|href="\/resources\/video-styles"[^>]*aria-current="page")/.test(style));
    const noWorkGrant = render(Sidebar, user("EDITOR", { editing: false }));
    check("revoked work access still leaves the first authorized drawer link visible", !group(noWorkGrant, "team").includes("<details") && !hrefs(noWorkGrant).includes("/editing"));
    pathname = "/content/client/month";
    check("current client work opens Clients automatically", !group(render(Sidebar, user("ADMIN")), "clients").includes("<details"));
    const destinations = [{ href: "/resources" }, { href: "/resources/video-styles" }, { href: "https://scripts.example.invalid", external: true }];
    check("longest path respects boundaries and external destinations", activeSidebarHref(destinations, "/resources/video-styles/premium") === "/resources/video-styles" && activeSidebarHref(destinations, "/resources-old") === null && activeSidebarHref(destinations, "https://scripts.example.invalid") === null);
    check("grouping retains authorized future destinations without mutating inputs", groupSidebarDestinations([{ href: "/future" }], "/future")[0]?.items[0].href === "/future" && destinations[0].href === "/resources");
    check("rendering does not fetch notifications or providers", fetches === 0);
    console.log(`\n${checked} passed, 0 failed`);
  } finally { globalThis.fetch = originalFetch; fs.rmSync(temp, { recursive: true, force: true }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
