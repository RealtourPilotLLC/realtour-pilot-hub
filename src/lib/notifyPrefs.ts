import "server-only";
import { prisma } from "@/lib/prisma";
import { getSetting, putSetting } from "@/lib/settings";
import { staffTextNumber } from "@/lib/hubSms";
import {
  defaultPrefsFor,
  mergeNotifyPrefs,
  notifyGroupLabel,
  parseNotifyPrefs,
  type LastReached,
  type NotifyEvent,
  type NotifyGroup,
  type NotifyPrefs,
  type TeamNotifyRow,
} from "@/lib/notifyPrefDefaults";

// ---------------------------------------------------------------------------
// Team notification preferences — the SERVER half (Jordan, Sep 15: "I want to
// make sure the editors are getting pinged on slack when they are tagged in a
// message or a message was sent on their project. James and harrison can get
// texted with the links when they are tagged in a message" / "I should be
// able to manage team notifications in settings").
//
// One question, answered in one place: for THIS person and THIS event, does
// the bell row also go to Slack, to their phone, both, or neither? The
// answer is an AppSetting row (`notify-prefs:<teamMemberId>`, the matrix the
// Settings card saves) merged over the default table in notifyPrefDefaults.ts
// — so nothing needs a saved row to work the day it ships, and a change is a
// click on /settings, not a deploy. The bridge in notify.ts asks on every NEW
// person-addressed bell row; roles no longer decide channels (they did until
// Sep 15: PHOTOGRAPHER-in-audience meant "text", editor:<key> meant "Slack or
// no-login SMS"). The bell itself is not a preference — every row still lands.
//
// The Sep 11 owner switch (`sms-prefs:<id>` = {"kinds":[…]}) is folded in:
// when a person has NO notify-prefs row yet, a legacy row still answers his
// "tagged" and "video in review" text switches, so nothing he set is lost on
// the day the matrix replaces the card.
// ---------------------------------------------------------------------------

export const notifyPrefsKey = (teamMemberId: string) => `notify-prefs:${teamMemberId}`;

// Bell kind → the switch that governs it. Anything unlisted is bell-only: a
// new emitter nobody classified must never text or DM someone by surprise.
//   mention        — someone tagged you, or answered you on a thread
//   project_message — a message on a job you are on: the editor, the assigned
//                     photographer while it is undelivered, the office (Sep
//                     16; see mentions.ts notifyProjectMessage)
//   job_ping       — the edit lane: raws in, a revision, a verdict, a hand-off
//   review_ready   — a cut waiting on a verdict (the owner's Sep 11 text; the
//                     office's switch since Sep 16)
//   shoot_change   — the field: reschedule, cancel, raws missing, cull, a task
const KIND_TO_EVENT: Record<string, NotifyEvent> = {
  mention: "mention",
  note_reply: "mention",
  project_message: "project_message",
  raws_landed: "job_ping",
  revision_raised: "job_ping",
  revision_resolved: "job_ping",
  edit_finished: "job_ping",
  edit_assigned: "job_ping",
  edit_started: "job_ping",
  review_changes: "job_ping",
  review_approved: "job_ping",
  // The photographer who shot the job asking the editor for a change from the
  // Review Room (Sep 18). An edit-lane ping by every measure: it lands on the
  // editor's own page as an open note and travels onto the edit card with the
  // next round, so it rides the switch their other edit-lane pings ride.
  cut_change_ask: "job_ping",
  cut_ready: "review_ready",
  review_submitted: "review_ready",
  // THE 1080p FILE COMING BACK FROM TOPAZ (Sep 21 2026). Jordan, in one
  // sentence: "I just want to make sure Kyle gets that view and is notified via
  // Slack when a video is ready for review, and then when a video is back from
  // Topaz." Two events, one want, so they ride one switch — the switch he is
  // describing is "Video in review", and Kyle already has it on for Slack
  // (his saved matrix reads review_ready {slack:true, sms:false}, saved
  // 2026-09-18 20:54Z, and the three cut_ready broadcasts since then each wrote
  // him a slack/sent leg).
  //
  // THE SEP 16 COMMENT ABOVE pingKyle SAID TO LEAVE THIS UNCLASSIFIED, and it
  // was right at the time for a reason that has since been overtaken: folding
  // it into "Job pings" would have put a live switch in front of Kyle that
  // governed two unrelated things. What it could not foresee is that Jordan
  // would name this event and "a video ready for review" as the same ask. The
  // cost of leaving it unclassified was measured before touching it: 13
  // topaz_ready bell legs to Kyle in 21 days, every one of them bell/sent and
  // nothing else, while three approved videos sat unsent for up to three days.
  //
  // WHY review_ready AND NOT job_ping, which reads closer. job_ping's
  // `appliesTo` is [Editor, Photographer] (notifyPrefDefaults.ts), so
  // clearInapplicable() zeroes it for anyone in the Office group on every save
  // — Kyle's stored row already reads job_ping {slack:false, sms:false}. Mapping
  // there would have shipped a fix that delivers nothing and reads like one.
  // review_ready's appliesTo already includes Office, so his switch is live and
  // honest rather than a new inert toggle.
  //
  // WHAT THIS DOES NOT DO: the OWNER leg of the topaz_ready row carries no
  // ownerSms, so bridgeBroadcast never runs for it and Jordan's phone is
  // exactly as quiet as it was yesterday. He asked for Kyle.
  //
  // STILL OWED (notifyPrefDefaults.ts is not this pass's file): the card's
  // label for this switch still says "A video waiting on review", and
  // NOTIFY_KIND_LABELS has no entry for topaz_ready, so Settings will render
  // "Last reached … (topaz ready)". Both are wording on a switch that now
  // governs one more thing than it names.
  topaz_ready: "review_ready",
  // Shoot feedback sent to the photographer's lane texted them before Sep 15
  
  // ("Shoot feedback — <street> → link"); keeping it under Shoot changes so the

  // switch that governs their shoot texts governs this one too (Sep 15 review).

  review_feedback: "shoot_change",
  appointment_change: "shoot_change",
  order_canceled: "shoot_change",
  raws_missing: "shoot_change",
  cull: "shoot_change",
  task_assigned: "shoot_change",
  // The day-before "Still needed? It closes tomorrow" nudge on a Slack ask
  // (B5 handover, Sep 16) — without a mapping it would be bell-only.
  task_expiring: "job_ping",
};
export function eventForKind(kind: string): NotifyEvent | null {
  return KIND_TO_EVENT[kind] ?? null;
}

// TeamMember id → editor key, for the in-house editors with a roster row
// (kim/john/remar). Exact (editor key → its row), never a name substring, and
// cached ten minutes per lambda: the bridge asks on every bell row and the
// roster changes a few times a year. Best-effort — a lookup failure returns
// the last known map, or an empty one.
let editorMapCache: { at: number; map: Map<string, string> } | null = null;
export async function editorKeysByTeamMemberId(): Promise<Map<string, string>> {
  if (editorMapCache && Date.now() - editorMapCache.at < 10 * 60_000) return editorMapCache.map;
  try {
    const { TEAM_MEMBER_EDITOR_KEYS, editorTeamMemberId } = await import("@/lib/editors");
    const map = new Map<string, string>();
    for (const key of TEAM_MEMBER_EDITOR_KEYS) {
      const tmId = await editorTeamMemberId(key);
      if (tmId) map.set(tmId, key);
    }
    editorMapCache = { at: Date.now(), map };
    return map;
  } catch {
    return editorMapCache?.map ?? new Map();
  }
}

type PersonFacts = { role: string; isEditor: boolean; isOwner: boolean; active: boolean };
async function personFacts(teamMemberId: string): Promise<PersonFacts | null> {
  const member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { role: true, active: true } });
  if (!member) return null;
  const [editors, owners] = await Promise.all([
    editorKeysByTeamMemberId(),
    (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]),
  ]);
  return { role: String(member.role), isEditor: editors.has(teamMemberId), isOwner: owners.includes(teamMemberId), active: member.active };
}

/**
 * What this person has switched on, per event — the saved matrix merged over
 * their default table. No saved row: the defaults, except that an owner's
 * legacy Sep 11 `sms-prefs` row still answers his two text switches. Unknown
 * person: everything off (the bridge then does nothing but the bell).
 */
export async function notifyPrefsFor(teamMemberId: string): Promise<NotifyPrefs> {
  const facts = await personFacts(teamMemberId).catch(() => null);
  if (!facts) return allOffPrefs();
  const defaults = defaultPrefsFor(facts.isEditor ? "EDITOR" : facts.role, facts.isOwner);
  const stored = await getSetting<Record<string, unknown>>(notifyPrefsKey(teamMemberId), {});
  if (stored && Object.keys(stored).length > 0) return mergeNotifyPrefs(defaults, stored);
  if (facts.isOwner) {
    // The Sep 11 card's answer, honoured until the matrix writes its own row.
    const { smsPrefsKey } = await import("@/lib/smsPrefs");
    const legacy = await getSetting<{ kinds?: unknown }>(smsPrefsKey(teamMemberId), {});
    if (Array.isArray(legacy.kinds)) {
      const kinds = legacy.kinds.filter((k): k is string => typeof k === "string");
      defaults.mention.sms = kinds.includes("mention");
      defaults.review_ready.sms = kinds.includes("review_ready");
    }
  }
  return defaults;
}

function allOffPrefs(): NotifyPrefs {
  const off = { slack: false, sms: false };
  return { mention: { ...off }, project_message: { ...off }, job_ping: { ...off }, review_ready: { ...off }, shoot_change: { ...off } };
}

/** Does a saved matrix exist for this person (vs. the default table)? */
export async function hasExplicitNotifyPrefs(teamMemberId: string): Promise<boolean> {
  const stored = await getSetting<Record<string, unknown>>(notifyPrefsKey(teamMemberId), {});
  return !!stored && Object.keys(stored).length > 0;
}

/** The card group this person files under (Owner / Editor / Photographer /
 *  Office) — what `appliesTo` greys switches by; null for an unknown id. */
export async function notifyGroupFor(teamMemberId: string): Promise<NotifyGroup | null> {
  const facts = await personFacts(teamMemberId).catch(() => null);
  if (!facts) return null;
  return notifyGroupLabel({ role: facts.role, isEditor: facts.isEditor, isOwner: facts.isOwner });
}

// What the delivery log last recorded per person (Sep 16, Kyle call: "is
// delivery verifiable?"). Three exact questions per person — the newest
// Slack DM that went, the newest text that went, the newest failure on
// either — each its own indexed lookup on (teamMemberId, createdAt).
//
// It used to be one 400-row read across the whole team, and the Sep 16
// review caught what that costs: one chatty recipient (or the per-line
// "sent" row the flusher writes for every queued text) pushes a quieter
// person's newest row past the cap and their block silently reverts to
// "nothing logged yet" — a false negative on the one line this card exists
// to prove. A findFirst per question can't be crowded out.
//
// A "queued" text is not "reached" (it is still in the digest window), a
// "skipped" one is not a failure (the switch was on but there was nowhere
// to send). Best-effort: a read failure leaves the card without the line.
async function lastReachedByMember(teamMemberIds: string[]): Promise<Map<string, LastReached>> {
  const out = new Map<string, LastReached>();
  if (teamMemberIds.length === 0) return out;
  const newest = (where: Record<string, unknown>) =>
    prisma.notificationDelivery.findFirst({
      where,
      orderBy: { createdAt: "desc" },
      select: { channel: true, kind: true, detail: true, createdAt: true },
    });
  await Promise.all(
    teamMemberIds.map(async (teamMemberId) => {
      try {
        const [slack, sms, failed] = await Promise.all([
          newest({ teamMemberId, channel: "slack", status: "sent" }),
          newest({ teamMemberId, channel: "sms", status: "sent" }),
          newest({ teamMemberId, channel: { in: ["slack", "sms"] }, status: "failed" }),
        ]);
        const cur: LastReached = {};
        if (slack) cur.slack = { at: slack.createdAt.toISOString(), kind: slack.kind };
        if (sms) cur.sms = { at: sms.createdAt.toISOString(), kind: sms.kind };
        if (failed)
          cur.failed = {
            at: failed.createdAt.toISOString(),
            detail: `${failed.channel === "slack" ? "Slack" : "text"}: ${(failed.detail ?? "send failed").slice(0, 200)}`,
          };
        if (cur.slack || cur.sms || cur.failed) out.set(teamMemberId, cur);
      } catch (e) {
        console.warn("lastReachedByMember failed", teamMemberId, e);
      }
    }),
  );
  return out;
}

/**
 * The Settings card's rows: every ACTIVE roster member with what the bridge
 * would do for them today. Ordered the way the office thinks about the team —
 * the owner, then the office, then the editors, then the photographers, each
 * group by name. `explicit` = a saved matrix exists. The phone itself never
 * leaves the server (hasPhone only) — the card shows "text ✓" / "no phone".
 * "text ✓" means the bridge could actually text them: a US/Canada number
 * (staffTextNumber — the same rule queueStaffSms refuses on) that is not our
 * own OpenPhone line. Kyle's roster phone IS the company number, and a Text
 * switch there would only queue lines the sender always refuses (review,
 * Sep 15) — so his row reads "company line", never "text ✓".
 */
export async function teamNotifyRows(): Promise<TeamNotifyRow[]> {
  const [members, editors, owners, ours] = await Promise.all([
    prisma.teamMember.findMany({
      where: { active: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, role: true, slackId: true, phone: true },
    }),
    editorKeysByTeamMemberId(),
    (await import("@/lib/smsPrefs")).ownerTeamMemberIds().catch(() => [] as string[]),
    (await import("@/lib/integrations/openphone")).ourOpenPhoneNumberKeys().catch(() => new Set<string>()),
  ]);
  const reached = await lastReachedByMember(members.map((m) => m.id));
  const rows: TeamNotifyRow[] = [];
  for (const m of members) {
    const isEditor = editors.has(m.id);
    const isOwner = owners.includes(m.id);
    const [prefs, explicit] = await Promise.all([notifyPrefsFor(m.id), hasExplicitNotifyPrefs(m.id)]);
    const num = staffTextNumber(m.phone);
    const phoneNote: TeamNotifyRow["phoneNote"] = num
      ? ours.has(num.key) ? "company_line" : undefined
      : (m.phone ?? "").replace(/\D/g, "").length >= 7 ? "non_us" : undefined;
    rows.push({
      teamMemberId: m.id,
      name: m.name,
      role: String(m.role),
      isEditor,
      isOwner,
      slackId: m.slackId ?? null,
      hasPhone: !!num && !phoneNote,
      ...(phoneNote ? { phoneNote } : {}),
      prefs,
      explicit,
      ...(reached.has(m.id) ? { lastReached: reached.get(m.id) } : {}),
    });
  }
  const group = (r: TeamNotifyRow) => (r.isOwner ? 0 : r.isEditor ? 2 : r.role.toUpperCase() === "PHOTOGRAPHER" ? 3 : 1);
  rows.sort((a, b) => group(a) - group(b) || a.name.localeCompare(b.name));
  return rows;
}

/**
 * The store write only — authorization lives in the settings action
 * (src/app/settings/actions.ts saveTeamNotifyPrefs). The shape is checked
 * again here so a caller can never persist a half-object the reader would
 * then have to guess at; putSetting drops the 60s read cache, so the bridge
 * sees the new answer on the next bell row.
 */
export async function saveNotifyPrefs(teamMemberId: string, prefs: NotifyPrefs, updatedBy?: string | null): Promise<void> {
  const clean = parseNotifyPrefs(prefs);
  if (!clean) throw new Error("Bad notification preferences shape.");
  await putSetting(notifyPrefsKey(teamMemberId), clean, updatedBy ?? null);
}
