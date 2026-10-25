// Oct 24 2026: CLIENT ISSUE SIGNALS GET AN END (lib/issueSignalsCore,
// lib/issueSignals, ownerDashboard.clientIssuesSection, the owner panel).
// Jordan: "The Heather Barritt issue was marked closed, but it is still
// showing on Jordan's dashboard. Why? If it's for a reason, it should give an
// action item for that generalized reason." Her 5 revision rounds were all
// fixed, sent and closed on Oct 20-23, and the row still read "Next:
// Correction plan" with no way to close it until the rounds aged out of the
// 30-day window. Held here:
//   §1 the rules, pure: still being fixed / confirm the client / settled /
//      closed / a new ask brings it back; one-off signals close on evidence
//   §2 the card: each stage's next action and owner; Close it (happy, with
//      why) hides it and leaves a record; a new ask brings it back marked;
//      Still unhappy opens a complaint that takes over; the assigned check-in
//      settles with it; a cancellation closes with one line; who may close
//   §3 the panel: why it's here, the close controls, the read-only preview
// Disposable PGlite; nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { PanelSpec } from "../../src/components/owner/panelTypes";

installNextStubs();
const fence = fenceFetch(async (url) => (url.startsWith("https://slack.com/api/") ? new Response(JSON.stringify({ ok: true, channel: { id: "D" }, ts: "1" }), { headers: { "content-type": "application/json" } }) : null));
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5961), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct24-issue-signals" } });
  const c = makeChecker();
  try {
    const core = await import("@/lib/issueSignalsCore");
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const od = await import("@/lib/ownerDashboard");
    const A = await import("@/app/clients/clientCareActions");
    const DA = await import("@/app/delegation/actions");
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const T = new Date();

    // =====================================================================
    c.head("§1 · the rules, pure");
    // =====================================================================
    const base = { rounds: 5, latestRoundAt: new Date(T.getTime() - 4 * D), openWork: [], lastFixAt: new Date(T.getTime() - 3.5 * D), closure: null, delegated: null, clientFirst: "Heather", now: T };
    const fixing = core.roundsStage({ ...base, openWork: [{ title: "Video revision", who: "Kim" }] });
    c.ok("open revision work: STILL BEING FIXED, next is to finish it, owned by whoever holds it", fixing.show && fixing.stage === "FIXING" && fixing.nextAction === "Finish the fix: Video revision" && fixing.owner === "Kim" && /Round 5 is still being fixed \(Kim has it\)/.test(fixing.whyHere), JSON.stringify(fixing));
    const confirm = core.roundsStage(base);
    c.ok("every round fixed: CONFIRM THE CLIENT, with the reason in words and no owner yet", confirm.show && confirm.stage === "CONFIRM" && confirm.nextAction === "Confirm Heather is happy" && confirm.owner === null && /All 5 rounds are fixed, and nobody has confirmed Heather is happy or recorded why it took 5 rounds/.test(confirm.whyHere), JSON.stringify(confirm));
    c.ok("…it settles on its own 7 days after the last fix went out", confirm.show && confirm.settlesAt?.getTime() === base.lastFixAt.getTime() + core.SETTLE_QUIET_DAYS * D);
    const quiet = core.roundsStage({ ...base, lastFixAt: new Date(T.getTime() - 8 * D), latestRoundAt: new Date(T.getTime() - 9 * D) });
    c.ok("a quiet week after the last fix: SETTLED, off the card", !quiet.show && /no new ask for 7 days/.test(quiet.why), JSON.stringify(quiet));
    const heldQuiet = core.roundsStage({ ...base, lastFixAt: new Date(T.getTime() - 8 * D), latestRoundAt: new Date(T.getTime() - 9 * D), delegated: { open: true, who: "Kyle", completedAt: null } });
    c.ok("…but never while someone holds the check-in: it stays, owned by them", heldQuiet.show && heldQuiet.owner === "Kyle" && heldQuiet.settlesAt === null);
    const closure = { v: 1 as const, at: T.toISOString(), by: "Jordan", outcome: "HAPPY" as const, cause: "BRIEF_GAP", note: null, upToISO: base.latestRoundAt.toISOString(), upToCount: null };
    c.ok("closed with the client happy: off the card", !core.roundsStage({ ...base, closure }).show);
    const back = core.roundsStage({ ...base, closure, latestRoundAt: new Date(T.getTime() - H), lastFixAt: null });
    c.ok("a new ask after the close brings it back, marked reopened", back.show && back.reopened && back.stage === "CONFIRM");
    c.ok("the check-in someone completed after the last ask closes it too", !core.roundsStage({ ...base, delegated: { open: false, who: "Kyle", completedAt: new Date(T.getTime() - H) } }).show);
    c.ok("two rounds read 'Both rounds are fixed'", (() => { const s = core.roundsStage({ ...base, rounds: 2 }); return s.show && s.whyHere.startsWith("Both rounds are fixed"); })());
    c.ok("one-off signals: closed covers its own event; a pattern returns when the count grows", core.signalClosed({ ...closure, upToISO: T.toISOString() }, { atISO: T.toISOString() }) && core.signalClosed({ ...closure, upToCount: 2 }, { count: 2 }) && !core.signalClosed({ ...closure, upToCount: 2 }, { count: 3 }) && !core.signalClosed(null, { count: 1 }));
    c.ok("the causes share the complaint vocabulary's keys", core.ROUND_CAUSES.every((x) => ["BRIEF_GAP", "MISSED_INSTRUCTION", "EDITOR_ERROR", "CLIENT_CHANGE", "CAPTURE", "PROCESSING", "OTHER"].includes(x.key)) && core.readClosure("not json") === null && core.readClosure(JSON.stringify(closure))?.cause === "BRIEF_GAP");

    // =====================================================================
    c.head("§2 · the card");
    // =====================================================================
    const tm = (name: string, role: string) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@signals.invalid` } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER");
    const kimTm = await tm("Kim Editor", "EDITOR");
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", "info@realtourpilot.com", "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@signals.invalid", "ADMIN", kyleTm.id);
    const kim = await user("Kim Editor", "kim@signals.invalid", "EDITOR", kimTm.id);
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const heather = await prisma.client.create({ data: { name: "Heather Barritt" } });
    const job = await prisma.project.create({ data: { clientId: heather.id, title: "671 Northbrook Rd, Kennett Square, PA", status: "DELIVERED", deliveredAt: new Date(T.getTime() - 11 * D) } });
    for (const [daysAgo, text] of [[11, "The lot lines are missing"], [10, "No blackened areas please"], [9, "Lot lines on the drone video too"], [5, "Change the lot lines to white"], [4, "The lot numbers are missing"]] as const) {
      await prisma.revisionBrief.create({ data: { projectId: job.id, source: "text", originalText: text, requestedByKind: "TEXT", requestedBy: "Heather Barritt", createdAt: new Date(T.getTime() - daysAgo * D) } });
    }
    const rev = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision — 671 Northbrook Rd", status: "OPEN", assignedKey: "kim", projectId: job.id, clientId: heather.id, source: "drill" } });
    const rowOf = async () => (await od.clientIssuesSection({ now: T })).rows.find((r) => r.id === `revisions:${job.id}`) ?? null;
    let r = await rowOf();
    c.ok("still being fixed: 'Finish the fix', owned by the editor who holds it (was 'Nobody yet' / 'Correction plan')", r?.nextAction === "Finish the fix: Video revision" && r.owner === "Kim" && /still being fixed/.test(r.whyHere ?? ""), JSON.stringify(r && [r.owner, r.nextAction, r.whyHere]));
    await prisma.smartTask.update({ where: { id: rev.id }, data: { status: "COMPLETED", completedAt: new Date(T.getTime() - 3.5 * D) } });
    // A creative review the hub closed on its own is paperwork, not a fix reaching her.
    await prisma.smartTask.create({ data: { taskType: "creative_review", title: "Creative review — 671 Northbrook Rd · Heather", status: "COMPLETED", completedAt: new Date(T.getTime() - H), projectId: job.id, source: "drill" } });
    r = await rowOf();
    c.ok("all fixed: 'Confirm Heather is happy', high (5 rounds), with the reason it's still here", r?.nextAction === "Confirm Heather is happy" && r.severity === "high" && r.owner === null && /nobody has confirmed Heather is happy/.test(r.whyHere ?? ""), JSON.stringify(r && [r.nextAction, r.whyHere]));
    c.ok("…the summary names the five days; the close carries the settle date from the revision, not the creative review", r?.close?.kind === "rounds" && r.close.rounds === 5 && r.close.settlesAtISO === new Date(T.getTime() - 3.5 * D + 7 * D).toISOString() && /5 different days in 30 days \(/.test(r.summary), JSON.stringify(r?.close));
    c.ok("…Assign hands the check-in to Kyle, keyed to this row", r?.assign.assigneeKey === "kyle" && r.assign.sourceHref === `/projects/${job.id}#revisions` && /Check in with Heather/.test(r.assign.title));
    const rowCopy = r!;

    await signIn(kim);
    const editorTry = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "HAPPY", cause: "BRIEF_GAP" });
    c.ok("an editor can't close it", !editorTry.ok, editorTry.message);
    await signIn(owner, kyle.id);
    const previewTry = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "HAPPY", cause: "BRIEF_GAP" });
    c.ok("the owner previewing Kyle can't close it", !previewTry.ok, previewTry.message);
    await signIn(owner);
    const assigned = await DA.assignTaskAction({ ...rowCopy.assign, assigneeKey: rowCopy.assign.assigneeKey ?? "kyle" });
    r = await rowOf();
    c.ok("once assigned, the row names who has the check-in", assigned.ok && r?.owner === "Kyle", `${assigned.message} · ${r?.owner}`);
    const noCause = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "HAPPY" });
    c.ok("closing as happy asks why it took 5 rounds", !noCause.ok && /why it took 5 rounds/.test(noCause.message), noCause.message);
    const closed = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "HAPPY", cause: "BRIEF_GAP", note: "Lot-line spec now in the brief" });
    r = await rowOf();
    const act = await prisma.activity.findFirst({ where: { projectId: job.id, body: { startsWith: "5 revision rounds closed" } } });
    const checkIn = await prisma.smartTask.findUnique({ where: { dedupeKey: `deleg:/projects/${job.id}#revisions` } });
    c.ok("Heather is happy + the cause: off the card", closed.ok && !r, closed.message);
    c.ok("…the job's activity records who, the answer and the cause", !!act && /Jordan/.test(act.body) && /client is happy/.test(act.body) && /The ask wasn't clear or written down/.test(act.body), act?.body);
    c.ok("…and Kyle's check-in is completed with it (nobody left chasing a closed question)", checkIn?.status === "COMPLETED", checkIn?.status);

    // Her next ask lands after the close (the close stamped the real clock).
    await prisma.revisionBrief.create({ data: { projectId: job.id, source: "email", originalText: "One more: the lot numbers are too small", requestedByKind: "EMAIL", createdAt: new Date(Date.now() + H) } });
    r = await rowOf();
    c.ok("a new ask after the close brings it back: '6 revision rounds · new ask after it was closed', high, saying who closed it", r?.title === "6 revision rounds · new ask after it was closed" && r.severity === "high" && r.close?.kind === "rounds" && /Jordan Spackman closed it .*\(client happy\)/.test(r.close.reopenedFrom ?? ""), JSON.stringify(r && [r.title, r.close]));
    await signIn(kyle);
    const noWords = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "COMPLAINT" });
    c.ok("Still unhappy asks what's still wrong", !noWords.ok && /still wrong/.test(noWords.message));
    const unhappy = await A.closeIssueSignalAction({ rowId: `revisions:${job.id}`, outcome: "COMPLAINT", note: "Thinks the lot numbers are still unreadable" });
    const ci = await od.clientIssuesSection({ now: T });
    const complaint = ci.rows.find((x) => x.kind === "complaint" && x.clientId === heather.id);
    c.ok("Kyle (office) can close it as still unhappy: a complaint opens and takes the row's place", unhappy.ok && !ci.rows.some((x) => x.id === `revisions:${job.id}`) && !!complaint && /Still unhappy after 6 revision rounds: 671 Northbrook Rd/.test(complaint.title) && complaint.nextAction === "Correct it", JSON.stringify(complaint && [complaint.title, complaint.nextAction]));

    // A one-off signal: a cancellation after delivery.
    const cjob = await prisma.project.create({ data: { clientId: heather.id, title: "9 Cancel Ct, Town", status: "DELIVERED" } });
    const cancelled = await prisma.activity.create({ data: { projectId: cjob.id, type: "SYSTEM", body: "Order canceled in Aryeo AFTER delivery: the agent lost the listing" } });
    let cRow = (await od.clientIssuesSection({ now: T })).rows.find((x) => x.id === `cancel:${cancelled.id}`);
    c.ok("a cancellation says why it's here and closes with one line", cRow?.close?.kind === "done" && /why it was cancelled/.test(cRow.whyHere ?? ""), JSON.stringify(cRow?.close));
    const empty = await A.closeIssueSignalAction({ rowId: `cancel:${cancelled.id}`, outcome: "DONE", note: "" });
    const done = await A.closeIssueSignalAction({ rowId: `cancel:${cancelled.id}`, outcome: "DONE", note: "Listing pulled; no refund, delivered in full" });
    cRow = (await od.clientIssuesSection({ now: T })).rows.find((x) => x.id === `cancel:${cancelled.id}`);
    c.ok("…the line is required; with it, off the card and on the job's record", !empty.ok && done.ok && !cRow && !!(await prisma.activity.findFirst({ where: { projectId: cjob.id, body: { contains: "Listing pulled" } } })));
    const bogus = await A.closeIssueSignalAction({ rowId: "complaint:whatever", outcome: "DONE", note: "x y z" });
    c.ok("a complaint or anything else isn't closed here (its own record does that)", !bogus.ok, bogus.message);

    // =====================================================================
    c.head("§3 · the panel");
    // =====================================================================
    const panel = (spec: PanelSpec, readOnly = false) => ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }], readOnly, initial: spec }, null));
    const html = panel({ kind: "issue", row: rowCopy });
    c.ok("renders: 'Why it's here', the reason, and Close it with 'Heather is happy' / 'Still unhappy'", !html.startsWith("RENDER FAILED") && html.includes("Why it&#x27;s here") && html.includes("nobody has confirmed Heather is happy") && html.includes(`data-close-signal="revisions:${job.id}"`) && html.includes("Heather is happy") && html.includes("Still unhappy"), html.slice(0, 300));
    c.ok("…says when it closes on its own and that a new ask brings it back; no 'resolve on the client's page' line", /closes on its own/.test(html) && /A new ask from Heather brings it back/.test(html) && !html.includes("resolve it with the outcome on the client"));
    c.ok("…the Assign button reads 'Assign the check-in'; the link opens the job", html.includes("Assign the check-in") && html.includes("Open the job"));
    const ro = panel({ kind: "issue", row: rowCopy }, true);
    c.ok("the read-only preview shows the reason but no close controls", ro.includes("Why it&#x27;s here") && !ro.includes("data-close-signal"));
    const cancelHtml = panel({ kind: "issue", row: { ...rowCopy, id: "cancel:x", kind: "cancellation", whyHere: "Nobody has recorded why", close: { kind: "done", prompt: "Why they cancelled, and the refund or write-off decided" } } });
    c.ok("a one-line close shows its own prompt and 'Mark done'", cancelHtml.includes("Why they cancelled, and the refund or write-off decided") && cancelHtml.includes("Mark done") && cancelHtml.includes("data-close-note"));
    const complaintHtml = panel({ kind: "issue", row: complaint! });
    c.ok("a complaint keeps its own panel: no close controls, resolve on the client's page", !complaintHtml.includes("data-close-signal") && complaintHtml.includes("resolve it with the outcome on the client"));
    c.ok("nothing left the box", fence.blocked.length === 0, JSON.stringify(fence.blocked));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
