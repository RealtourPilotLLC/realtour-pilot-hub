// ---------------------------------------------------------------------------
// DRILL: JAMES'S DASHBOARD, REBUILT TO THE MOCKUP (Oct 27 2026).
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-james-dashboard.ts
//
// Jordan: "The 'My Production' section has no functionality ... Rick's shoot -
// nothing recorded from the field yet - that doesn't matter to James. He's
// filming it today ... Brief sent, got it to tap - No idea what that is ...
// Shoot brief to read - why does that matter? No shot list on the job - if
// there is none, then just don't show that. My Production should just be
// 'Production' ... show only the first two ... then have a button to open a
// full view. Team Development & Quality ... like the example. Creative Prep
// ... Split it into two ... Process improvement - figure out what needs to go
// here ... All the cards should fit nicely, just like the example."
//
//   §A rendered from a fixture shaped like the live james-desk read (no
//      database): Production's two rows and its full view, every row's one
//      action; Creative Review; Team Development one row per group with one
//      action, the two tiles and the footnote; Listing scripts and Monthly
//      content scripts; Process Improvements from what the hub counted (the
//      real frictionsFrom over the same signals); Assigned to Me with an
//      action on every row; the glance and end-of-day strips; two equal-height
//      columns on a desktop, one on a phone; the read-only preview
//   §B the data behind it (PGlite): filming is not a gap, the shoot-day brief
//      is one "Mark brief read" with the version Kyle's desk waits on,
//      Finish handoff goes to the missing part of the upload page, a listing
//      script's one-line detail, his tasks by Team row and by key (a brand
//      update closes itself, a program's check links its page), Accept /
//      Done / hand to Kyle / escalate to Jordan, Ask Kyle on the job chat, an
//      improvement started from a friction row is tracked once
//
// ISOLATION: §B runs on PGlite via the shared harness, every .env key blank,
// AUTH_ENFORCE on, every outbound call fenced; the delegation workflow is faked
// at its module seam. The shoot-day brief is the real module: switched on, and
// its sent / acknowledged records written straight into the drill database.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import type { AssignedRow, CreativeDesk as Desk, HandoffRow, PrepRow, ShootRow } from "../../src/lib/creativeDesk";
import type { DelegatedTask } from "../../src/lib/delegation";
import type { Signal } from "../../src/lib/teamDevelopment";

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, replace() {}, push() {} });
navigation.usePathname = () => "/";

// ---- seams (used by §B) ----------------------------------------------------------------
const store = new Map<string, DelegatedTask>();
interceptModule((r) => r === "@/lib/delegation" || /src[\\/]lib[\\/]delegation(\.ts)?$/.test(r), (loaded) => ({
  ...(loaded as object),
  delegationFor: async (ids: string[]) => new Map(ids.filter((id) => store.has(id)).map((id) => [id, store.get(id)!] as const)),
  tasksAssignedTo: async (key: string) => [...store.values()].filter((t) => t.assigneeKey === key),
  tasksDelegatedBy: async (email: string) => [...store.values()].filter((t) => t.assignedBy?.toLowerCase() === email.toLowerCase()),
}));
// The shoot-day brief's version stamp in the §A fixture (any 32 hex; §B uses the real brief module).
const DIGEST = "0123456789abcdef0123456789abcdef";
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, ts: "1", channel: { id: "D1" } }), { headers: { "content-type": "application/json" } }) : null));

const flat = (el: Parameters<typeof renderToStaticMarkup>[0]) => { try { return renderToStaticMarkup(el).replace(/<!-- -->/g, ""); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
/** The markup of one element that opens with `open` (up to its matching close tag). */
function block(html: string, open: string, tag = "div"): string {
  const i = html.indexOf(open);
  if (i < 0) return "";
  const start = html.lastIndexOf(`<${tag}`, i);
  let depth = 0;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + m[0].length);
  }
  return html.slice(start);
}
const count = (html: string, s: string | RegExp) => (typeof s === "string" ? html.split(s).length - 1 : (html.match(s) ?? []).length);

const H = 3_600_000;
const D = 24 * H;

// ---- §A fixture: shaped like the live read of James's desk (Oct 27 2026, 2:58 PM) ----------
const NOW = "2026-10-27T18:58:29.613Z";
const chip = (key: string, label: string, tone: "ok" | "todo" | "info" | "off") => ({ key, label, tone });
const shoot = (o: Partial<ShootRow> & { id: string; projectId: string; street: string; clientName: string; whenISO: string; whenWords: string; dayKey: string }): ShootRow => ({
  endISO: new Date(Date.parse(o.whenISO) + 2 * H).toISOString(), today: o.dayKey === "2026-10-27", services: [], chips: [], missing: [], requests: [],
  links: [{ label: "Open brief", href: `/shoot/${o.projectId}` }, { label: "Daily brief", href: `/shoot/brief/${o.dayKey}` }],
  started: false, over: false, status: null, briefAck: null, finishHref: `/upload/${o.projectId}#capture`, ...o,
});
const teamHandoff = (projectId: string, street: string): HandoffRow => ({
  projectId, street, clientName: "Dana Field", photographer: "Harrison Wells", mine: false, visitISO: "2026-10-27T14:00:00.000Z",
  status: "Nothing recorded since the visit on Tue, Oct 27", tone: "todo", lines: [chip("photos-in", "Photos: no upload recorded", "todo")], missing: [], exceptions: [],
  links: [{ label: "Upload", href: `/upload/${projectId}` }, { label: "Flag an issue", href: `/shoot/${projectId}` }], sig: `sig-${projectId}`, finishHref: `/upload/${projectId}#capture`,
});
const signal = (key: string, group: "FIELD" | "EDITOR" | "QC", personName: string, skill: string, detail: string, count: number, countWords: string): Signal => ({
  key, group, personId: `${group}-${personName}`, personName, skill, detail, source: group === "QC" ? "QC records reopened by a client revision" : "KPI evidence, Sep 25 to Dec 31 2026", count, countWords,
  examples: [{ label: `Example for ${skill}`, href: "/projects/px", at: "2026-10-26T12:00:00.000Z", source: key }],
});
const H_ID = "hwells0000000000000001";
const SIGNALS: Signal[] = [
  signal(`field:${H_ID}:kpi:upload`, "FIELD", "Harrison Wells", "Upload timing", "20 entries in the KPI evidence this period", 20, "20 this period"),
  signal(`field:${H_ID}:kpi:handoff`, "FIELD", "Harrison Wells", "Handoff instructions", "8 entries in the KPI evidence this period", 8, "8 this period"),
  signal(`field:${H_ID}:kpi:capture`, "FIELD", "Harrison Wells", "Capture quality and coverage", "1 entry in the KPI evidence this period", 1, "1 this period"),
  signal(`field:${H_ID}:photoqc:car_in_driveway`, "FIELD", "Harrison Wells", "Photo check: Car in driveway", "Found on 9 shoots in the last 30 days", 9, "9 shoots in 30 days"),
  signal(`field:${H_ID}:photoqc:item_left`, "FIELD", "Harrison Wells", "Photo check: Item left in an empty room", "Found on 5 shoots in the last 30 days", 5, "5 shoots in 30 days"),
  signal(`field:${H_ID}:photoqc:vehicle_blocking`, "FIELD", "Harrison Wells", "Photo check: Vehicle blocking home", "Found on 3 shoots in the last 30 days", 3, "3 shoots in 30 days"),
  signal("qc:kyle:reopened", "QC", "Kyle Smith", "QC passes later reopened by a revision", "1 of 21 QC passes in 30 days. A revision does not prove QC missed it: review each example", 1, "1 of 21 passes in 30 days"),
];
const listingRow = (projectId: string, street: string, client: string, when: string, studio: string): PrepRow => ({
  key: `listing:${projectId}`, kind: "listing", projectId, title: `Listing script · ${street}`, detail: `Shoot ${when} · Script waiting on your review`, clientName: client, mode: "JAMES_OWNS",
  writer: "Script Studio", approver: "James", role: "You approve it and film it", source: "Script Studio (listing scripts are written there; you approve them)",
  deadlineISO: null, deadlineWords: `Shoot ${when}`, status: "Script waiting on your review",
  links: [{ label: "Open script", href: `https://studio.invalid/creative/${studio}`, external: true }, { label: "Open brief", href: `/shoot/${projectId}` }],
});
const monthlyRow = (enrollmentId: string, client: string, projectId: string | null, n: number, by: string, session: string): PrepRow => ({
  key: `monthly:${enrollmentId}:2026-10`, kind: "monthly", projectId, title: "Monthly scripts · October", detail: `${n} scripts approved for October · Scripts approved by ${by} (session ${session})`, clientName: client, mode: "JORDAN_OWNS",
  writer: "Jordan", approver: "Jordan", role: "You film the session: production input", source: "The filming session is booked with you", deadlineISO: null, deadlineWords: `Scripts approved by ${by} (session ${session})`, status: `${n} scripts approved for October`,
  links: [{ label: "Scripts", href: `/content/${enrollmentId}?tab=plan&view=scripts` }, { label: "Discovery and strategy", href: `/content/${enrollmentId}?tab=plan&view=strategy` }, { label: "Preferences", href: `/content/${enrollmentId}?tab=brand` }],
});

async function fixture(): Promise<Desk> {
  const { frictionsFrom } = await import("../../src/lib/creativeDesk");
  const groups = [
    { key: "FIELD" as const, label: "Field creatives", blurb: "Capture quality, client direction, uploads and handoffs", people: [{ id: H_ID, name: "Harrison Wells" }], items: [], signals: SIGNALS.filter((s) => s.group === "FIELD") },
    { key: "EDITOR" as const, label: "Editors", blurb: "Editing quality, corrections, recurring revisions", people: [{ id: "kim", name: "Kim Miguel" }], items: [], signals: [] },
    { key: "QC" as const, label: "Admin QC", blurb: "Photo QC calibration, missed issues", people: [{ id: "kyle", name: "Kyle Smith" }], items: [], signals: SIGNALS.filter((s) => s.group === "QC") },
  ];
  return {
    nowISO: NOW, dayKey: "2026-10-27", dateWords: "Tuesday, October 27",
    person: { name: "James Livingston", first: "James", teamMemberId: "jamestm", key: "james" }, ownerKey: "jordan", readOnly: false, development: true, unavailable: [],
    glance: { shoots: 1, reviews: 0, followUps: 0, urgent: 0, line: "1 shoot today." },
    production: {
      mine: [
        // Rick's full-day session: filming now (started 9 AM, ends 5 PM). Nothing missing.
        shoot({ id: "a-rick", projectId: "p-rick", street: "[No address provided]", clientName: "Rick Sample", whenISO: "2026-10-27T13:00:00.000Z", endISO: "2026-10-27T21:00:00.000Z", dayKey: "2026-10-27", whenWords: "Today 9:00 AM", services: ["Full Day Content Shoot"], started: true, status: { label: "Filming now", tone: "info" }, chips: [chip("confirm", "Confirmation sent", "ok"), chip("direction", "48 scripts approved for the session", "ok")] }),
        shoot({ id: "a-maple", projectId: "p-maple", street: "40 Maple Ave", clientName: "Avery Lane", whenISO: "2026-10-28T13:00:00.000Z", dayKey: "2026-10-28", whenWords: "Wed, Oct 28 9:00 AM", services: ["Essentials Package"], chips: [chip("confirm", "Confirmation sent", "ok"), chip("access", "Access noted", "ok"), chip("requests", "1 special request in the brief", "info")], requests: ["Lights on in every room"] }),
        shoot({ id: "a-cherry", projectId: "p-cherry", street: "825 Cherry St", clientName: "Avery Lane", whenISO: "2026-10-28T19:00:00.000Z", dayKey: "2026-10-28", whenWords: "Wed, Oct 28 3:00 PM", services: ["Photography and Standard Reel w/ Agent intro"], chips: [chip("confirm", "Confirmation sent", "ok"), chip("access", "Access noted", "ok")] }),
        shoot({ id: "a-birch", projectId: "p-birch", street: "877 Birch Dr", clientName: "Nora Quill", whenISO: "2026-10-29T12:30:00.000Z", dayKey: "2026-10-29", whenWords: "Thu, Oct 29 8:30 AM", services: ["Video Accelerator - 4HR Session"], chips: [chip("confirm", "Confirmation sent", "ok"), chip("direction", "5 scripts approved for the session", "ok")] }),
        shoot({ id: "a-hill", projectId: "p-hill", street: "658 Hill Rd", clientName: "Max Fable", whenISO: "2026-10-29T17:00:00.000Z", dayKey: "2026-10-29", whenWords: "Thu, Oct 29 1:00 PM", services: ["Social Influencer"], chips: [chip("confirm", "Confirmation sent", "ok"), chip("access", "Access noted", "ok"), chip("direction", "Agent script waiting on your review", "todo")], missing: ["Agent script waiting on your review"], links: [{ label: "Open brief", href: "/shoot/p-hill" }, { label: "Daily brief", href: "/shoot/brief/2026-10-29" }, { label: "Script Studio", href: "https://studio.invalid/creative/r1", external: true }] }),
        shoot({ id: "a-route", projectId: "p-route", street: "7287 Route 9", clientName: "Ivy Stone", whenISO: "2026-10-30T17:00:00.000Z", dayKey: "2026-10-30", whenWords: "Fri, Oct 30 1:00 PM", services: ["Social Influencer"], chips: [chip("confirm", "Not confirmed yet (Kyle)", "info"), chip("access", "Access noted", "ok")] }),
        shoot({ id: "a-elm", projectId: "p-elm", street: "101 Elm Way", clientName: "Theo Park", whenISO: "2026-11-02T18:00:00.000Z", dayKey: "2026-11-02", whenWords: "Mon, Nov 2 1:00 PM", services: ["Video Accelerator - 4HR Session"], chips: [chip("direction", "4 scripts approved for the session", "ok")] }),
      ],
      handoffs: [],
      team: [teamHandoff("p-cedar", "29 Cedar Ln"), teamHandoff("p-pine", "26 Pine Rd")],
      teamUpcoming: [],
      unavailable: false, myShootsHref: "/shoot?as=jamestm", closedOut: 0, fullHref: "/production",
    },
    review: { ready: [], delayed: [], coverHours: 9, unavailable: false },
    team: { groups, dueIds: [], unavailable: [], recordsUnavailable: false },
    readiness: { items: [], criteria: [], people: [{ id: H_ID, name: "Harrison Wells" }], unavailable: false },
    prep: { items: [
      monthlyRow("enr-nora", "Nora Quill", "p-birch", 5, "Wed, Oct 28, 8:30 AM", "Thu, Oct 29"),
      listingRow("p-hill", "658 Hill Rd", "Max Fable", "Thu, Oct 29, 1:00 PM", "r1"),
      listingRow("p-route", "7287 Route 9", "Ivy Stone", "Fri, Oct 30, 1:00 PM", "r2"),
      monthlyRow("enr-theo", "Theo Park", "p-elm", 4, "Sun, Nov 1, 1:00 PM", "Mon, Nov 2"),
    ], unavailable: false },
    improvements: { items: [], frictions: frictionsFrom(SIGNALS, []), unavailable: false },
    assigned: { items: [], people: [{ key: "jordan", name: "Jordan Spackman" }, { key: "kyle", name: "Kyle Smith" }, { key: "harrison", name: "Harrison Wells" }, { key: "kim", name: "Kim Miguel" }], unavailable: false },
    closeout: { dayKey: "2026-10-27", lines: [
      { key: "uploads", label: "My uploads and handoffs complete", auto: true, words: "Every shoot of yours is handed off", tick: null, done: true },
      { key: "reviews", label: "Due reviews handled, or exceptions documented", auto: true, words: "No review of yours is due or past the window", tick: null, done: true },
      { key: "coaching", label: "Coaching follow-ups recorded", auto: true, words: "No coaching follow-up due", tick: null, done: true },
      { key: "blockers", label: "Blockers have an owner and a next step", auto: true, words: "Nothing of yours is blocked", tick: null, done: true },
    ] },
  };
}

async function partA(c: ReturnType<typeof makeChecker>) {
  const { CreativeDesk } = await import("../../src/components/creativeDesk/CreativeDesk");
  const base = await fixture();
  const render = (desk: Desk, mode: "home" | "production" | "development" = "home", initialPanel: unknown = null) => flat(createElement(CreativeDesk, { desk, mode, initialPanel: initialPanel as never }));
  const html = render(base);

  // =====================================================================
  c.head("§A1 · Production: the first two rows, every row's one action, then the full view");
  // =====================================================================
  const prod = block(html, 'data-section="production"', "section");
  c.ok("it renders, titled 'Production' (never 'My Production')", !html.startsWith("RENDER FAILED") && /id="production-title"[^>]*>Production</.test(html) && !html.includes("My Production"), html.slice(0, 200));
  c.ok("only the first two rows: Rick's session today, then the next shoot", count(prod, /data-shoot="/g) + count(prod, /data-handoff="/g) === 2 && prod.indexOf('data-shoot="a-rick"') > 0 && prod.indexOf('data-shoot="a-maple"') > prod.indexOf('data-shoot="a-rick"') && !prod.includes('data-shoot="a-cherry"'));
  c.ok("…then a button to the full view, with the rest counted (5 more of yours, 2 team handoffs)", prod.includes('href="/production"') && prod.includes("Open full view (9)") && prod.includes("5 more of yours · 2 team handoffs to check in the full view."));
  const rick = block(prod, 'data-shoot="a-rick"', "li");
  c.ok("Rick's shoot while he is filming: none of the noise (nothing recorded, Got it to tap, shoot brief to read, no shot list)", !!rick && !/Nothing recorded|Got it to tap|Shoot brief to read|No shot list/.test(rick) && rick.includes('data-status="Filming now"'), rick.slice(0, 400));
  c.ok("…its actions: Open brief, Ask Kyle or Jordan, Flag a problem (straight to the flag box)", rick.includes('href="/shoot/p-rick"') && rick.includes("Ask Kyle or Jordan") && rick.includes('href="/shoot/p-rick#flag"') && rick.includes('data-primary="brief"'));
  c.ok("no row's only action is Open: each has the ask and the flag as well", [...prod.matchAll(/<li data-shoot="[^"]+"/g)].every((m) => { const li = block(prod, m[0], "li"); return li.includes("data-ask=") && li.includes("#flag"); }));

  // A brief Kyle waits on, a visit over with nothing recorded, an own handoff.
  const v = structuredClone(base);
  v.production.mine[0] = { ...v.production.mine[0], over: true, started: true, status: { label: "Handoff due", tone: "todo" }, chips: [chip("field", "Nothing recorded from the field yet", "todo"), ...v.production.mine[0].chips], missing: ["Nothing recorded from the field yet"] };
  v.production.mine[1] = { ...v.production.mine[1], briefAck: { day: "2026-10-28", digest: DIGEST, again: false, changes: [] }, status: { label: "Brief to confirm", tone: "todo" }, missing: ["Shoot-day brief to confirm"] };
  const own: HandoffRow = { ...teamHandoff("p-oak", "12 Oak Ln"), mine: true, photographer: "James Livingston", status: "Upload started, not submitted", finishHref: "/upload/p-oak#submit" };
  v.production.handoffs = [own];
  const vHtml = render(v);
  const vProd = block(vHtml, 'data-section="production"', "section");
  const vRick = block(vProd, 'data-shoot="a-rick"', "li");
  c.ok("once the visit's END has passed with nothing recorded: said, and the row's button is Finish handoff (the upload page's capture part)", vRick.includes("Nothing recorded from the field yet") && vRick.includes('data-status="Handoff due"') && /href="\/upload\/p-rick#capture"[^>]*data-primary="finish"|data-primary="finish"[^>]*href="\/upload\/p-rick#capture"/.test(vRick) && vRick.includes("Finish handoff"));
  c.ok("his own handoff is the second row: Finish handoff to the part of the upload page that is missing (#submit)", vProd.includes('data-handoff="p-oak"') && block(vProd, 'data-handoff="p-oak"', "li").includes('href="/upload/p-oak#submit"') && !vProd.includes('data-shoot="a-maple"'));
  const full = render(v, "production");
  const perry = block(full, 'data-shoot="a-maple"', "li");
  c.ok("the full view lists every shoot of his; the brief Kyle waits on is one button, Mark brief read (the version shown)", count(full, /<li data-shoot="/g) === 7 && perry.includes('data-brief-ack="2026-10-28"') && perry.includes(">Mark brief read<") && perry.includes('data-status="Brief to confirm"') && perry.includes('href="/shoot/p-maple"'));
  // James's call (Oct 2026): a changed brief shows WHAT changed, its Got it under it; none on record opens the day's brief.
  const ch = structuredClone(v);
  ch.production.mine[1] = { ...ch.production.mine[1], briefAck: { day: "2026-10-28", digest: DIGEST, again: true, changes: ['40 Maple Ave: request changed from "Lights on" to "Lights on in every room, blinds open"'] }, status: { label: "Brief changed", tone: "todo" } };
  ch.production.mine[2] = { ...ch.production.mine[2], briefAck: { day: "2026-10-28", digest: DIGEST, again: true, changes: [] }, status: { label: "Brief changed", tone: "todo" } };
  const chFull = render(ch, "production");
  const chMaple = block(chFull, 'data-shoot="a-maple"', "li");
  const box = block(chMaple, 'data-brief-changes="a-maple"', "div");
  c.ok("a changed brief lists what changed (before and after) on the row, and its Mark changed brief read sits under it", box.includes("What changed") && box.includes("request changed from &quot;Lights on&quot; to &quot;Lights on in every room, blinds open&quot;") && box.includes('data-brief-ack="2026-10-28"') && box.includes(">Mark changed brief read<") && count(chMaple, /data-brief-ack=/g) === 1, chMaple.slice(0, 900));
  const chCherry = block(chFull, 'data-shoot="a-cherry"', "li");
  c.ok("…a change with no words on record is never confirmed blind: See what changed, to the day's brief", chCherry.includes('data-primary="see-changes"') && chCherry.includes('href="/shoot/brief/2026-10-28"') && !chCherry.includes("data-brief-ack"), chCherry.slice(0, 700));
  // Harrison's Firethorn shoot (Oct 28, 2 PM; the call was at 1:30): the team's shoots from today on.
  const tu = structuredClone(v);
  tu.production.teamUpcoming = [
    { id: "a-fire", projectId: "p-fire", photographer: "Harrison Wells", street: "512 Firethorn Rd", clientName: "Mike Sample", whenISO: "2026-10-27T18:00:00.000Z", whenWords: "Today 2:00 PM", today: true, started: false, services: ["Essentials Package"], brief: chip("brief", "Brief sent, no Got it yet", "info"), href: "/shoot/p-fire" },
  ];
  const tuFull = render(tu, "production");
  const fire = block(tuFull, 'data-team-shoot="a-fire"', "li");
  c.ok("the full view lists the team's shoots from today on (Harrison's 2 PM Firethorn), with his brief and Open shoot", tuFull.includes('data-section="team-shoots"') && fire.includes("Harrison · 512 Firethorn Rd") && fire.includes("Today 2:00 PM") && fire.includes("Brief sent, no Got it yet") && fire.includes('href="/shoot/p-fire"') && tuFull.includes('href="/schedule"'), fire.slice(0, 600));
  const tuHome = block(render(tu), 'data-section="production"', "section");
  c.ok("…and the dashboard's Production card counts them toward the full view", tuHome.includes("1 team shoot this week"), tuHome.slice(-500));
  c.ok("…the team's handoffs he supervises (Check upload, Close out), and the way back", full.includes('data-list="team-handoffs"') && count(full, /data-handoff="p-(cedar|pine)" data-mine="false"/g) === 2 && full.includes("Check upload") && full.includes("Close out") && full.includes("Back to the dashboard") && !full.includes('data-section="team"') && !full.includes('data-section="assigned"'));

  // =====================================================================
  c.head("§A2 · Creative Review");
  // =====================================================================
  const review = block(html, 'data-section="review"', "section");
  c.ok("empty: said calmly; the review standards line and the approval rule as the mockup words them", review.includes("No cut is waiting on your review.") && review.includes("Review standards: Sequence · Capture · Color · Audio · Text · AI · Client brief") && review.includes("Approval sends the verified version to Kyle\u2019s delivery queue, never straight to the client.") && review.includes('href="/review"'));
  const r = structuredClone(base);
  r.review.ready = [{ id: "cut1", projectId: "p-cut", street: "60 Review Rd", clientName: "Real Agent", version: 2, label: "v2.mp4", editor: "Kim Miguel", reviewer: null, mine: false, enteredISO: NOW, waitedHours: 2, waitedWords: "2 working hours", delayed: false, heldForCheck: false, dueISO: null, dueWords: null, priorNotes: { total: 3, open: 0 }, asks: [], href: "/review/p-cut?cut=cut1", why: null }];
  const rHtml = block(render(r), 'data-section="review"', "section");
  c.ok("a cut: Version 2 · Corrections returned, its Review button, and Approve or escalate in the panel", rHtml.includes("Version 2 · Corrections returned · Kim Miguel") && /href="\/review\/p-cut\?cut=cut1"[^>]*>Review</.test(rHtml) && rHtml.includes('data-open-panel="cut:cut1"'));

  // =====================================================================
  c.head("§A3 · Team Development & Quality: one row per group, one action each");
  // =====================================================================
  const team = block(html, 'data-section="team"', "section");
  const field = block(team, 'data-group="FIELD"');
  const editors = block(team, 'data-group="EDITOR"');
  const qc = block(team, 'data-group="QC"');
  const buttons = (h: string) => count(h, /<button /g);
  c.ok("Field creatives: the person · topic with the hub's count, 'Next step: ...', ONE action (Assess work) on the strongest evidence", field.includes("Harrison · Upload timing") && field.includes("(20 this period)") && field.includes("Next step: Review the examples and record feedback") && field.includes(">Assess work<") && field.includes(`data-open-panel="signal:field:${H_ID}:kpi:upload"`) && buttons(field) === 1, field.slice(0, 500));
  c.ok("…the other five are behind one line (+5 more), not a wall of text", field.includes("+5 more in team development") && !field.includes("Handoff instructions") && !field.includes("KPI evidence, Sep 25"));
  c.ok("Editors with nothing recorded: an honest line and Record feedback", editors.includes("No recorded coaching and no quality evidence for editors right now.") && editors.includes(">Record feedback<") && buttons(editors) === 1);
  c.ok("Admin QC: Kyle · the QC topic, one action (Open QC review); the caveat waits in the panel", qc.includes("Kyle · QC passes later reopened by a revision") && qc.includes(">Open QC review<") && buttons(qc) === 1 && !qc.includes("A revision does not prove"));
  c.ok("two tiles: Training follow-up, Readiness recommendations (Start one when there is none)", team.includes("Training follow-up") && team.includes("No follow-up scheduled.") && team.includes("Readiness recommendations") && team.includes("No assessment in progress.") && team.includes(">Start one "));
  c.ok("the footnote: James assesses readiness. Jordan makes staffing decisions.", team.includes("James assesses readiness. Jordan makes staffing decisions."));
  const t2 = structuredClone(base);
  t2.team!.groups[0].items = [{ id: "item1", personId: H_ID, personName: "Harrison Wells", group: "FIELD", skill: "Capture consistency", standard: null, nextAction: "Review practice footage", followUpISO: "2026-10-27T13:00:00.000Z", followUpDue: true, practice: "Shoot three practice rooms", practiceDueISO: "2026-11-02T13:00:00.000Z", status: "OPEN", progress: null, evidence: [], log: [], createdBy: "James", createdISO: NOW, verifiedISO: null, verifiedBy: null, lastWords: null }];
  t2.team!.dueIds = ["item1"];
  t2.readiness!.items = [{ id: "ra1", personId: H_ID, personName: "Harrison Wells", track: "PREMIUM", trackLabel: "Premium project readiness", skill: null, criteria: [{ key: "k", label: "Quality", source: "kpi", covers: null, met: "yes", evidence: "Twelve reels" }, { key: "j", label: "Leads on site", source: "james", covers: null, met: "unknown", evidence: null }], met: 1, gaps: null, recommendation: "READY_WITH_SUPPORT", recommendationNote: null, status: "DRAFT", recommendedISO: null, createdBy: "James", createdISO: NOW, log: [], decision: null } as never];
  const t2Html = block(render(t2), 'data-section="team"', "section");
  c.ok("a follow-up due leads its group: Record follow-up, and the training tile names it", block(t2Html, 'data-group="FIELD"').includes("Harrison · Capture consistency") && block(t2Html, 'data-group="FIELD"').includes(">Record follow-up<") && t2Html.includes("Follow-up due") && t2Html.includes('data-open-panel="dev-item:item1"'));
  c.ok("an assessment with a recommendation: Recommend to Jordan on the readiness tile", t2Html.includes("Harrison · Premium project readiness") && t2Html.includes("1 of 2 criteria met · You recommend: Ready with support") && t2Html.includes("Recommend to Jordan"));

  // =====================================================================
  c.head("§A4 · Creative Prep, split: Listing scripts and Monthly content scripts");
  // =====================================================================
  const listing = block(html, 'data-section="prep"', "section");
  const monthly = block(html, 'data-section="prep-monthly"', "section");
  c.ok("two cards, titled as Jordan asked", listing.includes(">Listing scripts<") && monthly.includes(">Monthly content scripts<") && !html.includes("Creative Preparation"));
  const ridge = block(listing, 'data-prep="listing:p-hill"', "li");
  // Oct 27 2026 Loom: "James can approve them". The row is his: Review script opens it, no Add input to Jordan.
  c.ok("a listing row: the street and agent, ONE line of detail, James's chip, one button (Review script) to the script", ridge.includes("658 Hill Rd") && ridge.includes("Max Fable") && count(ridge, "data-prep-detail") === 1 && ridge.includes("Shoot Thu, Oct 29, 1:00 PM · Script waiting on your review") && ridge.includes(">James owns<") && !ridge.includes("data-ask-to") && !ridge.includes("Jordan") && ridge.includes(">Review script <") && count(ridge, "https://studio.invalid/creative/r1") === 1 && !ridge.includes("Writer:"), ridge.slice(0, 600));
  c.ok("the listing card holds listing rows only; the monthly card monthly rows only", count(listing, /data-prep="listing:/g) === 2 && !listing.includes('data-prep="monthly:') && count(monthly, /data-prep="monthly:/g) === 2 && !monthly.includes('data-prep="listing:'));
  const erin = block(monthly, 'data-prep="monthly:enr-nora:2026-10"', "li");
  c.ok("a monthly row: the client, '5 scripts approved for October · approved by ... (session ...)', the chip, Add input on the session's job, Open scripts", erin.includes("Nora Quill") && erin.includes("5 scripts approved for October · Scripts approved by Wed, Oct 28, 8:30 AM (session Thu, Oct 29)") && erin.includes(">Jordan owns<") && erin.includes('data-ask="p-birch"') && erin.includes(">Add input<") && erin.includes('href="/content/enr-nora?tab=plan&amp;view=scripts"'));
  const m2 = structuredClone(base);
  m2.prep.items = [{ ...monthlyRow("enr-x", "Dana Draft", null, 2, "Fri, Oct 30", "Sat, Oct 31"), mode: "JAMES_DRAFTS" }, { ...monthlyRow("enr-y", "Owen Own", null, 3, "Fri, Oct 30", "Sat, Oct 31"), mode: "JAMES_OWNS" }];
  const m2Html = block(render(m2), 'data-section="prep-monthly"', "section");
  c.ok("James drafts: Open draft; James owns: Review (each one button, to the scripts)", block(m2Html, 'data-prep="monthly:enr-x:2026-10"', "li").includes(">Open draft<") && block(m2Html, 'data-prep="monthly:enr-x:2026-10"', "li").includes(">James drafts<") && block(m2Html, 'data-prep="monthly:enr-y:2026-10"', "li").includes(">Review<") && block(m2Html, 'data-prep="monthly:enr-y:2026-10"', "li").includes(">James owns<"));

  // =====================================================================
  c.head("§A5 · Process Improvements: the friction the hub counted, each with one action");
  // =====================================================================
  const imp = block(html, 'data-section="improvements"', "section");
  const fr = base.improvements.frictions;
  c.ok("frictionsFrom: late uploads (20), the photo check's car in driveway (9), handoffs without instructions (8), item left (5), vehicle blocking (3), most first", fr.map((f) => `${f.key}=${f.count}`).join(",") === "friction:kpi:upload=20,friction:photoqc:car_in_driveway=9,friction:kpi:handoff=8,friction:photoqc:item_left=5,friction:photoqc:vehicle_blocking=3", fr.map((f) => `${f.key}=${f.count}`).join(","));
  c.ok("…every number is a count the hub made (the signals' own), nothing under two, no QC reopen (a revision is not proof)", fr.every((f) => SIGNALS.some((s) => s.count === f.count)) && !fr.some((f) => /^friction:(kpi:capture|qc:)/.test(f.key)) && fr.every((f) => f.count >= 2));
  c.ok("the card shows the top three, each 'title / count · who' with one action that starts an improvement", count(imp, /data-friction="/g) === 3 && imp.includes(">Late uploads<") && imp.includes("20 late uploads this KPI period · Harrison") && imp.includes(">Fix late uploads<") && imp.includes('data-open-panel="friction:friction:kpi:upload"') && imp.includes("+2 more improvements"));
  const fPanel = render(base, "home", { kind: "friction", key: "friction:kpi:upload" });
  c.ok("its panel: the examples, and the improvement form filled in from the count (area, next step), tracked by its friction key", fPanel.includes('data-side-panel="friction:friction:kpi:upload"') && fPanel.includes("Example for Upload timing") && fPanel.includes('data-friction="friction:kpi:upload"') && fPanel.includes("Shoot uploads land after their deadline (20 late uploads this KPI period · Harrison)") && fPanel.includes("Start the improvement</button>"), fPanel.slice(fPanel.indexOf("data-side-panel"), fPanel.indexOf("data-side-panel") + 2500).replace(/<svg.*?<\/svg>/g, ""));
  const tracked = structuredClone(base);
  tracked.improvements.items = [{ taskId: "imp1", friction: "friction:kpi:upload", problem: "Shoot uploads land after their deadline", area: "Uploads and handoffs", owner: "James", nextStep: "Set the fix", outcome: null, policy: false, status: "Open", dueISO: null, mine: true }, { taskId: "imp2", friction: null, problem: "Briefs missing the parking note", area: "Creative briefs", owner: "James", nextStep: null, outcome: null, policy: false, status: "Open", dueISO: null, mine: true }];
  const { frictionsFrom } = await import("../../src/lib/creativeDesk");
  tracked.improvements.frictions = frictionsFrom(SIGNALS, tracked.improvements.items);
  const tImp = block(render(tracked, "development"), 'data-section="improvements"', "section");
  c.ok("a friction already tracked shows once, as 'Improvement open' with Update; an improvement of his own is listed too", tImp.includes('data-friction="friction:kpi:upload" data-count="20" data-tracked="true"') && tImp.includes("Improvement open") && tImp.includes('data-open-panel="improvement:imp1"') && !tImp.includes('data-improvement="imp1"') && tImp.includes('data-improvement="imp2"'));
  const none = structuredClone(base);
  none.improvements.frictions = [];
  c.ok("nothing counted and nothing open: a calm line, no made-up rows", block(render(none), 'data-section="improvements"', "section").includes("Nothing recurring in what the hub counts, and no improvement tasks open."));

  // =====================================================================
  c.head("§A6 · Assigned to Me & Handoffs: every row has its action");
  // =====================================================================
  c.ok("nothing assigned: said calmly", block(html, 'data-section="assigned"', "section").includes("Nothing is assigned to you right now."));
  const row = (o: Partial<AssignedRow> & { taskId: string; title: string }): AssignedRow => ({ outcome: null, assignedBy: null, dueISO: null, dueWords: null, overdue: false, urgent: false, state: "OPEN", stateWords: "Open", blocker: null, nextStep: null, latestUpdate: null, needsVerification: false, delegated: false, closesItself: false, href: "/tasks", ...o });
  const a = structuredClone(base);
  a.assigned.items = [
    row({ taskId: "t-del", title: "Prepare a coaching plan", delegated: true, state: "ASSIGNED", stateWords: "Awaiting acceptance", assignedBy: "Jordan", dueWords: "Today 4:00 PM" }),
    row({ taskId: "t-brand", title: "Confirm Kim has Real Agent's brand update", closesItself: true, href: "/edit/p-brand" }),
    row({ taskId: "t-mid", title: "Mid-month check: Nora Quill", href: "/content/enr-nora" }),
    row({ taskId: "t-prog", title: "Report recurring capture issue", state: "IN_PROGRESS", stateWords: "In progress" }),
    row({ taskId: "t-brand2", title: "Confirm John has Owen Own's brand update", closesItself: true, state: "IN_PROGRESS", stateWords: "In progress", href: "/edit/p-own" }),
  ];
  const aHtml = block(render(a), 'data-section="assigned"', "section");
  const cell = (id: string) => block(aHtml, `data-task="${id}"`, "li");
  c.ok("a delegated task waiting: Accept, in place", cell("t-del").includes('data-step="accept"') && cell("t-del").includes("Awaiting acceptance") && cell("t-del").includes("From Jordan"));
  c.ok("a routed brand update and a program's mid-month check: Accept; the brand update says it closes itself", cell("t-brand").includes('data-step="accept"') && cell("t-brand").includes("Closes by itself once the editor works from the brief") && cell("t-mid").includes('data-step="accept"') && cell("t-mid").includes('href="/content/enr-nora"'));
  c.ok("in progress: Done; a brand update in progress: Check the brief (it closes on the editor's Got it or their work from the brief, never by hand)", cell("t-prog").includes('data-step="done"') && cell("t-brand2").includes(">Check the brief<") && cell("t-brand2").includes('href="/edit/p-own"') && !cell("t-brand2").includes('data-step="done"'));
  c.ok("every row also opens More: delegate, escalate", ["t-del", "t-brand", "t-mid", "t-prog", "t-brand2"].every((id) => cell(id).includes(`data-open-panel="task:${id}"`) && cell(id).includes("More: delegate, escalate")));
  const tp = render(a, "home", { kind: "task", id: "t-mid" });
  c.ok("a routed task's panel: Accept, Done, Hand to Kyle, Escalate to Jordan, Delegate to someone on the team", ['data-control="my-task"', ">Accept<", ">Done<", ">Hand to Kyle<", ">Escalate to Jordan<", "Delegate to", ">Harrison Wells<", ">Kim Miguel<"].every((w) => tp.includes(w)), tp.slice(tp.indexOf("data-side-panel"), tp.indexOf("data-side-panel") + 300));
  const bp = render(a, "home", { kind: "task", id: "t-brand" });
  c.ok("…a brand update's panel has no Done, and says how it closes", bp.includes('data-control="my-task"') && !/>Done</.test(bp.slice(bp.indexOf('data-control="my-task"'))) && bp.includes("This closes by itself when the editor taps Got it on the brief or works from it"));
  const dp = render(a, "home", { kind: "task", id: "t-del" });
  c.ok("…a delegated task keeps the delegation steps", ["Accept", "Update", "Flag blocker", "Complete", "Escalate"].every((w) => dp.includes(`>${w}</button>`)));

  // =====================================================================
  c.head("§A7 · the strips, the layout, the preview");
  // =====================================================================
  c.ok("Today at a glance: the shoot, reviews, follow-ups and urgent tasks", html.includes('data-section="glance"') && html.includes('data-glance="shoots" data-count="1"') && html.includes("shoot today"));
  c.ok("End-of-day check: the four ticks", count(html, /data-tick="/g) === 4 && html.includes("It never completes a task."));
  const sectionsInGrid = (g: string) => [...block(html, `data-grid="${g}"`).matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]).join(",");
  c.ok("two columns from the lg breakpoint, one on a phone: Production | Creative Review, then Listing + Monthly | Process Improvements", /data-grid="production-review" class="grid gap-4 lg:grid-cols-2"/.test(html) && /data-grid="prep-improvements" class="grid gap-4 lg:grid-cols-2"/.test(html) && sectionsInGrid("production-review") === "production,review" && sectionsInGrid("prep-improvements") === "prep,prep-monthly,improvements", `${sectionsInGrid("production-review")} / ${sectionsInGrid("prep-improvements")}`);
  c.ok("every card fills its cell, its link pinned to the bottom (equal heights side by side)", ["production", "review", "prep", "prep-monthly", "improvements"].every((s) => /class="[^"]*\bflex h-full\b[^"]*flex-col/.test(block(html, `data-section="${s}"`, "section").slice(0, 400))));
  c.ok("no fixed multi-column grid below a breakpoint; thumb-sized controls; no link inside a link; no em dashes", !/[" ]grid-cols-2/.test(html.slice(html.indexOf('data-grid="production-review"')).replace(/(sm|md|lg):grid-cols-\d/g, "")) && count(html, "min-h-11") >= 20 && !nestedLink(html) && !/[—–]/.test(html));
  const ro = render({ ...base, readOnly: true, assigned: a.assigned });
  c.ok("the owner's preview: no ask, no Add input, no Log one, no Start one, tasks only Open", !ro.includes("data-ask=") && !ro.includes(">Add input<") && !ro.includes("Log one") && !ro.includes(">Start one ") && !ro.includes('data-step="') && ro.includes("Preview: read-only."));

  // =====================================================================
  c.head("§A8 · the brief page resolves things: Before the shoot");
  // =====================================================================
  const { ShootPrepCard } = await import("../../src/components/shoot/ShootPrepCard");
  const lines = [
    { key: "brief", label: "Kyle sees your shoot-day brief unconfirmed until you mark it read", tone: "todo" as const, action: { kind: "ack" as const, day: "2026-10-28", digest: DIGEST, again: false } },
    { key: "access", label: "No access details on the appointment yet (Kyle chases them)", tone: "info" as const, action: { kind: "ask" as const, label: "Ask Kyle", to: "kyle" as const, placeholder: "e.g. How do I get in?" } },
    { key: "script", label: "Script not in yet (Jordan's, in Script Studio)", tone: "todo" as const, action: { kind: "ask" as const, label: "Ask Jordan", to: "jordan" as const, placeholder: "e.g. Will the script be ready?" } },
    { key: "requests", label: "1 special request from the client", tone: "info" as const, action: { kind: "link" as const, label: "Read them", href: "#brief" } },
  ];
  const card = flat(createElement(ShootPrepCard, { projectId: "p-maple", lines, readOnly: false }));
  const line = (k: string) => block(card, `data-prep-line="${k}"`, "li");
  c.ok("one line per thing the shoot needs, the count of what is his to handle (2)", count(card, /data-prep-line="/g) === 4 && card.includes("Before the shoot") && card.includes("2 to handle"));
  c.ok("the shoot-day brief: Mark brief read with that day's version", line("brief").includes('data-brief-ack="2026-10-28"') && line("brief").includes(">Mark brief read<"));
  c.ok("access missing is Kyle's to chase (said, not counted as James's): Ask Kyle on the job; the script: Ask Jordan", line("access").includes('data-tone="info"') && line("access").includes('data-ask-to="kyle"') && line("access").includes(">Ask Kyle<") && line("script").includes('data-ask-to="jordan"'));
  c.ok("special requests link to where they are on the page; the card closes with Ask Kyle or Jordan and Flag a problem", line("requests").includes('href="#brief"') && card.includes('data-ask-to="choose"') && card.includes(">Ask Kyle or Jordan<") && card.includes('href="#flag"'));
  const changedCard = flat(createElement(ShootPrepCard, { projectId: "p-maple", lines: [{ key: "brief", label: "Your shoot-day brief changed. Kyle sees it unconfirmed until you mark it read", tone: "todo" as const, detail: { title: "What changed", lines: ['825 Cherry St: new request "Produce reel styled after shared Instagram"'] }, action: { kind: "ack" as const, day: "2026-10-28", digest: DIGEST, again: true } }], readOnly: false }));
  const cl = block(changedCard, 'data-prep-line="brief"', "li");
  c.ok("the shoot screen: a changed brief says what changed before its Mark changed brief read", cl.includes('data-prep-detail="brief"') && cl.includes("825 Cherry St: new request") && cl.indexOf("data-prep-detail") < cl.indexOf("data-brief-ack") && cl.includes(">Mark changed brief read<"), cl.slice(0, 700));
  const cardRo = flat(createElement(ShootPrepCard, { projectId: "p-maple", lines, readOnly: true }));
  c.ok("in a preview: the lines and links, no ask, no Mark brief read", !cardRo.includes("data-ask") && !cardRo.includes("data-brief-ack") && cardRo.includes('href="#brief"'));
}

// ---- §B the data behind it ------------------------------------------------------------------
async function partB(c: ReturnType<typeof makeChecker>) {
  {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { buildCreativeDesk, frictionsFrom } = await import("@/lib/creativeDesk");
    const actions = await import("@/app/creativeDeskActions");
    const { askAboutShootAction } = await import("@/app/shoot/actions");
    const { etAt, etDayKey } = await import("@/lib/datetime");
    const T = new Date();
    const at = (ms: number) => new Date(T.getTime() + ms);
    const tomorrow = etDayKey(at(D));
    const today = etDayKey(T);

    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@jd.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true });
    const jamesTm = await tm("James Livingston", "PHOTOGRAPHER", { creativeManager: true, phone: "6105550133" });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER");
    const login = (name: string, email: string, role: string, teamMemberId: string | null) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await login("Jordan Spackman", "jordan@jd.invalid", "OWNER", jordanTm.id);
    await login("Kyle Smith", "kyle@jd.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@jd.invalid", "CREATIVE_MANAGER", jamesTm.id);
    await login("Harrison Wells", "harrison@jd.invalid", "PHOTOGRAPHER", harrisonTm.id);
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", teamMemberId: kyleTm.id, label: "Kyle Smith" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const me = async () => (await getCurrentUser())!;
    const client = await prisma.client.create({ data: { name: "Real Agent" } });
    const desc = ["Customer:", "Name: Real Agent", "", "Order Questions:", "- Lock Box / Door Code: 4321"].join("\n");
    const job = (title: string, extra: Record<string, unknown> = {}) => prisma.project.create({ data: { clientId: client.id, title, addressLine: title.split(",")[0], status: "SCHEDULED", photographerId: jamesTm.id, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] }, ...extra } });
    const visit = (projectId: string, start: Date, end: Date | null) => prisma.appointment.create({ data: { aryeoId: `a-${projectId}-${start.getTime()}`, projectId, startAt: start, endAt: end, status: "SCHEDULED", assignedToId: jamesTm.id, description: desc, rawJson: JSON.stringify({ items: [{ title: "Photos" }] }) } });

    // =====================================================================
    c.head("§B1 · filming is not a gap; the end of the visit is");
    // =====================================================================
    const startToday = (backMs: number) => new Date(Math.max(etAt(today, 0, 5).getTime(), T.getTime() - backMs));
    const pFilm = await job("1 Filming Way, Town");
    const vFilm = await visit(pFilm.id, startToday(30 * 60_000), at(3 * H));
    const pDay = await job("2 Full Day Rd, Town");
    const vDay = await visit(pDay.id, startToday(H), null);
    const pOver = await job("3 Ended Ct, Town");
    const overStart = startToday(3 * H);
    const vOver = await visit(pOver.id, overStart, new Date(Math.max(overStart.getTime() + 60_000, T.getTime() - 60_000)));
    const pBrief = await job("4 Brief Ln, Town");
    const vBrief = await visit(pBrief.id, etAt(tomorrow, 10), etAt(tomorrow, 12));
    const dayAfter = etDayKey(at(2 * D));
    const pAck = await job("5 Confirmed St, Town");
    const vAck = await visit(pAck.id, etAt(dayAfter, 14), etAt(dayAfter, 16));
    const pPast = await job("6 Past Pl, Town");
    await visit(pPast.id, at(-2 * D), at(-2 * D + 2 * H));
    const pDraft = await job("7 Draft Dr, Town");
    await visit(pDraft.id, at(-2 * D), at(-2 * D + 2 * H));
    await prisma.uploadDraft.create({ data: { projectId: pDraft.id, authorKey: "james", authorName: "James Livingston", savedAt: at(-D), payloadJson: "{}" } });
    // The shoot-day brief switched on; James's brief for today and tomorrow sent an hour ago (no Got it),
    // the day after's sent and acknowledged. The version each carries is the one his brief page shows.
    const pb = await import("@/lib/photographerBrief");
    const core = await import("@/lib/photographerBriefCore");
    await pb.savePhotographerBriefSettings({ enabled: true, sendMinute: 18 * 60 }, "jordan@jd.invalid");
    const sentRecord = async (day: string, acked: boolean) => {
      const b = (await pb.buildBriefDays([day], { now: T, teamMemberIds: [jamesTm.id] })).briefs.find((x) => x.teamMemberId === jamesTm.id && x.day === day);
      if (!b) throw new Error(`no brief for ${day}`);
      const sentAt = at(-H).toISOString();
      const rec = { ...core.emptyRecord(jamesTm.id, day), sent: { n: 1, at: sentAt, digest: b.digest, snapshot: b.material, outcome: "sent" as const }, firstSentAt: sentAt, ...(acked ? { ack: { at: sentAt, by: "James Livingston", userId: james.id, digest: b.digest, snapshot: b.material } } : {}) };
      await prisma.appSetting.create({ data: { key: pb.briefRecordKey(jamesTm.id, day), value: JSON.stringify(rec) } });
      return b.digest;
    };
    await sentRecord(today, false);
    const digestTomorrow = await sentRecord(tomorrow, false);
    await sentRecord(dayAfter, true);
    await signIn(james);
    let d = await buildCreativeDesk(await me(), { now: T });
    const row = (id: string) => d.production.mine.find((s) => s.id === id);
    const film = row(vFilm.id);
    c.ok("a visit under way: Filming now, nothing 'missing', no 'Nothing recorded', no Got it chase (it has begun)", !!film && film.started && !film.over && film.status?.label === "Filming now" && !film.chips.some((x) => x.key === "field") && !film.briefAck && film.missing.length === 0, JSON.stringify(film && { s: film.status, c: film.chips, m: film.missing }));
    const day = row(vDay.id);
    c.ok("a visit with no end time from Aryeo is not over until the day ends (a full-day session)", !!day && day.started && !day.over && !day.chips.some((x) => x.key === "field"), JSON.stringify(day && { over: day.over, end: day.endISO }));
    const over = row(vOver.id);
    c.ok("the visit's END passed with nothing recorded: 'Nothing recorded from the field yet', Handoff due, Finish handoff at the capture part", !!over && over.over && over.chips[0]?.label === "Nothing recorded from the field yet" && over.status?.label === "Handoff due" && over.finishHref === `/upload/${pOver.id}#capture`, JSON.stringify(over && { s: over.status, c: over.chips }));
    const br = row(vBrief.id);
    c.ok("a sent shoot-day brief for a visit ahead: one 'Mark brief read' with the day and the version Kyle's desk waits on; no 'Got it to tap' words", !!br && br.briefAck?.day === tomorrow && br.briefAck.digest === digestTomorrow && !br.briefAck.again && br.status?.label === "Brief to confirm" && br.missing.includes("Shoot-day brief to confirm") && !JSON.stringify(d.production).includes("Got it to tap"), JSON.stringify(br && { a: br.briefAck, s: br.status }));
    c.ok("…confirmed: a tick ('Brief confirmed'); off or not sent: nothing at all; never 'Shoot brief to read'", row(vAck.id)?.chips.some((x) => x.key === "brief" && x.label === "Brief confirmed" && x.tone === "ok") === true && !row(vDay.id)?.chips.some((x) => x.key === "brief") && !JSON.stringify(d.production).includes("Shoot brief to read") && !d.production.mine.some((s) => s.chips.some((x) => x.key === "read")));
    c.ok("no 'No shot list on the job', no 'No confirmation on file'", !/No shot list on the job|No confirmation on file/.test(JSON.stringify(d.production)));
    const { acknowledgePhotographerBrief } = await import("@/app/shoot/brief/actions");
    const ack = await acknowledgePhotographerBrief(br?.briefAck?.day ?? "", br?.briefAck?.digest ?? "");
    d = await buildCreativeDesk(await me(), { now: T });
    const brNow = row(vBrief.id);
    c.ok("Mark brief read (the action the button calls, with the row's day and version): recorded, and the row turns to 'Brief confirmed', nothing left to do", ack.ok && !brNow?.briefAck && brNow?.chips.some((x) => x.key === "brief" && x.label === "Brief confirmed") === true && brNow?.status?.label !== "Brief to confirm" && !brNow?.missing.length, `${ack.message} ${JSON.stringify(brNow && { a: brNow.briefAck, s: brNow.status, m: brNow.missing })}`);
    const hPast = d.production.handoffs.find((h) => h.projectId === pPast.id);
    const hDraft = d.production.handoffs.find((h) => h.projectId === pDraft.id);
    c.ok("own handoffs: nothing recorded goes to #capture; an upload started goes to #submit", hPast?.finishHref === `/upload/${pPast.id}#capture` && hDraft?.finishHref === `/upload/${pDraft.id}#submit`, JSON.stringify([hPast?.finishHref, hDraft?.finishHref]));
    c.ok("the full view's link is on the card's data", d.production.fullHref === "/production");
    const prodOnly = await buildCreativeDesk(await me(), { now: T, only: "production" });
    c.ok("/production reads only production (no review, team, prep, tasks)", prodOnly.production.mine.length === d.production.mine.length && prodOnly.team === null && prodOnly.prep.items.length === 0 && prodOnly.assigned.items.length === 0);

    // =====================================================================
    c.head("§B2 · a listing script: one line of detail, the job to add input on");
    // =====================================================================
    const pList = await job("8 Listing Ave, Town", { scriptingId: "studio-8", scriptingStatus: "awaiting_review", scriptingUrl: "https://studio.invalid/creative/8" });
    await visit(pList.id, etAt(tomorrow, 15), etAt(tomorrow, 17));
    d = await buildCreativeDesk(await me(), { now: T });
    const lr = d.prep.items.find((p) => p.key === `listing:${pList.id}`);
    c.ok("detail = when + where the script stands; projectId kept; Open script = Script Studio", !!lr && lr.projectId === pList.id && /^Shoot .+ · Script waiting on your review$/.test(lr.detail) && lr.links[0]?.label === "Open script" && lr.links[0]?.href === "https://studio.invalid/creative/8", JSON.stringify(lr && { d: lr.detail, l: lr.links }));

    // =====================================================================
    c.head("§B3 · his tasks, whichever engine routed them");
    // =====================================================================
    const brand = await prisma.smartTask.create({ data: { taskType: "todo", source: "system", status: "OPEN", title: "Confirm Kim has Real Agent's brand update", description: `Kim sees it as a banner on the brief (/edit/${pList.id}) until they press Got it.`, assignedKey: "james", clientId: client.id, dedupeKey: `brand-ack:${client.id}:1` } });
    const mid = await prisma.smartTask.create({ data: { taskType: "todo", source: "system", status: "OPEN", title: "Mid-month check: Real Agent", description: "Roll-over note and follow-up. Open /content/enr123?tab=plan to see the month.", ownerId: jamesTm.id, clientId: client.id, dueAt: at(D) } });
    const harrisons = await prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", title: "Harrison's own task", assignedKey: "harrison" } });
    d = await buildCreativeDesk(await me(), { now: T });
    const b = d.assigned.items.find((x) => x.taskId === brand.id);
    const m = d.assigned.items.find((x) => x.taskId === mid.id);
    c.ok("a brand update routed to him: listed, closes itself, links the edit brief the task names", !!b && b.closesItself && b.href === `/edit/${pList.id}` && !b.delegated, JSON.stringify(b));
    c.ok("a mid-month check on his Team row with no key: listed, linking the program page it names", !!m && m.href === "/content/enr123?tab=plan" && !m.closesItself, JSON.stringify(m));
    c.ok("someone else's task is not his", !d.assigned.items.some((x) => x.taskId === harrisons.id));
    c.ok("Delegate's list: the team, never a vendor, never himself", d.assigned.people.some((p) => p.key === "kyle") && d.assigned.people.some((p) => p.key === "harrison") && !d.assigned.people.some((p) => p.key === "james" || p.key === "autohdr" || p.key === "cubicasa"));
    const accept = await actions.myTaskStepAction(mid.id, "start");
    const midNow = await prisma.smartTask.findUniqueOrThrow({ where: { id: mid.id } });
    c.ok("Accept on the mid-month check: his (claimed by his key) and In progress", accept.ok && midNow.assignedKey === "james" && midNow.status === "IN_PROGRESS", accept.message);
    const brandDone = await actions.myTaskStepAction(brand.id, "done");
    c.ok("Done on a brand update is refused with the reason (it closes on the editors' Got it)", !brandDone.ok && /Got it/.test(brandDone.message) && (await prisma.smartTask.findUniqueOrThrow({ where: { id: brand.id } })).status === "OPEN", brandDone.message);
    c.ok("someone else's task, a bad step, a closed task: refused", !(await actions.myTaskStepAction(harrisons.id, "start")).ok && !(await actions.myTaskStepAction(mid.id, "nope" as never)).ok);
    const done = await actions.myTaskStepAction(mid.id, "done");
    c.ok("Done closes it", done.ok && (await prisma.smartTask.findUniqueOrThrow({ where: { id: mid.id } })).status === "COMPLETED", done.message);
    c.ok("…and a closed task takes no more steps", !(await actions.myTaskStepAction(mid.id, "start")).ok);
    const noWhy = await actions.handMyTaskAction(brand.id, "kyle", "");
    c.ok("handing a task over needs the reason", !noWhy.ok);
    const toVendor = await actions.handMyTaskAction(brand.id, "autohdr", "Please do it");
    c.ok("…and someone on the team (a vendor is refused)", !toVendor.ok);
    const hand = await actions.handMyTaskAction(brand.id, "kyle", "Kim is out today, can you confirm with John?");
    const handed = await prisma.smartTask.findUniqueOrThrow({ where: { id: brand.id } });
    c.ok("Hand to Kyle: Kyle's now, flagged by James, the reason on the task", hand.ok && handed.assignedKey === "kyle" && handed.flaggedBy === "James Livingston" && !!handed.flaggedAt && /Handed to Kyle by James Livingston .*Kim is out today/.test(handed.description ?? ""), `${hand.message} ${handed.assignedKey} ${handed.flaggedBy}`);
    c.ok("…and it has left his list", !(await buildCreativeDesk(await me(), { now: T })).assigned.items.some((x) => x.taskId === brand.id));

    // =====================================================================
    c.head("§B4 · Ask Kyle on the job chat; an improvement from a friction row");
    // =====================================================================
    const ask = await askAboutShootAction(pBrief.id, "kyle", "How do I get in, is anyone home?");
    const msg = await prisma.projectMessage.findFirst({ where: { projectId: pBrief.id }, orderBy: { createdAt: "desc" } });
    c.ok("Ask Kyle: his words on the job's team chat, Kyle tagged, said back to James", ask.ok && msg?.body === "@Kyle How do I get in, is anyone home?" && JSON.parse(msg?.mentions ?? "[]").includes(kyleTm.id) && /Asked Kyle/.test(ask.message), `${ask.message} ${msg?.body} ${msg?.mentions}`);
    c.ok("…an empty question is refused", !(await askAboutShootAction(pBrief.id, "kyle", " ")).ok);
    const fKey = "friction:kpi:upload";
    const started = await actions.addImprovementAction({ problem: "Shoot uploads land after their deadline", area: "Uploads and handoffs", nextStep: "Find where the time goes", friction: fKey });
    const again = await actions.addImprovementAction({ problem: "Shoot uploads land after their deadline", area: "Uploads and handoffs", friction: fKey });
    d = await buildCreativeDesk(await me(), { now: T });
    const impRow = d.improvements.items.find((i) => i.friction === fKey);
    c.ok("started from a friction row: one improvement task carrying the friction key; a second press tracks the same one", started.ok && again.ok && /Already tracked/.test(again.message) && d.improvements.items.filter((i) => i.friction === fKey).length === 1 && (await prisma.smartTask.count({ where: { taskType: "process_improvement" } })) === 1, `${started.message} / ${again.message}`);
    const linked = frictionsFrom([{ key: `field:${harrisonTm.id}:kpi:upload`, group: "FIELD", personId: harrisonTm.id, personName: "Harrison Wells", skill: "Upload timing", detail: "", source: "", examples: [], count: 4, countWords: "4 this period" }], d.improvements.items);
    c.ok("…and the friction row knows it is tracked (its task)", linked[0]?.taskId === impRow?.taskId && !!impRow);

    // =====================================================================
    c.head("§B5 · the owner's preview writes nothing");
    // =====================================================================
    await signIn(owner, james.id);
    const pv = [await actions.myTaskStepAction(brand.id, "start"), await actions.handMyTaskAction(brand.id, "jordan", "Please decide"), await actions.addImprovementAction({ problem: "A preview problem", area: "Shot lists" })];
    const askPv = await askAboutShootAction(pBrief.id, "jordan", "Preview question").then((r) => r, (e: Error) => ({ ok: false, message: e.message }));
    c.ok("Accept, hand over, log an improvement and Ask are all refused in the preview", pv.every((x) => !x.ok) && !askPv.ok && (await prisma.projectMessage.count({ where: { projectId: pBrief.id } })) === 1, [...pv, askPv].map((x) => x.message).join(" | "));
    c.ok("nothing left the box", fence.blocked.length === 0, fence.blocked.join(", "));
  }
}

async function main() {
  const c = makeChecker();
  // Booted first: the desk's module loads Prisma, so even §A's render imports wait for the drill database.
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7351), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-james-dashboard" } });
  const quiet = quietPrismaErrors();
  try {
    await partA(c);
    await partB(c);
  } finally { quiet.restore(); fence.restore(); await db.stop(); }
  c.summary();
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
