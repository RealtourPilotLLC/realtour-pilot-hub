// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual delivery component handlers/SSR; server actions are explicit fakes.
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fenceFetch, makeChecker } from "./_harness";
import type { NotTold as NotToldRow, ReadyBoard, ReadyVideo, SentResult } from "../../src/lib/readyToSend";
import type { GroupDeliveryResult, UploadedTarget } from "../../src/lib/uploadedDeliveryGroups";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...elements(tree.props.children, name)];
}
function words(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(words).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  return words(tree.props.children) + (typeof tree.props.message === "string" ? tree.props.message : "");
}
function namedComponent(tree: unknown, name: string): { type: (props: Props) => unknown; props: Props } | null {
  if (Array.isArray(tree)) { for (const child of tree) { const found = namedComponent(child, name); if (found) return found; } return null; }
  if (!isValidElement<Props>(tree)) return null;
  if (typeof tree.type === "function" && tree.type.name === name) return { type: tree.type as (props: Props) => unknown, props: tree.props };
  return namedComponent(tree.props.children, name);
}
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = []; let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => unknown) => { cells[slot] = true; void Promise.resolve(callback()).finally(() => { cells[slot] = false; }); }]; },
  };
  return { render() { index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } }, stop() { cleanups.splice(0).forEach((fn) => fn()); } };
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); if (!test()) throw new Error("delivery UI fixture did not settle"); }

async function main() {
  const c = makeChecker(), req = createRequire(__filename);
  let groupResult = deferred<GroupDeliveryResult>();
  let destinationResponse = Response.json({ ok: false, message: "Link an Aryeo listing first." });
  let destinationCalls = 0;
  const groupCalls: { projectId: string; cuts: UploadedTarget[] }[] = [];
  const fence = fenceFetch((url, init) => {
    if (url.startsWith("/api/ops/video-destination")) { destinationCalls++; return destinationResponse; }
    if (url !== "/api/ops/project-sent") return null;
    groupCalls.push(JSON.parse(init?.body as string));
    return groupResult.promise.then(value => Response.json(value));
  });
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const markers = new Map<string, string>(); let storageFails = false, refreshes = 0;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => { if (storageFails) throw new Error("storage blocked"); return markers.get(key) ?? null; },
    setItem: (key: string, value: string) => { if (storageFails) throw new Error("storage blocked"); markers.set(key, value); }, removeItem: (key: string) => markers.delete(key),
  } });
  const calls: { id: string; notice?: string | null }[] = [], noticeCalls: { id: string; notice: string }[] = []; let result = deferred<SentResult>(), noticeResult = deferred<SentResult>();
  const noticeQuery: { args?: { select: { project: { select: { contentMonthId?: boolean } } }; where: { projectId?: string; project: unknown }; take: number; orderBy: unknown }; fail?: boolean } = {};
  const readerRows = [
    { id: "monthly-notice", projectId: "month-job", fileName: "monthly-exact-v2.mp4", assetPath: null, sentToClientAt: new Date("2026-10-01T15:00:00Z"), sentToClientBy: "Kyle", clientNoticeBy: "Actual saved marker", project: { title: "Unrelated neutral title", contentMonthId: "canonical-month-id" } },
    { id: "listing-notice", projectId: "listing-job", fileName: "listing-v1.mp4", assetPath: null, sentToClientAt: new Date("2026-10-01T16:00:00Z"), sentToClientBy: "Original office actor", clientNoticeBy: null, project: { title: "Monthly content words in an ordinary listing title", contentMonthId: null } },
  ];
  stub(req.resolve("../../src/lib/prisma.ts"), { prisma: { auditLog: { findMany: async () => [] }, reviewSubmission: { findMany: async (args: NonNullable<typeof noticeQuery.args>) => { noticeQuery.args = args; if (noticeQuery.fail) throw new Error("fixture reader unavailable"); return readerRows; } } } });
  const uploadCalls: { id: string; fingerprint: string }[] = []; let uploadResult = deferred<{ ok: boolean; message: string }>();
  stub(req.resolve("../../src/app/ops/actions.ts"), {
    markVideoUploadedAction: async (id: string, fingerprint: string) => { uploadCalls.push({ id, fingerprint }); return uploadResult.promise; },
    markVideoSentAction: async (id: string, notice?: string | null) => { calls.push({ id, notice }); return result.promise; },
    recordClientNoticeAction: async (id: string, notice: string) => { noticeCalls.push({ id, notice }); return noticeResult.promise; },
  });
  stub(req.resolve("next/navigation"), { useRouter: () => ({ refresh: () => { refreshes++; } }) });
  stub(req.resolve("../../src/app/ops/finalRenditionActions.ts"), {
    finalFileChoicesAction: () => { throw new Error("read not invoked by this fixture"); },
    recordFinalFileCheckAction: () => { throw new Error("save not invoked by this fixture"); },
    readFinalFileCheckReceiptAction: () => { throw new Error("receipt not invoked by this fixture"); },
  });
  stub(req.resolve("../../src/lib/recordUploadRequest.ts"), { recordUploadRequest: async (id: string, fingerprint: string) => { uploadCalls.push({ id, fingerprint }); return uploadResult.promise; } });
  stub(req.resolve("../../src/lib/recordDeliveryRequest.ts"), { recordDeliveryRequest: async (id: string, notice?: string) => { calls.push({ id, notice }); return result.promise; } });
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  let confirms = true, removed = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { confirm: () => confirms } });
  let card: ReturnType<typeof mountHooks> | null = null;
  try {
    const { MarkSent } = await import("../../src/components/ops/MarkSent");
    const props = { submissionId: "fixture-exact-cut", street: "Fixture Grove", monthly: true };
    const mount = async (monthly = true) => { card?.stop(); card = mountHooks(() => MarkSent({ ...props, monthly })); card.render(); await Promise.resolve(); };
    const tree = () => card!.render();
    const button = (label: string) => elements(tree(), "Button").find((p) => words(p.children).trim() === label);
    const click = (label: string) => { const p = button(label); if (!p) throw new Error(`Missing button ${label}`); (p.onClick as () => void)(); if (label === "Mark as Uploaded") { const confirm = button(confirms ? "Confirm uploaded" : "Cancel"); if (confirm) (confirm.onClick as () => void)(); } };
    const status = () => elements(tree(), "SaveStatus")[0];
    const { MarkUploaded } = await import("../../src/components/ops/MarkUploaded");
    const mountUpload = async () => { card?.stop(); card = mountHooks(() => MarkUploaded({ submissionId: props.submissionId, fingerprint: "exact-file-v3", onUploaded: () => removed++ })); tree(); await Promise.resolve(); };
    await mountUpload(); confirms = false; click("Mark as Uploaded"); confirms = true;
    c.ok("cancelling confirmation submits nothing", uploadCalls.length === 0 && markers.size === 0);
    click("Mark as Uploaded"); click("Mark as Uploaded");
    c.ok("confirmed upload serializes exact version despite repeated clicks", uploadCalls.length === 1 && uploadCalls[0].fingerprint === "exact-file-v3");
    uploadResult.reject(new Error("lost response")); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("lost response ends spinner with ordinary retry and no reconciliation control", !!button("Mark as Uploaded") && !button("Reconcile upload record") && markers.size === 1 && removed === 0);
    await mountUpload(); uploadResult = deferred(); click("Mark as Uploaded");
    c.ok("ordinary confirmed retry preserves exact source after remount", uploadCalls.length === 2 && uploadCalls[1].fingerprint === "exact-file-v3");
    uploadResult.resolve({ ok: true, message: "Already recorded by original actor" }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("authoritative receipt removes row immediately without dashboard refresh", removed === 1 && markers.size === 0 && !!button("Uploaded") && elements(tree(), "Button")[0].disabled === true && refreshes === 0);
    await mountUpload(); uploadResult = deferred(); click("Mark as Uploaded"); uploadResult.resolve({ ok: false, message: "This cut changed" }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("refusal keeps row visible with reason", removed === 1 && words(tree()).includes("This cut changed"));
    markers.clear(); await mountUpload(); uploadResult = deferred();
    const realTimer = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => realTimer(callback, ms === 15_000 || ms === 20_000 ? 1 : ms, ...args)) as typeof setTimeout;
    try { click("Mark as Uploaded"); await until(() => elements(tree(), "Button")[0].busy === false); }
    finally { globalThis.setTimeout = realTimer; }
    c.ok("hung confirmation ends spinner and retains recoverable ordinary retry", markers.size === 1 && removed === 1 && !!button("Mark as Uploaded") && !elements(tree(), "Button")[0].disabled);
    uploadResult.resolve({ ok: true, message: "Late response" }); await Promise.resolve(); await Promise.resolve();
    c.ok("late response cannot falsely remove the row", removed === 1 && markers.size === 1);
    markers.clear();
    await mount(false); click("Mark as sent");
    const staleChoice = button("Mark as sent")!.onClick as () => void;
    staleChoice();
    c.ok("one-click listing acknowledgement dispatches once without notice questionnaire", calls.length === 1 && calls[0].id === props.submissionId && calls[0].notice === undefined && !button("Not told yet"));
    const listingSSR = renderToStaticMarkup(tree() as ReactNode);
    c.ok("confirmation uses named native 44px controls and shared visible focus", listingSSR.includes('type="button"') && listingSSR.includes("min-h-11") && listingSSR.includes("focus-visible:outline"));
    result.reject(new Error("lost response after possible database commit")); await until(() => elements(tree(), "Button")[0].busy === false);
    const heldCalls = calls.length; staleChoice(); click("Mark as sent");
    c.ok("lost response reports unknown rather than no-write and blocks immediate replay", calls.length === heldCalls && elements(tree(), "Button")[0].disabled === true && status().state === "error" && words(tree()).includes("may already have saved") && !words(tree()).includes("Couldn’t save"));
    c.ok("persisted guard contains only an opaque UUID, no client or notice words", markers.size === 1 && /^[a-f0-9-]{36}$/i.test([...markers.values()][0]) && ![...markers.values()].join().includes("Fixture") && ![...markers.values()].join().includes("not-yet"));
    const beforeRefresh = refreshes; click("Refresh delivery status"); await Promise.resolve();
    c.ok("unknown recovery refresh is read-only and does not itself unlock another write", refreshes === beforeRefresh + 1 && calls.length === heldCalls && markers.size === 1 && elements(tree(), "Button")[0].disabled === true);
    card!.stop(); card = mountHooks(() => MarkSent(props)); (elements(tree(), "Button")[0].onClick as () => void)(); await Promise.resolve();
    c.ok("same-cut remount checks the stored hold synchronously before mutation", calls.length === heldCalls && elements(tree(), "Button")[0].disabled === true && !!button("Refresh delivery status"));
    result = deferred(); click("Check and reconcile delivery record"); click("Check and reconcile delivery record");
    c.ok("explicit unknown recovery uses the same exact idempotent action without overwriting notice or duplicating dispatch", calls.length === heldCalls + 1 && calls.at(-1)?.id === props.submissionId && calls.at(-1)?.notice === undefined && words(tree()).includes("records or repairs the handoff you already confirmed") && words(tree()).includes("notification remains owed"));
    result.reject(new Error("recovery response also lost")); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("repeated unknown recovery remains visible and guarded rather than claiming success", markers.size === 1 && elements(tree(), "Button")[0].disabled === true && status().state === "error" && words(tree()).includes("may already have saved"));
    result = deferred(); click("Check and reconcile delivery record"); result.resolve({ ok: false, message: "Resolve the changed exact-file check." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("known refusal of a recovery cannot disprove the earlier unknown write", markers.size === 1 && elements(tree(), "Button")[0].disabled === true && words(tree()).includes("earlier delivery record is still unconfirmed") && words(tree()).includes("changed exact-file check"));
    result = deferred(); click("Check and reconcile delivery record"); result.resolve({ ok: true, already: true, message: "Already marked sent by Kyle at the recorded time." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("confirmed exact reconciliation clears its guard and truthfully retains the original actor receipt", !markers.size && status().state === "saved" && words(tree()).includes("by Kyle at the recorded time") && words(tree()).includes("Client approval and notification remain separate"));
    markers.clear(); await mount(); result = deferred(); click("Record portal handoff");
    result.resolve({ ok: false, message: "Exact final-file check is missing." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("known server refusal keeps its exact reason and permits correction without a stale hold", status().state === "error" && words(tree()).includes("Exact final-file check is missing") && !markers.size && !elements(tree(), "Button")[0].disabled);
    result = deferred(); click("Record portal handoff");
    const beforePartialRefresh = refreshes;
    result.resolve({ ok: true, message: "Marked sent, but a record failed.", incomplete: ["Kyle task update is incomplete"] }); await until(() => !!button("Finish the bookkeeping"));
    c.ok("known partial save retains named repair receipt without false complete success or refresh", status().state === "partial" && words(tree()).includes("Kyle task update is incomplete") && words(tree()).includes("without uploading or sending again") && refreshes === beforePartialRefresh && !markers.size);
    result = deferred(); click("Finish the bookkeeping");
    c.ok("partial repair preserves existing no-notice bookkeeping-only action arguments", calls.at(-1)?.id === props.submissionId && calls.at(-1)?.notice === undefined);
    result.resolve({ ok: true, already: true, message: "Already marked sent by Kyle at the recorded time." }); await until(() => elements(tree(), "Button")[0].busy === false);
    const savedCalls = calls.length; staleChoice();
    c.ok("confirmed monthly receipt preserves existing actor evidence and separate approval/notice facts", status().state === "saved" && words(tree()).includes("by Kyle at the recorded time") && words(tree()).includes("Client approval and notification remain separate") && !markers.size && refreshes === beforePartialRefresh + 1 && calls.length === savedCalls);
    await mount(); storageFails = true; click("Record portal handoff"); storageFails = false;
    c.ok("unavailable recovery storage refuses locally before a request", calls.length === savedCalls && words(tree()).includes("Nothing was submitted"));
    result = deferred(); click("Record portal handoff"); const other = randomUUID(); markers.set("rtp:delivery-record:fixture-exact-cut", other);
    result.resolve({ ok: false, message: "Known no-write refusal." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("late known response never clears another attempt's guard", markers.get("rtp:delivery-record:fixture-exact-cut") === other && elements(tree(), "Button")[0].disabled === true && words(tree()).includes("different unconfirmed change"));

    const { ReadyToSendCard } = await import("../../src/components/ops/ReadyToSendCard");
    const { DeliveryExitSummary } = await import("../../src/components/review/DeliveryExitSummary");
    const ready: ReadyVideo = {
      submissionId: props.submissionId, projectId: "fixture-project", monthlyProgram: true, monthKey: "2026-10", topicTitle: "Exact topic", monthlyPortalReleased: true, monthlyPortalAccess: true, monthlyFinalCheckRecorded: false,
      topazJobId: null, street: props.street, clientName: "Fixture Grove Client", clientAvatarUrl: null, cutLabel: "Output 2", round: 3, approvedAtISO: "2026-10-01T15:00:00Z", approvedBy: "James", waitingHours: 1, overdue: false,
      file: { source: "editor-dropbox", fileName: "exact-v3.mp4", downloadHref: "/api/review/cut/fixture-exact-cut/final", dropboxPath: "/fixture/final/exact-v3.mp4", dropboxUrl: "https://www.dropbox.com/home/fixture?preview=exact-v3.mp4", says: "Exact approved file", why: null },
      alsoOnFile: [], aryeoUrl: "https://example.test/listing", aryeoTitle: "Listing", reviewHref: "/review/fixture-project?cut=fixture-exact-cut", downloadedAtISO: null, downloadedBy: null, downloadedHoursAgo: null, listing: null,
    };
    const board: ReadyBoard = { ready: [ready], rendering: [], needsFinishing: [], notTold: [] };
    const monthlyHTML = renderToStaticMarkup(createElement(ReadyToSendCard, { board }));
    c.ok("actual monthly row passes destination into record control and orders final check before recording", !monthlyHTML.includes("Record portal handoff") && !monthlyHTML.includes("Check client-viewable file") && !monthlyHTML.includes("example.test/listing"));
    const branding = { ...ready, deliveryDestination: "client-portal" as const, canChooseAryeo: true, destinationFingerprint: "branding-choice", uploadFingerprint: "branding-final" };
    const brandingHTML = renderToStaticMarkup(createElement(ReadyToSendCard, { board: { ...board, ready: [branding] } }));
    c.ok("branding alternative appears below always-visible file buttons", brandingHTML.includes("Upload to Aryeo instead?") && brandingHTML.indexOf("Upload to Aryeo instead?") > brandingHTML.indexOf("Watch it"));
    card!.stop(); card = mountHooks(() => ReadyToSendCard({ board: { ...board, ready: [branding] } }));
    const brandRow = namedComponent(tree(), "ReadyRow")!;
    (brandRow.props.onAryeoChosen as () => void)();
    c.ok("confirmed choice moves branding into upload queue immediately while preserving month identity", words(tree()).includes("Ready for upload") && !words(tree()).includes("Portal delivery needs attention") && namedComponent(tree(), "ReadyRow")!.props.v !== branding && (namedComponent(tree(), "ReadyRow")!.props.v as ReadyVideo).monthlyProgram);
    branding.uploadFingerprint = "branding-replacement"; branding.destinationFingerprint = "branding-choice-replacement";
    c.ok("local choice cannot leak onto a replaced source", words(tree()).includes("Portal delivery needs attention") && !words(tree()).includes("Ready for upload"));
    const { ChooseAryeoDelivery } = await import("../../src/components/ops/ChooseAryeoDelivery");
    let chosen = 0;
    card!.stop(); card = mountHooks(() => ChooseAryeoDelivery({ submissionId: "branding-cut", fingerprint: "branding-final", onChosen: () => chosen++ }));
    await (elements(tree(), "button")[0].onClick as () => Promise<void>)();
    c.ok("destination refusal ends busy state and displays actionable error", chosen === 0 && words(tree()).includes("Link an Aryeo listing first.") && !elements(tree(), "button")[0].disabled);
    const { destinationReceiptHeaders, confirmedAryeoDestination } = await import("../../src/lib/videoDestinationReceipt");
    const accepted = new Response(new ReadableStream({ start() {} }), { headers: destinationReceiptHeaders("branding-cut", "branding-final") });
    c.ok("destination receipt rejects a different source", !confirmedAryeoDestination(accepted, "branding-cut", "wrong-final"));
    destinationResponse = accepted;
    const beforeChoices = destinationCalls;
    await (elements(tree(), "button")[0].onClick as () => Promise<void>)();
    c.ok("committed headers finish choice even when the response body never completes", chosen === 1 && destinationCalls === beforeChoices + 1 && !elements(tree(), "button")[0].disabled);
    const listingHTML = renderToStaticMarkup(createElement(ReadyToSendCard, { board: { ...board, ready: [{ ...ready, monthlyProgram: false, uploadFingerprint: "fixture-source" }] } }));
    c.ok("actual listing row retains Aryeo destination, link and original Mark-as-sent action", listingHTML.includes("example.test/listing") && !listingHTML.includes("Mark as sent") && listingHTML.includes("Mark as Uploaded"));
    c.ok("files and upload is an always-visible section, never a disclosure", listingHTML.includes('aria-label="Files and upload"') && !listingHTML.includes('<summary class="cursor-pointer text-sm font-medium">Files and upload'));
    const listing = { ...ready, monthlyProgram: false, uploadFingerprint: "fixture-source", overdue: true };
    const uploadedHTML = renderToStaticMarkup(createElement(ReadyToSendCard, { board: { ...board, ready: [{ ...listing, uploaded: { id: "receipt", at: ready.approvedAtISO, by: "Kyle" } }] } }));
    c.ok("uploaded-not-sent is expanded with only title, overdue and requested actions", uploadedHTML.includes("Uploaded, not sent") && uploadedHTML.includes("Past due") && uploadedHTML.includes("Aryeo listing") && uploadedHTML.includes(">Watch</a>") && uploadedHTML.includes("Mark as sent") && !uploadedHTML.includes("Files and upload") && !uploadedHTML.includes("Download") && !uploadedHTML.includes("Mark as Uploaded") && !uploadedHTML.includes("<details"));
    card!.stop(); card = mountHooks(() => ReadyToSendCard({ board: { ...board, ready: [listing] } }));
    const uploadRow = namedComponent(tree(), "ReadyRow")!;
    (uploadRow.props.onUploaded as () => void)();
    const uploadedRow = namedComponent(tree(), "UploadedRow")!;
    c.ok("confirmed upload moves exact row between queues immediately", !!uploadedRow && !namedComponent(tree(), "ReadyRow") && words(tree()).includes("Uploaded, not sent"));
    (uploadedRow.props.onSent as (v: unknown) => void)([{ submissionId: listing.submissionId, fingerprint: listing.uploadFingerprint }]);
    c.ok("confirmed send removes exact row from uploaded-not-sent immediately", !namedComponent(tree(), "UploadedRow") && words(tree()).includes("No new files ready"));
    listing.uploadFingerprint = "replacement-source";
    c.ok("replacement source is not hidden by earlier upload/send acknowledgement", !!namedComponent(tree(), "ReadyRow") && !namedComponent(tree(), "UploadedRow"));
    const groupedHTML = renderToStaticMarkup(createElement(ReadyToSendCard, { board: { ...board, ready: [
      { ...listing, cutLabel: "Personal Branding Reel — Video 1 of 2", uploaded: { id: "one", at: ready.approvedAtISO, by: "Kyle" } },
      { ...listing, submissionId: "second-cut", cutLabel: "Personal Branding Reel — Video 2 of 2", uploaded: { id: "two", at: ready.approvedAtISO, by: "Kyle" } },
    ] } }));
    c.ok("same project has one concise unsent item and one set of actions", groupedHTML.includes("Personal Branding - Not Sent") && (groupedHTML.match(/>Mark as sent</g) ?? []).length === 1 && (groupedHTML.match(/>Watch</g) ?? []).length === 1 && !groupedHTML.includes("Video 2 of 2"));
    const { MarkProjectSent } = await import("../../src/components/ops/MarkProjectSent");
    const groupCuts = [{ submissionId: "group-one", fingerprint: "group-fp-one" }, { submissionId: "group-two", fingerprint: "group-fp-two" }];
    const groupCompleted: UploadedTarget[] = [];
    card!.stop(); card = mountHooks(() => MarkProjectSent({ projectId: "group-project", cuts: groupCuts, onRecorded: cuts => { groupCompleted.push(...cuts); } }));
    click("Mark as sent"); click("Cancel");
    c.ok("cancel group confirmation records nothing", groupCalls.length === 0 && groupCompleted.length === 0);
    click("Mark as sent"); const confirmGroup = button("Confirm sent")!.onClick as () => void; confirmGroup(); confirmGroup();
    c.ok("group save serializes one exact visible snapshot", groupCalls.length === 1 && groupCalls[0].projectId === "group-project" && JSON.stringify(groupCalls[0].cuts) === JSON.stringify(groupCuts));
    groupResult.resolve({ ok: false, completed: [groupCuts[0]], message: "Second video bookkeeping needs repair" }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("partial group receipt removes only confirmed members and names remaining work", groupCompleted.length === 1 && groupCompleted[0].submissionId === groupCuts[0].submissionId && words(tree()).includes("Second video bookkeeping"));
    groupResult = deferred(); click("Mark as sent"); click("Confirm sent");
    groupResult.resolve({ ok: true, completed: [{ submissionId: "unknown-cut", fingerprint: "other" }], message: "Invalid success" }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("mismatched group response cannot remove another cut", groupCompleted.length === 1 && words(tree()).includes("Could not confirm"));
    groupResult = deferred(); click("Mark as sent"); click("Confirm sent");
    groupResult.reject(new Error("Response lost after possible commit")); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("lost group response ends saving and permits explicit idempotent retry", groupCompleted.length === 1 && !!button("Mark as sent") && !elements(tree(), "Button")[0].disabled && words(tree()).includes("You do not need to send"));
    groupResult = deferred(); click("Mark as sent"); click("Confirm sent");
    groupResult.resolve({ ok: true, completed: groupCuts, message: "Recorded" }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("full group receipt removes confirmed versions without a root render", groupCompleted.length === 3 && groupCompleted.at(-1)?.submissionId === groupCuts[1].submissionId);
    markers.clear(); result = deferred(); let sentRemoved = 0;
    card!.stop(); card = mountHooks(() => MarkSent({ ...props, monthly: false, expectedFingerprint: "fixture-source", onRecorded: () => sentRemoved++ }));
    tree(); await Promise.resolve(); const refreshBeforeSend = refreshes;
    click("Mark as sent"); result.resolve({ ok: true, message: "Recorded", incomplete: ["Task update pending"] }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("partial bookkeeping retains row and explains follow-up", sentRemoved === 0 && words(tree()).includes("Task update pending") && !!button("Finish the bookkeeping"));
    result = deferred(); click("Finish the bookkeeping"); result.resolve({ ok: true, already: true, message: "Original actor retained" }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("direct send receipt removes row once without heavy dashboard refresh", sentRemoved === 1 && refreshes === refreshBeforeSend && markers.size === 0);
    const partialHTML = renderToStaticMarkup(createElement(ReadyToSendCard, { board: { ...board, ready: [], needsFinishing: [{ submissionId: ready.submissionId, projectId: ready.projectId, street: ready.street, sentAtISO: ready.approvedAtISO, sentBy: "Kyle", why: "Fixture partial" }] } }));
    c.ok("partial follow-up no longer claims client possession from a handoff stamp", !partialHTML.includes("The client has these") && partialHTML.includes("does not prove client approval, notification or receipt"));
    const exitHTML = renderToStaticMarkup(createElement(DeliveryExitSummary, { board }));
    c.ok("James-to-Kyle handoff keeps exact version link and separate approval/notification with accessible control", exitHTML.includes("fixture-exact-cut") && exitHTML.includes("Notification and client approval remain separate") && exitHTML.includes("min-h-11") && exitHTML.includes("focus-visible:outline"));

    const { clientNotToldYet } = await import("../../src/lib/readyToSend");
    const noticeRows = await clientNotToldYet({ projectId: "exact-requested-project", excludeClientIds: ["excluded-fixture"], max: 7 });
    c.ok("actual notice reader projects canonical contentMonthId without guessing from title or changing actor evidence", noticeQuery.args?.select.project.select.contentMonthId === true && noticeRows[0].monthlyProgram === true && noticeRows[1].monthlyProgram === false && noticeRows[0].sentBy === "Kyle" && noticeRows[0].markedBy === "Actual saved marker" && noticeRows[1].sentBy === "Original office actor");
    c.ok("destination projection leaves exact-project, exclusion, order and cap contracts intact", noticeQuery.args?.where.projectId === "exact-requested-project" && JSON.stringify(noticeQuery.args?.where.project).includes("excluded-fixture") && JSON.stringify(noticeQuery.args?.orderBy) === '{"sentToClientAt":"asc"}' && noticeQuery.args?.take === 7);
    noticeQuery.fail = true; let readerFailed = false; try { await clientNotToldYet(); } catch { readerFailed = true; } noticeQuery.fail = false;
    c.ok("failed notice read remains a failure rather than a false empty list", readerFailed);
    const { NotTold } = await import("../../src/components/ops/NotTold");
    const mountNotice = async (r: NotToldRow) => { card?.stop(); const row = namedComponent(NotTold({ rows: [r] }), "Row")!; card = mountHooks(() => row.type(row.props)); tree(); await Promise.resolve(); };
    markers.clear(); await mountNotice(noticeRows[0]);
    c.ok("monthly notice row names recorded portal handoff and omits Aryeo claim while separating approval and receipt", words(tree()).includes("portal handoff recorded") && words(tree()).includes("does not establish client approval or file receipt") && !button("Aryeo emailed them") && !!button("We texted them") && !!button("Call or in person") && words(tree()).includes("by Kyle"));
    const noticeMarkup = renderToStaticMarkup(createElement(NotTold, { rows: noticeRows }));
    c.ok("notice follow-up uses readable native targets and record-only wording", noticeMarkup.includes("Client notification owed") && noticeMarkup.includes("These controls send no message") && noticeMarkup.includes("min-h-11") && noticeMarkup.includes("focus-visible:outline") && !noticeMarkup.includes("text-[11px]"));
    const textNotice = button("We texted them")!.onClick as () => void; textNotice(); textNotice();
    c.ok("notice mutation synchronously serializes exact cut and unchanged notice enum", noticeCalls.length === 1 && noticeCalls[0].id === "monthly-notice" && noticeCalls[0].notice === "our-text");
    noticeResult.reject(new Error("notice response lost after possible commit")); await until(() => elements(tree(), "Button")[0].busy === false);
    click("Call or in person");
    c.ok("unknown notice save blocks switching channels and truthfully offers same-notice recovery", noticeCalls.length === 1 && status().state === "error" && words(tree()).includes("may already have saved") && !!button("Check and record:  We texted them"));
    const storedNotice = [...markers.values()][0], storedData = JSON.parse(storedNotice) as { id: string; via: string };
    c.ok("notice recovery stores only opaque attempt ID and necessary canonical channel", Object.keys(storedData).sort().join() === "id,via" && /^[a-f0-9-]{36}$/i.test(storedData.id) && storedData.via === "our-text" && !storedNotice.includes("Kyle") && !storedNotice.includes("monthly-exact"));
    await mountNotice(noticeRows[0]); click("Call or in person"); const noticeBeforeRefresh = refreshes; click("Refresh notice status"); await Promise.resolve();
    c.ok("notice hold survives remount and read-only refresh cannot change its original channel", noticeCalls.length === 1 && refreshes === noticeBeforeRefresh + 1 && !!button("Check and record:  We texted them"));
    noticeResult = deferred(); click("Check and record:  We texted them"); click("Check and record:  We texted them");
    c.ok("explicit notice reconciliation reuses exact cut/channel once and never substitutes a new actor", noticeCalls.length === 2 && noticeCalls[1].id === "monthly-notice" && noticeCalls[1].notice === "our-text");
    noticeResult.reject(new Error("second notice response lost")); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("unknown notice retry retains the guard and makes no false saved claim", markers.size === 1 && status().state === "error" && elements(tree(), "Button")[0].disabled === true);
    noticeResult = deferred(); click("Check and record:  We texted them"); noticeResult.resolve({ ok: false, message: "Current exact cut is unavailable." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("refused notice reconciliation does not clear uncertainty about original attempt", markers.size === 1 && words(tree()).includes("earlier notice record is still unconfirmed") && words(tree()).includes("Current exact cut is unavailable"));
    noticeResult = deferred(); click("Check and record:  We texted them"); noticeResult.resolve({ ok: true, already: true, message: "Already recorded: a call or in person (Original actor)." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("confirmed idempotent receipt preserves actual earlier channel/actor and clears only this guard", !markers.size && status().state === "saved" && words(tree()).includes("a call or in person (Original actor)") && elements(tree(), "Button")[0].disabled === true);
    await mountNotice(noticeRows[1]);
    c.ok("listing follow-up retains all three original notice choices", !!button("Aryeo emailed them") && !!button("We texted them") && !!button("Call or in person") && words(tree()).includes("delivery recorded"));
    noticeResult = deferred(); click("Aryeo emailed them"); noticeResult.resolve({ ok: false, message: "Known no-write refusal." }); await until(() => elements(tree(), "Button")[0].busy === false);
    c.ok("first known refusal preserves exact reason and permits corrected notice recording", !markers.size && words(tree()).includes("Known no-write refusal") && !elements(tree(), "Button")[0].disabled);
    const noticeExit = renderToStaticMarkup(createElement(DeliveryExitSummary, { board: { ...board, ready: [], notTold: [noticeRows[0]] } }));
    c.ok("review-exit monthly notification state names portal handoff without claiming delivery to or approval by client", noticeExit.includes("Portal handoff recorded; client notification owed") && noticeExit.includes("does not establish client approval or receipt") && !noticeExit.includes("video is marked sent"));
    let apiAllowed = true, apiWrites = 0;
    stub(req.resolve("../../src/lib/auth/guards.ts"), { requireAdmin: async () => { if (!apiAllowed) throw new Error("Forbidden"); } });
    stub(req.resolve("../../src/lib/auth/user.ts"), { getCurrentUser: async () => ({ id: "fixture-office", name: "Kyle", impersonating: false }) });
    stub(req.resolve("../../src/lib/deliveryUploads.ts"), { uploadReceiptStatus: async () => ({ ok: true, recorded: true, message: "Original saved receipt" }), recordUploaded: async (id: string, actor: { id: string }, fingerprint: string) => { apiWrites++; return { ok: id === props.submissionId && actor.id === "fixture-office" && fingerprint === "exact-file-v3", message: "Receipt saved" }; } });
    const { POST, GET: uploadGET } = await import("../../src/app/api/ops/video-upload/route");
    const apiRequest = (origin = "https://hub.example.test", body: unknown = { submissionId: props.submissionId, fingerprint: "exact-file-v3" }) => new Request("https://hub.example.test/api/ops/video-upload", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    c.ok("upload API rejects cross-origin requests before any write", (await POST(apiRequest("https://other.example.test"))).status === 403 && apiWrites === 0);
    apiAllowed = false;
    c.ok("upload API enforces office permissions before any write", (await POST(apiRequest())).status === 403 && apiWrites === 0);
    apiAllowed = true;
    c.ok("upload API rejects malformed confirmation before any write", (await POST(apiRequest(undefined, {}))).status === 400 && apiWrites === 0);
    const apiResponse = await POST(apiRequest()), apiReceipt = await apiResponse.json();
    c.ok("upload API returns exact authenticated receipt directly without dashboard render", apiReceipt.ok === true && apiWrites === 1);
    const { confirmedUploadResponse } = await import("../../src/lib/uploadReceiptResponse");
    c.ok("committed upload API publishes a source-bound immediate receipt", confirmedUploadResponse(apiResponse, props.submissionId, "exact-file-v3")?.ok === true && !confirmedUploadResponse(apiResponse, props.submissionId, "other-version") && apiResponse.headers.get("cache-control") === "private, no-store");
    const statusRequest = new Request("https://hub.example.test/api/ops/video-upload?submissionId=exact-cut&fingerprint=exact-source");
    apiAllowed = false;
    c.ok("upload receipt reader preserves office authorization", (await uploadGET(statusRequest)).status === 403 && apiWrites === 1);
    apiAllowed = true;
    c.ok("upload receipt reader requires exact ID and source", (await uploadGET(new Request("https://hub.example.test/api/ops/video-upload"))).status === 400 && apiWrites === 1);
    const readReceipt = await uploadGET(statusRequest);
    c.ok("upload receipt reader is uncached and writes nothing", (await readReceipt.json()).recorded === true && readReceipt.headers.get("cache-control") === "private, no-store" && apiWrites === 1);
    const { POST: sentPOST } = await import("../../src/app/api/ops/video-sent/route");
    const callsBeforeAPI = calls.length;
    c.ok("sent API rejects cross-origin before recording", (await sentPOST(apiRequest("https://other.example.test"))).status === 403 && calls.length === callsBeforeAPI);
    apiAllowed = false;
    c.ok("sent API enforces office permissions", (await sentPOST(apiRequest())).status === 403 && calls.length === callsBeforeAPI);
    apiAllowed = true;
    c.ok("sent API requires exact version before recording", (await sentPOST(apiRequest(undefined, { submissionId: props.submissionId }))).status === 400 && calls.length === callsBeforeAPI);
    result = deferred(); result.resolve({ ok: true, message: "Original exact delivery action" });
    const sentReceipt = await (await sentPOST(apiRequest())).json();
    c.ok("sent API delegates original delivery safeguards and returns direct receipt", sentReceipt.ok === true && calls.length === callsBeforeAPI + 1);
    let groupWrites = 0;
    stub(req.resolve("../../src/lib/projectDelivery.ts"), { markUploadedGroupSent: async () => { groupWrites++; return { ok: true, completed: groupCuts, message: "Recorded" }; } });
    const { POST: projectPOST } = await import("../../src/app/api/ops/project-sent/route");
    const groupRequest = (origin = "https://hub.example.test", body: unknown = { projectId: "group-project", cuts: groupCuts }) => new Request("https://hub.example.test/api/ops/project-sent", { method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    c.ok("group API rejects other origins before writes", (await projectPOST(groupRequest("https://other.example.test"))).status === 403 && groupWrites === 0);
    apiAllowed = false;
    c.ok("group API enforces office roles before writes", (await projectPOST(groupRequest())).status === 403 && groupWrites === 0);
    apiAllowed = true;
    c.ok("group API rejects empty/invalid membership before writes", (await projectPOST(groupRequest(undefined, { projectId: "group-project", cuts: [] }))).status === 400 && groupWrites === 0);
    c.ok("group API returns exact membership receipt uncached", (await (await projectPOST(groupRequest())).json()).completed.length === 2 && groupWrites === 1);
    const attemptId = randomUUID();
    const completeResponse = await projectPOST(groupRequest(undefined, { projectId: "group-project", cuts: groupCuts, attemptId }));
    const { confirmedProjectDeliveryResponse } = await import("../../src/lib/uploadedDeliveryGroups");
    completeResponse.json = () => { throw new Error("Body lost after successful delivery response headers"); };
    c.ok("committed group response confirms its exact attempt without waiting on the body", confirmedProjectDeliveryResponse(completeResponse, "group-project", groupCuts, attemptId)?.completed.length === 2);
    c.ok("group receipt cannot confirm another attempt or project", !confirmedProjectDeliveryResponse(completeResponse, "other-project", groupCuts, attemptId) && !confirmedProjectDeliveryResponse(completeResponse, "group-project", groupCuts, randomUUID()));
    c.ok("isolated UI checks performed no real providers, database action or send", fence.faked.length === groupCalls.length - 1 + destinationCalls && fence.blocked.length === 0);
    c.summary();
  } finally {
    card?.stop();
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window");
    for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
    if (storageBefore) Object.defineProperty(globalThis, "sessionStorage", storageBefore); else Reflect.deleteProperty(globalThis, "sessionStorage");
    fence.restore();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
