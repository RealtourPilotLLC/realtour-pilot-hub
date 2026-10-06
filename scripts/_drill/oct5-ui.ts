// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: OCT 5 UI — Home, the Editing Room, /shoot and /upload for a monthly
// content session, simple and calm (Jordan: "simple and clear, without
// creating information overload in a small space … the UI as frictionless as
// possible").
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct5-ui.ts --logs /private/tmp/oct5-ui
//
//   1. Weak signal (the real components' own handlers, fake actions): a failed
//      notes save keeps every word and never says "Saved"; a failed flag comes
//      back off the list with its words back in the box; a failed status text
//      keeps the sheet and its text; "Done" asks ON THE PAGE (never
//      window.confirm) and a failed complete says so; the upload portal's
//      flag does the same, and "Discard" restored answers asks first and keeps
//      them when the discard does not land.
//   2. Home per role (Jordan OWNER, Kyle ADMIN, James the creative reviewer):
//      one "What needs you now" list whose lead is that role's first queue,
//      the rest folded with the urgent count said; delivery is a row with the
//      list's own count (no second delivery card); one line for today's
//      shoots and the full cards folded; the slow sections streamed behind
//      Suspense; each work destination linked once; no money for Kyle.
//   3. The Editing Room: soonest due first; who is working on what, by name,
//      on the row; today's evidence on the row (office only); the editor's
//      own queue with one named next action; filters fold on a phone.
//   4. /shoot for a content session: the office-APPROVED script shows (not
//      only Approve & share), open by default with the "film it as written"
//      line on an unapproved one; drafts never show; "I read this brief" sits
//      under the brief and the assigned shooter on an ADMIN login (James) can
//      mark it — Kyle cannot; the photographer's own notes are not a brief
//      change, the office's are; the screen speaks about topics, not rooms.
//   5. /upload for the content session: the per-topic notes lead and ask for
//      clip names; the general box says it applies to all videos; optional
//      boxes fold; no foyer/drone/pool placeholders, no "forfeits" line, no
//      Backup Photos; and the page never calls Script Studio for a content
//      session (a listing job still does — the control).
//
// ISOLATION. PGlite on 127.0.0.1:6600 through the shared harness; production
// is never opened. Every non-loopback call is fenced (Script Studio's host is
// configured to a fake one only so the control call has somewhere to be
// refused). Nothing is sent, charged or published.
//
// THE CLOCK IS PINNED to 12:00 noon ET on today's ET date (see below), so the
// drill answers the same at whatever hour it runs.
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement, isValidElement, Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = 6600;
const REPO = path.resolve(__dirname, "../..");

// ---- the clock (Oct 5 2026, night) ------------------------------------------
// Pinned to 12:00 noon ET on today's ET date, and running on from there. The
// drill used to read the real clock, and section 3 writes Kim's note 30
// minutes before "now" while the Editing Room counts only TODAY's activity
// (since 12:00am ET): run between midnight and 12:30am ET, the note landed on
// yesterday, the office row had no evidence to show, and one check failed at
// night that passed by day. At noon every relative time here (ago/ahead, from
// minutes to days) reads the same whatever the hour. Only the HOUR is pinned,
// not the date: rows the database layer stamps itself — Prisma's engine fills
// @default(now()) from the real system clock, not this process's Date — stay
// within half a day of the drill's "now".
const RealDate = Date;
const PIN_HOUR_ET = 12;
const etWall = (ms: number) =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new RealDate(ms))
      .map((p) => [p.type, p.value]),
  );
const PINNED = (() => {
  const today = etWall(RealDate.now());
  const wallAsUtc = RealDate.UTC(Number(today.year), Number(today.month) - 1, Number(today.day), PIN_HOUR_ET);
  // EDT is UTC-4, EST UTC-5: the one that reads as noon, today, in New York.
  const pinned = [4, 5].map((h) => wallAsUtc + h * 3_600_000).find((ms) => Number(etWall(ms).hour) === PIN_HOUR_ET && etWall(ms).day === today.day);
  if (pinned === undefined) throw new Error("could not pin the drill clock to noon ET");
  return pinned;
})();
const clockOffset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + clockOffset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + clockOffset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;

installNextStubs();
// Next bundles stylesheets (the shoot route map imports Leaflet's); this Node
// fixture never renders a map, so a .css import is simply nothing.
createRequire(__filename).extensions[".css"] = () => { /* stylesheet loading belongs to Next */ };
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const load = createRequire(__filename);
const search = "";
for (const navigation of [load("next/navigation"), load("./_next-navigation-stub.cjs")]) {
  navigation.redirect = (href: string) => { throw new Redirect(href); };
  navigation.useRouter = () => ({ refresh() {}, push() {}, replace() {}, prefetch() {}, back() {} });
  navigation.useSearchParams = () => new URLSearchParams(search);
  navigation.usePathname = () => "/";
}

// ---- element trees ----------------------------------------------------------
type El = { type: any; props: Record<string, any> };
const nameOf = (t: any): string => (typeof t === "string" ? t : typeof t === "symbol" ? String(t) : t?.displayName || t?.name || "?");
function walk(n: any, visit: (e: El) => void) {
  if (Array.isArray(n)) { n.forEach((x) => walk(x, visit)); return; }
  if (!isValidElement(n)) return;
  visit(n as unknown as El);
  for (const v of Object.values((n as unknown as El).props)) walk(v, visit);
}
const find = (tree: any, name: string): El[] => { const out: El[] = []; walk(tree, (e) => { if (nameOf(e.type) === name) out.push(e); }); return out; };
const findBy = (tree: any, pred: (e: El) => boolean): El[] => { const out: El[] = []; walk(tree, (e) => { if (pred(e)) out.push(e); }); return out; };
function words(n: any, out: string[] = []): string[] {
  if (n == null || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (isValidElement(n)) words((n as unknown as El).props.children, out);
  return out;
}
const textOfTree = (n: any) => words(n).join(" ").replace(/\s+/g, " ");
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const STREAMED = new Set(["HomeExceptions", "HomeRadar", "OwnerBusiness"]);
async function settle(tree: any): Promise<any> {
  if (Array.isArray(tree)) return Promise.all(tree.map(settle));
  if (!isValidElement(tree)) return tree;
  const el = tree as unknown as El;
  if (typeof el.type === "function" && STREAMED.has(el.type.name)) return settle(await el.type(el.props));
  return { ...tree, props: Object.fromEntries(await Promise.all(Object.entries(el.props).map(async ([k, v]) => [k, await settle(v)] as const))) };
}
const html = (el: El) => renderToStaticMarkup(createElement(el.type, el.props));

// ---- a hooks harness: a component's own render + handlers, no DOM ------------
// (the upload-portal-recovery-ui pattern: the real function, its real state,
// its real handlers; fake actions answer.)
function mountHooks(render: () => unknown) {
  const react = load("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { effect(); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await tick(); return test(); }
const buttonWith = (tree: any, label: string) => findBy(tree, (e) => e.type === "button" && textOfTree(e.props.children).includes(label))[0];

async function main() {
  const db = await bootDrillDb({
    port: PORT,
    env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct5-ui", SCRIPTING_BASE_URL: "https://studio.oct5-drill.invalid", SCRIPTING_API_KEY: "oct5-drill-fake-key" },
  });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const fence = fenceFetch();
  console.log(`drill clock: ${new Date().toISOString()} (pinned — 12:00 noon ET today)`);
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const signIn = (u: { id: string; email: string; role: string; name: string | null }) => setSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined });

    // =======================================================================
    c.head("1 · weak signal: failed saves keep the words and never say saved");
    // =======================================================================
    // Fake actions, seeded BEFORE the two client screens load so their
    // imports bind to these; removed again before the pages load the real ones.
    const shootActions = load.resolve("../../src/app/shoot/actions.ts");
    const uploadActions = load.resolve("../../src/app/upload/actions.ts");
    const draftActions = load.resolve("../../src/app/upload/draftActions.ts");
    const behave: Record<string, (...a: any[]) => Promise<any>> = {};
    const calls: Record<string, number> = {};
    const fake = (names: string[]) => new Proxy({ __esModule: true } as Record<string, unknown>, {
      get: (_t, k) => (k === "__esModule" ? true : k === "then" ? undefined : typeof k === "string" && names.includes(k)
        ? (...a: any[]) => { calls[k] = (calls[k] ?? 0) + 1; return (behave[k] ?? (async () => ({ ok: true, message: "" })))(...a); }
        : async () => ({ ok: true, message: "" })),
    });
    const put = (file: string, exports: unknown) => { load.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
    put(shootActions, fake(["saveShootNote", "flagShootIssue", "sendShootStatusText", "completeShoot", "sendClientMessage", "draftClientMessage", "recordShootPreference", "setDeliverableCaptured"]));
    put(uploadActions, fake(["flagIssue", "finalizeUpload", "checkUploadRawFiles", "readUploadAttempt"]));
    put(draftActions, fake(["saveUploadDraft", "discardUploadDraft"]));
    const storage = new Map<string, string>();
    const local = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } };
    let confirmCalls = 0, reloads = 0;
    const g = globalThis as any;
    Object.defineProperty(g, "localStorage", { configurable: true, value: local });
    Object.defineProperty(g, "window", { configurable: true, value: { localStorage: local, scrollTo() {}, addEventListener() {}, removeEventListener() {}, confirm: () => { confirmCalls++; return true; }, location: { reload: () => { reloads++; } } } });
    Object.defineProperty(g, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
    const { ShootScreen } = await import("@/components/shoot/ShootScreen");
    const { UploadPortal } = await import("@/components/upload/UploadPortal");
    const { videoStepSpec } = await import("@/lib/pipeline");
    const { submittedFieldsHash } = await import("@/lib/uploadDraft");

    const offline = async () => { throw new Error("isolated: the connection dropped"); };
    const view0: any = {
      project: { id: "weak-signal-job", title: "12 Signal St, Testville", street: "12 Signal St", addressFull: "12 Signal St, Testville", mapsQuery: "12 Signal St", packageName: "Video Starter", status: "SCHEDULED", shootDateISO: null, editorBrief: "First note", uploadedAt: null, squareFeet: null, photoTarget: null, aryeoListingId: null, reelHook: null, reelScript: null, reelSong: null, reelShotList: null, reelScriptUrl: null, reelRecipeUpdatedAt: null, addressChangePending: null, contentSession: true },
      appointment: null, extraAppointments: 0,
      client: { id: "c", name: "Signal Client TEST", firstName: "Signal", phone: "2155550100", phoneE164: "+12155550100", email: null, socialClient: true, socialPlan: "Starter", avatarUrl: null, customerNote: null, theirStyle: null, theirPreferences: null, brandColors: [] },
      segment: null, profile: null,
      deliverables: [{ id: "d1", type: "SOCIAL_REEL", label: "Video Starter", quantity: 3, status: "PENDING", capturedAt: null, uploadCount: 0 }],
      specialRequests: [], editRequests: [], flags: [], photographer: { id: "tm", name: "James Drill" }, zillowTourUrl: null, session: null, outputBriefs: [],
    };
    const screen = mountHooks(() => (ShootScreen as any)({ view: view0, pay: null, map: null, briefRead: null, whenText: "", timing: "today", media: null }));
    const screenTree = screen.render();
    const flashes: string[] = [];
    const flash = (k: string, t: string) => { flashes.push(`${k}:${t}`); };

    // NotesCard
    const notesEl = find(screenTree, "NotesCard")[0];
    const notes = mountHooks(() => notesEl.type({ ...notesEl.props, flash }));
    let nt = notes.render();
    const area = () => find(nt, "AutoTextarea")[0];
    area().props.onChange({ target: { value: "Topic 2: use take 3. Clips C0012–C0015." } });
    nt = notes.render();
    behave.saveShootNote = offline;
    buttonWith(nt, "Save notes").props.onClick();
    await until(() => { nt = notes.render(); return textOfTree(nt).includes("Not saved"); });
    nt = notes.render();
    c.ok("notes: a dropped save keeps every typed word in the box", area().props.value === "Topic 2: use take 3. Clips C0012–C0015.");
    c.ok("notes: …says it did not save, with the way to retry", /Not saved — the connection dropped\. Your notes are still here; tap Save notes to try again\./.test(textOfTree(nt)));
    c.ok("notes: …and never says Saved (button still reads Save notes; no 'saved' toast)", !!buttonWith(nt, "Save notes") && !buttonWith(nt, "Saved") && !flashes.some((f) => /saved/i.test(f)), flashes.join(" | "));
    behave.saveShootNote = async () => ({ ok: true });
    buttonWith(nt, "Save notes").props.onClick();
    await until(() => { nt = notes.render(); return !!buttonWith(nt, "Saved"); });
    c.ok("notes: the retry lands → Saved, and the toast says so", !!buttonWith(notes.render(), "Saved") && flashes.includes("ok:Notes saved for editors"));
    c.ok("notes: a content session's placeholder is about takes and clips, not a pool", /take/.test(area().props.placeholder) && !/pool|exteriors|backlit/i.test(area().props.placeholder), area().props.placeholder);

    // BriefCard flag
    const briefEl = find(screenTree, "BriefCard")[0];
    const brief = mountHooks(() => briefEl.type({ ...briefEl.props, flash }));
    let bt = brief.render();
    const flagInput = () => findBy(bt, (e) => e.type === "input" && e.props["aria-label"] === "On-site issue")[0];
    flagInput().props.onChange({ target: { value: "Lockbox code didn't work" } });
    bt = brief.render();
    behave.flagShootIssue = offline;
    buttonWith(bt, "Flag").props.onClick();
    await until(() => { bt = brief.render(); return textOfTree(bt).includes("Not flagged"); });
    bt = brief.render();
    c.ok("shoot flag: a dropped flag comes back off the list", !textOfTree(findBy(bt, (e) => e.type === "ul")).includes("Lockbox code didn't work"));
    c.ok("shoot flag: …its words are back in the box, and the line says so", flagInput().props.value === "Lockbox code didn't work" && /Not flagged — the connection dropped/.test(textOfTree(bt)) && !flashes.includes("ok:Issue flagged"));

    // ActionBar: status text + Done
    const barEl = find(screenTree, "ActionBar")[0];
    const bar = mountHooks(() => barEl.type({ ...barEl.props, flash, total: 1, captured: 0 }));
    let at = bar.render();
    buttonWith(at, "On my way").props.onClick();
    at = bar.render();
    const sheetText = find(at, "SendSheet")[0]?.props.text;
    behave.sendShootStatusText = offline;
    find(at, "SendSheet")[0].props.onSend();
    await until(() => { at = bar.render(); return !!find(at, "SendSheet")[0]?.props.failure; });
    at = bar.render();
    const sheet = find(at, "SendSheet")[0];
    c.ok("status text: a dropped send keeps the sheet open with the same text", !!sheet && sheet.props.text === sheetText && !!sheetText);
    c.ok("status text: …and says it was not sent (never 'Text sent')", /^Not sent — the connection dropped/.test(sheet?.props.failure ?? "") && !flashes.includes("ok:Text sent to client"), sheet?.props.failure);
    sheet.props.onCancel();
    at = bar.render();
    behave.completeShoot = offline;
    buttonWith(at, "Done").props.onClick();
    at = bar.render();
    c.ok("Done with an unticked item asks ON THE PAGE — window.confirm is never called", confirmCalls === 0 && /1 item on the checklist isn’t ticked off yet\. Mark the shoot complete anyway\?/.test(textOfTree(at)) && !calls.completeShoot);
    buttonWith(at, "Go back").props.onClick();
    at = bar.render();
    c.ok("…Go back closes the question and records nothing", !textOfTree(at).includes("Mark the shoot complete anyway") && !calls.completeShoot);
    buttonWith(at, "Done").props.onClick();
    at = bar.render();
    buttonWith(at, "Mark complete").props.onClick();
    await until(() => { at = bar.render(); return textOfTree(at).includes("Not marked complete"); });
    at = bar.render();
    c.ok("…Mark complete over a dropped connection says it did not record, and the bar still offers Done", calls.completeShoot === 1 && /Not marked complete — the connection dropped\. Tap Done to try again\./.test(textOfTree(at)) && !!buttonWith(at, "Done") && !flashes.includes("ok:Shoot marked complete"));

    // UploadPortal: flag + Discard
    const project: any = { id: "upload-weak-signal", title: "12 Signal St, Testville", addressLine: "12 Signal St", city: null, state: null, zip: null, packageName: "Video Starter", shootDate: "2026-10-05T14:00:00Z", status: "SCHEDULED", editorBrief: null, uploadedAt: null, debriefSubmittedAt: null, photosHandoffAt: null, photosHandoffBy: null, videoHandoffAt: null, videoHandoffBy: null, editorPdfPath: null, clientName: "Signal Client TEST", clientAvatarUrl: null, customerNote: null, photographerName: "James Drill", cullingConfirmedAt: null, shotOrderNotes: null, removalNotes: null, videoInstructions: null, videosFilmed: null, scriptConfirmedAt: null, scriptConfirmNote: null };
    const draftPayload = { editorBrief: "Unsent words from last night", checks: { coverage: false, culling: false, quality: false, count: false }, removal: "", nothingToRemove: false, orderChoice: null, orderNotes: "", vidStyle: null, vidSections: {}, videosFilmed: "", filmedTopicIds: [], topicNotes: {}, extraRows: [], scriptChoice: null, scriptText: "", scriptNote: "" };
    const portalProps: any = {
      project, deliverables: [{ id: "reel", type: "SOCIAL_REEL", quantity: 3, status: "PENDING", uploadedAt: null, notCompletedReason: null }],
      specialRequests: [], flags: [],
      policy: { photosOrdered: false, videoOrdered: true, photoTarget: 0, range: { low: 0, high: 0, upper: null }, rangeMode: "sop", squareFeet: null, squareFeetBand: null, videoSpec: videoStepSpec(["Video Starter"], { hasFullVideo: false, isMonthly: true }), videoStyle: "personal_branding", isPremium: false },
      script: null, foldersSlot: null, handoffFolders: [], submission: { submittedBy: null, lastEdited: null, addOns: [], files: [] },
      viewerIsOffice: false, payGateFromMs: 0, sessionTopics: null, topicsUnavailable: false,
      draft: { revision: 3, payload: draftPayload, savedAtISO: "2026-10-05T01:00:00Z", baseHash: null }, draftRevision: 3, canSaveDraft: true,
      baseHash: submittedFieldsHash({ editorBrief: null, videoInstructions: null, removalNotes: null, shotOrderNotes: null, reelScript: null, scriptConfirmNote: null, videosFilmed: null }),
      evidence: [], gaps: [], fieldReports: [], nowMs: Date.parse("2026-10-05T20:00:00Z"),
    };
    const portal = mountHooks(() => (UploadPortal as any)(portalProps));
    let pt = portal.render();
    await tick();
    pt = portal.render();
    const portalFlag = () => findBy(pt, (e) => e.type === "input" && /Couldn’t shoot the garage/.test(e.props.placeholder ?? ""))[0];
    portalFlag().props.onChange({ target: { value: "Mic battery died mid-take" } });
    pt = portal.render();
    behave.flagIssue = offline;
    buttonWith(pt, "Flag").props.onClick();
    await until(() => { pt = portal.render(); return textOfTree(pt).includes("Not flagged"); });
    pt = portal.render();
    c.ok("upload flag: a dropped flag comes back off the list, its words back in the box", portalFlag().props.value === "Mic battery died mid-take" && !findBy(pt, (e) => e.type === "li" && textOfTree(e.props.children).includes("Mic battery died")).length);
    c.ok("upload flag: …and the page says so", /Not flagged — the connection dropped\. Your words are back in the box; tap Flag to try again\./.test(textOfTree(pt)));
    c.ok("restored answers are on the page with a Discard", textOfTree(pt).includes("Restored answers you hadn") && !!buttonWith(pt, "Discard"));
    buttonWith(pt, "Discard").props.onClick();
    pt = portal.render();
    c.ok("Discard asks first, on the page — nothing is discarded yet", /Throw these answers away\? This can.t be undone\./.test(textOfTree(pt)) && !!buttonWith(pt, "Discard them") && !!buttonWith(pt, "Keep them") && !calls.discardUploadDraft);
    buttonWith(pt, "Keep them").props.onClick();
    pt = portal.render();
    c.ok("…Keep them puts the plain Discard back and discards nothing", !buttonWith(pt, "Discard them") && !!buttonWith(pt, "Discard") && !calls.discardUploadDraft);
    behave.discardUploadDraft = async () => ({ ok: false, message: "The server is unreachable." });
    buttonWith(pt, "Discard").props.onClick();
    pt = portal.render();
    buttonWith(pt, "Discard them").props.onClick();
    await until(() => { pt = portal.render(); return textOfTree(pt).includes("Not discarded"); });
    pt = portal.render();
    c.ok("…a discard that did not land keeps the answers, says so, and does not reload", calls.discardUploadDraft === 1 && reloads === 0 && /Not discarded: The server is unreachable\./.test(textOfTree(pt)) && find(pt, "AutoTextarea").some((t) => t.props.value === "Unsent words from last night"));
    behave.discardUploadDraft = async () => ({ ok: true });
    buttonWith(pt, "Discard").props.onClick();
    pt = portal.render();
    buttonWith(pt, "Discard them").props.onClick();
    await until(() => reloads === 1);
    c.ok("…confirmed and landed: the page reloads clean", reloads === 1 && calls.discardUploadDraft === 2);

    // The real actions from here on.
    for (const f of [shootActions, uploadActions, draftActions]) delete load.cache[f];
    for (const k of ["window", "document", "localStorage"]) delete g[k];

    // =======================================================================
    // The world for sections 2–5.
    // =======================================================================
    const now = new Date();
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const ahead = (h: number) => new Date(now.getTime() + h * 3_600_000);
    const tm = (name: string, role: "ADMIN" | "PHOTOGRAPHER" | "EDITOR" | "MANAGER") => prisma.teamMember.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}-oct5@example.test`, role } });
    const jamesTm = await tm("James Drill", "MANAGER");
    const kyleTm = await tm("Kyle Drill", "ADMIN");
    const harrisonTm = await tm("Harrison Drill", "PHOTOGRAPHER");
    const kimTm = await tm("Kim Miguel", "EDITOR");
    const johnTm = await tm("John Mark", "EDITOR");
    const user = (name: string, role: string, extra: { teamMemberId?: string; editorKey?: string } = {}) =>
      prisma.appUser.create({ data: { name, email: `${name.split(" ")[0].toLowerCase()}-user-oct5@example.test`, role, status: "ACTIVE", ...extra }, select: { id: true, email: true, role: true, name: true } });
    const jordan = await user("Jordan Drill", "OWNER");
    const kyle = await user("Kyle Drill", "ADMIN", { teamMemberId: kyleTm.id });
    const james = await user("James Drill", "ADMIN", { teamMemberId: jamesTm.id });
    const kim = await user("Kim Miguel", "EDITOR", { teamMemberId: kimTm.id, editorKey: "kim" });
    await prisma.appSetting.create({ data: { key: "review_room", value: JSON.stringify({ creativeApproverTeamMemberId: jamesTm.id }) } });

    const agent = await prisma.client.create({ data: { name: "Oct5 Real Agent", firstSeenAt: now } });
    // A listing job with a cut waiting on James and a finished one to send.
    const listing = await prisma.project.create({ data: { clientId: agent.id, title: "123 Home Ave, Testville", status: "REVIEW", shootDate: ago(30), deliveryDue: ago(2), photographerId: harrisonTm.id, deliverables: { create: { type: "VIDEO", label: "Property video", quantity: 2 } } }, include: { deliverables: true } });
    await prisma.reviewSubmission.create({ data: { projectId: listing.id, deliverableId: listing.deliverables[0].id, slot: 1, kind: "video", status: "PENDING", reviewerTeamMemberId: jamesTm.id, submittedByKey: "kim", assetPath: `/isolated/${listing.id}.mp4`, createdAt: ago(5) } });
    await prisma.reviewSubmission.create({ data: { projectId: listing.id, deliverableId: listing.deliverables[0].id, slot: 2, kind: "video", status: "APPROVED", fileName: "ready.mp4", blobUrl: "https://example.test/ready.mp4", decidedAt: ago(3) } });
    await prisma.appointment.create({ data: { aryeoId: `oct5-${listing.id}`, projectId: listing.id, startAt: ahead(0.02), assignedToId: harrisonTm.id } });
    // Enough other queues that the list folds: tasks, a waiting client, a slack ask.
    await prisma.smartTask.createMany({ data: [
      { clientId: agent.id, projectId: listing.id, title: "Unassigned office work", taskType: "todo", source: "manual", dueAt: ago(48) },
      { clientId: agent.id, projectId: listing.id, title: "Photo check", taskType: "media_qa", source: "manual" },
      { clientId: agent.id, projectId: listing.id, title: "Delivery draft", taskType: "delivery_text", source: "manual" },
      { clientId: agent.id, title: "Slack instruction", taskType: "internal_instruction", source: "slack", dueAt: ago(1) },
    ] });
    await prisma.commLog.create({ data: { clientId: agent.id, clientName: agent.name, contactName: agent.name, channel: "email", source: "gmail", direction: "in", body: "When is my video coming?", occurredAt: ago(30) } });

    // =======================================================================
    c.head("2 · Home: one list per role, the lead first, the rest folded");
    // =======================================================================
    const { default: home } = await import("@/app/page");
    const render = async () => {
      const raw = await home({ searchParams: Promise.resolve({}) });
      return { raw, tree: await settle(raw) };
    };
    const needsOf = (tree: any) => (find(tree, "NeedsToday")[0]?.props.needs ?? []) as { key: string; count: number; href: string; tone: string }[];
    await signIn(jordan);
    const owner = await render();
    const ownerNeeds = needsOf(owner.tree);
    const dayOf = (tree: any) => find(tree, "Block")[0].props.d as import("../../src/lib/opsDay").OpsDay;
    const od = dayOf(owner.tree);
    c.ok("owner: one 'What needs you now' list, led by the cuts waiting on a review (Jordan's order)", find(owner.tree, "NeedsToday").length === 1 && ownerNeeds[0]?.key === "cuts", ownerNeeds.map((n) => n.key).join(","));
    const toSend = ownerNeeds.find((n) => n.key === "tosend");
    c.ok("finished videos to send are a ROW with the list's own count, opening the delivery controls", !!toSend && toSend.count === od.readySend.ready.length && toSend.count === 1 && toSend.href === "#video-review");
    const ownerWords = textOfTree(owner.tree);
    c.ok("…and the old three-paragraph delivery card is gone (no second count of the same videos)", !ownerWords.includes("Operations owns the handoff") && !ownerWords.includes("ready for delivery"));
    // The line is checked against the day the page itself read (Oct 5 night:
    // the clock is pinned to noon ET now, not real — and the page lists
    // today's shoots by the job's shoot date, which is 30 hours back here).
    const todayLine = findBy(owner.tree, (e) => e.type === "a" && e.props.href === "#shoots" && e.props.className?.includes("min-h-11"));
    const todayWords = todayLine[0] ? textOfTree(todayLine[0].props.children) : "";
    c.ok("today's appointments are ONE line (count + next) linking to the folded cards — the old three-row box is gone",
      todayLine.length === 1 && !ownerWords.includes("fixed appointments") &&
        (od.todayShoots.length > 0 ? new RegExp(`${od.todayShoots.length} shoots? today · (next .* ET, 123 Home Ave · Harrison Drill|all started)`).test(todayWords) : todayWords.includes("No shoots on today’s calendar")), todayWords);
    const shootsBlock = findBy(owner.tree, (e) => nameOf(e.type) === "DayBlock" && e.props.id === "shoots")[0];
    c.ok("…the full shoot cards (access, weather, week ahead) are folded, not removed", !!shootsBlock && shootsBlock.props.defaultOpen === false && find(shootsBlock, "ShootList").length === 1 && find(shootsBlock, "WeekStrip").length === 1);
    const suspended = (name: string) => findBy(owner.raw, (e) => e.type === Suspense && nameOf(e.props.children?.type) === name).length === 1;
    c.ok("the slow sections stream behind their own Suspense: exceptions, radar + new clients, the owner's money", suspended("HomeExceptions") && suspended("HomeRadar") && suspended("OwnerBusiness"));
    c.ok("…and they still compose: new-client card, money strip and the folded trends are there once streamed",
      find(owner.tree, "NewClientCard").length === 1 && find(owner.tree, "MoneyStat").length === 4 && findBy(owner.tree, (e) => e.type === "summary" && textOfTree(e.props.children).includes("Trends and quality")).length === 1);
    const destinations = findBy(owner.tree, (e) => e.type === "nav" && e.props["aria-label"] === "Your work destinations");
    const destLinks = destinations.flatMap((nav) => findBy(nav, (e) => typeof e.props.href === "string").map((e) => e.props.href as string));
    c.ok("each work destination is linked once (one nav, no duplicate Review Room/My work rows at the top)", destinations.length === 1 && new Set(destLinks).size === destLinks.length && destLinks.includes("/review") && destLinks.includes("/tasks?tab=work&who=me"), destLinks.join(" "));
    c.ok("the standing rules fold under 'How the day runs'", findBy(owner.tree, (e) => e.type === "summary" && textOfTree(e.props.children).includes("How the day runs")).length === 1);

    await signIn(kyle);
    const ops = await render();
    const opsNeeds = needsOf(ops.tree);
    c.ok("Kyle (operations): the lead is the finished videos to send", opsNeeds[0]?.key === "tosend", opsNeeds.map((n) => n.key).join(","));
    const opsDay = dayOf(ops.tree);
    c.ok("…every row's count is the length of the list it opens", opsNeeds.find((n) => n.key === "clients")?.count === opsDay.unanswered.count && opsNeeds.find((n) => n.key === "tosend")?.count === opsDay.readySend.ready.length);
    const opsCard = html(find(ops.tree, "NeedsToday")[0]);
    // Oct 5 night review: a red or amber queue never folds (lib/homeNeeds);
    // calm rows fill what room is left under the lead, the rest fold.
    const urgentTone = (t: unknown) => t === "danger" || t === "warning";
    const restNeeds = opsNeeds.slice(1) as { tone?: string }[];
    const urgentRest = restNeeds.filter((n) => urgentTone(n.tone)).length;
    const calmShown = Math.min(restNeeds.length - urgentRest, Math.max(0, 3 - urgentRest));
    const later = restNeeds.length - urgentRest - calmShown;
    const shownRows = (opsCard.split("<details")[0].match(/<a /g) ?? []).length;
    c.ok(`…the lead, every urgent row and calm rows up to three show (${1 + urgentRest + calmShown}); the other ${later} calm row${later === 1 ? "" : "s"} fold under "${later} more queue${later === 1 ? "" : "s"}"`,
      opsNeeds.length > 4 && shownRows === 1 + urgentRest + calmShown && (later === 0 ? !text(opsCard).includes("more queue") : text(opsCard).includes(`${later} more queue${later === 1 ? "" : "s"}`)),
      `${opsNeeds.length} needs, ${shownRows} shown, ${urgentRest} urgent under the lead`);
    c.ok("…the lead carries its own Open button, under one title and this role's one-line orientation",
      /Open/.test(text(opsCard.split("</a>")[0])) && textOfTree(ops.tree).includes("What needs you now") && textOfTree(ops.tree).includes("Deliveries and client follow-through"));
    c.ok("Kyle: no money anywhere, no owner list, no business section", find(ops.tree, "MoneyStat").length === 0 && find(ops.tree, "QuickAdd").length === 0 && !findBy(ops.raw, (e) => e.type === Suspense && nameOf(e.props.children?.type) === "OwnerBusiness").length);

    await signIn(james);
    const rev = await render();
    const revNeeds = needsOf(rev.tree);
    c.ok("James (creative reviewer): the lead is the cut assigned to him, opening that exact cut", revNeeds[0]?.key === "review-mine" && revNeeds[0].count === 1 && revNeeds[0].href.startsWith(`/review/${listing.id}?cut=`), revNeeds.map((n) => n.key).join(","));

    // =======================================================================
    c.head("3 · the Editing Room: who is on what, soonest due first, one next action");
    // =======================================================================
    const job = async (title: string, editor: typeof kimTm | null, dueH: number) => {
      const p = await prisma.project.create({ data: { title, clientId: agent.id, status: "SHOT", shootDate: ago(72), deliveryDue: ahead(dueH), photographerId: harrisonTm.id, editorId: editor?.id ?? null, statusEvidence: JSON.stringify({ dropbox: { rawVideo: 2 } }), deliverables: { create: { type: "SOCIAL_REEL", label: "Standard Reel", quantity: 1 } } } });
      if (editor) await prisma.smartTask.create({ data: { projectId: p.id, clientId: agent.id, title: `Edit ${title}`, taskType: "edit_video", status: "OPEN", assignedKey: editor === kimTm ? "kim" : "john", assignedManually: true } });
      return p;
    };
    const later2 = await job("30 Later Lane", kimTm, 72);
    const active = await job("10 Active Ave", kimTm, 24);
    const late = await job("5 Late Ct", johnTm, -10);
    await prisma.editorWorkItem.create({ data: { editorKey: "kim", projectId: active.id, state: "ACTIVE", activeFor: "kim", firstStartedAt: ago(1), activeSince: ago(1), lastEventAt: ago(1) } });
    await prisma.mediaNote.create({ data: { projectId: later2.id, assetUrl: "/isolated/clip.mp4", body: "Kim's note on the later job", authorKey: "editor:kim", createdAt: ago(0.5) } });
    const { default: editing } = await import("@/app/editing/page");
    await signIn(kyle);
    const officeTree = await editing({ searchParams: Promise.resolve({}) });
    const queue = find(officeTree, "SimpleQueue")[0];
    const rows = queue.props.notDone as import("../../src/components/editing/SimpleQueue").QueueRow[];
    const mine = rows.filter((r) => [later2.id, active.id, late.id].includes(r.id)).map((r) => r.id);
    c.ok("the backlog is soonest due first (late job, then tomorrow's, then the later one)", JSON.stringify(mine) === JSON.stringify([late.id, active.id, later2.id]), mine.join(","));
    const header = find(officeTree, "PageHeader")[0].props.subtitle as string;
    c.ok("the header says what is open and what is late, in plain words (no 'test records hidden')", /\d+ open projects · \d+ late · \d+ upcoming/.test(header) && !/test records hidden/.test(header), header);
    const officeHtml = renderToStaticMarkup(officeTree as any);
    c.ok("'Working now' leads, the queue follows, the workload folds under 'Workload by editor' (no jargon line)",
      officeHtml.indexOf('aria-label="Editors today"') < officeHtml.indexOf('id="editing-queue-heading"') && officeHtml.includes("Workload by editor") && !officeHtml.includes("Project workload follows the record view above"));
    const qh = renderToStaticMarkup(createElement(queue.type, queue.props));
    c.ok("office row: who is on it, by name — 'Kim · working'", text(qh).includes("Kim · working"));
    c.ok("office row: today's evidence is ON the row with its not-a-Start title", /Kim wrote a note · \d/.test(text(qh)) && qh.includes('title="Today&#x27;s activity — not a Start. Only Start and Pause say someone is working."'), text(qh).match(/Kim [a-z ]+· \d+:\d+[ap]m/)?.[0] ?? text(qh).slice(0, 300));
    c.ok("office row: the kind of video is visible beside the count ('Standard · 1 video')", /Standard · 1 video/.test(text(qh)));
    const filterClass = qh.match(/id="editing-queue-filters" class="([^"]*)"/)?.[1] ?? "";
    c.ok("filters fold behind one 'Filters' button on a phone", /<button[^>]*aria-controls="editing-queue-filters"[^>]*>Filters<\/button>/.test(qh) && /(^| )hidden( |$)/.test(filterClass) && /(^| )sm:flex( |$)/.test(filterClass) && /sm:hidden/.test(qh.match(/<button[^>]*aria-controls="editing-queue-filters"[^>]*>/)?.[0] ?? ""), filterClass);
    await signIn(kim);
    const editorTree = await editing({ searchParams: Promise.resolve({}) });
    const own = find(editorTree, "SimpleQueue")[0];
    const eh = renderToStaticMarkup(createElement(own.type, own.props));
    c.ok("editor: only her own rows, each with ONE named next action ('Continue' on the job she started, 'Open brief' on the next)",
      (own.props.notDone as { editorKey: string | null }[]).every((r) => r.editorKey === "kim") && text(eh).includes("Continue") && text(eh).includes("Open brief"),
      (own.props.notDone as { street: string; status: string; videosToEdit: number; work: { active: unknown[] } }[]).map((r) => `${r.street}: ${r.status} · ${r.videosToEdit} to edit · active ${r.work.active.length}`).join(" | "));
    c.ok("editor: no office evidence line and no 'working' chips on her own view", !text(eh).includes("Kim's note") && !/· working/.test(text(eh)) && !eh.includes("Today&#x27;s activity — not a Start"));

    // =======================================================================
    c.head("4 · /shoot for a monthly content session");
    // =======================================================================
    const f = await buildContentMonth(prisma as never, {
      name: "Oct5 Session TEST", package: "Starter", videosPerMonth: 5, owner: false,
      appointments: [{ startAt: ahead(2) }],
      topics: ["Approved by the client", "Shared, not decided", "Office approved, not shared", "Newer approval over shared", "Only a draft"].map((title) => ({ title, selection: "SELECTED" as const })),
    });
    await prisma.project.update({ where: { id: f.projectId! }, data: { photographerId: jamesTm.id } });
    const [T1, T2, T3, T4, T5] = f.topicIds;
    const version = (scriptId: string, n: number, body: string, status: string) =>
      prisma.contentScriptVersion.create({ data: { scriptId, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: n, title: `v${n}`, hook: "h", pointsJson: "[]", close: "c", body, source: "AI", status }, select: { id: true } });
    const script = (topicId: string, title: string) => prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId, title, body: "x", status: "APPROVED" }, select: { id: true } });
    const s1 = await script(T1, "S1"); const s1v = await version(s1.id, 1, "Words the client signed off.", "SHARED");
    await prisma.contentScript.update({ where: { id: s1.id }, data: { sharedVersionId: s1v.id, approvedVersionId: s1v.id, currentVersionId: s1v.id, clientApprovedVersionId: s1v.id, clientApprovedAt: now, releaseState: "released" } });
    await prisma.contentScriptRelease.create({ data: { scriptId: s1.id, scriptVersionId: s1v.id, enrollmentId: f.enrollmentId, clientId: f.clientId, action: "CLIENT_APPROVED", actorEmail: "client@example.test" } });
    const s2 = await script(T2, "S2"); const s2v = await version(s2.id, 1, "Words shared, no verdict yet.", "SHARED");
    await prisma.contentScript.update({ where: { id: s2.id }, data: { sharedVersionId: s2v.id, approvedVersionId: s2v.id, currentVersionId: s2v.id, releaseState: "released" } });
    const s3 = await script(T3, "S3"); const s3v = await version(s3.id, 1, "Words the office approved this morning.", "APPROVED");
    await prisma.contentScript.update({ where: { id: s3.id }, data: { approvedVersionId: s3v.id, currentVersionId: s3v.id, releaseState: "withheld" } });
    const s4 = await script(T4, "S4"); const s4v1 = await version(s4.id, 1, "The old shared words.", "SUPERSEDED"); const s4v2 = await version(s4.id, 2, "The newer approved words.", "APPROVED");
    await prisma.contentScript.update({ where: { id: s4.id }, data: { sharedVersionId: s4v1.id, approvedVersionId: s4v2.id, currentVersionId: s4v2.id } });
    const s5 = await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, topicId: T5, title: "S5", body: "x", status: "DRAFT" }, select: { id: true } });
    const s5v = await version(s5.id, 1, "Unapproved draft words — never on a phone.", "DRAFT");
    await prisma.contentScript.update({ where: { id: s5.id }, data: { currentVersionId: s5v.id } });

    const { getShoot } = await import("@/lib/shoot");
    const sv = await getShoot(f.projectId!);
    const topic = (id: string) => sv!.session!.topics.find((t) => t.topicId === id)!;
    c.ok("client-approved script: shown, 'approved by the client'", topic(T1).script?.text === "Words the client signed off." && topic(T1).script?.clientApproved === true);
    c.ok("shared, not decided: shown, not client-approved", topic(T2).script?.text === "Words shared, no verdict yet." && topic(T2).script?.clientApproved === false);
    c.ok("office-APPROVED, not shared: NOW shown, said plainly ('approved by the office · not shared with the client yet')",
      topic(T3).script?.text === "Words the office approved this morning." && topic(T3).script?.standing === "approved by the office · not shared with the client yet" && topic(T3).noScript === null);
    c.ok("a newer office approval over a shared version: the newer words, not the superseded ones", topic(T4).script?.versionNo === 2 && topic(T4).script?.text === "The newer approved words." && topic(T4).script?.clientApproved === false);
    c.ok("a draft the office never approved: still never shown", topic(T5).script === null && !JSON.stringify(sv).includes("Unapproved draft words"));
    c.ok("the view knows it is a content session", sv!.project.contentSession === true);

    const { default: shootPage } = await import("@/app/shoot/[id]/page");
    const shootTree = async () => shootPage({ params: Promise.resolve({ id: f.projectId! }), searchParams: Promise.resolve({}) });
    await signIn(james);
    let st = await shootTree();
    let screenEl = find(st, "ShootScreen")[0];
    const readCard = () => find(screenEl.props.briefRead, "BriefReadCard")[0];
    c.ok("'I read this brief' is handed to the screen BELOW the brief — not in the top slot", !!readCard() && find(screenEl.props.map, "BriefReadCard").length === 0);
    c.ok("James, the assigned shooter on an ADMIN login, can mark it read", readCard().props.canAcknowledge === true && readCard().props.readAtISO === null);
    const sessionCard = find(screenEl.props.map, "SessionBriefCard")[0];
    const sh = html(sessionCard);
    const unapprovedWithWords = [T2, T3, T4].length;
    c.ok("scripts open by default, at reading size, with a big tap target", (sh.match(/<details open=""/g) ?? []).length === 4 && /<summary class="[^"]*min-h-11/.test(sh) && /text-base leading-relaxed">Words the client signed off\./.test(sh));
    c.ok(`one plain line on each script the client hasn't approved (${unapprovedWithWords}): "Film it as written — the client can still ask for changes"`,
      (text(sh).match(/Film it as written — the client can still ask for changes\./g) ?? []).length === unapprovedWithWords);
    const { acknowledgeShootBrief, saveShootNote } = await import("@/app/shoot/actions");
    await signIn(kyle);
    const kyleTree = await shootTree();
    const kyleCard = find(find(kyleTree, "ShootScreen")[0].props.briefRead, "BriefReadCard")[0];
    const kyleAck = await acknowledgeShootBrief(f.projectId!, kyleCard.props.digest);
    c.ok("Kyle (ADMIN, not on this shoot) can read it but not mark it", kyleCard.props.canAcknowledge === false && !kyleAck.ok && /assigned photographer/.test(kyleAck.message));
    await signIn(james);
    const ack = await acknowledgeShootBrief(f.projectId!, readCard().props.digest);
    c.ok("James marks it read", ack.ok && (await prisma.shootBriefRead.count({ where: { projectId: f.projectId! } })) === 1, ack.message);
    await saveShootNote(f.projectId!, "My own notes for the editor: topic 2 best take is the last one.");
    st = await shootTree(); screenEl = find(st, "ShootScreen")[0];
    c.ok("his OWN notes for the editor are not a brief change", !!readCard().props.readAtISO && readCard().props.changes.length === 0, JSON.stringify(readCard().props.changes));
    await prisma.activity.create({ data: { projectId: f.projectId!, type: "SPECIAL_REQUEST", body: "Client wants one take at the front door" } });
    st = await shootTree(); screenEl = find(st, "ShootScreen")[0];
    c.ok("…an office/client change still is (1 item, the new must-get)", readCard().props.changes.length === 1 && /Must-get/.test(readCard().props.changes[0].label));
    const { briefChanges } = await import("@/lib/shootBriefRead");
    c.ok("a receipt saved BEFORE this change (with the old notes / version lines) reports nothing about those lines",
      briefChanges([{ key: "job:shared", label: "Job-wide editing instructions", value: "old" }, { key: "output:o1:version", label: "v", value: "Brief v1" }, { key: "output:o1:section:Changed on site", label: "x", value: "a" }], []).length === 0);
    const screenHtml = renderToStaticMarkup(createElement(screenEl.type, { ...screenEl.props, map: null, pay: null, media: null, chat: null, briefRead: null }));
    const sht = text(screenHtml);
    c.ok("the capture list speaks about topics, not a walkthrough or a reel of rooms", sht.includes("Every topic on the session card above") && !sht.includes("Cinematic walkthrough") && !sht.includes("Vertical clips for the reel"));
    c.ok("no 'captured photos' media card on a video-only session, and no pool in the notes prompt", !sht.includes("captured photos") && !sht.includes("Your media") && !/placeholder="[^"]*pool/.test(screenHtml));

    // =======================================================================
    c.head("5 · /upload for the content session");
    // =======================================================================
    const { default: uploadPage } = await import("@/app/upload/[id]/page");
    const studioCalls = () => fence.blocked.filter((u) => u.includes("studio.oct5-drill.invalid")).length;
    const before = studioCalls();
    const up = await uploadPage({ params: Promise.resolve({ id: f.projectId! }) });
    c.ok("the content session's page never calls Script Studio (its scripts come from the program)", studioCalls() === before, `${studioCalls() - before} call(s)`);
    const reelJob = await prisma.project.create({ data: { clientId: agent.id, title: "77 Studio Way, Testville", status: "SCHEDULED", shootDate: ago(4), deliverables: { create: { type: "SOCIAL_REEL", label: "Social Reel", quantity: 1 } } } });
    await uploadPage({ params: Promise.resolve({ id: reelJob.id }) });
    c.ok("…the control: a listing reel's page still asks Studio (refused by the fence here)", studioCalls() > before, `${studioCalls() - before} call(s)`);
    const portalEl = find(up, "UploadPortal")[0];
    const folders = find(portalEl.props.foldersSlot, "DropboxFolders")[0];
    c.ok("the session's page knows it has topics and no photos (so no Backup Photos folder)", !!portalEl.props.sessionTopics && folders?.props.photosOrdered === false);
    const { foldersSlot: _slot, onBriefNote: _note, ...rest } = portalEl.props;
    void _slot; void _note;
    const tickedProps = { ...rest, foldersSlot: null, draft: { revision: 1, savedAtISO: now.toISOString(), baseHash: null, payload: { ...draftPayload, editorBrief: "", filmedTopicIds: [T1], topicNotes: {} } }, draftRevision: 1 };
    const ph = renderToStaticMarkup(createElement(portalEl.type, tickedProps));
    const pht = text(ph);
    c.ok("a ticked topic opens its note at once, asking which clips are which", /aria-label="Note for the editor about Approved by the client"[^>]*placeholder="Which clips are this one\? File names, e\.g\. C0012–C0015 or IMG_4412–4418/.test(ph) || /placeholder="Which clips are this one\? File names[^"]*"[^>]*aria-label="Note for the editor about Approved by the client"/.test(ph));
    c.ok("the topics lead; the general box comes after and says it applies to all videos", pht.indexOf("Which topics did you film?") >= 0 && pht.indexOf("Which topics did you film?") < pht.indexOf("Instructions for the edit — applies to all videos") && pht.includes("Anything else for the editor? — applies to all videos"));
    c.ok("the optional boxes fold under 'More for the editor — optional'", /<details[^>]*><summary[^>]*>More for the editor <span[^>]*>— optional<\/span><\/summary>/.test(ph));
    c.ok("no foyer / drone / pool placeholders, no 'forfeits' line, no Backup Photos", !/foyer|drone push-in|over the pool|neighbor's yard/i.test(ph) && !pht.includes("forfeits future premium shoot assignments") && !pht.includes("Backup Photos"));

    c.ok("nothing left the building except the refused Studio control calls", fence.faked.length === 0 && fence.blocked.every((u) => u.includes("studio.oct5-drill.invalid")), fence.blocked.slice(0, 3).join(" | "));
    c.summary();
  } finally {
    quiet.restore?.();
    fence.restore();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}
void REPO;
main().catch((error) => { console.error(error); process.exit(1); });
