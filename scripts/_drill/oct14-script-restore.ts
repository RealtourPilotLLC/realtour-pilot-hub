// ---------------------------------------------------------------------------
// DRILL: script hand edits start from the current version; restore any version
// (Oct 14 2026).
//
// Jordan, on Janice's "Hakuna Matata": "when I did an AI revision (v4 revision)
// I ended up editing it by myself to add a reference video link, and it ended
// up reverting back to the previous version when I clicked the edit button. I
// need a way to manually revert back to a different version, and the edit
// myself showing the previous version needs to be fixed."
//
//   1. A save that started from a version that is no longer the newest is
//      refused, nothing is written, and the message names both versions.
//   2. A hand edit keeps what the textarea does not carry (filming notes,
//      creative direction, goal, alternate hooks); the filming-notes box
//      replaces the notes when it is sent, and an old caller keeps them.
//   3. Restore copies an earlier version's script AND notes into a new version
//      on top (based on the current one, "Restored from vN"); the versions in
//      between are untouched; the current version, a stale base, another
//      script's version and a historical script are refused.
//   4. The panel seeds the edit box on click, not at mount.
//
// ISOLATION: PGlite via the shared harness; every outbound call is fenced.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6991);
const STAFF_EMAIL = "dev@local"; // the sessionless dev path the staff action runs on
const LINK = "https://www.instagram.com/reel/Dd3itODJqaf/";

installNextStubs();
const fence = fenceFetch();

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const scripts = await import("@/lib/contentScripts");
  const actions = await import("@/app/content/actions");
  try {
    await prisma.appUser.create({ data: { email: STAFF_EMAIL, name: "Jordan Drill", role: "OWNER", status: "ACTIVE" } });
    const F = await buildContentMonth(db, { name: "Restore Drill TEST", package: "Accelerator", topics: [{ title: "Hakuna Matata", selection: "SELECTED" }] });
    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];

    // v1: the first AI draft (talking head), with the full set of internal notes.
    const v1 = await scripts.createScriptVersion({
      enrollmentId: F.enrollmentId, monthId: F.monthId, topicId: F.topicIds[0], source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai",
      parts: { title: "Hakuna Matata", hook: "Janice walks the Steel Stacks path with Kona.", points: pts("Real estate can be problem free.", "I plan every step before we list.", "So the only surprise is the price."), close: "Perfect casting.", captionCta: "Call or text me.", filmingNotes: "Steel Stacks, talking head between walking shots.", creativeDirection: "Playful, relaxed.", goal: "Show the calm.", alternateHooks: ["What if moving felt easy?"] },
    });
    // v2: the AI revision Jordan asked for (B-roll and lip sync).
    const v2 = await scripts.createScriptVersion({
      scriptId: v1.scriptId, enrollmentId: F.enrollmentId, monthId: F.monthId, source: "REVISION", status: "INTERNAL_REVIEW", createdBy: "ai", basedOnVersionId: v1.versionId, changeSummary: "Revised: B-roll and lip sync",
      parts: { title: "Hakuna Matata", hook: "[B-roll: Janice and Kona walking the Steel Stacks path.]", points: pts("[Lip sync: Hakuna Matata]", "[On-screen text: No worries]", "[On-screen text: For the rest of your days]"), close: "Kona: unimpressed. Perfect casting.", captionCta: "Call or text me.", filmingNotes: "Almost entirely b-roll and on-screen text.", creativeDirection: "Golden hour, wide.", goal: "Show the calm.", alternateHooks: ["Hakuna Matata, but make it real estate."] },
    });
    const row = (id: string) => prisma.contentScriptVersion.findUniqueOrThrow({ where: { id } });
    const count = () => prisma.contentScriptVersion.count({ where: { scriptId: v1.scriptId } });
    const v1Row = await row(v1.versionId);
    const v2Row = await row(v2.versionId);

    // ======================================================================
    c.head("1 · a save that started from an older version is refused");
    const stale = await actions.saveScriptText(v1.scriptId, `${v1Row.body}\nReference Video: ${LINK}`, { baseVersionId: v1.versionId, filmingNotes: `Reference video: ${LINK}` });
    c.ok("the save is refused", !stale.ok, stale.message);
    c.ok("…the message names the newer version and the one the edit started from", /Version 2 was added after you started from v1/.test(stale.message) && /still in the box/.test(stale.message), stale.message);
    c.ok("…and nothing was written", (await count()) === 2);
    const head0 = await prisma.contentScript.findUniqueOrThrow({ where: { id: v1.scriptId } });
    c.ok("…the current version is still v2", head0.currentVersionId === v2.versionId);

    // ======================================================================
    c.head("2 · a hand edit from the current version keeps the notes");
    const edited = v2Row.body.replace("Perfect casting.", "Perfect casting, every time.");
    const e1 = await actions.saveScriptText(v1.scriptId, edited, { baseVersionId: v2.versionId, filmingNotes: `${v2Row.filmingNotes} Reference video: ${LINK}` });
    c.ok("the edit saves as v3", e1.ok && /version 3/.test(e1.message), e1.message);
    const v3Row = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: v1.scriptId, versionNo: 3 } });
    c.ok("v3 holds the edited words, built on v2", /every time/.test(v3Row.close) && v3Row.hook === v2Row.hook && v3Row.basedOnVersionId === v2.versionId && v3Row.source === "MANUAL");
    c.ok("the filming-notes box replaced the notes (the link is there)", v3Row.filmingNotes === `${v2Row.filmingNotes} Reference video: ${LINK}`, String(v3Row.filmingNotes));
    c.ok("creative direction, goal and alternate hooks came over from v2", v3Row.creativeDirection === "Golden hour, wide." && v3Row.goal === "Show the calm." && v3Row.alternateHooksJson === v2Row.alternateHooksJson, `${v3Row.creativeDirection} | ${v3Row.goal} | ${v3Row.alternateHooksJson}`);
    // An old caller (no notes box) keeps the notes instead of wiping them.
    const e2 = await actions.saveScriptText(v1.scriptId, v3Row.body.replace("every time", "every single time"));
    const v4Row = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: v1.scriptId, versionNo: 4 } });
    c.ok("an edit without the notes box keeps v3's filming notes", e2.ok && v4Row.filmingNotes === v3Row.filmingNotes && v4Row.creativeDirection === "Golden hour, wide.", String(v4Row.filmingNotes));
    // Clearing the box is a real choice, and it is honoured.
    const e3 = await scripts.editScriptFromBody(v1.scriptId, v4Row.body, "jordan@drill.invalid", { baseVersionId: v4Row.id, filmingNotes: "  " });
    const v5Row = await row(e3.versionId);
    c.ok("an emptied notes box saves no filming notes", v5Row.filmingNotes === null);

    // ======================================================================
    c.head("3 · restore copies an earlier version on top");
    const r1 = await actions.restoreScriptVersionAction(v1.scriptId, v1.versionId, v5Row.id);
    c.ok("restoring v1 saves as v6", r1.ok && /v1 restored as version 6/.test(r1.message), r1.message);
    const v6Row = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: v1.scriptId, versionNo: 6 } });
    c.ok("v6 is v1's script word for word", v6Row.hook === v1Row.hook && v6Row.pointsJson === v1Row.pointsJson && v6Row.close === v1Row.close && v6Row.captionCta === v1Row.captionCta && v6Row.body === v1Row.body);
    c.ok("…with v1's notes (filming, creative, goal, alternate hooks)", v6Row.filmingNotes === v1Row.filmingNotes && v6Row.creativeDirection === v1Row.creativeDirection && v6Row.goal === v1Row.goal && v6Row.alternateHooksJson === v1Row.alternateHooksJson);
    c.ok("…recorded as a restore, based on the version it replaced", v6Row.source === "MANUAL" && v6Row.changeSummary === "Restored from v1" && v6Row.basedOnVersionId === v5Row.id && v6Row.status === "DRAFT");
    const head1 = await prisma.contentScript.findUniqueOrThrow({ where: { id: v1.scriptId } });
    c.ok("v6 is now current", head1.currentVersionId === v6Row.id);
    const untouched = await Promise.all([v2Row, v3Row, v4Row, v5Row].map((v) => row(v.id)));
    c.ok("the versions in between are untouched", untouched.every((u, i) => u.body === [v2Row, v3Row, v4Row, v5Row][i].body && u.filmingNotes === [v2Row, v3Row, v4Row, v5Row][i].filmingNotes));
    // Undo is a restore of the one before.
    const r2 = await actions.restoreScriptVersionAction(v1.scriptId, v5Row.id, v6Row.id);
    const v7Row = await prisma.contentScriptVersion.findFirstOrThrow({ where: { scriptId: v1.scriptId, versionNo: 7 } });
    c.ok("undo = restore the one before (v5 back as v7)", r2.ok && v7Row.body === v5Row.body && v7Row.changeSummary === "Restored from v5", r2.message);
    const same = await actions.restoreScriptVersionAction(v1.scriptId, v7Row.id, v7Row.id);
    c.ok("restoring the current version is refused", !same.ok && /already the current version/.test(same.message), same.message);
    const staleR = await actions.restoreScriptVersionAction(v1.scriptId, v2.versionId, v6Row.id);
    c.ok("a restore from a stale screen is refused (reload and choose again)", !staleR.ok && /Version 7 was added after this page loaded/.test(staleR.message) && /nothing was restored/.test(staleR.message), staleR.message);
    const other = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, monthId: F.monthId, source: "AI", status: "INTERNAL_REVIEW", createdBy: "ai", parts: { title: "Another script", hook: "Another hook.", points: pts("One.", "Two.", "Three."), close: "Call me." } });
    const cross = await actions.restoreScriptVersionAction(v1.scriptId, other.versionId, v7Row.id);
    c.ok("another script's version is refused", !cross.ok && /not part of this script/.test(cross.message), cross.message);
    const hist = await scripts.createScriptVersion({ enrollmentId: F.enrollmentId, source: "IMPORT", historical: true, createdBy: "import", parts: { title: "Filmed in 2025", hook: "Old hook.", points: pts("One.", "Two.", "Three."), close: "Old close." } });
    await scripts.createScriptVersion({ scriptId: hist.scriptId, enrollmentId: F.enrollmentId, source: "IMPORT", historical: true, createdBy: "import", parts: { title: "Filmed in 2025", hook: "Older hook.", points: pts("One.", "Two.", "Three."), close: "Old close." } });
    const histR = await actions.restoreScriptVersionAction(hist.scriptId, hist.versionId, null);
    c.ok("a historical script is refused", !histR.ok && /historical/.test(histR.message), histR.message);
    c.ok("seven versions in all, nothing deleted", (await count()) === 7);

    // ======================================================================
    c.head("4 · the panel loads the edit box on click");
    const panel = fs.readFileSync(path.resolve(__dirname, "../../src/components/content/ScriptsPanel.tsx"), "utf8");
    c.ok("the edit box is not seeded from the version at mount", !/useState\(cur\?\.body/.test(panel));
    c.ok("Edit myself loads the current version and remembers it", /const startEdit = \(\) => \{ setBody\(cur\?\.body \?\? ""\); setNotes\(cur\?\.filmingNotes \?\? ""\); setBaseId\(cur\?\.id \?\? null\)/.test(panel) && /onClick=\{startEdit\}/.test(panel));
    c.ok("the save sends the version it started from and the notes", /saveScriptText\(s\.id, body, \{ baseVersionId: baseId, filmingNotes: notes \}\)/.test(panel));
    c.ok("every older version offers Restore", /restoreScriptVersionAction\(s\.id, v\.id, cur\?\.id \?\? null\)/.test(panel));

    // ======================================================================
    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  } finally {
    quiet.restore();
    c.summary();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
