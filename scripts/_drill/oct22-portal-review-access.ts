// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the portal's video review and easy access (Oct 22 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct22-portal-review-access.ts
//
// Jordan, Oct 22 2026:
//   · "Mike Ciunci said he left a review note on his video, but I'm not seeing
//     it." (No PortalComment from him ever reached the server: typed, never sent.)
//   · "When I view his portal it says record the client's approval. I don't
//     want them to see that so make sure it just says approve for them."
//   · "When I type in the note box, it makes the video disappear / flash."
//   · "Clients need an easy way to access the portal without having to log in
//     every time or look for a link in their email."
//
//   A  approval wording: the client's words for a client and the shared link,
//      "Approve for Mike" (and one on-behalf line) for staff only
//   B  the player is isolated from note typing: the load effect depends on the
//      file only, a new callback or a fresh token never reloads it, typing
//      re-renders the note box alone, and the player's props never change
//   C  the note box: draft autosave per cut, put back after a reload, "Send
//      note", the unsent-note warning before approve / request changes /
//      leaving, and a plain confirmation after sending
//   D  the rolling one-year session: re-issued on a visit (httpOnly, sameSite,
//      path as the sign-in route), never for a revoked seat, revoked program
//      access or a disabled person, and the resolver still refuses at once
//   E  the home screen app: the manifest route, its icons on disk, the tags on
//      /portal/me only
//   F  "Add to your home screen" on Home for the client and the link, never
//      for staff on their behalf
//   G  one-tap links: the landing allowlist, sign-in links that land on the
//      right page, a signed-in device passed straight through, and the
//      builders that now use them
//
// ISOLATION: PGlite via the shared harness, every .env key blank, every
// outbound call fenced. Nothing is sent; the server actions the review
// component calls are stubs.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrismaClient } from "@prisma/client";
import type { CutVersion } from "@/lib/clientDecisions";
import type { PortalViewer } from "@/lib/portal";
import { bootDrillDb, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6891);
const ROOT = path.resolve(__dirname, "..", "..");
const src = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const c = makeChecker();
const fence = fenceFetch();
const req = createRequire(__filename);

/* eslint-disable @typescript-eslint/no-explicit-any */
// ---- element trees ---------------------------------------------------------------
const MEMO = Symbol.for("react.memo");
const FWD = Symbol.for("react.forward_ref");
const typeName = (t: any): string => (typeof t === "string" ? t : t?.$$typeof === MEMO || t?.$$typeof === FWD ? typeName(t.type ?? t.render) : t?.displayName || t?.name || "?");
function find(n: any, name: string, out: any[] = []): any[] {
  if (!n || typeof n !== "object") return out;
  if (Array.isArray(n)) { n.forEach((x) => find(x, name, out)); return out; }
  if (!isValidElement(n)) return out;
  if (typeName(n.type) === name) out.push(n);
  for (const v of Object.values(n.props as object)) if (v && typeof v === "object") find(v, name, out);
  return out;
}
function words(n: any, out: string[] = []): string[] {
  if (n === null || n === undefined || typeof n === "boolean") return out;
  if (typeof n === "string" || typeof n === "number") { out.push(String(n)); return out; }
  if (Array.isArray(n)) { n.forEach((x) => words(x, out)); return out; }
  if (!isValidElement(n)) return out;
  return words((n.props as { children?: unknown }).children, out);
}
const say = (t: any) => words(t).join("").replace(/\s+/g, " ");
const buttonWith = (tree: any, text: string) => find(tree, "button").find((b) => say(b).includes(text));
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

// ---- a tiny hook host: runs ONE component's render with React's real hooks
// API pointed at a dispatcher we can watch (state cells, effects with deps).
function hookHost() {
  const internals = (req("react") as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const cells: any[] = [];
  let idx = 0;
  let pending: (() => void)[] = [];
  const cleanups = new Map<number, () => void>();
  let changes = 0;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
  const effect = (fn: () => void | (() => void), deps?: unknown[]) => {
    const s = idx++;
    const prev = cells[s];
    if (prev && deps !== undefined && !changed(prev.deps, deps)) return;
    cells[s] = { deps };
    pending.push(() => { cleanups.get(s)?.(); cleanups.delete(s); const cu = fn(); if (typeof cu === "function") cleanups.set(s, cu); });
  };
  const d: Record<string, any> = {
    useState(init: unknown) {
      const s = idx++;
      if (!(s in cells)) {
        const cell: any = { v: typeof init === "function" ? (init as () => unknown)() : init };
        cell.set = (n: unknown) => { const nv = typeof n === "function" ? (n as (v: unknown) => unknown)(cell.v) : n; if (!Object.is(nv, cell.v)) { cell.v = nv; changes++; } };
        cells[s] = cell;
      }
      return [cells[s].v, cells[s].set];
    },
    useRef(init: unknown) { const s = idx++; if (!(s in cells)) cells[s] = { current: init }; return cells[s]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const s = idx++; const p = cells[s]; if (!p || changed(p.deps, deps)) cells[s] = { deps, v: fn() }; return cells[s].v; },
    useCallback(fn: unknown, deps: unknown[]) { return d.useMemo(() => fn, deps); },
    useEffect: effect,
    useLayoutEffect: effect,
    useInsertionEffect: effect,
    useImperativeHandle(ref: any, create: () => unknown) { idx++; pending.push(() => { if (ref && typeof ref === "object") ref.current = create(); else if (typeof ref === "function") ref(create()); }); },
    useTransition() { const s = idx++; if (!(s in cells)) cells[s] = { busy: false }; return [cells[s].busy, (cb: () => unknown) => { cells[s].busy = true; Promise.resolve(cb()).finally(() => { cells[s].busy = false; changes++; }); }]; },
    useContext(ctx: any) { return ctx?._currentValue; },
    useId() { return `:d${idx++}:`; },
    useDebugValue() {},
  };
  return {
    render<T>(fn: () => T): T { idx = 0; const before = internals.H; internals.H = d; try { return fn(); } finally { internals.H = before; } },
    flush() { const p = pending; pending = []; p.forEach((f) => f()); },
    unmount() { for (const cu of cleanups.values()) cu(); cleanups.clear(); },
    get changes() { return changes; },
  };
}

// ---- the server actions CutReview calls: stubs that record the call --------------
const actionCalls: { name: string; args: unknown[] }[] = [];
let addCommentResult: { ok: boolean; message: string; id?: string } = { ok: true, message: "Noted.", id: "c1" };
const stubModule = (file: string, exports: unknown) => { const f = req.resolve(file); req.cache[f] = { id: f, filename: f, loaded: true, exports } as NodeModule; };
const rec = (name: string, result: () => unknown) => async (...args: unknown[]) => { actionCalls.push({ name, args }); return result(); };
stubModule("../../src/app/portal/actions.ts", {
  portalAddComment: rec("portalAddComment", () => addCommentResult),
  portalApproveCut: rec("portalApproveCut", () => ({ ok: true, message: "Approved." })),
  portalRecordClientApproval: rec("portalRecordClientApproval", () => ({ ok: true, message: "Recorded." })),
  portalRequestRevision: rec("portalRequestRevision", () => ({ ok: true, message: "Sent." })),
  portalDeleteComment: rec("portalDeleteComment", () => ({ ok: true, message: "Removed." })),
  portalResolveComment: rec("portalResolveComment", () => ({ ok: true, message: "Updated." })),
});
let refreshes = 0;
const router = { refresh: () => { refreshes++; }, push: () => {}, replace: () => {}, prefetch: () => {}, back: () => {}, forward: () => {} };
const nope = (n: string) => () => { throw new Error(`next/navigation.${n}() is not available in a drill`); };
stubModule("next/navigation", {
  useRouter: () => router, usePathname: () => "/portal/me", useSearchParams: () => new URLSearchParams(), useParams: () => ({}),
  redirect: nope("redirect"), permanentRedirect: nope("permanentRedirect"), notFound: nope("notFound"), forbidden: nope("forbidden"), unauthorized: nope("unauthorized"),
  RedirectType: { push: "push", replace: "replace" },
});

const SUB = "sub1abcdefghij";
const cut = (o: Partial<CutVersion> = {}): CutVersion => ({
  submissionId: SUB, round: 2, clientVersion: 2, fileName: "Done_Rev_1033 Preserve Ln (Mike Ciunci)_Video2.mov", releasedAtISO: "2026-10-21T15:00:00.000Z",
  assetUrl: `/api/review/cut/${SUB}/stream?m=T1`, clientState: "AWAITING_YOUR_DECISION", isCurrent: true, decidedByMe: false, revisionOpen: false,
  decisions: [], comments: [], review: null, ...o,
});
const OWNER_PERMS = { comment: true, request: true, approve: true };

async function main() {
  const copyMod = await import("@/components/portal/cutReviewCopy");
  const { approvalCopy, STAFF_ONLY_PHRASES, NOTE_COPY, noteDraftKey, clientFirstName } = copyMod;
  const { CutReview, PlayerFrame, leavesThePage } = await import("@/components/portal/CutReview");
  const { PortalPlayer, playerSourceKey } = await import("@/components/portal/PortalPlayer");
  const hasStaffWords = (s: string) => STAFF_ONLY_PHRASES.some((p) => s.includes(p));

  // =========================================================================
  c.head("A · approval wording: 'Approve this version' for the client, 'Approve for Mike' for staff only");
  // =========================================================================
  {
    const client = approvalCopy(2, null);
    const staff = approvalCopy(2, "Mike");
    c.ok("client copy: Approve this version / Approve version 2 as final? / Yes, approve, no on-behalf line",
      client.button === "Approve this version" && client.title === "Approve version 2 as final?" && client.confirm === "Yes, approve" && client.onBehalf === null, JSON.stringify(client));
    c.ok("…and not one staff-only phrase anywhere in it", !hasStaffWords(Object.values(client).join(" ")));
    c.ok("staff copy reads naturally: 'Approve for Mike', one line that they act on Mike's behalf",
      staff.button === "Approve for Mike" && staff.confirm === "Approve for Mike" && staff.title === "Approve version 2 for Mike?" && staff.onBehalf === "You're approving on Mike's behalf.", JSON.stringify(staff));
    c.ok("'Record the client's approval' is gone from the component", !/Record the client|Record approval/.test(src("src/components/portal/CutReview.tsx")));
    c.ok("first names: 'Mike Ciunci' → Mike, a TEST suffix dropped, a team kept whole, nothing → 'the client'",
      clientFirstName("Mike Ciunci") === "Mike" && clientFirstName("Mike Ciunci TEST") === "Mike" && clientFirstName("The Smith Team") === "The Smith Team" && clientFirstName("Bob and Sue Lane") === "Bob and Sue Lane" && clientFirstName(null) === "the client");

    const html = (p: Record<string, unknown>) => decode(renderToStaticMarkup(createElement(CutReview, { versions: [cut()], perms: OWNER_PERMS, ...p } as any)));
    const clientHtml = html({});
    c.ok("signed-in client page: 'Approve this version', 'Send note', no staff words", clientHtml.includes("Approve this version") && clientHtml.includes("Send note") && !hasStaffWords(clientHtml) && !clientHtml.includes("Save note"));
    const clientWithName = html({ clientFirst: "Mike" });
    c.ok("…even when a name is handed in by mistake, a client still gets the client words", clientWithName.includes("Approve this version") && !hasStaffWords(clientWithName));
    const linkHtml = html({ perms: { comment: false, request: false, approve: false }, linkVisitor: true, staff: true, clientFirst: "Mike", signInHref: "/portal/login" });
    c.ok("shared link (TOKEN): 'Sign in to approve or request changes.', no staff words even with staff=true", linkHtml.includes("Sign in to approve or request changes.") && !hasStaffWords(linkHtml), linkHtml.slice(0, 200));
    const staffHtml = html({ staff: true, clientFirst: "Mike" });
    c.ok("staff iframe: 'Approve for Mike' and 'You're approving on Mike's behalf.'", staffHtml.includes("Approve for Mike") && staffHtml.includes("You're approving on Mike's behalf.") && !staffHtml.includes("Approve this version"));
    const cr = src("src/components/portal/CutReview.tsx");
    c.ok("source: every on-behalf branch keys off onBehalf = staff && !linkVisitor", /const onBehalf = staff && !linkVisitor;/.test(cr) && /approvalCopy\(current\.clientVersion, onBehalf \?/.test(cr) && !/\bstaff \?/.test(cr) && /\{onBehalf && \(\s*<label/.test(cr));
    c.ok("source: the server hands the name to a STAFF visit only, and VideosTab passes it only with staff",
      /clientFirst: actor\.kind === "STAFF" \? clientFirstName\(client\?\.name\) : null/.test(src("src/components/portal/PortalPage.tsx")) &&
      /clientFirst=\{d\.staff \? d\.clientFirst \?\? null : null\}/.test(src("src/components/portal/tabs/VideosTab.tsx")));
    c.ok("source: the staff flag itself is still STAFF-only (staff: actor.kind === \"STAFF\")", /staff: actor\.kind === "STAFF",/.test(src("src/components/portal/PortalPage.tsx")));
    c.ok("copy: no em dash in any of the new words", ![...Object.values(client), ...Object.values(staff), ...Object.values(NOTE_COPY)].some((s) => typeof s === "string" && /—/.test(s)));
  }

  // =========================================================================
  c.head("B · the player is isolated from typing in the note box");
  // =========================================================================
  {
    c.ok("ROOT CAUSE gone: the load effect no longer lists onError (it re-ran on every keystroke and unloaded the video)",
      !/\[src, onError\]\)/.test(src("src/components/portal/PortalPlayer.tsx")) && /\}, \[srcKey\]\);/.test(src("src/components/portal/PortalPlayer.tsx")));
    c.ok("PortalPlayer and PlayerFrame are memoised", (PortalPlayer as any).$$typeof === MEMO && (PlayerFrame as any).$$typeof === MEMO);
    c.ok("a fresh media token is the same file; another cut is not",
      playerSourceKey(`/api/review/cut/${SUB}/stream?m=T1`) === playerSourceKey(`/api/review/cut/${SUB}/stream?m=T2`) && playerSourceKey(`/api/review/cut/${SUB}/stream?m=T1`) !== playerSourceKey("/api/review/cut/other0000001/stream?m=T1"));

    // The player's own effects, run with the hook host and a fake <video>.
    class FakeVideo {
      sets: string[] = []; removed = 0; loads = 0; currentTime = 12.5; readyState = 4; paused = false; listeners: Record<string, () => void> = {};
      private s = "";
      get src() { return this.s; }
      set src(v: string) { this.s = v; this.sets.push(v); }
      removeAttribute(n: string) { if (n === "src") { this.removed++; this.s = ""; } }
      load() { this.loads++; }
      canPlayType() { return ""; }
      pause() { this.paused = true; }
      play() { this.paused = false; return Promise.resolve(); }
      addEventListener(t: string, f: () => void) { this.listeners[t] = f; }
      setAttribute() {}
    }
    const el = new FakeVideo();
    const renderFn = (PortalPlayer as any).type.render as (p: unknown, r: unknown) => unknown;
    const host = hookHost();
    const handle = { current: null as unknown };
    let errs = 0;
    const mount = (props: Record<string, unknown>) => {
      const tree = host.render(() => renderFn(props, handle));
      const video = find(tree, "video")[0];
      if (video?.props.ref && !video.props.ref.current) video.props.ref.current = el;
      host.flush();
      return tree;
    };
    mount({ src: `/api/review/cut/${SUB}/stream?m=T1`, poster: null, onError: () => { errs++; } });
    c.ok("first render loads the file once", el.sets.length === 1 && el.sets[0].endsWith("m=T1"), el.sets.join(","));
    for (let i = 0; i < 25; i++) mount({ src: `/api/review/cut/${SUB}/stream?m=T1`, poster: null, onError: () => { errs++; } });
    c.ok("25 parent re-renders with a NEW onError each time (what each keystroke did): no unload, no reload", el.sets.length === 1 && el.removed === 0 && el.loads === 0, `sets ${el.sets.length}, removed ${el.removed}, load() ${el.loads}`);
    const tree = mount({ src: `/api/review/cut/${SUB}/stream?m=T2`, poster: null, onError: () => { errs++; } });
    c.ok("a router.refresh with a fresh token: still no reload (same frame, same playhead)", el.sets.length === 1 && el.removed === 0 && el.loads === 0);
    find(tree, "video")[0].props.onError();
    c.ok("…if the old token has run out, one retry with the newest address, at the same moment", el.sets.length === 2 && el.sets[1].endsWith("m=T2") && typeof el.listeners.loadedmetadata === "function" && errs === 0);
    el.currentTime = 0; el.listeners.loadedmetadata();
    c.ok("…the playhead is put back (12.5 s)", el.currentTime === 12.5);
    mount({ src: "/api/review/cut/other0000001/stream?m=T3", poster: null, onError: () => { errs++; } });
    c.ok("a different cut DOES reload (unload the old, load the new)", el.removed === 1 && el.loads === 1 && el.sets.at(-1)!.includes("other0000001"));

    // CutReview + its note box: typing never reaches the player.
    const storage = new Map<string, string>();
    const winListeners: Record<string, (e: any) => void> = {};
    const docListeners: Record<string, (e: any) => void> = {};
    let confirms: string[] = [];
    let confirmAnswer = false;
    class FakeElement { closest(): unknown { return null; } }
    class FakeAnchor extends FakeElement {
      constructor(public href: string, public target = "", private dl = false) { super(); }
      closest() { return this; }
      hasAttribute(n: string) { return n === "download" && this.dl; }
    }
    const g = globalThis as any;
    const saved = { window: g.window, document: g.document, Element: g.Element, HTMLAnchorElement: g.HTMLAnchorElement };
    g.window = {
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } },
      location: { pathname: "/portal/me", search: "", href: "http://drill.local/portal/me?tab=library&v=vid0000000001" },
      addEventListener: (t: string, f: (e: any) => void) => { winListeners[t] = f; },
      removeEventListener: (t: string, f: (e: any) => void) => { if (winListeners[t] === f) delete winListeners[t]; },
      confirm: (m: string) => { confirms.push(m); return confirmAnswer; },
    };
    g.document = {
      addEventListener: (t: string, f: (e: any) => void) => { docListeners[t] = f; },
      removeEventListener: (t: string, f: (e: any) => void) => { if (docListeners[t] === f) delete docListeners[t]; },
    };
    g.Element = FakeElement;
    g.HTMLAnchorElement = FakeAnchor;
    try {
      const P = hookHost();
      const props = { versions: [cut()], perms: OWNER_PERMS };
      let pTree = P.render(() => CutReview(props as any));
      P.flush();
      const frame1 = find(pTree, "PlayerFrame")[0]?.props;
      let composerEl = find(pTree, "NoteComposer")[0];
      c.ok("the page renders the player through PlayerFrame and the note box as its own NoteComposer", !!frame1 && !!composerEl && composerEl.props.submissionId === SUB);
      const Composer = composerEl.type as (p: unknown) => unknown;
      let C = hookHost();
      const cRender = () => { const t = C.render(() => Composer(composerEl.props)); C.flush(); return t; };
      let cTree: any = cRender();
      const parentChangesBefore = P.changes;
      const type = (v: string) => { find(cTree, "textarea")[0].props.onChange({ target: { value: v } }); cTree = cRender(); };
      const sentence = "The intro is too long, cut the first two seconds";
      for (let i = 1; i <= sentence.length; i++) type(sentence.slice(0, i));
      c.ok(`typing ${sentence.length} keystrokes changes the page's own state exactly once (the box went from empty to not)`, P.changes - parentChangesBefore === 1, `${P.changes - parentChangesBefore} changes`);
      pTree = P.render(() => CutReview(props as any));
      P.flush();
      const frame2 = find(pTree, "PlayerFrame")[0]?.props;
      const sameProps = !!frame1 && !!frame2 && Object.keys(frame1).length === Object.keys(frame2).length && Object.keys(frame1).every((k) => Object.is(frame1[k], frame2[k]));
      c.ok("…and on that one page re-render every PlayerFrame prop is the identical value (memo: React skips the player)", sameProps, Object.keys(frame1 ?? {}).filter((k) => !Object.is(frame1[k], frame2?.[k])).join(",") || "all identical");

      // =====================================================================
      c.head("C · no note is lost: autosave, warnings, Send note, confirmation");
      // =====================================================================
      c.ok("the draft autosaves on this device, per cut", storage.get(noteDraftKey(SUB)) === sentence && noteDraftKey(SUB) === `rtp_portal_note:${SUB}`);
      c.ok("an unsent note says so under the box, and the button reads 'Send note'", say(cTree).includes(NOTE_COPY.unsentHint) && !!buttonWith(cTree, "Send note"));
      // Leaving the page.
      const unload = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
      winListeners.beforeunload?.(unload);
      c.ok("reload or close: the browser's own 'leave?' prompt is asked for", unload.prevented && unload.returnValue === "");
      const click = (a: InstanceType<typeof FakeAnchor>) => { const ev = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, target: a, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; docListeners.click?.(ev); return ev; };
      confirms = []; confirmAnswer = false;
      const away = click(new FakeAnchor("http://drill.local/portal/me?tab=library"));
      c.ok("a portal link away: 'You have a note you haven't sent…' and Cancel keeps them on the page", confirms[0] === NOTE_COPY.leaveConfirm && away.defaultPrevented && away.stopped);
      confirmAnswer = true;
      const go = click(new FakeAnchor("http://drill.local/portal/me?tab=library"));
      c.ok("…OK leaves (the draft stays on the device)", !go.defaultPrevented && storage.get(noteDraftKey(SUB)) === sentence);
      confirms = [];
      click(new FakeAnchor("http://drill.local/portal/me?tab=library&v=vid0000000001#notes"));
      click(new FakeAnchor("http://drill.local/portal/me?tab=library", "_blank"));
      click(new FakeAnchor("tel:+16105550100"));
      c.ok("…a jump on the same page, a new tab or a phone link asks nothing", confirms.length === 0, confirms.join(" | "));
      c.ok("leavesThePage: another path yes; same page with a hash, _blank, download, tel: no",
        leavesThePage({ href: "/portal/me?tab=plan" }, { href: "http://h.test/portal/me?tab=library" }) &&
        !leavesThePage({ href: "/portal/me?tab=library#x" }, { href: "http://h.test/portal/me?tab=library" }) &&
        !leavesThePage({ href: "/x", target: "_blank" }, { href: "http://h.test/" }) && !leavesThePage({ href: "/x", hasDownload: true }, { href: "http://h.test/" }) &&
        !leavesThePage({ href: "mailto:a@b.c" }, { href: "http://h.test/" }));

      // Approve with the note unsent.
      buttonWith(pTree, "Approve this version").props.onClick();
      pTree = P.render(() => CutReview(props as any)); P.flush();
      c.ok("approving with an unsent note: 'You have a note you haven't sent.' with Send note and Discard it", say(pTree).includes(NOTE_COPY.unsentWarning) && !!buttonWith(pTree, NOTE_COPY.discardIt));
      c.ok("…and 'Yes, approve' waits until it is sent or discarded", buttonWith(pTree, "Yes, approve")?.props.disabled === true);
      buttonWith(pTree, "Not yet").props.onClick();
      pTree = P.render(() => CutReview(props as any)); P.flush();
      buttonWith(pTree, "Request changes").props.onClick();
      pTree = P.render(() => CutReview(props as any)); P.flush();
      c.ok("requesting changes with an unsent note: the same warning, and 'Send to the editor' waits", say(pTree).includes(NOTE_COPY.unsentWarning) && buttonWith(pTree, "Send to the editor")?.props.disabled === true);
      // Discard through the page's button (the composer handle).
      const composerRef = composerEl.props.ref as { current: { send(): Promise<boolean>; discard(): void } | null };
      buttonWith(pTree, NOTE_COPY.discardIt).props.onClick();
      cTree = cRender();
      pTree = P.render(() => CutReview(props as any)); P.flush();
      c.ok("Discard it: the box and the device copy are cleared, the warning goes, and the request can be sent",
        !storage.has(noteDraftKey(SUB)) && find(cTree, "textarea")[0].props.value === "" && !say(pTree).includes(NOTE_COPY.unsentWarning) && buttonWith(pTree, "Send to the editor")?.props.disabled === false);
      c.ok("…and leaving no longer asks", !winListeners.beforeunload && !docListeners.click);

      // Send a note: the server action, then a plain confirmation.
      type("Brighten the kitchen shot at 0:12");
      actionCalls.length = 0; refreshes = 0;
      const sent = await composerRef.current!.send();
      cTree = cRender();
      const call = actionCalls.find((a) => a.name === "portalAddComment");
      c.ok("Send note calls portalAddComment for this cut with the typed text (a general note: the video never played)", sent && !!call && call.args[1] === SUB && call.args[2] === null && call.args[3] === "Brighten the kitchen shot at 0:12");
      c.ok("…then says plainly that we have it, and what happens next", say(cTree).includes("Got it. We have your note.") && /press Request changes below to send your notes to your editor/.test(say(cTree)), say(cTree).slice(-220));
      c.ok("…clears the box and the device copy, and re-reads the page", find(cTree, "textarea")[0].props.value === "" && !storage.has(noteDraftKey(SUB)) && refreshes === 1);
      // A failed send keeps the text.
      type("Second note");
      addCommentResult = { ok: false, message: "That's a lot of notes." };
      const failed = await composerRef.current!.send();
      cTree = cRender();
      c.ok("a refused send keeps the note in the box and on the device, and says why", !failed && find(cTree, "textarea")[0].props.value === "Second note" && storage.get(noteDraftKey(SUB)) === "Second note" && say(cTree).includes("That's a lot of notes."));
      addCommentResult = { ok: true, message: "Noted.", id: "c2" };
      C.unmount();

      // A reload (or the flash) never loses text: the draft comes back.
      storage.set(noteDraftKey(SUB), "Kept from before the reload");
      C = hookHost();
      composerEl = find(P.render(() => CutReview(props as any)), "NoteComposer")[0];
      cTree = cRender(); cTree = cRender();
      c.ok("after a reload the unsent note is back in the box, with 'You have a note you haven't sent. We kept it on this device.'",
        find(cTree, "textarea")[0].props.value === "Kept from before the reload" && say(cTree).includes(NOTE_COPY.restored));
      C.unmount();
      // Storage that throws (a private window): typing still works, nothing breaks.
      g.window.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
      C = hookHost();
      let threw = false;
      try { cTree = cRender(); type("Works without storage"); } catch { threw = true; }
      c.ok("blocked storage: no crash, the box still holds the text", !threw && find(cTree, "textarea")[0].props.value === "Works without storage");
      C.unmount();

      // Notes saved but not in a request are called out (the Bernadette lesson).
      const withOpen = { versions: [cut({ comments: [{ id: "n1", body: "Logo too small", timeSec: 3, status: "OPEN", resolvedAtISO: null, resolvedBy: null, mine: true, byStaff: false, decisionId: null, author: "Mike", createdAtISO: "2026-10-21T16:00:00.000Z", replies: [] }] })], perms: OWNER_PERMS };
      const P2 = hookHost();
      const openTree = P2.render(() => CutReview(withOpen as any));
      // Oct 26 2026: and it says the note goes on its own after 15 minutes (lib/unsentNotes).
      c.ok("a saved note not yet in a change request: '1 note hasn't gone to your editor yet. Press Request changes… Otherwise it goes on its own 15 minutes after your last note.'", /1 note hasn't gone to your editor yet\. Press Request changes to send it now, or approve if nothing needs changing\. Otherwise it goes on its own 15 minutes after your last note\./.test(say(openTree)) && !!buttonWith(openTree, "Request changes (1 note)"));
    } finally {
      Object.assign(g, saved);
      for (const k of Object.keys(saved) as (keyof typeof saved)[]) if (saved[k] === undefined) delete g[k];
    }
  }

  // ---- the database for D–G ------------------------------------------------------
  const { stop } = await bootDrillDb({ port: PORT, env: { APP_SECRET: "isolated-oct22-portal" } });
  const quiet = quietPrismaErrors();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { NextRequest } = await import("next/server");
    const cs = await import("@/lib/auth/clientSession");
    const refresh = await import("@/lib/auth/clientSessionRefresh");
    const { resolvePortalViewer } = await import("@/lib/portal");
    const { proxy } = await import("@/proxy");

    const mike = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Mike Ciunci TEST", owner: { email: "info+mike@realtourpilot.com", name: "Mike Ciunci" } });
    const jar = (token: string) => ({ get: (n: string) => (n === cs.CLIENT_COOKIE ? token : undefined) });
    const visit = (token: string, pathname = "/portal/me", method = "GET") => new NextRequest(`http://127.0.0.1${pathname}`, { method, headers: { cookie: `${cs.CLIENT_COOKIE}=${token}` } });
    const HOUR = 3600_000;

    // =======================================================================
    c.head("D · stay signed in: a rolling year, re-issued on a visit, revocation still immediate");
    // =======================================================================
    c.ok("the session lasts a year (365 days), re-issued when an hour old", cs.CLIENT_SESSION_MAX_AGE === 365 * 86400 && cs.CLIENT_SESSION_REFRESH_AFTER_MS === HOUR);
    const now = new Date();
    const old = await cs.signClientSession({ cu: mike.clientUserId!, email: "info+mike@realtourpilot.com" }, new Date(now.getTime() - 40 * 86400_000));
    const oldRead = await cs.readClientSession(old);
    const decoded = JSON.parse(Buffer.from(old.split(".")[1], "base64url").toString());
    c.ok("a token's life is exactly a year from when it was issued", decoded.exp - decoded.iat === 365 * 86400 && !!oldRead?.issuedAt);
    const res = await proxy(visit(old));
    const setCookie = res.headers.get("set-cookie") ?? "";
    const fresh = res.cookies.get(cs.CLIENT_COOKIE)?.value ?? "";
    const freshRead = await cs.readClientSession(fresh);
    c.ok("a visit to /portal/me with a 40-day-old cookie re-issues it (the proxy, sliding expiry)", !!freshRead && freshRead.cu === mike.clientUserId && Math.abs(freshRead.issuedAt!.getTime() - Date.now()) < 60_000);
    c.ok("…httpOnly, sameSite lax, path /, a year long, exactly the sign-in route's attributes",
      /HttpOnly/i.test(setCookie) && /SameSite=lax/i.test(setCookie) && /Path=\//.test(setCookie) && /Max-Age=31536000/.test(setCookie) && /clientCookieOptions\(CLIENT_SESSION_MAX_AGE\)/.test(src("src/lib/auth/clientSessionRefresh.ts")) && /clientCookieOptions\(CLIENT_SESSION_MAX_AGE\)/.test(src("src/app/portal/auth/[token]/route.ts")), setCookie);
    c.ok("…secure follows production, as before", cs.clientCookieOptions(1).secure === (process.env.NODE_ENV === "production") && cs.clientCookieOptions(1).httpOnly === true);
    const recent = await cs.signClientSession({ cu: mike.clientUserId!, email: "info+mike@realtourpilot.com" }, new Date(now.getTime() - 5 * 60_000));
    c.ok("a cookie issued 5 minutes ago is left alone (no database read per click)", !(await proxy(visit(recent))).cookies.get(cs.CLIENT_COOKIE));
    c.ok("only portal GETs: not a POST, not the sign-in route, not a hub page",
      !refresh.isClientSessionVisit("POST", "/portal/me", true) && !refresh.isClientSessionVisit("GET", "/portal/auth/abc", true) && !refresh.isClientSessionVisit("GET", "/tasks", true) && refresh.isClientSessionVisit("GET", "/portal/me", true) && !refresh.isClientSessionVisit("GET", "/portal/me", false));
    c.ok("the session reads back as Mike's live seat", (await resolvePortalViewer({ cookies: jar(fresh) })).ok);

    await prisma.clientMembership.update({ where: { id: mike.membershipId! }, data: { revokedAt: new Date() } });
    c.ok("staff revoke the seat: the very next request is refused, even with the cookie just re-issued", (await resolvePortalViewer({ cookies: jar(fresh) })).ok === false);
    c.ok("…and a visit re-issues nothing for it", !(await proxy(visit(old))).cookies.get(cs.CLIENT_COOKIE) && (await refresh.refreshedClientSession(old)) === null);
    await prisma.clientMembership.update({ where: { id: mike.membershipId! }, data: { revokedAt: null } });
    await prisma.contentEnrollment.update({ where: { id: mike.enrollmentId }, data: { accessRevokedAt: new Date() } });
    c.ok("program access revoked: refused, and never re-issued", (await resolvePortalViewer({ cookies: jar(fresh) })).ok === false && (await refresh.refreshedClientSession(old)) === null);
    await prisma.contentEnrollment.update({ where: { id: mike.enrollmentId }, data: { accessRevokedAt: null } });
    await prisma.clientUser.update({ where: { id: mike.clientUserId! }, data: { status: "DISABLED" } });
    const disabled = await resolvePortalViewer({ cookies: jar(fresh) });
    c.ok("a disabled person: refused, and never re-issued", !disabled.ok && disabled.reason === "no_session" && (await refresh.refreshedClientSession(old)) === null);
    await prisma.clientUser.update({ where: { id: mike.clientUserId! }, data: { status: "ACTIVE" } });
    c.ok("a forged or foreign cookie is not re-issued", (await refresh.refreshedClientSession("not.a.jwt")) === null && !(await proxy(visit("not.a.jwt"))).cookies.get(cs.CLIENT_COOKIE));

    // =======================================================================
    c.head("E · the home screen app: manifest route, icons, tags");
    // =======================================================================
    {
      const route = await import("@/app/portal/manifest.webmanifest/route");
      const r = route.GET();
      const m = await r.json();
      const css = src("src/app/globals.css");
      const portalBrand = /\.portal-light \{[\s\S]*?--brand: (#[0-9a-f]{6});/i.exec(css)?.[1];
      const portalBg = /\.portal-light \{[\s\S]*?--background: (#[0-9a-f]{6});/i.exec(css)?.[1];
      c.ok("served as application/manifest+json", /application\/manifest\+json/.test(r.headers.get("content-type") ?? ""));
      c.ok("name 'Realtour Pilot', scope /portal/, start /portal/me, standalone", m.name === "Realtour Pilot" && m.short_name === "Realtour Pilot" && m.scope === "/portal/" && m.start_url === "/portal/me" && m.display === "standalone", JSON.stringify(m).slice(0, 200));
      c.ok("theme and background from the portal's brand tokens", m.theme_color === portalBrand && m.background_color === portalBg, `${m.theme_color} vs ${portalBrand}, ${m.background_color} vs ${portalBg}`);
      const png = (p: string) => { const b = fs.readFileSync(path.join(ROOT, "public", p)); return b.toString("ascii", 1, 4) === "PNG" ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
      const icons = m.icons as { src: string; sizes: string; type: string; purpose: string }[];
      c.ok("icons 192 and 512, PNG, any + maskable, and the files are those sizes on disk",
        ["192x192", "512x512"].every((s) => icons.some((i) => i.sizes === s && i.purpose === "any") && icons.some((i) => i.sizes === s && i.purpose === "maskable")) &&
        icons.every((i) => i.type === "image/png" && JSON.stringify(png(i.src)) === JSON.stringify(i.sizes.split("x").map(Number))));
      c.ok("apple-touch-icon is 180×180 on disk", JSON.stringify(png("brand/apple-touch-icon.png")) === "[180,180]");
      const me = await import("@/app/portal/me/page");
      const tok = await import("@/app/portal/[token]/page");
      const meta = me.metadata as any;
      c.ok("/portal/me links the manifest, the Apple web app tags and the touch icon, with the theme colour",
        meta.manifest === "/portal/manifest.webmanifest" && meta.appleWebApp?.capable === true && meta.appleWebApp?.title === "Realtour Pilot" && meta.other?.["apple-mobile-web-app-capable"] === "yes" && meta.icons?.apple?.[0]?.url === "/brand/apple-touch-icon.png" && (me as any).viewport?.themeColor === portalBrand && meta.title === "Your Content Program | Realtour Pilot" && meta.robots?.index === false);
      c.ok("the shared-link page links no manifest (an icon made there keeps its own address)", (tok.metadata as any).manifest === undefined);
      c.ok("no root app/manifest (it would be linked from every hub page)", !["ts", "js", "json", "webmanifest"].some((x) => fs.existsSync(path.join(ROOT, `src/app/manifest.${x}`))));
      const { isPublicRoute } = await import("@/lib/publicRoutes");
      c.ok("the manifest is public like the rest of /portal", isPublicRoute("/portal/manifest.webmanifest"));
    }

    // =======================================================================
    c.head("F · 'Add to your home screen' on Home: the client and the link, never staff");
    // =======================================================================
    {
      const { PortalPage } = await import("@/components/portal/PortalPage");
      const { InstallAppCard, installPlatform, INSTALL_CARD_DISMISSED_KEY } = await import("@/components/portal/InstallAppCard");
      const staffUser = await prisma.appUser.create({ data: { email: "kyle@realtourpilot.com", name: "Kyle Drill", role: "ADMIN", status: "ACTIVE" }, select: { id: true } });
      const viewerOf = (actor: PortalViewer["actor"]): PortalViewer => ({ enrollment: { id: mike.enrollmentId, clientId: mike.clientId, clientName: mike.clientName, status: "ACTIVE", videosPerMonth: mike.videosPerMonth, sessionsPerMonth: mike.sessionsPerMonth }, actor, access: "FULL", via: actor.kind === "CLIENT" ? "LOGIN" : actor.kind } as PortalViewer);
      const cards = async (actor: PortalViewer["actor"], p: string) => find(await PortalPage({ viewer: viewerOf(actor), path: p, query: {} }), "InstallAppCard");
      const clientCards = await cards({ kind: "CLIENT", clientUserId: mike.clientUserId!, email: "info+mike@realtourpilot.com", name: "Mike Ciunci", membershipId: mike.membershipId!, membershipRole: "OWNER" } as PortalViewer["actor"], "/portal/me");
      const linkCards = await cards({ kind: "TOKEN" } as PortalViewer["actor"], "/portal/[token]");
      const staffCards = await cards({ kind: "STAFF", staffUserId: staffUser.id, staffName: "Kyle Drill", staffRole: "ADMIN" } as PortalViewer["actor"], "/portal/[token]");
      c.ok("the signed-in client's Home shows the card (signedIn)", clientCards.length === 1 && clientCards[0].props.signedIn === true);
      c.ok("the shared link's Home shows it too", linkCards.length === 1 && linkCards[0].props.signedIn === false);
      c.ok("staff viewing on the client's behalf never get it", staffCards.length === 0);
      const videosTab = find(await PortalPage({ viewer: viewerOf({ kind: "CLIENT", clientUserId: mike.clientUserId!, email: "x", name: "Mike", membershipId: mike.membershipId!, membershipRole: "OWNER" } as PortalViewer["actor"]), path: "/portal/me", query: { tab: "library" } }), "InstallAppCard");
      c.ok("…and it is on Home only", videosTab.length === 0);
      c.ok("the card renders nothing on the server (it decides in the browser, so it never flashes)", renderToStaticMarkup(createElement(InstallAppCard, { signedIn: true })) === "");
      c.ok("iPhone, iPad (reported as a Mac with touch) and Android get their own steps; a computer only with an install prompt",
        installPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)") === "ios" && installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5) === "ios" &&
        installPlatform("Mozilla/5.0 (Linux; Android 15; Pixel 9)") === "android" && installPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0) === "other");
      const card = src("src/components/portal/InstallAppCard.tsx");
      c.ok("the steps are plain: Share, then Add to Home Screen; the menu, then Add to Home screen or Install app", /Tap the Share button/.test(card) && /Add to Home Screen/.test(card) && /Tap the menu/.test(card) && /Install app/.test(card) && !/—/.test(card.replace(/\/\/.*$/gm, "")));
      c.ok("dismissal is remembered per device, every storage access guarded", INSTALL_CARD_DISMISSED_KEY === "rtp_portal_install_card_dismissed" && /try \{ return window\.localStorage\.getItem\(INSTALL_CARD_DISMISSED_KEY\)/.test(card) && /try \{ window\.localStorage\.setItem\(INSTALL_CARD_DISMISSED_KEY, "1"\); \} catch/.test(card));
    }

    // =======================================================================
    c.head("G · one-tap links: land on the right page, signed in");
    // =======================================================================
    {
      const { portalLandingQuery, portalNextPath, PORTAL_LANDING } = await import("@/lib/portalLanding");
      const { resolvePortalLink } = await import("@/lib/programReminders");
      const pa = await import("@/lib/portalAccess");
      const authRoute = await import("@/app/portal/auth/[token]/route");
      const { composeReplyNotice } = await import("@/lib/programMessages");
      const allowed = ["?tab=library&st=review", "?tab=library&v=vid0000000001", "?tab=library", "?tab=plan", "?tab=plan&pv=scripts", "?tab=plan&pv=strategy", "?tab=messages", "?tab=brand", "?tab=topics&iv=abcdefghij12"];
      c.ok("every email landing passes the allowlist", allowed.every((q) => portalLandingQuery(q) === q && portalNextPath(`/portal/me${q}`) === `/portal/me${q}`));
      const bad = ["//evil.com", "https://evil.com/portal/me?tab=messages", "/portal/me?tab=messages&x=1", "/portal/me?tab=topics&iv=../x", "/portal/me?tab=library&v=../../x", "/portal/me?tab=messages#x", "/portal/meX?tab=messages", "/portal/me?tab=plan&pv=evil"];
      c.ok("an open redirect, a traversal, anything appended: home instead", bad.every((n) => portalNextPath(n) === "/portal/me"), bad.filter((n) => portalNextPath(n) !== "/portal/me").join(" "));
      const eRow = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: mike.enrollmentId }, select: { id: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true } });
      const seat = { membershipId: mike.membershipId!, clientUserId: mike.clientUserId! };
      const tokenLink = await resolvePortalLink(eRow, null, null, new Date(), { path: PORTAL_LANDING.scripts });
      c.ok("with no seat: the shared page, opened on the scripts", tokenLink?.kind === "token" && tokenLink.url.endsWith(`/portal/${eRow.portalToken}?tab=plan&pv=scripts`), tokenLink?.url);
      const signIn = await resolvePortalLink(eRow, seat, null, new Date(), { path: PORTAL_LANDING.reviewVideos });
      c.ok("with a seat: a sign-in link whose ?next= is the videos waiting on them", signIn?.kind === "login" && /\/portal\/auth\/[A-Za-z0-9_-]{40,60}\?next=/.test(signIn.url) && signIn.url.endsWith(`?next=${encodeURIComponent("/portal/me?tab=library&st=review")}`), signIn?.url);
      const raw = new URL(signIn!.url).pathname.split("/").pop()!;
      const params = { params: Promise.resolve({ token: raw }) };
      const linkUrl = signIn!.url;
      const opened = await authRoute.GET(new NextRequest(linkUrl), params);
      const html = await opened.text();
      c.ok("opening it (no cookie): one button, carrying the landing; nothing spent", opened.status === 200 && html.includes("Continue to your portal") && html.includes('value="/portal/me?tab=library&amp;st=review"') && (await pa.peekLoginToken(raw)).ok);
      const pressed = await authRoute.POST(new NextRequest(`http://127.0.0.1/portal/auth/${raw}`, { method: "POST", headers: { "sec-fetch-site": "same-origin" }, body: new URLSearchParams({ next: "/portal/me?tab=library&st=review" }) }), params);
      const cookie = pressed.cookies.get(cs.CLIENT_COOKIE)?.value ?? "";
      c.ok("the press signs in for a year and lands on the videos to review", pressed.status === 303 && new URL(pressed.headers.get("location")!).pathname + new URL(pressed.headers.get("location")!).search === "/portal/me?tab=library&st=review" && !!cookie && /Max-Age=31536000/.test(pressed.headers.get("set-cookie") ?? ""), pressed.headers.get("location") ?? "");
      const withCookie = (u: string) => new NextRequest(u, { headers: { cookie: `${cs.CLIENT_COOKIE}=${cookie}` } });
      const again = await authRoute.GET(withCookie(linkUrl), params);
      c.ok("ONE TAP: the same (now spent) link on the signed-in phone goes straight to the page, no login wall", again.status === 303 && (again.headers.get("location") ?? "").endsWith("/portal/me?tab=library&st=review"), again.headers.get("location") ?? "");
      const noCookie = await authRoute.GET(new NextRequest(linkUrl), params);
      c.ok("…without the cookie a spent link still goes to sign-in, as before", noCookie.status === 303 && /\/portal\/login\?reason=invalid/.test(noCookie.headers.get("location") ?? ""));
      const live = await resolvePortalLink(eRow, seat, null, new Date(), { path: PORTAL_LANDING.messages });
      const liveRaw = new URL(live!.url).pathname.split("/").pop()!;
      const ownLive = await authRoute.GET(withCookie(live!.url), { params: Promise.resolve({ token: liveRaw }) });
      c.ok("their own live link on the signed-in phone: straight to Messages, and the link is not spent", ownLive.status === 303 && (ownLive.headers.get("location") ?? "").endsWith("/portal/me?tab=messages") && (await pa.peekLoginToken(liveRaw)).ok);
      const other = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Other Agent TEST", owner: { email: "info+other@realtourpilot.com", name: "Other Agent" } });
      const otherE = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: other.enrollmentId }, select: { id: true, portalToken: true, portalTokenExpiresAt: true, accessRevokedAt: true } });
      const otherLink = await resolvePortalLink(otherE, { membershipId: other.membershipId!, clientUserId: other.clientUserId! }, null, new Date(), { path: PORTAL_LANDING.messages });
      const otherRaw = new URL(otherLink!.url).pathname.split("/").pop()!;
      const foreign = await authRoute.GET(withCookie(otherLink!.url), { params: Promise.resolve({ token: otherRaw }) });
      c.ok("someone else's live link on Mike's phone: the button (it signs in its owner), not Mike's portal", foreign.status === 200 && (await foreign.text()).includes("Continue to your portal") && (await pa.peekLoginToken(otherRaw)).ok);

      // A reply under a script (Oct 22, the script-replies build): the shape its
      // email uses is an allowed landing, so a sign-in link can carry it.
      const replyLanding = PORTAL_LANDING.scriptReply(mike.enrollmentId, "msg0000000001");
      c.ok("a reply under a script: its landing (program, Scripts view, the reply's anchor) passes the allowlist", portalLandingQuery(replyLanding) === replyLanding && portalNextPath(`/portal/me${replyLanding}`) === `/portal/me?e=${mike.enrollmentId}&tab=plan&pv=scripts#reply-msg0000000001`);
      const replyLink = await resolvePortalLink(eRow, seat, null, new Date(), { path: replyLanding });
      const replyRaw = new URL(replyLink!.url).pathname.split("/").pop()!;
      const toReply = await authRoute.GET(withCookie(replyLink!.url), { params: Promise.resolve({ token: replyRaw }) });
      c.ok("…and a sign-in link to it opens the Scripts view at the reply on the signed-in phone", replyLink?.kind === "login" && toReply.status === 303 && (toReply.headers.get("location") ?? "").endsWith(`/portal/me?e=${mike.enrollmentId}&tab=plan&pv=scripts#reply-msg0000000001`), toReply.headers.get("location") ?? "");
      // Left as they are (listed in the report): a sign-in link in these turns
      // Jordan's Bcc into a separate link-stripped copy (clientEmailMonitor).
      const plain = composeReplyNotice({ name: "Mike Ciunci", staffName: "Kyle Cabrera", body: "Moved it to Thursday" });
      c.ok("the office-replied notice is unchanged: the sign-in page, no sign-in link", plain.includes("/portal/login") && !plain.includes("/portal/auth/"));

      const share = src("src/lib/scriptShare.ts");
      const rem = src("src/lib/programReminders.ts");
      c.ok("scripts ready / strategy ready: the sign-in link opens the scripts or the strategy (not only the token page)",
        /const landing = n\.action === "STRATEGY_READY" \? PORTAL_LANDING\.strategy : PORTAL_LANDING\.scripts;/.test(share) && /resolvePortalLink\([^;]*\{ path: landing \}\)/.test(share) && !/link\.kind === "token" \? `\$\{link\.url\}\?tab=plan&pv=strategy`/.test(share));
      c.ok("program reminders: review → the videos waiting, planning and filming → Your Month",
        /lane === "REVIEW" \? PORTAL_LANDING\.reviewVideos : action === "BOOK_SESSION" \|\| action === "BOOK_CALL" \|\| action === "CHOOSE_PATH" \|\| action === "COMPLETE_ANSWERS" \? PORTAL_LANDING\.yourMonth : null/.test(rem));
      c.ok("brand kit → the brand page; approve your scripts → the scripts", /\{ path: PORTAL_LANDING\.brand \}/.test(rem) && /\{ path: PORTAL_LANDING\.scripts \}/.test(rem));
      c.ok("resolvePortalLink and the sign-in route share one allowlist", /const path = portalLandingQuery\(opts\.path\);/.test(rem) && /const safePortalNext = portalNextPath;/.test(src("src/app/portal/auth/[token]/route.ts")));
    }

    c.head("isolation");
    c.ok("no outbound call left the machine", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
    c.ok("no Prisma error was logged", quiet.count === 0, `${quiet.count}`);
    c.summary();
  } finally {
    quiet.restore();
    await stop();
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => { fence.restore(); process.exit(process.exitCode ?? 0); });
