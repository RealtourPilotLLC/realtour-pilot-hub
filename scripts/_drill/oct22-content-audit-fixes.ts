// ---------------------------------------------------------------------------
// DRILL: THE CONTENT PROGRAM AUDIT FIXES, OCT 22 2026.
//
//   H2  offline and test AI runs no longer count against a client's daily cap;
//       the 15-minute check sweep skips a client at its cap and carries on.
//   H3  billing terms leave the enrollment history for anyone but the owner;
//       the office reads "a fee may apply", never the dollars.
//   H4  Joe Sutow's October: the hub's drafts step aside for an upload, the
//       call's topics go back to the bank, the uploaded picks stop being
//       extras and their filmed videos count.
//   M1  the answers reminder only when picked topics owe answers; with
//       nothing picked, PICK_TOPICS on the written route, ours otherwise.
//   M2  stale escalation, answer-gap and discovery tasks close with a note.
//   M3  a Mix account short of skit ideas gets a skit-only refresh.
//   M4  a topic pointing at an August import while picked for October.
//   M5  the Dashboard card and the month page agree (the fork's section).
//   M6  staff notes on a topic's history never reach the client's browser.
//   LOW stale publication failures, the library check on ended programs, and
//       the per-device drafts of three portal boxes.
//
// ISOLATION: PGlite via the shared harness; the model is a stub; no message leaves.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";
import { isJudgeCall, passingJudge, isIdentityCall, plainIdentity } from "./_judge";

const PORT = Number(process.env.DRILL_PORT ?? 6981);
const REPO = path.resolve(__dirname, "../..");
const STAFF_EMAIL = "jordan@audit-oct22.test";
// The reminder evaluator and the task pass read the calendar: they run on the audit day, in the fixture month (2026-10).
const EVAL_NOW = new Date("2026-10-22T16:00:00Z");
installNextStubs();
const fence = fenceFetch(async () => null);
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: () => {} }));

// ---- the model boundary ----------------------------------------------------
const modelCalls: { system: string; prompt: string; schema: unknown }[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage" && k !== "aiStructuredWithUsage") return t[k];
      return async (opts: { system: string; prompt: string; schema?: unknown }) => {
        modelCalls.push({ system: opts.system, prompt: opts.prompt, schema: opts.schema });
        if (isJudgeCall(opts.system)) return passingJudge();
        if (isIdentityCall(opts.system)) return plainIdentity();
        const usage = { inputTokens: 500, outputTokens: 200 };
        if (/Video Topic Bank/.test(opts.system)) {
          const pillars = [...new Set([...opts.prompt.matchAll(/Pillar \d+: ([^\n]+)/g)].map((m) => m[1].trim()))];
          // A skit-only refresh: two skits and one talking-to-camera idea per pillar (the last must be dropped).
          const out = pillars.map((p, pi) => ({
            pillarName: p,
            topics: ["lantern", "orchard", "granite"].map((w, i) => ({
              title: `${p.split(" ")[0]} ${w} skit ${pi * 3 + i}`, description: `An acted scene about ${w}.`, audienceNeed: "Sellers", businessGoal: "Trust", intendedMessage: "Plan first", sourceRef: null,
              format: i < 2 ? "SKIT" : "DIRECT",
            })),
          }));
          return { result: { complete: true, pillars: out, gaps: [] }, usage, model: "drill-stub" };
        }
        throw new Error(`unexpected model call in the audit drill: ${opts.system.slice(0, 80)}`);
      };
    },
  }),
);

const SELLER = "Seller Strategy";
const BRAND = "Personal Branding";
function strategyDoc(name: string) {
  return {
    clientName: name, year: 2026, subtitle: "Content Strategy",
    brandOverview: { coreValues: "Honest advice.", brandMessage: "Plan before you list.", shortBrandStatement: null, brandVoice: "Plain, warm.", otherFields: [], paragraphs: [] },
    targetAudience: { present: true, heading: "Target Audience", primaryServiceAreas: "Lehigh Valley", pricePositioning: null, primaryClientTypes: "Move-up sellers", longTermPositioningGoal: "The agent sellers call first.", otherFields: [], paragraphs: [] },
    contentGoals: { heading: "Content Goals", items: ["Build trust with sellers"], numbered: false },
    contentPillars: { heading: "Content Pillars", preamble: ["Trust, Value, Credibility and Entertainment guide every pillar."], pillars: [
      { number: 1, name: SELLER, heading: `Pillar 1: ${SELLER}`, purpose: "Show how a sale is planned.", focusAreas: "pricing, prep", contentApproach: null, otherFields: [] },
      { number: 2, name: BRAND, heading: `Pillar 2: ${BRAND}`, purpose: "Let people know the agent.", focusAreas: "story, animals", contentApproach: null, otherFields: [] },
    ] },
    framework: null, captionCtaExamples: { heading: "Caption CTA Examples", items: ["DM me PLAN."] },
    strategicDirection: { heading: "Strategic Direction", paragraphs: ["More personal branding."] }, otherSections: [],
  };
}

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-content-audit-oct22", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const noDash = (s: string) => !/[‒-―]/.test(s);
  const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
  const { establishSession } = await import("@/lib/auth/session");
  const ct = await import("@/lib/contentTopics");
  try {
    const owner = await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    const kyle = await prisma.appUser.create({ data: { email: "kyle@audit-oct22.test", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" } });
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: new Date() }, update: { enabled: true } });
    const today = () => new Date();

    // =======================================================================
    c.head("H2 · test and offline runs are off the client's cap; the sweep carries on");
    // =======================================================================
    {
      const ai = await import("@/lib/aiRuns");
      c.ok("isOfflineRun: claude:* and scope offline are offline; cron and a person are not",
        ai.isOfflineRun("claude:erica-redraft-oct22") && ai.isOfflineRun("info@realtourpilot.com", { offline: true }) && ai.isOfflineRun(null, '{"topicId":"x","offline":true}') && !ai.isOfflineRun("cron") && !ai.isOfflineRun("info@realtourpilot.com", { offline: false }));
      const A = await buildContentMonth(db, { name: "Cap Client TEST", package: "Accelerator" });
      const runs = (n: number, data: Record<string, unknown>) => prisma.programAiRun.createMany({ data: Array.from({ length: n }, () => ({ kind: "script_draft", enrollmentId: A.enrollmentId, clientId: A.clientId, promptKey: "drill", status: "SUCCEEDED", startedAt: today(), ...data })) });
      await runs(45, { requestedBy: "claude:retro-oct22" });
      await runs(10, { requestedBy: "info@realtourpilot.com", scopeJson: JSON.stringify({ topicId: "t", offline: true, writerStep: "review" }) });
      let refused: unknown = null;
      try { await ai.assertQuota("script_draft", A.enrollmentId); } catch (e) { refused = e; }
      c.ok("55 test and offline runs today: the client's cap is not reached (40 a day)", refused === null, String(refused));
      await runs(40, { requestedBy: "info@realtourpilot.com" });
      try { await ai.assertQuota("script_draft", A.enrollmentId); } catch (e) { refused = e; }
      c.ok("40 of the client's own runs: refused, and the refusal says it is THIS client's cap", refused instanceof ai.QuotaExceededError && (refused as InstanceType<typeof ai.QuotaExceededError>).scope === "client", String(refused));
      let offlineRefused: unknown = null;
      try { await ai.assertQuota("script_draft", A.enrollmentId, null, { offline: true }); } catch (e) { offlineRefused = e; }
      c.ok("an offline run at that client is held to the program-wide caps only (not refused)", offlineRefused === null, String(offlineRefused));
      c.ok("runAiJson passes the offline flag from requestedBy and the scope", /assertQuota\(opts\.kind, opts\.enrollmentId \?\? null, claimed\?\.id \?\? null, \{ offline: isOfflineRun\(opts\.requestedBy, opts\.scope \?\? null\) \}\)/.test(read("src/lib/aiRuns.ts")));

      // The sweep: client A is at its cap, client B is not. A's check comes first.
      const B = await buildContentMonth(db, { name: "Sweep Neighbour TEST", package: "Accelerator" });
      const { pendingJudge } = await import("@/lib/scriptJudgeRecord");
      const pending = JSON.stringify({ judge: pendingJudge() });
      const scripts = await import("@/lib/contentScripts");
      const pts = [{ role: "re-hook" as const, text: "Buyers decide in two days." }, { role: "build-up" as const, text: "Price it right and they compete." }, { role: "payoff" as const, text: "That is how you win the weekend." }];
      const make = async (F: typeof A) => {
        const v = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[0] ?? null, source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title: "Sweep topic", hook: "The first weekend sets your price.", points: pts, close: "Call me before you list.", captionCta: null } });
        await prisma.contentScriptVersion.update({ where: { id: v.versionId }, data: { validationJson: pending } });
        return v;
      };
      if (!A.topicIds.length) { const t = await prisma.contentTopic.create({ data: { enrollmentId: A.enrollmentId, clientId: A.clientId, title: "Sweep topic A", status: "SELECTED", monthId: A.monthId } }); A.topicIds.push(t.id); }
      if (!B.topicIds.length) { const t = await prisma.contentTopic.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, title: "Sweep topic B", status: "SELECTED", monthId: B.monthId } }); B.topicIds.push(t.id); }
      const vA = await make(A);
      await new Promise((r) => setTimeout(r, 20));
      const vB = await make(B);
      const judge = await import("@/lib/scriptJudge");
      const sweep = await judge.sweepScriptChecks({ max: 4, budgetMs: 60_000, minStartMs: 0 });
      const { readJudge } = await import("@/lib/scriptJudgeRecord");
      const jA = readJudge((await prisma.contentScriptVersion.findUnique({ where: { id: vA.versionId } }))?.validationJson);
      const jB = readJudge((await prisma.contentScriptVersion.findUnique({ where: { id: vB.versionId } }))?.validationJson);
      c.ok("the capped client is skipped and named, its check left owed for tomorrow", sweep.clientsAtCap.includes(A.enrollmentId) && jA?.state === "pending", JSON.stringify({ sweep, a: jA?.state }));
      c.ok("…and the sweep carried on: the next client's check ran", jB?.state !== "pending" && sweep.checked >= 1, `${jB?.state} ${JSON.stringify(sweep)}`);
    }

    // =======================================================================
    c.head("H3 · billing terms and fee dollars are the owner's");
    // =======================================================================
    {
      const W = await import("@/app/content/[id]/workspaceData");
      const F = await buildContentMonth(db, { name: "Money Client TEST", package: "Accelerator", topics: [{ title: "Money topic", selection: "SELECTED" }] });
      const at = new Date();
      for (const [field, from, to] of [["billingType", "\"TRIAL\"", "null"], ["billingRate", "997", "1497"], ["billingMonths", "1", "6"], ["package", "\"Starter\"", "\"Accelerator\""]] as const) {
        await prisma.programEnrollmentChange.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, field, fromValue: from, toValue: to, effectiveAt: at, appliedAt: at, source: "manual", changedBy: STAFF_EMAIL } });
      }
      const ownerView = await W.loadSettingsTab(F.enrollmentId, true);
      const officeView = await W.loadSettingsTab(F.enrollmentId, false);
      const fields = (v: typeof ownerView) => (v?.history ?? []).map((h) => h.field).sort().join(",");
      c.ok("the owner reads every change, the billing terms included", fields(ownerView) === "billingMonths,billingRate,billingType,package", fields(ownerView));
      c.ok("anyone else reads the package change and no billing term", fields(officeView) === "package", fields(officeView));
      c.ok("the pure filter: billing* fields go, any other field stays", W.moneyFreeHistory([{ field: "billingRate" }, { field: "billingSomethingNew" }, { field: "overrides" }], false).map((r) => r.field).join(",") === "overrides");
      c.ok("the Settings tab passes the owner rule (canPreviewPortal is OWNER only, the money rule)", /loadSettingsTab\(ctx\.id, ctx\.ownerEyes\)/.test(read("src/app/content/[id]/tabs/SettingsTab.tsx")) && /me\.role === "OWNER"/.test(read("src/lib/contentNav.ts")));

      // A revision round with a fee: the owner reads the dollars; Kyle reads "a fee may apply".
      const video = await prisma.contentVideo.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, monthKey: F.monthKey, kind: "PROGRAM", title: "Fee video", status: "CLIENT_REVIEW", projectId: F.projectId } });
      const win = await prisma.contentReviewWindow.create({ data: { submissionId: "sub-fee-1", videoKey: `${F.projectId}:1`, projectId: F.projectId!, enrollmentId: F.enrollmentId, clientId: F.clientId, round: 2, openedAt: at, deadlineAt: new Date(at.getTime() + 4 * 864e5), videoId: video.id } });
      await prisma.contentRevisionRound.create({ data: { videoKey: `${F.projectId}:1`, projectId: F.projectId!, enrollmentId: F.enrollmentId, clientId: F.clientId, submissionId: "sub-fee-1", windowId: win.id, decisionId: "decision-fee-1", ordinal: 3, includedRounds: 2, included: false, feeCents: 7500, feeDecision: "PENDING", videoId: video.id } });
      await establishSession(owner.id);
      const asOwner = await W.loadContentTab(F.enrollmentId, F.clientId);
      const rOwner = asOwner.rows.find((r) => r.id === video.id)?.revisionRounds?.[0];
      await establishSession(kyle.id);
      const asKyle = await W.loadContentTab(F.enrollmentId, F.clientId);
      const rowKyle = asKyle.rows.find((r) => r.id === video.id);
      const rKyle = rowKyle?.revisionRounds?.[0];
      c.ok("the owner reads the fee in dollars", rOwner?.feeCents === 7500, JSON.stringify(rOwner));
      c.ok("Kyle reads no dollars, only that a fee applies, and keeps the charge or waive controls", rKyle?.feeCents === null && rKyle?.feeApplies === true && rowKyle?.moneyEyes === true, JSON.stringify(rKyle));
      c.ok("the panel prints \"a fee may apply\" when the amount is hidden", /r\.feeApplies \? " · a fee may apply"/.test(read("src/components/content/ContentLibraryPanel.tsx")));
      await establishSession(owner.id);
    }

    // =======================================================================
    c.head("H4 · Joe Sutow's October: the upload's picks count, the call's go back to the bank");
    // =======================================================================
    {
      const J = await buildContentMonth(db, { name: "Joe Shape TEST", package: "Accelerator", topics: [1, 2, 3, 4].map((i) => ({ title: `Call topic ${i}`, selection: "SELECTED" as const })) });
      const scripts = await import("@/lib/contentScripts");
      const pts = [{ role: "re-hook" as const, text: "Buyers decide in two days." }, { role: "build-up" as const, text: "Price it right and they compete." }, { role: "payoff" as const, text: "That is how you win the weekend." }];
      const parts = (title: string) => ({ title, hook: `${title}: the first weekend sets your price.`, points: pts, close: "Call me before you list.", captionCta: null });
      // The hub's drafts for the call's four (system drafts in review): the topics read SCRIPTED.
      for (const [i, id] of J.topicIds.entries()) await scripts.createScriptVersion({ enrollmentId: J.enrollmentId, monthId: J.monthId, topicId: id, source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: parts(`Call draft ${i + 1}`) });
      // The drafting sweep marks a drafted topic SCRIPTED (contentDrafting); the drill writes that state as production holds it.
      await prisma.contentTopic.updateMany({ where: { id: { in: J.topicIds } }, data: { status: "SCRIPTED" } });
      c.ok("setup: the call's four topics are SCRIPTED on October with live picks", (await prisma.contentTopic.count({ where: { id: { in: J.topicIds }, status: "SCRIPTED", monthId: J.monthId } })) === 4);
      // Jordan's four uploaded scripts: picked while the call's four are still on the month.
      const actor = { kind: "STAFF" as const, staffUserId: STAFF_EMAIL };
      const up: string[] = [];
      const upScripts: string[] = [];
      for (let i = 1; i <= 4; i++) {
        const t = await prisma.contentTopic.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, title: `Uploaded topic ${i}`, status: "IDEA", approvalState: "APPROVED", source: "staff" } });
        const r = await ct.selectTopicForMonth(t.id, J.monthId, { source: "staff", actor, status: "SELECTED" });
        await prisma.contentTopicSelection.update({ where: { topicId_monthId: { topicId: t.id, monthId: J.monthId } }, data: { rank: i } });
        const s = await prisma.contentScript.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: J.monthId, topicId: t.id, title: `Uploaded ${i}`, body: "b", status: "INTERNAL_REVIEW", source: "manual" } });
        await prisma.contentTopic.update({ where: { id: t.id }, data: { status: "SCRIPTED" } });
        up.push(t.id); upScripts.push(s.id);
        if (i === 1) c.ok("setup: a pick made while four are live is stored as an extra", r.overflow === true);
      }
      const sels = await prisma.contentTopicSelection.findMany({ where: { monthId: J.monthId, topicId: { in: up } }, select: { id: true, topicId: true, overflow: true } });
      c.ok("setup: all four uploaded picks are stored as extras", sels.every((s) => s.overflow));
      // Filmed: the upload portal made the videos EXTRA (two by the flag, one a person mapped).
      const selOf = (tid: string) => sels.find((s) => s.topicId === tid)!.id;
      const v1 = await prisma.contentVideo.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: J.monthId, monthKey: J.monthKey, kind: "EXTRA", countsTowardAllowance: false, title: "Uploaded 1", topicId: up[0], selectionId: selOf(up[0]), status: "FILMED", source: "upload_portal" } });
      const v2 = await prisma.contentVideo.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: J.monthId, monthKey: J.monthKey, kind: "EXTRA", countsTowardAllowance: false, title: "Uploaded 2", topicId: up[1], selectionId: selOf(up[1]), status: "APPROVED", source: "upload_portal" } });
      const v3 = await prisma.contentVideo.create({ data: { enrollmentId: J.enrollmentId, clientId: J.clientId, monthId: J.monthId, monthKey: J.monthKey, kind: "EXTRA", countsTowardAllowance: false, title: "Uploaded 3", topicId: up[2], selectionId: selOf(up[2]), status: "FILMED", source: "upload_portal", mappedBy: "kyle@audit-oct22.test" } });
      // The upload on file (made before the step-aside existed), then the step-aside Jordan ran on Oct 13.
      const { UPLOAD_KIND, stepAsideForUpload } = await import("@/lib/scriptUpload");
      const ledger = { monthId: J.monthId, monthKey: J.monthKey, by: STAFF_EMAIL, byName: "Jordan", at: new Date().toISOString(), scriptIds: upScripts, createdTopicIds: up, matched: [], replaced: [], route: { chosen: false, before: null, at: null }, parser: "house", aiRunId: null, owed: 4 };
      const batch = await prisma.contentImportBatch.create({ data: { kind: UPLOAD_KIND, contentHash: "joe-shape-drill", mode: "APPLIED", enrollmentId: J.enrollmentId, clientId: J.clientId, previewJson: JSON.stringify(ledger) } });
      const res = await stepAsideForUpload(batch.id, { email: STAFF_EMAIL, appUserId: owner.id, name: "Jordan" });
      c.ok("the step-aside withdrew the hub's four drafts", res.removed === 4 && (await prisma.contentScript.count({ where: { topicId: { in: J.topicIds } } })) === 0, String(res.removed));
      const callTopics = await prisma.contentTopic.findMany({ where: { id: { in: J.topicIds } }, select: { status: true, monthId: true } });
      c.ok("the call's four topics are back in the bank (SAVED, no month), not left SCRIPTED on October", callTopics.every((t) => t.status === "SAVED" && t.monthId === null), JSON.stringify(callTopics));
      const after = await prisma.contentTopicSelection.findMany({ where: { monthId: J.monthId, topicId: { in: up } }, select: { overflow: true } });
      c.ok("the four uploaded picks are no longer extras", after.length === 4 && after.every((s) => !s.overflow), JSON.stringify(after));
      const vids = await prisma.contentVideo.findMany({ where: { id: { in: [v1.id, v2.id, v3.id] } }, select: { id: true, kind: true, countsTowardAllowance: true } });
      const vk = (id: string) => vids.find((v) => v.id === id)!;
      c.ok("the videos the upload portal made extras by the flag are program videos that count", vk(v1.id).kind === "PROGRAM" && vk(v1.id).countsTowardAllowance && vk(v2.id).kind === "PROGRAM" && vk(v2.id).countsTowardAllowance);
      c.ok("…a video a person mapped is left as the person mapped it", vk(v3.id).kind === "EXTRA" && !vk(v3.id).countsTowardAllowance);
      c.ok("…and each change is on the video's history", (await prisma.contentVideoCorrection.count({ where: { videoId: { in: [v1.id, v2.id] }, field: "kind", toValue: "PROGRAM" } })) === 2);
      const { programCountsByMonth } = await import("@/lib/contentVideos");
      c.ok("the month's program count includes them", ((await programCountsByMonth(J.enrollmentId, [J.monthKey])).get(J.monthKey)?.total ?? 0) >= 2);

      // Removing a pick frees a slot for the next extra (deselectTopic).
      const K = await buildContentMonth(db, { name: "Slot Freed TEST", package: "Starter", topics: [{ title: "First pick", selection: "SELECTED" }, { title: "Second pick", selection: "SELECTED" }] });
      const extra = await prisma.contentTopic.create({ data: { enrollmentId: K.enrollmentId, clientId: K.clientId, title: "Third pick", status: "IDEA", approvalState: "APPROVED", source: "staff" } });
      const r3 = await ct.selectTopicForMonth(extra.id, K.monthId, { source: "staff", actor, status: "SELECTED" });
      c.ok("a third pick on a two-video month is an extra", r3.overflow === true);
      await ct.deselectTopic(K.topicIds[0], K.monthId, actor);
      c.ok("removing a pick takes the extra into the allowance (the flag is re-derived)", !(await prisma.contentTopicSelection.findUniqueOrThrow({ where: { topicId_monthId: { topicId: extra.id, monthId: K.monthId } } })).overflow);
      const recheck = await ct.reconcileMonthExtras(K.monthId);
      c.ok("a second pass changes nothing (idempotent)", recheck.cleared.length === 0 && recheck.marked.length === 0 && recheck.videos.length === 0);
      c.ok("the Joe repair script uses the app's own functions and is a dry run by default", /deselectTopic\(id, MONTH/.test(read("scripts/_live/oct22-audit-joe-october.ts")) && /reconcileMonthExtras\(MONTH/.test(read("scripts/_live/oct22-audit-joe-october.ts")) && /if \(!APPLY\) process\.exit\(0\)/.test(read("scripts/_live/oct22-audit-joe-october.ts")));
    }

    // =======================================================================
    c.head("M1 · answers only when there are questions; otherwise pick topics");
    // =======================================================================
    {
      const R = await import("@/lib/programReminders");
      const ask = R.answersOrPickAsk;
      c.ok("picked topics owe answers → COMPLETE_ANSWERS", ask({ route: "WRITTEN", chosen: 2, videosOwed: 2, answersOwed: 2, chosenBy: "staff:x" }).action === "COMPLETE_ANSWERS");
      const pick = ask({ route: "WRITTEN", chosen: 0, videosOwed: 2, answersOwed: 0, chosenBy: "staff:x" });
      c.ok("written route, nothing picked → PICK_TOPICS (2 to pick), the client's turn", pick.action === "PICK_TOPICS" && pick.toPick === 2);
      c.ok("an office-planned month → ours, nothing asked of the client", ask({ route: "WRITTEN", chosen: 0, videosOwed: 2, answersOwed: 0, chosenBy: "office:info@x" }).suppression === "topics_ours");
      c.ok("the call route → ours (the call picks the topics)", ask({ route: "CALL", chosen: 0, videosOwed: 2, answersOwed: 0, chosenBy: null }).action === null);
      c.ok("all picked and answered → nothing to answer", ask({ route: "WRITTEN", chosen: 2, videosOwed: 2, answersOwed: 0, chosenBy: null }).suppression === "nothing_to_answer");
      // Audit, Oct 23 2026: a topic an open question request chases is not asked a second time by the month's email.
      const qrOnly = ask({ route: "WRITTEN", chosen: 2, videosOwed: 2, answersOwed: 1, chosenBy: "staff:x", askedByRequest: 1 });
      c.ok("audit: the only owed topic is a question request's → no month email (the request follows up on its own)", qrOnly.action === null && qrOnly.suppression === "question_request_open", JSON.stringify(qrOnly));
      const qrAndOne = ask({ route: "WRITTEN", chosen: 3, videosOwed: 3, answersOwed: 2, chosenBy: "staff:x", askedByRequest: 1 });
      c.ok("audit: another topic still owes answers → COMPLETE_ANSWERS for that one only", qrAndOne.action === "COMPLETE_ANSWERS" && /^1 picked topic/.test(qrAndOne.why), JSON.stringify(qrAndOne));
      c.ok("audit: a request's topic and topics still to pick (written route) → PICK_TOPICS as before", ask({ route: "WRITTEN", chosen: 1, videosOwed: 3, answersOwed: 1, chosenBy: "staff:x", askedByRequest: 1 }).action === "PICK_TOPICS");
      c.ok("audit: a count above what is owed never goes negative", ask({ route: "WRITTEN", chosen: 2, videosOwed: 2, answersOwed: 1, chosenBy: null, askedByRequest: 5 }).action === null);
      const { reminderTemplate, renderReminder, DEFAULT_TEMPLATE_IDS } = await import("@/lib/reminderTemplates");
      const body = renderReminder(reminderTemplate(DEFAULT_TEMPLATE_IDS.PICK_TOPICS), { firstName: "Arielle", month: "October", portalLink: "https://hub.example.test/portal", bookCallLink: null, noCallEligible: true, answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 2, titles: [], updatedTitles: [], deadline: null });
      c.ok("the PICK_TOPICS email asks for topics, not answers, with no em dash", /choosing your video topics/.test(body) && /pick 2 that suit you/.test(body) && !/questions are part-way/.test(body) && noDash(body), body);

      // Arielle's shape, through the evaluator itself.
      const Z = await buildContentMonth(db, { name: "Arielle Shape TEST", package: "Starter", project: false, topics: [{ title: "Bank idea one", selection: null, topicStatus: "SAVED" }, { title: "Bank idea two", selection: null, topicStatus: "SAVED" }] });
      await prisma.contentEnrollment.update({ where: { id: Z.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN", noCallEligible: true, strategyCallRequired: false } });
      await prisma.contentMonth.update({ where: { id: Z.monthId }, data: { planningMode: "WRITTEN", strategyCallStatus: "SKIPPED", planningChosenAt: new Date(), planningChosenBy: `staff:${owner.id}` } });
      const prim = async (monthId: string) => (await R.previewReminders(monthId, { now: EVAL_NOW })).lanes.find((l) => l.lane === "PRIMARY")?.candidate;
      const z0 = await prim(Z.monthId);
      c.ok("a written month with 0 topics is asked PICK_TOPICS, never COMPLETE_ANSWERS", z0?.action === "PICK_TOPICS" && z0.state.topicsToPick === 2, `${z0?.action} ${z0?.reason}`);
      for (const id of Z.topicIds) await ct.selectTopicForMonth(id, Z.monthId, { source: "client", actor: { kind: "CLIENT", clientUserId: Z.clientUserId }, status: "SELECTED" });
      const z1 = await prim(Z.monthId);
      c.ok("once two topics are picked and their questions are open → COMPLETE_ANSWERS", z1?.action === "COMPLETE_ANSWERS" && (z1.state.answersOwed ?? 0) === 2, `${z1?.action} ${z1?.reason}`);
      await prisma.contentMonth.update({ where: { id: Z.monthId }, data: { planningChosenBy: "office:info@x" } });
      for (const id of Z.topicIds) await ct.deselectTopic(id, Z.monthId, { kind: "STAFF", staffUserId: STAFF_EMAIL });
      const z2 = await prim(Z.monthId);
      c.ok("an office-planned month with nothing picked asks the client nothing", z2?.action === null && z2.suppressionReason === "topics_ours", `${z2?.action} ${z2?.suppressionReason} ${z2?.reason}`);
      await prisma.contentMonth.update({ where: { id: Z.monthId }, data: { planningChosenBy: `staff:${owner.id}` } });
      // Arielle was sent the answers ask four times (one of them the 15th's): the pick ask is not started over.
      const sent = (n: number, tag: string, daysAgo: number) => prisma.programReminder.create({ data: {
        enrollmentId: Z.enrollmentId, clientId: Z.clientId, monthId: Z.monthId, monthKey: Z.monthKey, action: "COMPLETE_ANSWERS", templateKey: "reminder.complete_answers.v1", channel: "email",
        attempt: n, state: "SENT", sentAt: new Date(EVAL_NOW.getTime() - daysAgo * 864e5), dedupeKey: `${Z.enrollmentId}:${Z.monthKey}:COMPLETE_ANSWERS:${tag}${n}`,
      } });
      // The last one six days back (Fri Oct 16), so the 72 weekday hours since it have passed and the cap is what answers.
      await sent(1, "", 12); await sent(2, "mid:", 7); await sent(3, "", 9); await sent(4, "", 6);
      const z3 = await prim(Z.monthId);
      c.ok("PICK_TOPICS shares the answers ask's cadence: after three sends it stops and hands over (no fourth email)", z3?.action === "PICK_TOPICS" && /3 of 3 reminders already sent/.test(z3.reason) && z3.decision !== "send", `${z3?.decision} attempt=${z3?.attempt} ${z3?.reason}`);
    }

    // =======================================================================
    c.head("M2 · stale escalation, answer-gap and discovery tasks close with a note");
    // =======================================================================
    {
      const T = await import("@/lib/programTaskCloser");
      const zClient = await prisma.client.findFirstOrThrow({ where: { name: "Arielle Shape TEST" }, select: { id: true } });
      const Z = await prisma.contentMonth.findFirstOrThrow({ where: { clientId: zClient.id }, select: { id: true, clientId: true } });
      const task = (dedupeKey: string, clientId: string | null, title: string) => prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title, description: "Original description.", dedupeKey, clientId } });
      const escAnswers = await task(`program-reminder-escalation:${Z.id}:COMPLETE_ANSWERS`, Z.clientId, "Arielle: still needs the written preparation answers");
      const escPick = await task(`program-reminder-escalation:${Z.id}:PICK_TOPICS`, Z.clientId, "Arielle: still needs topics picked");
      const escBook = await task(`program-reminder-escalation:${Z.id}:BOOK_CALL`, Z.clientId, "Arielle: still needs a strategy call booking");
      // Answer gaps: one with an approved script (Marcee), one still owed.
      const G = await buildContentMonth(db, { name: "Gap Client TEST", package: "Starter", topics: [{ title: "Malvern underrated", selection: "SELECTED" }, { title: "Still open topic", selection: "SELECTED" }] });
      const iv1 = await prisma.contentInterview.create({ data: { topicId: G.topicIds[0], enrollmentId: G.enrollmentId, clientId: G.clientId, monthId: G.monthId, status: "SUBMITTED_WITH_GAPS" } });
      const iv2 = await prisma.contentInterview.create({ data: { topicId: G.topicIds[1], enrollmentId: G.enrollmentId, clientId: G.clientId, monthId: G.monthId, status: "SUBMITTED_WITH_GAPS" } });
      await prisma.contentScript.create({ data: { enrollmentId: G.enrollmentId, clientId: G.clientId, monthId: G.monthId, topicId: G.topicIds[0], title: "Malvern", body: "b", status: "APPROVED", source: "ai", approvedVersionId: "approved-v", approvedAt: new Date() } });
      const gap1 = await task(`program-answer-gaps:${iv1.id}`, G.clientId, "Follow up on their answers: Malvern");
      const gap2 = await task(`program-answer-gaps:${iv2.id}`, G.clientId, "Follow up on their answers: still open");
      // Discovery: Joe (strategy approved, no Calendly booking) and a brand-new signup.
      const D1 = await buildContentMonth(db, { name: "Discovery Done TEST", package: "Starter", project: false });
      const D2 = await buildContentMonth(db, { name: "Discovery Owed TEST", package: "Starter", project: false, strategy: false });
      const disc1 = await task(`program-discovery-booking:${D1.enrollmentId}`, D1.clientId, "Book the brand discovery call: Joe");
      const disc2 = await task(`program-discovery-booking:${D2.enrollmentId}`, D2.clientId, "Book the brand discovery call: new signup");
      const closedByPerson = await prisma.smartTask.create({ data: { taskType: "todo", status: "COMPLETED", completedAt: new Date(), source: "content_program", title: "closed by a person", dedupeKey: `program-reminder-escalation:${Z.id}:CHOOSE_PATH`, clientId: Z.clientId } });

      const dry = await T.closeResolvedProgramTasks({ dryRun: true, now: EVAL_NOW });
      const verdict = (id: string) => dry.verdicts.find((v) => v.taskId === id);
      c.ok("dry run: verdicts for every open one, nothing written", dry.closed === 0 && (await prisma.smartTask.count({ where: { id: { in: [escAnswers.id, gap1.id, disc1.id] }, status: "OPEN" } })) === 3);
      c.ok("the answers escalation no longer holds: the month's next step is picking topics", verdict(escAnswers.id)?.holds === false && /topics picked in the portal/.test(verdict(escAnswers.id)?.evidence ?? ""), verdict(escAnswers.id)?.evidence);
      c.ok("the pick-topics escalation still holds", verdict(escPick.id)?.holds === true, verdict(escPick.id)?.evidence);
      c.ok("a strategy call escalation on a written month no longer holds", verdict(escBook.id)?.holds === false, verdict(escBook.id)?.evidence);
      c.ok("an answer gap whose script is approved no longer holds; one still owed does", verdict(gap1.id)?.holds === false && /approved/.test(verdict(gap1.id)?.evidence ?? "") && verdict(gap2.id)?.holds === true, `${verdict(gap1.id)?.evidence} | ${verdict(gap2.id)?.evidence}`);
      c.ok("a discovery task for a client whose strategy is approved no longer holds; a new signup's does", verdict(disc1.id)?.holds === false && /approved/.test(verdict(disc1.id)?.evidence ?? "") && verdict(disc2.id)?.holds === true, `${verdict(disc1.id)?.evidence} | ${verdict(disc2.id)?.evidence}`);
      const run = await T.closeResolvedProgramTasks({ now: EVAL_NOW });
      const rows = await prisma.smartTask.findMany({ where: { id: { in: [escAnswers.id, escPick.id, escBook.id, gap1.id, gap2.id, disc1.id, disc2.id, closedByPerson.id] } } });
      const row = (id: string) => rows.find((r) => r.id === id)!;
      c.ok("the pass closes exactly the four that no longer hold", [escAnswers, escBook, gap1, disc1].every((t) => row(t.id).status === "COMPLETED" && !!row(t.id).completedAt) && [escPick, gap2, disc2].every((t) => row(t.id).status === "OPEN"), `closed ${run.closed}: ${rows.map((r) => `${r.title}=${r.status}`).join("; ")}`);
      c.ok("each closed task carries a plain note after its own text, no em dash", /^Original description\.\n\nClosed by the hub on [A-Z][a-z]{2} \d{1,2}: /.test(row(escAnswers.id).description ?? "") && noDash((row(escAnswers.id).description ?? "").split("\n\n")[1] ?? ""), row(escAnswers.id).description ?? "");
      c.ok("a task a person closed is never touched", row(closedByPerson.id).status === "COMPLETED" && !row(closedByPerson.id).description);
      c.ok("the hourly cron runs the pass in the programMonths step", /closeResolvedProgramTasks\(\{ budgetMs: 10_000 \}\)/.test(read("src/app/api/cron/sync/route.ts")));
    }

    // =======================================================================
    c.head("M3 · a Mix account short of skit ideas gets a skit-only refresh");
    // =======================================================================
    {
      const M = await buildContentMonth(db, { name: "Mix Skits TEST", package: "Accelerator", project: false });
      const D = await buildContentMonth(db, { name: "Direct Only TEST", package: "Accelerator", project: false });
      await prisma.contentEnrollment.update({ where: { id: M.enrollmentId }, data: { overridesJson: JSON.stringify({ videoStyle: "MIX", skitsPerMonth: 2 }) } });
      await prisma.contentTopic.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, title: "One skit on file", status: "SAVED", approvalState: "APPROVED", scoresJson: JSON.stringify({ videoFormat: "SKIT" }) } });
      await prisma.contentTopic.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, title: "A scripted skit", status: "SCRIPTED", approvalState: "APPROVED", scoresJson: JSON.stringify({ videoFormat: "SKIT" }) } });
      await prisma.contentTopic.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, title: "A declined skit", status: "SAVED", approvalState: "APPROVED", clientDeclinedAt: new Date(), scoresJson: JSON.stringify({ videoFormat: "SKIT" }) } });
      await prisma.contentTopic.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, title: "A direct idea", status: "SAVED", approvalState: "APPROVED", scoresJson: JSON.stringify({ videoFormat: "DIRECT" }) } });
      c.ok("a Direct account has no skit target", (await ct.skitShortfall(D.enrollmentId)) === null);
      const s = await ct.skitShortfall(M.enrollmentId);
      c.ok("Mix, 2 a month: target 4, 1 unscripted skit idea (scripted and declined ones do not count), 3 short", s?.target === 4 && s.unscripted === 1 && s.need === 3, JSON.stringify(s));
      const { createStrategyVersion, structuredFromText, approveStrategyVersion } = await import("@/lib/contentStrategy");
      const { setOwnerOverride } = await import("@/lib/contentProgram");
      const { renderStrategy } = await import("@/lib/contentPolicy");
      const text = renderStrategy(strategyDoc("Mix Skits TEST") as unknown as Parameters<typeof renderStrategy>[0]);
      const sv = await createStrategyVersion({ enrollmentId: M.enrollmentId, stored: structuredFromText(text).stored, rawText: text, sourceKind: "manual", createdBy: "drill", status: "DRAFT" } as Parameters<typeof createStrategyVersion>[0]);
      await setOwnerOverride("ENROLLMENT", M.enrollmentId, "STRATEGY", owner.id, "drill");
      await approveStrategyVersion(sv.versionId, STAFF_EMAIL);
      await prisma.contentTopicRefreshRun.updateMany({ where: { enrollmentId: M.enrollmentId, status: "QUEUED" }, data: { status: "CANCELLED", dedupeKey: null } });
      const q1 = await ct.queueSkitRefreshIfShort(M.enrollmentId, { requestedBy: "cron" });
      const run = q1.runId ? await prisma.contentTopicRefreshRun.findUnique({ where: { id: q1.runId } }) : null;
      const inputs = JSON.parse(run?.inputsJson ?? "{}") as { skitsOnly?: boolean; keep?: number; pillarId?: string | null };
      c.ok("the shortfall queues one REFRESH run, skits only, keeping 3", q1.queued && run?.kind === "REFRESH" && run.status === "QUEUED" && inputs.skitsOnly === true && inputs.keep === 3 && !inputs.pillarId, JSON.stringify({ q1, inputs }));
      const q2 = await ct.queueSkitRefreshIfShort(M.enrollmentId, { requestedBy: "cron" });
      c.ok("a second check while it waits queues nothing", !q2.queued && /queued, running, or was tried/.test(q2.why), q2.why);
      // Oct 26 2026: the sweep tops up each pillar per format instead (queuePillarRefills); the account-wide skit refresh stays for the old live script.
      c.ok("the bank sweep now refills per pillar and format, not account-wide skits", /queuePillarRefills\(e\.id, \{ requestedBy: "cron", now \}\)/.test(read("src/lib/contentTopics.ts")) && !/queueSkitRefreshIfShort\(e\.id, \{ requestedBy: "cron"/.test(read("src/lib/contentTopics.ts")));
      // The run itself, with the stubbed model: skits only, three kept, the talking-to-camera idea dropped.
      modelCalls.length = 0;
      await prisma.contentTopicRefreshRun.update({ where: { id: q1.runId! }, data: { status: "RUNNING", leaseUntil: new Date(Date.now() + 600_000), leaseBy: "drill" } });
      const gen = await import("@/lib/contentGeneration");
      await gen.executeTopicRefreshRun(q1.runId!, { unattended: false, keep: 3, skitsOnly: true });
      const done = await prisma.contentTopicRefreshRun.findUniqueOrThrow({ where: { id: q1.runId! } });
      const bankCall = modelCalls.find((m) => /Video Topic Bank/.test(m.system));
      c.ok("the prompt asks for skit concepts only, 3 in total, with the format in the schema", !!bankCall && /SKITS ONLY/.test(bankCall.system) && /exactly 3 skit concepts in total/.test(bankCall.system) && !/VIDEO STYLE: MIX/.test(bankCall.system) && /"enum":\["DIRECT","SKIT"\]/.test(JSON.stringify(bankCall.schema)) && noDash(bankCall.system.slice(bankCall.system.indexOf("SKITS ONLY"), bankCall.system.indexOf("SKITS ONLY") + 400)), done.lastError ?? done.changeSummary ?? "");
      const sugg = await prisma.contentTopicSuggestion.findMany({ where: { refreshRunId: q1.runId! } });
      const formats = await ct.suggestionFormats(sugg);
      c.ok("three suggestions, every one a skit (the DIRECT ideas dropped)", done.status === "SUCCEEDED" && sugg.length === 3 && sugg.every((x) => formats.get(x.id) === "SKIT"), `${done.status} ${sugg.length} ${JSON.stringify([...formats.values()])} ${done.changeSummary}`);
      c.ok("the live script queues for Bernadette only on --apply and names its requester", /queueSkitRefreshIfShort\(e\.id, \{ requestedBy: "staff:oct22-audit-m3" \}\)/.test(read("scripts/_live/oct22-audit-bernadette-skits.ts")) && /if \(!APPLY\) process\.exit\(0\)/.test(read("scripts/_live/oct22-audit-bernadette-skits.ts")));
    }

    // =======================================================================
    c.head("M4 · a topic pointing at its August import while picked for October");
    // =======================================================================
    {
      const B = await buildContentMonth(db, { name: "Bernadette Shape TEST", package: "Accelerator", project: false, topics: [1, 2, 3].map((i) => ({ title: `October pick ${i}`, selection: "RECONCILED" as const, topicStatus: "SCRIPTED" })) });
      const aug = await prisma.contentMonth.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthKey: "2026-08", videosOwed: 4, status: "OPEN" } });
      const scum = await prisma.contentTopic.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, title: "Real Estate Agents Are Scumbags", status: "SCRIPTED", monthId: aug.id, source: "strategy_call" } });
      await prisma.contentScript.create({ data: { enrollmentId: B.enrollmentId, clientId: B.clientId, monthId: aug.id, topicId: scum.id, title: "Salesperson vs. Advisor", body: "b", status: "READY_TO_FILM", source: "import", historical: true, releaseState: "historical" } });
      await prisma.contentTopicSelection.create({ data: { topicId: scum.id, monthId: B.monthId, enrollmentId: B.enrollmentId, clientId: B.clientId, status: "RECONCILED", source: "staff" } });
      const live = await prisma.contentTopicSelection.count({ where: { monthId: B.monthId, status: { in: ct.ALLOWANCE_SELECTION_STATUSES } } });
      const pointing = () => prisma.contentTopic.count({ where: { monthId: B.monthId } });
      c.ok("the shape: October has 4 picks but 3 topics point at it", live === 4 && (await pointing()) === 3);
      // The correction the live script makes: the pointer moves; the August import stays.
      await prisma.contentTopic.updateMany({ where: { id: scum.id, monthId: aug.id }, data: { monthId: B.monthId } });
      c.ok("after the correction October counts 4 by either reader, and the August import is still history on August", (await pointing()) === 4 && (await prisma.contentScript.count({ where: { topicId: scum.id, monthId: aug.id, historical: true } })) === 1);
      const src = read("scripts/_live/oct22-audit-bernadette-scumbags.ts");
      c.ok("the live script is a dry run by default, fences the write on the pointer it read, and records it on the topic", /if \(!APPLY\) process\.exit\(0\)/.test(src) && /updateMany\(\{ where: \{ id: TOPIC, monthId: t\.monthId \}/.test(src) && /recordTopicEvent\(TOPIC/.test(src) && !/contentScript\.update|contentScript\.delete/.test(src));
    }

    // =======================================================================
    // M5 — the fork's section: the card and the month page agree.
    // =======================================================================
    {
      const { m5Section } = await import("./_oct22-m5-section");
      await m5Section(c, db);
    }

    // =======================================================================
    c.head("M6 · staff notes on a topic's history stay on the server");
    // =======================================================================
    {
      const portal = await import("@/lib/portal");
      const at = new Date();
      const key = () => "2026-10";
      c.ok("a STAFF event's note is not sent", portal.portalHistoryLine({ kind: "DESELECTED", createdAt: at, note: "The hub's draft stepped aside for the scripts Jordan uploaded", actorKind: "STAFF", monthId: "m" }, key).note === null);
      c.ok("an AI or SYSTEM note is not sent", portal.portalHistoryLine({ kind: "DISCUSSED", createdAt: at, note: "Raised on the call", actorKind: "AI", monthId: null }, key).note === null);
      c.ok("the client's own words are", portal.portalHistoryLine({ kind: "DECLINED", createdAt: at, note: "Not interested: too salesy", actorKind: "CLIENT", monthId: "m" }, key).note === "Not interested: too salesy");
      const P = await buildContentMonth(db, { name: "History Client TEST", package: "Starter", topics: [{ title: "History topic", selection: "SELECTED" }] });
      await ct.recordTopicEvent(P.topicIds[0], P.enrollmentId, "DISCUSSED", { kind: "STAFF", staffUserId: STAFF_EMAIL }, { monthId: P.monthId, note: "STAFF ONLY: she is hard to pin down, push the call" });
      const data = await portal.portalTopics({ id: P.enrollmentId, clientId: P.clientId });
      const t = data.groups.flatMap((g) => g.topics).find((x) => x.id === P.topicIds[0]);
      const sent = JSON.stringify(data);
      c.ok("end to end: the portal's topic data holds the event but not the staff note", !!t && t.history.length > 0 && t.history.every((h) => h.note === null) && !sent.includes("STAFF ONLY"), JSON.stringify(t?.history));
    }

    // =======================================================================
    c.head("LOW · stale publication failures, ended programs, portal drafts");
    // =======================================================================
    {
      const cv = await import("@/lib/contentVideos");
      const L = await buildContentMonth(db, { name: "Library Client TEST", package: "Starter" });
      const video = await prisma.contentVideo.create({ data: { enrollmentId: L.enrollmentId, clientId: L.clientId, monthId: L.monthId, monthKey: L.monthKey, kind: "PROGRAM", title: "On the library", status: "DELIVERED", projectId: L.projectId } });
      const inLib = await prisma.reviewSubmission.create({ data: { projectId: L.projectId!, status: "APPROVED", videoId: video.id, fileName: "on-library.mov" } });
      await prisma.contentVideoSource.create({ data: { videoId: video.id, kind: "REVIEW_CUT", ref: inLib.id, submissionId: inLib.id } });
      const missing = await prisma.reviewSubmission.create({ data: { projectId: L.projectId!, status: "APPROVED", fileName: "not-yet.mov" } });
      const why = JSON.stringify({ at: new Date().toISOString(), why: "Confirm an eligible owner seat and rollout access for this exact program before recording portal delivery." });
      await prisma.appSetting.createMany({ data: [{ key: cv.publicationFailureKey(inLib.id), value: why }, { key: cv.publicationFailureKey(missing.id), value: why }] });
      const dry = await cv.clearStalePublicationFailures({ dryRun: true });
      c.ok("dry run: the cut on the library is stale, the missing one is not, nothing deleted", dry.find((r) => r.submissionId === inLib.id)?.inLibrary === true && dry.find((r) => r.submissionId === missing.id)?.inLibrary === false && (await prisma.appSetting.count({ where: { key: { startsWith: "portal-publication-failure:" } } })) === 2);
      await cv.clearStalePublicationFailures();
      c.ok("the stale record is cleared, the open one kept", !(await prisma.appSetting.findUnique({ where: { key: cv.publicationFailureKey(inLib.id) } })) && !!(await prisma.appSetting.findUnique({ where: { key: cv.publicationFailureKey(missing.id) } })));
      c.ok("the hourly library repair clears them from now on", /await clearStalePublicationFailures\(\)\.catch/.test(read("src/lib/contentVideos.ts")));

      const lib = await import("@/lib/portalLibrary");
      const E = await buildContentMonth(db, { name: "Sarina Ended TEST", package: "Starter", enrollmentStatus: "ENDED" });
      const rec = { monthId: E.monthId, monthKey: E.monthKey, enrollmentId: E.enrollmentId, clientId: E.clientId, clientName: "Sarina Ended TEST", due: 2, inLibrary: 0, short: 2, missing: ["x"], firstSeenAt: new Date().toISOString(), checkedAt: new Date().toISOString(), resolvedAt: null };
      await prisma.appSetting.create({ data: { key: `${lib.LIBRARY_SHORT_PREFIX}${E.monthId}`, value: JSON.stringify(rec) } });
      await lib.checkLibraryCompleteness({ now: new Date() });
      const after = JSON.parse((await prisma.appSetting.findUniqueOrThrow({ where: { key: `${lib.LIBRARY_SHORT_PREFIX}${E.monthId}` } })).value) as { resolvedAt: string | null; checkedAt: string };
      c.ok("an ended program's open library-short record is closed, and it is not checked again", !!after.resolvedAt);
      const open = await lib.openLibraryShortRecords();
      c.ok("…so it is off the exceptions board", !open.some((r) => r.enrollmentId === E.enrollmentId));

      const draft = await import("@/components/portal/portalDraft");
      const store = new Map<string, string>();
      const g = globalThis as unknown as { window?: unknown };
      const had = g.window;
      g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } };
      draft.writeDraft(draft.scriptChangeDraftKey("s1"), "make the hook about first-time buyers");
      draft.writeDraft(draft.scriptReplyDraftKey("s1"), "thanks!");
      c.ok("each box has its own key; a draft is kept and read back", draft.readDraft(draft.scriptChangeDraftKey("s1")) === "make the hook about first-time buyers" && draft.readDraft(draft.scriptReplyDraftKey("s1")) === "thanks!" && draft.scriptChangeDraftKey("s1") !== draft.scriptReplyDraftKey("s1"));
      draft.writeDraft(draft.scriptReplyDraftKey("s1"), "  ");
      c.ok("an emptied box clears its draft", !store.has(draft.scriptReplyDraftKey("s1")));
      c.ok("the Messages key is per portal and per client viewed", draft.messageDraftKey({ pathname: "/portal/abc", search: "" }) !== draft.messageDraftKey({ pathname: "/portal", search: "?e=enr1&tab=messages" }) && draft.messageDraftKey({ pathname: "/portal", search: "?e=enr1&tab=messages" }) === "rtp_portal_message:/portal?e=enr1");
      g.window = { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } } };
      c.ok("blocked storage never throws (no autosave, the box still works)", draft.readDraft("k") === "" && (() => { draft.writeDraft("k", "x"); return true; })());
      g.window = had;
      const sac = read("src/components/portal/ScriptApprovalCard.tsx"), st = read("src/components/portal/ScriptThread.tsx"), mc = read("src/components/portal/MessageComposer.tsx");
      c.ok("the change note, the reply under a script and the Messages box keep their words on the device", /useDraft\(scriptChangeDraftKey\(script\.id\)\)/.test(sac) && /useDraft\(scriptReplyDraftKey\(scriptId\)\)/.test(st) && /useDraft\(draftKey, initialBody\)/.test(mc) && [sac, st, mc].every((s) => /DRAFT_COPY\.restored/.test(s)));
      c.ok("the kept-draft line has no em dash", noDash(draft.DRAFT_COPY.restored));
    }

    c.ok("no call left the drill", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    // Best-effort writes the app starts without waiting (bells, run records)
    // finish, and the pool's sockets close while the database is still open
    // (PGlite's socket server reads the session on each close).
    await new Promise((r) => setTimeout(r, 1500));
    await prisma.$disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    quiet.restore();
    await stop();
  }
  c.summary();
}

main().catch((e) => { console.error(e); process.exit(1); });
