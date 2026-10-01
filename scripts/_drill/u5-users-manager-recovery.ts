// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual UsersManager handlers and action wrappers; in-memory records only.
import { isValidElement, type ReactElement } from "react";
import { createRequire } from "node:module";
import { installNextStubs, fenceFetch, makeChecker } from "./_harness";
import type { UserActionResult } from "../../src/app/users/actions";
import type { UserView } from "../../src/components/users/UsersManager";

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): ReactElement<Props>[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function text(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(text).join(" ");
  if (!isValidElement<Props>(tree)) return "";
  const component = tree.type as unknown as { name?: string } & ((p: Props) => unknown);
  return component.name === "UserReceipt" ? text(component(tree.props)) : text(tree.props.children);
}
function mount(render: () => unknown) {
  const react = createRequire(__filename)("react") as { __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown } };
  const cells: unknown[] = [], effects: (() => void)[] = [], cleanups = new Map<number, (() => void) | undefined>(); let i = 0;
  const dispatcher = {
    useState(initial: unknown) { const n = i++; if (!(n in cells)) cells[n] = typeof initial === "function" ? initial() : initial; return [cells[n], (next: unknown) => { cells[n] = typeof next === "function" ? next(cells[n]) : next; }]; },
    useRef(initial: unknown) { const n = i++; if (!(n in cells)) cells[n] = { current: initial }; return cells[n]; },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) { const n = i++, old = cells[n] as unknown[] | undefined; if (!old || deps.some((v, j) => v !== old[j])) { cells[n] = deps; effects.push(() => { cleanups.get(n)?.(); cleanups.set(n, effect()); }); } },
    useTransition() { const n = i++; if (!(n in cells)) cells[n] = false; return [cells[n], (callback: () => Promise<unknown>) => { cells[n] = true; void callback().finally(() => { cells[n] = false; }); }]; },
  };
  return () => { i = 0; const before = react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H; react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher; try { const result = render(); effects.splice(0).forEach((effect) => effect()); return result; } finally { react.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = before; } };
}
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(test: () => boolean) { for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 5)); if (!test()) throw new Error("users fixture did not settle"); }
const button = (tree: unknown, label: string) => elements(tree, "Button").find((e) => text(e).includes(label))!.props;
const click = (tree: unknown, label: string) => (button(tree, label).onClick as () => void)();
const change = (props: Props, value: string) => (props.onChange as (e: { target: { value: string } }) => void)({ target: { value } });
const input = (tree: unknown, placeholder: string) => elements(tree, "input").find((e) => e.props.placeholder === placeholder)!.props;
const invoke = (element: ReactElement<Props>) => (element.type as (p: Props) => unknown)(element.props);
installNextStubs();
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename), originals = new Map<string, NodeModule | undefined>();
  const stub = (file: string, exports: unknown) => { if (!originals.has(file)) originals.set(file, req.cache[file]); req.cache[file] = { id: file, filename: file, loaded: true, exports } as NodeModule; };
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), cryptoBefore = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  const markers = new Map<string, string>(); let number = 0, storageFails = false;
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => { if (storageFails) throw new Error("blocked storage"); return markers.get(k) ?? null; }, setItem: (k: string, v: string) => markers.set(k, v), removeItem: (k: string) => markers.delete(k) } });
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { randomUUID: () => `opaque-attempt-${++number}` } });
  const actionFile = req.resolve("../../src/app/users/actions.ts");
  const calls: { operation: string; args: unknown[] }[] = []; let response = deferred<UserActionResult>();
  const fake = (operation: string) => async (...args: unknown[]) => { calls.push({ operation, args }); return response.promise; };
  stub(actionFile, Object.fromEntries(["inviteUser", "inviteLinkFor", "setUserRole", "setUserPermission", "resetUserPermissions", "setUserStatus", "removeUser", "viewAs"].map((op) => [op, fake(op)])));
  const nav = req("next/navigation") as { useRouter: () => unknown }, oldRouter = nav.useRouter; let refreshes = 0;
  nav.useRouter = () => ({ refresh: () => { refreshes++; }, push: () => {} });
  try {
    const { UsersManager } = await import("../../src/components/users/UsersManager");
    const addElement = elements(UsersManager({ users: [] }), "AddUser")[0];
    const add = mount(() => invoke(addElement));
    click(add(), "Add a user"); change(input(add(), "name@example.com"), "first@example.test"); change(input(add(), "First Last"), " First  Person ");
    const oldSubmit = button(add(), "Create invite").onClick as () => void;
    oldSubmit(); oldSubmit();
    change(input(add(), "name@example.com"), "second@example.test"); change(input(add(), "First Last"), " Second exact words "); change(elements(add(), "select")[0].props, "ADMIN");
    c.ok("invite dispatch is same-tick guarded and captures exact submitted words/default role", calls.length === 1 && JSON.stringify(calls[0].args[0]) === '{"email":"first@example.test","name":" First  Person ","role":"PHOTOGRAPHER"}');
    response.resolve({ ok: true, outcome: "confirmed", message: "Invite created.", link: "https://fixture.invalid/invite/opaque-first" }); await until(() => text(add()).includes("Confirmed invite link"));
    c.ok("older invite receipt preserves every newer field and names its original email/role", input(add(), "name@example.com").value === "second@example.test" && input(add(), "First Last").value === " Second exact words " && elements(add(), "select")[0].props.value === "ADMIN" && text(add()).includes("first@example.test") && text(add()).includes("newer form input was kept"));
    const copy = invoke(elements(add(), "CopyLink")[0]);
    c.ok("link delegates to existing verified CopyButton and retains a labelled manual-copy field", elements(copy, "CopyButton")[0]?.props.value === "https://fixture.invalid/invite/opaque-first" && elements(copy, "input")[0]?.props["aria-label"] === "Invite or password setup link");
    response = deferred(); click(add(), "Create invite");
    c.ok("new token attempt removes the previous link rather than presenting it as current", elements(add(), "CopyLink").length === 0);
    response.resolve({ ok: true, outcome: "confirmed", message: "Invite created.", link: "https://fixture.invalid/invite/opaque-second" }); await until(() => input(add(), "name@example.com").value === "");
    c.ok("exact unchanged successful draft clears name/email but preserves selected role", input(add(), "First Last").value === "" && elements(add(), "select")[0].props.value === "ADMIN" && markers.size === 0);
    change(input(add(), "name@example.com"), "unknown@example.test"); response = deferred(); click(add(), "Create invite"); response.reject(new Error("lost token response")); await until(() => text(add()).includes("may already have happened")); oldSubmit();
    c.ok("lost invite response keeps exact draft, no link/sent claim and blocks repeat", calls.length === 3 && input(add(), "name@example.com").value === "unknown@example.test" && elements(add(), "CopyLink").length === 0 && button(add(), "Create invite").disabled === true);
    const reopenedAdd = mount(() => invoke(addElement)); click(reopenedAdd(), "Add a user"); change(input(reopenedAdd(), "name@example.com"), "later@example.test"); click(reopenedAdd(), "Create invite");
    c.ok("opaque invite marker restores hold on full form remount before another action", calls.length === 3 && text(reopenedAdd()).includes("previous request") && [...markers.values()].every((v) => /^opaque-attempt-\d+$/.test(v)));

    const u: UserView = { id: "fixture-user", email: "member@example.test", name: "Fixture member", role: "ADMIN", permissions: '{"mypay":true}', status: "ACTIVE", lastLoginAt: null, isSelf: false };
    const cardElement = elements(UsersManager({ users: [u] }), "UserCard")[0]; const card = mount(() => invoke(cardElement));
    const access = () => invoke(elements(card(), "AccessToggles")[0]);
    const checkbox = (label: string) => elements(access(), "label").find((e) => text(e).includes(label))!;
    const check = (label: string, checked: boolean) => (elements(checkbox(label), "input")[0].props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked } });
    response = deferred(); check("Finance", true); check("Trends", true); click(card(), "Revoke"); change(elements(card(), "select")[0].props, "PHOTOGRAPHER");
    c.ok("whole same-account permissions/role/status serialize synchronously and pass exact raw baseline", calls.length === 4 && calls.at(-1)?.operation === "setUserPermission" && JSON.stringify(calls.at(-1)?.args) === '["fixture-user","sales",true,{"role":"ADMIN","permissions":"{\\"mypay\\":true}"}]' && elements(access(), "input").every((e) => e.props.disabled === true));
    response.resolve({ ok: false, outcome: "refused", message: "Permission changed elsewhere." }); await until(() => text(card()).includes("Permission changed elsewhere"));
    c.ok("known permission refusal is visible, keeps displayed baseline and releases retry marker", elements(checkbox("My Pay"), "input")[0].props.checked === true && !markers.has("ops-user-attempt:account:fixture-user") && button(card(), "Refresh account").disabled === false);
    response = deferred(); click(access(), "Reset to"); click(access(), "Reset to");
    c.ok("reset makes one atomic exact-baseline request, never a per-key mutation loop", calls.length === 5 && calls.at(-1)?.operation === "resetUserPermissions" && JSON.stringify(calls.at(-1)?.args) === '["fixture-user",{"role":"ADMIN","permissions":"{\\"mypay\\":true}"}]');
    response.reject(new Error("reset result lost")); await until(() => text(card()).includes("may already have happened")); click(card(), "Revoke");
    const remounted = mount(() => invoke(cardElement)); click(remounted(), "Invite link");
    c.ok("unknown reset holds every account write even after full remount", calls.length === 5 && text(remounted()).includes("previous request") && button(remounted(), "Revoke").disabled === true);
    const ownerElement = elements(UsersManager({ users: [{ ...u, id: "owner-self", role: "OWNER", isSelf: true }] }), "UserCard")[0], owner = mount(() => invoke(ownerElement));
    c.ok("owner/self visibility unchanged and controls have native names/disclosure", elements(owner(), "select")[0].props.disabled === true && elements(owner(), "AccessToggles").length === 0 && !text(owner()).includes("Revoke") && elements(card(), "Button").some((e) => e.props["aria-label"] === "Remove Fixture member") && button(card(), "Access")["aria-controls"] === "access-fixture-user");
    const otherElement = elements(UsersManager({ users: [{ ...u, id: "other-user" }] }), "UserCard")[0], other = mount(() => invoke(otherElement)); response = deferred(); click(other(), "Revoke");
    c.ok("unknown account hold does not prevent independent exact-account work", calls.length === 6 && calls.at(-1)?.args[0] === "other-user");
    response.resolve({ ok: false, outcome: "refused", message: "Fixture refusal" }); await until(() => text(other()).includes("Fixture refusal"));
    storageFails = true; click(other(), "Invite link"); storageFails = false;
    c.ok("unavailable recovery storage refuses before creating tokens", calls.length === 6 && text(other()).includes("No request was made"));

    // Actual server wrappers below. Fake CAS compares stored raw role + JSON.
    delete req.cache[actionFile];
    let actor = { id: "owner", email: "owner@example.test", realRole: "OWNER", impersonating: false };
    type Row = { id: string; email: string; name: string; role: string; permissions: string | null; editorKey: string | null; status: string; inviteToken: string | null };
    let row: Row = { id: "fixture-user", email: "member@example.test", name: "Fixture member", role: "ADMIN", permissions: '{"mypay":true}', editorKey: null, status: "ACTIVE", inviteToken: "existing-token" };
    const waiting: (() => void)[] = [];
    let readPair = false, writes = 0, auditWrites = 0, revalidateFails = false, writeFails = false;
    const snapshot = async () => { const result = { ...row }; if (readPair) await new Promise<void>((resolve) => { waiting.push(resolve); if (waiting.length === 2) { readPair = false; waiting.splice(0).forEach((f) => f()); } }); return result; };
    const db = { appUser: {
      findUnique: snapshot,
      updateMany: async ({ where, data }: { where: { id: string; role: string; permissions: string | null }; data: Partial<Row> }) => { if (writeFails) throw new Error("fake write timeout"); if (row.id !== where.id || row.role !== where.role || row.permissions !== where.permissions) return { count: 0 }; row = { ...row, ...data }; writes++; return { count: 1 }; },
      update: async ({ data }: { data: Partial<Row> }) => { row = { ...row, ...data }; writes++; if (writeFails) throw new Error("fake response loss after update"); return row; },
      create: async ({ data }: { data: Partial<Row> }) => { row = { ...row, ...data }; writes++; if (writeFails) throw new Error("fake response loss after create"); return row; },
      delete: async () => { writes++; if (writeFails) throw new Error("fake response loss after delete"); return row; },
    }, auditLog: { create: async () => { auditWrites++; return {}; } } };
    stub(req.resolve("../../src/lib/prisma.ts"), { prisma: db });
    stub(req.resolve("../../src/lib/auth/user.ts"), { __esModule: true, getCurrentUser: async () => actor });
    const cache = req("next/cache") as { revalidatePath: () => void }; cache.revalidatePath = () => { if (revalidateFails) throw new Error("fake post-write revalidation"); };
    const real = await import("../../src/app/users/actions");
    const baseline = { role: row.role, permissions: row.permissions };
    readPair = true; const raced = await Promise.all([real.setUserPermission(row.id, "sales", true, baseline), real.setUserPermission(row.id, "trends", true, baseline)]);
    c.ok("two equal snapshots race: exactly one permission CAS wins, other is known no-write refusal", writes === 1 && raced.filter((r) => r.ok && r.outcome === "confirmed").length === 1 && raced.filter((r) => !r.ok && r.outcome === "refused").length === 1 && row.permissions?.includes('"mypay":true') === true && auditWrites === 1);
    const stale = await real.setUserPermission(row.id, "clients", false, baseline);
    c.ok("explicit stale displayed baseline refuses before changing any current grant", stale.outcome === "refused" && writes === 1);
    row = { ...row, role: "PHOTOGRAPHER", permissions: '{"clients":true,"editing":false,"mypay":true}' }; const roleBase = { role: row.role, permissions: row.permissions }; readPair = true;
    const roleRace = await Promise.all([real.setUserRole(row.id, "EDITOR", roleBase), real.setUserPermission(row.id, "sales", true, roleBase)]);
    c.ok("role rewrite and permission rewrite share the same CAS boundary", roleRace.filter((r) => r.ok).length === 1 && roleRace.filter((r) => r.outcome === "refused").length === 1 && writes === 2);
    if (row.role === "EDITOR") c.ok("role migration preserves grants and prunes only new-role default revocations", row.permissions === '{"clients":true,"mypay":true}');
    else { const changed = await real.setUserRole(row.id, "EDITOR", { role: row.role, permissions: row.permissions }); c.ok("role migration preserves grants and prunes only new-role default revocations", changed.ok && !row.permissions?.includes('"editing":false') && row.permissions?.includes('"mypay":true') === true); }
    row = { ...row, role: "ADMIN", permissions: '{"mypay":true,"clients":false,"connections":true,"customLegacy":true}' }; const beforeReset = writes;
    const reset = await real.resetUserPermissions(row.id, { role: row.role, permissions: row.permissions });
    c.ok("atomic explicit reset clears the same valid overrides including My Pay and retains legacy/owner-only keys", reset.ok && writes === beforeReset + 1 && row.permissions === '{"connections":true,"customLegacy":true}');
    const noReset = await real.resetUserPermissions(row.id, { role: row.role, permissions: row.permissions });
    c.ok("reset with no valid page overrides preserves other stored keys without any write", noReset.ok && writes === beforeReset + 1 && row.permissions === '{"connections":true,"customLegacy":true}');
    const legacy = await real.setUserPermission(row.id, "clients", false);
    c.ok("legacy callers may omit displayed baseline while retaining server-read CAS", legacy.ok && row.permissions?.includes('"clients":false') === true);
    actor = { ...actor, realRole: "ADMIN" }; const beforeGuard = writes; const denied = await real.resetUserPermissions(row.id);
    actor = { ...actor, realRole: "OWNER", impersonating: true }; const previewDenied = await real.setUserPermission(row.id, "sales", true);
    actor = { ...actor, impersonating: false }; const selfRole = await real.setUserRole(actor.id, "ADMIN"), selfStatus = await real.setUserStatus(actor.id, "DISABLED"), selfRemove = await real.removeUser(actor.id);
    c.ok("owner-only, preview read-only and self protections refuse without writes", [denied, previewDenied, selfRole, selfStatus, selfRemove].every((r) => !r.ok && r.outcome === "refused") && writes === beforeGuard);
    row = { ...row, role: "OWNER" }; const ownerDenied = await real.setUserPermission(row.id, "sales", false); const fixedDenied = await real.setUserPermission(row.id, "connections", true);
    c.ok("owners and owner-only pages remain non-overridable", ownerDenied.outcome === "refused" && fixedDenied.outcome === "refused" && writes === beforeGuard);
    row = { ...row, role: "ADMIN" }; revalidateFails = true;
    const uncertain = await real.setUserPermission(row.id, "clients", true, { role: row.role, permissions: row.permissions }); revalidateFails = false;
    c.ok("post-CAS revalidation failure is unknown after write, never a no-write refusal", uncertain.outcome === "unknown" && writes === beforeGuard + 1);
    writeFails = true; const lostStatus = await real.setUserStatus(row.id, "DISABLED"), lostRemove = await real.removeUser(row.id), lostInvite = await real.inviteUser({ email: row.email, name: row.name, role: row.role });
    row.inviteToken = null; const lostToken = await real.inviteLinkFor(row.id); writeFails = false;
    c.ok("status/remove/reinvite/token write exceptions all return unknown", [lostStatus, lostRemove, lostInvite, lostToken].every((r) => r.outcome === "unknown"));
    c.ok("fixture uses no real database, provider, invite send or network", fence.blocked.length === 0 && refreshes === 0);
    c.summary();
  } finally {
    nav.useRouter = oldRouter; for (const [file, original] of originals) { if (original) req.cache[file] = original; else delete req.cache[file]; }
    if (storageBefore) Object.defineProperty(globalThis, "sessionStorage", storageBefore); else Reflect.deleteProperty(globalThis, "sessionStorage");
    if (cryptoBefore) Object.defineProperty(globalThis, "crypto", cryptoBefore); else Reflect.deleteProperty(globalThis, "crypto"); fence.restore();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
