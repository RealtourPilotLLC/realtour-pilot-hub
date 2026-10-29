// ---------------------------------------------------------------------------
// DRILL: the scripts link on a content session's day (Oct 23 2026).
//
// Jordan: "make sure that the creatives (either Harrison or James) whoever is
// assigned to the appointment gets a text with a link to their My Shoots page
// for the scripts for the monthly content sessions. Like John's session today,
// Harrison should get a text." lib/sessionScriptsText: from 7 AM ET on the
// session's day until its start, once per job, creative and day, from the
// company line, behind its own switch.
//
// ISOLATION: PGlite via the shared harness; OpenPhone answered in-process;
// nothing outbound at all.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6751);

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
let offset = et(2026, 10, 23, 6).getTime() - RealDate.now();
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
const FRI = (h: number, mi = 0) => et(2026, 10, 23, h, mi);
const SAT = (h: number, mi = 0) => et(2026, 10, 24, h, mi);

installNextStubs();
const fence = fenceFetch(() => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-session-scripts" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { putSetting } = await import("@/lib/settings");
    const op = await import("@/lib/integrations/openphone");
    const OFFICE = "+16105550100";
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
    const texts: { to: string; body: string }[] = [];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
      texts.push({ to: String(to), body });
      return { data: { id: `op-${texts.length}` } };
    };
    const sst = await import("@/lib/sessionScriptsText");
    const { HUB_SMS_PREFIX } = await import("@/lib/hubSms");

    c.head("1 · The world: John's session at 1:30 PM with Harrison");
    const member = (name: string, email: string, phone: string | null) => prisma.teamMember.create({ data: { name, email, role: "PHOTOGRAPHER", phone, active: true }, select: { id: true } });
    const harrison = await member("Harrison Wells", "harrison@drill.invalid", "(610) 555-0144");
    const james = await member("James Livingston", "james@drill.invalid", "(610) 555-0133");
    const john = await prisma.client.create({ data: { name: "John Collins", phone: "6105550401" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", phone: "6105550402" } });
    let n = 0;
    const job = async (street: string, start: Date, who: string | null, extra: { content?: boolean; clientId?: string; apptStatus?: string; status?: string } = {}) => {
      const p = await prisma.project.create({
        data: { title: `${street}, Devon, PA`, addressLine: street, clientId: extra.clientId ?? john.id, status: (extra.status ?? "SCHEDULED") as never, shootDate: start, photographerId: who, contentMonthId: extra.content === false ? null : "month-drill" },
      });
      await prisma.appointment.create({ data: { aryeoId: `appt-${++n}`, projectId: p.id, startAt: start, endAt: new Date(start.getTime() + 4 * 3600_000), status: extra.apptStatus ?? "SCHEDULED", assignedToId: who } });
      return p;
    };
    const session = await job("80 W Lancaster Ave", FRI(13, 30), harrison.id);
    await job("9 Listing Rd", FRI(14), harrison.id, { content: false }); // a listing shoot: never this text
    await job("10 Cancel Ct", FRI(15), james.id, { apptStatus: "CANCELED" });
    await job("11 Test Rd", FRI(15), james.id, { clientId: fixture.id });
    await job("12 Dead End", FRI(15), james.id, { status: "CANCELLED" });
    const tomorrow = await job("13 Saturday Ln", SAT(9), james.id);
    c.ok("the world is built", !!session && !!tomorrow);

    c.head("2 · From 7 AM, before the start, once");
    await sst.sweepSessionScriptsTexts(setNow(FRI(6, 59)));
    c.ok("6:59 AM: nothing yet", texts.length === 0, String(texts.length));
    await sst.sweepSessionScriptsTexts(setNow(FRI(7, 0)));
    const h = texts.filter((t) => t.to.replace(/\D/g, "").endsWith("6105550144"));
    c.ok("7:00 AM: Harrison gets one text", h.length === 1, String(h.length));
    c.ok("…the words: who, when, where and the shoot page link", /^⚙️ Realtour Hub: Hi Harrison, John's content session is today at 1:30 PM at 80 W Lancaster Ave\.\n\nThe scripts are on your shoot page:\nhttps?:\/\/\S+\/shoot\/\S+$/.test(h[0]?.body ?? "") && !!h[0]?.body.endsWith(`/shoot/${session.id}`), h[0]?.body);
    c.ok("…no listing shoot, cancelled appointment, test client or cancelled job is texted", texts.length === 1, texts.map((t) => t.body.slice(0, 60)).join(" | "));
    await Promise.all([sst.sweepSessionScriptsTexts(setNow(FRI(7, 5))), sst.sweepSessionScriptsTexts(FRI(7, 5))]);
    c.ok("later ticks (two at once) send nothing again", texts.length === 1, String(texts.length));
    c.ok("one line on the job's timeline", (await prisma.activity.count({ where: { projectId: session.id, body: { startsWith: "Texted Harrison the link to today's scripts" } } })) === 1);
    c.ok("tomorrow's session waits for tomorrow", texts.every((t) => !t.body.includes("13 Saturday Ln")));

    c.head("3 · A session booked later that morning; after the start, nothing");
    const late = await job("14 Late Booking Rd", FRI(16), james.id);
    await sst.sweepSessionScriptsTexts(setNow(FRI(10, 15)));
    c.ok("booked mid-morning: James is texted on the next tick", texts.some((t) => t.to.replace(/\D/g, "").endsWith("6105550133") && t.body.endsWith(`/shoot/${late.id}`)));
    const started = await job("15 Started Ave", FRI(11), james.id);
    await sst.sweepSessionScriptsTexts(setNow(FRI(11, 1)));
    c.ok("a session that already started is not texted", texts.every((t) => !t.body.endsWith(`/shoot/${started.id}`)));

    c.head("4 · The switch");
    await putSetting("internal_alerts", { sessionScriptsText: { enabled: false } });
    const before = texts.length;
    const off = await sst.sweepSessionScriptsTexts(setNow(SAT(7, 30)));
    c.ok("switched off: nothing, and it says why", texts.length === before && "skipped" in off, JSON.stringify(off));
    await putSetting("internal_alerts", { sessionScriptsText: { enabled: true } });
    await sst.sweepSessionScriptsTexts(setNow(SAT(7, 31)));
    c.ok("on again: Saturday's session goes to James", texts.some((t) => t.body.endsWith(`/shoot/${tomorrow.id}`)));

    c.ok("only the creatives were ever texted", texts.every((t) => /6105550144$|6105550133$/.test(t.to.replace(/\D/g, ""))), texts.map((t) => t.to).join(","));
    c.ok("no outbound call at all", fence.blocked.length === 0, fence.blocked.join(" "));
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
