// ---------------------------------------------------------------------------
// Team notification preferences — the client-safe half (Jordan, Sep 15: "I
// want to make sure the editors are getting pinged on slack when they are
// tagged in a message or a message was sent on their project. James and
// harrison can get texted with the links when they are tagged", and "I should
// be able to manage team notifications in settings").
//
// This module imports NOTHING on purpose: the Settings card (a client
// component) and the notify bridge (server) both read the same event list and
// the same default table from here. The stored answer lives in an AppSetting
// row (`notify-prefs:<teamMemberId>`), read and merged server-side in
// src/lib/notifyPrefs.ts; what lives here is only "what can be switched, and
// what it says when nobody has touched it".
//
// The bell is not a preference: every row still lands in the in-app bell.
// These switches decide what ALSO reaches Slack or the person's phone.
// ---------------------------------------------------------------------------

export const NOTIFY_EVENTS = [
  { key: "mention", label: "Tagged in a message, or replied to", short: "Tags" },
  { key: "project_message", label: "A message posted on one of their jobs", short: "Job messages" },
  { key: "job_ping", label: "Job pings — footage landed, a revision, a review verdict, reassigned", short: "Job pings" },
  { key: "review_ready", label: "A video waiting on review", short: "Video in review" },
  { key: "shoot_change", label: "Shoot changes & feedback — reschedule, cancel, footage missing, cull, review feedback", short: "Shoot changes" },
] as const;

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]["key"];
export const NOTIFY_EVENT_KEYS: NotifyEvent[] = NOTIFY_EVENTS.map((e) => e.key);

export type NotifyChannels = { slack: boolean; sms: boolean };
export type NotifyPrefs = Record<NotifyEvent, NotifyChannels>;

/** What the Settings card gets per person — built server-side by
 *  teamNotifyRows() in src/lib/notifyPrefs.ts. `explicit` = a saved row
 *  exists (vs. the defaults below); the card shows that as "custom". */
export type TeamNotifyRow = {
  teamMemberId: string;
  name: string;
  role: string;
  isEditor: boolean;
  isOwner: boolean;
  slackId: string | null;
  hasPhone: boolean;
  /** Why `hasPhone` is false when a number IS on the roster (review, Sep 15):
   *  it is our own OpenPhone line (Kyle's roster phone is the company number
   *  — the sender refuses to text the office line from itself) or not a
   *  US/Canada number (the office line can't reach it). The card says which. */
  phoneNote?: "company_line" | "non_us";
  prefs: NotifyPrefs;
  explicit: boolean;
};

const off: NotifyChannels = { slack: false, sms: false };
const slack: NotifyChannels = { slack: true, sms: false };
const sms: NotifyChannels = { slack: false, sms: true };
const both: NotifyChannels = { slack: true, sms: true };

const allOff = (): NotifyPrefs => ({
  mention: { ...off },
  project_message: { ...off },
  job_ping: { ...off },
  review_ready: { ...off },
  shoot_change: { ...off },
});

/**
 * The default table. `role` is the roster role, except that the server passes
 * "EDITOR" for anyone holding an editor key (Kim and John Mark are MANAGER /
 * VA on the roster — the key is what makes them editors). `isOwner` wins over
 * the role: Jordan is PHOTOGRAPHER on the roster and the owner by login.
 *   · owner        — tags: text + Slack; a video waiting on review: text.
 *   · editor       — tags, messages on their jobs, job pings: Slack.
 *   · photographer — tags and shoot changes: text (James and Harrison have no
 *                    Slack habit; a text with the link is what Jordan asked for).
 *   · office       — tags: Slack (Kyle lives in Slack; the rest is his queue).
 */
export function defaultPrefsFor(role: string, isOwner: boolean): NotifyPrefs {
  const p = allOff();
  if (isOwner) {
    p.mention = { ...both };
    p.review_ready = { ...sms };
    // He shoots too (PHOTOGRAPHER on the roster) and the old bridge texted him
    // about his own shoots — reschedules, missing footage, cull (25 rows in 90
    // days, Sep 15 review). Keep that on; the switch is his to flip.
    p.shoot_change = { ...sms };
    return p;
  }
  const r = (role || "").toUpperCase();
  if (r === "EDITOR") {
    p.mention = { ...slack };
    p.project_message = { ...slack };
    p.job_ping = { ...slack };
    return p;
  }
  if (r === "PHOTOGRAPHER") {
    p.mention = { ...sms };
    p.shoot_change = { ...sms };
    return p;
  }
  // MANAGER / ADMIN / VA / SALES without an editor key: the office.
  p.mention = { ...slack };
  return p;
}

/** The default table for a row as the card and the store both see it. */
export function defaultPrefsForRow(row: Pick<TeamNotifyRow, "role" | "isEditor" | "isOwner">): NotifyPrefs {
  return defaultPrefsFor(row.isEditor ? "EDITOR" : row.role, row.isOwner);
}

/** The group a person's defaults come from — the chip on the Settings card. */
export function notifyGroupLabel(row: Pick<TeamNotifyRow, "role" | "isEditor" | "isOwner">): "Owner" | "Editor" | "Photographer" | "Office" {
  if (row.isOwner) return "Owner";
  if (row.isEditor) return "Editor";
  if ((row.role || "").toUpperCase() === "PHOTOGRAPHER") return "Photographer";
  return "Office";
}

/**
 * Strict read of a prefs object from the wire or the store: every event key
 * present, nothing else, both channels booleans. Returns null when the shape
 * is wrong — the save action refuses, the reader falls back to the defaults.
 * (`merge` is the lenient cousin for the store, where a row written before
 * a new event was added is still a valid answer for the events it names.)
 */
export function parseNotifyPrefs(input: unknown): NotifyPrefs | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const obj = input as Record<string, unknown>;
  for (const k of Object.keys(obj)) if (!(NOTIFY_EVENT_KEYS as string[]).includes(k)) return null;
  const out = allOff();
  for (const key of NOTIFY_EVENT_KEYS) {
    const ch = obj[key];
    if (!ch || typeof ch !== "object" || Array.isArray(ch)) return null;
    const { slack: s, sms: t } = ch as Record<string, unknown>;
    if (typeof s !== "boolean" || typeof t !== "boolean") return null;
    out[key] = { slack: s, sms: t };
  }
  return out;
}

/** Lenient merge: `stored` (any shape) over `base`; unknown keys and
 *  non-boolean channels are ignored rather than rejected. */
export function mergeNotifyPrefs(base: NotifyPrefs, stored: unknown): NotifyPrefs {
  const out: NotifyPrefs = {
    mention: { ...base.mention },
    project_message: { ...base.project_message },
    job_ping: { ...base.job_ping },
    review_ready: { ...base.review_ready },
    shoot_change: { ...base.shoot_change },
  };
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return out;
  const obj = stored as Record<string, unknown>;
  for (const key of NOTIFY_EVENT_KEYS) {
    const ch = obj[key];
    if (!ch || typeof ch !== "object" || Array.isArray(ch)) continue;
    const { slack: s, sms: t } = ch as Record<string, unknown>;
    if (typeof s === "boolean") out[key].slack = s;
    if (typeof t === "boolean") out[key].sms = t;
  }
  return out;
}

export function notifyPrefsEqual(a: NotifyPrefs, b: NotifyPrefs): boolean {
  return NOTIFY_EVENT_KEYS.every((k) => a[k].slack === b[k].slack && a[k].sms === b[k].sms);
}
