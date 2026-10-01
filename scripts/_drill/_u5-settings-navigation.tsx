// Pure/SSR acceptance for Settings search and disclosure boundaries. No DB or providers.
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsGroup } from "../../src/components/settings/SettingsGroup";
import { SettingsNav } from "../../src/components/settings/SettingsNav";
import { SettingsSearchCard, SettingsSearchOverview } from "../../src/components/settings/SettingsGroupDisclosure";
import { SettingsSearchContext } from "../../src/components/settings/SettingsSearchContext";
import { SETTINGS_CARD_KEYS, SETTINGS_LAYOUT, settingsCardMatches, settingsGroupMatches, settingsGroupsFor } from "../../src/lib/settingsNavigation";

let checked = 0;
function check(label: string, condition: boolean) { assert.ok(condition, label); checked++; console.log(`PASS ${label}`); }
const groups = settingsGroupsFor(true);
const find = (query: string, owner = true) => settingsGroupsFor(owner).filter((group) => settingsGroupMatches(group, query)).map((group) => group.id);
check("seven owner sections remain in their original order", groups.map((group) => group.id).join() === "team,scheduling,production,program,comms,integrations,financial");
check("reviewer coverage finds Production without integration scanning", find("reviewer coverage").join() === "production");
check("reviewer coverage exposes its setting card only", SETTINGS_CARD_KEYS.filter((key) => settingsCardMatches(key, "reviewer coverage")).join() === "review-room");
check("reminder rules finds the policy card", settingsCardMatches("program-reminders", "reminder rules") && !settingsCardMatches("program-automations", "reminder rules"));
check("search handles whitespace, case and accents", find("  RÉVIEWER   Coverage ").join() === "production");
check("blank search restores every authorized section", find("   ").length === 7 && find("", false).length === 6);
check("unknown label is an empty result, without inventing matches", find("no-such-setting").length === 0);
check("no group matches words split across unrelated cards", find("Topaz reviewer").length === 0);
check("owner financial vocabulary does not expose a group to admins", find("bank feeds", false).length === 0 && find("bank feeds").join() === "financial");
check("group-name search retains every card in that section", SETTINGS_LAYOUT.program.every((key) => settingsCardMatches(key, "content program")));

const tree = (owner: boolean, query = "") => <SettingsSearchContext.Provider value={query}>
  {settingsGroupsFor(owner).map((group) => <SettingsGroup key={group.id} group={group} snapshot={group.id === "program" ? "Switches could not be read." : "Loaded fixture value"}>
    {SETTINGS_LAYOUT[group.id].map((key) => <SettingsSearchCard key={key} settingKey={key}>
      <label>{key}<input name={key} defaultValue={`unsaved-${key}`} /></label>
    </SettingsSearchCard>)}
  </SettingsGroup>)}
</SettingsSearchContext.Provider>;
const initial = renderToStaticMarkup(tree(true));
const admin = renderToStaticMarkup(tree(false));
const filtered = renderToStaticMarkup(tree(true, "reviewer coverage"));
check("default sections use native collapsed disclosures", (initial.match(/data-settings-disclosure/g) ?? []).length === 7 && !/<details[^>]*\sopen(?:[\s=>])/.test(initial));
check("all original cards render once under disclosures", SETTINGS_CARD_KEYS.every((key) => (initial.match(new RegExp(`data-settings-card="${key}"`, "g")) ?? []).length === 1));
check("admin rendering omits financial controls and values", !admin.includes('id="financial"') && !admin.includes('name="pay-view"'));
check("filtered-out cards keep their input mounted", SETTINGS_CARD_KEYS.every((key) => filtered.includes(`value="unsaved-${key}"`)));
check("filtered-out groups and cards leave the focusable tree", /<section[^>]*id="scheduling"[^>]*hidden=""/.test(filtered) && /<div[^>]*data-settings-card="topaz"[^>]*hidden=""/.test(filtered));
check("matching card stays exposed in its matching section", !/<section[^>]*id="production"[^>]*hidden=""/.test(filtered) && !/<div[^>]*data-settings-card="review-room"[^>]*hidden=""/.test(filtered));
check("unreadable snapshot is visible without claiming off or healthy", initial.includes("Loaded values:") && initial.includes("Switches could not be read."));
const ids = [...initial.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
check("group and setting anchors remain unique", ids.length === new Set(ids).size && groups.every((group) => ids.includes(group.id)) && SETTINGS_CARD_KEYS.every((key) => ids.includes(key)));
const navigation = renderToStaticMarkup(<SettingsNav groups={settingsGroupsFor(false)} />);
check("admin navigation keeps plain section anchors and omits Financial", navigation.includes('href="#program"') && navigation.includes('href="#readiness"') && !navigation.includes('href="#financial"'));
check("search has an accessible label and result announcement", navigation.includes('for="settings-search"') && navigation.includes('role="status"'));
const overview = renderToStaticMarkup(<SettingsSearchContext.Provider value="reminders"><SettingsSearchOverview><span>Readiness stays mounted</span></SettingsSearchOverview></SettingsSearchContext.Provider>);
check("search clears the readiness wall while retaining its content", overview.includes('hidden=""') && overview.includes("Readiness stays mounted"));
console.log(`\n${checked} passed, 0 failed`);
console.log("Browser keyboard/hash/dirty-input acceptance remains separate.");
