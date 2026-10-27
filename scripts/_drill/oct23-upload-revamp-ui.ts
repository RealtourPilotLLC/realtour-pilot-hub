// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE UPLOAD PAGE REVAMP, ITS CLIENT HALF (Oct 23 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct23-upload-revamp-ui.ts
//
// The real UploadPortal and its new pieces, with every server action replaced
// in-process (nothing reaches a database, a provider or the network):
//   1. The order: agent requests → What did you capture? → Dropbox and the
//      details → instructions and submit, rendered for a phone (one column)
//      and a desktop (two columns at lg) from the same markup.
//   2. No uploader anywhere: no file input, no "Choose files", no drop zone.
//      The Dropbox buttons are plain links: opening one calls nothing and
//      marks nothing uploaded.
//   3. A hidden section keeps its values: untick Video, the box goes, the
//      words stay (on the page and in the draft); tick it again, they are back.
//   4. Shared mode: the banner, the roster card, my own submit button, the
//      shared instructions instead of the single note box.
//   5. The stale-save refusal on the page: "James changed this; here's
//      their version", their words shown, mine still in the box.
//   6. The song request per video; the agent-request add form's duplicate
//      answer.
// ---------------------------------------------------------------------------
import { createElement, isValidElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fenceFetch, makeChecker } from "./_harness";
import { videoStepSpec } from "../../src/lib/pipeline";
import { submittedFieldsHash } from "../../src/lib/uploadDraft";
import type { UploadPortal } from "../../src/components/upload/UploadPortal";

type Props = Record<string, unknown>;
function elements(tree: unknown, match: (type: unknown, props: Props) => boolean): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, match));
  if (!isValidElement<Props>(tree)) return [];
  return [...(match(tree.type, tree.props) ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, match))];
}
const byName = (name: string) => (t: unknown) => (typeof t === "string" ? t : (t as { name?: string })?.name) === name;
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((child) => contains(child, text));
  return isValidElement<Props>(tree) && contains(tree.props.children, text);
}
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
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return {
    render() { index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { const tree = render(); const run = effects; effects = []; run.forEach((e) => e()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } },
    stop() { cleanups.splice(0).forEach((fn) => fn()); },
  };
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&rsquo;|’/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

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
  const rec = (name: string, answer: (...a: unknown[]) => unknown) => async (...a: unknown[]) => { calls.push({ name, args: a }); return answer(...a); };
  const drafts: Props[] = [];
  put(req.resolve("../../src/app/upload/actions.ts"), new Proxy({ __esModule: true }, { get: (_t, k) => (k === "__esModule" ? true : k === "then" ? undefined : rec(String(k), () => ({ ok: true, message: "" }))) }));
  put(req.resolve("../../src/app/upload/draftActions.ts"), { saveUploadDraft: rec("saveUploadDraft", (_id, body) => { drafts.push((body as { payload: Props }).payload); return { ok: true, revision: drafts.length, savedAtISO: new Date().toISOString() }; }), discardUploadDraft: rec("discardUploadDraft", () => ({ ok: true })) });
  let editAnswer: unknown = null;
  put(req.resolve("../../src/app/upload/sharedActions.ts"), {
    saveMyCapture: rec("saveMyCapture", () => ({ ok: true, message: "Saved.", contribution: null })),
    markMyUploads: rec("markMyUploads", () => ({ ok: true, message: "Marked", ticks: {} })),
    submitMyPart: rec("submitMyPart", () => ({ ok: true, message: "Your part is submitted." })),
    addSharedInstruction: rec("addSharedInstruction", () => ({ ok: true, message: "Added." })),
    editSharedInstruction: rec("editSharedInstruction", () => editAnswer),
    removeSharedInstruction: rec("removeSharedInstruction", () => ({ ok: true, message: "Removed." })),
    addAgentRequest: rec("addAgentRequest", () => ({ ok: true, duplicate: true, message: "Already on the list (Order notes (Aryeo)): Please feature the backyard and pool." })),
    saveAddedVideo: rec("saveAddedVideo", () => ({ ok: true, message: "Saved." })),
  });
  for (const f of ["../../src/app/upload/crewActions.ts", "../../src/app/upload/additionalShoots.ts"]) {
    try { req.resolve(f); } catch { /* not every file exists */ }
  }

  const { UploadPortal: Portal } = await import("@/components/upload/UploadPortal");
  const { SharedNoteRow } = await import("@/components/upload/SharedShoot");
  const { AgentRequests } = await import("@/components/upload/AgentRequests");

  const project = { id: "upload-revamp-ui", title: "2865 Greenleaf Ct, Malvern, PA", addressLine: "2865 Greenleaf Ct", city: "Malvern", state: "PA", zip: null, packageName: "Photos + Reel", shootDate: "2026-10-23T14:00:00Z", status: "SCHEDULED", editorBrief: null, uploadedAt: null, debriefSubmittedAt: null, photosHandoffAt: null, photosHandoffBy: null, videoHandoffAt: null, videoHandoffBy: null, editorPdfPath: null, clientName: "Georgiana Torrella", clientAvatarUrl: null, customerNote: null, photographerName: "Harrison Wells", cullingConfirmedAt: null, shotOrderNotes: null, removalNotes: null, videoInstructions: null, videosFilmed: null, scriptConfirmedAt: null, scriptConfirmNote: null };
  const requests = [
    { id: "order:1", text: "Please feature the backyard and pool.", original: "Please feature the backyard and pool.", source: "order_note", sourceWords: "Order notes (Aryeo)", atISO: null, group: "visit", medium: null, link: { href: "/shoot/upload-revamp-ui", label: "Open the order on the shoot screen" } },
    { id: "ask:1", text: "Avoid the unfinished garage", original: "Avoid the unfinished garage, it's a mess right now", source: "client_ask", sourceWords: "Text from Georgiana Torrella", atISO: "2026-10-22T15:00:00Z", group: "visit", medium: "both", link: null },
    { id: "ask:2", text: "Mailbox fixed", original: "Mailbox fixed", source: "client_ask", sourceWords: "Text from Georgiana Torrella", atISO: "2026-10-01T15:00:00Z", group: "history", medium: null, link: null, closedWords: "Confirmed by Kyle" },
  ];
  const folders = [
    { key: "rawPhotos", label: "Raw Photos", url: "https://www.dropbox.com/home/raw-photos", count: 42 },
    { key: "rawVideo", label: "Raw Video", url: "https://www.dropbox.com/home/raw-video", count: 0 },
    { key: "backupPhotos", label: "Backup Photos", url: "https://www.dropbox.com/home/backup", count: 3 },
    { key: "finalPhotos", label: "Final Photos", url: "https://www.dropbox.com/home/final", count: 0 },
  ];
  const base: ComponentProps<typeof UploadPortal> = {
    project,
    deliverables: [
      { id: "d-photos", type: "PHOTOS", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
      { id: "d-drone", type: "DRONE", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
      { id: "d-reel", type: "SOCIAL_REEL", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null },
    ],
    specialRequests: ["Avoid the unfinished garage"], flags: [],
    policy: { photosOrdered: true, videoOrdered: true, photoTarget: 40, range: { low: 35, high: 45, upper: 50 }, rangeMode: "sop", squareFeet: 2400, squareFeetBand: null, videoSpec: videoStepSpec(["Standard Reel"], { hasFullVideo: false }), videoStyle: "standard_cinematic", isPremium: false },
    script: null, foldersSlot: null, handoffFolders: [], submission: { submittedBy: null, lastEdited: null, addOns: [], files: [] },
    viewerIsOffice: false, payGateFromMs: Date.parse("2026-09-02"), sessionTopics: null, draft: null, draftRevision: null, canSaveDraft: true,
    baseHash: submittedFieldsHash({ ...project, reelScript: null }), evidence: [], gaps: [], fieldReports: [], nowMs: Date.parse("2026-10-23T22:00:00Z"),
    agentRequests: requests as never, folders, dropboxConnected: true, rawBudget: { budget: 60, overage: 80 }, existingSongs: { job: ["Client asked for: Sweet Home Alabama (Georgiana, by text, Oct 21)"] },
    addOnRows: [], addedVideoTexts: {}, slots: {}, viewerName: "Harrison Wells",
    sharedShoot: { shared: false, me: { memberId: "m-h", name: "Harrison Wells" }, members: [{ memberId: "m-h", name: "Harrison Wells", via: "appointment" }], contributions: [], notes: [], floorISO: null, answers: { photos: null, video: null } },
  };

  try {
    // =====================================================================
    c.head("1 · The order, on a phone and on a desktop");
    // =====================================================================
    const html = renderToStaticMarkup(createElement(Portal, base));
    const t = text(html);
    const at = (s: string) => t.indexOf(s);
    c.ok("agent requests first, then What did you capture?, then Dropbox, then notes and submit", at("Agent requests") >= 0 && at("Agent requests") < at("What did you capture?") && at("What did you capture?") < at("Upload to Dropbox") && at("Upload to Dropbox") < at("Notes & submit"), [at("Agent requests"), at("What did you capture?"), at("Upload to Dropbox"), at("Notes & submit")].join(","));
    c.ok("each request with its source, the original one tap away; history folded apart", /From: Order notes \(Aryeo\)/.test(t) && /From: Text from Georgiana Torrella/.test(t) && /Open the original/.test(t) && /Earlier and already handled/.test(t));
    c.ok("the special requests are in the requests card, not the heads-up card", !/special request/i.test(t.slice(0, Math.max(0, at("Agent requests")))));
    c.ok("what was ordered, said plainly; the five services offered", /Ordered: Photos \+ Drone photos \+ Video/.test(t) && ["Photos", "Drone photos", "Video", "Floor plan", "3D tour"].every((s) => html.includes(`>${s}</span>`)));
    c.ok("nothing is pre-ticked because it was ordered", !/aria-checked="true" data-capture/.test(html) && !/data-capture="[a-z]+"[^>]*aria-checked="true"/.test(html));
    c.ok("an ordered service not ticked shows as pending, with a way to say why", (html.match(/data-unchecked=/g) ?? []).length === 3 && /Pending: tick it if you shot it, or say why it wasn't completed/.test(t) && /Something ordered wasn't completed\?/.test(t));
    c.ok("phone: ONE column (no columns below lg); desktop: the side rail at lg", /class="grid gap-4 lg:grid-cols-\[minmax\(0,1fr\)_19rem\] lg:items-start"/.test(html) && !/class="[^"]*(?<![a-z]:)grid-cols-\[/.test(html.replace(/lg:grid-cols-\[[^\]]+\]/g, "")));
    c.ok("phone: the handoff summary comes before the steps (the rail is first in the markup, moved to the right column at lg)", html.indexOf("data-handoff-summary") < html.indexOf('data-portal-card="agent-requests"') && /lg:col-start-2 lg:row-start-1/.test(html));
    const wide = [...html.matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)].filter((m) => Number(m[1]) > 360);
    c.ok("nothing is wider than a phone (no fixed widths past 360px)", wide.length === 0, wide.map((m) => m[0]).join(","));
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"/g)].map((m) => m[1]);
    const small = buttons.filter((cl) => !/min-h-1[14]|size-11|min-h-14/.test(cl));
    c.ok("every button in the new layout is a phone-sized target (44px+)", small.length === 0, `${small.length} of ${buttons.length}: ${small.slice(0, 3).join(" | ")}`);
    const sources = ["src/components/upload/portalUi.tsx", "src/components/upload/AgentRequests.tsx", "src/components/upload/SharedShoot.tsx", "src/components/upload/SongRequestField.tsx"].map((f) => fs.readFileSync(path.join(__dirname, "../..", f), "utf8")).join("\n");
    c.ok("light and dark: the new pieces use the theme tokens only (no hard-coded colours)", !/#[0-9a-fA-F]{3,6}\b/.test(sources.replace(/https?:\/\/\S+/g, "")) && !/\b(?:bg|text|border)-(?:white|black|gray|slate|zinc|neutral)\b/.test(sources));

    // =====================================================================
    c.head("2 · No uploader; Dropbox buttons are only links");
    // =====================================================================
    c.ok("no file input, no Choose files, no drop zone anywhere on the page", !/type="file"/.test(html) && !/Choose files/i.test(t) && !/drag and drop|drop files/i.test(t));
    c.ok("one Open in Dropbox button per folder you use (never the editors' Final folders)", (html.match(/data-open-dropbox=/g) ?? []).length === 3 && !html.includes("dropbox.com/home/final"));
    const card = mountHooks(() => Portal(base));
    let tree = card.render();
    const links = elements(tree, (ty, p) => ty === "a" && !!p["data-open-dropbox"]);
    c.ok("…each a plain link that opens Dropbox in a new tab, with no click handler", links.length === 3 && links.every((p) => p.target === "_blank" && !p.onClick && String(p.href).startsWith("https://www.dropbox.com/")));
    c.ok("…so opening one calls no action and marks nothing uploaded", calls.length === 0 && !/Uploaded/.test(JSON.stringify(elements(tree, (ty) => ty === "span").map((p) => p.children))));

    // =====================================================================
    c.head("3 · Ticking what you captured; a hidden section keeps its values");
    // =====================================================================
    const tick = (k: string) => { const b = elements(card.render(), (ty, p) => ty === "button" && p["data-capture"] === k)[0]; (b.onClick as () => void)(); tree = card.render(); };
    tick("video");
    const notesBox = () => elements(tree, (ty, p) => byName("AutoTextarea")(ty) && /flow, the must-show moments|Anything the editor should know|editor should know/i.test(String(p.placeholder ?? "")) || (byName("AutoTextarea")(ty) && String(p.placeholder ?? "").startsWith("Anything the editor should know")))[0];
    const editBox = () => elements(tree, (ty, p) => byName("AutoTextarea")(ty) && p.value !== undefined && /editor should know — order, must-show moments/.test(String(p.placeholder ?? "")))[0] ?? notesBox();
    c.ok("ticking Video shows its details", !!elements(tree, (ty, p) => ty === "section" && p["data-service-section"] === "video")[0] && !!editBox());
    (editBox().onChange as (e: { target: { value: string } }) => void)({ target: { value: "Open on the front walk, quick cuts." } });
    tree = card.render();
    tick("video");
    c.ok("unticking Video hides its section", !elements(tree, (ty, p) => ty === "section" && p["data-service-section"] === "video")[0]);
    await until(() => drafts.some((d) => (d.vidSections as Props | undefined)?.editNotes === "Open on the front walk, quick cuts."));
    const last = drafts[drafts.length - 1];
    c.ok("…but the words are kept: the draft still carries them while hidden", (last.vidSections as Props).editNotes === "Open on the front walk, quick cuts." && Array.isArray(last.captured) && !(last.captured as string[]).includes("video"), JSON.stringify(last.captured));
    tick("video");
    c.ok("ticking it again brings them back, word for word", editBox()?.value === "Open on the front walk, quick cuts.");
    tick("photos");
    c.ok("Photos shows its details: gallery order, the standard, removal, and (Oct 27 2026, Jordan) the order's square footage READ-ONLY beside the photo count, no size box for the photographer", !!elements(tree, (ty, p) => ty === "section" && p["data-service-section"] === "photos")[0] && contains(tree, "Gallery order") && contains(tree, "Anything to remove in editing?") && !elements(tree, (ty, p) => ty === "input" && p.id === "sqft")[0] && elements(tree, (ty, p) => ty === "p" && "data-sqft-readonly" in p).some((p) => contains(p.children, "2,400 sq ft")));
    const songField = elements(tree, (ty) => byName("SongRequestField")(ty))[0];
    c.ok("the video's song request is on the page, with what is already on file shown", !!songField && songField.id === "song-video-1" && JSON.stringify(songField.existing).includes("Sweet Home Alabama"));
    (songField.onChange as (s: unknown) => void)({ mode: "requested", title: "", link: "", start: "" });
    tree = card.render();
    const { missingNow } = { missingNow: () => { const b = elements(card.render(), (ty, p) => ty === "button" && contains(p.children, "Submit my handoff"))[0] ?? elements(card.render(), (ty, p) => ty === "button" && contains(p.children, "Submit video"))[0]; (b.onClick as () => void)(); tree = card.render(); } };
    missingNow();
    await until(() => contains(card.render(), "Not done yet"));
    tree = card.render();
    c.ok("a requested song with no link holds the submit, in plain words (Oct 27 2026: the link is all it asks for)", JSON.stringify(elements(tree, (ty) => ty === "div").map((p) => p.children)).includes("the song link for the video"));
    card.stop();

    // =====================================================================
    c.head("4 · Shared mode");
    // =====================================================================
    const sharedProps: ComponentProps<typeof UploadPortal> = {
      ...base,
      sharedShoot: {
        shared: true,
        me: { memberId: "m-h", name: "Harrison Wells" },
        members: [{ memberId: "m-j", name: "James Livingston", via: "appointment" }, { memberId: "m-h", name: "Harrison Wells", via: "appointment" }],
        contributions: [
          { memberId: "m-j", name: "James Livingston", captured: ["photos", "floorplan", "tour"], videoDrone: false, uploaded: ["photos"], submits: [{ scope: "photos", atISO: "2026-10-23T20:15:00Z", services: ["photos", "floorplan", "tour"] }], version: 3, updatedAtISO: "2026-10-23T20:15:00Z" },
          { memberId: "m-h", name: "Harrison Wells", captured: ["video"], videoDrone: true, uploaded: [], submits: [], version: 1, updatedAtISO: "2026-10-23T19:00:00Z" },
        ],
        notes: [{ entryId: "e1", version: 1, text: "Use the wide patio shot before the pool close-ups.", authorName: "James Livingston", authorKey: "m-j", createdAtISO: "2026-10-23T20:15:00Z", lastByName: "James Livingston", lastByKey: "m-j", lastAtISO: "2026-10-23T20:15:00Z", deleted: false, history: [{ entryId: "e1", version: 1, text: "Use the wide patio shot before the pool close-ups.", byName: "James Livingston", byKey: "m-j", atISO: "2026-10-23T20:15:00Z", deleted: false }] }],
        floorISO: null,
        answers: { photos: { handedOffBy: "James Livingston", atISO: "2026-10-23T20:15:00Z", lines: ["Gallery order: front to back", "Remove in editing: nothing"] }, video: null },
      },
      project: { ...project, photosHandoffAt: "2026-10-23T20:15:00Z", photosHandoffBy: "James Livingston", editorBrief: "Office note: the agent prefers warm tones." },
    };
    const sHtml = renderToStaticMarkup(createElement(Portal, sharedProps));
    const st = text(sHtml);
    c.ok("the banner: 2 photographers assigned, a shared shoot, whose page this is", /2 photographers assigned · Shared shoot/.test(st) && /Your page: Harrison Wells/.test(st));
    c.ok("the roster: James submitted, Harrison in progress, each with what they captured", /James Livingston[^]*Photos, Floor plan, 3D tour[^]*Submitted/.test(st) && /Harrison Wells · you[^]*Video \(with drone footage\)[^]*In progress/.test(st));
    c.ok("James's contribution can be opened from Harrison's page", /View James's contribution/.test(st));
    c.ok("ordered work James did reads as done by him, not pending", /Photos[^]*Done by James Livingston \(submitted\)/.test(st));
    c.ok("my own submit: only my video (the job owes photos and video; the photos are James's)", /Submit my video/.test(st) && !/Submit photos/.test(st));
    c.ok("the shared instructions with their author, Edit and Add to this; the job's existing note kept, read-only", /Shared instructions for the editor/.test(st) && /James Livingston · saved/.test(st) && /Add to this/.test(st) && /Already on the job for the editor/.test(st) && /warm tones/.test(st) && !/Additional editor notes/.test(st));
    c.ok("the combined-brief promise under the button", /The editor receives one combined brief\. James's part stays recorded as it is\./.test(st));

    // =====================================================================
    c.head("5 · The stale save, on the page");
    // =====================================================================
    const note = sharedProps.sharedShoot!.notes[0];
    let saved: unknown = null;
    const row = mountHooks(() => SharedNoteRow({ projectId: project.id, note, onSaved: (n) => { saved = n; }, viewerName: "Harrison Wells", handoffISO: "2026-10-23T19:00:00Z", blocked: false }));
    let rt = row.render();
    (elements(rt, (ty, p) => ty === "button" && contains(p.children, "Edit"))[0].onClick as () => void)();
    rt = row.render();
    (elements(rt, (ty) => ty === "textarea")[0].onChange as (e: { target: { value: string } }) => void)({ target: { value: "Pool close-ups first." } });
    editAnswer = { ok: false, message: "James Livingston changed this; here's their version. Nothing was saved; your words are still in the box.", current: { ...note, version: 2, text: "Use the wide patio shot first, then the pool at dusk.", lastByName: "James Livingston", lastAtISO: "2026-10-23T21:00:00Z", history: [...note.history, { ...note.history[0], version: 2, text: "Use the wide patio shot first, then the pool at dusk." }] } };
    rt = row.render();
    (elements(rt, (ty, p) => ty === "button" && contains(p.children, "Save"))[0].onClick as () => void)();
    await until(() => contains(row.render(), "changed this; here"));
    rt = row.render();
    const flat = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : isValidElement<Props>(n) ? flat(n.props.children) : "";
    c.ok("refused with \"James changed this; here's their version\", and his words shown", /James Livingston changed this; here’s their version/.test(flat(rt)) && flat(rt).includes("Use the wide patio shot first, then the pool at dusk."), flat(rt).slice(0, 200));
    c.ok("…my words are still in the box, and the next save goes against his version", elements(rt, (ty) => ty === "textarea")[0].value === "Pool close-ups first." && (calls.filter((x) => x.name === "editSharedInstruction").at(-1)?.args[2] === 1) && (saved as { version?: number } | null)?.version === 2);
    row.stop();

    // =====================================================================
    c.head("6 · The request add form: never filed twice");
    // =====================================================================
    const ar = mountHooks(() => AgentRequests({ projectId: project.id, initial: requests as never, blocked: null, reviewed: false, onReviewed: () => {} }));
    let atree = ar.render();
    (elements(atree, (ty, p) => ty === "button" && contains(p.children, "Add a request the agent made on site"))[0].onClick as () => void)();
    atree = ar.render();
    (elements(atree, (ty) => ty === "textarea")[0].onChange as (e: { target: { value: string } }) => void)({ target: { value: "please feature the backyard and pool" } });
    atree = ar.render();
    (elements(atree, (ty, p) => ty === "button" && contains(p.children, "Add request"))[0].onClick as () => void)();
    await until(() => contains(ar.render(), "Already on the list"));
    c.ok("the same words as an order note come back as \"already on the list\", with where", contains(ar.render(), "Already on the list (Order notes (Aryeo))"));
    ar.stop();

    // =====================================================================
    c.head("7 · Audit fixes (Oct 23 2026)");
    // =====================================================================
    const twoMembers = [{ memberId: "m-j", name: "James Livingston", via: "appointment" }, { memberId: "m-h", name: "Harrison Wells", via: "appointment" }];
    // A shared shoot handed off on the page before the revamp: nobody has a part on file.
    const legacyProps: ComponentProps<typeof UploadPortal> = {
      ...base,
      project: { ...project, debriefSubmittedAt: "2026-10-10T17:15:00Z", photosHandoffAt: "2026-10-03T13:28:00Z", videoHandoffAt: "2026-10-10T17:15:00Z" },
      sharedShoot: { shared: true, me: { memberId: "m-h", name: "Harrison Wells" }, members: twoMembers, contributions: [], notes: [], floorISO: null, answers: { photos: null, video: null }, visits: { "m-j": "2026-10-02T15:00:00Z", "m-h": "2026-10-07T18:30:00Z" } },
    };
    const lt = text(renderToStaticMarkup(createElement(Portal, legacyProps)));
    c.ok("a shared shoot submitted before the revamp reads as submitted, not an open form with nothing ticked", /Submitted — you're good to go/.test(lt) && !/Submit my /.test(lt) && /Handed off on the job's page/.test(lt) && !/Not started/.test(lt), lt.slice(0, 240));
    c.ok("…and the agent's requests stay on the submitted page", /Agent requests/.test(lt) && /From: Order notes \(Aryeo\)/.test(lt));
    // The job's wrap-up came BEFORE Harrison's own visit: it was someone else's.
    const laterVisit = text(renderToStaticMarkup(createElement(Portal, { ...legacyProps, sharedShoot: { ...legacyProps.sharedShoot!, visits: { "m-j": "2026-10-02T15:00:00Z", "m-h": "2026-10-23T14:00:00Z" } } })));
    c.ok("a wrap-up made before my own visit leaves my page open", /Submit my /.test(laterVisit) && !/Submitted — you're good to go/.test(laterVisit));
    // A job that owes no photo or video half: the normal whole-page submit, never a part nobody can finish.
    const fpProps: ComponentProps<typeof UploadPortal> = {
      ...base,
      deliverables: [{ id: "d-fp", type: "FLOORPLAN", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null }, { id: "d-3d", type: "MATTERPORT_3D", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null }],
      policy: { ...base.policy, photosOrdered: false, videoOrdered: false },
      sharedShoot: { shared: true, me: { memberId: "m-h", name: "Harrison Wells" }, members: twoMembers, contributions: [{ memberId: "m-h", name: "Harrison Wells", captured: ["floorplan"], videoDrone: false, uploaded: [], submits: [], version: 1, updatedAtISO: "2026-10-23T19:00:00Z" }], notes: [], floorISO: null, answers: { photos: null, video: null } },
    };
    const fpt = text(renderToStaticMarkup(createElement(Portal, fpProps)));
    c.ok("a floor-plan-and-tour job hands off with the normal submit (a part alone could never finish it)", /Submit my handoff/.test(fpt) && !/Submit my floor plan/.test(fpt), (fpt.match(/Submit my [a-z ]+/) ?? [""])[0]);
    // James's page: his photos are in, the video is Harrison's.
    const jamesProps: ComponentProps<typeof UploadPortal> = {
      ...sharedProps,
      sharedShoot: { ...sharedProps.sharedShoot!, me: { memberId: "m-j", name: "James Livingston" } },
      project: { ...sharedProps.project, photosHandoffAt: "2026-10-23T12:15:00Z" },
    };
    const jt = text(renderToStaticMarkup(createElement(Portal, jamesProps)));
    c.ok("the photos photographer is not told the video is late (it is Harrison's)", !/Video still owed|Video overdue/.test(jt));
    const ht = text(renderToStaticMarkup(createElement(Portal, { ...sharedProps, project: { ...sharedProps.project, photosHandoffAt: "2026-10-23T12:15:00Z" } })));
    c.ok("…the video photographer still is", /Video still owed|Video overdue/.test(ht));
    // The office on a shared page still corrects the job's own note.
    const ot = text(renderToStaticMarkup(createElement(Portal, { ...sharedProps, viewerIsOffice: true, sharedShoot: { ...sharedProps.sharedShoot!, me: null } })));
    c.ok("the office edits the job's note for the editor on a shared page", /The job's note for the editor \(office\)/.test(ot));
    // A video added on site: nothing marked required while it waits for the order.
    // (Harrison's own part says he captured video, so its section is open.)
    const addedProps: ComponentProps<typeof UploadPortal> = { ...sharedProps, addOnRows: [{ id: "t-add", item: "Extra video", note: null, addedBy: "Harrison Wells", addedAtISO: "2026-10-23T19:00:00Z", handled: false }] };
    const addHtml = renderToStaticMarkup(createElement(Portal, addedProps));
    const addSection = addHtml.slice(addHtml.indexOf("data-later-video=\"added:t-add\""));
    c.ok("a video added on site gets its own area, nothing in it marked required", addHtml.includes("data-later-video=\"added:t-add\"") && !/text-danger">\*/.test(addSection.slice(0, 4000)) && !/Intro script/.test(text(addSection.slice(0, 4000))), text(addSection.slice(0, 400)));

    c.ok("the UI drill made no network call and no database call", fence.blocked.length === 0 && fence.faked.length === 0);
  } finally {
    c.summary();
    fence.restore();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
