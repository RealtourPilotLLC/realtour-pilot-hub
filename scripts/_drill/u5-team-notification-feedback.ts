// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// Team preference first paint and late/failed per-person save receipts. No DB or sends.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installNextStubs, makeChecker, fenceFetch } from "./_harness";
import {
  NOTIFY_EVENTS, clearInapplicable, defaultPrefsForRow, eventAppliesTo, notifyGroupLabel,
  type NotifyPrefs, type TeamNotifyRow,
} from "../../src/lib/notifyPrefDefaults";
import { attemptSettingsSave, finishSettingsSave, settingsDraftDirty, type SettingsDraft, type SettingsSaveResult } from "../../src/lib/settingsDraft";

installNextStubs();
async function main() {
  const c = makeChecker();
  const fence = fenceFetch();
  try {
    const { TeamNotifications } = await import("@/components/settings/TeamNotifications");
    const { SaveRow } = await import("@/components/settings/OperatingRules");
    const roles = [
      { name: "Jordan Fixture", role: "PHOTOGRAPHER", isOwner: true, isEditor: false },
      { name: "Kim Fixture", role: "MANAGER", isOwner: false, isEditor: true },
      { name: "James Fixture", role: "PHOTOGRAPHER", isOwner: false, isEditor: false },
      { name: "Kyle Fixture", role: "MANAGER", isOwner: false, isEditor: false },
    ];
    const rows: TeamNotifyRow[] = roles.map((role, i) => ({
      ...role, teamMemberId: `team-fixture-${i}`, slackId: i === 3 ? null : "fixture-slack", hasPhone: i !== 3,
      phoneNote: i === 3 ? "company_line" : undefined, prefs: defaultPrefsForRow(role), explicit: i === 3,
      lastReached: i === 3 ? { slack: { at: "2026-09-20T14:00:00Z", kind: "mention" }, failed: { at: "2026-09-20T15:00:00Z", detail: "fixture delivery rejected" } } : undefined,
    }));
    // A saved applicable preference remains set even when its channel is unavailable.
    rows[3].prefs.review_ready.sms = true;
    // The existing group boundary still clears a saved event that cannot address this person.
    rows[0].prefs.project_message = { slack: true, sms: true };
    const before = JSON.stringify(rows);
    for (const row of rows) {
      const html = renderToStaticMarkup(createElement(TeamNotifications, { rows: [row] }));
      const switches = [...html.matchAll(/<button\b[^>]*role="switch"[^>]*>/g)].map((match) => match[0]);
      const group = notifyGroupLabel(row);
      const expected = clearInapplicable(row.prefs, group);
      c.ok(`${group} keeps the exact applicable saved channel matrix and disabled boundaries`, switches.length === NOTIFY_EVENTS.length * 2 && NOTIFY_EVENTS.every((event, index) => ["slack", "sms"].every((channel, channelIndex) => {
        const key = channel as "slack" | "sms";
        const switchHtml = switches[index * 2 + channelIndex];
        const enabled = eventAppliesTo(event.key, group) && (key === "slack" ? !!row.slackId : row.hasPhone);
        return switchHtml.includes(`aria-checked="${expected[event.key][key]}"`) && switchHtml.includes('disabled=""') === !enabled;
      })));
      c.ok(`${group} names its own save and starts from a loaded receipt`, html.includes(`Save ${row.name.split(" ")[0]}&#x27;s notifications`) && html.includes("Loaded settings"));
      if (group === "Office") c.ok("missing channels keep their explanation and actual delivery history", html.includes("company line") && html.includes("no Slack ID") && html.includes("Last reached: Slack") && html.includes("fixture delivery rejected"));
    }
    c.ok("rendering leaves all input preferences and default permissions untouched", JSON.stringify(rows) === before);
    c.ok("photographer review and job-ping defaults remain off", !rows[2].prefs.review_ready.sms && !rows[2].prefs.job_ping.sms && !rows[2].prefs.review_ready.slack && !rows[2].prefs.job_ping.slack);

    const initial = clearInapplicable(rows[2].prefs, "Photographer");
    const submitted = { ...initial, mention: { ...initial.mention, sms: false } };
    const newer = { ...submitted, project_message: { ...submitted.project_message, slack: true } };
    let state: SettingsDraft<NotifyPrefs> = { value: submitted, saved: initial, feedback: null };
    let acknowledge!: (result: SettingsSaveResult) => void;
    const delayed = attemptSettingsSave(submitted, () => new Promise((resolve) => { acknowledge = resolve; }));
    state = { ...state, value: newer };
    acknowledge({ ok: true, message: "James's submitted preferences saved." });
    state = finishSettingsSave(state, submitted, await delayed);
    c.ok("a late preference receipt retains a different channel edited after Save", state.value === newer && state.saved === submitted && settingsDraftDirty(state));
    const receipt = renderToStaticMarkup(createElement(SaveRow, { busy: false, dirty: settingsDraftDirty(state), feedback: state.feedback, onSave() {} }));
    c.ok("the older successful receipt clearly identifies newer unsaved preferences", receipt.includes("Newer edits are still unsaved.") && receipt.includes('role="status"'));
    const failure = await attemptSettingsSave(state.value, async () => { throw new Error("fixture disconnected"); });
    state = finishSettingsSave(state, state.value, failure);
    const error = renderToStaticMarkup(createElement(SaveRow, { busy: false, dirty: true, feedback: state.feedback, onSave() {} }));
    c.ok("an unconfirmed save preserves exact current and saved preferences with an alert", state.value === newer && state.saved === submitted && error.includes('role="alert"') && error.includes("try Save again"));
    c.ok("per-person save snapshots do not mutate another person's preferences", JSON.stringify(rows) === before);
    c.ok("fixture rendering and receipts make no provider requests", fence.blocked.length === 0);
    c.summary();
  } finally { fence.restore(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
