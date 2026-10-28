// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: every task and assignment row has a button (Oct 28 2026, ACTIONS).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct28-actionable-rows.ts
//
// Jordan: "make sure every task and assignment has an actionable button."
// (The Oct 27 Loom: every row actionable in place, reply, delegate, mark
// handled, approve, never just text or a link to a generic page.)
//
//   §1 Kyle's dashboard, rendered from a fixture: every row of every card,
//      folds included (the jobs awaiting files, the follow-ups waiting on
//      someone), has a labelled button that opens its quick actions. A row
//      with no move of its own still says Follow up / Open / its Mark
//      delivered. A lead has Disregard beside Handle lead, and its panel
//      carries the Tasks board's own Disregard. A shoot that is done says
//      "Shot" once (Kyle: the chip, then "Shot" again under it).
//   §2 Kyle's dashboard built from a disposable database: a phone lead's row
//      opens ITS task (/tasks?task=<id>), not the whole inbox, and carries
//      Disregard (phone: Spam mutes the number); a task with no job opens
//      itself on Tasks, not the whole board; the built desk, rendered, has a
//      button on every row.
//   §3 Jordan's dashboard list panel: every row carries its action, Assign,
//      or Open (its panel, or its exact page); a plain fact (time off) none.
//   §4 the photographer's Your tasks: a labelled 44px Done on every row (not
//      a 20px empty circle); a "view as" preview has none.
//   §5 the Tasks board's compact rows: a button beyond the title on every
//      row (Done / Reply / Disregard on a lead).
//   §6 the owner dashboard's server pieces (source): a task that can't be
//      read opens /tasks?task=<id>, an escalation with no record links its
//      task, Team workload rows open their task, an escalation row opens its
//      task panel in place.
//
// ISOLATION: PGlite via the shared harness; fetch fenced; no message is sent;
// production is never opened.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { DeskAction, DeskItem, DeskPanel, OfficeDesk as Desk, PrepVisit } from "../../src/lib/officeDesk";
import type { ListRow, PanelSpec } from "../../src/components/owner/panelTypes";
import type { QueueTask } from "../../src/components/queue/TaskCard";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {}, back() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
  navigation.usePathname = () => "/";
}

const H = 3_600_000;
const read = (p: string) => readFileSync(p, "utf8");
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;|&ldquo;|&rdquo;|“|”/g, '"').replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One card's HTML (the <section> carrying data-desk-section). */
function card(html: string, attr: string): string {
  const at = html.indexOf(attr);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("<section", at), html.indexOf("</section>", at));
}
type Row = { id: string; attrs: string; html: string; state: string | null; button: string | null };
/** Every desk row (<li data-desk-item>) and the label of the button that opens its quick actions. */
function rowsOf(html: string): Row[] {
  return [...html.matchAll(/<li data-desk-item="([^"]+)"([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => {
    const b = new RegExp(`<button[^>]*data-open-panel="${esc(m[1])}"[^>]*>([\\s\\S]*?)</button>`).exec(m[3]);
    return { id: m[1], attrs: m[2], html: m[3], state: /data-state="([^"]+)"/.exec(m[2])?.[1] ?? null, button: b ? text(b[1]) : null };
  });
}
const labelled = (r: Row) => !!r.button && r.button.length > 1 && r.button !== "Handle";

// ---- §1's fixture (every name made up) ----
const T = Date.parse("2026-10-28T15:00:00.000Z"); // 11 AM ET
const iso = (h: number) => new Date(T + h * H).toISOString();
const PROJ = { a: "cfixproj0000000000101", wait: "cfixproj0000000000102", plan: "cfixproj0000000000103", shoot: "cfixproj0000000000104" };
const item = (o: Partial<DeskItem> & Pick<DeskItem, "id" | "section" | "title">): DeskItem => ({ state: "now", line: "", reason: "Why it is on the list.", client: null, who: null, dueISO: null, dueWords: null, late: false, rank: 2, primary: null, actions: [], href: null, panel: { kind: "task", lines: [] }, sinceISO: null, ...o });
const jobPanel = (projectId: string, street: string): DeskPanel => ({ kind: "job", projectId, street, client: "Sam Sample", assets: [], findings: [], aryeoUrl: null });
const link = (label: string, href: string): DeskAction => ({ kind: "link", label, href });
const task = (taskId: string, canWait = true): DeskAction => ({ kind: "task", taskId, allowNewDate: true, canWait });
const plan = (projectId: string, street: string): Extract<DeskAction, { kind: "mark-delivered" }> => ({
  kind: "mark-delivered", projectId, category: "Floor plan", street, maker: "CubiCasa", label: "Check floor plan",
  why: "The floor plan is not on the Aryeo listing yet.", history: [], anchor: "deliverable-floorplan",
});
const reply = (key: string): Extract<DeskAction, { kind: "reply" }> => ({ kind: "reply", threadKey: `phone:${key}`, family: "phone", clientId: "cfixclient0000000101", groupKey: key, phone: key, href: `/communications?thread=${encodeURIComponent(`phone:${key}`)}`, taskId: null, commLogId: null });
const visit = (o: Partial<PrepVisit> & Pick<PrepVisit, "apptId" | "street" | "timeISO">): PrepVisit => ({
  projectId: PROJ.shoot, client: "Sam Sample", dayKey: "2026-10-28", endISO: null, over: false, photographer: "Harrison Shoots", photographerId: "cfixteam000000000101", photographerPhone: "2155550177",
  confirmation: { state: "sent", words: "Confirmed", taskId: null }, access: { lockbox: "4321", access: null, presence: null, contactName: null, contactPhone: null },
  services: ["Photos"], servicesFrom: "visit", requests: [], instructions: [], earlier: [], revisionsAfterDelivery: [], conflicts: [], gaps: [],
  brief: { state: "unknown", words: "Brief acknowledged", why: null, href: null, sent: true }, otherVisits: [], ...o,
});
const shootRow = (id: string, v: PrepVisit, chip: DeskItem["chip"]): DeskItem =>
  item({ id, section: "shoots", day: "today", state: "ok", title: v.street, line: chip?.label ?? "", client: v.client, dueISO: v.timeISO, primary: { label: "Open the shoot", action: link("Open the job", `/projects/${v.projectId}`) }, actions: [link("Open the job", `/projects/${v.projectId}`)], href: `/projects/${v.projectId}`, panel: { kind: "visit", visit: v }, chip });

const LEAD = "cfixlead000000000101";
function fixtureDesk(): Desk {
  const r1 = reply("2155550101");
  const md = plan(PROJ.plan, "3 Plan Pl");
  // The live desk's started shoot: confirmation "Shot" / "On site now", chip "Shot" / "On site".
  const shot = visit({ apptId: "cfixappt000000000101", street: "9 Early Rd", timeISO: iso(-4), endISO: iso(-2), over: true, confirmation: { state: "na", words: "Shot", taskId: null } });
  const onSite = visit({ apptId: "cfixappt000000000102", street: "10 Midday Rd", timeISO: iso(-1), endISO: iso(1), confirmation: { state: "na", words: "On site now", taskId: null } });
  const later = visit({ apptId: "cfixappt000000000103", street: "11 Later Rd", timeISO: iso(3) });
  return {
    nowISO: iso(0), dayKey: "2026-10-28", dateWords: "Wednesday, October 28", person: "Kyle Smith",
    people: { creative: "James", owner: "Jordan", creativeKey: "james", ownerKey: "jordan" },
    delegates: [{ key: "james", name: "James Livingston" }, { key: "jordan", name: "Jordan Spackman" }],
    deliverHref: "/jobs?f=deliver", readOnly: false,
    freshness: [], unavailable: [], urgent: [],
    sections: [
      { key: "deliver", title: "Review & Deliver", empty: "Nothing to review or deliver.", count: 1, quiet: [], unavailable: [], ok: [],
        now: [item({ id: `media:${PROJ.a}`, section: "deliver", group: "media", title: "1 Approve Ave", line: "Photos ready to approve", primary: { label: "Approve and deliver", action: { kind: "photo-approve", jobId: "cfixjob00000000000101", street: "1 Approve Ave" } }, actions: [{ kind: "photo-approve", jobId: "cfixjob00000000000101", street: "1 Approve Ave" }], panel: jobPanel(PROJ.a, "1 Approve Ave") })],
        // Awaiting files: no move of Kyle's own (primary null), one with the floor plan's Mark delivered.
        waiting: [
          item({ id: `media:${PROJ.wait}`, section: "deliver", group: "media", state: "waiting", title: "2 Waiting Way", line: "Waiting on AutoHDR", actions: [link("Open the job", `/projects/${PROJ.wait}`)], href: `/projects/${PROJ.wait}`, panel: jobPanel(PROJ.wait, "2 Waiting Way") }),
          item({ id: `media:${PROJ.plan}`, section: "deliver", group: "media", state: "waiting", title: "3 Plan Pl", line: "Floor plan not in yet", actions: [md], href: `/projects/${PROJ.plan}`, panel: jobPanel(PROJ.plan, "3 Plan Pl") }),
        ] },
      { key: "comms", title: "Client Communications", empty: "Everyone has an answer.", count: 2, quiet: [], unavailable: [], ok: [],
        now: [
          item({ id: "reply:phone:2155550101", section: "comms", title: "Riley Sample", channel: "Text", initials: "RS", line: "When will the photos be ready?", primary: { label: "Reply", action: r1 }, actions: [r1, { kind: "handled", threadKey: r1.threadKey, family: "phone", clientId: r1.clientId, groupKey: r1.groupKey }], panel: { kind: "thread", client: "Riley Sample", family: "phone", messages: [{ atISO: iso(-2), text: "When will the photos be ready?" }], holding: null, revisionNote: null, alsoAsked: [] } }),
          item({ id: `lead:${LEAD}`, section: "comms", title: "New texter: reply to (215) 555-0188", channel: "Lead", initials: "NL", line: "New lead", primary: { label: "Handle lead", action: task(LEAD, false) }, actions: [task(LEAD, false), { kind: "lead-disregard", taskId: LEAD, phoneLead: true }], href: `/tasks?task=${LEAD}`, panel: { kind: "task", lines: [{ label: "Lead", value: "New texter: reply to (215) 555-0188" }] } }),
        ],
        // An email Kyle answered, waiting on Jordan to verify: no move of his own.
        // (the live desk's own shape: a delegation, primary null, and Open in Messages).
        waiting: [item({ id: "task:cfixtask000000000109", section: "comms", tag: "jordan", state: "waiting", title: "Answer Morgan about the invoice", channel: "Email", line: "From Jordan · waiting on Jordan to verify", who: "Jordan", actions: [{ kind: "delegation", taskId: "cfixtask000000000109", state: "READY_FOR_VERIFICATION", needsVerification: true }, link("Open in Messages", "/communications?thread=email%3Aclient%3Acfixclient0000000101")] })] },
      { key: "shoots", title: "Today's Shoots", empty: "No shoots today.", count: 0, quiet: [], unavailable: [], waiting: [], now: [],
        ok: [
          shootRow("visit:cfixappt000000000101", shot, { label: "Shot", tone: "muted" }),
          shootRow("visit:cfixappt000000000102", onSite, { label: "On site", tone: "muted" }),
          shootRow("visit:cfixappt000000000103", later, { label: "Ready", tone: "ok" }),
        ] },
      { key: "followups", title: "Requests & Follow-Ups", empty: "Nothing due today.", count: 1, quiet: [], unavailable: [], ok: [],
        now: [item({ id: "task:cfixtask000000000101", section: "followups", tag: "task", title: "Call the title company", line: "Due today", primary: { label: "Mark done", action: task("cfixtask000000000101") }, actions: [task("cfixtask000000000101")] })],
        // Waiting on someone else: before Oct 28 these rows had no button at all.
        waiting: [
          item({ id: "task:cfixtask000000000102", section: "followups", tag: "task", state: "waiting", title: "Music pick for 9 Early Rd", line: "Waiting on James · Follow up at 2:00 PM", actions: [task("cfixtask000000000102")] }),
          item({ id: "task:cfixtask000000000103", section: "followups", tag: "assigned", state: "waiting", title: "Fix the gallery order", line: "Waiting on Jordan to verify", who: "Jordan", actions: [task("cfixtask000000000103")] }),
          item({ id: "rev:cfixrev0000000000101", section: "followups", tag: "revision", state: "waiting", title: "Shorter intro for 40 Example Ct", line: "With Dana · due tomorrow", actions: [link("Open the cut", "/review?cut=cfixcut0000000000101")] }),
        ] },
    ],
    checks: {
      dayKey: "2026-10-28",
      groups: [
        { key: "morning", label: "Morning review", done: false, completedAtISO: null, lines: [{ key: "am_messages", label: "Review client messages", manual: true, auto: false, autoWords: "2 conversations waiting on you", tick: null, done: false }] },
        { key: "midday", label: "Midday review", done: false, completedAtISO: null, lines: [{ key: "md_new", label: "Review new messages and returned media", manual: true, auto: null, autoWords: "", tick: null, done: false }] },
        { key: "eod", label: "End-of-day review", done: false, completedAtISO: null, lines: [{ key: "eod_messages", label: "Client messages reviewed", manual: true, auto: false, autoWords: "", tick: null, done: false }] },
      ],
      finished: null, newSinceFinish: 0,
      summary: { activity: [], completed: [], completedTotal: 0, pending: [], blockers: [], tomorrow: { dayWords: "Thursday", lines: [] } },
    },
    backlog: { count: 0, href: "/tasks?mine=1" },
    nextDay: { dayKey: "2026-10-29", dayName: "Thursday", visits: 0, appointments: { confirmed: 0, pending: 0 }, access: { recorded: 0, missing: 0 }, instructions: { ready: 0, review: 0 }, missing: [] },
    briefsPending: [],
    commsFresh: true,
  } as unknown as Desk;
}

async function main() {
  // The disposable database first: DATABASE_URL points at it before any module that could read it loads.
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5644), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct28-actionable-rows" } });
  const c = makeChecker();
  try {
    const { OfficeDesk } = await import("@/components/desk/OfficeDesk");
    const desk = await import("@/lib/officeDesk");

    // =====================================================================
    c.head("§1 · Kyle's dashboard: a labelled button on every row, folds included");
    // =====================================================================
    const f = fixtureDesk();
    const html = ssr(createElement(OfficeDesk, { desk: f }));
    c.ok("it renders", !html.startsWith("RENDER FAILED") && html.includes("data-office-desk"), html.slice(0, 200));
    const rows = rowsOf(html);
    const expected = f.sections.flatMap((s) => [...s.now, ...s.waiting, ...s.ok]).filter((i) => i.section !== "shoots" || i.day === "today").map((i) => i.id);
    c.ok("every row in the data is on the page (the folds render their rows)", expected.every((id) => rows.some((r) => r.id === id)), expected.filter((id) => !rows.some((r) => r.id === id)).join());
    const bare = rows.filter((r) => !labelled(r));
    c.ok("EVERY row has a labelled button that opens its quick actions (none a bare 'Handle')", rows.length >= 13 && bare.length === 0, bare.map((r) => r.id).join() || `${rows.length} rows`);

    const deliver = rowsOf(card(html, 'data-desk-section="deliver"'));
    c.ok("Review & Deliver, awaiting files: a job waiting on AutoHDR says Open", deliver.find((r) => r.id === `media:${PROJ.wait}`)?.button === "Open", deliver.map((r) => `${r.id}=${r.button}`).join());
    c.ok("…a floor plan not in yet says its own move (Check floor plan)", deliver.find((r) => r.id === `media:${PROJ.plan}`)?.button === "Check floor plan");
    c.ok("…each awaiting row keeps the row text a 36px press and the button 44px (QUIET's min-h-11)", /data-state="waiting" class="flex items-center gap-2 py-1\.5"/.test(html) && /<button[^>]*data-open-panel="media:[^"]+"[^>]*class="[^"]*min-h-11/.test(card(html, 'data-desk-section="deliver"')));

    const fu = rowsOf(card(html, 'data-desk-section="followups"'));
    c.ok("Requests & Follow-Ups, waiting on James: Follow up (its panel: Mark done, a new date, Waiting on, Delegate)", fu.find((r) => r.id === "task:cfixtask000000000102")?.button === "Follow up", fu.map((r) => `${r.id}=${r.button}`).join());
    c.ok("…waiting on Jordan to verify: Follow up, and the row names who it waits on", fu.find((r) => r.id === "task:cfixtask000000000103")?.button === "Follow up" && text(fu.find((r) => r.id === "task:cfixtask000000000103")!.html).includes("Waiting on Jordan to verify"));
    c.ok("…a revision with an editor: Open (the cut itself)", fu.find((r) => r.id === "rev:cfixrev0000000000101")?.button === "Open");
    const pWait = ssr(createElement(OfficeDesk, { desk: f, initialOpen: "task:cfixtask000000000102" }));
    c.ok("…and its button opens real controls: the task's Mark done and Delegate / Escalate", pWait.includes('data-control="task-resolve"') && pWait.includes('data-control="hand-on"'));
    const pRev = ssr(createElement(OfficeDesk, { desk: f, initialOpen: "rev:cfixrev0000000000101" }));
    c.ok("…the revision's panel opens the exact cut, not a generic page", pRev.includes('href="/review?cut=cfixcut0000000000101"'));

    const comms = rowsOf(card(html, 'data-desk-section="comms"'));
    const lead = comms.find((r) => r.id === `lead:${LEAD}`);
    c.ok("Client Communications: the lead says Handle lead, with Disregard beside it (Kyle: 'a lot of them are spam')", lead?.button === "Handle lead" && !!lead && lead.html.includes(`data-disregard-row="lead:${LEAD}"`) && text(lead.html).includes("Disregard"), lead?.html.slice(0, 300));
    c.ok("…a reply row has no Disregard (only a lead does)", !comms.find((r) => r.id === "reply:phone:2155550101")?.html.includes("data-disregard-row"));
    const commsCard = card(html, 'data-desk-section="comms"');
    c.ok("…an email waiting on Jordan to verify is on the card now (it was in the data, never shown): folded, '1 waiting on others'", commsCard.includes("data-waiting") && text(commsCard).includes("1 waiting on others"));
    c.ok("…with its button (Follow up) and the row naming who it waits on", comms.find((r) => r.id === "task:cfixtask000000000109")?.button === "Follow up" && text(comms.find((r) => r.id === "task:cfixtask000000000109")!.html).includes("waiting on Jordan to verify"));
    const pVerify = ssr(createElement(OfficeDesk, { desk: f, initialOpen: "task:cfixtask000000000109" }));
    c.ok("…its panel: the assignment's own controls (Update / Escalate) and Open in Messages", pVerify.includes('data-control="delegation"') && text(pVerify).includes("Open in Messages"), text(pVerify.slice(pVerify.indexOf("data-side-panel"))).slice(0, 400));
    const pLead = ssr(createElement(OfficeDesk, { desk: f, initialOpen: `lead:${LEAD}` }));
    c.ok("…the lead's panel: Mark done and the Tasks board's own Disregard", pLead.includes('data-control="task-resolve"') && pLead.includes('data-control="lead-disregard"') && /data-control="lead-disregard"[\s\S]*?Disregard/.test(pLead));
    c.ok("…the row label for the new control kind", desk.actionLabel({ kind: "lead-disregard", taskId: LEAD, phoneLead: true }) === "Disregard");

    const shoots = rowsOf(card(html, 'data-desk-section="shoots"'));
    const shotRow = shoots.find((r) => r.id === "visit:cfixappt000000000101");
    const shotText = shotRow ? text(shotRow.html) : "";
    c.ok("Today's Shoots: a shoot that is done says 'Shot' ONCE (the chip), not again under it", !!shotRow && (shotText.match(/\bShot\b/g) ?? []).length === 1 && !shotRow.html.includes("data-shoot-sub"), shotText);
    const onSiteRow = shoots.find((r) => r.id === "visit:cfixappt000000000102");
    c.ok("…a shoot under way says 'On site' once (no 'On site now' under it)", !!onSiteRow && text(onSiteRow.html).includes("On site") && !text(onSiteRow.html).includes("On site now"), onSiteRow ? text(onSiteRow.html) : "");
    const laterRow = shoots.find((r) => r.id === "visit:cfixappt000000000103");
    c.ok("…one still to come keeps its confirmation and brief line", !!laterRow && text(laterRow.html).includes("Confirmed · Brief acknowledged"));
    c.ok("…every shoot keeps its button (Open the shoot)", shoots.length === 3 && shoots.every((r) => r.button === "Open the shoot"));

    // =====================================================================
    c.head("§2 · Kyle's dashboard built from a disposable database");
    // =====================================================================
    const { prisma } = await import("@/lib/prisma");
    const { listAssignees } = await import("@/lib/assignees");
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", role: "MANAGER" as never, email: "kyle@oct28.invalid", opsAlerts: true } });
    await prisma.appUser.create({ data: { name: "Kyle Smith", email: "kyle@oct28.invalid", role: "ADMIN", teamMemberId: kyleTm.id, status: "ACTIVE" } });
    const now = new Date();
    const phoneLead = await prisma.smartTask.create({ data: { taskType: "lead", source: "openphone", sourceDetail: "phone:2155550188", status: "OPEN", title: "New texter: reply to (215) 555-0188", createdAt: new Date(now.getTime() - 2 * H), dueAt: new Date(now.getTime() + H) } });
    const webLead = await prisma.smartTask.create({ data: { taskType: "lead", source: "website", status: "OPEN", title: "New lead: Pat Doe wants a listing shoot", createdAt: new Date(now.getTime() - 3 * H), dueAt: new Date(now.getTime() + H) } });
    const noJob = await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", assignedKey: "kyle", title: "Order lockbox keys", createdAt: new Date(now.getTime() - 3 * 24 * H), followUpAt: new Date(now.getTime() + 3 * 24 * H) } });
    const roster = await listAssignees();
    const built = await desk.buildOfficeDesk({ now, excludeClientIds: [], person: { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" }, roster });
    const all = built.sections.flatMap((s) => [...s.now, ...s.waiting, ...s.ok]);
    const lp = all.find((i) => i.id === `lead:${phoneLead.id}`);
    const lw = all.find((i) => i.id === `lead:${webLead.id}`);
    const dis = (i: DeskItem | undefined) => i?.actions.find((a): a is Extract<DeskAction, { kind: "lead-disregard" }> => a.kind === "lead-disregard");
    c.ok("a phone lead's row opens ITS task (/tasks?task=<id>), not the whole inbox (/communications)", lp?.href === `/tasks?task=${phoneLead.id}`, String(lp?.href));
    c.ok("…and carries Disregard, Spam muting the number (phoneLead)", dis(lp)?.phoneLead === true && dis(lp)?.taskId === phoneLead.id, JSON.stringify(lp?.actions));
    c.ok("a website lead: Disregard too, Spam blocking the sender (not a number)", dis(lw)?.phoneLead === false && lw?.href === `/tasks?task=${webLead.id}`);
    const nj = all.find((i) => i.id === `task:${noJob.id}`);
    const backlogHref = built.backlog.href;
    c.ok("a task with no job, when listed, opens itself on Tasks (?task=), never the bare board", nj ? nj.href === `/tasks?task=${noJob.id}` : !!backlogHref, nj ? String(nj.href) : `not listed today; backlog ${backlogHref}`);
    const builtHtml = ssr(createElement(OfficeDesk, { desk: built }));
    const builtRows = rowsOf(builtHtml);
    const builtBare = builtRows.filter((r) => !labelled(r));
    c.ok("the built desk, rendered: every row has a labelled button", !builtHtml.startsWith("RENDER FAILED") && builtRows.length >= 2 && builtBare.length === 0, builtBare.map((r) => r.id).join() || `${builtRows.length} rows`);

    // =====================================================================
    c.head("§3 · Jordan's dashboard list panel: an action, Assign, or Open on every row");
    // =====================================================================
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const roster2 = [{ key: "kyle", name: "Kyle" }, { key: "james", name: "James" }];
    const info: PanelSpec = { kind: "info", title: "Decide: Reshoot 9 Elm", lines: [{ label: "Owner", value: "Kyle" }] };
    const listRows: ListRow[] = [
      { id: "r-nudge", title: "Late edit: 10 Late Ln", sub: "James has it", tone: "bad", href: "/projects/p1", action: { kind: "nudge", label: "Request update", taskId: "cfixtask000000000201" } },
      { id: "r-assign", title: "No photographer: 11 Book Rd", tone: "bad", href: "/projects/p2", assign: { title: "Book a photographer: 11 Book Rd", assigneeKey: "kyle" } },
      { id: "r-open", title: "Escalated: refund for 12 Oak St", tone: "bad", href: "/tasks?task=cfixtask000000000203", open: info, openLabel: "Decide" },
      { id: "r-href", title: "13 Stage Ave: photos editing", tone: "warn", href: "/projects/p4" },
      { id: "r-email", title: "Morgan: invoice", tone: "ok", open: info },
      { id: "r-fact", title: "Harrison: off Friday", sub: "Time off", tone: "warn" },
    ];
    const listHtml = (readOnly: boolean) => ssr(createElement(OwnerShell, { roster: roster2, readOnly, initial: { kind: "list", title: "Team workload", rows: listRows } }, null));
    const lh = listHtml(false);
    const lis = [...lh.slice(lh.indexOf("data-panel-list")).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    const buttonsIn = (h: string) => [...h.matchAll(/<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/g)].filter((m) => !/text-left hover:underline|class="hover:underline"/.test(m[2])).map((m) => text(m[3]));
    c.ok("it renders the six rows", lis.length === 6, String(lis.length));
    c.ok("a row with its own action keeps it (Request update)", buttonsIn(lis[0]).includes("Request update"), buttonsIn(lis[0]).join("|"));
    c.ok("a row with nobody on it: Assign", buttonsIn(lis[1]).includes("Assign"));
    c.ok("an escalation that opens its task in place: Decide (opens the panel, data-row-open)", /<button[^>]*data-row-open[^>]*>Decide<\/button>/.test(lis[2]), lis[2].slice(-300));
    c.ok("a record with only its page: Open, to that exact page", /<a[^>]*href="\/projects\/p4"[^>]*data-row-open[^>]*>Open<\/a>|<a[^>]*data-row-open[^>]*href="\/projects\/p4"[^>]*>Open<\/a>/.test(lis[3]), lis[3].slice(-300));
    c.ok("a row that opens a panel: Open", /<button[^>]*data-row-open[^>]*>Open<\/button>/.test(lis[4]));
    c.ok("a plain fact (time off): no button", buttonsIn(lis[5]).length === 0, buttonsIn(lis[5]).join("|"));
    const ro = listHtml(true);
    const roLis = [...ro.slice(ro.indexOf("data-panel-list")).matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) => m[1]);
    c.ok("'view as' (read-only): Assign hides, Open to the row's page takes its place", !buttonsIn(roLis[1]).includes("Assign") && /data-row-open[^>]*>Open<\/a>/.test(roLis[1]));

    // =====================================================================
    c.head("§4 · The photographer's Your tasks: a labelled Done on every row");
    // =====================================================================
    const { YourTasksCard } = await import("@/components/shoot/YourTasksCard");
    const ptasks = [
      { id: "cfixptask00000000001", title: "Call the agent about the gate code", summary: "Kyle mentioned you. Open the note: /shoot/note/cfixnote000000000001", taskType: "mention", priority: "MEDIUM", dueAtISO: iso(2), overdue: false, projectId: PROJ.shoot, street: "9 Early Rd" },
      { id: "cfixptask00000000002", title: "Re-upload the drone set", summary: null, taskType: "todo", priority: "HIGH", dueAtISO: iso(-2), overdue: true, projectId: null, street: null },
    ];
    const yt = ssr(createElement(YourTasksCard, { tasks: ptasks }));
    const ytRows = [...yt.matchAll(/<li[^>]*data-your-task="([^"]+)"[^>]*>([\s\S]*?)<\/li>/g)];
    c.ok("each row has a labelled Done button, 44px tall", ytRows.length === 2 && ytRows.every((m) => new RegExp(`<button[^>]*data-task-done="${m[1]}"[^>]*class="[^"]*min-h-11[^"]*"[^>]*>[\\s\\S]*?Done</button>`).test(m[2])), yt.slice(0, 300));
    c.ok("…and the mention still opens its note", yt.includes('href="/shoot/note/cfixnote000000000001"'));
    const ytRo = ssr(createElement(YourTasksCard, { tasks: ptasks, readOnly: true }));
    c.ok("a 'view as' preview shows the rows without Done (look, don't touch)", !ytRo.includes("data-task-done") && ytRo.includes("Re-upload the drone set"));
    c.ok("a refused Done un-strikes the row and says why (source: the server's message is read)", /const r = await setSmartTaskStatus\(id, "COMPLETED"\);\s*if \(r && !r\.ok\) undo\(r\.message\);/.test(read("src/components/shoot/YourTasksCard.tsx")));

    // =====================================================================
    c.head("§5 · The Tasks board's compact rows: a button beyond the title");
    // =====================================================================
    const { TaskCard } = await import("@/components/queue/TaskCard");
    const base: QueueTask = { id: "cfixqtask00000000001", title: "Order lockbox keys", taskType: "todo", status: "OPEN", priority: "MEDIUM", dueAt: iso(4), createdAt: iso(-24), reasonCreated: null, summary: null, description: null, deliverables: [], source: "manual", sourceDetail: null, assignedKey: "kyle", projectId: null, clientId: null, clientName: null, contactName: null, propertyAddress: null };
    const qtasks: QueueTask[] = [
      base,
      { ...base, id: "cfixqtask00000000002", title: "New texter: reply to (215) 555-0188", taskType: "lead", source: "openphone", sourceDetail: "phone:2155550188", assignedKey: null },
      { ...base, id: "cfixqtask00000000003", title: "Reply to Riley Sample", taskType: "client_reply", source: "openphone", sourceDetail: "phone:2155550101" },
    ];
    for (const t of qtasks) {
      const h = ssr(createElement(TaskCard, { task: t, compact: true, assignees: roster2 }));
      const art = /<article[^>]*data-task-row[^>]*>([\s\S]*)<\/article>/.exec(h)?.[1] ?? "";
      const btns = [...art.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].filter((m) => !/aria-haspopup="dialog" onClick|w-full rounded-md text-left/.test(m[1])).map((m) => text(m[2])).filter(Boolean);
      c.ok(`${t.taskType}: a button beyond the title (${btns.join(" | ") || "none"})`, !h.startsWith("RENDER FAILED") && btns.length >= 1 && (t.taskType !== "lead" || btns.includes("Disregard")), h.startsWith("RENDER FAILED") ? h : "");
    }

    // =====================================================================
    c.head("§6 · The owner dashboard's server pieces (source)");
    // =====================================================================
    const home = read("src/components/owner/OwnerHome.tsx");
    const od = read("src/lib/ownerDashboard.ts");
    c.ok("a task that can't be read as a delegation opens /tasks?task=<id>, never the dashboard ('/')", /if \(!v\) return <Link href=\{`\/tasks\?task=\$\{encodeURIComponent\(taskId\)\}`\}/.test(home) && !/if \(!v\) return <Link href="\/"/.test(home));
    c.ok("an escalation with no record behind it links its task, not '/'", /href: d\.sourceHref \?\? `\/tasks\?task=\$\{d\.taskId\}`/.test(od) && !/href: d\.sourceHref \?\? "\/"/.test(od));
    c.ok("Team workload: each assignment row opens its own task", /open: \{ kind: "task" as const, task: \{ \.\.\.d, resurface: resurfaceOf\(d, now\) \} \}/.test(home));
    c.ok("Bottlenecks 'View all': a row whose only button is its task opens that task in place (Decide)", /const panels = await taskPanels\(/.test(home) && /openLabel: open \? b\.actions\.find\(\(a\) => a\.kind === "task"\)\?\.label/.test(home));

    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(" | "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
