// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE PHOTOGRAPHER BRIEF WITH "GOT IT" (Oct 23 2026, lib/photographerBrief,
// lib/photographerBriefCore). Jordan's Kyle dashboard spec, "Photographer
// briefing", and acceptance check 8: "Changed shoot instructions require
// renewed acknowledgment."
//
//   DRILL_PORT=7221 node scripts/_drill/run-all.cjs scripts/_drill/oct23-photographer-brief.ts
//
// Isolated PGlite; fetch fenced (the forecast and the FAA map answered in
// process); OpenPhone answered in-process, every text recorded. The clock is
// pinned to Fri Oct 23 2026 (EDT) and moved by hand.
//
//   1. The calendar and the words (pure): Friday covers Saturday, Sunday and
//      Monday; services per visit; request kinds; presence.
//   2. The switch OFF (the default): nothing sends, every status reads "off",
//      Send brief now refused.
//   3. Settings: owner and admin may switch it on and pick the time; an editor may not.
//   4. Before the send time: pending, saying when.
//   5. Friday 6 PM: Monday's brief (and Saturday's) go, Tuesday's does not; one
//      text per photographer per day, whatever the ticks; the brief carries only
//      the visit's own services and pre-shoot requests (615 Cliff Ln's
//      "Exteriors only" and a post-delivery revision never); no dashes.
//   6. Statuses: sent, failed (no phone), no photographer, pending.
//   7. The full-brief page: the photographer's own, Got it shown; the office
//      reads it without the button; an editor is sent home.
//   8. Got it: recorded with who and when; a preview, someone else and a stale
//      version are refused.
//   9. A non-material change sends nothing and keeps the Got it.
//  10. Acceptance 8: a material change (time) re-sends with what changed and
//      needs a new Got it; so does a new request, and a reassignment.
//  11. A failed send reads "failed" with the reason, retries on its own clock,
//      then goes when the cause is fixed.
//  12. Send brief now: owner, admin, creative manager yes; editor, photographer,
//      "view as" no; not twice in two minutes.
//  13. The shoot-day special-request text is folded in while the brief is on,
//      and the night-before text stops; OFF again, both carry on and nothing
//      of the brief sends.
//  14. Wired in, and the fence held.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 7221);
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
let offset = et(2026, 10, 23, 12).getTime() - RealDate.now();
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
const FRI = (h: number, mi = 0) => OCT(23, h, mi);
const SAT = (h: number, mi = 0) => OCT(24, h, mi);
const MON = (h: number, mi = 0) => OCT(26, h, mi);

installNextStubs();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.redirect = (href: string) => { throw new Error(`redirect ${href}`); };
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
}
// The forecast and the FAA map, answered here (planning information on the page only).
const fence = fenceFetch((url) => {
  if (url.startsWith("https://api.open-meteo.com/")) {
    const time = Array.from({ length: 72 }, (_, i) => `2026-10-${String(26 + Math.floor(i / 24)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00`);
    return new Response(JSON.stringify({ hourly: { time, temperature_2m: time.map(() => 54), precipitation_probability: time.map(() => 10), wind_speed_10m: time.map(() => 8) } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://services6.arcgis.com/")) return new Response(JSON.stringify({ features: [] }), { status: 200, headers: { "content-type": "application/json" } });
  return null;
});
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-photographer-brief" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const refuse = new Set<string>();
    const texts: { to: string; body: string; at: Date }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      const key = String(to).replace(/\D/g, "").slice(-10);
      if (refuse.has(key)) throw new op.OpenPhoneError("Invalid 'to' number", 400);
      texts.push({ to: key, body, at: new Date() });
      return { data: { id: `op-${texts.length}` } };
    };
    const core = await import("@/lib/photographerBriefCore");
    const pb = await import("@/lib/photographerBrief");
    const actions = await import("@/app/shoot/brief/actions");
    const { savePhotographerBrief } = await import("@/app/settings/actions");
    const { setSession } = await import("@/lib/auth/session");
    const { default: briefPage } = await import("@/app/shoot/brief/[day]/page");
    const { HUB_SMS_PREFIX } = await import("@/lib/hubSms");
    const { appBase } = await import("@/lib/appUrl");

    // =====================================================================
    c.head("1 · The calendar and the words (pure)");
    // =====================================================================
    c.ok("a shoot day's brief is due the business day before: Monday's on Friday, Saturday's and Sunday's on Friday, Tuesday's on Monday",
      core.prevBusinessDayKey("2026-10-26") === "2026-10-23" && core.prevBusinessDayKey("2026-10-24") === "2026-10-23" && core.prevBusinessDayKey("2026-10-25") === "2026-10-23" && core.prevBusinessDayKey("2026-10-27") === "2026-10-26");
    c.ok("Friday's run covers Saturday, Sunday and Monday (Monday's shoots on Friday)", JSON.stringify(core.daysCoveredBy("2026-10-23")) === JSON.stringify(["2026-10-24", "2026-10-25", "2026-10-26"]), JSON.stringify(core.daysCoveredBy("2026-10-23")));
    c.ok("Monday's run covers Tuesday only; Thursday's covers Friday only", JSON.stringify(core.daysCoveredBy("2026-10-26")) === '["2026-10-27"]' && JSON.stringify(core.daysCoveredBy("2026-10-22")) === '["2026-10-23"]');
    c.ok("Monday's brief is due Fri Oct 23 at 6:00 PM ET by default", core.briefDueAt("2026-10-26", core.DEFAULT_BRIEF_SETTINGS).getTime() === FRI(18).getTime());
    c.ok("a 7:30 PM setting moves it to Fri 7:30 PM", core.briefDueAt("2026-10-26", { enabled: true, sendMinute: 19 * 60 + 30 }).getTime() === FRI(19, 30).getTime());
    c.ok("the settings row: missing or unreadable is OFF at 6 PM; an off-menu time falls back to 6 PM",
      JSON.stringify(core.readBriefSettings(null)) === '{"enabled":false,"sendMinute":1080}' && JSON.stringify(core.readBriefSettings("nope")) === '{"enabled":false,"sendMinute":1080}' && core.readBriefSettings('{"enabled":true,"sendMinute":1081}').sendMinute === 1080);
    const raw = JSON.stringify({ items: [{ title: "Social Influencer", sub_title: "3,000 - 3,999 Sq. Ft.", quantity: 1 }, { title: "Agent on Camera", sub_title: "Intro Only", quantity: 1 }, { title: "Same Day Photo Delivery", quantity: 1 }, { title: "Twilight", quantity: 2, is_canceled: true }] });
    c.ok("a visit's services are its own Aryeo items: size bands dropped, a real sub-title kept, fees and cancelled lines out",
      JSON.stringify(core.visitServices(raw, null)) === '["Social Influencer","Agent on Camera: Intro Only"]', JSON.stringify(core.visitServices(raw, null)));
    c.ok("…read from the brief's own block when the payload has none", JSON.stringify(core.visitServices(null, "Order Items Serviced By This Appointment:\n - (1x) Zillow Showcase 3D Tour Add-on: 0 - 1,999 Sq. Ft.\n - (2x) Twilight: \n\nOrder Notes:\nn/a")) === '["Zillow Showcase 3D Tour Add-on","2 x Twilight"]');
    {
      const at = "2026-10-26T15:00:00.000Z";
      const shoot = { a: "a1", p: "p1", t: at, addr: "825 State St, Lancaster", svc: ["Listing Photography"], acc: ["Lockbox 1234"], con: "Ashley (717) 555-0100", req: ["req:Client note: logo on every video."] };
      const after = { ...shoot, svc: ["Listing Photography", "Drone Photos"], acc: [], con: "Mark (717) 555-0199", req: [...shoot.req, "req:Produce reel styled after shared Instagram with selling experience talking points.", "leave:No drone over the neighbor."] };
      const words = core.changesBetween([shoot], [after], new Date("2026-10-25T12:00:00Z")).map((x) => x.words);
      c.ok("change words say WHAT changed (Oct 28: \"825 State St requests changed\" told James nothing)", JSON.stringify(words) === JSON.stringify([
        '825 State St: new service "Drone Photos"',
        '825 State St: access note removed "Lockbox 1234"',
        "825 State St: on-site contact is now Mark (717) 555-0199 (was Ashley (717) 555-0100)",
        '825 State St: new request "Produce reel styled after shared Instagram with selling experience talking points"',
        '825 State St: new leave-out "No drone over the neighbor"',
      ]), JSON.stringify(words));
      const long = "x ".repeat(200);
      const clipped = core.changesBetween([shoot], [{ ...shoot, req: [...shoot.req, `req:${long}`] }], new Date("2026-10-25T12:00:00Z"))[0]?.words ?? "";
      c.ok("…a long request is clipped in the change line (the page shows it whole)", clipped.length < 130 && clipped.endsWith('…"'), clipped);
    }
    c.ok("request kinds by their own words", core.requestKind("Please make sure to capture the finished basement.") === "must" && core.requestKind("Don't forget the pool.") === "must" && core.requestKind("No drone, the HOA said no.") === "leave" && core.requestKind("Skip the garage.") === "leave" && core.requestKind("The seller prefers warm tones.") === "request");
    c.ok("who is there, as a sentence", core.presenceWords("Agent") === "Agent will be there" && core.presenceWords("Vacant") === "Vacant, nobody will be there" && core.presenceWords("The seller will be home until noon") === "Who's there: The seller will be home until noon");

    // =====================================================================
    c.head("2 · The world");
    // =====================================================================
    const member = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER" | "EDITOR", phone: string | null, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email, role, phone, active: true, ...extra }, select: { id: true, name: true } });
    const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144");
    const jamesTm = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", { creativeManager: true });
    const kyleTm = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE, { opsAlerts: true });
    const jordanTm = await member("Jordan Spackman", "info@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111");
    const kimTm = await member("Kim Miguel", "kim@drill.invalid", "EDITOR", null);
    const pat = await member("Pat Rivera", "pat@drill.invalid", "PHOTOGRAPHER", null);
    const sam = await member("Sam Ortiz", "sam@drill.invalid", "PHOTOGRAPHER", "(610) 555-0177");
    const login = (name: string, email: string, role: string, teamMemberId: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { name, email, role, status: "ACTIVE", teamMemberId, ...extra } });
    const owner = await login("Jordan Spackman", "info@drill.invalid", "OWNER", jordanTm.id);
    const kyle = await login("Kyle Smith", "kyle@drill.invalid", "ADMIN", kyleTm.id);
    const james = await login("James Livingston", "james@drill.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const kim = await login("Kim Miguel", "kim@drill.invalid", "EDITOR", kimTm.id, { editorKey: "kim" });
    const harrisonLogin = await login("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
    const signIn = (u: { id: string; email: string; role: string; name: string | null }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined, ...(actingAs ? { actingAs } : {}) });

    const client = await prisma.client.create({ data: { name: "Alex Stackhouse", phone: "5704129274" } });
    const client2 = await prisma.client.create({ data: { name: "Nick Valudes", phone: "7175758139" } });
    const desc = (o: { name: string; phone: string; items: string[]; orderNotes?: string; lockbox?: string; access?: string; presence?: string; special?: string; flexible?: string }) => [
      "Customer:", `Name: ${o.name}`, "Email: agent@drill.invalid", `Phone: ${o.phone}`, "Notes: n/a", "",
      "Order Items Serviced By This Appointment:", ...(o.items.length ? o.items.map((i) => ` - (1x) ${i}`) : ["No items added yet."]), "",
      "Order Notes:", o.orderNotes ?? "n/a", "",
      "Order Questions:",
      ` - Will you or the seller be present at the appointment?: ${o.presence ?? ""}`,
      ` - Lock Box / Door Code: ${o.lockbox ?? ""}`,
      ` - Additional information to access the property: ${o.access ?? ""}`,
      ` - Special Instructions for the photographer (for this property only): ${o.special ?? ""}`,
      ` - Is the time of the appointment flexible on the requested day?: ${o.flexible ?? "Flexible"}`,
      "", "Or View Full Order Details:", "https://app.aryeo.com/admin/orders/x/edit",
    ].join("\n");
    const rawOf = (items: string[], extra: Record<string, unknown> = {}) => JSON.stringify({ items: items.map((title) => ({ title, sub_title: "3,000 - 3,999 Sq. Ft.", quantity: 1, is_canceled: false })), customer_choice_enabled: false, ...extra });
    let aryeoN = 0;
    const appt = (projectId: string, startAt: Date, who: string | null, d: Parameters<typeof desc>[0]) =>
      prisma.appointment.create({ data: { aryeoId: `aryeo-${++aryeoN}`, projectId, startAt, endAt: new Date(startAt.getTime() + 90 * 60_000), status: "SCHEDULED", assignedToId: who, description: desc(d), rawJson: rawOf(d.items) }, select: { id: true } });

    // A: a two-visit job (615 Cliff Ln). Visit 1 shot the exteriors on Mon Oct 19;
    // visit 2 on Mon Oct 26 is the 3D tour, interiors and agent on camera.
    const cliff = await prisma.project.create({
      data: { title: "615 Cliff Ln, Malvern, PA 19355", addressLine: "615 Cliff Ln", city: "Malvern", clientId: client.id, status: "EDITING", shootDate: OCT(19, 10), photographerId: harrison.id, lat: 40.03, lng: -75.51,
        orderItems: { create: [{ title: "Social Influencer", quantity: 1 }, { title: "Zillow Showcase 3D Tour Add-on", quantity: 1 }] },
        deliverables: { create: [{ type: "PHOTOS", label: "Photos" }, { type: "DRONE", label: "Drone Photos" }] } },
      select: { id: true },
    });
    const SPECIAL = "Split appointment! Exteriors only. Photo, Video, and Drone.";
    const cliffV1 = await appt(cliff.id, OCT(19, 10), harrison.id, { name: "Alex Stackhouse", phone: "(570) 412-9274", items: ["Social Influencer"], presence: "Seller", special: SPECIAL });
    const cliffV2 = await appt(cliff.id, MON(13), harrison.id, { name: "Alex Stackhouse", phone: "(570) 412-9274", items: ["Zillow Showcase 3D Tour Add-on"], presence: "Seller", special: SPECIAL });
    // The order notes were written at booking (first seen Oct 15, before visit 1).
    await prisma.appSetting.create({ data: { key: pb.briefSeenKey(cliff.id), value: JSON.stringify({ [core.sentenceKey("Split appointment!")]: OCT(15, 9).toISOString(), [core.sentenceKey("Exteriors only.")]: OCT(15, 9).toISOString(), [core.sentenceKey("Photo, Video, and Drone.")]: OCT(15, 9).toISOString() }) } });
    // Before visit 1: the office's request for visit 1 (stays with visit 1).
    await prisma.activity.create({ data: { projectId: cliff.id, type: "SPECIAL_REQUEST", body: "Get the pool from the deck.", authorId: kyleTm.id, createdAt: OCT(16, 9) } });
    // Between the visits: for visit 2.
    await prisma.activity.create({ data: { projectId: cliff.id, type: "SPECIAL_REQUEST", body: "For the second visit: interiors and agent on camera.", authorId: kyleTm.id, createdAt: OCT(20, 15) } });
    await prisma.clientAsk.create({ data: { clientId: client.id, projectId: cliff.id, kind: "SPECIAL_REQUEST", medium: "both", text: "Please make sure to capture the finished basement this time.", source: "text", askedAt: OCT(21, 9), state: "OPEN" } });
    // Visit 1's photos were delivered Oct 20; Alex then asked for a photo change: a revision, never the brief's.
    await prisma.photoJob.create({ data: { projectId: cliff.id, stage: "DELIVERED", deliveredAt: OCT(20, 18) } });
    await prisma.clientAsk.create({ data: { clientId: client.id, projectId: cliff.id, kind: "SPECIAL_REQUEST", medium: "photo", text: "Can you adjust photo 12 so the lamp is still in it?", source: "email", askedAt: OCT(22, 11), state: "OPEN" } });
    await prisma.activity.create({ data: { projectId: cliff.id, type: "SPECIAL_REQUEST", body: "Client request (gmail): Can you adjust photo 12 so the lamp is still in it?", createdAt: OCT(22, 11) } });

    // B: one visit, Mon 11 AM (266 Richard Dr).
    const richard = await prisma.project.create({
      data: { title: "266 Richard Dr, Allentown, PA 18104", addressLine: "266 Richard Dr", city: "Allentown", clientId: client2.id, status: "SCHEDULED", shootDate: MON(11), photographerId: harrison.id,
        orderItems: { create: [{ title: "Social Influencer", quantity: 1 }] }, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } },
      select: { id: true },
    });
    const richardA = await appt(richard.id, MON(11), harrison.id, { name: "Nick Valudes", phone: "(717) 575-8139", items: ["Social Influencer"], presence: "Agent", lockbox: "4417", special: "Do not shoot the neighbor's yard — keep it tight." });
    // C: James on Saturday (Friday's run covers it).
    const sat = await prisma.project.create({ data: { title: "10 Weekend Way, Malvern, PA", addressLine: "10 Weekend Way", city: "Malvern", clientId: client2.id, status: "SCHEDULED", shootDate: SAT(9), photographerId: jamesTm.id, orderItems: { create: [{ title: "Standard Package", quantity: 1 }] } }, select: { id: true } });
    const satA = await appt(sat.id, SAT(9), jamesTm.id, { name: "Nick Valudes", phone: "(717) 575-8139", items: ["Standard Package"], presence: "Vacant" });
    // D: Harrison on Tuesday (Monday's run, not Friday's).
    const tue = await prisma.project.create({ data: { title: "77 Tuesday Ct, Malvern, PA", addressLine: "77 Tuesday Ct", city: "Malvern", clientId: client2.id, status: "SCHEDULED", shootDate: OCT(27, 10), photographerId: harrison.id, orderItems: { create: [{ title: "Standard Package", quantity: 1 }] } }, select: { id: true } });
    const tueA = await appt(tue.id, OCT(27, 10), harrison.id, { name: "Nick Valudes", phone: "(717) 575-8139", items: ["Standard Package"] });
    // E: Pat (no phone) on Monday; F: nobody on Monday.
    const patJob = await prisma.project.create({ data: { title: "5 No Phone Pl, Malvern, PA", addressLine: "5 No Phone Pl", city: "Malvern", clientId: client2.id, status: "SCHEDULED", shootDate: MON(9), photographerId: pat.id }, select: { id: true } });
    const patA = await appt(patJob.id, MON(9), pat.id, { name: "Nick Valudes", phone: "(717) 575-8139", items: ["Listing Photography"] });
    const nobodyJob = await prisma.project.create({ data: { title: "9 Nobody Ln, Malvern, PA", addressLine: "9 Nobody Ln", city: "Malvern", clientId: client2.id, status: "SCHEDULED", shootDate: MON(15) }, select: { id: true } });
    const nobodyA = await appt(nobodyJob.id, MON(15), null, { name: "Nick Valudes", phone: "(717) 575-8139", items: ["Listing Photography"] });
    c.ok("the world is built", !!cliffV2 && !!richardA && !!satA && !!tueA && !!patA && !!nobodyA);

    const toHarrison = () => texts.filter((t) => t.to === "6105550144");
    const toJames = () => texts.filter((t) => t.to === "6105550133");
    const status = async (ids: string[]) => pb.briefStatusForAppointments(ids);
    const record = async (tm: string, day: string) => {
      const r = await prisma.appSetting.findUnique({ where: { key: pb.briefRecordKey(tm, day) } });
      return r ? core.parseRecord(r.value, tm, day) : null;
    };
    const lines = async (projectId: string) => (await prisma.activity.findMany({ where: { projectId, type: "SYSTEM" }, orderBy: { createdAt: "asc" } })).map((a) => a.body);

    // =====================================================================
    c.head("2 · The switch OFF (the default): nothing sends");
    // =====================================================================
    const offRun = await pb.sweepPhotographerBriefs(setNow(FRI(18, 5)));
    c.ok("Fri 6:05 PM with no settings row: the sweep is idle, says why", "skipped" in offRun && /switched off/.test(offRun.skipped), JSON.stringify(offRun));
    c.ok("…no text, no outbox row, no record", texts.length === 0 && (await prisma.outboxMessage.count()) === 0 && (await prisma.appSetting.count({ where: { key: { startsWith: "photographer_brief:day:" } } })) === 0);
    const offStatus = await status([richardA.id, cliffV2.id, patA.id, nobodyA.id]);
    c.ok("every status reads 'off', with the reason", [...offStatus.values()].every((s) => s.state === "off" && /switched off/.test(s.why ?? "")) && offStatus.size === 4, JSON.stringify([...offStatus.values()]));
    await signIn(owner);
    const offPress = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    c.ok("Send brief now is refused while off", !offPress.ok && /switched off/.test(offPress.message) && texts.length === 0, offPress.message);

    // =====================================================================
    c.head("3 · Settings: owner and admin only");
    // =====================================================================
    await signIn(kim);
    const byKim = await savePhotographerBrief({ enabled: true, sendMinute: 18 * 60 });
    c.ok("an editor cannot switch it on", !byKim.ok && !(await pb.photographerBriefSettings()).enabled, byKim.message);
    await signIn(kyle);
    const badTime = await savePhotographerBrief({ enabled: true, sendMinute: 3 * 60 });
    c.ok("a time the card does not offer is refused", !badTime.ok && !(await pb.photographerBriefSettings()).enabled, badTime.message);
    const byKyle = await savePhotographerBrief({ enabled: true, sendMinute: 18 * 60 });
    c.ok("the admin (Kyle) switches it on at 6 PM", byKyle.ok && (await pb.photographerBriefSettings()).enabled && /6:00 PM/.test(byKyle.message), byKyle.message);
    const row = await prisma.appSetting.findUnique({ where: { key: "photographer_brief" } });
    c.ok("stored as the AppSetting `photographer_brief`", row?.value === '{"enabled":true,"sendMinute":1080}' && row?.updatedBy === "kyle@drill.invalid", row?.value);

    // =====================================================================
    c.head("4 · Before the send time: pending");
    // =====================================================================
    setNow(FRI(17));
    const early = await status([richardA.id, tueA.id]);
    c.ok("Fri 5 PM: Monday's brief is pending, going out Fri at 6:00 PM", early.get(richardA.id)?.state === "pending" && early.get(richardA.id)?.why === "Goes out Fri Oct 23 at 6:00 PM." && early.get(richardA.id)?.sentAt === null, JSON.stringify(early.get(richardA.id)));
    c.ok("…Tuesday's goes Monday at 6:00 PM", early.get(tueA.id)?.why === "Goes out Mon Oct 26 at 6:00 PM.", early.get(tueA.id)?.why ?? "");
    await pb.sweepPhotographerBriefs(FRI(17));
    c.ok("a 5 PM tick sends nothing", texts.length === 0);

    // =====================================================================
    c.head("5 · Friday 6 PM: Monday (and Saturday) go, Tuesday does not");
    // =====================================================================
    const run = await pb.sweepPhotographerBriefs(setNow(FRI(18, 5)));
    console.log(`\n--- Fri 6:05 PM run ---\n${JSON.stringify(run)}\n---`);
    const hMon = toHarrison();
    c.ok("Harrison: ONE text, his Monday brief", hMon.length === 1 && hMon[0].body.startsWith(`${HUB_SMS_PREFIX}: Harrison, your shoots for Mon Oct 26\n\n1) `), hMon.map((t) => t.body.split("\n")[0]).join(" | "));
    console.log(`\n--- Harrison's Monday brief ---\n${hMon[0]?.body}\n---`);
    c.ok("James: ONE text, his Saturday brief (Friday covers the weekend)", toJames().length === 1 && toJames()[0].body.startsWith(`${HUB_SMS_PREFIX}: James, your shoot for Sat Oct 24\n\n1) `), toJames().map((t) => t.body).join(" | "));
    c.ok("no Tuesday brief yet", !texts.some((t) => t.body.includes("Tue Oct 27") || t.body.includes("77 Tuesday Ct")));
    const body = hMon[0]?.body ?? "";
    // Oct 28 2026: each shoot is its own block, one fact a line, a blank line between.
    const cliffLine = body.split("\n\n").find((l) => l.includes("615 Cliff Ln")) ?? "";
    const richardLine = body.split("\n\n").find((l) => l.includes("266 Richard Dr")) ?? "";
    c.ok("in time order: 11:00 AM Richard Dr, then 1:00 PM Cliff Ln", body.indexOf("\n\n1) 11:00 AM, 266 Richard Dr, Allentown\nServices: ") > 0 && body.indexOf("\n\n2) 1:00 PM, 615 Cliff Ln, Malvern (visit 2 of 2)\nServices: ") > body.indexOf("1) 11:00 AM"));
    c.ok("Cliff Ln: only this visit's services (the 3D tour), not the order's Social Influencer", cliffLine.includes("Services: Zillow Showcase 3D Tour Add-on.") && !cliffLine.includes("Social Influencer"), cliffLine);
    c.ok("Cliff Ln: this visit's requests (made since visit 1), the client's must-get included", cliffLine.includes("For the second visit: interiors and agent on camera") && cliffLine.includes("Must get: Client: Please make sure to capture the finished basement this time"), cliffLine);
    c.ok("Cliff Ln: never visit 1's 'Exteriors only' or its pool request, never the post-delivery lamp revision", !/Exteriors only|pool from the deck|lamp/i.test(cliffLine), cliffLine);
    // Oct 29 2026 (James's 907-character brief never arrived): a day this long keeps every
    // must-get and leave-out and leaves the contact and the earlier-visit line to the page.
    c.ok(`a long day stays under ${core.BRIEF_TEXT_MAX} characters, every request still in the text`, body.length <= core.BRIEF_TEXT_MAX && !body.includes("more on the brief page"), String(body.length));
    c.ok("…the contacts and the earlier visit's notes are left to the page", !body.includes("Contact: ") && !cliffLine.includes("Notes from the earlier visit"), body);
    c.ok("Richard Dr: services, access (lockbox, who's there), and the exclusion", richardLine.includes("Services: Social Influencer.") && richardLine.includes("Access: Lockbox or door code: 4417; Agent will be there.") && richardLine.includes("Leave out: Do not shoot the neighbor's yard, keep it tight."), richardLine);
    c.ok("ends with the full-brief link", body.trim().endsWith(`\n\nFull brief, then tap Got it:\n${appBase()}/shoot/brief/2026-10-26`), body.slice(-90));
    c.ok("no em or en dashes (the special instructions had one)", !DASH.test(body) && !texts.some((t) => DASH.test(t.body)));
    const outRows = await prisma.outboxMessage.findMany({ orderBy: { createdAt: "asc" } });
    const { outboxKind, isClientKind } = await import("@/lib/outbox");
    c.ok("through the durable outbox, a team kind, one row per send, no client on it", outRows.length === 2 && outRows.every((r) => outboxKind(r.dedupeKey) === "photographer_brief" && r.state === "accepted" && r.clientId === null) && !isClientKind("photographer_brief")
      && outRows.some((r) => r.dedupeKey === `photographer_brief:${harrison.id}:2026-10-26:1`), outRows.map((r) => r.dedupeKey).join(" "));
    // One per photographer per day, whatever the ticks.
    await pb.sweepPhotographerBriefs(setNow(FRI(18, 10)));
    setNow(FRI(18, 15));
    await Promise.all([pb.sweepPhotographerBriefs(FRI(18, 15)), pb.sweepPhotographerBriefs(FRI(18, 15)), pb.sweepPhotographerBriefs(FRI(18, 15))]);
    c.ok("6:10 PM and three overlapping 6:15 PM ticks: still ONE text each", toHarrison().length === 1 && toJames().length === 1 && (await prisma.outboxMessage.count()) === 2, `${toHarrison().length}/${toJames().length}`);
    c.ok("each job's timeline says the brief went", (await lines(richard.id)).includes("Texted Harrison the shoot brief for Mon Oct 26 at 6:05 PM.") && (await lines(cliff.id)).includes("Texted Harrison the shoot brief for Mon Oct 26 at 6:05 PM."), (await lines(richard.id)).join(" | "));
    c.ok("Harrison's delivery log has it", (await prisma.notificationDelivery.count({ where: { kind: "photographer_brief", teamMemberId: harrison.id, status: "sent" } })) === 1);

    // =====================================================================
    c.head("6 · Statuses (the dashboard's read)");
    // =====================================================================
    setNow(FRI(18, 20));
    const s6 = await status([richardA.id, cliffV2.id, patA.id, nobodyA.id, tueA.id, satA.id]);
    c.ok("Harrison's two Monday visits: sent, with when, no why yet", ["sent"].includes(s6.get(richardA.id)!.state) && s6.get(cliffV2.id)!.state === "sent" && Math.abs(Date.parse(s6.get(richardA.id)!.sentAt!) - FRI(18, 5).getTime()) < 60_000 && s6.get(richardA.id)!.why === null && s6.get(richardA.id)!.ackAt === null, JSON.stringify(s6.get(richardA.id)));
    c.ok("Pat (no phone): failed, with the reason", s6.get(patA.id)?.state === "failed" && s6.get(patA.id)?.why === "Not sent: no phone number on file for Pat", JSON.stringify(s6.get(patA.id)));
    c.ok("nobody on the shoot: failed, saying so", s6.get(nobodyA.id)?.state === "failed" && /No photographer on this shoot/.test(s6.get(nobodyA.id)?.why ?? ""), JSON.stringify(s6.get(nobodyA.id)));
    c.ok("Tuesday: pending", s6.get(tueA.id)?.state === "pending");
    c.ok("James's Saturday: sent", s6.get(satA.id)?.state === "sent");
    setNow(MON(9, 5));
    const s6b = await status([richardA.id]);
    c.ok("Mon 9:05 AM, first shoot 11:00 AM and no Got it: the why says so (the dashboard shows it)", s6b.get(richardA.id)?.state === "sent" && s6b.get(richardA.id)?.why === "Not acknowledged yet. First shoot 11:00 AM.", JSON.stringify(s6b.get(richardA.id)));
    setNow(FRI(18, 25));

    // =====================================================================
    c.head("7 · The full-brief page");
    // =====================================================================
    const render = async (day: string, as?: string) => renderToStaticMarkup(await briefPage({ params: Promise.resolve({ day }), searchParams: Promise.resolve(as ? { as } : {}) }));
    await signIn(harrisonLogin);
    const mine = await render("2026-10-26");
    c.ok("Harrison sees his day: both visits, the Got it button", mine.includes("Shoot brief, Mon Oct 26") && mine.includes("266 Richard Dr") && mine.includes("615 Cliff Ln") && mine.includes(">Got it<"), mine.slice(0, 300));
    c.ok("…visit 2 of 2, its own services, the earlier visit's notes folded (Exteriors only, the pool), the lamp revision nowhere",
      mine.includes("visit 2 of 2") && mine.includes("Zillow Showcase 3D Tour Add-on") && /<details[^>]*>[\s\S]*Exteriors only[\s\S]*pool from the deck[\s\S]*<\/details>/.test(mine) && !/lamp/i.test(mine));
    c.ok("…the forecast and, for the drone job, the FAA map, as planning information only (no go or no-go)", mine.includes("Forecast at 1:00 PM: 54°F, 10% chance of rain, wind 8 mph.") && mine.includes("FAA UAS map: uncontrolled airspace (Class G) here.") && mine.includes("For planning only.") && !/\b(?:no-go|go\/no|safe to fly|cleared to fly)\b/i.test(mine));
    const asJ = await render("2026-10-26", jamesTm.id);
    c.ok("a photographer can never look at someone else's (?as= ignored)", asJ.includes("266 Richard Dr") && !asJ.includes("10 Weekend Way"));
    await signIn(kyle);
    const kyleView = await render("2026-10-26", harrison.id);
    c.ok("the office reads Harrison's brief, without the button", kyleView.includes("266 Richard Dr") && !kyleView.includes(">Got it<") && kyleView.includes("Only Harrison can tap Got it"), kyleView.slice(0, 200));
    await signIn(kim);
    let kimWent = "";
    try { await render("2026-10-26", harrison.id); } catch (e) { kimWent = e instanceof Error ? e.message : String(e); }
    c.ok("an editor is sent home", /^redirect \//.test(kimWent), kimWent);
    c.ok("drawing the page sent nothing", texts.length === 2);

    // =====================================================================
    c.head("8 · Got it");
    // =====================================================================
    const built = (await pb.buildBriefDays(["2026-10-26"], { teamMemberIds: [harrison.id] })).briefs[0];
    await signIn(owner, harrisonLogin.id);
    const viaPreview = await actions.acknowledgePhotographerBrief("2026-10-26", built.digest);
    c.ok("the owner viewing as Harrison: refused (a preview never acknowledges)", !viaPreview.ok && /preview/i.test(viaPreview.message), viaPreview.message);
    await signIn(kyle);
    const byOther = await actions.acknowledgePhotographerBrief("2026-10-26", built.digest);
    c.ok("Kyle (not his brief): refused", !byOther.ok, byOther.message);
    await signIn(harrisonLogin);
    const stale = await actions.acknowledgePhotographerBrief("2026-10-26", "0".repeat(32));
    c.ok("a version that is not the current one: refused", !stale.ok && /changed while this page was open/.test(stale.message), stale.message);
    setNow(FRI(19, 12));
    const got = await actions.acknowledgePhotographerBrief("2026-10-26", built.digest);
    c.ok("Harrison taps Got it: recorded", got.ok && got.message === "Got it. Recorded at 7:12 PM.", got.message);
    const r8 = await record(harrison.id, "2026-10-26");
    c.ok("…who and when, and exactly what he acknowledged", r8?.ack?.by === "Harrison Wells" && r8.ack.userId === harrisonLogin.id && Math.abs(Date.parse(r8.ack.at) - FRI(19, 12).getTime()) < 60_000 && r8.ack.digest === built.digest && r8.acks.length === 1);
    const s8 = await status([richardA.id, cliffV2.id]);
    c.ok("status: acknowledged, with ackAt", s8.get(richardA.id)?.state === "acknowledged" && s8.get(cliffV2.id)?.state === "acknowledged" && !!s8.get(richardA.id)?.ackAt && s8.get(richardA.id)?.why === null, JSON.stringify(s8.get(richardA.id)));
    c.ok("the timeline says he did", (await lines(richard.id)).includes("Harrison tapped Got it on the shoot brief for Mon Oct 26 at 7:12 PM."));
    c.ok("the page now says Got it and shows no button", (await render("2026-10-26")).includes("Nothing has changed since") && !(await render("2026-10-26")).includes(">Got it<"));

    // =====================================================================
    c.head("9 · A non-material change sends nothing");
    // =====================================================================
    setNow(SAT(10));
    await prisma.appointment.update({ where: { id: richardA.id }, data: { endAt: MON(13), rawJson: rawOf(["Social Influencer"], { customer_choice_enabled: true, updated_at: "2026-10-24T14:00:00Z" }), description: desc({ name: "Nick Valudes", phone: "(717) 575-8139", items: ["Social Influencer"], presence: "Agent", lockbox: "4417", special: "Do not shoot the neighbor's yard — keep it tight.", flexible: "Not Flexible" }) } });
    await prisma.project.update({ where: { id: richard.id }, data: { paymentStatus: "PAID", notes: "Billing sorted." } as never }).catch(() => prisma.project.update({ where: { id: richard.id }, data: { notes: "Billing sorted." } }));
    const n9 = texts.length;
    const run9 = await pb.sweepPhotographerBriefs(SAT(10, 1));
    c.ok("the end time, the 'flexible' answer, Aryeo's bookkeeping fields and the payment changed: no text", texts.length === n9, JSON.stringify(run9));
    c.ok("…and the Got it still holds", (await status([richardA.id])).get(richardA.id)?.state === "acknowledged");

    // =====================================================================
    c.head("10 · Acceptance 8: a material change re-sends and needs a new Got it");
    // =====================================================================
    setNow(SAT(11));
    await prisma.appointment.update({ where: { id: richardA.id }, data: { startAt: MON(12) } });
    const before = (await status([richardA.id])).get(richardA.id);
    c.ok("moved to 12:00 PM: 'changed' at once, saying what (the update about to go)", before?.state === "changed" && /266 Richard Dr is now at 12:00 PM \(was 11:00 AM\)/.test(before?.why ?? ""), JSON.stringify(before));
    const n10 = toHarrison().length;
    await pb.sweepPhotographerBriefs(SAT(11, 1));
    const upd = toHarrison().slice(n10);
    console.log(`\n--- the update ---\n${upd[0]?.body}\n---`);
    // Oct 29 (James's call): the update is the change and the link, short enough to arrive; the day is on the page.
    c.ok("ONE updated brief: what changed and the link, asking for Got it again (no repeat of the day)",
      upd.length === 1 && upd[0].body === `${HUB_SMS_PREFIX}: Harrison, your Mon Oct 26 brief changed\n\nWhat changed: 266 Richard Dr is now at 12:00 PM (was 11:00 AM).\n\nPlease open it and tap Got it again:\n${appBase()}/shoot/brief/2026-10-26` && !upd[0].body.includes("1) 12:00 PM") && !DASH.test(upd[0].body), upd.map((t) => t.body).join(" | "));
    const s10 = (await status([richardA.id, cliffV2.id])).get(richardA.id);
    c.ok("status: changed (sent again, awaiting a new Got it), the old ackAt kept", s10?.state === "changed" && /Waiting for Harrison's new Got it/.test(s10?.why ?? "") && Math.abs(Date.parse(s10?.ackAt ?? "") - FRI(19, 12).getTime()) < 60_000, JSON.stringify(s10));
    const page10 = await (async () => { await signIn(harrisonLogin); return render("2026-10-26"); })();
    c.ok("the page shows what changed since his Got it, and the button again", page10.includes("Changed since your Got it at") && /data-brief-changes[\s\S]*266 Richard Dr is now at 12:00 PM \(was 11:00 AM\)/.test(page10) && page10.includes(">Got it (the updated brief)<"), page10.slice(0, 600));
    c.ok("…and marks it on the shoot that changed, not on the other one", new RegExp(`data-shoot-changed="${richardA.id}"[\\s\\S]*266 Richard Dr is now at 12:00 PM`).test(page10) && !page10.includes(`data-shoot-changed="${cliffV2.id}"`));
    await pb.sweepPhotographerBriefs(SAT(11, 10));
    c.ok("the next tick does not send it again", toHarrison().length === n10 + 1);
    const b10 = (await pb.buildBriefDays(["2026-10-26"], { teamMemberIds: [harrison.id] })).briefs[0];
    setNow(SAT(11, 20));
    const got2 = await actions.acknowledgePhotographerBrief("2026-10-26", b10.digest);
    c.ok("a new Got it: acknowledged again", got2.ok && (await status([richardA.id])).get(richardA.id)?.state === "acknowledged" && Math.abs(Date.parse((await status([richardA.id])).get(richardA.id)?.ackAt ?? "") - SAT(11, 20).getTime()) < 60_000, got2.message);
    c.ok("…both acknowledgments kept", (await record(harrison.id, "2026-10-26"))?.acks.length === 2);

    // A new request is material too.
    setNow(SAT(12));
    await prisma.activity.create({ data: { projectId: richard.id, type: "SPECIAL_REQUEST", body: "Please get twilight shots of the pool.", authorId: kyleTm.id, createdAt: SAT(12) } });
    const n10b = toHarrison().length;
    await pb.sweepPhotographerBriefs(SAT(12, 1));
    const upd2 = toHarrison().slice(n10b);
    c.ok("a new pre-shoot request: an updated brief, the request under Must get", upd2.length === 1 && upd2[0].body.includes('What changed: 266 Richard Dr: new must-get "Please get twilight shots of the pool".') && upd2[0].body.length <= core.BRIEF_TEXT_MAX, upd2.map((t) => t.body).join(" | "));
    const page10b = await (async () => { await signIn(harrisonLogin); return render("2026-10-26"); })();
    c.ok("…the page names the new request itself (Oct 28: James saw only \"requests changed\")", /data-brief-changes[\s\S]*266 Richard Dr: new must-get &quot;Please get twilight shots of the pool&quot;/.test(page10b), page10b.slice(0, 600));
    c.ok("…and the Got it no longer holds", (await status([richardA.id])).get(richardA.id)?.state === "changed");

    // A reassignment: visit 2 of Cliff Ln goes to James.
    setNow(SAT(13));
    await prisma.appointment.update({ where: { id: cliffV2.id }, data: { assignedToId: jamesTm.id } });
    const nH = toHarrison().length;
    const nJ = toJames().length;
    await pb.sweepPhotographerBriefs(SAT(13, 1));
    const hOff = toHarrison().slice(nH);
    const jNew = toJames().slice(nJ);
    c.ok("Harrison is told 615 Cliff Ln is off his schedule", hOff.length === 1 && hOff[0].body.includes("615 Cliff Ln is off your schedule") && !hOff[0].body.includes("2) "), hOff.map((t) => t.body).join(" | "));
    c.ok("James gets his Monday brief with it (his first for that day)", jNew.length === 1 && jNew[0].body.startsWith(`${HUB_SMS_PREFIX}: James, your shoot for Mon Oct 26\n\n`) && jNew[0].body.includes("615 Cliff Ln, Malvern (visit 2 of 2)"), jNew.map((t) => t.body).join(" | "));
    c.ok("…the Cliff Ln status is James's now: sent, no Got it", (await status([cliffV2.id])).get(cliffV2.id)?.state === "sent");

    // =====================================================================
    c.head("11 · A failed send reads 'failed'");
    // =====================================================================
    const samJob = await prisma.project.create({ data: { title: "3 Refused Rd, Malvern, PA", addressLine: "3 Refused Rd", city: "Malvern", clientId: client2.id, status: "SCHEDULED", shootDate: MON(10), photographerId: sam.id, orderItems: { create: [{ title: "Listing Photography", quantity: 1 }] } }, select: { id: true } });
    const samA = await appt(samJob.id, MON(10), sam.id, { name: "Nick Valudes", phone: "(717) 575-8139", items: ["Listing Photography"] });
    refuse.add("6105550177");
    await pb.sweepPhotographerBriefs(setNow(SAT(14)));
    const s11 = (await status([samA.id])).get(samA.id);
    c.ok("OpenPhone refuses Sam's brief: failed, with OpenPhone's reason", s11?.state === "failed" && /^Not sent: OpenPhone refused it/.test(s11?.why ?? "") && s11?.sentAt === null, JSON.stringify(s11));
    // A refused send frees its identity in the outbox (dedupeKey cleared), so the row is found by its number.
    const samRow = await prisma.outboxMessage.findFirst({ where: { toRef: "6105550177" } });
    c.ok("…nothing reached Sam, the outbox row is failed, no timeline line", !texts.some((t) => t.to === "6105550177") && samRow?.state === "failed" && !(await lines(samJob.id)).some((l) => /brief/.test(l)), `${samRow?.state} ${samRow?.providerError} | ${(await lines(samJob.id)).join(" | ")}`);
    await pb.sweepPhotographerBriefs(setNow(SAT(14, 5)));
    c.ok("5 minutes later: not retried yet (15-minute gap)", (await record(sam.id, "2026-10-26"))?.failed?.attempts === 1);
    refuse.delete("6105550177");
    await pb.sweepPhotographerBriefs(setNow(SAT(14, 20)));
    c.ok("15 minutes on, the cause fixed: it goes, and reads 'sent'", texts.filter((t) => t.to === "6105550177").length === 1 && (await status([samA.id])).get(samA.id)?.state === "sent");

    // Oct 28 2026 (James, Ashley Brunner's 3 PM): an update BEFORE any Got it. The
    // dashboard said "Brief changed"; the page only said "Sent" and never what.
    await prisma.activity.create({ data: { projectId: samJob.id, type: "SPECIAL_REQUEST", body: "Please get a photo of the new roof.", authorId: kyleTm.id, createdAt: SAT(14, 25) } });
    await pb.sweepPhotographerBriefs(setNow(SAT(14, 30)));
    const samUpd = texts.filter((t) => t.to === "6105550177").slice(1);
    c.ok("Sam's update names the new request, not \"requests changed\"", samUpd.length === 1 && samUpd[0].body.includes('3 Refused Rd: new must-get "Please get a photo of the new roof"') && !samUpd[0].body.includes("requests changed"), samUpd.map((t) => t.body).join(" | "));
    await signIn(kyle);
    const samPage = await render("2026-10-26", sam.id);
    c.ok("…his page (no Got it yet) says it changed after it was sent and lists the change with the time it went", samPage.includes("This brief changed after it was sent") && /data-brief-changes[\s\S]*2:30 PM: <\/span>3 Refused Rd: new must-get &quot;Please get a photo of the new roof&quot;/.test(samPage), samPage.slice(0, 900));
    c.ok("…and marks it on the shoot", new RegExp(`data-shoot-changed="${samA.id}"[\\s\\S]*new must-get`).test(samPage));
    c.ok("…the status reads changed, saying what", (await status([samA.id])).get(samA.id)?.state === "changed" && /new must-get "Please get a photo of the new roof"/.test((await status([samA.id])).get(samA.id)?.why ?? ""));

    // =====================================================================
    c.head("12 · Send brief now: who may press");
    // =====================================================================
    setNow(SAT(15));
    const nowCount = () => texts.length;
    const n12 = nowCount();
    await signIn(kim);
    const pKim = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    await signIn(harrisonLogin);
    const pH = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    await signIn(owner, kyle.id);
    const pPrev = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    c.ok("an editor, a photographer and the owner viewing as Kyle: refused, nothing sent",
      !pKim.ok && /Only the office and the creative manager/.test(pKim.message) && !pH.ok && /Only the office and the creative manager/.test(pH.message) && !pPrev.ok && /viewing the hub as someone else/.test(pPrev.message) && nowCount() === n12, `${pKim.message} | ${pH.message} | ${pPrev.message}`);
    await signIn(kyle);
    const pKyle = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    c.ok("the admin (Kyle): sent", pKyle.ok && nowCount() === n12 + 1 && texts[texts.length - 1].to === "6105550144", pKyle.message);
    c.ok("…the same brief again (nothing changed since the last update), and the timeline names him", texts[texts.length - 1].body.startsWith(`${HUB_SMS_PREFIX}: Harrison, your shoot for Mon Oct 26\n\n`) && (await lines(richard.id)).some((l) => l === "Kyle Smith texted Harrison the shoot brief for Mon Oct 26 again at 3:00 PM."), texts[texts.length - 1].body.split("\n")[0]);
    await signIn(james);
    const pJ1 = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    c.ok("a second press a moment later: refused, nothing sent", !pJ1.ok && /Give it a couple of minutes/.test(pJ1.message) && nowCount() === n12 + 1, pJ1.message);
    setNow(SAT(15, 5));
    const pJ2 = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    c.ok("the creative manager (James), later: sent", pJ2.ok && nowCount() === n12 + 2, pJ2.message);
    setNow(SAT(15, 10));
    await signIn(owner);
    const pO = await actions.sendPhotographerBriefNow(harrison.id, "2026-10-26");
    c.ok("the owner: sent", pO.ok && nowCount() === n12 + 3, pO.message);
    const pNone = await actions.sendPhotographerBriefNow(kimTm.id, "2026-10-26");
    c.ok("someone with no shoots that day: refused, saying so", !pNone.ok && /has no shoots on Mon Oct 26/.test(pNone.message), pNone.message);
    c.ok("a resend keeps the Got it state honest (the last update is still unacknowledged)", (await status([richardA.id])).get(richardA.id)?.state === "changed");

    // =====================================================================
    c.head("13 · The shoot-day text and the night-before text, folded in; OFF again");
    // =====================================================================
    const { sweepShootDayTexts } = await import("@/lib/shootDayText");
    setNow(MON(12, 1));
    const sd = await sweepShootDayTexts(MON(12, 1));
    c.ok("Mon 12:01 PM, Richard Dr's start: no shoot-day text (its requests were in Harrison's brief)", !texts.some((t) => t.body.includes("Special requests for this shoot")) && "notSent" in sd && sd.notSent.some((x) => /in the photographer brief/.test(x)), JSON.stringify(sd));
    // The night-before brief: Sunday's run for Monday would text; while on, it does not.
    const { runEveningAutomations } = await import("@/lib/eveningPush");
    await prisma.appSetting.upsert({ where: { key: "internal_alerts" }, create: { key: "internal_alerts", value: JSON.stringify({ eveningPush: { enabled: false } }) }, update: { value: JSON.stringify({ eveningPush: { enabled: false } }) } });
    const nEve = texts.length;
    const eve = await runEveningAutomations(setNow(OCT(25, 18, 5))).catch((e) => ({ error: String(e) }));
    c.ok("Sun 6:05 PM: the old night-before text does not go while the brief is on", texts.length === nEve && (await prisma.notificationDelivery.count({ where: { kind: "shoot_brief" } })) === 0 && !texts.some((t) => t.body.includes("Shoot brief for tomorrow")), JSON.stringify(eve).slice(0, 300));
    // OFF again.
    await signIn(owner);
    const offAgain = await savePhotographerBrief({ enabled: false, sendMinute: 18 * 60 });
    c.ok("switched off again", offAgain.ok && !(await pb.photographerBriefSettings()).enabled);
    setNow(MON(12, 6));
    const sd2 = await sweepShootDayTexts(MON(12, 6));
    c.ok("…the shoot-day text goes as before (inside its half hour)", texts.some((t) => t.to === "6105550144" && t.body.includes("266 Richard Dr, 12:00 PM. Special requests for this shoot:")), JSON.stringify(sd2));
    setNow(MON(9));
    await prisma.appointment.update({ where: { id: tueA.id }, data: { startAt: OCT(27, 11) } });
    const nOff = texts.length;
    const offRun2 = await pb.sweepPhotographerBriefs(MON(18, 5));
    c.ok("off: Monday 6 PM sends no Tuesday brief and no update", "skipped" in offRun2 && texts.length === nOff);
    c.ok("off: every status reads 'off'", [...(await status([richardA.id, tueA.id, samA.id])).values()].every((s) => s.state === "off"));

    // =====================================================================
    c.head("14 · Wired in, and the fence held");
    // =====================================================================
    const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
    c.ok("the gmail cron runs the step every 5 minutes, ahead of the shoot-day text", /step\("photographerBrief"/.test(src("src/app/api/cron/gmail/route.ts")) && src("src/app/api/cron/gmail/route.ts").indexOf('step("photographerBrief"') < src("src/app/api/cron/gmail/route.ts").indexOf('step("shootDayText"'));
    c.ok("a drained brief answers to the switch and is recorded", /kind === "photographer_brief"/.test(src("src/app/api/cron/gmail/route.ts")) && /recordDrainedBriefText/.test(src("src/app/api/cron/gmail/route.ts")));
    c.ok("the dashboard's export is exactly as agreed", /export type BriefState = "off" \| "pending" \| "sent" \| "failed" \| "acknowledged" \| "changed";/.test(src("src/lib/photographerBrief.ts")) && /export async function briefStatusForAppointments\(appointmentIds: string\[\]\): Promise<Map<string, \{ state: BriefState; sentAt: string \| null; ackAt: string \| null; why: string \| null \}>>/.test(src("src/lib/photographerBrief.ts")));
    c.ok("Send brief now asks the real login's role and refuses a preview", /isCreativeLead\(me\.realRole\)/.test(src("src/app/shoot/brief/actions.ts")) && /me\?\.impersonating/.test(src("src/app/shoot/brief/actions.ts")));
    c.ok("no outbound call but the forecast and the FAA map (answered here)", fence.blocked.length === 0 && fence.faked.every((u) => /open-meteo|arcgis/.test(u)), fence.blocked.join(" "));
    c.ok("only the team was texted, never a client", texts.every((t) => ["6105550144", "6105550133", "6105550177"].includes(t.to)), [...new Set(texts.map((t) => t.to))].join(","));
    const ours = [...texts.filter((t) => t.body.includes("brief") || t.body.includes("your shoot")).map((t) => t.body), ...(await prisma.activity.findMany({ where: { body: { contains: "brief" } } })).map((a) => a.body)];
    c.ok("no em or en dashes in any brief text or timeline line", ours.length >= 10 && ours.every((x) => !DASH.test(x)), `${ours.length} checked`);
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
