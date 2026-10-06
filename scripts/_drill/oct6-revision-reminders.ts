// ---------------------------------------------------------------------------
// DRILL: OCT 6 2026 — A REVISION STILL WAITING ON ITS EDITOR (Jordan,
// verbatim: "Can we also have notifications sent to the editors for projects
// that have been in revision for over 24 hours? Like for example - Kim has had
// a revision open for a week or more now for Bernadette Rabel.")
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct6-revision-reminders.ts --logs /private/tmp/oct6-revrem
//
// Every check drives the SHIPPED code: the Editing Room's own queue builder
// (whose "Revisions" rows are the only thing reminded about), the open-ask
// fold, the hourly sweep, the real bell bridge with its Slack leg, Kyle's
// named notice, the staff quiet-time hold and its 5-minute flusher, and the
// cron runner that records the step.
//
//   0  The fold, pure: only a cut's newest round speaks; a client's send-back
//      is dated by the client's own request; v2 in → nothing owed.
//   1  1142 Hamilton St (Bernadette Rabel), James's internal send-back, Kim's
//      card: 23 h → nothing; 25 h → ONE bell + ONE Slack DM to Kim, worded as
//      Jordan asked, linking the video; the same day again → nothing; +24 h →
//      the second; Kim hands in v2 → no more, and the queue row leaves
//      Revisions.
//   2  A client's change request on an approved cut (portal shape) → John,
//      dated by the client's request, "the client's changes" — once, though a
//      revision card is open on the same job too.
//   3  Luma Visuals' job → Kyle, "relay it"; nobody's job → Kyle, "needs an
//      editor"; no editor bell for either.
//   4  Delivered, on hold, taken off the Editing Room → nothing at all.
//   5  The queue row and the editor's desk say "waiting N days".
//   6  Day 3 → Kyle's ONE combined line a day (not before 9 AM ET, not twice a
//      day), the editors' stuck revisions only, oldest first.
//   7  Saturday 3 AM ET: Kim's reminder goes at once (Jordan's Saturday is
//      Jordan's alone).
//   8  John's own saved quiet window (Sunday until 8 AM) holds his — released
//      once at 8.
//  10  THE CLIENT ASKS FOR CHANGES ON AN APPROVED VIDEO BY EMAIL (the gap the
//      first pass found): OLD — the ladder read the cut statuses only, so the
//      row said Approved and no reminder could find it. NEW — the cut stays
//      approved (the client keeps it), the row reads Revisions with the
//      client's ask, Kim is reminded at 24 h (not 23), and her v2 clears it.
//      An internal send-back plus the client's email on the SAME video is one
//      revision, one reminder.
//   9  The cron step is registered after reopenedClocks and lands in the
//      CronRun summary; no text and no client message anywhere.
//
// ISOLATION: PGlite on 127.0.0.1:6830 (this builder's range 6830-6849);
// production is never opened; every non-loopback call is fenced; Slack is
// answered by a fake and counted; OpenPhone's two calls are replaced
// in-process. THE CLOCK IS PINNED and only ever moves FORWARD (the roster and
// settings caches compare against Date.now()): Tue Oct 13 2026 09:00 EDT on.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6830;
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
/** Oct 2026 wall clock in EDT (UTC-4). */
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 13, 9, 0).getTime() - RealDate.now();
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
let last = edt(10, 13, 9, 0).getTime();
const setClock = (d: Date) => {
  if (d.getTime() < last) throw new Error(`drill clock may only move forward (${d.toISOString()})`);
  last = d.getTime();
  offset = d.getTime() - RealDate.now();
};

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
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  if (method === "conversations.open") return json({ ok: false, error: "missing_scope" });
  return json({ ok: false, error: `drill: ${method}` });
});

const S = { jordan: "U0JORDAN01", kyle: "U0KYLE0001", james: "U0JAMES001", kim: "U0KIMMIG01", john: "U0JOHNMR01" };

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const notify = await import("@/lib/notify");
  const sched = await import("@/lib/notifySchedule");
  const rr = await import("@/lib/revisionReminders");
  const { openRevisionAsks, reopenedByClient } = await import("@/lib/openRevisions");
  const { raiseRevision } = await import("@/lib/comms");
  const { buildEditorQueue } = await import("@/lib/editorQueue");
  const { toDeskJobs } = await import("@/lib/editorDesk");
  const { editCardCutSubmitted } = await import("@/lib/tasks");
  const { queueRemovedKey, serialize } = await import("@/lib/queueRemoved");
  const { cronBudget } = await import("@/lib/cron");

  const op = await import("@/lib/integrations/openphone");
  const OFFICE = "+16105550100";
  (op.OpenPhone as unknown as { phoneNumbers: () => Promise<unknown[]> }).phoneNumbers = async () => [{ id: "PN-drill", number: OFFICE }];
  const texts: { to: string; body: string }[] = [];
  (op.OpenPhone as unknown as { sendMessage: unknown }).sendMessage = async (_from: string, to: string, body: string) => {
    texts.push({ to: String(to), body });
    return { data: { id: `op-${texts.length}` } };
  };
  await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

  // ---- the cast, as production has it (before the first notify: the stack
  // caches owner/office/editor lists for ten minutes) ------------------------
  type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
  const member = (name: string, email: string, role: TeamRole, phone: string | null, slackId: string | null, extra: Record<string, unknown> = {}) =>
    prisma.teamMember.create({ data: { name, email, role, phone, slackId, active: true, ...extra }, select: { id: true, name: true } });
  const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER", "(610) 555-0111", S.jordan, { opsAlerts: true });
  const kyle = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER", OFFICE, S.kyle, { opsAlerts: true });
  const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", "(610) 555-0133", S.james, { creativeManager: true });
  const kim = await member("Kim Miguel", "kim@drill.invalid", "MANAGER", "+63 917 555 0101", S.kim);
  const john = await member("John Mark Reyes", "john@drill.invalid", "VA", null, S.john);
  const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
    prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
  await login("jordan@drill.invalid", "OWNER", jordan.id);
  const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
  await login("james@drill.invalid", "ADMIN", james.id);
  await login("kim@drill.invalid", "EDITOR", kim.id, { editorKey: "kim" });
  await login("john@drill.invalid", "EDITOR", john.id, { editorKey: "john" });
  // Kyle's saved matrix (production's shape). Kim and John keep the EDITOR
  // defaults on purpose — "Job pings" by Slack — so the default is what is proved.
  const allOff = { mention: { slack: false, sms: false }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: false, sms: false }, shoot_change: { slack: false, sms: false } };
  await putSetting(`notify-prefs:${kyle.id}`, { ...allOff, mention: { slack: true, sms: false }, review_ready: { slack: true, sms: false } });
  await putSetting(`notify-prefs:${jordan.id}`, { ...allOff, mention: { slack: true, sms: true }, review_ready: { slack: true, sms: true } });
  await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });

  // ---- helpers -----------------------------------------------------------
  const dms = (slackId: string, since = 0) => slack.slice(since).filter((m) => m.channel === slackId);
  const bells = (kind: string, where: Record<string, unknown> = {}) => prisma.notification.findMany({ where: { kind, ...where }, orderBy: { createdAt: "asc" }, select: { title: true, href: true, userKey: true, dedupeKey: true, body: true } });
  const heldRows = async () =>
    (await prisma.appSetting.findMany({ where: { key: { startsWith: sched.HELD_DM_PREFIX } }, select: { value: true } }))
      .map((r) => JSON.parse(r.value) as { teamMemberId: string; text: string; until: string; settledAt?: string })
      .filter((r) => !r.settledAt);
  const clientOf = async (name: string) => (await prisma.client.create({ data: { name }, select: { id: true } })).id;
  type Job = { id: string; deliverableId: string; outputId: string; street: string };
  const mkJob = async (street: string, clientId: string, o: { status?: string; card?: { key: string | null; manual?: boolean; summary?: string } | null; data?: Record<string, unknown> } = {}): Promise<Job> => {
    const p = await prisma.project.create({ data: { title: `${street}, Allentown, PA 18102`, clientId, status: (o.status ?? "REVISION") as "REVISION", addressLine: street, ...o.data }, select: { id: true } });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
    const out = await prisma.deliverableOutput.create({ data: { deliverableId: d.id, projectId: p.id, slot: 1, category: "VIDEO" }, select: { id: true } });
    if (o.card !== null) {
      await prisma.smartTask.create({
        data: {
          taskType: "edit_video", status: "IN_PROGRESS", title: `Edit video — ${street}`, projectId: p.id, dedupeKey: `edit-video-${p.id}`, source: "hub",
          assignedKey: o.card?.key ?? null, assignedManually: o.card?.manual ?? false,
          summary: o.card?.summary ?? "Round 2 — 1 note to fix (sent back from the Review Room). The notes are below; fix them and upload the next version.",
        },
      });
    }
    return { id: p.id, deliverableId: d.id, outputId: out.id, street };
  };
  const mkCut = (job: Job, o: { round: number; status: string; createdAt: Date; decidedAt?: Date | null; decidedBy?: string | null; clientRequestedAt?: Date | null; clientRequestedBy?: string | null; by?: string }) =>
    prisma.reviewSubmission.create({
      data: {
        projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: o.round, kind: "video", source: "upload", status: o.status,
        fileName: `${job.street.replace(/\s+/g, "-")}-v${o.round}.mp4`, submittedByKey: o.by ?? "kim", createdAt: o.createdAt,
        decidedAt: o.decidedAt ?? null, decidedBy: o.decidedBy ?? null, clientRequestedAt: o.clientRequestedAt ?? null, clientRequestedBy: o.clientRequestedBy ?? null,
      },
      select: { id: true },
    });
  const sweep = () => rr.sweepRevisionReminders();
  const BASE = "https://drill.invalid";
  const forJob = <T extends { dedupeKey: string | null }>(rows: T[], id: string): T[] => rows.filter((b) => (b.dedupeKey ?? "").includes(`:${id}:`));

  // =========================================================================
  c.head("0 · THE FOLD, PURE — which asks are open, and since when");
  {
    const base = { roundOwed: false, revisionTasks: [], revisionRequestedAt: null };
    const r1 = { id: "s1", cutKey: "d:1", deliverableId: "d", slot: 1, outputId: null, round: 1, status: "CHANGES_REQUESTED", createdAt: edt(9, 24, 9), decidedAt: edt(9, 25, 15), decidedBy: "James Livingston" };
    const a = openRevisionAsks({ ...base, cuts: [r1] });
    c.ok("a sent-back v1 is one ask, dated by James's verdict, his name on it", a.length === 1 && a[0].sinceISO === edt(9, 25, 15).toISOString() && a[0].by === "James Livingston" && a[0].source === "office", JSON.stringify(a));
    const v2 = { ...r1, id: "s2", round: 2, status: "PENDING", decidedAt: null, decidedBy: null, createdAt: edt(9, 27, 9) };
    c.ok("…v2 handed in: the newest round speaks, nothing is owed", openRevisionAsks({ ...base, cuts: [r1, v2] }).length === 0);
    const clientBack = { ...r1, id: "s3", decidedAt: edt(9, 20, 10), clientRequestedAt: edt(9, 30, 11), clientRequestedBy: "Ann Lee" };
    const b = openRevisionAsks({ ...base, cuts: [clientBack] });
    c.ok("a client's send-back on an approved cut is the client's, at the client's time", b.length === 1 && b[0].source === "client" && b[0].sinceISO === edt(9, 30, 11).toISOString(), JSON.stringify(b));
    const t = openRevisionAsks({ ...base, cuts: [], revisionTasks: [{ id: "t1", createdAt: edt(8, 1, 9) }], revisionRequestedAt: edt(10, 1, 9) });
    c.ok("no cut in the Review Room: a revision card dated by the job's own changes-requested stamp, not the card's August birth", t.length === 1 && t[0].kind === "task" && t[0].sinceISO === edt(10, 1, 9).toISOString(), JSON.stringify(t));
    // The client's ask on an APPROVED video (email / text / call).
    const ok1 = { ...r1, id: "a1", status: "APPROVED", decidedAt: edt(9, 26, 10) };
    const email = { id: "b1", at: edt(9, 28, 9), cutKey: "d:1", by: "Gina Torres" };
    const ro = reopenedByClient([ok1], [email]);
    c.ok("an email after the approved version reopens that video, dated by the email", ro.length === 1 && ro[0].cutKey === "d:1" && ro[0].ask.id === "b1", JSON.stringify(ro));
    const ra = openRevisionAsks({ ...base, cuts: [ok1], clientAsks: [email] });
    c.ok("…and is one open ask: the client's, since the email", ra.length === 1 && ra[0].kind === "client" && ra[0].source === "client" && ra[0].sinceISO === edt(9, 28, 9).toISOString(), JSON.stringify(ra));
    c.ok("an ask that came BEFORE the approved version was handed in is answered by it", reopenedByClient([{ ...ok1, createdAt: edt(9, 29, 9) }], [email]).length === 0);
    const v2up = { ...ok1, id: "a2", round: 2, status: "PENDING", createdAt: edt(9, 29, 9), decidedAt: null, decidedBy: null };
    c.ok("the editor's next version after the email answers it", reopenedByClient([ok1, v2up], [email]).length === 0 && openRevisionAsks({ ...base, cuts: [ok1, v2up], clientAsks: [email] }).length === 0);
    const sent = openRevisionAsks({ ...base, cuts: [r1], clientAsks: [{ ...email, at: edt(9, 26, 9) }] });
    c.ok("an internal send-back plus the client's email on the SAME video is ONE ask, not two", sent.length === 1 && sent[0].kind === "cut", JSON.stringify(sent));
    c.ok("an ask naming no video on a one-cut job is that video's", reopenedByClient([ok1], [{ ...email, cutKey: null }]).length === 1);
    const two = { ...ok1, id: "a3", cutKey: "d:2", slot: 2 };
    c.ok("an ask naming no video on an approved two-video job reopens the job once", reopenedByClient([ok1, two], [{ ...email, cutKey: null }]).map((x) => x.cutKey).join() === "", JSON.stringify(reopenedByClient([ok1, two], [{ ...email, cutKey: null }])));
    c.ok("…but not when one of them is already sent back (no double count)", reopenedByClient([ok1, { ...r1, id: "s9", cutKey: "d:2", slot: 2 }], [{ ...email, cutKey: null }]).length === 0);
  }

  // ---- the jobs (Tue Oct 13 09:00 EDT) -------------------------------------
  const bernadette = await clientOf("Bernadette Rabel");
  const annLee = await clientOf("Ann Lee");
  const paula = await clientOf("Paula Prospect");
  const marcus = await clientOf("Marcus Webb");
  // A — the live example's shape: REVISION, Kim's card IN_PROGRESS, v1 sent back by James.
  const A = await mkJob("1142 Hamilton St", bernadette, { card: { key: "kim" }, data: { revisionRequestedAt: edt(10, 13, 10) } });
  await mkCut(A, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 12, 15), decidedAt: edt(10, 13, 10), decidedBy: "James Livingston" });
  // B — John's: approved by James Monday, then the CLIENT sent it back on the portal Tuesday 10:30.
  const B = await mkJob("22 Portal Way", annLee, { card: { key: "john", summary: "Standard reel for 22 Portal Way." } });
  await mkCut(B, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 11, 15), decidedAt: edt(10, 12, 10), decidedBy: "James Livingston", clientRequestedAt: edt(10, 13, 10, 30), clientRequestedBy: "Ann Lee", by: "john" });
  // …and the portal routing's revision card on the same job (one video, one reminder).
  await prisma.smartTask.create({ data: { taskType: "revision", status: "OPEN", title: "Video revision — 22 Portal Way", projectId: B.id, dedupeKey: `drill-rev-${B.id}`, assignedKey: "john", outputId: B.outputId, createdAt: edt(10, 13, 10, 30) } });
  // C — handed to Luma Visuals.
  const C = await mkJob("7 Agency Ct", paula, { card: { key: "external_agency" }, data: { editorManual: true, editorVendorKey: "external_agency" } });
  await mkCut(C, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 12, 15), decidedAt: edt(10, 13, 10), decidedBy: "Kyle Smith", by: "external_agency" });
  // D — deliberately nobody's (the office unassigned it).
  const D = await mkJob("9 Nobody Rd", paula, { card: { key: null, manual: true } });
  await mkCut(D, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 12, 15), decidedAt: edt(10, 13, 10), decidedBy: "Jordan Spackman" });
  // E1-E3 — sent back days ago, but not the editor's to redo.
  const E1 = await mkJob("1 Delivered Dr", marcus, { status: "DELIVERED", card: null, data: { deliveredAt: edt(10, 12, 12) } });
  await mkCut(E1, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 9, 15), decidedAt: edt(10, 10, 10), decidedBy: "James Livingston" });
  const E2 = await mkJob("2 On Hold Ave", marcus, { status: "ON_HOLD", card: { key: "kim" } });
  await mkCut(E2, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 9, 15), decidedAt: edt(10, 10, 10), decidedBy: "James Livingston" });
  const E3 = await mkJob("3 Removed Ln", marcus, { card: { key: "kim" } });
  await mkCut(E3, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 9, 15), decidedAt: edt(10, 10, 10), decidedBy: "James Livingston" });
  await prisma.appSetting.create({ data: { key: queueRemovedKey(E3.id), value: serialize({ by: "Kyle Smith", at: edt(10, 12, 9), note: "client paused", task: null, restoredAt: null, restoredBy: null }) } });
  // K2 — Kim's, sent back by Kyle on Monday 08:00: the one that goes stale.
  const K2 = await mkJob("48 Stuck Ln", paula, { card: { key: "kim" } });
  await mkCut(K2, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 11, 15), decidedAt: edt(10, 12, 8), decidedBy: "Kyle Smith" });

  const KIM_A_1 = `Revision waiting 1 day — 1142 Hamilton St (Bernadette Rabel), Video 1: James's changes from Oct 13. Upload the next version: ${BASE}/edit/${A.id}?output=${A.outputId}`;

  // =========================================================================
  c.head("1 · 1142 HAMILTON ST — 23 h nothing, 25 h one reminder, same day nothing, +24 h the second, v2 ends it");
  {
    setClock(edt(10, 14, 9, 0)); // Wed 09:00 — A is 23 h old
    const s0 = slack.length;
    const r = await sweep();
    c.ok("23 h: no bell row for Kim about Hamilton St", forJob(await bells("revision_waiting"), A.id).length === 0);
    c.ok("…and no Slack DM about it", !dms(S.kim, s0).some((m) => m.text.includes("1142 Hamilton St")));
    c.ok("…the stuck list has nothing 3 days old yet (K2 is 2 days)", r.stuck === "none", JSON.stringify(r));

    setClock(edt(10, 14, 11, 0)); // Wed 11:00 — A is 25 h old
    const s1 = slack.length;
    const r2 = await sweep();
    const aBells = forJob(await bells("revision_waiting"), A.id);
    c.ok("25 h: ONE bell row, addressed to Kim, linking the video on her page", aBells.length === 1 && aBells[0].userKey === "editor:kim" && aBells[0].href === `/edit/${A.id}?output=${A.outputId}` && aBells[0].title === "Revision waiting 1 day — 1142 Hamilton St", JSON.stringify(aBells));
    const aDm = dms(S.kim, s1).filter((m) => m.text.includes("1142 Hamilton St"));
    c.ok("…ONE Slack DM to Kim, in plain words", aDm.length === 1 && aDm[0].text === KIM_A_1, aDm.map((m) => m.text).join(" | ") || "no DM");
    c.ok("…nothing to the client: no text anywhere", texts.length === 0);
    c.ok("the sweep's own tally says so", r2.editor.sent >= 1 && r2.failed.length === 0, JSON.stringify(r2));

    setClock(edt(10, 14, 16, 0)); // same day, 30 h
    const s2 = slack.length;
    const b0 = (await bells("revision_waiting")).length;
    const r3 = await sweep();
    c.ok("30 h, the same day: nothing new — no bell row, no DM", (await bells("revision_waiting")).length === b0 && dms(S.kim, s2).length === 0 && r3.editor.sent === 0, JSON.stringify(r3));
  }

  // =========================================================================
  c.head("2 · A CLIENT'S CHANGE REQUEST → John, dated by the client's request");
  {
    const bBells = forJob(await bells("revision_waiting"), B.id);
    const bDm = dms(S.john).filter((m) => m.text.includes("22 Portal Way"));
    c.ok("John got ONE bell row (Wed 11:00, 24.5 h after the client's 10:30 ask)", bBells.length === 1 && bBells[0].userKey === "editor:john", JSON.stringify(bBells));
    c.ok("…ONE DM: the client's changes from Oct 13, the video's link", bDm.length === 1 && bDm[0].text === `Revision waiting 1 day — 22 Portal Way (Ann Lee), Video 1: the client's changes from Oct 13. Upload the next version: ${BASE}/edit/${B.id}?output=${B.outputId}`, bDm.map((m) => m.text).join(" | ") || "no DM");
    c.ok("…the open revision card on the same video did not add a second reminder", bBells.length === 1 && bDm.length === 1);
  }

  // =========================================================================
  c.head("3 · LUMA VISUALS' JOB AND NOBODY'S JOB → Kyle");
  {
    const office = await bells("revision_waiting_office");
    const cK = forJob(office, C.id), dK = forJob(office, D.id);
    c.ok("Luma's job: ONE bell row to Kyle by name, saying relay", cK.length === 1 && cK[0].userKey === `tm:${kyle.id}` && /relay to Luma Visuals/.test(cK[0].title), JSON.stringify(cK));
    const kDm = dms(S.kyle);
    c.ok("…and his Slack DM: relay it to Luma Visuals, with the link", kDm.some((m) => m.text.includes("7 Agency Ct (Paula Prospect), Video 1: Kyle's changes from Oct 13") && m.text.includes("It's with Luma Visuals — relay it to them:") && m.text.includes(`/edit/${C.id}?output=${C.outputId}`)), kDm.map((m) => m.text.slice(0, 140)).join(" | ") || "no DM");
    c.ok("nobody's job: ONE bell row to Kyle, needs an editor", dK.length === 1 && dK[0].userKey === `tm:${kyle.id}` && /needs an editor/.test(dK[0].title) && dK[0].href === "/editing?stage=changes", JSON.stringify(dK));
    c.ok("…his DM says pick an editor, Jordan's send-back named", kDm.some((m) => m.text.includes("9 Nobody Rd (Paula Prospect), Video 1: Jordan's changes from Oct 13") && m.text.includes("It needs an editor")), kDm.map((m) => m.text.slice(0, 140)).join(" | ") || "no DM");
    const editorRows = (await bells("revision_waiting")).filter((b) => (b.dedupeKey ?? "").includes(C.id) || (b.dedupeKey ?? "").includes(D.id));
    c.ok("no editor bell row for either", editorRows.length === 0, JSON.stringify(editorRows));
  }

  // =========================================================================
  c.head("4 · DELIVERED, ON HOLD, TAKEN OFF THE EDITING ROOM → nothing");
  {
    const all = [...(await bells("revision_waiting")), ...(await bells("revision_waiting_office"))];
    for (const [label, j] of [["delivered", E1], ["on hold", E2], ["taken off the Editing Room", E3]] as const) {
      c.ok(`${label}: no bell row, no DM (sent back 3 days ago)`, all.every((b) => !(b.dedupeKey ?? "").includes(j.id)) && !slack.some((m) => m.text.includes(j.street)));
    }
  }

  // =========================================================================
  c.head("5 · THE QUEUE ROW AND THE EDITOR'S DESK SAY HOW LONG");
  {
    const { notDone } = await buildEditorQueue();
    const row = notDone.find((r) => r.id === A.id);
    c.ok("Hamilton St's row reads Revisions, waiting 1 day, Kim's", row?.status === "Revisions" && row?.revisionWaitingDays === 1 && row?.editorKey === "kim", JSON.stringify({ status: row?.status, days: row?.revisionWaitingDays, editor: row?.editorKey }));
    const desk = toDeskJobs(notDone.filter((r) => r.editorKey === "kim"), "kim", []);
    const deskA = desk.find((j) => j.projectId === A.id);
    c.ok("Kim's desk: \"Revisions to do · waiting 1 day\"", deskA?.note === "Revisions to do · waiting 1 day", deskA?.note ?? "not on the desk");
    c.ok("a row off Revisions carries no age", notDone.filter((r) => r.status !== "Revisions").every((r) => r.revisionWaitingDays == null));
    const ui = fs.readFileSync(path.join(REPO, "src/components/editing/SimpleQueue.tsx"), "utf8");
    c.ok("the queue row prints it (\"Waiting N days\", Revisions rows only)", /r\.status === "Revisions" && \(r\.revisionWaitingDays \?\? 0\) >= 1/.test(ui) && ui.includes("Waiting {r.revisionWaitingDays} day"));
  }

  // =========================================================================
  c.head("6 · DAY 3 → KYLE'S ONE COMBINED LINE A DAY");
  {
    c.ok("the switch is one named constant, on", rr.KYLE_DAILY_STUCK_LIST === true && rr.KYLE_STUCK_AFTER_DAYS === 3);
    setClock(edt(10, 15, 8, 30)); // Thu 08:30 — K2 is 3 days old, but it is before 9
    const k0 = dms(S.kyle).length;
    const r = await sweep();
    c.ok("08:30 ET: no list yet", r.stuck === "before 9 AM ET" && (await bells("revision_stuck")).length === 0, JSON.stringify(r));

    setClock(edt(10, 15, 9, 30));
    const k1 = slack.length;
    const r2 = await sweep();
    const list = dms(S.kyle, k1).filter((m) => /stuck with an editor/.test(m.text));
    c.ok("09:30 ET: ONE line to Kyle — 48 Stuck Ln, Kim, 3 days — and only the 3-day one", r2.stuck === "sent" && list.length === 1 && list[0].text.startsWith("1 revision stuck with an editor 3+ days: 48 Stuck Ln (Paula Prospect) — Kim, 3 days.") && !/Hamilton|Portal|Agency|Nobody/.test(list[0].text), list.map((m) => m.text).join(" | ") || JSON.stringify(r2));
    c.ok("…one bell row for it", (await bells("revision_stuck", { userKey: `tm:${kyle.id}` })).length === 1);

    setClock(edt(10, 15, 11, 0)); // Thu 11:00 — A is 49 h
    const k2 = slack.length;
    const r3 = await sweep();
    c.ok("11:00 the same day: the list is not sent again", r3.stuck === "already" && !dms(S.kyle, k2).some((m) => /stuck with an editor/.test(m.text)), JSON.stringify(r3));
    const aDm = dms(S.kim, k2).filter((m) => m.text.includes("1142 Hamilton St"));
    c.ok("…and Hamilton St's SECOND reminder to Kim: waiting 2 days", aDm.length === 1 && aDm[0].text.startsWith("Revision waiting 2 days — 1142 Hamilton St (Bernadette Rabel), Video 1: James's changes from Oct 13."), aDm.map((m) => m.text).join(" | ") || "no DM");
    c.ok("…two bell rows for Kim on it in all", forJob(await bells("revision_waiting"), A.id).length === 2);
    void k0;

    // Kim hands in v2 (the upload's own card answer), John hands in his v2.
    setClock(edt(10, 15, 12, 0));
    await mkCut(A, { round: 2, status: "PENDING", createdAt: edt(10, 15, 12) });
    await editCardCutSubmitted(A.id, { round: 2, close: true, editorKey: "kim" });

    setClock(edt(10, 16, 11, 0)); // Fri 11:00 — A would be 73 h; K2 4 days; B 3 days
    const k3 = slack.length;
    const r4 = await sweep();
    c.ok("Kim handed in v2: no third reminder for Hamilton St", forJob(await bells("revision_waiting"), A.id).length === 2 && !dms(S.kim, k3).some((m) => m.text.includes("1142 Hamilton St")));
    const { notDone } = await buildEditorQueue();
    c.ok("…and its row has left Revisions", notDone.find((r) => r.id === A.id)?.status !== "Revisions", notDone.find((r) => r.id === A.id)?.status);
    const fri = dms(S.kyle, k3).filter((m) => /stuck with an editor/.test(m.text));
    c.ok("Friday: the next day's ONE line — K2 (Kim, 4 days) then Portal Way (John Mark, 3 days), oldest first, no Luma/unassigned jobs", r4.stuck === "sent" && fri.length === 1 && fri[0].text.startsWith("2 revisions stuck with an editor 3+ days: 48 Stuck Ln (Paula Prospect) — Kim, 4 days; 22 Portal Way (Ann Lee) — John Mark, 3 days.") && fri[0].text.includes(`${BASE}/editing?stage=changes`) && !/Agency|Nobody|Hamilton/.test(fri[0].text), fri.map((m) => m.text).join(" | ") || JSON.stringify(r4));
    c.ok("…two list bell rows in two days, no more", (await bells("revision_stuck")).length === 2);
    // John hands in his v2 too.
    await mkCut(B, { round: 2, status: "PENDING", createdAt: edt(10, 16, 11, 30), by: "john" });
    await editCardCutSubmitted(B.id, { round: 2, close: true, editorKey: "john" });
  }

  // =========================================================================
  c.head("7 · SATURDAY 3 AM ET — Kim's reminder at once (Jordan's Saturday is his alone)");
  {
    // S — Kim's, sent back by James Friday 02:30.
    const Sj = await mkJob("5 Saturday Sq", marcus, { card: { key: "kim" } });
    await mkCut(Sj, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 15, 20), decidedAt: edt(10, 16, 2, 30), decidedBy: "James Livingston" });
    setClock(edt(10, 17, 3, 0)); // Sat 03:00 EDT — 24.5 h
    const s0 = slack.length;
    await sweep();
    const sDm = dms(S.kim, s0).filter((m) => m.text.includes("5 Saturday Sq"));
    c.ok("Sat 03:00: Kim's DM goes at once", sDm.length === 1 && sDm[0].text.startsWith("Revision waiting 1 day — 5 Saturday Sq (Marcus Webb), Video 1: James's changes from Oct 16."), sDm.map((m) => m.text).join(" | ") || "no DM");
    c.ok("…nothing held for Kim", (await heldRows()).filter((h) => h.teamMemberId === kim.id).length === 0);
    // Q — John's, sent back Saturday 01:00 (for section 8).
    const Q = await mkJob("3 Quiet Ct", marcus, { card: { key: "john" } });
    await mkCut(Q, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 16, 20), decidedAt: edt(10, 17, 1, 0), decidedBy: "James Livingston", by: "john" });
  }

  // =========================================================================
  c.head("8 · JOHN'S OWN QUIET WINDOW (Sunday until 8 AM) HOLDS HIS — released once");
  {
    await sched.saveSchedule(john.id, [{ day: 0, from: 0, to: 8 * 60 }], "drill");
    setClock(edt(10, 18, 2, 0)); // Sun 02:00 — Q is 25 h
    const s0 = slack.length;
    await sweep();
    const qBell = (await bells("revision_waiting", { userKey: "editor:john" })).filter((b) => b.title.includes("3 Quiet Ct"));
    c.ok("Sun 02:00: John's bell row is written at once", qBell.length === 1);
    c.ok("…no DM to John now", dms(S.john, s0).length === 0);
    const held = (await heldRows()).filter((h) => h.teamMemberId === john.id);
    c.ok("…his DM is HELD to 08:00 ET", held.length === 1 && held[0].until === edt(10, 18, 8, 0).toISOString() && held[0].text.includes("3 Quiet Ct"), JSON.stringify(held.map((h) => ({ until: h.until, text: h.text.slice(0, 60) }))));
    setClock(edt(10, 18, 7, 59));
    await notify.flushPendingSms();
    c.ok("07:59: still nothing to John", dms(S.john, s0).length === 0);
    setClock(edt(10, 18, 8, 1));
    await notify.flushPendingSms();
    await notify.flushPendingSms();
    const jDm = dms(S.john, s0);
    c.ok("08:01: ONE DM to John, about 3 Quiet Ct", jDm.length === 1 && jDm[0].text.includes("3 Quiet Ct") && jDm[0].text.includes("Upload the next version"), jDm.map((m) => m.text.slice(0, 160)).join(" | ") || "no DM");
    c.ok("…nothing left held", (await heldRows()).filter((h) => h.teamMemberId === john.id).length === 0);
    await sched.saveSchedule(john.id, null, "drill");
  }

  // =========================================================================
  c.head("10 · THE CLIENT EMAILS CHANGES ON AN APPROVED VIDEO → Revisions, a reminder at 24 h, cleared by v2");
  {
    setClock(edt(10, 18, 9, 0)); // Sun 09:00
    const gina = await clientOf("Gina Torres");
    // G — delivered with v1 approved by James; Kim's job.
    const G = await mkJob("77 Approved Ave", gina, { status: "DELIVERED", card: null, data: { deliveredAt: edt(10, 17, 12), editorManual: true, editorId: kim.id } });
    const gv1 = await mkCut(G, { round: 1, status: "APPROVED", createdAt: edt(10, 16, 15), decidedAt: edt(10, 17, 10), decidedBy: "James Livingston" });
    // H — Kim's, v1 sent back by James at 09:00 today, then the client emails about the same video.
    const H = await mkJob("88 Twice Ct", gina, { card: { key: "kim" }, data: { editorManual: true, editorId: kim.id, revisionRequestedAt: edt(10, 18, 9) } });
    await mkCut(H, { round: 1, status: "CHANGES_REQUESTED", createdAt: edt(10, 17, 15), decidedAt: edt(10, 18, 9), decidedBy: "James Livingston" });

    setClock(edt(10, 18, 9, 30));
    const ask = "Please swap the music for something calmer and take out the garage clip.";
    const okG = await raiseRevision({ projectId: G.id, clientId: gina, clientName: "Gina Torres", propertyAddress: G.street, note: ask, source: "gmail", requestedBy: { name: "Gina Torres", kind: "EMAIL" } });
    const okH = await raiseRevision({ projectId: H.id, clientId: gina, clientName: "Gina Torres", propertyAddress: H.street, note: ask, source: "gmail", requestedBy: { name: "Gina Torres", kind: "EMAIL" } });
    c.ok("the client's two emails land as revision cards (the real raiseRevision)", okG && okH);
    const cut = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: gv1.id }, select: { status: true, decidedBy: true, decidedAt: true } });
    c.ok("the approved cut's record is untouched — still APPROVED, James's verdict and time (the client keeps it)", cut.status === "APPROVED" && cut.decidedBy === "James Livingston" && cut.decidedAt?.getTime() === edt(10, 17, 10).getTime(), JSON.stringify(cut));

    // OLD: the ladder before Oct 6 read the cuts' statuses only.
    const rounds = await prisma.reviewSubmission.findMany({ where: { projectId: G.id }, select: { status: true } });
    const oldLadder = rounds.some((r) => r.status === "CHANGES_REQUESTED") ? "Revisions" : rounds.some((r) => r.status === "PENDING") ? "Ready for review" : "Approved";
    c.ok("OLD: the same rows read Approved — the editor's queue never showed the email", oldLadder === "Approved");
    const { cutKeyOf } = await import("@/lib/reviewCuts");
    const gCuts = (await prisma.reviewSubmission.findMany({ where: { projectId: G.id } })).map((s) => ({ ...s, cutKey: cutKeyOf(s) }));
    c.ok("OLD: …and with no client asks folded in there is nothing a reminder could find", openRevisionAsks({ cuts: gCuts, roundOwed: false, revisionTasks: [], revisionRequestedAt: null }).length === 0);

    const q = await buildEditorQueue();
    const g = q.notDone.find((r) => r.id === G.id);
    c.ok("NEW: the row reads Revisions, Kim's, one video to redo", g?.status === "Revisions" && g?.editorKey === "kim" && g?.videosToEdit === 1, JSON.stringify({ status: g?.status, editor: g?.editorKey, toEdit: g?.videosToEdit }));
    c.ok("…carrying the client's ask (who and when)", /Gina Torres, by email/.test(g?.revisionContext ?? ""), g?.revisionContext ?? "no line");
    c.ok("…and it is not also on the Done tab", !q.done.some((r) => r.id === G.id));
    const h = q.notDone.find((r) => r.id === H.id);
    c.ok("the twice-asked video counts ONCE: one in revisions, one to redo", h?.status === "Revisions" && h?.videosToEdit === 1 && h?.progressSummary === "1 changes" && (h?.revisionAsks ?? []).length === 1, JSON.stringify({ toEdit: h?.videosToEdit, summary: h?.progressSummary, asks: h?.revisionAsks }));

    setClock(edt(10, 19, 9, 0)); // Mon 09:00 — 23.5 h after the email
    const s0 = slack.length;
    await sweep();
    c.ok("23.5 h after the email: no reminder for 77 Approved Ave", forJob(await bells("revision_waiting"), G.id).length === 0 && !dms(S.kim, s0).some((m) => m.text.startsWith("Revision waiting") && m.text.includes("77 Approved Ave")));
    const hDm0 = dms(S.kim, s0).filter((m) => m.text.startsWith("Revision waiting") && m.text.includes("88 Twice Ct"));
    c.ok("…88 Twice Ct (James's send-back, 24 h) gets ONE reminder, dated by James's verdict", hDm0.length === 1 && hDm0[0].text.includes("Video 1: James's changes from Oct 18") && forJob(await bells("revision_waiting"), H.id).length === 1, hDm0.map((m) => m.text).join(" | ") || "no DM");

    setClock(edt(10, 19, 10, 0)); // Mon 10:00 — 24.5 h
    const s1 = slack.length;
    await sweep();
    const gDm = dms(S.kim, s1).filter((m) => m.text.includes("77 Approved Ave"));
    c.ok("24.5 h: ONE reminder to Kim — the client's changes, the video's link", gDm.length === 1 && gDm[0].text === `Revision waiting 1 day — 77 Approved Ave (Gina Torres), Video 1: the client's changes from Oct 18. Upload the next version: ${BASE}/edit/${G.id}?output=${G.outputId}`, gDm.map((m) => m.text).join(" | ") || "no DM");
    c.ok("…one bell row for it", forJob(await bells("revision_waiting"), G.id).length === 1);
    c.ok("…and still one for 88 Twice Ct (the email did not start a second series)", forJob(await bells("revision_waiting"), H.id).length === 1 && !dms(S.kim, s1).some((m) => m.text.includes("88 Twice Ct")));

    // Kim hands in v2 of 77 Approved Ave.
    setClock(edt(10, 19, 11, 0));
    await mkCut(G, { round: 2, status: "PENDING", createdAt: edt(10, 19, 11) });
    const after = (await buildEditorQueue()).notDone.find((r) => r.id === G.id);
    c.ok("Kim's v2 is in: the row leaves Revisions (the verdict is the office's now)", after?.status === "Ready for review" && !after?.revisionAsks, JSON.stringify({ status: after?.status, asks: after?.revisionAsks }));
    setClock(edt(10, 20, 10, 30)); // Tue 10:30 — would be the second window
    const s2 = slack.length;
    await sweep();
    c.ok("next day: no second reminder for 77 Approved Ave", forJob(await bells("revision_waiting"), G.id).length === 1 && !dms(S.kim, s2).some((m) => m.text.includes("77 Approved Ave")));
  }

  // =========================================================================
  c.head("9 · THE CRON STEP, AND NOTHING TO A CLIENT");
  {
    const route = fs.readFileSync(path.join(REPO, "src/app/api/cron/sync/route.ts"), "utf8");
    const at = route.indexOf('step("revisionReminders"');
    c.ok("the hourly route registers the step, after reopenedClocks", at > 0 && route.indexOf('step("reopenedClocks"') > 0 && route.indexOf('step("reopenedClocks"') < at && route.includes("sweepRevisionReminders()"));
    setClock(edt(10, 20, 12, 0));
    const run = cronBudget(60_000, Date.now(), "sync");
    await run.step("revisionReminders", () => rr.sweepRevisionReminders());
    await run.finish();
    const row = await prisma.cronRun.findFirst({ where: { job: "sync" }, orderBy: { startedAt: "desc" }, select: { summary: true, error: true } });
    let summary: Record<string, unknown> = {};
    try { summary = JSON.parse(row?.summary ?? "{}"); } catch { /* unreadable */ }
    const step = summary.revisionReminders as { open?: number; failed?: unknown[] } | string | undefined;
    c.ok("the run's CronRun summary carries the step's tally, no error", !!step && !row?.error && typeof step === "object" && typeof step.open === "number", row?.summary?.slice(0, 300));
    c.ok("no text went to anyone (so none to a client)", texts.length === 0, JSON.stringify(texts));
    c.ok("no client-facing outbox message was written", (await prisma.outboxMessage.count()) === 0);
    c.ok("every Slack post went to a staff member's DM", slack.every((m) => Object.values(S).includes(m.channel)), [...new Set(slack.map((m) => m.channel))].join(","));
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
