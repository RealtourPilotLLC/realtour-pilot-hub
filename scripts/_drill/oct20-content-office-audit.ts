// ---------------------------------------------------------------------------
// DRILL: THE CONTENT PROGRAM'S OFFICE SIDE, OCT 20 2026 AUDIT (area D).
//
//   1. D4 strategy: "waiting for approval" is ONE rule (DRAFT or
//      INTERNAL_REVIEW, newer than the version in force). Approving a newer
//      version supersedes an UNRELATED older draft; an older draft cannot be
//      approved over the version in force; the Undo (putting a version that
//      WAS in force back) still works.
//   2. D5 approving a new version of a script the client already has keeps it
//      on their portal (the shared version, released) until it is sent;
//      "Approve & send" approves and shares the version in one press.
//   3. D6 pulling a released script off the portal takes a reason.
//   4. D7 moving a session to a month moves its program video rows too, and a
//      missing past month is made LIVE, not imported history.
//   5. D9/D10 the Dashboard's Monthly content card: a DRAFT script counts as
//      "to approve"; an earlier open month with a script waiting shows; a
//      paused client does not.
//   6. D11 "Draft the script from these answers" queues a first draft (the
//      click answers at once; a second click is refused while it waits), and
//      "New draft from the changed answers" is queued onto the existing script.
//
// ISOLATION: PGlite via the shared harness; no message leaves.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6991);
installNextStubs();
const fence = fenceFetch(async () => null);
// after(): captured and never run — the background work (a recalc, a queued
// AI draft) is not what these checks are about, and no model is called.
const pendingAfter: (() => Promise<unknown> | unknown)[] = [];
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: (fn: () => Promise<unknown> | unknown) => { pendingAfter.push(fn); } }));

const monthBefore = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-content-office-audit", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const strategy = await import("@/lib/contentStrategy");
  const { strategyAwaitingByEnrollment } = await import("@/lib/strategyAwaiting");
  const scripts = await import("@/lib/contentScripts");
  const A = await import("@/app/content/actions");
  const { establishSession } = await import("@/lib/auth/session");
  const { etMonthKey } = await import("@/lib/contentProgram");
  try {
    const owner = await prisma.appUser.create({ data: { email: "jordan@office-audit.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    await establishSession(owner.id);
    const staff = { email: owner.email, appUserId: owner.id };

    // =======================================================================
    c.head("1 · D4 strategy: one waiting rule, older drafts superseded");
    {
      const F = await buildContentMonth(db, { strategy: false, name: "Strategy Rule TEST", package: "Starter" });
      const doc = (t: string) => ({ structureVersion: "LEGACY" as const, sections: [{ id: "brand", number: null, heading: "Brand Overview", order: 1, text: t }], document: null });
      const v1 = await strategy.createStrategyVersion({ enrollmentId: F.enrollmentId, stored: doc("Discovery draft words."), sourceKind: "discovery_call", createdBy: "ai", status: "DRAFT" });
      const v2 = await strategy.createStrategyVersion({ enrollmentId: F.enrollmentId, stored: doc("Imported document words."), sourceKind: "import", createdBy: owner.email, status: "INTERNAL_REVIEW" });
      const before = await strategy.strategyAwaitingCounts([F.enrollmentId]);
      c.ok("before any approval, both the DRAFT and the INTERNAL_REVIEW version wait", before.get(F.enrollmentId) === 2, JSON.stringify([...before]));
      await strategy.approveStrategyVersion(v2.versionId, owner.email);
      const rows = await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: F.enrollmentId }, orderBy: { versionNo: "asc" } });
      c.ok("approving v2 supersedes the unrelated older discovery draft v1", rows[0].status === "SUPERSEDED" && rows[1].status === "APPROVED", rows.map((r) => r.status).join(","));
      const after = await strategy.strategyAwaitingCounts([F.enrollmentId]);
      c.ok("…and nothing waits any more", !after.get(F.enrollmentId), JSON.stringify([...after]));
      // A stale draft left from before this rule (written straight to the row).
      await prisma.contentStrategyVersion.update({ where: { id: v1.versionId }, data: { status: "DRAFT" } });
      c.ok("an older draft beside the version in force is not counted as waiting", !(await strategy.strategyAwaitingCounts([F.enrollmentId])).get(F.enrollmentId));
      const refused = await A.approveStrategy(v1.versionId);
      c.ok("…and approving it over the newer version in force is refused", !refused.ok && /older than v2/.test(refused.message), refused.message);
      c.ok("  …v2 stays in force", (await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v2.versionId } })).status === "APPROVED");
      await prisma.contentStrategyVersion.update({ where: { id: v1.versionId }, data: { status: "SUPERSEDED" } });
      const v3 = await strategy.createStrategyVersion({ enrollmentId: F.enrollmentId, stored: doc("An edit on v2."), sourceKind: "manual", createdBy: owner.email, status: "INTERNAL_REVIEW", basedOnVersionId: v2.versionId });
      c.ok("a newer version waits (1)", (await strategy.strategyAwaitingCounts([F.enrollmentId])).get(F.enrollmentId) === 1);
      await strategy.approveStrategyVersion(v3.versionId, owner.email);
      await strategy.approveStrategyVersion(v2.versionId, owner.email); // the Undo: v2 WAS in force
      const undo = await prisma.contentStrategyVersion.findMany({ where: { enrollmentId: F.enrollmentId }, orderBy: { versionNo: "asc" }, select: { versionNo: true, status: true } });
      c.ok("the Undo still puts v2 back in force and sends v3 back to wait", undo.find((x) => x.versionNo === 2)?.status === "APPROVED" && undo.find((x) => x.versionNo === 3)?.status === "INTERNAL_REVIEW", JSON.stringify(undo));
      c.ok("…and v3 counts as waiting again", (await strategy.strategyAwaitingCounts([F.enrollmentId])).get(F.enrollmentId) === 1);
      const pure = strategyAwaitingByEnrollment([{ enrollmentId: "e", versionNo: 1, status: "DRAFT" }, { enrollmentId: "e", versionNo: 2, status: "APPROVED" }, { enrollmentId: "e", versionNo: 3, status: "DRAFT" }, { enrollmentId: "f", versionNo: 1, status: "INTERNAL_REVIEW" }]);
      c.ok("the pure rule: newer-than-in-force only, DRAFT and INTERNAL_REVIEW alike", pure.get("e") === 1 && pure.get("f") === 1, JSON.stringify([...pure]));
    }

    // =======================================================================
    c.head("2 · D5 a released script stays on the portal when a new version is approved; Approve & send");
    const S = await buildContentMonth(db, { strategy: false, name: "Script Keep TEST", package: "Starter", topics: [{ title: "First weekend", selection: "SELECTED" }, { title: "Second look", selection: "SELECTED" }] });
    const pts = [{ role: "re-hook" as const, text: "Buyers decide in two days." }, { role: "build-up" as const, text: "Price it right and they compete." }, { role: "payoff" as const, text: "That is how you win the weekend." }];
    const parts = (hook: string) => ({ title: "First weekend", hook, points: pts, close: "Call me before you list.", captionCta: null });
    {
      const v1 = await scripts.createScriptVersion({ enrollmentId: S.enrollmentId, monthId: S.monthId, topicId: S.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: parts("Your first weekend decides your price.") });
      await scripts.approveScriptVersion(v1.versionId, staff, "drill: no pillar yet");
      await scripts.releaseScriptVersion(v1.scriptId, staff);
      const v2 = await scripts.createScriptVersion({ scriptId: v1.scriptId, enrollmentId: S.enrollmentId, monthId: S.monthId, topicId: S.topicIds[0], source: "MANUAL", status: "DRAFT", createdBy: owner.email, parts: parts("The first weekend sets your price, every time.") });
      await scripts.approveScriptVersion(v2.versionId, staff, "drill: no pillar yet");
      const s = await prisma.contentScript.findUniqueOrThrow({ where: { id: v1.scriptId } });
      c.ok("approving v2 of a released script keeps it released, still showing v1", s.releaseState === "released" && s.sharedVersionId === v1.versionId && s.approvedVersionId === v2.versionId, `${s.releaseState} shared=${s.sharedVersionId === v1.versionId} approved=${s.approvedVersionId === v2.versionId}`);
      const { scriptVisibility } = await import("@/lib/postingKit");
      c.ok("…so the portal still shows it", scriptVisibility(s) === "released");

      const w1 = await scripts.createScriptVersion({ enrollmentId: S.enrollmentId, monthId: S.monthId, topicId: S.topicIds[1], source: "AI", status: "DRAFT", createdBy: "ai", parts: { ...parts("A second look sells the house."), title: "Second look" } });
      const sent = await A.approveAndSendScriptAction(w1.versionId, "drill: no pillar yet");
      const w = await prisma.contentScript.findUniqueOrThrow({ where: { id: w1.scriptId } });
      c.ok("Approve & send: one press approves and shares this exact version", sent.ok && w.approvedVersionId === w1.versionId && w.sharedVersionId === w1.versionId && w.releaseState === "released", sent.message);
      c.ok("…with the email suppressed while its switch is off", /suppressed/i.test(sent.message), sent.message);

      // Approve & send SELECTED: the ticked versions, each at its exact version.
      const { createPillar } = await import("@/lib/contentPillars");
      const pillarId = await createPillar({ enrollmentId: S.enrollmentId, clientId: S.clientId, name: "Pricing", createdBy: owner.email });
      const bulkTopics = await Promise.all(["Bulk one", "Bulk two"].map((title) => prisma.contentTopic.create({ data: { enrollmentId: S.enrollmentId, clientId: S.clientId, title, status: "SELECTED", source: "staff" } })));
      const b1 = await scripts.createScriptVersion({ enrollmentId: S.enrollmentId, monthId: S.monthId, topicId: bulkTopics[0].id, source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { ...parts("Bulk one, a hook with a pillar."), title: "Bulk one", pillarId, categoryLabel: "Pricing" } });
      const b2 = await scripts.createScriptVersion({ enrollmentId: S.enrollmentId, monthId: S.monthId, topicId: bulkTopics[1].id, source: "AI", status: "DRAFT", createdBy: "ai", parts: { ...parts("Bulk two, a hook with no pillar."), title: "Bulk two" } });
      const bulk = await A.approveAndSendScriptsAction([b1.versionId, b2.versionId]);
      const [h1, h2] = await Promise.all([b1, b2].map((b) => prisma.contentScript.findUniqueOrThrow({ where: { id: b.scriptId } })));
      c.ok("Approve & send selected: a clean script is approved and shared", h1.sharedVersionId === b1.versionId && h1.releaseState === "released", bulk.message);
      c.ok("…one that needs a written reason stays in the queue and is named", !h2.approvedVersionId && !h2.sharedVersionId && /Bulk two/.test(bulk.message) && /Format check/.test(bulk.message) && bulk.done === 1 && bulk.failed === 1, bulk.message);

      // =====================================================================
      c.head("3 · D6 pulling a script off the client's portal takes a reason");
      const noWhy = await A.returnScriptAction(w1.scriptId, " ");
      c.ok("no reason → refused, still on the portal", !noWhy.ok && /Say why/.test(noWhy.message) && (await prisma.contentScript.findUniqueOrThrow({ where: { id: w1.scriptId } })).releaseState === "released", noWhy.message);
      const pulled = await A.returnScriptAction(w1.scriptId, "Wrong listing named in the hook");
      const p = await prisma.contentScript.findUniqueOrThrow({ where: { id: w1.scriptId } });
      const ledger = await prisma.contentScriptRelease.findFirst({ where: { scriptId: w1.scriptId, action: "RETURN_TO_QUEUE" }, orderBy: { createdAt: "desc" } });
      c.ok("with a reason → off the portal, back in review, the reason on the ledger", pulled.ok && p.releaseState === "withheld" && !p.sharedVersionId && ledger?.note === "Wrong listing named in the hook", pulled.message);
    }

    // =======================================================================
    c.head("4 · D7 a session move takes its video rows, and the month it lands on is live");
    {
      const M = await buildContentMonth(db, { strategy: false, name: "Session Move TEST", package: "Starter" });
      const video = await prisma.contentVideo.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, monthKey: M.monthKey, projectId: M.projectId, kind: "PROGRAM", countsTowardAllowance: true, title: "Moved video TEST", status: "FILMED", source: "manual" } });
      const target = monthBefore(M.monthKey);
      const r = await A.moveSessionToMonth(M.projectId!, target);
      const month = await prisma.contentMonth.findFirst({ where: { enrollmentId: M.enrollmentId, monthKey: target } });
      const v = await prisma.contentVideo.findUniqueOrThrow({ where: { id: video.id } });
      c.ok("the move is confirmed", r.ok && r.outcome === "confirmed", r.message);
      c.ok("the past month it made is a live month, not imported history", !!month && month.historical === false, JSON.stringify(month));
      c.ok("the video row moved with the session (month and key)", v.monthId === month?.id && v.monthKey === target, `${v.monthKey}`);
    }

    // =======================================================================
    c.head("5 · D9/D10 the Dashboard's Monthly content card");
    {
      const { monthlyContentActions } = await import("@/lib/contentActions");
      const thisMonth = etMonthKey();
      const E = await buildContentMonth(db, { strategy: false, name: "Earlier Month TEST", package: "Starter", monthKey: monthBefore(thisMonth), topics: [{ title: "Last month's topic", selection: "SELECTED" }] });
      await scripts.createScriptVersion({ enrollmentId: E.enrollmentId, monthId: E.monthId, topicId: E.topicIds[0], source: "AI", status: "DRAFT", createdBy: "ai", parts: { ...parts("Last month's hook, written from their answers."), title: "Last month's topic" } });
      const P = await buildContentMonth(db, { strategy: false, name: "Paused Client TEST", package: "Starter", enrollmentStatus: "PAUSED", topics: [{ title: "Paused topic", selection: "SELECTED" }] });
      await scripts.createScriptVersion({ enrollmentId: P.enrollmentId, monthId: P.monthId, topicId: P.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { ...parts("A paused client's hook."), title: "Paused topic" } });
      const card = await monthlyContentActions();
      const earlier = card.rows.find((r) => r.clientName === "Earlier Month TEST");
      c.ok("an earlier open month with a DRAFT waiting reaches the card", !!earlier && earlier.monthKey === E.monthKey, JSON.stringify(card.rows.map((r) => [r.clientName, r.monthKey])));
      c.ok("…and the DRAFT reads as a script to approve, never a draft to finish", !!earlier?.items.some((i) => i.key === "approve" && /1 script to approve/.test(i.words)) && !earlier?.items.some((i) => i.key === "drafting"), JSON.stringify(earlier?.items));
      c.ok("a paused client is not on the card", !card.rows.some((r) => r.clientName === "Paused Client TEST"));
    }

    // =======================================================================
    c.head("6 · D11 a first draft from written answers goes on the queue");
    {
      const W = await buildContentMonth(db, { strategy: false, name: "Written Answers TEST", package: "Starter", topics: [{ title: "Written topic", selection: "SELECTED" }] });
      const { getOrCreateInterview } = await import("@/lib/contentInterview");
      const ivId = await getOrCreateInterview(W.topicIds[0], W.monthId, { staffUserId: owner.email });
      const r = await A.draftScriptFromInterview(ivId);
      const runs = await prisma.programAiRun.findMany({ where: { enrollmentId: W.enrollmentId } });
      c.ok("the click answers at once: one QUEUED written-answer draft, no script written yet", r.ok && /Sent for scripting/.test(r.message) && runs.length === 1 && runs[0].status === "QUEUED" && /"job":"script_interview"/.test(runs[0].scopeJson ?? "") && !(await prisma.contentScript.count({ where: { enrollmentId: W.enrollmentId } })), `${r.message} · ${runs.map((x) => x.status).join(",")}`);
      c.ok("…and the worker waits in after(), the model untouched", pendingAfter.length > 0);
      const again = await A.draftScriptFromInterview(ivId);
      c.ok("a second click is refused while it is queued", !again.ok && (await prisma.programAiRun.count({ where: { enrollmentId: W.enrollmentId } })) === 1, again.message);
      // The first draft lands (its key freed); the answers change; "New draft from the changed answers".
      const first = await prisma.programAiRun.findFirstOrThrow({ where: { enrollmentId: W.enrollmentId } });
      await prisma.programAiRun.update({ where: { id: first.id }, data: { status: "SUCCEEDED", dedupeKey: null, finishedAt: new Date() } });
      const made = await scripts.createScriptVersion({ enrollmentId: W.enrollmentId, monthId: W.monthId, topicId: W.topicIds[0], interviewId: ivId, source: "AI", status: "DRAFT", createdBy: "ai", parts: { ...parts("A hook written from their first answers."), title: "Written topic" } });
      const redraft = await A.draftScriptFromInterview(ivId);
      const queued = await prisma.programAiRun.findMany({ where: { enrollmentId: W.enrollmentId, status: "QUEUED" } });
      const rscope = JSON.parse(queued[0]?.scopeJson ?? "{}") as { job?: string; onlyIfUnscripted?: boolean; scriptId?: string };
      c.ok("a NEW draft from changed answers is queued too (onlyIfUnscripted off, on the existing script), no version written yet", redraft.ok && /Sent for a new draft/.test(redraft.message) && queued.length === 1 && rscope.job === "script_interview" && rscope.onlyIfUnscripted === false && rscope.scriptId === made.scriptId && (await prisma.contentScriptVersion.count({ where: { scriptId: made.scriptId } })) === 1, `${redraft.message} · ${queued[0]?.scopeJson}`);
      const { queueStateFor } = await import("@/lib/aiQueue");
      const qs = await queueStateFor(W.enrollmentId, { monthId: W.monthId });
      c.ok("…and the page shows it on that script (\"redraft\"), not as a topic draft", qs.scripts[made.scriptId]?.label === "redraft" && !qs.topics[W.topicIds[0]], JSON.stringify(qs));
    }

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
