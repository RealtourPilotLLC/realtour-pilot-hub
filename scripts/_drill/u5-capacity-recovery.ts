// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual handlers/wrappers, in-memory domains/storage; no roster/live writes.
import { createRequire } from "node:module";
import { isValidElement, type ReactElement } from "react";
import { installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { CapacityInput } from "../../src/lib/capacity";
import type { CapacityActionResult } from "../../src/app/people/capacity/actions";

type Props = Record<string, unknown>;
function text(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  const type = tree.type as { name?: string } & ((p: Props) => unknown);
  if (type.name === "CapacityReceipt") return text(type(tree.props));
  return text(tree.props.children);
}
function elements(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as { name?: string };
  return [...((typeof tree.type === "string" ? tree.type : type.name) === name ? [tree] : []), ...elements(tree.props.children, name)];
}
function mount(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = []; let index = 0;
  const dispatcher = {
    useState(initial: unknown) { const i = index++; if (!(i in cells)) cells[i] = typeof initial === "function" ? initial() : initial; return [cells[i], (next: unknown) => { cells[i] = typeof next === "function" ? next(cells[i]) : next; }]; },
    useRef(initial: unknown) { const i = index++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i]; },
    useEffect(effect: () => void, deps: unknown[]) { const i = index++, old = cells[i] as unknown[] | undefined; if (!old || deps.some((v, j) => old[j] !== v)) { cells[i] = deps; effects.push(effect); } },
    useId() { const i = index++; if (!(i in cells)) cells[i] = `fixture-${i}`; return cells[i]; },
    useTransition() { const i = index++; if (!(i in cells)) cells[i] = false; return [cells[i], (action: () => Promise<unknown>) => { cells[i] = true; void action().finally(() => { cells[i] = false; }); }]; },
  };
  return () => {
    index = 0; const old = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try { const tree = render(); effects.splice(0).forEach((f) => f()); return tree; }
    finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = old; }
  };
}
function deferred() { let resolve!: (r: CapacityActionResult) => void, reject!: (e: Error) => void; const promise = new Promise<CapacityActionResult>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); if (!test()) throw new Error("capacity fixture did not settle"); }
const change = (p: Props, value: string) => (p.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { if (!originals.has(file)) originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), cryptoBefore = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const markers = new Map<string, string>(); let number = 0, storageFails = false;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => { if (storageFails) throw new Error("storage blocked"); return markers.get(k) ?? null; }, setItem: (k: string, v: string) => markers.set(k, v), removeItem: (k: string) => markers.delete(k) } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => `fixture-opaque-${++number}` } });
  const actionFile = req.resolve("../../src/app/people/capacity/actions.ts");
  const calls: { kind: string; input?: CapacityInput; id?: string }[] = []; let result = deferred();
  stub(actionFile, { recordCapacityExceptionAction: async (input: CapacityInput) => { calls.push({ kind: "record", input }); return result.promise; }, cancelCapacityExceptionAction: async (id: string) => { calls.push({ kind: "cancel", id }); return result.promise; } });
  try {
    const { CapacityForm, CancelCapacityButton } = await import("../../src/app/people/capacity/CapacityForm");
    const people = [{ id: "kim", name: "Fixture Kim" }, { id: "john", name: "Fixture John" }];
    let render = mount(() => CapacityForm({ people, selfOnly: false }));
    const inputs = () => elements(render(), "input").map((e) => e.props);
    const button = () => elements(render(), "Button")[0].props;
    const click = () => (button().onClick as () => void)();
    change(inputs()[0], "2026-10-01T09:15"); change(inputs()[1], "2026-10-01T10:30"); change(inputs()[2], "Exact old availability note");
    const stale = button().onClick as () => void; stale(); stale();
    c.ok("same-tick duplicate record dispatch is blocked with exact Eastern payload", calls.length === 1 && calls[0].input?.teamMemberId === "kim" && calls[0].input.startsAt === "2026-10-01T13:15:00.000Z" && calls[0].input.endsAt === "2026-10-01T14:30:00.000Z" && calls[0].input.note === "Exact old availability note" && button().busy === true);
    change(inputs()[1], "2026-10-01T12:00"); change(inputs()[2], "Newer exact availability words");
    result.resolve({ ok: true, outcome: "confirmed", message: "Recorded exact old entry." }); await until(() => button().busy === false);
    c.ok("older confirmed result cannot clear newer note or end date", inputs()[1].value === "2026-10-01T12:00" && inputs()[2].value === "Newer exact availability words" && text(render()).includes("Recorded exact old entry") && markers.size === 0);
    result = deferred(); click(); result.resolve({ ok: false, outcome: "refused", message: "The end has to be after the start." }); await until(() => button().busy === false);
    c.ok("known pre-write refusal keeps every field and permits correction", inputs()[1].value === "2026-10-01T12:00" && inputs()[2].value === "Newer exact availability words" && !button().disabled && text(render()).includes("after the start"));
    result = deferred(); click(); result.reject(new Error("response lost after possible creation")); await until(() => button().busy === false);
    const beforeHold = calls.length; stale(); click();
    c.ok("uncertain record is caught, retained and held without blind replay", calls.length === beforeHold && button().disabled === true && inputs()[2].value === "Newer exact availability words" && text(render()).includes("may already have been recorded"));
    c.ok("recovery marker contains no person/date/note/private draft", markers.get("ops-capacity-attempt:new")?.startsWith("fixture-opaque-") === true && ![...markers.values()].join().includes("availability"));
    render = mount(() => CapacityForm({ people, selfOnly: false })); render(); await until(() => text(render()).includes("previous capacity change")); click();
    c.ok("reload restores unknown record guard without another write or draft-persistence claim", calls.length === beforeHold && button().disabled === true);
    markers.clear(); render = mount(() => CapacityForm({ people, selfOnly: false })); change(inputs()[0], "bad date"); click();
    c.ok("invalid local start is visible and makes no server request", calls.length === beforeHold && text(render()).includes("Pick when it starts") && markers.size === 0);
    change(inputs()[0], "2026-10-02T08:00"); storageFails = true; click();
    c.ok("unavailable recovery storage refuses before any capacity write", calls.length === beforeHold && text(render()).includes("No request was made")); storageFails = false;
    result = deferred(); click(); result.resolve({ ok: true, outcome: "confirmed", message: "Recorded current entry." }); await until(() => button().busy === false);
    c.ok("only unchanged confirmed submitted note/end are cleared", inputs()[1].value === "" && inputs()[2].value === "" && text(render()).includes("Recorded current entry"));
    const self = mount(() => CapacityForm({ people: [people[0]], selfOnly: true }));
    c.ok("editor self-only controls keep only blocked/offline kinds and no person picker", elements(self(), "select").length === 1 && elements(self(), "option").map((e) => e.props.value).sort().join() === "BLOCKED,CONNECTIVITY");
    render = mount(() => CancelCapacityButton({ id: "exact-entry" })); result = deferred(); click(); click();
    c.ok("cancel targets exact entry once with shared pending guard", calls.at(-1)?.id === "exact-entry" && calls.length === beforeHold + 2 && button().busy === true);
    result.resolve({ ok: false, outcome: "unknown", message: "not sure" }); await until(() => button().busy === false); const beforeCancel = calls.length;
    render = mount(() => CancelCapacityButton({ id: "exact-entry" })); render(); click();
    c.ok("returned unknown cancel remains held on same-entry remount", calls.length === beforeCancel && text(render()).includes("unconfirmed") && button().disabled === true);

    delete req.cache[actionFile]; let domainOk = true, domainFails = false;
    const domainCalls: unknown[][] = [];
    stub(req.resolve("../../src/lib/auth/guards.ts"), { authEnforced: () => true });
    stub(req.resolve("../../src/lib/auth/user.ts"), { __esModule: true, getCurrentUser: async () => ({ realName: "Fixture Kyle", name: "Kyle", email: "office@example.test", realRole: "ADMIN", teamMemberId: "office", impersonating: false }) });
    const domain = async (...args: unknown[]) => { domainCalls.push(args); if (domainFails) throw new Error("possible post-write failure"); return { ok: domainOk, message: "Exact domain evidence" }; };
    stub(req.resolve("../../src/lib/capacity.ts"), { recordCapacityException: domain, cancelCapacityException: domain });
    const a = req(actionFile) as { recordCapacityExceptionAction: (i: CapacityInput) => Promise<CapacityActionResult>; cancelCapacityExceptionAction: (id: string) => Promise<CapacityActionResult> };
    const payload = { teamMemberId: "kim", kind: "BLOCKED", startsAt: "2026-10-01T13:15:00Z", note: "exact" };
    c.ok("real wrappers add confirmation without changing actor/auth/payload", (await a.recordCapacityExceptionAction(payload)).outcome === "confirmed" && (await a.cancelCapacityExceptionAction("entry")).outcome === "confirmed" && JSON.stringify(domainCalls[0]) === JSON.stringify([payload, { name: "Fixture Kyle", realRole: "ADMIN", teamMemberId: "office", impersonating: false }, { authEnforced: true }]));
    domainOk = false;
    c.ok("returned pre-write domain refusal remains exact and retryable", (await a.recordCapacityExceptionAction(payload)).outcome === "refused" && (await a.cancelCapacityExceptionAction("entry")).outcome === "refused");
    domainOk = true; domainFails = true; let thrown = 0; try { await a.recordCapacityExceptionAction(payload); } catch { thrown++; } try { await a.cancelCapacityExceptionAction("entry"); } catch { thrown++; }
    c.ok("thrown domain ambiguity still reaches guarded component instead of no-write receipt", thrown === 2); domainFails = false;
    const cache = req("next/cache") as { revalidatePath: () => void }, originalRefresh = cache.revalidatePath;
    cache.revalidatePath = () => { throw new Error("view refresh lost after commit"); };
    let postWrite = false; try { await a.recordCapacityExceptionAction(payload); } catch { postWrite = true; } cache.revalidatePath = originalRefresh;
    c.ok("post-write refresh failure cannot become a known refusal", postWrite);
    const { WeekCalendar } = await import("../../src/components/day/WeekCalendar");
    const week = mount(() => WeekCalendar({ days: [], calendarOk: true }));
    const disclosure = () => elements(week(), "button")[0].props;
    const details = () => elements(week(), "div").find((e) => e.props.id === disclosure()["aria-controls"])!.props;
    (disclosure().onClick as () => void)();
    c.ok("weekly disclosure tracks native expanded state and retains its controlled region", disclosure()["aria-expanded"] === false && details().hidden === true && text(week()).replace(/\s+/g, " ").includes("0 scheduled items"));
    const allDayWeek = mount(() => WeekCalendar({ days: [{ dayKey: "2026-10-01", isToday: true, isWeekend: false, blocks: [], allDay: ["Fixture all-day planning"], freeMinutes: 540, plannedCount: 0 }], calendarOk: true }));
    (elements(allDayWeek(), "button")[0].props.onClick as () => void)();
    c.ok("collapsed week counts all-day scheduled items instead of claiming zero", text(allDayWeek()).replace(/\s+/g, " ").includes("1 scheduled items"));
    c.ok("unavailable weekly calendar is distinct from an empty free week", text(mount(() => WeekCalendar({ days: [], calendarOk: false }))()).includes("does not establish that the week is free"));
    c.ok("all capacity/calendar checks avoided live records and providers", fence.blocked.length === 0);
    c.summary();
  } finally {
    for (const [file, old] of originals) { if (old) req.cache[file] = old; else delete req.cache[file]; }
    if (storageBefore) Object.defineProperty(globalThis, "sessionStorage", storageBefore); else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (cryptoBefore) Object.defineProperty(globalThis, "crypto", cryptoBefore); else Reflect.deleteProperty(globalThis, "crypto");
    fence.restore();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
