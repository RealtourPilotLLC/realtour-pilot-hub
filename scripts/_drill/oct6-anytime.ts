// ---------------------------------------------------------------------------
// DRILL: OCT 6 2026 — ANYONE ON THE TEAM, ANY HOUR (Jordan, verbatim:
// "Editors can get night time pings. Anyone on the team can get pinged
// anytime. Just not Jordan on Saturday until 7:30PM.")
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct6-anytime.ts --logs /private/tmp/oct6-anytime
//
// That rule replaced Jordan's Sep 25/26 "overnight urgent pages held to 7 AM"
// and every default night hold built on it: the 10 PM–7 AM page rule, the
// staff texting window (7 AM–10 PM in the recipient's zone), the Manila
// editor's 10 PM–7 AM DM hold, and the `holdOvernight` option on Kyle's
// notices, the ops relays, the desk-task pings and the Review Room relay.
// Every check drives the SHIPPED code — the real bell bridge, the real staff
// text queue and its 5-minute flusher (texts AND held Slack DMs), the real
// job-chat notifier, the real Review Room announcer, the real ops relay, the
// real urgent pager, the real program desk tasks and Kyle's named notice:
//
//   1  2 AM ET (Tue): Kim's job-chat DM, Kyle's notice, an ops relay, an
//      urgent on-call page, an URGENT desk-task ping and James's "video in
//      review" TEXT all go at once; nothing is held, queued or announced as
//      held.
//   2  2 AM in Manila (Tue 14:00 ET): the same six, at once — Kim's night is
//      no longer a hold.
//   3  Jordan on Saturday 10:00 ET: the bell at once, his DM and text HELD and
//      released at 19:30 ET, once (19:25 nothing, 19:31 one of each, 19:40
//      nothing more); Kyle on the same Saturday morning, at once.
//   3b Saturday 11:00 ET, ROUTINE work notices (the kinds the Sep 20 weekend
//      rota dated to Monday 9 AM) to Kim, Kyle and Harrison — no saved
//      schedule, office cover Mon–Fri: each goes at once on the channels they
//      switched on, and Harrison (Slack AND text) gets BOTH — the DM is no
//      longer skipped because a text was queued.
//   4  Jordan on Sunday 2 AM: a DM and a text at once.
//   5  A person's OWN saved quiet window still holds them (Harrison's text,
//      Kyle's notice and his ops relay — Sunday until 8 AM), released once.
//   6  The Settings copy states the rule; the house night constants are gone.
//
// ISOLATION: PGlite on 127.0.0.1:6810 (this builder's range 6810-6829);
// production is never opened; every non-loopback call is fenced; Slack is
// answered by a fake and counted; OpenPhone's two calls are replaced
// in-process. THE CLOCK IS PINNED and only ever moved FORWARD (the roster and
// settings caches compare against Date.now()): Tue Oct 13 2026 02:00 EDT on.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6810;
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
/** Oct 2026 wall clock in EDT (UTC-4). */
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 13, 2, 0).getTime() - RealDate.now();
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
let last = edt(10, 13, 2, 0).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};

// ---- no login on any of these paths, but the guards read this seam ---------
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k === "getCurrentUser") return async () => null;
        return t[k];
      },
    }),
);
installNextStubs();

// ---- Slack, faked at fetch and counted --------------------------------------
type SlackPost = { channel: string; text: string; at: number };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "", at: Date.now() });
    return json({ ok: true, ts: String(slack.length) });
  }
  // No ops channel the bot is in: the ops destination is Kyle's DM, as production has it.
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

const S = { jordan: "U0JORDAN01", kyle: "U0KYLE0001", james: "U0JAMES001", harrison: "U0HARRIS01", kim: "U0KIMMIG01" };

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const notify = await import("@/lib/notify");
  const sched = await import("@/lib/notifySchedule");
  const defaults = await import("@/lib/notifyPrefDefaults");
  const { announceCutInReview } = await import("@/lib/reviewCuts");
  const { notifyProjectMessage } = await import("@/lib/mentions");
  const { noticeForKyle } = await import("@/lib/kyleNotice");
  const desk = await import("@/lib/programDeskTasks");

  // OpenPhone: the number lookup and the send, answered in-process.
  const op = await import("@/lib/integrations/openphone");
  const OFFICE = "+16105550100";
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
  const texts: { to: string; body: string; at: Date }[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
    texts.push({ to: String(to), body, at: new Date() });
    return { data: { id: `op-${texts.length}` } };
  };
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

  // ---- the cast, as production has it (every row BEFORE the first notify:
  // the stack caches owner/office/editor lists for ten minutes) -------------
  type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
  const member = (name: string, email: string, role: TeamRole, phone: string | null, slackId: string | null, extra: Record<string, unknown> = {}) =>
    prisma.teamMember.create({ data: { name, email, role, phone, slackId, active: true, ...extra }, select: { id: true, name: true } });
  const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111", S.jordan, { opsAlerts: true });
  // Kyle's roster phone IS the office line — Slack is his only channel.
  const kyle = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE, S.kyle, { opsAlerts: true });
  const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", S.james, { creativeManager: true });
  const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144", S.harrison);
  const kim = await member("Kim Miguel", "kim@drill.invalid", "MANAGER", "+63 917 555 0101", S.kim);
  const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
    prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
  await login("jordan@drill.invalid", "OWNER", jordan.id);
  const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
  await login("james@drill.invalid", "ADMIN", james.id);
  await login("harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
  await login("kim@drill.invalid", "EDITOR", kim.id, { editorKey: "kim" });
  // Saved matrices: Jordan Slack + text for tags and cuts (production); Kyle
  // Slack; James "video in review" BY TEXT (so the night text is what is
  // proved); Harrison his tags by text.
  const allOff = { mention: { slack: false, sms: false }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: false, sms: false }, shoot_change: { slack: false, sms: false } };
  await putSetting(`notify-prefs:${jordan.id}`, { ...allOff, mention: { slack: true, sms: true }, review_ready: { slack: true, sms: true }, shoot_change: { slack: true, sms: true } });
  await putSetting(`notify-prefs:${kyle.id}`, { ...allOff, mention: { slack: true, sms: false }, review_ready: { slack: true, sms: false }, shoot_change: { slack: true, sms: false } });
  await putSetting(`notify-prefs:${james.id}`, { ...allOff, mention: { slack: true, sms: false }, review_ready: { slack: false, sms: true } });
  await putSetting(`notify-prefs:${harrison.id}`, { ...allOff, mention: { slack: false, sms: true } });
  // The Review Room seats as Jordan set them: James first, Kyle backup, Jordan fallback.
  await putSetting("review_room", {
    discoverFromDropbox: false, keepUploadsDays: 90,
    creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
    coverOfferHours: 9, coverTransferHours: null,
  });
  // Office cover Mon–Fri 9–6 with Kyle on call: 2 AM is out of cover, so the
  // urgent page is routed to him — the exact path the old 10 PM–7 AM rule held.
  await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: kyle.id } });
  // Kyle is the program's DELIVERY owner — who noticeForKyle addresses.
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });

  // ---- helpers -----------------------------------------------------------
  const dms = (slackId: string, since = 0) => slack.slice(since).filter((m) => m.channel === slackId);
  const textsTo = (digits: string, since = 0) => texts.slice(since).filter((t) => t.to.replace(/\D/g, "").endsWith(digits));
  const JORDAN_PH = "6105550111";
  const JAMES_PH = "6105550133";
  const HARRISON_PH = "6105550144";
  const heldRows = async () =>
    (await prisma.appSetting.findMany({ where: { key: { startsWith: sched.HELD_DM_PREFIX } }, select: { value: true } }))
      .map((r) => JSON.parse(r.value) as { teamMemberId: string; text: string; until: string; settledAt?: string })
      .filter((r) => !r.settledAt);
  const datedTexts = () => prisma.pendingSms.findMany({ where: { sentAt: null, skippedAt: null, deferUntil: { not: null } }, select: { teamMemberId: true, deferUntil: true, line: true } });
  const unsent = (tmId: string) => prisma.pendingSms.findMany({ where: { teamMemberId: tmId, sentAt: null, skippedAt: null }, orderBy: { createdAt: "asc" } });
  const client = await prisma.client.create({ data: { name: "Paula Prospect" }, select: { id: true } });
  const mkJob = async (street: string, data: Record<string, unknown> = {}) => {
    const p = await prisma.project.create({ data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "EDITING", addressLine: street, ...data }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
    return { id: p.id, deliverableId: d.id, street };
  };
  let round = 0;
  const mkCut = async (job: { id: string; deliverableId: string }) =>
    (await prisma.reviewSubmission.create({
      data: {
        projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: ++round, kind: "video", source: "upload",
        status: "PENDING", fileName: `cut-${round}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel",
      },
      select: { id: true },
    })).id;
  let msgSeq = 0;
  const post = (projectId: string, author: { id: string; name: string }, text: string) =>
    notifyProjectMessage({ projectId, messageId: `oct6-msg-${++msgSeq}`, authorTmId: author.id, authorKey: `tm:${author.id}`, authorName: author.name, text, context: "the job's team chat", excludeTmIds: [] });
  const tag = (to: { id: string }, street: string, key: string) =>
    notify.notifyInApp({
      kind: "mention",
      title: `Kyle tagged you — ${street}`,
      href: "/projects/drill",
      targets: [{ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${to.id}`, slackDm: `💬 Kyle tagged you on ${street}:\n> can you look at this\nhttps://drill.invalid/projects/drill` }],
      dedupeKey: key,
    });

  /** The six pings Jordan's rule is about, raised at one instant. Every one
   *  must reach its person NOW: a DM or a text, nothing held, nothing dated. */
  const sixAtOnce = async (label: string, n: number) => {
    const s0 = slack.length, t0 = texts.length;
    // 1. Kim — a photographer's post on her job's team chat.
    const job = await mkJob(`${60 + n} Night Shift Rd`, { editorId: kim.id, photographerId: harrison.id });
    await post(job.id, harrison, `Drone shots re-uploaded (${label})`);
    const kimDm = dms(S.kim, s0);
    c.ok(`${label}: Kim's job-chat DM goes at once`, kimDm.length === 1 && /Drone shots re-uploaded/.test(kimDm[0]?.text ?? ""), kimDm.map((m) => m.text.slice(0, 80)).join(" | ") || "no DM");

    // 2. Kyle's named notice (a 1080p file waiting on a listen).
    const k0 = slack.length;
    const notice = await noticeForKyle({ kind: "topaz_problem", title: `1080p file held — ${60 + n} Night Shift Rd`, body: "Listen to it.", href: "/#video-review", dedupeKey: `oct6-notice-${n}`, slack: `1080p file held, not sent — ${60 + n} Night Shift Rd (${label})` });
    c.ok(`${label}: Kyle's notice — the bell, and his Slack DM at once (no overnight hold)`, notice.bell && notice.slack === "slack" && dms(S.kyle, k0).some((m) => /1080p file held, not sent/.test(m.text)), JSON.stringify(notice));

    // 3. An ops relay — the ops channel IS Kyle's DM today.
    const o0 = slack.length;
    const relayed = await notify.opsAlert(`🟥 Cron "topaz" degraded (${label})`);
    c.ok(`${label}: an ops relay is a DM to Kyle at once`, relayed && dms(S.kyle, o0).length === 1 && /Cron "topaz" degraded/.test(dms(S.kyle, o0)[0]?.text ?? ""));

    // 4. An urgent page — the reply-SLA pager's shape, routed to the on-call out of cover.
    const p0 = slack.length;
    const page = await notify.notifyStaffSms([kyle.id], `Client still unanswered (VIP) — Ann Lee, 2h (${label})`, "reply_sla", { urgency: "urgent" });
    c.ok(`${label}: the urgent page reaches Kyle as a DM at once`, page.length === 1 && page[0].teamMemberId === kyle.id && page[0].outcome === "slack" && dms(S.kyle, p0).some((m) => /Ann Lee/.test(m.text)), JSON.stringify(page));
    c.ok(`${label}: …and no 'Urgent page held' line anywhere`, !slack.slice(p0).some((m) => /Urgent page held/.test(m.text)));

    // 5. An URGENT desk task on Kyle's list.
    const d0 = slack.length;
    await desk.openProgramDeskTask({
      dedupeKey: `program-scripts-unapproved:oct6:${n}`, clientId: client.id, clientName: "Paula Prospect",
      title: `Scripts not approved before filming — Paula Prospect (${label})`, lines: ["Filming is tomorrow."], assignedKey: "kyle",
      reasonCreated: "drill", reopenIfClosed: false, dueAt: new Date(Date.now() + 20 * 3_600_000), priority: "URGENT",
    });
    c.ok(`${label}: the URGENT desk-task ping is a DM to Kyle at once`, dms(S.kyle, d0).some((m) => /New on your list \(URGENT\): Scripts not approved before filming/.test(m.text)), dms(S.kyle, d0).map((m) => m.text.slice(0, 80)).join(" | ") || "no DM");

    // 6. James's "video in review" — BY TEXT, the leg the texting window held.
    const rv = await mkJob(`${70 + n} Review Row`, { status: "REVIEW", photographerId: harrison.id });
    const cut = await mkCut(rv);
    const j0 = texts.length;
    await announceCutInReview({ kind: "cut_ready", projectId: rv.id, submissionId: cut, round: 1, street: rv.street, fileName: "cut.mp4", editorKey: "kim", editorName: "Kim Miguel" });
    const jt = textsTo(JAMES_PH, j0);
    c.ok(`${label}: James's review TEXT goes at once (no 7 AM–10 PM texting window)`, jt.length === 1 && jt[0].body.includes(rv.street) && jt[0].body.startsWith("⚙️ RealTour Hub"), jt.map((t) => t.body.slice(0, 90)).join(" | ") || "no text");
    c.ok(`${label}: …and nothing of his left in the queue`, (await unsent(james.id)).length === 0);

    c.ok(`${label}: NOTHING held for anyone — no held DM, no dated text`, (await heldRows()).length === 0 && (await datedTexts()).length === 0, JSON.stringify({ held: await heldRows(), dated: await datedTexts() }));
    return { s0, t0 };
  };

  // =========================================================================
  c.head("1 · 2 AM ET (Tue Oct 13): every ping goes at once");
  {
    setClock(edt(10, 13, 2, 0));
    const at = await sixAtOnce("2 AM ET", 1);
    // The five-minute flusher at 7 AM finds nothing left to send — each went once.
    setClock(edt(10, 13, 7, 1));
    const f = await notify.flushPendingSms();
    c.ok("07:01: no held DM is released and nobody gets a second copy — every ping went at 2 AM, once", f.dms.sent === 0 && textsTo(JAMES_PH, at.t0).length === 1 && dms(S.kim, at.s0).length === 1, JSON.stringify(f));
  }

  // =========================================================================
  c.head("2 · 2 AM IN MANILA (Tue 14:00 ET = Wed 02:00 PHT): Kim's night is not a hold");
  {
    setClock(edt(10, 13, 14, 0));
    const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", hourCycle: "h23" }).format(new Date()));
    c.ok("the clock really is 2 AM in Manila", hour === 2, String(hour));
    const at = await sixAtOnce("2 AM Manila", 2);
    setClock(edt(10, 13, 19, 1)); // 07:01 Manila — when the Oct 5 hold would have let it go
    const f = await notify.flushPendingSms();
    c.ok("07:01 Manila: nothing more for Kim — her DM went at 2 AM her time, once", f.dms.sent === 0 && dms(S.kim, at.s0).length === 1, JSON.stringify(f));
  }

  // =========================================================================
  c.head("3 · JORDAN ON SATURDAY 10:00 ET: held, then delivered at 7:30 PM — once");
  {
    setClock(edt(10, 17, 10, 0)); // Sat Oct 17
    const s0 = slack.length, t0 = texts.length;
    await tag(jordan, "12 Quiet Ln", "oct6-sat-jordan");
    await tag(kyle, "12 Quiet Ln", "oct6-sat-kyle");
    c.ok("Jordan's bell row is written at once", (await prisma.notification.count({ where: { userKey: `tm:${jordan.id}`, dedupeKey: { startsWith: "oct6-sat-jordan" } } })) === 1);
    c.ok("…no DM and no text to Jordan at 10:00", dms(S.jordan, s0).length === 0 && textsTo(JORDAN_PH, t0).length === 0);
    const held = (await heldRows()).filter((r) => r.teamMemberId === jordan.id);
    const dated = (await datedTexts()).filter((r) => r.teamMemberId === jordan.id);
    c.ok("…his DM is held and his text dated, both to 19:30 ET", held.length === 1 && held[0].until === edt(10, 17, 19, 30).toISOString() && dated.length === 1 && dated[0].deferUntil?.toISOString() === edt(10, 17, 19, 30).toISOString(), JSON.stringify({ held: held.map((h) => h.until), dated: dated.map((d) => d.deferUntil) }));
    c.ok("Kyle, the same Saturday morning: a DM at once (anyone else, any time)", dms(S.kyle, s0).length === 1 && /12 Quiet Ln/.test(dms(S.kyle, s0)[0]?.text ?? ""));

    // 3b — Saturday 11:00: routine work notices, nobody with a saved schedule.
    setClock(edt(10, 17, 11, 0));
    const cov = await (await import("@/lib/coverage")).coverageRules();
    c.ok("office cover is Monday–Friday (the setting the old weekend hold read) — still saved, still Mon–Fri", cov.weekdaysOnly === true, JSON.stringify(cov));
    await putSetting(`notify-prefs:${harrison.id}`, { ...allOff, mention: { slack: false, sms: true }, review_ready: { slack: true, sms: true } });
    const w0 = slack.length, wt0 = texts.length;
    const kimJob = await mkJob("40 Weekend Way", { editorId: kim.id, photographerId: harrison.id });
    await notify.notifyInApp({
      kind: "raws_landed", title: "Raws in — 40 Weekend Way: ready for editing", href: "/editing",
      targets: [{ roles: ["EDITOR"], userKey: "editor:kim", href: `/edit/${kimJob.id}` }], dedupeKey: "oct6-sat-raws-kim",
    });
    await notify.notifyInApp({
      kind: "cut_ready", title: "Cut ready to review — 42 Weekend Way", href: "/review/drill",
      targets: [{ roles: ["ADMIN"], userKey: `tm:${kyle.id}`, slackDm: "🎬 Cut ready to review — 42 Weekend Way. https://drill.invalid/review/drill" }], dedupeKey: "oct6-sat-cut-kyle",
    });
    await notify.notifyInApp({
      kind: "cut_ready", title: "A cut from your shoot — 44 Weekend Way", href: "/review/drill",
      targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${harrison.id}`, slackDm: "🎬 A cut from your shoot is in review — 44 Weekend Way. https://drill.invalid/review/drill" }], dedupeKey: "oct6-sat-cut-harrison",
    });
    c.ok("Sat 11:00: Kim's 'raws in' job ping is a DM at once", dms(S.kim, w0).some((m) => /40 Weekend Way/.test(m.text)), dms(S.kim, w0).map((m) => m.text.slice(0, 60)).join(" | ") || "no DM");
    c.ok("Sat 11:00: Kyle's routine cut-ready is a DM at once", dms(S.kyle, w0).some((m) => /42 Weekend Way/.test(m.text)), dms(S.kyle, w0).map((m) => m.text.slice(0, 60)).join(" | ") || "no DM");
    c.ok("Sat 11:00: Harrison (Slack AND text) gets the DM at once — not skipped because his text was queued", dms(S.harrison, w0).some((m) => /44 Weekend Way/.test(m.text)), dms(S.harrison, w0).map((m) => m.text.slice(0, 60)).join(" | ") || "no DM");
    c.ok("…and the text at once, not dated to Monday 9 AM", textsTo(HARRISON_PH, wt0).some((t) => /44 Weekend Way/.test(t.body)) && (await unsent(harrison.id)).length === 0, textsTo(HARRISON_PH, wt0).map((t) => t.body.slice(0, 60)).join(" | ") || "no text");
    const weekendHeld = (await heldRows()).filter((r) => r.teamMemberId !== jordan.id);
    const weekendDated = (await datedTexts()).filter((r) => r.teamMemberId !== jordan.id);
    c.ok("…nothing held or dated for any of the three (only Jordan's own Saturday is waiting)", weekendHeld.length === 0 && weekendDated.length === 0, JSON.stringify({ weekendHeld, weekendDated }));
    c.ok("…and no delivery row says a DM was skipped for a held text", (await prisma.notificationDelivery.count({ where: { channel: "slack", status: "skipped", detail: { contains: "held as a text" } } })) === 0);
    await putSetting(`notify-prefs:${harrison.id}`, { ...allOff, mention: { slack: false, sms: true } });
    setClock(edt(10, 17, 19, 25));
    await notify.flushPendingSms();
    c.ok("19:25: still nothing to Jordan", dms(S.jordan, s0).length === 0 && textsTo(JORDAN_PH, t0).length === 0);
    setClock(edt(10, 17, 19, 31));
    await notify.flushPendingSms();
    await notify.flushPendingSms(); // a second tick in the same minute sends nothing more
    c.ok("19:31: ONE DM and ONE text to Jordan", dms(S.jordan, s0).length === 1 && /12 Quiet Ln/.test(dms(S.jordan, s0)[0]?.text ?? "") && textsTo(JORDAN_PH, t0).length === 1 && /12 Quiet Ln/.test(textsTo(JORDAN_PH, t0)[0]?.body ?? ""), `${dms(S.jordan, s0).length} DM(s), ${textsTo(JORDAN_PH, t0).length} text(s)`);
    setClock(edt(10, 17, 19, 40));
    await notify.flushPendingSms();
    c.ok("19:40: nothing more — released once, never dropped", dms(S.jordan, s0).length === 1 && textsTo(JORDAN_PH, t0).length === 1 && (await heldRows()).length === 0 && (await unsent(jordan.id)).length === 0);
  }

  // =========================================================================
  c.head("4 · JORDAN ON SUNDAY 2 AM: at once");
  {
    setClock(edt(10, 18, 2, 0)); // Sun Oct 18 02:00 EDT
    const s0 = slack.length, t0 = texts.length;
    await tag(jordan, "20 Sunday St", "oct6-sun-jordan");
    c.ok("Sunday 02:00: Jordan's tag is a DM and a text at once", dms(S.jordan, s0).length === 1 && textsTo(JORDAN_PH, t0).length === 1, `${dms(S.jordan, s0).length} DM(s), ${textsTo(JORDAN_PH, t0).length} text(s)`);
    c.ok("…nothing held or dated for him", (await heldRows()).filter((r) => r.teamMemberId === jordan.id).length === 0 && (await unsent(jordan.id)).length === 0);
  }

  // =========================================================================
  c.head("5 · A PERSON'S OWN SAVED QUIET TIME STILL HOLDS THEM (Sunday until 8 AM)");
  {
    // Harrison and Kyle each save "Sunday midnight to 8 AM" on the card — their choice.
    await sched.saveSchedule(harrison.id, [{ day: 0, from: 0, to: 8 * 60 }], "drill");
    await sched.saveSchedule(kyle.id, [{ day: 0, from: 0, to: 8 * 60 }], "drill");
    setClock(edt(10, 18, 2, 5));
    const s0 = slack.length, t0 = texts.length;
    await tag(harrison, "30 Own Window Way", "oct6-own-harrison");
    const notice = await noticeForKyle({ kind: "topaz_problem", title: "1080p file held — 30 Own Window Way", body: "Listen to it.", href: "/#video-review", dedupeKey: "oct6-own-kyle", slack: "1080p file held, not sent — 30 Own Window Way" });
    const kept = await notify.opsAlert("🟥 Cron \"backup\" degraded (Sunday 2 AM)");
    c.ok("Harrison's tag: no text now, one queued line dated 08:00 ET", textsTo(HARRISON_PH, t0).length === 0 && (await unsent(harrison.id)).length === 1 && (await unsent(harrison.id))[0].deferUntil?.toISOString() === edt(10, 18, 8, 0).toISOString(), JSON.stringify((await unsent(harrison.id)).map((p) => p.deferUntil)));
    c.ok("Kyle's notice: the bell at once, the DM held (his own window)", notice.bell && notice.slack === "held" && dms(S.kyle, s0).length === 0, JSON.stringify(notice));
    c.ok("…the ops relay to his DM is KEPT, not sent", kept && dms(S.kyle, s0).length === 0);
    const kh = (await heldRows()).filter((r) => r.teamMemberId === kyle.id);
    c.ok("…both held for Kyle, dated 08:00 ET", kh.length === 2 && kh.every((h) => h.until === edt(10, 18, 8, 0).toISOString()), kh.map((h) => h.until).join(", "));
    setClock(edt(10, 18, 7, 59));
    await notify.flushPendingSms();
    c.ok("07:59: still nothing (their own 08:00 decides, no house 7 AM)", textsTo(HARRISON_PH, t0).length === 0 && dms(S.kyle, s0).length === 0);
    setClock(edt(10, 18, 8, 1));
    await notify.flushPendingSms();
    await notify.flushPendingSms();
    const kd = dms(S.kyle, s0);
    c.ok("08:01: Harrison gets ONE text", textsTo(HARRISON_PH, t0).length === 1 && /30 Own Window Way/.test(textsTo(HARRISON_PH, t0)[0]?.body ?? ""));
    c.ok("…Kyle gets ONE DM carrying both, oldest first", kd.length === 1 && /Held during your quiet time — 2 notices/.test(kd[0].text) && kd[0].text.indexOf("30 Own Window Way") < kd[0].text.indexOf("Cron \"backup\""), kd.map((m) => m.text.slice(0, 200)).join(" | "));
    c.ok("…and nothing is left waiting", (await heldRows()).length === 0 && (await unsent(harrison.id)).length === 0);
    await sched.saveSchedule(harrison.id, null, "drill");
    await sched.saveSchedule(kyle.id, null, "drill");
  }

  // =========================================================================
  c.head("6 · THE RULE IS WRITTEN WHERE PEOPLE READ IT; THE HOUSE NIGHT IS GONE FROM THE CODE");
  {
    const card = fs.readFileSync(path.join(REPO, "src/components/settings/NotificationSchedule.tsx"), "utf8");
    c.ok("the Settings card states the rule", card.includes("Anyone on the team can be notified at any hour.") && card.includes("quiet on Saturdays until 7:30 PM ET, then") && card.includes("everything held is delivered. Anyone can add their own quiet times here."));
    c.ok("…and no longer promises a night hold", !/no texts between/.test(card) && !/OVERNIGHT_/.test(card));
    const team = fs.readFileSync(path.join(REPO, "src/components/settings/TeamNotifications.tsx"), "utf8");
    c.ok("Team notifications no longer says texts wait 7 AM–10 PM", !/between 7 AM and 10 PM/.test(team) && /at any hour/.test(team));
    c.ok("no house-night constants or night helper are exported", !("OVERNIGHT_FROM" in defaults) && !("OVERNIGHT_TO" in defaults) && !("localNightEnd" in notify));
    c.ok("Jordan's Saturday until 7:30 PM is the one default window", JSON.stringify(defaults.OWNER_PRESET_WINDOWS) === JSON.stringify([{ day: 6, from: 0, to: 19 * 60 + 30 }]));
    const src = ["src/lib/notify.ts", "src/lib/kyleNotice.ts", "src/lib/programDeskTasks.ts", "src/app/review/actions.ts", "src/lib/notifySchedule.ts"]
      .map((f) => fs.readFileSync(path.join(REPO, f), "utf8"));
    c.ok("no caller passes holdOvernight, no code reads a texting window", src.every((t) => !/holdOvernight:\s*true/.test(t) && !/withinTextingHours\(/.test(t) && !/localNightEnd\(/.test(t)));
  }

  c.ok("nothing left the machine but the fakes", fence.blocked.length === 0, fence.blocked.join(", "));
  quiet.restore();
  c.summary();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
