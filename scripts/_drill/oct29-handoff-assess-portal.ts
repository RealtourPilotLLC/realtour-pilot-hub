// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: THE JAMES CALL, OCT 29 2026 (three of its asks).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct29-handoff-assess-portal.ts
//
//   1. "Harrison's editor notes could amount to 'standard edit'": the pure
//      rule (lib/editingDirection) on the briefs that really reached the
//      editors ("Standard edit", "N/A", "None", "Cinematic", "Standard fast
//      paced premium reel", "Same as previous videos for John") and on real
//      direction; tapped starters left empty; scripts never count.
//   2. The upload page (the real UploadPortal, every action faked): one-tap
//      starters under the required box, "Standard edit" said under the box
//      and in the submit's list, real words clear it, and a plain social reel
//      (Jordan, Sep 1: no notes needed) is never asked.
//   3. The server gate, read from source: the same rule inside the first
//      video's gate (not on an agent-intro reel's notes) and on a later
//      video's vision; the files are never held.
//   4. "Start another assessment" on the readiness tile and inside an open
//      assessment (the real PanelBody), never in a read-only preview.
//   5. The portal: the creative manager may LOOK (the preview page); making
//      or copying the client's link stays the owner's and the office's.
// ISOLATION: no database, no provider, no network (fenced).
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fenceFetch, makeChecker } from "./_harness";
import { videoStepSpec, specForStyle } from "../../src/lib/pipeline";
import { submittedFieldsHash } from "../../src/lib/uploadDraft";
import { DIRECTION_PROMPTS, SESSION_DIRECTION_PROMPTS, SPECIFIC_WORDS_NEEDED, directionText, editingDirectionProblem, specificWords, withStarter } from "../../src/lib/editingDirection";
import { canOpenPortal, canPreviewPortal, canViewPortal, resolveStaffTab } from "../../src/lib/contentNav";

type Props = Record<string, any>;
type Node = { type: unknown; props: Props };
function nodes(tree: unknown, match: (type: unknown, props: Props) => boolean): Node[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => nodes(part, match));
  if (!isValidElement<Props>(tree)) return [];
  return [...(match(tree.type, tree.props) ? [{ type: tree.type, props: tree.props }] : []), ...Object.values(tree.props).flatMap((part) => nodes(part, match))];
}
const elements = (tree: unknown, match: (type: unknown, props: Props) => boolean) => nodes(tree, match).map((n) => n.props);
const byName = (name: string) => (t: unknown) => (typeof t === "string" ? t : (t as { name?: string })?.name) === name;
const flat = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(flat).join("") : isValidElement<Props>(n) ? flat(n.props.children) : "";
function strings(tree: unknown, out: string[] = []): string[] {
  if (typeof tree === "string") out.push(tree);
  else if (Array.isArray(tree)) tree.forEach((x) => strings(x, out));
  else if (isValidElement<Props>(tree)) Object.values(tree.props).forEach((v) => strings(v, out));
  return out;
}
const errOf = (tree: unknown) => strings(tree).find((s) => s.startsWith("Not done yet")) ?? "";
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
const REPO = path.join(__dirname, "../..");
const src = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const storage = new Map<string, string>();
  const local = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); }, removeItem: (k: string) => { storage.delete(k); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: local, scrollTo() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {}, getElementById: () => null } });
  const nav = req.resolve("next/navigation"); req.cache[nav] = { id: nav, filename: nav, loaded: true, exports: { useRouter: () => ({ refresh() {}, push() {}, replace() {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() } } as NodeModule;
  const put = (file: string, exports: unknown) => { req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const calls: { name: string; args: unknown[] }[] = [];
  const fake = (defaults: Record<string, (...a: unknown[]) => unknown> = {}) => new Proxy({ __esModule: true }, {
    get: (_t, k) => (k === "__esModule" ? true : k === "then" || typeof k === "symbol" ? undefined : async (...a: unknown[]) => {
      calls.push({ name: String(k), args: a });
      const answer = defaults[String(k)];
      return answer ? answer(...a) : { ok: true, message: "" };
    }),
  });
  put(req.resolve("../../src/app/upload/actions.ts"), fake());
  put(req.resolve("../../src/app/upload/draftActions.ts"), fake({ saveUploadDraft: () => ({ ok: true, revision: 1, savedAtISO: new Date().toISOString() }) }));
  put(req.resolve("../../src/app/upload/sharedActions.ts"), fake({ saveMyCapture: () => ({ ok: true, message: "Saved.", contribution: null }), markMyUploads: () => ({ ok: true, message: "Marked", ticks: {} }) }));
  put(req.resolve("../../src/app/creativeDeskActions.ts"), fake());
  put(req.resolve("../../src/app/delegation/actions.ts"), fake());
  put(req.resolve("../../src/app/review/actions.ts"), fake());

  try {
    // =====================================================================
    c.head("1 · The rule: words that say something about this edit");
    // =====================================================================
    const live = [
      "COLOR PROFILE: iPhone\n\nEDITING NOTES\nStandard edit",
      "STYLE: Fast-Paced\nCOLOR PROFILE: S-Log3\n\nVISION FOR THE EDIT\nStandard fast paced premium reel",
      "STYLE: Timeless & Elegant (Cinematic)\nCOLOR PROFILE: S-Log3, D-LogM\n\nVISION FOR THE EDIT\nN/A",
      "COLOR PROFILE: iPhone\n\nEDITING NOTES\nNone",
      "COLOR PROFILE: iPhone\n\nEDITING NOTES\nCinematic",
      "STYLE: Personal Branding\nCOLOR PROFILE: S-Log3\nSONG REQUEST: No request\n\nVISION FOR THE EDIT\nSame as previous videos for John",
    ];
    c.ok("one word of substance is not enough (“Cinematic, slow”)", !!editingDirectionProblem("EDITING NOTES\nCinematic, slow") && !!editingDirectionProblem("VISION FOR THE EDIT\nSame as usual for John"));
    c.ok("every boilerplate brief that reached the editors in the last 45 days is refused", live.every((t) => !!editingDirectionProblem(t)), live.filter((t) => !editingDirectionProblem(t)).join(" | "));
    c.ok("…and the photographer is told what was typed, kindly, and what to add", editingDirectionProblem(live[0]) === "“Standard edit” doesn't tell the editor much. Add what to feature, your best clips or rooms, anything to avoid, and when the agent is on camera.", editingDirectionProblem(live[0]) ?? "");
    const real = [
      "EDITING NOTES\nShow the kitchen and pool",
      "VISION FOR THE EDIT\nFollow the script and inspo video clips.",
      "VISION FOR THE EDIT\nElegant and nice pacing. Kinetic text catered to Kristin's brand.",
      "EDITING NOTES\nNo script, drone only video. See lot outline in dropbox folder.",
      "VISION FOR THE EDIT\nOur normal fast paced premium reel style. Good speed, maybe a country style remix.",
      "VISION FOR THE EDIT\nCinematic\n\nSHOTS THAT MUST BE SHOWN\ndrone push-in over the pool",
      "Feature: the pool\nAvoid: neighbor's yard",
      "Show off the elegant open first floor along with the well kept exterior features.",
      "VISION FOR THE EDIT\nLuxury and calm.",
      "EDITING NOTES\nOpen on the porch",
    ];
    c.ok("real direction passes, even short (two specific words: “Luxury and calm”), and the must-show box counts with the vision", SPECIFIC_WORDS_NEEDED === 2 && real.every((t) => editingDirectionProblem(t) === null), real.filter((t) => editingDirectionProblem(t)).join(" | "));
    c.ok("tapped starters left empty are not direction (“The editor needs a line or two”)", /^The editor needs a line or two\./.test(editingDirectionProblem(DIRECTION_PROMPTS.map((p) => p.starter).join("\n")) ?? "") && !!editingDirectionProblem(SESSION_DIRECTION_PROMPTS.map((p) => p.starter).join("\n")));
    c.ok("a script is never direction: an intro typed word for word with “None” as the notes is still refused", !!editingDirectionProblem("INTRO SCRIPT\nWho says less maintenance means settling for less house\n\nEDITING NOTES\nNone") && directionText("INTRO SCRIPT\nhello there\n\nSCRIPT FOR THIS VIDEO\nmore words\n\nEDITING NOTES\nopen on the porch") === "open on the porch");
    c.ok("STYLE, COLOR PROFILE and song lines never count", directionText("STYLE: Fast-Paced\nCOLOR PROFILE: S-Log3\nSONG LINK: https://x\nSONG TITLE: Old Town Road\nVISION FOR THE EDIT\nN/A") === "N/A" && specificWords("N/A").length === 0);
    c.ok("a long thing it can't quote is still named, without pasting it back", /^That doesn't tell the editor much yet\./.test(editingDirectionProblem("standard edit same as usual please thanks for the normal style as always") ?? ""));
    c.ok("a later video's problem names the video", / for video 2 \(Listing Video\)\. Add what to feature/.test(editingDirectionProblem("N/A", { name: "video 2 (Listing Video)" }) ?? ""));
    c.ok("a starter is added on its own line, once", withStarter("", "Feature: ") === "Feature: " && withStarter("Open on the porch", "Avoid: ") === "Open on the porch\nAvoid: " && withStarter("Open on the porch\nAvoid: cars", "Avoid: ") === "Open on the porch\nAvoid: cars");
    c.ok("the four prompts are what the editor needs: feature, best clips or rooms, avoid, the agent on camera", DIRECTION_PROMPTS.map((p) => p.label).join(" | ") === "What to feature | Best clips or rooms | Anything to avoid | Agent on camera");

    // =====================================================================
    c.head("2 · The upload page: starters, the line under the box, the submit list");
    // =====================================================================
    const { UploadPortal: Portal } = await import("@/components/upload/UploadPortal");
    const P = Portal as any;
    const project: Props = { id: "oct29-dir", title: "265 Mill Rd, Havertown, PA", addressLine: "265 Mill Rd", city: "Havertown", state: "PA", zip: "19083", packageName: "Photos + Listing Video", shootDate: "2026-10-29T14:00:00Z", status: "SCHEDULED", editorBrief: null, uploadedAt: null, debriefSubmittedAt: null, photosHandoffAt: null, photosHandoffBy: null, videoHandoffAt: null, videoHandoffBy: null, editorPdfPath: null, clientName: "Dana Reyes", clientAvatarUrl: null, customerNote: null, photographerName: "Harrison Wells", cullingConfirmedAt: null, shotOrderNotes: null, removalNotes: null, videoInstructions: null, videosFilmed: null, scriptConfirmedAt: null, scriptConfirmNote: null };
    const base = (style: string, spec: Props, proj: Props = project): Props => ({
      project: proj,
      deliverables: [{ id: "d-video", type: "VIDEO", quantity: 1, status: "PENDING", uploadedAt: null, notCompletedReason: null }],
      specialRequests: [], flags: [],
      policy: { photosOrdered: false, videoOrdered: true, photoTarget: 0, range: { low: 0, high: 0, upper: 0 }, rangeMode: "sop", squareFeet: null, squareFeetBand: null, videoSpec: spec, videoStyle: style, isPremium: false },
      script: null, foldersSlot: null, handoffFolders: [], submission: { submittedBy: null, lastEdited: null, addOns: [], files: [] },
      viewerIsOffice: false, payGateFromMs: Date.parse("2026-09-02"), sessionTopics: null, draft: null, draftRevision: null, canSaveDraft: true,
      baseHash: submittedFieldsHash({ ...proj, reelScript: null } as never), evidence: [], gaps: [], fieldReports: [], nowMs: Date.parse("2026-10-29T22:00:00Z"),
      agentRequests: [], folders: [{ key: "rawVideo", label: "Raw Video", url: "https://www.dropbox.com/home/raw-video", count: 12 }],
      dropboxConnected: true, rawBudget: { budget: 45, overage: 60 }, existingSongs: {},
      addOnRows: [], addedVideoTexts: {}, viewerName: "Harrison Wells",
      slots: { debrief: createElement("div", { "data-debrief": true }, "How did the shoot go?") },
      sharedShoot: { shared: false, me: { memberId: "m-h", name: "Harrison Wells" }, members: [{ memberId: "m-h", name: "Harrison Wells", via: "appointment" }], contributions: [], notes: [], floorISO: null, answers: { photos: null, video: null } },
      halfShot: [{ key: "d-video:1", number: 1, label: "Listing Video", waiting: false, finished: false }],
    });
    const card = mountHooks(() => P(base("standard_cinematic", videoStepSpec(["Listing Video"], { hasFullVideo: true }))));
    let tree = card.render();
    const tickVideo = (m: { render(): unknown }) => { const b = elements(m.render(), (ty, p) => ty === "button" && p["data-capture"] === "video")[0]; if (b) (b.onClick as () => void)(); };
    tickVideo(card);
    tree = card.render();
    const notesBox = () => elements(card.render(), (ty, p) => byName("AutoTextarea")(ty) && /editor should know — order, must-show moments/.test(String(p.placeholder ?? "")))[0];
    const prompts = () => elements(card.render(), (ty, p) => "data-direction-prompts" in p)[0];
    const promptButtons = () => nodes(prompts()?.children, (ty) => ty === "button").map((n) => n.props);
    c.ok("a listing video (its one box is required): the four starters sit under the box", !!notesBox() && promptButtons().map((b) => flat(b.children)).join(" | ") === "+ What to feature | + Best clips or rooms | + Anything to avoid | + Agent on camera", promptButtons().map((b) => flat(b.children)).join(" | "));
    c.ok("nothing typed: no line under the box (the empty box has its own “required”)", !elements(card.render(), (ty, p) => "data-direction-problem" in p).length);
    (promptButtons()[0].onClick as () => void)();
    c.ok("tapping “What to feature” starts a line in the box", notesBox().value === "Feature: ");
    (notesBox().onChange as (e: unknown) => void)({ target: { value: "Standard edit" } });
    tree = card.render();
    const line = elements(tree, (ty, p) => "data-direction-problem" in p)[0];
    c.ok("“Standard edit”: said under the box, with what to add", !!line && /“Standard edit” doesn't tell the editor much\. Add what to feature, your best clips or rooms, anything to avoid, and when the agent is on camera\. The video can.t be handed in until it does\./.test(flat(line.children)), flat(line?.children));
    c.ok("…the softer “light” hint steps aside for it (one message, not two)", !elements(tree, (ty, p) => "data-light-instructions" in p).length);
    const submitBtn = (label: string) => elements(card.render(), (ty, p) => ty === "button" && flat(p.children).includes(label))[0];
    const submit = (label: string) => { const b = submitBtn(label); if (b) (b.onClick as () => void)(); return errOf(card.render()); };
    let e = submit("Submit");
    c.ok("…and the submit names it in its list (the files are untouched: nothing is uploaded or held from here)", /“Standard edit” doesn't tell the editor much\. Add what to feature/.test(e) && !/on camera\.\./.test(e) && !calls.some((x) => x.name === "submitUpload" || x.name === "finalizeUpload"), e.slice(0, 260));
    (notesBox().onChange as (e: unknown) => void)({ target: { value: "Feature: the kitchen island and the pool at dusk\nAvoid: the neighbor's yard" } });
    tree = card.render();
    c.ok("real words: the line goes", !elements(tree, (ty, p) => "data-direction-problem" in p).length);
    e = submit("Submit");
    c.ok("…and the submit no longer asks for it", !/doesn't tell the editor much/.test(e), e.slice(0, 200));
    card.stop();

    const reel = mountHooks(() => P(base("standard_reel", specForStyle("standard_reel"))));
    tickVideo(reel);
    const reelBox = elements(reel.render(), (ty, p) => byName("AutoTextarea")(ty) && /editor should know — order, must-show moments/.test(String(p.placeholder ?? "")))[0];
    if (reelBox) (reelBox.onChange as (e: unknown) => void)({ target: { value: "Standard edit" } });
    const rt = reel.render();
    c.ok("a plain social reel (Jordan, Sep 1: no notes needed): no starters, and “Standard edit” is fine", !!reelBox && !elements(rt, (ty, p) => "data-direction-prompts" in p).length && !elements(rt, (ty, p) => "data-direction-problem" in p).length);
    reel.stop();

    const handed = mountHooks(() => P(base("standard_cinematic", videoStepSpec(["Listing Video"], { hasFullVideo: true }), { ...project, videoInstructions: "COLOR PROFILE: iPhone\n\nEDITING NOTES\nStandard edit" })));
    tickVideo(handed);
    const ht = handed.render();
    c.ok("a brief already handed in is not re-judged (no starters, no line)", !elements(ht, (ty, p) => "data-direction-problem" in p).length && !elements(ht, (ty, p) => "data-direction-prompts" in p).length);
    handed.stop();

    // =====================================================================
    c.head("3 · The server gate (read from source)");
    // =====================================================================
    const actions = src("src/app/upload/actions.ts");
    const gate = actions.slice(actions.indexOf("if (firstVideoGate && !spec.minimalReel && !prior.videoInstructions && !instructionsInDropbox)"));
    c.ok("the first video's gate asks the same rule, after the empty check, not on an agent-intro reel's notes", /if \(!meaningful\) \{[\s\S]{0,400}\}\s*\/\/ WORDS THAT SAY SOMETHING[\s\S]{0,500}if \(spec\.fullBrief \|\| !spec\.requireIntro\) \{\s*const \{ editingDirectionProblem \} = await import\("@\/lib\/editingDirection"\);\s*const problem = editingDirectionProblem\(data\.videoInstructions\);\s*if \(problem\) return \{ blocked: problem \};/.test(gate));
    c.ok("…inside the gate a plain reel, a brief already saved and Dropbox instructions never reach", gate.indexOf("editingDirectionProblem(data.videoInstructions)") > 0 && gate.indexOf("editingDirectionProblem(data.videoInstructions)") < gate.indexOf("Premium packages: the script can NOT be blank"));
    c.ok("a later video's vision is asked the same, only when it had no words of its own", /if \(r\.shape === "full" && !r\.own\?\.trim\(\) && !instructionsInDropbox\) \{\s*const \{ editingDirectionProblem \} = await import\("@\/lib\/editingDirection"\);\s*const problem = editingDirectionProblem\(own, \{ name \}\);/.test(actions));
    c.ok("handoff readiness (cards, KPI) is unchanged: nothing already handed in is re-judged", !src("src/lib/handoff.ts").includes("editingDirection") && !src("src/lib/kpiEvidence.ts").includes("editingDirection"));

    // =====================================================================
    c.head("4 · Start another assessment");
    // =====================================================================
    const desk = src("src/components/creativeDesk/CreativeDesk.tsx");
    const tile = desk.slice(desk.indexOf("function ReadinessTile"), desk.indexOf("function FollowUps"));
    c.ok("the readiness tile with one in progress offers “Start another assessment” (not read-only, readable)", /\{!readOnly && !unavailable && \([\s\S]{0,300}data-open-panel="new-readiness" data-start-another[\s\S]{0,300}Start another assessment/.test(tile) && tile.includes(">Start one <"));
    c.ok("the full list's header says “Start another” once there are any", /\{items\.length \? "Start another" : "Start one"\}/.test(desk));
    c.ok("the panel can open the next one (PanelBody gets the desk's open)", desk.includes("<PanelBody panel={panel} desk={desk} href={href} onClose={() => setPanel(null)} onOpen={open} />"));
    const { PanelBody } = await import("@/components/creativeDesk/CreativePanels");
    const item = { id: "ra1", personId: "p1", personName: "Harrison Wells", track: "INDEPENDENT", trackLabel: "Independent work", skill: null, criteria: [{ key: "k1", label: "Delivers on time", source: "kpi", met: "unknown", evidence: null, covers: null }], met: 0, gaps: null, recommendation: null, recommendationNote: null, status: "DRAFT", recommendedISO: null, createdBy: "James Livingston", createdISO: "2026-10-20T15:00:00Z", log: [], decision: null, href: "/development?assessment=ra1" };
    const deskData = (readOnly: boolean) => ({ readOnly, readiness: { items: [item], criteria: [], people: [{ id: "p1", name: "Harrison Wells" }], unavailable: false } }) as any;
    const opened: unknown[] = [];
    const panelTree = (PanelBody as any)({ panel: { kind: "readiness", id: "ra1" }, desk: deskData(false), href: (h: string) => h, onClose() {}, onOpen: (p: unknown) => opened.push(p) });
    const startBtn = elements(panelTree, (ty, p) => ty === "button" && "data-start-another" in p)[0];
    c.ok("inside an open assessment: “Start another assessment”, and it opens the new one", !!startBtn && flat(startBtn.children).includes("Start another assessment") && (() => { (startBtn.onClick as () => void)(); return JSON.stringify(opened) === '[{"kind":"new-readiness"}]'; })());
    c.ok("…saying this one stays as it is", flat(panelTree).includes("This one stays as it is. You can come back to it any time."));
    const roTree = (PanelBody as any)({ panel: { kind: "readiness", id: "ra1" }, desk: deskData(true), href: (h: string) => h, onClose() {}, onOpen() {} });
    c.ok("a read-only preview (“view as”) never offers it", !elements(roTree, (ty, p) => "data-start-another" in p).length);
    c.ok("…and the page renders (server markup) with it", renderToStaticMarkup(createElement(PanelBody as any, { panel: { kind: "readiness", id: "ra1" }, desk: deskData(false), href: (h: string) => h, onClose() {}, onOpen() {} })).includes("Start another assessment"));

    // =====================================================================
    c.head("5 · The portal: the creative manager may look");
    // =====================================================================
    const who = (role: string) => ({ role });
    c.ok("look (the preview page): the owner, the office and the creative manager; not an editor or photographer", canViewPortal(who("OWNER"), true) && canViewPortal(who("ADMIN"), true) && canViewPortal(who("CREATIVE_MANAGER"), true) && !canViewPortal(who("EDITOR"), true) && !canViewPortal(who("PHOTOGRAPHER"), true) && !canViewPortal(null, true));
    c.ok("make or copy the client's link: still the owner and the office only; billing eyes still the owner's", !canOpenPortal(who("CREATIVE_MANAGER"), true) && canOpenPortal(who("ADMIN"), true) && !canPreviewPortal(who("CREATIVE_MANAGER"), true));
    c.ok("an old “Their portal” link sends the creative manager to the preview too", resolveStaffTab("portal", null, canViewPortal(who("CREATIVE_MANAGER"), true)).preview && resolveStaffTab("portal", null, canViewPortal(who("EDITOR"), true)).redirect);
    const page = src("src/app/content/[id]/page.tsx");
    c.ok("the client file: “Preview portal” for whoever may look; the link button stays the office's", /const portalViewEyes = canViewPortal\(me, authEnforced\(\)\);/.test(page) && /\{portalEyes && <PortalLinkButton enrollmentId=\{id\} \/>\}/.test(page) && /\{portalViewEyes && \(\s*<Link href=\{`\/content\/\$\{id\}\/preview`\}/.test(page) && page.includes("resolveStaffTab(sp.tab, sp.view, portalViewEyes)"));
    const preview = src("src/app/content/[id]/preview/page.tsx");
    c.ok("the preview page lets in whoever may look, shows the link button and the bare link only to the office", /if \(!canViewPortal\(me, authEnforced\(\)\)\) redirect\(contentHref\(id\)\);/.test(preview) && /actions=\{linkEyes \? <PortalLinkButton enrollmentId=\{id\} \/> : undefined\}/.test(preview) && /\{linkEyes && \(\s*<a\s+href=\{`\/portal\/\$\{enrollment\.portalToken\}`\}/.test(preview));
    c.ok("…the on-behalf warning is still there, and no link yet points the creative manager at Plan › Topics", preview.includes("is recorded as you, on their behalf") && /Kyle or Jordan creates it; the topic bank is on the client file&rsquo;s/.test(preview));
    const portal = src("src/lib/portal.ts");
    c.ok("the portal itself already stands the creative manager in as staff on the client's behalf (stamped with their name)", /const STAFF_ON_BEHALF_ROLES = new Set\(\["OWNER", "ADMIN", "CREATIVE_MANAGER"\]\);/.test(portal) && /\(on behalf of \$\{client\}\)/.test(src("src/lib/portalAccess.ts")));
    c.ok("issuePortalLink (the link itself) is still the office's", /export async function issuePortalLink[\s\S]{0,200}requireAdmin\(\)/.test(src("src/app/content/actions.ts")));

    // =====================================================================
    c.head("6 · House rules on the new words");
    // =====================================================================
    const added = [src("src/lib/editingDirection.ts"), src("src/components/creativeDesk/CreativeDesk.tsx"), src("src/components/creativeDesk/CreativePanels.tsx")].join("\n");
    const newPhrases = ["doesn't tell the editor much", "Add what to feature, your best clips or rooms, anything to avoid, and when the agent is on camera", "Start another assessment", "This one stays as it is", "Kyle or Jordan creates it"];
    c.ok("no em or en dash in the new words", newPhrases.every((p) => !/[—–]/.test(p)) && !/[—–]/.test(src("src/lib/editingDirection.ts").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n")));
    c.ok("the new words are on the page", newPhrases.every((p) => added.includes(p) || src("src/app/content/[id]/preview/page.tsx").includes(p)));
    c.ok("the drill made no network call", fence.blocked.length === 0 && fence.faked.length === 0, fence.blocked.slice(0, 2).join(" | "));
  } catch (err) {
    c.ok(`drill crashed: ${err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" ") : String(err)}`, false);
  }
  c.summary();
  process.exit(process.exitCode ?? 0);
}

void main();
