// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Jordan's Oct 27 2026 Loom, the page polish (Schedule, Client
// Activity, Coaching "Got it", Resources and SOPs, Settings).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-projects-pages.ts
//
//   S  Schedule: "they don't have to be so wide on the screen". The list sits in
//      one narrower column; the stage and the photographer keep fixed widths;
//      the Map view keeps the full width.
//   A  Client Activity: "this looks like s***. Active this week. The little pin
//      is here." Plain words for the health and the portal account, no colored
//      dots or plan pills, one list.
//   G  Coaching: "give him an option to acknowledge". Only the person a note is
//      about can say Got it (signed out, a preview, someone else and a missing
//      note are refused); the first time is kept, the note can change, it is
//      stored under its own prefix the coaching engine never reads, and nothing
//      is sent. The control draws a Got it button, or "You said Got it".
//   R  Resources and SOPs: "could be organized a little better". Categories
//      land in plain topics by who uses them, never dropped; the search box
//      matches every word.
//   T  Settings: "Team Permissions and Cover ... a little bit wider".
//
// ISOLATION: PGlite via the shared harness, every outbound call fenced. The
// live database is never opened.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker } from "./_harness";

installNextStubs();
const fence = fenceFetch();
const ROOT = path.resolve(__dirname, "..", "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** Code without its comments, so a dated comment quoting Jordan never trips a copy check. */
const code = (rel: string) => src(rel).replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const between = (s: string, from: string, to: string) => {
  const a = s.indexOf(from);
  const b = a < 0 ? -1 : s.indexOf(to, a + from.length);
  return a < 0 ? "" : s.slice(a, b < 0 ? undefined : b);
};

async function main() {
  const c = makeChecker();

  // ---- S: Schedule -------------------------------------------------------
  const schedule = code("src/app/schedule/page.tsx");
  const list = between(schedule, "async function ListView", "async function MapView");
  const map = between(schedule, "async function MapView", "\nexport default");
  c.ok("S1 the list sits in one narrower centred column", /className="mx-auto max-w-3xl[^"]*"\s+data-schedule-list/.test(list));
  c.ok("S2 stage and photographer keep fixed widths beside the address (both assigned and Unassigned)", (list.match(/sm:w-24/g) ?? []).length >= 3);
  c.ok("S3 the stage stays visible on a phone (no hidden wrapper)", !/hidden[^"]*sm:block[^"]*">\s*<Badge/.test(list));
  c.ok("S4 the Map view is not narrowed", map.length > 0 && !/max-w-3xl/.test(map));

  // ---- A: Client Activity ------------------------------------------------
  const activity = code("src/app/content/activity/page.tsx");
  c.ok("A1 no plan pill or Badge component on the page", !/<PkgChip\b/.test(activity) && !/<Badge\b/.test(activity) && !/import\s*\{[^}]*\b(Badge|PkgChip)\b[^}]*\}/.test(activity));
  c.ok("A2 filter chips carry no colored dot", !/rounded-full[^"]*size-2|size-2[^"]*rounded-full/.test(between(activity, "function Chip", "\n}\n")));
  c.ok("A3 health reads as plain colored words in one status line", /data-health=\{r\.health\}/.test(activity) && /color: ink\(h\.color\)/.test(activity));
  c.ok("A4 the portal account reads as words", /No portal account/.test(activity) && /Invited to the portal/.test(activity) && /Signed up to the portal/.test(activity));
  c.ok("A5 one list of clients", /data-client-rows/.test(activity) && /data-client-row=\{r\.clientId\}/.test(activity));
  c.ok("A6 no em dash in the page's copy", !activity.includes("—"));

  // ---- R: Resources and SOPs (pure) ---------------------------------------
  const { resourceTopicOf, matchesSearch, RESOURCE_TOPICS } = await import("@/app/resources/topics");
  const typed: [string, string][] = [
    ["Scheduling & Booking", "office"], ["Client Care", "office"], ["Pricing & Fees", "office"], ["Problem Handling", "office"],
    ["Communication", "office"], ["Sales", "office"], ["Booking & Calls", "office"],
    ["On-Site / Shooting", "field"], ["Shooting", "field"],
    ["Editing & Delivery", "editing"], ["Editing", "editing"], ["Delivery", "editing"], ["Brand Assets", "editing"],
    ["Tools", "tools"], ["", "other"], ["Misc", "other"],
  ];
  const wrong = typed.filter(([cat, want]) => resourceTopicOf(cat) !== want).map(([cat]) => `${cat} → ${resourceTopicOf(cat)}`);
  c.ok("R1 every typed category lands in its plain topic", wrong.length === 0, wrong.join("; "));
  c.ok("R2 an unknown or blank category lands in Everything else, never dropped", resourceTopicOf(null) === "other" && RESOURCE_TOPICS.some((t) => t.key === "other" && t.title === "Everything else"));
  c.ok("R3 topic titles are plain headings", RESOURCE_TOPICS.map((t) => t.title).join("|") === "Booking, clients and messages|Shooting|Editing and delivery|Tools and logins|Everything else");
  c.ok("R4 search matches every word, any order, any case", matchesSearch("drone checklist before the shoot", "Shoot  DRONE") && !matchesSearch("drone checklist", "drone twilight") && matchesSearch("anything", "   "));
  const resources = code("src/app/resources/page.tsx");
  c.ok("R5 creatives still get the SOP Center, money SOPs filtered", /creative \? "SOP Center"/.test(resources) && /allSops\.filter\(creativeSafeSop\)/.test(resources) && /creative \? \[\] : allResources/.test(resources) && /creative \? \[\] : orderForms/.test(resources));
  c.ok("R6 the page has the search box around the topic sections", /<ResourceSearch\b/.test(resources) && /data-search-group=\{t\.key\}/.test(resources) && /data-search=\{searchText\(/.test(resources));
  c.ok("R7 the Video Style Guide link is unchanged", /href="\/resources\/video-styles"/.test(resources));
  c.ok("R8 no em dash in the new copy", ["src/app/resources/page.tsx", "src/app/resources/topics.ts", "src/app/resources/ResourceSearch.tsx"].every((f) => !code(f).includes("—")));

  // ---- T: Settings -------------------------------------------------------
  const settings = code("src/app/settings/page.tsx");
  c.ok("T1 the Settings page is wider (max-w-7xl)", /className="mx-auto min-w-0 max-w-7xl[^"]*"\s+data-settings-page/.test(settings) && !/max-w-6xl/.test(settings));
  c.ok("T2 the overview tiles stay two per row (no squeezed third column)", /className="grid gap-3 md:grid-cols-2"\s+data-settings-tiles/.test(settings) && !/2xl:grid-cols-3/.test(settings));

  // ---- G: Coaching "Got it" (pure) ----------------------------------------
  const ackLib = await import("@/lib/coachingAck");
  const { cleanAckNote, parseAck, validAckTarget, ackWords, coachingAckKey, COACHING_ACK_PREFIX, ACK_NOTE_MAX } = ackLib;
  c.ok("G1 the ack prefix is its own (the engine's list never reads it)", COACHING_ACK_PREFIX === "coaching-ack:" && !COACHING_ACK_PREFIX.startsWith("comms-coaching:") && coachingAckKey("tm_kyle01", "2026-10-27") === "coaching-ack:tm_kyle01:2026-10-27");
  c.ok("G2 a note is trimmed, one space between words, capped, null when empty", cleanAckNote("  will   call\nback  ") === "will call back" && cleanAckNote("   ") === null && cleanAckNote(42) === null && cleanAckNote("x".repeat(900))?.length === ACK_NOTE_MAX);
  c.ok("G3 targets are checked before any read", validAckTarget("tm_kyle01", "2026-10-27") && !validAckTarget("tm_kyle01", "Oct 27") && !validAckTarget("a b", "2026-10-27") && !validAckTarget(undefined, "2026-10-27"));
  c.ok("G4 a broken stored row reads as not acknowledged", parseAck("{nope") === null && parseAck(JSON.stringify({ teamMemberId: "x" })) === null && parseAck(null) === null);
  c.ok("G5 Jordan's line: whether, and when in Eastern time", ackWords(null, "Kyle Smith") === "Kyle has not said Got it yet." && /^Kyle said Got it .+ ET\.$/.test(ackWords({ teamMemberId: "tm_kyle01", dayKey: "2026-10-27", by: "Kyle", byEmail: "", at: "2026-10-27T20:12:00.000Z", note: null, noteAt: null }, "Kyle Smith")));
  const coachingCode = code("src/app/coaching/page.tsx");
  c.ok("G6 owner view shows each note's Got it line and the trend counts them", /footer=\{<AckLine audit=\{a\} acks=\{acks\} \/>\}/.test(coachingCode) && /Got it on \$\{t\.gotIt\} of \$\{t\.days\}/.test(coachingCode));
  c.ok("G7 no em dash in the new coaching copy", ["src/lib/coachingAck.ts", "src/app/coaching/actions.ts", "src/components/coaching/AckControl.tsx"].every((f) => !code(f).includes("—")) && !between(coachingCode, "function AckLine", "\n}\n").includes("—"));
  c.ok("G8 the action sends nothing (no message, mail or text helper imported)", !/sendSms|sendEmail|sendText|openphone|quo|resend|notify/i.test(src("src/app/coaching/actions.ts").replace(/\/\/.*$/gm, "")));

  // ---- G: the real action on an isolated database --------------------------
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5629), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct27-loom-pages-isolated-secret" } });
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { acknowledgeCoachingNote } = await import("@/app/coaching/actions");
    const { listCoachingAudits, coachingAuditKey } = await import("@/lib/commsCoaching");
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Drill", email: "kyle-oct27@example.test", role: "ADMIN" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Drill", email: "james-oct27@example.test", role: "PHOTOGRAPHER" } });
    const kyle = await prisma.appUser.create({ data: { email: "kyle-oct27@example.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    const owner = await prisma.appUser.create({ data: { email: "owner-oct27@example.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const day = "2026-10-27";
    const audit = (tm: { id: string; name: string }) => ({ version: 1, teamMemberId: tm.id, personName: tm.name, dayKey: day, generatedAt: "2026-10-27T22:00:00.000Z", messagesConsidered: 4, messagesAnalysed: 4, threadsAnalysed: 2, droppedForCap: 0, notes: [] });
    const kyleAuditValue = JSON.stringify(audit(kyleTm));
    await prisma.appSetting.create({ data: { key: coachingAuditKey(kyleTm.id, day), value: kyleAuditValue } });
    await prisma.appSetting.create({ data: { key: coachingAuditKey(jamesTm.id, day), value: JSON.stringify(audit(jamesTm)) } });
    const ackRow = () => prisma.appSetting.findUnique({ where: { key: coachingAckKey(kyleTm.id, day) } });
    const refused = (r: { ok: boolean; message?: string }, re: RegExp) => !r.ok && re.test(r.message ?? "");

    await clearSession();
    c.ok("G9 signed out is refused", refused(await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: day }), /sign in/) && (await ackRow()) === null);
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: kyle.id });
    c.ok("G10 a preview (view as Kyle) is refused", refused(await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: day }), /previewing another user/) && (await ackRow()) === null);
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    c.ok("G11 Jordan cannot press it for Kyle", refused(await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: day }), /Only the person/) && (await ackRow()) === null);
    await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
    c.ok("G12 Kyle cannot press it on someone else's note", refused(await acknowledgeCoachingNote({ teamMemberId: jamesTm.id, dayKey: day }), /Only the person/) && (await prisma.appSetting.count({ where: { key: { startsWith: COACHING_ACK_PREFIX } } })) === 0);
    c.ok("G13 a bad day or a day with no note is refused", refused(await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: "yesterday" }), /could not be found/) && refused(await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: "2026-10-20" }), /could not be found/));
    const first = await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: day });
    const row1 = parseAck((await ackRow())?.value);
    c.ok("G14 Kyle's Got it is saved under the ack key with Kyle's login name and no note", first.ok && row1?.by === "Kyle" && row1.byEmail === kyle.email && row1.note === null && row1.noteAt === null && (await ackRow())?.updatedBy === kyle.email);
    c.ok("G15 the coaching note itself is untouched and the engine's list still sees one note for Kyle", (await prisma.appSetting.findUnique({ where: { key: coachingAuditKey(kyleTm.id, day) } }))?.value === kyleAuditValue && (await listCoachingAudits({ teamMemberId: kyleTm.id })).length === 1);
    await new Promise((r) => setTimeout(r, 15));
    const second = await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: day, note: "  Will call   back first next time " });
    const row2 = parseAck((await ackRow())?.value);
    c.ok("G16 adding a note keeps the first time and records when the note changed", second.ok && row2?.at === row1?.at && row2?.note === "Will call back first next time" && !!row2?.noteAt && row2.noteAt !== row1?.at);
    const long = await acknowledgeCoachingNote({ teamMemberId: kyleTm.id, dayKey: day, note: "y".repeat(2000) });
    c.ok("G17 a long note is capped", long.ok && parseAck((await ackRow())?.value)?.note?.length === ACK_NOTE_MAX && (await prisma.appSetting.count({ where: { key: { startsWith: COACHING_ACK_PREFIX } } })) === 1);

    // The control the person sees (rendered with the real client module).
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AckControl } = await import("@/components/coaching/AckControl");
    const open = renderToStaticMarkup(createElement(AckControl, { teamMemberId: kyleTm.id, dayKey: day, initial: null, atWords: null }));
    const done = renderToStaticMarkup(createElement(AckControl, { teamMemberId: kyleTm.id, dayKey: day, initial: row2, atWords: "Mon, Oct 27, 4:12 PM ET" }));
    const preview = renderToStaticMarkup(createElement(AckControl, { teamMemberId: kyleTm.id, dayKey: day, initial: null, atWords: null, readOnly: true }));
    c.ok("G18 not yet pressed: a Got it button and an optional note", /data-coaching-ack="open"/.test(open) && />Got it</.test(open) && /Add a note \(optional\)/.test(open));
    c.ok("G19 pressed: says when, shows the note, can change it", /data-coaching-ack="done"/.test(done) && /You said Got it.*Mon, Oct 27, 4:12 PM ET/.test(done) && /Your note: Will call back first next time/.test(done) && /Change your note/.test(done));
    c.ok("G20 in a preview the button is disabled and no note link is offered", /disabled=""/.test(preview) && !/Add a note/.test(preview));
    c.ok("G21 nothing left the isolated fixture", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    fence.restore();
    await db.stop();
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
