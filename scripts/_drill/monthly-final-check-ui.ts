// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual final-check component handlers with fully fake server actions.
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fenceFetch, makeChecker } from "./_harness";
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

type Result = { ok: boolean; message: string; outcome?: "confirmed" | "refused" | "unknown" };
type ChoicesResult = { ok: boolean; message: string; choices: { id: string; title: string; url: string; duration: number | null }[] };
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) } });
  let result = deferred<Result>(), receipt = deferred<{ ok: boolean; message: string }>(), writes = 0, receiptReads = 0;
  const originalChoices: ChoicesResult = { ok: true, message: "Exact portal final bytes read.", choices: [{ id: "exact-fingerprint", title: "Topic final", url: "/api/review/cut/fixture/final?f=exact", duration: null }] };
  let choiceRead: Promise<ChoicesResult> | null = null;
  const payloads: FormData[] = [];
  const file = req.resolve("../../src/app/ops/finalRenditionActions.ts");
  req.cache[file] = { id: file, filename: file, loaded: true, exports: {
    finalFileChoicesAction: async () => choiceRead ?? originalChoices,
    recordFinalFileCheckAction: async (f: FormData) => { writes++; payloads.push(f); return result.promise; },
    readFinalFileCheckReceiptAction: async () => { receiptReads++; return receipt.promise; },
  } } as NodeModule;
  const { FinalRenditionCheck } = await import("@/components/ops/FinalRenditionCheck");
  const props = { submissionId: "fixture-cut", label: "Topic", round: 2, monthly: true };
  let card = mountHooks(() => FinalRenditionCheck(props));
  const tree = () => card.render();
  const button = (label: string) => elements(tree(), "button").find((p) => contains(p.children, label));
  const click = (label: string) => (button(label)!.onClick as () => unknown)();
  const form = () => elements(tree(), "form")[0];
  const ticks = () => elements(tree(), "input").filter((p) => p.type === "checkbox");
  const tickAll = () => { for (const tick of ticks()) (tick.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } }); };
  const checkedCount = () => ticks().filter((p) => p.checked === true).length;
  const submit = () => { const data = new FormData(); for (const tick of ticks()) if (tick.checked) data.set(String(tick.name), String(tick.value)); return (form().action as (f: FormData) => unknown)(data); };
  const select = () => elements(tree(), "select")[0];
  const change = (v: string) => (select().onChange as (e: { target: { value: string } }) => void)({ target: { value: v } });
  const mount = async () => { card.stop(); card = mountHooks(() => FinalRenditionCheck(props)); card.render(); await Promise.resolve(); };
  try {
    tree(); await Promise.resolve(); click("Check client-viewable file"); await until(() => select().value === "exact-fingerprint");
    tickAll();
    const originalVideo = elements(tree(), "video")[0];
    (originalVideo.onLoadedMetadata as (e: { currentTarget: { duration: number; videoWidth: number; videoHeight: number } }) => void)({ currentTarget: { duration: 30, videoWidth: 1920, videoHeight: 1080 } });
    click("Read current final file"); await until(() => button("Read current final file")?.disabled === false);
    c.ok("rereading the same exact file preserves all six attestations and its metadata", checkedCount() === 6 && contains(tree(), "1920×1080"));
    change("exact-fingerprint");
    c.ok("selecting the same exact identity does not clear its checks", checkedCount() === 6);
    choiceRead = Promise.resolve({ ...originalChoices, choices: [{ ...originalChoices.choices[0], id: "replacement-fingerprint", url: "/api/review/cut/fixture/final?f=replacement" }] });
    click("Read current final file"); await until(() => select().value === "replacement-fingerprint");
    c.ok("a newly read final fingerprint clears exactly the six old-file attestations", checkedCount() === 0 && ticks().length === 6 && contains(tree(), "Browser metadata not confirmed"));
    (originalVideo.onLoadedMetadata as (e: { currentTarget: { duration: number; videoWidth: number; videoHeight: number } }) => void)({ currentTarget: { duration: 30, videoWidth: 1920, videoHeight: 1080 } });
    c.ok("a replaced player's late metadata cannot describe the newly selected final", contains(tree(), "Browser metadata not confirmed") && !contains(tree(), "1920×1080"));
    tickAll(); change("");
    c.ok("deliberately changing file selection clears checks without unmounting the form", select().value === "" && checkedCount() === 0 && form().hidden === false && ticks().length === 6);
    change("replacement-fingerprint"); tickAll();
    const lateChoices = deferred<ChoicesResult>(); choiceRead = lateChoices.promise;
    click("Read current final file"); change(""); lateChoices.resolve(originalChoices);
    await until(() => contains(tree(), "Your newer file choice is kept"));
    c.ok("an older read response cannot replace a newer native file choice", select().value === "" && checkedCount() === 0 && elements(tree(), "option").some((o) => o.value === "replacement-fingerprint"));
    choiceRead = null; click("Read current final file"); await until(() => select().value === "exact-fingerprint"); tickAll();
    const at = writes; submit(); submit(); change("later-selected-version");
    c.ok("actual handler synchronously serializes exact save while later native selection stays editable", writes === at + 1 && payloads.at(-1)?.get("mediaId") === "exact-fingerprint" && payloads.at(-1)?.get("identity") === "yes" && select().value === "later-selected-version" && checkedCount() === 0 && button("Record final-file check")?.disabled === true);
    result.resolve({ ok: true, outcome: "confirmed", message: "Exact earlier check recorded." }); await until(() => contains(tree(), "later form changes"));
    c.ok("older successful check preserves newer input and does not mark its draft as saved", select().value === "later-selected-version" && button("Record final-file check")?.disabled === false && !storage.size);
    change("exact-fingerprint"); result = deferred(); submit(); result.reject(new Error("lost response after commit")); await until(() => contains(tree(), "earlier save is unconfirmed"));
    const heldWrites = writes; change("newer-native-choice"); tickAll(); submit();
    c.ok("unknown result holds blind replay without resetting later selection or falsely claiming no save", writes === heldWrites && select().value === "newer-native-choice" && button("Record final-file check")?.disabled === true && contains(tree(), "does not prove the request ended"));
    c.ok("opaque refresh guard has UUID only and no identity/file/input/body", storage.size === 1 && /^[a-f0-9-]{36}$/i.test([...storage.values()][0]) && ![...storage.values()].join().includes("newer") && ![...storage.values()].join().includes("Topic"));
    receipt = deferred(); click("Check earlier save receipt"); receipt.resolve({ ok: false, message: "Not confirmed yet; inspect office history." }); await until(() => contains(tree(), "Not confirmed yet")); submit();
    c.ok("missing receipt cannot prove stopped writer or release unknown hold", receiptReads === 1 && writes === heldWrites && button("Record final-file check")?.disabled === true && select().value === "newer-native-choice" && checkedCount() === 6);
    receipt = deferred(); click("Check earlier save receipt"); receipt.resolve({ ok: true, message: "This exact check was recorded." }); await until(() => contains(tree(), "Current form edits are kept"));
    c.ok("matching saved receipt releases exact hold while preserving current unsaved form", !storage.size && select().value === "newer-native-choice" && checkedCount() === 6 && button("Record final-file check")?.disabled === false);
    result = deferred(); submit(); result.resolve({ ok: false, outcome: "refused", message: "Known stale file refusal." }); await until(() => contains(tree(), "Known stale file refusal"));
    c.ok("known prewrite refusal keeps deliberate retry available with the typed input", select().value === "newer-native-choice" && checkedCount() === 6 && button("Record final-file check")?.disabled === false && !storage.size);
    result = deferred(); submit(); result.resolve({ ok: true, message: "Legacy result without evidence." }); await until(() => contains(tree(), "earlier save is unconfirmed")); await mount(); submit();
    c.ok("legacy or refresh cannot unlock unknown request; recovery is visible and no draft survival promised", writes === heldWrites + 2 && button("Record final-file check")?.disabled === true && contains(tree(), "Unsaved form text is not restored") && button("Check earlier save receipt") !== undefined && form().hidden === false);
    storage.clear(); await mount(); click("Check client-viewable file"); await until(() => select().value === "exact-fingerprint"); result = deferred(); submit(); const other = randomUUID(); storage.set("rtp:final-check:fixture-cut", other); result.resolve({ ok: true, outcome: "confirmed", message: "Earlier exact save recorded." }); await until(() => contains(tree(), "Earlier exact save recorded")); submit();
    c.ok("late terminal response cannot erase a different opaque attempt marker", storage.get("rtp:final-check:fixture-cut") === other && button("Record final-file check")?.disabled === true);
    storage.clear(); await mount(); click("Check client-viewable file"); await until(() => select().value === "exact-fingerprint");
    const beforePrep = writes, uuid = crypto.randomUUID; try { crypto.randomUUID = () => { throw new Error("fixture prep error"); }; submit(); } finally { crypto.randomUUID = uuid; }
    c.ok("local preparation failure starts no request and keeps current form retryable", writes === beforePrep && !storage.size && button("Record final-file check")?.disabled === false && contains(tree(), "Nothing was submitted"));
    tickAll(); click("Close final check"); const hiddenForm = form();
    c.ok("folding the check preserves mounted native answers rather than removing the form", hiddenForm.hidden === true && ticks().length === 6 && checkedCount() === 6);
    const html = renderToStaticMarkup(tree() as ReactNode);
    c.ok("named native controls retain readable focus and 44px targets with portal/backup terminology", html.includes("client portal") && html.includes("final Dropbox") && !html.includes("After upload") && html.includes('name="identity"') && html.includes("min-h-11") && html.includes("focus-visible:outline"));
    c.ok("component handler fixture invokes no real database/provider or client send", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { card.stop(); fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
