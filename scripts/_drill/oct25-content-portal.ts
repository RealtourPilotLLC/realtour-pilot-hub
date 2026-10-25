// ---------------------------------------------------------------------------
// DRILL oct25-content-portal: THE OCT 25 2026 AUDIT FIXES, CONTENT PROGRAM AND
// CLIENT PORTAL (area E).
//   §1 the 15th's mid-month check for Kyle closes itself once the month asks
//      the client nothing (Janice booked on Oct 23 and hers stayed open); one
//      still asking stays; a person's close is never touched
//   §2 client words: no em dash and no retired "swap" in the topic errors a
//      client's toast shows; script titles in the scripts-ready email lose
//      their dashes; the portal's concept, "Why this one" and imported script
//      titles go through the dash cleaner
//   §3 a session request's notes reach the client's browser as their own
//      "Preferred:" line only, never the office's or the booking engine's
//   §4 dead code gone: the reviseScriptWithInstructions wrapper, the unused
//      interview follow-up prompt, five writer rules
// Disposable PGlite; no model, nothing leaves.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
import type { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

installNextStubs();
const fence = fenceFetch(async () => null);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const DASH = /[—–]/;
// The reminder evaluator reads the calendar: the fixture month is 2026-10.
const EVAL_NOW = new Date("2026-10-22T16:00:00Z");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5968), env: { APP_SECRET: "isolated-oct25-content-portal" } });
  const c = makeChecker();
  try {
    const { prisma: live } = await import("@/lib/prisma");
    const prisma = live as unknown as PrismaClient;
    const T = await import("@/lib/programTaskCloser");

    // =======================================================================
    c.head("§1 · the mid-month check closes itself once the month asks nothing");
    // =======================================================================
    {
      // Still asking: a month with no call, no path and no session.
      const A = await buildContentMonth(prisma, { name: "Midmonth Asking TEST", package: "Starter", project: false });
      // Asks nothing: the month was closed (COMPLETED).
      const B = await buildContentMonth(prisma, { name: "Midmonth Done TEST", package: "Starter", project: false, monthStatus: "COMPLETED" });
      const task = (monthId: string, clientId: string, title: string, status = "OPEN") => prisma.smartTask.create({ data: { taskType: "todo", status, source: "content_program", title, description: "It is the 15th.", dedupeKey: `${T.MIDMONTH_TASK_PREFIX}${monthId}`, clientId, ...(status === "COMPLETED" ? { completedAt: new Date() } : {}) } });
      const tA = await task(A.monthId, A.clientId, "Asking: mid-month check on 2026-10");
      const tB = await task(B.monthId, B.clientId, "Done: mid-month check on 2026-10");
      const C = await buildContentMonth(prisma, { name: "Midmonth Person TEST", package: "Starter", project: false, monthStatus: "COMPLETED" });
      const tC = await task(C.monthId, C.clientId, "Closed by a person", "COMPLETED");

      // An escalation raised AFTER them: the pass must still read it first.
      const esc = await prisma.smartTask.create({ data: { taskType: "todo", status: "OPEN", source: "content_program", title: "Asking: still needs a strategy call booking", dedupeKey: `program-reminder-escalation:${A.monthId}:BOOK_CALL`, clientId: A.clientId } });

      const dry = await T.closeResolvedProgramTasks({ dryRun: true, now: EVAL_NOW });
      const v = (id: string) => dry.verdicts.find((x) => x.taskId === id);
      const at = (id: string) => dry.verdicts.findIndex((x) => x.taskId === id);
      c.ok("the mid-month checks are read after the escalations (the pass has a budget)", at(esc.id) >= 0 && at(esc.id) < at(tA.id) && at(esc.id) < at(tB.id), dry.verdicts.map((x) => x.kind).join(","));
      c.ok("the mid-month task is read as its own kind", v(tA.id)?.kind === "midmonth" && v(tB.id)?.kind === "midmonth", `${v(tA.id)?.kind} ${v(tB.id)?.kind}`);
      c.ok("a month still asking the client something keeps its task", v(tA.id)?.holds === true && /still needs/.test(v(tA.id)?.evidence ?? ""), v(tA.id)?.evidence);
      c.ok("a month that asks nothing lets its task go", v(tB.id)?.holds === false && /no longer needs anything/.test(v(tB.id)?.evidence ?? ""), v(tB.id)?.evidence);
      c.ok("dry run writes nothing", dry.closed === 0 && (await prisma.smartTask.count({ where: { id: { in: [tA.id, tB.id] }, status: "OPEN" } })) === 2);
      await T.closeResolvedProgramTasks({ now: EVAL_NOW });
      const rows = await prisma.smartTask.findMany({ where: { id: { in: [tA.id, tB.id, tC.id] } }, select: { id: true, status: true, description: true } });
      const row = (id: string) => rows.find((r) => r.id === id)!;
      c.ok("the pass closes only the one that no longer holds", row(tB.id).status === "COMPLETED" && row(tA.id).status === "OPEN", rows.map((r) => r.status).join(","));
      c.ok("…with the hub's plain note after its own text, no em dash", /^It is the 15th\.\n\nClosed by the hub on [A-Z][a-z]{2} \d{1,2}: /.test(row(tB.id).description ?? "") && !DASH.test((row(tB.id).description ?? "").split("\n\n")[1] ?? ""), row(tB.id).description ?? "");
      c.ok("a task a person closed is never touched", row(tC.id).status === "COMPLETED" && row(tC.id).description === "It is the 15th.");
    }

    // =======================================================================
    c.head("§2 · words a client reads: no em dash, no retired swap");
    // =======================================================================
    {
      const topics = read("src/lib/contentTopics.ts");
      const thrown = [...topics.matchAll(/throw new Error\("([^"]*(?:script or footage|planned for a month|carried-over script)[^"]*)"\)/g)].map((m) => m[1]);
      const thrownTernary = [...topics.matchAll(/"(This is a carried-over script[^"]*|This topic already has a script or footage[^"]*)"/g)].map((m) => m[1]);
      const all = [...thrown, ...thrownTernary];
      c.ok("the topic errors a client's toast shows carry no em or en dash", all.length >= 4 && all.every((s) => !DASH.test(s)), all.join(" | "));
      c.ok("…and never offer the swap that was retired on Oct 21", all.every((s) => !/swap/i.test(s)), all.join(" | "));
      c.ok("the carry-over switch's description no longer promises the client a swap", !/can swap it for another topic/.test(read("src/lib/programAutomationCopy.ts")));

      const { renderReminder, reminderTemplate } = await import("@/lib/reminderTemplates");
      const body = renderReminder(reminderTemplate("scripts_ready.v1"), {
        firstName: "Janice", month: "October", portalLink: "https://hub.example.test/portal/login", bookCallLink: null, noCallEligible: false, answersStarted: false,
        sessionNote: null, earliestSession: null, itemCount: 2, titles: ["Hakuna Matata — Working With Me Is a Pro", "Spring Market – What Sellers Miss"], updatedTitles: ["Your Neighbor’s Sale Price — Only Part of It"], deadline: null,
      });
      c.ok("the scripts-ready email lists every title without a dash", !DASH.test(body) && body.includes("Hakuna Matata, Working With Me Is a Pro") && body.includes("Your Neighbor’s Sale Price, Only Part of It"), body.split("\n").filter((l) => l.includes("•")).join(" / "));

      const portal = read("src/lib/portal.ts");
      c.ok("the portal topic's concept goes through the dash cleaner", /concept: stripScriptDashes\(t\.concept\)/.test(portal));
      c.ok("…and every \"Why this one\" line", (portal.match(/reason: stripScriptDashes\(x\.reason\)/g) ?? []).length === 4);
      c.ok("…and an imported script's title (its body stays word for word)", /title: stripScriptDashes\(s\.title, \{ title: true \}\), body: s\.body/.test(portal));
      c.ok("…and the released strategy the Strategy tab shows (sections and summary)", /const stripMoneySentences = \(t: string\) => stripScriptDashes\(noMoney\(t\)\)/.test(portal) && /heading: stripScriptDashes\(s\.heading, \{ title: true \}\)/.test(portal) && /brandVoice: typeof sj\.brandVoice === "string" \? stripScriptDashes\(sj\.brandVoice\)/.test(portal));
      const { stripScriptDashes } = await import("@/lib/contentPolicy/scriptFormat");
      c.ok("the cleaner itself: a concept loses its dash, a null stays null", stripScriptDashes("Price it right — then wait") === "Price it right, then wait" && stripScriptDashes(null) === null);
    }

    // =======================================================================
    c.head("§3 · a session request's notes: only the client's own line leaves the server");
    // =======================================================================
    {
      const { clientRequestNote } = await import("@/lib/portal");
      const stored = "Preferred: Tuesday morning, 10 to 12\n\nThe hub asked Aryeo to move this and could not confirm it before session_booking was switched off.\nOffice: James is out that week.";
      c.ok("the client's Preferred line is kept", clientRequestNote(stored) === "Preferred: Tuesday morning, 10 to 12", String(clientRequestNote(stored)));
      c.ok("the office's and the engine's lines are not", !String(clientRequestNote(stored)).includes("Aryeo") && !String(clientRequestNote(stored)).includes("Office"));
      c.ok("notes with no Preferred line send nothing", clientRequestNote("The hub asked Aryeo to move this.") === null && clientRequestNote(null) === null);
      c.ok("the scheduler's month payload uses it", /notes: clientRequestNote\(notes\.get\(r\.id\) \?\? null\)/.test(read("src/lib/portal.ts")));
    }

    // =======================================================================
    c.head("§4 · dead code is gone");
    // =======================================================================
    {
      const pipeline = await import("@/lib/contentPipeline");
      c.ok("contentPipeline no longer exports the reviseScriptWithInstructions wrapper", !("reviseScriptWithInstructions" in pipeline));
      const prompts = await import("@/lib/contentPolicy/prompts");
      c.ok("the never-wired interview follow-up prompt is gone", !("buildInterviewFollowUpPrompt" in prompts) && !("FOLLOW_UP_OUTPUT_SCHEMA" in prompts));
      // The superseded caption prompt stays: caption-grounding rebuilds the
      // retired captionAssistant from git and runs it against this layer.
      c.ok("…the live question-set prompts are still there, and the caption prompt caption-grounding needs", typeof prompts.buildInterviewPlanPrompt === "function" && typeof prompts.buildQuestionRequestPrompt === "function" && typeof prompts.buildCaptionPrompt === "function");
      const rules = await import("@/lib/scriptWriter/rules");
      c.ok("five writer rules nothing read are gone", ["trimAboveFor", "lengthLabel", "NO_DURATION_RULE", "NEITHER_WINS_RULE", "REVIEW_CHECK_KEYS"].every((k) => !(k in rules)));
      c.ok("…and the live ones are kept", typeof rules.lengthBand === "function" && Array.isArray(rules.VIEWER_CHECK_KEYS) && typeof rules.LENGTH_RULE === "string");
    }

    c.ok("nothing left the machine", fence.blocked.length === 0, fence.blocked.join(", "));
  } finally {
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
