// ---------------------------------------------------------------------------
// DRILL: B5 — THE NOTIFICATION SCHEDULE, AND THE PAGES AND DIGESTS AROUND IT
// (unified handoff batch 5: Jordan's Sep 26 notification schedule; items
// 9-oncall-urgent-page-held-overnight, 9-inert-alert-switches,
// 9-digest-reports-sent-on-failure; and "the three review seats always hear
// about cuts, even when away").
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b5-notify-schedule.ts
//
// What it drives, through the SHIPPED code (the real bell bridge, the real
// staff text queue and its 5-minute flusher, the real outbox, the real digests,
// the real settings actions under AUTH_ENFORCE with getCurrentUser stubbed):
//
//   0  THE OLD CODE, loaded from git at 17df024: Jordan's Saturday 10:00 tag
//      buzzes his phone twice at once; an on-call urgent page at 23:30 is a
//      Slack DM at 23:30; a refused 4 o'clock DM reports sent and keeps the
//      day; an away review seat is left off the cut FYI.
//   1  The schedule itself: Jordan's preset, the summary sentence, pure hold
//      arithmetic across DST and chained windows — and (Oct 6 2026) NO
//      overnight rule: with no windows of your own, 2 AM is not held.
//   2  Saturday 10:00: Jordan's bell at once, his texts and DMs held to 19:30;
//      Kyle and James pinged at once. 19:25 nothing; 19:31 ONE text and ONE
//      DM carrying everything, in order; 19:40 nothing more.
//   3  Sunday and a weekday: Jordan notified at once; someone with no schedule
//      is notified at once on a Sunday too (Oct 6 2026 — the old code dated
//      their routine text to Monday 9 AM; that weekend hold is gone).
//   4  The away seat still hears about the cut.
//   5  The switches do what they say: raw video missing off → the task, no
//      bell; Kyle's digests off → nothing claimed, nothing sent.
//   6  The urgent on-call page (Oct 6 2026, Jordan: "Anyone on the team can
//      get pinged anytime. Just not Jordan on Saturday until 7:30PM."): 23:30
//      is a Slack DM at 23:30, a phone-only on-call is texted at 23:45, no
//      "held" line on the ops channel; Saturday 10:00 unchanged; Jordan on
//      call on his Saturday waits for 19:30 and the ops channel is told.
//   7  A digest that failed never reports sent: claim released, a failed
//      delivery row, the next tick sends once; Kyle's own quiet time holds it.
//   8  The Settings actions: who may save whose schedule, a stale tab refused,
//      every save audited.
//   9  A held DM goes once: a refused release is retried, two ticks racing
//      send one DM, a dead worker's claim is taken back after 15 minutes.
//   9b (review, Sep 26) A retry that finds no log lines holds no second copy
//      (the held row is the record); a delete that fails after Slack took the
//      DM settles the row instead of re-sending it when the lease runs out.
//   10 (review) The senders that never went through the bridge: the real
//      evening cron at Sat 19:00 — the OLD code texts Jordan's own Saturday
//      shoot and DMs Kyle's coaching note inside their windows; now both wait
//      (19:31 one text, 21:01 one DM). The 10 PM chaser and the late split
//      notice for somebody quiet 9 PM–midnight wait too, and go once at 00:05
//      when HIS window ends (Oct 6 2026: no 7 AM texting rule behind it).
//   11 (review) A held editor ping is reported "quiet", never "slack"; with
//      no saved schedule a Manila editor at midnight their time is DMed at
//      once (Oct 6 2026: "Editors can get night time pings").
//
// ISOLATION: PGlite on 127.0.0.1:5781 (the harness); production is never
// opened; every non-loopback call is fenced; Slack answered by a fake and
// counted; OpenPhone's two calls replaced in-process and counted.
// THE CLOCK IS PINNED and moved explicitly, FORWARD only (the settings and
// roster caches compare against Date.now(), so a clock that ran backwards
// could read a cache entry from its own future as fresh): Saturday Sep 19 2026
// for the old code, then Saturday Sep 26 10:00 EDT and on — never the real time.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5781);
const BASE = "17df024"; // the tree batch 5 starts from — never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
let offset = RealDate.UTC(2026, 8, 26, 14, 0, 0) - RealDate.now(); // Sat Sep 26 2026 10:00 EDT
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
const setClock = (d: Date) => { offset = d.getTime() - RealDate.now(); };
/** Sep/Oct 2026 wall clock in EDT (UTC-4). */
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));

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
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const refuse = new Set<string>(); // channels Slack refuses
const OPS = "C-OPS";
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string; users?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    const channel = body.channel ?? "?";
    if (refuse.has(channel)) return json({ ok: false, error: "channel_not_found" });
    slack.push({ channel, text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: `drill: ${method}` });
});

/** 17df024's copy of a file, its `@/` imports aimed at this tree. `patch`
 *  adapts a line that reaches for something this tree no longer exports. */
function baseCopy(dir: string, name: string, file: string, patch: (src: string) => string = (x) => x): string {
  const src = patch(execFileSync("git", ["show", `${BASE}:${file}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const pointed = src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = path.join(dir, name);
  fs.writeFileSync(out, pointed);
  return out;
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", SLACK_ALERT_CHANNEL: OPS } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const notify = await import("@/lib/notify");
  const sched = await import("@/lib/notifySchedule");
  const defaults = await import("@/lib/notifyPrefDefaults");
  const ra = await import("@/lib/reviewerAssignment");
  const { afternoonSlackDigest } = await import("@/lib/commsBoard");
  const { ensureEditorHandoff } = await import("@/lib/tasks");
  const settingsActions = await import("@/app/settings/actions");

  // OpenPhone: the number lookup and the send, answered in-process.
  const op = await import("@/lib/integrations/openphone");
  const OFFICE = "+16105550100";
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
  const texts: { to: string; body: string; at: Date }[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
    texts.push({ to: String(to), body, at: new Date() });
    return { data: { id: `op-${texts.length}` } };
  };

  // Slack "connected" so the real client takes its normal path (assembled at
  // run time: a token-shaped literal trips secret scanners even when fake).
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

  // ---- the cast, as production has it ---------------------------------------
  type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
  const member = (name: string, email: string, role: TeamRole, phone: string | null, slackId: string | null, extra: Record<string, unknown> = {}) =>
    prisma.teamMember.create({ data: { name, email, role, phone, slackId, active: true, ...extra }, select: { id: true, name: true } });
  const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111", "U-JORDAN");
  // Kyle's roster phone IS the office line in production — texts to him are
  // refused by design, so Slack is his channel.
  const kyle = await member("Kyle Cabrera", "kyle@drill.invalid", "MANAGER", OFFICE, "U-KYLE");
  const james = await member("James Rivera", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", "U-JAMES");
  const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER", "(610) 555-0144", null);
  const dana = await member("Dana Quill", "dana@drill.invalid", "MANAGER", "(610) 555-0155", null); // phone-only
  const login = (email: string, role: string, tm: string) =>
    prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm }, select: { id: true } });
  const uJordan = await login("jordan@drill.invalid", "OWNER", jordan.id);
  const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
  const uJames = await login("james@drill.invalid", "ADMIN", james.id);
  const uHarrison = await login("harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
  // Saved matrices as production has them (Sep 21 reads): Jordan Slack + text,
  // Kyle Slack. James and Harrison: their shipped photographer default
  // (tags by text). Harrison's "video in review" text is switched on here so
  // section 3 can show the old weekend rule held it and the new code does not.
  const allOff = { mention: { slack: false, sms: false }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: false, sms: false }, shoot_change: { slack: false, sms: false } };
  await putSetting(`notify-prefs:${jordan.id}`, { ...allOff, mention: { slack: true, sms: true }, review_ready: { slack: true, sms: true }, shoot_change: { slack: true, sms: true } });
  await putSetting(`notify-prefs:${kyle.id}`, { ...allOff, mention: { slack: true, sms: false }, review_ready: { slack: true, sms: false }, shoot_change: { slack: true, sms: false } });
  await putSetting(`notify-prefs:${harrison.id}`, { ...allOff, mention: { slack: false, sms: true }, review_ready: { slack: false, sms: true }, shoot_change: { slack: false, sms: true } });

  const as = (u: { id: string }, tm: { id: string; name: string }, role: string): Viewer => ({
    id: u.id, email: `${tm.name.split(" ")[0].toLowerCase()}@drill.invalid`, name: tm.name, role, permissions: null, status: "ACTIVE",
    teamMemberId: tm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: tm.name,
  });
  const V = { jordan: as(uJordan, jordan, "OWNER"), kyle: as(uKyle, kyle, "ADMIN"), james: as(uJames, james, "ADMIN"), harrison: as(uHarrison, harrison, "PHOTOGRAPHER") };

  const dmsTo = (tm: { name: string }, since = 0) => slack.slice(since).filter((m) => m.channel === `U-${tm.name.split(" ")[0].toUpperCase()}`);
  const opsLines = (since = 0) => slack.slice(since).filter((m) => m.channel === OPS);
  const textsTo = (phoneDigits: string, since = 0) => texts.slice(since).filter((t) => t.to.replace(/\D/g, "").endsWith(phoneDigits));
  const JORDAN_PH = "6105550111";
  const JAMES_PH = "6105550133";
  const DANA_PH = "6105550155";
  const HARRISON_PH = "6105550144";
  const heldDmRows = () => prisma.appSetting.findMany({ where: { key: { startsWith: sched.HELD_DM_PREFIX } } });
  const pending = (tm: { id: string }) => prisma.pendingSms.findMany({ where: { teamMemberId: tm.id, sentAt: null, skippedAt: null }, orderBy: { createdAt: "asc" } });
  const resetQueues = async () => {
    await prisma.pendingSms.deleteMany({});
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: sched.HELD_DM_PREFIX } } });
  };
  const tag = (to: { id: string; name: string }, words: string, key: string) =>
    notify.notifyInApp({
      kind: "mention",
      title: `Jordan tagged you — ${words}`,
      href: "/projects/drill",
      targets: [{ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${to.id}`, slackDm: `💬 Kyle tagged you on ${words}:\n> can you look at this\nhttps://drill.invalid/projects/drill` }],
      dedupeKey: key,
    });
  const cutReady = (street: string, key: string) =>
    notify.notifyInApp({
      kind: "cut_ready",
      title: `Cut ready to review — ${street}`,
      href: "/review/drill",
      targets: [{ roles: ["OWNER", "ADMIN"], ownerSms: `Video in review — ${street} (John, v1). https://drill.invalid/review/drill` }],
      dedupeKey: key,
    });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "b5-notify-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(tmp, "node_modules"));
  const old = {
    notify: (await import(baseCopy(tmp, "notify.base.ts", "src/lib/notify.ts"))) as typeof notify,
    reviewer: (await import(baseCopy(tmp, "reviewerAssignment.base.ts", "src/lib/reviewerAssignment.ts"))) as typeof ra,
    commsBoard: (await import(baseCopy(tmp, "commsBoard.base.ts", "src/lib/commsBoard.ts"))) as { afternoonSlackDigest: typeof afternoonSlackDigest },
  };

  // =========================================================================
  c.head(`0 · THE OLD CODE (${BASE}): no quiet time, pages at 23:30, a refused digest reports sent, away seats dropped`);
  {
    setClock(edt(9, 19, 10)); // Sat Sep 19 10:00 — the same shape of day, a week earlier
    const s0 = slack.length, t0 = texts.length;
    await old.notify.notifyInApp({
      kind: "mention", title: "Jordan tagged you — old code", href: "/projects/drill",
      targets: [{ roles: ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"], userKey: `tm:${jordan.id}`, slackDm: "💬 Kyle tagged you on 1 Old Rd:\n> can you look at this\nhttps://drill.invalid/x" }],
      dedupeKey: "b5-old-tag",
    });
    c.ok("old: Jordan's Saturday 10:00 tag is a Slack DM at 10:00", dmsTo(jordan, s0).length === 1, `${dmsTo(jordan, s0).length} DM(s)`);
    c.ok("old: …and a text at 10:00 — his phone buzzes twice inside what is now his quiet time", textsTo(JORDAN_PH, t0).length === 1, `${textsTo(JORDAN_PH, t0).length} text(s)`);

    setClock(edt(9, 21, 16, 30)); // Mon 16:30
    refuse.add("U-KYLE");
    const s2 = slack.length;
    const d = await old.commsBoard.afternoonSlackDigest();
    const claim = await prisma.appSetting.findUnique({ where: { key: "kyle-digest-2026-09-21" } });
    c.ok("old: Slack refuses the 4 o'clock DM and the digest still answers sent: true", d.sent === true && dmsTo(kyle, s2).length === 0, JSON.stringify(d));
    c.ok("old: …the day's claim is kept, so no later tick ever retries", !!claim);
    c.ok("old: …and no delivery row says it failed", (await prisma.notificationDelivery.count({ where: { teamMemberId: kyle.id, channel: "slack", status: "failed" } })) === 0);
    refuse.delete("U-KYLE");

    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: kyle.id } });
    setClock(edt(9, 22, 23, 30)); // Tue 23:30
    const s1 = slack.length;
    const r = await old.notify.notifyStaffSms([jordan.id], "Client still unanswered — old code", "reply_sla", { urgency: "urgent" });
    c.ok("old: an urgent page at 23:30 goes to the on-call (Kyle) as a Slack DM at 23:30", dmsTo(kyle, s1).length === 1 && r[0]?.outcome === "slack", JSON.stringify(r));

    await putSetting("review_room", { discoverFromDropbox: false, keepUploadsDays: 90, creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id, coverOfferHours: 9, coverTransferHours: null });
    await putSetting(ra.awayKey(james.id), { until: edt(10, 30, 0).toISOString(), setBy: "drill", setAt: new Date().toISOString() });
    const oldTargets = await old.reviewer.reviewAnnounceTargets({ reviewer: { teamMemberId: kyle.id, name: kyle.name }, street: "5 Away Ave", editor: "John", round: 1, href: "/review/x" });
    c.ok("old: James marked away is LEFT OFF the cut FYI", !!oldTargets && !oldTargets.some((t) => t.userKey === `tm:${james.id}`), JSON.stringify(oldTargets?.map((t) => t.userKey ?? "broadcast")));
    await putSetting(ra.awayKey(james.id), { until: null, setBy: "drill", setAt: new Date().toISOString() });
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });
    await resetQueues();
  }

  // =========================================================================
  c.head("1 · THE SCHEDULE: Jordan's preset, the words, and the arithmetic");
  {
    setClock(edt(9, 26, 9, 0));
    const js = await sched.scheduleOf(jordan.id);
    c.ok("Jordan (the OWNER login's roster row) has the preset with nothing saved", js.source === "preset" && JSON.stringify(js.windows) === JSON.stringify([{ day: 6, from: 0, to: 1170 }]), JSON.stringify(js));
    c.ok("…and nothing was written for it", (await prisma.appSetting.count({ where: { key: sched.notifyScheduleKey(jordan.id) } })) === 0);
    c.ok("Kyle and James have none", (await sched.scheduleOf(kyle.id)).source === "none" && (await sched.scheduleOf(james.id)).windows.length === 0);
    const words = defaults.describeQuietWindows("Jordan", js.windows);
    c.ok("the sentence the card prints", words === "Jordan: no notifications Saturday until 7:30 PM — held ones arrive at 7:30 PM.", words);

    const W = [{ day: 6, from: 0, to: 1170 }];
    const iso = (d: Date | null) => d?.toISOString() ?? "null";
    c.ok("Sat 10:00 EDT → held to Sat 19:30 EDT", iso(sched.quietEnd(W, edt(9, 26, 10))) === "2026-09-26T23:30:00.000Z", iso(sched.quietEnd(W, edt(9, 26, 10))));
    c.ok("Sat 19:30 exactly → not held", sched.quietEnd(W, edt(9, 26, 19, 30)) === null);
    c.ok("Sat 19:29 → held one minute", iso(sched.quietEnd(W, edt(9, 26, 19, 29))) === "2026-09-26T23:30:00.000Z");
    c.ok("Sun 10:00 and Fri 23:00 → not held", sched.quietEnd(W, edt(9, 27, 10)) === null && sched.quietEnd(W, edt(9, 25, 23)) === null);
    // DST: Sat Nov 7 2026 is EST (clocks went back Nov 1), so 19:30 is 00:30Z.
    const nov = new RealDate(RealDate.UTC(2026, 10, 7, 15)); // Sat Nov 7 10:00 EST
    c.ok("DST: Sat Nov 7 10:00 EST → 19:30 EST (00:30Z)", iso(sched.quietEnd(W, nov)) === "2026-11-08T00:30:00.000Z", iso(sched.quietEnd(W, nov)));
    // Oct 6 2026: there is no overnight rule any more (Jordan: "Anyone on the
    // team can get pinged anytime. Just not Jordan on Saturday until 7:30PM.").
    // quietEnd takes no `page` flag; with no windows nothing is ever held.
    const mar = new RealDate(RealDate.UTC(2027, 2, 14, 4, 30)); // Sat Mar 13 23:30 EST
    c.ok("Oct 6: no windows → 23:30 before spring-forward is NOT held", sched.quietEnd([], mar) === null, iso(sched.quietEnd([], mar)));
    c.ok("Oct 6: no windows → 02:00 is NOT held (no 10 PM–7 AM rule)", sched.quietEnd([], edt(9, 23, 2)) === null);
    c.ok("Oct 6: quietEnd takes the windows and the instant only", sched.quietEnd.length === 2, String(sched.quietEnd.length));
    const chain = [{ day: 5, from: 22 * 60, to: 1440 }, { day: 6, from: 0, to: 7 * 60 }];
    c.ok("chained windows: Friday from 10 PM + Saturday until 7 AM → Fri 23:00 waits for Sat 07:00", iso(sched.quietEnd(chain, edt(9, 25, 23))) === iso(edt(9, 26, 7)));
    c.ok("Fri 23:00 for someone quiet only on Saturday → not held (no overnight bridge into his Saturday)", sched.quietEnd(W, edt(9, 25, 23)) === null, iso(sched.quietEnd(W, edt(9, 25, 23))));
    c.ok("the reader refuses a window that runs past midnight", defaults.parseQuietWindows([{ day: 5, from: 1320, to: 420 }]) === null && /two windows/.test(defaults.quietWindowProblem({ day: 5, from: 1320, to: 420 }) ?? ""));
    c.ok("…and merges overlapping windows on one day", JSON.stringify(defaults.parseQuietWindows([{ day: 6, from: 0, to: 700 }, { day: 6, from: 660, to: 1170 }])) === JSON.stringify([{ day: 6, from: 0, to: 1170 }]));
  }

  // =========================================================================
  c.head("2 · SATURDAY 10:00: Jordan's bell at once, his phone at 19:30 — Kyle and James at once");
  {
    setClock(edt(9, 26, 10));
    const s0 = slack.length, t0 = texts.length;
    // Delivery rows are counted from here (the old code in section 0 wrote some).
    const logCount = (where: Record<string, unknown>) => prisma.notificationDelivery.count({ where: { teamMemberId: jordan.id, ...where } });
    const base = { bell: await logCount({ channel: "bell" }), smsSent: await logCount({ channel: "sms", status: "sent" }), slackSent: await logCount({ channel: "slack", status: "sent" }) };
    await tag(jordan, "12 Quiet Ln", "b5-sat-tag-jordan");
    await tag(kyle, "12 Quiet Ln", "b5-sat-tag-kyle");
    await tag(james, "12 Quiet Ln", "b5-sat-tag-james");
    await cutReady("14 Quiet Ln", "b5-sat-cut");
    // A line queued WITHOUT a hold (the payroll digest's path) for Jordan.
    await prisma.pendingSms.create({ data: { teamMemberId: jordan.id, line: "Payroll: your week is ready → https://drill.invalid/my-pay" } });

    const bells = await prisma.notification.count({ where: { userKey: `tm:${jordan.id}`, dedupeKey: { startsWith: "b5-sat-tag-jordan" } } });
    c.ok("Jordan's bell row is written at once", bells === 1);
    c.ok("…his cut-ready bell (the owner broadcast) too", (await prisma.notification.count({ where: { dedupeKey: { startsWith: "b5-sat-cut" } } })) === 1);
    c.ok("…and a bell delivery row for him on each", (await logCount({ channel: "bell" })) - base.bell === 2);
    c.ok("no Slack DM to Jordan", dmsTo(jordan, s0).length === 0, dmsTo(jordan, s0).map((m) => m.text).join(" | "));
    c.ok("no text to Jordan", textsTo(JORDAN_PH, t0).length === 0);
    const jp = await pending(jordan);
    const held = jp.filter((p) => p.deferUntil?.toISOString() === "2026-09-26T23:30:00.000Z");
    c.ok("his tag and his cut-ready text are queued, dated 19:30 EDT", held.length === 2, jp.map((p) => `${p.line.slice(0, 30)} @ ${p.deferUntil?.toISOString()}`).join(" | "));
    const dms = await heldDmRows();
    c.ok("his two Slack DMs are held, not turned into texts", dms.length === 2 && dms.every((r) => (JSON.parse(r.value) as { teamMemberId: string; until: string }).teamMemberId === jordan.id && (JSON.parse(r.value) as { until: string }).until === "2026-09-26T23:30:00.000Z"), String(dms.length));
    c.ok("…each logged slack/queued 'held until … (their quiet time)'", (await prisma.notificationDelivery.count({ where: { teamMemberId: jordan.id, channel: "slack", status: "queued", detail: { contains: "their quiet time" } } })) === 2);
    c.ok("Kyle: his tag AND the cut are Slack DMs at once", dmsTo(kyle, s0).length === 2, dmsTo(kyle, s0).map((m) => m.text.slice(0, 40)).join(" | "));
    c.ok("James: his tag is a text at once", textsTo(JAMES_PH, t0).length === 1, `${textsTo(JAMES_PH, t0).length}`);
    c.ok("nobody was relayed to the ops channel as unreached", opsLines(s0).length === 0, opsLines(s0).map((m) => m.text).join(" | "));

    setClock(edt(9, 26, 10, 5));
    await notify.flushPendingSms();
    c.ok("10:05 flush: the un-dated payroll line waits too (the flusher asks the schedule)", textsTo(JORDAN_PH, t0).length === 0 && (await pending(jordan)).length === 3);

    setClock(edt(9, 26, 19, 25));
    const f1 = await notify.flushPendingSms();
    c.ok("19:25: still nothing to Jordan", textsTo(JORDAN_PH, t0).length === 0 && dmsTo(jordan, s0).length === 0 && f1.dms.sent === 0, JSON.stringify(f1));

    setClock(edt(9, 26, 19, 31));
    const f2 = await notify.flushPendingSms();
    const jt = textsTo(JORDAN_PH, t0);
    const jd = dmsTo(jordan, s0);
    c.ok("19:31: ONE text carries all three lines", jt.length === 1 && /3 updates/.test(jt[0]?.body ?? ""), jt.map((t) => t.body).join(" | "));
    c.ok("…in the order they came (tag, cut, payroll)", (() => {
      const b = jt[0]?.body ?? "";
      const a = b.indexOf("12 Quiet Ln"), cc = b.indexOf("14 Quiet Ln"), p = b.indexOf("Payroll");
      return a >= 0 && cc > a && p > cc;
    })(), jt[0]?.body);
    c.ok("…and ONE Slack DM carries both held DMs, oldest first", jd.length === 1 && jd[0].text.indexOf("12 Quiet Ln") >= 0 && jd[0].text.indexOf("12 Quiet Ln") < jd[0].text.indexOf("14 Quiet Ln") && f2.dms.sent === 1, jd.map((m) => m.text).join(" | "));
    c.ok("…the held rows are gone and the log says sent when the hold ended", (await heldDmRows()).length === 0 && (await logCount({ channel: "slack", status: "sent", detail: { contains: "sent when the hold ended" } })) === 2 && (await logCount({ channel: "slack", status: "sent" })) - base.slackSent === 2);
    c.ok("…three sms/sent rows for him", (await logCount({ channel: "sms", status: "sent" })) - base.smsSent === 3);

    setClock(edt(9, 26, 19, 40));
    await notify.flushPendingSms();
    c.ok("19:40: nothing more — sent once", textsTo(JORDAN_PH, t0).length === 1 && dmsTo(jordan, s0).length === 1);
    await resetQueues();
  }

  // =========================================================================
  c.head("3 · SUNDAY AND A WEEKDAY: Jordan at once; nobody without a schedule is held either (Oct 6 2026)");
  {
    setClock(edt(9, 27, 10)); // Sunday
    const s0 = slack.length, t0 = texts.length;
    await tag(jordan, "20 Sunday St", "b5-sun-tag-jordan");
    c.ok("Sunday 10:00: Jordan's tag is a DM and a text at once", dmsTo(jordan, s0).length === 1 && textsTo(JORDAN_PH, t0).length === 1);
    const s1 = slack.length;
    await cutReady("22 Sunday St", "b5-sun-cut");
    c.ok("Sunday: his cut-ready DM goes at once — his schedule, not the office weekend rule, times him", dmsTo(jordan, s1).length === 1, dmsTo(jordan, s1).map((m) => m.text).join(" | "));
    const jp = await pending(jordan);
    // His text went straight to the queue with no hold; the 30-minute batch
    // window (a text went a moment ago) holds it for the flusher, as always.
    c.ok("…and its text is queued with NO hold on it (the old code dated it Monday 9 AM)", jp.length === 1 && jp[0].deferUntil === null, jp.map((p) => String(p.deferUntil)).join(","));
    // The old code, same Sunday, same event: dated to Monday.
    await resetQueues();
    await old.notify.notifyInApp({ kind: "cut_ready", title: "Cut ready — 24 Old Sun", href: "/review/drill", targets: [{ roles: ["OWNER", "ADMIN"], ownerSms: "Video in review — 24 Old Sun" }], dedupeKey: "b5-sun-cut-old" });
    const oldJ = await pending(jordan);
    c.ok("old: the same Sunday cut held Jordan's text to Monday 9 AM", oldJ.length === 1 && oldJ[0].deferUntil?.toISOString() === edt(9, 28, 9).toISOString(), oldJ.map((p) => String(p.deferUntil?.toISOString())).join(","));
    c.ok("unchanged for Kyle: a DM at once, old and new", dmsTo(kyle, s1).length === 2, String(dmsTo(kyle, s1).length));
    await resetQueues();

    // Harrison — no schedule, "video in review" by text. The old code dated his
    // Sunday line to Monday 9 AM (the office weekend rule); since Oct 6 2026
    // ("Anyone on the team can get pinged anytime") it is texted at once.
    const shooterRow = (key: string, n: typeof notify) =>
      n.notifyInApp({ kind: "cut_ready", title: "A cut from your shoot — 26 Sunday St", href: "/review/drill", targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${harrison.id}`, slackDm: "🎬 A cut from your shoot is in review — 26 Sunday St. https://drill.invalid/review/drill" }], dedupeKey: key });
    const th = texts.length;
    await shooterRow("b5-sun-shooter-new", notify);
    const hNewTexts = textsTo(HARRISON_PH, th);
    const hNewQueued = await pending(harrison);
    await resetQueues();
    await shooterRow("b5-sun-shooter-old", old.notify);
    const hOld = (await pending(harrison)).map((p) => p.deferUntil?.toISOString());
    c.ok("old: Harrison (no schedule), Sunday cut by text — held to Monday 9 AM", hOld.length === 1 && hOld[0] === edt(9, 28, 9).toISOString(), JSON.stringify(hOld));
    c.ok("new: the same Sunday cut is TEXTED at once — nothing dated, nothing left in the queue", hNewTexts.length === 1 && /26 Sunday St/.test(hNewTexts[0]?.body ?? "") && hNewQueued.length === 0, `${hNewTexts.length} text(s), ${hNewQueued.length} queued`);
    await resetQueues();

    setClock(edt(9, 29, 10)); // Tuesday
    const s2 = slack.length, t2 = texts.length;
    await tag(jordan, "30 Tuesday Terr", "b5-tue-tag-jordan");
    c.ok("Tuesday 10:00: Jordan's tag is a DM and a text at once", dmsTo(jordan, s2).length === 1 && textsTo(JORDAN_PH, t2).length === 1);
    await resetQueues();
  }

  // =========================================================================
  c.head("4 · THE THREE REVIEW SEATS HEAR ABOUT EVERY CUT — AWAY INCLUDED");
  {
    setClock(edt(9, 29, 11));
    await putSetting(ra.awayKey(james.id), { until: edt(10, 30, 0).toISOString(), setBy: "drill", setAt: new Date().toISOString() });
    const reviewer = await ra.resolveActiveReviewer();
    c.ok("James away → Kyle is the reviewer", reviewer?.teamMemberId === kyle.id);
    const t = await ra.reviewAnnounceTargets({ reviewer: reviewer ? { teamMemberId: reviewer.teamMemberId, name: reviewer.name } : null, street: "5 Away Ave", editor: "John", round: 1, href: "/review/x" });
    const keys = (t ?? []).map((x) => x.userKey ?? `broadcast:${x.roles.join("+")}`);
    c.ok("James (away) gets an FYI person row", keys.includes(`tm:${james.id}`), JSON.stringify(keys));
    c.ok("…whose line says he is away and Kyle has it", /marked away/.test(t?.find((x) => x.userKey === `tm:${james.id}`)?.slackDm ?? "") && /Kyle has it/.test(t?.find((x) => x.userKey === `tm:${james.id}`)?.slackDm ?? ""));
    c.ok("Kyle gets 'waiting on you', Jordan the owner row — all three hear it", keys.includes(`tm:${kyle.id}`) && keys.includes("broadcast:OWNER") && /Waiting on you/.test(t?.find((x) => x.userKey === `tm:${kyle.id}`)?.slackDm ?? ""));
    c.ok("…each exactly once", keys.filter((k) => k === `tm:${james.id}`).length === 1 && keys.filter((k) => k === `tm:${kyle.id}`).length === 1);
    await putSetting(ra.awayKey(james.id), { until: null, setBy: "drill", setAt: new Date().toISOString() });
  }

  // =========================================================================
  c.head("5 · THE SWITCHES DO WHAT THEY SAY");
  {
    setClock(edt(9, 29, 11));
    const client = await prisma.client.create({ data: { name: "Switch Client" }, select: { id: true } });
    const mkJob = async (street: string) => {
      const p = await prisma.project.create({
        data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "SHOT", addressLine: street, photographerId: harrison.id, statusEvidence: JSON.stringify({ dropbox: { rawPhotos: 14, rawVideo: 0, finalVideo: 0 } }) },
        select: { id: true },
      });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 } });
      return p.id;
    };
    await putSetting("internal_alerts", { rawVideoMissing: { enabled: false } });
    const off = await mkJob("40 Switch St");
    await ensureEditorHandoff(off);
    c.ok("raw video missing OFF: the 'Find the raw video' task is still made (capture is always on)", (await prisma.smartTask.count({ where: { dedupeKey: `raw-video-missing-${off}` } })) === 1);
    c.ok("…but no raws_missing bell row", (await prisma.notification.count({ where: { kind: "raws_missing", dedupeKey: { startsWith: `raw-video-missing-bell-${off}` } } })) === 0);
    c.ok("…and no delivery rows for it", (await prisma.notificationDelivery.count({ where: { kind: "raws_missing" } })) === 0);
    await putSetting("internal_alerts", { rawVideoMissing: { enabled: true } });
    const on = await mkJob("42 Switch St");
    await ensureEditorHandoff(on);
    c.ok("raw video missing ON: the bell rings for the photographer", (await prisma.notification.count({ where: { kind: "raws_missing", userKey: `tm:${harrison.id}`, dedupeKey: { startsWith: `raw-video-missing-bell-${on}` } } })) === 1);

    await putSetting("internal_alerts", { kyleDigests: { enabled: false } });
    setClock(edt(9, 29, 16, 30));
    const s0 = slack.length;
    const d = await afternoonSlackDigest();
    setClock(edt(9, 30, 9, 30));
    const m = await notify.kyleMorningDigest();
    c.ok("Kyle's digests OFF: both answer 'switched off', send nothing", !d.sent && /switched off/.test(d.reason ?? "") && !m.sent && /switched off/.test(m.reason ?? "") && dmsTo(kyle, s0).length === 0, JSON.stringify([d, m]));
    c.ok("…and claim nothing, so switching back on the same day still sends", (await prisma.appSetting.count({ where: { key: { in: ["kyle-digest-2026-09-29", "kyle-morning-2026-09-30"] } } })) === 0);
    await putSetting("internal_alerts", { kyleDigests: { enabled: true } });
    setClock(edt(9, 30, 9, 35));
    const m2 = await notify.kyleMorningDigest();
    c.ok("…back ON: the morning list goes", m2.sent === true && dmsTo(kyle, s0).length === 1, JSON.stringify(m2));
  }

  // =========================================================================
  c.head("6 · THE URGENT ON-CALL PAGE: any hour (Oct 6 2026) — only Jordan's Saturday waits");
  {
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: kyle.id } });
    setClock(edt(9, 30, 23, 30)); // Wed 23:30
    const s0 = slack.length;
    const sentRows = () => prisma.notificationDelivery.count({ where: { teamMemberId: kyle.id, kind: "reply_sla", channel: "slack", status: "sent" } });
    const sentBefore = await sentRows();
    const r = await notify.notifyStaffSms([jordan.id], "Client still unanswered (VIP) — Ann Lee, 2h", "reply_sla", { urgency: "urgent" });
    c.ok("23:30: the page goes to the on-call (Kyle) as a Slack DM at 23:30 — not held", r.length === 1 && r[0].teamMemberId === kyle.id && r[0].outcome === "slack" && dmsTo(kyle, s0).length === 1 && /Ann Lee/.test(dmsTo(kyle, s0)[0]?.text ?? ""), JSON.stringify(r));
    c.ok("…no 'Urgent page held' line on the ops channel, nothing held for him", !opsLines(s0).some((m) => /Urgent page held/.test(m.text)) && (await heldDmRows()).length === 0, opsLines(s0).map((m) => m.text).join(" | "));
    c.ok("…the delivery log reads slack/sent", (await sentRows()) - sentBefore === 1);
    setClock(edt(10, 1, 7, 1));
    await notify.flushPendingSms();
    c.ok("07:01: nothing more — it went once, at 23:30", dmsTo(kyle, s0).length === 1);

    // A phone-only on-call: texted at once, at night (the old code queued it "for the morning").
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: dana.id } });
    setClock(edt(10, 1, 23, 45));
    const s1 = slack.length, t1 = texts.length;
    const r2 = await notify.notifyStaffSms([jordan.id], "Unhappy client unanswered — Bo Park, 40m", "reply_sla", { urgency: "urgent" });
    c.ok("phone-only on-call at 23:45: texted at 23:45, outcome sent, nothing queued", r2[0]?.outcome === "sent" && textsTo(DANA_PH, t1).length === 1 && /Bo Park/.test(textsTo(DANA_PH, t1)[0]?.body ?? "") && (await pending(dana)).length === 0, JSON.stringify(r2));
    c.ok("…and no 'held' line on the ops channel", !opsLines(s1).some((m) => /Urgent page held/.test(m.text)));
    setClock(edt(10, 2, 7, 2));
    await notify.flushPendingSms();
    c.ok("07:02: nothing more for Dana", textsTo(DANA_PH, t1).length === 1);
    await resetQueues();

    // Saturday 10:00 — daytime, out of cover: unchanged, straight to Kyle.
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: kyle.id } });
    setClock(edt(10, 3, 10)); // Sat Oct 3
    const s2 = slack.length;
    const r3 = await notify.notifyStaffSms([jordan.id], "Client still unanswered — Cy Moss, 2h", "reply_sla", { urgency: "urgent" });
    c.ok("Saturday 10:00: the page is a Slack DM to Kyle at once — identical to today", r3[0]?.outcome === "slack" && dmsTo(kyle, s2).length === 1, JSON.stringify(r3));

    // Jordan on call, on his own Saturday: a quiet window applies to urgent pages too.
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: jordan.id } });
    const s3 = slack.length;
    const r4 = await notify.notifyStaffSms([kyle.id], "Client still unanswered — Di Nash, 2h", "reply_sla", { urgency: "urgent" });
    c.ok("Jordan on call, Saturday 10:00: his page waits for 19:30 (held, not dropped)", r4[0]?.outcome === "held" && r4[0]?.until === edt(10, 3, 19, 30).toISOString() && dmsTo(jordan, s3).length === 0, JSON.stringify(r4));
    c.ok("…and the ops channel is told it is waiting for HIS quiet time, until when", opsLines(s3).some((m) => /Urgent page held \(their quiet time\)/.test(m.text) && /Jordan Spackman gets it/.test(m.text)), opsLines(s3).map((m) => m.text).join(" | "));
    setClock(edt(10, 3, 19, 31));
    await notify.flushPendingSms();
    c.ok("…and reaches him once at 19:31", dmsTo(jordan, s3).length === 1);
    await putSetting("internal_alerts", { coverage: { weekdaysOnly: true, fromHour: 9, toHour: 18, onCallTeamMemberId: null } });
    await resetQueues();
  }

  // =========================================================================
  c.head("7 · A DIGEST THAT FAILED NEVER REPORTS SENT");
  {
    setClock(edt(10, 5, 16, 30)); // Mon
    refuse.add("U-KYLE");
    const s0 = slack.length;
    const d1 = await afternoonSlackDigest();
    c.ok("Slack refuses: sent: false with Slack's words", d1.sent === false && /channel_not_found|missing_scope/.test(d1.reason ?? ""), JSON.stringify(d1));
    c.ok("…the day's claim is released", (await prisma.appSetting.count({ where: { key: "kyle-digest-2026-10-05" } })) === 0);
    c.ok("…one failed delivery row", (await prisma.notificationDelivery.count({ where: { teamMemberId: kyle.id, kind: "kyle_digest", channel: "slack", status: "failed" } })) === 1);
    refuse.delete("U-KYLE");
    setClock(edt(10, 5, 16, 35));
    const d2 = await afternoonSlackDigest();
    setClock(edt(10, 5, 16, 40));
    const d3 = await afternoonSlackDigest();
    c.ok("the next tick sends it — once", d2.sent === true && d3.sent === false && /already sent/.test(d3.reason ?? "") && dmsTo(kyle, s0).length === 1, JSON.stringify([d2, d3]));
    c.ok("…with a sent delivery row", (await prisma.notificationDelivery.count({ where: { teamMemberId: kyle.id, kind: "kyle_digest", channel: "slack", status: "sent" } })) === 1);

    // Kyle's own quiet time holds the digest instead (Thursday 16:00–17:00).
    await sched.saveSchedule(kyle.id, [{ day: 4, from: 16 * 60, to: 17 * 60 }], "drill");
    setClock(edt(10, 8, 16, 30)); // Thu
    const s2 = slack.length;
    const h = await afternoonSlackDigest();
    c.ok("inside Kyle's quiet time the 4 o'clock check is HELD, and keeps its claim", h.sent === false && /held until/.test(h.reason ?? "") && (await prisma.appSetting.count({ where: { key: "kyle-digest-2026-10-08" } })) === 1 && dmsTo(kyle, s2).length === 0, JSON.stringify(h));
    // A routine staff alert inside the same window (deliveryWatch's shape): in
    // cover, so the rota sends it now — but it is Kyle's quiet time, so it waits
    // too, and quietly (routine: no ops line).
    const o0 = opsLines().length;
    const late = await notify.notifyStaffSms([kyle.id], "1 job shot and photos still not delivered on Aryeo: 60 Lag Ln", "photos_undelivered", { urgency: "routine" });
    c.ok("a routine photos-late alert inside his quiet time is held, with no ops line", late[0]?.outcome === "held" && opsLines().length === o0 && dmsTo(kyle, s2).length === 0, JSON.stringify(late));
    setClock(edt(10, 8, 17, 1));
    await notify.flushPendingSms();
    const k = dmsTo(kyle, s2);
    c.ok("…and at 17:01 both go as ONE DM, the digest first", k.length === 1 && /4 o'clock check/.test(k[0].text) && k[0].text.indexOf("4 o'clock check") < k[0].text.indexOf("60 Lag Ln"), k.map((m) => m.text.slice(0, 120)).join(" | "));
    await sched.saveSchedule(kyle.id, null, "drill");
    // A Saturday morning list is not skipped (Jordan, Sep 26 — see notify.ts).
    setClock(edt(10, 10, 9));
    const s1 = slack.length;
    const sat = await notify.kyleMorningDigest();
    c.ok("Saturday 9:00: Kyle's morning list still goes (no weekend skip)", sat.sent === true && dmsTo(kyle, s1).length === 1, JSON.stringify(sat));

  }

  // =========================================================================
  c.head("8 · THE SETTINGS ACTIONS: whose schedule, a stale tab, the audit trail");
  {
    setClock(edt(10, 12, 12));
    viewer = V.kyle;
    const loaded = await settingsActions.loadNotifySchedules();
    const jr = loaded.rows.find((r) => r.teamMemberId === jordan.id);
    c.ok("Kyle (admin) sees everyone, Jordan first with his preset", loaded.canEditAll && loaded.rows[0]?.teamMemberId === jordan.id && jr?.source === "preset", JSON.stringify(loaded.rows.map((r) => `${r.name}:${r.source}`)));
    const ok1 = await settingsActions.saveNotifySchedule(jordan.id, [{ day: 6, from: 0, to: 20 * 60 }], jr?.setAt ?? null);
    c.ok("Kyle saves Jordan's schedule (Saturday until 8 PM)", ok1.ok && /Saturday until 8 PM/.test(ok1.message), ok1.message);
    const stale = await settingsActions.saveNotifySchedule(jordan.id, [{ day: 6, from: 0, to: 19 * 60 }], jr?.setAt ?? null);
    c.ok("a second save from the same stale tab is refused", !stale.ok && /changed/.test(stale.message), stale.message);
    viewer = V.harrison;
    const theirs = await settingsActions.saveNotifySchedule(jordan.id, [], ok1.row?.setAt ?? null);
    c.ok("Harrison cannot change Jordan's", !theirs.ok, theirs.message);
    const own = await settingsActions.saveNotifySchedule(harrison.id, [{ day: 0, from: 0, to: 12 * 60 }], null);
    c.ok("…but can set his own", own.ok, own.message);
    const mine = await settingsActions.loadNotifySchedules();
    c.ok("…and loading shows him only his own row", !mine.canEditAll && mine.rows.length === 1 && mine.rows[0].teamMemberId === harrison.id);
    viewer = V.jordan;
    const bad = await settingsActions.saveNotifySchedule(jordan.id, [{ day: 5, from: 22 * 60, to: 7 * 60 }], ok1.row?.setAt ?? null);
    c.ok("a window past midnight is refused with the two-window advice", !bad.ok && /two windows/.test(bad.message), bad.message);
    const back = await settingsActions.saveNotifySchedule(jordan.id, null, ok1.row?.setAt ?? null);
    c.ok("Jordan resets to the preset", back.ok && back.row?.source === "preset" && /7:30 PM/.test(back.message), back.message);
    const audits = await prisma.auditLog.findMany({ where: { action: "notify_schedule" }, orderBy: { createdAt: "asc" } });
    c.ok("every accepted save wrote one AuditLog row (3), refusals none", audits.length === 3, audits.map((a) => `${a.actor}: ${a.detail.slice(0, 60)}`).join(" | "));
    c.ok("…naming who, whose, and before → after", audits[0]?.actor === "kyle@drill.invalid" && /Jordan Spackman/.test(audits[0]?.target ?? "") && /preset: .*7:30 PM.* -> saved: .*8 PM/.test(audits[0]?.detail ?? ""), audits[0]?.detail);
    viewer = null;
  }

  // =========================================================================
  c.head("9 · A HELD DM IS SENT ONCE: a refusal retries, two ticks race, a dead worker's claim is taken back");
  {
    setClock(edt(10, 17, 10)); // Sat Oct 17
    await resetQueues();
    await tag(jordan, "50 Lease Ln", "b5-lease-tag");
    c.ok("held as one row", (await heldDmRows()).length === 1);
    refuse.add("U-JORDAN");
    setClock(edt(10, 17, 19, 31));
    const s0 = slack.length;
    const f1 = await notify.releaseHeldStaffDms();
    const back = await heldDmRows();
    c.ok("Slack refuses at 19:31: counted failed, the row handed back unclaimed with attempt 1", f1.failed === 1 && back.length === 1 && (JSON.parse(back[0].value) as { attempts: number; claimedAt?: string }).attempts === 1 && !(JSON.parse(back[0].value) as { claimedAt?: string }).claimedAt, back.map((r) => r.value.slice(-80)).join(" | "));
    refuse.delete("U-JORDAN");
    setClock(edt(10, 17, 19, 36));
    const [a, b] = await Promise.all([notify.releaseHeldStaffDms(), notify.releaseHeldStaffDms()]);
    c.ok("19:36, two ticks at once: ONE DM, the row gone", a.sent + b.sent === 1 && dmsTo(jordan, s0).length === 1 && (await heldDmRows()).length === 0, JSON.stringify([a, b]));
    c.ok("…the log shows the failed attempt and the one send", (await prisma.notificationDelivery.count({ where: { teamMemberId: jordan.id, channel: "slack", status: "failed", detail: { contains: "will be retried" } } })) === 1);

    // A worker that died after claiming: its claim is left alone for 15
    // minutes (it may still be sending), then taken back — the notice is late,
    // never lost.
    const stuck = (claimedMinutesAgo: number) =>
      prisma.appSetting.create({
        data: {
          key: sched.heldDmKey(jordan.id),
          value: JSON.stringify({ teamMemberId: jordan.id, slackId: "U-JORDAN", text: `stuck ${claimedMinutesAgo}`, until: edt(10, 17, 19, 30).toISOString(), kind: "mention", notificationId: null, heldAt: edt(10, 17, 11).toISOString(), why: "their quiet time", attempts: 0, claimedAt: new Date(Date.now() - claimedMinutesAgo * 60_000).toISOString() }),
        },
      });
    await stuck(5);
    const s1 = slack.length;
    const r1 = await notify.releaseHeldStaffDms();
    c.ok("a claim 5 minutes old is left alone", r1.sent === 0 && dmsTo(jordan, s1).length === 0 && (await heldDmRows()).length === 1);
    setClock(edt(10, 17, 19, 56));
    const r2 = await notify.releaseHeldStaffDms();
    c.ok("…at 20 minutes old it is taken back and sent once", r2.sent === 1 && dmsTo(jordan, s1).length === 1 && /stuck 5/.test(dmsTo(jordan, s1)[0]?.text ?? "") && (await heldDmRows()).length === 0);
    await resetQueues();
  }

  // =========================================================================
  c.head("9b · A HELD DM IS ITS OWN RECORD: a lost log line on a retry, a failed delete after the send");
  {
    setClock(edt(10, 24, 10)); // Sat Oct 24 — Jordan's quiet morning
    await resetQueues();
    await tag(jordan, "60 Retry Rd", "b5-retry-tag");
    const first = await prisma.notification.findUnique({ where: { dedupeKey: "b5-retry-tag-0" }, select: { id: true } });
    const heldOn = async (notificationId: string | undefined) =>
      (await heldDmRows()).filter((r) => (JSON.parse(r.value) as { notificationId: string | null }).notificationId === notificationId);
    c.ok("the tag is held: one DM row, one dated text", !!first && (await heldOn(first?.id)).length === 1 && (await pending(jordan)).length === 1);
    // Both log lines lost — logDelivery is best-effort by contract.
    await prisma.notificationDelivery.deleteMany({ where: { notificationId: first?.id, channel: { in: ["slack", "sms"] } } });
    setClock(edt(10, 24, 10, 5)); // past the 60-second in-flight guard
    await tag(jordan, "60 Retry Rd", "b5-retry-tag");
    const after = await heldOn(first?.id);
    c.ok("a re-announcement with no log lines holds NO second copy — the held row is the record", after.length === 1 && (await pending(jordan)).length === 1, `${after.length} held row(s), ${(await pending(jordan)).length} queued line(s)`);

    // The store refuses every delete of a held row from here — a transient
    // Neon error, made to last for the drill.
    await prisma.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION drill_refuse_held_dm_delete() RETURNS trigger AS $$ BEGIN IF OLD.key LIKE 'held-dm:%' THEN RAISE EXCEPTION 'drill: the store refused the delete'; END IF; RETURN OLD; END $$ LANGUAGE plpgsql`,
    );
    await prisma.$executeRawUnsafe(`CREATE TRIGGER drill_refuse_held_dm_delete BEFORE DELETE ON "AppSetting" FOR EACH ROW EXECUTE FUNCTION drill_refuse_held_dm_delete()`);
    setClock(edt(10, 24, 19, 31));
    const s0 = slack.length;
    const r1 = await notify.releaseHeldStaffDms();
    const left = await heldDmRows();
    c.ok("19:31: Slack takes the DM — one sent", r1.sent === 1 && dmsTo(jordan, s0).length === 1, JSON.stringify(r1));
    c.ok("…the delete fails, so the row is stamped settled rather than left claimed", left.length === 1 && !!(JSON.parse(left[0].value) as { settledAt?: string }).settledAt, left.map((r) => r.value.slice(-90)).join(" | "));
    c.ok("…and the Settings card no longer counts it as waiting", ((await sched.heldForMembers([jordan.id])).get(jordan.id)?.dms ?? 0) === 0);
    setClock(edt(10, 24, 19, 50)); // the 15-minute lease is long gone
    const r2 = await notify.releaseHeldStaffDms();
    c.ok("19:50: NOT sent again (before the review, the expired claim sent it a second time here)", r2.sent === 0 && dmsTo(jordan, s0).length === 1 && (await heldDmRows()).length === 1, JSON.stringify(r2));
    await prisma.$executeRawUnsafe(`DROP TRIGGER drill_refuse_held_dm_delete ON "AppSetting"`);
    setClock(edt(10, 24, 19, 55));
    const r3 = await notify.releaseHeldStaffDms();
    c.ok("19:55, the store works again: the finished row is deleted, still one DM", r3.sent === 0 && (await heldDmRows()).length === 0 && dmsTo(jordan, s0).length === 1);
    c.ok("…one 'sent' line in the log for it", (await prisma.notificationDelivery.count({ where: { notificationId: first?.id, channel: "slack", status: "sent" } })) === 1);
    await resetQueues();
  }

  // =========================================================================
  c.head("10 · THE SENDERS OUTSIDE THE BRIDGE: the 7 PM upload text, the 10 PM chaser, the split notice, the coaching note");
  {
    const oldDigest = (await import(baseCopy(tmp, "uploadDigest.base.ts", "src/lib/uploadDigest.ts"))) as typeof import("@/lib/uploadDigest");
    // The old coaching note asked notify.holdUntilCovered, which this tree no
    // longer exports (Oct 6 2026, the weekend hold removed). For this kind it
    // always answered null (comms_coaching was never ROUTINE), so the old copy
    // is given exactly that answer — its behaviour is unchanged.
    const oldCoaching = (await import(baseCopy(tmp, "commsCoaching.base.ts", "src/lib/commsCoaching.ts", (src) => {
      const out = src
        .replace("const { notifyInApp, holdUntilCovered } = await import(\"@/lib/notify\");", "const { notifyInApp } = await import(\"@/lib/notify\");")
        .replace("const hold = await holdUntilCovered(COMMS_COACHING_KIND, undefined);", "const hold = null as Date | null;");
      if (out.includes("holdUntilCovered")) throw new Error("b5: the old coaching copy still reaches for holdUntilCovered");
      return out;
    }))) as typeof import("@/lib/commsCoaching");
    const digest = await import("@/lib/uploadDigest");
    const coaching = await import("@/lib/commsCoaching");
    const { NextRequest } = await import("next/server");
    const route = await import("@/app/api/cron/evening/route");
    const evening = () => route.GET(new NextRequest("http://127.0.0.1/api/cron/evening", { headers: { authorization: "Bearer drill-secret" } }));
    const client = await prisma.client.create({ data: { name: "Evening Client" }, select: { id: true } });
    const shoot = (title: string, photographerId: string, at: Date, extra: Record<string, unknown> = {}) =>
      prisma.project.create({ data: { title, clientId: client.id, status: "SCHEDULED", shootDate: at, photographerId, ...extra }, select: { id: true } });
    // Saturday Oct 31: the owner shoots, and so do James and Harrison.
    await shoot("80 Owner Way, Media, PA", jordan.id, edt(10, 31, 11));
    await shoot("82 James Pl, Media, PA", james.id, edt(10, 31, 11, 30));
    await shoot("84 Harrison Ave, Media, PA", harrison.id, edt(10, 31, 12));
    // Kyle keeps Saturday evenings quiet (6–9 PM). His coaching note is on and
    // today's audit is already written — the re-send path, no model call.
    await sched.saveSchedule(kyle.id, [{ day: 6, from: 18 * 60, to: 21 * 60 }], "drill");
    await putSetting(coaching.COMMS_COACHING_SETTING_KEY, { teamMemberIds: [kyle.id], sendEnabled: true });
    const auditKey = coaching.coachingAuditKey(kyle.id, "2026-10-31");
    const auditValue = JSON.stringify({
      version: 1, teamMemberId: kyle.id, personName: kyle.name, dayKey: "2026-10-31", generatedAt: edt(10, 31, 18).toISOString(),
      messagesConsidered: 6, messagesAnalysed: 6, threadsAnalysed: 2, droppedForCap: 0, clients: [], thanks: "Thanks for carrying the desk",
      wentWell: [], suggestions: [], note: "Hey Kyle! Drill coaching note for Saturday.", sent: false, sentAt: null, sendSkipped: null,
      model: "drill", inputTokens: 0, outputTokens: 0,
    });
    const unsentAudit = () => prisma.appSetting.upsert({ where: { key: auditKey }, create: { key: auditKey, value: auditValue }, update: { value: auditValue } });
    await unsentAudit();
    const kyleHeld = async () => (await heldDmRows()).filter((r) => (JSON.parse(r.value) as { teamMemberId: string }).teamMemberId === kyle.id);

    // OLD (17df024), the same Saturday at 7:00 PM.
    setClock(new RealDate(edt(10, 31, 19).getTime() + 30_000));
    const s0 = slack.length, t0 = texts.length;
    const od = await oldDigest.sendEveningUploadDigests();
    await oldCoaching.runDailyCommsCoaching();
    c.ok("old: the 7 PM upload text reaches Jordan at 19:00 — inside the quiet time the card says lasts until 19:30", textsTo(JORDAN_PH, t0).length === 1 && od.sent === 3, `${textsTo(JORDAN_PH, t0).length} text(s), ${JSON.stringify(od)}`);
    c.ok("old: …and nothing waits for him in the queue", (await pending(jordan)).length === 0);
    c.ok("old: Kyle's coaching note is a Slack DM at 19:00, inside his 6–9 PM window", dmsTo(kyle, s0).length === 1 && (await kyleHeld()).length === 0, `${dmsTo(kyle, s0).length} DM(s)`);
    // Give the new code the same Saturday: the old run's day claims undone.
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: "upload-digest-2026-10-31-" } } });
    await unsentAudit();

    // NEW — the real evening cron, as Vercel calls it.
    setClock(new RealDate(edt(10, 31, 19).getTime() + 40_000));
    const s1 = slack.length, t1 = texts.length;
    const res = await evening();
    const body = (await res.json()) as { digests?: { sent: number; held?: string[]; notes: string[] } };
    c.ok("19:00: the route answers 200 — a held text is not a failed night", res.status === 200, `${res.status} ${JSON.stringify(body).slice(0, 300)}`);
    c.ok("…Jordan is NOT texted at 19:00", textsTo(JORDAN_PH, t1).length === 0, textsTo(JORDAN_PH, t1).map((t) => t.body.slice(0, 50)).join(" | "));
    c.ok("…James and Harrison (nobody quiet at 19:00) are texted at 19:00, exactly as before", textsTo(JAMES_PH, t1).length === 1 && textsTo(HARRISON_PH, t1).length === 1 && body.digests?.sent === 2, JSON.stringify(body.digests));
    const jp = await pending(jordan);
    c.ok("…his list waits in the staff queue, dated 19:30", jp.length === 1 && jp[0].deferUntil?.toISOString() === edt(10, 31, 19, 30).toISOString() && /Tonight's shoots/.test(jp[0].line) && /80 Owner Way/.test(jp[0].line), jp.map((p) => `${p.deferUntil?.toISOString()} ${p.line.slice(0, 40)}`).join(" | "));
    c.ok("…and the route's answer names it as held, not as a failure", (body.digests?.held ?? []).some((h) => /^Jordan Spackman: held until 2026-10-31T23:30/.test(h)) && (body.digests?.notes ?? []).length === 0, JSON.stringify(body.digests));
    c.ok("Kyle's coaching note is held, not DM'd at 19:00", dmsTo(kyle, s1).length === 0 && (await kyleHeld()).length === 1 && (JSON.parse((await kyleHeld())[0].value) as { kind: string }).kind === "comms_coaching");
    c.ok("…and its audit records it handed over, so a re-run cannot hold a second copy", (await coaching.readCoachingAudit(kyle.id, "2026-10-31"))?.sent === true);
    setClock(new RealDate(edt(10, 31, 19).getTime() + 50_000));
    await evening();
    c.ok("a second firing in the same hour: nothing sent, nothing more held", textsTo(JORDAN_PH, t1).length === 0 && textsTo(JAMES_PH, t1).length === 1 && (await pending(jordan)).length === 1 && (await kyleHeld()).length === 1);

    setClock(edt(10, 31, 19, 25));
    await notify.flushPendingSms();
    c.ok("19:25: still nothing to Jordan", textsTo(JORDAN_PH, t1).length === 0);
    setClock(edt(10, 31, 19, 31));
    await notify.flushPendingSms();
    const jt = textsTo(JORDAN_PH, t1);
    c.ok("19:31: ONE text to Jordan with tonight's list, marked as the hub's", jt.length === 1 && /80 Owner Way/.test(jt[0].body) && jt[0].body.startsWith("⚙️ RealTour Hub"), jt.map((t) => t.body.slice(0, 80)).join(" | "));
    setClock(edt(10, 31, 20, 59));
    await notify.flushPendingSms();
    c.ok("20:59: Kyle's note still held", dmsTo(kyle, s1).length === 0);
    setClock(edt(10, 31, 21, 1));
    await notify.flushPendingSms();
    c.ok("21:01: ONE DM to Kyle carrying the note", dmsTo(kyle, s1).length === 1 && /Drill coaching note/.test(dmsTo(kyle, s1)[0]?.text ?? ""), dmsTo(kyle, s1).map((m) => m.text.slice(0, 60)).join(" | "));

    // The 10 PM chaser and the late split notice, for somebody quiet at night.
    await sched.saveSchedule(harrison.id, [{ day: 6, from: 21 * 60, to: 1440 }], "drill");
    const split = await shoot("86 Split St, Media, PA", harrison.id, edt(10, 31, 15), { deliverables: { create: [{ type: "VIDEO", label: "Listing Reel", quantity: 1 }] } });
    setClock(edt(10, 31, 22));
    const t2 = texts.length;
    const nag = await digest.sendNightlyUploadNags();
    c.ok("22:00: Harrison is inside his 9 PM–midnight window — no chaser text", textsTo(HARRISON_PH, t2).length === 0 && (nag.held ?? []).some((h) => /^Harrison Wells: held until 2026-11-01T04:00/.test(h)), JSON.stringify(nag));
    c.ok("…Jordan and James (nobody quiet at 22:00) get theirs as before", textsTo(JORDAN_PH, t2).length === 1 && textsTo(JAMES_PH, t2).length === 1);
    setClock(edt(10, 31, 22, 30));
    await prisma.project.update({ where: { id: split.id }, data: { photosHandoffAt: new Date() } });
    const sn = await digest.sendSplitNoticeIfChaserPassed(split.id, new Date());
    c.ok("22:30, the photos half is in: the split notice is held, not sent", !sn.sent && /held until 2026-11-01T04:00/.test(sn.reason) && textsTo(HARRISON_PH, t2).length === 0, JSON.stringify(sn));
    const again = await digest.sendSplitNoticeIfChaserPassed(split.id, new Date());
    c.ok("…pressing it again: already told (the job's claim stays taken)", !again.sent && /already told/.test(again.reason), JSON.stringify(again));
    const hp = await pending(harrison);
    c.ok("…both lines wait in the queue, dated midnight", hp.length === 2 && hp.every((p) => p.deferUntil?.toISOString() === "2026-11-01T04:00:00.000Z"), hp.map((p) => `${p.deferUntil?.toISOString()} ${p.line.slice(0, 30)}`).join(" | "));
    setClock(new RealDate(RealDate.UTC(2026, 10, 1, 3, 55))); // Sat Oct 31 23:55 EDT
    await notify.flushPendingSms();
    c.ok("23:55: still inside his window — nothing", textsTo(HARRISON_PH, t2).length === 0);
    setClock(new RealDate(RealDate.UTC(2026, 10, 1, 4, 5))); // Sun Nov 1 00:05 EDT
    await notify.flushPendingSms();
    const ht = textsTo(HARRISON_PH, t2);
    // Oct 6 2026: no 7 AM texting rule behind his own window — it goes at 00:05.
    c.ok("00:05, his window over: ONE text carrying both, in order — at night, no 7 AM texting rule", ht.length === 1 && /2 updates/.test(ht[0].body) && ht[0].body.indexOf("84 Harrison Ave") >= 0 && ht[0].body.indexOf("84 Harrison Ave") < ht[0].body.indexOf("video is not"), ht.map((t) => t.body.slice(0, 160)).join(" | "));
    setClock(new RealDate(RealDate.UTC(2026, 10, 1, 12, 1))); // Sun Nov 1 07:01 EST — the clocks went back at 2 AM
    await notify.flushPendingSms();
    c.ok("07:01 EST: nothing more — sent once", textsTo(HARRISON_PH, t2).length === 1);
    await sched.saveSchedule(kyle.id, null, "drill");
    await sched.saveSchedule(harrison.id, null, "drill");
    await putSetting(coaching.COMMS_COACHING_SETTING_KEY, { teamMemberIds: [], sendEnabled: false });
    await resetQueues();
  }

  // =========================================================================
  c.head("11 · A HELD EDITOR PING IS REPORTED AS HELD, NEVER AS A SLACK DM");
  {
    const john = await member("John Mark Drill", "johnmark@drill.invalid", "EDITOR", null, "U-JOHN");
    await sched.saveSchedule(john.id, [{ day: 0, from: 0, to: 1440 }], "drill"); // Sundays off
    const raws = (key: string) =>
      notify.notifyInApp({
        kind: "raws_landed",
        title: "Raws in — 90 Quiet Ct: ready for editing",
        href: "/editing",
        targets: [{ roles: ["ADMIN"] }, { roles: ["EDITOR"] }, { roles: ["EDITOR"], userKey: "editor:john", href: "/edit/drill" }],
        dedupeKey: key,
      });
    setClock(new RealDate(RealDate.UTC(2026, 10, 8, 15))); // Sun Nov 8 10:00 EST
    const s0 = slack.length;
    const sun = await raws("b5-john-sun");
    const ch = sun.bridged.find((b) => b.userKey === "editor:john")?.channel;
    c.ok("Sunday, inside John's quiet time: the bridge answers 'quiet' — the timeline and brand panel used to say 'pinged by Slack DM'", ch === "quiet", String(ch));
    c.ok("…no DM went; one is held for him", dmsTo(john, s0).length === 0 && (await heldDmRows()).filter((r) => (JSON.parse(r.value) as { teamMemberId: string }).teamMemberId === john.id).length === 1);
    setClock(new RealDate(RealDate.UTC(2026, 10, 9, 5, 1))); // Mon Nov 9 00:01 EST
    await notify.releaseHeldStaffDms();
    c.ok("Monday 00:01: the held ping reaches him, once", dmsTo(john, s0).length === 1 && /90 Quiet Ct/.test(dmsTo(john, s0)[0]?.text ?? ""));
    // Oct 6 2026 — ONE RULE: an editor is timed by a schedule of their OWN and
    // nothing else (Jordan: "Editors can get night time pings."). (1) John
    // SAVED one (Sundays off), so Monday 10:00 EST — 11 PM in Manila — is a DM
    // at once. (2) With NO saved schedule, midnight in Manila is a DM at once
    // too: the Oct 5 "hold an editor's DM to 7 AM their time" default is gone.
    setClock(new RealDate(RealDate.UTC(2026, 10, 9, 15))); // Mon 10:00 EST = Mon 23:00 in Manila
    const mon = await raws("b5-john-mon");
    c.ok("Monday 10:00 EST (11 PM Manila), John's OWN saved schedule says he is reachable: a DM at once, and the bridge says 'slack'", mon.bridged.find((b) => b.userKey === "editor:john")?.channel === "slack" && dmsTo(john, s0).length === 2, JSON.stringify(mon.bridged));
    await sched.saveSchedule(john.id, null, "drill"); // no schedule of his own
    setClock(new RealDate(RealDate.UTC(2026, 10, 9, 16))); // Mon 11:00 EST = Tue 00:00 in Manila
    const s1 = slack.length;
    const night = await raws("b5-john-night");
    const nightCh = night.bridged.find((b) => b.userKey === "editor:john")?.channel;
    const johnHeld = async () => (await heldDmRows()).map((r) => JSON.parse(r.value) as { teamMemberId: string; until: string }).filter((v) => v.teamMemberId === john.id);
    c.ok("no saved schedule, midnight in Manila (Mon 11:00 EST): a DM at once, the bridge says 'slack'", nightCh === "slack" && dmsTo(john, s1).length === 1 && /90 Quiet Ct/.test(dmsTo(john, s1)[0]?.text ?? ""), `${nightCh} · ${dmsTo(john, s1).length} DM(s)`);
    c.ok("…nothing held for him", (await johnHeld()).length === 0, JSON.stringify(await johnHeld()));
    setClock(new RealDate(RealDate.UTC(2026, 10, 9, 23, 1))); // Tue 07:01 in Manila (Mon 18:01 EST)
    await notify.releaseHeldStaffDms();
    c.ok("07:01 Manila: nothing more — it went once, at midnight", dmsTo(john, s1).length === 1, `${dmsTo(john, s1).length} DM(s)`);
    await resetQueues();
  }

  c.ok("nothing left the machine but the fakes", fence.blocked.length === 0, fence.blocked.join(", "));
  quiet.restore();
  c.summary();
  await stop();
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
