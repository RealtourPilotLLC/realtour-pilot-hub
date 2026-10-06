// ---------------------------------------------------------------------------
// DRILL: Oct 5 2026 — the Review Room answers on the click.
//
// Jordan: "when we approve an edit, it should close and give a confirmation
// instantly that it was approved, and then everything it's currently waiting
// on should be done in the background so our team can keep moving".
//
// What is driven here is the SHIPPED server code (src/app/review/actions.ts,
// src/lib/reviewRoom.ts) with next/server's after() replaced at the module
// seam, so the drill decides when the background runs:
//   1  approveCut answers before ANY follow-on runs: the verdict, who ruled,
//      the timeline line and the 1080p queue row are committed; the bells, the
//      library row, the Dropbox copy and the per-video rows are not — until the
//      after() work runs, and then every one of them does.
//   2  a slow follow-on (a bell write parked on a door) does not hold the
//      answer: approveCut has returned while the step is still parked.
//   3  a failing follow-on does not skip the rest, is recorded (AuditLog
//      review_followup_failed, naming the step and its sweep), and the sweep it
//      names really does pick it up (repairApprovedCutLibrary,
//      finalizeApprovedCuts).
//   4  a monthly portal video approved while its 1080p pass is still owed is
//      NOT published (no library FAILURE on the exceptions board), and the
//      words say what actually happens next — nothing "ready to deliver".
//   5  the bells reach Jordan and the three review seats by person (Jordan's
//      OWNER login could never see the old ADMIN broadcast), never the ruler.
//   6  requestCutChanges: the same answer-first shape; an outside agency's
//      round is a Kyle-addressed bell AND a Slack DM to him (staff helper).
//   7  nextCutToReview: this job's next video first, then the cuts waiting on
//      the viewer; never a held, delivered, someone-else's or test cut.
//   8  the outdated Review Room copy is gone; the panel dispatches the verdict
//      before it moves the reviewer on.
//
// ISOLATION: _harness.ts (PGlite on 127.0.0.1:6541, .env blanked, fetch AND
// raw sockets fenced). Slack's API is answered by a counting fake; the hub's
// public blob host by canned bytes; every other provider is refused. Nothing
// is sent to a client or a provider.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = 6541;
const REPO = path.resolve(__dirname, "../..");

// ---- the login, at the one seam every guard reads -------------------------
type Viewer = {
  id: string; email: string; name: string | null; role: string; permissions: string | null; status: string;
  teamMemberId: string | null; editorKey: string | null; notificationsSeenAt: Date | null;
  impersonating: boolean; realRole: string; realName: string | null;
};
let viewer: Viewer | null = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "getCurrentUser" ? async () => viewer : t[k]) }),
);

// ---- after(): the drill decides when the background runs -------------------
// "queue": the work is held until flush(). "eager": it starts at once but is
// never awaited by the action — the shape of the real thing, minus the wait
// for the response to finish.
type Task = () => Promise<void> | void;
let afterMode: "queue" | "eager" = "queue";
const afterQueue: Task[] = [];
const eagerRuns: Promise<void>[] = [];
let afterCalls = 0;
interceptModule(
  (r) => r === "next/server",
  (loaded) =>
    new Proxy(loaded as Record<string | symbol, unknown>, {
      get(t, k) {
        if (k !== "after") return t[k];
        return (fn: Task) => {
          afterCalls++;
          if (afterMode === "queue") afterQueue.push(fn);
          else eagerRuns.push(Promise.resolve().then(fn));
        };
      },
    }),
);
async function flush(): Promise<number> {
  let n = 0;
  while (afterQueue.length) {
    const fn = afterQueue.shift()!;
    await fn();
    n++;
  }
  return n;
}

// ---- injected trouble, at the prisma seam ----------------------------------
type Door = { inside: Promise<void>; enter: () => void; release: () => void; released: Promise<void> };
const door = (): Door => {
  let enter!: () => void, release!: () => void;
  const inside = new Promise<void>((r) => { enter = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { inside, enter, release, released };
};
let bellDoor: Door | null = null; // parks the first review_approved bell write
let failLibraryWrites = 0; // portalVideo.upsert throws this many times
interceptModule(
  (r) => r === "@/lib/prisma" || /[\\/]src[\\/]lib[\\/]prisma(\.ts)?$/.test(r),
  (loaded) => {
    const m = loaded as { prisma: Record<PropertyKey, unknown> };
    const bind = (v: unknown, self: object) => (typeof v === "function" ? v.bind(self) : v);
    const wrapTable = (table: Record<PropertyKey, unknown>, method: string, wrap: (fn: (...a: unknown[]) => unknown, args: unknown[]) => unknown) =>
      new Proxy(table, {
        get(d, k) {
          const fn = Reflect.get(d, k, d);
          if (k !== method || typeof fn !== "function") return bind(fn, d);
          return (...args: unknown[]) => wrap((...a: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(d, a), args);
        },
      });
    return {
      ...m,
      prisma: new Proxy(m.prisma, {
        get(t, key) {
          const value = Reflect.get(t, key, t);
          if (key === "notification") {
            return wrapTable(value as Record<PropertyKey, unknown>, "create", async (call, args) => {
              const d = bellDoor;
              const kind = (args[0] as { data?: { kind?: string } })?.data?.kind;
              if (d && kind === "review_approved") {
                bellDoor = null;
                d.enter();
                await d.released;
              }
              return call(...args);
            });
          }
          if (key === "portalVideo") {
            return wrapTable(value as Record<PropertyKey, unknown>, "upsert", async (call, args) => {
              if (failLibraryWrites > 0) {
                failLibraryWrites--;
                throw new Error("drill: the library write failed");
              }
              return call(...args);
            });
          }
          return bind(value, t);
        },
      }),
    };
  },
);

installNextStubs();

// ---- the network: Slack and Dropbox counted fakes, the blob host answered,
// everything else refused. Dropbox's save_url REFUSES while the approvals run
// (so the background copy fails and must be recorded) and ACCEPTS once the
// hourly sweep is being proved (so its retry is visible as a job id). ---------
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const dropboxCalls: string[] = [];
let dropboxPhase: "refuse" | "accept" = "refuse";
let dropboxJobs = 0;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)) {
    return new Response("abcde", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } });
  }
  if (url === "https://api.dropbox.com/oauth2/token") return json({ access_token: "drill-dropbox-access" });
  if (url.startsWith("https://api.dropboxapi.com/2/")) {
    const endpoint = url.slice("https://api.dropboxapi.com/2/".length);
    dropboxCalls.push(endpoint);
    if (endpoint === "users/get_current_account") return json({ root_info: {} });
    if (endpoint === "files/create_folder_v2") return json({ metadata: {} });
    if (endpoint === "files/save_url") {
      return dropboxPhase === "accept"
        ? json({ ".tag": "async_job_id", async_job_id: `drill-job-${++dropboxJobs}` })
        : json({ error_summary: "too_many_write_operations/" }, 503);
    }
    return json({ error_summary: `path/not_found/ (drill: ${endpoint})` }, 409);
  }
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

async function main() {
  const db = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "oct5-instant-review" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { putSetting, DEFAULT_TOPAZ } = await import("@/lib/settings");
    const actions = await import("@/app/review/actions");
    const room = await import("@/lib/reviewRoom");
    const { repairApprovedCutLibrary } = await import("@/lib/portalLibrary");
    const { finalizeApprovedCuts } = await import("@/lib/reviewCuts");
    await saveSecret("slack", "xoxb-drill-not-a-real-token");
    await saveSecret("dropbox", "drill-dropbox-refresh");

    // ---- the cast (every row before the first notify: the notify stack
    // caches the owner/office lists) ----------------------------------------
    type TeamRole = "ADMIN" | "MANAGER" | "PHOTOGRAPHER" | "EDITOR";
    const member = (name: string, email: string, role: TeamRole, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({
        data: { name, email, role, slackId: `U-${name.split(" ")[0].toUpperCase()}`, active: true, ...extra },
        select: { id: true, name: true },
      });
    const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER");
    const kyle = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER");
    const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", { creativeManager: true });
    const kim = await member("Kim Miguel", "kim@drill.invalid", "EDITOR");
    const login = (email: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name: null, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true } });
    const uJordan = await login("jordan@drill.invalid", "OWNER", jordan.id);
    const uKyle = await login("kyle@drill.invalid", "ADMIN", kyle.id);
    const uJames = await login("james@drill.invalid", "ADMIN", james.id);
    await login("kim@drill.invalid", "EDITOR", kim.id, { editorKey: "kim" });
    const as = (u: { id: string }, tm: { id: string; name: string }, role: string): Viewer => ({
      id: u.id, email: `${tm.name.split(" ")[0].toLowerCase()}@drill.invalid`, name: tm.name, role, permissions: null, status: "ACTIVE",
      teamMemberId: tm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: tm.name,
    });
    const V = { jordan: as(uJordan, jordan, "OWNER"), kyle: as(uKyle, kyle, "ADMIN"), james: as(uJames, james, "ADMIN") };
    // James first → Kyle covers → Jordan any time.
    await putSetting("review_room", {
      discoverFromDropbox: false, keepUploadsDays: 90,
      creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id,
      coverOfferHours: 9, coverTransferHours: null,
    });
    // The 1080p pass ON (it ships off), for both video kinds.
    await putSetting("topaz", { ...DEFAULT_TOPAZ, enabled: true });

    const client = await prisma.client.create({ data: { name: "Drill Agent" }, select: { id: true } });
    let seq = 0;
    const mkJob = async (street: string, status: "REVIEW" | "DELIVERED" = "REVIEW", clientId = client.id) => {
      const p = await prisma.project.create({ data: { title: `${street}, Royersford, PA`, clientId, status, addressLine: street }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
      return { id: p.id, deliverableId: d.id, street };
    };
    const mkCut = async (job: { id: string; deliverableId: string | null }, over: Record<string, unknown> = {}) => {
      seq++;
      const row = await prisma.reviewSubmission.create({
        data: {
          projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: 1, kind: "video", source: "upload",
          status: "PENDING", fileName: `cut-${seq}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel", sizeBytes: 5,
          createdAt: new Date(Date.now() - 60_000 + seq), ...over,
        },
        select: { id: true },
      });
      await prisma.reviewSubmission.update({
        where: { id: row.id },
        data: { assetUrl: `/api/review/cut/${row.id}/stream`, blobUrl: `https://drillstore.public.blob.vercel-storage.com/${row.id}.mp4`, blobPathname: `${row.id}.mp4` },
      });
      return row.id;
    };
    const bells = (prefix: string) => prisma.notification.findMany({ where: { dedupeKey: { startsWith: prefix } }, select: { userKey: true, audience: true, title: true, body: true, kind: true } });
    const failures = (id: string) => prisma.auditLog.findMany({ where: { action: "review_followup_failed", target: id } });
    const sub = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } });

    // =========================================================================
    c.head("1 · approveCut answers before any follow-on runs");
    // =========================================================================
    const J1 = await mkJob("101 Instant Ave");
    const cut1 = await mkCut(J1);
    viewer = V.james;
    afterMode = "queue";
    const callsBefore = afterCalls;
    const r1 = await actions.approveCut(cut1);
    const s1 = await sub(cut1);
    c.ok("the verdict is committed when the answer comes back: APPROVED, by James, with his login", r1.ok && s1.status === "APPROVED" && s1.decidedBy === "James Livingston" && s1.decidedByUserId === uJames.id, r1.message);
    c.ok("…the timeline line and the 1080p queue row are written on the answer path", !!(await prisma.activity.findFirst({ where: { projectId: J1.id, body: { startsWith: "Cut approved in review (round 1) by James Livingston" } } })) && (await prisma.topazJob.count({ where: { submissionId: cut1, state: "queued" } })) === 1);
    c.ok("ONE after() hand-off, still waiting", afterCalls - callsBefore === 1 && afterQueue.length === 1, `${afterCalls - callsBefore} call(s), ${afterQueue.length} queued`);
    c.ok("…and none of its work has run: no bell, no per-video row, no Dropbox attempt yet",
      (await bells(`review-approved-${cut1}`)).length === 0 &&
      (await prisma.deliverableOutput.count({ where: { approvedSubmissionId: cut1 } })) === 0 &&
      !dropboxCalls.includes("files/save_url"),
      `dropbox calls so far: ${dropboxCalls.join(", ") || "none"}`);
    c.ok("the answer says what really happens next (1080p, then Kyle's upload prompt) — not 'Kyle's been pinged to deliver'",
      /1080p/.test(r1.message) && /Kyle gets the upload-and-send prompt/.test(r1.message) && !/pinged to deliver/i.test(r1.message), r1.message);
    const ran1 = await flush();
    const b1 = await bells(`review-approved-${cut1}`);
    c.ok("after() runs: the bells land", ran1 === 1 && b1.length > 0, `${ran1} task(s), ${b1.length} bell row(s)`);
    c.ok("…the per-video row is refreshed to this approval", (await prisma.deliverableOutput.count({ where: { approvedSubmissionId: cut1 } })) === 1);
    const f1 = (await failures(cut1)).flatMap((f) => (JSON.parse(f.detail) as { failed: { step: string; repairedBy: string; error: string }[] }).failed);
    c.ok("…the Final-folder copy was attempted, Dropbox (faked) refused it, and the failure is recorded with its sweep",
      dropboxCalls.includes("files/save_url") && f1.some((x) => x.step === "Final folder copy" && /finalizeApprovedCuts/.test(x.repairedBy)),
      JSON.stringify(f1));

    c.head("5 · the bells reach Jordan and the seats by person — never the one who pressed it");
    const byKey = (k: string) => b1.find((b) => b.userKey === k);
    c.ok("Jordan has his own row (his OWNER login could never see the ADMIN broadcast)", !!byKey(`tm:${jordan.id}`) && JSON.parse(byKey(`tm:${jordan.id}`)!.audience).includes("OWNER"));
    c.ok("Kyle (backup seat) has his own row", !!byKey(`tm:${kyle.id}`));
    c.ok("James pressed it — no row tells him about his own press", !byKey(`tm:${james.id}`));
    c.ok("the role-only ADMIN broadcast is gone (every seat is addressed by name)", !b1.some((b) => b.userKey === null));
    c.ok("Kim, who cut it, keeps her editor row", !!byKey("editor:kim"));
    const kyleBell = byKey(`tm:${kyle.id}`)?.body ?? "";
    c.ok("the seat's bell keeps its body: who approved it and the honest next step — no 'Ready to deliver.'", kyleBell.startsWith("Approved by James Livingston.") && /1080p pass running/.test(kyleBell) && !/Ready to deliver/.test(kyleBell), kyleBell);
    c.ok("no text was queued by any of it (bell rows only)", (await prisma.pendingSms.count()) === 0);

    // =========================================================================
    c.head("2 · a slow follow-on does not hold the answer");
    // =========================================================================
    const J2 = await mkJob("102 Slow Bell St");
    const cut2 = await mkCut(J2);
    viewer = V.kyle;
    afterMode = "eager";
    bellDoor = door();
    const parked = bellDoor;
    let answered = false;
    const p2 = actions.approveCut(cut2).then((r) => { answered = true; return r; });
    await parked.inside; // the background bell write is now parked
    const r2 = await Promise.race([p2, new Promise<null>((res) => setTimeout(() => res(null), 5_000))]);
    c.ok("approveCut has answered while its bell write is still parked", !!r2 && r2.ok && answered && (await bells(`review-approved-${cut2}`)).length === 0, r2?.message ?? "no answer within 5 s");
    parked.release();
    await Promise.all(eagerRuns.splice(0));
    c.ok("…and the parked step finishes afterwards", (await bells(`review-approved-${cut2}`)).length > 0 && (await prisma.deliverableOutput.count({ where: { approvedSubmissionId: cut2 } })) === 1);
    afterMode = "queue";

    // =========================================================================
    c.head("3/4 · a monthly portal video: 1080p owed → no publication, no library FAILURE; a failing step is recorded and swept");
    // =========================================================================
    const M = await buildContentMonth(prisma, { name: "Instant Monthly TEST", package: "Starter", videosPerMonth: 1, project: { status: "REVIEW" } });
    const cut3 = await mkCut({ id: M.projectId!, deliverableId: M.deliverableId });
    viewer = V.kyle; // covering James
    const r3 = await actions.approveCut(cut3);
    const s3 = await sub(cut3);
    c.ok("approved, publication flagged as owed, the 1080p pass queued", r3.ok && s3.status === "APPROVED" && !!s3.portalPublicationRequiredAt && (await prisma.topazJob.count({ where: { submissionId: cut3, state: "queued" } })) === 1, r3.message);
    c.ok("the answer: 1080p running, the client's portal gets it, nothing to send — no Kyle upload prompt", /1080p/.test(r3.message) && /client's portal/.test(r3.message) && /Nothing to send/.test(r3.message) && !/Kyle/.test(r3.message), r3.message);
    failLibraryWrites = 1; // the library row write fails in the background
    await flush();
    const f3 = await failures(cut3);
    const failed3 = f3.flatMap((f) => (JSON.parse(f.detail) as { failed: { step: string; repairedBy: string }[] }).failed);
    c.ok("the failing step is recorded with the sweep that redoes it", failed3.some((x) => x.step === "portal library row" && /repairApprovedCutLibrary/.test(x.repairedBy)), JSON.stringify(failed3.map((x) => x.step)));
    c.ok("…and it skipped nothing after it: the bells and the per-video row still landed", (await bells(`review-approved-${cut3}`)).length > 0 && (await prisma.deliverableOutput.count({ where: { approvedSubmissionId: cut3 } })) === 1);
    const enr3 = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: M.enrollmentId } });
    c.ok("NO library failure on the exceptions board while the 1080p pass is owed (publication was not attempted)", enr3.librarySyncFailedAt === null && enr3.librarySyncError === null && (await prisma.contentVideo.count({ where: { enrollmentId: M.enrollmentId } })) === 0, enr3.librarySyncError ?? "clean");
    c.ok("the library row is missing after the failure…", (await prisma.portalVideo.count({ where: { externalKey: `sub:${cut3}` } })) === 0);
    const repair = await repairApprovedCutLibrary({ sinceDays: 45, max: 200 });
    c.ok("…and the hourly sweep it names puts it there", repair.repaired >= 1 && (await prisma.portalVideo.count({ where: { externalKey: `sub:${cut3}` } })) === 1, JSON.stringify(repair));
    const mBell = (await bells(`review-approved-${cut3}`)).find((b) => b.userKey === `tm:${jordan.id}`)?.body ?? "";
    c.ok("Jordan's bell: who approved it, the portal gets it after the 1080p pass, nothing to send", mBell.startsWith("Approved by Kyle Smith.") && /client's portal/.test(mBell) && /Nothing to send/i.test(mBell), mBell);
    c.ok("James and Jordan were told; Kyle (who pressed it) was not", (await bells(`review-approved-${cut3}`)).some((b) => b.userKey === `tm:${james.id}`) && !(await bells(`review-approved-${cut3}`)).some((b) => b.userKey === `tm:${kyle.id}`));

    // Same month, the 1080p pass switched OFF: nothing to wait for, so the
    // publication IS attempted in the background.
    await putSetting("topaz", { ...DEFAULT_TOPAZ, enabled: false });
    const M2 = await buildContentMonth(prisma, { name: "Instant Monthly Two TEST", package: "Starter", videosPerMonth: 1, project: { status: "REVIEW" } });
    const cut3b = await mkCut({ id: M2.projectId!, deliverableId: M2.deliverableId });
    const r3b = await actions.approveCut(cut3b);
    c.ok("1080p off: the answer says it is being published to the portal", r3b.ok && /publishing to the client's portal/i.test(r3b.message), r3b.message);
    c.ok("…and nothing was published before the answer", (await prisma.contentVideo.count({ where: { enrollmentId: M2.enrollmentId } })) === 0);
    await flush();
    c.ok("…the background publication ran (the client's library was rebuilt)", (await prisma.contentVideo.count({ where: { enrollmentId: M2.enrollmentId } })) > 0);
    await putSetting("topaz", { ...DEFAULT_TOPAZ, enabled: true });

    // The Dropbox copy that failed in the background (section 1) is the hourly
    // approvedCuts sweep's: it selects the cut and starts the copy again.
    c.ok("before the sweep, the failed copy left no Dropbox job on the cut", (await sub(cut1)).dropboxJobId === null);
    dropboxPhase = "accept";
    const swept = await finalizeApprovedCuts().catch((e: Error) => ({ error: e.message }));
    dropboxPhase = "refuse";
    const s1b = await sub(cut1);
    c.ok("the Final-folder copy that failed in the background is picked up by finalizeApprovedCuts (copy job started)",
      "retried" in swept && swept.retried >= 1 && !!s1b.dropboxJobId?.startsWith("drill-job-"),
      `${JSON.stringify(swept)} · job ${s1b.dropboxJobId}`);

    // =========================================================================
    c.head("6 · requestCutChanges: answer first; the rows that reach a person are written WITH it (Oct 5 night), the DMs and FYI bells after; Luma's round is Kyle's task");
    // =========================================================================
    const J6 = await mkJob("106 Send Back Rd");
    const cut6 = await mkCut(J6);
    // Kim holds the edit card (a routed card would go to whoever the routing
    // table names for a listing reel — not what this section is about).
    await prisma.smartTask.create({ data: { projectId: J6.id, taskType: "edit_video", title: "Edit the video — 106 Send Back Rd", status: "IN_PROGRESS", assignedKey: "kim", dedupeKey: `edit-video-${J6.id}` } });
    viewer = V.jordan;
    const note6 = await actions.addCutNote({ projectId: J6.id, submissionId: cut6, body: "Trim the intro by a second", lane: "EDITOR", kind: "fix", timeSec: 2 });
    c.ok("Jordan's note is on the cut", note6.ok, note6.message ?? "");
    viewer = V.james;
    const r6 = await actions.requestCutChanges(cut6);
    const s6 = await sub(cut6);
    const p6 = await prisma.project.findUniqueOrThrow({ where: { id: J6.id } });
    const card6 = await prisma.smartTask.findUnique({ where: { dedupeKey: `edit-video-${J6.id}` } });
    c.ok("the verdict, the job's status and the editor's round are committed on the answer", r6.ok && s6.status === "CHANGES_REQUESTED" && p6.status === "REVISION" && /Round 2 — sent back from the Review Room/.test(card6?.description ?? ""), r6.message);
    c.ok("…the answer names the editor and the round", /^Sent 1 change to Kim/.test(r6.message) && /round 2 is on their edit card/.test(r6.message), r6.message);
    // Oct 5 night review: the editor's own bell row is durable on the answer
    // (a background that dies can't lose it); the FYI rows and DMs wait.
    c.ok("…Kim's own bell row is written with the answer; the FYI bells wait for after()", afterQueue.length === 1 && JSON.stringify((await bells(`review-changes-${cut6}`)).map((b) => b.userKey)) === JSON.stringify(["editor:kim"]));
    await flush();
    const b6 = await bells(`review-changes-${cut6}`);
    c.ok("after(): Kim's row, Jordan's and Kyle's — not James's own", !!b6.find((b) => b.userKey === "editor:kim") && !!b6.find((b) => b.userKey === `tm:${jordan.id}`) && !!b6.find((b) => b.userKey === `tm:${kyle.id}`) && !b6.find((b) => b.userKey === `tm:${james.id}`), JSON.stringify(b6.map((b) => b.userKey)));
    c.ok("…the seats' rows name the sender", (b6.find((b) => b.userKey === `tm:${kyle.id}`)?.body ?? "").startsWith("James Livingston sent back 1 note"));

    // An outside agency's round.
    const J7 = await mkJob("107 Agency Way");
    const cut7 = await mkCut(J7, { submittedByKey: null, submittedByName: null });
    await prisma.smartTask.create({ data: { projectId: J7.id, taskType: "edit_video", title: "Edit the video — 107 Agency Way", status: "OPEN", assignedKey: "external_agency", assignedManually: true, dedupeKey: `edit-video-${J7.id}` } });
    viewer = V.jordan;
    await actions.addCutNote({ projectId: J7.id, submissionId: cut7, body: "Swap the music", lane: "EDITOR", kind: "fix", timeSec: 5 });
    viewer = V.james;
    slack.length = 0;
    const r7 = await actions.requestCutChanges(cut7);
    c.ok("the answer says Luma has no login and Kyle has a task to relay it", r7.ok && /Luma Visuals has no login here, so Kyle has a task to relay them/.test(r7.message), r7.message);
    c.ok("…the task (owned by Kyle) and his bell row exist on the answer; nothing was Slacked before after()",
      slack.length === 0 && (await bells(`review-relay-${cut7}`)).length === 1 && !!(await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: `review-relay:${cut7}` }, ownerId: kyle.id, status: "OPEN" } })));
    await flush();
    const relay = await bells(`review-relay-${cut7}`);
    c.ok("Kyle has a bell addressed to HIM: 'Relay cut changes to Luma Visuals'", relay.length === 1 && relay[0].userKey === `tm:${kyle.id}` && relay[0].title.startsWith("Relay cut changes to Luma Visuals"), JSON.stringify(relay));
    const dm = slack.filter((m) => m.channel === "U-KYLE");
    // Oct 6 2026 (Jordan: "Anyone on the team can get pinged anytime."): the
    // relay DM has no overnight hold any more — this drill runs on the real
    // clock, and at any hour the DM goes at once (Kyle has no quiet time saved).
    const heldRelay = (await prisma.appSetting.findMany({ where: { key: { startsWith: "held-dm:" } } })).map((r) => JSON.parse(r.value) as { text?: string }).filter((v) => /Relay to Luma Visuals/.test(v.text ?? ""));
    c.ok("…and a Slack DM through the staff helper, with the link to the edit card — at once, whatever the hour",
      dm.length === 1 && /Relay to Luma Visuals/.test(dm[0].text) && dm[0].text.includes(`/edit/${J7.id}`) && heldRelay.length === 0,
      `${dm.map((m) => m.text).join(" | ")} · held ${heldRelay.length}`);
    c.ok("…Jordan still gets the FYI row; Kyle is not rung twice", (await bells(`review-changes-${cut7}`)).some((b) => b.userKey === `tm:${jordan.id}`) && !(await bells(`review-changes-${cut7}`)).some((b) => b.userKey === `tm:${kyle.id}`));
    c.ok("no other DM went out for it", slack.filter((m) => m.channel !== "U-KYLE").length === 0, slack.map((m) => m.channel).join(", "));

    // Kyle sends one back himself: the relay is still his row, but no Slack to himself.
    const J8 = await mkJob("108 Self Relay Ct");
    const cut8 = await mkCut(J8, { submittedByKey: null, submittedByName: null });
    await prisma.smartTask.create({ data: { projectId: J8.id, taskType: "edit_video", title: "Edit the video — 108 Self Relay Ct", status: "OPEN", assignedKey: "external_agency", assignedManually: true, dedupeKey: `edit-video-${J8.id}` } });
    viewer = V.kyle;
    await actions.addCutNote({ projectId: J8.id, submissionId: cut8, body: "Color is too warm", lane: "EDITOR", kind: "fix", timeSec: 9 });
    slack.length = 0;
    const r8 = await actions.requestCutChanges(cut8);
    await flush();
    c.ok("Kyle pressing it himself: 'relay them yourself', and no Slack DM to himself", r8.ok && /relay them to Luma Visuals yourself/.test(r8.message) && slack.filter((m) => m.channel === "U-KYLE").length === 0, r8.message);

    // =========================================================================
    c.head("7 · nextCutToReview: this job first, then the cuts waiting on the viewer");
    // =========================================================================
    const N = await mkJob("110 Package Ln");
    const d2 = await prisma.deliverable.create({ data: { projectId: N.id, type: "VIDEO", label: "Second Reel", quantity: 1 }, select: { id: true } });
    const nA = await mkCut(N, { reviewerTeamMemberId: james.id });
    const nB = await mkCut({ id: N.id, deliverableId: d2.id }, { reviewerTeamMemberId: kyle.id });
    const other = await mkJob("111 Elsewhere St");
    const oKyle = await mkCut(other, { reviewerTeamMemberId: kyle.id, createdAt: new Date(Date.now() - 3_600_000) });
    const other2 = await mkJob("112 Mine Ave");
    const oJames = await mkCut(other2, { reviewerTeamMemberId: james.id });
    const held = await mkJob("113 Held Rd");
    await mkCut(held, { reviewerTeamMemberId: james.id, selfCheckId: "held-check", createdAt: new Date(Date.now() - 7_200_000) });
    const delivered = await mkJob("114 Delivered Dr", "DELIVERED");
    await mkCut(delivered, { reviewerTeamMemberId: james.id, createdAt: new Date(Date.now() - 7_200_000) });
    const testClient = await prisma.client.create({ data: { name: "Fixture TEST" }, select: { id: true } });
    const testJob = await mkJob("115 Test Ct", "REVIEW", testClient.id);
    const tJames = await mkCut(testJob, { reviewerTeamMemberId: james.id, createdAt: new Date(Date.now() - 9_000_000) });
    const jamesViewer = { teamMemberId: james.id, office: true };
    const n1 = await room.nextCutToReview({ afterSubmissionId: nA, projectId: N.id, viewer: jamesViewer });
    c.ok("from video 1 of a package: video 2 of the SAME job comes next (whoever holds it)", n1?.id === nB && n1.href === `/review/${N.id}?cut=${nB}`, n1?.label);
    const n2 = await room.nextCutToReview({ afterSubmissionId: nB, projectId: N.id, viewer: jamesViewer });
    c.ok("…the job done (video 1 is the only other one, still pending) → it still comes first", n2?.id === nA, n2?.label);
    // Settle the package so the next pick leaves the job.
    await prisma.reviewSubmission.updateMany({ where: { id: { in: [nA, nB] } }, data: { status: "APPROVED", decidedAt: new Date() } });
    const n3 = await room.nextCutToReview({ afterSubmissionId: nB, projectId: N.id, viewer: jamesViewer });
    const pendingIds = (await prisma.reviewSubmission.findMany({ where: { status: "PENDING" }, select: { id: true } })).map((r) => r.id);
    c.ok("then the oldest cut waiting on James — never Kyle's, a held one, a delivered job's or a test client's", n3?.id === oJames && pendingIds.includes(oKyle), n3?.label);
    const n4 = await room.nextCutToReview({ afterSubmissionId: nB, projectId: N.id, viewer: jamesViewer, includeTest: true });
    c.ok("…a test client's cut only when the desk is on a test job", n4?.id === tJames, n4?.label);
    const n5 = await room.nextCutToReview({ afterSubmissionId: oKyle, projectId: other.id, viewer: { teamMemberId: kyle.id, office: true } });
    c.ok("Kyle's next after his own: nothing else is his → null (All caught up)", n5 === null, n5?.label ?? "null");

    // =========================================================================
    c.head("8 · the copy and the panel");
    // =========================================================================
    const indexSrc = fs.readFileSync(path.join(REPO, "src/app/review/page.tsx"), "utf8");
    c.ok("the Review Room no longer says cuts arrive 'when the editor drops a Final file' or names a 'Done — send to review' button", !/drops a Final file/.test(indexSrc) && !/Done — send to review/.test(indexSrc));
    const panelSrc = fs.readFileSync(path.join(REPO, "src/components/review/CutReviewPanel.tsx"), "utf8");
    c.ok("the panel dispatches the verdict BEFORE it moves the reviewer on, outside any async transition", /const answer = confirmVerdict\(call\);\s*router\.push\(nextCut\?\.href \?\? "\/review"\);/.test(panelSrc) && !/start\(async \(\) => \{\s*setOptimistic/.test(panelSrc));
    c.ok("…Approve and Request changes both go through it; approve-anyway stays", /decide\("approve", \(\) => approveCut\(submission\.id, \{ verifyIssueIds: verifiedFixIds\(fixesToCheck, notFixed\), approveUncheckedFixes: true \}\)\)/.test(panelSrc) && /decide\("send-back", \(\) => requestCutChanges\(/.test(panelSrc));
    const actionsSrc = fs.readFileSync(path.join(REPO, "src/app/review/actions.ts"), "utf8");
    c.ok("approveCut no longer promises 'Kyle's been pinged to deliver' or rings 'Ready to deliver.'", !/Kyle's been pinged to deliver\.`/.test(actionsSrc) && !/: "Ready to deliver\."\)/.test(actionsSrc));

    // =========================================================================
    c.head("9 · FENCE");
    c.ok("nothing reached a provider: only the faked Slack, Dropbox and blob hosts answered", fence.faked.every((u) => u.startsWith("https://slack.com/api/") || u.startsWith("https://api.dropbox") || /public\.blob\.vercel-storage\.com/.test(u)));
    c.ok("no text was sent or queued", (await prisma.pendingSms.count()) === 0);
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
