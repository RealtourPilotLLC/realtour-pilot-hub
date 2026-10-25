// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE FIELD SIDE'S WEEK (audit Oct 25 2026, area D).
//
//   DRILL_PORT=6200 node scripts/_drill/run-all.cjs scripts/_drill/oct25-d-field-week.ts
//
// What the audit found, live, for the week of Oct 26:
//   · Harrison's week off (Oct 26 to 30) was on the PTO tracker while five
//     shoots that week still named him, and the photographer brief texted him
//     Monday's on the Friday. Nothing told Kyle.
//   · Erica Walker's Oct 29 session brief read "Requests: hub-session:<id>:2 ·
//     booked by the hub for 2026-10, Erica Walker; Prepaid: Content Program
//     Accelerator (... no charge on this order)": the hub's own booking line in
//     the order notes, read as a client request (Janice Pigga's carries a
//     Stripe subscription id).
//
//   1. parseShootBrief / aryeoCustomerNote drop the hub's booking line and keep
//      every other order note.
//   2. The brief build marks a whole day off; a half day off is still a work day.
//   3. Mon 6 PM: James's Tuesday brief goes, Harrison's (PTO) does not; his
//      record says why, the desk reads "failed" with that sentence.
//   4. A brief that went before the time off (Monday's, sent Friday) reads
//      "failed" on the desk until it is reassigned or he taps Got it.
//   5. Send brief now still sends (a person decided he is shooting).
//   6. Reassigned in Aryeo: the new photographer gets the brief on the next tick.
//   7. The shoot-day text skips someone on PTO.
//   8. The session brief carries no hub-session line, no Stripe id, no dashes.
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6200);

// ---- the clock (ET wall times) -------------------------------------------------
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

installNextStubs();
const load = createRequire(__filename);
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.redirect = (href: string) => { throw new Error(`redirect ${href}`); };
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {} });
  navigation.useSearchParams = () => new URLSearchParams("");
}
const fence = fenceFetch(() => null);
const DASH = /[–—]/;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct25-d-field-week" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to).replace(/\D/g, "").slice(-10), body });
      return { data: { id: `op-${texts.length}` } };
    };
    const shoot = await import("@/lib/shoot");
    const pto = await import("@/lib/pto");
    const pb = await import("@/lib/photographerBrief");
    const core = await import("@/lib/photographerBriefCore");

    // =====================================================================
    c.head("1 · The hub's booking line is never an order note");
    // =====================================================================
    const sessionDesc = (marker: string) => [
      "Customer:", "Name: Erica Walker", "Email: erica@drill.invalid", "Phone: (610) 462-9907", "Notes: n/a", "",
      "Order Items Serviced By This Appointment:", " - (1x) Video Accelerator - 4HR Session: ", "",
      "Order Notes:", marker, "",
      "Order Questions:", "n/a", "", "Or View Full Order Details:", "https://app.aryeo.com/admin/orders/x/edit",
    ].join("\n");
    const HUB_LINE = "hub-session:cmvjvktdd0006jp07npqff1vu:2 · booked by the hub for 2026-10, Erica Walker. Prepaid: Content Program Accelerator via Stripe sub_1UIpTNRrlUAkQjeVlf3QBRoq (no charge on this order).";
    const only = shoot.parseShootBrief(shoot.cleanBrief(sessionDesc(HUB_LINE)));
    c.ok("an order whose only note is the hub's booking line has no order notes", !only?.orderNotes, JSON.stringify(only));
    c.ok("…and no customer note for the editor", shoot.aryeoCustomerNote(sessionDesc(HUB_LINE)) === null, String(shoot.aryeoCustomerNote(sessionDesc(HUB_LINE))));
    const mixed = shoot.parseShootBrief(shoot.cleanBrief(sessionDesc(`${HUB_LINE}\nPark on the street, the driveway is shared.`)));
    c.ok("a real note beside it is kept, the booking line dropped", mixed?.orderNotes === "Park on the street, the driveway is shared.", JSON.stringify(mixed?.orderNotes));
    const plain = shoot.parseShootBrief(shoot.cleanBrief(sessionDesc("Seller asks: no photos of the kids' rooms.")));
    c.ok("an ordinary order note is unchanged", plain?.orderNotes === "Seller asks: no photos of the kids' rooms.");
    c.ok("a note that only mentions a session is kept (the line has to START with the marker)", shoot.parseShootBrief(shoot.cleanBrief(sessionDesc("Second hub-session day, bring the gimbal.")))?.orderNotes === "Second hub-session day, bring the gimbal.");

    // =====================================================================
    c.head("2 · The world: Harrison off Mon Oct 26 to Fri Oct 30, James working");
    // =====================================================================
    const member = (name: string, email: string, role: "MANAGER" | "PHOTOGRAPHER", phone: string | null) =>
      prisma.teamMember.create({ data: { name, email, role, phone, active: true }, select: { id: true, name: true } });
    const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144");
    const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133");
    const kyleTm = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE);
    const ptoDoc = (entries: unknown[]) => JSON.stringify({ v: 1, entries, log: [] });
    const harrisonOff = () => prisma.appSetting.create({ data: { key: pto.ptoKey(harrison.id, "2026-09-25"), value: ptoDoc([{ id: "e1", startKey: "2026-10-26", endKey: "2026-10-30", type: "vacation", fraction: 1, note: "Week off", by: "owner", at: OCT(23, 20).toISOString() }]) } });
    await harrisonOff();
    // James: half a day off Thursday (he still works part of it).
    await prisma.appSetting.create({ data: { key: pto.ptoKey(james.id, "2026-09-25"), value: ptoDoc([{ id: "e2", startKey: "2026-10-29", endKey: "2026-10-29", type: "personal", fraction: 0.5, note: "Afternoon off", by: "owner", at: OCT(22, 16).toISOString() }]) } });
    await prisma.appSetting.create({ data: { key: "photographer_brief", value: JSON.stringify({ enabled: true, sendMinute: 1080 }) } });

    const off = await pto.fullDaysOff([
      { teamMemberId: harrison.id, day: "2026-10-26" }, { teamMemberId: harrison.id, day: "2026-10-30" }, { teamMemberId: harrison.id, day: "2026-10-31" },
      { teamMemberId: james.id, day: "2026-10-29" }, { teamMemberId: james.id, day: "2026-10-27" },
    ]);
    c.ok("fullDaysOff: Harrison Mon and Fri off, Sat Oct 31 not", off.has(`${harrison.id}|2026-10-26`) && off.has(`${harrison.id}|2026-10-30`) && !off.has(`${harrison.id}|2026-10-31`));
    c.ok("fullDaysOff: James's half day is a work day", !off.has(`${james.id}|2026-10-29`) && !off.has(`${james.id}|2026-10-27`));
    c.ok("an unreadable PTO row reads as nobody off", pto.fullDayOffEntry([{ startKey: "bad", endKey: "2026-10-30", fraction: 1 } as never], "2026-10-27") === null);

    const client = await prisma.client.create({ data: { name: "William Hannum", phone: "4133206523" } });
    const erica = await prisma.client.create({ data: { name: "Erica Walker", phone: "6104629907" } });
    const desc = (name: string, phone: string, items: string[], notes = "n/a") => [
      "Customer:", `Name: ${name}`, "Email: agent@drill.invalid", `Phone: ${phone}`, "Notes: n/a", "",
      "Order Items Serviced By This Appointment:", ...items.map((i) => ` - (1x) ${i}`), "",
      "Order Notes:", notes, "",
      "Order Questions:", " - Lock Box / Door Code: 0999", " - Will you or the seller be present at the appointment?: Vacant", "",
      "Or View Full Order Details:", "https://app.aryeo.com/admin/orders/x/edit",
    ].join("\n");
    let n = 0;
    const job = async (street: string, clientId: string, at: Date, who: string, d: string) => {
      const p = await prisma.project.create({ data: { title: `${street}, Philadelphia, PA`, addressLine: street, city: "Philadelphia", clientId, status: "SCHEDULED", shootDate: at, photographerId: who, orderItems: { create: [{ title: "Listing Photography", quantity: 1 }] }, deliverables: { create: [{ type: "PHOTOS", label: "Photos" }] } }, select: { id: true } });
      const a = await prisma.appointment.create({ data: { aryeoId: `aryeo-${++n}`, projectId: p.id, startAt: at, endAt: new Date(at.getTime() + 90 * 60_000), status: "SCHEDULED", assignedToId: who, description: d, rawJson: JSON.stringify({ items: [{ title: "Listing Photography", quantity: 1 }] }) }, select: { id: true } });
      return { projectId: p.id, apptId: a.id };
    };
    const monH = await job("266 Richard Dr", client.id, OCT(26, 11), harrison.id, desc("Nick Valudes", "(717) 575-8139", ["Social Influencer"]));
    const tueH = await job("2925 N 21st St", client.id, OCT(27, 11), harrison.id, desc("William Hannum", "(413) 320-6523", ["Listing Photography"]));
    const tueJ = await job("40 N Perry St", client.id, OCT(27, 9), james.id, desc("Ashley Brunner", "(717) 869-2868", ["Essentials Package"]));
    await job("877 S York Dr", erica.id, OCT(29, 8, 30), james.id, desc("Erica Walker", "(610) 462-9907", ["Video Accelerator - 4HR Session"], HUB_LINE));

    // Monday's brief went on Friday at 6, before the week off was on the tracker (entered at 8 PM).
    await prisma.appSetting.delete({ where: { key: pto.ptoKey(harrison.id, "2026-09-25") } });
    const fri = await pb.sweepPhotographerBriefs(setNow(OCT(23, 18, 5)));
    c.ok("Fri 6:05 PM (no time off yet): Harrison gets Monday's brief", "sent" in fri && fri.sent.some((s) => s.startsWith("Harrison Wells for 2026-10-26")) && texts.filter((t) => t.to === "6105550144").length === 1, JSON.stringify(fri));
    await harrisonOff();

    // =====================================================================
    c.head("3 · The build marks the day off");
    // =====================================================================
    setNow(OCT(26, 17));
    const build = await pb.buildBriefDays(["2026-10-27", "2026-10-29"], { now: OCT(26, 17) });
    const hTue = build.briefs.find((b) => b.teamMemberId === harrison.id && b.day === "2026-10-27");
    const jTue = build.briefs.find((b) => b.teamMemberId === james.id && b.day === "2026-10-27");
    const jThu = build.briefs.find((b) => b.teamMemberId === james.id && b.day === "2026-10-29");
    c.ok("Harrison's Tuesday is marked off, in words Kyle can act on", !!hTue?.offWhy && /Harrison is on PTO Tue Oct 27\. Reassign this shoot in Aryeo/.test(hTue.offWhy) && !DASH.test(hTue.offWhy), hTue?.offWhy ?? "none");
    c.ok("James's Tuesday and his half-day Thursday are work days", !jTue?.offWhy && !jThu?.offWhy && !!jThu);

    // =====================================================================
    c.head("4 · Monday 6 PM: James's Tuesday brief goes, Harrison's does not");
    // =====================================================================
    const before = texts.length;
    const mon = await pb.sweepPhotographerBriefs(setNow(OCT(26, 18, 5)));
    const newTexts = texts.slice(before);
    c.ok("James is texted his Tuesday brief", newTexts.some((t) => t.to === "6105550133" && t.body.includes("Tue Oct 27") && t.body.includes("40 N Perry St")), JSON.stringify(mon));
    c.ok("Harrison is not texted", !newTexts.some((t) => t.to === "6105550144"), newTexts.map((t) => t.to).join(","));
    c.ok("the run says why", "notSent" in mon && mon.notSent.some((s) => /Harrison Wells for 2026-10-27: Harrison is on PTO/.test(s)), JSON.stringify(mon));
    const recRow = await prisma.appSetting.findUnique({ where: { key: pb.briefRecordKey(harrison.id, "2026-10-27") } });
    const rec = recRow ? core.parseRecord(recRow.value, harrison.id, "2026-10-27") : null;
    c.ok("his record holds the reason, nothing marked sent", !!rec?.failed && /on PTO/.test(rec.failed.why) && !rec.sent, recRow?.value);
    const again = await pb.sweepPhotographerBriefs(setNow(OCT(26, 18, 40)));
    c.ok("later ticks stay quiet and write nothing new", !texts.slice(before).some((t) => t.to === "6105550144") && "notSent" in again && (await prisma.appSetting.findUnique({ where: { key: pb.briefRecordKey(harrison.id, "2026-10-27") } }))?.value === recRow?.value);

    // =====================================================================
    c.head("5 · The desk reads it");
    // =====================================================================
    const st = await pb.briefStatusForAppointments([tueH.apptId, tueJ.apptId, monH.apptId]);
    c.ok("Tuesday's Harrison shoot: failed, with the PTO sentence", st.get(tueH.apptId)?.state === "failed" && /on PTO Tue Oct 27/.test(st.get(tueH.apptId)?.why ?? ""), JSON.stringify(st.get(tueH.apptId)));
    c.ok("Tuesday's James shoot: sent", st.get(tueJ.apptId)?.state === "sent", JSON.stringify(st.get(tueJ.apptId)));
    c.ok("Monday's (sent Friday, before the time off was entered): failed, 'still names them'", st.get(monH.apptId)?.state === "failed" && /on PTO Mon Oct 26, but this shoot still names them/.test(st.get(monH.apptId)?.why ?? ""), JSON.stringify(st.get(monH.apptId)));

    // =====================================================================
    c.head("6 · A person can still send it; Got it clears the desk");
    // =====================================================================
    const pressed = await pb.sendBriefNow(harrison.id, "2026-10-27", { name: "Kyle Smith" }, setNow(OCT(26, 19)));
    c.ok("Send brief now sends (Kyle decided Harrison is shooting after all)", pressed.ok && texts.some((t) => t.to === "6105550144" && t.body.includes("Tue Oct 27")), pressed.message);
    const view = await pb.briefPageView(harrison.id, "2026-10-26", OCT(26, 8));
    const ack = await pb.acknowledgeBrief({ teamMemberId: harrison.id, day: "2026-10-26", digest: view.brief!.digest, by: "Harrison Wells", userId: null, now: OCT(26, 8) });
    c.ok("Harrison taps Got it on Monday's brief", ack.ok, ack.message);
    const st2 = await pb.briefStatusForAppointments([monH.apptId]);
    c.ok("…and Monday reads acknowledged (he is shooting)", st2.get(monH.apptId)?.state === "acknowledged", JSON.stringify(st2.get(monH.apptId)));

    // =====================================================================
    c.head("7 · Reassigned in Aryeo: the new photographer is briefed");
    // =====================================================================
    const wed = await job("3828 N Percy St", client.id, OCT(28, 7, 30), harrison.id, desc("Stephen Kennedy", "(267) 614-3033", ["Listing Photography"]));
    await pb.sweepPhotographerBriefs(setNow(OCT(27, 18, 5)));
    c.ok("Tue 6 PM: Wednesday's Harrison shoot is held", !texts.some((t) => t.to === "6105550144" && t.body.includes("Wed Oct 28")));
    await prisma.appointment.update({ where: { id: wed.apptId }, data: { assignedToId: james.id } });
    await prisma.project.update({ where: { id: wed.projectId }, data: { photographerId: james.id } });
    await pb.sweepPhotographerBriefs(setNow(OCT(27, 18, 10)));
    c.ok("the next tick briefs James for Wednesday", texts.some((t) => t.to === "6105550133" && t.body.includes("Wed Oct 28") && t.body.includes("3828 N Percy St")));
    c.ok("…and Harrison still hears nothing about it", !texts.some((t) => t.to === "6105550144" && t.body.includes("Wed Oct 28")));

    // =====================================================================
    c.head("8 · The shoot-day text skips someone on PTO");
    // =====================================================================
    await prisma.activity.create({ data: { projectId: tueH.projectId, type: "SPECIAL_REQUEST", body: "Get the corner lot from the street.", authorId: kyleTm.id, createdAt: OCT(25, 9) } });
    const { shootDayCandidates } = await import("@/lib/shootDayText");
    const cands = await shootDayCandidates(setNow(OCT(27, 11, 10)));
    const hc = cands.find((x) => x.teamMemberId === harrison.id && x.projectId === tueH.projectId);
    c.ok("Harrison's Tuesday shoot: no shoot-day text (Kyle's press put the requests in his brief)", !!hc && hc.text === null && hc.skip === "in the photographer brief", JSON.stringify(hc));
    await prisma.appSetting.delete({ where: { key: pb.briefRecordKey(harrison.id, "2026-10-27") } });
    const cands2 = await shootDayCandidates(OCT(27, 11, 10));
    const hc2 = cands2.find((x) => x.teamMemberId === harrison.id && x.projectId === tueH.projectId);
    c.ok("…with no brief on record at all, PTO alone holds it", hc2?.skip === "on PTO that day" && hc2.text === null, JSON.stringify(hc2));

    // =====================================================================
    c.head("9 · The session brief carries no booking line");
    // =====================================================================
    await pb.sweepPhotographerBriefs(setNow(OCT(28, 18, 5)));
    const thu = texts.find((t) => t.to === "6105550133" && t.body.includes("Thu Oct 29"));
    c.ok("James's Thursday brief went (half day off is not a day off)", !!thu, texts.map((t) => t.body.split("\n")[0]).join(" | "));
    c.ok("…naming Erica's session without the hub's booking line or a Stripe id", !!thu && thu.body.includes("877 S York Dr") && !/hub-session|Stripe|sub_|Prepaid|no charge/i.test(thu.body), thu?.body);
    const page = await pb.briefPageView(james.id, "2026-10-29", OCT(28, 19));
    const york = page.brief?.shoots.find((s) => s.street.includes("877 S York Dr"));
    c.ok("the full-brief page has no requests from it either", !!york && !york.requests.some((r) => /hub-session|Prepaid/i.test(r)) && !york.must.length, JSON.stringify(york?.requests));
    c.ok("no dashes in any text sent", texts.every((t) => !DASH.test(t.body)));
    c.ok("no outbound call", fence.blocked.length === 0, fence.blocked.join(" "));
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
