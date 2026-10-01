// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual UI handlers and action outcomes with in-memory dependencies only.
// No database, provider, browser, destructive operation or real message.
import { isValidElement, type ReactElement } from "react";
import { createRequire } from "node:module";
import { installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { CutMoveOption, CutTakeBackInfo } from "../../src/components/review/types";
import type { TakeBackResult } from "../../src/app/review/actions";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((name === "$href" ? typeof tree.props.href === "string" : (typeof type === "string" ? type : type.name) === name) ? [tree] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function contains(tree: unknown, text: string): boolean {
  if (typeof tree === "string") return tree.includes(text);
  if (Array.isArray(tree)) return tree.some((child) => contains(child, text));
  if (!isValidElement<Props>(tree)) return false;
  const type = tree.type as unknown as { name?: string } & ((props: Props) => unknown);
  if (type.name === "TakeBackReceipt") return contains(type(tree.props), text);
  return Object.values(tree.props).some((child) => contains(child, text));
}
function mountHooks(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  const cleanups = new Map<number, (() => void) | undefined>();
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(effect: () => void, deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (!old || deps.some((value, i) => value !== old[i])) { cells[slot] = deps; effects.push(() => { cleanups.get(slot)?.(); cleanups.set(slot, (effect as () => (() => void) | undefined)()); }); } },
    useTransition() { const slot = index++; if (!(slot in cells)) cells[slot] = false; return [cells[slot], (callback: () => Promise<unknown>) => { cells[slot] = true; void callback().finally(() => { cells[slot] = false; }); }]; },
  };
  return () => {
    index = 0;
    const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; }
  };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((resolve) => setTimeout(resolve, 10)); if (!test()) throw new Error("take-back fixture did not settle"); }
const button = (tree: unknown, label: string) => elements(tree, "button").find((e) => contains(e.props.children, label))!.props;
const click = (tree: unknown, label: string) => (button(tree, label).onClick as () => void)();
const type = (props: Props, value: string) => (props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const byLabel = (tree: unknown, label: string) => elements(tree, "input").find((e) => e.props["aria-label"] === label)!.props;
const reasonLabel = "Reason for removing this version";
const noteLabel = "Message for the reviewer on the destination job";
const modal = (tree: unknown) => elements(tree, "ModalDialog")[0].props;
const close = (tree: unknown) => (modal(tree).onCancel as () => void)();
installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { if (!originals.has(file)) originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const actionsFile = req.resolve("../../src/app/review/actions.ts");
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), cryptoBefore = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const markers = new Map<string, string>(); let attemptNumber = 0, storageFails = false;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (key: string) => { if (storageFails) throw new Error("blocked storage"); return markers.get(key) ?? null; }, setItem: (key: string, value: string) => { if (storageFails) throw new Error("blocked storage"); markers.set(key, value); }, removeItem: (key: string) => markers.delete(key) } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => `fixture-attempt-${++attemptNumber}` } });
  let response = deferred<TakeBackResult>();
  let targetResult = deferred<CutMoveOption[]>();
  const calls: { kind: string; args: unknown[] }[] = [];
  let reads = 0, refreshes = 0;
  const nav = req("next/navigation") as { useRouter: () => unknown };
  const oldRouter = nav.useRouter;
  nav.useRouter = () => ({ refresh: () => { refreshes++; } });
  stub(actionsFile, {
    cutMoveTargets: async () => { reads++; return targetResult.promise; },
    removeCut: async (...args: unknown[]) => { calls.push({ kind: "remove", args }); return response.promise; },
    reassignCut: async (...args: unknown[]) => { calls.push({ kind: "move", args }); return response.promise; },
    removeStrandedFinal: async (...args: unknown[]) => { calls.push({ kind: "file", args }); return response.promise; },
  });
  try {
    const { CutTakeBack, CutTakeBackFlags } = await import("../../src/components/review/CutTakeBack");
    const info: CutTakeBackInfo = { submissionId: "exact-cut", round: 4, status: "PENDING", fileName: "exact-v4.mp4", canRemove: true, canMove: true, office: true, finalPath: null, folderSourcePath: null, strandedFinalPath: null, withdrawnAt: null, withdrawnBy: null, withdrawnReason: null, movedFromStreet: null, movedAt: null, movedBy: null };
    function mountCut(current: CutTakeBackInfo = info) {
      const parent = mountHooks(() => CutTakeBack({ info: current, cutLabel: "Fixture cut" }));
      let props: Props;
      const element = elements(parent(), "TakeBackDialog")[0];
      const render = mountHooks(() => (element.type as (p: Props) => unknown)(props));
      return { parent, tree: () => { props = elements(parent(), "TakeBackDialog")[0].props; return render(); } };
    }
    const cut = mountCut();
    c.ok("dialog is mounted but controlled closed, exact cut keyed; no hidden read", modal(cut.tree()).open === false && elements(cut.parent(), "TakeBackDialog")[0].key === info.submissionId && reads === 0);
    click(cut.parent(), "Wrong video?");
    c.ok("open uses shared native dialog with safe initial Close focus", modal(cut.tree()).open === true && elements(cut.tree(), "button").some((e) => e.props["data-modal-initial-focus"] && e.props["aria-label"] === "Close"));
    type(byLabel(cut.tree(), reasonLabel), " Exact reason with  spacing ");
    close(cut.tree());
    c.ok("dirty close asks explicitly and holds repeated Escape without losing words", modal(cut.tree()).holdEscape === true && byLabel(cut.tree(), reasonLabel).value === " Exact reason with  spacing ");
    let closeFocus = 0;
    const focusRef = elements(cut.tree(), "button").find((e) => e.props["aria-label"] === "Close")!.props.ref as { current: { focus: () => void } | null };
    focusRef.current = { focus: () => { closeFocus++; } };
    click(cut.tree(), "Keep editing");
    c.ok("Keep editing removes the close choice and returns focus to its safe Close control", modal(cut.tree()).holdEscape === false && closeFocus === 1 && byLabel(cut.tree(), reasonLabel).value === " Exact reason with  spacing ");
    close(cut.tree()); click(cut.tree(), "Close and keep draft");
    c.ok("close retains mounted exact text", modal(cut.tree()).open === false && byLabel(cut.tree(), reasonLabel).value === " Exact reason with  spacing ");
    click(cut.parent(), "Wrong video?");
    click(cut.tree(), "Remove this version"); // first matching is tab; choose actual destructive arm below
    const arm = () => (elements(cut.tree(), "button").filter((e) => contains(e.props.children, "Remove this version")).at(-1)!.props.onClick as () => void)();
    arm();
    const oldConfirm = button(cut.tree(), "Yes, remove it permanently").onClick as () => void;
    type(byLabel(cut.tree(), reasonLabel), "New exact reason"); oldConfirm();
    c.ok("editing the reason invalidates even a stale destructive confirmation", calls.length === 0 && !contains(cut.tree(), "Yes, remove it permanently"));
    arm(); const confirm = button(cut.tree(), "Yes, remove it permanently").onClick as () => void;
    confirm(); confirm(); close(cut.tree()); type(byLabel(cut.tree(), reasonLabel), "must not replace pending reason");
    c.ok("same-tick duplicate/pending dismiss/input guards preserve exact removal and default Dropbox choice", calls.length === 1 && calls[0].args.join("|") === "exact-cut|New exact reason|false" && modal(cut.tree()).busy === true && modal(cut.tree()).open === true && byLabel(cut.tree(), reasonLabel).value === "New exact reason");
    c.ok("retry marker persists only the opaque attempt for this exact cut", markers.size === 1 && markers.get("ops-cut-takeback-attempt:exact-cut") === "fixture-attempt-1");
    response.resolve({ ok: false, outcome: "refused", message: "Existing exact role refusal" });
    await until(() => contains(cut.tree(), "Existing exact role refusal"));
    c.ok("known refusal disarms and keeps reason without refreshing or claiming success, clearing only its marker", !contains(cut.tree(), "Yes, remove it permanently") && byLabel(cut.tree(), reasonLabel).value === "New exact reason" && refreshes === 0 && markers.size === 0);
    response = deferred(); arm(); const retry = button(cut.tree(), "Yes, remove it permanently").onClick as () => void; retry(); response.reject(new Error("lost response"));
    await until(() => contains(cut.tree(), "The request was not confirmed"));
    retry(); close(cut.tree()); click(cut.tree(), "Close and keep draft"); click(cut.parent(), "Wrong video?"); arm();
    c.ok("lost response remains held across close/reopen and stale callbacks, with exact recovery reference", calls.length === 2 && contains(cut.tree(), "exact-cut") && contains(cut.tree(), "stays blocked in this tab") && !contains(cut.tree(), "Yes, remove it permanently") && refreshes === 0);
    c.ok("recovery uses existing read-only Review Room link, never a fabricated submission route", elements(cut.tree(), "TakeBackReceipt").some((e) => elements((e.type as (p: Props) => unknown)(e.props), "a").some((a) => a.props.href === "/review" && a.props.target === "_blank")));

    const remounted = mountCut(); click(remounted.parent(), "Wrong video?");
    type(byLabel(remounted.tree(), reasonLabel), "Reopened reason");
    const remountArm = () => (elements(remounted.tree(), "button").filter((e) => contains(e.props.children, "Remove this version")).at(-1)!.props.onClick as () => void)();
    remountArm(); click(remounted.tree(), "Yes, remove it permanently");
    c.ok("same-tab full remount synchronously refuses an unknown exact-cut attempt before effects restore its receipt", calls.length === 2 && contains(remounted.tree(), "previous change to this exact version") && markers.get("ops-cut-takeback-attempt:exact-cut") === "fixture-attempt-2");
    const sharedFlags = mountHooks(() => CutTakeBackFlags({ info: { ...info, strandedFinalPath: "/fixture/exact-final.mp4" } }));
    click(sharedFlags(), "Remove it from Dropbox too"); click(sharedFlags(), "Yes, delete that file");
    c.ok("dialog uncertainty also holds the separate file-delete control for the same cut", calls.length === 2 && contains(sharedFlags(), "previous change to this exact version"));

    const moving = mountCut({ ...info, submissionId: "move-cut" }); click(moving.parent(), "Wrong video?"); click(moving.tree(), "Move to another job");
    const opts: CutMoveOption[] = [{ projectId: "exact-target", street: "Fixture target", clientName: "Fixture account", status: "EDITING", shootDateISO: null }];
    moving.tree(); await until(() => reads > 0); targetResult.reject(new Error("read lost"));
    await until(() => contains(moving.tree(), "Jobs could not be loaded"));
    c.ok("failed target read is not a false empty list and cannot move", !contains(moving.tree(), "No job matches") && button(moving.tree(), "Pick a job first").disabled === true);
    targetResult = deferred(); click(moving.tree(), "Retry job list"); moving.tree(); await until(() => reads > 1); targetResult.resolve(opts);
    await until(() => contains(moving.tree(), "Fixture target")); click(moving.tree(), "Fixture target"); type(byLabel(moving.tree(), noteLabel), " Exact move message  ");
    close(moving.tree()); click(moving.tree(), "Close and keep draft");
    c.ok("close retains selected target and exact move message", byLabel(moving.tree(), noteLabel).value === " Exact move message  " && contains(moving.tree(), "Move it to Fixture target"));
    click(moving.parent(), "Wrong video?"); moving.tree(); await until(() => button(moving.tree(), "Move it to Fixture target").disabled === false);
    response = deferred(); click(moving.tree(), "Move it to Fixture target"); response.resolve({ ok: true, outcome: "confirmed", message: "Moved; the approved source file remains for Kyle to check." });
    await until(() => contains(moving.tree(), "approved source file remains"));
    c.ok("confirmed move retains server file receipt and cannot repeat while current context refreshes; exact terminal marker clears", calls.at(-1)?.kind === "move" && calls.at(-1)?.args.join("|") === "move-cut|exact-target| Exact move message  " && modal(moving.tree()).open === true && button(moving.tree(), "Move it to Fixture target").disabled === true && refreshes === 1 && !markers.has("ops-cut-takeback-attempt:move-cut"));
    const editor = mountCut({ ...info, office: false, canMove: false, finalPath: "/fixture/final.mp4" }); click(editor.parent(), "Wrong video?");
    c.ok("old-round/editor presentation never offers move or office Dropbox option", !contains(editor.tree(), "Move to another job") && !contains(editor.tree(), "also delete the finished file"));
    const denied = mountHooks(() => CutTakeBack({ info: { ...info, canRemove: false }, cutLabel: "Fixture cut" }));
    c.ok("existing remove permission still decides trigger visibility", denied() === null);

    const flags = mountHooks(() => CutTakeBackFlags({ info: { ...info, submissionId: "file-cut", strandedFinalPath: "/fixture/exact-final.mp4" } }));
    click(flags(), "Remove it from Dropbox too"); response = deferred(); const filePress = button(flags(), "Yes, delete that file").onClick as () => void; filePress(); filePress(); response.resolve({ ok: false, outcome: "unknown", message: "Provider result unknown" });
    await until(() => contains(flags(), "Provider result unknown")); filePress();
    c.ok("leftover-file two-step preserves exact ID and holds unknown provider deletion", calls.filter((x) => x.kind === "file").length === 1 && calls.at(-1)?.args.join() === "file-cut" && button(flags(), "Remove it from Dropbox too").disabled === true);
    const replaced = mountHooks(() => CutTakeBackFlags({ info: { ...info, submissionId: "replacement-cut", strandedFinalPath: "/fixture/exact-final.mp4" } }));
    click(replaced(), "Remove it from Dropbox too"); response = deferred(); click(replaced(), "Yes, delete that file");
    markers.set("ops-cut-takeback-attempt:replacement-cut", "newer-opaque-attempt");
    response.resolve({ ok: false, outcome: "refused", message: "Exact prior refusal" }); await until(() => contains(replaced(), "Exact prior refusal"));
    click(replaced(), "Remove it from Dropbox too"); click(replaced(), "Yes, delete that file");
    c.ok("older terminal response cannot clear a different marker or dispatch another write", markers.get("ops-cut-takeback-attempt:replacement-cut") === "newer-opaque-attempt" && calls.filter((x) => x.kind === "file").length === 2 && contains(replaced(), "previous change to this exact version"));
    const blockedStorage = mountHooks(() => CutTakeBackFlags({ info: { ...info, submissionId: "storage-cut", strandedFinalPath: "/fixture/exact-final.mp4" } }));
    click(blockedStorage(), "Remove it from Dropbox too"); storageFails = true; click(blockedStorage(), "Yes, delete that file"); storageFails = false;
    c.ok("unavailable recovery storage refuses before any file mutation", contains(blockedStorage(), "No request was made") && calls.filter((x) => x.kind === "file").length === 2);

    // Actual action wrapper paths; all data and provider calls are pure fakes.
    delete req.cache[actionsFile];
    let user: { realRole: string; role: string; name: string; editorKey?: string; impersonating?: boolean } | null = { realRole: "OWNER", role: "OWNER", name: "Fixture owner" };
    let stored: Record<string, unknown> | null = { id: "exact-cut", projectId: "fixture-project", status: "UPLOADING", submittedByKey: "editor", strandedFinalPath: null };
    let readFails = false, providerFails = false, revalidateFails = false, fileDeletes = 0, dbWrites = 0;
    stub(req.resolve("../../src/lib/prisma.ts"), { prisma: { reviewSubmission: {
      findUnique: async () => { if (readFails) throw new Error("fake read failure"); return stored; },
      update: async () => { dbWrites++; return {}; },
    }, smartTask: { findUnique: async () => null }, activity: { create: async () => { dbWrites++; return {}; } } } });
    stub(req.resolve("../../src/lib/auth/user.ts"), { getCurrentUser: async () => user });
    stub(req.resolve("../../src/lib/auth/guards.ts"), { authEnforced: () => true, requireAdmin: async () => { if (user?.realRole !== "OWNER" && user?.realRole !== "ADMIN") throw new Error("Office only"); } });
    stub(req.resolve("../../src/lib/actorName.ts"), { displayNameFor: async () => "Fixture owner" });
    stub(req.resolve("../../src/lib/integrations/dropbox.ts"), { __esModule: true, dropboxDelete: async () => { fileDeletes++; if (providerFails) throw new Error("fake provider timeout"); } });
    const cache = req("next/cache") as { revalidatePath: () => void };
    cache.revalidatePath = () => { if (revalidateFails) throw new Error("fake post-write revalidation failure"); };
    const real = await import("../../src/app/review/actions");
    const prewrite = await real.removeCut("exact-cut", "Exact reason");
    c.ok("real guard annotates existing upload refusal without any write", prewrite.outcome === "refused" && prewrite.message.includes("still uploading") && fileDeletes === 0 && dbWrites === 0);
    stored = { ...stored, status: "APPROVED" }; user = { realRole: "EDITOR", role: "EDITOR", name: "Fixture editor", editorKey: "editor" };
    const approved = await real.removeCut("exact-cut", "Exact reason", true);
    c.ok("approved-cut editor restriction survives receipt annotation", approved.outcome === "refused" && approved.message.includes("Jordan has already approved") && fileDeletes === 0 && dbWrites === 0);
    user = null; let readRefused = false; try { await real.cutMoveTargets("exact-cut", ""); } catch { readRefused = true; }
    c.ok("unauthorized target read rejects instead of claiming an empty authorized list", readRefused);
    user = { realRole: "OWNER", role: "OWNER", name: "Fixture owner" }; readFails = true;
    const failed = await real.removeCut("exact-cut", "Exact reason");
    c.ok("unexpected action exception cannot promise no changes or enable blind retry", failed.outcome === "unknown" && !failed.message.includes("nothing was changed") && fileDeletes === 0);
    readFails = false; stored = null; readRefused = false; try { await real.cutMoveTargets("exact-cut", ""); } catch { readRefused = true; }
    c.ok("missing current cut is not misreported as no matching target jobs", readRefused);
    stored = { id: "exact-cut", projectId: "fixture-project", strandedFinalPath: "/fixture/exact-final.mp4", movedFromProjectId: null };
    providerFails = true; const uncertain = await real.removeStrandedFinal("exact-cut");
    c.ok("provider throw is explicitly unknown, not a pre-write refusal", uncertain.outcome === "unknown" && fileDeletes === 1 && dbWrites === 0 && !uncertain.message.includes("try again"), JSON.stringify({ uncertain, fileDeletes, dbWrites }));
    providerFails = false; revalidateFails = true; const partial = await real.removeStrandedFinal("exact-cut");
    c.ok("post-provider write/revalidation exception remains unknown after exactly one call", partial.outcome === "unknown" && fileDeletes === 2 && dbWrites === 2 && !partial.message.includes("nothing was changed"), JSON.stringify({ partial, fileDeletes, dbWrites }));
    revalidateFails = false; stored = { ...stored, strandedFinalPath: null }; const none = await real.removeStrandedFinal("exact-cut");
    c.ok("confirmed no-leftover response retains original semantics without provider call", none.ok && none.outcome === "confirmed" && fileDeletes === 2, JSON.stringify({ none, fileDeletes, dbWrites }));
    c.ok("fixture invokes no real provider/database/network", fence.blocked.length === 0);
    c.summary();
  } finally { nav.useRouter = oldRouter; for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; } if (storageBefore) Object.defineProperty(globalThis, "sessionStorage", storageBefore); else Reflect.deleteProperty(globalThis, "sessionStorage"); if (cryptoBefore) Object.defineProperty(globalThis, "crypto", cryptoBefore); else Reflect.deleteProperty(globalThis, "crypto"); fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
