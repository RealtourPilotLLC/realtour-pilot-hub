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

/** The four groups a roster row falls into on the Settings card
 *  (notifyGroupLabel below) — and the unit `appliesTo` speaks in. */
export type NotifyGroup = "Owner" | "Editor" | "Photographer" | "Office";

// `appliesTo` (Sep 16, Kyle call): which groups an emitter actually addresses
// for the event. A switch the bridge can never fire used to render live —
// Kyle's "Video in review" was on the card but no emitter ever wrote a row to
// him, and the audit found the toggle inert. Now the card greys a switch out
// for a group nothing addresses ("Nothing addresses Kyle for this event
// yet") and the save action clears it, so a saved matrix can only hold
// switches that can fire. Keep this in step with the emitters:
//   mention         — everyone (mentions.ts, messageActions.ts);
//   project_message — the job's editor, the assigned photographer while the
//                     job is undelivered, and the office (mentions.ts
//                     notifyProjectMessage);
//   job_ping        — the edit lane: every raws_landed / revision_* / edit_* /
//                     review_* person-leg is an editor:<key> or the job
//                     editor's tm: row (tasks.ts, comms.ts, editing/actions.ts,
//                     review/actions.ts). "Photographer" came OFF this row in
//                     the Sep 16 review because nothing addressed them —
//                     Harrison's and James's switch rendered live and inert,
//                     the exact dishonesty this table exists to remove. It is
//                     back on Sep 18 for exactly TWO kinds and no others:
//                     review_approved and review_changes now address the
//                     photographer who SHOT the job (Jordan: "they should be
//                     notified just like I am"). Their raws_landed and
//                     edit_assigned rows still do not exist, so the label's
//                     other words stay the editor's;
//   review_ready    — the Review Room's OWNER+ADMIN broadcast, bridged to
//                     the owner and the office (notify.ts bridgeBroadcast) —
//                     and, since Sep 18, the person-addressed cut_ready row
//                     for the photographer whose shoot the cut came from;
//   shoot_change    — the assigned photographer, the owner because he
//                     shoots, and the OFFICE: tasks.ts creativeAlertTargets
//                     addresses whoever carries TeamMember.creativeManager
//                     by tm:<id> for raws_missing whatever their group, so
//                     the day that flag moves from James to Kyle his row
//                     must still be switchable (Sep 16 review).
export const NOTIFY_EVENTS = [
  { key: "mention", label: "Tagged in a message, or replied to", short: "Tags", appliesTo: ["Owner", "Editor", "Photographer", "Office"] },
  { key: "project_message", label: "A message posted on one of their jobs", short: "Job messages", appliesTo: ["Editor", "Photographer", "Office"] },
  { key: "job_ping", label: "Job pings — footage landed, a revision, a review verdict, reassigned", short: "Job pings", appliesTo: ["Editor", "Photographer"] },
  { key: "review_ready", label: "A video waiting on review", short: "Video in review", appliesTo: ["Owner", "Office", "Photographer"] },
  { key: "shoot_change", label: "Shoot changes & feedback — reschedule, cancel, footage missing, cull, review feedback", short: "Shoot changes", appliesTo: ["Photographer", "Owner", "Office"] },
] as const satisfies readonly { key: string; label: string; short: string; appliesTo: readonly NotifyGroup[] }[];

export type NotifyEvent = (typeof NOTIFY_EVENTS)[number]["key"];
export const NOTIFY_EVENT_KEYS: NotifyEvent[] = NOTIFY_EVENTS.map((e) => e.key);

/** Does any emitter address this group for this event? (The card greys the
 *  row out otherwise; the save action clears it.) */
export function eventAppliesTo(event: NotifyEvent, group: NotifyGroup): boolean {
  const e = NOTIFY_EVENTS.find((x) => x.key === event);
  return !!e && (e.appliesTo as readonly NotifyGroup[]).includes(group);
}

export type NotifyChannels = { slack: boolean; sms: boolean };
export type NotifyPrefs = Record<NotifyEvent, NotifyChannels>;

/** What the delivery log (NotificationDelivery, Sep 16) last recorded for a
 *  person — the newest Slack DM that went, the newest text that went, and
 *  the newest failure on either. ISO timestamps: this crosses the server →
 *  client boundary as props. */
export type LastReached = {
  slack?: { at: string; kind: string };
  sms?: { at: string; kind: string };
  failed?: { at: string; detail: string };
};

/** A bell kind in the words the card uses — "Tue 4:12 PM (tagged)". Unlisted
 *  kinds show as themselves; nothing here decides delivery. */
export const NOTIFY_KIND_LABELS: Record<string, string> = {
  mention: "tagged",
  note_reply: "replied to",
  project_message: "job message",
  raws_landed: "raws in",
  revision_raised: "revision",
  revision_resolved: "revision back",
  edit_finished: "edit finished",
  edit_assigned: "reassigned",
  edit_started: "edit started",
  review_changes: "changes requested",
  review_approved: "cut approved",
  cut_change_ask: "change asked on a cut",
  cut_ready: "video in review",
  review_submitted: "video in review",
  review_feedback: "shoot feedback",
  appointment_change: "shoot change",
  order_canceled: "cancelled",
  raws_missing: "footage missing",
  cull: "cull",
  task_assigned: "task",
  photos_undelivered: "photos not delivered",
  staff_sms: "staff alert",
};
export function notifyKindLabel(kind: string): string {
  return NOTIFY_KIND_LABELS[kind] ?? kind.replace(/_/g, " ");
}

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
  /** Sep 16: what the delivery log last recorded for them (Settings shows
   *  "Last reached: Slack · Tue 4:12 PM (tagged)" and a red last failure). */
  lastReached?: LastReached;
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
    // Sep 18, Jordan on sharing the Review Room with the shooter: "they should
    // be notified just like I am". The owner's own row for a video waiting on
    // review is a text, so theirs is too. Volume was checked before the switch
    // was defaulted ON rather than after: the Room holds 35 cuts in its whole
    // life to date, 29 of them on jobs with a photographer — about a dozen a
    // month across the roster, and the staff queue batches a person's lines
    // into one message every 30 minutes anyway.
    p.review_ready = { ...sms };
    // The VERDICT is information, not a summons — the cut is already gone from
    // their hands and the next move is the editor's. Bell only by default; the
    // switch is on their Settings row the moment they want more.
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

/** The group a person's defaults come from — the chip on the Settings card,
 *  and the unit `appliesTo` greys switches by. */
export function notifyGroupLabel(row: Pick<TeamNotifyRow, "role" | "isEditor" | "isOwner">): NotifyGroup {
  if (row.isOwner) return "Owner";
  if (row.isEditor) return "Editor";
  if ((row.role || "").toUpperCase() === "PHOTOGRAPHER") return "Photographer";
  return "Office";
}

/** Sep 16: a copy of `prefs` with every switch nothing addresses for this
 *  group turned off — what the save action persists, so the store can never
 *  hold a switch the bridge ignores. */
export function clearInapplicable(prefs: NotifyPrefs, group: NotifyGroup): NotifyPrefs {
  const out = mergeNotifyPrefs(prefs, {});
  for (const key of NOTIFY_EVENT_KEYS) if (!eventAppliesTo(key, group)) out[key] = { slack: false, sms: false };
  return out;
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
