// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: REMOVE A SCRIPT FROM THE MONTH (Oct 26 2026). Jordan: "Can you add an
// option for me to remove a script from the month?" (lib/scriptRemoval).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-remove-script.ts --logs <dir>
//
//   1. a draft comes off: WITHDRAWN, off the month and the topic, its versions
//      WITHDRAWN, nothing deleted; the pick REMOVED, the topic back in the
//      bank; the extra pick takes the open slot; the Scripts tab lists it under
//      "Removed from this month" and no longer as a script
//   2. Put it back: exactly as it was (pick, topic, versions, approval), the
//      extra is an extra again; twice is refused
//   3. a script on the client's portal: refused without a reason; with one it
//      is pulled back first (the house pull back), then removed; Put it back
//      returns it to the review queue, never to the portal
//   4. refused: imported history, a script tied to a video, already removed;
//      Put it back refused once the topic has another script on the month
//   5. the guard (signed out, an editor, an owner previewing) and the words
//
// ISOLATION: PGlite via the shared harness, AUTH_ENFORCE on, every outbound
// call fenced; no model call.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5611);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: () => {} }));
const fence = fenceFetch(async () => null);

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct26-remove-script", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const A = await import("@/app/content/actions");
  const R = await import("@/lib/scriptRemoval");
  const scripts = await import("@/lib/contentScripts");
  const { createPillar } = await import("@/lib/contentPillars");
  const { loadScriptsTab } = await import("@/app/content/[id]/programData");
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");

  try {
    // ==================================================================
    c.head("0 · the world: Marcee's October, two videos owed, three picks (the third an extra)");
    const owner = await prisma.appUser.create({ data: { email: "jordan@oct26-rm.test", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { email: "kyle@oct26-rm.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "kim@oct26-rm.test", name: "Kim", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const M = await buildContentMonth(prisma, {
      name: "Marcee Remove TEST", package: "Pro", project: false, videosPerMonth: 2, owner: { email: "info+marcee-rm@realtourpilot.com", name: "Marcee Remove TEST" },
      topics: [
        { title: "Best brunch in Malvern", selection: "SELECTED", source: "call" },
        { title: "Where to eat on King Street", selection: "SELECTED", source: "call" },
        { title: "Get pre-approved first", selection: "SELECTED", source: "call" },
      ],
    });
    const [tA, tB, tC] = M.topicIds;
    const pillar = await createPillar({ enrollmentId: M.enrollmentId, clientId: M.clientId, name: "Local Life", createdBy: owner.email });
    await prisma.contentTopic.updateMany({ where: { id: { in: M.topicIds } }, data: { pillarId: pillar, approvalState: "APPROVED" } });
    // The order the month counts them in: A, B, then C (an extra).
    for (const [i, t] of [tA, tB, tC].entries()) await prisma.contentTopicSelection.updateMany({ where: { topicId: t, monthId: M.monthId }, data: { createdAt: new Date(Date.now() - (10 - i) * 60_000), overflow: i === 2 } });
    const pts = (a: string) => [{ role: "re-hook" as const, text: `${a} one.` }, { role: "build-up" as const, text: `${a} two.` }, { role: "payoff" as const, text: `${a} three.` }];
    const mk = (topicId: string, title: string) => scripts.createScriptVersion({ enrollmentId: M.enrollmentId, monthId: M.monthId, topicId, source: "AI", status: "INTERNAL_REVIEW", createdBy: "cron", parts: { title, hook: `${title} hook.`, points: pts(title), close: "Call me.", pillarId: pillar, categoryLabel: "Local Life" } });
    const sA = await mk(tA, "Best brunch in Malvern");
    const sB = await mk(tB, "Where to eat on King Street");
    await prisma.contentTopic.updateMany({ where: { id: { in: [tA, tB] } }, data: { status: "SCRIPTED", monthId: M.monthId } });
    const selOf = (t: string) => prisma.contentTopicSelection.findUniqueOrThrow({ where: { topicId_monthId: { topicId: t, monthId: M.monthId } } });
    c.ok("seeded: two scripts in review, the third pick an extra", (await selOf(tC)).overflow === true && (await prisma.contentScript.count({ where: { monthId: M.monthId } })) === 2);

    // ==================================================================
    c.head("1 · a draft comes off the month");
    await as(owner);
    const before = await prisma.contentScriptVersion.count();
    const r1 = await A.removeScriptFromMonthAction(sA.scriptId, "Keeping King Street — not both");
    c.ok("removed, and it says where to put it back", r1.ok && /Removed from the month\. Put it back from the bottom of this page\./.test(r1.message), r1.message);
    const a1 = await prisma.contentScript.findUniqueOrThrow({ where: { id: sA.scriptId } });
    c.ok("the script is WITHDRAWN, off the month and the topic, nothing deleted", a1.status === "WITHDRAWN" && a1.monthId === null && a1.topicId === null && a1.releaseState === "withheld" && (await prisma.contentScriptVersion.count()) === before);
    c.ok("…its versions read WITHDRAWN", (await prisma.contentScriptVersion.findMany({ where: { scriptId: sA.scriptId } })).every((v) => v.status === "WITHDRAWN"));
    const selA = await selOf(tA);
    c.ok("the pick is REMOVED (SCRIPT_REMOVED, by Jordan), the topic back in the bank", selA.status === "REMOVED" && selA.removedReason === "SCRIPT_REMOVED" && selA.removedBy === owner.email && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).status === "SAVED" && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).monthId === null);
    c.ok("the extra pick takes the open slot", (await selOf(tC)).overflow === false);
    const ledger = await prisma.contentScriptRelease.findFirst({ where: { scriptId: sA.scriptId, action: R.REMOVED_FROM_MONTH } });
    const l = R.readRemovalLedger(ledger?.note);
    c.ok("the ledger row: who, why (dashes said as commas), what it was", !!l && l.state === "REMOVED" && l.reason === "Keeping King Street, not both" && l.prior.script.status === "INTERNAL_REVIEW" && l.prior.selection?.status === "SELECTED" && l.prior.topic?.status === "SCRIPTED", JSON.stringify(l?.reason));
    const tab = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
    c.ok("the Scripts tab: no longer a script of the month; listed under Removed, by Jordan, with the reason", !tab.scripts.some((s) => s.id === sA.scriptId) && tab.removed.length === 1 && tab.removed[0].title === "Best brunch in Malvern" && tab.removed[0].by === "Jordan" && tab.removed[0].reason === "Keeping King Street, not both" && tab.removed[0].pulledFromPortal === false, JSON.stringify(tab.removed));
    c.ok("a topic event says why", (await prisma.contentTopicEvent.count({ where: { topicId: tA, kind: "DESELECTED", note: { contains: "Its script was removed from the month" } } })) === 1);
    const again = await A.removeScriptFromMonthAction(sA.scriptId, "");
    c.ok("removing it again: refused in words", !again.ok && /already off the month/.test(again.message), again.message);

    // ==================================================================
    c.head("2 · Put it back");
    const p1 = await A.putScriptBackAction(ledger!.id);
    c.ok("back on the month", p1.ok && /"Best brunch in Malvern" is back on the month\./.test(p1.message), p1.message);
    const a2 = await prisma.contentScript.findUniqueOrThrow({ where: { id: sA.scriptId } });
    c.ok("the script is as it was: in review, on the month and its topic", a2.status === "INTERNAL_REVIEW" && a2.monthId === M.monthId && a2.topicId === tA && a2.releaseState === l!.prior.script.releaseState);
    c.ok("…its versions back to what they were", (await prisma.contentScriptVersion.findMany({ where: { scriptId: sA.scriptId } })).every((v) => v.status === "INTERNAL_REVIEW"));
    c.ok("the pick is SELECTED again and the topic SCRIPTED on the month", (await selOf(tA)).status === "SELECTED" && (await selOf(tA)).removedAt === null && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).status === "SCRIPTED" && (await prisma.contentTopic.findUniqueOrThrow({ where: { id: tA } })).monthId === M.monthId);
    c.ok("…and the third pick is an extra again", (await selOf(tC)).overflow === true);
    c.ok("the Removed list is empty; the ledger says PUT_BACK", (await loadScriptsTab(M.enrollmentId, { id: M.monthId })).removed.length === 0 && R.readRemovalLedger((await prisma.contentScriptRelease.findUniqueOrThrow({ where: { id: ledger!.id } })).note)?.state === "PUT_BACK");
    const p2 = await A.putScriptBackAction(ledger!.id);
    c.ok("putting it back twice: refused", !p2.ok && /Already put back/.test(p2.message), p2.message);

    // ==================================================================
    c.head("3 · a script on the client's portal");
    const vB = (await prisma.contentScript.findUniqueOrThrow({ where: { id: sB.scriptId } })).currentVersionId!;
    await prisma.contentScriptVersion.update({ where: { id: vB }, data: { status: "SHARED" } });
    await prisma.contentScript.update({ where: { id: sB.scriptId }, data: { status: "CLIENT_VISIBLE", approvedVersionId: vB, sharedVersionId: vB, approvedAt: new Date(), approvedBy: owner.email, sharedAt: new Date(), releaseState: "released", clientVisible: true } });
    const noWhy = await A.removeScriptFromMonthAction(sB.scriptId, "  ");
    c.ok("no reason: refused, nothing changed", !noWhy.ok && /Say why it comes off their portal/.test(noWhy.message) && (await prisma.contentScript.findUniqueOrThrow({ where: { id: sB.scriptId } })).sharedVersionId === vB, noWhy.message);
    const rB = await A.removeScriptFromMonthAction(sB.scriptId, "She asked for a different restaurant video");
    c.ok("with a reason: pulled off their portal and removed", rB.ok && /Pulled off their portal and removed from the month/.test(rB.message), rB.message);
    const b1 = await prisma.contentScript.findUniqueOrThrow({ where: { id: sB.scriptId } });
    c.ok("…off the portal (no shared version, withheld) and WITHDRAWN", b1.sharedVersionId === null && b1.releaseState === "withheld" && b1.status === "WITHDRAWN" && b1.monthId === null);
    c.ok("…the house pull back wrote its row first, with the reason", (await prisma.contentScriptRelease.count({ where: { scriptId: sB.scriptId, action: "RETURN_TO_QUEUE", note: { contains: "Removed from the month: She asked for a different restaurant video" } } })) === 1);
    const tabB = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
    c.ok("the Removed list says it was taken off their portal", tabB.removed.some((r) => r.title === "Where to eat on King Street" && r.pulledFromPortal));
    const relB = await prisma.contentScriptRelease.findFirstOrThrow({ where: { scriptId: sB.scriptId, action: R.REMOVED_FROM_MONTH } });
    const pB = await A.putScriptBackAction(relB.id);
    const b2 = await prisma.contentScript.findUniqueOrThrow({ where: { id: sB.scriptId } });
    c.ok("Put it back: on the month in the review queue, NOT back on the portal", pB.ok && /in the review queue\. Send it again when you're ready\./.test(pB.message) && b2.monthId === M.monthId && b2.status === "INTERNAL_REVIEW" && b2.sharedVersionId === null && b2.releaseState === "withheld", pB.message);

    // ==================================================================
    c.head("4 · refused");
    const hist = await prisma.contentScript.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, title: "An old imported one", body: "Old words.", historical: true, source: "import" } });
    const rH = await A.removeScriptFromMonthAction(hist.id, "");
    c.ok("imported history: refused", !rH.ok && /Imported history stays/.test(rH.message), rH.message);
    const vid = await prisma.contentVideo.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, topicId: tB, scriptId: sB.scriptId, title: "King Street", status: "FILMED" } as never });
    const rV = await A.removeScriptFromMonthAction(sB.scriptId, "");
    c.ok("tied to a filmed video: refused, nothing changed", !rV.ok && /tied to a video that was filmed/.test(rV.message) && (await prisma.contentScript.findUniqueOrThrow({ where: { id: sB.scriptId } })).monthId === M.monthId, rV.message);
    await prisma.contentVideo.delete({ where: { id: vid.id } });
    await A.removeScriptFromMonthAction(sA.scriptId, "");
    const relA2 = await prisma.contentScriptRelease.findFirstOrThrow({ where: { scriptId: sA.scriptId, action: R.REMOVED_FROM_MONTH }, orderBy: { createdAt: "desc" } });
    const sA2 = await mk(tA, "Best brunch, a new take");
    const rT = await A.putScriptBackAction(relA2.id);
    c.ok("a new script for the topic on the month since: Put it back refused, the new one untouched", !rT.ok && /another script on the month now/.test(rT.message) && (await prisma.contentScript.findUniqueOrThrow({ where: { id: sA2.scriptId } })).monthId === M.monthId, rT.message);

    // ==================================================================
    c.head("5 · the guard and the words");
    await clearSession();
    const anon = await A.removeScriptFromMonthAction(sB.scriptId, "x");
    await as(editor);
    const ed = await A.removeScriptFromMonthAction(sB.scriptId, "x");
    const edBack = await A.putScriptBackAction(relA2.id);
    await as(owner, admin.id);
    const pv = await A.removeScriptFromMonthAction(sB.scriptId, "x");
    c.ok("signed out, an editor (remove and put back), an owner previewing: refused", !anon.ok && !ed.ok && !edBack.ok && !pv.ok);
    c.ok("…and the script never moved", (await prisma.contentScript.findUniqueOrThrow({ where: { id: sB.scriptId } })).monthId === M.monthId);
    await as(admin);
    const kyle = await A.removeScriptFromMonthAction(sB.scriptId, "");
    c.ok("the office (Kyle) may remove one", kyle.ok, kyle.message);
    const ui = read("src/components/content/ScriptsPanel.tsx");
    const block = ui.slice(ui.indexOf("{mode === \"read\" && removing && ("), ui.indexOf("{showVersions && s.versions.length > 1 && ("));
    const list = ui.slice(ui.indexOf("{removed.length > 0 && ("), ui.indexOf("{historical.length > 0 && ("));
    const lib = read("src/lib/scriptRemoval.ts");
    c.ok("the button, the confirm and the list are drawn in the panel", /Remove from this month/.test(ui) && /Take &ldquo;\{s\.title\}&rdquo; off this month\?/.test(block) && /Removed from this month/.test(list) && /Put it back/.test(list));
    c.ok("no em or en dash in the new UI, the actions' words or the lib", ![block, list, lib].some((s) => /[—–]/.test(s)) && ![r1, again, p1, p2, noWhy, rB, pB, rH, rV, rT, kyle].some((r) => /[—–]/.test(r.message)));
    c.ok("nothing left the drill", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    quiet.restore();
    fence.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
