// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual UploadPortal handlers with delayed fake action responses. No DB,
// provider, client sends, invitations or normal browser is exercised.
import { isValidElement, type ComponentProps } from "react";
import { createRequire } from "node:module";
import { fenceFetch, makeChecker } from "./_harness";
import { videoStepSpec } from "../../src/lib/pipeline";
import { submittedFieldsHash } from "../../src/lib/uploadDraft";
import type { UploadPortal } from "../../src/components/upload/UploadPortal";
import type { UploadAttempt } from "../../src/lib/uploadReceipt";
type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((child) => contains(child, text));
  return isValidElement<Props>(tree) && contains(tree.props.children, text);
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!test()) throw new Error("UI fixture did not settle"); }
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useMemo(fn: () => unknown, deps: unknown[]) { const slot = index++, prior = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!prior || deps.some((v, i) => v !== prior.deps[i])) cells[slot] = { deps, value: fn() }; return (cells[slot] as { value: unknown }).value; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return { render() { index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } }, stop() { cleanups.splice(0).forEach((fn) => fn()); } };
}
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const storage = new Map<string, string>();
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: local, scrollTo() {}, addEventListener() {}, removeEventListener() {} } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} } });
  const nav = req.resolve("next/navigation"); req.cache[nav] = { id: nav, filename: nav, loaded: true, exports: { useRouter: () => ({ refresh: () => { refreshes++; } }) } } as NodeModule;
  const actions = req.resolve("../../src/app/upload/actions.ts"), drafts = req.resolve("../../src/app/upload/draftActions.ts");
  const response = deferred<{ attemptTerminal: boolean; baseHash: string; handoff: { wholeDone: boolean; photosAtISO: null; videoAtISO: null } }>();
  let outcome: "unknown" | "running" | "complete" = "unknown";
  let sizeResponse = deferred<{ ok: boolean; terminal?: boolean }>();
  let sizeOutcome: "unknown" | "running" | "complete" = "unknown";
  let refreshes = 0, saves = 0;
  const submissions: (Props & UploadAttempt)[] = [], sizes: { value: number | null; attempt: UploadAttempt }[] = [];
  const put = (file: string, exports: unknown) => { req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  put(actions, {
    finalizeUpload: async (_id: string, payload: Props & UploadAttempt) => { submissions.push(payload); return response.promise; },
    checkUploadRawFiles: async () => ({ checkedAtISO: new Date().toISOString(), connected: false, photos: null, video: null }),
    readUploadAttempt: async () => outcome === "unknown" ? { state: "unknown" } : { state: "saved", terminal: outcome === "complete", phase: outcome === "complete" ? "complete" : "core_saved", baseHash: "saved-attempt-base", atISO: "2026-09-30T16:00:00Z", currentChanged: false, handoff: { wholeDone: true, photosAtISO: null, videoAtISO: null } },
    setProjectSquareFeet: async (_id: string, value: number | null, attempt: UploadAttempt) => { sizes.push({ value, attempt }); return sizeResponse.promise; },
    readUploadSquareFeet: async () => sizeOutcome === "unknown" ? { state: "unknown" } : { state: "saved", terminal: sizeOutcome === "complete", squareFeet: 2500 },
  });
  put(drafts, { saveUploadDraft: async () => { saves++; return { ok: true, revision: saves, savedAtISO: new Date().toISOString() }; }, discardUploadDraft: async () => {} });
  const { UploadPortal: Portal } = await import("@/components/upload/UploadPortal");
  const project = { id: "upload-ui-fixture", title: "123 Fixture Lane", addressLine: "123 Fixture Lane", city: null, state: null, zip: null, packageName: null, shootDate: "2026-09-30T15:00:00Z", status: "SCHEDULED", editorBrief: "Original note", uploadedAt: null, debriefSubmittedAt: null, photosHandoffAt: null, photosHandoffBy: null, videoHandoffAt: null, videoHandoffBy: null, editorPdfPath: null, clientName: "Fixture", clientAvatarUrl: null, customerNote: null, photographerName: "Fixture Shooter", cullingConfirmedAt: "2026-09-30T15:30:00Z", shotOrderNotes: "Front to back", removalNotes: "Nothing to remove", videoInstructions: null, videosFilmed: null, scriptConfirmedAt: null, scriptConfirmNote: null };
  const props: ComponentProps<typeof UploadPortal> = { project, deliverables: [{ id: "photos", type: "PHOTOS", quantity: 1, status: "UPLOADED", uploadedAt: "2026-09-30T15:30:00Z", notCompletedReason: null }], specialRequests: [], flags: [], policy: { photosOrdered: true, videoOrdered: false, photoTarget: 40, range: { low: 35, high: 45, upper: null }, rangeMode: "sop", squareFeet: 2000, squareFeetBand: null, videoSpec: videoStepSpec([], { hasFullVideo: false }), videoStyle: "standard_reel", isPremium: false }, script: null, foldersSlot: null, handoffFolders: [], submission: { submittedBy: null, lastEdited: null, addOns: [], files: [] }, viewerIsOffice: false, payGateFromMs: Date.parse("2026-09-02"), sessionTopics: null, draft: null, draftRevision: null, canSaveDraft: true, baseHash: submittedFieldsHash({ ...project, reelScript: null }), evidence: [], gaps: [], fieldReports: [], nowMs: Date.parse("2026-09-30T16:00:00Z") };
  let card = mountHooks(() => Portal(props));
  const button = (label: string) => elements(card.render(), "button").find((p) => contains(p.children, label))!;
  const click = (label: string) => (button(label).onClick as () => void)();
  const size = () => elements(card.render(), "input").find((p) => p.id === "sqft")!;
  const typeSize = (value: string) => (size().onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const blurSize = (value: string) => (size().onBlur as (event: { target: { value: string } }) => void)({ target: { value } });
  try {
    card.render(); await new Promise((resolve) => setTimeout(resolve, 10));
    click("Everything's uploaded"); await until(() => button("Submit to editors")?.disabled === false || !!button("Confirm handoff"));
    const confirm = elements(card.render(), "button").find((p) => p.className && String(p.className).includes("bg-brand px-3.5"))!;
    (confirm.onClick as () => void)(); (confirm.onClick as () => void)();
    await until(() => submissions.length === 1);
    c.ok("same-tick repeated confirm starts only one exact request", submissions.length === 1);
    const text = elements(card.render(), "AutoTextarea").find((p) => p.value === "Original note")!;
    (text.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Newer native note\n Keep  spacing. " } }); card.render();
    response.reject(new Error("isolated lost response")); await until(() => contains(card.render(), "The upload response was lost"));
    c.ok("lost response never claims editors were not notified and keeps exact newer native text", !contains(card.render(), "NOT notified") && elements(card.render(), "AutoTextarea").some((p) => p.value === "Newer native note\n Keep  spacing. "));
    c.ok("opaque attempt mirror retains ID/fingerprint only and submit remains held", storage.get(`upload-attempt:${project.id}`)?.includes(submissions[0].attemptId) === true && !storage.get(`upload-attempt:${project.id}`)?.includes("Original note") && elements(card.render(), "button").filter((p) => contains(p.children, "Everything's uploaded")).every((p) => p.disabled));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    c.ok("unknown request holds server autosave and keeps newer draft locally", saves === 0 && storage.get(`upload-draft:${project.id}`)?.includes("Newer native note") === true);
    click("Check upload status"); await until(() => contains(card.render(), "This exact upload attempt is not confirmed"));
    c.ok("absent receipt never releases old request hold", storage.has(`upload-attempt:${project.id}`) && submissions.length === 1);
    outcome = "running"; click("Check upload status"); await until(() => contains(card.render(), "earlier upload request has not confirmed it finished"));
    c.ok("saved core still running never enables a fresh submit or provider overlap", storage.has(`upload-attempt:${project.id}`) && saves === 0);
    const localDraft = JSON.parse(storage.get(`upload-draft:${project.id}`)!);
    const serverDraft = { revision: 3, payload: { ...localDraft.payload, editorBrief: "Other device draft" }, savedAtISO: "2026-09-30T16:00:00Z" };
    card.stop(); card = mountHooks(() => Portal({ ...props, draft: serverDraft, draftRevision: 3, project: { ...project, debriefSubmittedAt: "2026-09-30T16:01:00Z" } })); card.render();
    await until(() => contains(card.render(), "An earlier upload response is unconfirmed"));
    await until(() => elements(card.render(), "AutoTextarea").some((p) => p.value === "Newer native note\n Keep  spacing. "));
    c.ok("same-tab refresh restores exact attempt and newer native mirror despite earlier debrief stamp", storage.has(`upload-attempt:${project.id}`) && elements(card.render(), "AutoTextarea").some((p) => p.value === "Newer native note\n Keep  spacing. "));
    c.ok("unknown recovery keeps the existing draft conflict choice held", contains(card.render(), "A different copy") && button("Keep this page").disabled === true && button("Load the other copy").disabled === true);
    outcome = "complete"; click("Check upload status"); await until(() => contains(card.render(), "submitted answers are confirmed saved"));
    c.ok("terminal readback releases attempt while preserving current draft without blanket refresh", !storage.has(`upload-attempt:${project.id}`) && refreshes === 0 && elements(card.render(), "AutoTextarea").some((p) => p.value === "Newer native note\n Keep  spacing. "));
    await new Promise((resolve) => setTimeout(resolve, 1800));
    c.ok("terminal recovery does not bypass an outstanding native draft conflict choice", saves === 0 && button("Keep this page").disabled === false && storage.get(`upload-draft:${project.id}`)?.includes("Newer native note") === true);
    click("Keep this page");
    typeSize("2500"); blurSize("2500"); blurSize("2500"); await until(() => sizes.length === 1);
    typeSize("3100"); blurSize("3100"); typeSize("3300"); blurSize("3300");
    c.ok("size requests serialize and squash latest intended blur while input stays editable", sizes.length === 1 && size().value === "3300");
    sizeResponse.resolve({ ok: true, terminal: true }); await until(() => sizes.length === 2);
    c.ok("known size receipt drains only latest queued intent, never overwrites newer input", sizes[1].value === 3300 && size().value === "3300");
    // Replace the now fulfilled fake for a new isolated uncertain request.
    await until(() => !contains(card.render(), "saving…")); sizeResponse = deferred();
    typeSize("4200"); blurSize("4200"); await until(() => sizes.length === 3); typeSize("4500"); blurSize("4500");
    sizeResponse.reject(new Error("isolated lost size response")); await until(() => contains(card.render(), "size save response was lost"));
    c.ok("lost size response clears busy, holds further writes and preserves latest figure", size().value === "4500" && !!button("Check current size") && sizes.length === 3);
    click("Check current size"); await until(() => contains(card.render(), "earlier size request has not confirmed it finished"));
    blurSize("4500"); c.ok("unknown readback cannot replay queued newer size", sizes.length === 3 && storage.has(`upload-size-attempt:${project.id}`));
    sizeOutcome = "running"; click("Check current size"); await until(() => !button("Check current size").disabled); blurSize("4500");
    c.ok("core-only size receipt does not release delayed original write hold", sizes.length === 3 && storage.has(`upload-size-attempt:${project.id}`));
    sizeOutcome = "complete"; click("Check current size"); await until(() => contains(card.render(), "Current saved size: 2,500"));
    c.ok("terminal size readback updates baseline but keeps newer input and requires explicit intended save", size().value === "4500" && sizes.length === 3 && !storage.has(`upload-size-attempt:${project.id}`) && !!button("Save current size"));
    c.ok("recovery controls are visible buttons with readable hold/error context", String(button("Save current size").className).includes("min-h-11") && contains(card.render(), "Your typed figure is kept"));
    c.ok("UI fixture performs no DB/provider operations or external fetch", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { card.stop(); fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
