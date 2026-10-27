// ---------------------------------------------------------------------------
// DRILL: WHO GETS WHICH PING, BY ROLE (Oct 27 2026).
//
//   DRILL_PORT=5701 node scripts/_drill/run-all.cjs scripts/_drill/oct27-notification-roles.ts
//
// Jordan: "audit the notifications - make sure we are not overloading Kyle,
// James, and me with notifications that are not needed or that do not apply to
// our roles and responsibilities. Kyle handles comms, delegation, review,
// delivery, and coordination. James is the creative manager. I am CEO."
//
// The table lives in src/lib/notifyRoles.ts (ROLE_ROUTES, with the dated
// decision table). What this proves, through the shipped notifyInApp, the
// shipped Review Room announcer and the shipped photo alerts:
//   1  The table itself, per kind and seat, and the pure routing rules.
//   2  A cut James reviews: his bell every cut, a text only for the first of
//      a pile; Jordan (bell, Slack mirror, phone) and Kyle hear nothing. A cut
//      Jordan reviews is one row to him by name, with his Slack and text; his
//      own upload is bell only. A cut with no seat named still rings.
//   3  Verdicts: Jordan has none; James's copy is bell only (his switches say
//      text); nobody is told about their own press (echo), on a named row or
//      on a broadcast's channel legs. A revision ask still texts James.
//   4  The CEO's kinds: leads, topic suggestions, edit starts, portal chatter
//      and the photo pipeline leave his bell and his Slack mirror; errors,
//      behind alerts and owner-only photo alerts stay.
//   5  Money: the creative manager's row is scrubbed, as before.
//   6  The 6 PM wrap carries the day's leads (both copies) and the topic
//      suggestions (Jordan's copy only).
//   7  The Saturday rule is unchanged: Jordan held until 7:30 PM, nobody else.
//
// ISOLATION: PGlite via the shared harness; production is never opened; every
// non-loopback call is fenced; Slack is answered by a fake and counted;
// OpenPhone's two calls are replaced in-process. The clock is pinned to Tue
// Oct 27 2026 10:00 EDT and only moves forward.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5701);

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
/** Oct 2026 wall clock in EDT (UTC-4; DST ends Nov 1 2026). */
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 27, 10, 0).getTime() - RealDate.now();
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
let last = edt(10, 27, 10, 0).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};

installNextStubs();

// ---- Slack, faked at fetch and counted --------------------------------------
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length).split("?")[0];
  let body: { channel?: string; text?: string } = {};
  try { body = typeof init?.body === "string" ? JSON.parse(init.body) : {}; } catch { body = {}; }
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true, ts: String(slack.length) });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

const S = { jordan: "U0JORDAN27", kyle: "U0KYLE0027", james: "U0JAMES027", kim: "U0KIMMIG27" };

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { putSetting } = await import("@/lib/settings");
    const R = await import("@/lib/notifyRoles");
    const { notifyInApp } = await import("@/lib/notify");
    const { allSlackKey } = await import("@/lib/notifyAllSlack");
    const { announceCutInReview } = await import("@/lib/reviewCuts");
    const ops = await import("@/lib/photoDelivery/notifyOps");
    const eve = await import("@/lib/eveningPush");
    const { buildOpsDay } = await import("@/lib/opsDay");
    const defaults = await import("@/lib/notifyPrefDefaults");
    const sched = await import("@/lib/notifySchedule");

    // OpenPhone: the number lookup and the send, answered in-process.
    const op = await import("@/lib/integrations/openphone");
    (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: "+16105550100" }];
    (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async () => ({ data: { id: "op-drill" } });
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    // ---- the cast, as production has it (every row BEFORE the first notify:
    // the stack caches the owner, office and creative lists ten minutes) ----
    type TeamRole = "ADMIN" | "MANAGER" | "PHOTOGRAPHER" | "EDITOR" | "VA";
    const member = (name: string, email: string, role: TeamRole, phone: string | null, slackId: string, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email, role, phone, slackId, active: true, ...extra }, select: { id: true, name: true } });
    const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111", S.jordan, { opsAlerts: true });
    const kyle = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", "+16105550100", S.kyle, { opsAlerts: true });
    const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", S.james, { creativeManager: true });
    const kim = await member("Kim Miguel", "kim@drill.invalid", "MANAGER", "+63 917 555 0101", S.kim);
    const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
    await login("jordan@drill.invalid", "OWNER", jordan.id);
    const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
    await login("james@drill.invalid", "CREATIVE_MANAGER", james.id);
    await login("kim@drill.invalid", "EDITOR", kim.id, { editorKey: "kim" });
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith" } });
    // Saved switches as production has them: Jordan Slack + text for tags,
    // cuts and shoot changes, and everything on Slack (Oct 22); Kyle Slack for
    // tags and cuts; James a text for cuts and for job pings.
    const off = { slack: false, sms: false };
    const allOff = { mention: off, project_message: off, job_ping: off, review_ready: off, shoot_change: off };
    await putSetting(`notify-prefs:${jordan.id}`, { ...allOff, mention: { slack: true, sms: true }, review_ready: { slack: true, sms: true }, shoot_change: { slack: true, sms: true } });
    await putSetting(`notify-prefs:${kyle.id}`, { ...allOff, mention: { slack: true, sms: false }, review_ready: { slack: true, sms: false } });
    await putSetting(`notify-prefs:${james.id}`, { ...allOff, review_ready: { slack: false, sms: true }, job_ping: { slack: false, sms: true } });
    await putSetting(allSlackKey(jordan.id), { on: true });
    // The Review Room seats as Jordan set them: James first, Kyle backup, Jordan fallback.
    await putSetting("review_room", {
      discoverFromDropbox: false, keepUploadsDays: 90,
      creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
      coverOfferHours: 9, coverTransferHours: null,
    });

    // ---- helpers -----------------------------------------------------------
    const dms = (slackId: string, since: number) => slack.slice(since).filter((m) => m.channel === slackId);
    const textsFor = (tmId: string) => prisma.pendingSms.count({ where: { teamMemberId: tmId } });
    const rowsOf = (kind: string, dedupePrefix: string) =>
      prisma.notification.findMany({ where: { kind, dedupeKey: { startsWith: dedupePrefix } }, select: { userKey: true, audience: true, body: true } });
    const legs = (tmId: string, kind: string) =>
      prisma.notificationDelivery.findMany({ where: { teamMemberId: tmId, kind }, select: { channel: true, status: true } });
    const client = await prisma.client.create({ data: { name: "Drill Homeowner" }, select: { id: true } });
    const mkJob = async (street: string) => {
      const p = await prisma.project.create({ data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "REVIEW", addressLine: street }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
      return { id: p.id, deliverableId: d.id, street };
    };
    let round = 0;
    const mkCut = async (job: { id: string; deliverableId: string }, reviewer: string | null) =>
      (await prisma.reviewSubmission.create({
        data: {
          projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: ++round, kind: "video", source: "upload", status: "PENDING",
          fileName: `cut-${round}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel", reviewerTeamMemberId: reviewer,
        },
        select: { id: true },
      })).id;
    const announce = (job: { id: string; street: string }, id: string, reviewer: { teamMemberId: string; name: string }, ownerActed = false) =>
      announceCutInReview({ kind: "cut_ready", projectId: job.id, submissionId: id, round: 1, street: job.street, fileName: "cut.mp4", editorKey: "kim", editorName: "Kim Miguel", reviewer, ownerActed });
    const cutRows = (id: string) => prisma.notification.findMany({ where: { kind: "cut_ready", href: { contains: id } }, select: { userKey: true, audience: true } });

    // =========================================================================
    c.head("1 · the table, per kind and seat (notifyRoles.ts)");
    // =========================================================================
    const expect: [string, "owner" | "office" | "creative", string][] = [
      ["cut_ready", "owner", "theirs"], ["cut_ready", "office", "theirs"], ["cut_ready", "creative", "ping"],
      ["review_approved", "owner", "drop"], ["review_approved", "creative", "bell"], ["review_approved", "office", "ping"],
      ["review_changes", "owner", "drop"], ["review_changes", "creative", "bell"],
      ["revision_raised", "owner", "drop"], ["revision_raised", "office", "ping"], ["revision_raised", "creative", "ping"],
      ["revision_resolved", "owner", "drop"], ["revision_resolved", "creative", "drop"], ["revision_resolved", "office", "ping"],
      ["edit_started", "owner", "drop"], ["edit_started", "office", "ping"],
      ["new_lead", "owner", "drop"], ["new_lead", "office", "ping"],
      ["topic_suggestions_ready", "owner", "drop"],
      ["portal_comment", "owner", "drop"], ["portal_comment", "office", "drop"], ["portal_comment", "creative", "ping"],
      ["portal_script_approved", "owner", "ping"], ["portal_script_approved", "office", "drop"],
      ["photo_free_check", "owner", "drop"], ["photo_autohdr_failed", "owner", "drop"], ["photo_autohdr_failed", "office", "ping"],
      // Kept for Jordan: errors, escalations, client complaints, delegation, money, business risk.
      ["error_report", "owner", "ping"], ["behind_alert", "owner", "ping"], ["photos_undelivered", "owner", "ping"],
      ["review_escalation", "owner", "ping"], ["reply_sla", "owner", "ping"], ["client_feedback", "owner", "ping"],
      ["task_assigned", "owner", "ping"], ["program_message", "owner", "ping"], ["autohdr_credits_low", "owner", "ping"],
      ["photo_autohdr_billing", "owner", "ping"], ["order_canceled", "owner", "ping"],
      // Kept for Kyle and James: their lanes.
      ["topaz_ready", "office", "ping"], ["appointment_change", "creative", "ping"], ["raws_missing", "creative", "ping"],
      ["instructions_missing", "creative", "ping"], ["creative_review", "creative", "ping"],
    ];
    const wrong = expect.filter(([k, s, r]) => R.seatRoute(k, s) !== r).map(([k, s, r]) => `${k}/${s}: ${R.seatRoute(k, s)} (want ${r})`);
    c.ok(`${expect.length} kind × seat routes match the decision table`, wrong.length === 0, wrong.join("; "));
    c.ok("Jordan's seat only ever uses ping, theirs or drop (his everything-on-Slack stays whole)", Object.values(R.ROLE_ROUTES).every((r) => r.owner === undefined || r.owner !== "bell"));
    c.ok("roles map to seats: OWNER → owner, ADMIN → office, CREATIVE_MANAGER → creative, the rest none",
      R.seatOfRole("OWNER") === "owner" && R.seatOfRole("ADMIN") === "office" && R.seatOfRole("CREATIVE_MANAGER") === "creative" && R.seatOfRole("EDITOR") === null && R.seatOfRole("PHOTOGRAPHER") === null);
    const book = { owners: new Set(["J"]), creatives: new Set(["M"]), office: new Set(["K", "M"]) };
    const seatOf = (id: string) => R.seatOfMember(id, book);
    c.ok("a roster row's seat: owner first, then creative, then office", seatOf("J") === "owner" && seatOf("M") === "creative" && seatOf("K") === "office" && seatOf("H") === null);
    c.ok("'named in the call' counts seats only, never an editor or a photographer",
      R.namedSeatInCall([{ userKey: "tm:M" }], seatOf) && !R.namedSeatInCall([{ userKey: "tm:H" }, { userKey: "editor:kim" }, { userKey: null }], seatOf));
    const echo = R.routeTarget("mention", { roles: ["ADMIN"], userKey: "tm:K" }, { seatOf, namedInCall: true, actor: "K" });
    c.ok("ECHO: a row addressed to the person who caused it is dropped, whatever the kind", !echo.keep && echo.why === "echo");
    const named = R.routeTarget("review_approved", { roles: ["OWNER"], userKey: "tm:J" }, { seatOf, namedInCall: true, actor: "K" });
    c.ok("a named row for a dropped seat goes (Jordan's review_approved)", !named.keep && named.why === "route");
    const bell = R.routeTarget("review_approved", { roles: ["ADMIN"], userKey: "tm:M" }, { seatOf, namedInCall: true, actor: "K" });
    c.ok("a named row for a bell seat stays, muted to the bell (James's review_approved)", bell.keep && bell.mute === "channels");
    const fyi = R.routeTarget("cut_ready", { roles: ["OWNER"] }, { seatOf, namedInCall: true });
    const dark = R.routeTarget("cut_ready", { roles: ["OWNER", "ADMIN"] }, { seatOf, namedInCall: false });
    c.ok("'theirs': a broadcast copy goes while a seat is named, and stays when nobody is (never dark)",
      !fyi.keep && dark.keep && JSON.stringify(dark.roles) === JSON.stringify(["OWNER", "ADMIN"]));
    const lead = R.routeTarget("new_lead", { roles: ["OWNER", "ADMIN"] }, { seatOf, namedInCall: false });
    c.ok("a broadcast loses only the dropped seat's role (new_lead → ADMIN)", lead.keep && JSON.stringify(lead.roles) === JSON.stringify(["ADMIN"]));
    const untouched = R.routeTarget("raws_missing", { roles: ["PHOTOGRAPHER"], userKey: "tm:H" }, { seatOf, namedInCall: false });
    c.ok("a kind the table does not list is untouched (raws_missing to a photographer)", untouched.keep && untouched.mute === undefined);
    c.ok("photo pipeline: Jordan's copy goes only when Kyle has one",
      ops.ownerSkips("photo_free_check", "K", "J") && !ops.ownerSkips("photo_free_check", null, "J") && !ops.ownerSkips("photo_free_check", "J", "J") && !ops.ownerSkips("autohdr_credits_low", "K", "J") && !ops.ownerSkips("photo_autohdr_billing", "K", "J"));

    // =========================================================================
    c.head("2 · a cut in review: James's every cut, one text per pile; Jordan only when it is his");
    // =========================================================================
    const jamesSeat = { teamMemberId: james.id, name: "James Livingston" };
    const jordanSeat = { teamMemberId: jordan.id, name: "Jordan Spackman" };
    {
      const jA = await mkJob("12 First Cut Ln");
      const cutA = await mkCut(jA, james.id);
      const s0 = slack.length;
      const t0 = { james: await textsFor(james.id), jordan: await textsFor(jordan.id), kyle: await textsFor(kyle.id) };
      await announce(jA, cutA, jamesSeat);
      const rA = await cutRows(cutA);
      c.ok("James's row, by name", rA.some((r) => r.userKey === `tm:${james.id}`), JSON.stringify(rA.map((r) => r.userKey)));
      c.ok("…and his text: the first cut of a pile (his switch says text)", (await textsFor(james.id)) === t0.james + 1);
      c.ok("Jordan has no row for it: no FYI broadcast, nothing by name (Oct 27 2026)", !rA.some((r) => r.userKey === null || r.userKey === `tm:${jordan.id}`), JSON.stringify(rA));
      c.ok("…no Slack DM (not even his everything-on-Slack mirror) and no text", dms(S.jordan, s0).length === 0 && (await textsFor(jordan.id)) === t0.jordan, dms(S.jordan, s0).map((m) => m.text).join(" | "));
      c.ok("Kyle (backup seat) hears nothing about a cut James has (Oct 22, unchanged)", !rA.some((r) => r.userKey === `tm:${kyle.id}`) && dms(S.kyle, s0).length === 0);

      const jB = await mkJob("14 Second Cut Ln");
      const cutB = await mkCut(jB, james.id);
      const s1 = slack.length;
      await announce(jB, cutB, jamesSeat);
      const rB = await cutRows(cutB);
      c.ok("a second cut while the first waits: James's bell rings again", rB.some((r) => r.userKey === `tm:${james.id}`));
      c.ok("…but no second text (one text per pile)", (await textsFor(james.id)) === t0.james + 1, String(await textsFor(james.id)));
      c.ok("…and still nothing to Jordan or Kyle", !rB.some((r) => r.userKey === null || r.userKey === `tm:${jordan.id}` || r.userKey === `tm:${kyle.id}`) && dms(S.jordan, s1).length === 0 && dms(S.kyle, s1).length === 0);
      // The pile cleared: the next cut texts again.
      await prisma.reviewSubmission.updateMany({ where: { id: { in: [cutA, cutB] } }, data: { status: "APPROVED", decidedAt: new Date() } });
      const jC = await mkJob("16 Fresh Pile Rd");
      const cutC = await mkCut(jC, james.id);
      await announce(jC, cutC, jamesSeat);
      c.ok("once his pile is cleared, the next cut texts him again", (await textsFor(james.id)) === t0.james + 2, String(await textsFor(james.id)));
    }
    {
      const jJ = await mkJob("20 Owner Review Ct");
      const cutJ = await mkCut(jJ, jordan.id);
      const s0 = slack.length;
      const t0 = await textsFor(jordan.id);
      const tj0 = await textsFor(james.id);
      await announce(jJ, cutJ, jordanSeat);
      const rJ = await cutRows(cutJ);
      c.ok("a cut Jordan reviews: ONE row for him, addressed to him by name (no broadcast beside it)", rJ.filter((r) => r.userKey === `tm:${jordan.id}`).length === 1 && !rJ.some((r) => r.userKey === null), JSON.stringify(rJ));
      c.ok("…James (the chain's other seat) keeps his FYI row, never a text", rJ.some((r) => r.userKey === `tm:${james.id}`) && !rJ.some((r) => r.userKey === `tm:${kyle.id}`) && (await textsFor(james.id)) === tj0);
      c.ok("…his Slack DM says it is waiting on him", dms(S.jordan, s0).some((m) => /waiting on you/i.test(m.text) && /20 Owner Review Ct/.test(m.text)), dms(S.jordan, s0).map((m) => m.text).join(" | "));
      c.ok("…and his text, by his switch", (await textsFor(jordan.id)) === t0 + 1);
      const jO = await mkJob("22 Own Upload Way");
      const cutO = await mkCut(jO, jordan.id);
      const s1 = slack.length;
      const t1 = await textsFor(jordan.id);
      await announce(jO, cutO, jordanSeat, true);
      const rO = await cutRows(cutO);
      c.ok("his own upload: the bell row, no Slack, no text", rO.some((r) => r.userKey === `tm:${jordan.id}`) && dms(S.jordan, s1).length === 0 && (await textsFor(jordan.id)) === t1, dms(S.jordan, s1).map((m) => m.text).join(" | "));
    }
    {
      // No seat named (no chain): the office broadcast stands, so a cut never goes dark.
      const s0 = slack.length;
      await notifyInApp({ kind: "cut_ready", title: "Video in review — 24 Nobody St", href: "/review/x?cut=nobody", targets: [{ roles: ["OWNER", "ADMIN"], ownerSms: "Video in review — 24 Nobody St." }], dedupeKey: "drill-nobody" });
      const r = await rowsOf("cut_ready", "drill-nobody");
      c.ok("a cut with no seat named keeps the OWNER+ADMIN broadcast", r.length === 1 && JSON.stringify(JSON.parse(r[0].audience)) === JSON.stringify(["OWNER", "ADMIN"]), JSON.stringify(r));
      c.ok("…and its sentence reaches Kyle's Slack (his switch)", dms(S.kyle, s0).length >= 1);
      // The same broadcast caused by Kyle: his own leg is skipped (echo on a broadcast).
      const s1 = slack.length;
      await notifyInApp({ kind: "cut_ready", title: "Video in review — 26 Kyle Upload St", href: "/review/x?cut=kyle", targets: [{ roles: ["OWNER", "ADMIN"], ownerSms: "Video in review — 26 Kyle Upload St." }], dedupeKey: "drill-kyle-upload", actorTeamMemberId: kyle.id });
      c.ok("ECHO on a broadcast: Kyle caused it, so no DM to Kyle; Jordan still hears", dms(S.kyle, s1).length === 0 && dms(S.jordan, s1).length >= 1, `kyle ${dms(S.kyle, s1).length}, jordan ${dms(S.jordan, s1).length}`);
    }

    // =========================================================================
    c.head("3 · verdicts: none for Jordan, bell only for James, never about your own press");
    // =========================================================================
    {
      const seats = (extra: object = {}) => [
        { roles: ["OWNER" as const], userKey: `tm:${jordan.id}` },
        { roles: ["ADMIN" as const], userKey: `tm:${james.id}`, slackDm: "Approved — 30 Verdict Rd.", ...extra },
        { roles: ["EDITOR" as const], userKey: "editor:kim", href: "/edit/x" },
      ];
      const s0 = slack.length;
      const tJ = await textsFor(james.id);
      const tO = await textsFor(jordan.id);
      await notifyInApp({ kind: "review_approved", title: "Cut approved — 30 Verdict Rd", body: "Approved by Kyle Smith. The Topaz pass is running.", href: "/projects/x", targets: seats(), dedupeKey: "drill-approved-kyle", actorTeamMemberId: kyle.id });
      const r1 = await rowsOf("review_approved", "drill-approved-kyle");
      c.ok("Kyle approves: Jordan has no row (Oct 27 2026)", !r1.some((r) => r.userKey === `tm:${jordan.id}`), JSON.stringify(r1.map((r) => r.userKey)));
      c.ok("…James has his row; Kim keeps hers", r1.some((r) => r.userKey === `tm:${james.id}`) && r1.some((r) => r.userKey === "editor:kim"));
      c.ok("…James's copy is the bell only: no text though his job-ping switch says text, no Slack",
        (await textsFor(james.id)) === tJ && dms(S.james, s0).length === 0, `texts ${(await textsFor(james.id)) - tJ}`);
      const lJ = await legs(james.id, "review_approved");
      c.ok("…the delivery log has his bell and nothing else", lJ.length === 1 && lJ[0].channel === "bell", JSON.stringify(lJ));
      c.ok("…and Jordan gets no Slack mirror and no text for it", dms(S.jordan, s0).length === 0 && (await textsFor(jordan.id)) === tO);

      await notifyInApp({ kind: "review_approved", title: "Cut approved — 32 Own Press Rd", body: "Approved by James Livingston.", href: "/projects/y", targets: seats(), dedupeKey: "drill-approved-james", actorTeamMemberId: james.id });
      const r2 = await rowsOf("review_approved", "drill-approved-james");
      c.ok("James approves: no row tells James about his own press (echo), none to Jordan", !r2.some((r) => r.userKey === `tm:${james.id}` || r.userKey === `tm:${jordan.id}`) && r2.some((r) => r.userKey === "editor:kim"), JSON.stringify(r2.map((r) => r.userKey)));

      const s2 = slack.length;
      await notifyInApp({ kind: "review_changes", title: "Changes requested — 34 Send Back Rd", body: "Jordan Spackman sent back 1 note: trim the intro", href: "/edit/z", targets: seats(), dedupeKey: "drill-changes-jordan", actorTeamMemberId: jordan.id });
      const r3 = await rowsOf("review_changes", "drill-changes-jordan");
      c.ok("Jordan sends one back: his own row is not written; James's is, bell only", !r3.some((r) => r.userKey === `tm:${jordan.id}`) && r3.some((r) => r.userKey === `tm:${james.id}`) && (await textsFor(james.id)) === tJ && dms(S.james, s2).length === 0);
      c.ok("…and no all-Slack mirror of his own press", dms(S.jordan, s2).length === 0);

      // The control: the same switch DOES text James for a client's revision ask.
      const tR = await textsFor(james.id);
      await notifyInApp({ kind: "revision_raised", title: "Revision requested — 36 Client Ask Ln", body: "Mike asked for changes on video 2.", href: "/projects/r", targets: [{ roles: ["ADMIN", "OWNER"] }, { roles: ["CREATIVE_MANAGER"], userKey: `tm:${james.id}`, slackDm: "Mike asked for changes on 36 Client Ask Ln." }], dedupeKey: "drill-revision" });
      const r4 = await rowsOf("revision_raised", "drill-revision");
      const bc = r4.find((r) => r.userKey === null);
      c.ok("a client's revision ask still texts James (his job-ping switch): the bell-only rule is the verdicts'", (await textsFor(james.id)) === tR + 1);
      c.ok("…and its broadcast is the office's only: OWNER is gone (Kyle owns client revisions)", !!bc && JSON.stringify(JSON.parse(bc.audience)) === JSON.stringify(["ADMIN"]), bc?.audience ?? "none");
    }

    // =========================================================================
    c.head("4 · the CEO's bell: routine steps leave it, errors, risk and money stay");
    // =========================================================================
    {
      const s0 = slack.length;
      await notifyInApp({ kind: "topic_suggestions_ready", title: "New topic ideas for Erica Walker", href: "/content", targets: [{ roles: ["OWNER"] }], dedupeKey: "drill-topics" });
      c.ok("topic suggestions: no row at all (the 6 PM wrap lists them)", (await rowsOf("topic_suggestions_ready", "drill-topics")).length === 0);
      await notifyInApp({ kind: "new_lead", title: "New lead — Ann Buyer", href: "/queue", targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey: "drill-lead" });
      const lead = await rowsOf("new_lead", "drill-lead");
      c.ok("a new lead: Kyle's row (ADMIN), not Jordan's", lead.length === 1 && JSON.stringify(JSON.parse(lead[0].audience)) === JSON.stringify(["ADMIN"]), JSON.stringify(lead));
      await notifyInApp({ kind: "edit_started", title: "Kim started 38 Edit St", href: "/edit/e", targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey: "drill-edit-start" });
      const es = await rowsOf("edit_started", "drill-edit-start");
      c.ok("an editor pressing Start: Kyle's bell (he dispatched it), not Jordan's", es.length === 1 && JSON.stringify(JSON.parse(es[0].audience)) === JSON.stringify(["ADMIN"]), JSON.stringify(es));
      await notifyInApp({ kind: "portal_comment", title: "Erica left a comment", href: "/content", targets: [{ roles: ["OWNER", "ADMIN", "CREATIVE_MANAGER"] }], dedupeKey: "drill-portal-comment" });
      const pc = await rowsOf("portal_comment", "drill-portal-comment");
      c.ok("a portal comment: the creative manager's (James), not the CEO's or the office's", pc.length === 1 && JSON.stringify(JSON.parse(pc[0].audience)) === JSON.stringify(["CREATIVE_MANAGER"]), JSON.stringify(pc));
      c.ok("…none of these reached Jordan's Slack mirror", dms(S.jordan, s0).length === 0, dms(S.jordan, s0).map((m) => m.text).join(" | "));

      const s1 = slack.length;
      await notifyInApp({ kind: "behind_alert", title: "Photos late: 40 Late Ln", href: "/jobs", targets: [{ roles: ["OWNER"] }], dedupeKey: "drill-behind" });
      await notifyInApp({ kind: "error_report", title: "Error: Aryeo sync failed", href: "/system", targets: [{ roles: ["OWNER"] }], dedupeKey: "drill-error" });
      c.ok("business risk and errors stay Jordan's: both rows written", (await rowsOf("behind_alert", "drill-behind")).length === 1 && (await rowsOf("error_report", "drill-error")).length === 1);
      c.ok("…and both reach his Slack (everything-on-Slack, Oct 22)", dms(S.jordan, s1).length === 2, dms(S.jordan, s1).map((m) => m.text).join(" | "));

      await ops.alertOwnerAndKyle({ kind: "photo_autohdr_failed", title: "AutoHDR batch failed: 42 Photo Rd", href: "/ops/photo-delivery", dedupeKey: "drill-pd-failed", text: "failed", to: "both" });
      const pf = await prisma.notification.findMany({ where: { kind: "photo_autohdr_failed" }, select: { userKey: true } });
      c.ok("a photo problem: Kyle's row, not Jordan's (the pipeline is Kyle's lane)", pf.some((r) => r.userKey === `tm:${kyle.id}`) && !pf.some((r) => r.userKey === `tm:${jordan.id}`), JSON.stringify(pf));
      await ops.alertOwnerAndKyle({ kind: "photo_autohdr_billing", title: "AutoHDR credits fell while a shoot was editing", href: "/ops/photo-delivery/credits", dedupeKey: "drill-pd-billing", text: "billing", to: "owner" });
      const pb = await prisma.notification.findMany({ where: { kind: "photo_autohdr_billing" }, select: { userKey: true } });
      c.ok("an owner-only photo alert (AutoHDR billing, money) still reaches Jordan alone", pb.some((r) => r.userKey === `tm:${jordan.id}`) && !pb.some((r) => r.userKey === `tm:${kyle.id}`), JSON.stringify(pf));
    }

    // =========================================================================
    c.head("5 · money stays clamped for the creative manager");
    // =========================================================================
    {
      await notifyInApp({ kind: "revision_raised", title: "Revision requested — 44 Money Ln", body: "Client paid $1,250 and asked for a new intro.", href: "/projects/m", targets: [{ roles: ["CREATIVE_MANAGER"], userKey: `tm:${james.id}`, slackDm: "Client paid $1,250 and asked for a new intro." }], dedupeKey: "drill-money" });
      const m = await rowsOf("revision_raised", "drill-money");
      const lastText = await prisma.pendingSms.findFirst({ where: { teamMemberId: james.id }, orderBy: { createdAt: "desc" }, select: { line: true } });
      c.ok("James's row has no dollar figure", m.length === 1 && !/\$\s?1,?250/.test(m[0].body ?? ""), m[0]?.body ?? "none");
      c.ok("…nor does his text", !/\$\s?1,?250/.test(lastText?.line ?? ""), lastText?.line ?? "none");
    }

    // =========================================================================
    c.head("6 · the 6 PM wrap: the day's leads (both copies), topic suggestions (Jordan's only)");
    // =========================================================================
    {
      const day = await buildOpsDay();
      const base = {
        now: edt(10, 27, 18, 0), day: { ...day, closeout: { ...day.closeout } }, board: { today: [], tomorrow: [], upcoming: [], delivered: [], overdueCount: 0 },
        editorOf: new Map(), kyleFirst: "Kyle", kyleAsks: [], jordanAsksOld: [], cutsWaitingOnJordan: 0, photoDecisions: 0, link: "https://hub.invalid/",
      } as Parameters<typeof eve.composeEveningWrap>[0];
      const w = eve.composeEveningWrap({ ...base, newLeads: [{ name: "Ann Buyer", open: true }, { name: "Bob Seller", open: false }], topicSuggestions: [{ client: "Erica Walker", count: 6 }, { client: "Bernadette Rabel", count: 4 }] });
      c.ok("Jordan's wrap lists the leads, how many still open", /New leads since the last wrap \(2, 1 still open\): .*Ann Buyer/.test(w.text), w.text);
      c.ok("…and the topic suggestions, one line, per client with counts", /Topic suggestions to review \(2 clients\): Erica Walker \(6\)/.test(w.text) && /Bernadette Rabel \(4\)/.test(w.text));
      c.ok("Kyle's copy has the leads and not the topic line (not his)", /New leads since the last wrap/.test(w.officeText) && !/Topic suggestions/.test(w.officeText), w.officeText);
      c.ok("no em or en dashes in either copy", !/[–—]/.test(w.text) && !/[–—]/.test(w.officeText));
      const quietDay = eve.composeEveningWrap(base);
      c.ok("nothing new: neither line appears", !/New leads|Topic suggestions/.test(quietDay.text));
    }

    // =========================================================================
    c.head("7 · the Saturday rule is unchanged: Jordan held until 7:30 PM, nobody else");
    // =========================================================================
    {
      c.ok("Jordan's preset is Saturday 12 AM to 7:30 PM, as before", JSON.stringify(defaults.OWNER_PRESET_WINDOWS) === JSON.stringify([{ day: 6, from: 0, to: 19 * 60 + 30 }]), JSON.stringify(defaults.OWNER_PRESET_WINDOWS));
      const sat10 = edt(10, 31, 10, 0);
      const jHold = await sched.holdFor(jordan.id, sat10);
      c.ok("Saturday 10 AM: Jordan's notices wait until 7:30 PM", !!jHold && jHold.getTime() === edt(10, 31, 19, 30).getTime(), jHold?.toISOString() ?? "null");
      c.ok("Saturday 8 PM: Jordan is not held", (await sched.holdFor(jordan.id, edt(10, 31, 20, 0))) === null);
      c.ok("Tuesday 10 AM: Jordan is not held", (await sched.holdFor(jordan.id, edt(10, 27, 10, 0))) === null);
      c.ok("Saturday 10 AM: Kyle and James are not held (anyone, any hour)", (await sched.holdFor(kyle.id, sat10)) === null && (await sched.holdFor(james.id, sat10)) === null);
      setClock(sat10);
      const s0 = slack.length;
      await notifyInApp({ kind: "behind_alert", title: "Photos late: 46 Saturday Ln", href: "/jobs", targets: [{ roles: ["OWNER"] }], dedupeKey: "drill-sat-behind" });
      const held = (await prisma.appSetting.findMany({ where: { key: { startsWith: `held-dm:${jordan.id}:` } }, select: { value: true } })).map((r) => JSON.parse(r.value) as { text?: string; until?: string });
      c.ok("end to end, Saturday 10 AM: Jordan's kept alert is held, not sent", dms(S.jordan, s0).length === 0 && held.some((h) => /46 Saturday Ln/.test(h.text ?? "")), `sent ${dms(S.jordan, s0).length}, held ${JSON.stringify(held)}`);
    }

    // =========================================================================
    c.head("8 · FENCE");
    c.ok("nothing reached a provider: only the faked Slack answered", fence.faked.every((u) => u.startsWith("https://slack.com/api/")), fence.faked.filter((u) => !u.startsWith("https://slack.com/api/")).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
