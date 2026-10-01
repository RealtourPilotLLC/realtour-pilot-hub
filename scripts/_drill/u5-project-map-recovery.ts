// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Real map-panel event handlers with deferred in-memory read providers. No
// browser, database boot, tiles, geocoding, routing or weather request is made.
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { createRequire } from "node:module";
import { fenceFetch, installNextStubs, makeChecker } from "./_harness";
import type { MapPin } from "../../src/components/map/ProjectMap";
import type { Weather, DriveInfo } from "../../src/lib/travel";

type Props = Record<string, unknown>;
type AddressChoice = { lat: number; lng: number; label: string };
type Call = { kind: string; args: unknown[]; result: ReturnType<typeof deferred<unknown>> };
function elements(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function text(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (!isValidElement<Props>(tree)) return "";
  const type = tree.type as unknown as { name?: string } & ((p: Props) => unknown);
  if (type.name === "DriveLine") return text(type(tree.props));
  return text(tree.props.children);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mountHooks(render: () => unknown, skipMapInit = false) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [];
  const cleanups = new Map<number, () => void>();
  let index = 0, mounted = true;
  const changed = (old: unknown[] | undefined, deps: unknown[]) => !old || old.length !== deps.length || deps.some((value, i) => value !== old[i]);
  const dispatcher = {
    useState(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = typeof initial === "function" ? initial() : initial; return [cells[slot], (next: unknown) => { if (mounted) cells[slot] = typeof next === "function" ? next(cells[slot]) : next; }]; },
    useRef(initial: unknown) { const slot = index++; if (!(slot in cells)) cells[slot] = { current: initial }; return cells[slot]; },
    useId() { const slot = index++; if (!(slot in cells)) cells[slot] = `map-fixture-${slot}`; return cells[slot]; },
    useMemo(factory: () => unknown, deps: unknown[]) { const slot = index++, old = cells[slot] as { deps: unknown[]; value: unknown } | undefined; if (!old || changed(old.deps, deps)) cells[slot] = { deps, value: factory() }; return (cells[slot] as { value: unknown }).value; },
    useCallback(callback: unknown, deps: unknown[]) { return dispatcher.useMemo(() => callback, deps); },
    useEffect(effect: () => (() => void) | void, deps: unknown[]) { const slot = index++, old = cells[slot] as unknown[] | undefined; if (changed(old, deps)) { cells[slot] = deps; effects.push(() => { cleanups.get(slot)?.(); const cleanup = skipMapInit && String(effect).includes("leaflet") ? undefined : effect(); if (cleanup) cleanups.set(slot, cleanup); else cleanups.delete(slot); }); } },
  };
  const draw = () => {
    if (!mounted) throw new Error("Fixture rendered a removed pin panel");
    index = 0;
    const previous = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((effect) => effect()); return tree; }
    finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = previous; }
  };
  return { draw, snapshot: () => [...cells], unmount: () => { mounted = false; cleanups.forEach((cleanup) => cleanup()); cleanups.clear(); } };
}
const input = (tree: unknown) => elements(tree, "input")[0].props;
const button = (tree: unknown, label: string) => elements(tree, "button").find((element) => text(element.props.children).includes(label))!.props;
const click = (tree: unknown, label: string) => (button(tree, label).onClick as () => void)();
const change = (tree: unknown, value: string) => (input(tree).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const focus = (tree: unknown) => (input(tree).onFocus as () => void)();
const blur = (tree: unknown) => (input(tree).onBlur as () => void)();
function key(tree: unknown, value: string, composing = false) {
  let prevented = false;
  (input(tree).onKeyDown as (event: unknown) => void)({ key: value, nativeEvent: { isComposing: composing }, preventDefault: () => { prevented = true; } });
  return prevented;
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

installNextStubs();
async function main() {
  const c = makeChecker(), req = createRequire(__filename), fence = fenceFetch();
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const calls: Call[] = [];
  const fake = (kind: string) => (...args: unknown[]) => { const result = deferred<unknown>(); calls.push({ kind, args, result }); return result.promise; };
  stub(req.resolve("../../src/app/map/actions.ts"), { projectWeather: fake("weather"), driveInfo: fake("drive"), distanceToAddress: fake("distance"), addressSuggestions: fake("suggest") });
  stub(req.resolve("leaflet/dist/leaflet.css"), {});
  stub(req.resolve("leaflet"), { __esModule: true, default: {} });
  stub(req.resolve("../../src/lib/territories.ts"), { getTerritories: () => [], territoriesContaining: () => [], covers: () => false });
  stub(req.resolve("../../src/components/project/DroneAdvisory.tsx"), { DroneAdvisory: () => null });
  const dom = req("react-dom") as { createPortal: (children: ReactNode, container: unknown) => unknown };
  const originalPortal = dom.createPortal;
  dom.createPortal = (children) => createElement("portal-fixture", {}, children);
  const originalWindow = globalThis.window, originalDocument = globalThis.document;
  Object.assign(globalThis, { window: { addEventListener: () => {}, removeEventListener: () => {} }, document: { body: {} } });
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  const suggestionTimers = new Map<number, () => unknown>(); let timerId = 100000;
  globalThis.setTimeout = ((callback: () => unknown, ms?: number, ...args: unknown[]) => {
    if (ms === 300) { suggestionTimers.set(++timerId, callback); return timerId; }
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => { if (!suggestionTimers.delete(Number(id))) originalClearTimeout(id); }) as typeof clearTimeout;
  const flushSuggestion = async () => { const jobs = [...suggestionTimers.values()]; suggestionTimers.clear(); jobs.forEach((job) => { void job(); }); await settle(); };
  const last = (kind: string) => calls.findLast((call) => call.kind === kind)!;
  const count = (kind: string) => calls.filter((call) => call.kind === kind).length;
  const pinA: MapPin = { id: "appointment-A", projectId: "project-A", title: "First exact address", lat: 40.1, lng: -75.1, color: "#123456", stage: "Shooting", client: "First client", shootISO: "2026-10-02T12:00:00Z", endISO: null, photographer: "Creative A" };
  const pinB = { ...pinA, id: "appointment-B", projectId: "project-B", title: "Second exact address", lat: 41.2, lng: -76.2, client: "Second client" };
  const home = { lat: 39.2, lng: -74.2, label: "Home" };
  const weather = (label: string): Weather => ({ tempF: 70, code: 0, label, emoji: "☀️" });
  const drive = (miles: number): DriveInfo => ({ miles, minutes: 20, cost: miles * 0.65 });
  const choiceA = { lat: 42.1, lng: -77.1, label: "First exact suggestion" }, choiceB = { lat: 42.2, lng: -77.2, label: "Second exact suggestion" };
  const mounted: ReturnType<typeof mountHooks>[] = [];
  try {
    const { ProjectMap } = await import("../../src/components/map/ProjectMap");
    let rootPins = [pinA];
    // The canvas/Leaflet initializer needs a browser DOM; this focused handler
    // fixture omits that one effect and exercises selection/read effects.
    const root = mountHooks(() => ProjectMap({ pins: rootPins, home }), true); mounted.push(root);
    let rootTree = root.draw(); rootTree = root.draw();
    const detailElement = elements(rootTree, "PinDetail")[0];
    const detailType = detailElement.type as (props: Props) => ReactElement<Props>;
    let detailProps = detailElement.props, panelElement = detailType(detailProps);
    const panelType = panelElement.type as (props: Props) => unknown;
    let panel = mountHooks(() => panelType(panelElement.props)); mounted.push(panel);
    const draw = () => {
      let tree = panel.draw();
      const box = elements(tree, "div").find((element) => element.props.ref && typeof element.props.ref === "object");
      if (box) (box.props.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ left: 10, bottom: 20, width: 300 }) };
      tree = panel.draw(); return tree;
    };
    const replacePin = (pin: MapPin) => {
      const oldKey = panelElement.key;
      detailProps = { ...detailProps, pin };
      panelElement = detailType(detailProps);
      if (panelElement.key !== oldKey) { panel.unmount(); panel = mountHooks(() => panelType(panelElement.props)); mounted.push(panel); }
      return draw();
    };
    draw(); const weatherA = last("weather");
    c.ok("weather reads retain the exact project ID and start with readable loading status", weatherA.args.join() === "project-A" && text(draw()).includes("Loading weather"));
    replacePin(pinB); const weatherB = last("weather");
    weatherB.result.resolve(weather("Current B weather")); await settle(); weatherA.result.resolve(weather("Stale A weather")); await settle();
    c.ok("late weather for a replaced pin never appears on the current selected shoot", weatherB.args.join() === "project-B" && text(draw()).includes("Current B weather") && !text(draw()).includes("Stale A weather"));
    replacePin({ ...pinB, lat: 41.3 }); last("weather").result.resolve(null); await settle();
    c.ok("null weather is described as unavailable rather than a known provider failure", text(draw()).includes("Weather is unavailable for this shoot"));
    replacePin(pinA); last("weather").result.reject(new Error("fake weather read failed")); await settle();
    c.ok("thrown weather reads settle with visible current-shoot feedback", text(draw()).includes("Weather could not be loaded for this shoot") && !text(draw()).includes("Loading weather"));
    let tree = draw(); const addressInput = input(tree), addressLabel = elements(tree, "label")[0].props;
    c.ok("address field has an associated visible name and distance calculation has a visible button name", addressLabel.htmlFor === addressInput.id && addressInput.role === "combobox" && Boolean(button(tree, "Calculate distance")));
    const homeClick = button(tree, "Drive to home base").onClick as () => void, beforeHome = count("drive"); homeClick(); homeClick();
    const homeA = last("drive");
    c.ok("home drive uses exact pin/home coordinates and blocks same-tick duplicate reads", count("drive") === beforeHome + 1 && homeA.args.join() === "40.1,-75.1,39.2,-74.2" && button(draw(), "Drive to home base").disabled === true);
    replacePin(pinB); click(draw(), "Drive to home base"); const homeB = last("drive");
    homeA.result.resolve(drive(99)); await settle(); homeB.result.resolve(drive(12)); await settle();
    c.ok("late home route for an old pin cannot become the new pin's drive receipt", text(draw()).includes("12.0 mi") && !text(draw()).includes("99.0 mi"));
    click(draw(), "Drive to home base"); const staleHome = last("drive");
    change(draw(), "Kept home-change address"); const weatherBeforeHomeChange = count("weather");
    detailProps = { ...detailProps, home: { ...home, lat: 38.5 } }; panelElement = detailType(detailProps); draw();
    staleHome.result.resolve(drive(77)); await settle();
    c.ok("changed home coordinates invalidate only the home-drive context", !text(draw()).includes("77.0 mi") && count("weather") === weatherBeforeHomeChange && input(draw()).value === "Kept home-change address");
    click(draw(), "Drive to home base"); last("drive").result.reject(new Error("fake drive failed")); await settle();
    c.ok("current failed home read reports feedback and allows a deliberate read retry", text(draw()).includes("drive to home base could not be loaded") && !button(draw(), "Drive to home base").disabled);

    focus(draw()); change(draw(), "Old query"); draw(); await flushSuggestion(); const oldSuggestion = last("suggest");
    change(draw(), "New query"); draw(); await flushSuggestion(); const newSuggestion = last("suggest");
    newSuggestion.result.resolve([choiceA, choiceB]); await settle(); draw(); draw(); oldSuggestion.result.resolve([{ ...choiceA, label: "Stale suggestion" }]); await settle();
    c.ok("out-of-order address suggestions stay attached to the exact newer query", newSuggestion.args.join() === "New query" && elements(draw(), "li").length === 2 && !text(draw()).includes("Stale suggestion"));
    const listElement = elements(draw(), "ul").find((element) => element.props.role === "listbox")!;
    const listGeometry = {
      scrollTop: 0, clientTop: 1, clientHeight: 224,
      getBoundingClientRect: () => ({ top: 10 }),
      children: { item: (i: number) => ({ getBoundingClientRect: () => ({ top: (i ? 211 : 11) - listGeometry.scrollTop, bottom: (i ? 411 : 111) - listGeometry.scrollTop, height: i ? 200 : 100 }) }) },
    };
    (listElement.props.ref as { current: unknown }).current = listGeometry;
    const down = key(draw(), "ArrowDown"); tree = draw();
    c.ok("ArrowDown selects an announced listbox option while input retains focus", down && input(tree)["aria-expanded"] === true && input(tree)["aria-activedescendant"] === elements(tree, "li")[0].props.id && elements(tree, "li")[0].props["aria-selected"] === true);
    key(draw(), "ArrowDown"); draw();
    c.ok("keyboard-active wrapped option scrolls into view within its own list only", listGeometry.scrollTop === 176);
    key(draw(), "ArrowUp"); draw();
    c.ok("keyboard movement back to an earlier option restores its visible list position", listGeometry.scrollTop === 0);
    key(draw(), "ArrowUp");
    c.ok("arrow-key movement is bounded and supports previous option selection", input(draw())["aria-activedescendant"] === elements(draw(), "li")[0].props.id);
    const beforeDistance = count("distance"), beforePickDrive = count("drive"); key(draw(), "Enter");
    c.ok("Enter routes directly to the selected suggestion without a second geocode", input(draw()).value === choiceA.label && count("distance") === beforeDistance && count("drive") === beforePickDrive + 1 && last("drive").args.join() === "41.2,-76.2,42.1,-77.1");
    last("drive").result.resolve(drive(4)); await settle();
    c.ok("suggestion distance retains exact chosen label and mileage display definitions", text(draw()).includes(choiceA.label) && text(draw()).includes("4.0 mi") && text(draw()).includes("@ $0.65/mi"));
    change(draw(), "Pointer query"); draw(); await flushSuggestion(); last("suggest").result.resolve([choiceB]); await settle(); draw(); draw();
    const pointer = elements(draw(), "li")[0], pointerButton = elements(pointer, "button")[0].props;
    let pointerPrevented = false; (pointerButton.onPointerDown as (event: unknown) => void)({ preventDefault: () => { pointerPrevented = true; } });
    const beforePointer = count("drive"); (pointerButton.onClick as () => void)();
    c.ok("pointer suggestion selection prevents input blur then works through native click", pointerPrevented && input(draw()).value === choiceB.label && count("drive") === beforePointer + 1);
    last("drive").result.reject(new Error("fake chosen-address route failed")); await settle();
    c.ok("chosen-address read error preserves the exact address and reports a scoped failure", input(draw()).value === choiceB.label && text(draw()).includes("Your chosen address is kept"));
    change(draw(), choiceA.label); draw(); await flushSuggestion(); last("suggest").result.resolve([choiceA]); await settle(); draw(); draw();
    key(draw(), "ArrowDown"); key(draw(), "Enter"); draw();
    const beforeNextLabel = count("suggest");
    change(draw(), "New words after same-label pick"); draw(); await flushSuggestion();
    c.ok("same-label suggestion pick never suppresses the next newer-input lookup", count("suggest") === beforeNextLabel + 1 && last("suggest").args.join() === "New words after same-label pick");
    last("suggest").result.resolve([]); await settle();
    change(draw(), "Shortening query"); draw(); await flushSuggestion(); const longSuggestion = last("suggest"); change(draw(), "No"); draw(); longSuggestion.result.resolve([choiceA]); await settle();
    c.ok("shortening a query invalidates older pending suggestions instead of reopening them", elements(draw(), "li").length === 0 && input(draw()).value === "No");
    change(draw(), "Blur query"); draw(); await flushSuggestion(); const blurSuggestion = last("suggest"); blur(draw()); draw(); blurSuggestion.result.resolve([choiceA]); await settle();
    c.ok("blur closes suggestions without selecting and late results cannot reopen the menu", elements(draw(), "li").length === 0 && input(draw()).value === "Blur query");
    focus(draw()); draw(); await flushSuggestion(); const escapeSuggestion = last("suggest"); key(draw(), "Escape"); escapeSuggestion.result.resolve([choiceA]); await settle();
    c.ok("Escape cancels menu results while preserving the typed address", elements(draw(), "li").length === 0 && input(draw()).value === "Blur query");
    change(draw(), "Empty suggestions"); draw(); await flushSuggestion(); last("suggest").result.resolve([]); await settle();
    c.ok("empty suggestion results are truthful returned-result feedback, not a proven address absence", text(draw()).includes("No address suggestions were returned") && !text(draw()).includes("No matching addresses"));
    change(draw(), "Failed suggestions"); draw(); await flushSuggestion(); last("suggest").result.reject(new Error("fake suggestions failed")); await settle();
    c.ok("thrown suggestion read offers full-address calculation and retains exact input", text(draw()).includes("Address suggestions could not be loaded") && input(draw()).value === "Failed suggestions");
    change(draw(), "Stale button query"); draw(); await flushSuggestion(); last("suggest").result.resolve([choiceA]); await settle(); draw(); draw();
    const staleSuggestionClick = elements(elements(draw(), "li")[0], "button")[0].props.onClick as () => void;
    change(draw(), " Newer exact address  "); const beforeStale = count("drive"); staleSuggestionClick();
    c.ok("a stale suggestion callback cannot replace a newer typed address", input(draw()).value === " Newer exact address  " && count("drive") === beforeStale);
    const beforeCompose = count("distance"); key(draw(), "Enter", true);
    c.ok("IME composition Enter never launches a distance lookup", count("distance") === beforeCompose);
    const distanceClick = button(draw(), "Calculate distance").onClick as () => void; distanceClick(); distanceClick(); const request = last("distance");
    c.ok("typed calculation preserves exact query/coordinates and same-tick duplicate guard", count("distance") === beforeCompose + 1 && request.args.join() === "41.2,-76.2, Newer exact address  " && button(draw(), "Calculate distance").disabled === true);
    change(draw(), "New words while loading"); request.result.resolve({ ok: true, message: "ok", label: "Old returned address", lat: 43, lng: -78, drive: drive(50) }); await settle();
    c.ok("a late typed distance response cannot overwrite newer query or show its old route", input(draw()).value === "New words while loading" && !text(draw()).includes("Old returned address") && !text(draw()).includes("50.0 mi"));
    key(draw(), "Enter"); last("distance").result.resolve({ ok: false, message: "Couldn't compute a route." }); await settle();
    c.ok("Enter without an active suggestion calculates typed address and returned read error is visible", last("distance").args[2] === "New words while loading" && text(draw()).includes("Couldn't compute a route"));
    click(draw(), "Calculate distance"); last("distance").result.reject(new Error("fake distance response failed")); await settle();
    c.ok("thrown distance read retains address and permits deliberate safe read retry", input(draw()).value === "New words while loading" && text(draw()).includes("Your address is still here; try again") && !button(draw(), "Calculate distance").disabled);

    // Exercise the parent's current selection ref as well as its child guards.
    const oldOverlay = detailElement.props.onAddress as (choice: AddressChoice | null) => void;
    rootPins = [pinA, pinB]; root.draw(); rootTree = root.draw(); click(rootTree, pinB.title); rootTree = root.draw();
    oldOverlay(choiceA); rootTree = root.draw();
    const activeDetail = elements(rootTree, "PinDetail")[0].props;
    c.ok("parent refuses an old selected-pin overlay after a same-tick list selection", (activeDetail.pin as MapPin).id === pinB.id && root.snapshot()[2] === null);
    (activeDetail.onAddress as (choice: AddressChoice | null) => void)(choiceB); root.draw();
    c.ok("parent accepts only the current selected-pin overlay's exact coordinates", JSON.stringify(root.snapshot()[2]) === JSON.stringify(choiceB));
    rootPins = [pinA, { ...pinB, lat: 45 }]; root.draw(); rootTree = root.draw();
    c.ok("same-ID refreshed coordinates replace the selected context and clear the old destination", (elements(rootTree, "PinDetail")[0].props.pin as MapPin).lat === 45 && root.snapshot()[2] === null);
    const rootMap = elements(rootTree, "div").find((element) => element.props.ref && typeof element.props.ref === "object")!;
    c.ok("map canvas remains native and no Leaflet/provider initialization is needed for event checks", (rootMap.props.ref as { current: unknown }).current == null && fence.blocked.length === 0);
    replacePin(pinA); const addressBeforePinSwap = input(draw()).value;
    c.ok("a different pin starts a fresh query context without copying another pin's chosen address", addressBeforePinSwap === "");
    c.ok("map read recovery fixture makes no real database/provider/tiles/client-send request", fence.blocked.length === 0);
    c.summary();
  } finally {
    mounted.forEach((fixture) => fixture.unmount());
    globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout;
    Object.assign(globalThis, { window: originalWindow, document: originalDocument });
    dom.createPortal = originalPortal;
    for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
    fence.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
