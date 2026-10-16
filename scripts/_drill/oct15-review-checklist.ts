// ---------------------------------------------------------------------------
// DRILL: the reviewer's two-part check in the Review Room (Oct 15 2026).
//
//   1. The rules: every line answered, N/A only where allowed and with a
//      reason; the editor's own check pre-fills the technical block; Approve
//      waits until both are saved (creative by James or Jordan on program and
//      premium videos).
//   2. The switch OFF (the shipped default): approveCut is exactly as before.
//   3. The switch ON: approval refused until the checks cover THIS version;
//      Kyle saves the technical check, cannot sign the creative one on a
//      program video; James (the creative approver seat) can; then Kyle's
//      approval goes through. Who checked each block, and when, is stored.
//   4. The file changed after the check: the check no longer counts.
//   5. A standard listing reel: any reviewer signs the creative check.
//   6. Nobody checks their own version; a "view as" preview saves nothing.
//   7. The screens: both blocks above the verdict, Approve held with the
//      reason, the approved script / brand / style beside the cut.
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
    const core = await import("@/lib/reviewChecklistCore");
    const store = await import("@/lib/reviewChecklist");
    const actions = await import("@/app/review/actions");
    const checks = await import("@/app/review/checklistActions");

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
    const all = (block: "TECH" | "CREATIVE", over: Record<string, { answer: "OK" | "NA"; reason?: string }> = {}) =>
      core.ITEMS_FOR[block].map((i) => ({ key: i.key, answer: over[i.key]?.answer ?? "OK", reason: over[i.key]?.reason ?? null } as const));
    const status = (id: string) => prisma.reviewSubmission.findUniqueOrThrow({ where: { id } }).then((s) => s.status);

    // ======================================================================
    c.head("1 · the rules");
    c.ok("every line must be answered", !core.validateAnswers("TECH", all("TECH").slice(1)).ok);
    c.ok("'doesn't apply' needs a reason", !core.validateAnswers("TECH", all("TECH", { spelling_names: { answer: "NA", reason: "no" } })).ok);
    c.ok("…and only where it is allowed (black frames can't be skipped)", !core.validateAnswers("TECH", all("TECH", { black_frames: { answer: "NA", reason: "there are none" } })).ok);
    c.ok("a full answer passes, a reasoned N/A on captions too", core.validateAnswers("TECH", all("TECH", { spelling_names: { answer: "NA", reason: "No text in this cut" } })).ok);
    const pre = core.prefillFromSelfCheck([{ key: "audio_visual", answer: "YES", reason: null }, { key: "captions_text", answer: "NA", reason: "There are no captions" }, { key: "export_upload", answer: "YES", reason: null }]);
    c.ok("the editor's check pre-fills the technical block", pre.audio_music?.answer === "OK" && pre.spelling_names?.answer === "NA" && pre.spelling_names?.reason === "There are no captions" && pre.export?.answer === "OK" && !pre.black_frames);
    const st = (saved: boolean, stale = false, block: "TECH" | "CREATIVE" = "TECH") => ({ block, saved: saved ? { by: "x", atISO: "2026-10-15T00:00:00Z", role: null, answers: [], note: null } : null, stale });
    c.ok("Approve waits for both", !!core.approvalBlockedReason({ tech: st(true), creative: st(false, false, "CREATIVE"), creativeRequired: false, creativeSignedByApprover: false }));
    c.ok("program/premium: a creative check by somebody else is not enough", /James or Jordan/.test(core.approvalBlockedReason({ tech: st(true), creative: st(true, false, "CREATIVE"), creativeRequired: true, creativeSignedByApprover: false }) ?? ""));
    c.ok("both saved, creative by the approver: Approve may be pressed", core.approvalBlockedReason({ tech: st(true), creative: st(true, false, "CREATIVE"), creativeRequired: true, creativeSignedByApprover: true }) === null);
    c.ok("no dashes in the reasons Approve shows", ![st(false), st(true, true)].some((t) => /[—–]/.test(core.approvalBlockedReason({ tech: t, creative: st(false, false, "CREATIVE"), creativeRequired: true, creativeSignedByApprover: false }) ?? "")));

    // ======================================================================
    c.head("2 · the switch OFF (the shipped default): approval exactly as before");
    c.ok("the switch reads off by default", (await store.reviewChecklistSettings()).enforce === false);
    const J0 = await mkJob("Listing Reel");
    const cut0 = await mkCut(J0);
    viewer = V.kyle;
    const r0 = await actions.approveCut(cut0);
    c.ok("approveCut with no checks still approves", r0.ok && (await status(cut0)) === "APPROVED", r0.message);

    // ======================================================================
    c.head("3 · the switch ON: a program video");
    await putSetting(store.REVIEW_CHECKLIST_SETTING, { enforce: true });
    const M = await buildContentMonth(prisma as never, { name: "Checklist Monthly TEST", package: "Starter", videosPerMonth: 1, project: { status: "REVIEW" } });
    const cutM = await mkCut({ id: M.projectId!, deliverableId: M.deliverableId });
    const refused = await actions.approveCut(cutM);
    c.ok("approval refused until the checks are saved", !refused.ok && /technical check/.test(refused.message) && (await status(cutM)) === "PENDING", refused.message);
    const s0 = await store.checklistStatus(cutM);
    c.ok("a program video needs the creative approver", s0?.creativeRequired === true);
    viewer = V.kyle;
    const kTech = await checks.saveReviewCheck({ submissionId: cutM, block: "TECH", answers: all("TECH"), note: "Levels fine." });
    c.ok("Kyle saves the technical check", kTech.ok, kTech.message);
    const kCre = await checks.saveReviewCheck({ submissionId: cutM, block: "CREATIVE", answers: all("CREATIVE") });
    c.ok("Kyle cannot sign the creative check on a program video", !kCre.ok && /James's or Jordan's/.test(kCre.message), kCre.message);
    const still = await actions.approveCut(cutM);
    c.ok("still refused: the creative check is James's or Jordan's", !still.ok && /James or Jordan/.test(still.message), still.message);
    viewer = V.james;
    const bad = await checks.saveReviewCheck({ submissionId: cutM, block: "CREATIVE", answers: all("CREATIVE").slice(0, 2) });
    c.ok("a half-ticked block is refused", !bad.ok && /Tick every line/.test(bad.message));
    const jCre = await checks.saveReviewCheck({ submissionId: cutM, block: "CREATIVE", answers: all("CREATIVE", { script: { answer: "NA", reason: "Client-planned video, no script" } }) });
    c.ok("James (the creative approver seat) signs the creative check", jCre.ok, jCre.message);
    const rows = await prisma.cutReviewCheck.findMany({ where: { submissionId: cutM, voidedAt: null }, orderBy: { checkedAt: "asc" } });
    c.ok("both blocks are stored with who, when and in what role", rows.length === 2 && rows[0].block === "TECH" && rows[0].checkedBy === "Kyle Cabrera" && rows[0].checkedByRole === "ADMIN" && rows[1].block === "CREATIVE" && rows[1].checkedBy === "James Livingston" && rows[1].checkedByRole === "CREATIVE_APPROVER" && !!rows[1].checkedAt);
    c.ok("…against the exact bytes", rows.every((r) => r.contentHash && r.checklistKey.endsWith("@v1")));
    viewer = V.kyle;
    const ok = await actions.approveCut(cutM);
    c.ok("now Kyle's approval goes through", ok.ok && (await status(cutM)) === "APPROVED", ok.message);
    viewer = V.kyle;
    const again = await checks.saveReviewCheck({ submissionId: cutM, block: "TECH", answers: all("TECH") });
    const tRows = await prisma.cutReviewCheck.findMany({ where: { submissionId: cutM, block: "TECH" } });
    c.ok("saving a block again keeps the earlier one as history", again.ok && tRows.length === 2 && tRows.filter((r) => r.voidedAt).length === 1);

    // ======================================================================
    c.head("4 · the file changed after the check");
    const J4 = await mkJob("Listing Reel");
    const cut4 = await mkCut(J4);
    viewer = V.kyle;
    await checks.saveReviewCheck({ submissionId: cut4, block: "TECH", answers: all("TECH") });
    await checks.saveReviewCheck({ submissionId: cut4, block: "CREATIVE", answers: all("CREATIVE") });
    await prisma.reviewSubmission.update({ where: { id: cut4 }, data: { contentHash: "different-bytes" } });
    const s4 = await store.checklistStatus(cut4);
    c.ok("both checks read stale", !!s4?.tech.stale && !!s4.creative.stale);
    const r4 = await actions.approveCut(cut4);
    c.ok("approval refused: the file changed after the check", !r4.ok && /file changed/.test(r4.message), r4.message);

    // ======================================================================
    c.head("5 · a standard listing reel: any reviewer signs the creative check");
    const J5 = await mkJob("Listing Reel");
    const cut5 = await mkCut(J5);
    viewer = V.kyle;
    await checks.saveReviewCheck({ submissionId: cut5, block: "TECH", answers: all("TECH") });
    const k5 = await checks.saveReviewCheck({ submissionId: cut5, block: "CREATIVE", answers: all("CREATIVE") });
    c.ok("Kyle signs the creative check on a standard reel", k5.ok && (await store.checklistStatus(cut5))?.creativeRequired === false);
    const r5 = await actions.approveCut(cut5);
    c.ok("…and it approves", r5.ok && (await status(cut5)) === "APPROVED", r5.message);
    const J5p = await mkJob("Premium Social Media Reel");
    const cut5p = await mkCut(J5p);
    c.ok("a premium reel needs the creative approver", (await store.checklistStatus(cut5p))?.creativeRequired === true);

    // ======================================================================
    c.head("6 · nobody checks their own version; a preview saves nothing");
    const J6 = await mkJob("Listing Reel");
    const cut6 = await mkCut(J6, { submittedByKey: "kyle" });
    viewer = { ...V.kyle, editorKey: "kyle" };
    const own = await checks.saveReviewCheck({ submissionId: cut6, block: "TECH", answers: all("TECH") });
    c.ok("a check on your own version is refused", !own.ok && /your own version/.test(own.message), own.message);
    viewer = { ...V.jordan, impersonating: true };
    const prev = await checks.saveReviewCheck({ submissionId: cut6, block: "TECH", answers: all("TECH") });
    c.ok("a 'view as' preview saves nothing", !prev.ok);
    viewer = V.kim;
    const ed = await checks.saveReviewCheck({ submissionId: cut6, block: "TECH", answers: all("TECH") });
    c.ok("an editor cannot save a review check", !ed.ok);
    c.ok("nothing was stored for any of them", (await prisma.cutReviewCheck.count({ where: { submissionId: cut6 } })) === 0);

    // ======================================================================
    c.head("7 · the screens");
    const page = read("src/app/review/[id]/page.tsx");
    const panel = read("src/components/review/CutReviewPanel.tsx");
    // Oct 16 2026 (Jordan: "Make sure you didn't overcomplicate the review
    // portion ... We know what to look for"): the Review Room asks for no
    // checklist; the approval is the sign-off. The store and the server gate
    // stay (switched off), and nothing on the page holds Approve back.
    c.ok("the Review Room shows no checklist: Approve is one press", !page.includes("<ReviewChecklist") && !/approveBlockedReason=\{checklist/.test(page));
    c.ok("…and the panel still honours a reason if one is ever passed", /disabled=\{pending \|\| needsReload \|\| !!approveBlockedReason\}/.test(panel));
    c.ok("the approved script, their brand and style sit beside the cut", /<JudgeAgainst topicTitle=\{judgeTopic\} script=\{judgeScript\} brand=\{judgeBrand\} style=\{judgeStyle\} \/>/.test(page));
    c.ok("the server gate sits after the issue gate in approveCut", (() => { const a = read("src/app/review/actions.ts"); return a.indexOf("checklistRefusal(submissionId)") > a.indexOf("issueGate.canApproveAnyway") && a.indexOf("checklistRefusal(submissionId)") < a.indexOf("const ruler = await rulerOf()"); })());

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
