// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Actual appointment component handlers, with pure deferred action fakes.
// No database, Aryeo/provider request, client email or browser is invoked.
import { isValidElement } from "react";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { fenceFetch, makeChecker } from "./_harness";
import type { ApptResult } from "../../src/app/actions";
import type { ApptView } from "../../src/components/project/AppointmentManager";
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
  const actionFile = req.resolve("../../src/app/actions.ts");
  let response = deferred<ApptResult>();
  const writes: { kind: string; id: string; date?: string; notify: boolean }[] = [];
  req.cache[actionFile] = { id: actionFile, filename: actionFile, loaded: true, exports: {
    rescheduleAppointmentAction: async (id: string, date: string, notify: boolean) => { writes.push({ kind: "reschedule", id, date, notify }); return response.promise; },
    cancelAppointmentAction: async (id: string, notify: boolean) => { writes.push({ kind: "cancel", id, notify }); return response.promise; },
  } } as NodeModule;
  const { AppointmentManager } = await import("@/components/project/AppointmentManager");
  const appt: ApptView = { id: "appointment-recovery-fixture", startAt: "2026-10-01T15:00:00.000Z", endAt: "2026-10-01T16:15:00.000Z", durationMin: 75, status: "SCHEDULED", title: "117 Exact Appointment Lane", description: "Keep the exact shoot context.", preferenceType: null, requiresConfirmation: false, canCancel: true, canReschedule: true, rescheduledAt: null, postponedAt: null, previousStartAt: null, assignedTo: { name: "Fixture Shooter", avatarColor: "#123456" } };
  let current = appt;
  let card = mountHooks(() => AppointmentManager({ appt: current }));
  const buttons = () => elements(card.render(), "Button");
  const button = (label: string) => buttons().find((p) => contains(p.children, label))!;
  const click = (label: string) => (button(label).onClick as () => void)();
  const dateField = () => elements(card.render(), "TextField")[0];
  const checkbox = () => elements(card.render(), "input").find((p) => p.type === "checkbox")!;
  const typeDate = (value: string) => (dateField().onChange as (event: { target: { value: string } }) => void)({ target: { value } });
  const tick = (checked: boolean) => (checkbox().onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked } });
  const key = () => `appointment-unconfirmed:${current.id}`;
  const fresh = async (id: string) => { card.stop(); current = { ...appt, id }; card = mountHooks(() => AppointmentManager({ appt: current })); card.render(); await Promise.resolve(); };
  try {
    card.render(); await Promise.resolve(); click("Reschedule");
    c.ok("fresh appointment keeps notification unticked and exact readable context", checkbox().checked === false && contains(card.render(), appt.title!) && dateField().hint === "This field uses your device's local time zone. Appointment times above are shown in Eastern time.");
    typeDate("2026-10-02T12:30"); tick(true);
    const confirm = button("Confirm reschedule"); (confirm.onClick as () => void)(); (confirm.onClick as () => void)();
    c.ok("same-tick confirm starts one unchanged exact appointment/time/notify payload", writes.length === 1 && writes[0].id === appt.id && writes[0].date === new Date("2026-10-02T12:30").toISOString() && writes[0].notify === true);
    typeDate("2026-10-03T14:45"); tick(false);
    c.ok("pending mutation controls freeze while native newer input stays editable", button("Confirm reschedule").disabled === true && button("Reschedule").disabled === true && dateField().value === "2026-10-03T14:45" && checkbox().checked === false);
    response.resolve({ ok: true, message: "Appointment rescheduled.", outcome: "confirmed" });
    await until(() => contains(card.render(), "Your newer local date"));
    c.ok("confirmed older request preserves newer draft visibly and clears only its own marker", dateField().value === "2026-10-03T14:45" && checkbox().checked === false && button("Confirm reschedule").disabled === false && !storage.has(key()));
    response = deferred(); click("Confirm reschedule"); typeDate("2026-10-04T09:15"); tick(true);
    response.reject(new Error("isolated lost post-provider response")); await until(() => contains(card.render(), "appointment change is unconfirmed"));
    const saved = JSON.parse(storage.get(key())!);
    c.ok("rejection preserves latest exact date/email choice with opaque attempt identity only", dateField().value === "2026-10-04T09:15" && checkbox().checked === true && saved.draft.start === "2026-10-04T09:15" && saved.draft.notify === true && /^[0-9a-f-]{36}$/i.test(saved.attemptId) && !storage.get(key())?.includes(appt.title!));
    const beforeRetry = writes.length; click("Confirm reschedule");
    c.ok("unknown outcome blocks blind retry and provides concrete office inspection guidance", writes.length === beforeRetry && button("Confirm reschedule").disabled === true && contains(card.render(), "Ask Kyle") && contains(card.render(), "hub timeline") && contains(card.render(), "Reloading does not prove"));
    card.stop(); card = mountHooks(() => AppointmentManager({ appt: current })); card.render(); click("Reschedule"); click("Confirm reschedule");
    await until(() => contains(card.render(), "appointment change is unconfirmed"));
    c.ok("refresh restores latest held draft and reveals reschedule panel without repeating a writer", dateField().value === "2026-10-04T09:15" && checkbox().checked === true && button("Confirm reschedule").disabled === true && writes.length === beforeRetry && storage.get(key())?.includes(saved.attemptId) === true);
    typeDate("2026-10-05T11:30"); tick(false);
    c.ok("later native edits under unknown hold update only its exact device mirror", JSON.parse(storage.get(key())!).draft.start === "2026-10-05T11:30" && JSON.parse(storage.get(key())!).draft.notify === false && writes.length === beforeRetry);
    await fresh("appointment-known-refusal"); response = deferred(); click("Reschedule"); typeDate("2026-10-06T10:15"); click("Confirm reschedule");
    response.resolve({ ok: false, message: "Aryeo is not connected.", outcome: "refused" }); await until(() => contains(card.render(), "Aryeo is not connected."));
    c.ok("typed pre-provider refusal keeps draft and permits a deliberate retry without unknown hold", dateField().value === "2026-10-06T10:15" && button("Confirm reschedule").disabled === false && !storage.has(key()) && !contains(card.render(), "appointment change is unconfirmed"));
    response = deferred(); click("Confirm reschedule"); response.resolve({ ok: false, message: "Aryeo timed out.", outcome: "unknown" }); await until(() => contains(card.render(), "appointment change is unconfirmed"));
    c.ok("returned provider uncertainty also holds, rather than trusting false as retry permission", button("Confirm reschedule").disabled === true && storage.has(key()));
    await fresh("appointment-legacy-outcome"); response = deferred(); click("Cancel shoot"); click("Yes, cancel shoot"); response.resolve({ ok: true, message: "Appointment cancelled." }); await until(() => contains(card.render(), "appointment change is unconfirmed"));
    c.ok("omitted legacy outcome is conservative even if its boolean says success", button("Yes, cancel shoot").disabled === true && storage.has(key()));
    await fresh("appointment-late-marker"); response = deferred(); click("Reschedule"); click("Confirm reschedule");
    const other = { appointmentId: current.id, attemptId: randomUUID(), operation: "cancel", draft: { start: "2026-10-07T11:30", notify: true } }; storage.set(key(), JSON.stringify(other));
    response.resolve({ ok: true, message: "Appointment rescheduled.", outcome: "confirmed" }); await until(() => contains(card.render(), "Appointment rescheduled."));
    c.ok("late terminal response cannot erase a different tab's newer hold marker", JSON.parse(storage.get(key())!).attemptId === other.attemptId);
    const beforeOther = writes.length; click("Reschedule"); click("Confirm reschedule");
    c.ok("run entry synchronously refuses an existing other-attempt marker", writes.length === beforeOther && button("Yes, cancel shoot").disabled === true && contains(card.render(), "appointment change is unconfirmed"));
    await fresh("appointment-cancel-refresh"); response = deferred(); click("Cancel shoot");
    c.ok("independent cancel starts with deliberate notification unticked", checkbox().checked === false);
    click("Yes, cancel shoot"); tick(true); const cancelCall = writes.at(-1)!;
    response.reject(new Error("isolated cancellation response lost")); await until(() => contains(card.render(), "appointment change is unconfirmed"));
    card.stop(); card = mountHooks(() => AppointmentManager({ appt: current })); card.render(); await until(() => contains(card.render(), "appointment change is unconfirmed"));
    c.ok("lost cancellation restores visible held cancel panel and later explicit email choice", cancelCall.kind === "cancel" && cancelCall.id === current.id && cancelCall.notify === false && checkbox().checked === true && button("Yes, cancel shoot").disabled === true);
    await fresh("appointment-known-success"); response = deferred(); click("Cancel shoot"); click("Yes, cancel shoot"); response.resolve({ ok: true, message: "Appointment cancelled.", outcome: "confirmed" }); await until(() => contains(card.render(), "Appointment cancelled."));
    c.ok("unchanged known confirmed action retains ordinary close/success behavior", !button("Yes, cancel shoot") && !storage.has(key()));
    await fresh("appointment-preparation"); response = deferred(); click("Reschedule"); typeDate("not-a-date"); const beforePrep = writes.length; click("Confirm reschedule");
    c.ok("invalid local datetime produces retryable feedback before any provider-unknown marker", contains(card.render(), "Choose a valid date") && dateField().value === "not-a-date" && writes.length === beforePrep && !storage.has(key()) && !contains(card.render(), "appointment change is unconfirmed"));
    typeDate("2026-10-08T10:00"); const uuid = crypto.randomUUID;
    try { crypto.randomUUID = () => { throw new Error("isolated UUID preparation unavailable"); }; click("Confirm reschedule"); }
    finally { crypto.randomUUID = uuid; }
    c.ok("failed ID preparation cannot strand busy or invent an unknown provider write", contains(card.render(), "could not be prepared") && button("Confirm reschedule").disabled === false && writes.length === beforePrep && !storage.has(key()) && dateField().value === "2026-10-08T10:00");
    click("Confirm reschedule"); response.resolve({ ok: true, message: "Prepared retry confirmed.", outcome: "confirmed" }); await until(() => contains(card.render(), "Prepared retry confirmed."));
    c.ok("deliberate valid retry after local preparation refusal retains exact original conversion", writes.length === beforePrep + 1 && writes.at(-1)?.date === new Date("2026-10-08T10:00").toISOString() && !storage.has(key()));
    card.stop(); current = { ...appt, id: "appointment-prehydrate-input" };
    const recovered = { appointmentId: current.id, attemptId: randomUUID(), operation: "reschedule", draft: { start: "2026-10-09T10:00", notify: false } }; storage.set(key(), JSON.stringify(recovered));
    card = mountHooks(() => AppointmentManager({ appt: current })); card.render(); click("Reschedule"); typeDate("2026-10-10T11:45"); tick(true); const beforeHydrate = writes.length; click("Confirm reschedule"); await Promise.resolve();
    c.ok("a native edit before recovery hydration is mirrored without overwriting it or replaying an old writer", dateField().value === "2026-10-10T11:45" && checkbox().checked === true && JSON.parse(storage.get(key())!).draft.start === "2026-10-10T11:45" && JSON.parse(storage.get(key())!).draft.notify === true && writes.length === beforeHydrate && button("Confirm reschedule").disabled === true);
    card.stop(); current = { ...appt, id: "appointment-readonly", canCancel: false, canReschedule: false }; card = mountHooks(() => AppointmentManager({ appt: current }));
    c.ok("existing appointment eligibility still suppresses all mutation controls", !button("Cancel shoot") && !button("Reschedule"));
    card.stop(); current = { ...appt, id: "appointment-canceled", status: "CANCELED" }; card = mountHooks(() => AppointmentManager({ appt: current }));
    c.ok("existing canceled appointment remains noneditable", !button("Cancel shoot") && !button("Reschedule"));
    c.ok("component-only fake handlers never query database or contact provider/client destinations", fence.faked.length === 0 && fence.blocked.length === 0);
    c.summary();
  } finally { card.stop(); fence.restore(); }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
