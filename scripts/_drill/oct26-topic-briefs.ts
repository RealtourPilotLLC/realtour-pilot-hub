// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: WHAT THE AGENT SAID, IN THE OFFICE (Oct 26 2026).
//
// Jordan: "I want to see a summary of what the agent said about the topic or
// what they said for answered questions if they went that route." The hub
// writes, per chosen topic, the summary his ChatGPT used to write from the
// strategy call (lib/scriptWriter/topicBrief); the office reads and edits it.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-topic-briefs.ts --logs <dir>
//
//   1. currentBriefs: the newest row per topic, and the newest month header
//   2. the page data (programData.loadMonthBriefs, via loadTopicsTab and
//      loadScriptsTab): text, route, the call's date, the edited flag, every
//      chosen topic present (null while it has none), a topic off the month
//      absent, "Copy all" = monthBriefText of the month
//   3. saveTopicBriefEditAction: refused signed out, for an editor and for an
//      owner previewing; stores the office's wording (no em dash, "edited by
//      Kyle"), refuses an older row, and clears back to the AI's version;
//      Copy all carries the edit
//   4. buildTopicBriefsAction: refused the same way; a month with no chosen
//      topics, a topic off the month, "every summary is up to date" (no model
//      call), a duplicate press in plain words, and Summarize again on one
//      topic (the model faked): "Wrote 1 summary from the October 20 call."
//   5. rendered: the topic's fold (summary, source line, Edit, Summarize
//      again; "No summary yet." with Summarize the call; a topic the call
//      never covered says so), the script card's fold above the Writer's
//      notes, the Call summary card, and PlanTab leaving the card off a month
//      with no chosen topics
//   6. the words: no em or en dash, no dollar amount, in the new UI and actions
//
// ISOLATION: PGlite via the shared harness, AUTH_ENFORCE on, every outbound
// call fenced; the model is faked at aiStructuredWithUsage (the writer engine).
// The summaries are seeded as ContentTopicBrief rows; only step 4's
// Summarize again reaches the (fake) model.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, interceptModule, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 5611);
const REPO = path.resolve(__dirname, "../..");
installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => unknown };
navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {} });
interceptModule((r) => r === "next/server", (loaded) => ({ ...(loaded as Record<string, unknown>), after: () => {} }));
const fence = fenceFetch(async () => null);

// ---- the model: faked at aiStructuredWithUsage --------------------------------
const usage = { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 };
const briefPrompts: { system: string; prompt: string }[] = [];
let modelCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiStructuredWithUsage" && k !== "aiJsonWithUsage") return t[k];
      return async (opts: { system: string; prompt: string }) => {
        modelCalls++;
        if (!/You prepare the scripting brief/.test(opts.system)) throw new Error(`unexpected model call: ${opts.system.slice(0, 80)}`);
        briefPrompts.push(opts);
        const ids = [...opts.prompt.matchAll(/- SUMMARIZE \| id (\S+) \| "([^"]+)"/g)].map((m) => ({ id: m[1], title: m[2] }));
        return {
          result: {
            opening: "Marcee selected two videos during her October 20 strategy call, confirmed at 41:10.",
            mainRequest: "More about Malvern, \"the town people drive through\".",
            held: [{ title: "Open house etiquette", why: "She wants to film it in the spring.", ideas: ["Shoes on or off"] }],
            topics: ids.map((x) => ({
              topicId: x.id, title: x.title, discussed: true, audience: "Buyers", where: "12:04-18:30",
              summary: "FRESH: Marcee's point was that Malvern is the Main Line for less.", details: ["King Street on Saturday mornings"], examples: [], herWords: [], fromStrategist: [], notEstablished: [], overlap: null,
            })),
          },
          usage, model: "claude-opus-5-5", stopReason: "end_turn",
        };
      };
    },
  }),
);

/* eslint-disable @typescript-eslint/no-explicit-any */
type El = { $$typeof: symbol; type: any; key: string | null; props: Record<string, any> };
const isEl = (n: any): n is El => !!n && typeof n === "object" && "$$typeof" in n && "props" in n;
const typeName = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isEl(n)) return;
  visit(n);
  for (const v of Object.values(n.props)) if (v && typeof v === "object") walk(v, visit);
}
const find = (tree: any, name: string) => { const out: El[] = []; walk(tree, (e) => { if (typeName(e.type) === name) out.push(e); }); return out; };
/* eslint-enable @typescript-eslint/no-explicit-any */

const H = 3_600_000;

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct26-topic-briefs", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const { setSession, clearSession } = await import("@/lib/auth/session");
  const A = await import("@/app/content/actions");
  const { currentBriefs } = await import("@/lib/scriptWriter/topicBrief");
  const { monthBriefText, topicBriefText } = await import("@/lib/scriptWriter/briefFormat");
  type TopicBrief = import("@/lib/scriptWriter/briefFormat").TopicBrief;
  const { loadTopicsTab, loadScriptsTab, loadMonthBriefs } = await import("@/app/content/[id]/programData");
  const scripts = await import("@/lib/contentScripts");
  const { createPillar } = await import("@/lib/contentPillars");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { TopicsPanel } = await import("@/components/content/TopicsPanel");
  const { ScriptsPanel } = await import("@/components/content/ScriptsPanel");
  const { CallSummaryCard, TopicBriefFold } = await import("@/components/content/TopicBriefFold");
  const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&rsquo;/g, "’").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, " ").trim();
  const ser = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), "utf8");
  const foldOf = (html: string, key: string) => { const i = html.indexOf(`data-topic-brief="${key}"`); return i < 0 ? "" : html.slice(i, html.indexOf("</details>", i)); };

  try {
    // ==================================================================
    c.head("0 · the world: Marcee's October, two topics chosen on the October 20 call");
    const owner = await prisma.appUser.create({ data: { email: "jordan@oct26-tb.test", name: "Jordan", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { email: "kyle@oct26-tb.test", name: "Kyle", role: "ADMIN", status: "ACTIVE" } });
    const james = await prisma.appUser.create({ data: { email: "james@oct26-tb.test", name: "James", role: "CREATIVE_MANAGER", status: "ACTIVE" } });
    const editor = await prisma.appUser.create({ data: { email: "kim@oct26-tb.test", name: "Kim", role: "EDITOR", editorKey: "kim", status: "ACTIVE" } });
    const as = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    const M = await buildContentMonth(prisma, {
      name: "Marcee Briefs TEST", package: "Pro", project: false, owner: { email: "info+marcee-tb@realtourpilot.com", name: "Marcee Briefs TEST" },
      topics: [
        { title: "Malvern is underrated", selection: "SELECTED", source: "call" },
        { title: "Get pre-approved before you tour", selection: "SELECTED", source: "client" },
        { title: "A topic still in the bank", selection: null },
      ],
    });
    const [tA, tB, tC] = M.topicIds;
    const pillar = await createPillar({ enrollmentId: M.enrollmentId, clientId: M.clientId, name: "Local Life", createdBy: owner.email });
    await prisma.contentTopic.updateMany({ where: { id: { in: M.topicIds } }, data: { pillarId: pillar, approvalState: "APPROVED" } });
    await prisma.contentTopicSelection.updateMany({ where: { topicId: tB, monthId: M.monthId }, data: { answerRoute: "WRITTEN" } });
    const callAt = new Date("2026-10-20T16:00:00Z");
    const call = await prisma.programCallRecord.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, callType: "MONTHLY_STRATEGY", status: "COMPLETED", matchState: "MATCHED", monthId: M.monthId, targetMonthKey: M.monthKey, scheduledStart: callAt, scheduledEnd: new Date(callAt.getTime() + 75 * 60_000), transcriptState: "CONFIRMED" } });
    await prisma.programTranscriptSource.create({ data: { callRecordId: call.id, provider: "paste", contentHash: "drill-oct26-tb-1", matchState: "CONFIRMED", createdAt: new Date(Date.now() - 24 * H), text: [
      "Jordan: Tell me about Malvern.",
      "Marcee: Buyers drive right through Malvern, but King Street is packed on Saturday mornings.",
      "Jordan: Good, that's a video.",
    ].join("\n") } });
    await prisma.contentMonth.update({ where: { id: M.monthId }, data: { callRecordId: call.id, strategyCallStatus: "COMPLETED", strategyCallAt: callAt } });

    // The summaries, seeded as the writer stores them (no model call).
    const now = Date.now();
    const briefA: TopicBrief = {
      topicId: tA, title: "Malvern is underrated", discussed: true, audience: "Buyers", where: "12:04-18:30",
      summary: "Marcee's concern was that buyers write Malvern off as a town you drive through.\n\nHer point was that King Street on a Saturday morning sells it.",
      details: ["King Street on Saturday mornings", "The Paoli line into the city"],
      examples: [{ text: "A couple from Center City bought on Woodland Avenue last spring.", kind: "real" }],
      herWords: ["Malvern is the Main Line without the Main Line price"], fromStrategist: ["Film it walking down King Street (Jordan's idea)"], notEstablished: ["No sale price was given"], overlap: null,
    };
    const briefB: TopicBrief = {
      topicId: tB, title: "Get pre-approved before you tour", discussed: true, audience: "First-time buyers", where: "Written answers",
      summary: "In her written answers Marcee said first-time buyers fall for a house before they know their number.", details: ["Pre-approval takes a day with her lender"], examples: [], herWords: [], fromStrategist: [], notEstablished: [], overlap: null,
    };
    const row = (topicId: string | null, json: unknown, ago: number, extra: Record<string, unknown> = {}) => prisma.contentTopicBrief.create({ data: {
      enrollmentId: M.enrollmentId, clientId: M.clientId, monthId: M.monthId, topicId, route: "CALL", callRecordId: call.id, briefJson: JSON.stringify(json), createdBy: "drill", createdAt: new Date(now - ago), ...extra,
    } });
    const header = { opening: "Marcee selected two videos during her October 20 strategy call, confirmed at 41:10.", mainRequest: "More about Malvern, \"the town people drive through\".", held: [{ title: "Open house etiquette", why: "She wants to film it in the spring.", ideas: ["Shoes on or off"] }] };
    const oldHeader = await row(null, { opening: "OLD opening line", mainRequest: null, held: [] }, 3 * H);
    const newHeader = await row(null, header, 1 * H);
    const oldA = await row(tA, { ...briefA, summary: "OLD summary of Malvern." }, 3 * H);
    const newA = await row(tA, briefA, 1 * H);
    const rowB = await row(tB, briefB, 1 * H, { route: "WRITTEN", callRecordId: null });
    const pts = (a: string, b: string, d: string) => [{ role: "re-hook" as const, text: a }, { role: "build-up" as const, text: b }, { role: "payoff" as const, text: d }];
    const sA = await scripts.createScriptVersion({ enrollmentId: M.enrollmentId, monthId: M.monthId, topicId: tA, source: "AI", status: "INTERNAL_REVIEW", createdBy: "cron", parts: { title: "Malvern draft", hook: "Most buyers drive right through Malvern.", points: pts("They think it is quiet.", "King Street on Saturday says otherwise.", "The Main Line for less."), close: "Call me before you rule it out.", pillarId: pillar, categoryLabel: "Local Life" } });
    c.ok("seeded: two chosen topics, one in the bank, two header rows, two rows for Malvern, one written-answers row, a script on Malvern", !!sA.scriptId && (await prisma.contentTopicBrief.count({ where: { monthId: M.monthId } })) === 5);

    // ==================================================================
    c.head("1 · currentBriefs: the newest row per topic, and the newest header");
    const cur = await currentBriefs(M.monthId);
    c.ok("Malvern's current summary is the newer row, not the older", cur.byTopic.get(tA)?.id === newA.id && cur.byTopic.get(tA)?.id !== oldA.id && !/OLD summary/.test(cur.byTopic.get(tA)?.text ?? ""));
    c.ok("…the written-answers topic has its row, route WRITTEN", cur.byTopic.get(tB)?.id === rowB.id && cur.byTopic.get(tB)?.route === "WRITTEN");
    c.ok("the header is the newer one (opening, main request, held)", cur.header?.id === newHeader.id && cur.header?.id !== oldHeader.id && cur.header?.header?.opening === header.opening && cur.header?.header?.held[0]?.title === "Open house etiquette");
    c.ok("…no topic in the bank has one, and nothing is edited yet", !cur.byTopic.has(tC) && [...cur.byTopic.values()].every((r) => !r.edited));

    // ==================================================================
    c.head("2 · the page data: text, route, the call's date, the edited flag, Copy all");
    await as(owner);
    const d = await loadTopicsTab(M.enrollmentId, { id: M.monthId, monthKey: M.monthKey });
    const b = d.briefs!;
    c.ok("the topics tab carries the month's summaries: both chosen topics, in their order", !!b && b.monthId === M.monthId && b.chosenIds.join() === [tA, tB].join(), JSON.stringify(b?.chosenIds));
    c.ok("Malvern: the newest text, from the call, dated October 20, not edited", b.byTopic[tA]?.briefId === newA.id && b.byTopic[tA]?.text === topicBriefText(briefA) && b.byTopic[tA]?.route === "CALL" && b.byTopic[tA]?.callDate === "October 20" && b.byTopic[tA]?.edited === false && b.byTopic[tA]?.discussed === true, JSON.stringify(b.byTopic[tA]));
    c.ok("pre-approval: from the written answers, no call date", b.byTopic[tB]?.route === "WRITTEN" && b.byTopic[tB]?.callDate === null && /fall for a house before they know their number/.test(b.byTopic[tB]?.text ?? ""));
    c.ok("a topic in the bank is not listed (no fold for it)", !(tC in b.byTopic));
    c.ok("the header: opening, main request, held for later, and its call's date", b.header?.opening === header.opening && b.header?.mainRequest === header.mainRequest && b.header?.held[0]?.title === "Open house etiquette" && b.header?.callDate === "October 20");
    const fullMonth = monthBriefText({ ...header, topics: [briefA, briefB] });
    c.ok("Copy all is the month in Jordan's layout (monthBriefText), topics numbered in order", b.copyText === fullMonth, (b.copyText ?? "").slice(0, 200));
    const sd = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
    const sRow = sd.scripts.find((s) => s.id === sA.scriptId);
    c.ok("the scripts tab: Malvern's script carries Malvern's summary", sRow?.brief?.briefId === newA.id && sRow?.brief?.text === topicBriefText(briefA));
    c.ok("no model call reading any of it", modelCalls === 0);

    // ==================================================================
    c.head("3 · Edit: who may, what is stored, back to the AI's version");
    await clearSession();
    const anon = await A.saveTopicBriefEditAction(newA.id, "signed out words");
    await as(editor);
    const ed = await A.saveTopicBriefEditAction(newA.id, "editor words");
    await as(owner, admin.id);
    const pv = await A.saveTopicBriefEditAction(newA.id, "preview words");
    c.ok("signed out, an editor, and an owner previewing as Kyle: all refused", !anon.ok && !ed.ok && /access/i.test(ed.message) && !pv.ok && /previewing/i.test(pv.message), `${anon.message} | ${ed.message} | ${pv.message}`);
    c.ok("…in plain words (no dash in the refusal)", ![anon, ed, pv].some((r) => /[—–]/.test(r.message)), pv.message);
    c.ok("…and nothing was stored", (await prisma.contentTopicBrief.findUniqueOrThrow({ where: { id: newA.id } })).editedText === null);
    await as(admin);
    const edited = "Malvern is underrated\n\nMarcee says — buyers miss King Street on a Saturday.\n* The Paoli line";
    const saved = await A.saveTopicBriefEditAction(newA.id, edited);
    const afterSave = await prisma.contentTopicBrief.findUniqueOrThrow({ where: { id: newA.id } });
    c.ok("Kyle saves his wording: ok, \"Saved your wording.\"", saved.ok && saved.message === "Saved your wording.", saved.message);
    c.ok("…stored with no em dash, by Kyle", afterSave.editedText === "Malvern is underrated\n\nMarcee says, buyers miss King Street on a Saturday.\n* The Paoli line" && afterSave.editedBy === "Kyle" && !!afterSave.editedAt, JSON.stringify(afterSave.editedText));
    const b2 = await loadMonthBriefs(M.monthId);
    c.ok("the page reads it: edited, edited by Kyle, his text", b2.byTopic[tA]?.edited === true && b2.byTopic[tA]?.editedBy === "Kyle" && b2.byTopic[tA]?.text === afterSave.editedText);
    c.ok("Copy all carries his wording for Malvern, numbered, the rest unchanged", (b2.copyText ?? "").includes(`1. ${afterSave.editedText}`) && (b2.copyText ?? "").includes(topicBriefText(briefB, 2)) && !(b2.copyText ?? "").includes("Marcee's concern was"), (b2.copyText ?? "").slice(0, 300));
    const stale = await A.saveTopicBriefEditAction(oldA.id, "editing the old one");
    c.ok("editing an older summary is refused (a newer one is current)", !stale.ok && /A newer summary was written/.test(stale.message) && (await prisma.contentTopicBrief.findUniqueOrThrow({ where: { id: oldA.id } })).editedText === null, stale.message);
    const back = await A.saveTopicBriefEditAction(newA.id, "");
    const afterBack = await prisma.contentTopicBrief.findUniqueOrThrow({ where: { id: newA.id } });
    c.ok("empty text: \"Back to the AI's version.\", the edit cleared", back.ok && back.message === "Back to the AI's version." && afterBack.editedText === null && afterBack.editedBy === null, back.message);
    c.ok("…the page reads the AI's summary again", (await loadMonthBriefs(M.monthId)).byTopic[tA]?.edited === false && (await loadMonthBriefs(M.monthId)).byTopic[tA]?.text === topicBriefText(briefA));
    const again = await A.saveTopicBriefEditAction(newA.id, "");
    c.ok("…pressing it again changes nothing", again.ok && /already the AI/.test(again.message));
    await as(james);
    const jb = await A.saveTopicBriefEditAction(rowB.id, "Get pre-approved before you tour\n\nMarcee: know your number before you fall for a house.");
    c.ok("the creative manager (James) may edit too", jb.ok && (await prisma.contentTopicBrief.findUniqueOrThrow({ where: { id: rowB.id } })).editedBy === "James");
    c.ok("the guard is the creative-lead guard on both actions", ["buildTopicBriefsAction", "saveTopicBriefEditAction"].every((fn) => new RegExp(`export async function ${fn}[\\s\\S]{0,200}requireCreativeLead\\(\\)`).test(read("src/app/content/actions.ts"))));

    // ==================================================================
    c.head("4 · Summarize the call: refusals, nothing to do, and Summarize again");
    await clearSession();
    const bAnon = await A.buildTopicBriefsAction(M.monthId);
    await as(editor);
    const bEd = await A.buildTopicBriefsAction(M.monthId);
    await as(owner, admin.id);
    const bPv = await A.buildTopicBriefsAction(M.monthId, [tA], true);
    c.ok("signed out, an editor, an owner previewing: refused, no model call", !bAnon.ok && !bEd.ok && !bPv.ok && /previewing/i.test(bPv.message) && !/[—–]/.test(bPv.message) && modelCalls === 0, `${bEd.message} | ${bPv.message}`);
    await as(owner);
    const empty = await prisma.contentMonth.create({ data: { enrollmentId: M.enrollmentId, clientId: M.clientId, monthKey: "2026-11", videosOwed: 4, status: "OPEN" } });
    const none = await A.buildTopicBriefsAction(empty.id);
    c.ok("a month with no chosen topics: \"No topics are chosen for this month yet.\"", !none.ok && none.message === "No topics are chosen for this month yet.", none.message);
    const offMonth = await A.buildTopicBriefsAction(M.monthId, [tC], true);
    c.ok("a topic that isn't on the month: refused, reload", !offMonth.ok && /isn't one of this month's picks/.test(offMonth.message), offMonth.message);
    const upToDate = await A.buildTopicBriefsAction(M.monthId);
    c.ok("every summary newer than the call: \"Nothing new to summarize: every topic's summary is up to date.\" (no model call)", upToDate.ok && upToDate.message === "Nothing new to summarize: every topic's summary is up to date." && modelCalls === 0, upToDate.message);
    const blocker = await prisma.programAiRun.create({ data: { kind: "script_brief", promptKey: "script.topic_brief", status: "RUNNING", attempts: 1, requestedBy: "kyle@oct26-tb.test", startedAt: new Date(), leaseUntil: new Date(Date.now() + 10 * 60_000), leaseBy: "kyle@oct26-tb.test", dedupeKey: `topic-brief:${M.monthId}` } });
    const dup = await A.buildTopicBriefsAction(M.monthId, [tA], true);
    c.ok("a second press while one is running: \"That summary is already being written. Give it a moment.\"", !dup.ok && dup.message === "That summary is already being written. Give it a moment." && modelCalls === 0, dup.message);
    await prisma.programAiRun.update({ where: { id: blocker.id }, data: { status: "SUCCEEDED", dedupeKey: null, leaseUntil: null } });
    const fresh = await A.buildTopicBriefsAction(M.monthId, [tA], true);
    c.ok("Summarize again on Malvern: \"Wrote 1 summary from the October 20 call.\"", fresh.ok && fresh.message === "Wrote 1 summary from the October 20 call.", fresh.message);
    c.ok("…one model call, asked for Malvern only (the other topic listed so it can say how they differ)", modelCalls === 1 && new RegExp(`- SUMMARIZE \\| id ${tA} `).test(briefPrompts[0]?.prompt ?? "") && new RegExp(`- listed \\| id ${tB} `).test(briefPrompts[0]?.prompt ?? "") && /Buyers drive right through Malvern/.test(briefPrompts[0]?.prompt ?? ""));
    const b3 = await loadMonthBriefs(M.monthId);
    c.ok("…the new summary is current on the page; the written-answers edit is untouched", /FRESH: Marcee's point/.test(b3.byTopic[tA]?.text ?? "") && b3.byTopic[tA]?.briefId !== newA.id && b3.byTopic[tB]?.edited === true && b3.byTopic[tB]?.editedBy === "James");
    const strip = (s: string) => s.replace(/\s*[—–]\s*/g, ", ");
    c.ok("every answer here is in plain words (no em or en dash)", [bAnon, bEd, bPv, none, offMonth, upToDate, dup, fresh, saved, stale, back].every((r) => r.message === strip(r.message)));

    // ==================================================================
    c.head("5 · rendered: the topic's fold, the script card's fold, the Call summary card");
    const d5 = await loadTopicsTab(M.enrollmentId, { id: M.monthId, monthKey: M.monthKey });
    const monthUi = { id: M.monthId, label: "October 2026", short: "October", key: M.monthKey };
    const panelProps = { enrollmentId: M.enrollmentId, month: monthUi, capacity: d5.capacity, groups: d5.groups, proposed: d5.proposed, monthTopics: d5.monthTopics, suggestions: d5.suggestions, recommended: d5.recommended, runs: d5.runs, interviews: d5.interviews, histories: d5.histories, pillars: d5.pillars, topicsPerPillar: d5.topicsPerPillar, isOwner: true, archivedCount: d5.archivedCount, declined: d5.declined, stock: d5.stock, held: d5.held, drafts: d5.drafts, queueActive: d5.queueActive, videoStyle: d5.videoStyle, skitsPerMonth: d5.skitsPerMonth };
    const html = renderToStaticMarkup(createElement(TopicsPanel, ser({ ...panelProps, briefs: d5.briefs!.byTopic, clientFirst: "Marcee" })));
    const fA = foldOf(html, tA), fB = foldOf(html, tB);
    c.ok("Malvern's row has the fold, \"What Marcee said\", closed", /^data-topic-brief="[^"]+" data-brief-id="[^"]+" class="[^"]*">/.test(fA) && /<summary[^>]*>What Marcee said<\/summary>/.test(fA.replace(/<!-- -->/g, "")) && !/^[^>]* open/.test(fA), fA.slice(0, 200));
    c.ok("…the summary itself, paragraphs kept (whitespace-pre-wrap), bullets as dots", /whitespace-pre-wrap/.test(fA) && text(fA).includes("FRESH: Marcee's point was that Malvern is the Main Line for less.") && text(fA).includes("• King Street on Saturday mornings"), text(fA));
    c.ok("…the topic's title is not repeated inside it", !text(fA).includes("What Marcee said Malvern is underrated"));
    c.ok("…\"From the October 20 call\", Edit and Summarize again", text(fA).includes("From the October 20 call") && />(<svg[\s\S]*?<\/svg>)?Edit<\/button>/.test(fA) && /Summarize again<\/button>/.test(fA), text(fA));
    c.ok("the written-answers topic: \"From Marcee's written answers, edited by James\", his wording shown", text(fB).includes("From Marcee's written answers, edited by James") && text(fB).includes("Marcee: know your number before you fall for a house."), text(fB));
    c.ok("a topic in the bank has no fold", !html.includes(`data-topic-brief="${tC}"`));
    const noneHtml = renderToStaticMarkup(createElement(TopicsPanel, ser({ ...panelProps, briefs: { ...d5.briefs!.byTopic, [tB]: null }, clientFirst: "Marcee" })));
    const fNone = foldOf(noneHtml, tB);
    c.ok("a chosen topic with none yet: \"No summary yet.\" and Summarize the call (the summary line says so too)", text(fNone).includes("What Marcee said · no summary yet") && text(fNone).includes("No summary yet.") && /Summarize the call<\/button>/.test(fNone) && !/Edit<\/button>/.test(fNone), text(fNone));
    const undiscussed = { ...d5.briefs!.byTopic[tA]!, discussed: false, text: "Malvern is underrated\n\nNot discussed on the call and no written answers yet." };
    const fU = foldOf(renderToStaticMarkup(createElement(TopicsPanel, ser({ ...panelProps, briefs: { ...d5.briefs!.byTopic, [tA]: undiscussed }, clientFirst: "Marcee" }))), tA);
    c.ok("a topic the call never covered says so plainly", text(fU).includes("Marcee didn’t talk about this topic on the call, and there are no written answers for it yet.") && !text(fU).includes("Not discussed on the call"), text(fU));
    const oldCaller = renderToStaticMarkup(createElement(TopicsPanel, ser(panelProps)));
    c.ok("a caller that passes no summaries draws no fold (the bank and old pages unchanged)", !oldCaller.includes("data-topic-brief"));

    const sd5 = await loadScriptsTab(M.enrollmentId, { id: M.monthId });
    const sHtml = renderToStaticMarkup(createElement(ScriptsPanel, ser({ enrollmentId: M.enrollmentId, scripts: sd5.scripts, queueCount: sd5.queueCount, scriptOwner: sd5.scriptOwner, owed: [], revising: sd5.revising, drafting: sd5.drafting, queueActive: sd5.queueActive, questionRequests: sd5.questionRequests, clientFirst: "Marcee" })));
    const cardAt = sHtml.indexOf(`data-script-card="${sA.scriptId}"`);
    const card = cardAt < 0 ? "" : sHtml.slice(cardAt);
    const briefAt = card.indexOf("data-topic-brief"), notesAt = card.indexOf("data-writer-notes");
    const cardFold = briefAt < 0 ? "" : card.slice(briefAt, card.indexOf("</details>", briefAt));
    c.ok("the script card: \"What Marcee said\" with the summary, just above the Writer's notes", briefAt > 0 && notesAt > briefAt && text(cardFold).includes("What Marcee said") && text(cardFold).includes("FRESH: Marcee's point was that Malvern is the Main Line for less.") && text(cardFold).includes("From the October 20 call"), text(cardFold));
    c.ok("…read and Edit only: no model call from the card", /Edit<\/button>/.test(cardFold) && !/Summarize/.test(cardFold));
    c.ok("…and the Writer's notes fold is still the last thing on the card", (card.match(/data-writer-notes/g) ?? []).length === 1);

    const cardHtml = renderToStaticMarkup(createElement(CallSummaryCard, ser({ monthId: M.monthId, clientFirst: "Marcee", briefs: d5.briefs! })));
    c.ok("the Call summary card: the opening line, the main request, held for later", text(cardHtml).includes("Call summary") && text(cardHtml).includes(header.opening) && text(cardHtml).includes(`Main request: ${header.mainRequest}`) && text(cardHtml).includes("Held for later") && /Open house etiquette ?: She wants to film it in the spring\./.test(text(cardHtml)), text(cardHtml));
    c.ok("…Copy all and Summarize the call", /Copy all<\/button>/.test(cardHtml) && /Summarize the call<\/button>/.test(cardHtml));
    c.ok("…and where to read each one", text(cardHtml).includes("Every topic is summarized. Each one is under its topic below, in \"What Marcee said\"."), text(cardHtml));
    const halfHtml = renderToStaticMarkup(createElement(CallSummaryCard, ser({ monthId: M.monthId, clientFirst: "Marcee", briefs: { ...d5.briefs!, header: null, byTopic: { [tA]: null, [tB]: null }, copyText: null } })));
    c.ok("with nothing yet: \"No summary yet.\" and no Copy all", text(halfHtml).includes("No summary yet. Summarize the call to see what Marcee said about each topic.") && !/Copy all/.test(halfHtml), text(halfHtml));
    const lone = renderToStaticMarkup(createElement(TopicBriefFold, ser({ topicId: tA, monthId: M.monthId, brief: d5.briefs!.byTopic[tA], clientFirst: "Marcee" })));
    c.ok("the fold on its own renders the same summary", text(lone).includes("FRESH: Marcee's point"));

    // PlanTab: the card above the topics, never on a month with no chosen topics.
    const { PlanTab } = await import("@/app/content/[id]/tabs/PlanTab");
    const client = { id: M.clientId, name: "Marcee Briefs TEST", email: null, phone: null, company: null, generalNotes: null, editingPreferences: null };
    const monthRow = await prisma.contentMonth.findUniqueOrThrow({ where: { id: M.monthId } });
    const ctxFor = (month: typeof monthRow) => ({ id: M.enrollmentId, client, enrollment: { package: "Pro", status: "ACTIVE", videosPerMonth: 4, sessionsPerMonth: 1, strategyCallRequired: true, portalToken: null }, months: [month], month, activeKey: month.monthKey, view: "topics", progress: null, me: { id: owner.id, role: "OWNER", name: "Jordan" }, ownerEyes: true, staffEyes: true, officeEyes: true });
    const tree = await PlanTab({ ctx: ctxFor(monthRow) as never, badges: {} });
    const cards = find(tree, "CallSummaryCard");
    const panels = find(tree, "TopicsPanel");
    c.ok("PlanTab › Topics: the Call summary card for October, with Marcee's first name", cards.length === 1 && cards[0].props.monthId === M.monthId && cards[0].props.clientFirst === "Marcee" && cards[0].props.briefs.chosenIds.length === 2);
    c.ok("…and the topics get their summaries and the first name", panels.length === 1 && panels[0].props.clientFirst === "Marcee" && !!panels[0].props.briefs?.[tA]);
    const emptyTree = await PlanTab({ ctx: ctxFor(await prisma.contentMonth.findUniqueOrThrow({ where: { id: empty.id } })) as never, badges: {} });
    c.ok("a month with no chosen topics: no Call summary card", find(emptyTree, "CallSummaryCard").length === 0 && find(emptyTree, "TopicsPanel").length === 1);
    const scriptsTree = await PlanTab({ ctx: { ...ctxFor(monthRow), view: "scripts" } as never, badges: {} });
    c.ok("PlanTab › Scripts hands the script cards the first name", find(scriptsTree, "ScriptsPanel")[0]?.props.clientFirst === "Marcee");

    // ==================================================================
    c.head("6 · the words");
    const fold = read("src/components/content/TopicBriefFold.tsx");
    const acts = read("src/app/content/actions.ts");
    const block = acts.slice(acts.indexOf("// WHAT THE AGENT SAID, PER TOPIC (Oct 26 2026)"));
    const loader = read("src/app/content/[id]/programData.ts");
    const loaderBlock = loader.slice(loader.indexOf("// WHAT THE AGENT SAID, PER TOPIC"), loader.indexOf("export async function loadTopicsTab"));
    c.ok("no em or en dash in the new UI, actions or loader (code and comments)", ![fold, block.replace(/\[—–\]/g, ""), loaderBlock].some((s) => /[—–]/.test(s)), (/.{0,40}[—–].{0,40}/.exec(fold + block.replace(/\[—–\]/g, "") + loaderBlock) ?? [""])[0]);
    c.ok("no dollar amount in them", ![fold, block, loaderBlock].some((s) => /\$\d/.test(s)));
    c.ok("no dash in anything the new folds and the card drew", ![fA, fB, fNone, fU, cardFold, cardHtml, halfHtml].some((h) => /[—–]/.test(text(h))), (/.{0,40}[—–].{0,40}/.exec([fA, fB, fNone, fU, cardFold, cardHtml].map(text).join(" | ")) ?? [""])[0]);
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
