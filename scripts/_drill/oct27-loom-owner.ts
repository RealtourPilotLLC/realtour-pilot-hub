// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Oct 27 2026: JORDAN'S LOOM ON HIS DASHBOARD (0:00 to 7:00), held here.
//   §1  Bottlenecks are TOPICS, a count over a window that says what it is
//       ("Videos past due: 7 projects, oldest 4 days late"; "A client text
//       went unanswered: Logan, Sat to Mon"; repeat revisions; slow replies;
//       the same photo problem on 3 shoots "all shoots by Harrison"). Pure,
//       pinned with a fixed clock.
//   §2  The AI step (complaint themes) with a stubbed model: behind ai_runs,
//       never while the AI account refuses, a thanks is never sent, a failed
//       call changes nothing (no tag added or removed, no message marked read).
//   §3  The loader and his moves as the signed-in owner: Delegate is keyed to
//       the topic (the row says who has it), Mark handled hides it until a new
//       record appears, Snooze 7 days, Reopen, Make it my task (his /day list).
//       An AI store over a day old shows no AI topics, and says so.
//   §4  THE BUG (5:17 to 6:51): an email he delegated to Kyle stayed under
//       "Email needing my reply". Now it leaves the list (one quiet line points
//       to Delegated by me), it is under Delegated by me, it is Kyle's Client
//       Communications row with Reply, and marking the thread handled closes it.
//   §5  Pre-production says what the shoots need (scripts to write, waiting
//       for approval), Open brief is a real brief, listing-script tasks are
//       the creative manager's.
// Disposable PGlite; the model and Slack are fakes; nothing leaves; nothing is sent.
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, interceptModule, makeChecker } from "./_harness";
import type { JobRow } from "../../src/lib/jobsBoard";
import type { Bottleneck } from "../../src/lib/ownerDashboard";
import type { ReplyWait, ThemeStore } from "../../src/lib/ownerTopicsCore";

installNextStubs();
type Props = Record<string, unknown>;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

// ---- the model: a fake that tags by the words, and can be made to fail ----
let modelMode: "ok" | "fail" = "ok";
const modelPrompts: string[] = [];
const fence = fenceFetch(async (url, init) => {
  if (url === "https://api.anthropic.com/v1/messages") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { content: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? "");
    modelPrompts.push(prompt);
    if (modelMode === "fail") return json({ type: "error", error: { type: "invalid_request_error", message: "drill: the model call failed" } }, 400);
    const items: { id: string; theme: string; detail?: string }[] = [];
    for (const line of prompt.split("\n")) {
      if (!line.startsWith("{")) continue;
      const m = JSON.parse(line) as { id: string; from: string; text: string };
      const t = m.text.toLowerCase();
      if (m.from === "TEAM" && /upload/.test(t)) items.push({ id: m.id, theme: "upload_problem", detail: "Dropbox upload failing" });
      else if (/bathroom/.test(t)) items.push({ id: m.id, theme: "photo_angles", detail: "Bathroom angles" });
      else items.push({ id: m.id, theme: "none" });
    }
    // Two answers the checks must drop: an id it wasn't asked about, a theme off the list.
    items.push({ id: "not-asked-about", theme: "photo_angles", detail: "made up" });
    return json({ id: "msg_drill", type: "message", role: "assistant", model: "drill-model", content: [{ type: "tool_use", id: "tu_1", name: "emit", input: { items } }], usage: { input_tokens: 100, output_tokens: 50 } });
  }
  if (url.startsWith("https://slack.com/api/")) return json({ ok: true, channel: { id: "D-DRILL" }, ts: "1" });
  return null;
});

// ---- the production boards, through their contracts (empty unless a check sets them) ----
let jobRows: JobRow[] = [];
interceptModule((r) => r === "@/lib/jobsBoard" || /src[\\/]lib[\\/]jobsBoard(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/jobsBoard");
  return { ...m, jobsBoard: async () => ({ rows: jobRows, counts: { total: jobRows.length, late: jobRows.filter((j) => j.late).length, dueToday: 0, dueTomorrow: 0, oldestLateDays: null } }) };
});
interceptModule((r) => r === "@/lib/videoDelivery" || /src[\\/]lib[\\/]videoDelivery(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/videoDelivery");
  return {
    ...m,
    videoDeliveryBoard: async () => ({ asOf: new Date().toISOString(), lanes: { late: [], today: [], upcoming: [], review: [], sending: [], held: [], finishing: [], delivered: [] }, counts: {}, mode: "live", connected: true, unavailable: false }),
    videoSummary: async () => ({ readyToSend: 0, late: 0, dueToday: 0 }),
  };
});
interceptModule((r) => r === "@/lib/reviewRoom" || /src[\\/]lib[\\/]reviewRoom(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/reviewRoom");
  return { ...m, getReviewQueue: async () => ({ pending: [], waitingOnCheck: [], waitingOnEditor: [], recentlyApproved: [], followUps: [] }) };
});
interceptModule((r) => r === "@/lib/opsExceptions" || /src[\\/]lib[\\/]opsExceptions(?:\.ts)?$/.test(r), (loaded) => {
  const m = loaded as typeof import("../../src/lib/opsExceptions");
  return { ...m, opsExceptionsBoard: async () => ({ ...m.emptyExceptionBoard(), rows: [] }) };
});

const STREAMED = new Set([
  "OwnerHome", "FinanceSection", "ProductionSection", "ClientIssuesSection", "TeamSection", "MeetingsSection", "CreativeSection", "EmailSectionView", "DelegatedSection", "WeeklySection", "TaskOpen",
]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && STREAMED.has(tree.type.name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
const nestedButton = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)button\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
/** The markup of one element, from its marker to its closing tag (same-tag nesting counted). */
function sliceOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at < 0) return "";
  const open = html.lastIndexOf("<", at);
  const tag = /^<([a-z]+)/.exec(html.slice(open))?.[1] ?? "div";
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = open;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void; push: () => void }; usePathname: () => string };
navigation.useRouter = () => ({ refresh() {}, push() {} });
navigation.usePathname = () => "/";

const H = 3_600_000;
const D = 24 * H;
const OWNER_EMAIL = "info@realtourpilot.com";

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5965), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-loom-owner" } });
  const c = makeChecker();
  try {
    const core = await import("@/lib/ownerTopicsCore");
    const desks = { office: { key: "kyle", name: "Kyle" }, cm: { key: "james", name: "James" }, owner: { key: "jordan", name: "Jordan" } };

    // =====================================================================
    c.head("§1 · topics, pure: a count over a window that says what it is (fixed clock)");
    // =====================================================================
    // Tuesday Oct 27 2026, 11 AM ET.
    const NOW = new Date("2026-10-27T15:00:00Z");
    const iso = (ms: number) => new Date(ms).toISOString();
    const late = (i: number, pid: string, hours: number): Bottleneck => ({
      id: `editing:${pid}:${i}`, issue: `${i} Late Rd: video past its promise`, client: "Real Agent", commitment: null, owner: "John", handledBy: null,
      nextStep: "Recovery plan and new ETA", clientUpdate: null, tone: "bad", href: `/projects/${pid}`, assign: { title: "Recover it" }, taskId: null,
      actions: [{ kind: "link", label: "Open", href: `/projects/${pid}` }], topic: "videos-late", lateHours: hours, projectId: pid,
    } as Bottleneck);
    // Seven projects late (one with two late cuts), the oldest 4 days.
    const lates = [late(1, "p1", 96), late(2, "p2", 30), late(3, "p3", 10), late(4, "p4", 50), late(5, "p5", 20), late(6, "p6", 5), late(7, "p7", 70), late(8, "p7", 12)];
    const fromB = core.topicsFromBottlenecks(lates, desks);
    const vl = fromB.find((t) => t.key === "videos-late");
    c.ok("\"Videos past due: 7 projects, oldest 4 days late\" (two cuts of one job count once)", vl?.title === "Videos past due" && vl.summary === "7 projects, oldest 4 days late" && vl.count === 7 && vl.items.length === 8, `${vl?.title}: ${vl?.summary} (${vl?.count})`);
    c.ok("…its Delegate is keyed to the topic, to the creative manager (James), with the outcome he wants", vl?.delegate.sourceHref === "/#topic-videos-late" && vl.delegate.assigneeKey === "james" && /^Videos past due: 7 projects/.test(vl.delegate.title) && /recovery plan/i.test(vl.delegate.outcome ?? ""), JSON.stringify(vl?.delegate));
    c.ok("…Review opens the board it counts (Video Delivery)", vl?.review?.href === "/review", JSON.stringify(vl?.review));
    const cmLess = core.topicsFromBottlenecks(lates, { ...desks, cm: { key: null, name: null } }).find((t) => t.key === "videos-late");
    c.ok("…no creative manager on record: Delegate goes to the office (Kyle)", cmLess?.delegate.assigneeKey === "kyle");

    // Repeat revisions: 2+ asks on one job inside 7 days.
    const ask = (id: string, pid: string, client: string, daysAgo: number) => ({ id, projectId: pid, client, street: `${pid} St`, atISO: iso(NOW.getTime() - daysAgo * D), href: `/projects/${pid}` });
    const rr = core.repeatRevisionsTopic([ask("a1", "pa", "Ann", 1), ask("a2", "pa", "Ann", 3), ask("b1", "pb", "Ben", 2), ask("b2", "pb", "Ben", 9), ask("c1", "pc", "Cal", 1), ask("c2", "pc", "Cal", 2), ask("c3", "pc", "Cal", 4)], NOW, desks);
    c.ok("repeat revisions: \"2 clients asked for 2+ rounds in the last 7 days\" (an ask 9 days old doesn't count)", rr?.summary === "2 clients asked for 2+ rounds in the last 7 days" && rr.items.length === 2 && rr.tone === "bad" && rr.window === "Last 7 days", `${rr?.summary} · ${rr?.items.map((i) => i.title).join(" | ")}`);
    c.ok("…one ask per job is not a topic", core.repeatRevisionsTopic([ask("a1", "pa", "Ann", 1), ask("b1", "pb", "Ben", 2)], NOW, desks) === null);

    // A client text left on read over the weekend: Logan, Sat to Mon.
    const ev = (id: string, direction: "in" | "out", at: string, body: string, extra: Partial<{ clientId: string; name: string; thread: string; skip: boolean }> = {}) => ({ id, clientId: "logan", name: "Logan", thread: "", direction, atISO: at, body, ...extra });
    const sat = "2026-10-24T14:00:00Z"; // Sat 10 AM ET
    const mon = "2026-10-26T13:30:00Z"; // Mon 9:30 AM ET
    const waits = core.replyWaits([
      ev("t1", "in", sat, "Hey, can you send me the photos for Elm St?"),
      ev("t2", "in", "2026-10-24T18:00:00Z", "Following up on the photos"),
      ev("t3", "out", "2026-10-25T12:00:00Z", "Thanks for booking with RealTour Pilot!", { skip: true }),
      ev("t4", "out", mon, "Sorry Logan, sending them now"),
    ], NOW);
    const mt = core.missedTextsTopic(waits, NOW, desks);
    c.ok("\"A client text went unanswered: Logan, Sat to Mon\" (the automated text in between doesn't answer it)", mt?.title === "A client text went unanswered" && mt.summary === "Logan, Sat to Mon" && waits.length === 1 && waits[0].id === "t1" && Math.round(waits[0].hours) === 48, `${mt?.title}: ${mt?.summary} · ${waits.map((w) => `${w.id} ${Math.round(w.hours)}h`).join(", ")}`);
    c.ok("…its Delegate goes to the office, keyed to the topic", mt?.delegate.assigneeKey === "kyle" && mt.delegate.sourceHref === "/#topic-missed-texts");
    const still = core.replyWaits([ev("s1", "in", "2026-10-25T15:00:00Z", "Are we still on for Thursday?", { clientId: "sam", name: "Sam" })], NOW);
    c.ok("…still waiting: \"Sun to now, still waiting\", in red", core.missedTextsTopic(still, NOW, desks)?.summary === "Sam, Sun to now, still waiting" && core.missedTextsTopic(still, NOW, desks)?.tone === "bad", core.missedTextsTopic(still, NOW, desks)?.summary);
    const fast = core.replyWaits([ev("f1", "in", sat, "Can you call me?"), ev("f2", "out", "2026-10-24T16:00:00Z", "Calling now")], NOW);
    const thanks = core.replyWaits([ev("k1", "in", sat, "Thanks so much!", { skip: true })], NOW);
    c.ok("…answered within the day, or a plain thanks: no topic", fast.length === 0 && thanks.length === 0 && core.missedTextsTopic([], NOW, desks) === null);
    const old = core.replyWaits([ev("o1", "in", "2026-10-18T15:00:00Z", "Old question"), ev("o2", "out", "2026-10-20T15:00:00Z", "Answer")], NOW);
    c.ok("…a wait that started over 7 days ago isn't counted", old.length === 0);
    const many = core.missedTextsTopic([...waits, ...still], NOW, desks);
    c.ok("…two people: \"Client texts unanswered a day or more: 2 texts in the last 7 days (Logan, Sam)\"", many?.title === "Client texts unanswered a day or more" && many.summary === "2 texts in the last 7 days (Logan, Sam)", many?.summary);

    // Slow email replies: a pattern is two threads or more.
    const w = (id: string): ReplyWait => ({ id, clientId: id, name: id, thread: `subject ${id}`, fromISO: sat, toISO: mon, hours: 47, snippet: "x" });
    c.ok("slow replies: one slow thread is the inbox's job (no topic); two is \"2 email threads waited 24h+ in the last 7 days\"", core.slowRepliesTopic([w("e1")], NOW, desks) === null && core.slowRepliesTopic([w("e1"), w("e2")], NOW, desks)?.summary === "2 email threads waited 24h+ in the last 7 days");

    // The same photo problem on three shoots in a week.
    const issue = (id: string, pid: string, shooter: string | null, daysAgo = 1) => ({ id, key: "flag:bathroom angle", label: "bathroom angle", projectId: pid, client: "C", street: `${pid} Ave`, shooter, atISO: iso(NOW.getTime() - daysAgo * D), href: `/projects/${pid}` });
    const pi = core.photoIssueTopics([issue("i1", "j1", "Harrison"), issue("i2", "j2", "Harrison"), issue("i3", "j3", "Harrison"), issue("i4", "j3", "Harrison")], NOW, desks);
    c.ok("a photo problem on 3 shoots: \"Recurring photo issue: bathroom angle: 3 shoots in the last 7 days, all shoots by Harrison\"", pi.length === 1 && pi[0].title === "Recurring photo issue: bathroom angle" && pi[0].summary === "3 shoots in the last 7 days, all shoots by Harrison" && pi[0].owner === "Harrison", pi.map((t) => `${t.title}: ${t.summary}`).join(" | "));
    const mixed = core.photoIssueTopics([issue("i1", "j1", "Harrison"), issue("i2", "j2", "Harrison"), issue("i3", "j3", "Pat")], NOW, desks);
    c.ok("…two photographers: counted by name \"(Harrison 2, Pat 1)\"; on two shoots, or 9 days ago: no topic", mixed[0]?.summary === "3 shoots in the last 7 days (Harrison 2, Pat 1)" && core.photoIssueTopics([issue("i1", "j1", "H"), issue("i2", "j2", "H")], NOW, desks).length === 0 && core.photoIssueTopics([issue("i1", "j1", "H"), issue("i2", "j2", "H"), issue("i3", "j3", "H", 9)], NOW, desks).length === 0, mixed[0]?.summary);

    // The AI half, pure: the reply is checked, a failure changes nothing, a stale store shows nothing.
    const parsed = core.parseThemeReply({ items: [{ id: "m1", theme: "photo_angles", detail: "  Bathroom   ANGLES " }, { id: "m2", theme: "made_up_theme" }, { id: "zz", theme: "billing" }, { id: "m1", theme: "billing" }, { id: "m3", theme: "none" }, null, "junk"] }, ["m1", "m2", "m3"]);
    c.ok("parseThemeReply keeps only asked ids, themes on the list (or none), once each; never throws on junk", parsed.length === 2 && parsed[0].theme === "photo_angles" && parsed[0].detail === "bathroom angles" && parsed[1].theme === "none" && core.parseThemeReply("garbage", ["m1"]).length === 0 && core.parseThemeReply(null, []).length === 0, JSON.stringify(parsed));
    const tag = (id: string, client: string, pid: string | null, daysAgo = 1, theme: "photo_angles" | "upload_problem" = "photo_angles") => ({ commLogId: id, channel: theme === "upload_problem" ? "slack" : "text", clientId: theme === "upload_problem" ? null : client, client: theme === "upload_problem" ? null : client, projectId: pid, theme, detail: theme === "upload_problem" ? "dropbox upload failing" : "bathroom angles", atISO: iso(NOW.getTime() - daysAgo * D) });
    const good: ThemeStore = { v: 1, lastRunAt: iso(NOW.getTime() - H), lastOkAt: iso(NOW.getTime() - H), lastError: null, seen: [{ id: "x", at: iso(NOW.getTime() - D) }], tags: [tag("m1", "Ann", "j1"), tag("m2", "Ben", "j2"), tag("m3", "Cal", "j3")] };
    const failed = core.foldThemeRun(good, { ok: false, error: "The AI account is refusing calls" }, NOW);
    c.ok("a failed AI run records its error and changes nothing else (tags, read list, last good run)", failed.lastError === "The AI account is refusing calls" && failed.lastOkAt === good.lastOkAt && JSON.stringify(failed.tags) === JSON.stringify(good.tags) && JSON.stringify(failed.seen) === JSON.stringify(good.seen));
    const tt = core.themeTopics(good, NOW, desks, (pid) => (pid ? "Harrison" : null));
    c.ok("\"Recurring client complaint: 3 clients in the last 7 days about bathroom angles, all shoots by Harrison\", marked AI", tt.length === 1 && tt[0].title === "Recurring client complaint" && tt[0].summary === "3 clients in the last 7 days about bathroom angles, all shoots by Harrison" && tt[0].source === "ai" && /Grouped by AI/.test(tt[0].note ?? ""), tt.map((t) => `${t.title}: ${t.summary}`).join(" | "));
    c.ok("…the last good run over a day ago (the AI down, the switch off): no AI topics at all", core.themeTopics({ ...good, lastOkAt: iso(NOW.getTime() - 25 * H) }, NOW, desks, () => null).length === 0 && core.themeTopics(null, NOW, desks, () => null).length === 0);
    c.ok("…one client is not a pattern; two Slack messages aren't either (a team theme needs 3)", core.themeTopics({ ...good, tags: [tag("m1", "Ann", "j1"), tag("m2", "Ann", "j2")] }, NOW, desks, () => null).length === 0 && core.themeTopics({ ...good, tags: [tag("s1", "", null, 1, "upload_problem"), tag("s2", "", null, 1, "upload_problem")] }, NOW, desks, () => null).length === 0);

    // His decisions on a topic.
    const st = (state: "handled" | "snoozed", ids: string[], until: string | null = null) => ({ state, at: NOW.toISOString(), until, ids, by: OWNER_EMAIL });
    c.ok("Mark handled hides a topic until a record it didn't count appears", core.topicHidden({ ids: ["a", "b"] }, st("handled", ["a", "b"]), NOW) && core.topicHidden({ ids: ["a"] }, st("handled", ["a", "b"]), NOW) && !core.topicHidden({ ids: ["a", "c"] }, st("handled", ["a", "b"]), NOW));
    c.ok("Snooze hides it for the week whatever happens, then it is back", core.topicHidden({ ids: ["new"] }, st("snoozed", ["a"], iso(NOW.getTime() + 7 * D)), NOW) && !core.topicHidden({ ids: ["a"] }, st("snoozed", ["a"], iso(NOW.getTime() - H)), NOW));
    const ordered = core.orderTopics([...tt, ...(mt ? [mt] : []), ...fromB]);
    c.ok("live work first (videos past due), then what keeps coming back", ordered[0].key === "videos-late" && ordered.findIndex((t) => t.key === "missed-texts") < ordered.findIndex((t) => t.source === "ai"), ordered.map((t) => t.key).join(", "));

    // =====================================================================
    c.head("§2 · the AI step, with a stubbed model: fail safe");
    // =====================================================================
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const themes = await import("@/lib/complaintThemes");
    const topicsLib = await import("@/lib/ownerTopics");
    const T = new Date();
    const tm = (name: string, role: string, extra: Record<string, unknown> = {}) => prisma.teamMember.create({ data: { name, role: role as never, email: `${name.split(" ")[0].toLowerCase()}@loom27.invalid`, ...extra } });
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER");
    const kyleTm = await tm("Kyle Smith", "MANAGER", { opsAlerts: true, slackId: "UKYLE" });
    const jamesTm = await tm("James Livingston", "MANAGER", { creativeManager: true, slackId: "UJAMES" });
    const harrisonTm = await tm("Harrison Wells", "PHOTOGRAPHER", { slackId: "UHARRISON" });
    const user = (name: string, email: string, role: string, teamMemberId: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const owner = await user("Jordan Spackman", OWNER_EMAIL, "OWNER", jordanTm.id);
    const kyle = await user("Kyle Smith", "kyle@loom27.invalid", "ADMIN", kyleTm.id);
    await user("James Livingston", "james@loom27.invalid", "CREATIVE_MANAGER", jamesTm.id);
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    await signIn(owner);
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));

    const clientOf = (name: string, i: number) => prisma.client.create({ data: { name, email: `c${i}@client.example`, phone: `21555501${String(10 + i)}` } });
    const [ann, ben, cal] = [await clientOf("Ann Agent", 1), await clientOf("Ben Broker", 2), await clientOf("Cal Closer", 3)];
    const shoot = (clientId: string, title: string) => prisma.project.create({ data: { clientId, title, status: "DELIVERED", photographerId: harrisonTm.id, shootDate: new Date(T.getTime() - 3 * D) } });
    const [pAnn, pBen, pCal] = [await shoot(ann.id, "1 Ann St, Town"), await shoot(ben.id, "2 Ben St, Town"), await shoot(cal.id, "3 Cal St, Town")];
    const msg = (o: { clientId?: string | null; name?: string | null; projectId?: string | null; channel: string; body: string; hoursAgo: number; subject?: string; direction?: string; source?: string }) =>
      prisma.commLog.create({ data: { clientId: o.clientId ?? null, clientName: o.name ?? null, contactName: o.name ?? null, projectId: o.projectId ?? null, channel: o.channel, direction: o.direction ?? "in", source: o.source ?? (o.channel === "slack" ? "slack" : o.channel === "email" ? "gmail" : "openphone"), subject: o.subject ?? null, body: o.body, occurredAt: new Date(T.getTime() - o.hoursAgo * H) } });
    const mAnn = await msg({ clientId: ann.id, name: ann.name, projectId: pAnn.id, channel: "text", body: "The bathroom angles in the photos look off again, can you redo them?", hoursAgo: 30 });
    await msg({ clientId: ann.id, name: ann.name, channel: "text", direction: "out", source: "openphone", body: "So sorry Ann, we're redoing those now", hoursAgo: 28 });
    await msg({ clientId: ben.id, name: ben.name, projectId: pBen.id, channel: "text", body: "Bathroom shots are crooked, the angle is weird", hoursAgo: 20 });
    await msg({ clientId: cal.id, name: cal.name, projectId: pCal.id, channel: "email", subject: "Listing photos", body: "The bathroom angles on 3 Cal St are not usable", hoursAgo: 10 });
    const mThanks = await msg({ clientId: ann.id, name: ann.name, channel: "text", body: "Thanks!", hoursAgo: 5 });
    const mBook = await msg({ clientId: ben.id, name: ben.name, channel: "text", body: "Can we book a shoot next Tuesday at 10?", hoursAgo: 4 });
    for (let i = 0; i < 3; i++) await msg({ channel: "slack", body: `Upload keeps failing on the Dropbox folder (${i + 1})`, hoursAgo: 6 + i });
    const storeRow = () => prisma.appSetting.findUnique({ where: { key: topicsLib.THEME_STORE_KEY } });
    const store = async () => topicsLib.readThemeStore();

    let r = await themes.runComplaintThemes({ now: T });
    c.ok("ai_runs off: skipped, the model never called, nothing written", "skipped" in r && /ai_runs/.test(r.skipped) && modelPrompts.length === 0 && !(await storeRow()), JSON.stringify(r));
    await prisma.programAutomation.upsert({ where: { key: "ai_runs" }, create: { key: "ai_runs", enabled: true, enabledBy: "drill", enabledAt: T }, update: { enabled: true } });
    await saveSecret("ai", "drill-ai-key-not-real");
    r = await themes.runComplaintThemes({ now: T, budgetMs: 10_000, minStartMs: themes.THEMES_MIN_START_MS });
    c.ok("not enough time left in the cron run: skipped, the model never called", "skipped" in r && modelPrompts.length === 0, JSON.stringify(r));
    await prisma.appSetting.create({ data: { key: "ai_outage", value: JSON.stringify({ since: T.toISOString(), lastAt: T.toISOString(), reason: "credit", failures: 2 }) } });
    r = await themes.runComplaintThemes({ now: T });
    c.ok("the AI account refusing calls (an outage on record): skipped, the model never called", "skipped" in r && /refusing/.test(r.skipped) && modelPrompts.length === 0, JSON.stringify(r));
    await prisma.appSetting.delete({ where: { key: "ai_outage" } });

    r = await themes.runComplaintThemes({ now: T });
    let s = await store();
    c.ok("a run: 7 messages sent (3 complaints, 3 Slack, 1 booking), 6 tagged", "sent" in r && r.sent === 7 && r.tagged === 6 && modelPrompts.length === 1, JSON.stringify(r));
    c.ok("…a plain thanks is read but never sent to the model", !modelPrompts[0].includes(mThanks.id) && !!s?.seen.some((x) => x.id === mThanks.id));
    c.ok("…the model's made-up id is dropped; the booking question is read and not a complaint", !!s && !s.tags.some((t) => t.commLogId === "not-asked-about") && s.seen.some((x) => x.id === mBook.id) && !s.tags.some((t) => t.commLogId === mBook.id) && s.tags.length === 6, JSON.stringify(s?.tags.map((t) => [t.theme, t.detail])));
    c.ok("…only tags and ids are kept (no message text in the store)", !!s && !JSON.stringify(s).includes("crooked") && !!s.lastOkAt && s.lastError === null);
    r = await themes.runComplaintThemes({ now: T });
    c.ok("a second run with nothing new: the model is not called again", "sent" in r && r.sent === 0 && modelPrompts.length === 1, JSON.stringify(r));

    const before = (await store())!;
    const mNew = await msg({ clientId: cal.id, name: cal.name, channel: "text", body: "Bathroom angles again on the second listing", hoursAgo: 1 });
    modelMode = "fail";
    r = await themes.runComplaintThemes({ now: T });
    s = await store();
    c.ok("the model failing: the run says so; no tag added or removed, nothing marked read, the last good run kept", "failed" in r && !!s && s.lastError !== null && JSON.stringify(s.tags) === JSON.stringify(before.tags) && JSON.stringify(s.seen) === JSON.stringify(before.seen) && s.lastOkAt === before.lastOkAt && !s.seen.some((x) => x.id === mNew.id), JSON.stringify(r));
    modelMode = "ok";
    r = await themes.runComplaintThemes({ now: T });
    s = await store();
    c.ok("…the next good run picks the unread message up (asked once more, never lost)", "sent" in r && r.sent === 1 && !!s?.tags.some((t) => t.commLogId === mNew.id) && s.lastError === null, JSON.stringify(r));
    void mAnn;

    // =====================================================================
    c.head("§3 · the loader, and his moves on a topic (signed in as Jordan)");
    // =====================================================================
    const logan = await prisma.client.create({ data: { name: "Logan Price", phone: "2155550199" } });
    await msg({ clientId: logan.id, name: logan.name, channel: "text", body: "Hey, can you send me the photos for Elm St?", hoursAgo: 60 });
    await msg({ clientId: logan.id, name: logan.name, channel: "text", direction: "out", source: "auto-confirmation", body: "Thanks for booking with RealTour Pilot!", hoursAgo: 40 });
    await msg({ clientId: logan.id, name: logan.name, channel: "text", direction: "out", source: "openphone", body: "Sorry Logan, sending them now", hoursAgo: 12 });
    const pRev = await prisma.project.create({ data: { clientId: ann.id, title: "9 Round Rd, Town", status: "EDITING" } });
    const brief = (hoursAgo: number, kind: string | null = "CLIENT") => prisma.revisionBrief.create({ data: { projectId: pRev.id, source: "review_room", originalText: "Please change the music", requestedByKind: kind, createdAt: new Date(T.getTime() - hoursAgo * H) } });
    await brief(50);
    await brief(20);
    await brief(10, "OFFICE"); // the office's own note is not an ask
    const load = (now: Date = T) => topicsLib.loadOwnerTopics({ now, bottlenecks: [], excludeClientIds: [], desks });
    let L = await load();
    const tk = (k: string) => L.topics.find((t) => t.key === k);
    c.ok("the loader: the text Logan waited on, by name (\"Logan, <day> to <day>\")", /^Logan, [A-Z][a-z]{2} to [A-Z][a-z]{2}$/.test(tk("missed-texts")?.summary ?? "") && tk("missed-texts")?.count === 1, `${tk("missed-texts")?.summary}`);
    c.ok("…repeat revisions from the client's asks (the office's note not counted): 1 client, 2 rounds", tk("repeat-revisions")?.summary === "1 client asked for 2+ rounds in the last 7 days" && /2 rounds/.test(tk("repeat-revisions")?.items[0]?.title ?? ""), `${tk("repeat-revisions")?.summary} · ${tk("repeat-revisions")?.items[0]?.title}`);
    c.ok("…the AI's complaint theme, with who shot the jobs: \"3 clients in the last 7 days about bathroom angles, all shoots by Harrison\"", tk("ai:photo_angles")?.summary === "3 clients in the last 7 days about bathroom angles, all shoots by Harrison" && tk("ai:photo_angles")?.source === "ai", tk("ai:photo_angles")?.summary);
    c.ok("…the team's Slack theme: \"The team keeps hitting upload problems\"", tk("ai:upload_problem")?.title === "The team keeps hitting upload problems" && /^3 Slack messages in the last 7 days/.test(tk("ai:upload_problem")?.summary ?? ""), `${tk("ai:upload_problem")?.title}: ${tk("ai:upload_problem")?.summary}`);
    c.ok("…nothing unavailable, no stale note", L.unavailable.length === 0 && L.note === null, `${L.unavailable.join(", ")} ${L.note}`);
    const stale = await load(new Date(Date.parse((await store())!.lastOkAt!) + 25 * H));
    c.ok("the AI's last good run over a day old: no AI topics, and the card says so; the counted topics stay", !stale.topics.some((t) => t.source === "ai") && /Complaint themes are paused/.test(stale.note ?? "") && stale.topics.some((t) => t.key === "repeat-revisions"), stale.note ?? "");

    const OT = await import("@/app/ownerTopicActions");
    const A = await import("@/app/delegation/actions");
    // Delegate: one keyed task, and the topic says who has it.
    const rt = tk("repeat-revisions")!;
    const del = await A.assignTaskAction({ ...rt.delegate, assigneeKey: "james" });
    L = await load();
    c.ok("Delegate (to James): one task keyed to the topic; the topic now says James has it", del.ok && /James has it/.test(tk("repeat-revisions")?.handledBy?.words ?? "") && (await prisma.smartTask.count({ where: { dedupeKey: "deleg:/#topic-repeat-revisions" } })) === 1, `${del.message} · ${tk("repeat-revisions")?.handledBy?.words}`);
    const again = await A.assignTaskAction({ ...rt.delegate, assigneeKey: "james" });
    c.ok("…pressing it again is the same task", again.ok && (await prisma.smartTask.count({ where: { dedupeKey: "deleg:/#topic-repeat-revisions" } })) === 1, again.message);

    // Mark handled: gone until something new.
    const mtTopic = tk("missed-texts")!;
    let o = await OT.setOwnerTopicState({ key: mtTopic.key, state: "handled", ids: mtTopic.ids });
    L = await load();
    c.ok("Mark handled: the topic leaves the dashboard", o.ok && !tk("missed-texts"), o.message);
    const sam = await prisma.client.create({ data: { name: "Sam Seller", phone: "2155550177" } });
    await msg({ clientId: sam.id, name: sam.name, channel: "text", body: "Are we still on for Thursday at 2?", hoursAgo: 30 });
    L = await load();
    c.ok("…a new unanswered text (one it didn't count) brings it back", !!tk("missed-texts") && tk("missed-texts")!.count === 2, tk("missed-texts")?.summary);
    o = await OT.setOwnerTopicState({ key: "missed-texts", state: "snoozed", ids: tk("missed-texts")!.ids });
    L = await load();
    const snoozedRow = await prisma.appSetting.findUnique({ where: { key: "owner_topic:missed-texts" } });
    const until = snoozedRow ? (JSON.parse(snoozedRow.value) as { until: string }).until : null;
    c.ok("Snooze 7 days: hidden, back in a week", o.ok && !tk("missed-texts") && !!until && Math.round((Date.parse(until) - Date.now()) / D) === 7 && !!(await load(new Date(T.getTime() + 8 * D))).topics, o.message);
    o = await OT.setOwnerTopicState({ key: "missed-texts", state: "reopen", ids: [] });
    L = await load();
    c.ok("Reopen: back on the dashboard at once", o.ok && !!tk("missed-texts"));
    const ai = tk("ai:photo_angles")!;
    o = await OT.makeOwnerTopicMyTask({ key: ai.key, title: ai.title, summary: ai.summary, ids: ai.ids, lines: ai.items.map((i) => i.title) });
    L = await load();
    const todo = await prisma.ownerTodo.findFirst({ where: { title: { startsWith: "Recurring client complaint" } } });
    c.ok("Make it my task: on his own list (/day) with the records as notes, and off the dashboard", o.ok && !!todo && /3 clients in the last 7 days about bathroom angles/.test(todo.title) && /Ann Agent/.test(todo.notes ?? "") && !tk("ai:photo_angles"), `${o.message} · ${todo?.title}`);
    o = await OT.setOwnerTopicState({ key: "bad key with spaces", state: "handled", ids: [] });
    c.ok("a key that isn't a topic's is refused", !o.ok);
    await signIn(kyle);
    let refused = false;
    try { const k = await OT.setOwnerTopicState({ key: "repeat-revisions", state: "handled", ids: [] }); refused = !k.ok; } catch { refused = true; }
    c.ok("…and only the owner can do any of it (Kyle is refused)", refused && !(await prisma.appSetting.findUnique({ where: { key: "owner_topic:repeat-revisions" } })));
    await signIn(owner);

    // The card: topic rows open a panel with the records and his five moves.
    const OH = await import("@/components/owner/OwnerHome");
    const { OwnerShell } = await import("@/components/owner/OwnerShell");
    const renderHome = async () => {
      const tree = await settle(await OH.OwnerHome({ me: { email: OWNER_EMAIL, name: "Jordan Spackman", impersonating: false }, now: T }));
      return { tree, html: ssr(tree) };
    };
    let home = await renderHome();
    const cardHtml = sliceOf(home.html, "data-topics=");
    c.ok("Bottlenecks requiring action: topic rows (title: summary), \"Grouped by AI\" on the AI's", /data-topic="repeat-revisions"/.test(cardHtml) && /data-topic="ai:upload_problem"/.test(cardHtml) && /Grouped by AI/.test(text(cardHtml)) && /Repeat revision requests\s*: 1 client asked for 2\+ rounds/.test(text(cardHtml)), text(cardHtml).slice(0, 400));
    const specs: { spec: { kind: string; topic?: { key: string } } }[] = [];
    const walk = (t: unknown) => { if (Array.isArray(t)) { t.forEach(walk); return; } if (!isValidElement<Props>(t)) return; const ty = t.type as { name?: string }; if (typeof t.type !== "string" && ty.name === "PanelButton") specs.push(t.props as never); Object.values(t.props).forEach(walk); };
    walk(home.tree);
    const aiSpec = specs.find((x) => x.spec.kind === "topic" && x.spec.topic?.key === "ai:upload_problem")?.spec;
    const panel = aiSpec ? ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }, { key: "james", name: "James" }], readOnly: false, initial: aiSpec as never }, null)) : "";
    c.ok("an AI topic's panel: the summary, the messages, the AI note, and Review, Delegate, Make it my task, Mark handled, Snooze 7 days", panel.includes("data-topic-panel") && /data-topic-note="ai"/.test(panel) && ["data-topic-review", "data-topic-delegate", "data-topic-mine", "data-topic-handled", "data-topic-snooze"].every((a) => panel.includes(a)) && !nestedButton(panel), text(panel).slice(0, 300));
    const ro = aiSpec ? ssr(createElement(OwnerShell, { roster: [], readOnly: true, initial: aiSpec as never }, null)) : "";
    c.ok("…viewed as someone else (read only): Review only, no moves", ro.includes("data-topic-review") && !ro.includes("data-topic-delegate") && !ro.includes("data-topic-handled"));

    // =====================================================================
    c.head("§4 · THE BUG: an email he delegated left \"Email needing my reply\"");
    // =====================================================================
    const ow = await import("@/lib/ownerWork");
    await saveSecret("gmail", JSON.stringify({ [OWNER_EMAIL]: "drill-refresh-token-not-real" }));
    const mailer = await prisma.client.create({ data: { name: "Mia Mailer", email: "mia@client.example" } });
    const longSubject = `Questions about the spring listing package and ${"the photos, the reel, the drone, ".repeat(9)}timing`;
    const inMail = await prisma.commLog.create({ data: { clientId: mailer.id, clientName: mailer.name, contactName: "Mia Mailer", channel: "email", direction: "in", source: "gmail", externalId: `gmail-${OWNER_EMAIL}:msg-loom-1`, subject: longSubject, body: "Can you confirm what the spring package includes and when you can shoot?", occurredAt: new Date(T.getTime() - 5 * H), createdAt: new Date(T.getTime() - 5 * H) } });
    let e = await ow.emailNeedingReply({ now: T });
    const row = () => e.rows.find((x) => x.clientId === mailer.id);
    c.ok("a client email in his inbox: 'You need to reply', Delegate keyed to the THREAD (a link under 300 characters even with a long subject)", row()?.cls === "reply" && (row()?.assign.sourceHref ?? "").startsWith("/communications?tab=email&focus=") && (row()?.assign.sourceHref ?? "").length <= 300 && longSubject.length > 300, `${row()?.cls} · ${row()?.assign.sourceHref?.length}`);
    home = await renderHome();
    c.ok("…on the card with Reply and Delegate", /data-email-row="reply"/.test(home.html) && !/data-email-delegated=/.test(home.html));
    const dEmail = await A.assignTaskAction({ ...row()!.assign, assigneeKey: "kyle" });
    const emailTask = await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: "deleg:/communications?tab=email&focus=" } } });
    e = await ow.emailNeedingReply({ now: T });
    c.ok("delegated to Kyle: one task, keyed to the thread; the row is 'waiting' on Kyle", dEmail.ok && !!emailTask && emailTask.assignedKey === "kyle" && row()?.cls === "waiting" && /Kyle/.test(row()?.handledBy ?? ""), `${dEmail.message} · ${row()?.cls} ${row()?.handledBy}`);
    home = await renderHome();
    const emailCard = sliceOf(home.html, 'id="email"');
    c.ok("…and it LEAVES 'Email needing my reply': no row, one quiet line pointing to Delegated by me", !/data-email-row=/.test(emailCard) && /data-email="0"/.test(emailCard) && /data-email-delegated="1"/.test(emailCard) && /Delegated by me/.test(text(emailCard)), text(emailCard).slice(0, 300));
    const mine = await ow.delegatedByMe({ email: OWNER_EMAIL, now: T });
    c.ok("…it is under Delegated by me, with Kyle", mine.rows.some((x) => x.taskId === emailTask?.id && /Kyle/.test(x.assigneeName ?? "")), JSON.stringify(mine.rows.map((x) => [x.title, x.assigneeName])));
    await prisma.commLog.create({ data: { clientId: mailer.id, clientName: mailer.name, contactName: "Mia Mailer", channel: "email", direction: "in", source: "gmail", externalId: `gmail-${OWNER_EMAIL}:msg-loom-2`, subject: `Re: ${longSubject}`, body: "Also, can you add twilight photos to that?", occurredAt: new Date(T.getTime() - H), createdAt: new Date(T.getTime() - H) } });
    e = await ow.emailNeedingReply({ now: T });
    c.ok("…the client writing again in the same thread doesn't bring it back to 'You need to reply' (the Loom bug)", row()?.cls === "waiting", `${row()?.cls}`);

    const desk = await import("@/lib/officeDesk");
    await signIn(kyle);
    const kd = await desk.officeDeskFor({ name: "Kyle Smith", email: kyle.email, teamMemberId: kyleTm.id }, { now: T });
    const comms = kd.sections.find((x) => x.key === "comms");
    const kRow = comms?.now.find((x) => x.id.startsWith("reply:email:") && x.title === "Mia Mailer") ?? comms?.now.find((x) => x.id === `task:${emailTask?.id}`);
    c.ok("on Kyle's dashboard: a Client Communications row, from Jordan, with Reply", !!kRow && kRow.primary?.label === "Reply" && /From Jordan/.test(kRow.line ?? "") && kRow.actions.some((a) => a.kind === "delegation"), JSON.stringify(comms?.now.map((x) => [x.id, x.title, x.primary?.label])));
    const reqs = kd.sections.flatMap((x) => x.now).filter((x) => x.id === `deleg:${emailTask?.id}` || (x.section !== "comms" && x.actions.some((a) => a.kind === "delegation" && (a as { taskId?: string }).taskId === emailTask?.id)));
    c.ok("…once, not a second row under Requests & Follow-Ups", reqs.length === 0, JSON.stringify(reqs.map((x) => [x.section, x.id])));
    const handled = await (await import("@/app/actions")).markCommsHandled(mailer.id, "email");
    const after = await prisma.smartTask.findUnique({ where: { id: emailTask!.id } });
    c.ok("Kyle marks the thread handled: the delegated task is done, with that as its evidence", handled.ok && after?.status === "COMPLETED", `${handled.message} · ${after?.status}`);
    await signIn(owner);
    e = await ow.emailNeedingReply({ now: T });
    const mineAfter = await ow.delegatedByMe({ email: OWNER_EMAIL, now: T });
    c.ok("…and Jordan sees it done (not back on his reply list)", row()?.cls !== "reply" && (mineAfter.rows.find((x) => x.taskId === emailTask?.id)?.state ?? "COMPLETED") === "COMPLETED", `${row()?.cls} · ${mineAfter.rows.find((x) => x.taskId === emailTask?.id)?.state}`);
    // Sending the reply closes it too (the send path's own close, with the thread's subject).
    const mailer2 = await prisma.client.create({ data: { name: "Ned Newmail", email: "ned@client.example" } });
    await prisma.commLog.create({ data: { clientId: mailer2.id, clientName: mailer2.name, contactName: "Ned Newmail", channel: "email", direction: "in", source: "gmail", externalId: `gmail-${OWNER_EMAIL}:msg-loom-3`, subject: "Drone add-on", body: "Can you add drone to Friday's shoot?", occurredAt: new Date(T.getTime() - 3 * H), createdAt: new Date(T.getTime() - 3 * H) } });
    e = await ow.emailNeedingReply({ now: T });
    const r2 = e.rows.find((x) => x.clientId === mailer2.id)!;
    await A.assignTaskAction({ ...r2.assign, assigneeKey: "kyle" });
    const { closeDelegatedEmailTasks } = await import("@/lib/emailDelegation");
    const otherThread = await closeDelegatedEmailTasks({ clientId: mailer2.id, subject: "A different subject", why: "sent" });
    const closed = await closeDelegatedEmailTasks({ clientId: mailer2.id, subject: "Re: Drone add-on", why: "sent", by: "Kyle Smith" });
    c.ok("a reply sent on the thread closes its delegated task; a reply on another thread doesn't", otherThread === 0 && closed === 1);
    void inMail;

    // =====================================================================
    c.head("§5 · pre-production says what the shoots need; Open brief is a brief; listing scripts are James's");
    // =====================================================================
    const od = await import("@/lib/ownerDashboard");
    const premium = (pid: string) => prisma.deliverable.create({ data: { projectId: pid, type: "SOCIAL_REEL", label: "Premium Social Media Reel", productTitle: "Social Influencer", videoStyle: "premium_social_reel" } as never });
    const lister = await prisma.client.create({ data: { name: "Lisa Lister", phone: "2155550166" } });
    const pW = await prisma.project.create({ data: { clientId: lister.id, title: "80 Script St, Town", status: "SCHEDULED", shootDate: new Date(T.getTime() + 2 * D) } });
    await premium(pW.id);
    // A covered shoot is not a thing to do.
    const pCovered = await prisma.project.create({ data: { clientId: lister.id, title: "82 Fine St, Town", status: "SCHEDULED", photographerId: harrisonTm.id } });
    await prisma.appointment.create({ data: { aryeoId: "ap-loom-1", projectId: pCovered.id, assignedToId: harrisonTm.id, startAt: new Date(T.getTime() + 2 * D), endAt: new Date(T.getTime() + 2 * D + 2 * H), status: "SCHEDULED" } });
    let h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    let pre = h.stages.find((x) => x.key === "pre")!;
    c.ok("a premium reel with no script: pre-production reads '1 script to write' (not 'shoots coming up'), James's", pre.headline.n === 1 && pre.headline.words === "script to write" && pre.items.some((i) => i.projectId === pW.id && i.owner === "James") && !pre.items.some((i) => i.projectId === pCovered.id), `${pre.headline.n} ${pre.headline.words} · ${pre.items.map((i) => `${i.street} ${i.owner}`).join(" | ")}`);
    const pA = await prisma.project.create({ data: { clientId: lister.id, title: "81 Draft Dr, Town", status: "SCHEDULED", shootDate: new Date(T.getTime() + 3 * D), scriptingId: "studio-loom-81", scriptingDraftVersion: 2 } });
    await premium(pA.id);
    h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    pre = h.stages.find((x) => x.key === "pre")!;
    c.ok("…and a draft waiting: '1 script to write', the small line '1 waiting for approval · listing scripts'", pre.headline.words === "script to write" && /^1 waiting for approval · listing scripts/.test(pre.detail ?? ""), `${pre.headline.n} ${pre.headline.words} · ${pre.detail}`);
    await prisma.deliverable.deleteMany({ where: { projectId: pW.id } });
    h = await od.productionHealth({ now: T, includeTest: true, excludeClientIds: [] });
    pre = h.stages.find((x) => x.key === "pre")!;
    c.ok("…only the draft left: '1 script waiting for approval'", pre.headline.n === 1 && pre.headline.words === "script waiting for approval", `${pre.headline.n} ${pre.headline.words}`);

    // Open brief: a program call two days out.
    const enr = await prisma.contentEnrollment.create({ data: { clientId: lister.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 2, startedAt: new Date("2026-06-01T12:00:00Z") } });
    await prisma.programCallRecord.create({ data: { enrollmentId: enr.id, clientId: lister.id, callType: "MONTHLY_STRATEGY", status: "COMPLETED", scheduledStart: new Date(T.getTime() - 30 * D) } });
    await prisma.programCallRecord.create({ data: { enrollmentId: enr.id, clientId: lister.id, callType: "MONTHLY_STRATEGY", status: "SCHEDULED", scheduledStart: new Date(T.getTime() + 2 * D), meetLink: "https://meet.google.com/drill-not-real" } });
    await msg({ clientId: lister.id, name: lister.name, channel: "text", body: "Can we talk about doing a market update video next month?", hoursAgo: 26 });
    const m = await ow.meetingsSection({ now: T });
    const mr = m.rows.find((x) => x.clientId === lister.id);
    c.ok("the meeting's brief from records: the program, the last call, the last thing they wrote, questions to ask", !!mr && /^Accelerator, 4 videos a month/.test(mr.brief.program ?? "") && /^Monthly strategy call, /.test(mr.brief.lastCall ?? "") && /market update video/.test(mr.brief.lastFromClient ?? "") && mr.brief.questions.length === 4, JSON.stringify(mr?.brief));
    const bp = mr ? ssr(createElement(OwnerShell, { roster: [{ key: "kyle", name: "Kyle" }], readOnly: false, initial: { kind: "meeting", row: mr } as never }, null)) : "";
    c.ok("Open brief opens the brief in the panel (Join first; the program page one link at the bottom)", bp.includes("data-meeting-panel") && bp.includes('data-brief="last-from-client"') && bp.includes('data-brief="questions"') && /data-brief-program-link[^>]*>Open the program</.test(bp) && /meet\.google\.com\/drill-not-real/.test(bp) && /Accelerator, 4 videos a month/.test(text(bp)), text(bp).slice(0, 300));

    const routing = await import("@/lib/taskRouting");
    c.ok("listing-script tasks are the creative manager's: 'Review and action Premium Reel script package' and reel/listing scripts match; a client text doesn't", routing.isListingScriptTask("Review and action Premium Reel script package") && routing.isListingScriptTask("Approve the listing script for 658 W Ridge Pike") && routing.isListingScriptTask("Send the reel script to Sarina") && !routing.isListingScriptTask("Reply to Mike about Thursday") && !routing.isListingScriptTask("Monthly content scripts for November"));
    const cmDesk = await routing.listingScriptsDesk();
    c.ok("…and the desk they go to is James's", cmDesk?.key === "james", JSON.stringify(cmDesk));

    c.head("Nothing left the hub");
    c.ok("the only outbound calls were the fake model (no Slack, no Gmail, no text)", fence.blocked.length === 0, fence.blocked.join(", "));
  } catch (e) {
    console.error(e);
    c.ok("the drill ran to the end", false, (e as Error).stack?.split("\n").slice(0, 4).join(" | "));
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
