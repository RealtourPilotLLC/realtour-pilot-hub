// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL · oct29-brief-changes: JAMES'S CALL, THE BRIEF THREE (Oct 29 2026).
//
// Three rows of Jordan's James-call list:
//   "A team shoot is missing from the dashboard": Harrison's Firethorn shoot
//     (Wed Oct 28, 2 PM; the call was at 1:30) was on the Schedule but nowhere
//     on James's desk, which listed only the team's PAST visits with a handoff
//     open. The desk now lists the field team's shoots from today on.
//   "Changed briefs do not show the change": the 825 State St card said the
//     brief changed; the desk row and the shoot screen offered "Mark changed
//     brief read" with no words. The row now says what changed beside it.
//   "Brief-change notification was unclear": both of James's Oct 28 texts (907
//     and 1,040 characters) were taken by OpenPhone and never confirmed on his
//     phone. Briefs are kept short, an update is the change and the link, and a
//     text no phone confirmed says so on the status (Kyle calls or resends).
//
//   §1 the words (pure): a changed request reads "changed from X to Y"; a long
//      day's brief and a long update stay under BRIEF_TEXT_MAX
//   §2 the world: James, Harrison, Jordan (owner) and their Wed Oct 28 shoots
//   §3 delivery: confirmed / not confirmed / not known, judged from OpenPhone's
//      own "message.delivered" receipts; the office's line and Resend
//   §4 a change: the update text is the change and the link; James's desk row
//      lists it beside Mark changed brief read
//   §5 the team's shoots from today on, as the Schedule has them
//
// ISOLATION: PGlite via the shared harness, every .env key blank, AUTH_ENFORCE
// on, OpenPhone's send stubbed at its module seam (nothing leaves), every other
// outbound call fenced.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7437);

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
let offset = et(2026, 10, 27, 12).getTime() - RealDate.now();
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
const OCT = (d: number, h: number, mi = 0) => et(2026, 10, d, h, mi);
const TUE = (h: number, mi = 0) => OCT(27, h, mi);
const WED = (h: number, mi = 0) => OCT(28, h, mi);

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown; usePathname: () => string; useSearchParams: () => unknown };
navigation.useRouter = () => ({ refresh() {}, replace() {}, push() {}, prefetch() {} });
navigation.usePathname = () => "/";
navigation.useSearchParams = () => new URLSearchParams("");
const fence = fenceFetch((url) => {
  if (url.startsWith("https://api.open-meteo.com/")) return new Response(JSON.stringify({ hourly: { time: [], temperature_2m: [], precipitation_probability: [], wind_speed_10m: [] } }), { status: 200, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://services6.arcgis.com/")) return new Response(JSON.stringify({ features: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return null;
});
const DASH = /[–—]/;
const flat = (el: Parameters<typeof renderToStaticMarkup>[0]) => { try { return renderToStaticMarkup(el).replace(/<!-- -->/g, ""); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
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

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct29-brief-changes" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string; at: Date; id: string }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      const id = `AC${randomBytes(16).toString("hex")}`;
      texts.push({ to: String(to).replace(/\D/g, "").slice(-10), body, at: new Date(), id });
      return { data: { id } };
    };
    const core = await import("@/lib/photographerBriefCore");
    const pb = await import("@/lib/photographerBrief");
    const { briefOffer } = await import("@/lib/officeDesk");
    const { setSession } = await import("@/lib/auth/session");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const { buildCreativeDesk } = await import("@/lib/creativeDesk");
    const { CreativeDesk } = await import("@/components/creativeDesk/CreativeDesk");
    const { HUB_SMS_PREFIX } = await import("@/lib/hubSms");
    const { appBase } = await import("@/lib/appUrl");

    // =====================================================================
    c.head("1 · The words (pure)");
    // =====================================================================
    const at = "2026-10-28T19:00:00.000Z";
    const shoot = { a: "a1", p: "p1", t: at, addr: "825 State St, Lancaster", svc: ["Listing Photography"], acc: ["Lockbox 1234"], con: "Ashley (717) 555-0100", req: ["req:Lights on in the kitchen."] };
    const words = (after: typeof shoot) => core.changesBetween([shoot], [after], new Date("2026-10-28T12:00:00Z")).map((x) => x.words);
    const edited = words({ ...shoot, req: ["req:Lights on in every room, blinds open."] });
    c.ok("an edited request says before and after (not \"requests changed\", not a removed and a new line)",
      JSON.stringify(edited) === JSON.stringify(['825 State St: request changed from "Lights on in the kitchen" to "Lights on in every room, blinds open"']), JSON.stringify(edited));
    const lock = words({ ...shoot, acc: ["Lockbox 5678"] });
    c.ok("…the same for an access note (the lockbox code changed)", JSON.stringify(lock) === JSON.stringify(['825 State St: access note changed from "Lockbox 1234" to "Lockbox 5678"']), JSON.stringify(lock));
    const two = words({ ...shoot, req: ["req:Lights on in the kitchen.", "req:Twilight of the pool.", "must:Agent intro at the front door."] });
    c.ok("…an added request stays an addition", two.length === 2 && two.every((w) => w.includes(": new ")), JSON.stringify(two));

    const visit = (n: number, extra: Partial<Parameters<typeof core.shootLine>[0]> = {}): Parameters<typeof core.shootLine>[0] => ({
      appointmentId: `v${n}`, projectId: `p${n}`, startISO: `2026-10-28T${String(12 + n).padStart(2, "0")}:00:00.000Z`, time: `${8 + n}:00 AM`, street: `${n}00 Long Day Rd`, address: `${n}00 Long Day Rd, Lancaster`, visit: null,
      services: ["Photography and Standard Reel w/ Agent intro", "Drone Photos", "Zillow Showcase 3D Tour Add-on"], servicesNote: null,
      access: ["Lockbox or door code: 4417", "Agent will be there", "Gate code 9911 at the side entrance, the dog is friendly"], contact: "Ashley Example (717) 555-0100",
      must: ["Produce reel styled after the shared Instagram with selling experience talking points", "Agent intro at the front door"], leave: ["No drone over the neighbor's yard"], requests: ["Lights on in every room, blinds open", "Seller prefers warm tones"],
      earlier: [], orderSentences: [], ...extra,
    });
    const link = `${appBase()}/shoot/brief/2026-10-28`;
    const one = core.composeBriefText({ teamMemberId: "tm", name: "James Livingston", day: "2026-10-28", shoots: [visit(1)] }, link);
    c.ok("one shoot with everything: under the cap, still the shoot's facts", one.length <= core.BRIEF_TEXT_MAX && one.includes("1) 9:00 AM, 100 Long Day Rd, Lancaster") && one.includes("Access: ") && one.trim().endsWith(link), `${one.length}\n${one}`);
    const long = core.composeBriefText({ teamMemberId: "tm", name: "James Livingston", day: "2026-10-28", shoots: [1, 2, 3, 4].map((n) => visit(n)) }, link);
    console.log(`\n--- a four-shoot day (${long.length} characters) ---\n${long}\n---`);
    c.ok(`a four-shoot day never runs past ${core.BRIEF_TEXT_MAX} characters (James's 907-character brief never arrived)`, long.length <= core.BRIEF_TEXT_MAX && !DASH.test(long), String(long.length));
    c.ok("…every shoot still named, in order, and the page link last", [1, 2, 3, 4].every((n) => long.includes(`${n}) ${8 + n}:00 AM, ${n}00 Long Day Rd`)) && long.trim().endsWith(`Full brief, then tap Got it:\n${link}`), long);
    const many = Array.from({ length: 9 }, (_, i) => `${i + 1}00 Long Day Rd: new request "${"Please capture every angle of the renovated space ".repeat(2).trim()}"`);
    const upd = core.composeUpdateText({ teamMemberId: "tm", name: "James Livingston", day: "2026-10-28", shoots: [visit(1)] }, many, link);
    console.log(`\n--- an update with nine changes (${upd.length} characters) ---\n${upd}\n---`);
    c.ok("an update with nine long changes: under the cap, says how many more are on the page, ends with the link",
      upd.length <= core.BRIEF_TEXT_MAX && /\n\((\d+) more on the brief page\.\)\n/.test(upd) && upd.trim().endsWith(`Please open it and tap Got it again:\n${link}`) && !upd.includes("Services:"), upd);
    const shown = (upd.match(/^• /gm) ?? []).length;
    c.ok("…the count is right (shown + more = 9)", shown + Number(upd.match(/\((\d+) more on the brief page/)?.[1] ?? 0) === 9, String(shown));
    const gone = core.composeUpdateText({ teamMemberId: "tm", name: "James Livingston", day: "2026-10-28", shoots: [] }, ["825 State St is off your schedule"], link);
    c.ok("an update that leaves no shoots says so", gone.includes("What changed: 825 State St is off your schedule.") && gone.includes("You have no shoots that day now:"), gone);

    // =====================================================================
    c.head("2 · The world (Wed Oct 28)");
    // =====================================================================
    const member = (name: string, role: "MANAGER" | "PHOTOGRAPHER", phone: string | null, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@drill.invalid`, role, phone, active: true, ...extra }, select: { id: true, name: true } });
    const jamesTm = await member("James Livingston", "PHOTOGRAPHER", "(610) 555-0133", { creativeManager: true });
    const harrisonTm = await member("Harrison Wells", "PHOTOGRAPHER", "(610) 555-0144");
    const kyleTm = await member("Kyle Smith", "MANAGER", OFFICE, { opsAlerts: true });
    const jordanTm = await member("Jordan Spackman", "PHOTOGRAPHER", "(610) 555-0111");
    const login = (name: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@drill.invalid`, role, status: "ACTIVE", teamMemberId } });
    await login("Jordan Spackman", "OWNER", jordanTm.id);
    await login("Kyle Smith", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "CREATIVE_MANAGER", jamesTm.id);
    await login("Harrison Wells", "PHOTOGRAPHER", harrisonTm.id);
    await prisma.appSetting.create({ data: { key: "photographer_brief", value: JSON.stringify({ enabled: true, sendMinute: 1080 }) } });

    const client = await prisma.client.create({ data: { name: "Mike Sample", phone: "7175550123" } });
    const desc = (items: string[]) => ["Customer:", "Name: Mike Sample", "Email: agent@drill.invalid", "Phone: (717) 555-0123", "", "Order Items Serviced By This Appointment:", ...items.map((i) => ` - (1x) ${i}`), "", "Order Notes:", "n/a", "", "Order Questions:", " - Lock Box / Door Code: 4417", ""].join("\n");
    let n = 0;
    const job = async (street: string, start: Date, who: string, o: { items?: string[]; status?: string; projectStatus?: string } = {}) => {
      const items = o.items ?? ["Essentials Package"];
      const p = await prisma.project.create({ data: { title: `${street}, Lancaster, PA 17601`, addressLine: street, city: "Lancaster", clientId: client.id, status: (o.projectStatus ?? "SCHEDULED") as never, shootDate: start, photographerId: who, orderItems: { create: items.map((title) => ({ title, quantity: 1 })) } }, select: { id: true } });
      const a = await prisma.appointment.create({ data: { aryeoId: `aryeo-${++n}`, projectId: p.id, startAt: start, endAt: new Date(start.getTime() + 90 * 60_000), status: o.status ?? "SCHEDULED", assignedToId: who, description: desc(items), rawJson: JSON.stringify({ items: items.map((title) => ({ title, quantity: 1, is_canceled: false })) }) }, select: { id: true } });
      return { projectId: p.id, appointmentId: a.id };
    };
    const state = await job("825 State St", WED(15), jamesTm.id, { items: ["Photography and Standard Reel w/ Agent intro"] });
    const fire = await job("512 Firethorn Rd", WED(14), harrisonTm.id);
    const jordans = await job("3 Owner Ct", WED(10), jordanTm.id);
    const cancelled = await job("9 Cancelled Way", WED(16), harrisonTm.id, { status: "CANCELED" });
    const nextWeek = await job("40 Next Week Ln", et(2026, 11, 3, 11), harrisonTm.id);
    const tooFar = await job("77 Too Far Rd", et(2026, 11, 6, 10), harrisonTm.id);
    c.ok("the world is built", !!state && !!fire && !!jordans && !!cancelled && !!nextWeek && !!tooFar);

    // =====================================================================
    c.head("3 · Did the text reach the phone? (OpenPhone's own receipts)");
    // =====================================================================
    await pb.sweepPhotographerBriefs(setNow(TUE(18, 5)));
    const toJames = () => texts.filter((t) => t.to === "6105550133");
    const toHarrison = () => texts.filter((t) => t.to === "6105550144");
    c.ok("Tue 6:05 PM: James and Harrison each get Wednesday's brief, each under the cap", toJames().length === 1 && toHarrison().length === 1 && texts.every((t) => t.body.length <= core.BRIEF_TEXT_MAX), texts.map((t) => `${t.to} ${t.body.length}`).join(" | "));
    const rows = await prisma.outboxMessage.findMany({ select: { dedupeKey: true, providerId: true } });
    c.ok("…the outbox kept OpenPhone's id for each (Jordan's own shoot has its brief too)", rows.length === 3 && rows.length === texts.length && rows.every((r) => /^AC[0-9a-f]{32}$/.test(r.providerId ?? "")), JSON.stringify(rows));
    const sentAt645 = texts.length;
    const status = async () => pb.briefStatusForAppointments([state.appointmentId, fire.appointmentId]);
    const NOT = /^Not delivered:/;

    setNow(TUE(18, 10));
    let s = await status();
    c.ok("5 minutes on, no receipt yet: just sent (too soon to judge)", s.get(state.appointmentId)?.state === "sent" && !NOT.test(s.get(state.appointmentId)?.why ?? ""), JSON.stringify(s.get(state.appointmentId)));
    setNow(TUE(18, 45));
    s = await status();
    c.ok("40 minutes on, and NO receipts at all arriving: not known, so nothing is claimed", !NOT.test(s.get(state.appointmentId)?.why ?? "") && !NOT.test(s.get(fire.appointmentId)?.why ?? ""), JSON.stringify([...s.values()]));

    const receipt = (id: string, createdAt: Date) => prisma.webhookEvent.create({ data: { provider: "openphone", eventType: "message.delivered", externalId: `EV${randomBytes(8).toString("hex")}`, payload: JSON.stringify({ type: "message.delivered", data: { object: { id, object: "message", direction: "outgoing", status: "delivered" } } }), createdAt } });
    await receipt(toHarrison()[0].id, new Date(TUE(18, 5).getTime() + 8_000));
    await receipt(`AC${randomBytes(16).toString("hex")}`, TUE(18, 40)); // someone else's text, confirmed later
    s = await status();
    const jWhy = s.get(state.appointmentId)?.why ?? "";
    c.ok("Harrison's phone confirmed his; a later text was confirmed too, James's never was: \"Not delivered\", saying what to do",
      jWhy === "Not delivered: OpenPhone took the 6:05 PM text, but James's phone never confirmed it. Call James, or press Send brief now." && s.get(state.appointmentId)?.state === "sent", jWhy);
    c.ok("…Harrison's is not flagged", !NOT.test(s.get(fire.appointmentId)?.why ?? ""), JSON.stringify(s.get(fire.appointmentId)));
    const offer = briefOffer({ state: "sent", sent: true, started: false, why: jWhy });
    c.ok("Kyle's desk line: the problem in those words, with Resend (a person presses it: never resent by itself)", offer.problem === jWhy.replace(/\.$/, "") && offer.send === "resend" && !offer.waiting, JSON.stringify(offer));
    c.ok("…and the hub sent nothing more on its own", texts.length === sentAt645);
    const late = await pb.briefDelivery([{ teamMemberId: jamesTm.id, day: "2026-10-28", record: { ...core.emptyRecord(jamesTm.id, "2026-10-28"), sent: { n: 1, at: TUE(18, 5).toISOString(), digest: "x", snapshot: [], outcome: "sent" } } }], TUE(18, 45));
    c.ok("briefDelivery reads it the same way (false = never confirmed)", late.get(`${jamesTm.id}|2026-10-28`) === false, JSON.stringify([...late]));
    await receipt(toJames()[0].id, new Date(TUE(18, 5).getTime() + 30_000));
    s = await status();
    c.ok("once his phone confirms it, the flag is gone", !NOT.test(s.get(state.appointmentId)?.why ?? "") && s.get(state.appointmentId)?.state === "sent", JSON.stringify(s.get(state.appointmentId)));

    // =====================================================================
    c.head("4 · A change: the update is the change and the link; the desk says what changed");
    // =====================================================================
    setNow(WED(9));
    await prisma.activity.create({ data: { projectId: state.projectId, type: "SPECIAL_REQUEST", body: "Produce reel styled after shared Instagram with selling experience talking points.", authorId: kyleTm.id, createdAt: WED(9) } });
    await pb.sweepPhotographerBriefs(setNow(WED(9, 1)));
    const upd825 = toJames().slice(1);
    console.log(`\n--- James's update ---\n${upd825[0]?.body}\n---`);
    c.ok("ONE update to James: what changed (the request itself) and the link, nothing else",
      upd825.length === 1 && upd825[0].body === `${HUB_SMS_PREFIX}: James, your Wed Oct 28 brief changed\n\nWhat changed: 825 State St: new request "Produce reel styled after shared Instagram with selling experience talking points".\n\nPlease open it and tap Got it again:\n${link}`, upd825.map((t) => t.body).join(" | "));
    c.ok("…short (the 1,040-character update repeated the whole day)", (upd825[0]?.body.length ?? 999) <= core.BRIEF_TEXT_MAX && !upd825[0]?.body.includes("1) 3:00 PM"), String(upd825[0]?.body.length));
    c.ok("…and Harrison, whose day did not change, gets nothing", toHarrison().length === 1);
    await pb.sweepPhotographerBriefs(setNow(WED(9, 6)));
    c.ok("the next tick sends nothing again", toJames().length === 2);

    await setSession({ uid: james.id, email: james.email, role: james.role, name: james.name ?? undefined });
    const me = async () => (await getCurrentUser())!;
    const d1 = await buildCreativeDesk(await me(), { now: WED(9, 10) });
    const row = d1.production.mine.find((r) => r.id === state.appointmentId);
    c.ok("James's desk row: Brief changed, with the change itself to confirm", row?.status?.label === "Brief changed" && row?.briefAck?.again === true && /^[a-f0-9]{32}$/.test(row?.briefAck?.digest ?? "")
      && JSON.stringify(row?.briefAck?.changes) === JSON.stringify(['825 State St: new request "Produce reel styled after shared Instagram with selling experience talking points"']), JSON.stringify(row?.briefAck));
    const html = flat(createElement(CreativeDesk, { desk: d1, mode: "production", initialPanel: null }));
    const li = block(html, `data-shoot="${state.appointmentId}"`, "li");
    const box = block(li, `data-brief-changes="${state.appointmentId}"`, "div");
    c.ok("…rendered: What changed, the request, and Mark changed brief read under it", box.includes("What changed") && box.includes("Produce reel styled after shared Instagram") && box.includes(">Mark changed brief read<"), li.slice(0, 900));

    // =====================================================================
    c.head("5 · The team's shoots from today on (Harrison's Firethorn at 1:30 PM)");
    // =====================================================================
    const d2 = await buildCreativeDesk(await me(), { now: WED(13, 30) });
    const up = d2.production.teamUpcoming;
    const f = up.find((t) => t.id === fire.appointmentId);
    c.ok("Harrison's 2 PM Firethorn shoot is on James's desk, today, not started", !!f && f.photographer === "Harrison Wells" && f.street === "512 Firethorn Rd" && f.whenWords === "Today 2:00 PM" && f.today && !f.started && f.href === `/shoot/${fire.projectId}`, JSON.stringify(f));
    c.ok("…with his brief's state (sent, his phone confirmed it, no Got it yet)", f?.brief?.label === "Brief sent, no Got it yet", JSON.stringify(f?.brief));
    c.ok("…next week's shoot is there; one past the week, a cancelled one, Jordan's and James's own are not",
      up.some((t) => t.id === nextWeek.appointmentId) && !up.some((t) => [tooFar.appointmentId, cancelled.appointmentId, jordans.appointmentId, state.appointmentId].includes(t.id)), JSON.stringify(up.map((t) => t.street)));
    const html2 = flat(createElement(CreativeDesk, { desk: d2, mode: "production", initialPanel: null }));
    const tli = block(html2, `data-team-shoot="${fire.appointmentId}"`, "li");
    c.ok("…rendered in Team shoots this week", html2.includes('data-section="team-shoots"') && tli.includes("Harrison · 512 Firethorn Rd") && tli.includes("Today 2:00 PM"), tli.slice(0, 500));
    c.ok("nothing left the building (OpenPhone's send is the stub above)", fence.blocked.every((u) => !/openphone|slack|gmail|googleapis|twilio/i.test(u)), JSON.stringify(fence.blocked));
  } catch (e) {
    c.ok(`drill threw: ${(e as Error).stack ?? e}`, false);
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main();
