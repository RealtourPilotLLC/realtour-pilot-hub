// ---------------------------------------------------------------------------
// DRILL: no client ask is left unread; songs reach the music note; review
// notes get a suggested category (Oct 16 2026).
//
// 24 of the 32 client texts filed as revisions since Sep 4 were never split
// into items (analyzedAt null, no error): until Oct 14 a brief was only read
// at 240 characters or more, and a reading that died left the same blank row.
//
//   1. The rules: tries counted in the error, refusals never retried, which
//      unread briefs the sweep may read (open job, or a week-old ask whose card
//      is still open; never a finished job whose card a person closed).
//   2. Born read: a short text is read at once; a portal ask with no cut is
//      read; an addendum with no cut is born with its own lines, no model call.
//   3. A reading that fails: the error is on the row, the client's words stay
//      one issue; the sweep waits ten minutes, counts tries ("Try 2 of 3
//      failed"), gives up after the third, and reads it when the model is back
//      (the whole-text issue stands down, the items become issues).
//   4. A reading that died silently is read; a finished job is not; the
//      topics cron runs the step second, after the AI queue.
//   5. Songs: Joe's "just use Sweet home Alabama" lands on the video's music
//      note beside the office's own words, once; a Spotify link adds a line;
//      two videos and nothing saying which leaves the notes alone and says so
//      on the timeline; a music item naming video 2 lands on video 2 only; a
//      song for a job still being made lands too.
//   6. Categories: a note's words suggest one (stored beside the category,
//      never in it), once; a person's pick wins; the brief item and the
//      /quality list carry it.
//
// ISOLATION: PGlite; the model is answered in-process; nothing else leaves.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
type Item = { area: string; ask: string; kind: string; detail: string; quote: string; scope: string; videos: string[] };
let mode: "ok" | "fail" = "ok";
let nextItems: Item[] = [];
let briefCalls = 0;
const prompts: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    if (prompt.includes("--- WHAT THE CLIENT SAID ---")) {
      briefCalls++;
      prompts.push(prompt);
      if (mode === "fail") return json({ error: { message: "drill: the model is down" } }, 400);
      return json({ content: [{ type: "tool_use", name: "emit", input: { headline: "Changes to the video", items: nextItems, keep: [], references: [], questions: [] } }] });
    }
    return json({ content: [{ type: "text", text: "ok" }] });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: "D1", ts: "1.1" });
  return null;
});
const item = (p: Partial<Item> & { ask: string }): Item => ({ area: "Other", kind: "CORRECTION", detail: "", quote: "", scope: "all", videos: [], ...p });
const MIN = 60_000;
const DAY = 86_400_000;

async function main() {
  const drill = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 7163), env: { CRON_SECRET: "drill-secret" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const read = (p: string) => fs.readFileSync(p, "utf8");
  const errs: unknown[][] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => { errs.push(a); };
  try {
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("ai", "drill-ai-key-not-real");
    const rb = await import("@/lib/revisionBrief");
    const sw = await import("@/lib/revisionBriefSweep");
    const songs = await import("@/lib/songRequests");
    const causes = await import("@/lib/issueCauses");
    const issues = await import("@/lib/revisionIssues");
    const { raiseRevision } = await import("@/lib/comms");
    const dout = await import("@/lib/deliverableOutputs");

    let seq = 0;
    /** A listing job owing `videos` videos (VIDEO deliverables, quantity 1 each). */
    const job = async (name: string, opts: { status?: string; videos?: number } = {}) => {
      const client = await prisma.client.create({ data: { name } });
      const p = await prisma.project.create({ data: { clientId: client.id, title: `${++seq} ${name.split(" ")[0]} Rd, Testville, PA`, status: (opts.status ?? "DELIVERED") as never, deliveredAt: opts.status && opts.status !== "DELIVERED" ? null : new Date(Date.now() - 2 * DAY) } });
      for (let v = 0; v < (opts.videos ?? 1); v++) {
        await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: v === 0 ? "Video" : `Video ${v + 1}`, productTitle: v === 0 ? "Cinematic MLS Video" : `Social Reel ${v + 1}`, videoStyle: "standard_cinematic", quantity: 1 } });
      }
      await dout.ensureOutputsForProject(p.id);
      const outs = await prisma.deliverableOutput.findMany({ where: { projectId: p.id }, orderBy: [{ createdAt: "asc" }] });
      return { projectId: p.id, clientId: client.id, clientName: name, outs };
    };
    const latestBrief = (projectId: string) => prisma.revisionBrief.findFirstOrThrow({ where: { projectId }, orderBy: { createdAt: "desc" } });
    const musicOf = async (outputId: string) => dout.readOutputBrief((await prisma.deliverableOutput.findUniqueOrThrow({ where: { id: outputId } })).briefJson)?.sections.music ?? null;

    // ======================================================================
    c.head("1 · the rules");
    c.ok("tries: none, the first reading's own error, the sweep's count", rb.analysisTriesOf(null) === 0 && rb.analysisTriesOf("AI is not connected.") === 1 && rb.analysisTriesOf("Try 2 of 3 failed: x") === 2);
    c.ok("a try's error keeps the reason, not the old prefix", rb.analysisTryError(3, "Try 2 of 3 failed: the model is down") === "Try 3 of 3 failed: the model is down", rb.analysisTryError(3, "Try 2 of 3 failed: the model is down"));
    c.ok("a refusal is an answer, counted or not", rb.isAnalysisRefusal("Not re-read: its items are already being worked") && rb.isAnalysisRefusal("Try 2 of 3 failed: Not re-read: x") && !rb.isAnalysisRefusal("the model is down"));
    const now = new Date("2026-10-16T15:00:00Z");
    const v = (p: Partial<Parameters<typeof sw.briefSweepVerdict>[0]> & { ageMs: number }) =>
      sw.briefSweepVerdict({ source: "openphone", analyzedAt: null, analysisError: null, jobStatus: "REVISION", taskStatus: "OPEN", ...p, createdAt: new Date(now.getTime() - p.ageMs) }, now);
    const why = (x: ReturnType<typeof v>) => (x.read ? "read" : x.why);
    c.ok("an open job's ask, 20 minutes old: read", why(v({ ageMs: 20 * MIN })) === "read");
    c.ok("5 minutes old: left to its own reading", why(v({ ageMs: 5 * MIN })) === "too new");
    c.ok("a delivered job whose card is still open, 3 days: read", why(v({ ageMs: 3 * DAY, jobStatus: "DELIVERED" })) === "read");
    c.ok("a delivered job whose card a person closed, 2 days: not read", why(v({ ageMs: 2 * DAY, jobStatus: "DELIVERED", taskStatus: "COMPLETED" })) === "finished job");
    c.ok("a delivered job, card open but 8 days old: not read", why(v({ ageMs: 8 * DAY, jobStatus: "DELIVERED" })) === "finished job");
    // Oct 19 audit: a card a person closed is finished work, whatever the job's status.
    c.ok("a job still in editing, card closed, a month old: not read (the card is closed)", why(v({ ageMs: 30 * DAY, jobStatus: "EDITING", taskStatus: "COMPLETED" })) === "finished job");
    c.ok("a job in revision with its card closed (671 Northbrook): not read", why(v({ ageMs: 2 * DAY, jobStatus: "REVISION", taskStatus: "COMPLETED" })) === "finished job");
    c.ok("a test client's brief: never read", why(v({ ageMs: DAY, jobStatus: "EDITING", testClient: true })) === "test client");
    c.ok("an office row, a refusal, three tries, an analysed row: never", why(v({ ageMs: DAY, source: "office" })) === "office" && why(v({ ageMs: DAY, analysisError: "Not re-read: x" })) === "refused" && why(v({ ageMs: DAY, analysisError: "Try 3 of 3 failed: x" })) === "gave up" && why(v({ ageMs: DAY, analyzedAt: now })) === "already read");

    // ======================================================================
    c.head("2 · born read");
    const A = await job("Joe Music TEST");
    nextItems = [item({ area: "Music & sound", ask: "Add music to the video", quote: "There's no music on the video." })];
    const calls0 = briefCalls;
    await raiseRevision({ projectId: A.projectId, clientId: A.clientId, clientName: A.clientName, note: "There's no music on the video.", source: "openphone", requestedBy: { name: "Joe", kind: "TEXT" } });
    const a1 = await latestBrief(A.projectId);
    c.ok("a 30-character text is read at once (the old 240 floor is gone)", briefCalls === calls0 + 1 && !!a1.analyzedAt && !a1.analysisError, `${briefCalls - calls0} ${a1.analysisError}`);
    c.ok("…into numbered items", JSON.parse(a1.itemsJson!).items.length === 1);
    c.ok("…which became the editor's issue, filed under its area", (await prisma.revisionIssue.findFirst({ where: { sourceId: { startsWith: `${a1.id}:` } } }))?.category === "Music & sound");
    const calls1 = briefCalls;
    const portal = await rb.createRevisionBrief({ projectId: A.projectId, source: "portal", text: "Make the ending shorter please", pin: { submissionId: "legacy-sub", outputId: null, cutKey: null, decisionId: "dec-legacy", roundId: null, label: "the video" } });
    const pb = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: portal! } });
    c.ok("a portal ask on a cut with no slot (no items of its own) is read too", briefCalls === calls1 + 1 && !!pb.analyzedAt, `${briefCalls - calls1}`);
    const calls2 = briefCalls;
    const add = await rb.createRevisionBrief({ projectId: A.projectId, source: "portal", sourceDetail: "decision:dec-legacy:addendum:1", text: "Additional notes:\n• Brighter intro\n• Lose the second drone shot", skipAnalysis: true, pin: { submissionId: "legacy-sub", outputId: null, cutKey: null, decisionId: "dec-legacy", roundId: null, label: "the video" } });
    const ab = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: add! } });
    const abItems = JSON.parse(ab.itemsJson!).items as { ask: string; scope: string; cuts: string[] | null }[];
    c.ok("an addendum with no cut: no model call, born with its own lines, unplaced", briefCalls === calls2 && !!ab.analyzedAt && abItems.length === 2 && abItems.every((i) => i.scope === "unknown" && i.cuts === null) && abItems[1].ask === "Lose the second drone shot", JSON.stringify(abItems));

    // ======================================================================
    c.head("3 · a reading that fails, and the net under it");
    const B = await job("Bea Logo TEST");
    mode = "fail";
    errs.length = 0;
    await raiseRevision({ projectId: B.projectId, clientId: B.clientId, clientName: B.clientName, note: "The logo at the end is the old one, please swap it", source: "openphone" });
    const b1 = await latestBrief(B.projectId);
    c.ok("the failure is on the row, not silent: analysisError, still unread", !b1.analyzedAt && /model is down/.test(b1.analysisError ?? ""), b1.analysisError ?? "(none)");
    c.ok("…and in the log", errs.some((e) => /reading failed|did not complete/.test(String(e[0]))));
    const whole = await prisma.revisionIssue.findFirst({ where: { sourceId: { startsWith: `${b1.id}:whole:` } } });
    c.ok("the client's whole text is still one issue for the editor", !!whole && whole.state === "OPEN" && whole.originalText.includes("old one"));
    c.ok("its card data: not analysed, no items, the words whole", await rb.getRevisionBriefs(B.projectId, true).then((bs) => bs.some((x) => x.id === b1.id && !x.analyzed && x.items.length === 0 && x.originalText.includes("old one"))));
    const at = (ms: number) => new Date(b1.createdAt.getTime() + ms);
    let callsS = briefCalls;
    const s0 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true, now: at(5 * MIN) });
    c.ok("five minutes on, the sweep leaves it alone", briefCalls === callsS && !s0.failedIds.includes(b1.id) && !s0.readIds.includes(b1.id));
    const s1 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true, now: at(11 * MIN) });
    const b2 = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: b1.id } });
    c.ok("eleven minutes on it tries again and counts it: Try 2 of 3", s1.failedIds.includes(b1.id) && b2.analysisError?.startsWith("Try 2 of 3 failed: ") === true && /model is down/.test(b2.analysisError), b2.analysisError ?? "");
    await sw.sweepUnanalyzedBriefs({ includeTestClients: true, now: at(26 * MIN) });
    const b3 = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: b1.id } });
    c.ok("the third try: Try 3 of 3", b3.analysisError?.startsWith("Try 3 of 3 failed: ") === true, b3.analysisError ?? "");
    callsS = briefCalls;
    const s3 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true, now: at(41 * MIN) });
    c.ok("then it gives up: no fourth model call, counted", briefCalls === callsS && s3.gaveUp >= 1 && !s3.failedIds.includes(b1.id), JSON.stringify(s3));

    // A second ask whose first reading failed, and the model comes back.
    const C = await job("Cal Spell TEST");
    await raiseRevision({ projectId: C.projectId, clientId: C.clientId, clientName: C.clientName, note: "You spelled Okehocking wrong and the hook is missing", source: "openphone" });
    const c1 = await latestBrief(C.projectId);
    c.ok("(a second failed first reading)", !c1.analyzedAt && !!c1.analysisError);
    mode = "ok";
    nextItems = [item({ area: "On-screen text", ask: "Fix the spelling of Okehocking", quote: "You spelled Okehocking wrong" }), item({ area: "Cuts & content", ask: "Add the hook back at the start", quote: "the hook is missing" })];
    const s4 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true, now: new Date(c1.createdAt.getTime() + 12 * MIN) });
    const c2 = await prisma.revisionBrief.findUniqueOrThrow({ where: { id: c1.id } });
    c.ok("the model is back: read, error cleared, two items", s4.readIds.includes(c1.id) && !!c2.analyzedAt && c2.analysisError === null && JSON.parse(c2.itemsJson!).items.length === 2, JSON.stringify(s4));
    const cIssues = await prisma.revisionIssue.findMany({ where: { sourceId: { startsWith: `${c1.id}:` } }, orderBy: { createdAt: "asc" } });
    c.ok("the whole-text issue stands down; each item is its own issue", cIssues.find((i) => i.sourceId.includes(":whole:"))?.state === "NOT_APPLICABLE" && cIssues.filter((i) => i.state === "OPEN").length === 2, cIssues.map((i) => `${i.sourceId.split(":")[1]}=${i.state}`).join(" "));

    // ======================================================================
    c.head("4 · a reading that died, a finished job, the cron step");
    const D = await job("Dee Silent TEST", { status: "REVISION" });
    const dTask = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision — D", status: "OPEN", projectId: D.projectId, dedupeKey: `drill-rev-${D.projectId}` } });
    const dead = await prisma.revisionBrief.create({ data: { projectId: D.projectId, taskId: dTask.id, source: "openphone", originalText: "Can you make the intro shorter", createdAt: new Date(Date.now() - 30 * MIN) } });
    nextItems = [item({ area: "Pacing & movement", ask: "Shorten the intro", quote: "Can you make the intro shorter" })];
    const s5 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true });
    c.ok("a brief whose reading died with its request (no error at all) is read", s5.readIds.includes(dead.id) && !!(await prisma.revisionBrief.findUniqueOrThrow({ where: { id: dead.id } })).analyzedAt, JSON.stringify(s5));
    const F = await job("Finn Finished TEST");
    const fTask = await prisma.smartTask.create({ data: { taskType: "revision", title: "Video revision — F", status: "COMPLETED", projectId: F.projectId, dedupeKey: `drill-rev-${F.projectId}` } });
    const old = await prisma.revisionBrief.create({ data: { projectId: F.projectId, taskId: fTask.id, source: "openphone", originalText: "He doesn't want it published the way it is", createdAt: new Date(Date.now() - 2 * DAY) } });
    const callsF = briefCalls;
    const s6 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true });
    c.ok("a finished job whose card a person closed: never read, no model call, counted", briefCalls === callsF && !s6.readIds.includes(old.id) && s6.finishedJob >= 1 && !(await prisma.revisionBrief.findUniqueOrThrow({ where: { id: old.id } })).analyzedAt);
    c.ok("…and no creative review or issue made for it", (await prisma.smartTask.count({ where: { projectId: F.projectId, taskType: "creative_review" } })) === 0 && (await prisma.revisionIssue.count({ where: { projectId: F.projectId } })) === 0);
    const cap = await prisma.revisionBrief.create({ data: { projectId: D.projectId, taskId: dTask.id, source: "openphone", originalText: "Also brighten the kitchen", createdAt: new Date(Date.now() - 20 * MIN) } });
    const cap2 = await prisma.revisionBrief.create({ data: { projectId: D.projectId, taskId: dTask.id, source: "openphone", originalText: "And the music lower", createdAt: new Date(Date.now() - 25 * MIN) } });
    const s7 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true, max: 1 });
    c.ok("a run reads at most its share; the rest wait for the next run", s7.read === 1 && s7.leftForNextRun >= 1 && [cap.id, cap2.id].some((id) => s7.readIds.includes(id)), JSON.stringify(s7));
    const s8 = await sw.sweepUnanalyzedBriefs({ includeTestClients: true, budgetMs: 10_000, minStartMs: 75_000 });
    c.ok("with too little time left, nothing starts", s8.read === 0 && s8.failed === 0 && s8.leftForNextRun >= 1, JSON.stringify(s8));
    const route = read("src/app/api/cron/topics/route.ts");
    c.ok("the topics cron runs it second, after the AI queue, with a start floor", route.indexOf('step("aiQueue"') > 0 && route.indexOf('step("revisionBriefs"') > route.indexOf('step("aiQueue"') && route.indexOf('step("revisionBriefs"') < route.indexOf("const run: Record<AiWorkStep") && /minStartMs: BRIEF_SWEEP_MIN_START_MS/.test(route));
    const { NextRequest } = await import("next/server");
    const { GET } = await import("@/app/api/cron/topics/route");
    const res = await GET(new NextRequest("http://127.0.0.1/api/cron/topics", { headers: { authorization: "Bearer drill-secret" } }) as never);
    const body = (await res.json()) as Record<string, unknown> & { ms?: Record<string, number> };
    const steps = Object.keys(body.ms ?? {});
    c.ok("GET /api/cron/topics: revisionBriefs ran second, no error", steps[0] === "aiQueue" && steps[1] === "revisionBriefs" && !("revisionBriefsError" in body) && typeof (body.revisionBriefs as { looked?: number })?.looked === "number", `${steps.join()} ${String(JSON.stringify(body.revisionBriefs ?? Object.keys(body))).slice(0, 300)}`);
    const src = read("src/lib/revisionBrief.ts");
    c.ok("analyzeBrief wraps every step (the reads ahead of the model too) in one catch that records the error", /export async function analyzeBrief\([^)]*\): Promise<boolean> \{\s*try \{\s*return await analyzeBriefOnce/.test(src));
    c.ok("an unknown brief: false, never a throw", (await rb.analyzeBrief("no-such-brief")) === false);

    // ======================================================================
    c.head("5 · songs onto the music note");
    const J = await job("Joe Sutow TEST");
    const jOut = J.outs[0];
    await dout.saveOutputBrief({ outputId: jOut.id, projectId: J.projectId, sections: { music: "Use something upbeat, licensed." }, actor: "Kyle" });
    nextItems = [item({ area: "Music & sound", kind: "REFINEMENT", ask: "Use Sweet Home Alabama", quote: "just use Sweet home Alabama" })];
    await raiseRevision({ projectId: J.projectId, clientId: J.clientId, clientName: J.clientName, note: "As for the song... I sent James a few but just use Sweet home Alabama.", source: "openphone", requestedBy: { name: "Joe Sutow", kind: "TEXT" } });
    const m1 = (await musicOf(jOut.id)) ?? "";
    c.ok("the office's own words stay, the client's song goes under them", m1.startsWith("Use something upbeat, licensed.\nClient asked for: Sweet home Alabama (Joe Sutow, by text, "), m1);
    c.ok("…no em dash in it", !/—/.test(m1));
    c.ok("…the timeline says so", !!(await prisma.activity.findFirst({ where: { projectId: J.projectId, body: { contains: "song request was added to the music note" } } })));
    const jb = await latestBrief(J.projectId);
    const again = await songs.noteSongRequestsFromBrief(jb.id);
    c.ok("the same brief again writes nothing (idempotent)", again.written.length === 0 && (await musicOf(jOut.id)) === m1, JSON.stringify(again));
    nextItems = [item({ area: "Music & sound", ask: "Use the linked track", quote: "" })];
    await raiseRevision({ projectId: J.projectId, clientId: J.clientId, clientName: J.clientName, note: "https://open.spotify.com/track/4lXjz5k4Rij3LTj6O0mgOO?si=pg2lwzwnTiurlQK806hnwQ&utm_source=sms", source: "openphone", requestedBy: { name: "Tabitha", kind: "TEXT" } });
    const m2 = (await musicOf(jOut.id)) ?? "";
    c.ok("a Spotify link adds its own line under both", m2.startsWith(m1) && /\nClient asked for: https:\/\/open\.spotify\.com\/track\/4lXjz5k4Rij3LTj6O0mgOO/.test(m2), m2);

    const E = await job("Erin Two TEST", { videos: 2 });
    nextItems = [item({ area: "Music & sound", ask: "Use the SoundCloud track", scope: "unknown" })];
    await raiseRevision({ projectId: E.projectId, clientId: E.clientId, clientName: E.clientName, note: "Can we use this song? https://on.soundcloud.com/8xzGBHh6GwdDU1PA9H", source: "openphone" });
    c.ok("two videos and nothing saying which: no note touched", (await Promise.all(E.outs.map((o) => musicOf(o.id)))).every((x) => x === null));
    c.ok("…the timeline says which video is unclear", !!(await prisma.activity.findFirst({ where: { projectId: E.projectId, body: { contains: "isn't clear, so no video's music note was changed" } } })));
    nextItems = [item({ area: "Music & sound", ask: "Use Golden Hour on the reel", scope: "named", videos: ["V2"] })];
    await raiseRevision({ projectId: E.projectId, clientId: E.clientId, clientName: E.clientName, note: "For the reel please use \"Golden Hour\" by JVKE instead of the current track", source: "gmail" });
    const slots = await (await import("@/lib/reviewCuts")).cutSlots(E.projectId);
    const v2 = E.outs.find((o) => o.deliverableId === slots[1].deliverableId && o.slot === slots[1].slot)!;
    const v1 = E.outs.find((o) => o.id !== v2.id)!;
    c.ok("a music item naming video 2: video 2's note only, by email", /Client asked for: Golden Hour by JVKE \(by email, /.test((await musicOf(v2.id)) ?? "") && (await musicOf(v1.id)) === null, `${await musicOf(v2.id)} | ${await musicOf(v1.id)}`);

    const G = await job("Georgiana Making TEST", { status: "EDITING" });
    const gm = await songs.noteSongRequestFromMessage({ projectId: G.projectId, text: "Caught Up In The Country (Sam Feldt Remix) by Rodney Atkins on #SoundCloud \r\nhttps://on.soundcloud.com/8xzGBHh6GwdDU1PA9H\r\n\r\nHey guys can we use this song for the listing", source: "openphone", who: "Georgiana" });
    c.ok("a song for a job still being made lands on its one video", gm.written.length === 1 && /Client asked for: https:\/\/on\.soundcloud\.com\/8xzGBHh6GwdDU1PA9H · Caught Up In The Country \(Sam Feldt Remix\) by Rodney Atkins \(Georgiana, by text, /.test((await musicOf(G.outs[0].id)) ?? ""), await musicOf(G.outs[0].id) ?? "");
    c.ok("words that name no song write nothing", songs.findSongAsks("There's no music on the video. Staging 8 and 18.").length === 0 && songs.findSongAsks("I'm getting a copyright claim blocking the video on our YouTube channel. Can you edit with another song?").length === 0 && songs.findSongAsks("Like this one https://www.youtube.com/watch?v=abc123 can you match the pacing?").length === 0);
    c.ok("an artist's song is still named", JSON.stringify(songs.findSongAsks("Then maybe use the Noah Kahan actual song and have me do the rest")) === JSON.stringify(["a Noah Kahan song"]));
    c.ok("the comms path for a job still being made calls the same note", /noteSongRequestFromMessage\(\{ projectId: anchorProjectId/.test(read("src/lib/comms.ts")));

    // ======================================================================
    c.head("6 · a suggested category beside the pick");
    const cases: [string, string | null][] = [
      ["Thing -> Things", "On-screen text"], ["Small typo - spasso", "On-screen text"], ["Remove \"of\"", "On-screen text"],
      ["There's no music on the video", "Music & sound"], ["I don't like the sound of my voice on this. It's really loud", "Music & sound"],
      ["At the end - add mikes animated logo", "Graphics & effects"], ["Cut this clip", "Cuts & content"],
      ["Trim up the kitchen and dining room sequences here", "Cuts & content"], ["Add a little more stabilization here", "Pacing & movement"],
      ["Everything else is perfect!", null], ["So with a", null],
    ];
    const misses = cases.filter(([t, want]) => causes.suggestIssueCategory(t) !== want);
    c.ok("the words point at the category (11 real notes)", misses.length === 0, misses.map(([t]) => `${t} → ${causes.suggestIssueCategory(t)}`).join(" | "));
    c.ok("a report counts the pick, else the suggestion, else Other", causes.effectiveIssueCategory("Music & sound", "On-screen text") === "Music & sound" && causes.effectiveIssueCategory("Other", "On-screen text") === "On-screen text" && causes.effectiveIssueCategory("Other", null) === "Other");
    const sub = await prisma.reviewSubmission.create({ data: { projectId: J.projectId, deliverableId: jOut.deliverableId, slot: jOut.slot, round: 1, status: "CHANGES_REQUESTED", source: "upload", fileName: "v1.mov", submittedByKey: "kim", outputId: jOut.id } });
    const noteRow = await prisma.mediaNote.create({ data: { projectId: J.projectId, assetUrl: `cut:${sub.id}`, assetType: "video", timeSec: 12, lane: "EDITOR", kind: "fix", body: "“Thing” should be “Things”\n\nThing -> Things", status: "OPEN", authorKey: "owner", authorName: "Jordan Spackman" } });
    const issueId = await issues.ingestReviewNote(noteRow.id);
    const iss = await prisma.revisionIssue.findUniqueOrThrow({ where: { id: issueId! } });
    const evs = await prisma.revisionIssueEvent.findMany({ where: { issueId: issueId!, kind: issues.CATEGORY_SUGGESTED } });
    c.ok("a review note's issue keeps category Other; the suggestion sits beside it", iss.category === "Other" && evs.length === 1 && evs[0].toValue === "On-screen text" && evs[0].fromValue === "Other");
    await issues.ingestReviewNote(noteRow.id);
    c.ok("ingesting again adds no second suggestion", (await prisma.revisionIssueEvent.count({ where: { issueId: issueId!, kind: issues.CATEGORY_SUGGESTED } })) === 1);
    const view = (await issues.issuesForProject(J.projectId, { scrub: true })).find((i) => i.id === issueId)!;
    c.ok("the issue list carries it (category Other, suggested On-screen text)", view.category === "Other" && view.categorySuggested === "On-screen text");
    c.ok("an editor's view carries it too (it is not a verdict)", (await issues.issuesForProject(J.projectId, { scrub: true, viewer: { editorKey: "john" } })).find((i) => i.id === issueId)?.categorySuggested === "On-screen text");
    const uc = await issues.unclassifiedIssues(100);
    c.ok("the /quality list carries it", uc.find((i) => i.id === issueId)?.categorySuggested === "On-screen text");
    await issues.classifyIssue(issueId!, { cause: "CLIENT_CHANGE", category: "Captions & names" }, { name: "James" });
    const after = (await issues.issuesForProject(J.projectId, { scrub: true })).find((i) => i.id === issueId)!;
    c.ok("a person's pick wins: the category is theirs, the suggestion drops away", after.category === "Captions & names" && after.categorySuggested === null);
    c.ok("…and the hub never suggests over it", (await issues.recordCategorySuggestion(issueId!, "Cut this clip")) === null && (await prisma.revisionIssueEvent.count({ where: { issueId: issueId!, kind: issues.CATEGORY_SUGGESTED } })) === 1);
    const unread = (await prisma.revisionIssue.findMany({ where: { projectId: B.projectId, sourceId: { contains: ":whole:" } } }))[0];
    const unreadEv = unread ? await prisma.revisionIssueEvent.findFirst({ where: { issueId: unread.id, kind: issues.CATEGORY_SUGGESTED } }) : null;
    c.ok("an unread brief's whole-text issue gets one from the client's words (the logo: graphics)", unread?.category === "Other" && unreadEv?.toValue === "Graphics & effects", `${unread?.category} ${unreadEv?.toValue}`);
    const bf = read("scripts/_fix/oct16/revision-categories.ts");
    c.ok("the backfill is a dry run by default on a read-only connection, and writes through the same function", /process\.argv\.includes\("--apply"\)/.test(bf) && /default_transaction_read_only/.test(bf) && /recordCategorySuggestion\(/.test(bf) && !/category:\s*s\b|data:\s*\{\s*category/.test(bf));

    c.ok("nothing left the building", fence.blocked.length === 0, fence.blocked.join(" | "));
  } finally {
    console.error = realError;
    quiet.restore();
    c.summary();
    await drill.stop();
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
