// ---------------------------------------------------------------------------
// DRILL: OCT 5 2026 — TEAM NOTIFICATIONS (Jordan: "I want our communications
// perfect. Especially team notifications, so I don't have to remind and
// notify photographers, admin, editors, and the creative manager.")
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-team-notify.ts --logs /private/tmp/oct5-notify
//
// Every check drives the SHIPPED code — the real bell bridge, the real staff
// queue and its 5-minute flusher (texts AND held Slack DMs), the real
// Review Room announcer and cover sweep, the real Stripe activation, the real
// program desk tasks, the real job-chat notifier, the real self-check notice,
// the real Editing Room reassign action (getCurrentUser stubbed) and the real
// raws/ready notice — and asks: did the right PERSON get the right CHANNEL at
// the right TIME?
//
//   1  James (first reviewer, PHOTOGRAPHER on the roster) gets "Video in
//      review" by Slack via his SEAT, not a bell only; Harrison (no seat) does
//      not; the Settings row says so and its reset agrees.
//   2  A paid Content Program signup DMs Kyle (ops line) and the discovery-call
//      task is due TODAY and pings him; HIGH/URGENT desk tasks ping the person
//      whose list they are on; MEDIUM and TEST tasks never ping.
//   3  Kyle's covered-hours cover offer reaches him on Slack, once.
//   4  A cut held for its editor's check Slacks the editor (job_ping).
//   5  Manila: an editor DM raised in their night waits for 7 AM THEIR time
//      and goes once; a job-chat post before the raws are in pings no editor.
//   6  The ops channel (Kyle's DM when nothing else is set) keeps the 10 PM–
//      7 AM ET overnight rule and Kyle's own schedule; the "urgent page held"
//      notice no longer DMs him at 11:30 PM; SLACK_ALERT_CHANNEL posts at once
//      to a channel and falls back when the channel refuses.
//   7  Luma Visuals: a dispatch and a "ready for editing" with no in-house
//      editor Slack Kyle by name (never about his own click).
//   8  Photographers hear job-chat posts on the jobs they shot (text) by
//      default; and an explicit saved preference still wins (James, Harrison).
//
// ISOLATION: PGlite on 127.0.0.1:6560 (this builder's range 6560-6579);
// production is never opened; every non-loopback call is fenced; Slack is
// answered by a fake and counted; OpenPhone's two calls are replaced
// in-process. THE CLOCK IS PINNED and only ever moved FORWARD (the roster and
// settings caches compare against Date.now()): Tue Oct 6 2026 09:30 EDT on.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6560;

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
/** Oct 2026 wall clock in EDT (UTC-4). */
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 6, 9, 30).getTime() - RealDate.now();
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
let last = edt(10, 6, 9, 30).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};

// ---- the login, stubbed at the one seam every guard reads -------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k === "getCurrentUser") return async () => viewer;
        return t[k];
      },
    }),
);
installNextStubs();

// ---- Slack, faked at fetch and counted --------------------------------------
type SlackPost = { channel: string; text: string; at: number };
const slack: SlackPost[] = [];
const refuse = new Set<string>();
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    const channel = body.channel ?? "?";
    if (refuse.has(channel)) return json({ ok: false, error: "not_in_channel" });
    slack.push({ channel, text: body.text ?? "", at: Date.now() });
    return json({ ok: true, ts: String(slack.length) });
  }
  // No ops channel the bot is in: the default destination is Kyle's DM, as production has it.
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

const S = { jordan: "U0JORDAN01", kyle: "U0KYLE0001", james: "U0JAMES001", harrison: "U0HARRIS01", kim: "U0KIMMIG01", john: "U0JOHNMK01" };

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const notify = await import("@/lib/notify");
  const prefs = await import("@/lib/notifyPrefs");
  const defaults = await import("@/lib/notifyPrefDefaults");
  const sched = await import("@/lib/notifySchedule");
  const ra = await import("@/lib/reviewerAssignment");
  const { announceCutInReview } = await import("@/lib/reviewCuts");
  const { notifyProjectMessage } = await import("@/lib/mentions");
  const { notifySelfCheckNeeded } = await import("@/lib/selfCheckStore");
  const desk = await import("@/lib/programDeskTasks");
  const ss = await import("@/lib/stripeSignups");
  const { STRIPE_PROGRAM_PRICES } = await import("@/lib/contentProgram");
  const tasks = await import("@/lib/tasks");
  const editing = await import("@/app/editing/actions");

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
  const john = await member("John Mark Reyes", "johnmark@drill.invalid", "VA", null, S.john);
  const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
    prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
  const uJordan = await login("jordan@drill.invalid", "OWNER", jordan.id);
  const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
  await login("james@drill.invalid", "ADMIN", james.id);
  await login("harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
  await login("kim@drill.invalid", "EDITOR", kim.id, { editorKey: "kim" });
  await login("johnmark@drill.invalid", "EDITOR", john.id, { editorKey: "john" });
  // Saved matrices as production has them: Jordan Slack + text for tags and
  // cuts; Kyle Slack for tags, cuts and shoot changes. James, Harrison, Kim
  // and John: nothing saved (their defaults) until section 8 saves some.
  const allOff = { mention: { slack: false, sms: false }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: false, sms: false }, shoot_change: { slack: false, sms: false } };
  await putSetting(`notify-prefs:${jordan.id}`, { ...allOff, mention: { slack: true, sms: true }, review_ready: { slack: true, sms: true }, shoot_change: { slack: true, sms: true } });
  await putSetting(`notify-prefs:${kyle.id}`, { ...allOff, mention: { slack: true, sms: false }, review_ready: { slack: true, sms: false }, shoot_change: { slack: true, sms: false } });
  // The Review Room seats as Jordan set them: James first, Kyle backup, Jordan fallback.
  await putSetting("review_room", {
    discoverFromDropbox: false, keepUploadsDays: 90,
    creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
    coverOfferHours: 9, coverTransferHours: null,
  });
  const as = (u: { id: string }, tm: { id: string; name: string }, role: string): Viewer => ({
    id: u.id, email: `${tm.name.split(" ")[0].toLowerCase()}@drill.invalid`, name: tm.name, role, permissions: null, status: "ACTIVE",
    teamMemberId: tm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: tm.name,
  });

  // ---- helpers -----------------------------------------------------------
  const dms = (slackId: string, since = 0) => slack.slice(since).filter((m) => m.channel === slackId);
  const heldFor = async (tmId: string) =>
    (await prisma.appSetting.findMany({ where: { key: { startsWith: `held-dm:${tmId}:` } }, select: { value: true } }))
      .map((r) => JSON.parse(r.value) as { text: string; until: string; kind: string; settledAt?: string })
      .filter((r) => !r.settledAt);
  const pendingFor = (tmId: string) => prisma.pendingSms.findMany({ where: { teamMemberId: tmId }, orderBy: { createdAt: "asc" } });
  const textsTo = (digits: string, since = 0) => texts.slice(since).filter((t) => t.to.replace(/\D/g, "").endsWith(digits));
  const client = await prisma.client.create({ data: { name: "Drill Homeowner" }, select: { id: true } });
  const mkJob = async (street: string, data: Record<string, unknown> = {}) => {
    const p = await prisma.project.create({ data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "EDITING", addressLine: street, ...data }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
    return { id: p.id, deliverableId: d.id, street };
  };
  let round = 0;
  const mkCut = async (job: { id: string; deliverableId: string }, over: Record<string, unknown> = {}) =>
    (await prisma.reviewSubmission.create({
      data: {
        projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: ++round, kind: "video", source: "upload",
        status: "PENDING", fileName: `cut-${round}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel", ...over,
      },
      select: { id: true },
    })).id;
  const announce = (job: { id: string; street: string }, id: string) =>
    announceCutInReview({ kind: "cut_ready", projectId: job.id, submissionId: id, round: 1, street: job.street, fileName: "cut.mp4", editorKey: "kim", editorName: "Kim Miguel" });
  let msgSeq = 0;
  const post = (projectId: string, author: { id: string; name: string }, text: string) =>
    notifyProjectMessage({ projectId, messageId: `drill-msg-${++msgSeq}`, authorTmId: author.id, authorKey: `tm:${author.id}`, authorName: author.name, text, context: "the job's team chat", excludeTmIds: [] });
  const rowsFor = (prefix: string) => prisma.notification.findMany({ where: { dedupeKey: { startsWith: prefix } }, select: { userKey: true, kind: true } });

  // =========================================================================
  c.head("8 · PHOTOGRAPHERS HEAR JOB-CHAT POSTS ON THE JOBS THEY SHOT — and 5b · NO EDITOR PING BEFORE THE RAWS");
  {
    setClock(edt(10, 6, 9, 30)); // Tue 09:30 ET = Tue 21:30 Manila (their daytime)
    const hp = await prefs.notifyPrefsFor(harrison.id);
    c.ok("Harrison's default 'Job messages' is ON — by text, like his tags", hp.project_message.sms && !hp.project_message.slack, JSON.stringify(hp.project_message));
    const jobA = await mkJob("22 Not Shot Yet Ln", { status: "SCHEDULED", photographerId: harrison.id, editorId: kim.id });
    const t0 = texts.length;
    const s0 = slack.length;
    await post(jobA.id, kyle, "Client asked for the pool shot first, gate code 4411");
    const rowsA = await rowsFor("project-message-drill-msg-1-");
    c.ok("Harrison (assigned, job undelivered) gets the post as a TEXT, at once", textsTo("6105550144", t0).length === 1 && /pool shot first/.test(textsTo("6105550144", t0)[0].body), textsTo("6105550144", t0).map((t) => t.body).join(" | "));
    c.ok("5b: the job's editor of record (Kim) is NOT pinged — the raws are not in", !rowsA.some((r) => r.userKey === `tm:${kim.id}` || r.userKey === "editor:kim") && dms(S.kim, s0).length === 0, JSON.stringify(rowsA));
    await prisma.activity.create({ data: { projectId: jobA.id, type: "SYSTEM", body: "Raws in for 22 Not Shot Yet Ln — received: files received; readiness not checked yet." } });
    const s1 = slack.length;
    await post(jobA.id, harrison, "Twilight set is in the second folder");
    c.ok("5b: once the raws are in, Kim hears the next post on Slack (her daytime in Manila)", dms(S.kim, s1).length === 1 && /Twilight set/.test(dms(S.kim, s1)[0].text), dms(S.kim, s1).map((m) => m.text).join(" | "));
  }

  // =========================================================================
  c.head("4 · A CUT HELD FOR ITS EDITOR'S CHECK SLACKS THE EDITOR");
  {
    const jobS = await mkJob("31 Final Folder Ct");
    const cut = await mkCut(jobS, { submittedByKey: "john", submittedByName: "John Mark" });
    const s0 = slack.length;
    await notifySelfCheckNeeded(cut, "Dropped straight into the Final folder — tick the check before it goes to review.");
    const johnDms = dms(S.john, s0);
    c.ok("John Mark (whose cut it is) gets a Slack DM, not only a bell — Tue 21:30 Manila", johnDms.length === 1 && /Check needed before review — 31 Final Folder Ct/.test(johnDms[0].text), johnDms.map((m) => m.text).join(" | "));
    const legs = await prisma.notificationDelivery.findMany({ where: { teamMemberId: john.id, kind: "self_check_needed" }, select: { channel: true, status: true } });
    c.ok("…and the delivery log says bell + slack/sent", legs.some((l) => l.channel === "bell") && legs.some((l) => l.channel === "slack" && l.status === "sent"), JSON.stringify(legs));
    c.ok("the office copy stays a bell (role broadcast): no DM to Kyle or Jordan", dms(S.kyle, s0).length === 0 && dms(S.jordan, s0).length === 0);
  }

  // =========================================================================
  c.head("1 · JAMES GETS 'VIDEO IN REVIEW' ON SLACK BECAUSE HE HOLDS THE FIRST SEAT");
  {
    setClock(edt(10, 6, 10, 0)); // Tue 10:00 ET
    const jp = await prisma.appSetting.count({ where: { key: `notify-prefs:${james.id}` } });
    const jPrefs = await prefs.notifyPrefsFor(james.id);
    const hPrefs = await prefs.notifyPrefsFor(harrison.id);
    c.ok("James has NO saved matrix — this is the default talking", jp === 0);
    c.ok("James (PHOTOGRAPHER on the roster, first review seat, Slack ID on file): 'Video in review' = Slack, no text", jPrefs.review_ready.slack && !jPrefs.review_ready.sms, JSON.stringify(jPrefs.review_ready));
    c.ok("Harrison (PHOTOGRAPHER, no seat): 'Video in review' stays off", !hPrefs.review_ready.slack && !hPrefs.review_ready.sms);
    const rows = await prefs.teamNotifyRows();
    const jr = rows.find((r) => r.teamMemberId === james.id)!;
    const hr = rows.find((r) => r.teamMemberId === harrison.id)!;
    c.ok("Settings: James's row is marked as a review seat; 'Role defaults' gives him the same Slack switch", jr.reviewSeat === true && defaults.defaultPrefsForRow(jr).review_ready.slack && jr.prefs.review_ready.slack);
    c.ok("Settings: Harrison's row is not a seat and his reset stays off", !hr.reviewSeat && !defaults.defaultPrefsForRow(hr).review_ready.slack);
    c.ok("a seat with NO Slack ID gets no switch the bridge could only log as skipped", !defaults.defaultPrefsFor("PHOTOGRAPHER", false, { reviewSeat: true, hasSlack: false }).review_ready.slack);
    const job = await mkJob("12 Owner St", { status: "REVIEW", photographerId: harrison.id });
    const cut = await mkCut(job);
    const s0 = slack.length;
    const jamesSms0 = (await pendingFor(james.id)).length;
    await announce(job, cut);
    const sub = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut }, select: { reviewerTeamMemberId: true } });
    c.ok("the cut is James's", sub.reviewerTeamMemberId === james.id);
    c.ok("James gets ONE Slack DM — 'Waiting on you' — at once", dms(S.james, s0).length === 1 && /Waiting on you — 12 Owner St/.test(dms(S.james, s0)[0].text), dms(S.james, s0).map((m) => m.text).join(" | "));
    c.ok("…and no text (the seat default is Slack only)", (await pendingFor(james.id)).length === jamesSms0);
    c.ok("Kyle (backup) still gets his FYI DM", dms(S.kyle, s0).length === 1 && /James reviews it first/.test(dms(S.kyle, s0)[0].text), dms(S.kyle, s0).map((m) => m.text).join(" | "));
    c.ok("Jordan (fallback) still gets his oversight DM", dms(S.jordan, s0).length === 1);
    c.ok("Harrison (the shooter) hears it in the bell only — his switch is off", dms(S.harrison, s0).length === 0 && (await prisma.notification.count({ where: { userKey: `tm:${harrison.id}`, kind: "cut_ready" } })) === 1);
  }

  // =========================================================================
  c.head("3 · THE COVER OFFER REACHES KYLE ON SLACK, ONCE");
  {
    const job = await mkJob("40 Waiting Way", { status: "REVIEW" });
    const cut = await mkCut(job, { reviewerTeamMemberId: james.id, reviewerRole: "PRIMARY", reviewerAssignedAt: edt(10, 5, 9, 0), createdAt: edt(10, 5, 9, 0) });
    const s0 = slack.length;
    const r = await ra.reviewCoverSweep({ now: new Date() }); // Tue 10:00 — 10 covered hours since Mon 09:00
    c.ok("the sweep offers the cut to the backup", r.offered >= 1, JSON.stringify(r));
    const kd = dms(S.kyle, s0);
    c.ok("Kyle gets ONE Slack DM: whose it was, how long, what to do", kd.length === 1 && /James hasn't got to 40 Waiting Way/.test(kd[0].text) && /covered hours/.test(kd[0].text) && /send it back yourself/.test(kd[0].text), kd.map((m) => m.text).join(" | "));
    c.ok("…the cut did NOT move (an offer moves nothing)", (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut }, select: { reviewerTeamMemberId: true } })).reviewerTeamMemberId === james.id);
    await ra.reviewCoverSweep({ now: new Date() });
    c.ok("a second sweep sends nothing more", dms(S.kyle, s0).length === 1);
  }

  // =========================================================================
  c.head("2 · A PAID PROGRAM SIGNUP, AND THE DESK TASKS THAT FOLLOW, PING KYLE");
  {
    const price = Object.entries(STRIPE_PROGRAM_PRICES).find(([, v]) => v.package === "Accelerator" && v.billingType === "MONTH_TO_MONTH")!;
    const session = {
      id: "cs_test_drillOct5Signup01", object: "checkout.session", status: "complete", payment_status: "paid", mode: "subscription",
      amount_total: price[1].amountCents ?? 159900, created: Math.floor(Date.now() / 1000) - 60, subscription: null, customer: null,
      customer_details: { email: "paula.prospect@example.com", name: "Paula Prospect", phone: null },
      line_items: { data: [{ description: price[1].productName, price: { id: price[0], product: price[1].productId } }] },
    };
    const s0 = slack.length;
    const out = await ss.processCheckoutSession(JSON.parse(JSON.stringify(session)), "webhook");
    c.ok("the checkout activates", out === "activated", String(out));
    const kd = dms(S.kyle, s0);
    c.ok("Kyle gets the signup on Slack (the ops line — his DM, as production has it)", kd.some((m) => /New Content Program signup — Paula Prospect \(Video Accelerator\)/.test(m.text)), kd.map((m) => m.text).join(" | "));
    c.ok("…with no money and no billing term in it", kd.every((m) => !/\$|\d{3,},?\d*\.\d\d|month-to-month|pay in full/i.test(m.text)), kd.map((m) => m.text).join(" | "));
    const task = await prisma.smartTask.findFirst({ where: { title: { contains: "Book the brand discovery call — Paula Prospect" } }, select: { id: true, dueAt: true, priority: true, assignedKey: true } });
    c.ok("the discovery-call task is due TODAY (5:00 PM ET), not in two days", task?.dueAt?.toISOString() === edt(10, 6, 17, 0).toISOString(), task?.dueAt?.toISOString());
    c.ok("…and it pinged Kyle by name on Slack, with the due time in ET", kd.some((m) => /New on your list: Book the brand discovery call — Paula Prospect · due .*5:00 PM ET/.test(m.text) && m.text.includes(`task=${task?.id}`)), kd.map((m) => m.text).join(" | "));
    c.ok("two lines for one signup, no more", kd.length === 2, String(kd.length));
    const s1 = slack.length;
    const again = await ss.processCheckoutSession(JSON.parse(JSON.stringify(session)), "webhook");
    c.ok("the same checkout again: nothing re-sent", again === "known" && dms(S.kyle, s1).length === 0, String(again));

    // The URGENT "scripts not approved 24h before filming" task — the shape
    // reconcileScriptApprovalTasks raises — was silent.
    const paula = await prisma.client.findFirstOrThrow({ where: { name: "Paula Prospect" }, select: { id: true } });
    const s2 = slack.length;
    await desk.openProgramDeskTask({
      dedupeKey: "program-scripts-unapproved:drill-month:session-1", clientId: paula.id, clientName: "Paula Prospect",
      title: "Scripts not approved before filming — Paula Prospect · Wednesday, October 7, 10:00 AM",
      lines: ["Filming is tomorrow. We film either way; nothing is cancelled or moved."], assignedKey: "kyle",
      reasonCreated: "Scripts not approved 24 hours before filming (6.5)", reopenIfClosed: false, dueAt: edt(10, 7, 10, 0), priority: "URGENT",
    });
    const u = dms(S.kyle, s2);
    c.ok("an URGENT desk task pings Kyle at once, marked URGENT", u.length === 1 && /New on your list \(URGENT\): Scripts not approved before filming/.test(u[0].text), u.map((m) => m.text).join(" | "));
    await desk.openProgramDeskTask({
      dedupeKey: "program-scripts-unapproved:drill-month:session-1", clientId: paula.id, clientName: "Paula Prospect",
      title: "Scripts not approved before filming — Paula Prospect · Wednesday, October 7, 10:00 AM",
      lines: ["Filming is tomorrow. One script now approved."], assignedKey: "kyle",
      reasonCreated: "Scripts not approved 24 hours before filming (6.5)", reopenIfClosed: false, dueAt: edt(10, 7, 10, 0), priority: "URGENT",
    });
    c.ok("…rewriting the same open task pings nothing", dms(S.kyle, s2).length === 1);
    const s3 = slack.length;
    await desk.openProgramDeskTask({ dedupeKey: "drill-medium-1", clientId: paula.id, clientName: "Paula Prospect", title: "A MEDIUM housekeeping task", lines: ["x"], assignedKey: "kyle", reasonCreated: "drill", reopenIfClosed: false, priority: "MEDIUM" });
    c.ok("a MEDIUM desk task pings nobody", dms(S.kyle, s3).length === 0);
    process.env.PROGRAM_DESK_TASKS_FOR_TEST = "1";
    await desk.openProgramDeskTask({ dedupeKey: "drill-test-client-1", clientId: paula.id, clientName: "Bobby Test", title: "Book the brand discovery call — Bobby Test", lines: ["x"], assignedKey: "kyle", reasonCreated: "drill", reopenIfClosed: true, priority: "HIGH" });
    delete process.env.PROGRAM_DESK_TASKS_FOR_TEST;
    c.ok("a TEST client's task (even when a probe forces it) pings nobody", dms(S.kyle, s3).length === 0 && (await prisma.smartTask.count({ where: { dedupeKey: "drill-test-client-1" } })) === 1);
    const s4 = slack.length;
    await desk.openProgramDeskTask({ dedupeKey: "program-draft-failed:drill", clientId: paula.id, clientName: "Paula Prospect", title: "Script draft keeps failing — Paula Prospect · “Market update”", lines: ["x"], assignedKey: "jordan", reasonCreated: "drill", reopenIfClosed: true });
    c.ok("a HIGH task on JORDAN's list pings Jordan, not Kyle", dms(S.jordan, s4).length === 1 && dms(S.kyle, s4).length === 0 && /Script draft keeps failing/.test(dms(S.jordan, s4)[0]?.text ?? ""));
    await prisma.smartTask.updateMany({ where: { dedupeKey: "program-draft-failed:drill" }, data: { status: "COMPLETED", completedAt: new Date() } });
    await desk.openProgramDeskTask({ dedupeKey: "program-draft-failed:drill", clientId: paula.id, clientName: "Paula Prospect", title: "Script draft keeps failing — Paula Prospect · “Market update”", lines: ["x"], assignedKey: "jordan", reasonCreated: "drill", reopenIfClosed: true });
    c.ok("…a reopened one is back on the list and says so", dms(S.jordan, s4).length === 2 && /Back on your list/.test(dms(S.jordan, s4)[1]?.text ?? ""), dms(S.jordan, s4).map((m) => m.text).join(" | "));
  }

  // =========================================================================
  c.head("7 · LUMA VISUALS: KYLE HEARS IT BY NAME, ON SLACK");
  {
    const job = await mkJob("50 Agency Ave", { status: "EDITING" });
    await prisma.smartTask.create({ data: { title: "Edit the video — 50 Agency Ave", taskType: "edit_video", status: "OPEN", projectId: job.id, assignedKey: "john", source: "system" } });
    const s0 = slack.length;
    viewer = as(uJordan, jordan, "OWNER");
    const r = await editing.setEditVideoEditor(job.id, "external_agency");
    c.ok("Jordan hands the job to Luma Visuals", r.ok, r.message);
    const kd = dms(S.kyle, s0);
    c.ok("Kyle gets ONE Slack DM: hand it to Luma Visuals, with the job link", kd.length === 1 && /Hand to Luma Visuals — 50 Agency Ave/.test(kd[0].text) && kd[0].text.includes(`/edit/${job.id}`), kd.map((m) => m.text).join(" | "));
    const job2 = await mkJob("51 Agency Ave", { status: "EDITING" });
    await prisma.smartTask.create({ data: { title: "Edit the video — 51 Agency Ave", taskType: "edit_video", status: "OPEN", projectId: job2.id, assignedKey: "john", source: "system" } });
    const s1 = slack.length;
    viewer = as(uKyle, kyle, "ADMIN");
    const r2 = await editing.setEditVideoEditor(job2.id, "external_agency");
    c.ok("Kyle doing it himself: no DM about his own click (the ADMIN bell still stands)", r2.ok && dms(S.kyle, s1).length === 0 && (await prisma.notification.count({ where: { title: { contains: "Dispatch to Luma Visuals — 51 Agency Ave" } } })) === 1, r2.message);
    viewer = null;

    const ready = { ready: true, blockedReason: null } as unknown as NonNullable<Parameters<typeof tasks.notifyRawsLanded>[1]>["readiness"];
    const lumaJob = await mkJob("52 Agency Ave", { status: "SHOT", editorManual: true, editorVendorKey: "external_agency" });
    const s2 = slack.length;
    await tasks.notifyRawsLanded(lumaJob.id, { readiness: ready, videoFound: true });
    const kd2 = dms(S.kyle, s2);
    c.ok("ready for editing on a Luma job: Kyle by name — 'this one goes to Luma Visuals'", kd2.some((m) => /Ready for editing — 52 Agency Ave: this one goes to Luma Visuals — send them the packet/.test(m.text)), kd2.map((m) => m.text).join(" | "));
    const line = await prisma.activity.findFirst({ where: { projectId: lumaJob.id, body: { startsWith: "Raws in for 52 Agency Ave" } }, select: { body: true } });
    c.ok("…and the job's timeline says Kyle was pinged by Slack DM", /Kyle pinged by Slack DM/.test(line?.body ?? ""), line?.body);
    const nobody = await mkJob("53 Branding Blvd", { status: "SHOT", editorManual: true });
    const s3 = slack.length;
    await tasks.notifyRawsLanded(nobody.id, { readiness: ready, videoFound: true });
    c.ok("ready for editing with no editor picked: Kyle told to pick one", dms(S.kyle, s3).some((m) => /Ready for editing — 53 Branding Blvd: no editor is assigned/.test(m.text)), dms(S.kyle, s3).map((m) => m.text).join(" | "));
  }

  // =========================================================================
  c.head("5 · MANILA: AN EDITOR'S DM WAITS FOR 7 AM THEIR TIME");
  {
    setClock(edt(10, 6, 15, 0)); // Tue 15:00 ET = Wed 03:00 Manila
    c.ok("localNightEnd: Wed 03:00 Manila → Wed 07:00 Manila (Tue 19:00 ET)", notify.localNightEnd("Asia/Manila")?.toISOString() === edt(10, 6, 19, 0).toISOString(), notify.localNightEnd("Asia/Manila")?.toISOString());
    c.ok("localNightEnd: Manila daytime → nothing to hold", notify.localNightEnd("Asia/Manila", edt(10, 6, 20, 0)) === null);
    c.ok("localNightEnd: 23:30 Manila → the NEXT 07:00 there", notify.localNightEnd("Asia/Manila", edt(10, 6, 11, 30))?.toISOString() === edt(10, 6, 19, 0).toISOString());
    const job = await mkJob("60 Night Shift Rd", { status: "EDITING", editorId: kim.id, photographerId: harrison.id });
    const s0 = slack.length;
    await post(job.id, harrison, "Drone shots re-uploaded, the first set was blurry");
    c.ok("a photographer's post at Wed 03:00 Manila: NO DM to Kim now", dms(S.kim, s0).length === 0);
    const kh = await heldFor(kim.id);
    c.ok("…it is HELD for her, until Wed 07:00 Manila", kh.length === 1 && kh[0].until === edt(10, 6, 19, 0).toISOString() && /Drone shots/.test(kh[0].text), JSON.stringify(kh.map((h) => h.until)));
    const cut = await mkCut(job, { submittedByKey: "john", submittedByName: "John Mark" });
    await notifySelfCheckNeeded(cut, "Dropped straight into Final.");
    c.ok("John Mark's self-check ping at 03:00 Manila: held too, no DM now", dms(S.john, s0).length === 0 && (await heldFor(john.id)).length === 1);
    const s1 = slack.length;
    await notify.opsAlert("🔔 Raws in for 60 Night Shift Rd — files received");
    c.ok("meanwhile Kyle's ops line at 15:00 ET (his working day) goes at once", dms(S.kyle, s1).length === 1);
    setClock(edt(10, 6, 18, 59));
    await notify.flushPendingSms();
    c.ok("18:59 ET (06:59 Manila): still nothing", dms(S.kim, s0).length === 0 && dms(S.john, s0).length === 0);
    setClock(edt(10, 6, 19, 1));
    await notify.flushPendingSms();
    await notify.flushPendingSms();
    c.ok("19:01 ET (07:01 Manila): Kim gets it, ONCE", dms(S.kim, s0).length === 1 && /Drone shots/.test(dms(S.kim, s0)[0].text));
    c.ok("…and John Mark gets his, ONCE", dms(S.john, s0).length === 1 && /Check needed before review — 60 Night Shift Rd/.test(dms(S.john, s0)[0].text));
    const s2 = slack.length;
    setClock(edt(10, 6, 20, 0)); // Wed 08:00 Manila
    await post(job.id, harrison, "Second twilight set is up too");
    c.ok("Wed 08:00 Manila: the next post is a DM at once", dms(S.kim, s2).length === 1);
  }

  // =========================================================================
  c.head("6 · THE OPS CHANNEL KEEPS KYLE'S NIGHT (it is his DM today)");
  {
    // Kyle's own schedule: quiet Wednesday until 8 AM (his choice on Settings).
    await sched.saveSchedule(kyle.id, [{ day: 3, from: 0, to: 8 * 60 }], "drill");
    setClock(edt(10, 6, 23, 30)); // Tue 23:30 ET
    const s0 = slack.length;
    c.ok("the ops destination is Kyle's DM (no SLACK_ALERT_CHANNEL, no ops channel)", (await notify.alertDestination()) === S.kyle);
    const ok = await notify.opsAlert("🟥 Cron \"topaz\" degraded: drill");
    c.ok("23:30: an ops relay is KEPT (true), not DMed", ok && dms(S.kyle, s0).length === 0);
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: kyle.id } });
    const page = await notify.notifyStaffSms([jordan.id], "Client still unanswered (VIP) — Ann Lee, 2h", "reply_sla", { urgency: "urgent" });
    c.ok("23:31: the urgent page goes to the on-call (Kyle) and is held", page.length === 1 && page[0].teamMemberId === kyle.id && page[0].outcome === "held", JSON.stringify(page));
    c.ok("…and the 'Urgent page held' notice does NOT DM Kyle at 11:30 PM — not now, not later (the page itself says it)", dms(S.kyle, s0).length === 0 && !(await heldFor(kyle.id)).some((h) => /Urgent page held/.test(h.text)));
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: jordan.id } });
    const page2 = await notify.notifyStaffSms([kyle.id], "Client still unanswered (VIP) — Bo Diaz, 2h", "reply_sla", { urgency: "urgent" });
    c.ok("on-call Jordan's page is held to 7 AM", page2[0]?.teamMemberId === jordan.id && page2[0]?.outcome === "held", JSON.stringify(page2));
    const kh = await heldFor(kyle.id);
    c.ok("…the notice that it is waiting is KEPT for Kyle's morning, not sent at 23:31", dms(S.kyle, s0).length === 0 && kh.some((h) => /Urgent page held \(quiet hours\) — Jordan Spackman gets it Wed, Oct 7, 7:00 AM ET/.test(h.text)), kh.map((h) => h.text).join(" | "));
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });
    // Kyle's own pings at night: a Luma ready notice and an URGENT desk task.
    const ping = await notify.pingKyle("📦 Ready for editing — 70 Late Ln: it's Luma Visuals' job", "luma_dispatch");
    c.ok("a Luma ping at 23:3x: held, not sent", Array.isArray(ping) && ping[0]?.outcome === "held", JSON.stringify(ping));
    const paula = await prisma.client.findFirstOrThrow({ where: { name: "Paula Prospect" }, select: { id: true } });
    await desk.openProgramDeskTask({ dedupeKey: "program-scripts-unapproved:drill-month:session-2", clientId: paula.id, clientName: "Paula Prospect", title: "Scripts not approved before filming — Paula Prospect · Wednesday, October 7, 11:00 PM", lines: ["x"], assignedKey: "kyle", reasonCreated: "drill", reopenIfClosed: false, dueAt: edt(10, 7, 23, 0), priority: "URGENT" });
    c.ok("an URGENT desk task at 23:3x: held, not sent", dms(S.kyle, s0).length === 0 && (await heldFor(kyle.id)).length >= 5, String((await heldFor(kyle.id)).length));
    const wake = (await heldFor(kyle.id)).map((h) => h.until);
    c.ok("…everything for Kyle is dated to the END of his quiet time: Wed 08:00 (his own window runs past 7 AM)", wake.every((u) => u === edt(10, 7, 8, 0).toISOString()), wake.join(", "));
    setClock(edt(10, 7, 6, 55));
    await notify.flushPendingSms();
    c.ok("06:55: nothing for anyone", dms(S.kyle, s0).length === 0 && dms(S.jordan, s0).length === 0);
    setClock(edt(10, 7, 7, 1));
    await notify.flushPendingSms();
    c.ok("07:01: Jordan's held page reaches him, once", dms(S.jordan, s0).length === 1 && /Bo Diaz/.test(dms(S.jordan, s0)[0].text));
    c.ok("…Kyle is still inside HIS window (until 8:00): nothing yet", dms(S.kyle, s0).length === 0);
    setClock(edt(10, 7, 8, 1));
    await notify.flushPendingSms();
    await notify.flushPendingSms();
    const kd = dms(S.kyle, s0);
    c.ok("08:01: Kyle gets ONE DM carrying all of it, oldest first", kd.length === 1 && /Held during your quiet time — \d+ notices/.test(kd[0].text) && /Cron "topaz" degraded/.test(kd[0].text) && /Ann Lee/.test(kd[0].text) && /Jordan Spackman gets it/.test(kd[0].text) && /70 Late Ln/.test(kd[0].text) && /Scripts not approved before filming/.test(kd[0].text), kd[0]?.text.slice(0, 400));
    c.ok("…nothing waiting any more", (await heldFor(kyle.id)).length === 0);

    // SLACK_ALERT_CHANNEL: a real channel gets every line at once, night or day.
    setClock(edt(10, 7, 23, 0));
    process.env.SLACK_ALERT_CHANNEL = "C0OPSALRT1";
    const s1 = slack.length;
    await notify.opsAlert("⚠️ drill: webhooks bouncing");
    c.ok("SLACK_ALERT_CHANNEL set: 23:00 line posts to #ops-alerts at once (a channel is not a page)", dms("C0OPSALRT1", s1).length === 1 && dms(S.kyle, s1).length === 0);
    process.env.SLACK_ALERT_CHANNEL = " #ops-alerts ";
    refuse.add("#ops-alerts");
    const s2 = slack.length;
    const kept = await notify.opsAlert("⚠️ drill: the bot is not in the channel yet");
    c.ok("a channel that refuses (bot not invited): falls back to Kyle's DM — kept for his morning at 23:00", kept && dms(S.kyle, s2).length === 0 && (await heldFor(kyle.id)).some((h) => /not in the channel yet/.test(h.text)));
    setClock(edt(10, 8, 12, 0));
    await notify.flushPendingSms();
    const s3 = slack.length;
    await notify.opsAlert("⚠️ drill: still not invited, midday");
    c.ok("…and in the day it reaches Kyle's DM at once", dms(S.kyle, s3).length === 1 && /midday/.test(dms(S.kyle, s3)[0].text));
    delete process.env.SLACK_ALERT_CHANNEL;
  }

  // =========================================================================
  c.head("8b · AN EXPLICIT SAVED PREFERENCE STILL WINS — and 1b · JAMES'S OWN QUIET TIME");
  {
    setClock(edt(10, 8, 12, 10)); // Thu 12:10 ET
    await putSetting(`notify-prefs:${james.id}`, { ...allOff, mention: { slack: false, sms: true }, shoot_change: { slack: false, sms: true } });
    await putSetting(`notify-prefs:${harrison.id}`, { ...allOff, mention: { slack: false, sms: true }, shoot_change: { slack: false, sms: true } });
    c.ok("James saved 'Video in review' OFF: the seat default no longer applies", !(await prefs.notifyPrefsFor(james.id)).review_ready.slack);
    const job = await mkJob("80 Choice Ct", { status: "REVIEW", photographerId: harrison.id });
    const cut = await mkCut(job);
    const s0 = slack.length;
    await announce(job, cut);
    c.ok("…a new cut: James gets the bell and no DM", dms(S.james, s0).length === 0 && (await prisma.notification.count({ where: { userKey: `tm:${james.id}`, dedupeKey: { startsWith: `cut-in-review-${cut}-` } } })) === 1);
    const t0 = texts.length;
    const q0 = (await pendingFor(harrison.id)).length;
    await post(job.id, kyle, "Client loved the drone opener");
    c.ok("Harrison saved 'Job messages' OFF: no text for a post on his job", textsTo("6105550144", t0).length === 0 && (await pendingFor(harrison.id)).length === q0);

    // Back to the default, and a quiet hour of his own: the seat DM waits for it.
    await putSetting(`notify-prefs:${james.id}`, {});
    await sched.saveSchedule(james.id, [{ day: 4, from: 12 * 60, to: 13 * 60 }], "drill"); // Thursday 12–1 PM
    setClock(edt(10, 8, 12, 30));
    const cut2 = await mkCut(job);
    const s1 = slack.length;
    await announce(job, cut2);
    c.ok("James quiet Thursday 12–1: the cut DM is held, not sent at 12:30", dms(S.james, s1).length === 0 && (await heldFor(james.id)).length === 1 && (await heldFor(james.id))[0].until === edt(10, 8, 13, 0).toISOString());
    setClock(edt(10, 8, 13, 1));
    await notify.flushPendingSms();
    c.ok("13:01: it reaches him, once", dms(S.james, s1).length === 1 && /Waiting on you — 80 Choice Ct/.test(dms(S.james, s1)[0].text));
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
