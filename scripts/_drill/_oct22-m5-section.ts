// ---------------------------------------------------------------------------
// DRILL SECTION (helper, not run on its own): AUDIT M5, OCT 22 2026. The
// Dashboard's Monthly content card and the month page must say the same
// thing, and the month page (monthProgress, programOverview, the Scripts
// tab) is the source of truth.
//
//   a. Ashley Brunner's shape: four topics chosen, the route not chosen. The
//      month page says the ball is with the client; the card used to say
//      "Needs 4 scripts". A held call's topics (our side) still count.
//   b. Bernadette Rabel's shape: three scripts in review and one draft. The
//      card and the month page print the same words for the same counts.
//   c. Rick Schultz's shape: a bulk plan's released scripts are the client's
//      own bank, never "awaiting the client" (a monthly client's still are).
//   d. A finished month (every video owed delivered) is off the card; the
//      client's waiting message moves to their next row.
//
// Call it from a drill that has booted the drill database:
//   const { m5Section } = await import("./_oct22-m5-section");
//   await m5Section(c, prisma as unknown as PrismaClient);
// It seeds its own TEST clients and reads only them.
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import { buildContentMonth } from "./_fixtures/contentMonth";

type Checker = { ok: (label: string, cond: boolean, detail?: string) => boolean; head: (title: string) => void };

const monthBefore = (key: string) => {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

export async function m5Section(c: Checker, prisma: PrismaClient): Promise<void> {
  const { monthlyContentActions, NOT_OURS_YET } = await import("@/lib/contentActions");
  const { monthProgress, staffMonthView, scriptsAwaitingWords } = await import("@/lib/monthProgress");
  const { programOverview } = await import("@/lib/programOverview");
  const { scriptWorkForMonth } = await import("@/lib/contentDrafting");
  const { etMonthKey } = await import("@/lib/contentProgram");
  const scripts = await import("@/lib/contentScripts");
  const { loadScriptsTab } = await import("@/app/content/[id]/programData");
  const thisMonth = etMonthKey();
  const pts = [{ role: "re-hook" as const, text: "Buyers decide in two days." }, { role: "build-up" as const, text: "Price it right and they compete." }, { role: "payoff" as const, text: "That is how you win the weekend." }];
  const parts = (title: string) => ({ title, hook: `${title}: the first weekend sets your price.`, points: pts, close: "Call me before you list.", captionCta: null });
  const draft = (F: { enrollmentId: string; monthId: string; topicIds: string[] }, i: number, status: "DRAFT" | "INTERNAL_REVIEW", title: string) =>
    scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[i], source: "AI", status, createdBy: "ai", parts: parts(title) });
  /** Released to the portal by hand (the shape a bulk release leaves), no client decision yet. */
  const shared = async (v: { scriptId: string; versionId: string }) => {
    await prisma.contentScriptVersion.update({ where: { id: v.versionId }, data: { status: "SHARED", approvedBy: "drill", approvedAt: new Date(), sharedAt: new Date() } });
    await prisma.contentScript.update({ where: { id: v.scriptId }, data: { status: "CLIENT_VISIBLE", clientVisible: true, approvedVersionId: v.versionId, sharedVersionId: v.versionId, releaseState: "released", approvedAt: new Date(), sharedAt: new Date() } });
  };
  const four = (prefix: string) => [1, 2, 3, 4].map((i) => ({ title: `${prefix} topic ${i}`, selection: "SELECTED" as const }));

  // =========================================================================
  c.head("M5 a · Ashley's shape: topics chosen, route not chosen: no 'Needs N scripts'");
  const A = await buildContentMonth(prisma, { name: "M5 Undecided TEST", package: "Accelerator", videosPerMonth: 4, monthKey: thisMonth, project: false, topics: four("Undecided") });
  await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { callMode: "OPTIONAL_WRITTEN", noCallEligible: true, strategyCallRequired: false } });
  const H = await buildContentMonth(prisma, { name: "M5 Held Call TEST", package: "Accelerator", videosPerMonth: 4, monthKey: thisMonth, project: false, topics: four("Held call") });
  await prisma.contentMonth.update({ where: { id: H.monthId }, data: { planningMode: "CALL", strategyCallStatus: "COMPLETED", strategyCallAt: new Date(Date.now() - 2 * 864e5) } });

  const pa = await monthProgress(A.enrollmentId, A.monthId);
  const workA = await scriptWorkForMonth(A.monthId);
  c.ok("the month page: the route is not chosen, every topic waits on the client to choose it", pa?.planning?.route === "UNDECIDED" && (pa?.planning?.topics ?? []).length === 4 && (pa?.planning?.topics ?? []).every((t) => t.step === "CHOSEN"), JSON.stringify(pa?.planning?.topics.map((t) => t.step)));
  c.ok("…and its next step is the client's", pa?.nextAction?.blocked === "client", JSON.stringify(pa?.nextAction));
  c.ok("the drafting reader still calls all four THIN (the old card counted them)", workA.filter((w) => !w.scriptId && w.readiness === "THIN").length === 4, workA.map((w) => w.readiness).join(","));
  const ph = await monthProgress(H.enrollmentId, H.monthId);
  const oursH = (ph?.planning?.topics ?? []).filter((t) => !NOT_OURS_YET.has(t.step)).length;

  const card = await monthlyContentActions();
  const rowOf = (name: string) => card.rows.filter((r) => r.clientName === name);
  const aRows = rowOf("M5 Undecided TEST");
  c.ok("the card: no 'Needs N scripts' for the client who has not chosen how to plan", !aRows.some((r) => r.items.some((i) => i.key === "write")), JSON.stringify(aRows.map((r) => r.items)));
  const hRow = rowOf("M5 Held Call TEST").find((r) => r.monthKey === thisMonth);
  c.ok("a held call's topics are ours: the card counts exactly the month page's topics on our side", oursH === 4 && !!hRow?.items.some((i) => i.key === "write" && i.words === "Needs 4 scripts"), `${oursH} ours · ${JSON.stringify(hRow?.items)} · steps ${JSON.stringify(ph?.planning?.topics.map((t) => t.step))}`);

  // =========================================================================
  c.head("M5 b · Bernadette's shape: scripts in review plus a draft, one set of words");
  const B = await buildContentMonth(prisma, { name: "M5 Draft Mix TEST", package: "Accelerator", videosPerMonth: 4, monthKey: thisMonth, project: false, topics: four("Mix") });
  await prisma.contentEnrollment.update({ where: { id: B.enrollmentId }, data: { callMode: "NOT_INCLUDED", strategyCallRequired: false } });
  await draft(B, 0, "INTERNAL_REVIEW", "Mix one");
  await draft(B, 1, "INTERNAL_REVIEW", "Mix two");
  await draft(B, 2, "INTERNAL_REVIEW", "Mix three");
  await draft(B, 3, "DRAFT", "Mix four");
  const pb = await monthProgress(B.enrollmentId, B.monthId);
  c.ok("the month page's reader keeps the split: 3 in review, 1 draft", pb?.scripts.needsJordan === 3 && pb?.scripts.drafting === 1, JSON.stringify(pb?.scripts));
  const words = pb ? scriptsAwaitingWords(pb.scripts, "to approve") : null;
  c.ok("the one wording: \"4 scripts to approve, 1 of them a draft\"", words === "4 scripts to approve, 1 of them a draft", String(words));
  c.ok("a draft alone stays \"a script to approve\" (audit D9)", scriptsAwaitingWords({ needsJordan: 0, drafting: 1 }, "to approve") === "1 script to approve" && scriptsAwaitingWords({ needsJordan: 2, drafting: 0 }, "to approve") === "2 scripts to approve" && scriptsAwaitingWords({ needsJordan: 0, drafting: 0 }, "to approve") === null);
  const card2 = await monthlyContentActions();
  const bRow = card2.rows.find((r) => r.clientName === "M5 Draft Mix TEST" && r.monthKey === thisMonth);
  const approve = bRow?.items.find((i) => i.key === "approve");
  c.ok("the card prints the month page's counts in the same words", approve?.words === words, JSON.stringify(bRow?.items));
  c.ok("the month page's next step says the same split", !!pb?.nextAction && pb.nextAction.text === scriptsAwaitingWords(pb.scripts, "waiting on your OK"), pb?.nextAction?.text ?? "null");
  const ovB = await programOverview({ monthKey: thisMonth, enrollmentIds: [B.enrollmentId] });
  const ovText = ovB.rows[0]?.nextAction.text ?? "";
  c.ok("…and so does the month page's Overview row (4 waiting, 1 of them a draft)", ovB.rows[0]?.work.scriptsReviewNeeded === 4 && ovB.rows[0]?.work.scriptsDrafting === 1 && /^4 scripts waiting for .+, 1 of them a draft$/.test(ovText), `${ovText} · ${JSON.stringify(ovB.rows[0]?.work)}`);

  // =========================================================================
  c.head("M5 c · Rick's shape: a bulk plan's released scripts are not awaiting the client");
  const R = await buildContentMonth(prisma, { name: "M5 Bulk Plan TEST", package: "Accelerator", videosPerMonth: 2, monthKey: thisMonth, project: false, topics: [{ title: "Bank one", selection: "SELECTED" }, { title: "Bank two", selection: "SELECTED" }] });
  await prisma.contentEnrollment.update({ where: { id: R.enrollmentId }, data: { programKind: "BULK" } });
  await prisma.contentBulkPlan.create({ data: { enrollmentId: R.enrollmentId, clientId: R.clientId, monthId: R.monthId, totalVideos: 2, perSession: 2, sessionsPlanned: 1, status: "ACTIVE" } });
  await shared(await draft(R, 0, "INTERNAL_REVIEW", "Bank one"));
  await shared(await draft(R, 1, "INTERNAL_REVIEW", "Bank two"));
  const M = await buildContentMonth(prisma, { name: "M5 Monthly Release TEST", package: "Accelerator", videosPerMonth: 2, monthKey: thisMonth, project: false, topics: [{ title: "Monthly one", selection: "SELECTED" }, { title: "Monthly two", selection: "SELECTED" }] });
  await shared(await draft(M, 0, "INTERNAL_REVIEW", "Monthly one"));
  await shared(await draft(M, 1, "INTERNAL_REVIEW", "Monthly two"));
  const pr = await monthProgress(R.enrollmentId, R.monthId);
  const pm = await monthProgress(M.enrollmentId, M.monthId);
  c.ok("the bulk plan: 0 awaiting the client, 2 on the client's bank", pr?.scripts.releasedAwaitingClient === 0 && pr?.scripts.releasedBank === 2, JSON.stringify(pr?.scripts));
  c.ok("a monthly client's released scripts still wait on them (2)", pm?.scripts.releasedAwaitingClient === 2 && pm?.scripts.releasedBank === 0, JSON.stringify(pm?.scripts));
  const tabR = await loadScriptsTab(R.enrollmentId, { id: R.monthId });
  const tabM = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
  c.ok("the Scripts tab marks the bulk plan's scripts as its bank (no \"client hasn't answered yet\")", tabR.scripts.length === 2 && tabR.scripts.every((s) => s.bulkBank === true) && tabM.scripts.every((s) => !s.bulkBank), JSON.stringify([tabR.scripts.map((s) => s.bulkBank), tabM.scripts.map((s) => s.bulkBank)]));

  // =========================================================================
  c.head("M5 d · a finished month is off the card; its client's message moves to the next row");
  const F = await buildContentMonth(prisma, { name: "M5 Finished TEST", package: "Accelerator", videosPerMonth: 1, monthKey: monthBefore(thisMonth), project: false, topics: [{ title: "Finished topic", selection: "SELECTED" }] });
  await draft(F, 0, "DRAFT", "Finished topic");
  await prisma.contentVideo.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthId: F.monthId, monthKey: F.monthKey, kind: "PROGRAM", countsTowardAllowance: true, title: "Finished video TEST", topicId: F.topicIds[0], status: "DELIVERED", deliveredAt: new Date(), source: "manual" } });
  const now = await prisma.contentMonth.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, monthKey: thisMonth, videosOwed: 1, status: "OPEN" } });
  await prisma.programMessage.create({ data: { enrollmentId: F.enrollmentId, clientId: F.clientId, authorKind: "CLIENT", authorLabel: "Finished TEST", body: "Quick question about next month." } });
  const pf = await monthProgress(F.enrollmentId, F.monthId);
  c.ok("the month page calls the earlier month finished (1 of 1 delivered) with a draft left on it", !!pf && staffMonthView(pf).deliveredDone && pf.scripts.drafting === 1, JSON.stringify({ delivered: pf?.production.delivered, owed: pf?.videosOwed, scripts: pf?.scripts }));
  const card3 = await monthlyContentActions();
  const fRows = card3.rows.filter((r) => r.clientName === "M5 Finished TEST");
  c.ok("the finished month is not on the card (its leftover draft is not work)", !fRows.some((r) => r.monthKey === F.monthKey), JSON.stringify(fRows.map((r) => [r.monthKey, r.items.map((i) => i.words)])));
  c.ok("…and the client's waiting message rides on their open month instead", fRows.some((r) => r.monthKey === thisMonth && r.items.some((i) => i.key === "messages")), JSON.stringify(fRows.map((r) => [r.monthKey, r.items.map((i) => i.words)])));
  void now;
}
