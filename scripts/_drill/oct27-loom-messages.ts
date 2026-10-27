// ---------------------------------------------------------------------------
// DRILL: MESSAGES, FROM JORDAN'S OCT 27 2026 LOOM (26:50-27:09, 36:30-41:04).
//
//   DRILL_PORT=5627 node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-messages.ts
//
//   1. A booking answers a booking question: Mike Ciunci's "Can we schedule
//      ahead of time for November?" leaves Waiting on us once a booking for
//      him exists, made after it; a booking made before it, a reschedule, or
//      a second question about the work stays for a person. His open
//      scheduling ask closes too, with what was booked.
//   2. A thank-you is a thank-you under a signature: "Thanks so much Jordan!"
//      over a name, a cell number and a wire-fraud notice is not owed; a bare
//      phone number is still information.
//   3. Client communications only: a calendar accept, a scheduler's
//      confirmation, a shipping notice, a "top tier capital program" pitch and
//      mail from an unsaved sender are folded off Email (with the reason) and
//      off Waiting on us; a client's own "Re:" stays. The AI check (stubbed,
//      never a real model) hides only what it is sure of; down, it changes
//      nothing; "show it" undoes it.
//   4. Unread: a read mark per person per conversation, forward only.
//   5. Unsaved numbers: "Not a client" mutes and cuts the number.
//   6. The reply backlog: behind = more than 8 waiting or one over 24h; Kyle
//      is told once a day from 9 AM ET, in Jordan's words.
//   7. The Outbox follows the live shoot: a postponed shoot holds its
//      confirmation (no date, off the Outbox), a new date brings it back the
//      day before; the warning is only for a shoot that moved or passed.
//   8. Late promises: only past the promise (William Hannum's photos, due
//      tomorrow, are not listed and get no draft).
//   9. Team chat is off the Messages tab bar.
//
// ISOLATION: PGlite via the shared harness; the clock is pinned (Tue Oct 27
// 2026, 10:00 AM EDT); no request leaves; nothing is sent to anyone.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5627);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RealDate = Date;
const NOW = RealDate.UTC(2026, 9, 27, 14, 0); // Tue Oct 27 2026, 10:00 AM EDT
let offset = NOW - RealDate.now();
const setNow = (ms: number) => { offset = ms - RealDate.now(); return new RealDate(ms); };
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

installNextStubs();
const fence = fenceFetch(async () => null);

const MIKE_THANKS = [
  "Thanks so much Jordan!",
  "",
  "Mike Ciunci",
  "REALTOR®",
  "Keller Williams Main Line",
  "Cell: 610-555-0142",
  "mike.ciunci@drill.invalid",
  "",
  "WIRE FRAUD NOTICE: Never wire money based on instructions received by email. Always call our office at a number you know to verify wiring instructions before sending any funds.",
].join("\n");

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const rq = await import("@/lib/replyQueue");
  const bq = await import("@/lib/bookingQuestion");
  const { unansweredCommsBoards } = await import("@/lib/commsBoard");
  const { getEmailThreads } = await import("@/components/comms/emailThreads");
  const nc = await import("@/lib/commsNotClient");
  const reads = await import("@/lib/messageReads");
  const { closeBookedSchedulingAsks } = await import("@/lib/clientAsks");
  const ct = await import("@/lib/clientTexts");
  const tasks = await import("@/lib/tasks");
  const at = await import("@/lib/atRiskUpdates");
  const nav = await import("@/components/comms/messagesNav");

  const now = new Date();
  const ago = (ms: number) => new RealDate(NOW - ms);
  const ahead = (ms: number) => new RealDate(NOW + ms);
  let n = 0;
  const log = (o: { channel?: "text" | "email"; direction?: "in" | "out"; clientId?: string | null; contactName?: string | null; phone?: string | null; subject?: string | null; body: string; at: Date }) =>
    prisma.commLog.create({
      data: {
        channel: o.channel ?? "text", direction: o.direction ?? "in", clientId: o.clientId ?? null, clientName: null, contactName: o.contactName ?? null,
        fromPhone: o.phone ?? null, subject: o.subject ?? null, body: o.body, occurredAt: o.at, source: o.channel === "email" ? "gmail" : "openphone", externalId: `drill-${++n}`,
      },
      select: { id: true },
    });

  try {
    // =======================================================================
    c.head("2 · A thank-you under a signature (pure)");
    // =======================================================================
    c.ok("\"thanks so much\" is a thank-you", rq.isCourtesyMessage("thanks so much"));
    c.ok("\"Thanks so much! See you Nov 4th at 10am\" is a sign-off, the date inside it is not information", rq.isCourtesyMessage("Thanks so much! See you Nov 4th at 10am"));
    c.ok("…but \"See you Nov 4th at 10am\" alone is a plan, not a thank-you", !rq.isCourtesyMessage("See you Nov 4th at 10am"));
    c.ok("a bare phone number is NOT a thank-you", !rq.isCourtesyMessage("610-555-0142") && !rq.isCourtesyMessage("6105550142"));
    c.ok("Mike Ciunci's email: \"Thanks so much Jordan!\" over his signature and a wire-fraud notice is a thank-you", rq.isAckOnlyEmailBody(MIKE_THANKS));
    c.ok("…the old reading (the whole body as one line) is why it was missed", !rq.isCourtesyMessage(MIKE_THANKS.replace(/\s+/g, " ")));
    c.ok("a thank-you with a real ask under it is not", !rq.isAckOnlyEmailBody("Thanks so much Jordan!\nCan you also send the floor plan?\n\nMike Ciunci\nCell: 610-555-0142"));

    // =======================================================================
    c.head("1 · A booking answers a booking question (pure)");
    // =======================================================================
    const ASK = "Can we schedule ahead of time for November?";
    c.ok("Mike's question is a booking question", bq.isBookingQuestion(ASK));
    c.ok("a reschedule is not (a person moves a booking)", !bq.isBookingQuestion("Can we reschedule Thursday's shoot to Friday?"));
    c.ok("a second question about the work is not", !bq.isBookingQuestion("Can we book the November shoot? Also when will the photos be ready?"));
    const asked = ago(5 * HOUR);
    const sess = (atT: Date): import("@/lib/bookingQuestion").Booking => ({ clientId: "m", at: atT, kind: "session", words: "content session Nov 12" });
    const noKey = () => null;
    c.ok("a session booked after the question answers it", bq.bookingAnswering({ text: ASK, at: asked }, [sess(ago(2 * HOUR))], noKey)?.words === "content session Nov 12");
    c.ok("…a booking made two days before it does not", bq.bookingAnswering({ text: ASK, at: asked }, [sess(ago(2 * DAY))], noKey) === null);

    // ---- the people --------------------------------------------------------------
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "kyle@drill.invalid", role: "MANAGER", active: true }, select: { id: true } });
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", teamMemberId: kyleTm.id, label: "Kyle Smith", setBy: "drill" } });
    const mike = await prisma.client.create({ data: { name: "Mike Ciunci", phone: "(610) 555-0142", email: "mike.ciunci@drill.invalid" }, select: { id: true } });
    const nadia = await prisma.client.create({ data: { name: "Nadia Osborne", phone: "(215) 555-0101", email: "nadia@drill.invalid" }, select: { id: true } });
    const omar = await prisma.client.create({ data: { name: "Omar Reyes", phone: "(215) 555-0303" }, select: { id: true } });
    const pitch = await prisma.client.create({ data: { name: "Dana Growth", email: "dana@growth.invalid" }, select: { id: true } });

    // Mike: the booking question by text, then a job booked for him after it.
    await log({ clientId: mike.id, contactName: "Mike Ciunci", phone: "6105550142", body: ASK, at: asked });
    await prisma.project.create({ data: { clientId: mike.id, title: "November content session, Mike Ciunci", status: "BOOKED", createdAt: ago(2 * HOUR) } });
    // …his thank-you email, his calendar accept.
    await log({ channel: "email", clientId: mike.id, contactName: "Mike Ciunci", subject: "Re: Your November session", body: MIKE_THANKS, at: ago(3 * HOUR) });
    await log({ channel: "email", clientId: mike.id, contactName: "Mike Ciunci", subject: "Accepted: Content planning call @ Wed Oct 28, 2026 2pm - 2:30pm (EDT)", body: "Mike Ciunci has accepted this invitation.\n\nInvitation from Google Calendar", at: ago(4 * HOUR) });
    // Omar: the same question, but his only booking was made BEFORE he asked.
    await prisma.project.create({ data: { clientId: omar.id, title: "12 Elm St, Media, PA", status: "BOOKED", createdAt: ago(3 * DAY) } });
    await log({ clientId: omar.id, contactName: "Omar Reyes", phone: "2155550303", body: "Can we book a shoot for next week?", at: ago(6 * HOUR) });
    // Nadia: a real email question.
    await log({ channel: "email", clientId: nadia.id, contactName: "Nadia Osborne", subject: "Re: Photos for 12 Oak Ln", body: "Hi, can you also send the floor plan for 12 Oak Ln?\n\nNadia", at: ago(7 * HOUR) });
    // A saved "client" whose email is a pitch the rules let through (the AI's job).
    const pitchRow = await log({ channel: "email", clientId: pitch.id, contactName: "Dana Growth", subject: "Quick question", body: "Hi Jordan, would you be open to a quick call about how we help media agencies double their bookings this quarter?", at: ago(8 * HOUR) });
    // Strangers: Core9's shipment, Laura Hayes's capital program.
    await log({ channel: "email", contactName: "Core9", subject: "Your shipment is on the way!", body: "Good news! Your package is on the way. Tracking number 1Z999.", at: ago(9 * HOUR) });
    await log({ channel: "email", contactName: "Laura Hayes", subject: "Top tier capital program", body: "Hi Jordan, you have been pre-approved for our top tier capital program: working capital up to $250,000.", at: ago(10 * HOUR) });
    // An unsaved number.
    await log({ phone: "2155550199", body: "Hi, is this the photography company?", at: ago(2 * HOUR) });

    // =======================================================================
    c.head("1 · …on Waiting on us, and the open scheduling ask");
    // =======================================================================
    const boards = await unansweredCommsBoards(now);
    const phoneNames = boards.phone.map((g) => g.clientName);
    const emailNames = boards.email.map((g) => g.clientName);
    c.ok("Mike's booking question is not waiting: his job was booked after it", !boards.phone.some((g) => g.clientId === mike.id), phoneNames.join(", "));
    c.ok("Omar's stays: his booking was made before he asked", boards.phone.some((g) => g.clientId === omar.id), phoneNames.join(", "));
    const askMike = await prisma.clientAsk.create({ data: { clientId: mike.id, kind: "SCHEDULING", text: ASK, source: "text", askedAt: asked, state: "OPEN" }, select: { id: true } });
    const askOmar = await prisma.clientAsk.create({ data: { clientId: omar.id, kind: "SCHEDULING", text: "Can we book a shoot for next week?", source: "text", askedAt: ago(6 * HOUR), state: "OPEN" }, select: { id: true } });
    const closed = await closeBookedSchedulingAsks(now);
    const aMike = await prisma.clientAsk.findUnique({ where: { id: askMike.id } });
    const aOmar = await prisma.clientAsk.findUnique({ where: { id: askOmar.id } });
    c.ok("Mike's open scheduling ask (no address in it) closes, saying what was booked", aMike?.state === "DONE" && /^booked: November content session/.test(aMike?.confirmNote ?? "") && closed.ids.includes(askMike.id), `${aMike?.state} ${aMike?.confirmNote}`);
    c.ok("…Omar's stays open", aOmar?.state === "OPEN");

    // =======================================================================
    c.head("2 · …Mike's thank-you is not owed");
    // =======================================================================
    c.ok("Mike is not on the email board (his thank-you, his calendar accept)", !boards.email.some((g) => g.clientId === mike.id), emailNames.join(", "));
    c.ok("Nadia's real question is", boards.email.some((g) => g.clientId === nadia.id), emailNames.join(", "));

    // =======================================================================
    c.head("3 · Client communications only");
    // =======================================================================
    const r = (subject: string, body: string, contactName = "Someone") => rq.notClientEmailReason({ subject, contactName, body });
    c.ok("\"Accepted: ... Google Meet\" → a calendar reply", r("Accepted: Strategy call @ Wed Oct 28 (Google Meet)", "Mike Ciunci has accepted this invitation.") === "calendar");
    c.ok("\"Invitation accepted\" in any order → a calendar reply", r("Google Meet invitation accepted", "Join with Google Meet") === "calendar");
    c.ok("a scheduler's \"Your appointment is confirmed\" → scheduling confirmation", r("Your appointment is confirmed", "See you then. Add to calendar.") === "scheduler");
    c.ok("Core9's \"Your shipment is on the way!\" → shipping", r("Your shipment is on the way!", "Your package is on the way.", "Core9") === "shipping");
    c.ok("Laura Hayes's \"Top tier capital program\" → a sales pitch", r("Top tier capital program", "Working capital up to $250,000.", "Laura Hayes") === "solicitation");
    c.ok("a client's \"Re: Your appointment is confirmed\" with a question stays a client's", r("Re: Your appointment is confirmed", "Can we push it to 11?") === null);
    c.ok("a client's own question stays a client's", r("Photos for 12 Oak Ln", "Can you send the floor plan?") === null);

    const t1 = await getEmailThreads();
    const hiddenWhy = (needle: string) => t1.hidden.find((h) => h.subject.includes(needle))?.why ?? null;
    c.ok("Email lists client threads only: Nadia's, Mike's thank-you thread, the pitch the rules let through", t1.threads.some((t) => t.counterpart === "Nadia Osborne") && !t1.threads.some((t) => /Core9|Laura Hayes/.test(t.counterpart)) && !t1.threads.some((t) => /^Accepted/.test(t.subject)), t1.threads.map((t) => `${t.counterpart}: ${t.subject}`).join(" | "));
    c.ok("…the fold says why: the calendar accept, Core9, Laura Hayes", hiddenWhy("Accepted") === "Calendar invite or reply" && hiddenWhy("shipment") === "Not from a saved client" && hiddenWhy("capital") === "Not from a saved client" && t1.hiddenTotal === 3, t1.hidden.map((h) => `${h.subject}: ${h.why}`).join(" | "));
    c.ok("…each thread carries when they last wrote (for its unread dot)", t1.threads.every((t) => t.lastInboundISO === null || !Number.isNaN(Date.parse(t.lastInboundISO))));

    // ---- the AI fail-safe --------------------------------------------------------
    const verdictRows = () => prisma.appSetting.count({ where: { key: { startsWith: "comms-not-client" } } });
    const down = await nc.sweepNotClientEmail({ now, judge: async () => { throw new Error("model down"); } });
    c.ok("AI down: nothing hidden, nothing stored, the watermark does not move", down.skipped === "ai unavailable" && (await verdictRows()) === 0, JSON.stringify(down));
    const judged: string[] = [];
    const up = await nc.sweepNotClientEmail({
      now,
      judge: async (rows) => {
        judged.push(...rows.map((x) => x.subject));
        return rows.map((x) => (x.id === pitchRow.id ? { id: x.id, kind: "marketing", sure: true, why: "a growth agency's pitch" } : /Oak Ln/.test(x.subject) ? { id: x.id, kind: "solicitation", sure: false } : { id: x.id, kind: "client", sure: true }));
      },
    });
    c.ok("the AI is asked only what the rules let through (not the calendar accept)", judged.includes("Quick question") && !judged.some((s) => /^Accepted/.test(s)), judged.join(" | "));
    c.ok("only the sure \"not a client\" is stored (an unsure one is not)", up.hidden === 1 && (await prisma.appSetting.count({ where: { key: rq.notClientVerdictKey(pitchRow.id) } })) === 1, JSON.stringify(up));
    const again = await nc.sweepNotClientEmail({ now, judge: async () => { throw new Error("must not be asked twice"); } });
    c.ok("…and the watermark moved: the next pass asks nothing", again.skipped === "nothing new", JSON.stringify(again));
    const boards2 = await unansweredCommsBoards(now);
    c.ok("the pitch leaves Waiting on us", boards.email.some((g) => g.clientId === pitch.id) && !boards2.email.some((g) => g.clientId === pitch.id), boards2.email.map((g) => g.clientName).join(", "));
    const t2 = await getEmailThreads();
    const aiRow = t2.hidden.find((h) => h.id === pitchRow.id);
    c.ok("…and Email: folded as the AI check's, which can be undone", !!aiRow && aiRow.why === "Not a client (AI check)" && aiRow.byAi && !t2.threads.some((t) => t.counterpart === "Dana Growth"));
    await nc.clearNotClientVerdict(pitchRow.id);
    c.ok("\"It is a client: show it\" puts it back", (await getEmailThreads()).threads.some((t) => t.counterpart === "Dana Growth"));

    // =======================================================================
    c.head("4 · Unread");
    // =======================================================================
    const me = "appuser-kyle";
    const omarGroup = boards.phone.find((g) => g.clientId === omar.id)!;
    const keysOf = (g: typeof omarGroup) => reads.waitingReadKeys("phone", g);
    c.ok("Omar's conversation is unread before anyone opens it", (await reads.unreadRows(me, [omarGroup], keysOf)).size === 1);
    await reads.markRead(me, reads.textReadKey(omarGroup.key), now);
    c.ok("opened: read", (await reads.unreadRows(me, [omarGroup], keysOf)).size === 0);
    c.ok("…for that person only", (await reads.unreadRows("appuser-jordan", [omarGroup], keysOf)).size === 1);
    await reads.markRead(me, reads.textReadKey(omarGroup.key), ago(DAY));
    c.ok("a mark never moves back", (await reads.unreadRows(me, [omarGroup], keysOf)).size === 0);
    const newer = { ...omarGroup, items: [...omarGroup.items, { ...omarGroup.items[0], atISO: ahead(HOUR).toISOString() }] };
    c.ok("a newer message from them makes it unread again", (await reads.unreadRows(me, [newer], keysOf)).size === 1);
    c.ok("a ledger row's #task suffix is the same conversation", reads.textReadKey(`c:${omar.id}#task1`) === reads.textReadKey(`c:${omar.id}`));
    c.ok("an email thread's read key is Messages · Email's own thread key", reads.emailReadKeyFor("Re: Photos for 12 Oak Ln", nadia.id) === reads.emailReadKey(t1.threads.find((t) => t.counterpart === "Nadia Osborne")!.key));
    await reads.markRead(me, "not-a-message-key", now);
    c.ok("only msg: keys are written (the team chat's own marks are never touched)", (await prisma.threadRead.count({ where: { projectId: "not-a-message-key" } })) === 0);

    // =======================================================================
    c.head("5 · Unsaved numbers: Not a client");
    // =======================================================================
    c.ok("the unsaved number's text is waiting", (await rq.replyQueue({ now })).cards.some((x) => x.key === "p:2155550199"));
    c.ok("\"Not a client\" mutes it", (await rq.muteNumber("(215) 555-0199", "not a client", now)) === "muted" && (await rq.isMutedNumber("2155550199")));
    const muted = await rq.mutedNumbers();
    c.ok("…with its reason on the muted list", muted.some((m) => m.phone === "2155550199" && m.reason === "not a client"), JSON.stringify(muted));
    c.ok("…and it is off the queue", !(await rq.replyQueue({ now })).cards.some((x) => x.key === "p:2155550199"));
    await prisma.teamMember.update({ where: { id: kyleTm.id }, data: { phone: "(215) 555-0777" } });
    c.ok("one of our own numbers is never muted", (await rq.muteNumber("2155550777", "not a client", now)) === "teammate");

    // =======================================================================
    c.head("6 · The reply backlog");
    // =======================================================================
    const th = (h: number) => ({ isClient: true, isTeam: false, courtesyOnly: false, waitingSince: ago(h * HOUR), displayName: `Client ${h}` });
    const eight = Array.from({ length: 8 }, (_, i) => th(i + 1));
    c.ok("8 waiting, the oldest 8h: not behind", !rq.backlogOf(eight, now).behind);
    c.ok("9 waiting: behind", rq.backlogOf([...eight, th(2)], now).behind);
    const old = rq.backlogOf([th(1), th(30)], now);
    c.ok("one waiting 30h: behind, and it is named", old.behind && old.oldestHours === 30 && old.overDay === 1 && old.oldestName === "Client 30");
    c.ok("thank-yous, teammates and unsaved numbers do not count", rq.backlogOf([{ ...th(40), courtesyOnly: true }, { ...th(40), isTeam: true }, { ...th(40), isClient: false }], now).waiting === 0);
    c.ok("Jordan's words", rq.backlogNoticeText({ waiting: 11, oldestHours: 31, overDay: 2, oldestName: null, behind: true }) === "We're behind on replies: 11 waiting, the oldest 31h. Review, reply or mark handled.");
    // A client who has waited since yesterday morning.
    await log({ clientId: nadia.id, contactName: "Nadia Osborne", phone: "2155550101", body: "Did you get a chance to look at the twilight edits?", at: ago(26 * HOUR) });
    const live = await rq.replyBacklog({ now });
    c.ok("replyBacklog() reads the same client threads (Nadia 26h, Omar): behind on age", live.behind && live.oldestHours >= 26 && live.oldestName === "Nadia Osborne", JSON.stringify(live));
    const early = await rq.escalateReplyBacklog(ago(2 * HOUR)); // 8:00 AM ET
    c.ok("before 9 AM ET: nothing is sent", !early.sent && early.skipped === "before 9 AM ET");
    const sent = await rq.escalateReplyBacklog(now);
    const bell = await prisma.notification.findMany({ where: { kind: "reply_backlog" } });
    c.ok("from 9 AM: Kyle's bell gets ONE row, in Jordan's words, linking to Messages", sent.sent && bell.length === 1 && bell[0].userKey === `tm:${kyleTm.id}` && /^We're behind on replies: \d+ waiting, the oldest \d+h\. Review, reply or mark handled\.$/.test(bell[0].body ?? "") && bell[0].href === "/communications", JSON.stringify(bell.map((b) => [b.userKey, b.body, b.href])));
    const twice = await rq.escalateReplyBacklog(ahead(3 * HOUR));
    c.ok("…and once a day: a later pass the same day sends nothing", !twice.sent && twice.skipped === "already sent today" && (await prisma.notification.count({ where: { kind: "reply_backlog" } })) === 1);

    // =======================================================================
    c.head("7 · The Outbox follows the live shoot (Georgiana, 2031 Ruth St)");
    // =======================================================================
    const geo = await prisma.client.create({ data: { name: "Georgiana Pike", phone: "(610) 555-0177" }, select: { id: true } });
    const ruth = await prisma.project.create({ data: { clientId: geo.id, title: "2031 Ruth St, Allentown, PA", status: "SCHEDULED", shootDate: ahead(20 * HOUR) }, select: { id: true } });
    await tasks.generateTasksForProject(ruth.id);
    const conf = () => prisma.smartTask.findFirst({ where: { projectId: ruth.id, taskType: "confirmation_text" } });
    const inOutbox = async () => (await prisma.smartTask.count({ where: { AND: [ct.clientTextWhere(new Date()), { projectId: ruth.id }] } })) === 1;
    let cf = await conf();
    c.ok("booked for tomorrow: the confirmation is drafted, due the day before, and in the Outbox", !!cf && cf.status === "OPEN" && cf.dueAt?.getTime() === ahead(20 * HOUR).getTime() - DAY && (await inOutbox()), `${cf?.status} ${cf?.dueAt?.toISOString()}`);
    c.ok("…its due time has passed (the day before), and it does NOT read \"may be out of date\": the shoot is ahead and tomorrow", ct.confirmationInWindow(ahead(20 * HOUR), now));
    await prisma.project.update({ where: { id: ruth.id }, data: { shootDate: null } });
    await tasks.generateTasksForProject(ruth.id);
    cf = await conf();
    c.ok("postponed with no new date: HELD, no date, and off the Outbox", cf?.status === "OPEN" && cf.dueAt === null && cf.summary === tasks.CONFIRMATION_HELD && !(await inOutbox()), `${cf?.status} ${cf?.dueAt?.toISOString() ?? "no date"} ${cf?.summary}`);
    const NEW_SHOOT = ahead(5 * DAY);
    await prisma.project.update({ where: { id: ruth.id }, data: { shootDate: NEW_SHOOT } });
    await tasks.generateTasksForProject(ruth.id);
    cf = await conf();
    c.ok("a new date five days out: re-timed to the day before it, the summary back, and NOT in the Outbox yet", cf?.status === "OPEN" && cf.dueAt?.getTime() === NEW_SHOOT.getTime() - DAY && cf.summary !== tasks.CONFIRMATION_HELD && !(await inOutbox()), `${cf?.dueAt?.toISOString()} ${cf?.summary?.slice(0, 40)}`);
    setNow(NEW_SHOOT.getTime() - 20 * HOUR);
    c.ok("…the day before the new date: in the Outbox", await inOutbox());
    setNow(NEW_SHOOT.getTime() + HOUR);
    c.ok("…after the shoot: off the Outbox (nothing left to confirm)", !(await inOutbox()) && !ct.confirmationInWindow(NEW_SHOOT, new Date()));
    setNow(NOW);
    c.ok("the window: ahead of us and no later than the end of tomorrow (ET)", ct.confirmationInWindow(ahead(HOUR), now) && ct.confirmationInWindow(ahead(37 * HOUR), now) && !ct.confirmationInWindow(ahead(39 * HOUR), now) && !ct.confirmationInWindow(ago(HOUR), now) && !ct.confirmationInWindow(null, now));

    // =======================================================================
    c.head("8 · Late promises: only past the promise");
    // =======================================================================
    const hannum = await prisma.client.create({ data: { name: "William Hannum" }, select: { id: true } });
    const tomorrow = await prisma.project.create({ data: { clientId: hannum.id, title: "88 Hannum Way, Paoli, PA", status: "EDITING", shootDate: ago(DAY), promisedDueAt: ahead(20 * HOUR) }, select: { id: true } });
    const lateJob = await prisma.project.create({ data: { clientId: hannum.id, title: "14 Late Ln, Paoli, PA", status: "EDITING", shootDate: ago(3 * DAY), promisedDueAt: ago(3 * HOUR) }, select: { id: true } });
    const rows = await at.atRiskOutputs(now);
    c.ok("William Hannum's photos, due tomorrow: NOT listed", !rows.some((x) => x.projectId === tomorrow.id), rows.map((x) => x.street).join(" | "));
    c.ok("a job three hours past its promise: listed, overdue", rows.some((x) => x.projectId === lateJob.id && x.overdue));
    const draft = await at.autoDraftAtRiskUpdate({ projectId: tomorrow.id, promisedAt: ahead(20 * HOUR), now });
    c.ok("no \"running behind\" draft before the promise", !draft.ok && (await prisma.smartTask.count({ where: { taskType: "at_risk_update", projectId: tomorrow.id } })) === 0, draft.ok ? "drafted" : draft.message);
    const lateDraft = await at.autoDraftAtRiskUpdate({ projectId: lateJob.id, promisedAt: ago(3 * HOUR), now });
    c.ok("…one past it still drafts (on Kyle's list, never sent)", lateDraft.ok && lateDraft.created, lateDraft.ok ? lateDraft.draft : lateDraft.message);

    // =======================================================================
    c.head("9 · Team chat is not on the Messages tab bar");
    // =======================================================================
    c.ok("the bar: Waiting on us, Email, Outbox, All", nav.MESSAGES_TABS.filter((t) => t.onBar !== false).map((t) => t.key).join() === "waiting,email,outbox,all");
    c.ok("…?tab=team still opens the team center (the messages icon's Team messages)", nav.resolveMessagesTab({ tab: "team" }) === "team");

    c.ok("nothing was sent: no outbox row, no outbound message", (await prisma.outboxMessage.count()) === 0 && (await prisma.commLog.count({ where: { direction: "out" } })) === 0);
    c.ok("no request left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
