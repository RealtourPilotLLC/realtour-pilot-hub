// ---------------------------------------------------------------------------
// DRILL: THE ANTHROPIC SPEND FIXES (Oct 22 2026).
//
//   1. the Slack router decides each message ONCE across many 5-minute polls,
//      whatever the outcome (new card, added to an existing card, no action,
//      rolled into a running card); the same "Update:" line never lands twice;
//      a card a person closed is not re-opened by a message already handled;
//      a message another worker is deciding holds the cursor until it is
//      decided, and a stale claim is taken over; an EDITED message is asked
//      about once more, and only once (an edit to a message that has its own
//      card is noted on that card, no AI);
//   2. mergeIntoExistingTask({ keepClosed }) refuses a closed card;
//   3. the usage ledger records feature / model / tokens / cost for each
//      call, merges concurrent writes without losing one, prices each model
//      from the table, and never throws or slows the call when its store
//      fails or hangs;
//   4. the owner's AI spend card: only the owner (not Kyle, not the owner
//      previewing Kyle, not signed out); the total is the ledger plus the
//      content program's and photo QC's own run costs from BEFORE the ledger
//      began, nothing counted twice;
//   5. client profiles: rebuilt only when something new arrived since the
//      last build (a message, a job, feedback, a revision...), never on age
//      alone.
//
// ISOLATION: PGlite via the shared harness. Anthropic and Slack are faked at
// fetch; nothing else leaves (asserted at the end). The card is rendered for
// real (its icons need the client React), so it runs like the other Finance
// drills: without the react-server condition, server-only neutralised.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { isValidElement } from "react";

installNextStubs();
const PORT = Number(process.env.DRILL_PORT ?? 7723);

// ---- the fakes ---------------------------------------------------------------
type SlackDecision = { actionable: boolean; title?: string; mergeIntoTaskId?: string | null };
/** Slack router answers, by a phrase in the message. */
const slackAnswers: { match: string; answer: () => SlackDecision }[] = [];
const calls = { slack: 0, todo: 0, profile: 0, json: 0, other: 0 };
const askedSlack: string[] = [];
const channelMsgs: { ts: string; user: string; text: string; edited?: { user: string; ts: string } }[] = [];

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const USAGE = { input_tokens: 1000, output_tokens: 100 };
const PROFILE = {
  summary: "A steady client.", touchLevel: "low", workingStyle: "", communication: "", revisions: { summary: "", commonTypes: [] },
  brandStyle: "", shootNotes: [], aboutThem: [], dos: [], donts: [], editing: { summary: "", prefs: [], customerNotes: [], dos: [], donts: [] },
};

function anthropic(init?: RequestInit): Response {
  const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; system?: unknown; messages?: { content: unknown }[]; tools?: unknown[] };
  const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
  const user = typeof body.messages?.[0]?.content === "string" ? (body.messages[0].content as string) : JSON.stringify(body.messages?.[0]?.content ?? "");
  const model = body.model ?? "claude-sonnet-4-6";
  const text = (t: string) => json({ model, content: [{ type: "text", text: t }], usage: USAGE, stop_reason: "end_turn" });
  if (system.includes("internal Slack messages")) {
    calls.slack++;
    const msg = /New Slack message from [^\n]*:\n"""\n([\s\S]*?)\n"""/.exec(user)?.[1] ?? "";
    askedSlack.push(msg);
    const a = slackAnswers.find((x) => msg.includes(x.match))?.answer() ?? { actionable: false };
    return text(JSON.stringify({ actionable: a.actionable, title: a.title ?? "Follow up", detail: "", priority: "MEDIUM", clientId: null, projectId: null, mergeIntoTaskId: a.mergeIntoTaskId ?? null, flags: [], reason: "drill" }));
  }
  if (system.includes("working profile")) { calls.profile++; return text(JSON.stringify(PROFILE)); }
  if (user.includes("Summarize it into ONE specific action item")) { calls.todo++; return text(JSON.stringify({ title: "Do the thing", detail: "" })); }
  if (Array.isArray(body.tools) && body.tools.length) {
    calls.json++;
    return json({ model, content: [{ type: "tool_use", id: "t1", name: "emit", input: { ok: true } }], usage: USAGE, stop_reason: "tool_use" });
  }
  calls.other++;
  return text("Polished.");
}

function slack(url: string): Response {
  const u = new URL(url);
  const method = u.pathname.replace("/api/", "");
  if (method === "auth.test") return json({ ok: true });
  if (method === "users.list") return json({ ok: true, members: [{ id: "UKYLE", profile: { display_name: "Kyle Smith" } }] });
  if (method === "conversations.list") {
    const types = u.searchParams.get("types") ?? "";
    return json({ ok: true, channels: types.includes("public_channel") ? [{ id: "CTRACK", name: "project-tracker", is_member: true }] : [] });
  }
  if (method === "conversations.history") {
    const oldest = Number(u.searchParams.get("oldest") ?? 0);
    return json({ ok: true, messages: channelMsgs.filter((m) => Number(m.ts) > oldest).map((m) => ({ ...m })).reverse(), response_metadata: { next_cursor: "" } });
  }
  return json({ ok: false, error: "unknown_method" });
}

async function main() {
  const db = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct22-ai-spend" } });
  const quiet = quietPrismaErrors();
  const fence = fenceFetch(async (url, init) => {
    if (url.startsWith("https://api.anthropic.com/")) return anthropic(init);
    if (url.startsWith("https://slack.com/api/")) return slack(url);
    return null;
  });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { syncSlackHistory, slackRoutedKey } = await import("@/lib/integrations/slackSync");
    const { mergeIntoExistingTask } = await import("@/lib/tasks");
    const usage = await import("@/lib/aiUsage");
    const ai = await import("@/lib/integrations/ai");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const { refreshStaleClientProfiles, latestProfileNews } = await import("@/lib/clientProfile");
    const { AiSpendCard } = await import("@/components/finance/AiSpendCard");
    const { etDayKey } = await import("@/lib/datetime");
    await saveSecret("ai", "isolated-fake-anthropic-key");
    await saveSecret("slack_user", "xoxp-isolated-fake");

    // =======================================================================
    c.head("1 · the Slack router decides each message once");
    // =======================================================================
    const JORDAN = "U07D2KJH1JP"; // the literal fallback: no roster in this database
    const base = Math.floor(Date.now() / 1000) - 600;
    const ts = (i: number) => (base + i * 5).toFixed(6);
    const card = (data: { title: string; contactName?: string | null; description?: string | null }) =>
      prisma.smartTask.create({ data: { taskType: "internal_instruction", source: "slack", status: "OPEN", assignedKey: null, ...data } });
    // An open card the router adds to; one a pre-memory router already added
    // M5 to; and Kyle's running card the consolidation rolls into.
    const X = await card({ title: "Oak Street floor plan", contactName: "Office" });
    const M5_TEXT = "Can you confirm the Birch Road shoot time";
    const X2 = await card({ title: "Birch Road shoot time", contactName: "Office", description: `Original ask\n\nUpdate: ${M5_TEXT}` });
    const R = await card({ title: "Kyle's asks", contactName: "Kyle Smith" });
    // …and a person has closed that Birch Road card since.
    await prisma.smartTask.update({ where: { id: X2.id }, data: { status: "COMPLETED", completedAt: new Date() } });

    slackAnswers.push(
      { match: "Smith photos", answer: () => ({ actionable: true, title: "Send the Smith photos" }) },
      { match: "Oak Street", answer: () => ({ actionable: true, title: "Add the Oak Street floor plan", mergeIntoTaskId: X.id }) },
      { match: "I will send it later", answer: () => ({ actionable: false }) },
      { match: "twilight edit", answer: () => ({ actionable: true, title: "Fix the Maple Ave twilight edit" }) },
      { match: "Birch Road", answer: () => ({ actionable: true, title: "Confirm the Birch Road time", mergeIntoTaskId: X2.id }) },
      { match: "Cedar Lane", answer: () => ({ actionable: true, title: "Upload the Cedar Lane reel" }) },
    );
    channelMsgs.push(
      { ts: ts(0), user: JORDAN, text: "Can you send the Smith photos to the client today" },        // M1 → new card
      { ts: ts(1), user: JORDAN, text: "Please add the floor plan to the Oak Street order" },        // M2 → merged into X
      { ts: ts(2), user: "UKYLE", text: "ok I will send it later" },                                 // M3 → no action
      { ts: ts(3), user: "UKYLE", text: "Also need to fix the twilight edit for Maple Ave" },        // M4 → rolled into R
      { ts: ts(4), user: JORDAN, text: M5_TEXT },                                                    // M5 → already on X2 (closed)
      { ts: ts(5), user: "UKYLE", text: "Please upload the Cedar Lane reel" },                       // M6 → another worker holds it
    );
    // M6: the real-time webhook is deciding it right now (a fresh claim).
    const m6Key = slackRoutedKey("CTRACK", ts(5));
    await prisma.appSetting.create({ data: { key: m6Key, value: JSON.stringify({ s: "asking", h: "webhook", at: Date.now(), e: 0 }) } });

    const tick = () => syncSlackHistory({ sinceHours: 1 });
    const updateLines = async (id: string, line: string) => ((await prisma.smartTask.findUnique({ where: { id } }))?.description ?? "").split(line).length - 1;
    const cursor = async () => (await prisma.appSetting.findUnique({ where: { key: "slack-sync:cursor:CTRACK" } }))?.value ?? null;

    const r1 = await tick();
    c.ok("first poll: four messages asked about, one each (M5 is already on a card, M6 is someone else's)", calls.slack === 4 && !askedSlack.some((m) => m.includes("Cedar Lane") || m.includes("Birch Road")), JSON.stringify({ calls, r1 }));
    const m1Card = await prisma.smartTask.findUnique({ where: { dedupeKey: `slack-${ts(0)}` } });
    c.ok("M1 became its own card", !!m1Card && m1Card.title === "Send the Smith photos");
    c.ok("M2 was added to the Oak Street card once", (await updateLines(X.id, "Update: Please add the floor plan")) === 1);
    c.ok("M4 rolled into Kyle's running card", ((await prisma.smartTask.findUnique({ where: { id: R.id } }))?.description ?? "").includes("Fix the Maple Ave twilight edit"));
    const x2Now = await prisma.smartTask.findUnique({ where: { id: X2.id } });
    c.ok("M5 (added before the hub remembered, card closed since): not asked, not re-opened, no twin card", x2Now?.status === "COMPLETED" && (await updateLines(X2.id, `Update: ${M5_TEXT}`)) === 1 && !(await prisma.smartTask.findUnique({ where: { dedupeKey: `slack-${ts(4)}` } })));
    c.ok("the cursor waits behind M6 while another worker decides it", (await cursor()) === ts(4), String(await cursor()));
    const memo = async (i: number) => JSON.parse((await prisma.appSetting.findUnique({ where: { key: slackRoutedKey("CTRACK", ts(i)) } }))?.value ?? "{}");
    const outcomes = await Promise.all([0, 1, 2, 3, 4].map(memo));
    c.ok("every decision is remembered, whatever it was", outcomes.map((o) => `${o.s}:${o.o}`).join(",") === "done:created,done:merged,done:no_action,done:rolled,done:merged", JSON.stringify(outcomes));

    // A person closes the Oak Street card; M2 is still inside the overlap.
    await prisma.smartTask.update({ where: { id: X.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    await tick();
    await tick();
    c.ok("two more polls: not one more AI call (all inside the 2-minute overlap)", calls.slack === 4, JSON.stringify(calls));
    const xNow = await prisma.smartTask.findUnique({ where: { id: X.id } });
    c.ok("the closed card stays closed, with M2's line on it once", xNow?.status === "COMPLETED" && (await updateLines(X.id, "Update: Please add the floor plan")) === 1);
    c.ok("no second card for M1, nothing more rolled into Kyle's card", (await prisma.smartTask.count({ where: { source: "slack" } })) === 4 && ((await prisma.smartTask.findUnique({ where: { id: R.id } }))?.description ?? "").split("Fix the Maple Ave").length === 2);

    // The webhook's claim goes stale (it crashed): the poll takes it over once.
    await prisma.appSetting.update({ where: { key: m6Key }, data: { value: JSON.stringify({ s: "asking", h: "webhook", at: Date.now() - 10 * 60_000, e: 0 }) } });
    await tick();
    c.ok("a stale claim is taken over and M6 is asked about once", calls.slack === 5 && askedSlack.filter((m) => m.includes("Cedar Lane")).length === 1);
    c.ok("…and the cursor moves past it", (await cursor()) === ts(5));
    await tick();
    await tick();
    c.ok("six polls in all: five AI calls for six messages (one was decided before)", calls.slack === 5 && calls.todo === 0, JSON.stringify(calls));

    // Edits. M1 has its own card: noted there, no AI. M3 (no action) is asked once more.
    channelMsgs[0] = { ...channelMsgs[0], text: "Can you send the Smith photos to the client today, the drone ones too", edited: { user: JORDAN, ts: ts(9) } };
    channelMsgs[2] = { ...channelMsgs[2], text: "ok I will send it later, actually can you send the Elm St photos to Joe", edited: { user: "UKYLE", ts: ts(9) } };
    await tick();
    c.ok("an edited message is asked about once more (M3), an edit to a carded message is not (M1)", calls.slack === 6 && askedSlack[askedSlack.length - 1].includes("Elm St"), JSON.stringify(calls));
    c.ok("M1's edit is noted on its own card", (await updateLines(m1Card!.id, "Edited in Slack: Can you send the Smith photos to the client today, the drone ones too")) === 1);
    channelMsgs[2] = { ...channelMsgs[2], text: "ok I will send it later, actually can you send the Elm St photos to Joe now" };
    channelMsgs[0] = { ...channelMsgs[0], text: "Can you send the Smith photos to the client today, the drone ones too please" };
    await tick();
    await tick();
    c.ok("a second edit is not asked about again", calls.slack === 6, JSON.stringify(calls));
    c.ok("…and M1's card gets no second edit note", (await updateLines(m1Card!.id, "Edited in Slack:")) === 1);

    // The webhook path: a message it already decided is refused without AI.
    const { maybeCreateSlackTask } = await import("@/lib/integrations/slackSync");
    const again = await maybeCreateSlackTask({ text: channelMsgs[1].text, ts: ts(1), channel: "CTRACK", senderName: "Jordan" });
    c.ok("the real-time webhook path refuses a decided message without asking", again === false && calls.slack === 6);

    // =======================================================================
    c.head("2 · a closed card is never re-opened by keepClosed");
    // =======================================================================
    const closed = await card({ title: "Done already" });
    await prisma.smartTask.update({ where: { id: closed.id }, data: { status: "COMPLETED", completedAt: new Date() } });
    const refused = await mergeIntoExistingTask(closed.id, { title: "More", snippet: "more" }, { keepClosed: true });
    const after = await prisma.smartTask.findUnique({ where: { id: closed.id } });
    c.ok("keepClosed: the merge is refused, the card stays COMPLETED and unchanged", !refused && after?.status === "COMPLETED" && !after.description);
    const openOne = await card({ title: "Still open" });
    c.ok("keepClosed still merges into an open card", await mergeIntoExistingTask(openOne.id, { title: "Still open", snippet: "more detail" }, { keepClosed: true }));

    // =======================================================================
    c.head("3 · the usage ledger");
    // =======================================================================
    await usage.flushAiUsage();
    const today = etDayKey(new Date());
    const yesterday = etDayKey(new Date(Date.now() - 86_400_000));
    const rows = await usage.readAiUsage(yesterday, today);
    const slot = (feature: string, model: string) => rows.filter((r) => r.feature === feature && r.model === model).reduce((a, r) => ({ calls: a.calls + r.calls, in: a.in + r.inputTokens, out: a.out + r.outputTokens, usd: a.usd + r.usd }), { calls: 0, in: 0, out: 0, usd: 0 });
    const sr = slot("slack_router", "claude-sonnet-4-6");
    c.ok("every Slack router call is in the ledger: feature, model, tokens, cost", sr.calls === 6 && sr.in === 6000 && sr.out === 600 && Math.abs(sr.usd - 6 * 0.0045) < 1e-9, JSON.stringify(sr));
    c.ok("the ledger began with the first call", !!(await prisma.appSetting.findUnique({ where: { key: usage.AI_USAGE_SINCE_KEY } })));

    await ai.aiJson({ system: "s", prompt: "p", schema: { type: "object" }, feature: "growth_plan", model: "claude-haiku-4-5-20251001" });
    await ai.postMessages({ model: "claude-haiku-5-5", max_tokens: 10, messages: [{ role: "user", content: "x" }] }, "k", { timeoutMs: 5_000 });
    await ai.polishOutbound({ rough: "running 10 min late", clientName: "Joe" });
    await usage.flushAiUsage();
    const rows2 = await usage.readAiUsage(yesterday, today);
    const has = (f: string, m: string) => rows2.some((r) => r.feature === f && r.model === m && r.calls >= 1);
    c.ok("a call site's feature name is recorded (aiJson feature: growth_plan, Haiku 4.5)", has("growth_plan", "claude-haiku-4-5-20251001"));
    c.ok("a direct transport call with no name is photo QC's", has("photo_qc", "claude-haiku-5-5"));
    c.ok("a named helper in ai.ts records its own feature (polish)", rows2.some((r) => r.feature === "polish"));

    const p = (m: string, i: number, o: number, cr = 0, cw = 0) => usage.aiCostUsd(m, { inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw });
    const M = 1_000_000;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    c.ok("prices: Sonnet 4.6 $3/$15, Haiku 4.5 $1/$5, Opus 5.5 $4/$20, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50",
      near(p("claude-sonnet-4-6", M, M), 18) && near(p("claude-haiku-4-5-20251001", M, M), 6) && near(p("claude-opus-5-5", M, M), 24) && near(p("claude-sonnet-5-5", M, M), 12) && near(p("claude-haiku-5-5", M, M), 0.6));
    c.ok("cache reads at each model's cache price, writes at 1.25x input", near(p("claude-opus-5-5", 0, 0, M), 0.2) && near(p("claude-sonnet-4-6", 0, 0, M), 0.3) && near(p("claude-haiku-5-5", 0, 0, M), 0.01) && near(p("claude-sonnet-4-6", 0, 0, 0, M), 3.75));

    // Twenty calls finishing together: none lost.
    const u1 = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await Promise.all(Array.from({ length: 20 }, () => usage.recordAiUsage({ feature: "drill_burst", model: "claude-sonnet-4-6", usage: u1 })));
    const burst = (await usage.readAiUsage(today, today)).find((r) => r.feature === "drill_burst");
    c.ok("twenty concurrent writes to one slot: twenty counted", burst?.calls === 20 && burst.inputTokens === 200, JSON.stringify(burst));

    // A store that fails, a store that hangs, a row that is not JSON.
    usage.__setAiUsageStoreForTests(async () => { throw new Error("store down"); });
    let threw = false;
    try { await ai.polishOutbound({ rough: "running 10 min late", clientName: "Joe" }); } catch { threw = true; }
    c.ok("a failing store never breaks the call", !threw);
    usage.__setAiUsageStoreForTests(() => new Promise<void>(() => {}));
    const t0 = Date.now();
    const answer = await ai.polishOutbound({ rough: "running 10 min late", clientName: "Joe" }).catch(() => null);
    c.ok("a hanging store never slows the call", answer === "Polished." && Date.now() - t0 < 3_000, `${Date.now() - t0} ms`);
    usage.__setAiUsageStoreForTests(null);
    await prisma.appSetting.create({ data: { key: `${usage.AI_USAGE_DAY_PREFIX}2026-01-05`, value: "not json" } });
    let rejected = false;
    await usage.recordAiUsage({ feature: "x", model: "claude-sonnet-4-6", usage: u1, at: new Date("2026-01-05T17:00:00Z") }).catch(() => { rejected = true; });
    c.ok("a corrupt day row: the write fails quietly and the row is left alone", !rejected && (await prisma.appSetting.findUnique({ where: { key: `${usage.AI_USAGE_DAY_PREFIX}2026-01-05` } }))?.value === "not json");
    c.ok("a call that billed nothing is not recorded", (await usage.recordAiUsage({ feature: "zero", model: "m", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }), !(await usage.readAiUsage(today, today)).some((r) => r.feature === "zero")));

    // =======================================================================
    c.head("4 · the owner's AI spend card");
    // =======================================================================
    const day = 86_400_000;
    const now = Date.now();
    const client = await prisma.client.create({ data: { name: "QC Drill Client" } });
    const project = await prisma.project.create({ data: { title: "1 Drill Lane", clientId: client.id } });
    const job = await prisma.photoJob.create({ data: { projectId: project.id } });
    const run = (kind: string, model: string, costCents: number, finishedAt: Date) =>
      prisma.programAiRun.create({ data: { kind, promptKey: "drill", model, costCents, status: "SUCCEEDED", finishedAt } });
    await run("strategy_draft", "claude-sonnet-4-6", 250, new Date(now - 3 * day));   // before the ledger: counted
    await run("script_hooks", "claude-opus-5-5", 100, new Date(now - 2 * day));       // a writer step: counted as the script writer
    await run("topic_bank", "claude-sonnet-4-6", 999, new Date(now + 1_000));         // after the ledger began: the ledger has it
    await run("topic_bank", "claude-sonnet-4-6", 777, new Date(now - 40 * day));      // outside 30 days
    await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", rulesVersion: "v1", costUsd: 1.5, startedAt: new Date(now - 3 * day) } });
    await prisma.photoQcRun.create({ data: { jobId: job.id, trigger: "INITIAL", rulesVersion: "v1", costUsd: 7, startedAt: new Date(now + 1_000) } });

    const user = (email: string, name: string, role: string) => prisma.appUser.create({ data: { email, name, role, status: "ACTIVE" }, select: { id: true, email: true, role: true } });
    const owner = await user("owner@oct22-ai.drill.invalid", "Jordan Drill", "OWNER");
    const kyle = await user("kyle@oct22-ai.drill.invalid", "Kyle Drill", "ADMIN");
    const editor = await user("editor@oct22-ai.drill.invalid", "Editor Drill", "EDITOR");
    const refuses = async () => { try { await usage.ownerAiSpend(); return false; } catch (e) { return /Only the owner/.test((e as Error).message); } };
    const cardText = async () => { const el = await AiSpendCard(); return el && isValidElement(el) ? JSON.stringify(el) : null; };
    for (const [label, u] of [["Kyle (ADMIN)", kyle], ["an editor", editor]] as const) {
      await setSession({ uid: u.id, email: u.email, role: u.role });
      c.ok(`${label}: the loader refuses and the card renders nothing`, (await refuses()) && (await cardText()) === null);
    }
    await setSession({ uid: owner.id, email: owner.email, role: owner.role, actingAs: kyle.id });
    c.ok("the owner previewing Kyle: refused", await refuses());
    await clearSession();
    c.ok("signed out: refused", await refuses());

    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    await usage.flushAiUsage();
    const spend = await usage.ownerAiSpend();
    const ledgerUsd = (await usage.readAiUsage(spend.fromDay, spend.toDay)).reduce((s, r) => s + r.usd, 0);
    const f = (k: string) => spend.byFeature.find((l) => l.key === k);
    c.ok("the total is the ledger plus the run costs from before it began ($2.50 + $1.00 + $1.50)", Math.abs(spend.totalUsd - (ledgerUsd + 5)) < 0.011 && Math.abs(spend.sources.programRunsUsd - 3.5) < 1e-9 && Math.abs(spend.sources.photoQcRunsUsd - 1.5) < 1e-9, JSON.stringify(spend.sources));
    c.ok("by feature: the content program, the script writer and photo QC sit beside the Slack router", f("content_program")?.usd === 2.5 && f("script_writer")?.usd === 1 && (f("photo_qc")?.usd ?? 0) >= 1.5 && (f("slack_router")?.calls ?? 0) === 6, JSON.stringify(spend.byFeature));
    c.ok("by model: Sonnet 4.6, Opus 5.5 and the photo QC mix", spend.byModel.some((l) => l.key === "claude-sonnet-4-6") && spend.byModel.some((l) => l.key === "claude-opus-5-5" && l.usd === 1) && spend.byModel.some((l) => l.key === "photo_qc_mixed"));
    const text = (await cardText()) ?? "";
    c.ok("the owner's card shows the spend and says where the other apps' keys are counted", text.includes("AI spend") && text.includes("Script Studio") && text.includes("Console") && text.includes("Slack to-do sorting"));

    // =======================================================================
    c.head("5 · client profiles are rebuilt only on news");
    // =======================================================================
    const old = new Date(now - 20 * day);
    const v2 = JSON.stringify({ v: 2, summary: "old", stats: { totalOrders: 1, revisions: 0, inboundMsgs: 0 } });
    const mk = (name: string, built: Date | null) => prisma.client.create({ data: { name, transactionCount: 1, profileJson: built ? v2 : null, profileUpdatedAt: built } });
    const quietC = await mk("Quiet Client", old);
    const texted = await mk("Texted Client", old);
    const neverBuilt = await mk("Never Built", null);
    const ownerOnly = await mk("Owner Only Client", old);
    const newJob = await mk("New Job Client", old);
    const fb = await mk("Feedback Client", old);
    const rev = await mk("Revision Client", old);
    await prisma.commLog.create({ data: { channel: "text", direction: "in", minRole: "ADMIN", clientId: texted.id, body: "Can we move the shoot?", occurredAt: new Date(), source: "openphone" } });
    await prisma.commLog.create({ data: { channel: "slack", direction: "in", minRole: "OWNER", clientId: ownerOnly.id, body: "owner-only note", occurredAt: new Date(), source: "slack" } });
    await prisma.commLog.create({ data: { channel: "text", direction: "in", minRole: "ADMIN", clientId: quietC.id, body: "old message", occurredAt: new Date(now - 30 * day), source: "openphone", createdAt: new Date(now - 30 * day) } });
    await prisma.project.create({ data: { title: "9 New Job Road", clientId: newJob.id } });
    const fbProject = await prisma.project.create({ data: { title: "4 Feedback Way", clientId: fb.id, createdAt: new Date(now - 60 * day) } });
    await prisma.feedback.create({ data: { projectId: fbProject.id, body: "Loved it", rating: 5 } });
    await prisma.smartTask.create({ data: { taskType: "revision", title: "Brighten the kitchen", clientId: rev.id } });

    const news = await latestProfileNews([quietC.id, texted.id, ownerOnly.id, newJob.id, fb.id, rev.id], old);
    c.ok("news: a message the team may see, a job, feedback, a revision", news.has(texted.id) && news.has(newJob.id) && news.has(fb.id) && news.has(rev.id));
    c.ok("not news: an owner-only message, a message from before the last build", !news.has(ownerOnly.id) && !news.has(quietC.id));

    const before = calls.profile;
    const res = await refreshStaleClientProfiles(20, 60_000);
    const stamp = async (id: string) => (await prisma.client.findUnique({ where: { id } }))?.profileUpdatedAt?.getTime() ?? 0;
    c.ok("five rebuilt (four with news + one never built), one AI call each", res.refreshed === 5 && calls.profile - before === 5, JSON.stringify({ res, calls: calls.profile - before }));
    c.ok("the quiet client and the owner-only one keep their old profile", (await stamp(quietC.id)) === old.getTime() && (await stamp(ownerOnly.id)) === old.getTime());
    c.ok("the never-built client was built", (await stamp(neverBuilt.id)) > now - day);
    const second = await refreshStaleClientProfiles(20, 60_000);
    c.ok("the next night: nothing new, nothing rebuilt", second.refreshed === 0 && calls.profile - before === 5);
    await usage.flushAiUsage();
    c.ok("profile rebuilds are in the ledger as client_profile", (await usage.readAiUsage(yesterday, today)).some((r) => r.feature === "client_profile" && r.calls === 5));

    c.ok("nothing left the machine (only faked Anthropic and Slack)", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
