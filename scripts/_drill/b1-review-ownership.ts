// ---------------------------------------------------------------------------
// DRILL: B1 — ONE RESPONSIBLE REVIEWER PER CUT (unified handoff §8.1; items
// O03, 8.1-reviewer-assignment, 8.1-scoped-authority,
// 8.1-notifications-oversight, 8.1-coverage-transfer, A35).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/b1-review-ownership.ts
//
// What it drives, every time through the SHIPPED code (server actions under
// AUTH_ENFORCE with getCurrentUser stubbed, the real announcer, the real
// notify bridge with Slack faked at fetch, the real hourly sweep, the real
// exceptions board):
//
//   0  THE OLD CODE, pinned to 75d56f1 and loaded from git: the cut rings the
//      OWNER+ADMIN broadcast and never names James; a designated reviewer
//      without ADMIN is refused Approve and an office note; the board counts
//      three calendar days and prints one global name on every row.
//   1  Nothing configured → the new code behaves exactly like the old.
//   2  James primary, Kyle backup, Jordan fallback → ONE reviewer per cut, one
//      SUBMITTED event, the assignee's person row + Jordan's oversight + Kyle's
//      FYI (his Slack DM kept), James bell-only by his own switch; a repeat or
//      a race writes nothing more.
//   3  Scoped authority: James approves as ADMIN and as a non-admin seat;
//      Harrison (even with the creative-manager flag), Kim and "view as" are
//      refused; Kyle/Jordan ruling on James's cut is ONE call and a COVER
//      event, never a co-approval. Roster pay/flag columns are untouched.
//   4  Away: James away moves only his PENDING cuts to Kyle; both away →
//      Jordan; all away → the office. Coming back moves nothing back.
//   5  Take / hand on: one owner, one event, FYI to the person it left; a
//      race of two takes leaves one winner.
//   6  The covered-hours clock: a Friday-5pm cut is offered to Kyle once, on
//      Monday afternoon, and nothing moves; the automatic move happens only
//      with coverTransferHours set, once.
//   7  The exceptions board: the row's own reviewer, the clock from the
//      editor's check, two COVERED days — against the old board's answers.
//   8  The /edit strip and the tracker line read the same name.
//
// ISOLATION: PGlite on 127.0.0.1:5602 (the harness); production is never
// opened; every non-loopback call is fenced; Slack is answered by a fake and
// counted; texts only ever reach the PendingSms queue (nothing flushes it).
// THE CLOCK IS PINNED to Tue Sep 22 2026 10:00 ET — cut_ready is a routine
// kind and the bridge holds routine alerts on uncovered days, so a real clock
// on a weekend would be answering a different question.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Module from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 5602);
const BASE = "75d56f1"; // pinned: the tree batch 1 starts from, never HEAD
const REPO = path.resolve(__dirname, "../..");

// ---- the clock -------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 8, 22, 14, 0, 0); // Tue Sep 22 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
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
/** An ET wall clock on a given Sep 2026 day (EDT = UTC-4). */
const et = (day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, 8, day, hour + 4, minute));

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

// The tracker's status line is a pure function in a .tsx file whose icon import
// (lucide-react) cannot evaluate under react-server; the icons are stubbed so
// the SHIPPED deriveEditStage can be called. Nothing here renders.
{
  const M = Module as unknown as { _load: (r: string, p: unknown, m: boolean) => unknown };
  const prev = M._load;
  M._load = function (r: string, p: unknown, m: boolean) {
    if (r === "lucide-react") return new Proxy({}, { get: (_t, k) => (k === "__esModule" ? true : () => null) });
    return prev.call(this, r, p, m);
  };
}

// ---- Slack, faked at fetch and counted --------------------------------------
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { channel?: string; text?: string }) : {};
  if (method === "chat.postMessage") {
    slack.push({ channel: body.channel ?? "?", text: body.text ?? "" });
    return json({ ok: true });
  }
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: `drill: ${method}` });
});

/** 75d56f1's copies, their `@/` imports aimed at this tree. */
function writeBaseCopies(): { reviewCuts: string; actions: string; board: string; page: string; wsPage: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-review-base-"));
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"));
  const show = (f: string) => execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const point = (src: string) => src.replace(/(["'])@\/([^"']+)\1/g, (_m, q: string, p: string) => `${q}${path.join(REPO, "src", p)}${q}`);
  const out = (name: string, f: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, point(show(f)));
    return p;
  };
  return {
    reviewCuts: out("reviewCuts.base.ts", "src/lib/reviewCuts.ts"),
    actions: out("reviewActions.base.ts", "src/app/review/actions.ts"),
    board: out("opsExceptions.base.ts", "src/lib/opsExceptions.ts"),
    page: out("reviewPage.base.tsx", "src/app/review/page.tsx"),
    wsPage: out("reviewWorkspacePage.base.tsx", "src/app/review/[id]/page.tsx"),
  };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { saveSecret } = await import("@/lib/integrations/connections");
  const { putSetting } = await import("@/lib/settings");
  const { notifyPrefsFor } = await import("@/lib/notifyPrefs");
  const { announceCutInReview } = await import("@/lib/reviewCuts");
  const ra = await import("@/lib/reviewerAssignment");
  const actions = await import("@/app/review/actions");
  const { opsExceptionsBoard } = await import("@/lib/opsExceptions");
  const { coveredHoursBetween, coverageRules } = await import("@/lib/coverage");
  const { deriveEditStage } = await import("@/components/editing/EditTracker");
  const baseFiles = writeBaseCopies();
  type AnnounceFn = typeof announceCutInReview;
  const base = {
    announce: ((await import(baseFiles.reviewCuts)) as { announceCutInReview: AnnounceFn }).announceCutInReview,
    actions: (await import(baseFiles.actions)) as typeof actions,
    board: ((await import(baseFiles.board)) as { opsExceptionsBoard: typeof opsExceptionsBoard }).opsExceptionsBoard,
  };

  console.log(`drill clock: ${new Date().toISOString()} (pinned — Tue Sep 22 2026, 10:00 ET)`);
  await saveSecret("slack", "xoxb-drill-not-a-real-token");

  // ---- the cast, as production has it (every row before the first notify:
  // the notify stack caches the owner/office lists for ten minutes) ---------
  type TeamRole = "ADMIN" | "MANAGER" | "SALES" | "PHOTOGRAPHER" | "EDITOR" | "VA";
  const member = (name: string, email: string, role: TeamRole, extra: Record<string, unknown> = {}) =>
    prisma.teamMember.create({
      data: { name, email, role, phone: `(610) 555-01${String(email.length).padStart(2, "0")}`, slackId: `U-${name.split(" ")[0].toUpperCase()}`, active: true, payPercent: 0.35, payFloor: 100, ...extra },
      select: { id: true, name: true },
    });
  const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER");
  const kyle = await member("Kyle Cabrera", "kyle@drill.invalid", "MANAGER");
  // James: PHOTOGRAPHER on the roster, the creative-manager flag ON, ADMIN by
  // login (session records) — the shape the notification bridge used to skip.
  const james = await member("James Rivera", "james@drill.invalid", "PHOTOGRAPHER", { creativeManager: true });
  const harrison = await member("Harrison Wells", "harrison@drill.invalid", "PHOTOGRAPHER");
  const kim = await member("Kim Miguel", "kim@drill.invalid", "EDITOR");
  const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
    prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
  const uJordan = await login("jordan@drill.invalid", "OWNER", jordan.id);
  const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
  const uJames = await login("james@drill.invalid", "ADMIN", james.id);
  const uHarrison = await login("harrison@drill.invalid", "PHOTOGRAPHER", harrison.id);
  const uKim = await login("kim@drill.invalid", "EDITOR", kim.id, { editorKey: "kim" });
  // Saved matrices as production has them (Sep 21 reads): Jordan Slack+text,
  // Kyle Slack for "video in review". James: none saved — his shipped default.
  await putSetting(`notify-prefs:${jordan.id}`, { mention: { slack: true, sms: true }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: true, sms: true }, shoot_change: { slack: true, sms: true } });
  await putSetting(`notify-prefs:${kyle.id}`, { mention: { slack: true, sms: false }, project_message: { slack: false, sms: false }, job_ping: { slack: false, sms: false }, review_ready: { slack: true, sms: false }, shoot_change: { slack: true, sms: false } });

  const as = (u: { id: string }, tm: { id: string; name: string }, role: string, over: Partial<Viewer> = {}): Viewer => ({
    id: u.id, email: `${tm.name.split(" ")[0].toLowerCase()}@drill.invalid`, name: tm.name, role, permissions: null, status: "ACTIVE",
    teamMemberId: tm.id, editorKey: role === "EDITOR" ? "kim" : null, notificationsSeenAt: null, impersonating: false,
    realRole: role, realName: tm.name, ...over,
  });
  const V = {
    jordan: as(uJordan, jordan, "OWNER"),
    kyle: as(uKyle, kyle, "ADMIN"),
    jamesAdmin: as(uJames, james, "ADMIN"),
    jamesSeat: as(uJames, james, "PHOTOGRAPHER"), // a designated seat WITHOUT admin
    harrison: as(uHarrison, harrison, "PHOTOGRAPHER"),
    kim: as(uKim, kim, "EDITOR"),
    // Jordan previewing as James: effective = James, real = OWNER.
    preview: as(uJames, james, "PHOTOGRAPHER", { impersonating: true, realRole: "OWNER", realName: "Jordan Spackman" }),
  };

  const client = await prisma.client.create({ data: { name: "Drill Client" }, select: { id: true } });
  let seq = 0;
  const mkJob = async (street: string, photographerId: string | null = harrison.id) => {
    const p = await prisma.project.create({
      data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "REVIEW", addressLine: street, photographerId },
      select: { id: true },
    });
    const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
    return { id: p.id, deliverableId: d.id, street };
  };
  type Job = Awaited<ReturnType<typeof mkJob>>;
  const mkCut = async (job: Job, over: Record<string, unknown> = {}) => {
    seq++;
    const row = await prisma.reviewSubmission.create({
      data: {
        projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: seq, kind: "video", source: "upload",
        status: "PENDING", fileName: `cut-${seq}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel",
        createdAt: new Date(Date.now() - 60_000), ...over,
      },
      select: { id: true },
    });
    await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: `/api/review/cut/${row.id}/stream` } });
    return row.id;
  };
  const announceWith = (fn: AnnounceFn, job: Job, id: string) =>
    fn({ kind: "cut_ready", projectId: job.id, submissionId: id, round: 1, street: job.street, fileName: "cut.mp4", editorKey: "kim", editorName: "Kim Miguel" });
  const announce = (job: Job, id: string) => announceWith(announceCutInReview, job, id);
  const rowsFor = (id: string) =>
    prisma.notification.findMany({ where: { dedupeKey: { startsWith: `cut-in-review-${id}-` } }, select: { userKey: true, audience: true, kind: true } });
  const events = (id: string) => prisma.cutReviewerEvent.findMany({ where: { submissionId: id }, orderBy: { at: "asc" } });
  const sub = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id }, select: { status: true, reviewerTeamMemberId: true, reviewerRole: true, reviewerAssignedAt: true } });
  const dmsTo = (tm: { name: string }) => slack.filter((m) => m.channel === `U-${tm.name.split(" ")[0].toUpperCase()}`);
  const smsFor = (tm: { id: string }) => prisma.pendingSms.count({ where: { teamMemberId: tm.id } });
  const setChain = (over: Record<string, unknown> = {}) =>
    putSetting("review_room", {
      discoverFromDropbox: false, keepUploadsDays: 90,
      creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
      coverOfferHours: 9, coverTransferHours: null, ...over,
    });
  const roster = () =>
    prisma.teamMember.findMany({ orderBy: { email: "asc" }, select: { id: true, name: true, role: true, creativeManager: true, payPercent: true, payFloor: true, payType: true, monthlyPay: true, hourlyRate: true, opsAlerts: true } });
  const rosterBefore = JSON.stringify(await roster());
  const editorNote = (job: Job, id: string, body: string) =>
    prisma.mediaNote.create({ data: { projectId: job.id, assetUrl: `/api/review/cut/${id}/stream`, assetType: "video", lane: "EDITOR", kind: "fix", body, status: "OPEN", authorKey: "owner", authorName: "Jordan" } });

  // =========================================================================
  c.head("0 · THE OLD CODE (75d56f1): nobody owns a cut, and approval means ADMIN");
  const J0 = await mkJob("10 Old Code Ln");
  const cut0 = await mkCut(J0);
  await base.announce({ kind: "cut_ready", projectId: J0.id, submissionId: cut0, round: 1, street: J0.street, fileName: "cut.mp4", editorKey: "kim", editorName: "Kim Miguel" });
  const old0 = await rowsFor(cut0);
  c.ok("old: the cut rings ONE office broadcast (OWNER+ADMIN, no person)", old0.filter((r) => !r.userKey && r.audience.includes("ADMIN")).length === 1, JSON.stringify(old0));
  c.ok("old: …and never names James — no tm:<james> row", !old0.some((r) => r.userKey === `tm:${james.id}`));
  c.ok("old: James gets no Slack DM (his roster role keeps him off the office bridge)", dmsTo(james).length === 0);
  // Even with James NAMED as the approver, the old actions answer by role only.
  await setChain();
  const cut0b = await mkCut(J0);
  viewer = V.jamesSeat;
  const oldApprove = await base.actions.approveCut(cut0b);
  c.ok("old: a designated reviewer without ADMIN is refused Approve", !oldApprove.ok && /access/i.test(oldApprove.message), oldApprove.message);
  const oldNote = await base.actions.addCutNote({ projectId: J0.id, submissionId: cut0b, body: "Trim the intro", lane: "EDITOR", kind: "fix", timeSec: 3 });
  c.ok("old: …and an office note on the editor lane", !oldNote.ok, oldNote.message ?? "");
  c.ok("old: the cut is still PENDING and nobody's", (await sub(cut0b)).status === "PENDING" && (await sub(cut0b)).reviewerTeamMemberId === null);
  viewer = null;
  await putSetting("review_room", { discoverFromDropbox: false, keepUploadsDays: 90, creativeApproverTeamMemberId: null });

  // =========================================================================
  c.head("1 · NOTHING CONFIGURED: the new code rings exactly as the old one did");
  const J1 = await mkJob("11 Unset Rd");
  const cut1 = await mkCut(J1);
  slack.length = 0;
  const jordanSms1 = await smsFor(jordan);
  await announce(J1, cut1);
  const r1 = await rowsFor(cut1);
  c.ok("no chain → no reviewer and no event", (await sub(cut1)).reviewerTeamMemberId === null && (await events(cut1)).length === 0);
  c.ok("…the same office broadcast + the shooter's row", r1.length === 2 && r1.filter((r) => !r.userKey && r.audience.includes("ADMIN")).length === 1 && r1.some((r) => r.userKey === `tm:${harrison.id}`), JSON.stringify(r1));
  c.ok("…Kyle still Slacked, Jordan Slacked and texted", dmsTo(kyle).length === 1 && dmsTo(jordan).length === 1 && (await smsFor(jordan)) === jordanSms1 + 1, `kyle ${dmsTo(kyle).length} jordan ${dmsTo(jordan).length}`);

  // =========================================================================
  c.head("2 · JAMES → KYLE → JORDAN: one reviewer per cut, assigned as it enters review");
  await setChain();
  const chain = await ra.reviewerChain();
  c.ok("the chain reads three seats in order", chain.members.map((m) => m.slot).join(",") === "PRIMARY,BACKUP,FALLBACK" && chain.members.every((m) => m.canRule));
  c.ok("the active reviewer is James", (await ra.resolveActiveReviewer())?.teamMemberId === james.id);
  c.ok("James's own 'video in review' switch is bell-only (shipped default, never flipped here)", !(await notifyPrefsFor(james.id)).review_ready.slack && !(await notifyPrefsFor(james.id)).review_ready.sms);
  const J2 = await mkJob("12 Owner St");
  const cut2 = await mkCut(J2);
  slack.length = 0;
  const jordanSmsBefore = await smsFor(jordan);
  await announce(J2, cut2);
  const s2 = await sub(cut2);
  const e2 = await events(cut2);
  c.ok("the cut is James's, as PRIMARY", s2.reviewerTeamMemberId === james.id && s2.reviewerRole === "PRIMARY", JSON.stringify(s2));
  c.ok("…with exactly one SUBMITTED event", e2.length === 1 && e2[0].reason === "SUBMITTED" && e2[0].fromTeamMemberId === null);
  const r2 = await rowsFor(cut2);
  c.ok("James gets his OWN person row (not only an ADMIN bell)", r2.filter((r) => r.userKey === `tm:${james.id}`).length === 1, JSON.stringify(r2));
  c.ok("Jordan gets ONE oversight row (OWNER only, not assigned work)", r2.filter((r) => !r.userKey && r.audience === JSON.stringify(["OWNER"])).length === 1);
  c.ok("Kyle gets ONE FYI person row", r2.filter((r) => r.userKey === `tm:${kyle.id}`).length === 1);
  c.ok("the ADMIN role broadcast is gone — no second bell for the assignee", !r2.some((r) => !r.userKey && r.audience.includes("ADMIN")));
  c.ok("the shooter still hears it", r2.some((r) => r.userKey === `tm:${harrison.id}`));
  // Jordan, Sep 25: all three are told; Kyle's copy names his part in it.
  c.ok("Kyle's Slack DM is kept, and says James is first and Kyle may rule", dmsTo(kyle).length === 1 && /James reviews it first/.test(dmsTo(kyle)[0].text) && /approve it or send it back yourself/.test(dmsTo(kyle)[0].text), dmsTo(kyle)[0]?.text ?? "none");
  c.ok("Jordan's oversight DM says James is first and he may approve any time, and his text is queued as before", dmsTo(jordan).length === 1 && /James reviews it first/.test(dmsTo(jordan)[0].text) && /approve it any time/.test(dmsTo(jordan)[0].text) && (await smsFor(jordan)) === jordanSmsBefore + 1, dmsTo(jordan)[0]?.text ?? "none");
  c.ok("James: bell only — no DM, no text", dmsTo(james).length === 0 && (await smsFor(james)) === 0);
  const jamesLegs = await prisma.notificationDelivery.findMany({ where: { teamMemberId: james.id }, select: { channel: true, status: true } });
  c.ok("…and his delivery log says bell, nothing else", jamesLegs.length >= 1 && jamesLegs.every((l) => l.channel === "bell"), JSON.stringify(jamesLegs));
  const rowsBefore = await prisma.notification.count();
  await announce(J2, cut2);
  c.ok("a repeat announce adds 0 rows and 0 events", (await prisma.notification.count()) === rowsBefore && (await events(cut2)).length === 1);
  const cut3 = await mkCut(J2);
  await Promise.all([announce(J2, cut3), announce(J2, cut3), ra.ensureCutReviewer(cut3)]);
  c.ok("a three-way race on entry writes ONE event", (await events(cut3)).length === 1 && (await sub(cut3)).reviewerTeamMemberId === james.id, String((await events(cut3)).length));
  c.ok("…and one set of rows (4: James, Jordan, Kyle, shooter)", (await rowsFor(cut3)).length === 4, String((await rowsFor(cut3)).length));
  c.ok("a notification never moved the cut: still PENDING, still James's", (await sub(cut2)).status === "PENDING" && (await sub(cut2)).reviewerTeamMemberId === james.id);
  const Jshot = await mkJob("13 Shot By James", james.id);
  const cutShot = await mkCut(Jshot);
  await announce(Jshot, cutShot);
  c.ok("James shooting a job he reviews hears it ONCE, as its reviewer", (await rowsFor(cutShot)).filter((r) => r.userKey === `tm:${james.id}`).length === 1);

  // =========================================================================
  c.head("3 · SCOPED AUTHORITY on the real server actions (AUTH_ENFORCE on)");
  viewer = V.jamesAdmin;
  const a2 = await actions.approveCut(cut2);
  c.ok("James as ADMIN → Approve works", a2.ok && (await sub(cut2)).status === "APPROVED", a2.message);
  c.ok("…his own cut: no COVER event", (await events(cut2)).length === 1);
  viewer = V.jamesSeat;
  const a3 = await actions.approveCut(cut3);
  c.ok("James as a NON-admin designated seat → Approve works", a3.ok && (await sub(cut3)).status === "APPROVED", a3.message);
  const cut4 = await mkCut(J2);
  await announce(J2, cut4);
  const n4 = await actions.addCutNote({ projectId: J2.id, submissionId: cut4, body: "Cut the drone shot at 0:04", lane: "EDITOR", kind: "fix", timeSec: 4 });
  c.ok("…an office note on the editor lane works (the old code refused it)", n4.ok, n4.message ?? "");
  const b4 = await actions.requestCutChanges(cut4);
  c.ok("…and Send back works", b4.ok && (await sub(cut4)).status === "CHANGES_REQUESTED", b4.message);
  const cut5 = await mkCut(J2);
  await announce(J2, cut5);
  viewer = V.harrison;
  const h5 = await actions.approveCut(cut5);
  c.ok("Harrison (photographer, no seat) → refused", !h5.ok && /access/i.test(h5.message), h5.message);
  await prisma.teamMember.update({ where: { id: harrison.id }, data: { creativeManager: true } });
  const h5b = await actions.approveCut(cut5);
  c.ok("…flipping the creative-manager flag on him grants NOTHING", !h5b.ok && (await sub(cut5)).status === "PENDING", h5b.message);
  await prisma.teamMember.update({ where: { id: harrison.id }, data: { creativeManager: false } });
  viewer = V.kim;
  const k5 = await actions.approveCut(cut5);
  c.ok("Kim (editor) → refused", !k5.ok, k5.message);
  viewer = V.preview;
  const p5 = await actions.approveCut(cut5);
  c.ok("Jordan previewing as James → refused ('view as' is read-only)", !p5.ok && /previewing/i.test(p5.message), p5.message);
  viewer = V.kyle;
  const ky5 = await actions.approveCut(cut5);
  const e5 = await events(cut5);
  c.ok("Kyle approving JAMES's cut → APPROVED in ONE call", ky5.ok && (await sub(cut5)).status === "APPROVED", ky5.message);
  c.ok("…recorded as ONE COVER event James → Kyle", e5.length === 2 && e5[1].reason === "COVER" && e5[1].fromTeamMemberId === james.id && e5[1].toTeamMemberId === kyle.id, JSON.stringify(e5.map((e) => e.reason)));
  c.ok("…Kyle is the reviewer of record (role COVER)", (await sub(cut5)).reviewerTeamMemberId === kyle.id && (await sub(cut5)).reviewerRole === "COVER");
  const cut6 = await mkCut(J2);
  await announce(J2, cut6);
  await editorNote(J2, cut6, "Colour is off in the kitchen");
  viewer = V.jordan;
  const jo6 = await actions.requestCutChanges(cut6);
  c.ok("Jordan sending back James's cut → ONE call, no co-approval", jo6.ok && (await sub(cut6)).status === "CHANGES_REQUESTED", jo6.message);
  c.ok("…recorded as a COVER by Jordan", (await events(cut6)).some((e) => e.reason === "COVER" && e.toTeamMemberId === jordan.id));
  viewer = null;
  c.ok("the roster's pay and flag columns are byte-identical (creativeManager, bonus basis inputs)", JSON.stringify(await roster()) === rosterBefore);
  const src = fs.readFileSync(path.join(REPO, "src/lib/reviewerAssignment.ts"), "utf8");
  c.ok("…and the new module never READS creativeManager", !/creativeManager\s*[:=!]|\.creativeManager\b|creativeManager\s*:\s*true/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));

  // =========================================================================
  c.head("4 · AWAY: the one automatic move, and it follows a person's own switch");
  const J4 = await mkJob("14 Away Ave");
  const cut7 = await mkCut(J4);
  const cut8 = await mkCut(J4);
  await announce(J4, cut7);
  await announce(J4, cut8);
  viewer = V.jordan;
  const away1 = await actions.setCutReviewerAway(james.id, "2026-09-25");
  c.ok("Jordan marks James away", away1.ok, away1.message);
  c.ok("…James's two PENDING cuts moved to Kyle", (await sub(cut7)).reviewerTeamMemberId === kyle.id && (await sub(cut8)).reviewerTeamMemberId === kyle.id);
  c.ok("…one AWAY_TRANSFER event each", (await events(cut7)).filter((e) => e.reason === "AWAY_TRANSFER").length === 1 && (await events(cut8)).filter((e) => e.reason === "AWAY_TRANSFER").length === 1);
  c.ok("…a cut he already APPROVED stays his (only PENDING moves)", (await sub(cut2)).reviewerTeamMemberId === james.id && (await sub(cut2)).status === "APPROVED");
  const kyleNow = await prisma.notification.count({ where: { userKey: `tm:${kyle.id}`, dedupeKey: { startsWith: `cut-reviewer-${cut7}-` } } });
  const jamesFyi = await prisma.notification.count({ where: { userKey: `tm:${james.id}`, kind: "review_reassigned", dedupeKey: { startsWith: `cut-reviewer-fyi-${cut7}-` } } });
  c.ok("…Kyle is told it's his; James gets an FYI bell", kyleNow === 1 && jamesFyi === 1, `kyle ${kyleNow} james ${jamesFyi}`);
  const cut9 = await mkCut(J4);
  await announce(J4, cut9);
  c.ok("a cut arriving while James is away goes to Kyle (BACKUP)", (await sub(cut9)).reviewerTeamMemberId === kyle.id && (await sub(cut9)).reviewerRole === "BACKUP");
  c.ok("…and James, away, is not FYI'd about it", !(await rowsFor(cut9)).some((r) => r.userKey === `tm:${james.id}`));
  await actions.setCutReviewerAway(kyle.id, "2026-09-25");
  c.ok("Kyle away too → his waiting cuts go to Jordan", [cut7, cut8, cut9].every(Boolean) && (await sub(cut9)).reviewerTeamMemberId === jordan.id);
  slack.length = 0;
  const cut10 = await mkCut(J4);
  await announce(J4, cut10);
  c.ok("a new cut with both away → Jordan (FALLBACK)", (await sub(cut10)).reviewerTeamMemberId === jordan.id && (await sub(cut10)).reviewerRole === "FALLBACK");
  c.ok("…his line says it is waiting on HIM", dmsTo(jordan).some((m) => /waiting on you/i.test(m.text)), dmsTo(jordan).map((m) => m.text).join(" | "));
  await actions.setCutReviewerAway(jordan.id, "2026-09-25");
  const cut11 = await mkCut(J4);
  await announce(J4, cut11);
  const r11 = await rowsFor(cut11);
  c.ok("all three away → nobody holds it and the office is rung the old way", (await sub(cut11)).reviewerTeamMemberId === null && r11.some((r) => !r.userKey && r.audience.includes("ADMIN")));
  await actions.setCutReviewerAway(jordan.id, null);
  await actions.setCutReviewerAway(kyle.id, null);
  await actions.setCutReviewerAway(james.id, null);
  c.ok("coming back moves nothing back", (await sub(cut7)).reviewerTeamMemberId === jordan.id && (await sub(cut9)).reviewerTeamMemberId === jordan.id);
  viewer = V.jamesSeat;
  const selfAway = await actions.setCutReviewerAway(james.id, "2026-09-23");
  const otherAway = await actions.setCutReviewerAway(kyle.id, "2026-09-23");
  c.ok("a seat can mark ITSELF away…", selfAway.ok, selfAway.message);
  c.ok("…but not someone else", !otherAway.ok, otherAway.message);
  await actions.setCutReviewerAway(james.id, null);
  viewer = null;

  // =========================================================================
  c.head("5 · TAKE AND HAND ON: one owner, one event, and nobody told about their own press");
  const J5 = await mkJob("15 Claim Ct");
  const cut12 = await mkCut(J5);
  await announce(J5, cut12);
  viewer = V.kyle;
  const cl = await actions.claimCutReview(cut12);
  const e12 = await events(cut12);
  c.ok("Kyle takes James's cut", cl.ok && (await sub(cut12)).reviewerTeamMemberId === kyle.id && (await sub(cut12)).reviewerRole === "MANUAL", cl.message);
  c.ok("…one CLAIM event", e12.length === 2 && e12[1].reason === "CLAIM");
  c.ok("…James gets the FYI bell, Kyle gets no notice of his own press",
    (await prisma.notification.count({ where: { userKey: `tm:${james.id}`, kind: "review_reassigned", dedupeKey: { startsWith: `cut-reviewer-fyi-${cut12}-` } } })) === 1 &&
    (await prisma.notification.count({ where: { userKey: `tm:${kyle.id}`, dedupeKey: { startsWith: `cut-reviewer-${cut12}-` } } })) === 0);
  viewer = V.jordan;
  const hand = await actions.reassignCutReviewer(cut12, james.id, "He knows this agent");
  c.ok("Jordan hands it back to James, with a note", hand.ok && (await sub(cut12)).reviewerTeamMemberId === james.id && (await events(cut12)).at(-1)?.reason === "MANUAL" && (await events(cut12)).at(-1)?.note === "He knows this agent", hand.message);
  c.ok("…James is told it is his (a cut_ready person row)", (await prisma.notification.count({ where: { userKey: `tm:${james.id}`, kind: "cut_ready", dedupeKey: { startsWith: `cut-reviewer-${cut12}-` } } })) === 1);
  const toHarrison = await actions.reassignCutReviewer(cut12, harrison.id);
  c.ok("handing it to someone who cannot rule is refused", !toHarrison.ok && (await sub(cut12)).reviewerTeamMemberId === james.id, toHarrison.message);
  const decided = await actions.claimCutReview(cut2);
  c.ok("taking a cut that already has a verdict is refused", !decided.ok, decided.message);
  const cut13 = await mkCut(J5);
  await announce(J5, cut13);
  const [t1, t2] = await Promise.all([
    ra.takeCutReview(cut13, { teamMemberId: kyle.id, name: "Kyle Cabrera", userId: uKyle.id }),
    ra.takeCutReview(cut13, { teamMemberId: jordan.id, name: "Jordan Spackman", userId: uJordan.id }),
  ]);
  const e13 = await events(cut13);
  c.ok("two takes at once: exactly one wins", [t1, t2].filter((t) => t.ok).length === 1 && e13.length === 2, `${t1.message} / ${t2.message} / events ${e13.length}`);
  viewer = V.kim;
  const kimClaim = await actions.claimCutReview(cut13);
  c.ok("an editor cannot take a cut", !kimClaim.ok, kimClaim.message);
  viewer = null;

  // =========================================================================
  c.head("6 · THE COVERED-HOURS CLOCK: offer once, move only when told to");
  const cov = await coverageRules();
  c.ok("Fri 5pm → Mon 9am is ONE covered hour", coveredHoursBetween(et(18, 17), et(21, 9), cov) === 1);
  c.ok("Mon 10am → Tue 10am is nine", coveredHoursBetween(et(21, 10), et(22, 10), cov) === 9);
  c.ok("Fri 5pm → Mon 5pm is nine", coveredHoursBetween(et(18, 17), et(21, 17), cov) === 9);
  const J6 = await mkJob("16 Weekend Way");
  // THE HOURLY LABEL: the cut announced while all three were away, the one
  // from before the chain existed — and one that never entered review.
  const heldCut = await mkCut(J6); // e.g. still waiting on the editor's check
  // …and one the editor's check sent BACK after it had rung (§8.2 voids a
  // check on new bytes): an old announcement row exists, the row is held.
  const voidedCut = await mkCut(J6, { selfCheckId: "chk-drill-void" });
  await prisma.notification.create({ data: { kind: "cut_ready", title: "old ring", href: "/review", audience: JSON.stringify(["OWNER", "ADMIN"]), dedupeKey: `cut-in-review-${voidedCut}-0` } });
  const notesBefore = await prisma.notification.count();
  const label = await ra.reviewCoverSweep({ now: et(21, 16) });
  c.ok("the sweep gives the office's orphan (announced, nobody present) a reviewer", (await sub(cut11)).reviewerTeamMemberId === james.id && label.labelled >= 2, JSON.stringify(label));
  c.ok("…the pre-chain cut from section 1 too", (await sub(cut1)).reviewerTeamMemberId === james.id);
  c.ok("…silently: it already rang the office once", (await prisma.notification.count()) === notesBefore);
  c.ok("…but never a row that was not announced (assignment is not a way in)", (await sub(heldCut)).reviewerTeamMemberId === null);
  c.ok("…nor one held for the editor's check, even if it once rang", (await sub(voidedCut)).reviewerTeamMemberId === null);
  viewer = V.kyle;
  const takeHeld = await actions.claimCutReview(voidedCut);
  c.ok("taking a cut still waiting on the editor's check is refused", !takeHeld.ok && /editor's check/.test(takeHeld.message), takeHeld.message);
  c.ok("…and the /edit strip does not list it", !(await ra.reviewerStripFor(J6.id, V.kyle)).rows.some((r) => r.submissionId === voidedCut));
  viewer = null;
  const cut14 = await mkCut(J6, { createdAt: et(18, 16, 55) });
  await ra.ensureCutReviewer(cut14, { at: et(18, 17) });
  c.ok("a Friday-5pm cut is James's from 5pm", (await sub(cut14)).reviewerTeamMemberId === james.id && (await sub(cut14)).reviewerAssignedAt?.getTime() === et(18, 17).getTime());
  const offers = () => prisma.notification.count({ where: { kind: "review_cover_offer", userKey: `tm:${kyle.id}`, dedupeKey: `review-cover-offer-${cut14}-0` } });
  await ra.reviewCoverSweep({ now: et(21, 16) });
  c.ok("Monday 4pm (8 covered hours): no offer yet", (await offers()) === 0);
  await ra.reviewCoverSweep({ now: et(21, 17, 30) });
  c.ok("Monday 5:30pm (9½ covered hours): Kyle is offered it, once", (await offers()) === 1);
  await ra.reviewCoverSweep({ now: et(21, 17, 45) });
  c.ok("…a second sweep offers nothing more", (await offers()) === 1);
  const offerRow = await prisma.notification.findFirst({ where: { kind: "review_cover_offer", userKey: `tm:${kyle.id}`, dedupeKey: `review-cover-offer-${cut14}-0` } });
  c.ok("…it tells Kyle to rule himself, in the Review Room (Jordan, Sep 25)",
    !!offerRow && /hasn't got to/.test(offerRow.title) && /approve it or send it back yourself/.test(offerRow.title) && offerRow.href === `/review/${J6.id}?cut=${cut14}`,
    JSON.stringify({ t: offerRow?.title, b: offerRow?.body, h: offerRow?.href }));
  c.ok("…and NOTHING moved: still James's, still one event", (await sub(cut14)).reviewerTeamMemberId === james.id && (await events(cut14)).length === 1);
  await ra.reviewCoverSweep({ now: et(28, 17) });
  c.ok("automatic move OFF (null): a week later it is still James's", (await sub(cut14)).reviewerTeamMemberId === james.id);
  // A cut chosen BY HAND, aged the same, must not be moved by the rule.
  await prisma.reviewSubmission.update({ where: { id: cut12 }, data: { reviewerAssignedAt: et(18, 17) } });
  await setChain({ coverTransferHours: 9 });
  const moved = await ra.reviewCoverSweep({ now: et(21, 17, 30) });
  const e14 = await events(cut14);
  c.ok("with coverTransferHours = 9 it moves ONCE, to Kyle", (await sub(cut14)).reviewerTeamMemberId === kyle.id && e14.filter((e) => e.reason === "AUTO_TRANSFER").length === 1, JSON.stringify(moved));
  c.ok("…with one notice to Kyle", (await prisma.notification.count({ where: { userKey: `tm:${kyle.id}`, kind: "cut_ready", dedupeKey: { startsWith: `cut-reviewer-${cut14}-` } } })) === 1);
  await ra.reviewCoverSweep({ now: et(21, 17, 30) });
  c.ok("…a second sweep is a no-op", (await events(cut14)).length === e14.length);
  c.ok("a cut someone chose BY HAND is never moved by the rule", (await sub(cut12)).reviewerTeamMemberId === james.id);
  await setChain();

  // =========================================================================
  c.head("7 · THE EXCEPTIONS BOARD: the row's own reviewer, on covered days");
  const J7 = await mkJob("17 Board Blvd");
  const cut15 = await mkCut(J7, { createdAt: et(21, 10) });
  await ra.ensureCutReviewer(cut15, { at: et(21, 10) });
  await ra.handCutReview(cut15, kyle.id, { teamMemberId: jordan.id, name: "Jordan Spackman", userId: uJordan.id });
  const cut16 = await mkCut(J7, { createdAt: et(21, 10), selfCheckedAt: et(22, 10) });
  await ra.ensureCutReviewer(cut16, { at: et(22, 10) });
  const cut17 = await mkCut(J7, { createdAt: et(21, 10) }); // never announced: nobody holds it
  const row = async (b: Awaited<ReturnType<typeof opsExceptionsBoard>>, id: string) => b.rows.find((r) => r.id === `review:${id}`);
  const tue6 = await opsExceptionsBoard({ now: et(22, 18) });
  c.ok("Tue 6pm (17 covered hours): not on the board yet", !(await row(tue6, cut15)));
  const wed10 = await opsExceptionsBoard({ now: et(23, 10) });
  const w15 = await row(wed10, cut15);
  c.ok("Wed 10am (two covered days): on Jordan's board", !!w15, JSON.stringify(wed10.totals["aging-review"]));
  c.ok("…owned by the cut's OWN reviewer — Kyle, who holds it", w15?.owner === "Kyle Cabrera", w15?.owner ?? "none");
  c.ok("…and the sentence counts covered days", /2 covered days/.test(w15?.why ?? ""), w15?.why ?? "");
  c.ok("the clock starts at the editor's check: 9 covered hours since → not on the board", !(await row(wed10, cut16)));
  c.ok("an unheld cut shows the board-wide label (the office's approver)", (await row(wed10, cut17))?.owner === "James Rivera", (await row(wed10, cut17))?.owner ?? "none");
  const oldWed = await base.board({ now: et(23, 10) });
  c.ok("old board, same moment: three CALENDAR days, so it does not show", !oldWed.rows.some((r) => r.id === `review:${cut15}`));
  const oldThu = await base.board({ now: et(24, 11) });
  const o15 = oldThu.rows.find((r) => r.id === `review:${cut15}`);
  c.ok("old board, Thursday: it prints the ONE global name on a cut Kyle holds", o15?.owner === "James Rivera", o15?.owner ?? "none");
  const newThu = await opsExceptionsBoard({ now: et(24, 11) });
  c.ok("new board, Thursday: Kyle", (await row(newThu, cut15))?.owner === "Kyle Cabrera");

  // =========================================================================
  c.head("8 · THE /edit STRIP AND THE TRACKER SAY THE SAME NAME");
  const J8 = await mkJob("18 Strip St");
  const cut18 = await mkCut(J8, { createdAt: et(18, 16, 55) });
  await ra.ensureCutReviewer(cut18, { at: et(18, 17) });
  const stripKyle = await ra.reviewerStripFor(J8.id, V.kyle, { now: et(21, 17, 30) });
  const s18 = stripKyle.rows.find((r) => r.submissionId === cut18);
  c.ok("Kyle sees it with James, 9½ covered hours, and the cover offered", s18?.reviewer?.id === james.id && s18.coverOffered && stripKyle.canRule, JSON.stringify(s18));
  c.ok("…and can hand it to any seat", ["James Rivera", "Kyle Cabrera", "Jordan Spackman"].every((n) => stripKyle.candidates.some((cc) => cc.name === n)));
  const stripJames = await ra.reviewerStripFor(J8.id, V.jamesSeat, { now: et(21, 17, 30) });
  c.ok("James sees it as waiting on him", stripJames.rows.find((r) => r.submissionId === cut18)?.mine === true);
  const stripKim = await ra.reviewerStripFor(J8.id, V.kim, { now: et(21, 17, 30) });
  c.ok("Kim (editor) sees the name and no doors", !stripKim.canRule && stripKim.candidates.length === 0 && stripKim.rows[0]?.reviewer?.name === "James Rivera");
  const stage = (reviewerName?: string | null) =>
    deriveEditStage({ projectStatus: "REVIEW", revisionOpen: false, revisionAfterApproval: false, latestRoundStatus: "PENDING", rawsLanded: true, reviewerName }).label;
  c.ok("tracker: 'Ready for review — with James' when he holds it", stage("James Rivera") === "Ready for review — with James", stage("James Rivera"));
  c.ok("tracker: unchanged wording when nobody is named", stage(null) === "Ready for review — with Jordan");
  viewer = V.kyle;
  const seats = await actions.loadCutReviewerSeats();
  const jamesSeat = seats.find((s) => s.id === james.id);
  c.ok("Settings: James's seat reads 'bell-only' (his switch, shown not flipped)", !!jamesSeat && !jamesSeat.reviewReady.slack && !jamesSeat.reviewReady.sms && jamesSeat.canRuleIfDesignated);
  viewer = V.harrison;
  c.ok("…and the seat list is the desk's only", (await actions.loadCutReviewerSeats()).length === 0);
  viewer = null;

  // =========================================================================
  c.head("R · REVIEW FIXES (Sep 25): who may hold a seat, and a seat that has a desk");
  // =========================================================================
  {
    // #10 an ADMIN could seat an editor (who could then approve their own
    // cut); seats are validated on the server now, and a grant of approval to
    // a login that is not owner/admin is the owner's call.
    const prev = await (await import("@/lib/settings")).reviewRoomRules();
    const kimAsBackup = await ra.validateReviewSeats(prev, { ...prev, backupReviewerTeamMemberId: kim.id }, "ADMIN");
    c.ok("#10 an editor login can't be seated (even by the owner)", !kimAsBackup.ok && !(await ra.validateReviewSeats(prev, { ...prev, backupReviewerTeamMemberId: kim.id }, "OWNER")).ok, kimAsBackup.ok ? "" : kimAsBackup.message);
    const harrisonByKyle = await ra.validateReviewSeats(prev, { ...prev, fallbackReviewerTeamMemberId: harrison.id }, "ADMIN");
    c.ok("#10 Kyle (ADMIN) seating Harrison (a photographer login) is refused — only Jordan grants that", !harrisonByKyle.ok && /only Jordan/i.test(harrisonByKyle.message), harrisonByKyle.ok ? "" : harrisonByKyle.message);
    c.ok("#10 …Jordan (OWNER) may", (await ra.validateReviewSeats(prev, { ...prev, fallbackReviewerTeamMemberId: harrison.id }, "OWNER")).ok);
    c.ok("#10 …and an ADMIN may still reorder the seats already held", (await ra.validateReviewSeats(prev, { ...prev, creativeApproverTeamMemberId: kyle.id, backupReviewerTeamMemberId: james.id }, "ADMIN")).ok);
    const settingsActions = await import("@/app/settings/actions");
    viewer = V.kyle;
    const saved = await settingsActions.saveReviewRoomRules({ ...prev, backupReviewerTeamMemberId: kim.id });
    viewer = null;
    c.ok("#10 the real save action refuses it, and the seat is unchanged", !saved.ok && (await (await import("@/lib/settings")).reviewRoomRules()).backupReviewerTeamMemberId === prev.backupReviewerTeamMemberId, saved.message);
    // A row written before this check (or by hand) that seats an editor grants nothing.
    await setChain({ fallbackReviewerTeamMemberId: kim.id });
    const kimRule = await ra.canRuleOnCuts(V.kim);
    const chain = await ra.reviewerChain();
    c.ok("#10 an editor in a seat still can't rule, and the chain skips her", !kimRule.ok && chain.members.find((m) => m.teamMemberId === kim.id)?.canRule === false);
    await setChain();
    // Nobody rules on their own version — owner/admin included.
    const Jown = await mkJob("90 Own Work Way");
    const own = await mkCut(Jown, { submittedByKey: "kim" });
    viewer = { ...V.kyle, editorKey: "kim" }; // an office login that is ALSO the editor who made it
    const selfApprove = await actions.approveCut(own);
    viewer = null;
    c.ok("#10 approving your own version is refused whatever the role", !selfApprove.ok && /your own version/i.test(selfApprove.message) && (await sub(own)).status === "PENDING", selfApprove.message);
  }
  {
    // #5 / #13 the Room is drawn for exactly who the actions accept: a seat on
    // a narrower login (James as PHOTOGRAPHER) gets the desk, not the
    // photographer's own-shoots room or a redirect home.
    const Jp = await mkJob("91 Seat Desk Rd"); // shot by Harrison, not James
    const cutP = await mkCut(Jp);
    await announce(Jp, cutP);
    // The pages themselves cannot be evaluated here (a client component in
    // their import graph needs React's client build), so the drill proves the
    // question they ask and that both pages ask it.
    const pageSrc = fs.readFileSync(path.join(REPO, "src/app/review/page.tsx"), "utf8");
    const wsSrc = fs.readFileSync(path.join(REPO, "src/app/review/[id]/page.tsx"), "utf8");
    const oldPage = fs.readFileSync(baseFiles.page, "utf8");
    const oldWsPage = fs.readFileSync(baseFiles.wsPage, "utf8");
    const roleOnly = /ownerDesk = me \? me\.role === "OWNER" \|\| me\.role === "ADMIN"/;
    c.ok(`#13 old (${BASE}): both pages drew the desk for OWNER/ADMIN by role alone`, roleOnly.test(oldPage) && roleOnly.test(oldWsPage));
    c.ok("#5/#13 both pages now ask isReviewDesk — the actions' own question", /ownerDesk = await isReviewDesk\(me/.test(pageSrc) && /ownerDesk = await isReviewDesk\(me/.test(wsSrc) && !roleOnly.test(pageSrc) && !roleOnly.test(wsSrc));
    const desk = (v: typeof viewer) => ra.isReviewDesk(v, { authEnforced: true });
    c.ok("#5 James seated on a PHOTOGRAPHER login IS the desk (the actions accept him)", await desk(V.jamesSeat));
    c.ok("#13 …Kyle and Jordan are, Harrison (no seat), Kim (editor) and a preview are not",
      (await desk(V.kyle)) && (await desk(V.jordan)) && !(await desk(V.harrison)) && !(await desk(V.kim)) && !(await desk(V.preview)));
    // The same seat through the real verdict on a cut from a shoot he did not do.
    viewer = V.jamesSeat;
    await editorNote(Jp, cutP, "Horizon tilts at 0:08");
    const back = await actions.requestCutChanges(cutP);
    c.ok("#13 …and the verdict the desk offers him goes through", back.ok, back.message);
    viewer = null;
  }

  // =========================================================================
  c.head("9 · FENCE");
  c.ok("no call left the machine except the faked Slack API", fence.blocked.length === 0, fence.blocked.slice(0, 5).join(", "));
  c.ok("…and no text was SENT (the queue is never flushed here)", (await prisma.pendingSms.count({ where: { sentAt: { not: null } } })) === 0);

  c.summary();
  quiet.restore();
  fence.restore();
  await stop();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
