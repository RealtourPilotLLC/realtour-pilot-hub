// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Delayed/failed UI-save receipts and actual first paint. No DB or provider work.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import { attemptSettingsSave, finishSettingsSave, settingsDraftDirty, type SettingsDraft, type SettingsSaveResult } from "../../src/lib/settingsDraft";

installNextStubs();
async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { SaveRow, TextTemplateSettings, TurnaroundSettings, ReviewRoomSettings } = await import("@/components/settings/OperatingRules");
    const { RoutingRulesForm } = await import("@/components/settings/RoutingRulesForm");
    const { DEFAULT_TURNAROUNDS, DEFAULT_REVIEW_ROOM } = await import("@/lib/settings");
    const original = { hours: 24, unknown: { preserve: "future config" } };
    const first = { ...original, hours: 36 };
    let state: SettingsDraft<typeof original> = { value: first, saved: original, feedback: null };
    let resolve!: (result: SettingsSaveResult) => void;
    const delayed = attemptSettingsSave(first, () => new Promise((done) => { resolve = done; }));
    state = { ...state, value: { ...first, hours: 48 } };
    resolve({ ok: true, message: "Saved submitted settings." });
    state = finishSettingsSave(state, first, await delayed);
    c.ok("late successful save acknowledges only submitted values and keeps newer edits", state.saved.hours === 36 && state.value.hours === 48 && settingsDraftDirty(state));
    const lateHtml = renderToStaticMarkup(createElement(SaveRow, { busy: false, dirty: settingsDraftDirty(state), feedback: state.feedback, onSave() {} }));
    c.ok("successful old receipt cannot claim newer input is saved", lateHtml.includes("Unsaved changes") && lateHtml.includes("Newer edits are still unsaved.") && lateHtml.includes('role="status"'));
    const rejected = await attemptSettingsSave(state.value, async () => { throw new Error("network unavailable"); });
    state = finishSettingsSave(state, state.value, rejected);
    c.ok("unconfirmed save keeps exact input and last acknowledged snapshot", !rejected.ok && state.value.hours === 48 && state.saved.hours === 36 && state.value.unknown === original.unknown);
    const failedHtml = renderToStaticMarkup(createElement(SaveRow, { busy: false, dirty: true, feedback: state.feedback, onSave() {} }));
    c.ok("network failure exposes an accessible retry without a saved claim", failedHtml.includes('role="alert"') && failedHtml.includes("try Save again") && !failedHtml.includes(">Saved<"));
    state = finishSettingsSave(state, state.value, await attemptSettingsSave(state.value, async () => ({ ok: true, message: "Saved." })));
    c.ok("same-input retry clears dirty only after confirmation", !settingsDraftDirty(state) && state.saved.hours === 48);
    const refused = finishSettingsSave({ ...state, value: { ...state.value, hours: 0 } }, { ...state.value, hours: 0 }, { ok: false, message: "Hours must be positive." });
    c.ok("server validation refusal keeps invalid draft for correction", refused.value.hours === 0 && refused.saved.hours === 48 && settingsDraftDirty(refused));
    const busyHtml = renderToStaticMarkup(createElement(SaveRow, { busy: true, dirty: true, feedback: null, onSave() {} }));
    c.ok("pending save has a disabled button and explicit saving status", busyHtml.includes("disabled") && busyHtml.includes("Saving…") && busyHtml.includes("min-h-11"));
    const templateHtml = renderToStaticMarkup(createElement(TextTemplateSettings, { initial: { confirmation: "", deliveryAll: "exact saved wording", deliveryPartial: "" } }));
    c.ok("empty template draft remains empty and builtin copy is only a placeholder", /<textarea[^>]*aria-label="Shoot confirmation"[^>]*><\/textarea>/.test(templateHtml));
    c.ok("saved template words are unchanged on first paint", templateHtml.includes(">exact saved wording</textarea>") && templateHtml.includes("Loaded settings"));
    const routing = renderToStaticMarkup(createElement(RoutingRulesForm, { initial: { standardVideo: "kim", premiumVideo: "john", personalBranding: null } }));
    c.ok("routing retains all three existing values and a named section save", routing.includes('value="kim" selected') && routing.includes('value="john" selected') && routing.includes('value="manual" selected') && routing.includes("Save routing rules"));
    const turns = renderToStaticMarkup(createElement(TurnaroundSettings, { initial: DEFAULT_TURNAROUNDS }));
    const review = renderToStaticMarkup(createElement(ReviewRoomSettings, { initial: DEFAULT_REVIEW_ROOM }));
    c.ok("turnaround and review use distinct section save and loaded states", turns.includes("Save turnaround promises") && review.includes("Save review rules") && turns.includes("Loaded settings") && review.includes("Loaded settings"));
    c.ok("rendering and feedback make no provider calls", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
