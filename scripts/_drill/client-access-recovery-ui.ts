// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual sign-in/team/access handlers; every server export is a pure fake.
// No login, invite, provider, database, clipboard or real browser is invoked.
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
type Result = { ok: boolean; message: string; outcome?: "confirmed" | "refused" | "unknown"; redirect?: string; url?: string; expiresAtISO?: string };
async function main() {
  const c = makeChecker(), fence = fenceFetch(), req = createRequire(__filename);
  const storage = new Map<string, string>();
  const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); }, removeItem: (key: string) => { storage.delete(key); } };
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: local });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { pathname: "/portal/me", search: "?e=fixture-team" }, confirm: () => true } });
  let response = deferred<Result>();
  const writes: { kind: string; args: unknown[] }[] = [], navigation: string[] = [];
  let refreshes = 0;
  const stub = (file: string, exports: unknown) => { const f = req.resolve(file); req.cache[f] = { id: f, filename: f, loaded: true, exports } as NodeModule; };
  const fake = (kind: string) => async (...args: unknown[]) => { writes.push({ kind, args }); return response.promise; };
  stub("next/navigation", { useRouter: () => ({ refresh: () => { refreshes++; }, push: (url: string) => navigation.push(url) }) });
  stub("../../src/app/portal/login/actions.ts", { requestPortalLoginLink: fake("login"), signOutPortal: async () => { throw new Error("sign-out not invoked"); } });
  stub("../../src/app/login/actions.ts", { loginWithPassword: fake("password") });
  stub("../../src/app/portal/actions.ts", { portalInviteTeammate: fake("teamInvite"), portalCancelHeldInvite: fake("teamCancel"), portalRevokeTeammate: fake("teamRevoke"), portalSetTeammateRole: fake("teamRole") });
  stub("../../src/app/content/portalAccessActions.ts", { rotatePortalLink: fake("rotate"), expirePortalLink: fake("expire"), invitePortalPerson: fake("staffInvite"), revokePortalPerson: fake("staffRevoke"), setPortalPersonRole: fake("staffRole"), getPortalSignInLink: fake("mint") });
  const { PortalSignIn } = await import("@/components/portal/PortalSignIn");
  const { TeamSettings } = await import("@/components/portal/TeamSettings");
  const { PortalAccessControls } = await import("@/components/portal/staff/PortalAccessControls");
  const { PasswordLoginForm } = await import("@/components/auth/PasswordLoginForm");
  let card = mountHooks(() => PortalSignIn({}));
  const tree = () => card.render();
  const button = (label: string) => elements(tree(), "Button").find((p) => contains(p.children, label))!;
  const click = (label: string) => (button(label).onClick as () => unknown)();
  const field = (name: string) => elements(tree(), "TextField").find((p) => p.name === name)!;
  const type = (name: string, value: string) => (field(name).onChange as (e: { target: { value: string } }) => void)({ target: { value } });
  const submit = () => (elements(tree(), "form").find((p) => p.onSubmit)!.onSubmit as (e: { preventDefault: () => void }) => unknown)({ preventDefault() {} });
  const mount = async (render: () => unknown) => { card.stop(); card = mountHooks(render); card.render(); await Promise.resolve(); };
  const chooseTeam = (role: string) => (elements(tree(), "input").find((p) => p.type === "radio" && p.value === role)!.onChange as () => void)();
  try {
    card.render(); await Promise.resolve(); type("email", "earlier@example.test"); submit(); submit(); type("email", "later@example.test");
    c.ok("public login sync guard sends one exact earlier email while later native email remains editable", writes.length === 1 && (writes[0].args[0] as FormData).get("email") === "earlier@example.test" && field("email").value === "later@example.test" && button("Email me").disabled === true);
    response.resolve({ ok: true, message: "Request received. Account and delivery are not confirmed here." }); await until(() => contains(tree(), "earlier request"));
    c.ok("earlier login acknowledgement retains newer email and makes no sent claim", field("email").value === "later@example.test" && !contains(tree(), "on its way") && !storage.size);
    response = deferred(); submit(); type("email", "latest@example.test"); response.reject(new Error("lost response")); await until(() => contains(tree(), "couldn’t confirm"));
    const beforeLost = writes.length; submit();
    c.ok("thrown public request holds repeat without claiming sent or not-sent and preserves current input", writes.length === beforeLost && field("email").value === "latest@example.test" && button("Email me").disabled === true && contains(tree(), "may already have been processed") && elements(tree(), "ActionLink").some((p) => p.href === "/portal/me"));
    c.ok("public hold marker contains only opaque attempt/operation without account/draft data", Object.keys(JSON.parse(storage.get("portal-login-unconfirmed")!)).sort().join() === "attemptId,operation" && ![...storage.values()].join().includes("@"));
    await mount(() => PortalSignIn({})); type("email", "refresh@example.test"); submit();
    c.ok("same-tab refresh restores public hold and never treats a reload as terminal proof", writes.length === beforeLost && button("Email me").disabled === true && contains(tree(), "Reloading does not confirm") && field("email").value === "refresh@example.test");
    await mount(() => PortalSignIn({ emailSignIn: false, reason: "expired", signedIn: { who: "Fixture", canEnter: false } }));
    c.ok("email gate and revoked-seat sign-out remain intact without an actionable email form", !field("email") && elements(tree(), "form").some((p) => p.action));
    storage.clear(); card.stop(); card = mountHooks(() => PortalSignIn({})); card.render(); type("email", "early-dispatch@example.test"); response = deferred(); submit(); await Promise.resolve();
    c.ok("initial hydration cannot mistake its own live request marker for a previous unknown request", !contains(tree(), "couldn’t confirm your sign-in request") && button("Email me").busy === true);
    response.resolve({ ok: true, message: "Early request acknowledged." }); await until(() => contains(tree(), "Early request acknowledged."));
    storage.clear();
    await mount(() => TeamSettings({ seats: [], invitationsOn: true }));
    type("teammateName", "Earlier Person"); type("teammateEmail", "earlier-team@example.test"); chooseTeam("COLLABORATOR"); response = deferred(); click("Send invitation"); click("Send invitation");
    type("teammateName", "Newer Person"); type("teammateEmail", "newer-team@example.test"); chooseTeam("VIEWER");
    const teamCall = writes.at(-1)!;
    response.resolve({ ok: true, message: "Earlier person added." }); await until(() => contains(tree(), "newer invitation draft"));
    c.ok("team invitation captures exact identity/role once and old success preserves coherent newer draft", teamCall.kind === "teamInvite" && JSON.stringify(teamCall.args) === JSON.stringify([{ enrollmentId: "fixture-team" }, { name: "Earlier Person", email: "earlier-team@example.test", role: "COLLABORATOR" }]) && writes.filter((w) => w.kind === "teamInvite").length === 1 && field("teammateName").value === "Newer Person" && field("teammateEmail").value === "newer-team@example.test" && elements(tree(), "input").some((p) => p.value === "VIEWER" && p.checked) && refreshes === 1);
    response = deferred(); click("Send invitation"); response.resolve({ ok: true, message: "Newer person added." }); await until(() => contains(tree(), "Newer person added."));
    c.ok("unchanged successful client invitation clears only its own fields and restores existing OWNER default", field("teammateName").value === "" && field("teammateEmail").value === "" && elements(tree(), "input").some((p) => p.value === "OWNER" && p.checked) && !storage.size);
    type("teammateName", "Valid Person"); type("teammateEmail", "valid@example.test"); response = deferred(); click("Send invitation"); response.resolve({ ok: false, message: "That email is not valid." }); await until(() => contains(tree(), "That email is not valid."));
    c.ok("known client pre-write refusal keeps draft and enables deliberate correction", field("teammateName").value === "Valid Person" && button("Send invitation").disabled === false && !storage.size);
    response = deferred(); click("Send invitation"); response.reject(new Error("lost invite response")); await until(() => contains(tree(), "access change is unconfirmed"));
    const teamLost = writes.length; click("Send invitation");
    c.ok("unknown client invitation prevents blind replay and gives account/invitation inspection context", writes.length === teamLost && field("teammateEmail").value === "valid@example.test" && contains(tree(), "access and invitation history") && !contains(tree(), "didn't go through"));
    await mount(() => TeamSettings({ seats: [], invitationsOn: false })); click("Save — invite later");
    c.ok("team refresh preserves held guard and rollout wording without creating another invite", writes.length === teamLost && button("Save — invite later").disabled === true && contains(tree(), "account is set up for it"));
    storage.clear();
    const props = { enrollmentId: "fixture-staff", clientName: "Fixture Client", isTestClient: true, status: "ACTIVE", link: { issued: false, url: null, issuedAtISO: null, expiresAtISO: null, rotatedAtISO: null, expired: false }, accessRevokedAtISO: null, people: [{ membershipId: "fixture-person", email: "existing@example.test", name: "Existing Person", role: "OWNER" as const, invitedAtISO: "2026-10-01T10:00:00Z", acceptedAtISO: null, revokedAtISO: null, lastLoginAtISO: null }], lastOpened: null, visits: 0, switches: { invites: true, loginEmail: true } };
    await mount(() => PortalAccessControls(props));
    const staffRole = () => elements(tree(), "select").find((p) => p.name === "role")!;
    const chooseStaff = (value: string) => (staffRole().onChange as (e: { target: { value: string } }) => void)({ target: { value } });
    type("email", "old-staff@example.test"); type("name", "Old Staff"); chooseStaff("COLLABORATOR"); response = deferred(); submit(); submit(); type("email", "new-staff@example.test"); type("name", "New Staff"); chooseStaff("VIEWER");
    const staffCall = writes.at(-1)!;
    response.resolve({ ok: true, message: "Invitation accepted by fake action.", outcome: "confirmed" }); await until(() => contains(tree(), "newer invitation draft"));
    c.ok("staff old success retains all later fields/role and exact original enrollment/person payload", JSON.stringify(staffCall.args) === JSON.stringify(["fixture-staff", "old-staff@example.test", "Old Staff", "COLLABORATOR"]) && writes.filter((w) => w.kind === "staffInvite").length === 1 && field("email").value === "new-staff@example.test" && field("name").value === "New Staff" && staffRole().value === "VIEWER");
    response = deferred(); submit(); response.resolve({ ok: true, message: "New staff accepted.", outcome: "confirmed" }); await until(() => contains(tree(), "New staff accepted."));
    c.ok("unchanged successful staff invitation clears email/name while preserving existing chosen role", field("email").value === "" && field("name").value === "" && staffRole().value === "VIEWER" && !storage.size);
    type("email", "refused@example.test"); type("name", "Refused Person"); response = deferred(); submit(); response.resolve({ ok: false, message: "Owner access required.", outcome: "refused" }); await until(() => contains(tree(), "Owner access required."));
    c.ok("typed staff pre-write refusal retains fields and does not install unknown hold", field("email").value === "refused@example.test" && button("Invite").disabled === false && !storage.size);
    response = deferred(); submit(); response.resolve({ ok: false, message: "Unconfirmed domain response.", outcome: "unknown" }); await until(() => contains(tree(), "portal access change is unconfirmed")); const staffLost = writes.length; submit(); click("Create link");
    c.ok("returned staff uncertainty holds invitations and credential changes with exact inspection guidance", writes.length === staffLost && field("name").value === "Refused Person" && button("Create link").disabled === true && contains(tree(), "request logs and outbox") && storage.has("staff-portal-unconfirmed:fixture-staff"));
    await mount(() => PortalAccessControls(props)); submit();
    c.ok("staff current-tab refresh cannot erase unknown writer guard or promise draft restoration", writes.length === staffLost && button("Invite").disabled === true && contains(tree(), "only while this form stays open") && ![...storage.values()].join().includes("example.test"));
    storage.clear(); await mount(() => PortalAccessControls(props)); response = deferred(); click("Create link"); response.resolve({ ok: true, message: "Legacy success without outcome." }); await until(() => contains(tree(), "portal access change is unconfirmed"));
    c.ok("legacy omitted access outcome remains held even when boolean says success", button("Create link").disabled === true && storage.has("staff-portal-unconfirmed:fixture-staff"));
    storage.clear(); await mount(() => PortalAccessControls(props)); response = deferred(); click("Get sign-in link"); response.resolve({ ok: true, message: "Link minted.", outcome: "confirmed", url: "https://example.test/one-time-fixture", expiresAtISO: "2026-10-01T12:00:00Z" }); await until(() => contains(tree(), "one-time-fixture"));
    c.ok("confirmed staff test link belongs to exact existing membership and visibly names its person", writes.at(-1)?.kind === "mint" && JSON.stringify(writes.at(-1)?.args) === JSON.stringify(["fixture-staff", "fixture-person"]) && contains(tree(), "Existing Person") && contains(tree(), "nothing was emailed") && !storage.size);
    response = deferred(); click("Get sign-in link"); response.reject(new Error("lost mint")); await until(() => contains(tree(), "portal access change is unconfirmed"));
    c.ok("unknown remint removes prior displayed credential and does not claim a new link exists", !contains(tree(), "one-time-fixture") && button("Get sign-in link").disabled === true);
    storage.clear(); await mount(() => PortalAccessControls({ ...props, isTestClient: false, switches: { invites: false, loginEmail: false } })); const beforeBlocked = writes.length; submit();
    c.ok("real-client invitation launch gate remains blocked and feedback stops claiming an email was sent", writes.length === beforeBlocked && field("email").disabled === true && button("Add person").disabled === true && !contains(tree(), "check your inbox"));
    storage.clear(); await mount(() => PortalAccessControls(props)); response = deferred(); click("Create link"); const other = { attemptId: randomUUID(), operation: "invite" }; storage.set("staff-portal-unconfirmed:fixture-staff", JSON.stringify(other)); response.resolve({ ok: true, message: "Own link created.", outcome: "confirmed" }); await until(() => contains(tree(), "Own link created."));
    c.ok("late known response removes only matching opaque marker and preserves a different attempt hold", JSON.parse(storage.get("staff-portal-unconfirmed:fixture-staff")!).attemptId === other.attemptId && button("Create link").disabled === true);
    storage.clear(); await mount(() => PortalSignIn({})); type("email", "prepare@example.test"); const uuid = crypto.randomUUID; const beforePrep = writes.length;
    try { crypto.randomUUID = () => { throw new Error("local preparation"); }; submit(); } finally { crypto.randomUUID = uuid; }
    c.ok("local preparation refusal is retryable and starts no send or unknown marker", writes.length === beforePrep && !storage.size && contains(tree(), "No request was started") && button("Email me").disabled === false);
    await mount(() => PasswordLoginForm({ next: "/review" }));
    const NativeFormData = globalThis.FormData;
    class FakeFormData extends NativeFormData { constructor() { super(); this.set("email", "password-fixture@example.test"); this.set("password", "isolated fixture secret"); } }
    Object.defineProperty(globalThis, "FormData", { configurable: true, value: FakeFormData });
    response = deferred(); submit(); submit();
    c.ok("password native named/labelled fields retain autocomplete and one unchanged auth payload", writes.filter((w) => w.kind === "password").length === 1 && (writes.at(-1)!.args[0] as FormData).get("next") === "/review" && field("email").label === "Email" && field("password").label === "Password" && field("password").autoComplete === "current-password" && field("password").value === undefined && button("Sign in").busy === true);
    response.reject(new Error("lost session response")); await until(() => contains(tree(), "couldn’t confirm sign-in"));
    c.ok("thrown password login catches without success/navigation or storing any credential", navigation.length === 0 && !storage.size && elements(tree(), "ActionLink").some((p) => p.href === "/") && button("Sign in").busy === false && contains(tree(), "session may already be active"));
    response = deferred(); submit(); response.resolve({ ok: false, message: "Generic credential refusal." }); await until(() => contains(tree(), "Generic credential refusal."));
    c.ok("known password refusal preserves uncontrolled fields and generic privacy error", field("password").value === undefined && field("email").value === undefined && !storage.size);
    response = deferred(); submit(); response.resolve({ ok: true, message: "", redirect: "/review" }); await until(() => navigation.length === 1);
    c.ok("successful password login uses exact existing server redirect once", navigation.join() === "/review");
    Object.defineProperty(globalThis, "FormData", { configurable: true, value: NativeFormData });
    const html = renderToStaticMarkup(tree() as ReactNode);
    c.ok("native auth controls render linked labels, readable text and 44px focusable controls", html.includes('for="password-login-email"') && html.includes('for="password-login-password"') && html.includes('name="password"') && html.includes("min-h-11") && html.includes("text-base") && html.includes("focus-visible:outline"));
    c.ok("actual-handler fixture invokes no database/provider/client/clipboard destination", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { card.stop(); fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
