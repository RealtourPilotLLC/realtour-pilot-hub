// ---------------------------------------------------------------------------
// DRILL: no reviewer checklist in the Review Room (Oct 15 2026, trimmed Oct 20).
//
// Oct 15 built a two-part reviewer check (technical + creative blocks) with a
// server gate behind an AppSetting switch. Jordan took the checklist out of the
// room on Oct 16 ("We know what to look for"), and on Oct 20 2026 (audit B5)
// the dead gate, its save action and the component were removed. What stays:
//   1. approveCut approves with no checks saved, even with the old
//      `review_checklist` switch row left ON in the database;
//   2. who is a creative approver (Jordan; the creative-approver seat, James;
//      never Kyle's admin login, never a "view as" preview);
//   3. the screens: no checklist, Approve is one press, and the approved
//      script / brand / style beside the cut.
//
// ISOLATION: PGlite via the shared harness; the login seam and after() are
// intercepted; Dropbox / Slack fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

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
const afterQueue: (() => unknown)[] = [];
interceptModule(
  (r) => r === "next/server",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "after" ? (fn: () => unknown) => { afterQueue.push(fn); } : t[k]) }),
);
installNextStubs();
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url) => {
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7102), env: { AUTH_ENFORCE: "true", APP_SECRET: "oct15-review-checklist" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const read = (p: string) => fs.readFileSync(p, "utf8");
  try {
    const { prisma } = await import("@/lib/prisma");
    const { putSetting } = await import("@/lib/settings");
    const store = await import("@/lib/reviewChecklist");
    const actions = await import("@/app/review/actions");

    const member = (name: string, role: "PHOTOGRAPHER" | "MANAGER" | "EDITOR") => prisma.teamMember.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}@chk.invalid`, role, active: true }, select: { id: true, name: true } });
    const jordan = await member("Jordan Spackman", "PHOTOGRAPHER");
    const kyle = await member("Kyle Cabrera", "MANAGER");
    const james = await member("James Livingston", "PHOTOGRAPHER");
    const kimTm = await member("Kim Miguel", "EDITOR");
    const login = (tm: { id: string; name: string }, role: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email: `${tm.name.split(" ")[0].toLowerCase()}@chk.invalid`, name: tm.name, role, status: "ACTIVE", teamMemberId: tm.id, ...extra }, select: { id: true } });
    const as = (u: { id: string }, tm: { id: string; name: string }, role: string, extra: Partial<Viewer> = {}): Viewer => ({
      id: u.id, email: `${tm.name.split(" ")[0].toLowerCase()}@chk.invalid`, name: tm.name, role, permissions: null, status: "ACTIVE",
      teamMemberId: tm.id, editorKey: null, notificationsSeenAt: null, impersonating: false, realRole: role, realName: tm.name, ...extra,
    });
    const V = {
      jordan: as(await login(jordan, "OWNER"), jordan, "OWNER"),
      kyle: as(await login(kyle, "ADMIN"), kyle, "ADMIN"),
      james: as(await login(james, "PHOTOGRAPHER"), james, "PHOTOGRAPHER"),
      kim: as(await login(kimTm, "EDITOR", { editorKey: "kim" }), kimTm, "EDITOR", { editorKey: "kim" }),
    };
    await putSetting("review_room", { discoverFromDropbox: false, keepUploadsDays: 90, creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id, coverOfferHours: 9, coverTransferHours: null });

    const client = await prisma.client.create({ data: { name: "Checklist Agent TEST" }, select: { id: true } });
    let seq = 0;
    const mkJob = async (label: string, title = "Listing Reel") => {
      const p = await prisma.project.create({ data: { title: `${++seq} Check Ln, Royersford, PA`, clientId: client.id, status: "REVIEW" }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label, quantity: 1 }, select: { id: true } });
      void title;
      return { id: p.id, deliverableId: d.id };
    };
    const mkCut = async (job: { id: string; deliverableId: string | null }, over: Record<string, unknown> = {}) => {
      const row = await prisma.reviewSubmission.create({ data: { projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: 1, kind: "video", source: "upload", status: "PENDING", fileName: `cut-${++seq}.mp4`, submittedByKey: "kim", submittedByName: "Kim Miguel", contentHash: `hash-${seq}`, ...over }, select: { id: true } });
      await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: `/api/review/cut/${row.id}/stream` } });
      return row.id;
    };
    const status = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } }).then((s) => s.status);

    // ======================================================================
    c.head("1 · approval is the sign-off: no checklist gate");
    const J0 = await mkJob("Listing Reel");
    const cut0 = await mkCut(J0);
    viewer = V.kyle;
    const r0 = await actions.approveCut(cut0);
    c.ok("approveCut with no checks approves", r0.ok && (await status(cut0)) === "APPROVED", r0.message);
    // The old switch row may still be in the live database: it no longer means anything.
    await putSetting("review_checklist", { enforce: true });
    const M = await buildContentMonth(prisma as never, { name: "Checklist Monthly TEST", package: "Starter", videosPerMonth: 1, project: { status: "REVIEW" } });
    const cutM = await mkCut({ id: M.projectId!, deliverableId: M.deliverableId });
    const rM = await actions.approveCut(cutM);
    c.ok("a program video approves with the old switch left on", rM.ok && (await status(cutM)) === "APPROVED", rM.message);
    c.ok("nothing was stored as a review check", (await prisma.cutReviewCheck.count()) === 0);

    // ======================================================================
    c.head("2 · who is a creative approver");
    c.ok("Jordan (the owner)", await store.isCreativeApprover(V.jordan, { authEnforced: true }));
    c.ok("James (the creative-approver seat)", await store.isCreativeApprover(V.james, { authEnforced: true }));
    c.ok("not Kyle's admin login", !(await store.isCreativeApprover(V.kyle, { authEnforced: true })));
    c.ok("not an editor", !(await store.isCreativeApprover(V.kim, { authEnforced: true })));
    c.ok("not a 'view as' preview, even of the owner", !(await store.isCreativeApprover({ ...V.jordan, impersonating: true }, { authEnforced: true })));

    // ======================================================================
    c.head("3 · the screens");
    const page = read("src/app/review/[id]/page.tsx");
    const panel = read("src/components/review/CutReviewPanel.tsx");
    c.ok("the Review Room shows no checklist: Approve is one press", !page.includes("<ReviewChecklist") && !/approveBlockedReason/.test(page) && !/approveBlockedReason/.test(panel));
    c.ok("the checklist component and its save action are gone", !fs.existsSync("src/components/review/ReviewChecklist.tsx") && !/function saveReviewCheck/.test(read("src/app/review/checklistActions.ts")));
    c.ok("approveCut asks no checklist", !/checklistRefusal\(/.test(read("src/app/review/actions.ts")));
    c.ok("the approved script, their brand and style sit beside the cut", /<JudgeAgainst topicTitle=\{judgeTopic\} script=\{judgeScript\} brand=\{judgeBrand\} style=\{judgeStyle\} \/>/.test(page));

    c.head("isolation");
    c.ok("nothing left the machine but fenced Slack", fence.blocked.every((u) => /dropbox|blob\.vercel/i.test(u)), fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
