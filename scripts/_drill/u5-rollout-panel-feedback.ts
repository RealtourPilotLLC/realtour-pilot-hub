// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Rollout/write-scope local receipts and draft context. Mock operations only; no writes or sends.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import { attemptPanelOperation, changeSettingsPanel, readSettingsPanel, refreshPanelChoice, type PanelChoice } from "../../src/lib/settingsPanelFeedback";
import { PROGRAM_PILOT_GROUPS, type RolloutMode } from "../../src/lib/programRolloutCore";
import type { ProgramRolloutPanelData } from "../../src/app/settings/rolloutActions";
import type { HubWriteScopesPayload } from "../../src/app/settings/pilotActions";

installNextStubs();
async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { ProgramRolloutPanel, PilotForm, EditPilotForm, HeldAccessReceipt } = await import("@/components/settings/ProgramRolloutPanel");
    const { HubWriteScopePanel } = await import("@/components/settings/HubWriteScopePanel");
    const rollout: ProgramRolloutPanelData = {
      mode: "TEST_ONLY", modeSinceISO: "2026-09-30T12:00:00Z", problem: null, updatedBy: "fixture owner", updatedAtISO: "2026-09-30T12:00:00Z", cap: 3,
      pilot: { state: "ACTIVE", clients: [{ id: "fixture-pilot", name: "Pilot Fixture", joinedAtISO: "2026-09-29T12:00:00Z" }], groups: ["accounts", "bookings"], approvedBy: "fixture owner", approvedAtISO: "2026-09-29T12:00:00Z", expiresAtISO: "2026-11-01T04:00:00Z", note: "Keep this exact pilot note." },
      groups: PROGRAM_PILOT_GROUPS.map(({ key, label }) => ({ key, label })), candidates: [{ id: "fixture-candidate", name: "Candidate Fixture" }],
      audience: [{ clientId: "fixture-pilot", name: "Pilot Fixture", tier: null, code: "rollout_test_only", reason: "The rollout remains TEST only.", groups: [] }], switchesOn: [],
    };
    const scopes: HubWriteScopesPayload = {
      switches: [{ switchKey: "call_booking", title: "Strategy call booking", enabled: false, missing: false, headline: "off — no hub writes for anyone", fixtures: [{ id: "fixture-test", name: "TEST Fixture", problem: "fixture refusal evidence" }], pilot: { state: "ACTIVE", clients: [{ id: "fixture-pilot", name: "Pilot Fixture" }], groups: ["booking"], approvedBy: "fixture owner", approvedAtISO: "2026-09-29T12:00:00Z", expiresAtISO: null, note: "Retain pilot evidence" }, groups: [{ key: "booking", label: "Strategy call booking" }], pilotSource: "program", pilotProblem: null }], candidates: [],
    };
    const before = JSON.stringify([rollout, scopes]);
    let actions = 0;
    let reads = 0;
    const confirmed = { ok: true, message: "Fixture membership removed; the provider switch stayed off." };
    const savedUnreadable = await changeSettingsPanel(async () => { actions++; return confirmed; }, async () => { reads++; throw new Error("fixture read unavailable"); });
    c.ok("a confirmed write remains confirmed when its read-back fails", savedUnreadable.result === confirmed && savedUnreadable.read?.ok === false && !savedUnreadable.requiresRefresh && actions === 1 && reads === 1);
    c.ok("read-back failure does not invent 'nothing changed' or resend the mutation", savedUnreadable.read?.ok === false && !savedUnreadable.read.message.includes("Nothing has changed") && actions === 1);
    const retryRead = await readSettingsPanel(async () => { reads++; return scopes; });
    c.ok("retrying Refresh reads the current list without repeating removal", retryRead.ok && retryRead.data === scopes && actions === 1 && reads === 2);
    const refused = { ok: false, message: "The owner permission check refused this change." };
    const rejection = await changeSettingsPanel(async () => { actions++; return refused; }, async () => { reads++; return scopes; });
    c.ok("a returned permission refusal stays distinct from an unconfirmed mutation", rejection.result === refused && rejection.read === null && !rejection.requiresRefresh && reads === 2);
    const unknown = await changeSettingsPanel(async () => { actions++; throw new Error("fixture connection lost after dispatch"); }, async () => { reads++; return scopes; });
    c.ok("an unconfirmed mutation requires the refresh lock and is never automatically retried", !unknown.result.ok && unknown.requiresRefresh && unknown.result.message.includes("could not be confirmed") && unknown.result.message.includes("Refresh") && unknown.read === null && actions === 3 && reads === 2);
    const deniedRead = await readSettingsPanel(async () => ({ error: "Fixture access denied" }));
    c.ok("a failed panel read stays failure rather than an empty allowed scope", !deniedRead.ok && deniedRead.message === "Fixture access denied");

    let resolveRead!: (result: ProgramRolloutPanelData) => void;
    const delayed = readSettingsPanel(() => new Promise<ProgramRolloutPanelData>((resolve) => { resolveRead = resolve; }));
    let draft: PanelChoice<RolloutMode> = { value: "TEST_ONLY", saved: "TEST_ONLY" };
    draft = { ...draft, value: "ALL" };
    resolveRead({ ...rollout, mode: "PILOT" });
    const late = await delayed;
    if (!late.ok) throw new Error("Fixture read should succeed");
    draft = refreshPanelChoice(draft, late.data.mode);
    c.ok("a late read advances the actual mode without discarding a newer unsaved choice", draft.value === "ALL" && draft.saved === "PILOT");
    const untouched = refreshPanelChoice<RolloutMode>({ value: "TEST_ONLY", saved: "TEST_ONLY" }, "PILOT");
    c.ok("an untouched choice follows refreshed settings rather than inventing an unsaved revert", untouched.value === "PILOT" && untouched.saved === "PILOT");
    const same = refreshPanelChoice<RolloutMode>({ value: "PILOT", saved: "TEST_ONLY" }, "PILOT");
    c.ok("a read confirming the chosen mode leaves it clean without another action", same.value === same.saved && actions === 3);

    let previewCalls = 0;
    const previewFailure = { ok: false, message: "Preview failed; no current release list is available." };
    const preview = await attemptPanelOperation(async () => { previewCalls++; throw new Error("fixture preview unavailable"); }, previewFailure);
    c.ok("a thrown read-only preview has an explicit failure and no retry loop", preview === previewFailure && previewCalls === 1);
    const partialReceipt = renderToStaticMarkup(createElement(HeldAccessReceipt, { result: { ok: true, message: "1 account opened · 2 still held · 1 needs a person: fixture conflict.", granted: 1, held: 2, conflicts: ["fixture conflict"] } }));
    c.ok("partial release preserves granted/held/conflict evidence and gives the next safe step", partialReceipt.includes("Some access remains held or needs attention") && partialReceipt.includes("1 account opened") && partialReceipt.includes("2 still held") && partialReceipt.includes("fixture conflict") && partialReceipt.includes("Preview held access again") && partialReceipt.includes('role="status"'));
    const failedReceipt = renderToStaticMarkup(createElement(HeldAccessReceipt, { result: { ok: false, message: "Outcome unavailable; some welcomes may have been processed.", granted: 0, held: 0, conflicts: [] } }));
    c.ok("an unknown release is an alert and never treats placeholder zero counts as confirmed", failedReceipt.includes('role="alert"') && failedReceipt.includes("Release not confirmed") && failedReceipt.includes("may have been processed") && !failedReceipt.includes("0 accounts") && failedReceipt.includes("Preview held access again"));

    const owner = renderToStaticMarkup(createElement(ProgramRolloutPanel, { isOwner: true, initial: rollout }));
    const admin = renderToStaticMarkup(createElement(ProgramRolloutPanel, { isOwner: false, initial: rollout }));
    c.ok("rollout first paint preserves the actual mode, pilot cap, exact note and disabled feature state", owner.includes('data-rollout-mode="TEST_ONLY"') && owner.includes("at most 3 real clients") && owner.includes("Keep this exact pilot note.") && owner.includes("No client-reaching switch is on"));
    c.ok("owner controls retain their existing mode confirmation and pilot actions", owner.includes("EVERY CLIENT") && owner.includes("Add a pilot client") && owner.includes("End the pilot") && owner.includes("Held portal access: preview"));
    c.ok("admin view exposes previews but no owner rollout changes or held-access release controls", admin.includes("Only Jordan can change it") && admin.includes("What would go out now?") && !admin.includes("Add a pilot client") && !admin.includes("End the pilot") && !admin.includes("Held portal access: preview"));
    const pendingAdd = renderToStaticMarkup(createElement(PilotForm, { data: rollout, busy: true, onSave() { throw new Error("SSR must not approve anything"); } }));
    const pendingEdit = renderToStaticMarkup(createElement(EditPilotForm, { data: rollout, busy: true, onSave() { throw new Error("SSR must not change anything"); } }));
    c.ok("the entire submitted pilot form is frozen while pending, including date, groups and note", /^<fieldset disabled=""/.test(pendingAdd) && /^<fieldset disabled=""/.test(pendingEdit) && pendingAdd.includes('type="date"') && pendingAdd.includes('maxLength="500"') && pendingEdit.includes('value="2026-10-31"'));
    const addDefaults = renderToStaticMarkup(createElement(PilotForm, { data: { ...rollout, pilot: null }, busy: false, onSave() {} }));
    const addExisting = renderToStaticMarkup(createElement(PilotForm, { data: rollout, busy: false, onSave() {} }));
    // Oct 5 2026: six groups ("Messages you send yourself" joined them).
    c.ok("new pilot still defaults to every group while an existing pilot keeps its saved two", (addDefaults.match(/type="checkbox"[^>]*checked=""/g) ?? []).length === PROGRAM_PILOT_GROUPS.length && (addExisting.match(/type="checkbox"[^>]*checked=""/g) ?? []).length === 2);
    const writeOwner = renderToStaticMarkup(createElement(HubWriteScopePanel, { isOwner: true, initial: scopes }));
    const writeAdmin = renderToStaticMarkup(createElement(HubWriteScopePanel, { isOwner: false, initial: scopes }));
    c.ok("write scopes keep switch-off state, fixture refusal and the single program pilot link", writeOwner.includes("switch off") && writeOwner.includes("fixture refusal evidence") && writeOwner.includes("Pilot Fixture") && writeOwner.includes('href="#program-rollout"'));
    c.ok("only the owner gets a named fixture removal control; no pilot editor is added", writeOwner.includes("Remove TEST Fixture from Strategy call booking") && !writeAdmin.includes("Remove TEST Fixture") && writeAdmin.includes("See the program pilot") && !writeOwner.includes("Approve for the pilot"));
    c.ok("panels retain anchors and expose explicit read-only refresh controls", owner.includes('id="program-rollout"') && writeOwner.includes('id="hub-write-scopes"') && owner.includes("Refresh program scope") && writeOwner.includes("Refresh write scopes"));
    c.ok("all isolated component fixtures remain unchanged", JSON.stringify([rollout, scopes]) === before);
    c.ok("mock operations and real SSR make no provider requests", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
