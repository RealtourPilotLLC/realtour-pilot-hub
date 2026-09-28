// ---------------------------------------------------------------------------
// DRILL: UI-03 — SETTINGS GROUPED BY PURPOSE (11-settings-grouping + the A56
// readiness panel on top; unified handoff §11, batch 6, Sep 28 2026).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/ui03-settings-ia.ts
//
// THE PAGE IS REALLY RENDERED. This file runs twice: the parent (react-server,
// like every drill) boots PGlite, seeds it and asserts; a child copy of itself
// (UI03_MODE=render, WITHOUT the react-server condition, `server-only`
// neutralised by _client-drill-preload.cjs) imports the actual
// src/app/settings/page.tsx, signs a real session cookie for each role, calls
// the page and renders its tree to HTML with react-dom/static — every card,
// every client component's first paint, both provider cards' Suspense
// boundaries resolved. The parent then reads the HTML with a small tag-stack
// parser. Nothing is mirrored: what is asserted is what the browser would get.
//
// What it proves, the OLD behaviour first (BASE is pinned to 3de6023, the tree
// batch 6 starts from — never HEAD; BASE's page.tsx is rendered for real too):
//   0. OLD: one flat column of the 14 cards with no group and no section nav;
//      the Photographer pay view card rendered for an ADMIN; the content
//      program anchor was written twice (page wrapper + panel), and the
//      notification schedule had no anchor at all.
//   1. NEW: every one of the 14 cards renders exactly once, inside exactly
//      one group, and in the group SETTINGS_LAYOUT gives it.
//   2. The financial group is absent for an ADMIN and present for the OWNER
//      (pay view and the payroll / bank-feed links with it); an EDITOR is
//      redirected away, and with enforcement on nobody signed in (a client
//      has no hub login) is sent to /login.
//   3. Anchors: #coaching, #topaz, #program-automations, #program-reminders,
//      #calendly, #notification-schedule, #internal-alerts, #hub-write-scopes
//      and every group chip resolve to exactly one element; no id appears
//      twice anywhere on the page; every "/settings#…" link written anywhere
//      in src, and every in-page "#…" link the settings cards write, points at
//      an id that exists.
//   4. The readiness panel renders one row per report row, same keys, same
//      order, and says the launch gate is closed; a switch that is on while
//      AI runs is off reads "on, but blocked" in the switch list and "NOT
//      working" in readiness, never a plain green "on".
//   5. Saved settings are byte-identical before and after rendering it (for
//      three roles): AppSetting, ProgramAutomation, Connection, the Calendly
//      mappings, TeamMember, AppUser and AuditLog.
//   6. Phone width: the section nav wraps (no sideways strip), nothing on the
//      new surfaces forces a width.
//
// ISOLATION: PGlite on 127.0.0.1:5871 (DRILL_PORT overrides) through the shared
// harness; production is never opened; both processes fence every
// non-loopback call (must be 0); nothing is sent.
// THE CLOCK IS PINNED to Mon Sep 28 2026 11:00 ET (both processes).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, pinDrillEnv, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5871);
const BASE = "3de6023"; // pinned: the tree batch 6 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");
const MODE = process.env.UI03_MODE === "render" ? "render" : "parent";

// ---- the clock (both processes) ---------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 28, 15, 0, 0); // Mon Sep 28 2026, 11:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });

type Users = { owner: string; admin: string; editor: string };
type RenderResult = { files: Record<string, string>; redirects: Record<string, string>; errors: string[]; blocked: string[] };

// =============================================================================
// THE CHILD: render the page, write the HTML, exit.
// =============================================================================
async function renderChild() {
  pinDrillEnv(PORT);
  // PGlite is ONE backend session shared by every socket, and each Prisma
  // client names its prepared statements s0, s1, … from zero — so a second
  // process's "s0" collides with the parent's (42P05). pgbouncer mode makes
  // this client use unnamed statements only.
  process.env.DATABASE_URL = `${process.env.DATABASE_URL}&pgbouncer=true`;
  installNextStubs();
  const fence = fenceFetch();
  const out = process.env.UI03_OUT!;
  const users = JSON.parse(process.env.UI03_USERS!) as Users;
  const result: RenderResult = { files: {}, redirects: {}, errors: [], blocked: [] };

  // A redirect that names where it goes (the shared stubs only say "not
  // available"). Both copies are patched: the resolved stub file and the
  // loader's replacement object, whichever a module happens to reach.
  const redirect = (url: string) => { throw new Error(`REDIRECT ${url}`); };
  // Through the CJS loader on purpose: an import() would hand back a frozen
  // namespace copy, and the point is to change the object the app reaches.
  const load = createRequire(__filename);
  for (const mod of [load(path.join(__dirname, "_next-navigation-stub.cjs")), load("next/navigation")] as { redirect: unknown }[]) mod.redirect = redirect;

  // prerender, not renderToReadableStream: it waits for every Suspense
  // boundary (the Topaz and Calendly cards, readiness) before writing, so each
  // card is inline where the browser ends up showing it — not a skeleton in
  // the shell plus a hidden copy swapped in by script at the end.
  const { prerender } = (await import("react-dom/static")) as unknown as { prerender: (n: unknown) => Promise<{ prelude: ReadableStream }> };
  const { prisma } = await import("@/lib/prisma");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const as = async (uid: string | null) => {
    if (!uid) { await clearSession(); return; }
    const u = await prisma.appUser.findUniqueOrThrow({ where: { id: uid } });
    // setSession, not establishSession: signing the cookie writes nothing
    // (establishSession stamps lastLoginAt, which would dirty section 5).
    await setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, permissions: u.permissions });
  };
  const html = async (tree: unknown) => new Response((await prerender(tree)).prelude).text();

  // BASE's page, byte for byte, its @/ imports aimed at this tree.
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui03-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
  const oldFile = path.join(baseDir, "settings-page.base.tsx");
  // `import React` first: outside the repo, the transform may be the classic
  // one that needs React in scope; under the automatic one it is unused.
  fs.writeFileSync(oldFile, 'import React from "react";\nvoid React;\n' + show("src/app/settings/page.tsx").replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  const OldPage = ((await import(oldFile)) as { default: () => Promise<unknown> }).default;
  const NewPage = ((await import("@/app/settings/page")) as { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown> }).default;

  const write = (name: string, body: string) => { const f = path.join(out, `${name}.html`); fs.writeFileSync(f, body); result.files[name] = f; };
  for (const [role, uid] of [["OWNER", users.owner], ["ADMIN", users.admin]] as const) {
    try { await as(uid); write(`new-${role}`, await html(await NewPage({ searchParams: Promise.resolve({}) }))); } catch (e) { result.errors.push(`new ${role}: ${(e as Error).stack ?? e}`); }
    try { await as(uid); write(`old-${role}`, await html(await OldPage())); } catch (e) { result.errors.push(`old ${role}: ${(e as Error).stack ?? e}`); }
  }
  // Refused viewers: the page must redirect before it renders anything.
  for (const [who, uid, enforce] of [["EDITOR", users.editor, false], ["NOBODY (enforced)", null, true]] as const) {
    const prev = process.env.AUTH_ENFORCE;
    if (enforce) process.env.AUTH_ENFORCE = "true";
    try {
      await as(uid);
      await NewPage({ searchParams: Promise.resolve({}) });
      result.redirects[who] = "RENDERED";
    } catch (e) {
      // Next's own redirect() (reached through a dynamic import that skips the
      // CJS stubs) throws NEXT_REDIRECT with the target in its digest.
      const digest = (e as { digest?: unknown }).digest;
      result.redirects[who] = typeof digest === "string" && digest.startsWith("NEXT_REDIRECT") ? `REDIRECT ${digest.split(";")[2] ?? digest}` : String((e as Error).message ?? e);
    } finally {
      if (enforce) { if (prev === undefined) delete process.env.AUTH_ENFORCE; else process.env.AUTH_ENFORCE = prev; }
    }
  }
  result.blocked = fence.blocked;
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result));
  try { fs.unlinkSync(path.join(baseDir, "node_modules")); fs.rmSync(baseDir, { recursive: true, force: true }); } catch { /* harmless */ }
  await (prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect();
  process.exit(0);
}

// =============================================================================
// A small HTML reader: enough of a tag stack to know what is inside what.
// =============================================================================
type El = { tag: string; attrs: Record<string, string>; parent: El | null; children: El[]; text: string };
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, parent: null, children: [], text: "" };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[6] !== undefined) { cur.text += m[6]; continue; }
    if (!m[3]) continue; // comment or script/style
    const tag = m[3].toLowerCase();
    if (m[2] === "/") {
      // Close the nearest open element with this tag.
      let n: El | null = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n && n.parent) cur = n.parent;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[4] ?? "").matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? "";
    const el: El = { tag, attrs, parent: cur, children: [], text: "" };
    cur.children.push(el);
    if (!VOID.has(tag) && m[5] !== "/") cur = el;
  }
  return root;
}
const all = (root: El, pred: (e: El) => boolean): El[] => {
  const out: El[] = [];
  const walk = (e: El) => { if (pred(e)) out.push(e); e.children.forEach(walk); };
  walk(root);
  return out;
};
const ancestors = (e: El): El[] => { const out: El[] = []; for (let p = e.parent; p; p = p.parent) out.push(p); return out; };
const textOf = (e: El): string => e.text + e.children.map(textOf).join("");
/**
 * Do what React's inline $RC/$RS scripts do in the browser: a Suspense
 * boundary that was still waiting when the shell was written appears as
 * `<!--$?--><template id="B:n"></template>FALLBACK<!--/$-->`, and its content
 * arrives later as `<div hidden id="S:m">…</div>` plus `$RC("B:n","S:m")`.
 * Swapping them here means the page is read as the browser shows it: each
 * card where it sits, once, and no skeleton left behind.
 */
function inlineBoundaries(html: string): string {
  const takeSegment = (h: string, sid: string): { h: string; inner: string } | null => {
    const open = `<div hidden id="S:${sid}">`;
    const at = h.indexOf(open);
    if (at < 0) return null;
    let depth = 0;
    const re = /<div\b[^>]*>|<\/div>/g;
    re.lastIndex = at;
    let m: RegExpExecArray | null;
    while ((m = re.exec(h))) {
      depth += m[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return { h: h.slice(0, at) + h.slice(m.index + m[0].length), inner: h.slice(at + open.length, m.index) };
    }
    return null;
  };
  const ops = [...html.matchAll(/\$R([CS])\("([BS]):(\w+)","([SP]):(\w+)"\)/g)];
  let h = html;
  for (const op of ops) {
    if (op[1] === "C") {
      const seg = takeSegment(h, op[5]);
      if (!seg) continue;
      h = seg.h;
      const tpl = `<!--$?--><template id="B:${op[3]}"></template>`;
      const at = h.indexOf(tpl);
      if (at < 0) continue;
      // The fallback runs to this boundary's own <!--/$-->, past any nested ones.
      let depth = 1;
      const re = /<!--\$[?!]?-->|<!--\/\$-->/g;
      re.lastIndex = at + tpl.length;
      let m: RegExpExecArray | null;
      while ((m = re.exec(h))) {
        depth += m[0] === "<!--/$-->" ? -1 : 1;
        if (depth === 0) { h = `${h.slice(0, at)}<!--$-->${seg.inner}${h.slice(m.index)}`; break; }
      }
    } else {
      const seg = takeSegment(h, op[3]);
      if (!seg) continue;
      h = seg.h.replace(`<template id="P:${op[5]}"></template>`, seg.inner);
    }
  }
  return h;
}
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// =============================================================================
// THE PARENT
// =============================================================================
async function parent() {
  installNextStubs();
  const fence = fenceFetch();
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { SETTINGS_CARD_KEYS, SETTINGS_LAYOUT, SETTINGS_GROUPS } = await import("@/components/settings/SettingsGroup");
  const { readinessReport } = await import("@/lib/readiness");

  // ---- seed: three people, some saved rules, a switch or two -----------------
  const owner = await db.appUser.create({ data: { email: "owner@drill.test", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
  const admin = await db.appUser.create({ data: { email: "admin@drill.test", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" } });
  const editor = await db.appUser.create({ data: { email: "editor@drill.test", name: "Ed Drill", role: "EDITOR", status: "ACTIVE" } });
  await db.teamMember.create({ data: { name: "Kyle Drill", email: "admin@drill.test" } });
  await db.appSetting.create({ data: { key: "editor_routing", value: JSON.stringify({ standardVideo: "john", premiumVideo: "kim", personalBranding: null }), updatedBy: "owner@drill.test" } });
  await db.appSetting.create({ data: { key: "internal_alerts", value: JSON.stringify({ uploadReminder: { enabled: true, hour: 19 } }), updatedBy: "admin@drill.test" } });
  await db.programAutomation.create({ data: { key: "reminders", enabled: false, configJson: JSON.stringify({ testClientsOnly: true }) } });
  await db.programAutomation.create({ data: { key: "session_booking", enabled: false, configJson: JSON.stringify({ authorizedFixtureClientIds: [] }) } });
  // On, while the AI master switch it depends on is off: the switch list must
  // not show it as a plain green "on".
  await db.programAutomation.create({ data: { key: "script_drafting", enabled: true, enabledBy: "owner@drill.test", enabledAt: new Date() } });

  const snapshot = async () => JSON.stringify([
    await db.appSetting.findMany({ orderBy: { key: "asc" } }),
    await db.programAutomation.findMany({ orderBy: { key: "asc" } }),
    await db.connection.findMany({ orderBy: { provider: "asc" } }),
    await db.programCalendlyEventMapping.findMany({ orderBy: { id: "asc" } }),
    await db.teamMember.findMany({ orderBy: { id: "asc" } }),
    await db.appUser.findMany({ orderBy: { id: "asc" } }),
    await db.auditLog.count(),
  ]);
  const before = await snapshot();

  // ---- render, in a child process that speaks to this database ----------------
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ui03-render-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UI03_MODE: "render",
    UI03_OUT: outDir,
    UI03_USERS: JSON.stringify({ owner: owner.id, admin: admin.id, editor: editor.id } satisfies Users),
    DRILL_PORT: String(PORT),
    // No react-server condition: react-dom/static needs the ordinary React.
    // server-only is neutralised instead (see _client-drill-preload.cjs).
    NODE_OPTIONS: "--require ./scripts/_drill/_drill-preload.cjs --require ./scripts/_drill/_client-drill-preload.cjs",
  };
  const code = await new Promise<number>((resolve) => {
    // ASYNC, never spawnSync: the database this child talks to is served from
    // THIS process's event loop.
    const child = spawn("npx", ["tsx", path.join("scripts", "_drill", "ui03-settings-ia.ts")], { cwd: REPO, env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("exit", (n) => resolve(n ?? 1));
  });
  const resultFile = path.join(outDir, "result.json");
  c.ok("the render child finished", code === 0 && fs.existsSync(resultFile), `exit ${code}`);
  if (!fs.existsSync(resultFile)) { c.summary(); await stop(); process.exit(1); }
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as RenderResult;
  c.ok("every render succeeded (NEW and OLD, OWNER and ADMIN)", result.errors.length === 0 && ["new-OWNER", "new-ADMIN", "old-OWNER", "old-ADMIN"].every((k) => !!result.files[k]), result.errors.join("\n").slice(0, 1500));
  const page = (k: string) => {
    if (!result.files[k]) { c.summary(); throw new Error(`no ${k} render — see the errors above`); }
    const raw = inlineBoundaries(fs.readFileSync(result.files[k], "utf8"));
    return { raw, root: parseHtml(raw) };
  };
  const NEW = { OWNER: page("new-OWNER"), ADMIN: page("new-ADMIN") };
  c.ok("every Suspense boundary resolved into place (no skeleton, no hidden segment left)", (["OWNER", "ADMIN"] as const).every((r) => !/<!--\$\?-->|<div hidden id="S:|animate-pulse/.test(NEW[r].raw)));
  const OLD = { OWNER: page("old-OWNER"), ADMIN: page("old-ADMIN") };
  const cardTitle: Record<string, string> = {
    "editor-routing": "Editor auto-assignment", "automated-texts": "Automated texts", "text-wording": "Text wording", turnaround: "Turnaround promises",
    "internal-alerts": "Internal alerts", "team-notifications": "Team notifications", coaching: "Comms coaching", "pay-view": "Photographer pay view",
    "review-room": "Review Room", topaz: "1080p video pass", "program-automations": "Content program automations", "program-reminders": "Program reminders",
    calendly: "Calendly & content-program calls", "product-categories": "Product categories",
  };
  const h2Count = (root: El, title: string) => all(root, (e) => e.tag === "h2" && decode(textOf(e)).trim() === title).length;

  // =========================================================================
  c.head("0 · OLD (3de6023): one flat column, the pay view for an admin, a doubled anchor");
  // =========================================================================
  {
    const oldPage = show("src/app/settings/page.tsx");
    const oldPanel = show("src/components/settings/ProgramAutomationPanel.tsx");
    const oldSchedule = show("src/components/settings/NotificationSchedule.tsx");
    c.ok("OLD: all 14 cards rendered for the owner, each once", Object.values(cardTitle).every((t) => h2Count(OLD.OWNER.root, t) === 1), Object.values(cardTitle).filter((t) => h2Count(OLD.OWNER.root, t) !== 1).join(", "));
    c.ok("OLD: no group and no section nav on the page", all(OLD.OWNER.root, (e) => "data-settings-group" in e.attrs || "data-settings-nav" in e.attrs).length === 0 && !/SettingsGroup|SettingsNav/.test(oldPage));
    c.ok("OLD: the Photographer pay view card rendered for an ADMIN", h2Count(OLD.ADMIN.root, "Photographer pay view") === 1);
    c.ok("OLD: #program-automations was written twice (the page's wrapper AND the panel's own div)", /id="program-automations"/.test(oldPage) && /id="program-automations"/.test(oldPanel));
    c.ok("OLD: the notification schedule had no anchor", !/id="notification-schedule"/.test(oldSchedule));
  }

  // =========================================================================
  c.head("1 · every card renders exactly once, inside exactly one group");
  // =========================================================================
  {
    const layoutKeys = Object.values(SETTINGS_LAYOUT).flat();
    c.ok("SETTINGS_LAYOUT places each of the 14 cards exactly once", layoutKeys.length === SETTINGS_CARD_KEYS.length && SETTINGS_CARD_KEYS.every((k) => layoutKeys.filter((x) => x === k).length === 1));
    c.ok("…and those are the same 14 cards the OLD page had", SETTINGS_CARD_KEYS.length === 14 && SETTINGS_CARD_KEYS.every((k) => h2Count(OLD.OWNER.root, cardTitle[k]) === 1));
    const groupOf = new Map<string, string>(Object.entries(SETTINGS_LAYOUT).flatMap(([g, ks]) => ks.map((k) => [k, g] as const)));
    for (const role of ["OWNER", "ADMIN"] as const) {
      const root = NEW[role].root;
      const cards = all(root, (e) => "data-settings-card" in e.attrs);
      const expected = SETTINGS_CARD_KEYS.filter((k) => role === "OWNER" || k !== "pay-view");
      const counts = new Map<string, number>();
      for (const e of cards) counts.set(e.attrs["data-settings-card"], (counts.get(e.attrs["data-settings-card"]) ?? 0) + 1);
      c.ok(`${role}: each of its ${expected.length} cards renders exactly once`, expected.every((k) => counts.get(k) === 1) && cards.length === expected.length, [...counts].map(([k, n]) => `${k}:${n}`).join(" "));
      const misplaced = cards.filter((e) => {
        const gs = ancestors(e).filter((a) => "data-settings-group" in a.attrs);
        return gs.length !== 1 || gs[0].attrs["data-settings-group"] !== groupOf.get(e.attrs["data-settings-card"]);
      });
      c.ok(`${role}: every card sits inside exactly one group — the one SETTINGS_LAYOUT names`, misplaced.length === 0, misplaced.map((e) => e.attrs["data-settings-card"]).join(","));
      c.ok(`${role}: each card still carries its own title, once`, expected.every((k) => h2Count(root, cardTitle[k]) === 1));
      const groups = all(root, (e) => "data-settings-group" in e.attrs);
      c.ok(`${role}: every group states its effect in a sentence under its heading`, groups.length > 0 && groups.every((g) => {
        const def = SETTINGS_GROUPS.find((d) => d.id === g.attrs["data-settings-group"]);
        return !!def && decode(textOf(g)).includes(def.summary) && def.summary.split(" ").length >= 12;
      }));
    }
  }

  // =========================================================================
  c.head("2 · who sees what: financial is the owner's; editors and strangers never render it");
  // =========================================================================
  {
    const groupsIn = (root: El) => all(root, (e) => "data-settings-group" in e.attrs).map((e) => e.attrs["data-settings-group"]);
    c.ok("OWNER: all seven groups, in order", groupsIn(NEW.OWNER.root).join() === SETTINGS_GROUPS.map((g) => g.id).join());
    c.ok("ADMIN: the financial group is absent (and only it)", groupsIn(NEW.ADMIN.root).join() === SETTINGS_GROUPS.filter((g) => !g.ownerOnly).map((g) => g.id).join() && !groupsIn(NEW.ADMIN.root).includes("financial"));
    c.ok("ADMIN: no pay view, no payroll link, no bank-feeds link anywhere on the page", h2Count(NEW.ADMIN.root, "Photographer pay view") === 0 && !/href="\/sales\?tab=payroll"/.test(NEW.ADMIN.raw) && !/href="\/connections\/banks"/.test(NEW.ADMIN.raw));
    c.ok("OWNER: the pay view, the payroll link and the bank-feeds link are in the financial group", (() => {
      const fin = all(NEW.OWNER.root, (e) => e.attrs["data-settings-group"] === "financial")[0];
      if (!fin) return false;
      const links = all(fin, (e) => e.tag === "a").map((e) => e.attrs.href);
      return h2Count(fin, "Photographer pay view") === 1 && links.includes("/sales?tab=payroll") && links.includes("/connections/banks");
    })());
    c.ok("the chip for the financial group only for the OWNER", /href="#financial"/.test(NEW.OWNER.raw) && !/href="#financial"/.test(NEW.ADMIN.raw));
    c.ok("ADMIN: no link to the owner-only Connections page; the logins tab is the owner's too", !/href="\/connections"/.test(NEW.ADMIN.raw) && /href="\/users\?tab=team"/.test(NEW.ADMIN.raw) && !/href="\/users\?tab=logins"/.test(NEW.ADMIN.raw));
    c.ok("OWNER: Connections and the logins tab are linked", /href="\/connections"/.test(NEW.OWNER.raw) && /href="\/users\?tab=logins"/.test(NEW.OWNER.raw));
    c.ok("EDITOR: redirected before anything renders (to the editor's home)", /^REDIRECT \/editing/.test(result.redirects.EDITOR ?? ""), result.redirects.EDITOR);
    c.ok("nobody signed in, enforcement on (a client has no hub login): sent to /login", /^REDIRECT \/login\?next=%2Fsettings/.test(result.redirects["NOBODY (enforced)"] ?? ""), result.redirects["NOBODY (enforced)"]);
  }

  // =========================================================================
  c.head("3 · anchors resolve, once each, and every inbound link still lands");
  // =========================================================================
  {
    const REQUIRED = ["coaching", "topaz", "program-automations", "program-reminders", "calendly", "notification-schedule", "internal-alerts", "hub-write-scopes", "readiness"];
    for (const role of ["OWNER", "ADMIN"] as const) {
      const ids = all(NEW[role].root, (e) => "id" in e.attrs).map((e) => e.attrs.id);
      const dup = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
      c.ok(`${role}: no id appears twice anywhere on the page`, dup.length === 0, dup.join(","));
      c.ok(`${role}: ${REQUIRED.map((a) => `#${a}`).join(" ")} each resolve to exactly one element`, REQUIRED.every((a) => ids.filter((x) => x === a).length === 1), REQUIRED.filter((a) => ids.filter((x) => x === a).length !== 1).join(","));
      const chips = all(NEW[role].root, (e) => "data-settings-nav" in e.attrs).flatMap((n) => all(n, (e) => e.tag === "a").map((e) => e.attrs.href));
      c.ok(`${role}: every section chip points at an id on the page`, chips.length >= 7 && chips.every((h) => h.startsWith("#") && ids.includes(h.slice(1))), chips.join(" "));
    }
    // Every "/settings#…" link anywhere in src, and every in-page "#…" link a settings card writes.
    const inbound = new Map<string, string[]>();
    const inPage = new Map<string, string[]>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name)) {
          const src = fs.readFileSync(path.join(REPO, rel), "utf8");
          for (const m of src.matchAll(/["'`]\/settings#([a-z0-9-]+)/g)) inbound.set(m[1], [...(inbound.get(m[1]) ?? []), rel]);
          if (rel.startsWith(path.join("src", "components", "settings")) || rel === path.join("src", "app", "settings", "page.tsx")) {
            for (const m of src.matchAll(/href="#([a-z0-9-]+)"/g)) inPage.set(m[1], [...(inPage.get(m[1]) ?? []), rel]);
          }
        }
      }
    };
    walk("src");
    const ownerIds = new Set(all(NEW.OWNER.root, (e) => "id" in e.attrs).map((e) => e.attrs.id));
    c.ok(`every "/settings#…" link in src lands on an id (${[...inbound.keys()].sort().join(", ")})`, inbound.size >= 3 && [...inbound.keys()].every((a) => ownerIds.has(a)), [...inbound].filter(([a]) => !ownerIds.has(a)).map(([a, f]) => `${a} ← ${f.join(",")}`).join(" | "));
    c.ok("…including the ones the task names: /coaching → #coaching, /connections → #topaz, /content/monitoring → #program-automations", ["coaching", "topaz", "program-automations"].every((a) => inbound.has(a)));
    c.ok(`every in-page "#…" link the settings cards write lands on an id (${[...inPage.keys()].sort().join(", ")})`, [...inPage.keys()].every((a) => ownerIds.has(a)), [...inPage].filter(([a]) => !ownerIds.has(a)).map(([a, f]) => `${a} ← ${f.join(",")}`).join(" | "));
    c.ok("the old anchors keep their homes: #program-automations holds the switches, #topaz the 1080p card, #coaching the coaching card", (() => {
      const byId = (id: string) => all(NEW.OWNER.root, (e) => e.attrs.id === id)[0];
      return h2Count(byId("program-automations"), "Content program automations") === 1 && h2Count(byId("topaz"), "1080p video pass") === 1 && h2Count(byId("coaching"), "Comms coaching") === 1 && h2Count(byId("calendly"), "Calendly & content-program calls") === 1 && h2Count(byId("program-reminders"), "Program reminders") === 1;
    })());
    c.ok("#notification-schedule sits inside Internal alerts, in the communication group", (() => {
      const n = all(NEW.OWNER.root, (e) => e.attrs.id === "notification-schedule")[0];
      const a = n ? ancestors(n) : [];
      return a.some((x) => x.attrs["data-settings-card"] === "internal-alerts") && a.some((x) => x.attrs["data-settings-group"] === "comms");
    })());
  }

  // =========================================================================
  c.head("4 · the readiness panel is the report");
  // =========================================================================
  {
    const rep = await readinessReport({ now: new Date() });
    for (const role of ["OWNER", "ADMIN"] as const) {
      const keys = all(NEW[role].root, (e) => "data-readiness-key" in e.attrs).map((e) => e.attrs["data-readiness-key"]);
      c.ok(`${role}: one panel row per report row — same keys, same order (${rep.rows.length})`, keys.join() === rep.rows.map((r) => r.key).join(), `${keys.length} vs ${rep.rows.length}`);
      c.ok(`${role}: the panel says the launch gate is closed`, all(NEW[role].root, (e) => e.attrs["data-rollout"] === "closed").length === 1);
      const ready = all(NEW[role].root, (e) => e.attrs.id === "readiness")[0];
      const nav = all(NEW[role].root, (e) => "data-settings-nav" in e.attrs)[0];
      const firstGroup = all(NEW[role].root, (e) => "data-settings-group" in e.attrs)[0];
      const order = (x: El | undefined) => (x ? NEW[role].raw.indexOf(`${x.attrs.id ? `id="${x.attrs.id}"` : "data-settings-nav"}`) : -1);
      c.ok(`${role}: the nav, then readiness, then the groups — readiness at the top of Settings`, !!ready && !!nav && !!firstGroup && order(nav) < order(ready) && order(ready) < order(firstGroup));
      const switches = decode(textOf(all(NEW[role].root, (e) => e.attrs.id === "program-automations")[0]));
      c.ok(`${role}: a switch that is on while AI runs is off reads "on, but blocked" in the switch list, and says what it waits for`, /on, but blocked/.test(switches) && switches.includes("Has no effect until “AI runs (master switch)” is on as well."));
      const draftingRow = all(NEW[role].root, (e) => e.attrs["data-readiness-key"] === "script_drafting")[0];
      c.ok(`${role}: …and the readiness row says it is switched on but NOT working`, !!draftingRow && /Switched on but NOT working: needs ai_runs switched on/.test(decode(textOf(draftingRow))));
      const integ = all(NEW[role].root, (e) => e.attrs["data-settings-group"] === "integrations")[0];
      c.ok(`${role}: the integrations group lists every provider read-only (no form, no button)`, !!integ && all(integ, (e) => "data-provider" in e.attrs).length === rep.providers.length && all(integ, (e) => e.tag === "form" || e.tag === "button" || e.tag === "input").length === 0);
    }
  }

  // =========================================================================
  c.head("5 · rendering Settings changed no saved value");
  // =========================================================================
  {
    const after = await snapshot();
    c.ok("AppSetting, ProgramAutomation, Connection, Calendly mappings, TeamMember, AppUser and AuditLog byte-identical after 4 page renders and 2 refusals", before === after);
  }

  // =========================================================================
  c.head("6 · phone width: wraps, never scrolls sideways");
  // =========================================================================
  {
    const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    const nav = read("src/components/settings/SettingsNav.tsx");
    const panel = read("src/components/settings/ReadinessPanel.tsx");
    const group = read("src/components/settings/SettingsGroup.tsx");
    c.ok("the section nav wraps (flex-wrap) and never scrolls sideways (no overflow-x / nowrap)", /flex flex-wrap/.test(nav) && !/overflow-x|whitespace-nowrap|flex-nowrap/.test(nav));
    c.ok("chips are at least 36 px tall (min-h-9) — a thumb-sized target", /min-h-9/.test(nav));
    c.ok("the new surfaces set no fixed width and no nowrap", ![nav, panel, group].some((s) => /\bw-\[\d|min-w-\[\d|whitespace-nowrap|overflow-x-(auto|scroll)/.test(s)));
    c.ok("readiness rows wrap their chips and break long words", /flex flex-wrap gap-1/.test(panel) && /break-words/.test(panel));
  }

  c.ok("fence: parent and child reached nothing outside loopback", fence.blocked.length === 0 && result.blocked.length === 0, [...fence.blocked, ...result.blocked].join(","));
  quiet.restore();
  c.summary();
  if (process.env.UI03_KEEP) console.log(`renders kept in ${outDir}`);
  else try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* harmless */ }
  await stop();
  fence.restore();
  process.exit(process.exitCode ?? 0);
}

(MODE === "render" ? renderChild() : parent()).catch((e) => {
  console.error(e);
  process.exit(1);
});
