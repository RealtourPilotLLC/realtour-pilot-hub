// @drill-run: engine=postgres conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL oct5-ssfix — the staff-side defects an adversarial review confirmed
// in the Oct 5 work, each proved fixed against the SHIPPED code (Oct 5 night).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-ssfix.ts --logs /private/tmp/oct5-ssfix
//
// A disposable Postgres on 127.0.0.1:6770. Server code runs for real; client
// components are DRIVEN through their real handlers with a small hook
// dispatcher (the shape oct5-upload-loop uses); the server actions they call
// are answered at the module seam where the check is about the component.
// Slack is a counting fake, the blob store a canned host, everything else is
// fenced. Nothing is sent to a client or a provider.
//
//   §1  money filter: 62 table strings both ways (item 4)
//   §2  self-check: every line starts unanswered, N/A needs a typed reason,
//       one send button off until answered; a job-wide ask stays open (2)
//   §3  Home: an amber/red queue never folds (6)
//   §4  verdict receipts: a pending card is never evicted or lost (12)
//   §5  Review panel: a typed note goes with the verdict (12)
//   §6  CutUploader: a refused check reopens with the server's list; a
//       confirming hand-in survives "Next" and shows its failure (11)
//   §7  "Got it": only this video, success only after the save (8)
//   §8  Kyle by duty, held overnight, deduped under a race; held-file bells (3, 17, A)
//   §9  a send-back: the relay task and bells exist before the answer;
//       Kyle never belled about his own; DM held at night (3, 10, 16)
//   §10 rawsAreIn counts a SHOT job with raw footage (14)
//   §11 monthly jobs: no Final-folder send, server-side (B)
//   §12 the edit page: Studio script/song/shot list on a premium cinematic;
//       the shared-script caveat; whose video on each chip; Changes to make
//       for THIS video; Got it scoped; Agent Profile keeps "never" rules and
//       money-filters the note's fonts (1, 7, 8, 9, 17)
//   §13 the portal shows the script word for word (5)
//   §14 a held 1080p file says "on hold" (15); one definition of late (17)
//   §15 Home: the money strip says when it couldn't load; an untimed shoot
//       is not "all started"; the to-send row says "on hold" (17, 15)
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = 6770;
const req = createRequire(__filename);
const c = makeChecker();

// ---- the clock: Tue Oct 6 2026, 10:00 ET unless a section moves it ----------
const RealDate = Date;
const edt = (month: number, day: number, hour: number, minute = 0) => new RealDate(RealDate.UTC(2026, month - 1, day, hour + 4, minute));
let offset = edt(10, 6, 10, 0).getTime() - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const setClock = (d: Date) => { offset = d.getTime() - RealDate.now(); };

installNextStubs();
// Client components ask for a router; the drill answers with a recorder.
const nav = req("next/navigation") as Record<string, unknown>;
const routerCalls: string[] = [];
const searchParams = new URLSearchParams();
nav.useRouter = () => ({ refresh: () => { routerCalls.push("refresh"); }, push: (u: string) => { routerCalls.push(`push:${u}`); }, replace: (u: string) => { routerCalls.push(`replace:${u}`); }, back() {}, forward() {}, prefetch() {} });
nav.useSearchParams = () => searchParams;
nav.usePathname = () => "/edit/x";
nav.useParams = () => ({});

// ---- after(): queued, so a check can look between the answer and the background
type Task = () => Promise<void> | void;
const afterQueue: Task[] = [];
interceptModule(
  (r) => r === "next/server",
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (k === "after" ? (fn: Task) => { afterQueue.push(fn); } : t[k]) }),
);
async function flush(): Promise<number> {
  let n = 0;
  while (afterQueue.length) { await afterQueue.shift()!(); n++; }
  return n;
}

// ---- module seams with fall-through fakes ----------------------------------
const fakes: Record<string, ((...a: never[]) => unknown) | undefined> = {};
const seam = (match: (r: string) => boolean) =>
  interceptModule(match, (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (typeof k === "string" && fakes[k] ? fakes[k] : t[k]) }));
seam((r) => r === "@/app/review/actions" || /[\\/]src[\\/]app[\\/]review[\\/]actions(\.ts)?$/.test(r));
seam((r) => r === "@/app/review/selfCheckActions" || /[\\/]src[\\/]app[\\/]review[\\/]selfCheckActions(\.ts)?$/.test(r));
seam((r) => r === "@/app/edit/[id]/receipt.actions" || /receipt\.actions(\.ts)?$/.test(r));
seam((r) => r === "@/lib/cutUploadFinishReceipt" || /[\\/]lib[\\/]cutUploadFinishReceipt(\.ts)?$/.test(r));
seam((r) => r === "@vercel/blob/client");
seam((r) => r === "@/lib/ownerPulse" || /[\\/]lib[\\/]ownerPulse(\.ts)?$/.test(r));
seam((r) => r === "@/lib/opsDay" || /[\\/]lib[\\/]opsDay(\.ts)?$/.test(r));

// ---- the network: Slack counted, the blob host answered, the rest refused ---
type SlackPost = { channel: string; text: string };
const slack: SlackPost[] = [];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\//i.test(url)) return new Response("abcde", { status: 200, headers: { "content-type": "video/mp4", "content-length": "5" } });
  if (!url.startsWith("https://slack.com/api/")) return null;
  const method = url.slice("https://slack.com/api/".length);
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { channel?: string; text?: string }) : {};
  if (method === "chat.postMessage") { slack.push({ channel: body.channel ?? "?", text: body.text ?? "" }); return json({ ok: true, ts: "1.1" }); }
  if (method === "conversations.open") return json({ ok: true, channel: { id: body.channel ?? "D-DRILL" } });
  if (method === "conversations.list") return json({ ok: true, channels: [] });
  return json({ ok: false, error: `drill: ${method}` });
});

// ---- a small hook dispatcher, so a client component's REAL handlers run ------
function mountHooks(render: () => unknown) {
  const react = req("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [];
  const effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useCallback(fn: unknown) { index++; return fn; },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!deps || !old || deps.some((v, i) => v !== old[i])) { cells[slot] = deps ?? []; effects.push(() => { effect(); }); } },
    useLayoutEffect() { index++; },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (cb: () => Promise<unknown> | void) => { cells[slot] = true; void Promise.resolve().then(cb).finally(() => { cells[slot] = false; }); }]; },
    useOptimistic(passthrough: unknown) { index++; return [passthrough, () => {}]; },
    useId() { return `drill-${index++}`; },
  };
  return {
    render() {
      index = 0;
      const internals = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const before = internals.H;
      internals.H = dispatcher;
      try { const tree = render(); effects.splice(0).forEach((e) => e()); return tree; } finally { internals.H = before; }
    },
  };
}
type Props = Record<string, unknown>;
function named(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((t) => named(t, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string; displayName?: string };
  const hit = (typeof type === "string" ? type : type.displayName ?? type.name) === name ? [tree.props] : [];
  return [...hit, ...Object.values(tree.props).flatMap((v) => named(v, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join("");
  if (!isValidElement<Props>(tree)) return "";
  return textOf(tree.props.children);
}
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const plain = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const until = async (test: () => boolean | Promise<boolean>, what: string, ms = 10_000) => {
  const t0 = RealDate.now();
  while (!(await test())) {
    if (RealDate.now() - t0 > ms) throw new Error(`drill: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
/** Resolve the async server components (what Next's RSC renderer does), leaving client components for react-dom/server. */
async function resolveTree(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveTree));
  if (!isValidElement<Props>(node)) return node;
  const type = node.type as unknown;
  if (typeof type === "function" && (type as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction") {
    return resolveTree(await (type as (p: Props) => Promise<unknown>)(node.props));
  }
  const next: Props = {};
  let changed = false;
  for (const [k, v] of Object.entries(node.props)) {
    if (k === "children" || isValidElement(v) || Array.isArray(v)) { next[k] = await resolveTree(v); changed = true; }
  }
  return changed ? cloneElement(node, next) : node;
}
/** The HTML of the element that opens at the first match of `open` — balanced on its tag name. */
function block(html: string, open: RegExp): string {
  const m = open.exec(html);
  if (!m) return "";
  const start = m[0].startsWith("<") ? m.index : html.lastIndexOf("<", m.index);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))?.[1];
  if (!tag) return "";
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "gi");
  re.lastIndex = start;
  let depth = 0;
  for (let t = re.exec(html); t; t = re.exec(html)) {
    depth += t[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, t.index + t[0].length);
  }
  return html.slice(start);
}
const renderHtml = (tree: unknown) => (req("react-dom/server") as typeof import("react-dom/server")).renderToStaticMarkup(tree as ReactNode);

async function section(title: string, fn: () => Promise<void>) {
  c.head(title);
  try { await fn(); } catch (e) { c.ok(`${title}: ran to the end`, false, e instanceof Error ? `${e.message}\n${e.stack?.split("\n").slice(1, 4).join("\n")}` : String(e)); }
}

async function main() {
  const db = await bootDrillDb({ port: PORT, engine: "postgres", env: { AUTH_ENFORCE: "true", APP_SECRET: "oct5-ssfix-isolated-secret", BLOB_READ_WRITE_TOKEN: ["vercel", "blob", "rw", "drillstore", "fixture"].join("_") } });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    const { putSetting } = await import("@/lib/settings");
    await saveSecret("slack", "xoxb-drill-not-a-real-token");

    // ---- the cast ------------------------------------------------------------
    type TeamRole = "ADMIN" | "MANAGER" | "PHOTOGRAPHER" | "EDITOR";
    const member = (name: string, email: string, role: TeamRole, extra: Record<string, unknown> = {}) =>
      prisma.teamMember.create({ data: { name, email, role, slackId: `U-${name.split(" ")[0].toUpperCase()}`, active: true, ...extra }, select: { id: true, name: true } });
    const jordan = await member("Jordan Spackman", "jordan@drill.invalid", "PHOTOGRAPHER");
    const kyle = await member("Kyle Smith", "kyle@drill.invalid", "MANAGER");
    const james = await member("James Livingston", "james@drill.invalid", "PHOTOGRAPHER", { creativeManager: true });
    const kim = await member("Kim Miguel", "kim@drill.invalid", "EDITOR");
    const john = await member("John Mark", "john@drill.invalid", "EDITOR");
    // A SECOND "Kyle" on the roster (a client contact typed in): the old
    // name lookup found two and gave up; the duty owner is unaffected.
    await prisma.teamMember.create({ data: { name: "Kyle Contact (client side)", email: "kyle.contact@drill.invalid", role: "MANAGER", active: true } });
    const login = (email: string, name: string, role: string, tm: string, extra: Record<string, unknown> = {}) =>
      prisma.appUser.create({ data: { email, name, role, status: "ACTIVE", teamMemberId: tm, ...extra }, select: { id: true, email: true, role: true, name: true } });
    const uJordan = await login("jordan@drill.invalid", "Jordan Spackman", "OWNER", jordan.id);
    const uKyle = await login("kyle@drill.invalid", "Kyle Smith", "ADMIN", kyle.id);
    const uJames = await login("james@drill.invalid", "James Livingston", "ADMIN", james.id);
    const uKim = await login("kim@drill.invalid", "Kim Miguel", "EDITOR", kim.id, { editorKey: "kim" });
    const uJohn = await login("john@drill.invalid", "John Mark", "EDITOR", john.id, { editorKey: "john" });
    const as = (u: { id: string; email: string; role: string; name: string | null }) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });
    await putSetting("review_room", { discoverFromDropbox: false, keepUploadsDays: 90, creativeApproverTeamMemberId: james.id, backupReviewerTeamMemberId: kyle.id, fallbackReviewerTeamMemberId: jordan.id, coverOfferHours: 9, coverTransferHours: null }, "drill");
    // Kyle owns DELIVERY (the program's duty owner row).
    await prisma.programOwnerAssignment.create({ data: { scope: "DEFAULT", scopeRef: "", duty: "DELIVERY", appUserId: uKyle.id, teamMemberId: kyle.id, label: "Kyle Smith", setBy: "drill" } });
    const client = await prisma.client.create({ data: { name: "Drill Agent", autoConfirmationText: false, autoDeliveryText: false }, select: { id: true } });

    // =========================================================================
    await section("§1 · our money, not the market's — 62 strings both ways (item 4)", async () => {
      const { mentionsOurBilling, stripMoneySentences } = await import("@/lib/text");
      const drop = [
        "Still owes 750 for the drone.", "She owes us for last month.", "Price: 325", "Our pricing for the twilight add-on is 175.",
        "Client gets VIP pricing — 20 percent off.", "She is on the $12,000/yr deal.",
        "I paid the $175 add-on fee for the second hour.", "Send the invoice to my assistant.", "He was refunded $40 last month.", "The client paid a $150 rush fee on this one.",
        "Total: 450 for both reels.", "Deposit of 200 is due Friday.", "Her balance is 300.", "The cost is 95 per reel.", "We quoted her 400 for the edit.",
        "That's $1.5k for the month.", "She's on the $499/mo social plan.", "Charge her card for the rush.", "Take 15% off the next shoot.", "Venmo the photographer after.",
        "Add the $75 twilight fee.", "She pays us 2,000 a month.", "He owed us 300 from the last shoot.", "Bill her for the extra hour.", "Payment came in through Stripe.",
        "Give her friends and family rates.", "Annual retainer is $18,000.", "Unpaid since September.", "Use the 10 percent off code.", "Her deposit cleared.",
        "We charged twice last time, please refund one.", "She spent $3,400 with us this year.",
      ];
      const keep = [
        "HOA fees are $300 a month.", "$5,000 in closing cost help.", "The seller paid closing costs.", "Our marketing plan targets $2M homes.", "Charge up your phone before the shoot.",
        "The first weekend decides your price.", "Most sellers learn the pricing lesson after the listing has already gone live.", "At a $1M price point, buyers read the first weekend as a signal.",
        "Price it right on day one and the down payment math works for the buyer too.", "The listing price is $725,000.", "Homes in this zip sell for $450K.", "Mention the $25,000 price drop.",
        "Their HOA covers the pool.", "Buyers put 20 percent down on average.", "Mortgage payments run about $2,800 a month.", "She's in charge of the open house.", "Keep the color balance warm.",
        "Fix the audio balance at 0:12.", "Total of 45 photos.", "Pay attention to the kitchen light.", "The house was priced at $1.2M.", "Down payment assistance up to $5,000.",
        "Earnest money deposit is due in three days.", "Property taxes are about $6,000 a year.", "Rent in this building starts at $2,400 a month.", "Show the 3 bedrooms first.",
        "Interest rate is 6.5% right now.", "Voice and music balance should sit under the music.", "We owe it to our buyers to show the street.", "Film the floor plan walkthrough.",
      ];
      const leaks = drop.filter((s) => !mentionsOurBilling(s) || stripMoneySentences(s) !== "");
      const wrong = keep.filter((s) => mentionsOurBilling(s) || stripMoneySentences(s) !== s);
      c.ok(`all ${drop.length} lines of OUR money are dropped (owe/owes, "Price: 325", our/VIP pricing, percent off, the $12,000/yr deal…)`, leaks.length === 0 && drop.length === 32, leaks.join(" | "));
      c.ok(`all ${keep.length} real-estate / editing lines stay (HOA fees, closing cost help, "$2M homes", "Charge up", colour balance…)`, wrong.length === 0 && keep.length === 30, wrong.join(" | "));
      c.ok("…in a multi-line note, only the billing sentence goes", stripMoneySentences("HOA fees are $300 a month. She owes us for last month.\nFilm the porch first.") === "HOA fees are $300 a month.\nFilm the porch first.");
    });

    // =========================================================================
    await section("§2 · the self-check starts UNANSWERED (item 2)", async () => {
      const sc = await import("@/lib/selfCheck");
      const { SelfCheckDialog } = await import("@/components/editing/SelfCheckDialog");
      const profile = sc.resolveSelfCheckProfile("standard_reel", null);
      const issue = { id: "issue-1", text: "Trim the intro by a second", category: "edit", timeSec: 2, fromRound: 1, raisedByName: "James" };
      const ctx = { profile, isRevision: true, issues: [issue] };
      const ids = { isRevision: true, openIssueIds: ["issue-1"] };
      const asked = sc.itemsFor(profile, ids);
      const file = { name: "v2.mp4", size: 10, lastModified: 1 };
      const start = sc.oneScreenStart(profile, ids);
      const v0 = sc.validateSelfCheck(profile, sc.oneScreenInput(profile, ids, start, file), ids);
      c.ok("one untouched press records NOTHING: every line and the open note are missing", !v0.ok && v0.missing.length === asked.length + 1, v0.ok ? "" : `${v0.missing.length} missing · ${v0.message}`);
      const html = renderHtml(createElement(SelfCheckDialog, { context: ctx, file, onCancel: () => {}, onSubmit: async () => ({ ok: true, message: "" }) }));
      const boxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
      const sendBtn = (html.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []).find((b) => plain(b).includes("All checked — send it")) ?? "";
      c.ok("the dialog draws every line and the note with NOTHING ticked", boxes.length === asked.length + 1 && boxes.every((b) => !/ checked=""/.test(b)), `${boxes.length} boxes`);
      c.ok("…ONE send button, OFF until every line and note is answered", / disabled=""/.test(sendBtn) && (html.match(/All checked — send it/g) ?? []).length === 1);
      c.ok("…and it says how far along: \"0 of 7 answered\"", plain(html).includes(`0 of ${asked.length + 1} answered`), plain(html).slice(-260));

      // Drive the real dialog: "Doesn't apply" on captions opens an EMPTY reason box (stock sentence is only the placeholder).
      let sent: unknown = null;
      const ui = mountHooks(() => SelfCheckDialog({ context: ctx, file, onCancel: () => {}, onSubmit: async (i) => { sent = i; return { ok: true, message: "" }; } }));
      const buttons = () => named(ui.render(), "button");
      const lineButtons = (key: string) => {
        const li = named(ui.render(), "li").find((p) => p["data-check-line"] === key)!;
        return { li, na: named(li.children, "button")[0], box: named(li.children, "input").find((p) => p.type === "checkbox")! };
      };
      (lineButtons("captions_text").na.onClick as () => void)();
      const reasonBox = named(lineButtons("captions_text").li.children, "input").find((p) => p.type !== "checkbox");
      c.ok("\"Doesn't apply\" opens an EMPTY reason box — the product's sentence is only the placeholder", !!reasonBox && reasonBox.value === "" && reasonBox.placeholder === profile.items.find((i) => i.key === "captions_text")!.naHint, JSON.stringify({ value: reasonBox?.value, placeholder: reasonBox?.placeholder }));
      for (const it of asked) if (it.key !== "captions_text") (lineButtons(it.key).box.onChange as () => void)();
      const noteLi = () => named(ui.render(), "li").find((p) => p["data-check-note"] === "issue-1")!;
      (named(noteLi().children, "input").find((p) => p.type === "checkbox")!.onChange as () => void)();
      const sendNow = () => buttons().find((b) => textOf(b.children).includes("All checked — send it"))!;
      c.ok("with captions N/A and no reason typed, Send stays off", sendNow().disabled === true);
      (named(lineButtons("captions_text").li.children, "input").find((p) => p.type !== "checkbox")!.onChange as (e: unknown) => void)({ target: { value: "No captions or on-screen text in this one." } });
      c.ok("…typing a reason of their own turns Send on", sendNow().disabled === false);
      (sendNow().onClick as () => void)();
      await until(() => sent !== null, "the dialog's send");
      const input = sent as import("@/lib/selfCheck").SelfCheckInput;
      c.ok("…and what it sends is exactly what was answered: 5 YES, captions N/A with the typed reason, the note fixed",
        Object.values(input.answers).filter((a) => a.answer === "YES").length === asked.length - 1 && input.answers.captions_text?.answer === "NA" && input.answers.captions_text.reason === "No captions or on-screen text in this one." && JSON.stringify(input.issues?.addressed) === JSON.stringify(["issue-1"]));
      const brand = sc.resolveSelfCheckProfile("personal_branding", null, { brandChoice: "none" }).items.find((i) => i.key === "brand_assets")!;
      c.ok("the one recorded exception: on a video the office marked \"no brand assets\", choosing N/A carries the office's own reason", sc.naStartingReason(brand) === sc.BRAND_NONE_REASON && sc.naStartingReason(profile.items.find((i) => i.key === "captions_text")!) === "");

      // A job-wide ask on a three-video job is not closed by one video's upload.
      const { applySelfCheckDeclarations, openIssuesForSlot } = await import("@/lib/revisionIssues");
      const p = await prisma.project.create({ data: { title: "12 Wide Ask Ln, Media, PA", clientId: client.id, status: "EDITING" }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Personal Branding Reel", videoStyle: "personal_branding", quantity: 3 }, select: { id: true } });
      const sub2 = await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, slot: 2, round: 2, status: "PENDING", source: "upload", fileName: "v2.mp4", submittedByKey: "kim" }, select: { id: true } });
      const wide = await prisma.revisionIssue.create({ data: { projectId: p.id, summary: "Make the logo bigger on every video", originalText: "Make the logo bigger on every video", state: "OPEN", sourceKind: "MANUAL", sourceId: "ssfix-wide-1", raisedByName: "Dana" }, select: { id: true } });
      const own = await prisma.revisionIssue.create({ data: { projectId: p.id, deliverableId: d.id, slot: 2, summary: "Trim the intro", originalText: "Trim the intro", state: "OPEN", sourceKind: "MANUAL", sourceId: "ssfix-own-1", raisedByName: "James" }, select: { id: true } });
      const listed = await openIssuesForSlot(p.id, { deliverableId: d.id, slot: 2 });
      c.ok("the job-wide ask is listed on video 2's check, labelled as the whole job's", listed.find((i) => i.id === wide.id)?.jobWide === true && listed.find((i) => i.id === own.id)?.jobWide !== true, JSON.stringify(listed.map((i) => [i.text, i.jobWide])));
      await applySelfCheckDeclarations(sub2.id, { addressed: [wide.id, own.id], notAddressed: {} }, { name: "Kim Miguel" });
      const [w, o] = await Promise.all([prisma.revisionIssue.findUniqueOrThrow({ where: { id: wide.id } }), prisma.revisionIssue.findUniqueOrThrow({ where: { id: own.id } })]);
      c.ok("video 2's \"fixed\" closes its OWN note, but the job-wide ask stays OPEN for videos 1 and 3 (recorded as fixed in video 2)",
        o.state === "ADDRESSED" && w.state === "OPEN" && (await prisma.revisionIssueEvent.count({ where: { issueId: wide.id, kind: "FIXED_IN_ONE_VIDEO", submissionId: sub2.id } })) === 1, `${o.state} / ${w.state}`);
    });

    // =========================================================================
    await section("§3 · Home never folds a red or amber queue (item 6)", async () => {
      const { foldNeeds } = await import("@/lib/homeNeeds");
      const n = (key: string, tone: "brand" | "danger" | "warning" | "muted") => ({ key, tone });
      const needs = [n("mytodos", "brand"), n("cuts", "brand"), n("tosend", "brand"), n("stuck", "muted"), n("tomorrow", "warning"), n("late", "warning"), n("incidents", "danger"), n("assign", "muted")];
      const f = foldNeeds(needs, 3);
      const shown = [f.lead, ...f.next].map((x) => x?.key);
      c.ok("every amber and red row is on screen, however far down it sat", ["tomorrow", "late", "incidents"].every((k) => shown.includes(k)), shown.join(", "));
      c.ok("…the fold holds only calm rows, and its count is what it holds", f.later.every((x) => x.tone === "brand" || x.tone === "muted") && f.later.length === needs.length - 1 - f.next.length, f.later.map((x) => x.key).join(", "));
      c.ok("…calm rows only fill the room the urgent ones leave (3 under the lead, here all three urgent)", f.next.length === 3 && f.next.every((x) => x.tone !== "brand" && x.tone !== "muted"));
      const calm = foldNeeds([n("a", "brand"), n("b", "brand"), n("c", "muted"), n("d", "muted"), n("e", "muted")], 3);
      c.ok("with nothing urgent: lead + 3, the rest folded (unchanged)", calm.next.length === 3 && calm.later.length === 1);
    });

    // =========================================================================
    await section("§4 · a pending verdict receipt is never evicted or lost (item 12)", async () => {
      const store = await import("@/components/review/verdictReceiptStore");
      const base = { cutHref: "/review/x", title: "Approved", cut: "1 Elm · Video 1", message: "…", next: null };
      const ids = [1, 2, 3, 4, 5].map((i) => store.addReceipt({ ...base, submissionId: `s${i}`, state: "pending" }));
      c.ok("five verdicts in a row, all still saving: all five cards stay (the cap only drops settled cards)", store.receiptsSnapshot().length === 5);
      store.updateReceipt(ids[0], { state: "done", message: "Approved." });
      store.updateReceipt(ids[1], { state: "done", message: "Approved." });
      const more = store.addReceipt({ ...base, submissionId: "s6", state: "pending" });
      c.ok("…a sixth trims a SETTLED card, never a pending one", store.receiptsSnapshot().length <= 5 && [ids[2], ids[3], ids[4], more].every((id) => store.receiptsSnapshot().some((r) => r.id === id)));
      store.dismissReceipt(ids[2]);
      c.ok("closing a card while it says \"Saving…\" hides it", !store.receiptsSnapshot().some((r) => r.id === ids[2]));
      store.updateReceipt(ids[2], { state: "refused", message: "This cut was already approved by Kyle." });
      const back = store.receiptsSnapshot().find((r) => r.id === ids[2]);
      c.ok("…and when the answer is a REFUSAL it comes back on screen, with the reason", back?.state === "refused" && back.message.includes("already approved"));
      store.dismissReceipt(ids[3]);
      store.updateReceipt(ids[3], { state: "done", message: "Approved." });
      c.ok("…a closed card whose answer is a success simply goes", !store.receiptsSnapshot().some((r) => r.id === ids[3]));
      for (const r of [...store.receiptsSnapshot()]) { store.updateReceipt(r.id, { state: "done" }); store.dismissReceipt(r.id); }
    });

    // =========================================================================
    await section("§5 · a typed note goes WITH the verdict (item 12)", async () => {
      const { CutReviewPanel } = await import("@/components/review/CutReviewPanel");
      const order: string[] = [];
      fakes.addCutNote = (async (i: { body: string; lane: string; kind: string }) => { order.push(`note:${i.lane}/${i.kind}:${i.body}`); return { ok: true }; }) as never;
      fakes.approveCut = (async () => { order.push("approve"); return { ok: true, message: "Approved — Topaz 1080p is queued." }; }) as never;
      fakes.requestCutChanges = (async () => { order.push("send-back"); return { ok: true, message: "Sent 1 change to Kim." }; }) as never;
      const submission = { id: "cut-typed-1", round: 1, status: "PENDING", assetUrl: null, assetPath: null, fileName: "v1.mp4", note: null, submittedByKey: "kim", submittedByName: "Kim", createdAt: new Date().toISOString(), decidedAt: null, decidedBy: null, clientRequestedAt: null, clientRequestedBy: null, verdict: null, reviewerMove: null, deliverableId: "d1", slot: 1, source: "upload", hasHubCopy: true, completedAt: null, heldForCheck: false, selfChecked: true };
      const mount = (id: string) => mountHooks(() => CutReviewPanel({ projectId: "p1", submission: { ...submission, id }, notes: [], editorLabel: "Kim", canDecide: true, nextCut: null, street: "1 Elm St" } as never));
      const ui = mount("cut-typed-1");
      const btn = (label: string) => named(ui.render(), "button").find((b) => textOf(b.children).includes(label));
      (btn("Add note")!.onClick as () => void)();
      (named(ui.render(), "MentionTextarea")[0].onChange as (v: string) => void)("Logo is cropped at the end");
      c.ok("with a change request typed and nothing saved yet, \"Request changes\" is offered (the typed note counts)", btn("Request changes")?.disabled === false && textOf(btn("Request changes")!.children).includes("(1)"));
      (btn("Approve cut")!.onClick as () => void)();
      await until(() => order.includes("approve"), "the verdict");
      c.ok("pressing Approve with words in the composer ADDS the note first, then approves — nothing typed is dropped", JSON.stringify(order) === JSON.stringify(["note:EDITOR/fix:Logo is cropped at the end", "approve"]), order.join(" → "));
      // A refused note: nothing is decided.
      order.length = 0;
      fakes.addCutNote = (async () => { order.push("note-refused"); return { ok: false, message: "Your session expired." }; }) as never;
      const ui2 = mount("cut-typed-2");
      const btn2 = (label: string) => named(ui2.render(), "button").find((b) => textOf(b.children).includes(label));
      (btn2("Add note")!.onClick as () => void)();
      (named(ui2.render(), "MentionTextarea")[0].onChange as (v: string) => void)("Colour is too warm");
      (btn2("Request changes")!.onClick as () => void)();
      await until(() => order.length > 0, "the note attempt");
      await new Promise((r) => setTimeout(r, 30));
      const store = await import("@/components/review/verdictReceiptStore");
      const rc = store.receiptsSnapshot().find((r) => r.submissionId === "cut-typed-2");
      c.ok("…if the note is refused, the verdict is NOT sent and the receipt says why", JSON.stringify(order) === JSON.stringify(["note-refused"]) && rc?.state === "refused" && /didn't save, so nothing was decided/.test(rc.message), `${order.join(",")} · ${rc?.state} ${rc?.message}`);
      delete fakes.addCutNote; delete fakes.approveCut; delete fakes.requestCutChanges;
    });

    // =========================================================================
    await section("§6 · CutUploader: the server's list on a refusal; a confirming hand-in survives Next (item 11)", async () => {
      const up = await import("@/components/editing/CutUploader");
      const sc = await import("@/lib/selfCheck");
      const profile = sc.resolveSelfCheckProfile("standard_reel", null);
      const stale = { profile, isRevision: false, issues: [] as { id: string; text: string; category: string; timeSec: number | null; fromRound: number | null; raisedByName: string | null }[] };
      const freshIssue = { id: "note-arrived", text: "Music cuts off at 0:41", category: "audio", timeSec: 41, fromRound: 1, raisedByName: "James", state: "OPEN" };
      const key1 = "dl1:1", key2 = "dl1:2";
      const summary = { approved: 0, total: 2, firstReviewer: "James", sentTo: null, videos: [{ key: key1, outputId: "out1", number: 1, topic: null, open: true }, { key: key2, outputId: "out2", number: 2, topic: "Main Street", open: true }] };
      fakes.uploadPanelSummary = (async () => summary) as never;
      let startCalls = 0;
      fakes.startCutUpload = (async () => {
        startCalls++;
        if (startCalls === 1) return { ok: false, needsSelfCheck: true, message: "A note arrived on this video — answer it too.", checkContext: { key: key1, profile, isRevision: true, issues: [freshIssue] } };
        return { ok: true, submissionId: "sub-confirming", pathname: "cuts/p/sub.mp4", round: 1, access: "public" };
      }) as never;
      fakes.upload = (async (pathname: string) => ({ url: `https://drillstore.public.blob.vercel-storage.com/${pathname}`, downloadUrl: "", pathname, contentType: "video/mp4", contentDisposition: "inline" })) as never;
      const finishGate = deferred<{ ok: boolean; message: string }>();
      fakes.cutUploadFinishReceipt = (async () => finishGate.promise) as never;
      fakes.abandonCutUpload = (async () => ({ ok: true })) as never;
      fakes.cutTakeBackFlags = (async () => null) as never;
      const g = globalThis as Record<string, unknown>;
      const win = { location: { href: "https://hub.drill/edit/p1#submit-cut" }, history: { state: null, replaceState: (_d: unknown, _t: string, url: string) => { win.location.href = new URL(url, win.location.href).href; } }, addEventListener() {}, removeEventListener() {} };
      g.window = win;
      g.document = { addEventListener() {}, removeEventListener() {} };
      try {
        const row = (slot: number) => ({ deliverableId: "dl1", slot, label: `Listing Reel — Video ${slot} of 2`, latest: null, openNotes: 0 });
        let props: Record<string, unknown> = { projectId: "p1", cuts: [row(1)], canUpload: true, checks: { [key1]: stale }, jobSummary: summary };
        const ui = mountHooks(() => up.CutUploader(props as Parameters<typeof up.CutUploader>[0]));
        ui.render();
        const fileInput = named(ui.render(), "input").find((p) => p.type === "file")!;
        (fileInput.onChange as (e: unknown) => void)({ target: { files: [{ name: "v1.mp4", size: 9, type: "video/mp4", lastModified: 3 }], value: "" } });
        await until(() => named(ui.render(), "SelfCheckDialog").length === 1, "the check");
        const first = named(ui.render(), "SelfCheckDialog")[0];
        c.ok("setup: the check opens with the page-load list (no notes on it)", (first.context as typeof stale).issues.length === 0);
        const yes = sc.oneScreenStart(profile, { isRevision: false, openIssueIds: [] });
        for (const it of sc.itemsFor(profile, { isRevision: false, openIssueIds: [] })) yes.answer[it.key] = "YES";
        await (first.onSubmit as (i: unknown) => Promise<unknown>)(sc.oneScreenInput(profile, { isRevision: false, openIssueIds: [] }, yes, { name: "v1.mp4", size: 9 }));
        await until(() => named(ui.render(), "SelfCheckDialog").length === 1, "the refused check to come back");
        const again = named(ui.render(), "SelfCheckDialog")[0];
        c.ok("the server refused (a note arrived): the check comes back with the SERVER's list — the new note is on it, so the next answer can pass",
          (again.context as typeof stale).issues.some((i) => i.id === "note-arrived") && again.notice === "A note arrived on this video — answer it too.", JSON.stringify((again.context as typeof stale).issues));
        const ids2 = { isRevision: true, openIssueIds: ["note-arrived"] };
        const ans = sc.oneScreenStart(profile, ids2);
        for (const it of sc.itemsFor(profile, ids2)) ans.answer[it.key] = "YES";
        ans.fixed["note-arrived"] = true;
        await (again.onSubmit as (i: unknown) => Promise<unknown>)(sc.oneScreenInput(profile, ids2, ans, { name: "v1.mp4", size: 9 }));
        await until(() => named(ui.render(), "UploadSentCard")[0]?.phase === "confirming", "the hand-in card (confirming)");
        const card = named(ui.render(), "UploadSentCard")[0] as { next: { onNavigate: () => void } | null };
        c.ok("setup: the bytes are in, the card says confirming…, and offers Next: Video 2", !!card.next);
        card.next!.onNavigate();
        props = { ...props, cuts: [row(2)] };
        win.location.href = "https://hub.drill/edit/p1?output=out2";
        c.ok("pressing Next while it is still confirming keeps the card (it moves with the editor)", named(ui.render(), "UploadSentCard")[0]?.phase === "confirming");
        finishGate.resolve({ ok: false, message: "The file didn't land in the store." });
        await until(() => named(ui.render(), "UploadSentCard")[0]?.phase === "problem", "the failed finish to show", 5_000).catch(() => {});
        const bad = named(ui.render(), "UploadSentCard")[0];
        c.ok("…and when that finish FAILS, the failure is on screen with Try again — on Video 2's page", bad?.phase === "problem" && bad.problem === "The file didn't land in the store." && typeof bad.onRetry === "function", JSON.stringify(bad && { phase: bad.phase, problem: bad.problem }));
      } finally {
        delete g.window; delete g.document;
        for (const k of ["uploadPanelSummary", "startCutUpload", "upload", "cutUploadFinishReceipt", "abandonCutUpload", "cutTakeBackFlags"]) delete fakes[k];
      }
    });

    // =========================================================================
    await section("§7 · \"Got it\" — this video only, success only after the save (item 8)", async () => {
      const { BriefGotIt } = await import("@/components/editing/BriefGotIt");
      const calls: string[] = [];
      let gate = deferred<{ ok: boolean; message: string }>();
      fakes.acknowledgeEditorBrief = (async (_p: string, outputId: string) => { calls.push(outputId); return gate.promise; }) as never;
      const ui = mountHooks(() => BriefGotIt({ projectId: "p1", videoNumber: 2, pending: [{ outputId: "out2", digest: "d2" }], changed: false, noLogo: false, otherVideos: [{ number: 1, href: "/edit/p1?output=out1" }, { number: 3, href: "/edit/p1?output=out3" }] }));
      const html = () => plain(renderHtml(ui.render() as ReactNode));
      c.ok("the button names THIS video, and the other videos waiting for a Got it are named with a link", html().includes("Got it — video 2") && /Still waiting for your Got it: video 1\s*,\s*video 3/.test(html()), html());
      (named(ui.render(), "button")[0].onClick as () => void)();
      await until(() => calls.length === 1, "the receipt call");
      c.ok("the press acknowledges ONLY video 2 — never the unopened videos", JSON.stringify(calls) === JSON.stringify(["out2"]));
      c.ok("…while it saves, it says \"Saving…\" — not \"Got it\"", html().includes("Saving…") && !html().includes("the office can see you have"), html());
      gate.resolve({ ok: false, message: "The brief changed. Refresh and read it before acknowledging." });
      await until(() => html().includes("The brief changed"), "the refusal");
      c.ok("a refusal comes back with the reason and the button — no success shown", html().includes("Nothing was recorded") && html().includes("Got it — video 2") && !html().includes("the office can see you have"), html());
      gate = deferred();
      (named(ui.render(), "button")[0].onClick as () => void)();
      await until(() => calls.length === 2, "the second press");
      gate.resolve({ ok: true, message: "Received." });
      await until(() => html().includes("the office can see you have"), "the success");
      c.ok("…and only once the server saved it: \"Got it — the office can see you have video 2's brief.\"", html().includes("Got it — the office can see you have video 2’s brief."), html());
      delete fakes.acknowledgeEditorBrief;
    });

    // =========================================================================
    await section("§8 · Kyle by DUTY, never at night, once under a race; one bell for a held file (items 3, 17, A)", async () => {
      const { noticeForKyle, kyleTeamMemberId } = await import("@/lib/kyleNotice");
      c.ok("\"Kyle\" is the DELIVERY duty owner — with a second Kyle on the roster (the old name lookup gave up on two)", (await kyleTeamMemberId()) === kyle.id);
      setClock(edt(10, 6, 23, 30));
      const s0 = slack.length;
      const night = await noticeForKyle({ kind: "topaz_problem", title: "1080p file held — 9 Night Ln", body: "Listen to it.", href: "/#video-review", dedupeKey: "ssfix-night-1", slack: "1080p file held — 9 Night Ln" });
      c.ok("at 11:30 PM ET his Slack is HELD to the morning, not sent (holdOvernight)", night.bell && night.slack === "held" && slack.slice(s0).filter((m) => m.channel === "U-KYLE").length === 0, JSON.stringify(night));
      setClock(edt(10, 7, 10, 0));
      const s1 = slack.length;
      const race = await Promise.all([1, 2, 3].map(() => noticeForKyle({ kind: "topaz_problem", title: "Topaz credits are running low", body: "Top up.", href: "/#video-review", dedupeKey: "ssfix-race-1", slack: "Topaz credits are running low" })));
      c.ok("three sweeps racing on the same notice: ONE bell row and ONE DM", (await prisma.notification.count({ where: { dedupeKey: { startsWith: "ssfix-race-1" } } })) === 1 && slack.slice(s1).filter((m) => m.channel === "U-KYLE").length === 1 && race.filter((r) => r.bell).length === 1, JSON.stringify(race));
      const { heldFileBellTargets } = await import("@/lib/topazJobs");
      const targets = heldFileBellTargets(james.id, kyle.id);
      c.ok("a held 1080p file: Jordan's row and James's — no ADMIN broadcast for Kyle to read beside his own notice", JSON.stringify(targets) === JSON.stringify([{ roles: ["OWNER"] }, { roles: ["ADMIN"], userKey: `tm:${james.id}` }]), JSON.stringify(targets));
      c.ok("…and if Kyle is the reviewer, no second row for him", heldFileBellTargets(kyle.id, kyle.id).length === 1);
      // A delivery owner whose login links to nobody: a clear error, the
      // office's bell, never a guess (not even the "Kyle" on the roster).
      const ghost = await prisma.appUser.create({ data: { email: "ghost.owner@drill.invalid", name: "Ghost Owner", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
      await prisma.programOwnerAssignment.updateMany({ where: { duty: "DELIVERY" }, data: { appUserId: ghost.id, teamMemberId: null } });
      const none = await noticeForKyle({ kind: "topaz_problem", title: "Nobody owns delivery", body: "x", href: "/", dedupeKey: "ssfix-noowner-1", slack: "x" });
      const row = await prisma.notification.findFirst({ where: { dedupeKey: { startsWith: "ssfix-noowner-1" } } });
      c.ok("an unlinked delivery owner: a clear error, the office role's bell, and no person guessed", /not linked to one active team member/.test(none.error ?? "") && row?.userKey === null && JSON.parse(row?.audience ?? "[]").includes("ADMIN"), JSON.stringify(none));
      await prisma.programOwnerAssignment.updateMany({ where: { duty: "DELIVERY" }, data: { appUserId: uKyle.id, teamMemberId: kyle.id } });
    });

    // =========================================================================
    await section("§9 · a send-back: the relay exists BEFORE the answer (items 3, 10, 16)", async () => {
      const actions = await import("@/app/review/actions");
      const mkJob = async (street: string) => {
        const p = await prisma.project.create({ data: { title: `${street}, Royersford, PA`, clientId: client.id, status: "REVIEW", addressLine: street }, select: { id: true } });
        const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
        return { id: p.id, deliverableId: d.id };
      };
      const mkCut = async (job: { id: string; deliverableId: string }, by: string | null) => {
        const row = await prisma.reviewSubmission.create({ data: { projectId: job.id, deliverableId: job.deliverableId, slot: 1, round: 1, kind: "video", source: "upload", status: "PENDING", fileName: "cut.mp4", submittedByKey: by, submittedByName: by ? "Kim Miguel" : null, sizeBytes: 5 }, select: { id: true } });
        await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: `/api/review/cut/${row.id}/stream`, blobUrl: `https://drillstore.public.blob.vercel-storage.com/${row.id}.mp4`, blobPathname: `${row.id}.mp4` } });
        return row.id;
      };
      const bells = (prefix: string) => prisma.notification.findMany({ where: { dedupeKey: { startsWith: prefix } }, select: { userKey: true, title: true } });
      // An outside agency's round, sent back by James at 11 PM ET.
      setClock(edt(10, 7, 23, 0));
      const L = await mkJob("107 Agency Way");
      const cutL = await mkCut(L, null);
      await prisma.smartTask.create({ data: { projectId: L.id, taskType: "edit_video", title: "Edit the video — 107 Agency Way", status: "OPEN", assignedKey: "external_agency", assignedManually: true, dedupeKey: `edit-video-${L.id}` } });
      await as(uJordan);
      await actions.addCutNote({ projectId: L.id, submissionId: cutL, body: "Swap the music", lane: "EDITOR", kind: "fix", timeSec: 5 });
      await as(uJames);
      afterQueue.length = 0;
      const s0 = slack.length;
      const r = await actions.requestCutChanges(cutL);
      const task = await prisma.smartTask.findFirst({ where: { projectId: L.id, dedupeKey: { startsWith: `review-relay:${cutL}` } } });
      c.ok("ON THE ANSWER (before any background): a relay task OWNED by Kyle exists — the round can't be lost with the background", r.ok && task?.status === "OPEN" && task.ownerId === kyle.id && task.assignedKey === "kyle" && /Relay cut changes to Luma Visuals/.test(task.title), `${r.message} · ${task?.title}`);
      c.ok("…and Kyle's bell row is already written", (await bells(`review-relay-${cutL}`)).some((b) => b.userKey === `tm:${kyle.id}`));
      c.ok("…the answer says what is true: Kyle has a task to relay it", /Kyle has a task to relay them/.test(r.message), r.message);
      c.ok("…only the DM waits for the background", afterQueue.length === 1 && slack.length === s0);
      await flush();
      c.ok("in the background at 11 PM ET: Kyle's DM is HELD overnight, never sent at night", slack.slice(s0).filter((m) => m.channel === "U-KYLE").length === 0);
      // Kyle sends one back himself.
      setClock(edt(10, 8, 10, 0));
      const S = await mkJob("108 Self Relay Ct");
      const cutS = await mkCut(S, null);
      await prisma.smartTask.create({ data: { projectId: S.id, taskType: "edit_video", title: "Edit the video — 108 Self Relay Ct", status: "OPEN", assignedKey: "external_agency", assignedManually: true, dedupeKey: `edit-video-${S.id}` } });
      await as(uKyle);
      await actions.addCutNote({ projectId: S.id, submissionId: cutS, body: "Colour is too warm", lane: "EDITOR", kind: "fix", timeSec: 9 });
      const s1 = slack.length;
      const rs = await actions.requestCutChanges(cutS);
      await flush();
      c.ok("Kyle pressing it himself: no bell for him about his own send-back, no DM to himself — the task is still his list",
        rs.ok && !(await bells(`review-relay-${cutS}`)).some((b) => b.userKey === `tm:${kyle.id}`) && !(await bells(`review-changes-${cutS}`)).some((b) => b.userKey === `tm:${kyle.id}`) && slack.slice(s1).filter((m) => m.channel === "U-KYLE").length === 0 && !!(await prisma.smartTask.findFirst({ where: { dedupeKey: { startsWith: `review-relay:${cutS}` }, ownerId: kyle.id } })) && /yourself/.test(rs.message),
        rs.message);
      // An in-house editor: Kim's bell row exists before the background.
      const K = await mkJob("109 Kim Ct");
      const cutK = await mkCut(K, "kim");
      await prisma.smartTask.create({ data: { projectId: K.id, taskType: "edit_video", title: "Edit — 109 Kim Ct", status: "IN_PROGRESS", assignedKey: "kim", dedupeKey: `edit-video-${K.id}` } });
      await as(uJordan);
      await actions.addCutNote({ projectId: K.id, submissionId: cutK, body: "Trim the intro", lane: "EDITOR", kind: "fix", timeSec: 2 });
      await as(uJames);
      afterQueue.length = 0;
      const rk = await actions.requestCutChanges(cutK);
      c.ok("an in-house editor's sent-back bell is written on the answer, before the background", rk.ok && (await bells(`review-changes-${cutK}`)).some((b) => b.userKey === "editor:kim") && afterQueue.length === 1);
      await flush();
    });

    // =========================================================================
    await section("§10 · raws are in on a SHOT job with raw footage (item 14)", async () => {
      const { rawsAreIn } = await import("@/lib/mentions");
      const withRaws = await prisma.project.create({ data: { title: "14 Raw Rd", clientId: client.id, status: "SHOT", statusEvidence: JSON.stringify({ dropbox: { rawVideo: 12 } }) }, select: { id: true } });
      const without = await prisma.project.create({ data: { title: "15 Empty Rd", clientId: client.id, status: "SHOT" }, select: { id: true } });
      c.ok("a SHOT job whose Raw Video folder has clips: the raws are in (the editor hears the chat)", await rawsAreIn(withRaws.id));
      c.ok("…a SHOT job with nothing in the folder still waits", !(await rawsAreIn(without.id)));
    });

    // =========================================================================
    await section("§11 · a monthly job can't be sent from the Final folder, server-side (B)", async () => {
      const actions = await import("@/app/review/actions");
      const shell = await (await import("../_fixtures/representativeMonth")).createTestClientShell(prisma, { name: "Folder Month TEST", slug: "ssfixfolder" });
      const month = await prisma.contentMonth.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, monthKey: "2026-10", videosOwed: 2 } });
      const p = await prisma.project.create({ data: { clientId: shell.clientId, contentMonthId: month.id, title: "Folder Month — October session", status: "EDITING", editorId: kim.id, editorManual: true }, select: { id: true } });
      await prisma.deliverable.create({ data: { projectId: p.id, type: "SOCIAL_REEL", label: "Video Accelerator", videoStyle: "personal_branding", quantity: 2 } });
      await prisma.smartTask.create({ data: { projectId: p.id, taskType: "edit_video", title: "Edit the session", status: "OPEN", assignedKey: "kim", assignedManually: true, dedupeKey: `edit-video-${p.id}` } });
      await as(uKim);
      const before = await prisma.reviewSubmission.count({ where: { projectId: p.id } });
      const r = await actions.submitCutForReview(p.id, "From the Final folder");
      c.ok("\"Send from the Final folder\" on a monthly job is refused with the plain sentence, and nothing is written",
        !r.ok && r.message.includes("upload the file here instead — the 1080p pass needs the hub's own copy") && (await prisma.reviewSubmission.count({ where: { projectId: p.id } })) === before, r.message);
    });

    // =========================================================================
    await section("§12 · the edit page (items 1, 7, 8, 9, 17)", async () => {
      const { ensureOutputsForProject } = await import("@/lib/deliverableOutputs");
      const { default: page } = await import("@/app/edit/[id]/page");
      const yesterday = new Date(Date.now() - 864e5);
      const due = new Date(Date.now() + 10 * 864e5);
      const view = async (u: typeof uKim, id: string, search: Record<string, string> = {}) => {
        await as(u);
        const tree = await resolveTree(await page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) }));
        return { tree, html: renderHtml(tree), text: plain(renderHtml(tree)) };
      };

      // (a) A premium cinematic listing video with a Studio script, song and shot list.
      const rob = await prisma.client.create({ data: { name: "Rob Premium", autoConfirmationText: false, autoDeliveryText: false } });
      const cine = await prisma.project.create({ data: {
        clientId: rob.id, title: "415 Oak Street, Wayne, PA 19087", status: "EDITING", source: "MANUAL", shootDate: yesterday, deliveryDue: due, editorId: john.id, editorManual: true,
        statusEvidence: JSON.stringify({ dropbox: { rawVideo: 30 } }),
        reelHook: "Wait until you see the kitchen in this Wayne colonial.", reelScript: "Hi, I'm Rob with Main Line Realty. Welcome to 415 Oak Street.", reelSong: "Cinematic strings — slow build", reelShotList: "1. Drone push-in over the street\n2. Kitchen island reveal\n3. Rob at the front door",
      } });
      await prisma.deliverable.create({ data: { projectId: cine.id, type: "VIDEO", label: "Premium Cinematic Video", productTitle: "Premium Cinematic Video", videoStyle: "premium_cinematic", quantity: 1 } });
      await ensureOutputsForProject(cine.id);
      await prisma.smartTask.create({ data: { projectId: cine.id, clientId: rob.id, taskType: "edit_video", title: "Edit 415 Oak", assignedKey: "john", assignedManually: true, status: "OPEN", dedupeKey: `edit-video-${cine.id}`, dueAt: due, source: "manual" } });
      const j = await view(uJohn, cine.id);
      c.ok("premium cinematic + a Studio script on file: the Script section shows it — never \"No script on file\"", j.text.includes("Wait until you see the kitchen") && j.text.includes("Welcome to 415 Oak Street") && !j.text.includes("No script on file"), j.text.slice(0, 200));
      c.ok("…the Studio's shot list is there for the EDITOR (it was office-only)", j.html.includes("data-shot-list") && j.text.includes("Kitchen island reveal"));
      c.ok("…and the music rule is the Studio's song", j.text.includes("Use the song picked with the Studio script: Cinematic strings — slow build"));
      c.ok("…one video on the job: no shared-script caveat", !j.html.includes("data-shared-script"));

      // (b) A three-video monthly session: Kim has 1 and 3, John has 2.
      const shell = await (await import("../_fixtures/representativeMonth")).createTestClientShell(prisma, { name: "Dana Maple TEST", slug: "ssfixbrief" });
      await prisma.client.update({ where: { id: shell.clientId }, data: {
        generalNotes: "Fonts: Lora. She paid $40 for the font license.\nUse her logo on every video.",
        profileJson: JSON.stringify({ v: 2, segment: "vip", stats: { totalOrders: 9, revisions: 1, inboundMsgs: 4 }, summary: "", touchLevel: "low", workingStyle: "", communication: "", revisions: { summary: "", commonTypes: [] }, brandStyle: "", shootNotes: [], aboutThem: [], dos: [], donts: [],
          editing: { summary: "Dana likes calm edits.", prefs: ["Warm grade", "Slow pans", "Captions in her brand font", "Logo end card"], customerNotes: [], dos: [], donts: ["Never use stock music"] } }),
      } });
      const month = await prisma.contentMonth.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, monthKey: "2026-11", videosOwed: 3 } });
      const monthly = await prisma.project.create({ data: {
        clientId: shell.clientId, contentMonthId: month.id, title: "Dana Maple — November content session", addressLine: "22 Maple Ave, Media, PA 19063",
        status: "EDITING", source: "MANUAL", shootDate: yesterday, deliveryDue: due, editorId: kim.id, editorManual: true, statusEvidence: JSON.stringify({ dropbox: { rawVideo: 23 } }),
        reelHook: "Three things every Media buyer asks.", reelScript: "One script the Studio wrote for the whole session.",
      } });
      await prisma.deliverable.create({ data: { projectId: monthly.id, type: "SOCIAL_REEL", label: "Video Accelerator", productTitle: "Video Accelerator", videoStyle: "personal_branding", quantity: 3 } });
      await ensureOutputsForProject(monthly.id);
      const outs = await prisma.deliverableOutput.findMany({ where: { projectId: monthly.id }, orderBy: { slot: "asc" } });
      for (const [i, o] of outs.entries()) {
        const owner = i === 1 ? { ownerKey: "john", ownerName: "John Mark" } : { ownerKey: "kim", ownerName: "Kim" };
        await prisma.deliverableOutput.update({ where: { id: o.id }, data: { title: ["First weekend", "Main Street", "Inspection"][i], ...owner, ownerSetAt: yesterday, rawInAt: yesterday, promisedAt: due } });
      }
      await prisma.smartTask.create({ data: { projectId: monthly.id, clientId: shell.clientId, taskType: "edit_video", title: "Edit Dana Maple session", assignedKey: "kim", assignedManually: true, status: "OPEN", dedupeKey: `edit-video-${monthly.id}`, dueAt: due, source: "manual" } });
      // Two client asks: one about video 3, one for the whole job.
      await prisma.smartTask.create({ data: { projectId: monthly.id, clientId: shell.clientId, taskType: "revision", title: "Video revision — 22 Maple Ave", assignedKey: "kim", status: "OPEN", outputId: outs[2].id, description: "Make the inspection checklist text bigger.", dedupeKey: `ssfix-rev-v3-${monthly.id}` } });
      await prisma.smartTask.create({ data: { projectId: monthly.id, clientId: shell.clientId, taskType: "revision", title: "Video revision — 22 Maple Ave", assignedKey: "kim", status: "OPEN", description: "Use a warmer grade on all of them.", dedupeKey: `ssfix-rev-job-${monthly.id}` } });
      const k1 = await view(uKim, monthly.id, { output: outs[0].id });
      const changes1 = plain(block(k1.html, /data-brief-section="changes"/));
      c.ok("video 1's Changes to make: the whole-job ask, labelled \"For every video on this job\"", changes1.includes("For every video on this job") && changes1.includes("Use a warmer grade on all of them."), changes1 || "no Changes section");
      c.ok("…and NOT video 3's ask", !!changes1 && !changes1.includes("inspection checklist text bigger"), changes1);
      const k3 = await view(uKim, monthly.id, { output: outs[2].id });
      const changes3 = plain(block(k3.html, /data-brief-section="changes"/));
      c.ok("video 3's Changes to make: its own ask under \"What the client asked\", the job-wide one beside it", changes3.includes("What the client asked") && changes3.includes("Make the inspection checklist text bigger.") && changes3.includes("For every video on this job"), changes3);
      c.ok("the shared Studio script on a 3-video job says it isn't tied to one video", k1.html.includes("data-shared-script") && k1.text.includes("One script for the whole job"));
      const chips = (k1.html.match(/<a[^>]*href="\/edit\/[^"]*\?output=[^"]*"[^>]*>[\s\S]*?<\/a>/g) ?? []).map(plain).filter((t) => /^\d ·/.test(t));
      c.ok("each video chip names whose it is: \"you\" on Kim's, \"John\" on video 2", chips.length === outs.length && chips.every((t, i) => t.endsWith(i === 1 ? "· John" : "· you")), JSON.stringify(chips));
      const got = named(k1.tree, "BriefGotIt")[0];
      const kimsOthers = outs.map((_, i) => i + 1).filter((n) => n !== 1 && n !== 2);
      c.ok("\"Got it\" on video 1's page acknowledges video 1 only, and names Kim's other videos (not John's) as still waiting",
        !!got && JSON.stringify((got.pending as { outputId: string }[]).map((p) => p.outputId)) === JSON.stringify([outs[0].id]) && JSON.stringify((got.otherVideos as { number: number }[]).map((v) => v.number)) === JSON.stringify(kimsOthers),
        JSON.stringify(got && { pending: got.pending, others: got.otherVideos }));
      const { agentProfileFor } = await import("@/lib/clientProfile");
      const prof = await agentProfileFor(shell.clientId);
      c.ok("Agent Profile: with four preferences on file, the \"never\" rule still makes it", !!prof?.style.preferences.some((p) => p.text === "Never use stock music"), JSON.stringify(prof?.style.preferences.map((p) => p.text)));
      c.ok("…and the Aryeo note's font line goes through the money filter (Lora, without the $40)", prof?.style.fonts?.text?.includes("Lora") === true && !prof.style.fonts.text.includes("$40"), JSON.stringify(prof?.style.fonts));
    });

    // =========================================================================
    await section("§13 · the portal shows the script word for word (item 5)", async () => {
      const { portalTopicScript } = await import("@/lib/portal");
      const shell = await (await import("../_fixtures/representativeMonth")).createTestClientShell(prisma, { name: "Portal Words TEST", slug: "ssfixportal" });
      const topic = await prisma.contentTopic.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, title: "When you owe more than it's worth", status: "SCRIPTED" } });
      const body = "Sellers who owe more than the home is worth still have options.\nOur pricing for a short sale starts with a conversation.";
      await prisma.contentScript.create({ data: { enrollmentId: shell.enrollmentId, clientId: shell.clientId, topicId: topic.id, title: topic.title, body, releaseState: "released" } });
      const shown = await portalTopicScript({ id: shell.enrollmentId, clientId: shell.clientId }, topic.id);
      c.ok("the client reads the same words the crew films and the editor cuts — nothing dropped by the money filter", shown?.body === body, JSON.stringify(shown?.body));
    });

    // =========================================================================
    await section("§14 · a held 1080p file says \"on hold\"; one definition of late (items 15, 17)", async () => {
      const { ProjectVideoStatus } = await import("@/components/review/ProjectVideoStatus");
      const p = await prisma.project.create({ data: { title: "16 Held Ct, Media, PA", clientId: client.id, status: "REVIEW" }, select: { id: true } });
      const d = await prisma.deliverable.create({ data: { projectId: p.id, type: "VIDEO", label: "Listing Reel", quantity: 1 }, select: { id: true } });
      const s = await prisma.reviewSubmission.create({ data: { projectId: p.id, deliverableId: d.id, slot: 1, round: 1, status: "APPROVED", source: "upload", fileName: "held.mp4", decidedAt: new Date(), decidedBy: "James" }, select: { id: true } });
      await prisma.topazJob.create({ data: { submissionId: s.id, projectId: p.id, state: "held", heldPath: "/x/Final Video/unverified/held.mp4", heldAt: new Date() } });
      const html = plain(renderHtml(await resolveTree(createElement(ProjectVideoStatus, { projectId: p.id, selectedKey: `${d.id}:1` }))));
      c.ok("Project status: \"1080p on hold — Kyle has the next step\", never \"1080p pass running\"", html.includes("1080p on hold — Kyle has the next step") && !html.includes("1080p pass running"), html);
      const { editingWorkload } = await import("@/lib/editorWorkload");
      const past = new Date(Date.now() - 3 * 864e5).toISOString();
      const w = await editingWorkload([
        { status: "In editing", editorKey: "kim", editor: "Kim", videos: 1, dueISO: past, late: true },
        { status: "Ready for editing", editorKey: "kim", editor: "Kim", videos: 1, dueISO: past, late: false },
      ]);
      c.ok("the workload counts late by the queue's own flag — 1, the same as the header (a raw due < now said 2)", w.overdue === 1 && w.editors.find((e) => e.key === "kim")?.dueSoon === 0, `overdue=${w.overdue}`);
    });

    // =========================================================================
    await section("§15 · Home: money that couldn't load says so; an untimed shoot; held renders (items 17, 15)", async () => {
      const { default: home } = await import("@/app/page");
      const STREAMED = new Set(["HomeExceptions", "HomeRadar", "OwnerBusiness"]);
      const settle = async (tree: unknown): Promise<unknown> => {
        if (Array.isArray(tree)) return Promise.all(tree.map(settle));
        if (!isValidElement<Props>(tree)) return tree;
        if (typeof tree.type === "function" && STREAMED.has((tree.type as { name: string }).name)) return settle(await (tree.type as (p: Props) => Promise<unknown>)(tree.props));
        return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(tree.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
      };
      // The day's reads, with today's one shoot made untimed and two renders on the delivery board (one held).
      fakes.ownerPulse = (async () => { throw new Error("drill: the books read failed"); }) as never;
      const opsDay = await import("@/lib/opsDay");
      const realBuild = (opsDay as unknown as { buildOpsDay: (...a: unknown[]) => Promise<Record<string, unknown>> }).buildOpsDay;
      fakes.buildOpsDay = (async (...a: unknown[]) => {
        const d = await realBuild(...a);
        const shoots = (d.todayShoots as Record<string, unknown>[]).map((s) => ({ ...s, timeISO: null, endISO: null }));
        const rs = d.readySend as Record<string, unknown>;
        const ready = [{ submissionId: "r1", projectId: "p-r1", street: "1 Ready Rd", clientName: "Drill Agent", cutLabel: "Listing Reel", round: 1, approvedAtISO: new Date(Date.now() - 3_600_000).toISOString(), waitingHours: 1, file: { why: null } }];
        const rendering = [{ submissionId: "h1", state: "held", street: "2 Held Ct" }, { submissionId: "h2", state: "processing", street: "3 Busy Ln" }];
        return { ...d, todayShoots: shoots, readySend: { ...rs, ready, rendering } };
      }) as never;
      await prisma.project.create({ data: { title: "77 Untimed Way, Media, PA", clientId: client.id, status: "BOOKED", shootDate: new Date(Date.now() - 2 * 3_600_000) } });
      await as(uJordan);
      let tree: unknown;
      try {
        tree = await settle(await home({}));
      } finally {
        delete fakes.ownerPulse; delete fakes.buildOpsDay;
      }
      const all = textOf(tree);
      c.ok("the books read failed: the owner's money strip SAYS it couldn't load (it used to vanish)", named(tree, "p").some((p) => p["data-money-unavailable"] !== undefined && textOf(p.children).includes("The books (profit, bank, owed to you)")), all.slice(0, 200));
      c.ok("today's shoot has no time: the line says so, not \"all started\"", named(tree, "span").some((p) => p["data-untimed-shoots"] !== undefined && textOf(p.children).includes("77 Untimed Way has no time set")) && !all.includes("all started"));
      const needs = named(tree, "NeedsToday")[0]?.needs as { key: string; detail?: string }[] | undefined;
      const toSend = needs?.find((n) => n.key === "tosend");
      c.ok("the to-send row: \"1 more still processing · 1 1080p on hold — Kyle has the next step\" — a held file is never \"processing\"", !!toSend?.detail?.includes("1 more still processing") && toSend.detail.includes("1 1080p on hold — Kyle has the next step"), toSend?.detail);
    });

    c.ok("nothing left the machine but the fakes", fence.blocked.length === 0, fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
