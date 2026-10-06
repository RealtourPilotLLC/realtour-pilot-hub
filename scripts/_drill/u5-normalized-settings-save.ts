// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Quiet-schedule and email-SLA receipt races. Pure normalization and SSR; no mutations.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import { attemptSettingsSave, finishNormalizedSettingsSave, settingsDraftDirty, type SettingsDraft } from "../../src/lib/settingsDraft";
import { parseQuietWindows, type NotifyScheduleRow, type QuietWindow } from "../../src/lib/notifyPrefDefaults";
import type { EmailSlaRules } from "../../src/lib/commsSla";

installNextStubs();
async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { NotificationSchedule, PersonSchedule, notificationScheduleDraft } = await import("@/components/settings/NotificationSchedule");
    const { EmailSlaSettings, EmailSlaForm } = await import("@/components/settings/EmailSlaSettings");
    const { SaveStatus } = await import("@/components/ui/SaveStatus");
    const { normaliseEmailSla } = await import("@/lib/commsSla");
    const windows: QuietWindow[] = [{ day: 6, from: 0, to: 1170 }];
    const preset: NotifyScheduleRow = {
      teamMemberId: "fixture-owner", name: "Jordan Fixture", isOwner: true, source: "preset", windows,
      setAt: null, setBy: null, summary: "Jordan is quiet on Saturday until 7:30 PM.",
      held: { texts: 2, dms: 1, nextAt: "2026-10-03T23:30:00Z" },
    };
    const office: NotifyScheduleRow = { ...preset, teamMemberId: "fixture-office", name: "Kyle Fixture", isOwner: false, source: "none", windows: [], summary: "Kyle follows the office rota.", held: { texts: 0, dms: 0, nextAt: null } };
    const savedEmpty: NotifyScheduleRow = { ...office, source: "saved", setAt: "2026-09-30T12:00:00Z", setBy: "fixture writer", summary: "Kyle has no quiet time of his own." };
    const initialBytes = JSON.stringify([preset, office, savedEmpty]);
    const ownerHtml = renderToStaticMarkup(createElement(PersonSchedule, { row: preset, onSaved() {} }));
    const officeHtml = renderToStaticMarkup(createElement(PersonSchedule, { row: office, onSaved() {} }));
    const emptyHtml = renderToStaticMarkup(createElement(PersonSchedule, { row: savedEmpty, onSaved() {} }));
    c.ok("owner preset, existing windows and held delivery evidence survive first paint", ownerHtml.includes("Jordan’s preset") && ownerHtml.includes("Sat") && ownerHtml.includes("7:30 PM") && ownerHtml.includes("2 texts and 1 Slack message"));
    c.ok("an unset office schedule stays distinct from a deliberately saved empty schedule", officeHtml.includes("not set — any hour") && !officeHtml.includes("Back to the default") && emptyHtml.includes("Back to the default") && emptyHtml.includes("fixture writer"));
    c.ok("loaded schedules never claim that a save occurred", ownerHtml.includes("Loaded settings") && officeHtml.includes("Loaded settings") && emptyHtml.includes("Loaded settings"));
    c.ok("schedule controls have a person-specific save and readable input names", ownerHtml.includes("Save Jordan’s schedule") && ownerHtml.includes("Start of Jordan&#x27;s quiet time") && ownerHtml.includes("min-h-11"));
    const noPersonal = notificationScheduleDraft(office);
    const explicitEmpty = notificationScheduleDraft(savedEmpty);
    c.ok("identical empty windows retain the explicit-empty policy distinction", noPersonal.windows.length === 0 && explicitEmpty.windows.length === 0 && !noPersonal.explicitEmpty && explicitEmpty.explicitEmpty && settingsDraftDirty({ value: explicitEmpty, saved: noPersonal, feedback: null }));

    const split: QuietWindow[] = [{ day: 6, from: 0, to: 720 }, { day: 6, from: 660, to: 1170 }];
    const merged = parseQuietWindows(split);
    if (!merged) throw new Error("Fixture windows should normalize");
    const submitted = { windows: split, explicitEmpty: false };
    const accepted = notificationScheduleDraft({ ...preset, source: "saved", windows: merged, setAt: "2026-09-30T13:00:00Z" });
    const exact = finishNormalizedSettingsSave({ value: submitted, saved: notificationScheduleDraft(preset), feedback: null }, submitted, { ok: true, message: "Schedule saved." }, accepted);
    c.ok("the exact submitted schedule adopts the server's merged windows", exact.value === accepted && exact.saved === accepted && exact.value.windows.length === 1 && !settingsDraftDirty(exact));
    const newer = { windows: [...split, { day: 0, from: 600, to: 900 }], explicitEmpty: false };
    const late = finishNormalizedSettingsSave({ value: newer, saved: notificationScheduleDraft(preset), feedback: null }, submitted, { ok: true, message: "Schedule saved." }, accepted);
    c.ok("a late schedule receipt keeps newer windows and acknowledges the returned normalized snapshot", late.value === newer && late.saved === accepted && settingsDraftDirty(late));
    const resetExact = finishNormalizedSettingsSave({ value: explicitEmpty, saved: explicitEmpty, feedback: null }, explicitEmpty, { ok: true, message: "Office rota restored." }, noPersonal);
    c.ok("reset to the office rota adopts the returned source instead of turning null into saved-empty", resetExact.value === noPersonal && !resetExact.value.explicitEmpty && !settingsDraftDirty(resetExact));
    const draftAfterResetStarted = { windows: [{ day: 1, from: 0, to: 600 }], explicitEmpty: false };
    const resetLate = finishNormalizedSettingsSave({ value: draftAfterResetStarted, saved: explicitEmpty, feedback: null }, explicitEmpty, { ok: true, message: "Office rota restored." }, noPersonal);
    c.ok("windows added during reset stay unsaved while the office-rota baseline advances", resetLate.value === draftAfterResetStarted && resetLate.saved === noPersonal && settingsDraftDirty(resetLate));
    const refused = finishNormalizedSettingsSave(late, newer, { ok: false, message: "Someone changed this schedule in another tab." }, noPersonal);
    c.ok("a stale-stamp refusal preserves the current windows and last acknowledged schedule", refused.value === newer && refused.saved === accepted && refused.feedback?.ok === false);

    const initial: EmailSlaRules = { enabled: true, kyleCoveredHours: 4, ownerCoveredHours: 9, unhappyCoveredHours: 4 };
    const emailSent: EmailSlaRules = { enabled: false, kyleCoveredHours: 5.3, ownerCoveredHours: 2, unhappyCoveredHours: 4.2 };
    const normalized = normaliseEmailSla(emailSent);
    let confirm!: (value: { ok: boolean; message: string; rules: EmailSlaRules }) => void;
    const response = new Promise<{ ok: boolean; message: string; rules: EmailSlaRules }>((resolve) => { confirm = resolve; });
    const changedAfterSave = { ...emailSent, unhappyCoveredHours: 7, enabled: true };
    let emailState: SettingsDraft<EmailSlaRules> = { value: changedAfterSave, saved: initial, feedback: null };
    confirm({ ok: true, message: "Submitted email settings saved.", rules: normalized });
    const result = await response;
    emailState = finishNormalizedSettingsSave(emailState, emailSent, result, result.rules);
    c.ok("late email save retains a newer enabled choice and hours without applying them", emailState.value === changedAfterSave && emailState.value.enabled && !emailState.saved.enabled && emailState.value.unhappyCoveredHours === 7 && settingsDraftDirty(emailState));
    c.ok("the acknowledged email baseline uses existing half-hour and escalation normalization", emailState.saved.kyleCoveredHours === 5.5 && emailState.saved.ownerCoveredHours === 9 && emailState.saved.unhappyCoveredHours === 4);
    const emailExact = finishNormalizedSettingsSave({ value: emailSent, saved: initial, feedback: null }, emailSent, result, normalized);
    c.ok("without newer edits the exact submitted email form adopts returned normalized values", emailExact.value === normalized && !emailExact.value.enabled && !settingsDraftDirty(emailExact));
    const failure = await attemptSettingsSave(changedAfterSave, async () => { throw new Error("fixture network interruption"); });
    const failedEmail = finishNormalizedSettingsSave(emailState, changedAfterSave, failure, normalized);
    c.ok("unconfirmed email save does not advance the saved baseline or erase current edits", failedEmail.value === changedAfterSave && failedEmail.saved === normalized && failedEmail.feedback?.ok === false);
    const errorHtml = renderToStaticMarkup(createElement(SaveStatus, { state: "error", message: failure.message }));
    c.ok("unconfirmed receipts are an accessible alert with retry guidance", errorHtml.includes('role="alert"') && errorHtml.includes("Save not confirmed") && errorHtml.includes("try Save again"));
    const emailHtml = renderToStaticMarkup(createElement(EmailSlaForm, { initial, initialSince: "2026-09-30T12:00:00Z" }));
    const offHtml = renderToStaticMarkup(createElement(EmailSlaForm, { initial: { ...initial, enabled: false }, initialSince: null }));
    c.ok("email first paint keeps the saved enabled flag, thresholds, watermark and no-provider wording", emailHtml.includes('aria-checked="true"') && emailHtml.includes('value="4"') && emailHtml.includes('value="9"') && emailHtml.includes("Ringing since") && emailHtml.includes("never a text or a Slack message"));
    c.ok("disabled email settings stay disabled with no invented start timestamp", offHtml.includes('aria-checked="false"') && !offHtml.includes("Ringing since") && offHtml.includes("Loaded settings"));
    c.ok("email controls use a named save and do not claim success on first paint", emailHtml.includes("Save email reply alerts") && emailHtml.includes("Loaded settings") && emailHtml.includes("min-h-11"));
    const waiting = renderToStaticMarkup(createElement(NotificationSchedule)) + renderToStaticMarkup(createElement(EmailSlaSettings));
    c.ok("loading either isolated card does not replace loading with empty or disabled settings", waiting.includes("Loading schedules…") && waiting.includes("Loading email reply alerts…"));
    c.ok("all schedule fixture rows remain byte-identical", JSON.stringify([preset, office, savedEmpty]) === initialBytes);
    c.ok("pure normalization and SSR perform no provider requests", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
