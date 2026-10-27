// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Kyle's dashboard, Oct 27 2026 (KYLE-UI).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-kyle-dashboard.ts
//
// Jordan: "Make the dashboard look more like what the example shows. Clicking
// Review and Deliver should open a full job status page like the shoots page
// ... Clicking Chase Cubicasa or Check floorplan or whatever it is, it should
// open up the quick action menu on the right side with more info, and then
// allow Kyle to close the task, like mark floorplan delivered. ... When a
// client asks for changes, that quick menu should show what the change request
// is and allow action items for it. ... If someone says thank you - no reply
// is needed. He should also be able to mark it as handled. Today's shoots,
// even if they started, should not be collapsed."
//
//   §1 the pure rules: a thank-you (signature and quoted reply stripped) or a
//      short closer needs no reply; a question or a number still does.
//   §2 the desk, rendered from a fixture shaped like the live desk (fictional
//      names): the mockup's order, three rows a card then View all, Review &
//      Deliver opening /jobs?f=deliver, the thank-you fold (not counted),
//      "Other conversations are up to date", every shoot of today in time order
//      (started ones too, with Open the shoot), "N waiting on others", and a
//      labelled button on every row.
//   §3 the right-side panel: Mark floor plan delivered + Email CubiCasa + the
//      job's #deliverable-floorplan section; the client's change request in
//      their words with four decisions; a task's Mark done / Not needed / New
//      date / Waiting on / Delegate / Escalate to Jordan; an email in the hub's
//      own reply box; Mark handled; Text the photographer; read-only preview.
//   §4 the Shoots page's Review & deliver filter and its piece chips.
//   §5 the actions on a disposable PGlite: Mark floor plan delivered records
//      who and when, closes the CubiCasa chase and leaves Kyle's list; a second
//      press says it is already done; the owner's "view as" is refused; a task
//      closes with its note; a change decision is recorded with its next step.
//
// ISOLATION: PGlite via the shared harness; nothing leaves (fetch fenced), no
// message is sent, production is never opened.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { AssetLine, DeskAction, DeskItem, DeskPanel, OfficeDesk as Desk, PrepVisit } from "../../src/lib/officeDesk";
import type { ShootRow } from "../../src/lib/jobsBoard";

installNextStubs();
const fence = fenceFetch();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {}, back() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
  navigation.usePathname = () => "/";
}

const H = 3_600_000;
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;|&ldquo;|&rdquo;|“|”/g, '"').replace(/\s+/g, " ").trim();

/** One card's HTML (the <section> carrying data-desk-section or data-desk-card). */
function card(html: string, attr: string): string {
  const at = html.indexOf(attr);
  if (at < 0) return "";
  return html.slice(html.lastIndexOf("<section", at), html.indexOf("</section>", at));
}
type Row = { id: string; attrs: string; html: string; state: string | null; button: string | null };
function rowsOf(cardHtml: string): Row[] {
  return [...cardHtml.matchAll(/<li data-desk-item="([^"]+)"([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => {
    const id = m[1];
    const b = new RegExp(`<button[^>]*data-open-panel="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</button>`).exec(m[3]);
    return { id, attrs: m[2], html: m[3], state: /data-state="([^"]+)"/.exec(m[2])?.[1] ?? null, button: b ? text(b[1]) : null };
  });
}

// ---- the fixture: shaped like the live desk (scratchpad/audit/kyle-desk.json), every name made up ----

const T = Date.parse("2026-10-27T15:00:00.000Z"); // 11 AM ET
const iso = (h: number) => new Date(T + h * H).toISOString();
const P = { chase: "cfixproj0000000000001", rev: "cfixproj0000000000002", approve: "cfixproj0000000000003", tour: "cfixproj0000000000004", wait: "cfixproj0000000000005", shoot: "cfixproj0000000000006" };
const JOB_REV = "cfixjob00000000000002";
const item = (o: Partial<DeskItem> & Pick<DeskItem, "id" | "section" | "title">): DeskItem => ({ state: "now", line: "", reason: "Why it is on the list.", client: null, who: null, dueISO: null, dueWords: null, late: false, rank: 2, primary: null, actions: [], href: null, panel: { kind: "task", lines: [] }, sinceISO: null, ...o });
const asset = (o: Partial<AssetLine> & Pick<AssetLine, "id" | "kind" | "label">): AssetLine => ({ status: "", tone: "waiting", late: false, dueISO: null, who: null, note: null, action: null, ...o });
const jobPanel = (projectId: string, street: string, assets: AssetLine[]): DeskPanel => ({ kind: "job", projectId, street, client: "Sam Sample", assets, findings: [], aryeoUrl: null });
const link = (label: string, href: string): DeskAction => ({ kind: "link", label, href });
const task = (taskId: string, canWait = true): DeskAction => ({ kind: "task", taskId, allowNewDate: true, canWait });
const plan = (projectId: string, street: string, label: string, category: "Floor plan" | "3D tour" = "Floor plan"): Extract<DeskAction, { kind: "mark-delivered" }> => ({
  kind: "mark-delivered", projectId, category, street, maker: category === "Floor plan" ? "CubiCasa" : "Matterport", label,
  why: category === "Floor plan" ? "The floor plan is not on the Aryeo listing yet. Ask CubiCasa for it, or mark it delivered if it is already on the listing." : "Matterport has it ready. Check it is on the listing and right, then mark it delivered.",
  history: ["Task opened: Chase CubiCasa floor plan: 30 Example Dr", "Due Oct 27, 9:00 AM"], anchor: category === "Floor plan" ? "deliverable-floorplan" : "deliverable-matterport_3d",
});
const reply = (family: "phone" | "email", key: string, clientId: string | null, commLogId: string | null = null): Extract<DeskAction, { kind: "reply" }> =>
  ({ kind: "reply", threadKey: `${family}:${key}`, family, clientId, groupKey: key, phone: family === "phone" ? key : null, href: `/communications?thread=${encodeURIComponent(`${family}:${key}`)}`, taskId: null, commLogId });
const handled = (r: Extract<DeskAction, { kind: "reply" }>): DeskAction => ({ kind: "handled", threadKey: r.threadKey, family: r.family, clientId: r.clientId, groupKey: r.groupKey });
const followUp = (clientId: string | null, title: string): DeskAction => ({ kind: "follow-up", clientId, projectId: null, title });
const thread = (client: string, family: "phone" | "email", words: string): DeskPanel => ({ kind: "thread", client, family, messages: [{ atISO: iso(-2), text: words }], holding: null, revisionNote: null, alsoAsked: [] });
const visit = (o: Partial<PrepVisit> & Pick<PrepVisit, "apptId" | "street" | "timeISO">): PrepVisit => ({
  projectId: P.shoot, client: "Sam Sample", dayKey: "2026-10-27", endISO: null, over: false, photographer: "Harrison Shoots", photographerId: "cfixteam000000000001", photographerPhone: "2155550177",
  confirmation: { state: "sent", words: "Confirmed", taskId: null }, access: { lockbox: "4321", access: null, presence: null, contactName: null, contactPhone: null },
  services: ["Photos"], servicesFrom: "visit", requests: [], instructions: [], earlier: [], revisionsAfterDelivery: [], conflicts: [], gaps: [],
  brief: { state: "unknown", words: "Brief acknowledged", why: null, href: null, sent: true }, otherVisits: [], ...o,
});
const shootRow = (id: string, v: PrepVisit, day: "today" | "next", state: DeskItem["state"], chip: DeskItem["chip"], primary: DeskItem["primary"]): DeskItem =>
  item({ id, section: "shoots", day, state, title: v.street, line: chip?.label ?? "", client: v.client, dueISO: v.timeISO, primary, actions: primary ? [primary.action] : [], href: `/projects/${v.projectId}`, panel: { kind: "visit", visit: v }, chip });

function fixtureDesk(readOnly = false): Desk {
  const md1 = plan(P.chase, "30 Example Dr", "Chase CubiCasa");
  const mdTour = plan(P.tour, "44 Demo Rd", "Check tour", "3D tour");
  const rev: DeskAction = { kind: "revision-decide", jobId: JOB_REV, projectId: P.rev, clientId: "cfixclient0000000001", street: "850 Sample Ln", asks: [{ id: "cfixask0000000000009", text: "Please brighten the kitchen photo and take the trash can out of the driveway shot", askedAtISO: iso(-20) }], taskNote: null, decided: null };
  const rEmail = reply("email", "client:cfixclient0000000001", "cfixclient0000000001", "cfixcommlog000000001");
  const rText = reply("phone", "2155550101", "cfixclient0000000002");
  const rText2 = reply("phone", "2155550102", "cfixclient0000000003");
  const rThanks = reply("phone", "2155550199", "cfixclient0000000004");
  const started = visit({ apptId: "cfixappt000000000001", street: "9 Early Rd", timeISO: iso(-2), endISO: iso(4), over: true, confirmation: { state: "na", words: "On site now", taskId: null } });
  const noon = visit({ apptId: "cfixappt000000000002", street: "77 Noon St", timeISO: iso(1), photographer: "Jordan Spackman", photographerPhone: null });
  const late = visit({ apptId: "cfixappt000000000003", street: "15 Late Ave", timeISO: iso(4), confirmation: { state: "open", words: "Not confirmed yet", taskId: "cfixtask000000000031" } });
  const tomorrow = visit({ apptId: "cfixappt000000000004", street: "200 Tomorrow Blvd", timeISO: iso(23), dayKey: "2026-10-28" });
  const openShoot = (v: PrepVisit) => ({ label: "Open the shoot", action: link("Open the job", `/projects/${v.projectId}`) });
  return {
    nowISO: iso(0), dayKey: "2026-10-27", dateWords: "Tuesday, October 27", person: "Kyle Smith",
    people: { creative: "James", owner: "Jordan", creativeKey: "james", ownerKey: "jordan" },
    delegates: [{ key: "james", name: "James Livingston" }, { key: "jordan", name: "Jordan Spackman" }, { key: "dana", name: "Dana Editor" }],
    deliverHref: "/jobs?f=deliver",
    readOnly,
    freshness: [{ key: "aryeo", label: "Aryeo orders", state: "ok", atISO: iso(0), words: "synced 3 min ago" }],
    unavailable: [], urgent: [],
    sections: [
      { key: "deliver", title: "Review & Deliver", empty: "Nothing to review or deliver.", count: 4, quiet: [], unavailable: [], ok: [],
        now: [
          item({ id: `media:${P.chase}`, section: "deliver", group: "media", title: "30 Example Dr", line: "Photos delivered · Floor plan not in yet", client: "Sam Sample", late: true, primary: { label: "Chase CubiCasa", action: md1 }, actions: [md1, link("Open the job", `/projects/${P.chase}`)], href: `/projects/${P.chase}`,
            panel: jobPanel(P.chase, "30 Example Dr", [asset({ id: "photo:1", kind: "photos", label: "Photos", status: "Delivered Oct 25", tone: "done" }), asset({ id: `floorplan:${P.chase}`, kind: "floorplan", label: "Floor plan", status: "Not on the listing yet", who: "CubiCasa", action: md1 })]) }),
          item({ id: `media:${P.rev}`, section: "deliver", group: "media", title: "850 Sample Ln", line: 'Client asked for changes: "Please brighten the kitchen photo"', client: "Sam Sample", primary: { label: "Decide", action: rev }, actions: [rev], href: `/projects/${P.rev}`, panel: jobPanel(P.rev, "850 Sample Ln", [asset({ id: "photo:2", kind: "photos", label: "Photos", status: "Client asked for changes", tone: "now", action: rev })]) }),
          item({ id: `media:${P.approve}`, section: "deliver", group: "media", title: "12 Test Ct", line: "Photos ready to approve", primary: { label: "Approve and deliver", action: { kind: "photo-approve", jobId: "cfixjob00000000000003", street: "12 Test Ct" } }, actions: [{ kind: "photo-approve", jobId: "cfixjob00000000000003", street: "12 Test Ct" }], panel: jobPanel(P.approve, "12 Test Ct", []) }),
          item({ id: `media:${P.tour}`, section: "deliver", group: "media", title: "44 Demo Rd", line: "3D tour ready to verify", primary: { label: "Check tour", action: mdTour }, actions: [mdTour], panel: jobPanel(P.tour, "44 Demo Rd", []) }),
        ],
        waiting: [item({ id: `media:${P.wait}`, section: "deliver", group: "media", state: "waiting", title: "5 Waiting Way", line: "Waiting on AutoHDR", actions: [link("Open the job", `/projects/${P.wait}`)], href: `/projects/${P.wait}`, panel: jobPanel(P.wait, "5 Waiting Way", []) })] },
      { key: "comms", title: "Client Communications", empty: "Everyone has an answer.", count: 4, quiet: [], unavailable: [], waiting: [],
        now: [
          item({ id: "reply:email:client:cfixclient0000000001", section: "comms", title: "Morgan Sample", channel: "Email", elapsed: "2 business hours", initials: "MS", line: "Can you send the invoice for 30 Example Dr?", primary: { label: "Reply", action: rEmail }, actions: [rEmail, handled(rEmail), followUp("cfixclient0000000001", "Follow up with Morgan Sample")], panel: thread("Morgan Sample", "email", "Can you send the invoice for 30 Example Dr?") }),
          item({ id: "reply:phone:2155550101", section: "comms", title: "Riley Sample", channel: "Text", elapsed: "1 business hour", initials: "RS", line: "When will the photos be ready?", primary: { label: "Reply", action: rText }, actions: [rText, handled(rText), followUp("cfixclient0000000002", "Follow up with Riley Sample")], panel: thread("Riley Sample", "phone", "When will the photos be ready?") }),
          item({ id: "lead:cfixlead000000000001", section: "comms", title: "New texter: reply to (215) 555-0188", line: "Hi, do you shoot in Malvern?", primary: { label: "Handle lead", action: task("cfixlead000000000001", false) }, actions: [task("cfixlead000000000001", false)] }),
          item({ id: "reply:phone:2155550102", section: "comms", title: "Casey Sample", channel: "Text", initials: "CS", line: "Can we move Thursday to 2?", primary: { label: "Reply", action: rText2 }, actions: [rText2, handled(rText2)], panel: thread("Casey Sample", "phone", "Can we move Thursday to 2?") }),
        ],
        ok: [item({ id: "reply:phone:2155550199", section: "comms", state: "ok", title: "Jamie Sample", channel: "Text", initials: "JS", line: '"Thank you so much!" · no reply needed', primary: { label: "Mark handled", action: handled(rThanks) }, actions: [handled(rThanks), rThanks], panel: thread("Jamie Sample", "phone", "Thank you so much!") })] },
      { key: "shoots", title: "Today's Shoots", empty: "No shoots today.", count: 1, quiet: [], unavailable: [], waiting: [],
        now: [shootRow("visit:cfixappt000000000003", late, "today", "now", { label: "Needs confirmation", tone: "warn" }, { label: "Confirm", action: { kind: "confirm", taskId: "cfixtask000000000031" } })],
        ok: [
          // Out of time order on purpose: the card sorts by time.
          shootRow("visit:cfixappt000000000002", noon, "today", "ok", { label: "Ready", tone: "ok" }, openShoot(noon)),
          shootRow("visit:cfixappt000000000001", started, "today", "ok", { label: "On site", tone: "muted" }, openShoot(started)),
          shootRow("visit:cfixappt000000000004", tomorrow, "next", "ok", { label: "Ready", tone: "ok" }, openShoot(tomorrow)),
        ] },
      { key: "followups", title: "Requests & Follow-Ups", empty: "Nothing due today.", count: 5, quiet: [], unavailable: [], ok: [],
        now: [
          item({ id: "task:cfixtask000000000001", section: "followups", tag: "production", title: "Chase CubiCasa floor plan: 30 Example Dr", line: "Overdue · due 9:00 AM", late: true, primary: { label: "Chase CubiCasa", action: md1 }, actions: [md1, task("cfixtask000000000001")], panel: { kind: "task", lines: [{ label: "Task", value: "Chase CubiCasa floor plan: 30 Example Dr" }] } }),
          item({ id: "task:cfixtask000000000002", section: "followups", tag: "task", title: "Apply $750 credit for 12 Oak St", line: "Due today", primary: { label: "Mark done", action: task("cfixtask000000000002") }, actions: [task("cfixtask000000000002")], panel: { kind: "task", lines: [{ label: "Task", value: "Apply $750 credit for 12 Oak St" }] } }),
          item({ id: "ask:cfixask0000000000001", section: "followups", tag: "request", title: "1 Example Way · Special request", line: "Twilight shots, please", primary: { label: "Check request", action: { kind: "ask", askId: "cfixask0000000000001", askKind: "SPECIAL_REQUEST" } }, actions: [{ kind: "ask", askId: "cfixask0000000000001", askKind: "SPECIAL_REQUEST" }, link("Open the job", `/projects/${P.approve}`)] }),
          item({ id: "task:cfixtask000000000003", section: "followups", tag: "task", title: "Call the title company", line: "Due today", primary: { label: "Mark done", action: task("cfixtask000000000003") }, actions: [task("cfixtask000000000003")] }),
          item({ id: "rev:cfixrev0000000000001", section: "followups", tag: "revision", title: "Shorter intro for 40 Example Ct", line: "Yours to fix · Open the photos", primary: { label: "Open photos", action: link("Open photos", `/projects/${P.rev}`) }, actions: [link("Open photos", `/projects/${P.rev}`)] }),
        ],
        waiting: [
          item({ id: "task:cfixtask000000000004", section: "followups", tag: "task", state: "waiting", title: "Music pick for 9 Early Rd", line: "Waiting on James · Follow up at 2:00 PM", primary: { label: "Follow up", action: task("cfixtask000000000004") }, actions: [task("cfixtask000000000004")] }),
          item({ id: "task:cfixtask000000000005", section: "followups", tag: "task", state: "waiting", title: "Invoice question for 12 Test Ct", line: "Waiting on Jordan · Follow up tomorrow", primary: { label: "Follow up", action: task("cfixtask000000000005") }, actions: [task("cfixtask000000000005")] }),
        ] },
    ],
    checks: {
      dayKey: "2026-10-27",
      groups: [
        { key: "morning", label: "Morning review", done: false, completedAtISO: null, lines: [{ key: "am_messages", label: "Review client messages", manual: true, auto: false, autoWords: "4 conversations waiting on you", tick: null, done: false }] },
        { key: "midday", label: "Midday review", done: false, completedAtISO: null, lines: [{ key: "md_new", label: "Review new messages and returned media", manual: true, auto: null, autoWords: "", tick: null, done: false }] },
        { key: "eod", label: "End-of-day review", done: false, completedAtISO: null, lines: [{ key: "eod_messages", label: "Client messages reviewed", manual: true, auto: false, autoWords: "", tick: null, done: false }] },
      ],
      finished: null, newSinceFinish: 0,
      summary: { activity: [{ atISO: iso(-1), what: "Task done", detail: "Confirm 77 Noon St" }], completed: [{ what: "Tasks done", count: 1, examples: ["Confirm 77 Noon St"] }], completedTotal: 1, pending: [], blockers: [], tomorrow: { dayWords: "Wednesday", lines: ["1 shoot"] } },
    },
    backlog: { count: 2, href: "/tasks?mine=1" },
    nextDay: { dayKey: "2026-10-28", dayName: "Wednesday", visits: 1, appointments: { confirmed: 1, pending: 0 }, access: { recorded: 1, missing: 0 }, instructions: { ready: 1, review: 0 }, missing: [] },
    briefsPending: [],
    commsFresh: true,
  } as Desk;
}

async function main() {
  // The disposable database first: DATABASE_URL points at it before any module that could read it loads.
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 6127), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-kyle-dashboard" } });
  const c = makeChecker();
  try {
    const desk = await import("@/lib/officeDesk");
    const { OfficeDesk } = await import("@/components/desk/OfficeDesk");
    const { ShootsList } = await import("@/components/jobs/ShootsList");
    const jobs = await import("@/lib/jobsBoard");

    // =====================================================================
    c.head("§1 · A thank-you needs no reply; a question or a number does");
    // =====================================================================
    const sig = "Thank you so much!\n\nDana Sample\nDirector of Sales\nSample Realty Group\n(610) 555-0100";
    c.ok("a thank-you with a signature (phone number and all): no reply needed", desk.needsNoReply([{ text: sig }], "Dana Sample") === true, desk.ownWords(sig, "Dana Sample"));
    c.ok("…its own words are just the thank-you", desk.ownWords(sig, "Dana Sample") === "Thank you so much!");
    c.ok("a thank-you signed with the first name after a sentence: no reply needed", desk.needsNoReply([{ text: "Thanks so much! Dana" }], "Dana Sample") === true);
    c.ok("a thank-you over a quoted earlier email: no reply needed", desk.needsNoReply([{ text: "Thanks!\n\nOn Mon, Oct 26, 2026 at 4:10 PM Kyle Smith wrote:\n> Can you confirm 10 AM on the 29th?" }], "Dana Sample") === true);
    c.ok("'It went well' and 'That looks great!': no reply needed", desk.needsNoReply([{ text: "It went well" }], null) && desk.needsNoReply([{ text: "That looks great!" }], null));
    c.ok("a thank-you that also asks something still needs a reply", desk.needsNoReply([{ text: "Thanks! Can you send the floor plan?" }], null) === false);
    c.ok("a thank-you carrying a number (a code, a time) still needs a reply", desk.needsNoReply([{ text: "Thanks, the code is 4321" }], null) === false);
    c.ok("a thread with a thank-you AND a real message still needs a reply", desk.needsNoReply([{ text: "Thank you!" }, { text: "Also the tenant will be home Friday afternoon so please come in the morning instead" }], null) === false);
    c.ok("an empty thread is not 'no reply needed'", desk.needsNoReply([], null) === false);

    // =====================================================================
    c.head("§2 · The desk, rendered: the mockup's layout, three rows a card, a labelled button on every row");
    // =====================================================================
    const f = fixtureDesk();
    const html = ssr(createElement(OfficeDesk, { desk: f }));
    const flat = text(html);
    c.ok("it renders", !html.startsWith("RENDER FAILED") && html.includes("data-office-desk"), html.slice(0, 200));
    c.ok("the mockup's order: Daily checks, Review & Deliver | Client Communications, Today's Shoots | Requests & Follow-Ups, Next business day, End-of-day closeout | Completed today",
      /Daily checks[\s\S]*Review & Deliver[\s\S]*Client Communications[\s\S]*Today's Shoots[\s\S]*Requests & Follow-Ups[\s\S]*Next business day · Wednesday[\s\S]*End-of-day closeout[\s\S]*Completed today/.test(flat));
    c.ok("two columns on a desktop, equal-height cards (items-stretch), one column on a phone", /class="grid items-stretch gap-4 lg:grid-cols-2" data-desk-grid/.test(html));

    const deliver = card(html, 'data-desk-section="deliver"');
    const dRows = rowsOf(deliver);
    const dNow = dRows.filter((r) => r.state !== "waiting");
    c.ok("Review & Deliver: three rows, then 'View all 4'", dNow.length === 3 && text(deliver).includes("View all 4"), dNow.map((r) => r.id).join());
    c.ok("…its chevron opens the full status page (/jobs?f=deliver)", /<a [^>]*href="\/jobs\?f=deliver"[^>]*aria-label="Open Review &amp; Deliver"|aria-label="Open Review &amp; Deliver"[^>]*href="\/jobs\?f=deliver"/.test(deliver));
    const viewAllTag = /<a [^>]*data-view-deliveries[^>]*>/.exec(deliver)?.[0] ?? "";
    c.ok("…and so does 'View all deliveries'", viewAllTag.includes('href="/jobs?f=deliver"') && text(deliver).includes("View all deliveries"), viewAllTag);
    c.ok("…the jobs awaiting files are folded, one press away", deliver.includes("data-awaiting") && text(deliver).includes("1 awaiting files") && dRows.some((r) => r.state === "waiting" && r.id === `media:${P.wait}`));
    c.ok("…the floor plan row's button says what it does (Chase CubiCasa), the change request's says Decide", dNow.find((r) => r.id === `media:${P.chase}`)?.button === "Chase CubiCasa" && dNow.find((r) => r.id === `media:${P.rev}`)?.button === "Decide");

    const comms = card(html, 'data-desk-section="comms"');
    const cRows = rowsOf(comms);
    c.ok("Client Communications: three rows, then 'View all 4'", cRows.filter((r) => r.state !== "ok").length === 3 && text(comms).includes("View all 4"));
    c.ok("…the thank-you is NOT counted (4 clients need a reply) and sits in its own fold with Mark handled", /data-desk-section="comms" data-count="4"/.test(html) && text(comms).includes("4 clients need a reply") && comms.includes('data-no-reply-needed="1"') && text(comms).includes("1 thank-you or closers: no reply needed") && cRows.find((r) => r.state === "ok")?.button === "Mark handled");
    c.ok("…every reply row offers Mark handled and Create follow-up beside Reply", cRows.filter((r) => r.id.startsWith("reply:") && r.state !== "ok" && r.id !== "reply:phone:2155550102").every((r) => r.button === "Reply" && r.html.includes("data-mark-handled-row") && r.html.includes("data-create-follow-up")));
    c.ok("…'Other conversations are up to date' (the mail sync is fresh)", comms.includes("data-up-to-date") && text(comms).includes("Other conversations are up to date."));
    const stale = ssr(createElement(OfficeDesk, { desk: { ...f, commsFresh: false } }));
    c.ok("…and not when the mail sync is stale", !card(stale, 'data-desk-section="comms"').includes("data-up-to-date"));

    const shoots = card(html, 'data-desk-section="shoots"');
    const sRows = rowsOf(shoots);
    c.ok("Today's Shoots: every shoot of today, in time order, the started one included (never folded)", sRows.map((r) => r.id).join() === "visit:cfixappt000000000001,visit:cfixappt000000000002,visit:cfixappt000000000003" && !shoots.includes("data-past") && !text(shoots).includes("Every shoot today has started"), sRows.map((r) => r.id).join());
    const startedRow = sRows.find((r) => r.id === "visit:cfixappt000000000001");
    c.ok("…the started shoot keeps its row: data-started, 'On site', Open the shoot", !!startedRow && startedRow.attrs.includes('data-started="true"') && text(startedRow.html).includes("On site") && startedRow.button === "Open the shoot");
    c.ok("…each row: the time, the address, the photographer, a chip, one button", sRows.every((r) => /\d{1,2}:\d{2} [AP]M/.test(text(r.html)) && r.html.includes("data-chip") && !!r.button) && text(shoots).includes("9 Early Rd") && text(shoots).includes("Harrison Shoots"));
    c.ok("…the Today / Next business day tabs", shoots.includes('data-day="today"') && shoots.includes('data-day="next"'));
    const nextHtml = card(ssr(createElement(OfficeDesk, { desk: f, initialDay: "next" })), 'data-desk-section="shoots"');
    c.ok("…the next business day's tab lists its own shoots", rowsOf(nextHtml).map((r) => r.id).join() === "visit:cfixappt000000000004");

    const fu = card(html, 'data-desk-section="followups"');
    const fRows = rowsOf(fu);
    c.ok("Requests & Follow-Ups: 'N due', three rows, then 'View all 5'", fRows.filter((r) => r.state === "now").length === 3 && text(fu).includes("View all 5") && text(fu).includes("5 follow-ups due, 1 overdue"));
    c.ok("…'2 waiting on others' folded below", fu.includes("data-waiting") && text(fu).includes("2 waiting on others") && fRows.filter((r) => r.state === "waiting").length === 2);
    c.ok("…the CubiCasa chase row says Chase CubiCasa (not a bare Handle)", fRows.find((r) => r.id === "task:cfixtask000000000001")?.button === "Chase CubiCasa");

    // Every row on the page has a labelled button that opens its quick actions (or, for an awaiting-files row, the row itself opens them).
    const every = [...dRows, ...cRows, ...sRows, ...fRows];
    const unlabelled = every.filter((r) => !(r.button && r.button.length > 1 && r.button !== "Handle") && !(r.state === "waiting" && r.html.includes("<button")));
    c.ok("every row has a labelled button (resolve, respond, delegate or open), none a bare 'Handle'", every.length >= 14 && unlabelled.length === 0, unlabelled.map((r) => r.id).join());
    // The full page (all rows) also renders "View all" lists with the same labels.
    const fullRows = f.sections.flatMap((s) => [...s.now, ...s.waiting, ...s.ok]);
    c.ok("…and in the data every row has a primary or opens actions", fullRows.every((i) => (i.primary && i.primary.label && i.primary.label !== "Handle") || i.actions.length > 0));

    // =====================================================================
    c.head("§3 · The right-side quick actions");
    // =====================================================================
    const panel = (id: string, d: Desk = f) => {
      const h = ssr(createElement(OfficeDesk, { desk: d, initialOpen: id }));
      const at = h.indexOf("data-side-panel=");
      return at < 0 ? "" : h.slice(h.lastIndexOf("<div", at));
    };
    const pPlan = panel(`media:${P.chase}`);
    c.ok("a right-side sheet, full screen on a phone", /role="dialog"[^>]*class="relative flex h-full w-full max-w-xl/.test(pPlan) && pPlan.includes("justify-end"));
    c.ok("Chase CubiCasa opens the floor plan's own panel: why, its history, a note", pPlan.includes('data-control="mark-delivered"') && text(pPlan).includes("The floor plan is not on the Aryeo listing yet") && pPlan.includes("data-history") && text(pPlan).includes("Task opened: Chase CubiCasa floor plan"));
    c.ok("…'Mark floor plan delivered' (records who and when, closes the chase)", /data-mark-delivered[^>]*>[\s\S]*?Mark floor plan delivered/.test(pPlan) && text(pPlan).includes("Records you and the time, and closes the CubiCasa chase."));
    c.ok("…'Email CubiCasa' opens Kyle's own mail with the job filled in (nothing sent from the hub)", /<a href="mailto:\?subject=Floor%20plan%20for%2030%20Example%20Dr&amp;body=[^"]+"[^>]*data-email-vendor/.test(pPlan) && text(pPlan).includes("Email CubiCasa"));
    c.ok("…'Open the job's floor plan section' goes to /projects/<id>#deliverable-floorplan", pPlan.includes(`href="/projects/${P.chase}#deliverable-floorplan"`) && text(pPlan).includes("Open the job's floor plan section"));
    c.ok("…and Delegate / Escalate to Jordan", pPlan.includes('data-control="hand-on"') && pPlan.includes("data-delegate") && text(pPlan).includes("Escalate to Jordan"));
    const pTour = panel(`media:${P.tour}`);
    c.ok("a 3D tour gets the same: Mark 3D tour delivered, Email Matterport, its own section", text(pTour).includes("Mark 3D tour delivered") && text(pTour).includes("Email Matterport") && pTour.includes(`#deliverable-matterport_3d`));
    const pChase = panel("task:cfixtask000000000001");
    c.ok("the chase in Requests & Follow-Ups opens the same Mark floor plan delivered, plus the task's own closes", pChase.includes('data-control="mark-delivered"') && pChase.includes('data-control="task-resolve"'));

    const pRev = panel(`media:${P.rev}`);
    c.ok("a client's change request: their exact words", pRev.includes("data-client-words") && text(pRev).includes('"Please brighten the kitchen photo and take the trash can out of the driveway shot"'));
    c.ok("…four decisions: photo editor (AutoHDR fix), fix it myself, no change needed, ask the client", ["editor", "self", "none", "ask"].every((k) => pRev.includes(`data-choice="${k}"`)) && ["Send to the photo editor (AutoHDR fix)", "Fix it myself", "No change needed", "Ask the client"].every((w) => text(pRev).includes(w)));
    c.ok("…a note for the fix, Save decision, and Open the photos (the holding section)", text(pRev).includes("Note the fix") && text(pRev).includes("Save decision") && pRev.includes(`href="/ops/photo-delivery/${JOB_REV}#pd-holding-h"`));
    const decided = fixtureDesk();
    const dItem = decided.sections[0].now[1];
    const dAct = { ...(dItem.actions[0] as Extract<DeskAction, { kind: "revision-decide" }>), decided: { choice: "editor" as const, note: "AutoHDR to brighten the kitchen", by: "Kyle Smith", at: iso(-1) } };
    dItem.actions = [dAct]; dItem.primary = { label: desk.actionLabel(dAct), action: dAct };
    const pDecided = panel(`media:${P.rev}`, decided);
    c.ok("…once decided, the panel says who decided what, and the row's button is the next step (Send the fix)", pDecided.includes('data-decided="editor"') && text(pDecided).includes("Decided by Kyle: Send to the photo editor (AutoHDR fix). AutoHDR to brighten the kitchen") && desk.actionLabel(dAct) === "Send the fix");

    const pTask = panel("task:cfixtask000000000002");
    c.ok("a task: Mark done (with a note), Not needed, a new date", pTask.includes('data-control="task-resolve"') && pTask.includes("data-task-done") && text(pTask).includes("Mark done") && text(pTask).includes("Not needed") && pTask.includes("data-snooze") && text(pTask).includes("New date") && pTask.includes('value="2026-10-28"'));
    c.ok("…Waiting on (James for a creative question, Jordan for a business one)", pTask.includes('data-control="wait"') && text(pTask).includes("James: a creative question") && text(pTask).includes("Jordan: a business or policy question"));
    c.ok("…Delegate to James, Jordan or an editor, and Escalate to Jordan", pTask.includes("data-delegate") && ["James Livingston", "Jordan Spackman", "Dana Editor"].every((n) => pTask.includes(`>${n}</option>`)) && pTask.includes("data-escalate") && text(pTask).includes("Escalate to Jordan"));

    const pEmail = panel("reply:email:client:cfixclient0000000001");
    c.ok("an email: the hub's own email reply box, open and ready (no trip to Messages)", pEmail.includes('data-control="email-reply"') && pEmail.includes("data-email-reply"));
    c.ok("…plus Mark handled, Create follow-up and Open in Messages", pEmail.includes('data-control="handled"') && text(pEmail).includes("Mark handled: no reply needed") && text(pEmail).includes("Create follow-up") && text(pEmail).includes("Open in Messages"));
    const pText = panel("reply:phone:2155550101");
    c.ok("a text: the reply engine's draft box (Text back)", pText.includes('data-control="draft-reply"') && pText.includes('data-mode="text"'));
    const pThanks = panel("reply:phone:2155550199");
    c.ok("a thank-you: Mark handled comes first (Answered elsewhere beside it)", pThanks.indexOf('data-control="handled"') > -1 && pThanks.indexOf('data-control="handled"') < pThanks.indexOf('data-control="draft-reply"') && text(pThanks).includes("Answered elsewhere"));

    const pShoot = panel("visit:cfixappt000000000001");
    c.ok("a started shoot: the visit's details, Text Harrison, Delegate / Escalate", pShoot.includes('data-panel="visit"') && text(pShoot).includes("Text Harrison") && pShoot.includes('data-control="hand-on"'));
    const pNoPhone = panel("visit:cfixappt000000000002");
    c.ok("…no Text button when the photographer has no phone on file", !text(pNoPhone).includes("Text Jordan"));

    const ro = fixtureDesk(true);
    const pRo = panel(`media:${P.chase}`, ro);
    c.ok("the owner's preview (read-only): the panel's actions are off", text(pRo).includes("Preview: read-only. Actions are off.") && !pRo.includes('data-control="mark-delivered"') && !pRo.includes('data-control="hand-on"'));

    // =====================================================================
    c.head("§4 · The full Review & deliver view: the Shoots page's own filter");
    // =====================================================================
    c.ok("DELIVER_HREF is /jobs?f=deliver, and the desk carries it", desk.DELIVER_HREF === "/jobs?f=deliver");
    c.ok("the Shoots page has a 'Review & deliver' filter (the menu item keeps its name)", jobs.SHOOT_FILTERS.some((x) => x.key === "deliver" && x.label === "Review & deliver"));
    const rows = [
      { projectId: "a", delivered: false, shot: true },
      { projectId: "b", delivered: false, shot: false },
      { projectId: "c", delivered: true, shot: true },
      { projectId: "d", delivered: false },
    ] as unknown as ShootRow[];
    c.ok("…it lists every job shot and not delivered (not the unshot, not the delivered)", jobs.filterShootRows(rows, "deliver").map((r) => r.projectId).join() === "a");
    const sr: ShootRow = { projectId: P.chase, street: "30 Example Dr", client: "Sam Sample", dueISO: null, dueWords: "Today 5 PM", late: false, dueToday: true, photos: { label: "Delivered", tone: "done" }, video: null, requests: { open: 0, photo: 0, video: 0, needsOwner: 0 }, monthly: false, href: `/projects/${P.chase}`, holding: null, delivered: false, dueThisWeek: true, videoSetup: null, shot: true };
    const listHtml = ssr(createElement(ShootsList, { rows: [sr], empty: "none", extras: { [P.chase]: { pieces: [{ label: "Floor plan", stage: { label: "Marked delivered", tone: "done" } }, { label: "3D tour", stage: { label: "Not in yet", tone: "waiting" } }], missing: ["3D tour: not on the listing yet"] } } }));
    c.ok("…each row shows the floor plan and 3D tour states and what is missing, and opens the job", listHtml.includes("data-pieces") && text(listHtml).includes("Floor plan Marked delivered") && text(listHtml).includes("Missing: 3D tour: not on the listing yet") && listHtml.includes(`href="/projects/${P.chase}"`));

    // =====================================================================
    c.head("§5 · The actions (PGlite): Mark floor plan delivered, a task's close, a change decision");
    // =====================================================================
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const actions = await import("@/app/deskActions");
    const { listAssignees } = await import("@/lib/assignees");
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms);
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@oct27-kyle.invalid`, ...extra } });
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true });
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const kyle = await user("Kyle Smith", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Jordan Spackman", jordanTm.email!, "OWNER", jordanTm.id);
    await user("James Livingston", jamesTm.email!, "ADMIN", jamesTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const roster = await listAssignees();
    const build = () => desk.buildOfficeDesk({ now: new Date(), excludeClientIds: [], person: { key: "kyle", teamMemberId: kyleTm.id, name: "Kyle" }, roster });

    const sam = await prisma.client.create({ data: { name: "Sam Sample", phone: "2155550160" } });
    const p = await prisma.project.create({ data: { clientId: sam.id, title: "30 Chase Dr, Town", status: "DELIVERED", shootDate: at(-5 * 24 * H), statusEvidence: JSON.stringify({ expected: ["Photos", "Floor plan"], present: ["Photos"], missing: ["Floor plan"], awaitingSend: [] }) } });
    const fp = await prisma.deliverable.create({ data: { projectId: p.id, type: "FLOORPLAN", status: "PENDING" } });
    const chase = await prisma.smartTask.create({ data: { taskType: "comms_followup", source: "system", status: "OPEN", priority: "HIGH", title: "Chase CubiCasa floor plan: 30 Chase Dr", assignedKey: "kyle", projectId: p.id, clientId: sam.id, dueAt: at(-H), dedupeKey: `vendor-chase-${p.id}-floorplan` } });

    const before = await build();
    const chaseRow = before.sections.find((s) => s.key === "followups")!.now.find((i) => i.id === `task:${chase.id}`);
    c.ok("before: the chase is on Kyle's follow-ups as 'Chase CubiCasa', opening Mark floor plan delivered (and the task's closes)", chaseRow?.primary?.label === "Chase CubiCasa" && chaseRow.primary.action.kind === "mark-delivered" && chaseRow.actions.some((a) => a.kind === "task"), JSON.stringify(chaseRow?.primary));
    c.ok("…Delegate lists the team, never Kyle himself; Escalate goes to the owner", before.delegates.length > 0 && !before.delegates.some((d) => d.key === "kyle") && before.people.ownerKey != null && before.delegates.some((d) => d.key === before.people.ownerKey));

    await signIn(owner, kyle.id);
    const viewAs = await actions.deskMarkDeliveredAction({ projectId: p.id, category: "Floor plan", note: "" });
    c.ok("the owner viewing as Kyle cannot mark it (read-only preview)", viewAs.ok === false && (await prisma.smartTask.findUnique({ where: { id: chase.id } }))?.status === "OPEN", viewAs.message);

    await signIn(kyle);
    const marked = await actions.deskMarkDeliveredAction({ projectId: p.id, category: "Floor plan", note: "Saw it on the listing" });
    const mark = await prisma.appSetting.findUnique({ where: { key: desk.deliveredMarkKey(p.id, "Floor plan") } });
    const markRec = mark ? (JSON.parse(mark.value) as { by: string; at: string; note: string | null }) : null;
    c.ok("Mark floor plan delivered: done, and it says the chase is closed", marked.ok && /Floor plan marked delivered, and its chase is closed/.test(marked.message), marked.message);
    c.ok("…records who and when (and the note)", markRec?.by === "Kyle Smith" && !!markRec.at && Math.abs(Date.parse(markRec.at) - Date.now()) < 60_000 && markRec.note === "Saw it on the listing");
    c.ok("…the CubiCasa chase task is closed (COMPLETED)", (await prisma.smartTask.findUnique({ where: { id: chase.id } }))?.status === "COMPLETED");
    c.ok("…the floor plan deliverable is DONE, with an audit row and a line on the job's activity", (await prisma.deliverable.findUnique({ where: { id: fp.id } }))?.status === "DONE"
      && (await prisma.auditLog.count({ where: { action: "office_marked_delivered", target: p.id } })) === 1
      && (await prisma.activity.count({ where: { projectId: p.id, body: { contains: "Floor plan marked delivered by Kyle Smith" } } })) === 1);
    const again = await actions.deskMarkDeliveredAction({ projectId: p.id, category: "Floor plan", note: "" });
    c.ok("a second press: 'Already marked delivered by Kyle', nothing written twice", again.ok && again.message.startsWith("Already marked delivered by Kyle") && (await prisma.auditLog.count({ where: { action: "office_marked_delivered", target: p.id } })) === 1, again.message);
    const noTour = await actions.deskMarkDeliveredAction({ projectId: p.id, category: "3D tour", note: "" });
    c.ok("a job with no 3D tour on the order cannot have one marked delivered", !noTour.ok && /no 3d tour on the order/i.test(noTour.message), noTour.message);
    const after = await build();
    c.ok("after: the chase has left Kyle's follow-ups", !after.sections.find((s) => s.key === "followups")!.now.some((i) => i.id === `task:${chase.id}`));
    const pieces = await jobs.deliverPieces([p.id], new Date());
    c.ok("the Review & deliver page reads it: Floor plan 'Marked delivered', no longer missing", pieces[p.id]?.pieces.some((x) => x.label === "Floor plan" && x.stage.label === "Marked delivered") === true && !pieces[p.id].missing.some((m) => m.startsWith("Floor plan")), JSON.stringify(pieces[p.id]));
    // The hourly status read puts the deliverable back to PENDING while Aryeo shows no plan; the hand-mark is its own record.
    await prisma.deliverable.update({ where: { id: fp.id }, data: { status: "PENDING" } });
    const reread = await jobs.deliverPieces([p.id], new Date());
    c.ok("…and still after the hourly read resets the deliverable (the hand-mark is its own record)", reread[p.id]?.pieces.some((x) => x.label === "Floor plan" && x.stage.label === "Marked delivered") === true);

    const credit = await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", assignedKey: "kyle", title: "Apply $750 credit for 30 Chase Dr", dueAt: at(-H), projectId: p.id } });
    const closed = await actions.deskCloseTaskAction({ taskId: credit.id, how: "done", note: "Credit applied in Aryeo" });
    const creditAfter = await prisma.smartTask.findUnique({ where: { id: credit.id } });
    c.ok("Mark done with a note: the task closes, the note is kept on it and on the job", closed.ok && creditAfter?.status === "COMPLETED" && (creditAfter.summary ?? "").includes("Credit applied in Aryeo") && (await prisma.activity.count({ where: { projectId: p.id, body: { contains: "Credit applied in Aryeo" } } })) === 1, `${closed.message} · ${creditAfter?.status}`);
    const chore = await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", assignedKey: "kyle", title: "Old chore", dueAt: at(-H) } });
    const notNeeded = await actions.deskCloseTaskAction({ taskId: chore.id, how: "not-needed", note: "" });
    const choreAfter = await prisma.smartTask.findUnique({ where: { id: chore.id } });
    c.ok("Not needed: the task leaves the open list", notNeeded.ok && choreAfter?.status !== "OPEN", `${notNeeded.message} · ${choreAfter?.status}`);
    const closedAgain = await actions.deskCloseTaskAction({ taskId: credit.id, how: "done", note: "" });
    c.ok("…a closed task pressed again: 'Already closed.'", closedAgain.ok && closedAgain.message === "Already closed.");

    const pRevDb = await prisma.project.create({ data: { clientId: sam.id, title: "850 Change Ln, Town", status: "DELIVERED", shootDate: at(-4 * 24 * H) } });
    const job = await prisma.photoJob.create({ data: { projectId: pRevDb.id, stage: "REVISION_REQUESTED" } });
    const short = await actions.deskRevisionDecisionAction({ jobId: job.id, choice: "editor", note: "x" });
    c.ok("a change decision needs a note of the fix", !short.ok && /Note the fix/.test(short.message), short.message);
    const dec = await actions.deskRevisionDecisionAction({ jobId: job.id, choice: "editor", note: "AutoHDR to brighten the kitchen" });
    const decRec = await prisma.appSetting.findUnique({ where: { key: desk.revisionDecisionKey(job.id) } });
    c.ok("'Send to the photo editor': recorded (who, what, the note) and the next step opens the photos' gallery", dec.ok && dec.href === `/ops/photo-delivery/${job.id}#pd-gallery-h` && !!decRec && JSON.parse(decRec.value).choice === "editor" && JSON.parse(decRec.value).by === "Kyle Smith", JSON.stringify(dec));
    c.ok("…the decision is on the job's activity", (await prisma.activity.count({ where: { projectId: pRevDb.id, body: { contains: "AutoHDR to brighten the kitchen" } } })) === 1);
    const self = await actions.deskRevisionDecisionAction({ jobId: job.id, choice: "self", note: "I will straighten the bedroom photo" });
    c.ok("'Fix it myself': the next step is the photos' holding section (Approve and deliver again)", self.ok && self.href === `/ops/photo-delivery/${job.id}#pd-holding-h`);
    const noneShort = await actions.deskRevisionDecisionAction({ jobId: job.id, choice: "none", note: "ok" });
    c.ok("'No change needed' keeps Photo Delivery's own minimum reason", !noneShort.ok, noneShort.message);
    await prisma.photoJob.update({ where: { id: job.id }, data: { stage: "DELIVERED" } });
    const stale2 = await actions.deskRevisionDecisionAction({ jobId: job.id, choice: "editor", note: "AutoHDR again" });
    c.ok("photos no longer waiting on a decision: refused, reload", !stale2.ok && /not waiting on a decision/.test(stale2.message));

    c.ok("nothing left the drill, and no message was queued to anyone", fence.blocked.length === 0 && (await prisma.outboxMessage.count()) === 0, fence.blocked.slice(0, 3).join(" | "));
    c.summary();
  } finally {
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
