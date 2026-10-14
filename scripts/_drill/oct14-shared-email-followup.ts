// ---------------------------------------------------------------------------
// DRILL: "BOTH KYLE AND I GET EMAILED" (Jordan, Oct 14 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct14-shared-email-followup.ts
//
// Jordan: "Sometimes both Kyle and I get emailed. If Kyle responds on his end,
// close it out on my end. If he forgets to follow up, remind him."
//
// Isolated PGlite; fetch and raw sockets fenced; the clock is pinned to a real
// week (Mon Oct 19 → Sat Oct 24 2026, EDT; coverage Mon–Fri 9–6). Jordan is
// info@ (OWNER), Kyle is hello@ (ADMIN) — the production roster's shape, so the
// "whose inbox" rule is read off the roster exactly as it will be live.
//
//   1. Kyle's reply leaves Jordan's card. A client emails info@ AND hello@;
//      Jordan's Home files it under "Kyle has it" (not "waiting"), Kyle's Home
//      lists it. Kyle answers from hello@ WITHOUT copying info@ — the Sent
//      folder reader turns that into our outbound row (attributed to Kyle) and
//      the thread leaves Jordan's card, Kyle's card and the email board. Same
//      for a thread that only reached info@ (different Gmail thread ids, same
//      subject + client). Negative cases: a cold email, a note to a vendor.
//   2. The fast-reply ordering and the Handled tick (a message is judged by
//      when it reached the hub, an answer by when it was sent).
//   3. Unanswered past 4 business hours → exactly ONE follow-up task for Kyle
//      and ONE bell, however many sweeps; Jordan's 9-hour bell does NOT ring
//      for Kyle's thread (it still does for his own info@-only thread); one
//      Slack DM to Kyle at 13 covered hours, never twice.
//   4. A reply closes the task (and a new email later reopens the same row).
//   5. Nothing client-facing is sent: no Gmail / OpenPhone call, no outbound
//      row we did not write ourselves, no text queued for anyone but Kyle.
//   6. Saturday: Kyle's reminder and DM go on a Saturday; Jordan gets nothing
//      — his own thread's bell waits for cover, and his Saturday hold (until
//      7:30 PM) is what any DM to him would meet.
//   7. The switch: off → no task, no bell, and Jordan's card shows the row as
//      waiting again; tasks already open still close themselves on a reply.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5797);

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
let offset = et(2026, 10, 19, 8).getTime() - RealDate.now();
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

const MON = (h: number, mi = 0) => et(2026, 10, 19, h, mi);
const TUE = (h: number, mi = 0) => et(2026, 10, 20, h, mi);
const WED = (h: number, mi = 0) => et(2026, 10, 21, h, mi);
const THU = (h: number, mi = 0) => et(2026, 10, 22, h, mi);
const SAT = (h: number, mi = 0) => et(2026, 10, 24, h, mi);

// ---- a fake Google for section 8 (the real syncGmail) ------------------------
type FakeMsg = { id: string; thread: string; from: string; to: string; subject: string; body: string; at: Date; inReplyTo?: string };
const fakeGoogle = {
  on: false,
  inbox: { info: [] as FakeMsg[], hello: [] as FakeMsg[] },
  sent: { info: [] as FakeMsg[], hello: [] as FakeMsg[] },
  fetched: new Map<string, number>(),
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const asGmail = (m: FakeMsg) => ({
  id: m.id, threadId: m.thread, snippet: m.body, internalDate: String(m.at.getTime()),
  payload: {
    mimeType: "text/plain",
    headers: [
      { name: "From", value: m.from }, { name: "To", value: m.to }, { name: "Subject", value: m.subject },
      ...(m.inReplyTo ? [{ name: "In-Reply-To", value: m.inReplyTo }] : []),
    ],
    body: { data: b64(m.body) },
  },
});
const fence = fenceFetch((url, init) => {
  if (!fakeGoogle.on) return null;
  if (url === "https://oauth2.googleapis.com/token") {
    const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
    return rt === "rt-info-drill" ? json(200, { access_token: "tok-info", expires_in: 3600 }) : rt === "rt-hello-drill" ? json(200, { access_token: "tok-hello", expires_in: 3600 }) : json(400, { error: "invalid_grant" });
  }
  const m = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me(\/[^?]*)(\?.*)?$/.exec(url);
  if (!m) return null;
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
  const box = auth.endsWith("tok-info") ? "info" : auth.endsWith("tok-hello") ? "hello" : null;
  if (!box) return json(401, {});
  const all = [...fakeGoogle.inbox[box], ...fakeGoogle.sent[box]];
  if (m[1] === "/messages") {
    const q = new URLSearchParams(m[2] ?? "").get("q") ?? "";
    const list = /in:sent/.test(q) ? fakeGoogle.sent[box] : /in:inbox/.test(q) ? fakeGoogle.inbox[box] : [];
    return json(200, { messages: list.map((x) => ({ id: x.id, threadId: x.thread })) });
  }
  const one = /^\/messages\/([^/]+)$/.exec(m[1]);
  if (one) {
    const x = all.find((y) => y.id === one[1]);
    fakeGoogle.fetched.set(`${box}:${one[1]}`, (fakeGoogle.fetched.get(`${box}:${one[1]}`) ?? 0) + 1);
    return x ? json(200, asGmail(x)) : json(404, {});
  }
  const th = /^\/threads\/([^/]+)$/.exec(m[1]);
  if (th) return json(200, { messages: all.filter((y) => y.thread === th[1]).sort((a, b) => a.at.getTime() - b.at.getTime()).map(asGmail) });
  return json(404, {});
});
installNextStubs();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { GOOGLE_CLIENT_ID: "drill-client", GOOGLE_CLIENT_SECRET: "drill-client-secret" } });
  const quiet = quietPrismaErrors();
  const { prisma } = await import("@/lib/prisma");
  const sla = await import("@/lib/commsSla");
  const fu = await import("@/lib/emailFollowUp");
  const rq = await import("@/lib/replyQueue");
  const { unansweredCommsBoard } = await import("@/lib/commsBoard");
  const { staffAddressBook, staffReplyRow } = await import("@/lib/staffEmail");
  const { logComm } = await import("@/lib/commLog");
  const { buildOpsDay, ownerUnansweredView } = await import("@/lib/opsDay");
  const { scheduleOf, quietEnd } = await import("@/lib/notifySchedule");
  const c = makeChecker();

  // ---- the cast: the production roster's shape -------------------------------
  type Role = Parameters<typeof prisma.teamMember.create>[0]["data"]["role"];
  const mkMember = (name: string, email: string, role: Role) =>
    prisma.teamMember.create({ data: { name, email, role, active: true }, select: { id: true, name: true } });
  const jordan = await mkMember("Jordan Spackman", "info@realtourpilot.com", "PHOTOGRAPHER");
  const kyle = await mkMember("Kyle Smith", "hello@realtourpilot.com", "MANAGER");
  await prisma.teamMember.update({ where: { id: kyle.id }, data: { slackId: "UKYLEDRILL" } }); // he has Slack, as live
  await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE", teamMemberId: jordan.id } });
  await prisma.appUser.create({ data: { email: "hello@realtourpilot.com", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE", teamMemberId: kyle.id } });

  const mkClient = (name: string, email: string) => prisma.client.create({ data: { name, email }, select: { id: true, name: true } });
  let ext = 0;
  /** One client email as the Gmail sync logs it: one row per inbox it landed in. */
  const emailIn = async (o: { client: { id: string; name: string }; subject: string; body: string; at: Date; inboxes: string[]; loggedAt?: Date }) => {
    const n = ++ext;
    for (const mb of o.inboxes) {
      await prisma.commLog.create({
        data: {
          channel: "email", direction: "in", clientId: o.client.id, clientName: o.client.name, contactName: o.client.name,
          subject: o.subject, body: o.body, occurredAt: o.at, source: "gmail",
          externalId: `gmail-${mb}:m${n}-${mb.slice(0, 4)}`,
          ...(o.loggedAt ? { createdAt: o.loggedAt } : {}),
        },
      });
    }
  };
  const book = await staffAddressBook();
  const clientByAddress = new Map<string, { clientId: string; clientName: string | null }>();
  /** A message from one of our mailboxes, run through the SAME reader the sync
   *  uses (staffReplyRow) and logged the way the sync logs it. */
  const gmailSent = async (o: { mailbox: string; from: string; to: string; cc?: string; subject: string; body: string; at: Date; reply?: boolean; id?: string }) => {
    const row = staffReplyRow(
      {
        mailbox: o.mailbox, messageId: o.id ?? `s${++ext}`, threadId: `t-${o.mailbox.slice(0, 4)}-${ext}`,
        from: o.from, to: o.to, cc: o.cc ?? "", subject: o.subject,
        inReplyTo: o.reply === false ? "" : "<client-msg@mail.invalid>", references: "",
        at: o.at, body: o.body, fromSentFolder: true,
      },
      book,
      (a) => clientByAddress.get(a) ?? null,
      rq.GMAIL_SENT_SOURCE,
    );
    if (!row) return null;
    const { to: _to, ...data } = row;
    void _to;
    await logComm(data);
    return row;
  };
  const waiting = async () => sla.findUnansweredInbound(new Date(), { families: ["email"] });
  const waitingFor = async (clientId: string) => (await waiting()).find((w) => w.clientId === clientId) ?? null;
  const homeFor = async (owner: boolean) => {
    const d = await buildOpsDay();
    return owner ? ownerUnansweredView(d) : d;
  };
  const tasksFor = (clientId: string) => prisma.smartTask.findMany({ where: { source: fu.EMAIL_FOLLOWUP_SOURCE, clientId } });
  const bellsFor = (clientId: string, tier: "e1" | "e2") => prisma.notification.findMany({ where: { kind: "reply_sla_email", dedupeKey: { startsWith: `sla-${tier}-${clientId}-` } } });
  const sweep = async (at: Date) => { setNow(at); return sla.sweepReplySla(); };

  // The lane switches itself on the way it will in production (nothing saved →
  // the defaults; the first sweep stamps the backlog watermark).
  setNow(MON(8));
  await sla.sweepReplySla();
  const rules = await sla.emailSlaRules();
  c.head("0 · Defaults");
  c.ok("nothing saved → the email alerts are on, and so is Kyle's follow-up (4h reminder, 13h Slack)", rules.enabled && rules.kyleFollowUp && rules.kyleCoveredHours === 4 && rules.kyleEscalateCoveredHours === 13, JSON.stringify(rules));
  c.ok("follow-up defaults to the lane's own switch when never saved", sla.normaliseEmailSla({ enabled: false }).kyleFollowUp === false && sla.normaliseEmailSla({ enabled: true }).kyleFollowUp === true);
  c.ok("the Slack line can never come before the reminder", sla.normaliseEmailSla({ kyleCoveredHours: 6, kyleEscalateCoveredHours: 3 }).kyleEscalateCoveredHours > 6);
  const holders = await fu.inboxHolders(["info@realtourpilot.com", "hello@realtourpilot.com"]);
  c.ok("hello@ is held by Kyle (not the owner); info@ by Jordan (the owner) — read off the roster", holders.get("hello@realtourpilot.com")?.teamMemberId === kyle.id && holders.get("hello@realtourpilot.com")?.isOwner === false && holders.get("info@realtourpilot.com")?.isOwner === true);

  // =========================================================================
  c.head("1 · Kyle answers from hello@ — the thread leaves Jordan's card");
  // =========================================================================
  const brandon = await mkClient("Brandon Dunbar", "bdunbar@clients.invalid");
  clientByAddress.set("bdunbar@clients.invalid", { clientId: brandon.id, clientName: brandon.name });
  setNow(MON(10, 5));
  await emailIn({ client: brandon, subject: "22 White Birch", body: "Can we push the 22 White Birch shoot to Thursday morning?", at: MON(10), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  setNow(MON(10, 30));
  const w1 = await waitingFor(brandon.id);
  c.ok("one email in both inboxes is ONE waiting thread that knows both inboxes", !!w1 && w1.inboxes.length === 2, JSON.stringify(w1?.inboxes));
  const jHome = await homeFor(true);
  const kHome = await homeFor(false);
  c.ok("Jordan's Home: not in his waiting count…", jHome.unanswered.count === 0 && !jHome.unanswered.preview.some((p) => p.clientId === brandon.id), `count=${jHome.unanswered.count}`);
  c.ok("…but labelled under \"Kyle has it\"", jHome.unanswered.withTeammate?.length === 1 && jHome.unanswered.withTeammate[0].heldBy === "Kyle Smith" && jHome.unanswered.withTeammate[0].name === "Brandon Dunbar", JSON.stringify(jHome.unanswered.withTeammate));
  c.ok("…and his closeout tick does not count it against him", jHome.closeout.unanswered === 0);
  c.ok("Kyle's Home still lists it as waiting (it is his work)", kHome.unanswered.count === 1 && kHome.unanswered.preview[0]?.clientId === brandon.id);

  // Kyle replies from hello@ to Brandon only — info@ is NOT copied.
  const r1 = await gmailSent({ mailbox: "hello@realtourpilot.com", from: "\"Realtour Pilot, LLC\" <hello@realtourpilot.com>", to: "Brandon Dunbar <bdunbar@clients.invalid>", subject: "Re: 22 White Birch", body: "Thursday 9am works, see you then.", at: MON(10, 40) });
  c.ok("the Sent-folder reader logs Kyle's reply as our outbound, attributed to Kyle", !!r1 && r1.clientId === brandon.id && r1.senderTeamMemberId === kyle.id && r1.source === rq.GMAIL_SENT_SOURCE && r1.externalId.startsWith("gmail-sent-"), JSON.stringify(r1 && { to: r1.to, by: r1.senderTeamMemberId, ext: r1.externalId }));
  setNow(MON(10, 45));
  c.ok("Brandon has left the waiting list", !(await waitingFor(brandon.id)));
  c.ok("…Jordan's card (no row, no \"Kyle has it\" line)", !(await homeFor(true)).unanswered.withTeammate?.length && (await homeFor(true)).unanswered.count === 0);
  c.ok("…and the email board", (await unansweredCommsBoard("email", new Date())).length === 0);

  // Different Gmail threads: Rick wrote to info@ only; Kyle answers him from hello@.
  const rick = await mkClient("Rick Schultz", "rick@clients.invalid");
  clientByAddress.set("rick@clients.invalid", { clientId: rick.id, clientName: rick.name });
  await emailIn({ client: rick, subject: "Fall content plan", body: "Can we add a market update video to the fall plan?", at: MON(11), inboxes: ["info@realtourpilot.com"] });
  setNow(MON(11, 10));
  const wr = await waitingFor(rick.id);
  c.ok("an info@-only email stays on Jordan's card as waiting (it is his)", !!wr && (await homeFor(true)).unanswered.preview.some((p) => p.clientId === rick.id));
  await gmailSent({ mailbox: "hello@realtourpilot.com", from: "hello@realtourpilot.com", to: "rick@clients.invalid", subject: "RE: Fall content plan", body: "Yes, added it.", at: MON(11, 30) });
  setNow(MON(11, 35));
  c.ok("Kyle's reply from the OTHER inbox (another Gmail thread id, same subject + client) clears it too", !(await waitingFor(rick.id)));

  // Negative cases: a cold email and a note to someone who is not a client.
  const sara = await mkClient("Sara Lin", "sara@clients.invalid");
  clientByAddress.set("sara@clients.invalid", { clientId: sara.id, clientName: sara.name });
  await emailIn({ client: sara, subject: "Twilight photos for 9 Elm", body: "Do you do twilight photos for 9 Elm?", at: MON(12), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  const cold = await gmailSent({ mailbox: "hello@realtourpilot.com", from: "hello@realtourpilot.com", to: "sara@clients.invalid", subject: "Your October content calendar", body: "Here is October.", at: MON(12, 30), reply: false });
  const vendor = await gmailSent({ mailbox: "hello@realtourpilot.com", from: "hello@realtourpilot.com", to: "orders@vendor.invalid", subject: "Re: Twilight photos for 9 Elm", body: "Order placed.", at: MON(12, 31) });
  setNow(MON(12, 35));
  c.ok("a COLD email from us (no In-Reply-To, no Re:) is not logged as an answer", cold === null);
  c.ok("a reply to an address that is not a client is not logged", vendor === null);
  c.ok("…so Sara is still waiting", !!(await waitingFor(sara.id)));
  const jamesMail = staffReplyRow(
    { mailbox: "info@realtourpilot.com", messageId: "x1", threadId: "tx1", from: "James <james@realtourpilot.com>", to: "sara@clients.invalid", cc: "info@realtourpilot.com", subject: "Re: Twilight photos for 9 Elm", inReplyTo: "<a@b>", references: "", at: MON(12, 40), body: "Yes we do, $X.", fromSentFolder: false },
    book, (a) => clientByAddress.get(a) ?? null, rq.GMAIL_SENT_SOURCE,
  );
  c.ok("another staff address (james@, mailbox not connected) seen in info@ on cc counts as OUR reply", !!jamesMail && jamesMail.clientId === sara.id && jamesMail.externalId === "gmail-staff-info@realtourpilot.com:x1");
  if (jamesMail) { const { to: _t, ...d } = jamesMail; void _t; await logComm(d); }
  setNow(MON(12, 45));
  c.ok("…and clears Sara", !(await waitingFor(sara.id)));

  // =========================================================================
  c.head("2 · A fast answer, and the Handled tick");
  // =========================================================================
  const nina = await mkClient("Nina Park", "nina@clients.invalid");
  clientByAddress.set("nina@clients.invalid", { clientId: nina.id, clientName: nina.name });
  // Sent 1:00, the 5-minute scan logged it at 1:04; Kyle answered at 1:02.
  await emailIn({ client: nina, subject: "Floor plan", body: "Is the floor plan included for 4 Oak?", at: MON(13), loggedAt: MON(13, 4), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  await gmailSent({ mailbox: "hello@realtourpilot.com", from: "hello@realtourpilot.com", to: "nina@clients.invalid", subject: "Re: Floor plan", body: "Yes, it is.", at: MON(13, 2) });
  setNow(MON(13, 10));
  c.ok("a reply sent BEFORE the scan logged the email still answers it (sorted by send time)", !(await waitingFor(nina.id)));
  // A tick at 1:20 must not hide a message sent 1:19 that only reached the hub at 1:23.
  const omar = await mkClient("Omar Diaz", "omar@clients.invalid");
  await emailIn({ client: omar, subject: "Deposit question", body: "Which card did the deposit go on?", at: MON(13, 19), loggedAt: MON(13, 23), inboxes: ["info@realtourpilot.com"] });
  setNow(MON(13, 25));
  const wo = await waitingFor(omar.id);
  await prisma.appSetting.create({ data: { key: rq.threadAckKey("email", wo!.threadKey), value: rq.ackValue(MON(13, 20), "answered elsewhere") } });
  c.ok("a Handled tick does not hide a message that reached the hub after the tick", !!(await waitingFor(omar.id)));
  await prisma.appSetting.update({ where: { key: rq.threadAckKey("email", wo!.threadKey) }, data: { value: rq.ackValue(MON(13, 24), "answered elsewhere") } });
  c.ok("a tick after it reached the hub does", !(await waitingFor(omar.id)));

  // =========================================================================
  c.head("3 · Unanswered past 4 business hours → ONE task + ONE bell for Kyle");
  // =========================================================================
  const olivia = await mkClient("Olivia Vecere", "olivia@clients.invalid");
  clientByAddress.set("olivia@clients.invalid", { clientId: olivia.id, clientName: olivia.name });
  await emailIn({ client: olivia, subject: "34 Oakland Rd", body: "When will the 34 Oakland Rd photos be ready?", at: TUE(10), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  // Jordan's own info@-only thread at the same moment — the control for his lane.
  const mark = await mkClient("Mark Reyes", "mark@clients.invalid");
  await emailIn({ client: mark, subject: "Referral", body: "Can I send you a referral for next week?", at: TUE(10), inboxes: ["info@realtourpilot.com"] });
  await sweep(TUE(13, 59));
  c.ok("3h 59m: no task, no bell", (await tasksFor(olivia.id)).length === 0 && (await bellsFor(olivia.id, "e1")).length === 0);
  const run = await sweep(TUE(14));
  let t = await tasksFor(olivia.id);
  c.ok("4 business hours: ONE follow-up task", t.length === 1, JSON.stringify(run.followUp));
  c.ok("…on Kyle's list (owner + assignee), open, HIGH, an internal to-do", t[0]?.ownerId === kyle.id && t[0]?.assignedKey === "kyle" && t[0]?.status === "OPEN" && t[0]?.priority === "HIGH" && t[0]?.taskType === "todo", JSON.stringify(t[0] && { o: t[0].ownerId, a: t[0].assignedKey, s: t[0].status, p: t[0].priority, ty: t[0].taskType }));
  c.ok("…titled for the client and the subject", /Olivia Vecere/.test(t[0]?.title ?? "") && /34 Oakland Rd/.test(t[0]?.title ?? ""), t[0]?.title);
  let b1 = await bellsFor(olivia.id, "e1");
  c.ok("ONE bell, Kyle's own (tm:), pointing at the task", b1.length === 1 && b1[0].userKey === `tm:${kyle.id}` && b1[0].href === `/tasks?tab=other&task=${t[0]?.id}`, b1.map((b) => `${b.userKey} ${b.href}`).join(" | "));
  for (const m of [5, 10, 15]) await sweep(TUE(14, m));
  t = await tasksFor(olivia.id);
  b1 = await bellsFor(olivia.id, "e1");
  c.ok("three more sweeps: still one task, still one bell", t.length === 1 && b1.length === 1);
  c.ok("Jordan's own info@ thread rang KYLE's lane bell as before (no follow-up task — not Kyle's inbox)", (await tasksFor(mark.id)).length === 0 && (await bellsFor(mark.id, "e1")).length === 1);
  await sweep(WED(10, 30)); // 9.5 covered hours
  c.ok("9 covered hours: Jordan's bell rings for HIS thread…", (await bellsFor(mark.id, "e2")).length === 1);
  c.ok("…but NOT for Kyle's (Jordan is not reminded about Kyle's emails)", (await bellsFor(olivia.id, "e2")).length === 0);
  const dmKey = `email-followup-dm:${fu.followUpKey(olivia.id, (await waitingFor(olivia.id))!.groupKey)}@${TUE(10).toISOString()}`;
  await sweep(WED(13, 59));
  c.ok("12h 59m: no Slack message yet", !(await prisma.appSetting.findUnique({ where: { key: dmKey } })));
  const esc = await sweep(WED(14));
  c.ok("13 covered hours: ONE Slack message to Kyle", esc.followUp?.escalated === 1 && !!(await prisma.appSetting.findUnique({ where: { key: dmKey } })), JSON.stringify(esc.followUp));
  const dmRows = await prisma.notificationDelivery.findMany({ where: { kind: "email_followup" } });
  c.ok("…addressed to Kyle and nobody else", dmRows.length > 0 && dmRows.every((r) => r.teamMemberId === kyle.id), dmRows.map((r) => `${r.channel}/${r.status}`).join(" "));
  let again = 0;
  for (const m of [5, 10, 15]) again += (await sweep(WED(14, m))).followUp?.escalated ?? 0;
  c.ok("…never twice", again === 0 && (await prisma.notificationDelivery.count({ where: { kind: "email_followup" } })) === dmRows.length);

  // =========================================================================
  c.head("4 · A reply closes the task");
  // =========================================================================
  await gmailSent({ mailbox: "hello@realtourpilot.com", from: "hello@realtourpilot.com", to: "olivia@clients.invalid", subject: "Re: 34 Oakland Rd", body: "Tomorrow by noon.", at: WED(15) });
  const closeRun = await sweep(WED(15, 5));
  t = await tasksFor(olivia.id);
  c.ok("the next sweep closes Kyle's task by itself", t.length === 1 && t[0].status === "COMPLETED" && closeRun.followUp?.closed === 1, `${t[0]?.status} ${JSON.stringify(closeRun.followUp)}`);
  c.ok("…and Olivia is off every card", !(await waitingFor(olivia.id)));
  await emailIn({ client: olivia, subject: "Re: 34 Oakland Rd", body: "Also, can we get a vertical cut for 34 Oakland Rd?", at: THU(9, 30), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  await sweep(THU(13, 31));
  t = await tasksFor(olivia.id);
  c.ok("a NEW email past 4 business hours reopens the SAME task row (one per thread)", t.length === 1 && t[0].status === "OPEN");
  c.ok("…with its own new bell (a new waiting episode)", (await bellsFor(olivia.id, "e1")).length === 2);
  // A Handled tick (answered by phone) closes it too.
  const wo2 = await waitingFor(olivia.id);
  await prisma.appSetting.create({ data: { key: rq.threadAckKey("email", wo2!.threadKey), value: rq.ackValue(THU(13, 40), "answered elsewhere") } });
  await sweep(THU(13, 45));
  c.ok("a Handled tick (answered elsewhere) closes it as well", (await tasksFor(olivia.id))[0].status === "COMPLETED");

  // =========================================================================
  c.head("5 · Nothing client-facing");
  // =========================================================================
  const outbound = await prisma.commLog.findMany({ where: { direction: "out" } });
  c.ok("every outbound row is a reply the drill itself fed in (the hub wrote none)", outbound.every((r) => r.source === rq.GMAIL_SENT_SOURCE), outbound.map((r) => r.source).join(","));
  // The only provider calls tried are Slack (Kyle's DM) and, for the staff-text
  // fallback, OpenPhone's own number lookup — never Gmail, never a message send.
  c.ok("no Gmail call and no text/message send was attempted", !fence.blocked.some((u) => /gmail|googleapis|\/messages/i.test(u)), fence.blocked.join(" "));
  c.ok("no text queued for anyone but Kyle", (await prisma.pendingSms.findMany()).every((p) => p.teamMemberId === kyle.id));
  c.ok("no client outbox row", (await prisma.outboxMessage.count()) === 0);

  // =========================================================================
  c.head("6 · Saturday: Kyle may be pinged, Jordan is not");
  // =========================================================================
  const tess = await mkClient("Tess Ward", "tess@clients.invalid");
  await emailIn({ client: tess, subject: "Drone for 5 Hill Rd", body: "Is drone included for 5 Hill Rd?", at: THU(10), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  const ian = await mkClient("Ian Fox", "ian@clients.invalid");
  await emailIn({ client: ian, subject: "Price for 2 Bay", body: "What would 2 Bay cost?", at: THU(10), inboxes: ["info@realtourpilot.com"] });
  // The cron missed the weekdays for these two (they are only swept on Saturday).
  const notesBefore = await prisma.notification.count({ where: { audience: "OWNER" } }).catch(() => -1);
  const satRun = await sweep(SAT(11));
  const tt = await tasksFor(tess.id);
  c.ok("Saturday 11 AM: Kyle's follow-up task opens", tt.length === 1 && tt[0].status === "OPEN", JSON.stringify(satRun.followUp));
  c.ok("…with his bell and his one Slack message (anyone may be pinged any hour)", (await bellsFor(tess.id, "e1")).length === 1 && (satRun.followUp?.escalated ?? 0) === 1);
  c.ok("Jordan gets nothing for Kyle's thread", (await bellsFor(tess.id, "e2")).length === 0);
  c.ok("…nor for his OWN thread on a Saturday (his email bell waits for cover)", (await bellsFor(ian.id, "e2")).length === 0 && (await bellsFor(ian.id, "e1")).length === 0);
  c.ok("no OWNER bell of any kind was written on Saturday", (await prisma.notification.count({ where: { audience: "OWNER" } }).catch(() => -2)) === notesBefore);
  const jordanSched = await scheduleOf(jordan.id);
  const kyleSched = await scheduleOf(kyle.id);
  const jEnd = quietEnd(jordanSched.windows, SAT(11));
  c.ok("Jordan's Saturday hold runs to 7:30 PM ET (any DM to him would wait)", !!jEnd && jEnd.getTime() === SAT(19, 30).getTime(), jEnd?.toISOString());
  c.ok("Kyle has no hold — his Saturday reminder goes now", quietEnd(kyleSched.windows, SAT(11)) === null);
  c.ok("every follow-up delivery ever made went to Kyle", (await prisma.notificationDelivery.findMany({ where: { kind: "email_followup" } })).every((r) => r.teamMemberId === kyle.id));

  // =========================================================================
  c.head("7 · Switched off");
  // =========================================================================
  await sla.saveEmailSlaRules({ kyleFollowUp: false }, "drill");
  const zoe = await mkClient("Zoe Hart", "zoe@clients.invalid");
  clientByAddress.set("zoe@clients.invalid", { clientId: zoe.id, clientName: zoe.name });
  await emailIn({ client: zoe, subject: "Reels", body: "Can we get two reels this month?", at: et(2026, 10, 26, 9), inboxes: ["info@realtourpilot.com", "hello@realtourpilot.com"] });
  await sweep(et(2026, 10, 26, 14));
  c.ok("off: no follow-up task", (await tasksFor(zoe.id)).length === 0);
  c.ok("off: Kyle's ordinary 4-hour bell is back for his thread (the lane as it was)", (await bellsFor(zoe.id, "e1")).length === 1);
  const offHome = await homeFor(true);
  c.ok("off: Jordan's card shows the row as waiting again (nobody is reminding Kyle)", offHome.unanswered.preview.some((p) => p.clientId === zoe.id) && !offHome.unanswered.withTeammate?.length);
  clientByAddress.set("tess@clients.invalid", { clientId: tess.id, clientName: tess.name });
  await gmailSent({ mailbox: "hello@realtourpilot.com", from: "hello@realtourpilot.com", to: "tess@clients.invalid", subject: "Re: Drone for 5 Hill Rd", body: "Yes, drone is included.", at: et(2026, 10, 26, 14, 11) });
  await sweep(et(2026, 10, 26, 14, 15));
  c.ok("off: a task already open still closes itself on a reply (desk truth)", (await tasksFor(tess.id))[0].status === "COMPLETED");

  // =========================================================================
  c.head("8 · The real Gmail sync (a fake Google): Kyle's Sent folder closes info@'s task");
  // =========================================================================
  await sla.saveEmailSlaRules({ kyleFollowUp: true }, "drill");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const google = await import("@/lib/integrations/google");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "rt-info-drill", "hello@realtourpilot.com": "rt-hello-drill" }));
  fakeGoogle.on = true;
  const gina = await mkClient("Gina Lowe", "gina@clients.invalid");
  const G_AT = et(2026, 10, 27, 10);
  const ginaMail = { from: "Gina Lowe <gina@clients.invalid>", to: "info@realtourpilot.com, hello@realtourpilot.com", subject: "Kitchen photos", body: "Can you brighten the kitchen photos for 7 Pine Ln? Thank you!", at: G_AT };
  fakeGoogle.inbox.info.push({ id: "gi1", thread: "ti-g", ...ginaMail });
  fakeGoogle.inbox.hello.push({ id: "gh1", thread: "th-g", ...ginaMail });
  setNow(et(2026, 10, 27, 10, 4));
  const s1 = await google.syncGmail();
  const ginaTasks = () => prisma.smartTask.findMany({ where: { clientId: gina.id, taskType: "client_reply" } });
  const before = await ginaTasks();
  c.ok("the sync read both inboxes and logged Gina's email from each", s1.mailboxes.every((mb) => mb.ok) && (await prisma.commLog.count({ where: { clientId: gina.id, direction: "in" } })) === 2, JSON.stringify(s1.mailboxes));
  c.ok("…stamped with when she SENT it, not when the scan ran", (await prisma.commLog.findFirst({ where: { clientId: gina.id, direction: "in" } }))?.occurredAt.getTime() === G_AT.getTime());
  c.ok("…and filed a reply task on ONE inbox's copy of the thread", before.length === 1 && before[0].status !== "COMPLETED", before.map((t) => t.sourceDetail).join(" | "));
  // Kyle answers from hello@ only. info@'s copy of the thread never hears of it.
  const kyleReply: FakeMsg = { id: "gs1", thread: "th-g", from: "\"Realtour Pilot, LLC\" <hello@realtourpilot.com>", to: "Gina Lowe <gina@clients.invalid>", subject: "Re: Kitchen photos", body: "On it, new versions this afternoon.", at: et(2026, 10, 27, 10, 20), inReplyTo: "<gina-1@mail.invalid>" };
  fakeGoogle.sent.hello.push(kyleReply);
  setNow(et(2026, 10, 27, 10, 24));
  await google.syncGmail();
  const out = await prisma.commLog.findFirst({ where: { clientId: gina.id, direction: "out" } });
  c.ok("the Sent-folder read logged Kyle's reply (same key the old thread check uses), attributed to Kyle", out?.externalId === "gmail-sent-th-g-gs1" && out.senderTeamMemberId === kyle.id && out.source === rq.GMAIL_SENT_SOURCE, JSON.stringify(out && { e: out.externalId, by: out.senderTeamMemberId }));
  const after = await ginaTasks();
  c.ok("the reply task closed — whichever inbox's thread it was filed on", after.length === 1 && after[0].status === "COMPLETED", `${after[0]?.sourceDetail} → ${after[0]?.status}`);
  c.ok("…dated to Kyle's reply, not to the scan (a later email from Gina stays waiting)", after[0]?.sourceDetail?.includes("info@") ? after[0]?.completedAt?.getTime() === kyleReply.at.getTime() : after[0]?.status === "COMPLETED", after[0]?.completedAt?.toISOString());
  c.ok("Gina is off Jordan's card and the email board", !(await waitingFor(gina.id)) && !(await unansweredCommsBoard("email", new Date())).some((g) => g.clientId === gina.id));
  await google.syncGmail();
  c.ok("the next sync does not read Kyle's sent message again (the ledger remembers it)", fakeGoogle.fetched.get("hello:gs1") === 1, String(fakeGoogle.fetched.get("hello:gs1")));
  c.ok("…and nothing was sent anywhere: no Gmail send endpoint was called", ![...fakeGoogle.fetched.keys()].some((k) => /send/.test(k)) && !fence.blocked.some((u) => /gmail/.test(u)));
  fakeGoogle.on = false;

  c.summary();
  quiet.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
