// ---------------------------------------------------------------------------
// DRILL: WORKING PREFERENCES, SORTED (Oct 29 2026, Jordan: "Working
// preferences should be summarized and organized and shown in full. The
// working preferences shown in the editor brief should only be editing
// related, not shooting related or communication related or anything else").
// The keyword reading had Renee Ryan backwards: her "PHOTO NOTE: ... capture a
// shot from the front of the living room" reached the editor while her one
// edit rule (fireplaces never show fire) did not.
//   1  what the sort reads: all five places, whole, our fees left out
//   2  the sort: one model call, cached against what it read; a second call
//      is a no-op; long dashes and money never survive; topics kept to the list
//   3  stale when a note changes; the nightly sweep sorts recent clients only
//   4  the client page card: every group, every line whole; the brief: editing only
// ISOLATION: PGlite via the shared harness (DRILL_PORT, default 6996); the
// model is answered in-process; nothing else leaves.
// ---------------------------------------------------------------------------
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, fenceFetch, installNextStubs, makeChecker, quietPrismaErrors } from "./_harness";

installNextStubs();
const asked: string[] = [];
let modelReply: Record<string, unknown> | null = null;
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { system?: string; messages?: { content: string }[] };
    asked.push(`${body.system ?? ""}\n---\n${body.messages?.[0]?.content ?? ""}`);
    return new Response(JSON.stringify({ id: "msg_drill", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "tool_use", id: "tu_1", name: "emit", input: modelReply }], stop_reason: "tool_use", usage: { input_tokens: 100, output_tokens: 100 } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return null;
});
const PORT = Number(process.env.DRILL_PORT ?? 6996);
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

const PHOTO_NOTE = '<div><strong>PHOTO NOTE:</strong> Client prefers additional angles showing the full flow of the home. Please make sure to capture a shot from the <strong>front of the living room looking straight toward the back of the home</strong>, along with additional wide angles when possible.</div>';

async function main() {
  const { stop } = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const wp = await import("@/lib/workingPrefs");
    const core = await import("@/lib/workingPrefsCore");
    const { WorkingPrefsCard } = await import("@/components/clients/WorkingPrefsCard");
    await saveSecret("ai", "sk-drill-not-a-key");

    const renee = await prisma.client.create({ data: {
      name: "Renee Ryan",
      generalNotes: `${PHOTO_NOTE}\n<div>We charged her a $95 rush fee last time.</div>`,
      clientPreferences: "Texts are best, she rarely picks up calls before noon.",
      profileJson: JSON.stringify({ v: 2, stats: { totalOrders: 4, revisions: 0, inboundMsgs: 12 }, summary: "", touchLevel: "high", workingStyle: "", communication: "Renee communicates mostly by text and replies quickly.", revisions: { summary: "", commonTypes: [] }, brandStyle: "", shootNotes: ["Include additional wide-angle shots whenever possible."], aboutThem: [], dos: [], donts: [], editing: { summary: "", prefs: [], customerNotes: ["Agent name on screen must read Renee Ryan; brokerage is Keller Williams"], dos: [], donts: ["Do not add or retain any fire effect in a fireplace in any delivered video"] } }),
    } });

    c.head("1 · what the sort reads");
    const src = await wp.workingPrefSources(renee.id);
    const all = JSON.stringify(src.sources);
    c.ok("the customer note whole, as text (the photo note, every word)", src.sources.some((s) => s.label.startsWith("Customer note") && s.text.includes("front of the living room looking straight toward the back of the home") && s.text.includes("additional wide angles when possible")), all.slice(0, 300));
    c.ok("the office's client preferences, the working profile's edit, shoot and communication notes", all.includes("Texts are best") && all.includes("fire effect in a fireplace") && all.includes("Keller Williams") && all.includes("wide-angle shots") && all.includes("mostly by text"));
    c.ok("our fee never goes in", !all.includes("$95") && !/rush fee/.test(all));
    c.ok("a client with nothing on file: nothing to sort", (await wp.sortedWorkingPrefs((await prisma.client.create({ data: { name: "Blank Slate" } })).id)).state === "none");

    c.head("2 · the sort");
    c.ok("not sorted yet: stale, with nothing older to show", (await wp.sortedWorkingPrefs(renee.id)).state === "stale" && (await wp.sortedWorkingPrefs(renee.id)).prefs === null);
    modelReply = {
      editing: [
        { topic: "What must or must not appear", text: "Fireplaces never show fire in any delivered video — a standing compliance rule." },
        { topic: "Branding and contact details", text: "Her name on screen reads Renee Ryan, with Keller Williams as the brokerage." },
        { topic: "Sparkles", text: "A topic that is not on the list." },
      ],
      shooting: [{ text: "Capture a shot from the front of the living room looking straight toward the back of the home, plus extra wide angles." }],
      communication: [{ text: "Text her; she rarely picks up calls before noon. She paid $95 for the rush." }],
      other: [],
    };
    const b1 = await wp.buildSortedWorkingPrefs(renee.id, "drill");
    c.ok("one model call, with the rules and every source", b1.ok && asked.length === 1 && asked[0].includes("editing: anything that changes the finished, edited work") && asked[0].includes("PHOTO NOTE") && asked[0].includes("Keller Williams"), b1.message);
    const p1 = b1.prefs!;
    c.ok("no long dashes survive", !/[—–]/.test(JSON.stringify(p1)), JSON.stringify(p1.editing[0]));
    c.ok("a money sentence the model let through is dropped", !JSON.stringify(p1).includes("$95") && p1.communication[0]?.text === "Text her; she rarely picks up calls before noon.", p1.communication[0]?.text);
    c.ok("a topic off the list becomes Other", p1.editing[2]?.topic === "Other");
    c.ok("ready now, and a second build is a no-op (no second model call)", (await wp.sortedWorkingPrefs(renee.id)).state === "ready" && (await wp.buildSortedWorkingPrefs(renee.id, "drill")).message === "Already sorted." && asked.length === 1);
    const topics = core.editingByTopic(p1).map((g) => g.topic);
    c.ok("the brief's topics in the house order", JSON.stringify(topics) === JSON.stringify(["Branding and contact details", "What must or must not appear", "Other"]), JSON.stringify(topics));

    c.head("3 · stale, and the nightly sweep");
    await prisma.client.update({ where: { id: renee.id }, data: { clientPreferences: "Texts are best before noon." } });
    const st = await wp.sortedWorkingPrefs(renee.id);
    c.ok("a note changes: stale, the last sort still there to show", st.state === "stale" && st.prefs?.editing.length === 3);
    await prisma.appSetting.create({ data: { key: `working_prefs_lock:${renee.id}`, value: String(Date.now()) } });
    c.ok("one sort at a time per client", (await wp.buildSortedWorkingPrefs(renee.id, "drill")).message === "Already sorting." && asked.length === 1);
    await prisma.appSetting.delete({ where: { key: `working_prefs_lock:${renee.id}` } });
    const old = await prisma.client.create({ data: { name: "Old Client", clientPreferences: "Morning shoots only." } });
    const recentProject = await prisma.project.create({ data: { title: "232 S Matlack St, West Chester, PA 19382", clientId: renee.id, status: "SCHEDULED", shootDate: new Date(Date.now() + 5 * 86_400_000) } });
    await prisma.project.create({ data: { title: "1 Old Rd, Media, PA 19063", clientId: old.id, status: "DELIVERED", shootDate: new Date(Date.now() - 90 * 86_400_000) } });
    const sw = await wp.refreshSortedWorkingPrefs(10, 30_000);
    c.ok("the sweep sorts the client with a job this month, not the one from three months ago", sw.sorted === 1 && asked.length === 2 && (await wp.sortedWorkingPrefs(renee.id)).state === "ready" && (await wp.sortedWorkingPrefs(old.id)).state === "stale", JSON.stringify(sw));
    void recentProject;

    c.head("4 · where it shows");
    const ready = (await wp.sortedWorkingPrefs(renee.id)).prefs!;
    const card = renderToStaticMarkup(createElement(WorkingPrefsCard, { prefs: ready, state: "ready" }));
    const groups = [...card.matchAll(/data-pref-group="([a-z]+)"/g)].map((m) => m[1]);
    c.ok("the client page card: Editing (by topic), Shooting, Communication and scheduling", JSON.stringify(groups) === JSON.stringify(["editing", "shooting", "communication"]) && text(card).includes("Communication and scheduling") && text(card).includes("What must or must not appear"), JSON.stringify(groups));
    c.ok("every line whole", text(card).includes("Capture a shot from the front of the living room looking straight toward the back of the home, plus extra wide angles.") && text(card).includes("Fireplaces never show fire in any delivered video, a standing compliance rule."), text(card).slice(0, 400));
    const waiting = renderToStaticMarkup(createElement(WorkingPrefsCard, { prefs: null, state: "stale" }));
    c.ok("never sorted yet: says it is sorting, nothing else", text(waiting).includes("Sorting their preferences now") && renderToStaticMarkup(createElement(WorkingPrefsCard, { prefs: null, state: "none" })) === "");
    const clientPage = read("src/app/clients/[id]/page.tsx");
    c.ok("the client page shows the card and re-sorts a stale one after the response", /<WorkingPrefsCard prefs=\{workingPrefs\.prefs\} state=\{workingPrefs\.state\} \/>/.test(clientPage) && /after\(\(\) => import\("@\/lib\/workingPrefs"\)\.then\(\(m\) => m\.buildSortedWorkingPrefs\(clientId, "client-page"\)\)/.test(clientPage));
    const brief = read("src/app/edit/[id]/page.tsx");
    c.ok("the editor brief reads the editing group only", /editingByTopic\(sortedPrefs\.prefs/.test(brief) && !/sortedPrefs\.prefs\.(shooting|communication|other)/.test(brief) && /buildSortedWorkingPrefs\(clientId, "editor-brief"\)/.test(brief));
    c.ok("the nightly client run sorts recent clients", /refreshSortedWorkingPrefs\(15, 40_000\)/.test(read("src/app/api/cron/daily-clients/route.ts")));
    c.ok("its spend has a name on the AI usage page", /client_prefs: "Working preferences sorting"/.test(read("src/lib/aiUsage.ts")));

    c.head("isolation");
    c.ok("nothing left the hub but the faked model", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}
main();
