import type { SettingsGroupId } from "@/lib/readiness";

// ---------------------------------------------------------------------------
// SETTINGS, GROUPED BY PURPOSE (11-settings-grouping, unified handoff §11,
// Sep 28 2026).
//
// "Settings should group existing controls by purpose: team/permissions and
// coverage; scheduling/turnaround; production/review policies; content
// program; communication/notifications; integrations; financial settings.
// This is an organizational proposal within the current settings shell, not
// authority to change saved values."
//
// So this is a heading and a sentence around cards that are otherwise exactly
// what they were: every card keeps its own save, its own id, its own anchor.
// The sentence says what the controls in the group DECIDE, in plain words, so
// a person scanning for "who gets told" or "what clients receive" lands in the
// right place without reading fourteen card titles.
//
// `ownerOnly` is enforced where the groups are chosen (settingsGroupsFor), not
// by hiding markup: an owner-only group is never rendered for anyone else.
// ---------------------------------------------------------------------------

export type SettingsGroupDef = {
  id: SettingsGroupId;
  /** The heading. */
  title: string;
  /** The chip in the section nav — short enough to wrap cleanly at 375 px. */
  short: string;
  /** What the controls in here decide, in plain words. */
  summary: string;
  ownerOnly?: boolean;
};

/** In page order. The ids are the anchors (#team, #program, …). */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  {
    id: "team",
    title: "Team, permissions & coverage",
    short: "Team",
    summary: "Who on the team is told about what, who is coached on their client messages, and where logins and coverage hours are managed. These decide which person hears about work, not what the work is.",
  },
  {
    id: "scheduling",
    title: "Scheduling & turnaround",
    short: "Scheduling",
    summary: "The delivery times we promise clients, and how content-program strategy calls are booked and matched to a client's month.",
  },
  {
    id: "production",
    title: "Production & review",
    short: "Production",
    summary: "Who a new edit goes to, who reviews a finished cut, what happens to an approved video, and what each Aryeo product actually produces.",
  },
  {
    id: "program",
    title: "Content program",
    short: "Content program",
    summary: "The content program's automations and its client reminders. Every switch that would reach a client stays closed until launch is approved, and each one says what it needs before it can work.",
  },
  {
    id: "comms",
    title: "Communication & notifications",
    short: "Communication",
    summary: "The texts clients receive without anyone pressing send, the words they use, and the team's alerts, coverage hours and quiet time.",
  },
  {
    id: "integrations",
    title: "Integrations",
    short: "Integrations",
    summary: "Which outside services are connected and working, and which automations depend on each one. Read-only here: nothing on this page connects or disconnects a service.",
  },
  {
    id: "financial",
    title: "Financial",
    short: "Financial",
    summary: "What photographers are shown about their pay, and where payroll and bank feeds are managed. Only you see this group.",
    ownerOnly: true,
  },
];

/** Every card the page renders, by the name its wrapper carries (data-settings-card). */
export const SETTINGS_CARD_KEYS = [
  "editor-routing", "automated-texts", "text-wording", "turnaround", "internal-alerts", "team-notifications", "coaching",
  "pay-view", "review-room", "topaz", "program-automations", "program-reminders", "calendly", "product-categories",
] as const;
export type SettingsCardKey = (typeof SETTINGS_CARD_KEYS)[number];

/**
 * Which cards sit in which group, in order — the ONE place a card is placed, so
 * it cannot be dropped or shown twice by editing a group. The ui03 drill checks
 * this list covers every card exactly once. Integrations holds no existing
 * card (its readiness rows are new and read-only); the page adds it.
 */
export const SETTINGS_LAYOUT: Record<SettingsGroupId, readonly SettingsCardKey[]> = {
  team: ["team-notifications", "coaching"],
  scheduling: ["turnaround", "calendly"],
  production: ["editor-routing", "review-room", "topaz", "product-categories"],
  program: ["program-automations", "program-reminders"],
  comms: ["automated-texts", "text-wording", "internal-alerts"],
  integrations: [],
  financial: ["pay-view"],
};

/** The groups this viewer sees. An owner-only group is left out entirely for anyone else. */
export function settingsGroupsFor(isOwner: boolean): SettingsGroupDef[] {
  return SETTINGS_GROUPS.filter((g) => !g.ownerOnly || isOwner);
}

/** Labels and operator vocabulary only; never search saved values or secrets. */
export const SETTINGS_SEARCH_LABELS: Record<SettingsCardKey, string> = {
  "editor-routing": "Editor auto-assignment routing standard premium personal branding manual",
  "automated-texts": "Automated texts confirmation delivery feedback after hours welcome send window hours timezone Eastern ET",
  "text-wording": "Text wording templates confirmation delivery placeholders message",
  turnaround: "Turnaround promises photos drone twilight floor plan 3D tour headshot virtual staging video monthly hours business days",
  "internal-alerts": "Internal alerts notification schedule coverage hours on call quiet time urgent Slack digests",
  "team-notifications": "Team notifications members mentions project messages bell Slack SMS phone channels",
  coaching: "Comms coaching audited team members report send notes",
  "pay-view": "Photographer pay view visibility paused payroll financial",
  "review-room": "Review Room reviewer coverage primary backup fallback creative approver offer transfer covered hours upload retention Dropbox discovery",
  topaz: "1080p video pass Topaz upscale enhancement limits credits",
  "program-automations": "Content program automations switches enabled dependencies rollout pilot client scope AI script drafting call transcript discovery monthly",
  "program-reminders": "Program reminders policy rules templates email cadence timezone quiet hours snooze dry run ledger failed unknown",
  calendly: "Calendly content program calls event type mappings booking discovery monthly transcript matching Drive",
  "product-categories": "Product categories Aryeo product map photo video tier shoot add-on",
};

const GROUP_EXTRA_SEARCH: Partial<Record<SettingsGroupId, string>> = {
  team: "People access logins permissions passwords team coverage on call",
  integrations: "Connections connected provider Gmail OpenPhone Slack Dropbox Aryeo Calendly Drive Topaz Anthropic API run health sync cron",
  financial: "Payroll bank feeds accounts Plaid mileage adjustments pay",
};

const normalizeSearch = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
export function matchesSettingsSearch(query: string, ...labels: string[]): boolean {
  const words = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const haystack = normalizeSearch(labels.join(" "));
  return words.every((word) => haystack.includes(word));
}

export function settingsGroupMatches(group: SettingsGroupDef, query: string): boolean {
  return matchesSettingsSearch(query, group.title, group.short, GROUP_EXTRA_SEARCH[group.id] ?? "") || SETTINGS_LAYOUT[group.id].some((key) => settingsCardMatches(key, query));
}

export function settingsCardMatches(key: SettingsCardKey, query: string): boolean {
  const group = SETTINGS_GROUPS.find((g) => SETTINGS_LAYOUT[g.id].includes(key))!;
  return matchesSettingsSearch(query, group.title, group.short, SETTINGS_SEARCH_LABELS[key]);
}
