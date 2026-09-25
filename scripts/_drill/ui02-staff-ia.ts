// ---------------------------------------------------------------------------
// DRILL: UI-02 — the staff client file's six tabs, the roster's one engine,
// and Kyle's package/status controls on the ledger (completion audit, Sep 24
// 2026; batch F2).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/ui02-staff-ia.ts
//
// What it proves, the OLD behaviour first wherever it can be observed (BASE's
// sources and actions, read from git byte for byte):
//   1. THE ADDRESS BOOK. OLD: twelve tab keys plus seven in-page aliases, no
//      redirect, "Their portal" a tab. NEW: every one of those keys (and every
//      ?tab= key any file in src still writes into a bell) lands on a named
//      tab/view; `portal` is the owner's Preview page and the overview for
//      anyone else; every canonical output fed back in does not redirect again;
//      contentHref omits the tab for the overview and the month when it is this
//      ET month; the old #call/#topics/#scripts/#sessions anchors map to the
//      views that hold them now.
//   2. LINK BUILDERS. No `/content/${…}?tab=<old key>` literal is left in the
//      files that build staff links (portal actions, scriptDecisions,
//      programOnboarding, BackfillReview, the page, the overview).
//   3. ONE ENGINE. OLD: /content defaulted to rows and fed its cards from
//      getProgramRoster. NEW: cards are the default and both views render
//      programOverview rows through overviewFacts(); on a Starter + Pro fixture
//      the filtered read (the client file's Overview) deep-equals the roster
//      read, the card/table facts are identical, the journey is the reader's,
//      and a Pro month with one dated shell and no appointment is neither
//      "Filmed" nor fully scheduled.
//   4. KYLE KEEPS PAUSE / END / PACKAGE — ON THE LEDGER. OLD: an ADMIN's
//      saveEnrollmentSettings rewrote package and status with NO ledger row.
//      NEW: that function is gone; staffChangePackageAction and
//      staffSetEnrollmentStatusAction accept ADMIN, refuse an EDITOR, write a
//      ProgramEnrollmentChange row naming Kyle for each change, insist on a
//      KEEP/APPLY choice for the month in flight, and billing stays owner-only.
//   5. VERSION-EXACT APPROVAL ONLY. approveScriptVersionAction(v1) never marks
//      a later v2 approved; the unmounted approveScript refuses a call that
//      does not name the version it showed; no staff screen mounts the retired
//      ScriptReview, and ScriptsPanel approves by version id.
//   6. PREVIEW GATE. canPreviewPortal: OWNER yes, ADMIN/EDITOR/CREATIVE no;
//      the preview page redirects outside any try.
//   7. The tab loaders run on the fixture, and the client's open script
//      requests (only ever visible in the retired list) now load for Plan ›
//      Scripts.
//
// ISOLATION. PGlite on 127.0.0.1:5535 (DRILL_PORT overrides) through the
// shared harness; production is never opened; every non-loopback call is
// fenced and counted (must be 0); nothing is sent to anyone.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5535);
const REPO = path.resolve(__dirname, "../..");
const BASE = "7d0d5c9"; // the commit F2 starts from

installNextStubs();
const fence = fenceFetch();

// ---- who is acting: a REAL signed session in the stubbed cookie jar -------
// (establishSession, as cp02 does). A module interceptor cannot do this job:
// the actions reach getCurrentUser through a dynamic import(), which returns
// the already-loaded module's real exports without passing the CJS loader.
type FakeUser = { id: string; email: string; name: string; role: string };
async function actAs(u: FakeUser) {
  const { establishSession } = await import("@/lib/auth/session");
  await establishSession(u.id);
}

const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

/** BASE's content actions, byte for byte, their `@/` imports aimed at this tree. */
function writeBaseActions(): { dir: string; actions: string; ledger: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ui02-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const actions = path.join(dir, "contentActions.base.ts");
  fs.writeFileSync(actions, point(show("src/app/content/actions.ts")));
  // BASE's enrollment ledger too — to show the OLD supersede bug (it was
  // committed before F2, so git's copy is the behaviour Kyle's card inherited).
  const ledger = path.join(dir, "enrollmentChanges.base.ts");
  fs.writeFileSync(ledger, point(show("src/lib/enrollmentChanges.ts")));
  return { dir, actions, ledger };
}
function removeBase(dir: string) {
  try { fs.unlinkSync(path.join(dir, "node_modules")); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* harmless */ }
}

async function main() {
  const c = makeChecker();
  const nav = await import("@/lib/contentNav");
  const { resolveStaffTab, contentHref, resolveStepHref, canPreviewPortal, resolveRosterView, LEGACY_TAB_MAP, STAFF_TABS, PLAN_VIEWS, PRODUCTION_VIEWS } = nav;
  const etKey = (d: Date) => {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit" }).formatToParts(d);
    return `${p.find((x) => x.type === "year")!.value}-${p.find((x) => x.type === "month")!.value}`;
  };
  const now = new Date();
  const MK = etKey(now);
  const OTHER = MK.endsWith("-01") ? `${Number(MK.slice(0, 4)) - 1}-12` : `${MK.slice(0, 5)}${String(Number(MK.slice(5)) - 1).padStart(2, "0")}`;
  /** Feed an href back through the resolver the page uses. */
  const reResolve = (href: string, isOwner = false) => {
    const u = new URL(href, "http://x");
    return resolveStaffTab(u.searchParams.get("tab"), u.searchParams.get("view"), isOwner);
  };

  // =========================================================================
  c.head("1 · the address book: every old ?tab= key lands, nothing loops");
  // =========================================================================
  {
    const oldPage = show("src/app/content/[id]/page.tsx");
    const oldTabs = [...(/type Tab = ([^;]+);/.exec(oldPage)?.[1] ?? "").matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
    const oldAliases = [...(/const LEGACY_TABS[^{]*\{([^}]+)\}/.exec(oldPage)?.[1] ?? "").matchAll(/"?([a-z-]+)"?\s*:/g)].map((m) => m[1]);
    c.ok("OLD: the client file had 12 tab keys and 7 in-page aliases", oldTabs.length === 12 && oldAliases.length === 7, `${oldTabs.join(",")} | ${oldAliases.join(",")}`);
    c.ok("OLD: a legacy key was aliased in place — never redirected, so the bookmark kept its old address", /LEGACY_TABS\[tabParam/.test(oldPage) && !/redirect\(contentHref|redirect\(`\/content\/\$\{id\}\?/.test(oldPage));
    c.ok("OLD: 'Their portal' was a tab (an iframe acting as staff)", oldTabs.includes("portal") && /<iframe/.test(oldPage));

    const expect: Record<string, [string, string | null]> = {
      "": ["overview", null], month: ["overview", null], overview: ["overview", null],
      strategy: ["plan", "strategy"], ideas: ["plan", "topics"], topics: ["plan", "topics"], "video-topics": ["plan", "topics"], scripts: ["plan", "scripts"],
      facts: ["plan", "knowledge"], notes: ["plan", "knowledge"],
      content: ["production", "videos"], videos: ["production", "videos"],
      brand: ["brand", null], profile: ["brand", null], assets: ["brand", null], file: ["brand", null],
      settings: ["settings", null], messages: ["messages", null], import: ["import", null],
    };
    const everyOld = [...new Set([...oldTabs, ...oldAliases, "", "overview"])];
    const missing = everyOld.filter((k) => k !== "portal" && !(k in expect));
    c.ok("every old key and alias has a documented destination", missing.length === 0, missing.join(","));
    const wrong: string[] = [];
    for (const [k, [tab, view]] of Object.entries(expect)) {
      const r = resolveStaffTab(k || undefined, null, false);
      const defaultView = tab === "plan" ? "topics" : tab === "production" ? "sessions" : null;
      if (r.tab !== tab || (r.view ?? null) !== (view ?? defaultView)) wrong.push(`${k}→${r.tab}/${r.view}`);
    }
    c.ok("each lands on the documented tab and view", wrong.length === 0, wrong.join(" "));
    c.ok("an old key redirects to the canonical URL (the address changes, not just the render)", ["month", "ideas", "topics", "video-topics", "strategy", "scripts", "facts", "notes", "content", "videos", "profile", "assets", "file"].every((k) => resolveStaffTab(k, null, false).redirect));
    c.ok("?tab=file carries the one-line 'the client file was split' notice", resolveStaffTab("file", null, false).moved && contentHref("E1", { tab: "brand", moved: true }) === "/content/E1?tab=brand&moved=1");
    const pOwner = resolveStaffTab("portal", null, true);
    const pAdmin = resolveStaffTab("portal", null, false);
    c.ok("?tab=portal: the owner goes to the Preview page", pOwner.preview && !pOwner.redirect);
    c.ok("?tab=portal: anyone else gets the overview, not the preview", !pAdmin.preview && pAdmin.tab === "overview" && pAdmin.redirect);
    c.ok("an unknown key or a bad view is cleaned up, not honoured", resolveStaffTab("nonsense", null).tab === "overview" && resolveStaffTab("nonsense", null).redirect && resolveStaffTab("plan", "bogus").redirect && resolveStaffTab("plan", "bogus").view === "topics");

    // No loops: every canonical output, fed back in, stays put.
    const loops: string[] = [];
    const canon = [
      ...Object.keys(expect).map((k) => resolveStaffTab(k || undefined, null, false)),
      ...STAFF_TABS.map((t) => resolveStaffTab(t.key, null, false)),
      ...PLAN_VIEWS.map((v) => resolveStaffTab("plan", v.key, false)),
      ...PRODUCTION_VIEWS.map((v) => resolveStaffTab("production", v.key, false)),
      resolveStaffTab("import", null, false),
    ];
    for (const r of canon) {
      for (const month of [null, MK, OTHER]) {
        const href = contentHref("E1", { tab: r.tab, view: r.view, month });
        const again = reResolve(href);
        if (again.redirect || again.tab !== r.tab || (again.view ?? null) !== (r.view ?? null)) loops.push(`${href} → ${again.tab}/${again.view}${again.redirect ? " (redirect)" : ""}`);
      }
    }
    c.ok("every canonical URL resolves to itself without another redirect", loops.length === 0, loops.slice(0, 4).join(" | "));
    c.ok("contentHref: the overview carries no tab; this ET month is omitted, another month kept", contentHref("E1") === "/content/E1" && contentHref("E1", { month: MK }) === "/content/E1" && contentHref("E1", { tab: "plan", view: "scripts", month: OTHER }) === `/content/E1?tab=plan&view=scripts&month=${OTHER}`);
    c.ok("resolveStepHref: the old one-page anchors open the views that hold them", resolveStepHref("E1", "#scripts") === "/content/E1?tab=plan&view=scripts" && resolveStepHref("E1", "#sessions", OTHER) === `/content/E1?tab=production&view=sessions&month=${OTHER}` && resolveStepHref("E1", "#call") === "/content/E1?tab=plan&view=calls" && resolveStepHref("E1", "/review") === "/review");

    // Every ?tab= key any file in src still writes (a bell stored today keeps its href for ever).
    const written = new Set<string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(e.name)) for (const m of read(rel).matchAll(/\/content\/\$\{[^}]+\}\?tab=([a-z-]+)/g)) written.add(m[1]);
      }
    };
    walk("src");
    const unknownKeys = [...written].filter((k) => !(k in LEGACY_TAB_MAP) && !STAFF_TABS.some((t) => t.key === k) && k !== "import" && k !== "portal");
    c.ok(`every ?tab= key still written anywhere in src resolves (${[...written].sort().join(", ") || "none"})`, unknownKeys.length === 0, unknownKeys.join(","));
    c.ok("the roster view: ?view wins, then the cookie, then cards; the old 'rows' means the table", resolveRosterView(null, null) === "cards" && resolveRosterView("rows", "cards") === "table" && resolveRosterView(null, "table") === "table" && resolveRosterView("cards", "table") === "cards" && resolveRosterView("junk", "junk") === "cards");
  }

  // =========================================================================
  c.head("2 · the link builders go through contentHref");
  // =========================================================================
  {
    const files = [
      "src/app/portal/actions.ts", "src/lib/scriptDecisions.ts", "src/lib/programOnboarding.ts", "src/components/content/BackfillReview.tsx",
      "src/app/content/[id]/page.tsx", "src/lib/programOverview.ts",
      ...fs.readdirSync(path.join(REPO, "src/app/content/[id]/tabs")).map((f) => `src/app/content/[id]/tabs/${f}`),
    ];
    const OLD_LITERAL = /\/content\/\$\{[^}]+\}\?tab=(topics|ideas|videos|strategy|scripts|facts|file|portal|content|import|month)\b/;
    const before = ["src/app/portal/actions.ts", "src/lib/scriptDecisions.ts", "src/lib/programOnboarding.ts", "src/components/content/BackfillReview.tsx", "src/app/content/[id]/page.tsx"].filter((f) => OLD_LITERAL.test(show(f)) || /\?tab=scripts&month=MONTH/.test(show(f)));
    c.ok("OLD: five files built ?tab= links by hand", before.length === 5, before.join(", "));
    const left = files.filter((f) => OLD_LITERAL.test(read(f)));
    c.ok("NEW: no hand-built ?tab= literal is left in them", left.length === 0, left.join(", "));
    c.ok("NEW: each builds through contentHref", ["src/app/portal/actions.ts", "src/lib/scriptDecisions.ts", "src/lib/programOnboarding.ts", "src/components/content/BackfillReview.tsx"].every((f) => /contentHref\(/.test(read(f))));
  }

  // ---- the database -----------------------------------------------------
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const base = writeBaseActions();
  const DAY = 864e5;

  const jordan = await prisma.appUser.create({ data: { email: "jordan-drill@example.com", name: "Jordan Drill", role: "OWNER", status: "ACTIVE" }, select: { id: true } });
  const kyle = await prisma.appUser.create({ data: { email: "kyle-drill@example.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
  const kim = await prisma.appUser.create({ data: { email: "kim-drill@example.com", name: "Kim Drill", role: "EDITOR", status: "ACTIVE" }, select: { id: true } });
  const JORDAN: FakeUser = { id: jordan.id, email: "jordan-drill@example.com", name: "Jordan Drill", role: "OWNER" };
  const KYLE: FakeUser = { id: kyle.id, email: "kyle-drill@example.com", name: "Kyle Drill", role: "ADMIN" };
  const KIM: FakeUser = { id: kim.id, email: "kim-drill@example.com", name: "Kim Drill", role: "EDITOR" };

  const S = await buildContentMonth(db, { name: "Sam Starter TEST", package: "Starter", monthKey: MK, appointments: [{ startAt: new Date(now.getTime() + 5 * DAY) }], topics: [{ title: "First weekend pricing", selection: "SELECTED" }] });
  const P = await buildContentMonth(db, { name: "Pat Pro TEST", package: "Pro", monthKey: MK, project: { title: "Pat Pro — shell", status: "SCHEDULED", shootDate: new Date(now.getTime() - 4 * DAY) } });

  // =========================================================================
  c.head("3 · one engine: cards, table and the client file's Overview agree");
  // =========================================================================
  {
    const oldRoster = show("src/app/content/page.tsx");
    c.ok("OLD: /content defaulted to rows, and the cards read a second engine (getProgramRoster)", /sp\.view === "cards" \? "cards" : "rows"/.test(oldRoster) && /getProgramRoster\(/.test(oldRoster) && /function ClientCard\(\{ r \}: \{ r: ProgramRow \}\)/.test(oldRoster));
    const newRoster = read("src/app/content/page.tsx");
    c.ok("NEW: the roster no longer reads getProgramRoster, and cards are the default", !/getProgramRoster/.test(newRoster.replace(/\/\/.*$/gm, "")) && resolveRosterView(undefined, undefined) === "cards");
    c.ok("NEW: the card and the table row both draw overviewFacts(r)", /overviewFacts\(r\)/.test(read("src/components/content/ClientMonthCard.tsx")) && /overviewFacts\(r\)/.test(read("src/components/content/OverviewRow.tsx")));
    c.ok("NEW: both views render the same programOverview rows on the page", /<ClientMonthCard [^>]*r=\{r\}/.test(newRoster) && /<OverviewRow [^>]*r=\{r\}/.test(newRoster) && /programOverview\(\{ monthKey: monthParam/.test(newRoster));

    const { programOverview, overviewFacts } = await import("@/lib/programOverview");
    const { monthProgress, journeyInputFrom } = await import("@/lib/monthProgress");
    const all = await programOverview({ monthKey: MK, now });
    const pick = (r: (typeof all.rows)[number]) => JSON.stringify({ production: r.production, session: r.session, work: r.work, nextAction: r.nextAction, journey: r.journey, flags: r.flags, priority: r.priority, planning: r.planning });
    for (const f of [S, P]) {
      const rosterRow = all.rows.find((r) => r.enrollmentId === f.enrollmentId)!;
      const one = await programOverview({ monthKey: MK, now, enrollmentIds: [f.enrollmentId] });
      c.ok(`${f.clientName}: the filtered read is ONE row and deep-equals the roster's`, one.rows.length === 1 && pick(one.rows[0]) === pick(rosterRow));
      c.ok(`${f.clientName}: card facts = table facts (delivered/owed, session, owner, due)`, JSON.stringify(overviewFacts(one.rows[0])) === JSON.stringify(overviewFacts(rosterRow)), JSON.stringify(overviewFacts(rosterRow)));
      const p = await monthProgress(f.enrollmentId, f.monthId, { now });
      c.ok(`${f.clientName}: the card's journey is the reader's (the client file hero's) input`, !!p && JSON.stringify(rosterRow.journey) === JSON.stringify(journeyInputFrom(p)));
      const nh = rosterRow.nextAction.href;
      c.ok(`${f.clientName}: the next action links to a canonical tab (no redirect on arrival)`, !nh.startsWith("/content/") || (!reResolve(nh).redirect && !reResolve(nh).preview), nh);
    }
    const fewer = await programOverview({ monthKey: MK, now, enrollmentIds: [S.enrollmentId] });
    c.ok("the filter leaves the other clients out (and the roster without it unchanged)", fewer.rows.every((r) => r.enrollmentId === S.enrollmentId) && all.rows.some((r) => r.enrollmentId === P.enrollmentId));
    const pro = all.rows.find((r) => r.enrollmentId === P.enrollmentId)!;
    const pf = overviewFacts(pro);
    c.ok("Pro with one dated shell and no appointment: NOT 'Filmed'", pro.session.state !== "COMPLETED" && pf.sessionWord !== "Filmed", `${pro.session.state} · ${pf.sessionLabel}`);
    c.ok("  …and not fully scheduled: 0 of 2 confirmed, still missing, flagged", pro.session.confirmed === 0 && pro.session.required === 2 && pro.session.missing > 0 && pro.flags.includes("missing_appointment"), JSON.stringify(pro.session));
    c.ok("  …the card's session line says so in words", /0\/2 confirmed/.test(pf.sessionLabel), pf.sessionLabel);
    c.ok("  …and the journey's Shoot step counts nothing filmed", (pro.journey?.sessionsFilmedConfirmed ?? -1) === 0);

    const { loadOverviewTab } = await import("@/app/content/[id]/workspaceData");
    const ov = await loadOverviewTab(P.enrollmentId, MK);
    c.ok("the client file's Overview loader returns the very roster row", !!ov.row && JSON.stringify(overviewFacts(ov.row)) === JSON.stringify(pf) && ov.row.nextAction.text === pro.nextAction.text);
  }

  // =========================================================================
  c.head("4 · Kyle keeps pause / end / package change — on the ledger");
  // =========================================================================
  process.env.AUTH_ENFORCE = "true";
  {
    const ledger = (enrollmentId: string) => prisma.programEnrollmentChange.findMany({ where: { enrollmentId }, orderBy: { createdAt: "asc" } });
    const E0 = await buildContentMonth(db, { name: "Olive Oldpath TEST", package: "Starter", monthKey: MK, owner: false });
    await actAs(KYLE);
    const oldActions = (await import(base.actions)) as { saveEnrollmentSettings: (id: string, s: Record<string, unknown>) => Promise<{ ok: boolean; message: string }> };
    const o1 = await oldActions.saveEnrollmentSettings(E0.enrollmentId, { package: "Pro" });
    const o2 = await oldActions.saveEnrollmentSettings(E0.enrollmentId, { status: "ENDED" });
    const e0 = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: E0.enrollmentId } });
    c.ok("OLD: as ADMIN, saveEnrollmentSettings changed the package and ENDED the client", o1.ok && o2.ok && e0.package === "Pro" && e0.status === "ENDED", `${o1.message} / ${o2.message}`);
    c.ok("OLD: …and wrote NO ledger row — nobody could see who did it or when", (await ledger(E0.enrollmentId)).length === 0);

    const actions = await import("@/app/content/actions");
    c.ok("NEW: saveEnrollmentSettings no longer exists", !("saveEnrollmentSettings" in actions));

    const K = await buildContentMonth(db, { name: "Kate Kylepath TEST", package: "Starter", monthKey: MK, owner: false });
    const before = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K.enrollmentId } });

    await actAs(KIM);
    const ed = await actions.staffSetEnrollmentStatusAction(K.enrollmentId, "PAUSED");
    const ed2 = await actions.staffChangePackageAction(K.enrollmentId, { package: "Pro", effectiveMonthKey: null, currentMonthChoice: "KEEP" });
    c.ok("an EDITOR is refused both, and nothing changes", !ed.ok && !ed2.ok && (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K.enrollmentId } })).status === "ACTIVE" && (await ledger(K.enrollmentId)).length === 0, `${ed.message} / ${ed2.message}`);

    await actAs(KYLE);
    const noChoice = await actions.staffChangePackageAction(K.enrollmentId, { package: "Pro", effectiveMonthKey: MK, currentMonthChoice: null });
    c.ok("Kyle: a package change effective THIS month without a keep/apply choice is refused", !noChoice.ok && /keep it, or apply/.test(noChoice.message) && (await ledger(K.enrollmentId)).length === 0, noChoice.message);
    const pk = await actions.staffChangePackageAction(K.enrollmentId, { package: "Pro", effectiveMonthKey: MK, currentMonthChoice: "KEEP", reason: "drill: upgrade" });
    const afterPk = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K.enrollmentId } });
    const rowsPk = await ledger(K.enrollmentId);
    const monthNow = await prisma.contentMonth.findUniqueOrThrow({ where: { id: K.monthId } });
    c.ok("Kyle CAN change the package — it is Pro now", pk.ok && afterPk.package === "Pro", pk.message);
    c.ok("  …recorded: a package row, applied, naming Kyle", rowsPk.some((r) => r.field === "package" && r.changedBy === KYLE.email && !!r.appliedAt && r.toValue === JSON.stringify("Pro")), rowsPk.map((r) => `${r.field}:${r.changedBy}`).join(","));
    c.ok("  …KEEP held this month's obligation (quantities start next month, pending)", afterPk.videosPerMonth === before.videosPerMonth && monthNow.videosOwed === before.videosPerMonth && rowsPk.some((r) => r.field === "videosPerMonth" && !r.appliedAt && r.effectiveMonthKey !== MK));

    const pz = await actions.staffSetEnrollmentStatusAction(K.enrollmentId, "PAUSED", "drill: vacation");
    const en = await actions.staffSetEnrollmentStatusAction(K.enrollmentId, "ENDED");
    const afterEnd = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K.enrollmentId } });
    const statusRows = (await ledger(K.enrollmentId)).filter((r) => r.field === "status");
    c.ok("Kyle CAN pause and end", pz.ok && en.ok && afterEnd.status === "ENDED" && afterEnd.statusManual, `${pz.message} / ${en.message}`);
    c.ok("  …two status rows, ACTIVE→PAUSED→ENDED, each naming Kyle", statusRows.length === 2 && statusRows[0].fromValue === JSON.stringify("ACTIVE") && statusRows[0].toValue === JSON.stringify("PAUSED") && statusRows[1].toValue === JSON.stringify("ENDED") && statusRows.every((r) => r.changedBy === KYLE.email && r.source === "manual" && !r.billingTruth), statusRows.map((r) => `${r.fromValue}->${r.toValue}`).join(" "));
    const back = await actions.staffSetEnrollmentStatusAction(K.enrollmentId, "ACTIVE");
    c.ok("  …and can bring them back, recorded too", back.ok && (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K.enrollmentId } })).status === "ACTIVE" && (await ledger(K.enrollmentId)).filter((r) => r.field === "status").length === 3);

    const nextKey = rowsPk.find((r) => r.field === "videosPerMonth")!.effectiveMonthKey!;

    // ---- a decision that matches what is SCHEDULED cancels nothing (Sep 24) ----
    // Finding 1 + 8. After "Pro this month / KEEP" the enrollment reads Pro but
    // 2 videos until next month; the card used to show "2" and Kyle re-typed
    // Pro's 8 for next month. OLD: no row written, yet all three pending rows
    // superseded — a "Pro" on 2 videos / 1 session / 2h forever.
    {
      const oldLedger = (await import(base.ledger)) as { changePackage: (id: string, i: Record<string, unknown>, by: string | null) => Promise<{ changeIds: string[]; superseded: unknown[] }> };
      const O = await buildContentMonth(db, { name: "Oscar Oldkeep TEST", package: "Starter", monthKey: MK, owner: false });
      await oldLedger.changePackage(O.enrollmentId, { package: "Pro", effectiveMonthKey: MK, currentMonthChoice: "KEEP" }, KYLE.email);
      const pendBefore = (await ledger(O.enrollmentId)).filter((r) => !r.appliedAt).length;
      const again = await oldLedger.changePackage(O.enrollmentId, { package: "Pro", effectiveMonthKey: nextKey, currentMonthChoice: null, videosPerMonth: null }, KYLE.email);
      const pendAfter = (await ledger(O.enrollmentId)).filter((r) => !r.appliedAt).length;
      c.ok("OLD: re-affirming Pro for next month after a KEEP upgrade wrote nothing and CANCELLED the 3 pending quantity rows", pendBefore === 3 && again.changeIds.length === 0 && again.superseded.length === 3 && pendAfter === 0, `${pendBefore} pending → ${pendAfter}, superseded ${again.superseded.length}`);

      const K2 = await buildContentMonth(db, { name: "Kip Keepcheck TEST", package: "Starter", monthKey: MK, owner: false });
      await actions.staffChangePackageAction(K2.enrollmentId, { package: "Pro", effectiveMonthKey: MK, currentMonthChoice: "KEEP" });
      const wd = await import("@/app/content/[id]/workspaceData");
      const st = await wd.loadSettingsTab(K2.enrollmentId, false);
      c.ok("NEW: the Settings loader hands the card next month's terms (Pro · 8), not today's column (2)", !!st && st.settings.videosPerMonth === 2 && st.settings.nextTerms.pkg === "Pro" && st.settings.nextTerms.videosPerMonth === 8 && st.settings.nextTerms.sessionsPerMonth === 2, JSON.stringify(st?.settings.nextTerms));
      const re = await actions.staffChangePackageAction(K2.enrollmentId, { package: "Pro", effectiveMonthKey: nextKey, currentMonthChoice: null, videosPerMonth: null });
      const live2 = (await ledger(K2.enrollmentId)).filter((r) => !r.appliedAt && !(r.reason ?? "").startsWith("SUPERSEDED"));
      c.ok("NEW: re-affirming Pro for next month writes nothing AND cancels nothing — 3 quantity rows still pending", re.ok && /Nothing changed/.test(re.message) && !/never take effect/.test(re.message) && live2.length === 3 && live2.every((r) => r.effectiveMonthKey === nextKey), re.message);

      // The same scheduled decision pressed twice (the armed button).
      const K3 = await buildContentMonth(db, { name: "Kay Twicepress TEST", package: "Starter", monthKey: MK, owner: false });
      const first = await actions.staffChangePackageAction(K3.enrollmentId, { package: "Pro", effectiveMonthKey: nextKey, currentMonthChoice: null });
      const second = await actions.staffChangePackageAction(K3.enrollmentId, { package: "Pro", effectiveMonthKey: nextKey, currentMonthChoice: null });
      const live3 = (await ledger(K3.enrollmentId)).filter((r) => !r.appliedAt && !(r.reason ?? "").startsWith("SUPERSEDED"));
      c.ok("NEW: 'Pro from next month' pressed twice keeps all 4 scheduled rows (the second press is a no-op)", first.ok && second.ok && /Nothing changed/.test(second.message) && live3.length === 4, `${live3.length} live · ${second.message}`);
      // …and the revert path the supersede rule exists for still works.
      const revert = await actions.staffChangePackageAction(K3.enrollmentId, { package: "Starter", effectiveMonthKey: MK, currentMonthChoice: "APPLY" });
      const live3b = (await ledger(K3.enrollmentId)).filter((r) => !r.appliedAt && !(r.reason ?? "").startsWith("SUPERSEDED"));
      const e3 = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K3.enrollmentId } });
      c.ok("  …while 'back to Starter, this month' still cancels the scheduled raise, and says so", revert.ok && live3b.length === 0 && e3.package === "Starter" && e3.videosPerMonth === 2 && /never take effect/.test(revert.message), revert.message);

      const ws0 = read("src/components/content/Workspace.tsx");
      c.ok("NEW: the card starts from and compares with nextTerms, disarms on success, and colours its note", /useState\(nextTerms\.pkg\)/.test(ws0) && /differsFrom\(nextTerms\)/.test(ws0) && /setWhen\("next"\)/.test(ws0) && /text-success/.test(ws0));
    }

    const custom = await actions.staffChangePackageAction(K.enrollmentId, { package: "Pro", effectiveMonthKey: nextKey, currentMonthChoice: null, videosPerMonth: 5, reason: "drill: 5-video deal" });
    const customRows = (await ledger(K.enrollmentId)).filter((r) => r.field === "videosPerMonth" && r.toValue === "5");
    c.ok("a custom deal's count (the old free-typed box) is a ledgered, scheduled change now", custom.ok && customRows.length === 1 && customRows[0].effectiveMonthKey === nextKey && !customRows[0].appliedAt && customRows[0].changedBy === KYLE.email, custom.message);

    // The custom count wrote only its own row; the pending sessions (1→2) and
    // hours rows from the KEEP upgrade agree with Pro and must SURVIVE it (the
    // old rule superseded them too, leaving a "Pro" on 1 session for good).
    const liveQty = async (id: string, field: string) => (await ledger(id)).filter((r) => r.field === field && !r.appliedAt && !(r.reason ?? "").startsWith("SUPERSEDED"));
    c.ok("  …and it leaves the KEEP upgrade's pending sessions and hours rows in force", (await liveQty(K.enrollmentId, "sessionsPerMonth")).length === 1 && (await liveQty(K.enrollmentId, "sessionHours")).length === 1 && (await liveQty(K.enrollmentId, "sessionsPerMonth"))[0].toValue === "2");
    const { enrollmentHistory } = await import("@/lib/enrollmentChanges");
    const hist = await enrollmentHistory(K.enrollmentId, 80);
    c.ok("the Settings tab's history shows every one of Kyle's changes", hist.filter((h) => h.changedBy === KYLE.email).length === (await ledger(K.enrollmentId)).filter((r) => r.changedBy === KYLE.email).length && hist.length >= 6, String(hist.length));

    const wa = await import("@/app/content/[id]/workspaceActions");
    const bill = await wa.setBillingTermsAction(K.enrollmentId, { type: "MONTHLY_CONTRACT", rate: 1500, months: 12 });
    c.ok("money stays owner-only: Kyle cannot set billing terms", !bill.ok && (await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: K.enrollmentId } })).billingRate === null, bill.message);
    await actAs(JORDAN);
    const bill2 = await wa.setBillingTermsAction(K.enrollmentId, { type: "MONTHLY_CONTRACT", rate: 1500, months: 12 });
    c.ok("  …Jordan can, and it is ledgered", bill2.ok && (await ledger(K.enrollmentId)).some((r) => r.field === "billingRate" && r.changedBy === JORDAN.email));

    const settingsTab = read("src/app/content/[id]/tabs/SettingsTab.tsx");
    const ws = read("src/components/content/Workspace.tsx");
    c.ok("the Settings tab mounts the ledgered controls for OWNER/ADMIN (package & status for the non-owner)", /<EnrollmentControls/.test(settingsTab) && /ctx\.staffEyes/.test(settingsTab) && /packageAndStatus=\{!ctx\.ownerEyes\}/.test(settingsTab));
    c.ok("the controls post to the ledgered actions only — the legacy card and saveEnrollmentSettings are gone", /staffChangePackageAction\(/.test(ws) && /staffSetEnrollmentStatusAction\(/.test(ws) && !/saveEnrollmentSettings\(|function EnrollmentSettingsCard/.test(ws));
    // Finding 5/14: Kyle's panel below the card no longer says "Only Jordan
    // changes a package", nor repeats a button-less status section.
    const sp = read("src/components/content/SettingsPanel.tsx");
    c.ok("OLD: the panel under Kyle's card told him 'Only Jordan changes a package.'", /Only Jordan changes a package\./.test(show("src/components/content/SettingsPanel.tsx")));
    c.ok("NEW: the Settings tab passes packageHandledAbove for ADMIN, and the panel then drops its package + status copies", /packageHandledAbove=\{ctx\.staffEyes && !ctx\.ownerEyes\}/.test(settingsTab) && /!packageHandledAbove && <PackageCard/.test(sp) && /!packageHandledAbove && <Section icon=\{Settings2\} title="Enrollment status"/.test(sp) && !/Only Jordan changes a package/.test(sp));
  }

  // =========================================================================
  c.head("5 · version-exact approval is the only staff approval");
  // =========================================================================
  {
    await actAs(JORDAN);
    const V = await buildContentMonth(db, { name: "Vera Version TEST", package: "Accelerator", monthKey: MK, owner: false });
    const script = await prisma.contentScript.create({ data: { enrollmentId: V.enrollmentId, clientId: V.clientId, monthId: V.monthId, title: "First weekend", body: "b", status: "INTERNAL_REVIEW" }, select: { id: true } });
    const points = JSON.stringify([{ role: "RE_HOOK", text: "Buyers decide in two days." }, { role: "BUILD_UP", text: "Price it right and they compete." }, { role: "PAYOFF", text: "That's how you win the weekend." }]);
    const mkV = (n: number) => prisma.contentScriptVersion.create({ data: { scriptId: script.id, enrollmentId: V.enrollmentId, clientId: V.clientId, versionNo: n, title: "First weekend", hook: `Your first weekend decides your price (v${n}).`, pointsJson: points, close: "Call me before you list.", body: `v${n} body`, source: "AI", status: "INTERNAL_REVIEW" }, select: { id: true } });
    const v1 = await mkV(1);
    await prisma.contentScript.update({ where: { id: script.id }, data: { currentVersionId: v1.id } });
    // The page rendered v1; a revise lands v2 before the click.
    const v2 = await mkV(2);
    await prisma.contentScript.update({ where: { id: script.id }, data: { currentVersionId: v2.id } });
    const actions = await import("@/app/content/actions");
    const r = await actions.approveScriptVersionAction(v1.id, "drill: pillar override");
    const after = await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } });
    const v2row = await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: v2.id } });
    c.ok("approving the version on screen (v1) approves v1 — exactly", r.ok && after.approvedVersionId === v1.id, `${r.ok} ${r.message}`);
    c.ok("  …and never the later v2 written after the page rendered", after.approvedVersionId !== v2.id && v2row.status !== "APPROVED" && v2row.status !== "SHARED", v2row.status);
    const legacy = await (actions.approveScript as unknown as (id: string, n?: string) => Promise<{ ok: boolean; message: string }>)(script.id, "drill");
    c.ok("the unmounted by-id approveScript refuses a call that does not name the version it showed", !legacy.ok && /Reload/.test(legacy.message) && (await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id } })).approvedVersionId !== v2.id, legacy.message);
    const tabs = fs.readdirSync(path.join(REPO, "src/app/content/[id]/tabs")).map((f) => read(`src/app/content/[id]/tabs/${f}`)).join("\n") + read("src/app/content/[id]/page.tsx");
    const ws = read("src/components/content/Workspace.tsx");
    c.ok("no staff screen mounts the retired ScriptReview, and Workspace no longer calls approveScript", !/ScriptReview|approveScript\b/.test(tabs) && !/approveScript\(|function ScriptReview/.test(ws));
    c.ok("ScriptsPanel is the approval surface, and it approves by version id", /approveScriptVersionAction\(cur\.id/.test(read("src/components/content/ScriptsPanel.tsx")) && /<ScriptsPanel /.test(tabs));

    // The client's open change requests — only ever shown inside the retired list.
    await prisma.scriptSuggestion.create({ data: { scriptId: script.id, enrollmentId: V.enrollmentId, body: "Say Main Line, not Philly.", status: "OPEN", scriptVersionId: v1.id } });
    const { loadScriptRequests } = await import("@/app/content/[id]/programData");
    const groups = await loadScriptRequests({ id: V.monthId });
    const cur = await prisma.contentScript.findUniqueOrThrow({ where: { id: script.id }, select: { currentVersionId: true } });
    const curNo = cur.currentVersionId ? (await prisma.contentScriptVersion.findUniqueOrThrow({ where: { id: cur.currentVersionId } })).versionNo : null;
    c.ok("the client's open script request now loads for Plan › Scripts (with the version the script is on now)", groups.length === 1 && groups[0].requests.length === 1 && groups[0].versionNo === curNo && /<ScriptRequestsPanel/.test(tabs), JSON.stringify(groups));
  }

  // =========================================================================
  c.head("6 · the portal preview is the owner's");
  // =========================================================================
  {
    c.ok("canPreviewPortal: OWNER yes; ADMIN, EDITOR, CREATIVE no", canPreviewPortal({ role: "OWNER" }, true) && !canPreviewPortal({ role: "ADMIN" }, true) && !canPreviewPortal({ role: "EDITOR" }, true) && !canPreviewPortal({ role: "CREATIVE" }, true));
    c.ok("signed out: no preview when auth is enforced; open local dev counts as the owner", !canPreviewPortal(null, true) && canPreviewPortal(null, false));
    c.ok("resolveStaffTab('portal') for a non-owner is the overview, not the preview", resolveStaffTab("portal", null, false).tab === "overview" && !resolveStaffTab("portal", null, false).preview);
    const pv = read("src/app/content/[id]/preview/page.tsx");
    const pg = read("src/app/content/[id]/page.tsx");
    c.ok("the preview page gates on canPreviewPortal and redirects outside any try; the warning moved with it", /if \(!canPreviewPortal\(me, authEnforced\(\)\)\) redirect\(/.test(pv) && !/\btry\s*\{/.test(pv) && /on behalf of/.test(pv) && /<iframe/.test(pv));
    c.ok("the client file redirects old keys outside any try, and no longer embeds the portal", /if \(nav\.redirect\) redirect\(contentHref\(/.test(pg) && !/\btry\s*\{/.test(pg) && !/<iframe/.test(pg));
  }

  // =========================================================================
  c.head("7 · the tab loaders run on the fixture");
  // =========================================================================
  {
    await actAs(KYLE);
    const wd = await import("@/app/content/[id]/workspaceData");
    const pd = await import("@/app/content/[id]/programData");
    const sess = await wd.loadSessionsView({ id: P.monthId });
    c.ok("Production › Sessions: the Pro shell is listed (never counted), with its filmed-topic line", sess.projects.length === 1 && sess.projects[0].id === P.projectId && sess.projects[0].topicsConfirmedHere === 0, JSON.stringify(sess.projects));
    const revs = await wd.loadRevisionsView(P.enrollmentId);
    c.ok("Production › Revisions loads (nothing in motion on a fresh fixture)", revs.briefs.length === 0 && revs.cuts.length === 0);
    const calls = await pd.loadCallsTab(P.enrollmentId);
    c.ok("Plan › Calls loads", Array.isArray(calls) && calls.length === 0);
    const notes = await pd.loadLegacyNotes(S.clientId);
    c.ok("Plan › Knowledge's legacy notes load", Array.isArray(notes));
  }

  c.head("8 · the review's staff findings (Sep 24)");
  // =========================================================================
  {
    // Finding 17 — a badged tab opens the view that holds what it counts.
    const pg = read("src/app/content/[id]/page.tsx");
    // (The tab bar is UI-02's own, so git has no older copy of it: the OLD
    // shape is what a bare tab link resolves to.)
    const bare = { plan: reResolve(contentHref("x", { tab: "plan" })), production: reResolve(contentHref("x", { tab: "production" })) };
    c.ok("OLD shape: a bare tab link opens Plan › Topics and Production › Sessions — neither lists what the badge counts", bare.plan.view === "topics" && bare.production.view === "sessions", JSON.stringify(bare));
    c.ok("NEW: Plan's badge opens Scripts (or Strategy), Production's opens Revisions", /t === "plan" && badge\.plan \? \(scriptsNeedMe \? "scripts" : "strategy"\) : t === "production" && badge\.production \? "revisions" : null/.test(pg) && /contentHref\(id, \{ tab: t, view: badgeView\(t\), month: mk \}\)/.test(pg));
    for (const [tab, view] of [["plan", "scripts"], ["plan", "strategy"], ["production", "revisions"]] as const) {
      const r = reResolve(contentHref("x", { tab, view }));
      c.ok(`  …${tab} › ${view} is a canonical address (lands, no redirect)`, r.tab === tab && r.view === view && !r.redirect, JSON.stringify(r));
    }

    // Finding 18 — the Overview's one button never links to the Overview.
    const ended = await buildContentMonth(db, { name: "Enid Ended TEST", package: "Starter", monthKey: MK, owner: false });
    await actAs(JORDAN);
    const { staffSetEnrollmentStatusAction } = await import("@/app/content/actions");
    await staffSetEnrollmentStatusAction(ended.enrollmentId, "ENDED");
    const { loadOverviewTab } = await import("@/app/content/[id]/workspaceData");
    const ov = await loadOverviewTab(ended.enrollmentId, MK);
    const self = contentHref(ended.enrollmentId, { month: MK });
    c.ok("an ENDED month's next action points at the Overview itself ('Open the history') — the case", !!ov.row && ov.row.nextAction.href === self, `${ov.row?.nextAction.cta} → ${ov.row?.nextAction.href}`);
    const ot = read("src/app/content/[id]/tabs/OverviewTab.tsx");
    c.ok("NEW: OverviewTab drops the button when it would link to itself (the words stay)", /const selfLink = !!row && row\.nextAction\.href === contentHref\(id, \{ month: mk \}\);/.test(ot) && /\{!selfLink && \(\s*<Link href=\{row\.nextAction\.href\}/.test(ot));
  }

  c.head("isolation");
  c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.join(", "));

  quiet.restore();
  removeBase(base.dir);
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
