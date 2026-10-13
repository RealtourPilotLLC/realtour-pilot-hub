// ---------------------------------------------------------------------------
// DRILL: THE CLIENT ACTIVITY SCREEN (Oct 14 2026).
//
// Jordan: "Make sure I have an activity screen so I can track and see all of
// our clients' activity." /content/activity reads lib/clientActivity.ts, which
// reads only ledgers the portal already writes. This drill seeds them and
// checks what the owner is shown.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/oct14-client-activity.ts
//
//   1. Pure rules: the 30-minute collapse (30 min merges, 31 splits, one person
//      at a time), the reload rule, section and download paths, the health chip.
//   2. The summary for a TEST client "Activity Client TEST" with LOGIN, TOKEN
//      and STAFF visits, a script approval, a change request, a topic pick, a
//      message and a download: the account, first sign-in, welcome email, last
//      seen (STAFF excluded), visits 7d / 30d, actions 7d, the chip and what is
//      waiting on them (the portal's own Home list).
//   3. TEST clients come back in their own group and are not counted in the
//      chips; real clients are (Not invited, Never signed in).
//   4. The feed: newest first, the exact words, STAFF visits and staff acts
//      left out, the collapse, the Calendly booking shown but not counted, and
//      "Load older" paging with no overlap. The all-clients feed hides TEST.
//   5. The page: owner and admin only, and its copy carries no em dash.
//
// ISOLATION: PGlite on 127.0.0.1 via the shared harness. Production is never
// opened; every outbound call is fenced; nothing is sent.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6983);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
const fence = fenceFetch();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const ca = await import("@/lib/clientActivity");
  const { etDateTime } = await import("@/lib/datetime");

  try {
    // =======================================================================
    c.head("1 · the pure rules");
    // =======================================================================
    const t0 = new Date("2026-10-14T13:00:00Z");
    const v = (id: string, offMin: number, over: Partial<{ enrollmentId: string; clientUserId: string | null; via: string; path: string }> = {}) => ({
      id, enrollmentId: over.enrollmentId ?? "e1", clientUserId: over.clientUserId === undefined ? "u1" : over.clientUserId, via: over.via ?? "LOGIN", path: over.path ?? "/portal/me", createdAt: new Date(t0.getTime() + offMin * MIN),
    });
    const g1 = ca.collapseVisits([v("a", 0), v("b", 30), v("c", 61)]);
    c.ok("exactly 30 minutes apart is the same visit; 31 is a new one", g1.length === 2 && g1[1].pages === 2 && g1[0].pages === 1, JSON.stringify(g1.map((g) => g.pages)));
    c.ok("groups come back newest first", g1[0].start.getTime() > g1[1].start.getTime());
    const g2 = ca.collapseVisits([v("a", 0), v("b", 5, { clientUserId: "u2" }), v("c", 10), v("d", 12, { clientUserId: null, via: "TOKEN" })]);
    c.ok("one person at a time: two people and the shared link are three visits", g2.length === 3 && g2.find((g) => g.clientUserId === "u1")?.pages === 2, JSON.stringify(g2.map((g) => [g.clientUserId, g.pages])));
    const burst = Array.from({ length: 30 }, (_, i) => ({ ...v(`r${i}`, 0), createdAt: new Date(t0.getTime() + i * 200) }));
    const g3 = ca.collapseVisits(burst);
    c.ok("30 renders 0.2 s apart are one page view (30 loads)", g3.length === 1 && g3[0].pages === 1 && g3[0].loads === 30, JSON.stringify(g3.map((g) => [g.pages, g.loads])));
    c.ok("a path with ?tab=plan names Your Month; the pathname alone names nothing", ca.sectionOfPath("/portal/me?tab=plan") === "Your Month" && ca.sectionOfPath("/portal/me?tab=library") === "Content Library" && ca.sectionOfPath("/portal/me") === null && ca.sectionOfPath("/portal/[token]") === null);
    c.ok("download and posted paths are actions, not page views", ca.pathAction("/portal/download/cmu5or1bx00939k8m5fwmy7f1?cut=x")?.kind === "DOWNLOAD" && ca.pathAction("/portal/posted/cmu5lvqdt00029k0cq77qgct8?undo=1")?.kind === "UNPOSTED" && ca.pathAction("/portal/posted/cmu5lvqdt00029k0cq77qgct8")?.kind === "POSTED" && ca.isPageView("/portal/me") && !ca.isPageView("/portal/download/cmu5or1bx00939k8m5fwmy7f1"));
    const h = (o: Partial<Parameters<typeof ca.healthOf>[0]>) => ca.healthOf({ account: "NONE", welcomeSentAt: null, lastSeenAt: null, visits7: 0, actions7: 0, ...o });
    c.ok("health: a visit or an action this week is Active", h({ visits7: 1 }) === "ACTIVE" && h({ actions7: 1, account: "NONE" }) === "ACTIVE");
    c.ok("health: signed up (or seen) and nothing this week is Quiet", h({ account: "SIGNED_UP" }) === "QUIET" && h({ lastSeenAt: t0 }) === "QUIET");
    c.ok("health: invited or emailed, never seen, is Never signed in", h({ account: "INVITED" }) === "NEVER" && h({ welcomeSentAt: t0 }) === "NEVER");
    c.ok("health: nothing at all is Not invited", h({}) === "NOT_INVITED");
    c.ok("the chip words are Jordan's", ca.HEALTH.ACTIVE.label === "Active this week" && ca.HEALTH.QUIET.label === "Quiet 7+ days" && ca.HEALTH.NEVER.label === "Never signed in" && ca.HEALTH.NOT_INVITED.label === "Not invited");

    // =======================================================================
    c.head("2 · one TEST client's month, seeded");
    // =======================================================================
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const A = await buildContentMonth(prisma as never, {
      name: "Activity Client TEST", package: "Accelerator", monthKey: (await import("@/lib/contentProgram")).etMonthKey(now),
      topics: [
        { title: "First-time buyers", selection: "SELECTED", clientVisible: true, topicStatus: "SCRIPTED" },
        { title: "Open house tips", selection: "SELECTED", clientVisible: true, topicStatus: "SCRIPTED" },
        { title: "Spring market", selection: "SELECTED", clientVisible: true },
        { title: "Kitchen tour", selection: null, clientVisible: true },
      ],
      owner: { name: "Arielle Example", email: "arielle@example.com" },
    });
    const owner = A.clientUserId!;
    await prisma.clientMembership.update({ where: { id: A.membershipId! }, data: { acceptedAt: ago(4 * DAY), invitedAt: ago(5 * DAY) } });
    await prisma.clientUser.update({ where: { id: owner }, data: { lastLoginAt: ago(121 * MIN) } });
    const [tBuyers, tOpen, tSpring, tKitchen] = A.topicIds;
    // Three scripts on the client's page: one awaiting them, one they approved, one they asked to change.
    const script = async (topicId: string, title: string) => {
      const s = await prisma.contentScript.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, topicId, title, body: `${title} body`, status: "CLIENT_VISIBLE", clientVisible: true, releaseState: "released" } });
      const ver = await prisma.contentScriptVersion.create({ data: { scriptId: s.id, enrollmentId: A.enrollmentId, clientId: A.clientId, versionNo: 1, title, hook: "A hook.", pointsJson: JSON.stringify([{ role: "RE_HOOK", text: "One." }, { role: "BUILD_UP", text: "Two." }, { role: "PAYOFF", text: "Three." }]), close: "Call me.", body: `${title} body`, source: "AI", status: "SHARED", sharedAt: ago(DAY) } });
      await prisma.contentScript.update({ where: { id: s.id }, data: { sharedVersionId: ver.id, approvedVersionId: ver.id, currentVersionId: ver.id } });
      return { id: s.id, versionId: ver.id };
    };
    const sAwait = await script(tSpring, "Spring market");
    const sApproved = await script(tBuyers, "First-time buyers");
    const sChanges = await script(tOpen, "Open house tips");
    void sAwait;
    const NOTE = "Please swap the opening line for something about spring buyers, keep it shorter than the first draft, and mention the school district by name at the end.";
    await prisma.contentScriptRelease.create({ data: { scriptId: sApproved.id, scriptVersionId: sApproved.versionId, enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, action: "CLIENT_APPROVED", actorClientUserId: owner, actorEmail: "Arielle Example", createdAt: ago(110 * MIN) } });
    await prisma.contentScript.update({ where: { id: sApproved.id }, data: { clientApprovedVersionId: sApproved.versionId, clientApprovedAt: ago(110 * MIN), clientApprovedByUserId: owner } });
    await prisma.contentScriptRelease.create({ data: { scriptId: sChanges.id, scriptVersionId: sChanges.versionId, enrollmentId: A.enrollmentId, clientId: A.clientId, monthId: A.monthId, action: "CLIENT_CHANGES", actorClientUserId: owner, actorEmail: "Arielle Example", note: NOTE, createdAt: ago(105 * MIN) } });
    await prisma.contentScript.update({ where: { id: sChanges.id }, data: { clientChangesAt: ago(105 * MIN) } });
    // The topic pick (the client's own SELECTED event), and a staff one that must not show.
    await prisma.contentTopicEvent.create({ data: { topicId: tSpring, enrollmentId: A.enrollmentId, kind: "SELECTED", monthId: A.monthId, actorKind: "CLIENT", clientUserId: owner, createdAt: ago(102 * MIN) } });
    await prisma.contentTopicEvent.create({ data: { topicId: tKitchen, enrollmentId: A.enrollmentId, kind: "SELECTED", monthId: A.monthId, actorKind: "STAFF", staffUserId: "staff-1", createdAt: ago(101 * MIN) } });
    // A message from the client.
    await prisma.programMessage.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, authorKind: "CLIENT", clientUserId: owner, authorLabel: "Arielle Example", body: "Can we film at the new listing on Elm Street instead?", createdAt: ago(58 * MIN) } });
    // A video, its download through the portal (a recorded path), and a staff decision on their behalf (left out).
    const video = await prisma.contentVideo.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, topicId: tKitchen, title: "Kitchen tour", monthId: A.monthId, monthKey: A.monthKey } });
    await prisma.clientDecision.create({ data: { submissionId: "sub-staff-1", projectId: A.projectId!, videoId: video.id, enrollmentId: A.enrollmentId, clientId: A.clientId, decision: "APPROVE", staffUserId: "staff-1", actorLabel: "Jordan (on behalf of Arielle)", decidedAt: ago(95 * MIN) } });
    // Visits: LOGIN (3 views in one visit, then one more 40 min later), the emailed link
    // (2 views three days ago), a reload burst ten days ago, a section path, a download
    // path, and STAFF previews that are never the client.
    const visit = (at: Date, via: string, pathName = via === "TOKEN" ? "/portal/[token]" : "/portal/me", who: string | null = via === "LOGIN" ? owner : null) =>
      prisma.portalVisit.create({ data: { enrollmentId: A.enrollmentId, clientUserId: who, staffUserId: via === "STAFF" ? "staff-1" : null, via, path: pathName, createdAt: at } });
    for (const m of [120, 115, 100]) await visit(ago(m * MIN), "LOGIN");
    await visit(ago(60 * MIN), "LOGIN");
    await visit(ago(90 * MIN), "LOGIN", `/portal/download/${video.id}`);
    await visit(ago(3 * DAY), "TOKEN");
    await visit(ago(3 * DAY - 10 * MIN), "TOKEN");
    for (let i = 0; i < 30; i++) await visit(new Date(ago(10 * DAY).getTime() + i * 200), "TOKEN");
    await visit(ago(20 * DAY), "LOGIN", "/portal/me?tab=plan");
    for (const m of [30, 25, 20, 15, 10]) await visit(ago(m * MIN), "STAFF", "/portal/[token]", null);
    // A Calendly booking (outside the portal): on the timeline, not counted.
    await prisma.programCallRecord.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, callType: "MONTHLY_STRATEGY", matchState: "MATCHED", scheduledStart: new Date(now.getTime() + 2 * DAY), createdAt: ago(DAY) } });
    // System to client: the welcome Jordan sent by hand, and a scripts-ready email.
    await prisma.appSetting.create({ data: { key: `client-onboarding:${A.clientId}`, value: JSON.stringify({ onboardedAt: null, onboardedBy: null, log: [{ at: ago(5 * DAY).toISOString(), by: "jordan@example.com", kind: "marked", message: "welcome", channel: "email" }] }) } });
    await prisma.outboxMessage.create({ data: { channel: "email", toRef: "arielle@example.com", clientId: A.clientId, body: "x", state: "accepted", dedupeKey: "script_share:rem-1", acceptedAt: ago(2 * DAY), createdAt: ago(2 * DAY) } });

    // Two more TEST clients (Quiet, Never) and two real ones (Not invited, Never with a welcome).
    const Q = await buildContentMonth(prisma as never, { name: "Quiet Client TEST", owner: { name: "Quinn Quiet", email: "quinn@example.com" }, portalToken: true });
    await prisma.clientMembership.update({ where: { id: Q.membershipId! }, data: { acceptedAt: ago(20 * DAY) } });
    await prisma.portalVisit.create({ data: { enrollmentId: Q.enrollmentId, clientUserId: Q.clientUserId, via: "LOGIN", path: "/portal/me", createdAt: ago(12 * DAY) } });
    // Q chose to plan the month in writing (their choice, on the month), and has picked no topics yet.
    await prisma.contentMonth.update({ where: { id: Q.monthId }, data: { planningMode: "WRITTEN", planningChosenAt: ago(12 * DAY - MIN), planningChosenBy: `client:${Q.clientUserId}` } });
    const N = await buildContentMonth(prisma as never, { name: "Invited Client TEST", owner: { name: "Nina New", email: "nina@example.com" } });
    await prisma.clientMembership.update({ where: { id: N.membershipId! }, data: { acceptedAt: null } });
    await prisma.clientUser.update({ where: { id: N.clientUserId! }, data: { status: "INVITED" } });
    const real = async (name: string) => {
      const cl = await prisma.client.create({ data: { name, socialClient: true, socialPlan: "Starter" } });
      const e = await prisma.contentEnrollment.create({ data: { clientId: cl.id, status: "ACTIVE", package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, startedAt: ago(30 * DAY) } });
      return { clientId: cl.id, enrollmentId: e.id };
    };
    const B = await real("Dana Realtor");
    const E = await real("Evan Agent");
    const evanUser = await prisma.clientUser.create({ data: { email: "evan@example.com", name: "Evan Agent", status: "INVITED" } });
    const evanSeat = await prisma.clientMembership.create({ data: { clientUserId: evanUser.id, enrollmentId: E.enrollmentId, clientId: E.clientId, role: "OWNER", invitedAt: ago(DAY) } });
    await prisma.outboxMessage.create({ data: { channel: "email", toRef: "evan@example.com", clientId: E.clientId, body: "x", state: "accepted", dedupeKey: `portal_invite:${evanSeat.id}:welcome`, acceptedAt: ago(DAY), createdAt: ago(DAY) } });
    // An ENDED client is not on the screen at all.
    const ended = await real("Ended Agent");
    await prisma.contentEnrollment.update({ where: { id: ended.enrollmentId }, data: { status: "ENDED" } });

    // =======================================================================
    c.head("3 · the summary");
    // =======================================================================
    const s = await ca.clientActivitySummary({ now: new Date(now.getTime() + 1000), waiting: true });
    const rowA = s.test.find((r) => r.clientId === A.clientId)!;
    c.ok("the TEST client is in the TEST group, not the main rows", !!rowA && !s.rows.some((r) => r.clientId === A.clientId));
    c.ok("TEST group holds exactly the three TEST clients", s.test.map((r) => r.name).sort().join("|") === "Activity Client TEST|Invited Client TEST|Quiet Client TEST", s.test.map((r) => r.name).join("|"));
    c.ok("main rows hold the two real clients, never the ENDED one", s.rows.map((r) => r.name).sort().join("|") === "Dana Realtor|Evan Agent", s.rows.map((r) => r.name).join("|"));
    c.ok("chips count real clients only: Not invited 1, Never signed in 1, Active 0, Quiet 0", s.counts.NOT_INVITED === 1 && s.counts.NEVER === 1 && s.counts.ACTIVE === 0 && s.counts.QUIET === 0, JSON.stringify(s.counts));
    c.ok("name, package and status", rowA.name === "Activity Client TEST" && rowA.pkg === "Accelerator" && rowA.status === "ACTIVE");
    c.ok("portal account: signed up, first sign-in 4 days ago, the person named", rowA.account === "SIGNED_UP" && rowA.firstSignInAt?.getTime() === ago(4 * DAY).getTime() && rowA.people.length === 1 && rowA.people[0].name === "Arielle Example" && rowA.people[0].signedUp);
    c.ok("welcome email: the date Jordan marked it sent", rowA.welcomeSentAt?.getTime() === ago(5 * DAY).getTime(), rowA.welcomeSentAt?.toISOString());
    c.ok("last seen: the client's last page view, not the later STAFF previews", rowA.lastSeenAt?.getTime() === ago(60 * MIN).getTime(), rowA.lastSeenAt?.toISOString());
    c.ok("visits 7d = 3 (one LOGIN visit of 3 pages, one of 1, one emailed-link visit); STAFF and the download are not visits", rowA.visits7 === 3, String(rowA.visits7));
    c.ok("visits 30d = 5 (plus the reload burst and the Your Month visit)", rowA.visits30 === 5, String(rowA.visits30));
    c.ok("actions 7d = 5 (approval, change request, topic pick, message, download); the Calendly booking and staff acts are not counted", rowA.actions7 === 5, String(rowA.actions7));
    c.ok("chip: Active this week", rowA.health === "ACTIVE");
    const w = rowA.waiting ?? [];
    c.ok("waiting: the one script they have not answered (the portal's own count)", w.some((x) => x.kind === "APPROVE_SCRIPTS" && x.count === 1 && x.label === "1 script to approve"), JSON.stringify(w));
    c.ok("waiting: the approved and the change-requested scripts are not waiting on them", !w.some((x) => x.kind === "APPROVE_SCRIPTS" && x.count > 1));
    // The same list the portal's Home builds, read independently through the portal's own readers.
    const again = await ca.waitingOnClient({ id: A.enrollmentId, clientId: A.clientId, status: "ACTIVE" });
    c.ok("waiting is the portal Home list, every kind in Home's order", JSON.stringify(again.map((x) => x.kind)) === JSON.stringify(w.map((x) => x.kind)) && w.every((x, i, arr) => i === 0 || (["REVIEW_VIDEOS", "APPROVE_SCRIPTS", "ANSWER_QUESTIONS", "CHOOSE_ROUTE", "BOOK_CALL", "PICK_TOPICS", "BOOK_SESSION", "COMPLETE_ADDRESS", "ADD_BRIEF"].indexOf(arr[i - 1].kind) < ["REVIEW_VIDEOS", "APPROVE_SCRIPTS", "ANSWER_QUESTIONS", "CHOOSE_ROUTE", "BOOK_CALL", "PICK_TOPICS", "BOOK_SESSION", "COMPLETE_ADDRESS", "ADD_BRIEF"].indexOf(x.kind))), JSON.stringify(w.map((x) => x.label)));
    // A call-required month with no call booked: Home asks for the call; the topics are chosen on it, so no "pick topics".
    c.ok("waiting, exactly: 1 script to approve, then the strategy call to book", JSON.stringify(w.map((x) => x.label)) === JSON.stringify(["1 script to approve", "Strategy call to book"]), JSON.stringify(w.map((x) => x.label)));
    const wq = await ca.waitingOnClient({ id: Q.enrollmentId, clientId: Q.clientId, status: "ACTIVE" });
    c.ok("a month planned in writing with nothing chosen: its topics to pick are waiting (the package's 4)", wq.some((x) => x.kind === "PICK_TOPICS" && x.label === "4 topics to pick") && !wq.some((x) => x.kind === "BOOK_CALL"), JSON.stringify(wq.map((x) => x.label)));
    const paused = ca.waitingPromises([{ enrollmentId: "e-paused", clientId: "c-paused", status: "PAUSED" }]);
    c.ok("a paused program is not read: nothing is waiting on it", JSON.stringify(await paused.get("e-paused")) === "[]");
    const rowQ = s.test.find((r) => r.clientId === Q.clientId)!;
    c.ok("Quiet Client TEST: signed up, last seen 12 days ago, Quiet 7+ days", rowQ.health === "QUIET" && rowQ.visits7 === 0 && rowQ.visits30 === 1 && rowQ.lastSeenAt?.getTime() === ago(12 * DAY).getTime());
    const rowN = s.test.find((r) => r.clientId === N.clientId)!;
    c.ok("Invited Client TEST: invited, never seen, Never signed in", rowN.account === "INVITED" && rowN.health === "NEVER" && rowN.lastSeenAt === null && rowN.firstSignInAt === null);
    const rowB = s.rows.find((r) => r.clientId === B.clientId)!;
    c.ok("Dana Realtor: no account, no welcome, Not invited", rowB.account === "NONE" && rowB.welcomeSentAt === null && rowB.health === "NOT_INVITED");
    const rowE = s.rows.find((r) => r.clientId === E.clientId)!;
    c.ok("Evan Agent: invited, welcome email yesterday (the outbox), Never signed in", rowE.account === "INVITED" && rowE.welcomeSentAt?.getTime() === ago(DAY).getTime() && rowE.health === "NEVER");
    const sorted = ca.sortRows([rowB, rowQ, rowA, rowN], "seen").map((r) => r.name);
    c.ok("sort by last seen: newest first, never-seen last", sorted.join("|") === "Activity Client TEST|Quiet Client TEST|Dana Realtor|Invited Client TEST", sorted.join("|"));
    c.ok("sort by last seen, oldest first: never-seen still last", ca.sortRows([rowB, rowQ, rowA], "seen_old").map((r) => r.name).join("|") === "Quiet Client TEST|Activity Client TEST|Dana Realtor");
    const lazy = await ca.clientActivitySummary({ waiting: false });
    c.ok("waiting: false reads no portal readers (the page streams that column)", lazy.test.every((r) => r.waiting === null));

    // =======================================================================
    c.head("4 · the feed");
    // =======================================================================
    const f = await ca.clientActivityFeed({ clientId: A.clientId, limit: 200 });
    const lines = f.items.map((i) => i.text);
    console.log(lines.map((t, i) => `      ${i + 1}. [${f.items[i].kind}] ${t}${f.items[i].who ? ` (${f.items[i].who})` : ""}${f.items[i].detail ? ` · ${f.items[i].detail}` : ""}`).join("\n"));
    c.ok("newest first", f.items.every((x, i) => i === 0 || f.items[i - 1].at.getTime() >= x.at.getTime()));
    const expected = [
      "Sent a message: Can we film at the new listing on Elm Street instead?",
      "Opened the portal",
      "Downloaded “Kitchen tour”",
      `Picked topic “Spring market” for ${new Date(`${A.monthKey}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })}`,
      `Asked for changes on the script “Open house tips”: ${NOTE.slice(0, 119).trimEnd()}…`,
      "Approved the script “First-time buyers”",
      "Visited the portal (3 pages)",
      "Signed in",
    ];
    c.ok("the last two hours, in order and in plain words", JSON.stringify(lines.slice(0, expected.length)) === JSON.stringify(expected), JSON.stringify(lines.slice(0, expected.length)));
    c.ok("the change request quotes its first 120 characters", lines[4].endsWith("…") && lines[4].split(": ").slice(1).join(": ").length <= 120 && NOTE.startsWith(lines[4].split(": ").slice(1).join(": ").slice(0, -1)), String(lines[4].split(": ").slice(1).join(": ").length));
    c.ok("each line names the person (first name)", f.items[0].who === "Arielle" && f.items.find((i) => i.text === "Visited the portal (3 pages)")?.who === "Arielle");
    c.ok("STAFF previews never appear (no visit in the last 50 minutes)", !f.items.some((i) => i.kind === "visit" && i.at.getTime() > ago(55 * MIN).getTime()));
    c.ok("staff acts never appear (their topic pick, their approval on the client's behalf)", !lines.some((l) => /Kitchen tour/.test(l) && /Picked|Approved video/.test(l)));
    const rest = lines.slice(expected.length);
    c.ok("then: the Calendly booking, the scripts email, the emailed-link visit, first sign-in, the welcome", JSON.stringify(rest.slice(0, 5).map((l) => l.replace(/^(Booked a strategy call) for .*$/, "$1"))) === JSON.stringify(["Booked a strategy call", "Email sent: Your scripts are ready in your Realtour Pilot portal", "Visited the portal (2 pages)", "Signed in for the first time", "Welcome email sent by hand"]), JSON.stringify(rest.slice(0, 5)));
    const cal = f.items.find((i) => i.text.startsWith("Booked a strategy call"));
    c.ok("the Calendly booking says it was outside the portal", cal?.offPortal === true && /outside the portal/.test(cal.detail ?? ""));
    const link = f.items.find((i) => i.text === "Visited the portal (2 pages)");
    c.ok("the emailed-link visit is the shared link's, and says so", link?.who === "Shared link" && /from the emailed link/.test(link.detail ?? ""));
    const burstLine = f.items.find((i) => i.at.getTime() === ago(10 * DAY).getTime());
    c.ok("the reload burst is one page view, with its 30 loads explained", burstLine?.text === "Opened the portal" && /30 page loads in 6 seconds/.test(burstLine.detail ?? ""), JSON.stringify(burstLine));
    c.ok("the oldest line: a visit that opened Your Month", lines[lines.length - 1] === "Opened Your Month");
    c.ok("all times read in Eastern", f.items.every((i) => i.atLabel === etDateTime(i.at)) && /^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M$/.test(f.items[0].atLabel), f.items[0].atLabel);
    c.ok("one page holds everything: no Load older", f.nextBefore === null);

    // Paging: 5 a page, no overlap, nothing lost.
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const p = await ca.clientActivityFeed({ clientId: A.clientId, limit: 5, before });
      seen.push(...p.items.map((i) => i.id));
      before = p.nextBefore;
      pages++;
    } while (before && pages < 10);
    c.ok("Load older, 5 a page: every line once, in the same order", JSON.stringify(seen) === JSON.stringify(f.items.map((i) => i.id)), `${seen.length} vs ${f.items.length} in ${pages} pages`);

    const fq = await ca.clientActivityFeed({ clientId: Q.clientId, limit: 50 });
    c.ok("the route choice reads in plain words: 'Chose to plan <Month> in writing'", fq.items.some((i) => /^Chose to plan [A-Z][a-z]+ in writing$/.test(i.text) && i.who === "Quinn"), JSON.stringify(fq.items.map((i) => i.text)));
    const all = await ca.clientActivityFeed({ limit: 200 });
    c.ok("the all-clients feed leaves TEST clients out", !all.items.some((i) => /TEST/.test(i.clientName)) && all.items.some((i) => i.clientName === "Evan Agent" && i.text === "Welcome email sent"), JSON.stringify(all.items.map((i) => `${i.clientName}: ${i.text}`)));

    // =======================================================================
    c.head("5 · the page and the nav");
    // =======================================================================
    const page = fs.readFileSync(path.join(REPO, "src/app/content/activity/page.tsx"), "utf8");
    const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    c.ok("owner and admin only: anyone else is sent home", /if \(me && me\.role !== "OWNER" && me\.role !== "ADMIN"\) redirect\("\/"\);/.test(page) && /if \(!me && authEnforced\(\)\) redirect\("\/login\?next=\/content\/activity"\);/.test(page));
    c.ok("each row links to the client's content workspace and filters the feed (?client=)", /contentHref\(r\.enrollmentId\)/.test(page) && /client: r\.clientId/.test(page));
    c.ok("no em dash in the page's copy or the feed's words", !/—/.test(code(page)) && f.items.every((i) => !/—/.test(`${i.text} ${i.detail ?? ""}`)) && !/—/.test(Object.values(ca.HEALTH).map((x) => x.label + x.hint).join(" ")));
    const sidebar = fs.readFileSync(path.join(REPO, "src/components/Sidebar.tsx"), "utf8");
    c.ok("nav: 'Client activity' next to Content Program, filtered to owner and admin", /label: "Content Program", href: "\/content"[^\n]*\n[^\n]*\n\s*\{ label: "Client activity", href: "\/content\/activity"/.test(sidebar) && /user\.role !== "OWNER" && user\.role !== "ADMIN"\) items = items\.filter\(\(i\) => i\.href !== "\/content\/activity"\)/.test(sidebar));

    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
