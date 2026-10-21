// Oct 19 2026 (night): MESSAGES, ONE INBOX. Jordan approved "Messages merges
// Communications and Client messages into one inbox"; the priority is
// "responding to clients quickly". /communications is that inbox:
//   · its first view, "Waiting on us", is what /ops/messages showed, from the
//     same read (lib/opsHome.messagesBoard): every client waiting on a reply,
//     texts and email together, oldest first, with Reply (the view on the same
//     page that answers them) and Handled; the new leads; and the promises at
//     risk that lived only on the Tasks page's Replies tab;
//   · then Texts, Email, Team, Outbox, All, in that order, each number on its
//     tab and nowhere else on the page; old tab names still land right;
//   · /ops/messages, /tasks?tab=comms (and /today through it) open Messages,
//     keeping ?test=1; a login without Messages keeps the Tasks tab;
//   · Handled (a waiting client) and Handled (a lead) refuse anyone but the
//     office.
// Server-renders the real pages against disposable PGlite. No provider is
// connected, so nothing can be sent; nothing leaves the box.
// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { MessagesBoard } from "../../src/lib/opsHome";

installNextStubs();
const fence = fenceFetch();
type Props = Record<string, unknown>;

// ---- tree helpers ---------------------------------------------------------------------
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  const found = (typeof type === "string" ? type : type.name) === name ? [tree.props] : [];
  return [...found, ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function hrefs(tree: unknown): string[] {
  if (Array.isArray(tree)) return tree.flatMap(hrefs);
  if (!isValidElement<Props>(tree)) return [];
  return [...(typeof tree.props.href === "string" ? [tree.props.href] : []), ...Object.values(tree.props).flatMap(hrefs)];
}
// Server-only pieces of the page are expanded so their rows, links and
// buttons can be read; client components keep their real props.
const SERVER_PARTS = new Set(["WaitingOnUs", "AtRiskUpdates", "MessagesTabs", "ClientTextsPanel"]);
async function settle(tree: unknown): Promise<unknown> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement<Props>(tree)) return tree;
  if (typeof tree.type === "function" && SERVER_PARTS.has(tree.type.name)) return settle(await (tree.type as (p: Props) => unknown)(tree.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const ssr = (tree: unknown) => { try { return renderToStaticMarkup(tree as Parameters<typeof renderToStaticMarkup>[0]); } catch (e) { return `RENDER FAILED: ${(e as Error).message}`; } };
// A link inside a link is invalid HTML and breaks taps on a phone.
const nestedLink = (html: string) => { let depth = 0; for (const m of html.matchAll(/<(\/?)a\b/g)) { depth += m[1] ? -1 : 1; if (depth > 1) return true; } return false; };
const stripTags = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void }; usePathname: () => string };
navigation.redirect = (href) => { throw new Redirect(href); };
navigation.useRouter = () => ({ refresh() {} });
navigation.usePathname = () => "/communications";
// The guards reach next/navigation through a dynamic import, which is Next's
// own redirect (its digest carries the target), not the stub above.
async function redirectOf(run: () => Promise<unknown>): Promise<string | null> {
  try { await run(); return null; } catch (e) {
    if (e instanceof Redirect) return e.href;
    const digest = (e as { digest?: unknown })?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2] ?? null;
    throw e;
  }
}

const H = 3_600_000;
const D = 24 * H;

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5947), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct19-messages-inbox" } });
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const pageModule = await import("@/app/communications/page");
    const messages = pageModule.default;
    const { default: tasksPage } = await import("@/app/tasks/page");
    // Oct 20 2026 (audit H18): /ops/messages and /today left their pages for
    // next.config's redirects; the doors are asserted against that table.
    const { configRedirect } = await import("./_configRedirect");
    const nav = await import("@/components/comms/messagesNav");
    const { emailFocusKey } = await import("@/components/comms/WaitingOnUs");
    const { homeRecordHref } = await import("@/lib/homeRecordScope");
    const { messagesBoard } = await import("@/lib/opsHome");
    const { replyQueue } = await import("@/lib/replyQueue");
    const { markCommsHandled } = await import("@/app/actions");
    const { markLoopHandled } = await import("@/app/ops/actions");
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const ahead = (ms: number) => new Date(now.getTime() + ms);

    // =====================================================================
    c.head("§1 · the tab rules");
    // =====================================================================
    c.ok("six views, in Jordan's order: Waiting on us, Texts, Email, Team, Outbox, All", nav.MESSAGES_TABS.map((t) => t.key).join() === "waiting,texts,email,team,outbox,all" && nav.MESSAGES_TABS.map((t) => t.label).join() === "Waiting on us,Texts,Email,Team,Outbox,All");
    const tabOf = (sp: Record<string, string | string[]>) => nav.resolveMessagesTab(sp);
    c.ok("no tab = Waiting on us (the first view)", tabOf({}) === "waiting" && tabOf({ tab: "" }) === "waiting" && tabOf({ tab: "nonsense" }) === "waiting");
    c.ok("every old tab name still lands on its work: replies → Texts, inbox → All; email, team, outbox unchanged", tabOf({ tab: "replies" }) === "texts" && tabOf({ tab: "inbox" }) === "all" && tabOf({ tab: "email" }) === "email" && tabOf({ tab: "team" }) === "team" && tabOf({ tab: "outbox" }) === "outbox" && tabOf({ tab: "OUTBOX" }) === "outbox");
    c.ok("a delivery-text check (?incident=) opens on All, as it always did; a named tab still wins", tabOf({ incident: "x" }) === "all" && tabOf({ incident: "x", tab: "email" }) === "email");
    c.ok("links: Waiting on us is bare /communications; ?test=1 only where a view reads it", nav.messagesHref("waiting") === "/communications" && nav.messagesHref("waiting", { test: true }) === "/communications?test=1" && nav.messagesHref("email", { test: true }) === "/communications?tab=email&test=1" && nav.messagesHref("outbox", { test: true }) === "/communications?tab=outbox&test=1" && nav.messagesHref("texts", { test: true }) === "/communications?tab=texts&test=1" && nav.messagesHref("all", { test: true }) === "/communications?tab=all");
    c.ok("Reply on a text opens Texts at that conversation; on an email, Email at that thread (test view kept)", nav.waitingReplyHref("phone", "c1") === "/communications?tab=texts&focus=c1" && nav.waitingReplyHref("email", "floor plan::c2", true) === "/communications?tab=email&focus=floor+plan%3A%3Ac2&test=1");
    // Oct 20 2026: Texts reads ?test=1 too (audit F24), so Home's scope reaches it.
    c.ok("Home's test scope reaches Messages (Waiting on us, Texts, Email, Outbox), not a delivery-text check or an old tab name", homeRecordHref("/communications", true) === "/communications?test=1" && homeRecordHref("/communications?tab=email", true) === "/communications?tab=email&test=1" && homeRecordHref("/communications?tab=texts&focus=c1", true) === "/communications?tab=texts&focus=c1&test=1" && homeRecordHref("/communications?tab=replies", true) === "/communications?tab=replies" && homeRecordHref("/communications?incident=x", true) === "/communications?incident=x" && homeRecordHref("/communications", false) === "/communications");
    c.ok("the page's browser title is Messages", (pageModule as unknown as { metadata?: { title?: string } }).metadata?.title === "Messages");

    // =====================================================================
    c.head("§2 · the world");
    // =====================================================================
    const vip = await prisma.client.create({ data: { name: "Real Agent", phone: "2155550101", segment: "vip" } });
    const broker = await prisma.client.create({ data: { name: "Bea Broker", email: "bea@agent.invalid" } });
    const fixture = await prisma.client.create({ data: { name: "Avery TEST", phone: "2155550177" } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", role: "MANAGER", email: "kyle@oct19m.invalid" } });
    const jordanTm = await prisma.teamMember.create({ data: { name: "Jordan Spackman", role: "PHOTOGRAPHER", email: "jordan@oct19m.invalid" } });
    const jamesTm = await prisma.teamMember.create({ data: { name: "James Livingston", role: "MANAGER", email: "james@oct19m.invalid" } });
    const shooterTm = await prisma.teamMember.create({ data: { name: "Harrison Shooter", role: "PHOTOGRAPHER", email: "harrison@oct19m.invalid" } });
    const user = (name: string, email: string, role: string, teamMemberId?: string, permissions?: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE", permissions } });
    const kyle = await user("Kyle Smith", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Jordan Spackman", jordanTm.email!, "OWNER", jordanTm.id);
    await user("James Livingston", jamesTm.email!, "ADMIN", jamesTm.id);
    const shooter = await user("Harrison Shooter", shooterTm.email!, "PHOTOGRAPHER", shooterTm.id);
    // An office login whose Messages access was switched off by hand.
    const noComms = await user("Desk Without Messages", "desk@oct19m.invalid", "ADMIN", undefined, JSON.stringify({ communications: false }));
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });

    // Clients waiting: a VIP's text for 30 hours (with a dollar figure in it),
    // an email for 2 hours, a test client's text; an unsaved number's text
    // (Texts only: Waiting on us lists clients).
    const log = (data: Record<string, unknown>) => prisma.commLog.create({ data: { source: "openphone", channel: "text", direction: "in", ...data } as never });
    await log({ clientId: vip.id, clientName: vip.name, contactName: vip.name, fromPhone: vip.phone, body: "Is the $750 credit applied for 12 Oak St?", occurredAt: ago(30 * H) });
    await log({ clientId: broker.id, clientName: broker.name, contactName: broker.name, channel: "email", source: "gmail", subject: "Floor plan", body: "Can you check the floor plan for 4 Elm St? The kitchen is missing.", occurredAt: ago(2 * H) });
    await log({ clientId: fixture.id, clientName: fixture.name, contactName: fixture.name, fromPhone: fixture.phone, body: "Fixture question", occurredAt: ago(5 * H) });
    await log({ fromPhone: "2155550199", body: "Hi, do you shoot condos?", occurredAt: ago(3 * H) });
    // Leads: Kyle's (overdue), nobody's (call back today), James's.
    const task = (data: Record<string, unknown>) => prisma.smartTask.create({ data: { taskType: "todo", source: "manual", status: "OPEN", ...data } as never });
    const laterToday = ahead(30 * 60_000);
    const leadKyle = await task({ taskType: "lead", source: "openphone", title: "New lead: Pat Doe wants a listing shoot", ownerId: kyleTm.id, dueAt: ago(5 * D), createdAt: ago(5 * D) });
    const leadFree = await task({ taskType: "lead", source: "website", title: "New lead: Sam Roe", dueAt: laterToday, createdAt: ago(H) });
    const leadJames = await task({ taskType: "lead", source: "website", title: "New lead: for James", assignedKey: "james", createdAt: ago(2 * H) });
    // The Outbox: one real draft due today, one test client's.
    const pReal = await prisma.project.create({ data: { clientId: vip.id, title: "40 Tomorrow Way, Town", status: "SCHEDULED", shootDate: ahead(D) } });
    const pFix = await prisma.project.create({ data: { clientId: fixture.id, title: "Fixture-only property", status: "SCHEDULED", shootDate: ahead(D) } });
    await task({ taskType: "confirmation_text", source: "system", title: "Confirm 40 Tomorrow Way", projectId: pReal.id, clientId: vip.id, dueAt: laterToday });
    await task({ taskType: "confirmation_text", source: "system", title: "Confirm the fixture", projectId: pFix.id, clientId: fixture.id, dueAt: laterToday });
    // A promise at risk: a job due in six hours, not delivered.
    await prisma.project.create({ data: { clientId: vip.id, title: "5 Quarry Ln, Town", status: "EDITING", shootDate: ago(D), promisedDueAt: ahead(6 * H) } });
    // A Slack to-do, for the Tasks page's ?task= deep link.
    const slackTask = await task({ taskType: "internal_instruction", source: "slack", title: "Check the drone batteries", assignedKey: "kyle" });

    // =====================================================================
    c.head("§3 · Waiting on us = the clients waiting + new leads (Kyle)");
    // =====================================================================
    await signIn(kyle);
    const kyleBoard = await messagesBoard({ now, excludeClientIds: [fixture.id], viewer: { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id } });
    const kTree = await messages({ searchParams: Promise.resolve({}) });
    const waitingProps = elements(kTree, "WaitingOnUs")[0];
    const shown = waitingProps?.board as MessagesBoard | undefined;
    const keyOf = (b: MessagesBoard) => b.waiting.map((w) => `${w.family}:${w.group.groupKey}`).join();
    c.ok("the default view is Waiting on us, under the title Messages", elements(kTree, "MessagesTabs")[0]?.tab === "waiting" && elements(kTree, "PageHeader")[0]?.title === "Messages" && !!shown);
    c.ok("its clients are messagesBoard's waiting clients, in its order (longest wait first)", !!shown && keyOf(shown) === keyOf(kyleBoard) && kyleBoard.waiting.length === 2 && kyleBoard.waiting[0].group.clientId === vip.id && kyleBoard.waiting[1].family === "email", shown ? keyOf(shown) : "none");
    c.ok("…texts and email together; the test client and the unsaved number are not on it", !!shown && shown.waiting.some((w) => w.family === "phone") && shown.waiting.some((w) => w.family === "email") && !shown.waiting.some((w) => w.group.clientId === fixture.id) && shown.waiting.every((w) => !!w.group.clientId));
    c.ok("its leads are messagesBoard's: Kyle's and nobody's, not James's", !!shown && shown.leads.map((l) => l.id).join() === kyleBoard.leads.map((l) => l.id).join() && shown.leads.some((l) => l.id === leadKyle.id && l.behind) && shown.leads.some((l) => l.id === leadFree.id && l.dueToday) && !shown.leads.some((l) => l.id === leadJames.id));
    const kWaiting = await settle(kTree);
    const kHtml = ssr(kWaiting);
    // CHANGED Oct 21 2026 (audit F5, Jordan): a waiting client is cleared with the Texts tab's own Dismiss
    // (reasons, the thread's cut), keyed to its row's conversation and sender group.
    const handled = elements(kWaiting, "CommsDismissButton");
    c.ok("every waiting client has the Texts tab's Dismiss, keyed to its row", elements(kWaiting, "HandledButton").length === 0 && handled.length === kyleBoard.waiting.length && kyleBoard.waiting.every((w) => handled.some((h) => h.threadKey === w.group.key && h.clientId === w.group.clientId && h.family === w.family && h.groupKey === w.group.groupKey)));
    const replyLinks = hrefs(kWaiting).filter((h) => h.includes("focus="));
    const vipRow = kyleBoard.waiting.find((w) => w.group.clientId === vip.id)!;
    const brokerRow = kyleBoard.waiting.find((w) => w.group.clientId === broker.id)!;
    c.ok("Reply stays on this page: a text opens Texts at that client, an email opens Email at that thread", replyLinks.length === kyleBoard.waiting.length && replyLinks.includes(`/communications?tab=texts&focus=${encodeURIComponent(vipRow.group.groupKey)}`) && replyLinks.includes(`/communications?tab=email&focus=${new URLSearchParams({ f: emailFocusKey(brokerRow) }).toString().slice(2)}`) && emailFocusKey(brokerRow) === `floor plan::${broker.id}`, replyLinks.join(" | "));
    c.ok("…and no Reply still points at the old doors", !hrefs(kWaiting).some((h) => h.startsWith("/tasks?tab=comms") || h.startsWith("/ops/messages") || h === "/communications?tab=replies"));
    c.ok("every lead has View, Handled and Not needed (LoopActions), View opens the lead", elements(kWaiting, "LoopActions").length === kyleBoard.leads.length && elements(kWaiting, "LoopActions").every((l) => String(l.viewHref).startsWith("/tasks?tab=work&type=lead&task=")));
    c.ok("what they sent can be read in the list: the email's text and the VIP's text", kHtml.includes("The kitchen is missing.") && kHtml.includes("Read what they sent") && kHtml.includes('aria-label="VIP client"'));
    c.ok("promises at risk moved here from the Tasks page's Replies tab (job due in six hours, Draft update)", kHtml.includes('id="at-risk"') && kHtml.includes("Promises at risk") && kHtml.includes("5 Quarry Ln"));
    c.ok("Kyle never sees the dollar figure; the sentence stays", !kHtml.includes("$750") && kHtml.includes("[amount] credit applied"));
    // Each number once: the tab carries it; the header and section titles do not.
    const countOf = (html: string, key: string) => html.match(new RegExp(`data-count="${key}"[^>]*>(\\d+)<`))?.[1] ?? null;
    const tabsIn = (html: string) => [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]).join();
    const sub = String(elements(kTree, "PageHeader")[0]?.subtitle ?? "");
    const h2s = [...kHtml.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => stripTags(m[1]));
    const kTexts = await replyQueue();
    // CHANGED Oct 20 2026 (audit F24): the Texts view hides test clients like
    // Waiting, Email and the Outbox do, unless ?test=1. The library list still
    // carries them; the page filters.
    const kTextsReal = kTexts.cards.filter((card) => card.clientId !== fixture.id);
    // CHANGED Oct 21 2026 (audit F5): one "Waiting on us". Texts still lists every unanswered text,
    // but its number counts only what Waiting does not show (unsaved and team numbers), never a waiting client twice.
    const kTextsOnlyHere = kTextsReal.filter((card) => !card.clientId).length;
    c.ok("the tab bar: six tabs in order, with counts (waiting clients + leads; texts from unsaved and team numbers; drafts in the Outbox)", tabsIn(kHtml) === "waiting,texts,email,team,outbox,all" && countOf(kHtml, "waiting") === String(kyleBoard.waiting.length + kyleBoard.leads.length) && countOf(kHtml, "texts") === String(kTextsOnlyHere) && kTextsOnlyHere >= 1 && countOf(kHtml, "outbox") === "1", `${countOf(kHtml, "waiting")}/${countOf(kHtml, "texts")}/${countOf(kHtml, "outbox")}`);
    c.ok("…the Texts list still holds every unanswered text (the unsaved number and the waiting client too)", kTexts.cards.length === 3 && kTexts.cards.some((card) => !card.isClient) && kTexts.cards.some((card) => card.clientId === vip.id));
    c.ok("each number appears once: no count in the header or the section titles", !/\d/.test(h2s.join(" ")) && !sub.includes(`${kyleBoard.waiting.length} client`) && !sub.includes(`${kyleBoard.leads.length} new lead`) && sub.includes("1 client has waited over 24 hours"), `${h2s.join(" | ")} || ${sub}`);
    c.ok("the Outbox is a tab, not a second line on this view", !kHtml.includes("drafted and ready in the Outbox"));

    // =====================================================================
    c.head("§4 · the owner, and the test view");
    // =====================================================================
    await signIn(owner);
    const oRaw = await messages({ searchParams: Promise.resolve({}) });
    const oBoard = elements(oRaw, "WaitingOnUs")[0]?.board as MessagesBoard;
    const oHtml = ssr(await settle(oRaw));
    c.ok("the owner sees every lead, the figure as written, and no follow-ups link (that is Kyle's checklist)", oBoard.leads.length === 3 && oHtml.includes("$750") && !oHtml.includes("Internal follow-ups are on your daily checklist") && kHtml.includes("Internal follow-ups are on your daily checklist"));
    await signIn(kyle);
    const tTree = await messages({ searchParams: Promise.resolve({ test: "1" }) });
    const tBoard = elements(tTree, "WaitingOnUs")[0]?.board as MessagesBoard;
    const tHtml = ssr(await settle(tTree));
    c.ok("?test=1 brings the test client's row back, and its Outbox draft into the count", tBoard.waiting.some((w) => w.group.clientId === fixture.id) && tBoard.waiting.length === kyleBoard.waiting.length + 1 && countOf(tHtml, "outbox") === "2");
    // The tab links, in order, by their data-tab marker (attribute order is React's).
    const tabHrefs = (html: string) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => a.includes("data-tab=")).map((a) => (a.match(/href="([^"]+)"/)?.[1] ?? "").replace(/&amp;/g, "&"));
    c.ok("…the test view rides along on Waiting on us, Texts, Email and Outbox only", tabHrefs(tHtml).join() === "/communications?test=1,/communications?tab=texts&test=1,/communications?tab=email&test=1,/communications?tab=team,/communications?tab=outbox&test=1,/communications?tab=all" && tabHrefs(kHtml).join() === "/communications,/communications?tab=texts,/communications?tab=email,/communications?tab=team,/communications?tab=outbox,/communications?tab=all", tabHrefs(tHtml).join());
    c.ok("only a scalar test=1 turns it on", !(elements(await messages({ searchParams: Promise.resolve({ test: ["1", "1"] as never }) }), "WaitingOnUs")[0]?.board as MessagesBoard).waiting.some((w) => w.group.clientId === fixture.id));

    // =====================================================================
    c.head("§5 · the other views: same page, same title, each count on its tab");
    // =====================================================================
    const view = async (sp: Record<string, string>) => {
      const tree = await messages({ searchParams: Promise.resolve(sp) });
      return { tree, tab: elements(tree, "MessagesTabs")[0]?.tab as string, title: elements(tree, "PageHeader")[0]?.title as string, html: ssr(await settle(tree)) };
    };
    const texts = await view({ tab: "texts" });
    const rq = elements(texts.tree, "ReplyQueue")[0];
    c.ok("Texts = the reply queue (every unanswered text, a reply ready to write; test clients hidden)", texts.tab === "texts" && texts.title === "Messages" && (rq?.cards as unknown[]).length === kTextsReal.length);
    c.ok("…its header and the Everyone filter do not repeat the tab's number", !texts.html.includes("Everyone (") && !String(elements(texts.tree, "PageHeader")[0]?.subtitle).includes(`${kTextsReal.length} waiting`) && texts.html.includes(`Clients only (${kTextsReal.filter((card) => card.isClient).length})`));
    const textsTest = await view({ tab: "texts", test: "1" });
    c.ok("…and ?test=1 brings the test client's text back (audit F24)", (elements(textsTest.tree, "ReplyQueue")[0]?.cards as unknown[]).length === kTexts.cards.length && textsTest.html.includes("Hide test records"));
    const legacy = await view({ tab: "replies" });
    c.ok("an old ?tab=replies link opens Texts", legacy.tab === "texts" && elements(legacy.tree, "ReplyQueue").length === 1);
    const focused = await view({ tab: "texts", focus: vipRow.group.groupKey });
    const fq = elements(focused.tree, "ReplyQueue")[0];
    c.ok("Reply from Waiting on us: that client's conversation first, marked, open", (fq?.cards as { key: string }[])[0]?.key === `c:${vip.id}` && fq?.focusKey === `c:${vip.id}` && focused.html.includes(`data-reply-card="c:${vip.id}" aria-current="true"`) && focused.html.includes("Answering Real Agent"));
    const gone = await view({ tab: "texts", focus: "no-such-client" });
    c.ok("…a conversation answered meanwhile says so and still shows the queue", gone.html.includes("not waiting on a text reply any more") && elements(gone.tree, "ReplyQueue")[0]?.focusKey === null);
    const email = await view({ tab: "email", focus: emailFocusKey(brokerRow) });
    const el = elements(email.tree, "EmailThreadList")[0];
    c.ok("Email: Reply opens the client's thread first and unfolded, with Open in Gmail", email.tab === "email" && email.title === "Messages" && (el?.threads as { key: string }[])[0]?.key === `floor plan::${broker.id}` && el?.focusKey === `floor plan::${broker.id}` && email.html.includes("The kitchen is missing.") && email.html.includes("Open in Gmail"));
    c.ok("…Email's number (client wrote last, in two days) is on its tab", countOf(email.html, "email") === "1");
    // A request the hub wrote down with no subject (an obligation-ledger row)
    // still opens that client's newest thread; an unknown one says where to look.
    const noSubject = await view({ tab: "email", focus: `(no subject)::${broker.id}` });
    c.ok("…a waiting email with no subject opens that client's latest thread", elements(noSubject.tree, "EmailThreadList")[0]?.focusKey === `floor plan::${broker.id}` && noSubject.html.includes("Their latest thread is first and open."));
    const missing = await view({ tab: "email", focus: "a very old subject::nobody" });
    c.ok("…an email outside the 60 days says so, with a Gmail search", elements(missing.tree, "EmailThreadList")[0]?.focusKey === null && missing.html.includes("not in the last 60 days") && missing.html.includes("mail.google.com/mail/u/0/#search/a%20very%20old%20subject"));
    const team = await view({ tab: "team" });
    c.ok("Team: the chat by property", team.tab === "team" && team.title === "Messages" && elements(team.tree, "TeamMessagesPanel").length === 1);
    const outbox = await view({ tab: "outbox" });
    c.ok("Outbox: the drafts and Send all, under the same tab bar", outbox.tab === "outbox" && outbox.title === "Messages" && elements(outbox.tree, "ClientTextsPanel").length === 1 && elements(outbox.tree, "SendAllTexts")[0]?.count === 1);
    const all = await view({ tab: "all" });
    c.ok("All: every OpenPhone conversation (not connected here, so it says so, with the tabs)", all.tab === "all" && all.title === "Messages" && all.html.includes("Connect OpenPhone") && tabsIn(all.html) === "waiting,texts,email,team,outbox,all");
    const incident = await view({ incident: "unknown-outbox-id" });
    c.ok("a delivery-text check (?incident=) still opens the live list", incident.tab === "all");
    c.ok("the old Inbox name opens All", (await view({ tab: "inbox" })).tab === "all");
    for (const v of [texts, email, outbox, all]) c.ok(`${v.tab} renders with no link inside a link`, !v.html.startsWith("RENDER FAILED") && !nestedLink(v.html), v.html.slice(0, 160));
    c.ok("Waiting on us renders with no link inside a link, and thumb-sized buttons", !kHtml.startsWith("RENDER FAILED") && !nestedLink(kHtml) && (kHtml.match(/min-h-11/g) ?? []).length >= 10, kHtml.slice(0, 160));

    // =====================================================================
    c.head("§6 · the doors: /ops/messages, /tasks?tab=comms and /today open Messages");
    // =====================================================================
    c.ok("/ops/messages → Messages (Waiting on us)", await configRedirect("/ops/messages") === "/communications");
    c.ok("…with ?test=1 kept", await configRedirect("/ops/messages", { test: "1" }) === "/communications?test=1");
    c.ok("…and no page is left at /ops/messages to render instead", !existsSync("src/app/ops/messages/page.tsx"));
    const tasksTo = (sp: Record<string, string>) => redirectOf(() => tasksPage({ searchParams: Promise.resolve(sp) }));
    c.ok("/tasks?tab=comms (the Replies tab) → Messages; ?via=email too; test kept", await tasksTo({ tab: "comms" }) === "/communications" && await tasksTo({ tab: "comms", via: "email" }) === "/communications" && await tasksTo({ tab: "comms", via: "email", test: "1" }) === "/communications?test=1");
    c.ok("/today → /tasks?tab=today → Messages", await configRedirect("/today") === "/tasks?tab=today" && await tasksTo({ tab: "today" }) === "/communications");
    c.ok("a Slack to-do's ?task= link still lands on the Slack tab, not Messages", await tasksTo({ tab: "comms", task: slackTask.id }) === null);
    c.ok("the other Tasks tabs are untouched", await tasksTo({ tab: "work" }) === null && await tasksTo({ tab: "revisions" }) === null && await tasksTo({}) === null);
    await signIn(noComms);
    const kept = await tasksTo({ tab: "comms" });
    // Oct 21 2026 (audit F15): the Replies tab is gone; a login whose access
    // was hand-set without Messages lands on its own work board instead.
    c.ok("a login without Messages is sent to its Tasks work board (the Replies tab is gone)", kept === "/tasks", String(kept));
    await signIn(shooter);
    const shooterTo = await redirectOf(() => messages({ searchParams: Promise.resolve({}) }));
    c.ok("a photographer is sent to their own home, not shown Messages", !!shooterTo && !shooterTo.startsWith("/communications"), String(shooterTo));
    await clearSession();
    c.ok("signed out: the login, which returns to Messages", (await redirectOf(() => messages({ searchParams: Promise.resolve({}) })))?.startsWith("/login?next=%2Fcommunications") === true);

    // =====================================================================
    c.head("§7 · Handled: the office only");
    // =====================================================================
    const acks = () => prisma.appSetting.count({ where: { key: { startsWith: "comms-ack" } } });
    const leadState = async (id: string) => (await prisma.smartTask.findUnique({ where: { id }, select: { status: true } }))?.status;
    const before = await acks();
    c.ok("signed out: Handled on a waiting client is refused, nothing written", (await markCommsHandled(broker.id, "email", brokerRow.group.groupKey)).ok === false && await acks() === before);
    await signIn(shooter);
    c.ok("a photographer: Handled on a waiting client is refused, nothing written", (await markCommsHandled(vip.id, "phone", vipRow.group.groupKey)).ok === false && (await markCommsHandled(broker.id, "email", brokerRow.group.groupKey)).ok === false && await acks() === before);
    c.ok("…and Handled on a lead is refused, the lead stays open", (await markLoopHandled(leadFree.id)).ok === false && await leadState(leadFree.id) === "OPEN");
    await signIn(kyle);
    // Oct 21 2026: the row's Dismiss (CommsDismissButton) sends the thread key and a reason too.
    const r1 = await markCommsHandled(broker.id, "email", brokerRow.group.groupKey, { threadKey: brokerRow.group.key, reason: "answered elsewhere" });
    const after = await messagesBoard({ now: new Date(), excludeClientIds: [fixture.id], viewer: { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id } });
    const brokerAck = await prisma.appSetting.findFirst({ where: { key: { startsWith: "comms-ack-thread:email:" } }, select: { value: true } });
    c.ok("Kyle: Dismiss on the email takes it off Waiting on us, with its reason on the record; the text stays", r1.ok && await acks() === before + 2 && /\|answered elsewhere$/.test(brokerAck?.value ?? "") && !after.waiting.some((w) => w.group.clientId === broker.id) && after.waiting.some((w) => w.group.clientId === vip.id), brokerAck?.value);
    const r2 = await markLoopHandled(leadFree.id);
    const after2 = await messagesBoard({ now: new Date(), excludeClientIds: [fixture.id], viewer: { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id } });
    c.ok("Kyle: Handled on a lead closes it and takes it off the list", r2.ok && await leadState(leadFree.id) === "COMPLETED" && !after2.leads.some((l) => l.id === leadFree.id));
    const reTree = await messages({ searchParams: Promise.resolve({}) });
    c.ok("…and the page's own number follows", countOf(ssr(await settle(reTree)), "waiting") === String(after2.waiting.length + after2.leads.length) && after2.waiting.length + after2.leads.length === kyleBoard.waiting.length + kyleBoard.leads.length - 2);

    c.ok("nothing left the box; no message was queued or sent", fence.blocked.length === 0 && fence.faked.length === 0 && await prisma.outboxMessage.count() === 0, fence.blocked.join(", "));
    c.summary();
  } finally { fence.restore(); await db.stop(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
