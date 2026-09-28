// ---------------------------------------------------------------------------
// DRILL: THE EMAIL REPLY-SLA LANE (O06 / AU-07, unified handoff batch 5,
// Sep 26 2026) — and the §9 "one owner" refinement of the text pager's tier 1.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/email-sla.ts
//
// Jordan (Sep 25–26): "Bell only — no texts or Slack DMs; counting covered
// hours only (Mon–Fri 9–6 ET); Kyle's bell after 4 covered hours unanswered,
// Jordan's after 9; a client flagged unhappy escalates at 4; never nights or
// weekends."
//
// Isolated PGlite; fetch and raw sockets fenced (nothing leaves); the clock is
// pinned (a Friday 5:30 PM email, a weekend, a Monday). OLD behaviour first:
// src/lib/commsSla.ts at 17df024 (pinned — never HEAD) is loaded for real and
// run on the same rows.
//
//   1. OLD (17df024): an email waiting three covered days rings nobody.
//   2. Switch OFF: still nobody, no watermark; the text pager's pages are the
//      same keys and audiences the old code wrote.
//   3. Switched on Thu 10:00 → the watermark. A wait from Wednesday (the
//      backlog) never rings.
//   4. Fri 5:30 PM email: nothing Fri 5:45, Sat, Sun, Mon 9:00, Mon 12:29;
//      Kyle's OWN bell (tm:, not a broadcast) at Mon 12:30; three more sweeps
//      add nothing; Jordan's OWNER bell at Mon 5:30 PM (9 covered hours), not
//      one minute before.
//   5. An unhappy email reaches Jordan at 4 covered hours; the weekend rings
//      nothing; not one NotificationDelivery sms/slack row and not one
//      outbound request for the email lane.
//   6. Noise: a receipt, an auto-reply, an email we answered (gmail-sent), a
//      thread ticked Handled — none rings.
//   7. One email in info@ AND hello@ → one row per tier after three sweeps.
//   8. The owner is the reply task's owner (James here), not always Kyle.
//   9. Text pager tier 1 (§9): Kyle-owned → the ADMIN row names him, no
//      second row; owned by a photographer login → ADMIN copy + their own row.
//  10. Settings: an inverted pair reads as the default; off → on restarts the
//      watermark.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5783);
const BASE = "17df024"; // pinned: the tree batch 5 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
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
let offset = et(2026, 9, 30, 9).getTime() - RealDate.now();
/** Move the whole process's clock — sweepReplySla reads `new Date()` itself. */
const setNow = (d: Date) => { offset = d.getTime() - RealDate.now(); };
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

// The week: Wed Sep 30 → Tue Oct 6 2026 (EDT). Coverage = Mon–Fri 9–6.
const WED_BACKLOG = et(2026, 9, 30, 10);
const THU_ON = et(2026, 10, 1, 10);
const FRI_1730 = et(2026, 10, 2, 17, 30);

installNextStubs();
const fence = fenceFetch();

// ---- the old code, runnable ----------------------------------------------------
const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "email-sla-base-"));
fs.symlinkSync(path.join(REPO, "node_modules"), path.join(baseDir, "node_modules"));
const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8" });
async function loadBase<T>(rel: string): Promise<T> {
  const file = path.join(baseDir, rel.replace(/\//g, "__"));
  fs.writeFileSync(file, show(rel).replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`));
  return (await import(file)) as T;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const sla = await import("@/lib/commsSla");
  const oldSla = await loadBase<typeof import("@/lib/commsSla")>("src/lib/commsSla.ts");
  const { unansweredComms } = await import("@/lib/replyQueue");
  const { markCommsHandled } = await import("@/app/actions");
  const c = makeChecker();

  // ---- the cast --------------------------------------------------------------
  type Role = Parameters<typeof prisma.teamMember.create>[0]["data"]["role"];
  const mkMember = (name: string, email: string, role: Role) =>
    prisma.teamMember.create({ data: { name, email, role, active: true, payPercent: 0.35, payFloor: 100 }, select: { id: true, name: true } });
  const jordan = await mkMember("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER");
  const kyle = await mkMember("Kyle Smith", "kyle@drill.invalid", "MANAGER");
  const james = await mkMember("James Carter", "james@drill.invalid", "PHOTOGRAPHER");
  const harrison = await mkMember("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER");
  const login = (email: string, role: string, teamMemberId: string) =>
    prisma.appUser.create({ data: { email, role, status: "ACTIVE", teamMemberId } });
  await login("jordan@drill.invalid", "OWNER", jordan.id);
  await login("kyle@drill.invalid", "ADMIN", kyle.id);
  await login("james@drill.invalid", "ADMIN", james.id);
  await login("harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);

  const mkClient = (name: string, email: string, phone?: string) =>
    prisma.client.create({ data: { name, email, phone: phone ?? null }, select: { id: true, name: true } });
  let ext = 0;
  const emailIn = (o: { clientId: string; name: string; subject: string; body: string; at: Date; mailbox?: string; extId?: string }) =>
    prisma.commLog.create({
      data: {
        channel: "email", direction: "in", clientId: o.clientId, clientName: o.name, contactName: o.name,
        subject: o.subject, body: o.body, occurredAt: o.at, source: "gmail",
        externalId: o.extId ?? `gmail-${o.mailbox ?? "info@realtourpilot.com"}:m${++ext}`,
      },
    });
  const textIn = (o: { clientId: string; name: string; phone: string; body: string; at: Date }) =>
    prisma.commLog.create({ data: { channel: "text", direction: "in", clientId: o.clientId, clientName: o.name, contactName: o.name, fromPhone: o.phone, body: o.body, occurredAt: o.at, source: "openphone" } });
  const replyTask = (clientId: string, ownerId: string, source: string, key: string) =>
    prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply", source, clientId, ownerId, dedupeKey: key, priority: "HIGH" } });

  const emailRows = (where: object = {}) => prisma.notification.findMany({ where: { kind: "reply_sla_email", ...where }, orderBy: { createdAt: "asc" } });
  const e1 = (clientId: string) => emailRows({ dedupeKey: { startsWith: `sla-e1-${clientId}-` } });
  const e2 = (clientId: string) => emailRows({ dedupeKey: { startsWith: `sla-e2-${clientId}-` } });
  const sweepAt = async (d: Date) => { setNow(d); return sla.sweepEmailSla(d); };

  // =========================================================================
  c.head("1 · OLD (17df024): unanswered email rings nobody");
  // =========================================================================
  const erica = await mkClient("Erica Walker", "erica@clients.invalid");
  await emailIn({ clientId: erica.id, name: "Erica Walker", subject: "Vertical cut for 812 Linden Ave?", body: "Can you send the vertical cut for 812 Linden Ave by Friday? We list on Monday.", at: FRI_1730 });
  const MON_1230 = et(2026, 10, 5, 12, 30);
  setNow(MON_1230);
  const oldRun = await oldSla.sweepReplySla();
  c.ok("OLD: the pager reads phone only — a Monday sweep with Erica's emails waiting three days checks 0 and rings nothing", oldRun.checked === 0 && (await prisma.notification.count()) === 0, JSON.stringify(oldRun));

  // =========================================================================
  c.head("2 · Switched OFF: still nobody, no watermark, the text pager unchanged");
  // =========================================================================
  await sla.saveEmailSlaRules({ enabled: false }, "drill");
  const offRun = await sla.sweepEmailSla(MON_1230);
  c.ok("off: the email lane does nothing", !offRun.enabled && (await emailRows()).length === 0);
  c.ok("off: no watermark row exists", !(await prisma.appSetting.findUnique({ where: { key: sla.EMAIL_SLA_SINCE_KEY } })));
  // The same text, paged by the OLD code and then by the NEW code: same keys,
  // same ADMIN/OWNER audiences at index 0 (the ledger alreadySent() reads).
  const priya = await mkClient("Priya Nair", "priya@clients.invalid", "(610) 555-0177");
  await textIn({ clientId: priya.id, name: "Priya Nair", phone: "6105550177", body: "Hi — can we move Thursday's shoot at 58 Windrow Dr to 2pm?", at: et(2026, 10, 5, 9, 45) });
  setNow(MON_1230);
  await oldSla.sweepReplySla();
  const oldPhone = (await prisma.notification.findMany({ where: { kind: "reply_sla" }, orderBy: { dedupeKey: "asc" } })).map((n) => `${n.dedupeKey}|${n.audience}|${n.userKey ?? "-"}`);
  await prisma.notification.deleteMany({ where: { kind: "reply_sla" } });
  await sla.sweepReplySla();
  const newPhone = (await prisma.notification.findMany({ where: { kind: "reply_sla" }, orderBy: { dedupeKey: "asc" } })).map((n) => `${n.dedupeKey}|${n.audience}|${n.userKey ?? "-"}`);
  c.ok("the text pager wrote the same rows the old code wrote (no reply task → nobody named)", oldPhone.length === 2 && JSON.stringify(oldPhone) === JSON.stringify(newPhone), `${oldPhone.join(" ; ")} VS ${newPhone.join(" ; ")}`);
  c.ok("and still nothing for email while the lane is off", (await emailRows()).length === 0);

  // =========================================================================
  c.head("3 · Switched on Thursday 10:00 — the watermark");
  // =========================================================================
  setNow(THU_ON);
  const on = await sla.saveEmailSlaRules({ enabled: true }, "drill");
  const sinceRow = await prisma.appSetting.findUnique({ where: { key: sla.EMAIL_SLA_SINCE_KEY } });
  c.ok("Jordan's numbers are the defaults: Kyle 4, Jordan 9, unhappy 4", on.kyleCoveredHours === 4 && on.ownerCoveredHours === 9 && on.unhappyCoveredHours === 4 && on.enabled, JSON.stringify(on));
  c.ok("turning it on stamps the watermark at that moment", !!sinceRow && Math.abs(Date.parse(JSON.parse(sinceRow.value).since) - THU_ON.getTime()) < 10_000, sinceRow?.value);
  const noah = await mkClient("Noah Brandt", "noah@clients.invalid");
  await emailIn({ clientId: noah.id, name: "Noah Brandt", subject: "Drone footage for 1904 Foxfield Rd", body: "Is the drone footage for 1904 Foxfield Rd going to be included?", at: WED_BACKLOG });

  // =========================================================================
  c.head("4 · Friday 5:30 PM email: Kyle's bell Monday 12:30, Jordan's Monday 5:30");
  // =========================================================================
  for (const [label, at] of [
    ["Fri 5:45 PM (15 covered minutes)", et(2026, 10, 2, 17, 45)],
    ["Sat 12:00 PM (a weekend)", et(2026, 10, 3, 12)],
    ["Sun 8:00 PM (a weekend night)", et(2026, 10, 4, 20)],
    ["Mon 9:00 AM (30 covered minutes)", et(2026, 10, 5, 9)],
    ["Mon 12:29 PM (3h 59m covered)", et(2026, 10, 5, 12, 29)],
  ] as const) {
    await sweepAt(at);
    c.ok(`nothing rings at ${label}`, (await e1(erica.id)).length === 0);
  }
  await sweepAt(MON_1230);
  let k1 = await e1(erica.id);
  c.ok("Mon 12:30 PM (4 covered hours): ONE bell row", k1.length === 1, `${k1.length}`);
  c.ok("…addressed to Kyle by name (tm:), not an ADMIN broadcast", k1[0]?.userKey === `tm:${kyle.id}`, k1[0]?.userKey ?? "none");
  c.ok("…pointing at the client, saying covered hours", k1[0]?.href === `/clients/${erica.id}` && /covered/.test(k1[0]?.body ?? ""), `${k1[0]?.href} · ${k1[0]?.body}`);
  c.ok("…and Jordan's bell has NOT rung", (await e2(erica.id)).length === 0);
  for (let i = 0; i < 3; i++) await sweepAt(new Date(MON_1230.getTime() + (i + 1) * 5 * 60_000));
  k1 = await e1(erica.id);
  c.ok("three more sweeps: still exactly one Kyle row", k1.length === 1, `${k1.length}`);
  await sweepAt(et(2026, 10, 5, 17, 29));
  c.ok("Mon 5:29 PM (8h 59m covered): Jordan's bell still quiet", (await e2(erica.id)).length === 0);
  await sweepAt(et(2026, 10, 5, 17, 30));
  const j2 = await e2(erica.id);
  c.ok("Mon 5:30 PM (9 covered hours): Jordan's OWNER bell", j2.length === 1 && j2[0].audience === JSON.stringify(["OWNER"]) && !j2[0].userKey, j2.map((n) => n.audience).join(" "));
  const backlog = await emailRows({ dedupeKey: { contains: noah.id } });
  c.ok("the Wednesday backlog email (before the watermark) never rang, with far more than 9 covered hours on it", backlog.length === 0, `${backlog.length}`);

  // =========================================================================
  c.head("5 · Unhappy at 4; never at night; bell only");
  // =========================================================================
  const gail = await mkClient("Gail Moreno", "gail@clients.invalid");
  await emailIn({ clientId: gail.id, name: "Gail Moreno", subject: "Still no photos for 632 Greenridge Rd", body: "This is unacceptable. We were promised the photos for 632 Greenridge Rd yesterday and nobody has told us anything. When will they be delivered?", at: et(2026, 10, 5, 9) });
  const outboundBefore = fence.blocked.length;
  await sweepAt(et(2026, 10, 5, 12, 59));
  c.ok("3h 59m: nothing for the unhappy client yet", (await e1(gail.id)).length === 0 && (await e2(gail.id)).length === 0);
  await sweepAt(et(2026, 10, 5, 13));
  c.ok("4 covered hours: Kyle's bell AND Jordan's (unhappy escalates at 4)", (await e1(gail.id)).length === 1 && (await e2(gail.id)).length === 1);
  c.ok("…and Jordan's row says why", /unhappy/i.test((await e2(gail.id))[0]?.body ?? ""), (await e2(gail.id))[0]?.body ?? "");
  const hugo = await mkClient("Hugo Lindqvist", "hugo@clients.invalid");
  await emailIn({ clientId: hugo.id, name: "Hugo Lindqvist", subject: "Twilight add-on", body: "Can we add a twilight session to the 18 Birch Ln shoot? It's really disappointing we missed it.", at: et(2026, 10, 5, 16) });
  await sweepAt(et(2026, 10, 5, 22)); // Mon 10 PM
  await sweepAt(et(2026, 10, 6, 6)); // Tue 6 AM
  c.ok("an unhappy email with 2 covered hours rings nobody overnight (Mon 10 PM, Tue 6 AM)", (await e1(hugo.id)).length + (await e2(hugo.id)).length === 0);
  await sweepAt(et(2026, 10, 6, 11));
  c.ok("…and rings both at Tue 11:00 AM, when its fourth covered hour lands", (await e1(hugo.id)).length === 1 && (await e2(hugo.id)).length === 1);
  const legs = await prisma.notificationDelivery.findMany({ where: { kind: "reply_sla_email" }, select: { channel: true, status: true } });
  c.ok("the delivery log for the email lane holds bell legs only — no sms, no slack", legs.length > 0 && legs.every((l) => l.channel === "bell"), legs.map((l) => `${l.channel}/${l.status}`).join(" "));
  c.ok("the email lane made no outbound request (no Slack, no OpenPhone)", fence.blocked.length === outboundBefore, fence.blocked.slice(outboundBefore).join(" "));

  // =========================================================================
  c.head("6 · Noise, answered, handled: none of it rings");
  // =========================================================================
  const T6 = et(2026, 10, 6, 9, 5);
  const iris = await mkClient("Iris Park", "iris@clients.invalid");
  await emailIn({ clientId: iris.id, name: "Iris Park", subject: "Your receipt from Stripe", body: "Payment received. Amount: $450.00", at: T6 });
  const oscar = await mkClient("Oscar Vance", "oscar@clients.invalid");
  await emailIn({ clientId: oscar.id, name: "Oscar Vance", subject: "Automatic reply: 44 Elm St photos", body: "I am out of the office until Monday.", at: T6 });
  const rosa = await mkClient("Rosa Delgado", "rosa@clients.invalid");
  await emailIn({ clientId: rosa.id, name: "Rosa Delgado", subject: "Keys for 9 Mill Rd", body: "Where should I leave the keys for 9 Mill Rd on Thursday?", at: T6 });
  await prisma.commLog.create({ data: { channel: "email", direction: "out", clientId: rosa.id, clientName: "Rosa Delgado", contactName: "Us", subject: "Re: Keys for 9 Mill Rd", body: "The lockbox on the side door is perfect.", occurredAt: new Date(T6.getTime() + 20 * 60_000), source: "gmail-sent", externalId: "gmail-sent-rosa-1" } });
  const tom = await mkClient("Tom Becker", "tom@clients.invalid");
  await emailIn({ clientId: tom.id, name: "Tom Becker", subject: "Walkthrough video length", body: "How long will the walkthrough video be for 7 Oak Ct?", at: T6 });
  setNow(new Date(T6.getTime() + 30 * 60_000));
  const tomThread = (await unansweredComms({ now: new Date(), families: ["email"] })).find((t) => t.clientId === tom.id);
  const tick = tomThread ? await markCommsHandled(tom.id, "email", undefined, { threadKey: tomThread.key }) : { ok: false, message: "no thread" };
  c.ok("Tom's thread is ticked Handled on the board", tick.ok, tick.message ?? "");
  for (let i = 0; i < 3; i++) await sweepAt(et(2026, 10, 6, 14 + i));
  for (const [who, id] of [["a Stripe receipt", iris.id], ["an out-of-office auto-reply", oscar.id], ["an email we answered from Gmail (gmail-sent)", rosa.id], ["a thread ticked Handled", tom.id]] as const) {
    c.ok(`${who} never rings`, (await emailRows({ dedupeKey: { contains: id } })).length === 0);
  }

  // =========================================================================
  c.head("7 · One email in BOTH inboxes → one row per tier");
  // =========================================================================
  const lena = await mkClient("Lena Ortiz", "lena@clients.invalid");
  const DUP_AT = et(2026, 10, 6, 9, 10);
  for (const mb of ["info@realtourpilot.com", "hello@realtourpilot.com"]) {
    await emailIn({ clientId: lena.id, name: "Lena Ortiz", subject: "Reels for 5 Quarry Ln", body: "Could we get both reels for 5 Quarry Ln in vertical as well?", at: DUP_AT, mailbox: mb });
  }
  for (let i = 0; i < 3; i++) await sweepAt(et(2026, 10, 6, 13, 10 + i));
  c.ok("three sweeps at 4 covered hours: exactly ONE Kyle row for the doubled email", (await e1(lena.id)).length === 1, `${(await e1(lena.id)).length}`);
  for (let i = 0; i < 3; i++) await sweepAt(et(2026, 10, 7, 9, 10 + i));
  c.ok("…and exactly ONE Jordan row at 9 covered hours", (await e2(lena.id)).length === 1, `${(await e2(lena.id)).length}`);

  // =========================================================================
  c.head("8 · The bell goes to the reply task's owner");
  // =========================================================================
  const nia = await mkClient("Nia Brooks", "nia@clients.invalid");
  await replyTask(nia.id, james.id, "gmail", `${nia.id}|noproject|client_reply`);
  await emailIn({ clientId: nia.id, name: "Nia Brooks", subject: "Headshot retouch", body: "Can the headshots be retouched a little softer?", at: et(2026, 10, 7, 9) });
  await sweepAt(et(2026, 10, 7, 13));
  const niaRow = (await e1(nia.id))[0];
  c.ok("a client whose email reply task is James's rings JAMES's bell, not Kyle's", niaRow?.userKey === `tm:${james.id}`, niaRow?.userKey ?? "none");

  // =========================================================================
  c.head("9 · Text pager tier 1: one owner, one informational copy (§9)");
  // =========================================================================
  const T9 = et(2026, 10, 7, 10);
  const vic = await mkClient("Victor Hale", "victor@clients.invalid", "(484) 555-0161");
  await replyTask(vic.id, kyle.id, "openphone", `${vic.id}|noproject|client_reply`);
  await textIn({ clientId: vic.id, name: "Victor Hale", phone: "4845550161", body: "Is the 3D tour for 2 Ridge Rd live yet?", at: T9 });
  const wen = await mkClient("Wendy Cole", "wendy@clients.invalid", "(484) 555-0162");
  await replyTask(wen.id, harrison.id, "openphone", `${wen.id}|noproject|client_reply`);
  await textIn({ clientId: wen.id, name: "Wendy Cole", phone: "4845550162", body: "Harrison, what time tomorrow for 60 Cedar Ave?", at: T9 });
  setNow(new Date(T9.getTime() + 40 * 60_000));
  for (let i = 0; i < 3; i++) await sla.sweepReplySla();
  const vicRows = await prisma.notification.findMany({ where: { kind: "reply_sla", dedupeKey: { startsWith: `sla-1-${vic.id}-` } } });
  const wenRows = await prisma.notification.findMany({ where: { kind: "reply_sla", dedupeKey: { startsWith: `sla-1-${wen.id}-` } } });
  c.ok("Kyle owns Victor's reply: ONE row, the ADMIN broadcast, naming him (Kyle is not rung twice)", vicRows.length === 1 && !vicRows[0].userKey && /Kyle Smith's to answer/.test(vicRows[0].body ?? ""), vicRows.map((r) => `${r.userKey ?? "broadcast"}: ${r.body}`).join(" | "));
  const wenPersonal = wenRows.find((r) => r.userKey === `tm:${harrison.id}`);
  const wenBroadcast = wenRows.find((r) => !r.userKey);
  c.ok("Harrison (a photographer login) owns Wendy's: the ADMIN copy at index 0 AND his own row", wenRows.length === 2 && !!wenPersonal && !!wenBroadcast && wenBroadcast.dedupeKey?.endsWith("-0") === true, wenRows.map((r) => `${r.dedupeKey?.slice(-2)} ${r.userKey ?? "broadcast"}`).join(" | "));

  // =========================================================================
  c.head("10 · Settings");
  // =========================================================================
  c.ok("an inverted pair (Jordan before Kyle) reads as the default rather than skipping Kyle", sla.normaliseEmailSla({ kyleCoveredHours: 4, ownerCoveredHours: 2 }).ownerCoveredHours === 9);
  c.ok("out-of-range numbers fall back", sla.normaliseEmailSla({ kyleCoveredHours: 0, ownerCoveredHours: 400 }).kyleCoveredHours === 4 && sla.normaliseEmailSla({ ownerCoveredHours: 400 }).ownerCoveredHours === 9);
  const T10 = et(2026, 10, 8, 11);
  setNow(T10);
  await sla.saveEmailSlaRules({ enabled: false }, "drill");
  c.ok("off clears the watermark", !(await prisma.appSetting.findUnique({ where: { key: sla.EMAIL_SLA_SINCE_KEY } })));
  await sla.saveEmailSlaRules({ enabled: true }, "drill");
  const again = await prisma.appSetting.findUnique({ where: { key: sla.EMAIL_SLA_SINCE_KEY } });
  c.ok("on again starts a NEW watermark (what waited meanwhile is listed, not rung)", !!again && Math.abs(Date.parse(JSON.parse(again.value).since) - T10.getTime()) < 10_000, again?.value);
  await prisma.appSetting.deleteMany({ where: { key: { in: [sla.EMAIL_SLA_KEY, sla.EMAIL_SLA_SINCE_KEY] } } });
  const fresh = await sla.sweepEmailSla(et(2026, 10, 8, 11, 5));
  const firstSince = await prisma.appSetting.findUnique({ where: { key: sla.EMAIL_SLA_SINCE_KEY } });
  c.ok("with nothing saved (the production state on deploy) the lane is ON and the first sweep stamps its own watermark", fresh.enabled && !!firstSince && JSON.parse(firstSince.value).since === et(2026, 10, 8, 11, 5).toISOString(), firstSince?.value);

  c.ok("nothing left this process", fence.blocked.every((u) => /slack\.com/.test(u)), fence.blocked.filter((u) => !/slack\.com/.test(u)).join(" ") || `${fence.blocked.length} Slack attempts refused (ops-channel lines of the TEXT pager)`);
  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
