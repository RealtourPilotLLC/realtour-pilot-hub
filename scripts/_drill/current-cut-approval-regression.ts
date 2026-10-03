// Focused companion to client-production-journey: stale creative verdicts,
// real PostgreSQL entry/approval interleavings, and the canonical finishing
// gate's failure/duplicate/fallback behavior. All rows are disposable; every
// provider is fenced. Entry writes below are explicit concurrency inputs,
// not claims that a browser or a renderer was exercised.
// @drill-run: engine=postgres needs=tools/realpg
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch();
function door() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}
type Park = { inside: ReturnType<typeof door>; release: ReturnType<typeof door> };
const makePark = (): Park => ({ inside: door(), release: door() });
let gatePark: Park | null = null;
let claimPark: Park | null = null;
let applyPark: (Park & { issueId: string }) | null = null;
let fileReadFails = false;
// Park the real issue read after the initial current-round check. Native
// import() snapshots real exports, so wrapping approvalGate itself would not
// force an interleaving; its static Prisma import is the reliable seam.
interceptModule((r) => r === "@/lib/prisma" || /[\\/]src[\\/]lib[\\/]prisma(\.ts)?$/.test(r), (loaded) => {
  const m = loaded as { prisma: Record<PropertyKey, unknown> };
  const bind = (value: unknown, self: object) => typeof value === "function" ? value.bind(self) : value;
  const wrappedTx = (tx: Record<PropertyKey, unknown>) => new Proxy(tx, {
    get(t, key) {
      const value = Reflect.get(t, key, t);
      if (key !== "reviewSubmission") return bind(value, t);
      return new Proxy(value as Record<PropertyKey, unknown>, {
        get(d, method) {
          const fn = Reflect.get(d, method, d);
          if (method !== "findMany") return bind(fn, d);
          return async (args: { select?: { selfCheckId?: boolean } }) => {
            const out = await (fn as (args: unknown) => Promise<unknown>).call(d, args);
            const p = claimPark;
            if (p && args.select?.selfCheckId) { claimPark = null; p.inside.open(); await p.release.wait; }
            return out;
          };
        },
      });
    },
  });
  return { ...m, prisma: new Proxy(m.prisma, {
    get(t, key) {
      const value = Reflect.get(t, key, t);
      if (key === "$transaction") return (fn: unknown, ...rest: unknown[]) => typeof fn === "function"
        ? (value as (...args: unknown[]) => unknown).call(t, (tx: Record<PropertyKey, unknown>) => fn(wrappedTx(tx)), ...rest)
        : (value as (...args: unknown[]) => unknown).call(t, fn, ...rest);
      if (key === "revisionIssue") return new Proxy(value as Record<PropertyKey, unknown>, {
        get(d, method) {
          const fn = Reflect.get(d, method, d);
          if (method === "updateMany") return async (args: { where?: { id?: string }; data?: { state?: string } }) => {
            const p = applyPark;
            if (p && args.where?.id === p.issueId && args.data?.state === "VERIFIED") {
              applyPark = null; p.inside.open(); await p.release.wait;
            }
            return (fn as (args: unknown) => Promise<unknown>).call(d, args);
          };
          if (method !== "findMany") return bind(fn, d);
          return async (...args: unknown[]) => {
            const out = await (fn as (...args: unknown[]) => Promise<unknown>).apply(d, args);
            const p = gatePark;
            if (p) { gatePark = null; p.inside.open(); await p.release.wait; }
            return out;
          };
        },
      });
      if (key === "topazJob") return new Proxy(value as Record<PropertyKey, unknown>, {
        get(d, method) {
          const fn = Reflect.get(d, method, d);
          if (method !== "findMany") return bind(fn, d);
          return (...args: unknown[]) => {
            if (fileReadFails) throw new Error("isolated final-file read failure");
            return (fn as (...args: unknown[]) => unknown).apply(d, args);
          };
        },
      });
      return bind(value, t);
    },
  }) };
});
async function reached(p: Park, approval: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([p.inside.wait, approval.then((result) => { throw new Error(`approval finished before its park: ${JSON.stringify(result)}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("approval park was not reached")), 10_000); })]); }
  finally { clearTimeout(timer); }
}
async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5965), engine: "postgres", pool: 8, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-current-cut-race" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const rr = await import("@/app/review/actions");
    const cd = await import("@/lib/clientDecisions");
    const ri = await import("@/lib/revisionIssues");
    const { clientCutFiles } = await import("@/lib/cutEntitlement");
    const { setSession } = await import("@/lib/auth/session");
    const owner = await prisma.appUser.create({ data: { email: "current-cut-owner@example.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const world = async (name: string) => buildContentMonth(prisma, { name: `${name} TEST`, package: "Starter" });
    const mk = async (f: Awaited<ReturnType<typeof world>>, round: number, opts: { legacy?: boolean; slot?: number; status?: string; name?: string } = {}) => prisma.reviewSubmission.create({ data: {
      projectId: f.projectId!, deliverableId: opts.legacy ? null : f.deliverableId, slot: opts.slot ?? 1, round,
      fileName: opts.name ?? `Seller first weekend v${round}.mp4`, status: opts.status ?? "CHANGES_REQUESTED", source: "folder", assetUrl: "https://media.example.test/cut.mp4",
    } });
    c.head("A newer entered cut wins before the creative verdict CAS");
    for (const legacy of [false, true]) {
      const f = await world(legacy ? "Legacy stale" : "Slot stale");
      const old = await mk(f, 1, { legacy });
      const p = makePark(); gatePark = p;
      const approval = rr.approveCut(old.id);
      await reached(p, approval);
      const newest = await mk(f, 2, { legacy, status: "PENDING" });
      p.release.open();
      const result = await approval;
      const oldAfter = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: old.id } });
      c.ok(`${legacy ? "legacy versioned filename" : "deliverable/slot"}: an entry after initial checks refuses the stale verdict and preserves history`, !result.ok && oldAfter.status === "CHANGES_REQUESTED" && !oldAfter.decidedAt && await prisma.cutReviewerEvent.count({ where: { submissionId: old.id } }) === 0 && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: newest.id } })).status === "PENDING", result.message);
    }
    c.head("The short verdict transaction serializes existing entry and new insert");
    for (const insert of [false, true]) {
      const f = await world(insert ? "Insert race" : "Entry race");
      const old = await mk(f, 1, { legacy: insert });
      const pending = insert ? null : await mk(f, 2, { status: "UPLOADING" });
      const p = makePark(); claimPark = p;
      const approval = rr.approveCut(old.id);
      await reached(p, approval);
      // PrismaPromise is lazy: attach then now so the existing-row writer
      // actually starts while the verdict is parked inside its transaction.
      const writer = (insert ? mk(f, 2, { legacy: true, status: "PENDING" }) : prisma.reviewSubmission.update({ where: { id: pending!.id }, data: { status: "PENDING" } })).then((row) => row);
      let waited = false;
      for (const end = Date.now() + 3000; Date.now() < end;) {
        if (await db.waitingLocks() > 0) { waited = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const backends = await db.distinctBackends();
      p.release.open();
      const result = await approval;
      const newest = await writer;
      const saved = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: old.id } });
      const repeat = await rr.approveCut(old.id);
      c.ok(`${insert ? "new legacy insert" : "reserved cut entry"} waits on a real PostgreSQL lock; earlier approval stays historical and its duplicate is inert`, waited && backends >= 2 && result.ok && saved.status === "APPROVED" && newest.status === "PENDING" && repeat.ok && repeat.message === "Already approved.", `writerWaited=${waited}, backends=${backends}, ${result.message}`);
    }
    c.head("A won verdict verifies only the declaration its issue gate read");
    {
      const f = await world("Issue version race");
      const old = await mk(f, 1, { status: "PENDING" });
      const issue = await prisma.revisionIssue.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId, slot: 1, sourceKind: "MANUAL", sourceId: "declaration-race", originalText: "Replace the old logo.", state: "ADDRESSED", addressedInSubmissionId: old.id, addressedAt: new Date() } });
      const p = { ...makePark(), issueId: issue.id }; applyPark = p;
      const approval = rr.approveCut(old.id);
      await reached(p, approval);
      const verdictAlreadyWon = (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: old.id } })).status === "APPROVED";
      const replacement = await mk(f, 2, { status: "PENDING" });
      const check = await prisma.cutSelfCheck.create({ data: { submissionId: replacement.id, projectId: f.projectId!, deliverableId: f.deliverableId, slot: 1, round: 2, actorName: "Kim", checklistKey: "isolated-accepted-check", itemsJson: "[]", state: "VALID" } });
      await prisma.reviewSubmission.update({ where: { id: replacement.id }, data: { selfCheckId: check.id, selfCheckedAt: new Date() } });
      await ri.applySelfCheckDeclarations(replacement.id, { addressed: [issue.id], notAddressed: {} }, { name: "Kim" });
      p.release.open();
      const result = await approval;
      const afterOldApply = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
      const oldVerifiedEvents = await prisma.revisionIssueEvent.count({ where: { issueId: issue.id, kind: "VERIFIED", submissionId: old.id } });
      const newVerdict = await rr.approveCut(replacement.id, { verifyIssueIds: [issue.id] });
      const finalIssue = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
      c.ok("a checked replacement rebinds an ADDRESSED issue after old verdict; only its own later approval verifies it", verdictAlreadyWon && result.ok && afterOldApply.state === "ADDRESSED" && afterOldApply.addressedInSubmissionId === replacement.id && !afterOldApply.verifiedInSubmissionId && oldVerifiedEvents === 0 && newVerdict.ok && finalIssue.state === "VERIFIED" && finalIssue.verifiedInSubmissionId === replacement.id, JSON.stringify({ verdictAlreadyWon, afterOldApply: { state: afterOldApply.state, addressedIn: afterOldApply.addressedInSubmissionId, verifiedIn: afterOldApply.verifiedInSubmissionId }, oldVerifiedEvents, newVerdict }));
    }
    {
      const f = await world("Issue content race");
      const old = await mk(f, 1, { status: "PENDING" });
      const issue = await prisma.revisionIssue.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId, slot: 1, sourceKind: "MANUAL", sourceId: "content-race", originalText: "Replace the logo and add the pool shot.", summary: "Replace the logo and add the pool shot.", state: "ADDRESSED", addressedInSubmissionId: old.id, addressedAt: new Date() } });
      const p = { ...makePark(), issueId: issue.id }; applyPark = p;
      const approval = rr.approveCut(old.id);
      await reached(p, approval);
      const split = await ri.splitIssue(issue.id, ["Replace the logo.", "Add the pool shot."], { name: "James" });
      p.release.open();
      const result = await approval;
      const after = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
      c.ok("a split/reworded ask after the verdict is not verified by the old captured text", result.ok && split.ok && after.state === "ADDRESSED" && after.summary === "Replace the logo." && !after.verifiedInSubmissionId && await prisma.revisionIssueEvent.count({ where: { issueId: issue.id, kind: "VERIFIED" } }) === 0);
    }
    {
      const f = await world("Legacy issue preservation");
      const cut = await mk(f, 1, { legacy: true, status: "PENDING" });
      const issue = await prisma.revisionIssue.create({ data: { projectId: f.projectId!, raisedOnSubmissionId: cut.id, sourceKind: "MANUAL", sourceId: "legacy-unversioned", originalText: "Use the current logo.", state: "ADDRESSED", addressedAt: new Date(), addressedInSubmissionId: null } });
      const prior = await prisma.revisionIssue.create({ data: { projectId: f.projectId!, raisedOnSubmissionId: cut.id, sourceKind: "MANUAL", sourceId: "legacy-verified", originalText: "The captions were already checked.", state: "VERIFIED", verifiedAt: new Date(), verifiedBy: "James", verifiedInSubmissionId: cut.id } });
      const p = { ...makePark(), issueId: issue.id }; applyPark = p;
      const approval = rr.approveCut(cut.id);
      await reached(p, approval);
      const classified = await ri.classifyIssue(issue.id, { cause: "CLIENT_CHANGE" }, { name: "James" });
      await prisma.revisionIssue.update({ where: { id: issue.id }, data: { assignedEditorKey: "kim" } });
      p.release.open();
      const result = await approval;
      const after = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issue.id } });
      const old = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: prior.id } });
      c.ok("unversioned legacy fixes still verify through metadata changes; prior verified history stays untouched", classified.ok && result.ok && after.state === "VERIFIED" && after.verifiedInSubmissionId === cut.id && after.addressedInSubmissionId === null && after.cause === "CLIENT_CHANGE" && after.assignedEditorKey === "kim" && after.updatedAt.getTime() !== issue.updatedAt.getTime() && old.state === prior.state && old.verifiedInSubmissionId === prior.verifiedInSubmissionId && old.verifiedAt?.getTime() === prior.verifiedAt?.getTime() && old.updatedAt.getTime() === prior.updatedAt.getTime());
    }
    c.head("Final-file hold, failed read, prior receipt and delivered fallback");
    c.head("Missing revision verification ticks require explicit recorded approval");
    {
      const fixture = await world("Approve unchecked fixes");
      const cut = await mk(fixture, 1, { status: "PENDING" });
      const check = await prisma.cutSelfCheck.create({ data: { submissionId: cut.id, projectId: fixture.projectId!, deliverableId: fixture.deliverableId, slot: 1, round: 1, actorName: "Kim", checklistKey: "isolated-checked-cut", itemsJson: "[]", state: "VALID" } });
      await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { selfCheckId: check.id, selfCheckedAt: new Date() } });
      const fix = await prisma.revisionIssue.create({ data: { projectId: fixture.projectId!, deliverableId: fixture.deliverableId, slot: 1, sourceKind: "MANUAL", sourceId: "unticked-fix", originalText: "Check the revised opening.", state: "ADDRESSED", addressedInSubmissionId: cut.id, addressedAt: new Date() } });
      const warned = await rr.approveCut(cut.id, { verifyIssueIds: [] });
      c.ok("ordinary approval warns about missing ticks without changing the verdict", !warned.ok && warned.canApproveAnyway === true && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } })).status === "PENDING");
      const approvedAnyway = await rr.approveCut(cut.id, { verifyIssueIds: [], approveUncheckedFixes: true });
      const recorded = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } });
      const audit = await prisma.auditLog.findFirst({ where: { target: cut.id, action: "cut_approved_with_unchecked_fixes" } });
      c.ok("explicit approve-anyway records the authorized creative verdict", approvedAnyway.ok && recorded.status === "APPROVED" && recorded.decidedByUserId === owner.id, approvedAnyway.message);
      c.ok("missing ticks stay unverified instead of fabricating checkbox evidence", (await prisma.revisionIssue.findUniqueOrThrow({ where: { id: fix.id } })).state === "ADDRESSED" && await prisma.revisionIssueEvent.count({ where: { issueId: fix.id, kind: "VERIFIED" } }) === 0);
      c.ok("override audit records reviewer, exact version and omitted fix IDs", !!audit && JSON.parse(audit.detail).actorUserId === owner.id && JSON.parse(audit.detail).round === 1 && JSON.parse(audit.detail).uncheckedFixIds.includes(fix.id));
      await rr.approveCut(cut.id, { verifyIssueIds: [], approveUncheckedFixes: true });
      c.ok("repeated confirmation preserves original verdict and single override receipt", await prisma.auditLog.count({ where: { target: cut.id, action: "cut_approved_with_unchecked_fixes" } }) === 1 && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: cut.id } })).decidedAt?.getTime() === recorded.decidedAt?.getTime());
      const denied = await mk(fixture, 2, { status: "PENDING" });
      const editor = await prisma.appUser.create({ data: { email: "override-editor@example.test", name: "Fixture Editor", role: "EDITOR", status: "ACTIVE" } });
      await setSession({ uid: editor.id, email: editor.email, role: editor.role });
      const forbidden = await rr.approveCut(denied.id, { verifyIssueIds: [], approveUncheckedFixes: true });
      c.ok("approve-anyway never grants an editor creative approval permission", !forbidden.ok && (await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: denied.id } })).status === "PENDING");
      await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    }
    const f = await world("Finishing gate");
    const viewer: import("@/lib/portal").PortalViewer = {
      enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.clientName, status: "ACTIVE", videosPerMonth: f.videosPerMonth, sessionsPerMonth: f.sessionsPerMonth },
      actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "fixture-owner@example.test", name: "Maya", membershipId: f.membershipId!, membershipRole: "OWNER" }, access: "FULL", via: "LOGIN",
    } as import("@/lib/portal").PortalViewer;
    const held = await mk(f, 1, { status: "APPROVED", slot: 1 });
    await prisma.reviewSubmission.update({ where: { id: held.id }, data: { decidedAt: new Date(), clientReleasedAt: new Date() } });
    const render = await prisma.topazJob.create({ data: { projectId: f.projectId!, submissionId: held.id, state: "processing" } });
    const refused = await cd.approveCut(viewer, held.id, "NONE");
    fileReadFails = true;
    const unreadable = await cd.approveCut(viewer, held.id, "NONE");
    fileReadFails = false;
    c.ok("processing and read failure claim no window and record no new decision", !refused.ok && !unreadable.ok && await prisma.contentReviewWindow.count({ where: { submissionId: held.id } }) === 0 && await prisma.clientDecision.count({ where: { submissionId: held.id } }) === 0, `${refused.message} / ${unreadable.message}`);
    await prisma.topazJob.update({ where: { id: render.id }, data: { state: "done", finalPath: "/Fixture/Final.mp4", savedAt: new Date(), outputCheck: "verified" } });
    const accepted = await cd.approveCut(viewer, held.id, "NONE");
    await prisma.topazJob.update({ where: { id: render.id }, data: { state: "processing" } });
    fileReadFails = true;
    const duplicate = await cd.approveCut(viewer, held.id, "NONE");
    fileReadFails = false;
    c.ok("a recorded prior approval keeps its exact receipt through a later finishing hold/read failure", accepted.ok && duplicate.ok && duplicate.duplicate === true && duplicate.decisionId === accepted.decisionId && await prisma.clientDecision.count({ where: { submissionId: held.id, decision: "APPROVE" } }) === 1 && (await clientCutFiles([held.id])).get(held.id)?.kind === "original");
    const delivered = await mk(f, 1, { status: "APPROVED", slot: 2, name: "Buyer visit v1.mp4" });
    await prisma.reviewSubmission.update({ where: { id: delivered.id }, data: { decidedAt: new Date(), clientReleasedAt: new Date(), sentToClientAt: new Date() } });
    await prisma.topazJob.create({ data: { projectId: f.projectId!, submissionId: delivered.id, state: "processing" } });
    c.ok("an already delivered cut retains the canonical original-file fallback", (await clientCutFiles([delivered.id])).get(delivered.id)?.kind === "original" && (await cd.approveCut(viewer, delivered.id, "NONE")).ok);
    c.ok("no external call or outbound client message was made", fence.blocked.length === 0 && await prisma.outboxMessage.count() === 0, fence.blocked.join(", "));
    console.log(await db.evidence());
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
