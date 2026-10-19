// ---------------------------------------------------------------------------
// DRILL: THE SPECIAL REQUESTS, TEXTED AT THE SHOOT + TODAY'S SHOOTS CARD
// (Oct 19 2026). Jordan: "This should be on the home screen too, and if there
// is a special request, make sure we text the creative the special request on
// the day of the appointment at the appointment start time."
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct19-shoot-day-text.ts
//
// Isolated PGlite; fetch and raw sockets fenced; OpenPhone answered in-process
// (every text recorded). The clock is pinned to Mon Oct 19 2026 (EDT).
//
//   1. The words: access and who's-there sentences out, the office's lines,
//      the client's open asks, figures scrubbed, no dashes, the shape.
//   2. At the start, not before, once (twin ticks, later ticks), still inside
//      the half hour after a missed tick, never after it.
//   3. The right creative(s): the photographer and the videographer on their
//      own appointments; one text per job per person per day.
//   4. Nothing special, a cancelled or postponed appointment, a cancelled job,
//      a test client, no phone, our own office line: no text.
//   5. The switch: off sends nothing (and a send inside the window still goes
//      once it is back on); the timeline line; the drained-row bookkeeping.
//   6. Today's shoots card (components/home/TodaysShoots): Kyle (no figures)
//      and Jordan (owner) both get it, open; "No shoots today" on an empty day;
//      the render writes nothing.
//   7. The fence held: only the creatives were texted, nothing to Slack.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6743);
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ---------------------------------------------------------------
const RealDate = Date;
const ET_PARTS = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
function et(y: number, mo: number, d: number, h: number, mi = 0): Date {
  for (const off of [4, 5]) {
    const t = new RealDate(RealDate.UTC(y, mo - 1, d, h + off, mi));
    const p = Object.fromEntries(ET_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
    if (+p.year === y && +p.month === mo && +p.day === d && +p.hour === h && +p.minute === mi) return t;
  }
  throw new Error(`no such ET wall time ${y}-${mo}-${d} ${h}:${mi}`);
}
let offset = et(2026, 10, 19, 8).getTime() - RealDate.now();
const setNow = (d: Date) => { offset = d.getTime() - RealDate.now(); return d; };
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
const MON = (h: number, mi = 0) => et(2026, 10, 19, h, mi);
const TUE = (h: number, mi = 0) => et(2026, 10, 20, h, mi);
const SUN = (h: number, mi = 0) => et(2026, 10, 25, h, mi);
/** a sweep a few seconds after a wall time (the proxied clock keeps ticking) */
const past = (d: Date) => new RealDate(d.getTime() + 20_000);

installNextStubs();
const fence = fenceFetch(() => null); // nothing outbound is allowed at all
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct19-shoot-day-text" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { putSetting, internalAlertRules } = await import("@/lib/settings");
    const { setSession } = await import("@/lib/auth/session");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string; at: Date }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to), body, at: new Date() });
      return { data: { id: `op-${texts.length}` } };
    };
    const sdt = await import("@/lib/shootDayText");
    const { HUB_SMS_PREFIX } = await import("@/lib/hubSms");
    const { TodaysShoots } = await import("@/components/home/TodaysShoots");

    // =====================================================================
    c.head("1 · The words (pure)");
    // =====================================================================
    const brief = (special: string, extra = "") =>
      `Customer:\nName: Logan Hartzell\nEmail: logan@clients.invalid\n\nOrder Questions:\n - Lock Box / Door Code: 5636\n - Additional information to access the property: Side door, key under the mat\n - Special Instructions for the photographer (for this property only): ${special}\n - Will you or the seller be present at the appointment?: Agent\n${extra}\nOr View Full Order Details`;
    const reqs = sdt.shootDayRequests({
      brief: brief("Basement floor has stains on it, may not be painted in time. The gate code is 4417. Please take a pic of the Liberty Knoll sign at entrance. The seller will be home until noon."),
      jobLines: [
        "Shoot the community pool too, $50 add-on paid",
        "Client access note (openphone): lockbox moved to the side door",
        "Client request (openphone): a few things may still be in the basement",
        "Alarm code is 2211",
      ],
      clientAsks: [{ summary: "A few things may still be in the basement", text: "there may still be a few things in the basement" }, { summary: "", text: "Use the upbeat song — the one from last time" }],
    });
    c.ok("order instructions kept as written, the gate code and who's home taken out sentence by sentence", reqs[0] === "Basement floor has stains on it, may not be painted in time. Please take a pic of the Liberty Knoll sign at entrance.", reqs[0]);
    c.ok("the lockbox, the access field and the presence answer never appear", !reqs.join(" ").match(/5636|4417|2211|key under|Side door|Agent\b|home until/i), reqs.join(" | "));
    c.ok("the office's line, figures scrubbed", reqs.includes("Shoot the community pool too, [amount] add-on paid."), reqs.join(" | "));
    c.ok("the client's access note and the 'Client request' copy are left to the shoot screen and the ask", !reqs.some((r) => /side door|Client request/i.test(r)));
    c.ok("the client's open asks, prefixed 'Client:', the summary when there is one, no dashes", reqs.includes("Client: A few things may still be in the basement.") && reqs.some((r) => r.startsWith("Client: Use the upbeat song") && !DASH.test(r)), reqs.join(" | "));
    c.ok("nothing special → nothing to say", sdt.shootDayRequests({ brief: brief("n/a"), jobLines: ["The lockbox code is 1234"], clientAsks: [] }).length === 0);
    const sample = sdt.composeShootDayText({ street: "104 Carlton Ct", startAt: MON(14, 30), requests: ["Take a photo of the Liberty Knoll sign at the entrance.", "Client: a few things may still be in the basement."], link: "https://hub.example/shoot/p1" });
    console.log(`\n--- the shape ---\n${sample}\n---`);
    c.ok("the message's shape", sample === `${HUB_SMS_PREFIX}: 104 Carlton Ct, 2:30 PM. Special requests for this shoot: 1) Take a photo of the Liberty Knoll sign at the entrance. 2) Client: a few things may still be in the basement. Shoot screen: https://hub.example/shoot/p1`, sample);
    c.ok("live appointments: cancelled and postponed (UNSCHEDULED) are not", sdt.liveAppointment({ status: "SCHEDULED", startAt: MON(9) }) && !sdt.liveAppointment({ status: "CANCELED", startAt: MON(9) }) && !sdt.liveAppointment({ status: "UNSCHEDULED", startAt: MON(9) }) && !sdt.liveAppointment({ status: "SCHEDULED", startAt: null }));

    // =====================================================================
    c.head("2 · The world");
    // =====================================================================
    const member = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER" | "EDITOR", phone: string | null, slackId: string | null = null) =>
      prisma.teamMember.create({ data: { name, email, role, phone, slackId, active: true }, select: { id: true, name: true } });
    const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144", "U0HARRISON");
    const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133");
    const kim = await member("Kim Miguel", "kim@drill.invalid", "EDITOR", null);
    const kyleTm = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE);
    const jordanTm = await member("Jordan Spackman", "info@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111");
    const user = (email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId } });
    const uKyle = await user("kyle@drill.invalid", "ADMIN", kyleTm.id);
    const uJordan = await user("info@drill.invalid", "OWNER", jordanTm.id);
    const real = await prisma.client.create({ data: { name: "Logan Hartzell", phone: "6105550301" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", phone: "6105550302" } });
    let n = 0;
    const job = async (street: string, start: Date, appts: { who: string | null; at?: Date; status?: string }[], extra: { special?: string; clientId?: string; status?: string; photographerId?: string | null } = {}) => {
      const p = await prisma.project.create({
        data: {
          title: `${street}, Town, PA`, addressLine: street, clientId: extra.clientId ?? real.id, status: (extra.status ?? "SCHEDULED") as never, shootDate: start,
          photographerId: extra.photographerId === undefined ? appts[0]?.who ?? null : extra.photographerId,
          deliverables: { create: [{ type: "PHOTOS", label: "Photos", quantity: 1 }] },
        },
      });
      for (const a of appts) {
        await prisma.appointment.create({ data: { aryeoId: `appt-${++n}`, projectId: p.id, startAt: a.at ?? start, endAt: new Date((a.at ?? start).getTime() + 90 * 60_000), status: a.status ?? "SCHEDULED", assignedToId: a.who, description: extra.special === undefined ? null : brief(extra.special) } });
      }
      return p;
    };
    // 104 Carlton Ct: Harrison (photos) and James (video) at 2:30, Harrison back at 6:30 for twilight.
    const carlton = await job("104 Carlton Ct", MON(14, 30), [{ who: harrison.id }, { who: james.id }, { who: harrison.id, at: MON(18, 30) }], { special: "Basement floor has stains on it, may not be painted in time. Please take a pic of the Liberty Knoll sign at entrance. The gate code is 4417." });
    await prisma.activity.create({ data: { projectId: carlton.id, type: "SPECIAL_REQUEST", body: "Shoot the community pool too, $50 add-on paid" } });
    await prisma.activity.create({ data: { projectId: carlton.id, type: "SPECIAL_REQUEST", body: "Client access note (openphone): lockbox moved to the side door" } });
    await prisma.activity.create({ data: { projectId: carlton.id, type: "SPECIAL_REQUEST", body: "Client request (openphone): a few things may still be in the basement" } });
    const ask = (projectId: string, data: Record<string, unknown>) => prisma.clientAsk.create({ data: { clientId: real.id, projectId, kind: "SPECIAL_REQUEST", medium: "photo", source: "text", askedAt: MON(7), text: "x", ...data } as never });
    await ask(carlton.id, { summary: "A few things may still be in the basement", text: "there may still be a few things in the basement", medium: "both" });
    await ask(carlton.id, { summary: "Old ask, already checked", state: "CONFIRMED" });
    await ask(carlton.id, { kind: "SCHEDULING", medium: null, summary: "Move Friday's shoot" });
    await ask(carlton.id, { summary: "An order note (no longer an ask)", source: "order_note" });
    // Nothing special: access only.
    const plain = await job("7 Plain St", MON(10), [{ who: harrison.id }], { special: "n/a" });
    // Cancelled, postponed, cancelled job, test client: all with real requests.
    const cancelledAppt = await job("11 Cancel Ct", MON(11), [{ who: harrison.id, status: "CANCELED" }], { special: "Get the barn." });
    const postponed = await job("12 Later Ln", MON(11), [{ who: harrison.id, status: "UNSCHEDULED" }], { special: "Get the barn." });
    const deadJob = await job("13 Dead End", MON(11), [{ who: harrison.id }], { special: "Get the barn.", status: "CANCELLED" });
    const testJob = await job("14 Test Rd", MON(11), [{ who: harrison.id }], { special: "Get the barn.", clientId: fixture.id });
    // No phone (Kim) and our own office line (Kyle on the roster with it).
    const kimJob = await job("15 Kim Way", MON(12), [{ who: kim.id }], { special: "Get the pond." });
    const kyleJob = await job("16 Office Pl", MON(12), [{ who: kyleTm.id }], { special: "Get the pond." });
    // A missed tick (first look 20 minutes in) and a dead cron (first look 31 minutes in).
    const missed = await job("17 Missed Tick Rd", MON(12), [{ who: harrison.id }], { special: "Get the dock." });
    const tooLate = await job("18 Too Late Rd", MON(12, 30), [{ who: james.id }], { special: "Get the dock." });
    // Tuesday: the switch.
    const tueOn = await job("20 Switch Ave", TUE(9), [{ who: harrison.id }], { special: "Get the orchard." });
    const tueOff = await job("21 Off Ave", TUE(10), [{ who: harrison.id }], { special: "Get the orchard." });
    c.ok("the world is built", true);

    const textsTo = (digits: string) => texts.filter((t) => t.to.replace(/\D/g, "").endsWith(digits));
    const about = (street: string) => texts.filter((t) => t.body.includes(street));
    const sweep = (at: Date) => sdt.sweepShootDayTexts(setNow(at));

    // =====================================================================
    c.head("2 · At the start, not before, once");
    // =====================================================================
    c.ok("the switch is ON by default (no settings row)", (await internalAlertRules()).shootDayText.enabled === true);
    await sweep(MON(14, 25));
    c.ok("2:25 PM, five minutes before: nothing for 104 Carlton Ct", about("104 Carlton Ct").length === 0);
    await Promise.all([sweep(past(MON(14, 30))), sdt.sweepShootDayTexts(past(MON(14, 30)))]);
    const carltonTexts = about("104 Carlton Ct");
    c.ok("2:30 PM (two ticks at once): ONE text to Harrison and ONE to James", textsTo("6105550144").filter((t) => t.body.includes("104 Carlton Ct")).length === 1 && textsTo("6105550133").filter((t) => t.body.includes("104 Carlton Ct")).length === 1 && carltonTexts.length === 2, carltonTexts.map((t) => t.to).join(","));
    await sweep(MON(14, 35));
    await sweep(MON(14, 55));
    await sweep(MON(15, 5));
    c.ok("2:35, 2:55 and 3:05 add none", about("104 Carlton Ct").length === 2);
    await sweep(past(MON(18, 30)));
    c.ok("Harrison's 6:30 twilight visit to the same job: no second text that day", textsTo("6105550144").filter((t) => t.body.includes("104 Carlton Ct")).length === 1);
    const h = carltonTexts.find((t) => t.to.endsWith("6105550144"))?.body ?? "";
    console.log(`\n--- Harrison's text ---\n${h}\n---`);
    c.ok("from the company line as a hub text, the address and the start time first", h.startsWith(`${HUB_SMS_PREFIX}: 104 Carlton Ct, 2:30 PM. Special requests for this shoot: 1) `), h.slice(0, 120));
    c.ok("…the order's instructions, the office's line (no figures), the client's open ask", h.includes("1) Basement floor has stains on it, may not be painted in time. Please take a pic of the Liberty Knoll sign at entrance.") && h.includes("2) Shoot the community pool too, [amount] add-on paid.") && h.includes("3) Client: A few things may still be in the basement."));
    c.ok("…no codes, no access, no who's there, no closed or no-longer-filed asks, no scheduling", !/5636|4417|key under|side door|Agent|Old ask|order note|Friday/i.test(h));
    c.ok("…the shoot screen link last; no dashes; no money", h.endsWith(`Shoot screen: ${(await import("@/lib/appUrl")).appBase()}/shoot/${carlton.id}`) && !DASH.test(h) && !/\$\d/.test(h), h.slice(-80));
    c.ok("James's text says the same", carltonTexts.find((t) => t.to.endsWith("6105550133"))?.body === h);
    const rows = await prisma.outboxMessage.findMany({ where: { projectId: carlton.id } });
    c.ok("through the durable outbox: two accepted shoot_day rows, keyed per job, creative and day, no client on them", rows.length === 2 && rows.every((r) => r.state === "accepted" && r.clientId === null && r.dedupeKey?.startsWith(`shoot_day:${carlton.id}:`) && r.dedupeKey.endsWith(":2026-10-19")), rows.map((r) => `${r.state} ${r.dedupeKey}`).join(" | "));
    const line = await prisma.activity.findMany({ where: { projectId: carlton.id, type: "SYSTEM" }, orderBy: { body: "asc" } });
    c.ok("one timeline line per creative: 'Texted Harrison the special requests at 2:30 PM.'", line.length === 2 && line.map((l) => l.body).join(" | ") === "Texted Harrison the special requests at 2:30 PM. | Texted James the special requests at 2:30 PM.", line.map((l) => l.body).join(" | "));
    c.ok("a text, not Slack, even for Harrison who has a Slack id", fence.faked.length === 0 && fence.blocked.length === 0);
    c.ok("the People page's delivery log has it", (await prisma.notificationDelivery.count({ where: { kind: "shoot_day_text", teamMemberId: harrison.id, channel: "sms", status: "sent" } })) === 1);

    // =====================================================================
    c.head("3 · Who never gets one");
    // =====================================================================
    await sweep(past(MON(10)));
    c.ok("7 Plain St: access only, nothing special → no text", about("7 Plain St").length === 0);
    const r11 = await sweep(past(MON(11)));
    c.ok("cancelled appointment, postponed appointment, cancelled job, test client → no text", [cancelledAppt, postponed, deadJob, testJob].every((p) => about(p.addressLine!).length === 0), JSON.stringify(r11));
    const r12 = await sweep(past(MON(12)));
    c.ok("Kim has no phone: no text, said so in the run", about("15 Kim Way").length === 0 && "notSent" in r12 && r12.notSent.some((s) => s.includes("15 Kim Way") && s.includes("no phone")), JSON.stringify(r12));
    c.ok("Kyle's roster number is our own office line: never texted", about("16 Office Pl").length === 0 && "notSent" in r12 && r12.notSent.some((s) => s.includes("16 Office Pl") && s.includes("own office line")));
    c.ok("17 Missed Tick Rd: the 12:00 tick carried it, one text", about("17 Missed Tick Rd").length === 1);
    void kimJob; void kyleJob; void plain;

    // A missed tick: the first look at 18 Too Late Rd is 31 minutes after its 12:30 start.
    await sweep(MON(13, 1));
    c.ok("a first look 31 minutes after the start: outside the window, no text", about("18 Too Late Rd").length === 0);
    // And inside the window after missed ticks: a fresh job, first look 20 minutes in.
    const late20 = await job("19 Slow Cron St", MON(13, 0), [{ who: james.id }], { special: "Get the gazebo." });
    await sweep(MON(13, 20));
    c.ok("a first look 20 minutes after the start: still inside the window, it goes", about("19 Slow Cron St").length === 1);
    void late20; void tooLate; void missed;

    // =====================================================================
    c.head("4 · The switch, and the outbox's recovery path");
    // =====================================================================
    await putSetting("internal_alerts", { shootDayText: { enabled: false } });
    c.ok("Settings can switch it off", (await internalAlertRules()).shootDayText.enabled === false);
    const off = await sweep(past(TUE(9)));
    c.ok("switched off at 9:00: nothing, and the run says why", about("20 Switch Ave").length === 0 && "skipped" in off && /switched off/.test(off.skipped));
    await putSetting("internal_alerts", { shootDayText: { enabled: true } });
    await sweep(TUE(9, 10));
    c.ok("back on at 9:10, still inside the window: it goes, once", about("20 Switch Ave").length === 1);
    await putSetting("internal_alerts", { shootDayText: { enabled: false } });
    for (const at of [past(TUE(10)), TUE(10, 15), TUE(10, 29)]) await sweep(at);
    await putSetting("internal_alerts", { shootDayText: { enabled: true } });
    await sweep(TUE(10, 31));
    c.ok("off for the whole half hour: never sent, not even when switched back on later", about("21 Off Ave").length === 0);
    void tueOn; void tueOff;
    const card = fs.readFileSync(path.join(REPO, "src/components/settings/OperatingRules.tsx"), "utf8");
    c.ok("the switch is on the Internal alerts card, beside the night-before brief", /label="Night-before shoot brief"[\s\S]{0,1200}label="Special requests at the shoot"/.test(card) && card.includes("r.shootDayText.enabled"));
    const route = fs.readFileSync(path.join(REPO, "src/app/api/cron/gmail/route.ts"), "utf8");
    c.ok("the 5-minute comms cron runs it, and its recovery path writes the timeline line", /step\("shootDayText"[\s\S]{0,200}sweepShootDayTexts\(\)/.test(route) && route.includes("recordDrainedShootDayText") && route.includes(`kind === "shoot_day"`));
    const { shootDayKey, outboxKind } = await import("@/lib/outbox");
    const drainedKey = shootDayKey(tueOff.id, harrison.id, "2026-10-20");
    c.ok("the kind is a team kind (never held to the client hours)", outboxKind(drainedKey) === "shoot_day" && !(await import("@/lib/outbox")).isClientKind("shoot_day"));
    const note = await sdt.recordDrainedShootDayText({ dedupeKey: drainedKey }, "op-x");
    c.ok("a drained shoot-day text gets its timeline line", !!note && (await prisma.activity.count({ where: { projectId: tueOff.id, type: "SYSTEM", body: { startsWith: "Texted Harrison the special requests at" } } })) === 1, note ?? "");

    // =====================================================================
    c.head("5 · Today's shoots card, for Kyle and for Jordan");
    // =====================================================================
    setNow(MON(9));
    const counts = async () => JSON.stringify(await Promise.all([prisma.activity.count(), prisma.outboxMessage.count(), prisma.smartTask.count(), prisma.appSetting.count(), prisma.notificationDelivery.count()]));
    const before = await counts();
    await setSession({ uid: uKyle.id, email: uKyle.email, role: uKyle.role });
    const kyleEl = (await TodaysShoots()) as ReactElement<{ id: string; defaultOpen: boolean }>;
    const kyleHtml = renderToStaticMarkup(kyleEl);
    const nameOf = (el: unknown) => (isValidElement(el) && typeof el.type === "function" ? (el.type as { name?: string }).name : null);
    c.ok("Kyle: the Today's shoots card, open (shoots today), anchored #todays-shoots", nameOf(kyleEl) === "DayBlock" && kyleEl.props.defaultOpen === true && kyleEl.props.id === "todays-shoots" && kyleHtml.includes("Today’s shoots"), nameOf(kyleEl) ?? "");
    c.ok("…every live job today with its card (address, creative, special requests), never the test client's or the cancelled job's", ["104 Carlton Ct", "7 Plain St", "17 Missed Tick Rd", "Harrison Wells"].every((s) => kyleHtml.includes(s)) && !kyleHtml.includes("14 Test Rd") && !kyleHtml.includes("13 Dead End"));
    c.ok("…no figures on Kyle's card", kyleHtml.includes("[amount]") && !kyleHtml.includes("$50"));
    c.ok("…the week ahead strip under it", kyleHtml.includes("This week"));
    await setSession({ uid: uJordan.id, email: uJordan.email, role: uJordan.role });
    const jordanHtml = renderToStaticMarkup((await TodaysShoots()) as ReactElement);
    c.ok("Jordan (owner): the same card, figures shown", jordanHtml.includes("Today’s shoots") && jordanHtml.includes("104 Carlton Ct") && jordanHtml.includes("$50"));
    c.ok("…test records only when asked", !jordanHtml.includes("14 Test Rd") && renderToStaticMarkup((await TodaysShoots({ includeTest: true })) as ReactElement).includes("14 Test Rd"));
    setNow(SUN(9));
    const emptyEl = (await TodaysShoots()) as ReactElement;
    const emptyHtml = renderToStaticMarkup(emptyEl);
    c.ok("a day with no shoots: one line, 'No shoots today'", nameOf(emptyEl) !== "DayBlock" && emptyHtml.includes("No shoots today") && !emptyHtml.includes("Today’s shoots"), emptyHtml.slice(0, 200));
    c.ok("rendering the card writes nothing", (await counts()) === before);

    // =====================================================================
    c.head("6 · The fence held");
    // =====================================================================
    c.ok("no outbound call at all (OpenPhone answered in-process, no Slack, no weather)", fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.join(" "));
    c.ok("only the creatives were texted (Harrison, James); never a client, Kim, Kyle or Jordan", texts.every((t) => /6105550144$|6105550133$/.test(t.to.replace(/\D/g, ""))), texts.map((t) => t.to).join(","));
    c.ok("every text is a hub text with special requests", texts.every((t) => t.body.startsWith(`${HUB_SMS_PREFIX}: `) && t.body.includes("Special requests for this shoot: 1) ")));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
