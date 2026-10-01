// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Pure clipboard promises and actual CopyButton handlers; no real clipboard,
// credentials, database or provider calls. This is not a browser/focus test.
import { createRequire } from "node:module";
import { isValidElement } from "react";
import { fenceFetch, makeChecker } from "./_harness";
import { CopyButton } from "../../src/components/ui/CopyButton";

type Props = Record<string, unknown>;
function text(tree: unknown): string {
  if (typeof tree === "string") return tree;
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  return isValidElement<Props>(tree) ? text(tree.props.children) : "";
}
function mount(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [], cleanups: (() => void)[] = [];
  let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = initial; return [cells[slot], (next: unknown) => { cells[slot] = next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) { const slot = index++; if (!(slot in cells)) { cells[slot] = deps; effects.push(() => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); } },
  };
  return {
    render() {
      index = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
      react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
      try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return (tree as { props: Props }).props; }
      finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; }
    },
    unmount() { cleanups.splice(0).forEach((cleanup) => cleanup()); },
  };
}
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

async function main() {
  const c = makeChecker(), fence = fenceFetch();
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const originalTimeout = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const timers = new Map<number, () => void>(); let timerId = 0;
  globalThis.setTimeout = ((callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout;
  const setClipboard = (writeText?: (value: string) => Promise<void>) => Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: writeText ? { writeText } : undefined } });
  let value = "Exact fixture\n Keep  spacing. ";
  let label: string | undefined = "Copy text";
  const button = mount(() => CopyButton({ value, label, title: "Copy fixture" }));
  let prevented = 0, stopped = 0;
  const click = (props = button.render()) => (props.onClick as (event: unknown) => Promise<void>)({ preventDefault() { prevented++; }, stopPropagation() { stopped++; } });
  try {
    c.ok("visible label remains part of the native accessible name", button.render()["aria-label"] === "Copy text");
    setClipboard(); await click();
    c.ok("missing clipboard exposes failure without claiming Copied", text(button.render().children).includes("Copy failed") && !text(button.render().children).includes("Copied") && button.render().disabled === false);
    setClipboard(async () => { throw new Error("fixture permission refused"); }); await click();
    c.ok("denied copy is caught with manual-copy recovery and accessible label", String(button.render().title).includes("manually") && String(button.render()["aria-label"]).includes("Copy failed"));
    const writes: string[] = []; let result = deferred();
    setClipboard(async (payload) => { writes.push(payload); return result.promise; });
    const staleHandler = button.render(); const first = click(staleHandler); const duplicate = click(staleHandler);
    c.ok("synchronous guard refuses duplicate handlers while copy is pending", writes.length === 1 && button.render().disabled === true && button.render()["aria-busy"] === true);
    value = "Newer fixture\n Preserve  exact words! "; button.render(); result.resolve(); await first; await duplicate;
    c.ok("late success cannot label the newer value Copied", writes[0] === "Exact fixture\n Keep  spacing. " && !text(button.render().children).includes("Copied") && button.render().disabled === false);
    result = deferred(); const second = click(); result.resolve(); await second;
    c.ok("confirmed success identifies the exact unchanged value", writes[1] === value && text(button.render().children).includes("Copied") && button.render()["aria-label"] === "Copied");
    c.ok("new copy clears the previous receipt timer", timers.size === 1);
    const expire = [...timers.values()][0]; timers.clear(); expire();
    c.ok("success expiry returns to ordinary copy label", text(button.render().children).includes("Copy text") && !text(button.render().children).includes("Copied"));
    result = deferred(); const failing = click(); value = "Third fixture"; button.render(); result.reject(new Error("late refusal")); await failing;
    c.ok("late error belongs only to its requested value", !text(button.render().children).includes("Copy failed") && button.render()["aria-label"] === "Copy text");
    result = deferred(); const last = click(); result.resolve(); await last;
    label = undefined; setClipboard(); await click();
    const iconFailure = button.render();
    c.ok("icon-only callers receive visible failure words, not only a tooltip", (iconFailure.children as unknown[]).some((child) => isValidElement<Props>(child) && child.props.className !== "sr-only" && text(child) === "Copy failed"));
    result = deferred(); setClipboard(async () => result.promise); const finalSuccess = click(); result.resolve(); await finalSuccess; button.unmount();
    c.ok("unmount clears outstanding receipt timer", timers.size === 0);
    c.ok("native copy keeps event isolation and performs no external fetch", prevented === 9 && stopped === 9 && fence.blocked.length === 0);
    c.summary();
  } finally {
    button.unmount(); globalThis.setTimeout = originalTimeout; globalThis.clearTimeout = originalClear;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
    fence.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
