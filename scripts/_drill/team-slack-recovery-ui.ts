// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual embedded Slack control handlers with pure action fakes; no provider.
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fenceFetch, makeChecker } from "./_harness";
import type { SlackSyncReport, ActionResult } from "../../src/app/team/actions";
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
type Result = ActionResult & { slackId?: string; set?: SlackSyncReport["set"]; skipped?: SlackSyncReport["skipped"] };
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const storage = new Map<string, string>();
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, v: string) => { storage.set(key, v); }, removeItem: (key: string) => { storage.delete(key); } };
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: local });
  const writes: { kind: string; args: unknown[] }[] = [];
  let response = deferred<Result>(), refreshes = 0;
  const stub = (file: string, exports: unknown) => { const f = req.resolve(file); req.cache[f] = { id: f, filename: f, loaded: true, exports } as NodeModule; };
  const fake = (kind: string) => async (...args: unknown[]) => { writes.push({ kind, args }); return response.promise; };
  stub("next/navigation", { useRouter: () => ({ refresh: () => { refreshes++; } }) });
  stub("../../src/app/team/actions.ts", { saveSlackId: fake("save"), findSlackIdOnSlack: fake("find"), syncSlackIdsFromWorkspace: fake("sync"), sendTestSlackDm: fake("dm") });
  const { SlackIdField } = await import("@/components/people/SlackIdField");
  const { SlackSyncButton } = await import("@/components/people/SlackSyncButton");
  const { SlackTestDmButton } = await import("@/components/people/SlackTestDmButton");
  const { PeopleTabs } = await import("@/components/people/PeopleTabs");
  let props = { memberId: "fixture-editor", firstName: "Kim", slackId: "UORIGINAL" as string | null, canEdit: true };
  let card = mountHooks(() => SlackIdField(props));
  const tree = () => card.render();
  const button = (label: string) => elements(tree(), "Button").find((p) => contains(p.children, label))!;
  const click = (label: string) => (button(label).onClick as () => unknown)();
  const field = () => elements(tree(), "TextField")[0];
  const type = (value: string) => (field().onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  const mount = async (render: () => unknown) => { card.stop(); card = mountHooks(render); card.render(); await Promise.resolve(); };
  try {
    card.render(); await Promise.resolve(); click("Edit"); type("  uearlier1  "); response = deferred(); click("Save"); click("Save"); type("WNEWER001");
    c.ok("same-tick manual save captures normalized exact member/ID once while later input stays editable", JSON.stringify(writes) === JSON.stringify([{ kind: "save", args: ["fixture-editor", "UEARLIER1"] }]) && field().value === "WNEWER001" && button("Save").disabled === true && button("Cancel").disabled === true);
    response.resolve({ ok: true, outcome: "confirmed", message: "Earlier ID saved." }); await until(() => contains(tree(), "newer local input"));
    c.ok("older saved response updates its exact confirmed chip but retains newer draft and editor", field().value === "WNEWER001" && contains(tree(), "UEARLIER1") && contains(tree(), "earlier request") && button("Save").disabled === false && !storage.size);
    response = deferred(); click("Save"); response.resolve({ ok: true, outcome: "confirmed", message: "Latest ID saved." }); await until(() => contains(tree(), "Latest ID saved."));
    c.ok("unchanged successful save closes editor with exact canonical confirmed ID", !field() && contains(tree(), "WNEWER001") && !storage.size);
    props = { ...props, slackId: "USERVER01" }; card.render();
    c.ok("ordinary server refresh exposes new roster ID instead of retaining a stale chip override", elements(tree(), "span").some((p) => contains(p.children, "USERVER01")) && !elements(tree(), "span").some((p) => contains(p.children, "WNEWER001")));
    response = deferred(); click("Find on Slack"); click("Find on Slack"); click("Edit"); type("WMANUAL01"); response.resolve({ ok: true, outcome: "confirmed", message: "Found and saved.", slackId: "UFIND0001" }); await until(() => contains(tree(), "newer local input"));
    c.ok("late Find receipt cannot overwrite manual typing or close newly opened editor", writes.filter((w) => w.kind === "find").length === 1 && writes.at(-1)?.args.join() === "fixture-editor" && field().value === "WMANUAL01" && contains(tree(), "UFIND0001") && button("Save").disabled === false);
    type("bad"); const beforeInvalid = writes.length; click("Save");
    c.ok("existing U/W ID regex still refuses invalid local save and associates readable error with field", writes.length === beforeInvalid && button("Save").disabled === true && !!field().error && field().label === "Slack member ID for Kim");
    type(""); response = deferred(); click("Save"); response.resolve({ ok: true, outcome: "confirmed", message: "Cleared." }); await until(() => contains(tree(), "Cleared."));
    c.ok("explicit clear still sends null and only its unchanged success closes editor", JSON.stringify(writes.at(-1)?.args) === JSON.stringify(["fixture-editor", null]) && !field() && contains(tree(), "No Slack ID"));
    click("Add Slack ID"); type("UCORRECT1"); response = deferred(); click("Save"); response.resolve({ ok: false, outcome: "refused", message: "ID already belongs to another row." }); await until(() => contains(tree(), "ID already belongs"));
    c.ok("known prewrite refusal retains input and permits deliberate correction without unknown hold", field().value === "UCORRECT1" && button("Save").disabled === false && !storage.size);
    response = deferred(); click("Save"); type("WLATEST01"); response.reject(new Error("lost write reply")); await until(() => contains(tree(), "is unconfirmed")); const beforeUnknown = writes.length; click("Save");
    c.ok("thrown save holds blind replay/cancel and preserves exact later native input", writes.length === beforeUnknown && field().value === "WLATEST01" && button("Save").disabled === true && button("Cancel").disabled === true && contains(tree(), "may already have been saved"));
    const marker = JSON.parse(storage.get("slack-id-unconfirmed:fixture-editor")!);
    c.ok("Slack retry marker stores opaque operation identity only, no recipient/name/input/body", Object.keys(marker).sort().join() === "attemptId,operation" && ![...storage.values()].join().includes("LATEST") && ![...storage.values()].join().includes("Kim"));
    await mount(() => SlackIdField(props)); click("Find on Slack");
    c.ok("refresh keeps unknown roster mutation held without claiming earlier writer ended or draft survived", writes.length === beforeUnknown && button("Find on Slack").disabled === true && contains(tree(), "Local input is kept only") && contains(tree(), "request logs"));
    storage.clear(); await mount(() => SlackIdField({ ...props, canEdit: false }));
    c.ok("existing read-only role still exposes no Slack mutation controls", !button("Edit") && !button("Find on Slack"));
    storage.clear(); await mount(() => SlackIdField(props)); response = deferred(); click("Find on Slack"); response.resolve({ ok: true, message: "Legacy result.", slackId: "ULEGACY01" }); await until(() => contains(tree(), "is unconfirmed"));
    c.ok("legacy outcome cannot falsely mark an ID as saved or authorize another lookup", !contains(tree(), "ULEGACY01") && button("Find on Slack").disabled === true);
    storage.clear(); card.stop(); card = mountHooks(() => SlackIdField(props)); card.render(); response = deferred(); click("Find on Slack"); await Promise.resolve();
    c.ok("initial recovery hydration ignores the current live attempt marker", !contains(tree(), "is unconfirmed") && button("Find on Slack").disabled === true);
    response.resolve({ ok: false, outcome: "refused", message: "Known lookup refusal." }); await until(() => contains(tree(), "Known lookup refusal."));
    storage.clear(); await mount(() => SlackSyncButton()); response = deferred(); click("Sync Slack"); click("Sync Slack"); response.resolve({ ok: true, outcome: "confirmed", message: "Set one, skipped one.", set: [{ name: "Kim Exact", slackId: "UFOUND001", by: "email" }], skipped: [{ name: "Ambiguous Person", reason: "Two matches." }] }); await until(() => contains(tree(), "Set one"));
    c.ok("workspace sync runs once and keeps exact saved/skipped report with existing refresh behavior", writes.filter((w) => w.kind === "sync").length === 1 && writes.at(-1)?.args.length === 0 && contains(tree(), "Kim Exact") && contains(tree(), "Two matches.") && refreshes === 1 && !storage.size);
    response = deferred(); click("Sync Slack"); response.resolve({ ok: false, outcome: "refused", message: "No connected user token.", set: [], skipped: [] }); await until(() => contains(tree(), "No connected user token."));
    c.ok("known directory-read refusal remains retryable and does not fabricate roster mutations", button("Sync Slack").disabled === false && refreshes === 1 && !storage.size);
    response = deferred(); click("Sync Slack"); response.reject(new Error("lost partial sync reply")); await until(() => contains(tree(), "Slack ID sync is unconfirmed")); const beforeSync = writes.length; click("Sync Slack");
    c.ok("unknown/partial sync stops blind repeats and acknowledges some rows may already have changed", writes.length === beforeSync && button("Sync Slack").disabled === true && contains(tree(), "Some Team rows may already have changed"));
    await mount(() => SlackSyncButton()); click("Sync Slack");
    c.ok("sync current-tab refresh retains explicit held guard", writes.length === beforeSync && button("Sync Slack").disabled === true && storage.has("slack-sync-unconfirmed"));
    storage.clear(); await mount(() => SlackTestDmButton({ memberId: "fixture-editor", firstName: "Kim", slackId: null })); const beforeAbsent = writes.length; click("Send test DM");
    c.ok("no-ID recipient eligibility still blocks even direct handler invocation", writes.length === beforeAbsent && button("Send test DM").disabled === true);
    await mount(() => SlackTestDmButton({ memberId: "fixture-editor", firstName: "Kim", slackId: "UCURRENT1" })); response = deferred(); click("Send test DM"); click("Send test DM"); response.resolve({ ok: true, outcome: "confirmed", message: "Sent to the exact roster person." }); await until(() => contains(tree(), "Sent to the exact"));
    c.ok("test DM invokes exact existing member-only payload once and shows only confirmed success", writes.filter((w) => w.kind === "dm").length === 1 && JSON.stringify(writes.at(-1)?.args) === JSON.stringify(["fixture-editor"]) && button("Send test DM").disabled === false && !storage.size);
    response = deferred(); click("Send test DM"); response.resolve({ ok: false, outcome: "refused", message: "Known provider refusal." }); await until(() => contains(tree(), "Known provider refusal."));
    c.ok("typed known no-send result permits intentional retry without hidden defaults", button("Send test DM").disabled === false && !storage.size);
    response = deferred(); click("Send test DM"); response.resolve({ ok: false, outcome: "unknown", message: "Provider result unconfirmed." }); await until(() => contains(tree(), "is unconfirmed")); const beforeDm = writes.length; click("Send test DM");
    c.ok("unknown DM response prevents blind resend and gives recipient/conversation/log inspection context", writes.length === beforeDm && button("Send test DM").disabled === true && contains(tree(), "may already have reached Slack") && contains(tree(), "Slack conversation"));
    await mount(() => SlackTestDmButton({ memberId: "fixture-editor", firstName: "Kim", slackId: "UCURRENT1" })); click("Send test DM");
    c.ok("DM refresh retains send hold without persisting recipient or fixed body", writes.length === beforeDm && button("Send test DM").disabled === true && ![...storage.values()].join().includes("UCURRENT1") && ![...storage.values()].join().includes("Test from"));
    storage.clear(); await mount(() => SlackTestDmButton({ memberId: "fixture-editor", firstName: "Kim", slackId: "UCURRENT1" })); response = deferred(); click("Send test DM"); response.reject(new Error("transport lost")); await until(() => contains(tree(), "is unconfirmed"));
    c.ok("thrown test DM is caught without false no-send or an actionable repeat", button("Send test DM").disabled === true && contains(tree(), "Reloading does not prove"));
    storage.clear(); await mount(() => SlackSyncButton()); response = deferred(); click("Sync Slack"); const other = { attemptId: randomUUID(), operation: "sync" }; storage.set("slack-sync-unconfirmed", JSON.stringify(other)); response.resolve({ ok: true, outcome: "confirmed", message: "Original sync confirmed.", set: [], skipped: [] }); await until(() => contains(tree(), "Original sync confirmed."));
    c.ok("a late terminal response preserves another opaque attempt marker", JSON.parse(storage.get("slack-sync-unconfirmed")!).attemptId === other.attemptId && button("Sync Slack").disabled === true);
    storage.clear(); await mount(() => SlackIdField(props)); click("Edit"); type("ULOCAL001"); const beforePrep = writes.length, uuid = crypto.randomUUID;
    try { crypto.randomUUID = () => { throw new Error("device preparation failed"); }; click("Save"); } finally { crypto.randomUUID = uuid; }
    c.ok("local preparation failure keeps draft retryable and cannot strand busy/start a save", writes.length === beforePrep && field().value === "ULOCAL001" && button("Save").disabled === false && contains(tree(), "No request was started") && !storage.size);
    const html = renderToStaticMarkup(tree() as ReactNode);
    c.ok("member input renders associated label, native named control, readable/focus/44px conventions", html.includes('for="slack-member-id-fixture-editor"') && html.includes('name="slackId"') && html.includes("min-h-11") && html.includes("text-base") && html.includes("focus-visible:outline"));
    const tabs = renderToStaticMarkup(PeopleTabs({ tab: "team", show: ["team"] }));
    c.ok("People navigation preserves allowed exact destination while naming nav/current page and 44px targets", tabs.includes('aria-label="People sections"') && tabs.includes('aria-current="page"') && tabs.includes('/users?tab=team') && !tabs.includes('/users?tab=logins') && tabs.includes("min-h-11"));
    c.ok("embedded Slack handler fixture invokes no real action/database/provider/send/browser", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { card.stop(); fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
