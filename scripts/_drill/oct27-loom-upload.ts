// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: JORDAN'S OCT 27 2026 LOOM, THE UPLOAD PAGE AND MY SHOOTS.
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct27-loom-upload.ts
//
// The real UploadPortal, AgentRequests and SongRequestField, with every server
// action replaced in-process (a call is recorded, never sent), plus the pure
// rules they and the KPI read:
//   1. The pure rules: light instructions (under 20 of their own words, or a
//      premium brief with no vision and no style), the song link, the topic
//      script answer (split / join / problem / who is asked), the "not done on
//      site" line, and the My Shoots picture's frames (cover, then Street View
//      by coordinates, by the full address, by the title).
//   2. The top of the form: agent requests (with the on-site add and the
//      client preference, once), then From the shoot (Flag a problem, Something
//      ordered wasn't completed?, How did the shoot go?), then capture,
//      Dropbox and submit. No "Report a problem" fold, no drone tick.
//   3. "I couldn't fulfill this" per request, with a required why; a request
//      already marked shows the why and Undo; history rows and a preview never
//      offer it.
//   4. The photo details: square footage read-only for the photographer
//      (the office keeps the box), gallery order, the REQUIRED removal answer
//      ("Nothing to remove"), then Photo editor notes, then the standard.
//   5. The submit names the floor plan and 3D tour ticks and the removal.
//   6. The video: the KPI copy, the light hint, no "Instructions added to
//      Dropbox" (an old file is still read), "Video half shot" holding video 1.
//   7. A content-session topic whose script the client has not approved asks
//      "as written" or "changed on site" plus what changed; a topic confirmed
//      before is never asked; the answer is the note's last line.
//   8. The server halves, read from source: the first-video gate, the KPI
//      message, the half-shot hold and its undo, the cover guard.
// ISOLATION: no database, no provider, no network (fenced).
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fenceFetch, makeChecker } from "./_harness";
import { videoStepSpec } from "../../src/lib/pipeline";
import { submittedFieldsHash } from "../../src/lib/uploadDraft";
import { LIGHT_WORDS, lightInstructions, ownWords } from "../../src/lib/instructionsLight";
import { songProblem } from "../../src/lib/songRequest";
import { asksScriptConfirm, joinTopicScriptNote, splitTopicScriptNote, topicScriptProblem, SCRIPT_AS_WRITTEN_LINE, TOPIC_NOTE_CAP } from "../../src/lib/topicScriptConfirm";
import { notDoneLine, notDoneMatches, parseNotDoneLine } from "../../src/lib/agentRequestsCore";
import { shootThumbCandidates } from "../../src/lib/shootThumb";

type Props = Record<string, any>;
type Node = { type: unknown; props: Props };
function nodes(tree: unknown, match: (type: unknown, props: Props) => boolean): Node[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => nodes(part, match));
  if (!isValidElement<Props>(tree)) return [];
  return [...(match(tree.type, tree.props) ? [{ type: tree.type, props: tree.props }] : []), ...Object.values(tree.props).flatMap((part) => nodes(part, match))];
}
const elements = (tree: unknown, match: (type: unknown, props: Props) => boolean) => nodes(tree, match).map((n) => n.props);
const byName = (name: string) => (t: unknown) => (typeof t === "string" ? t : (t as { name?: string })?.name) === name;
/** the words a tree shows, in order (children only, as the page reads) */
const flat = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : isValidElement<Props>(n) ? flat(n.props.children) : "";
/** every string anywhere in the tree (any prop) */
function strings(tree: unknown, out: string[] = []): string[] {
  if (typeof tree === "string") out.push(tree);
  else if (Array.isArray(tree)) tree.forEach((x) => strings(x, out));
  else if (isValidElement<Props>(tree)) Object.values(tree.props).forEach((v) => strings(v, out));
  return out;
}
const errOf = (tree: unknown) => strings(tree).find((s) => s.startsWith("Not done yet")) ?? "";
async function settled(test: () => boolean) { try { await until(test); return true; } catch { return false; } }
async function until(test: () => boolean) { for (let i = 0; i < 300 && !test(); i++) await new Promise((r) => setTimeout(r, 10)); if (!test()) throw new Error("UI fixture did not settle"); }
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], cleanups: (() => void)[] = [];
  let effects: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? (initial as () => unknown)() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? (next as (v: unknown) => unknown)(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void Promise.resolve(callback()).finally(() => { cells[slot] = false; }); }]; },
  };
  return {
    render() { index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { const tree = render(); const run = effects; effects = []; run.forEach((e) => e()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } },
    stop() { cleanups.splice(0).forEach((fn) => fn()); },
  };
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const REPO = path.join(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i + 1}`).join(" ");

async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const storage = new Map<string, string>();
  const local = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: local, scrollTo() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, getElementById: () => null } });
  const nav = req.resolve("next/navigation"); req.cache[nav] = { id: nav, filename: nav, loaded: true, exports: { useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() } } as NodeModule;
  const put = (file: string, exports: unknown) => { req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  // Every server action this page can reach, replaced: a call is recorded, never sent.
  const calls: { name: string; args: unknown[] }[] = [];
  const answers: Record<string, (...a: unknown[]) => unknown> = {};
  const fake = (defaults: Record<string, (...a: unknown[]) => unknown> = {}) => new Proxy({ __esModule: true }, {
    get: (_t, k) => (k === "__esModule" ? true : k === "then" || typeof k === "symbol" ? undefined : async (...a: unknown[]) => {
      calls.push({ name: String(k), args: a });
      const answer = answers[String(k)] ?? defaults[String(k)];
      return answer ? answer(...a) : { ok: true, message: "" };
    }),
  });
  const drafts: Props[] = [];
  put(req.resolve("../../src/app/upload/actions.ts"), fake());
  put(req.resolve("../../src/app/upload/draftActions.ts"), fake({
    saveUploadDraft: (_id, body) => { drafts.push((body as { payload: Props }).payload); return { ok: true, revision: drafts.length, savedAtISO: new Date().toISOString() }; },
  }));
  put(req.resolve("../../src/app/upload/sharedActions.ts"), fake({
    saveMyCapture: () => ({ ok: true, message: "Saved.", contribution: null }),
    markMyUploads: () => ({ ok: true, message: "Marked", ticks: {} }),
    markRequestNotFulfilled: () => ({ ok: true, message: "Saved. Kyle has it on his follow-ups, and the editor's brief says it wasn't done." }),
    undoRequestNotFulfilled: () => ({ ok: true, message: "Taken back." }),
    setVideoHalfShot: (_p, input) => ({ ok: true, message: (input as { on: boolean }).on ? "Held for the next appointment. The editor won't start this video until that footage is in." : "Taken back. It is on the editors' queue again." }),
  }));

  const { UploadPortal: Portal } = await import("@/components/upload/UploadPortal");
  const { AgentRequests } = await import("@/components/upload/AgentRequests");
  const { SongRequestField } = await import("@/components/upload/SongRequestField");

  const project: Props = { id: "loom-upload", title: "2925 N 21st St, Philadelphia, PA", addressLine: "2925 N 21st St", city: "Philadelphia", state: "PA", zip: "19132", packageName: "Photos + Video + Floor plan + 3D tour", shootDate: "2026-10-27T14:00:00Z", status: "SCHEDULED", editorBrief: null, uploadedAt: null, debriefSubmittedAt: null, photosHandoffAt: null, photosHandoffBy: null, videoHandoffAt: null, videoHandoffBy: null, editorPdfPath: null, clientName: "Dana Reyes", clientAvatarUrl: null, customerNote: null, photographerName: "Harrison Wells", cullingConfirmedAt: null, shotOrderNotes: null, removalNotes: null, videoInstructions: null, videosFilmed: null, scriptConfirmedAt: null, scriptConfirmNote: null };
  const requests = [
    { id: "order:1", text: "Please feature the backyard and pool.", original: "Please feature the backyard and pool.", source: "order_note", sourceWords: "Order notes (Aryeo)", atISO: null, group: "visit", medium: null, link: null },
    { id: "ask:1", text: "Open the reel on the deck view", original: "Open the reel on the deck view", source: "client_ask", sourceWords: "Text from Dana Reyes", atISO: "2026-10-26T15:00:00Z", group: "visit", medium: "video", link: null },
    { id: "ask:2", text: "Shoot the rooftop at dusk", original: "Shoot the rooftop at dusk", source: "client_ask", sourceWords: "Text from Dana Reyes", atISO: "2026-10-26T15:05:00Z", group: "visit", medium: "photo", link: null, notDone: { why: "It rained all afternoon", by: "Harrison Wells", lineId: "act-1" } },
    { id: "ask:3", text: "Mailbox fixed", original: "Mailbox fixed", source: "client_ask", sourceWords: "Text from Dana Reyes", atISO: "2026-10-01T15:00:00Z", group: "history", medium: null, link: null, closedWords: "Confirmed by Kyle" },
  ];
  const base: Props = {
    project,
    deliverables: [
      { id: "d-photos", type: "PHOTOS", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
      { id: "d-video", type: "VIDEO", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
      { id: "d-fp", type: "FLOORPLAN", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
      { id: "d-3d", type: "MATTERPORT_3D", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
    ],
    specialRequests: [], flags: [],
    policy: { photosOrdered: true, videoOrdered: true, photoTarget: 30, range: { low: 25, high: 35, upper: 40 }, rangeMode: "sop", squareFeet: 2999, squareFeetBand: "2,000-2,999 Sq. Ft.", videoSpec: videoStepSpec(["Listing Video"], { hasFullVideo: true }), videoStyle: "standard_cinematic", isPremium: false },
    script: null, foldersSlot: null, handoffFolders: [], submission: { submittedBy: null, lastEdited: null, addOns: [], files: [] },
    viewerIsOffice: false, payGateFromMs: Date.parse("2026-09-02"), sessionTopics: null, draft: null, draftRevision: null, canSaveDraft: true,
    baseHash: submittedFieldsHash({ ...project, reelScript: null } as never), evidence: [], gaps: [], fieldReports: [], nowMs: Date.parse("2026-10-27T22:00:00Z"),
    agentRequests: requests, folders: [{ key: "rawPhotos", label: "Raw Photos", url: "https://www.dropbox.com/home/raw-photos", count: 40 }, { key: "rawVideo", label: "Raw Video", url: "https://www.dropbox.com/home/raw-video", count: 12 }],
    dropboxConnected: true, rawBudget: { budget: 45, overage: 60 }, existingSongs: {},
    addOnRows: [], addedVideoTexts: {}, viewerName: "Harrison Wells",
    slots: { debrief: createElement("div", { "data-debrief": true }, "How did the shoot go?") },
    sharedShoot: { shared: false, me: { memberId: "m-h", name: "Harrison Wells" }, members: [{ memberId: "m-h", name: "Harrison Wells", via: "appointment" }], contributions: [], notes: [], floorISO: null, answers: { photos: null, video: null } },
    halfShot: [{ key: "d-video:1", number: 1, label: "Listing Video", waiting: false, finished: false }],
  };
  const P = Portal as any;

  try {
    // =====================================================================
    c.head("1 · The pure rules");
    // =====================================================================
    const l19 = lightInstructions(`EDITING NOTES\n${words(19)}`), l20 = lightInstructions(`EDITING NOTES\n${words(20)}`);
    c.ok("light: 19 of their own words is light, 20 is not (LIGHT_WORDS = 20)", LIGHT_WORDS === 20 && l19.light && l19.words === 19 && /^19 words of your own; aim for at least 20/.test(l19.why ?? "") && !l20.light && l20.why === null, l19.why ?? "");
    c.ok("light: headings, the STYLE / COLOR PROFILE / SONG lines and 'n/a' never count as words", ownWords("VISION FOR THE EDIT\nSTYLE: Cinematic\nCOLOR PROFILE: S-Log3\nSONG LINK: https://open.spotify.com/x\nn/a\nopen on the porch") === 4);
    const prem = lightInstructions(`SUMMARY\n${words(30)}`, { full: true });
    c.ok("light: a premium brief with no vision and no style is light whatever its length", prem.light && prem.why === "no vision for the edit and no style" && !lightInstructions(`STYLE: Cinematic\nSUMMARY\n${words(30)}`, { full: true }).light && !lightInstructions(`VISION FOR THE EDIT\n${words(30)}`, { full: true }).light);
    c.ok("light: the same brief without `full` is judged by its words only", !lightInstructions(`SUMMARY\n${words(30)}`).light);

    const song = (o: Partial<{ mode: "requested" | "none" | "unset"; title: string; link: string; start: string }>) => ({ mode: "requested" as const, title: "", link: "", start: "", ...o });
    c.ok("song: a requested song asks for its link only", songProblem(song({}), "the video") === "the song link for the video (or choose No request)" && songProblem(song({ link: "open.spotify.com/track/abc", start: "0:30" })) === null);
    c.ok("song: a title saved before Oct 27 still answers on its own (never re-asked)", songProblem(song({ title: "Good Days by LAKEY INSPIRED" })) === null);
    c.ok("song: a link that isn't a web address is named", /isn't a web address/.test(songProblem(song({ link: "the one from yesterday" })) ?? ""));
    const fieldHtml = renderToStaticMarkup(createElement(SongRequestField, { id: "s1", value: song({}), onChange() {} }));
    const legacyHtml = renderToStaticMarkup(createElement(SongRequestField, { id: "s2", value: song({ title: "Good Days" }), onChange() {} }));
    c.ok("song field: link and start only, no title box; an old title is shown read-only", /id="s1-link"/.test(fieldHtml) && /id="s1-start"/.test(fieldHtml) && !/id="s1-title"/.test(fieldHtml) && !/Song title/i.test(fieldHtml) && /data-song-saved-title/.test(legacyHtml) && /Good Days/.test(legacyHtml) && !/<input[^>]*value="Good Days"/.test(legacyHtml));

    const asWritten = joinTopicScriptNote("C0012 to C0015, second take", "as-written");
    const changed = joinTopicScriptNote("C0012", "changed", "She dropped\nthe rates stat");
    c.ok("topic script: the answer is the note's own last line, and splits back exactly", asWritten === `C0012 to C0015, second take\n${SCRIPT_AS_WRITTEN_LINE}` && JSON.stringify(splitTopicScriptNote(asWritten)) === JSON.stringify({ note: "C0012 to C0015, second take", choice: "as-written", changed: "" }) && changed === "C0012\nScript changed on site: She dropped the rates stat" && splitTopicScriptNote(changed).changed === "She dropped the rates stat", changed);
    c.ok("topic script: answering again replaces the answer (never two lines); no answer leaves the words alone", joinTopicScriptNote(asWritten, "changed", "x") === "C0012 to C0015, second take\nScript changed on site: x" && joinTopicScriptNote(asWritten, null) === "C0012 to C0015, second take" && splitTopicScriptNote("just clips").choice === null);
    const longNote = joinTopicScriptNote("a".repeat(2000), "as-written");
    c.ok("topic script: at the note's cap the answer is kept whole (the photographer's words give way)", longNote.length <= TOPIC_NOTE_CAP && longNote.endsWith(`\n${SCRIPT_AS_WRITTEN_LINE}`), String(longNote.length));
    c.ok("topic script: the problems, in the photographer's words", topicScriptProblem({ title: "Rates explained", choice: null, changed: "" }) === "confirm the script for “Rates explained” (filmed as written, or what changed on site)" && topicScriptProblem({ title: "Rates explained", choice: "changed", changed: " " }) === "what changed on site in the script for “Rates explained”" && topicScriptProblem({ title: "x", choice: "as-written", changed: "" }) === null);
    const t0 = { scriptTitle: "Rates explained", clientApproved: false, filmedConfirmedAtISO: null };
    c.ok("topic script: asked only for a ticked topic with an unapproved script nobody confirmed yet", asksScriptConfirm(t0, true) && !asksScriptConfirm(t0, false) && !asksScriptConfirm({ ...t0, clientApproved: true }, true) && !asksScriptConfirm({ ...t0, scriptTitle: null }, true) && !asksScriptConfirm({ ...t0, filmedConfirmedAtISO: "2026-10-20T15:00:00Z" }, true));

    const line = notDoneLine("Harrison Wells", "Open the reel on the deck view", "The deck was\nbeing rebuilt");
    const parsed = parseNotDoneLine(line);
    c.ok("not done on site: one line, read back onto its request", line === `Not done on site (Harrison Wells): "Open the reel on the deck view" Why: The deck was being rebuilt` && parsed?.by === "Harrison Wells" && parsed.why === "The deck was being rebuilt" && notDoneMatches({ text: "Open the reel on the deck view", original: "Open the reel on the deck view, please!" }, parsed.request) && !notDoneMatches({ text: "Mailbox fixed", original: "Mailbox fixed" }, parsed.request), line);

    const keyBefore = process.env.GOOGLE_MAPS_API_KEY;
    process.env.GOOGLE_MAPS_API_KEY = "drill-key";
    const loc = (u: string) => new URL(u).searchParams.get("location");
    const full = shootThumbCandidates({ coverImageUrl: "https://cdn.aryeo.com/listings/1/cover.jpg", lat: 39.995, lng: -75.164, addressLine: "2925 N 21st St", city: "Philadelphia", state: "PA", zip: "19132", title: "2925 N 21st St" });
    c.ok("My Shoots picture: the cover first, then Street View by the coordinates, the full address, the title", full.map((f) => f.kind).join(",") === "aryeo,street,street,street" && full[0].url === "https://cdn.aryeo.com/listings/1/cover.jpg" && loc(full[1].url) === "39.995,-75.164" && loc(full[2].url) === "2925 N 21st St, Philadelphia, PA 19132" && loc(full[3].url) === "2925 N 21st St", full.slice(1).map((f) => loc(f.url)).join(" | "));
    c.ok("…each Street View frame asks for an outdoor pano near the point, and a real miss (not a grey tile)", full.slice(1).every((f) => /radius=250/.test(f.url) && /source=outdoor/.test(f.url) && /return_error_code=true/.test(f.url)));
    const noCoords = shootThumbCandidates({ coverImageUrl: null, lat: 0, lng: 0, addressLine: "2925 N 21st St", city: null, state: null, zip: null, title: "2925 N 21st St" });
    c.ok("…0,0 is no coordinates; a street with no city is not tried twice (the title covers it)", noCoords.length === 1 && loc(noCoords[0].url) === "2925 N 21st St");
    const dedup = shootThumbCandidates({ coverImageUrl: "  ", lat: null, lng: null, addressLine: "2925 N 21st St", city: "Philadelphia", state: null, zip: null, title: "2925 N 21st St, Philadelphia" });
    c.ok("…the same frame is never tried twice, and a blank cover is no cover", dedup.length === 1 && dedup[0].kind === "street");
    delete process.env.GOOGLE_MAPS_API_KEY;
    const noKey = shootThumbCandidates({ coverImageUrl: "https://cdn.aryeo.com/c.jpg", lat: 39.9, lng: -75.1, addressLine: "2925 N 21st St", city: "Philadelphia", state: "PA", zip: null, title: "x" });
    c.ok("…with no Maps key only the cover is offered (never a broken Street View link)", noKey.length === 1 && noKey[0].kind === "aryeo");
    if (keyBefore === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = keyBefore;

    // =====================================================================
    c.head("2 · The top of the form");
    // =====================================================================
    const html = renderToStaticMarkup(createElement(P, base));
    const t = text(html);
    const from = html.indexOf('data-portal-card="agent-requests"');
    const marks = ['data-portal-card="agent-requests"', "Add a request the agent made on site", "Client preference or request", 'data-portal-card="from-the-shoot"', 'for="flag-a-problem"', "Something ordered wasn&#x27;t completed?", "How did the shoot go?", 'data-portal-card="capture"', 'data-portal-card="dropbox"', 'data-portal-card="submit"'];
    const at = marks.map((m) => html.indexOf(m, from));
    c.ok("agent requests (with the on-site add and the client preference) → From the shoot: Flag a problem → Something ordered wasn't completed? → How did the shoot go? → capture → Dropbox → submit", from >= 0 && at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])), at.join(","));
    c.ok("the client preference box is on the page once (the lower duplicate is gone)", (html.match(/Client preference or request/g) ?? []).length === 1);
    c.ok("no \"Report a problem\" fold under the submit, no \"Includes drone footage\" tick", !/Report a problem/i.test(t) && !/Includes drone footage/i.test(t) && !/data-video-drone/.test(html));
    c.ok("one \"I couldn’t fulfill this\" per open request (not on the one already marked, not on history)", (html.match(/I couldn’t fulfill this/g) ?? []).length === 2, String((html.match(/I couldn’t fulfill this/g) ?? []).length));
    const nd = html.slice(html.indexOf("data-request-not-done"));
    c.ok("a request marked as not done shows who, why, and where it went", (html.match(/data-request-not-done/g) ?? []).length === 1 && /Harrison Wells couldn't do this/.test(text(nd.slice(0, 900))) && /Why: It rained all afternoon/.test(text(nd.slice(0, 900))) && /Kyle has it on his follow-ups/.test(text(nd.slice(0, 900))));

    // =====================================================================
    c.head("3 · I couldn't fulfill this (the real component, fake actions)");
    // =====================================================================
    const arProps = { projectId: project.id, initial: requests as never, blocked: null as string | null, reviewed: false, onReviewed: () => {} };
    const notDoneOf = (id: string, props = arProps): Node => {
      const ar = mountHooks(() => AgentRequests(props));
      const row = nodes(ar.render(), (ty, p) => byName("Row")(ty) && p.r?.id === id)[0];
      const rm = mountHooks(() => (row.type as any)(row.props));
      const n = nodes(rm.render(), (ty) => byName("NotDone")(ty))[0];
      ar.stop(); rm.stop();
      return n;
    };
    const btn = (tree: unknown, label: string) => elements(tree, (ty, p) => ty === "button" && flat(p.children).includes(label))[0];
    const one = notDoneOf("ask:1");
    const m1 = mountHooks(() => (one.type as any)(one.props));
    let t1 = m1.render();
    (btn(t1, "I couldn’t fulfill this").onClick as () => void)();
    t1 = m1.render();
    const why = () => elements(m1.render(), (ty, p) => ty === "textarea" && p.id === "not-done-ask:1")[0];
    c.ok("tapping it asks why (required): the send stays off until a why is typed", !!why() && flat(t1).includes("Why couldn’t it be done?") && btn(t1, "Tell Kyle and the editor")?.disabled === true);
    (why().onChange as (e: unknown) => void)({ target: { value: "The deck was being rebuilt" } });
    t1 = m1.render();
    c.ok("…typed, it can be sent", btn(t1, "Tell Kyle and the editor")?.disabled === false);
    (btn(t1, "Tell Kyle and the editor").onClick as () => void)();
    await until(() => calls.some((x) => x.name === "markRequestNotFulfilled"));
    const sent = calls.find((x) => x.name === "markRequestNotFulfilled")!;
    c.ok("…it sends the request and the why (the server files the line and Kyle's follow-up)", sent.args[0] === project.id && JSON.stringify(sent.args[1]) === JSON.stringify({ requestId: "ask:1", why: "The deck was being rebuilt" }), JSON.stringify(sent.args));
    await until(() => flat(m1.render()).includes("Kyle has it on his follow-ups"));
    c.ok("…and says so on the page", !why());
    m1.stop();
    const two = notDoneOf("ask:2");
    const m2 = mountHooks(() => (two.type as any)(two.props));
    const t2 = m2.render();
    c.ok("a marked request: who, why, and Undo", flat(t2).includes("Harrison Wells couldn't do this") && flat(t2).includes("Why: It rained all afternoon") && !!btn(t2, "Undo"));
    (btn(t2, "Undo").onClick as () => void)();
    await until(() => calls.some((x) => x.name === "undoRequestNotFulfilled"));
    c.ok("…Undo takes it back", JSON.stringify(calls.find((x) => x.name === "undoRequestNotFulfilled")!.args) === JSON.stringify([project.id, { requestId: "ask:2" }]));
    m2.stop();
    const hist = notDoneOf("ask:3");
    c.ok("a history row never offers it", mountHooks(() => (hist.type as any)(hist.props)).render() === null);
    const blockedProps = { ...arProps, blocked: "Preview: nothing can be saved while viewing as someone else." };
    const b1 = notDoneOf("ask:1", blockedProps), b2 = notDoneOf("ask:2", blockedProps);
    c.ok("a preview (view as) offers neither the button nor Undo", mountHooks(() => (b1.type as any)(b1.props)).render() === null && !btn(mountHooks(() => (b2.type as any)(b2.props)).render(), "Undo"));

    // =====================================================================
    c.head("4 · Photo details");
    // =====================================================================
    const card = mountHooks(() => P(base));
    let tree = card.render();
    const tick = (k: string) => { const b = elements(card.render(), (ty, p) => ty === "button" && p["data-capture"] === k)[0]; (b.onClick as () => void)(); tree = card.render(); };
    tick("photos");
    const sq = elements(tree, (ty, p) => ty === "p" && "data-sqft-readonly" in p)[0];
    c.ok("the photographer reads the square footage from the order, beside the photo count; no box to change it", !!sq && /Square footage: 2,000-2,999 Sq\. Ft\. \(from the order\)/.test(flat(sq.children)) && !elements(tree, (ty, p) => ty === "input" && p.id === "sqft").length, flat(sq?.children));
    const office = mountHooks(() => P({ ...base, viewerIsOffice: true }));
    (elements(office.render(), (ty, p) => ty === "button" && p["data-capture"] === "photos")[0].onClick as () => void)();
    const ot = office.render();
    c.ok("the office still edits it", !!elements(ot, (ty, p) => ty === "input" && p.id === "sqft")[0] && !elements(ot, (ty, p) => ty === "p" && "data-sqft-readonly" in p).length);
    office.stop();
    const pt = flat(tree);
    const pi = ["Gallery order", "Anything to remove in editing? *", "Photo editor notes", "Photo standard"].map((s) => pt.indexOf(s));
    c.ok("gallery order → anything to remove (required *) → Photo editor notes → the photo standard", pi.every((v, i) => v >= 0 && (i === 0 || v > pi[i - 1])), pi.join(","));
    c.ok("removal is answered with \"Nothing to remove\" or the notes", !!elements(tree, (ty, p) => ty === "button" && p.role === "radio" && flat(p.children).includes("Nothing to remove"))[0] && pt.includes("Required."));
    const submitCard = elements(tree, (ty, p) => byName("PortalCard")(ty) && p.id === "submit")[0];
    c.ok("step 3 is just \"Submit\": the photo editor's notes moved up, no \"Additional editor notes\" box", submitCard?.title === "Submit" && !pt.includes("Additional editor notes") && pt.includes("Your notes for the photo editor are in Photo details above.") && !!elements(tree, (ty, p) => byName("AutoTextarea")(ty) && p.id === "photo-editor-notes")[0]);
    const videoOnly = mountHooks(() => P({ ...base, deliverables: base.deliverables.filter((d: Props) => d.type !== "PHOTOS"), policy: { ...base.policy, photosOrdered: false } }));
    const vt = flat(videoOnly.render());
    c.ok("a job with no photos keeps \"Additional editor notes\" in step 3", vt.includes("Additional editor notes") && !vt.includes("Photo editor notes"));
    videoOnly.stop();

    // =====================================================================
    c.head("5 · The submit names the floor plan and 3D tour ticks and the removal");
    // =====================================================================
    const submit = (label: string) => { (btn(card.render(), label).onClick as () => void)(); tree = card.render(); return errOf(tree); };
    const fpTick = () => elements(card.render(), (ty, p) => ty === "button" && p["data-upload-tick"] === "FLOORPLAN")[0];
    const tourTick = () => elements(card.render(), (ty, p) => ty === "button" && p["data-upload-tick"] === "MATTERPORT_3D")[0];
    c.ok("an ordered floor plan and 3D tour each have their own tick, required, without ticking them under capture", !!fpTick() && !!tourTick() && fpTick().role === "checkbox" && fpTick()["aria-checked"] === false && flat(fpTick().children).includes("Floor plan uploaded") && flat(tourTick().children).includes("3D tour uploaded") && flat(fpTick().children).includes("*"));
    let e = submit("Submit photos");
    c.ok("Submit photos names both ticks and the removal answer", e.includes("tick “Floor plan uploaded”") && e.includes("tick “3D tour uploaded”") && e.includes("answer “Anything to remove in editing?” (list it, or choose Nothing to remove)"), e.slice(0, 260));
    (fpTick().onClick as () => void)();
    await until(() => calls.some((x) => x.name === "markDeliverableUploaded"));
    c.ok("ticking the floor plan marks it uploaded (the same tick as the list at the top)", fpTick()["aria-checked"] === true && JSON.stringify(calls.find((x) => x.name === "markDeliverableUploaded")!.args) === JSON.stringify(["d-fp", true]));
    (btn(card.render(), "Nothing to remove").onClick as () => void)();
    e = submit("Submit photos");
    c.ok("…then the submit asks only for what is left (the tour)", !e.includes("Floor plan uploaded") && !e.includes("Anything to remove") && e.includes("3D tour uploaded"), e.slice(0, 200));

    // =====================================================================
    c.head("6 · Video: the KPI copy, the light hint, no Dropbox instructions, half shot");
    // =====================================================================
    tick("video");
    const notesBox = () => elements(card.render(), (ty, p) => byName("AutoTextarea")(ty) && /editor should know — order, must-show moments/.test(String(p.placeholder ?? "")))[0];
    c.ok("the warning says what it costs now: skipped or light instructions count against the KPI", flat(tree).includes("Skipped or light instructions count against your KPI.") && !/forfeit/i.test(strings(tree).join(" ")));
    c.ok("no light hint before anything is typed", !elements(tree, (ty, p) => "data-light-instructions" in p).length);
    (notesBox().onChange as (e: unknown) => void)({ target: { value: "Open on the porch" } });
    tree = card.render();
    const hint = elements(tree, (ty, p) => "data-light-instructions" in p)[0];
    c.ok("four words: \"These instructions are light\", with the KPI's own reason", !!hint && /These instructions are light: 4 words of your own; aim for at least 20: the flow, the must-show moments and anything to avoid\. Light instructions count against your KPI\./.test(flat(hint.children)), flat(hint?.children));
    (notesBox().onChange as (e: unknown) => void)({ target: { value: `Open on the porch, ${words(20)}` } });
    tree = card.render();
    c.ok("…twenty-four words: the hint goes", !elements(tree, (ty, p) => "data-light-instructions" in p).length);
    c.ok("no \"Instructions added to Dropbox\" anywhere", !strings(tree).some((s) => /Instructions added to Dropbox/i.test(s)) && !nodes(tree, (ty) => byName("DropboxInstructions")(ty)).length);
    const legacy = mountHooks(() => P({ ...base, project: { ...project, instructionsDropbox: { path: "/Jobs/2925/INSTRUCTIONS.txt", name: "INSTRUCTIONS.txt", atISO: "2026-10-20T15:00:00Z", by: "Harrison Wells" } } }));
    (elements(legacy.render(), (ty, p) => ty === "button" && p["data-capture"] === "video")[0].onClick as () => void)();
    const lt = legacy.render();
    const lp = elements(lt, (ty, p) => "data-dropbox-instructions-legacy" in p)[0];
    c.ok("an instructions file said before today is still read (who, which file), read-only", !!lp && /INSTRUCTIONS\.txt, said by Harrison Wells/.test(flat(lp.children)) && /New instructions go in the boxes below/.test(flat(lp.children)) && !nodes(lt, (ty) => byName("DropboxInstructions")(ty)).length);
    legacy.stop();

    const half = () => elements(card.render(), (ty, p) => ty === "input" && p["data-half-shot-key"] === "d-video:1")[0];
    c.ok("\"Video half shot: needs a second appointment\" is on the video", !!half() && half().checked === false && flat(tree).includes("Video half shot: needs a second appointment"));
    e = submit("Submit video");
    c.ok("before it: the video owes its color profile", e.includes("pick the color profile you shot in"), e.slice(0, 200));
    c.ok("the video half never asks for the floor plan or tour ticks (they go with the photos)", !e.includes("3D tour uploaded") && !e.includes("Floor plan uploaded"));
    (half().onChange as (e: unknown) => void)({ target: { checked: true } });
    await until(() => flat(card.render()).includes("Held for the next appointment"));
    tree = card.render();
    const hold = calls.find((x) => x.name === "setVideoHalfShot")!;
    c.ok("ticking it saves the hold at once (the office's \"waiting on a second shoot\")", JSON.stringify(hold.args) === JSON.stringify([project.id, { key: "d-video:1", on: true }]) && half().checked === true);
    c.ok("…and the video owes nothing here until its footage is in", flat(tree).includes("(not needed until its footage is in)") && !flat(tree).includes("can’t be left blank"));
    const rawBefore = calls.filter((x) => x.name === "checkUploadRawFiles").length;
    submit("Submit video");
    c.ok("…so Submit video goes straight to the review (nothing missing)", calls.filter((x) => x.name === "checkUploadRawFiles").length === rawBefore + 1 && calls.filter((x) => x.name === "checkUploadRawFiles").at(-1)!.args[1] === "video");
    answers.setVideoHalfShot = () => ({ ok: false, message: "This video was already released to the editors." });
    (half().onChange as (e: unknown) => void)({ target: { checked: false } });
    await until(() => flat(card.render()).includes("already released"));
    c.ok("a refused change puts the tick back, with the reason", half().checked === true && JSON.stringify(calls.filter((x) => x.name === "setVideoHalfShot").at(-1)!.args[1]) === JSON.stringify({ key: "d-video:1", on: false }));
    delete answers.setVideoHalfShot;
    const finished = renderToStaticMarkup(createElement(P, { ...base, halfShot: [{ ...base.halfShot[0], finished: true }] }));
    c.ok("a finished video has no half-shot tick; a content session (no halfShot) has none", !/data-half-shot/.test(finished) && !/data-half-shot/.test(renderToStaticMarkup(createElement(P, { ...base, halfShot: null }))));
    card.stop();

    // =====================================================================
    c.head("7 · Script not approved by the client yet (a content session)");
    // =====================================================================
    const topic = (id: string, title: string, o: Props = {}) => ({ topicId: id, title, pillarName: null, scriptTitle: title, clientApproved: false, filmedConfirmedAtISO: null, filmedConfirmedBy: null, confirmedOnProjectId: null, overflow: false, note: null, folder: null, ...o });
    const cs: Props = { ...project, id: "loom-session", title: "Dana Reyes · October content", packageName: "Full Day Content Shoot" };
    const draftPayload = { editorBrief: "", checks: { coverage: false, culling: false, quality: false, count: false }, removal: "", nothingToRemove: false, orderChoice: null, orderNotes: "", vidStyle: null, vidSections: {}, videosFilmed: "", filmedTopicIds: ["topicRates", "topicMarket", "topicBuyers"], topicNotes: {}, extraRows: [], scriptChoice: null, scriptText: "", scriptNote: "", captured: ["video"] };
    const csProps: Props = {
      ...base, project: cs, halfShot: null, agentRequests: [],
      deliverables: [{ id: "cs-video", type: "VIDEO", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null }],
      policy: { ...base.policy, photosOrdered: false, squareFeet: null, squareFeetBand: null, videoSpec: videoStepSpec(["Full Day Content Shoot"], { hasFullVideo: false, isMonthly: true }), videoStyle: "personal_branding" },
      sessionTopics: { owed: 4, bulk: null, pending: null, topics: [
        topic("topicRates", "Rates explained"),
        topic("topicMarket", "Market update", { clientApproved: true }),
        topic("topicTour", "Neighborhood tour", { filmedConfirmedAtISO: "2026-10-20T15:00:00Z", filmedConfirmedBy: "Kyle Smith", confirmedOnProjectId: "another-session" }),
        topic("topicBuyers", "First-time buyers", { filmedConfirmedAtISO: "2026-10-27T18:00:00Z", filmedConfirmedBy: "Kyle Smith", confirmedOnProjectId: "loom-session" }),
      ] },
      draft: { revision: 1, payload: draftPayload, savedAtISO: "2026-10-27T20:00:00Z", baseHash: null }, draftRevision: 1,
    };
    const callsBefore = calls.length;
    const sess = mountHooks(() => P(csProps));
    let st = sess.render();
    await new Promise((r) => setTimeout(r, 20));
    st = sess.render();
    const boxes = () => elements(sess.render(), (ty, p) => "data-topic-script-confirm" in p);
    c.ok("one ask, for the ticked topic whose script the client hasn't approved (not the approved one, not one filmed elsewhere, not one already confirmed)", boxes().length === 1 && flat(boxes()[0].children).includes("Script not approved by the client yet") && flat(boxes()[0].children).includes("“Rates explained”") && flat(st).includes("script not approved by the client yet"), String(boxes().length));
    const sSubmit = () => { (btn(sess.render(), "Submit my handoff").onClick as () => void)(); st = sess.render(); return errOf(st); };
    e = sSubmit();
    c.ok("the submit waits for the answer, by name", e.includes("confirm the script for “Rates explained” (filmed as written, or what changed on site)") && !e.includes("Market update") && !e.includes("Neighborhood tour") && !e.includes("First-time buyers"), e.slice(0, 240));
    const noteBox = () => elements(sess.render(), (ty, p) => byName("AutoTextarea")(ty) && p["aria-label"] === "Note for the editor about Rates explained")[0];
    (noteBox().onChange as (e: unknown) => void)({ target: { value: "C0012 to C0015, second take" } });
    (btn(sess.render(), "I filmed this script as written").onClick as () => void)();
    e = sSubmit();
    c.ok("\"I filmed this script as written\" answers it", !e.includes("Rates explained") && noteBox().value === "C0012 to C0015, second take", e.slice(0, 200));
    const asWrittenSaved = await settled(() => drafts.some((d) => (d.topicNotes as Props | undefined)?.topicRates === `C0012 to C0015, second take\n${SCRIPT_AS_WRITTEN_LINE}`));
    c.ok("…recorded on the upload: the topic note's last line (the note box still shows only their words)", asWrittenSaved, JSON.stringify((drafts.at(-1)?.topicNotes as Props | undefined)?.topicRates));
    (btn(sess.render(), "I changed it on site").onClick as () => void)();
    const changedBox = () => elements(sess.render(), (ty, p) => byName("AutoTextarea")(ty) && p["aria-label"] === "What changed on site in the script for Rates explained")[0];
    e = sSubmit();
    c.ok("\"I changed it on site\" asks what changed, and waits for it", !!changedBox() && e.includes("what changed on site in the script for “Rates explained”"), e.slice(0, 200));
    (changedBox().onChange as (e: unknown) => void)({ target: { value: "She dropped the rates stat" } });
    e = sSubmit();
    c.ok("…answered", !e.includes("Rates explained"));
    const changedSaved = await settled(() => drafts.some((d) => (d.topicNotes as Props | undefined)?.topicRates === "C0012 to C0015, second take\nScript changed on site: She dropped the rates stat"));
    c.ok("…recorded the same way: \"Script changed on site: …\" as the note's last line", changedSaved, JSON.stringify((drafts.at(-1)?.topicNotes as Props | undefined)?.topicRates));
    c.ok("…and the submit sends the topic notes as they are (the answer rides the filming report, cut at 1000 from the front)", /topicNotes: Object\.fromEntries\(\s*filmedTopicIds\.map\(\(id\) => \[id, \(topicNotes\[id\] \?\? ""\)\.trim\(\)\.slice\(0, 1000\)\]/.test(src("src/components/upload/UploadPortal.tsx")));
    c.ok("the script itself is never touched: no script action was called", !calls.slice(callsBefore).some((x) => /script/i.test(x.name)), calls.slice(callsBefore).map((x) => x.name).filter((n, i, a) => a.indexOf(n) === i).join(","));
    sess.stop();

    // =====================================================================
    c.head("8 · The server halves, read from source");
    // =====================================================================
    const actions = src("src/app/upload/actions.ts");
    c.ok("upload/actions: video 1 held for a second appointment is not gated (firstVideoGate), and the message names the KPI", /const firstVideoGate = wantsVideoGate && !firstWaiting;/.test(actions) && /if \(firstVideoGate && data\.videoInstructions !== undefined && !colorLine/.test(actions) && actions.includes("Video instructions are required: the flow and your vision for the edit. Skipped or light instructions count against your KPI.") && !/forfeit/i.test(actions));
    const shared = src("src/app/upload/sharedActions.ts");
    c.ok("sharedActions: the half-shot tick is the office's hold (markVideoWaitingOnShoot) and its undo, the request answer goes to requestNotFulfilled", /export async function setVideoHalfShot\(/.test(shared) && /ss\.markVideoWaitingOnShoot\(\{ projectId, key, note: HALF_SHOT_NOTE/.test(shared) && /ss\.clearVideoWaitingOnShoot\(/.test(shared) && /export async function markRequestNotFulfilled\(/.test(shared) && /requestNotFulfilled\(\{/.test(shared) && /export async function undoRequestNotFulfilled\(/.test(shared));
    c.ok("secondShoot: clearVideoWaitingOnShoot puts the video back on the queue", /export async function clearVideoWaitingOnShoot\(/.test(src("src/lib/secondShoot.ts")));
    c.ok("upload/[id]: the page passes each listing video's hold (halfShot)", /halfShot=\{halfShot\}/.test(src("src/app/upload/[id]/page.tsx")));
    c.ok("/upload: no \"Cull to the Photography SOP\" banner (the shoot screen keeps its compact one)", !/<CullingReminder/.test(src("src/app/upload/page.tsx")) && /<CullingReminder compact/.test(src("src/components/shoot/ShootScreen.tsx")));
    c.ok("projectStatus: a listing with no photos has no cover (Street View stays on the card)", /cover: \(l\.images\?\.length \?\? 0\) > 0 \?/.test(src("src/lib/projectStatus.ts")));
    c.ok("kpiEvidence: the KPI reads the same light rule as the page", /export const THIN_WORDS = LIGHT_WORDS;/.test(src("src/lib/kpiEvidence.ts")) && /lightInstructions\(r\.videoInstructions \?\? r\.editorBrief/.test(src("src/lib/kpiEvidence.ts")));
    const shoots = src("src/components/shoot/MyShootsView.tsx");
    c.ok("My Shoots: the card steps to the next frame on a miss and ends on a house tile, never blank", /onError=\{\(\) => setI\(\(n\) => n \+ 1\)\}/.test(shoots) && /data-thumb-placeholder/.test(shoots) && /thumbFallbacks: thumbs\.slice\(1\)/.test(src("src/lib/shoot.ts")));
    // The lines that carry the words added today: none has an em or en dash.
    const touched = ["src/components/upload/UploadPortal.tsx", "src/components/upload/AgentRequests.tsx", "src/components/upload/SongRequestField.tsx", "src/lib/topicScriptConfirm.ts", "src/lib/instructionsLight.ts", "src/app/upload/sharedActions.ts"].map(src).join("\n").split("\n");
    const phrases = ["I couldn&rsquo;t fulfill this", "Tell Kyle and the editor", "Why couldn&rsquo;t it be done?", "needs a second appointment", "These instructions are light", "Photo editor notes", "Script not approved by the client yet", "I filmed this script as written", "I changed it on site", "Flag a problem, say what", "Square footage:", "Held for the next appointment", "of your own; aim for at least", "Upload it, then tick it", "Nothing to remove", "The link is all the editor needs"];
    const dashed = phrases.filter((ph) => { const ls = touched.filter((l) => l.includes(ph)); return !ls.length || ls.some((l) => /[—–]/.test(l)); });
    c.ok("no em or en dash in the words added today (each found, none dashed)", dashed.length === 0, dashed.join(" | "));

    c.ok("the drill made no network call", fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.slice(0, 2).join(" | "));
  } finally {
    c.summary();
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
