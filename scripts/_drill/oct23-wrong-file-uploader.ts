// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL oct23-wrong-file-uploader: the wrong-file warning on the editor's
// upload panel and the reviewer's line in the cut panel (Jordan, Oct 23 2026:
// "This looks like the file you uploaded for 859 N Lawrence St on Oct 22.
// Upload anyway?", and a flag for the reviewer).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-wrong-file-uploader.ts --logs <dir>
//
// The SHIPPED CutUploader is driven with its real handlers (the small hook
// dispatcher cut-sound-uploader uses) and rendered with react-dom/server; the
// SHIPPED CutReviewPanel is rendered whole. The server actions and the byte
// store are declared fakes at the module boundary, recording what they were
// sent; no database is opened and nothing leaves the process. The server's
// own half (the check, the refusal, the timeline) is oct23-wrong-file.ts.
//
//   §1 the 859 file on 538 Onward Ave: the words and two buttons, BEFORE any
//      bytes; nothing reserved, nothing uploaded
//   §2 "Choose another file": the card goes, the picker opens; the right file
//      then goes up as today, with no override
//   §3 "Upload anyway": the final check, then the reservation carries the
//      override, and the bytes go
//   §4 the server's own refusal (the panel's check came back empty): the same
//      card, the check already answered is kept, "Upload anyway" sends
//   §5 never blocks: a check that fails, or hangs, uploads as today
//   §6 the reviewer: the line above Approve with "Wrong video?" beside it;
//      Approve untouched; the softer line; nothing when nothing is wrong
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fenceFetch, interceptModule, makeChecker } from "./_harness";

const req = createRequire(__filename);
const fence = fenceFetch();

// ---- next/navigation for a client component ---------------------------------
const navigation = req("next/navigation") as Record<string, unknown>;
navigation.useRouter = () => ({ refresh() {}, replace() {}, push() {}, back() {}, prefetch() {} });
navigation.useSearchParams = () => new URLSearchParams();
navigation.usePathname = () => "/edit";

const WRONG = { name: "Done_859 N Lawrence St (Joseph Sutow).mov", size: 114_438_264 };
const RIGHT = { name: "Done_538 Onward Ave_Premium .mov", size: 266_879_825 };
const EDITOR_WORDS = "This looks like the file you uploaded for 859 N Lawrence St on Oct 22 (same name and size).";
const REVIEWER_WORDS = "Wrong file? The name says 859 N Lawrence St, and the same file was uploaded to 859 N Lawrence St on Oct 22.";

// ---- the server's side, declared fakes -----------------------------------------
type StartInput = { fileName: string; sizeBytes: number; wrongFileOverride?: boolean; selfCheck?: unknown };
let checkMode: "answer" | "empty" | "throw" | "hang" = "answer";
let serverRefuses = false;
const calls = { asked: [] as string[], start: [] as StartInput[], upload: 0, finish: 0 };
const wrapKeys = (match: (r: string) => boolean, fakes: Record<string, unknown>) =>
  interceptModule(match, (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (typeof k === "string" && k in fakes ? fakes[k] : t[k]) }));
wrapKeys((r) => r === "@/app/review/actions", {
  checkCutUploadFile: async (i: { fileName: string }) => {
    calls.asked.push(i.fileName);
    if (checkMode === "throw") throw new Error("declared check failure");
    if (checkMode === "hang") return new Promise(() => {});
    if (checkMode === "empty") return null;
    return i.fileName === WRONG.name ? { lines: [EDITOR_WORDS], strong: true } : null;
  },
  startCutUpload: async (i: StartInput) => {
    calls.start.push(i);
    if (serverRefuses && i.fileName === WRONG.name && i.wrongFileOverride !== true) {
      return { ok: false, message: `${EDITOR_WORDS} Choose another file, or press Upload anyway.`, wrongFile: { lines: [EDITOR_WORDS], strong: true } };
    }
    const n = calls.start.length;
    return { ok: true, submissionId: `sub-${n}`, round: 1, pathname: `review-cuts/p538/sub-${n}/${i.fileName}`, access: "public" };
  },
  finishCutUpload: async () => { calls.finish++; return { ok: true, message: "Version 1 is in review." }; },
  abandonCutUpload: async () => ({ ok: true }),
  cutTakeBackFlags: async () => [],
});
wrapKeys((r) => r === "@/app/review/selfCheckActions", { uploadPanelSummary: async () => null });
wrapKeys((r) => r === "@/components/editing/cutMessage.actions", { saveCutMessage: async () => ({ ok: true, message: "Saved" }) });
wrapKeys((r) => r === "@vercel/blob/client", {
  upload: async (pathname: string) => { calls.upload++; const url = `https://drillstore.public.blob.vercel-storage.com/${pathname}`; return { url, downloadUrl: url, pathname, contentType: "video/quicktime", contentDisposition: "inline" }; },
});

// ---- a small hook dispatcher, so the component's REAL handlers run ---------------
function mountHooks(render: () => unknown) {
  const react = req("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [];
  const effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((v, i) => v !== old[i])) { cells[slot] = deps; effects.push(() => { effect(); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (cb: () => Promise<unknown>) => { cells[slot] = true; void cb().finally(() => { cells[slot] = false; }); }]; },
    useOptimistic(passthrough: unknown) { index++; return [passthrough, () => {}]; },
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
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const until = async (test: () => boolean, what: string, ms = 8_000) => {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(`drill: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 60));

async function main() {
  const c = makeChecker();
  const g = globalThis as Record<string, unknown>;
  g.window = { location: { href: "https://hub.drill/edit/p538" }, history: { state: null, replaceState() {} }, addEventListener() {}, removeEventListener() {} };
  g.document = { addEventListener() {}, removeEventListener() {} };
  const up = await import("../../src/components/editing/CutUploader");
  const { CutReviewPanel } = await import("../../src/components/review/CutReviewPanel");

  const KEY = "d538:1";
  const ctx = { profile: { styleName: "Premium Social Media Reel", items: [] }, isRevision: false, issues: [] };
  const file = (f: { name: string; size: number }) => {
    // A File that reports the real night's size without holding 114 MB.
    const x = new File([new Uint8Array(16)], f.name, { type: "video/quicktime", lastModified: 1 });
    Object.defineProperty(x, "size", { value: f.size });
    return x;
  };
  const mount = () => {
    const props = { projectId: "p538", cuts: [{ deliverableId: "d538", slot: 1, label: "Premium Social Media Reel", latest: null, openNotes: 0 }], canUpload: true, checks: { [KEY]: ctx } };
    const ui = mountHooks(() => up.CutUploader(props as unknown as Parameters<typeof up.CutUploader>[0]));
    let picker = 0;
    const tree = () => ui.render();
    const input = () => named(tree(), "input").find((p) => p.type === "file")!;
    // The row's one picker: its ref gets a stand-in element so "Choose another
    // file" can be seen opening it.
    const attach = () => (input().ref as (el: unknown) => void)?.({ click: () => { picker++; } });
    attach();
    return {
      tree,
      html: () => plain(renderToStaticMarkup(tree() as ReactElement)),
      card: () => named(tree(), "div").find((p) => "data-wrong-file" in p) ?? null,
      button: (attr: string) => named(tree(), "button").find((p) => attr in p) ?? null,
      dialog: () => named(tree(), "SelfCheckDialog")[0] ?? null,
      sent: () => named(tree(), "UploadSentCard").some((p) => p.phase === "done"),
      pick: (f: File) => { attach(); (input().onChange as (e: unknown) => void)({ target: { files: [f], value: "" } }); },
      get picker() { return picker; },
    };
  };
  const reset = () => { calls.asked = []; calls.start = []; calls.upload = 0; calls.finish = 0; };

  // =========================================================================
  c.head("§1 · the 859 file on 538 Onward Ave");
  // =========================================================================
  const p = mount();
  {
    reset();
    p.pick(file(WRONG));
    await until(() => !!p.card(), "the wrong-file card");
    const text = p.html();
    c.ok(`the row reads: "${EDITOR_WORDS} Upload anyway?"`, text.includes(`${EDITOR_WORDS} Upload anyway?`), text.slice(0, 400));
    c.ok("asked with the chosen file's name and size, for this job and video", calls.asked.length === 1 && calls.asked[0] === WRONG.name);
    c.ok("two buttons: \"Choose another file\" (the default, focused) and \"Upload anyway\"", !!p.button("data-wrong-file-choose") && p.button("data-wrong-file-choose")?.autoFocus === true && !!p.button("data-wrong-file-anyway") && /Choose another file/.test(text) && /Upload anyway goes on the job.s timeline with your name\./.test(text));
    c.ok("the file and its size are named on the card", /Done_859 N Lawrence St \(Joseph Sutow\)\.mov · 114 MB/.test(text), text.slice(0, 400));
    c.ok("nothing uploaded, nothing reserved, no final check opened", calls.start.length === 0 && calls.upload === 0 && !p.dialog());
    await settle();
    c.ok("...and still nothing a moment later (nothing goes up until a button is pressed)", calls.start.length === 0 && calls.upload === 0);
  }

  // =========================================================================
  c.head("§2 · \"Choose another file\"");
  // =========================================================================
  {
    const before = p.picker;
    (p.button("data-wrong-file-choose")!.onClick as () => void)();
    c.ok("the card goes and the file picker opens", !p.card() && p.picker === before + 1);
    c.ok("still nothing uploaded", calls.start.length === 0 && calls.upload === 0);
    p.pick(file(RIGHT));
    await until(() => !!p.dialog(), "the final check for the right file");
    c.ok("the right file: no card, straight to the final check", !p.card());
    await (p.dialog()!.onSubmit as (i: unknown) => Promise<unknown>)({ checklistKey: "x", answers: {} });
    await until(() => p.sent(), "the hand-in");
    c.ok("...and it goes up as today, with no override", calls.start.length === 1 && calls.start[0].fileName === RIGHT.name && calls.start[0].wrongFileOverride === undefined && calls.upload === 1);
  }

  // =========================================================================
  c.head("§3 · \"Upload anyway\"");
  // =========================================================================
  {
    reset();
    const q = mount();
    q.pick(file(WRONG));
    await until(() => !!q.card(), "the wrong-file card");
    (q.button("data-wrong-file-anyway")!.onClick as () => void)();
    await until(() => !!q.dialog(), "the final check");
    c.ok("the card goes; the final check opens before any bytes", !q.card() && calls.start.length === 0 && calls.upload === 0);
    await (q.dialog()!.onSubmit as (i: unknown) => Promise<unknown>)({ checklistKey: "x", answers: {} });
    await until(() => q.sent(), "the hand-in");
    c.ok("the reservation carries the override (the server records who, the warning, the file)", calls.start.length === 1 && calls.start[0].fileName === WRONG.name && calls.start[0].wrongFileOverride === true);
    c.ok("...and the bytes go", calls.upload === 1 && calls.finish === 1);
    c.ok("the warning was asked once, for that file", calls.asked.length === 1);
  }

  // =========================================================================
  c.head("§4 · the server's own refusal");
  // =========================================================================
  {
    reset();
    checkMode = "empty"; // the panel's question came back empty (or never ran)
    serverRefuses = true;
    const r = mount();
    r.pick(file(WRONG));
    await until(() => !!r.dialog(), "the final check");
    await (r.dialog()!.onSubmit as (i: unknown) => Promise<unknown>)({ checklistKey: "x", answers: { a: { answer: "YES" } } });
    await until(() => !!r.card(), "the server's wrong-file card");
    c.ok("the server refused without the override: the same words on the same card", r.html().includes(`${EDITOR_WORDS} Upload anyway?`) && calls.start.length === 1 && calls.start[0].wrongFileOverride === undefined);
    c.ok("no bytes went", calls.upload === 0);
    (r.button("data-wrong-file-anyway")!.onClick as () => void)();
    await until(() => r.sent(), "the hand-in");
    c.ok("\"Upload anyway\" sends it with the override, and the check already answered (not asked twice)", calls.start.length === 2 && calls.start[1].wrongFileOverride === true && JSON.stringify(calls.start[1].selfCheck) === JSON.stringify({ checklistKey: "x", answers: { a: { answer: "YES" } } }) && !r.dialog());
    c.ok("...and the bytes go", calls.upload === 1);
    serverRefuses = false;
  }

  // =========================================================================
  c.head("§5 · never blocks");
  // =========================================================================
  for (const mode of ["throw", "hang"] as const) {
    reset();
    checkMode = mode;
    const s = mount();
    const t0 = Date.now();
    s.pick(file(WRONG));
    await until(() => !!s.dialog(), `the final check after a check that ${mode === "throw" ? "fails" : "hangs"}`);
    const took = Date.now() - t0;
    c.ok(mode === "throw" ? "a check that fails: no card, the upload goes as today" : `a check that hangs: no card after ${Math.round(took / 100) / 10} s, the upload goes as today`, !s.card() && (mode === "throw" || took < 7_000));
    await (s.dialog()!.onSubmit as (i: unknown) => Promise<unknown>)({ checklistKey: "x", answers: {} });
    await until(() => s.sent(), "the hand-in");
    c.ok("...uploaded without an override (the server decides)", calls.start.length === 1 && calls.start[0].wrongFileOverride === undefined && calls.upload === 1);
  }
  checkMode = "answer";

  // =========================================================================
  c.head("§6 · the reviewer's line");
  // =========================================================================
  {
    const submission = {
      id: "sub-538", round: 1, status: "PENDING", assetUrl: "/api/review/cut/sub-538/stream", assetPath: null, fileName: WRONG.name, note: null,
      submittedByKey: "john", submittedByName: "John Mark", createdAt: "2026-10-24T02:08:00.000Z", decidedAt: null, decidedBy: null,
      clientRequestedAt: null, clientRequestedBy: null, verdict: null, reviewerMove: null, deliverableId: "d538", slot: 1, source: "upload",
      hasHubCopy: true, completedAt: null, heldForCheck: false,
    };
    const takeBack = {
      submissionId: "sub-538", round: 1, status: "PENDING", fileName: WRONG.name, canRemove: true, canMove: true, office: true, finalPath: null, folderSourcePath: null,
      withdrawnAt: null, withdrawnBy: null, withdrawnReason: null, strandedFinalPath: null, movedFromStreet: null, movedAt: null, movedBy: null,
    };
    const render = (extra: Record<string, unknown>) => renderToStaticMarkup(createElement(CutReviewPanel as unknown as (p: Record<string, unknown>) => ReactElement, {
      projectId: "p538", submission, notes: [], editorLabel: "John Mark", takeBack, cutLabel: "Premium Social Media Reel", canDecide: true, readStamp: "2026-10-24T02:30:00.000Z", street: "538 Onward Ave", ...extra,
    }));
    const html = render({ wrongFile: { line: REVIEWER_WORDS, strong: true } });
    const block = html.slice(html.indexOf("data-wrong-file"), html.indexOf("Add note"));
    c.ok(`the line: "${REVIEWER_WORDS}"`, plain(block).includes(REVIEWER_WORDS), plain(block).slice(0, 300));
    c.ok("\"Wrong video?\" right beside it", /Wrong video\?/.test(block));
    c.ok("above Approve", html.indexOf("data-wrong-file") > -1 && html.indexOf("data-wrong-file") < html.indexOf("Approve cut"));
    // The control is a button; its dialog (closed) carries the same title.
    const controls = (h: string) => (h.match(/Wrong video\?<\/button>/g) ?? []).length;
    c.ok("one \"Wrong video?\" control on the panel, not two", controls(html) === 1 && /Wrong video\?<\/button>/.test(block));
    const approve = html.slice(html.lastIndexOf("<button", html.indexOf("Approve cut")), html.indexOf("Approve cut"));
    c.ok("Approve is still there and not disabled (a person decides)", /Approve cut/.test(html) && !/disabled=""/.test(approve));
    c.ok("Approve and send, when offered, is still there too", /Approve and send/.test(render({ wrongFile: { line: REVIEWER_WORDS, strong: true }, sendOffer: { openAsks: [], asksUnknown: false } })));
    const soft = render({ wrongFile: { line: "Same file again? This version has the same name and size as version 1 (Oct 22).", strong: false } });
    c.ok("the softer line reads as itself", plain(soft).includes("Same file again? This version has the same name and size as version 1 (Oct 22)."));
    const clean = render({});
    c.ok("nothing wrong: no line, and \"Wrong video?\" stays in the verdict bar", !/data-wrong-file/.test(clean) && controls(clean) === 1 && clean.indexOf("Wrong video?</button>") > clean.indexOf("Add note"));
    c.ok("a photographer on the job sees no line", !/data-wrong-file/.test(render({ canDecide: false, wrongFile: { line: REVIEWER_WORDS, strong: true } })));
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  c.summary();
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
main().catch((e) => { console.error(e); process.exitCode = 1; setTimeout(() => process.exit(1), 50); });
