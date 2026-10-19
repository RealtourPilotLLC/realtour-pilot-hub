// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL cut-sound-uploader — the sound check inside the editor's uploader
// (src/components/editing/CutUploader.tsx, Oct 16 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/cut-sound-uploader.ts --logs <dir>
//
// The SHIPPED CutUploader is driven with its real handlers (a small hook
// dispatcher, as oct5-upload-loop does) and its cards rendered with
// react-dom/server. The server actions it calls and the byte store are
// declared fakes at the module boundary, recording what they were sent; no
// database is opened and nothing leaves the process. The picked files are
// real Blobs/Files of synthetic MP4s (_fixtures/mp4), read by the shipped
// sound check through Blob.slice — and, Node having no WebCodecs, only its
// header half runs here, which is exactly what a browser without AudioDecoder
// gets.
//
//   §1 the line: the rendered warning, and nothing for clean / un-run
//   §2 a file whose sound ends 0.6 s early: the line in the final-check
//      dialog before the bytes go and under the row; the upload goes ahead;
//      the reviewer gets ONE automatic line on the version's note
//   §3 the editor's own message comes first, the automatic line after it
//   §4 a clean file: no line, no notice, nothing written to the note
//   §5 a file the check can't read (WebM): silent, upload as usual
// ---------------------------------------------------------------------------
import { createRequire } from "node:module";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fenceFetch, interceptModule, makeChecker } from "./_harness";
import { buildExport, type Frame } from "./_fixtures/mp4";

const req = createRequire(__filename);
const fence = fenceFetch();

// ---- next/navigation for a client component ---------------------------------
const navigation = req("next/navigation") as Record<string, unknown>;
navigation.useRouter = () => ({ refresh() {}, replace() {}, push() {}, back() {}, prefetch() {} });
navigation.useSearchParams = () => new URLSearchParams();
navigation.usePathname = () => "/edit";

// ---- the server's side, declared fakes -----------------------------------------
const calls = { start: 0, upload: 0, finish: 0, notes: [] as { id: string; message: string }[] };
const wrapKeys = (match: (r: string) => boolean, fakes: Record<string, unknown>) =>
  interceptModule(match, (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get: (t, k) => (typeof k === "string" && k in fakes ? fakes[k] : t[k]) }));
wrapKeys((r) => r === "@/app/review/actions", {
  startCutUpload: async (i: { fileName: string }) => { calls.start++; return { ok: true, submissionId: `sub-${calls.start}`, round: 1, pathname: `review-cuts/p1/sub-${calls.start}/${i.fileName}`, access: "public" }; },
  finishCutUpload: async () => { calls.finish++; return { ok: true, message: "Version 1 is in review." }; },
  abandonCutUpload: async () => ({ ok: true }),
  cutTakeBackFlags: async () => [],
});
wrapKeys((r) => r === "@/app/review/selfCheckActions", { uploadPanelSummary: async () => null });
wrapKeys((r) => r === "@/components/editing/cutMessage.actions", {
  saveCutMessage: async (id: string, message: string) => { calls.notes.push({ id, message }); return { ok: true, message: "Saved" }; },
});
wrapKeys((r) => r === "@vercel/blob/client", {
  upload: async (pathname: string) => { calls.upload++; const url = `https://drillstore.public.blob.vercel-storage.com/${pathname}`; return { url, downloadUrl: url, pathname, contentType: "video/mp4", contentDisposition: "inline" }; },
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
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const until = async (test: () => boolean, what: string, ms = 5_000) => {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error(`drill: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

const fading = (end: number) => (t: number): Frame => ({ mode: "tone", amp: t >= end - 1.5 ? Math.max(0, 0.14 * ((end - t) / 1.5)) : 0.14 });
const mp4File = async (name: string, spec: Parameters<typeof buildExport>[0]) => new File([await buildExport(spec).bytes()], name, { type: "video/mp4", lastModified: 1 });

async function main() {
  const c = makeChecker();
  const g = globalThis as Record<string, unknown>;
  const win = { location: { href: "https://hub.drill/edit/p1" }, history: { state: null, replaceState() {} }, addEventListener() {}, removeEventListener() {} };
  g.window = win;
  g.document = { addEventListener() {}, removeEventListener() {} };
  const up = await import("../../src/components/editing/CutUploader");
  const sc = await import("../../src/lib/cutSoundCheck");

  // =========================================================================
  c.head("§1 · the one line");
  // =========================================================================
  {
    const line = (report: unknown) => plain(renderToStaticMarkup(createElement(up.SoundCheckLine, { report: report as Parameters<typeof up.SoundCheckLine>[0]["report"] })));
    const sync = { findings: [{ kind: "sync", words: "the audio ends 0.6 s before the picture" }], ran: { header: true, levels: false } };
    c.ok("rendered: \"The audio ends 0.6 s before the picture. Check the sync before you send it.\"", line(sync) === "The audio ends 0.6 s before the picture. Check the sync before you send it.", line(sync));
    c.ok("…marked for the page (data-sound-check), with the warning icon", /data-sound-check/.test(renderToStaticMarkup(createElement(up.SoundCheckLine, { report: sync as never }))) && /<svg/.test(renderToStaticMarkup(createElement(up.SoundCheckLine, { report: sync as never }))));
    c.ok("a clean check draws nothing", line({ findings: [], ran: { header: true, levels: true } }) === "");
    c.ok("a check that didn't run draws nothing", line({ findings: [], ran: { header: false, levels: false } }) === "" && line(null) === "" && line(undefined) === "");
  }

  const KEY = "d1:1";
  const ctx = { profile: { styleName: "Standard Reel", items: [] }, isRevision: false, issues: [] };
  /** Mount a fresh panel, pick `file`, answer the check, and wait for the hand-in. */
  async function handIn(file: File, opts: { draft?: string } = {}) {
    const before = { start: calls.start, notes: calls.notes.length };
    const props = { projectId: "p1", cuts: [{ deliverableId: "d1", slot: 1, label: "Real Estate Video Tour", latest: null, openNotes: 0 }], canUpload: true, checks: { [KEY]: ctx } };
    const ui = mountHooks(() => up.CutUploader(props as unknown as Parameters<typeof up.CutUploader>[0]));
    if (opts.draft) (named(ui.render(), "CutMessage")[0].onDraft as (v: string) => void)(opts.draft);
    const input = named(ui.render(), "input").find((p) => p.type === "file")!;
    (input.onChange as (e: unknown) => void)({ target: { files: [file], value: "" } });
    await until(() => named(ui.render(), "SelfCheckDialog").length === 1, "the final-check dialog");
    // The check runs beside the dialog; give it the moment it needs.
    await new Promise((r) => setTimeout(r, 150));
    const dialog = named(ui.render(), "SelfCheckDialog")[0];
    const rowLine = named(ui.render(), "SoundCheckLine")[0];
    const rowText = rowLine ? plain(renderToStaticMarkup(createElement(up.SoundCheckLine, rowLine as never))) : "";
    await (dialog.onSubmit as (i: unknown) => Promise<{ ok: boolean }>)({ checklistKey: "x", answers: {} });
    await until(() => named(ui.render(), "UploadSentCard").some((p) => p.phase === "done"), "the hand-in to be confirmed");
    return { notice: (dialog.notice ?? null) as string | null, rowText, started: calls.start - before.start, notes: calls.notes.slice(before.notes) };
  }

  // =========================================================================
  c.head("§2 · sound that ends 0.6 s before the picture");
  // =========================================================================
  {
    const file = await mp4File("Tour v1.mp4", { videoSec: 30, audioSec: 29.4, sound: fading(29.4), priming: true, moovAtEnd: true });
    const r = await handIn(file);
    const line = "The audio ends 0.6 s before the picture. Check the sync before you send it.";
    c.ok("in the final-check dialog, BEFORE the bytes go", r.notice === line, String(r.notice));
    c.ok("…and as the one line under the row", r.rowText === line, r.rowText);
    c.ok("WARN, NEVER BLOCK: the upload went ahead", r.started === 1 && calls.upload >= 1);
    c.ok("the reviewer gets ONE automatic line on the version's note", r.notes.length === 1 && r.notes[0].message === "Sound check (automatic): the audio ends 0.6 s before the picture.", JSON.stringify(r.notes));
  }

  // =========================================================================
  c.head("§3 · the editor's own message first");
  // =========================================================================
  {
    const file = await mp4File("Tour v2.mp4", { videoSec: 30, audioSec: 29.5, sound: fading(29.5), audioDelaySec: 0.5 });
    const r = await handIn(file, { draft: "no border version" });
    c.ok("saved as their words, then the automatic line", r.notes.length === 1 && r.notes[0].message === "no border version\nSound check (automatic): the sound starts 0.5 s after the picture.", JSON.stringify(r.notes));
  }

  // =========================================================================
  c.head("§4 · a clean file");
  // =========================================================================
  {
    const file = await mp4File("Tour v3.mp4", { videoSec: 30, audioSec: 30, sound: fading(30) });
    const r = await handIn(file);
    c.ok("no notice in the dialog, no line under the row", r.notice === null && r.rowText === "", `${r.notice} / ${r.rowText}`);
    c.ok("nothing written to the version's note", r.notes.length === 0, JSON.stringify(r.notes));
    const withDraft = await handIn(await mp4File("Tour v4.mp4", { videoSec: 30, audioSec: 30, sound: fading(30) }), { draft: "client's logo added" });
    c.ok("…and an editor's message goes up exactly as typed", withDraft.notes.length === 1 && withDraft.notes[0].message === "client's logo added", JSON.stringify(withDraft.notes));
  }

  // =========================================================================
  c.head("§5 · a file the check can't read");
  // =========================================================================
  {
    const webm = new File([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]), new Uint8Array(4096)], "Tour v5.webm", { type: "video/webm" });
    const r = await handIn(webm);
    c.ok("WebM: silent — no notice, no line, no note — and uploaded as usual", r.notice === null && r.rowText === "" && r.notes.length === 0 && r.started === 1);
    c.ok("the words module agrees: no finding, no words", sc.soundWarningLine([]) === null);
  }

  c.head("Z · isolation");
  c.ok("nothing left the process", fence.blocked.length === 0, fence.blocked.slice(0, 3).join(", "));
  c.summary();
  // The panel's own timers/effects are not ours to wait on.
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}
main().catch((e) => { console.error(e); process.exitCode = 1; setTimeout(() => process.exit(1), 50); });
