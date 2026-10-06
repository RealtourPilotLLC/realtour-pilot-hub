import "server-only";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { scrubMoney } from "@/lib/text";
import { slackNotify, slackChannels } from "@/lib/integrations/slack";
import { appBase } from "@/lib/appUrl";
import { HUB_SMS_PREFIX, staffTextNumber } from "@/lib/hubSms";
import type { Role } from "@/lib/auth/access";

// ---------------------------------------------------------------------------
// Internal operational pings → Slack (never clients). The task engine files
// work into the queue, but nothing ever TOLD anyone — every urgent event waited
// for someone to open the hub. These helpers push a one-line Slack message for
// the handful of events that shouldn't wait (URGENT tasks, new leads, revision
// requests, cron/webhook failures). ALL of it is best-effort: a notify failure
// must never break task creation, a webhook, or a cron run.
// ---------------------------------------------------------------------------

// Kyle's Slack user id — same DM the comms-memory sync reads (slackSync.ts).
// Posting to a user id opens the bot's DM with him. Since Sep 15 the roster
// (TeamMember.slackId, editable on People) is the source of truth and the
// literal is only the fallback for a roster that has lost the row — cached
// ten minutes, the alert path runs on every ping.
const KYLE_SLACK_ID = "U07SCBTPDC7";
let kyleCache: { at: number; id: string } | null = null;
async function kyleSlackId(): Promise<string> {
  if (kyleCache && Date.now() - kyleCache.at < 10 * 60_000) return kyleCache.id;
  let id = KYLE_SLACK_ID;
  try {
    const kyle = await prisma.teamMember.findFirst({
      where: { name: { contains: "Kyle", mode: "insensitive" }, active: true },
      select: { slackId: true },
    });
    if (kyle?.slackId) id = kyle.slackId;
  } catch { /* the literal */ }
  kyleCache = { at: Date.now(), id };
  return id;
}

// Absolute links come from the one origin helper (src/lib/appUrl.ts) — the
// local copy this file carried lacked the APP_URL fallback and the scheme
// normalisation every other text already gets (Sep 11).

// Where alerts go: SLACK_ALERT_CHANNEL env (a channel id like C0123ABC, or
// "#ops-alerts" — the bot must be invited to it) wins; else the ops channel
// the bot is already in (#rp-project-tracker family); else Kyle's DM. Cached
// ~1h so we don't list channels on every ping.
let destCache: { at: number; channel: string } | null = null;
export async function alertDestination(): Promise<string> {
  const env = alertChannelEnv();
  if (env) return env;
  return defaultAlertDestination();
}
function alertChannelEnv(): string | null {
  const env = (process.env.SLACK_ALERT_CHANNEL ?? "").trim();
  return env || null;
}
async function defaultAlertDestination(): Promise<string> {
  if (destCache && Date.now() - destCache.at < 3600_000) return destCache.channel;
  let channel = await kyleSlackId();
  try {
    const chans = await slackChannels();
    const ops = chans.find((c) => c.is_member && /project-tracker|alert|ops|notif/i.test(c.name));
    if (ops) channel = ops.id;
  } catch {
    /* fall back to Kyle's DM */
  }
  destCache = { at: Date.now(), channel };
  return channel;
}

/** A Slack user id (a DM to one person) rather than a channel. */
const isPersonDm = (dest: string) => /^[UW][A-Z0-9]{2,}$/.test(dest);

// ---------------------------------------------------------------------------
// THE OPS CHANNEL IS A PERSON'S PHONE TODAY (Oct 5 2026, team notifications
// pass). With no SLACK_ALERT_CHANNEL set and no ops channel the bot is in,
// alertDestination() is Kyle's DM — so every relay, receipt and failure line
// below buzzed his phone at whatever hour it fired, and the "⏸ Urgent page
// held (quiet hours)" notice itself DMed him at 11:30 PM, defeating the very
// hold it announced. A post to a CHANNEL is not a page (nobody's phone rings
// for a channel line unless they asked it to), so a channel still gets every
// line at once. A post that would land in one person's DM is asked the same
// question every other person-addressed notice asks: their own quiet time
// (notifySchedule.holdFor) and nothing more — since Oct 6 2026 there is no
// house night (Jordan: "Anyone on the team can get pinged anytime. Just not
// Jordan on Saturday until 7:30PM."), so Kyle's DM gets the 11:30 PM line at
// 11:30 PM. Inside somebody's own quiet time the line is KEPT — a held Slack
// DM, released by the 5-minute flusher with anything else waiting for them —
// never dropped. Rule 3 still holds: a read that fails sends now.
//
// SLACK_ALERT_CHANNEL: set it (Vercel env) to the channel's id or "#name"
// once #ops-alerts exists and the bot is invited; every line then goes there
// at once and Kyle's DM is left for what is actually his. A channel that
// refuses the post (the bot not invited, a typo) falls back to the default
// destination rather than swallowing the alert.
// ---------------------------------------------------------------------------
async function holdOpsDmForQuietTime(dest: string, text: string, at: Date): Promise<boolean> {
  try {
    const tm = await prisma.teamMember.findFirst({ where: { slackId: dest, active: true }, select: { id: true } });
    if (!tm) return false; // the literal fallback ID with no roster row — nothing to time it by
    const { holdFor } = await import("@/lib/notifySchedule");
    const until = await holdFor(tm.id, at);
    if (!until) return false;
    return await holdStaffDm({ teamMemberId: tm.id, slackId: dest, text, until, kind: "ops_alert", why: "ops alert, their quiet time" });
  } catch {
    return false; // rule 3: never silent because a read failed
  }
}

// Post one internal alert line. Never throws; false = not delivered (a line
// KEPT for the morning counts as delivered — it will be).
export async function opsAlert(text: string): Promise<boolean> {
  try {
    const env = alertChannelEnv();
    if (env) {
      if (isPersonDm(env)) {
        if (await holdOpsDmForQuietTime(env, text, new Date())) return true;
      }
      if (await slackNotify(env, text)) return true;
      console.warn(`opsAlert: SLACK_ALERT_CHANNEL (${env}) refused the post — falling back to the default destination`);
    }
    const dest = await defaultAlertDestination();
    if (isPersonDm(dest) && (await holdOpsDmForQuietTime(dest, text, new Date()))) return true;
    return await slackNotify(dest, text);
  } catch {
    return false;
  }
}

/** Is the ops channel, as it stands, one person's DM (their Slack ID), or null
 *  when it is a real channel. */
async function opsDestinationPerson(): Promise<string | null> {
  try {
    const env = alertChannelEnv();
    const dest = env ?? (await defaultAlertDestination());
    return isPersonDm(dest) ? dest : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// In-app notifications (the bell). Same philosophy as opsAlert: best-effort,
// NEVER throws — a bell miss must never break a webhook, cron, or task write.
// One Notification row per target: a role broadcast (no userKey) or one person
// ("tm:<teamMemberId>" / "editor:<editorKey>", role still required). Emitters
// dual-write next to their existing Slack ping/task — never instead of it.
// ---------------------------------------------------------------------------

export type { Role };
// Saying "the photographer on this job" without hard-coding an id:
// photographerNotifyTarget() in src/lib/projectPhotographer.ts builds one of
// these from a projectId (Sep 18, the Review Room's photographer bell).
export type NotifyTarget = {
  roles: Role[];
  userKey?: string;
  href?: string; // overrides the default per row
  /** Sep 11: the exact sentence a phone (or a Slack DM) gets from an
   *  OWNER+ADMIN broadcast — today only the Review Room's "cut ready" row
   *  (reviewCuts.ts announceCutInReview). Read only for that broadcast, and
   *  delivered to each owner AND office roster row whose "video in review"
   *  row on /settings → Team notifications says text or Slack (Sep 16: Kyle's
   *  switch was inert because only the owner was ever iterated). Because it
   *  now reaches the office, the bridge scrubs money out of it for anyone but
   *  an owner — write it money-free anyway. Leave it OFF and the row is
   *  bell-only for everyone (topazJobs.ts relies on exactly that for its OWNER
   *  row). Person-addressed rows carry slackDm instead. */
  ownerSms?: string;
  /** Sep 21 2026: THE OWNER DID THIS HIMSELF. Only the Review Room sends it
   *  (reviewCuts.ts announceCutInReview, a cut Jordan uploaded from his own
   *  login). The sentence above still goes to the office; the owner's roster
   *  rows are dropped from the fan-out, so his phone and his DM stay quiet on
   *  his own upload — the Sep 11 carve-out, kept.
   *
   *  It is on the EMITTER because it is a fact about the event, not a guess
   *  about a person: leaving it to a preference would either text him about
   *  work he just filed (his saved matrix says Slack and text) or make him
   *  turn off "video in review" altogether and miss everyone else's cuts.
   *  Saved preferences still decide everything the owner did NOT cause, and
   *  every other person on the broadcast, untouched. */
  ownerActed?: boolean;
  /** Sep 15: the emitter's own sentence for the person this row is addressed
   *  to (tm:<id>, or editor:<key> resolved to its TeamMember) — who, where,
   *  the summary, the link; money already scrubbed for a non-owner
   *  (mentions.ts slackMentionDm). The bridge sends it as their Slack DM
   *  and, in plain-text form, as their text — whichever their matrix row
   *  says. Leave it OFF for a self-tag: a tag or reply row with no sentence
   *  goes nowhere but the bell. */
  slackDm?: string;
};

// ---------------------------------------------------------------------------
// WHAT THE BELL IS FOR (Sep 2 2026, before onboarding the team).
//
// Measured on the live table first: 1,314 rows since Jul 7. 940 of them (72%)
// were role BROADCASTS nobody had to act on, and six kinds — raws_landed,
// delivery_out, appointment_change, raws_missing, reply_sla, order_booked —
// were 1,014 of the 1,314 (77%). Three of the seven logins (Harrison, John,
// Kim) had NEVER opened the bell, and the owner was 1,111 rows behind his own
// watermark — last read Jul 16. A feed nobody reads is worse than no feed: the
// two rows that mattered were buried in ninety that didn't.
//
// So the bell carries only what needs a PERSON TO ACT: mentions, revisions,
// cuts to review, new leads, and genuinely urgent things. Everything else is
// either already on the screen where that work is done, or already goes out on
// a channel people actually read (ops Slack, SMS).
//
// This is the ONE gate. Kinds are silenced HERE, at the choke point — not by
// pulling emitters out of 29 files. Nothing is deleted: history stays, and
// every emitter keeps its Slack ping, its task and its timeline row untouched.
//
//   "all"    — ring for everyone the emitter addressed (the default).
//   "person" — ring ONLY rows addressed to a named human (tm:/editor:). Those
//              are also the rows that bridge to SMS / a Manila Slack DM, and
//              for an editor with a login the bell IS their channel. What gets
//              dropped is the role broadcast that shadowed them.
//   "off"    — no bell row at all.
//
// An unlisted kind RINGS (fail open). A new emitter nobody thought to classify
// must never vanish silently — classify it here, on purpose.
//
// ⚠️ TWO KINDS MUST NOT BE SILENCED, however noisy they look:
//   · reply_sla — commsSla.alreadySent() reads the bell row back by dedupeKey
//     to decide whether tier 1 already fired. With no row, `alreadySent` is
//     always false: the tier-1 Slack line and the tier-2 urgent ping would fire
//     for every waiting client EVERY FIVE MINUTES. Silencing it means first
//     moving that ledger off the Notification table (an AppSetting key or a
//     SmartTask dedupeKey) in src/lib/commsSla.ts — a file this pass didn't own.
//   · photos_undelivered — deliveryWatch.ts uses the same row as its "already
//     texted staff about this job" ledger; no row means it re-texts Kyle and
//     Jordan every afternoon, forever.
// ---------------------------------------------------------------------------
type BellRule = "all" | "person" | "off";

const BELL_RULES: Record<string, BellRule> = {
  // --- SILENCED, still reaches the person who has to act -------------------
  // The ROUTED editor keeps their own row (and their Slack DM / SMS). What goes
  // is the ADMIN copy and the EDITOR bench broadcast — and the bench IS
  // /editing, an editor's home page, which lists every job whose raws are in.
  // Jordan (Aug 25): "editors get their notifications on the dashboard."
  raws_landed: "person",
  // The assigned photographer keeps their row AND the text ("Rescheduled",
  // "No longer yours", "New shoot"). The ADMIN broadcast duplicated a change
  // Kyle usually made himself, and /schedule + Ops Day show every move.
  appointment_change: "person",
  // Both people who chase this keep their PERSONAL row and text: the
  // photographer whose upload it is, and the creative manager (Kyle) — see
  // creativeAlertTargets in tasks.ts, which addresses him by tm: id precisely
  // because a role can't find him. Only the OWNER/ADMIN broadcast goes, and
  // that one is already a task in the queue and an alert on Ops Day.
  raws_missing: "person",

  // --- SILENCED entirely: nothing to do about them --------------------------
  // A delivery needs no one: the project page, the Dashboard's delivered rail
  // and the client's own delivery text all say it.
  delivery_out: "off",
  // A new job announces itself on the Dashboard, /schedule and /projects, and
  // mints its own tasks.
  order_booked: "off",
  // The same action already writes an Activity row, posts "Shoot complete …
  // ready to upload content" into the project thread, moves the project to SHOT
  // and runs the editor handoff. Ops Day and the /shoot Complete badge show it.
  shoot_completed: "off",
  // Money, and nobody chases a payment from a bell: /billing and Finance own it.
  order_paid: "off",

  // --- KEPT, deliberately: this is the whole point of the bell --------------
  mention: "all", // someone tagged you by name
  mention_done: "all", // …and someone finished what you tagged them on
  note_reply: "all", // your question on a thread finally has an answer
  project_message: "all", // a message on a job you are editing (Jordan, Sep 15; always person-addressed — mentions.ts)
  revision_raised: "all", // a client wants a change
  revision_resolved: "all", // it came back — check it and re-deliver
  cut_ready: "all", // a cut is waiting on a verdict
  review_ready: "all",
  review_submitted: "all",
  review_changes: "all", // changes asked for on a cut (the editor must act)
  // Oct 6 2026 (lib/revisionReminders): a revision still waiting on its editor
  // after 24 hours, once a day; the same to Kyle for an agency or unassigned
  // job, and his once-a-day list of revisions stuck with editors 3+ days.
  revision_waiting: "all",
  revision_waiting_office: "all",
  revision_stuck: "all",
  review_approved: "all", // the editor's loop closes here
  // §8.1 (Sep 25): a cut's ONE reviewer changed — the FYI to the person it
  // left, and the backup being OFFERED a cut the primary has held past the
  // covered-hours line (lib/reviewerAssignment). Both person-addressed. The
  // FYI stays bell-only (not in notifyPrefs.KIND_TO_EVENT). The OFFER rides
  // the backup's "Video in review" switch since Oct 5 2026 — it asks them to
  // rule on a cut, which is what that switch is for, and a bell nobody opens
  // is how a cut waited nine covered hours in the first place. The new
  // owner's own notice rides cut_ready.
  review_reassigned: "all",
  review_cover_offer: "all",
  // The photographer who shot the job asking for a change on the cut (Sep 18).
  // It is a REQUEST, not a verdict — nothing about the submission moves — so
  // the only thing that carries it to the people who can act is this row.
  cut_change_ask: "all",
  review_feedback: "all", // capture feedback the photographer has to fix
  feedback_shared: "all",
  new_lead: "all", // someone is trying to give us money
  new_client: "all", // a new client to say hello to (Jordan + Kyle, Sep 7)
  program_signup: "all", // a website signup that needs a look — a lead by another name
  client_feedback: "all", // a rating, and a bad one needs a person today
  order_canceled: "all", // stop the work, refund or write off
  photos_undelivered: "all", // the client is past due and waiting (see the warning above)
  cull: "all", // has to happen before the edit starts
  task_assigned: "all", // someone put a job on YOUR name
  edit_assigned: "all", // …the editor version of the same
  edit_started: "all", // an editor pressed Start (or the office started it for them, named as the office) — owner/admin hear it; a Resume is silent (§7.1, Sep 25)
  edit_finished: "all",
  shoot_add_on: "all", // sold in the field; it doesn't get invoiced unless someone sees it
  portal_suggestion: "all", // a client asked for a script change
  portal_asset: "all", // a client's brand file: the bell is its ONLY signal, so it stays
  // CP-06: the assigned editor, told a client's brand changed (brandProfile.ts
  // alertBrandChanges; sent only while the brand_change_alerts switch is on).
  brand_updated: "all",
  // CP-13: a client wrote on their program conversation. Person-addressed to
  // the MESSAGES owner (tm:) plus an OWNER broadcast (lib/programMessages.ts).
  // Bell ONLY: it is deliberately absent from notifyPrefs.KIND_TO_EVENT, so no
  // saved Slack/text switch pages anyone for it — that would be a staff page,
  // and staff pages ride a switch.
  program_message: "all",
  reply_sla: "all", // the client pager (see the warning above)
  // Unanswered client EMAIL (commsSla.sweepEmailSla, Sep 26 2026): Kyle's bell
  // at 4 covered hours, Jordan's at 9. The same warning as reply_sla applies —
  // the row IS that lane's ledger — and it is deliberately absent from
  // notifyPrefs.KIND_TO_EVENT: Jordan asked for the bell and nothing else.
  reply_sla_email: "all",
  system: "all", // integration failures — the owner is the only one who can fix them
  slack_id_missing: "all", // a mention had no Slack ID to go to — the office fixes that on People (Sep 15)
};

// ---------------------------------------------------------------------------
// NO WEEKEND HOLD EITHER (Oct 6 2026). From Sep 20 (audit F07) a ROUTINE
// person-addressed notice — raws in, a cut ready, an edit finished, a verdict,
// a 1080p file back — raised on a Saturday or Sunday to somebody with no saved
// schedule was dated to Monday 9 AM as a text, and its Slack DM was skipped
// because the text had been held (holdUntilCovered / ROUTINE_KINDS). Jordan,
// Oct 6: "Anyone on the team can get pinged anytime. Just not Jordan on
// Saturday until 7:30PM." — weekends included. So the bell bridge asks ONE
// question now, the person's own quiet time (saved on the card, or Jordan's
// Saturday preset), and both legs go at once otherwise, each on the channels
// the person switched on.
//
// What the office COVERAGE days still decide is when the coverage-driven
// OFFICE alerts fire — notifyStaffSms's `urgency` routing (photos not
// delivered, the client-reply pager, via coverage.routeAlert). That is a saved
// business setting on the Operating rules card, not a hold on a person.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// THE CHANNEL BRIDGE (Sep 15). A person-addressed bell row — tm:<id>, or
// editor:<key> resolved through the roster — that is NEW also goes out on the
// channels THAT PERSON has switched on for the row's event: the matrix on
// /settings → Team notifications (src/lib/notifyPrefs.ts; the default table
// in notifyPrefDefaults.ts). Jordan: "I want to make sure the editors are
// getting pinged on slack when they are tagged in a message or a message was
// sent on their project. James and harrison can get texted with the links
// when they are tagged in a message."
//   · Slack DM — the emitter's own sentence (slackDm — who, where, the
//     summary, the link), else the title and the link. Immediate, at any hour
//     on any day, unless the person's own quiet time holds it (then it waits
//     on Slack for the window's end). From Sep 20 to Oct 6 2026 it was also
//     skipped on a weekend when the same sentence had been held as a text —
//     that hold is gone (see the block above).
//   · Text — the same sentence in plain-text form, through the staff SMS
//     queue below: any hour (Oct 6 2026 — no house texting window any more;
//     only the person's own quiet time holds it), the 30-minute digest, the
//     "⚙️ RealTour Hub:" prefix, TEAM MEMBERS ONLY (the number comes off the
//     roster row, never a client contact — the drafts-only policy for client
//     texting is not weakened here), never our own OpenPhone line. Weekends
//     too since Oct 6 2026 (the Sep 20 "routine kind on a Saturday → Monday
//     9am" hold is gone): the switch is the person's own.
//   Both go when both are on. ONE delivery per person per event, on whichever
//   of their rows is new first (an editor is addressed twice — tm: and
//   editor: — and is one human). A tag or reply row with NO sentence is a
//   self-tag (the emitters leave slackDm off) and goes nowhere but the bell.
//   A role broadcast (no userKey) stays bell-only — except the Review Room's
//   OWNER+ADMIN "cut ready" row, which reaches the owner and the office when
//   their "video in review" row says so (the Sep 11 text, now a matrix row;
//   the office leg since Sep 16 — bridgeBroadcast).
// This REPLACES the three rules that predate it — PHOTOGRAPHER-in-audience →
// text (SMS_KINDS), editor:<key> → Slack-or-no-login-SMS (channelForEditor),
// and the owner's own sms-prefs switch (ownerSmsRecipient). A row's roles now
// decide only who can SEE it in the bell. Only a NEWLY created row bridges,
// so a deduped re-announcement can never re-text or re-DM.
//
// THE DELIVERY LOG (Sep 16, Kyle call: "is delivery verifiable?"). Until now
// a bell row was durable, a text was only a claim stamp set BEFORE OpenPhone
// answered, and a Slack DM left no record at all — a refused DM still left
// the bell row looking delivered. Every send point below now writes one
// NotificationDelivery row per person per channel: the bell row itself
// (channel bell, sent), a Slack DM (sent, or failed with Slack's own words),
// a text (queued with the PendingSms id when it enters the digest queue,
// sent once OpenPhone accepts, failed with the error), and skipped with the
// reason when a switch is on but there is nowhere to send (no Slack ID, no
// US number, our own line). Settings → Team notifications reads the newest
// rows back as "Last reached". Best-effort like everything here: a log miss
// never blocks a send.
// ---------------------------------------------------------------------------

type DeliveryChannel = "slack" | "sms" | "bell";
type DeliveryStatus = "sent" | "queued" | "failed" | "skipped";
type DeliveryLog = {
  notificationId?: string | null;
  teamMemberId: string;
  kind: string;
  channel: DeliveryChannel;
  status: DeliveryStatus;
  detail?: string | null;
};

/** One row in the delivery log. Never throws; a failure is a console line.
 *  Nothing prunes this table yet (review, Sep 16): it grows by a handful of
 *  rows a day, and the sweep belongs with the other nightly housekeeping in
 *  the cron route rather than on the send path. */
export async function logDelivery(d: DeliveryLog): Promise<void> {
  try {
    await prisma.notificationDelivery.create({
      data: {
        notificationId: d.notificationId ?? null,
        teamMemberId: d.teamMemberId,
        kind: d.kind,
        channel: d.channel,
        status: d.status,
        detail: d.detail ? d.detail.slice(0, 500) : null,
      },
    });
  } catch (e) {
    console.warn("delivery log write failed", d.channel, d.status, e);
  }
}

/** What the queue was told about a line when it was queued — read back by
 *  the flusher so the "sent" / "failed" / "skipped" rows carry the same kind
 *  and bell row as the "queued" one. Lines queued outside queueStaffSms (the
 *  payroll digest, and rows left from notifyStaffSms's night branch before
 *  Oct 6 2026) have no queued row and log under "staff_sms". */
async function queuedMeta(pendingIds: string[]): Promise<Map<string, { kind: string; notificationId: string | null }>> {
  const out = new Map<string, { kind: string; notificationId: string | null }>();
  if (pendingIds.length === 0) return out;
  try {
    const rows = await prisma.notificationDelivery.findMany({
      where: { channel: "sms", status: "queued", detail: { in: pendingIds } },
      select: { detail: true, kind: true, notificationId: true },
    });
    for (const r of rows) if (r.detail) out.set(r.detail, { kind: r.kind, notificationId: r.notificationId });
  } catch { /* the log is best-effort */ }
  return out;
}

// NO TEXTING WINDOW (Oct 6 2026). A staff text used to wait for 7 AM–10 PM in
// the recipient's timezone (ET, or Manila for an editor), and a Manila
// editor's Slack DM waited for 7 AM their time. Jordan:
// "Editors can get night time pings. Anyone on the team can get pinged
// anytime. Just not Jordan on Saturday until 7:30PM." Both are gone; the one
// thing that still holds a staff text or DM is the person's own quiet time
// (notifySchedule.holdFor — saved on the card, or Jordan's Saturday preset).

// One text per person per window; everything else queues and flushes as ONE
// combined message (Aug 24: Harrison & James were getting blown up with
// back-to-back texts). A line held by somebody's own quiet time queues too —
// it becomes part of the digest that goes when the window ends instead of
// silently vanishing.
const SMS_BATCH_WINDOW_MS = 30 * 60_000;

/** A queued line is DUE when nothing is holding it back (deferUntil null — every
 *  row written before Sep 18 2026, and every line queued while somebody is on
 *  shift) or the hold has passed. ONE definition, shared by the grouping, the
 *  flush select and the acceptance drill: two copies of this predicate is
 *  exactly how a held line gets swept into somebody else's batch. */
export function dueSmsWhere(now: Date = new Date()): Prisma.PendingSmsWhereInput {
  return { sentAt: null, skippedAt: null, OR: [{ deferUntil: null }, { deferUntil: { lte: now } }] };
}

// One digest line into a team member's queue — the ONLY way onto the text
// bridge. The line is the emitter's sentence in plain-text form (or "title →
// link" for a row that brought none). Everything downstream is shared: the
// 30-minute window, the person's own quiet time (asked by the flush), the
// claim-then-send flush. Refuses a member with no usable number — a US/Canada
// line (staffTextNumber in hubSms.ts; a queued line with nowhere to go would
// sit in PendingSms being retried every five minutes, which is exactly what
// Kim's +63 number did under the old "last ten digits" check) — and our OWN
// OpenPhone line (Kyle's roster phone is the company number; texting it from
// itself echoes back through the inbound webhook as a fake client message).
// Returns whether the line was queued. `meta` (Sep 16) names the bell row and
// kind the line came from, for the delivery log: queued with the PendingSms
// id, or skipped with the reason when there is nowhere to send.
// `deferUntil` (Sep 18, audit WF-06): a ROUTINE alert raised when nobody is on
// shift is queued with the next covered moment on it instead of buzzing a phone
// at the weekend. The line is captured exactly as any other — it simply becomes
// invisible to the flusher until that instant. Null (every existing caller) is
// unchanged behaviour: send at the next permitted flush.
async function queueStaffSms(
  teamMemberId: string,
  line: string,
  meta: { kind: string; notificationId?: string | null } = { kind: "staff_sms" },
  deferUntil?: Date | null,
): Promise<boolean> {
  const skip = (detail: string) => logDelivery({ ...meta, teamMemberId, channel: "sms", status: "skipped", detail });
  try {
    const member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true, phone: true } });
    const num = staffTextNumber(member?.phone);
    if (!num) {
      await skip((member?.phone ?? "").replace(/\D/g, "").length >= 7 ? "no US number on file" : "no phone on file");
      return false;
    }
    const { ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
    if ((await ourOpenPhoneNumberKeys().catch(() => new Set<string>())).has(num.key)) {
      console.warn(`queueStaffSms: ${member?.name ?? teamMemberId}'s number is our own OpenPhone line — not texting it to itself`);
      await skip("roster phone is our own OpenPhone line");
      return false;
    }
    const queued = await prisma.pendingSms.create({ data: { teamMemberId, line, deferUntil: deferUntil ?? null }, select: { id: true } });
    // `detail` stays the bare PendingSms id and nothing else — queuedMeta()
    // joins the "sent"/"failed" rows back to this one on exactly that string,
    // so a held-until suffix here would cost every deferred line its kind in
    // the delivery log. The deferral's record is the row's own deferUntil.
    await logDelivery({ ...meta, teamMemberId, channel: "sms", status: "queued", detail: queued.id });
    const recentSend = await prisma.pendingSms.findFirst({
      where: { teamMemberId, sentAt: { gte: new Date(Date.now() - SMS_BATCH_WINDOW_MS) } },
      select: { id: true },
    });
    // First ping in the window → deliver immediately, at any hour (flushing
    // everything queued for them along the way; the flush itself still asks
    // their own quiet time). Otherwise the flusher cron combines it into one
    // message shortly. A DEFERRED line never takes this branch — an immediate
    // flush is exactly what it was queued to avoid.
    if (!deferUntil && !recentSend) {
      // A refused send un-claims the rows for the 5-minute cron — the line is
      // still queued, so this is still "delivered to the queue".
      await flushMemberSms(teamMemberId).catch((e) => console.warn("queueStaffSms immediate flush failed (queued for the cron)", e));
    }
    return true;
  } catch (e) {
    console.warn("queueStaffSms failed", e);
    await logDelivery({ ...meta, teamMemberId, channel: "sms", status: "failed", detail: e instanceof Error ? e.message : "queue failed" });
    return false;
  }
}

// Park every unsent line for a member who can never be texted (Sep 16): a
// terminal skippedAt + reason ONCE, plus a "skipped" delivery row per line,
// instead of a console warning on every 5-minute tick for a week. The rows
// stay (history), they just leave the unsent set. Returns how many parked.
async function parkUntextableSms(teamMemberId: string, reason: string): Promise<number> {
  const rows = await prisma.pendingSms.findMany({
    where: { teamMemberId, sentAt: null, skippedAt: null },
    select: { id: true },
  });
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id);
  const parked = await prisma.pendingSms.updateMany({
    where: { id: { in: ids }, sentAt: null, skippedAt: null },
    data: { skippedAt: new Date(), skipReason: reason },
  });
  if (parked.count === 0) return 0;
  const meta = await queuedMeta(ids);
  for (const id of ids) {
    const m = meta.get(id);
    await logDelivery({ teamMemberId, kind: m?.kind ?? "staff_sms", notificationId: m?.notificationId ?? null, channel: "sms", status: "skipped", detail: `${reason} (${id})` });
  }
  return parked.count;
}

// Send EVERYTHING queued for one member as a single text.
//   "sent"   — OpenPhone accepted one text carrying every unsent line;
//   "none"   — nothing to send (or another flush claimed the rows first);
//   "parked" — the member can't be texted; the lines were parked (above);
//   "held"   — OpenPhone did not confirm (RTP-08, Sep 16). The lines stay
//              claimed and are NEVER re-queued: a digest that may already be on
//              someone's phone must not arrive twice. Until Sep 16 an ambiguous
//              failure unclaimed the rows exactly like a refusal, so an
//              accepted-then-timed-out digest went out again five minutes later.
// Throws when OpenPhone REFUSES, after un-claiming the rows for the next tick.
/** The SMS body budget. One segment-safe cap for the whole digest. */
const SMS_BODY_LIMIT = 1500;

export type PackedDigest = {
  /** How many queued lines the outgoing body ACTUALLY contains. */
  count: number;
  /** The body to send — always complete lines, never a mid-sentence cut. */
  body: string;
  /** True when one single line was too long to send whole and was summarised. */
  summarisedOne: boolean;
};

/**
 * A01 (Sep 21 audit, fixed Sep 22 2026) — THE DIGEST AND THE RECORD AGREE.
 *
 * flushMemberSms claimed every due line, built one body from all of them, sent
 * `body.slice(0, 1500)`, and then stamped EVERY claimed row as sent. So the
 * lines past 1,500 characters were cut off mid-sentence, never delivered, and
 * recorded as delivered. The audit reproduced it: twelve ~210-character updates
 * produced a 1,500-character body, the twelfth was absent, and all twelve
 * carried a sent stamp and a successful delivery log.
 *
 * This packs COMPLETE lines only and reports how many fit. The caller unclaims
 * the rest, so they go out in the next digest instead of being lost — which is
 * also why the header count is computed from what fits rather than from what
 * was claimed.
 *
 * A single line longer than the whole budget is not cut in the middle either:
 * it is summarised, and the text says so, because half an instruction reads
 * like a whole one.
 *
 * Pure, so the boundary cases can be tested without a queue or a provider.
 */
export function packStaffDigest(lines: string[], limit = SMS_BODY_LIMIT): PackedDigest {
  if (lines.length === 0) return { count: 0, body: "", summarisedOne: false };

  const single = (line: string) => `${HUB_SMS_PREFIX}: ${line}`;
  const many = (ls: string[]) => `${HUB_SMS_PREFIX} — ${ls.length} updates:\n` + ls.map((l) => `• ${l}`).join("\n");

  // One line, and it fits: the ordinary case.
  if (lines.length === 1 && single(lines[0]).length <= limit) {
    return { count: 1, body: single(lines[0]), summarisedOne: false };
  }

  // The largest k whose body fits, complete lines only. n is small (a staff
  // digest is a handful of lines), so the straightforward walk is fine and the
  // header's own length is accounted for because the body is rebuilt each time.
  for (let k = lines.length; k >= 2; k--) {
    const body = many(lines.slice(0, k));
    if (body.length <= limit) return { count: k, body, summarisedOne: false };
  }
  if (single(lines[0]).length <= limit) return { count: 1, body: single(lines[0]), summarisedOne: false };

  // ONE line, too long for a text on its own. Never a mid-sentence cut — the
  // beginning plus an explicit pointer, so the reader knows there is more and
  // where it is. The full text is on the bell in the hub.
  const tail = " … (cut short — open the hub to read it in full)";
  const room = limit - `${HUB_SMS_PREFIX}: `.length - tail.length;
  return { count: 1, body: `${HUB_SMS_PREFIX}: ${lines[0].slice(0, Math.max(40, room))}${tail}`, summarisedOne: true };
}

async function flushMemberSms(teamMemberId: string): Promise<"sent" | "none" | "parked" | "held"> {
  // The number BEFORE the claim: a member whose roster phone can't be texted
  // (none, or not a US number) must not claim rows and bounce off OpenPhone
  // every five minutes. Until Sep 16 the rows were simply left unsent — and
  // the three lines the retired no-login editor path queued for Kim (Sep
  // 3–10) tripped this warning on every tick for a week. Now they are parked
  // once (skippedAt) and the flusher stops seeing them.
  const member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { name: true, phone: true } });
  const num = staffTextNumber(member?.phone);
  if (!num) {
    const reason = !member ? "no roster row" : (member.phone ?? "").replace(/\D/g, "").length >= 7 ? "no US number on file" : "no phone on file";
    const n = await parkUntextableSms(teamMemberId, reason);
    if (n > 0) console.warn(`flushMemberSms: ${member?.name ?? teamMemberId} — ${reason}; parked ${n} queued line${n === 1 ? "" : "s"}`);
    return n > 0 ? "parked" : "none";
  }
  // NOT INSIDE THEIR QUIET TIME (Sep 26 2026, the notification schedule). The
  // lines the bridge holds carry deferUntil already; this is for everything
  // queued WITHOUT one — the payroll digest, a line queued before somebody's
  // schedule was saved — which would otherwise go out at 10 AM on Jordan's
  // Saturday. They wait, and the first flush after the window ends carries
  // them all. The person's own quiet time is the ONLY thing asked here: there
  // is no house texting window since Oct 6 2026.
  const { holdFor } = await import("@/lib/notifySchedule");
  if (await holdFor(teamMemberId)) return "none";
  // DUE, not merely unsent (Sep 18): a routine alert raised out of cover
  // carries the next covered moment, and a flush triggered by somebody else's
  // line must not sweep it up early — the body is built from exactly the rows
  // this claim wins, so a held line joining the batch IS the weekend text we
  // are removing.
  const rows = await prisma.pendingSms.findMany({
    where: { teamMemberId, ...dueSmsWhere() },
    orderBy: { createdAt: "asc" },
    // Bounded: a member with a long backlog (Kim's 63 lines sat unsent for a
    // week) otherwise had every id read and re-read on a five-minute tick. Far
    // more than one text's worth, so the pack below is never starved.
    take: 60,
  });
  if (rows.length === 0) return "none";

  // ---------------------------------------------------------------------
  // R3 (follow-up audit, Sep 22 2026) — PACK FIRST, THEN CLAIM ONLY WHAT FITS.
  //
  // The A01 fix claimed every due row, packed, and then RELEASED the overflow
  // with `.catch(() => {})` before sending anyway. That introduced a new way to
  // strand an update, and it is worse than the bug it replaced: if the release
  // fails, the omitted rows stay claimed under the SAME claim stamp as a digest
  // that really was sent — so recoverUnclaimedStaffSms reconstructs the outbox
  // key, finds the outbox owns it, and skips those rows forever. Six sent, six
  // stranded, and nothing ever looks again.
  //
  // There is no release to fail if there is no overflow to release. The pack
  // decides the batch BEFORE anything is claimed; the rows that do not fit are
  // simply never touched and are still due on the next tick.
  // ---------------------------------------------------------------------
  const plan = packStaffDigest(rows.map((r) => r.line));
  if (plan.count === 0) return "none";
  const wanted = rows.slice(0, plan.count);

  // CLAIM before sending — the immediate flush and the 5-minute cron can race
  // on the same unsent rows and text the digest twice (audit). The claim stamp
  // is a unique instant; the body is then built from EXACTLY the rows this
  // claim won, so a partial claim can never re-text a competitor's rows
  // (review finding), and an unclaim can only release our own.
  const claimStamp = new Date();
  const claimed = await prisma.pendingSms.updateMany({
    where: { id: { in: wanted.map((r) => r.id) }, sentAt: null },
    data: { sentAt: claimStamp },
  });
  if (claimed.count === 0) return "none";
  const mine = await prisma.pendingSms.findMany({
    where: { teamMemberId, sentAt: claimStamp },
    orderBy: { createdAt: "asc" },
  });
  if (mine.length === 0) return "none";
  // A01: both of these are bound to the rows this digest ACTUALLY carries,
  // which is decided below by packStaffDigest — `sending`, never `mine`. A
  // delivery log covering a line the text does not contain is the defect.
  let sending: typeof mine = mine;
  const unclaim = () =>
    prisma.pendingSms.updateMany({ where: { id: { in: sending.map((r) => r.id) } }, data: { sentAt: null } }).catch(() => {});
  // The bell rows and kinds behind these lines, for the log (one lookup).
  const meta = await queuedMeta(mine.map((r) => r.id));
  const logAll = (status: "sent" | "failed", detail?: string) =>
    Promise.all(
      sending.map((r) => {
        const m = meta.get(r.id);
        return logDelivery({ teamMemberId, kind: m?.kind ?? "staff_sms", notificationId: m?.notificationId ?? null, channel: "sms", status, detail: detail ?? r.id });
      }),
    );
  const { defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  // A gate, not the send: the outbox resolves the sending number itself.
  if (!(await defaultOpenPhoneNumber())) {
    await unclaim();
    await logAll("failed", "no OpenPhone number to send from");
    return "none";
  }
  // A01 + R3: the body is packed from exactly the rows this claim WON.
  //
  // `mine` is a subset of `wanted`, which already packed — and a subset always
  // still fits, because dropping a line shortens the body and can only shrink
  // the "N updates" header (and at N=1 the shorter single-line form is used).
  // So this repack never leaves an overflow behind; the assertion below says so
  // out loud rather than trusting the reasoning.
  const packed = packStaffDigest(mine.map((r) => r.line));
  if (packed.count !== mine.length) {
    // Unreachable by the argument above. If it ever happens, the rows we cannot
    // carry go back to the queue BEFORE anything is sent, and the send is
    // abandoned for this tick — never sent-with-a-silent-remainder.
    await prisma.pendingSms.updateMany({ where: { id: { in: mine.map((r) => r.id) } }, data: { sentAt: null } }).catch(() => {});
    console.warn(`flushMemberSms: ${teamMemberId} — repack shrank ${mine.length} claimed line(s) to ${packed.count}; released them all and sent nothing.`);
    return "none";
  }
  sending = mine;
  if (rows.length > mine.length) {
    console.info(`flushMemberSms: ${teamMemberId} — ${mine.length} of ${rows.length} due line(s) fit this text; the rest were never claimed and are due on the next tick.`);
  }
  const body = packed.body;
  // Through the outbox (RTP-08): one durable row per digest, keyed on the claim
  // stamp this flush won — so the send survives a killed worker with a record,
  // and OpenPhone's own message id is kept as the proof that it went.
  const { sendThroughOutbox, outboxStateOf, staffKey } = await import("@/lib/outbox");
  const key = staffKey(teamMemberId, claimStamp);
  // WHY THE CLAIM STILL COMES FIRST HERE (review, Sep 16). On the client rails
  // the outbox row IS the claim; a staff digest cannot work that way, because
  // its body is built from exactly the lines this claim won — enqueueing first
  // would mean texting lines a competing flush is also sending (the partial-claim
  // finding this file already carries). So the claim stays first, and the gap it
  // leaves — killed after the claim, before this row exists — is closed from the
  // other end by recoverUnclaimedStaffSms() on the 5-minute flusher, which puts
  // lines back in the queue when no outbox row was ever written under this key.
  let res;
  try {
    res = await sendThroughOutbox({
      channel: "sms",
      toRef: num.key,
      body, // already packed to complete lines within the limit (A01)
      dedupeKey: key,
      requestedBy: FLUSH_REQUESTED_BY,
    });
  } catch (e) {
    // A database failure while queueing. Ask the outbox itself whether a row
    // got written before deciding: NO row means nothing was ever handed over,
    // so the lines go back in the queue; a row means the watchdog owns it and
    // these lines must not be re-sent.
    const wrote = await outboxStateOf(key).catch(() => null);
    const why = e instanceof Error ? e.message : "queue failed";
    if (!wrote) {
      await unclaim();
      await logAll("failed", why);
      throw e;
    }
    await logAll("failed", `unconfirmed — not re-sent: ${why}`);
    return "held";
  }
  if (res.outcome === "accepted") {
    // Sent — one row per line so "Last reached: text" names the kind that went.
    await logAll("sent", res.providerId ? `op-${res.providerId}` : undefined);
    // R3 — THE CHECKPOINT, and ONLY on `accepted`.
    //
    // recoverUnclaimedStaffSms pages through claimed rows in a multi-day window
    // and asks the outbox about each. Settled rows never leave that window, so
    // a busy week fills the page with history and a genuine orphan behind it is
    // never reached — ordering alone cannot fix that, because the settled rows
    // are the OLDEST. This marks a row as answered for good so the scan can
    // query exactly the orphans.
    //
    // ACCEPTED is the only state that may be written here. markFailed,
    // retryHeld and recoverExpiredLeases all RELEASE the dedupeKey (set it to
    // null) on purpose, so "the outbox holds this key" is a temporary fact for
    // every other state — and turning a temporary fact into a permanent marker
    // would reintroduce this finding's exact shape under a new name. markAccepted
    // never touches the key.
    await settleStaffSms(sending.map((r) => r.id));
    return "sent";
  }
  if (res.outcome === "failed") {
    await unclaim(); // REFUSED → nothing went out, so the rows go back in the queue
    await logAll("failed", res.error);
    throw new Error(res.error);
  }
  // Unconfirmed (or another worker holds this exact claim): the digest may be on
  // their phone already. Keep the claim, say so in the log, and let a person
  // settle it — Connections lists every unconfirmed send with its age.
  const why = res.outcome === "unknown" ? res.error : `another worker holds this flush (${res.outcome})`;
  await logAll("failed", `unconfirmed — not re-sent: ${why}`);
  console.warn(`flushMemberSms: ${teamMemberId}'s digest could not be confirmed — held, not re-queued (${why})`);
  return "held";
}

// The identity every staff digest is queued under, kept in one place: the
// watchdog below uses it to tell "this flush reached the outbox" from "this
// flush died before it ever did".
const FLUSH_REQUESTED_BY = "notify:flushMemberSms";

/** THE DIGEST THAT NOBODY IS SENDING (review, Sep 16). flushMemberSms claims its
 *  lines (sentAt = the claim stamp) and only then writes the outbox row that
 *  makes the send durable. A worker killed in the gap leaves those lines
 *  claimed, unsent and invisible to every later flush — they no longer match
 *  `sentAt: null` — which is exactly the claim-before-send loss RTP-08 removed
 *  from the client rails.
 *
 *  A claimed line may only be released when we can PROVE nothing was handed
 *  over, and the proof is the absence of an outbox row under that flush's own
 *  identity (`staff:<member>:<claim stamp>`). Two guards keep that proof honest:
 *   · nothing is touched until the outbox has handled at least one staff digest.
 *     Before that, "no outbox row" only means "sent by the code that predates
 *     the outbox", and releasing those would re-text digests that did go out;
 *   · a five-minute margin after that first row, because a rolling deploy can
 *     leave an old instance finishing a flush while the new one starts.
 *  Lines claimed in the last 15 minutes are left alone — their flush may still
 *  be in flight — and anything we cannot read is left claimed, because a stuck
 *  digest beats a duplicate one. */
/** Mark digest lines as answered for good. Only ever called where the outbox's
 *  ownership of the key is permanent — see the note at the accepted branch. */
async function settleStaffSms(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await prisma.pendingSms.updateMany({ where: { id: { in: ids }, settledAt: null }, data: { settledAt: new Date() } }).catch(() => {
    // A failed stamp is SAFE in the only direction that matters: the row stays
    // unsettled, the scan looks at it again, finds the accepted outbox row and
    // stamps it then. The marker is an optimisation over a correct scan, never
    // a substitute for one.
  });
}

async function recoverUnclaimedStaffSms(): Promise<number> {
  const { outboxStateOf, staffKey } = await import("@/lib/outbox");
  const firstStaff = await prisma.outboxMessage
    .findFirst({ where: { requestedBy: FLUSH_REQUESTED_BY }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
    .catch(() => null);
  if (!firstStaff) return 0; // the outbox has never carried a staff digest here
  const from = new Date(firstStaff.createdAt.getTime() + 5 * 60_000);
  const until = new Date(Date.now() - 15 * 60_000);
  if (from >= until) return 0;
  // R3 — THE PAGE HOLDS ORPHANS, NOT HISTORY.
  //
  // This read took a page of 200 claimed rows in the window with no settled
  // predicate. Settled rows stay in that window for days and they are the
  // OLDEST, so ordering them first — which is what the A01 pass added — puts
  // the history at the front of the page and leaves a later orphan permanently
  // out of reach. `settledAt: null` is the fix: a digest that provably went is
  // marked once and never competes for a slot again.
  //
  // Rows written before that column existed have a null marker, which is
  // correct and self-limiting: each is examined once, found to be owned by an
  // accepted outbox row, stamped by the loop below, and never seen again.
  const claimed = await prisma.pendingSms
    .findMany({ where: { sentAt: { gt: from, lt: until }, skippedAt: null, settledAt: null }, select: { id: true, teamMemberId: true, sentAt: true }, orderBy: { sentAt: "asc" }, take: 200 })
    .catch(() => [] as { id: string; teamMemberId: string; sentAt: Date | null }[]);
  if (claimed.length === 0) return 0;
  // One group per flush: the claim stamp names it, which is what makes the
  // outbox key reconstructible from the rows alone.
  const byFlush = new Map<string, { teamMemberId: string; sentAt: Date; ids: string[] }>();
  for (const r of claimed) {
    if (!r.sentAt) continue;
    const key = staffKey(r.teamMemberId, r.sentAt);
    const g = byFlush.get(key) ?? { teamMemberId: r.teamMemberId, sentAt: r.sentAt, ids: [] };
    g.ids.push(r.id);
    byFlush.set(key, g);
  }
  let recovered = 0;
  for (const [key, g] of byFlush) {
    let held: Awaited<ReturnType<typeof outboxStateOf>> = null;
    try {
      held = await outboxStateOf(key);
    } catch {
      continue; // can't tell → leave it claimed
    }
    if (held) {
      // The outbox owns this flush. Stamp it out of the scan ONLY when the
      // answer is permanent: an accepted row keeps its dedupeKey for ever,
      // while pending / attempting / unknown can all have their identity
      // released again (markFailed, retryHeld, recoverExpiredLeases) — so
      // those keep today's behaviour and stay re-examinable on the next pass.
      if (held.state === "accepted") await settleStaffSms(g.ids);
      continue;
    }
    const back = await prisma.pendingSms
      .updateMany({ where: { id: { in: g.ids }, sentAt: g.sentAt }, data: { sentAt: null } })
      .catch(() => ({ count: 0 }));
    if (back.count > 0) {
      recovered += back.count;
      console.warn(`flushPendingSms: ${g.teamMemberId} — ${back.count} digest line(s) were claimed but never handed to OpenPhone; put back in the queue`);
    }
  }
  return recovered;
}

/** The drain sent a staff digest whose flush is gone (api/cron/gmail →
 *  outbox.drainPending). The lines were already claimed under this flush's stamp
 *  — that is what the identity encodes — so all that is missing is the delivery
 *  log that makes "Last reached: text" true on the People page. */
export async function recordDrainedStaffSms(
  row: { dedupeKey: string | null },
  providerId: string | null,
): Promise<string | null> {
  const key = row.dedupeKey ?? "";
  if (!key.startsWith("staff:")) return null;
  const rest = key.slice("staff:".length);
  const cut = rest.indexOf(":");
  if (cut < 1) return null;
  const teamMemberId = rest.slice(0, cut);
  const claimStamp = new Date(rest.slice(cut + 1)); // an ISO instant, colons and all
  if (Number.isNaN(claimStamp.getTime())) return null;
  const mine = await prisma.pendingSms
    .findMany({ where: { teamMemberId, sentAt: claimStamp }, select: { id: true } })
    .catch(() => [] as { id: string }[]);
  if (mine.length === 0) return null;
  const meta = await queuedMeta(mine.map((r) => r.id));
  for (const r of mine) {
    const m = meta.get(r.id);
    await logDelivery({
      teamMemberId,
      kind: m?.kind ?? "staff_sms",
      notificationId: m?.notificationId ?? null,
      channel: "sms",
      status: "sent",
      detail: providerId ? `op-${providerId} (recovered)` : `${r.id} (recovered)`,
    });
  }
  return `recovered and sent ${mine.length} queued text line(s) for ${teamMemberId}`;
}

// Cron flusher (every 5 min): deliver queued digests once the batch window has
// passed, at any hour — the texting window (7 AM–10 PM in the recipient's
// timezone) went on Oct 6 2026; only a person's own quiet time holds a line,
// asked inside flushMemberSms. `skipped`
// (Sep 16) counts lines parked because the member can never be texted, and
// `held` (Sep 16, RTP-08) counts digests OpenPhone did not confirm — those are
// NOT re-queued, they wait on Connections for a person. `recovered` (review,
// Sep 16) counts lines a killed flush left claimed and unsent, put back in the
// queue by the watchdog above — it runs FIRST, and before the early return,
// because those lines are claimed and so never appear in the pending groups.
// `dms` (Sep 26 2026, the notification schedule): Slack DMs held through a
// person's quiet time are released here too — one flusher for everything that
// waits, so a text and a DM held until 7:30 PM go out on the same tick.
export async function flushPendingSms(): Promise<{ flushed: number; failed: string[]; skipped: number; held: number; recovered: number; dms: { sent: number; failed: number } }> {
  const recovered = await recoverUnclaimedStaffSms().catch(() => 0);
  const dms = await releaseHeldStaffDms().catch((e) => {
    console.warn("releasing held Slack DMs failed (next tick retries)", e);
    return { sent: 0, failed: 0 };
  });
  // DUE lines only. Held lines are excluded from the grouping itself, not just
  // from the send: `_min.createdAt` drives the 30-minute batch window below, so
  // a Saturday line held until Monday would otherwise make every one of that
  // person's later lines look "old enough to go now".
  const pending = await prisma.pendingSms.groupBy({
    by: ["teamMemberId"],
    where: dueSmsWhere(),
    _min: { createdAt: true },
  });
  if (pending.length === 0) return { flushed: 0, failed: [], skipped: 0, held: 0, recovered, dms };
  let flushed = 0;
  let skipped = 0;
  let held = 0;
  const failed: string[] = [];
  for (const p of pending) {
    const oldest = p._min.createdAt;
    if (!oldest) continue;
    // A member with no textable number is parked — there is nothing to wait
    // for (Sep 16).
    const member = await prisma.teamMember.findUnique({ where: { id: p.teamMemberId }, select: { phone: true } });
    if (!staffTextNumber(member?.phone)) {
      try {
        if ((await flushMemberSms(p.teamMemberId)) === "parked") skipped++;
      } catch (e) {
        failed.push(`${p.teamMemberId}: ${e instanceof Error ? e.message : "park failed"}`);
      }
      continue;
    }
    // Any hour (Oct 6 2026 — no texting window; Kim's and John Mark's Manila
    // night included). flushMemberSms still asks the person's own quiet time.
    const recentSend = await prisma.pendingSms.findFirst({
      where: { teamMemberId: p.teamMemberId, sentAt: { gte: new Date(Date.now() - SMS_BATCH_WINDOW_MS) } },
      select: { id: true },
    });
    if (recentSend && Date.now() - oldest.getTime() < SMS_BATCH_WINDOW_MS) continue;
    // ONE bad recipient must not abort everyone else's flush. flushMemberSms
    // rethrows when OpenPhone rejects a send, and this loop had no guard — so
    // Kim's un-textable +63 number jammed the whole queue for FIVE DAYS and
    // failed the 5-minute comms cron every run (audit HIGH). Isolate per
    // member: a permanent rejection is that person's problem, not the team's.
    try {
      const r = await flushMemberSms(p.teamMemberId);
      if (r === "sent") flushed++;
      else if (r === "parked") skipped++;
      else if (r === "held") held++;
    } catch (e) {
      failed.push(`${p.teamMemberId}: ${e instanceof Error ? e.message : "send failed"}`);
    }
  }
  return { flushed, failed, skipped, held, recovered, dms };
}

// INTERNAL STAFF SMS. For alerts that must reach a named person's phone rather
// than a role's bell — "photos still not delivered", the kind of thing that has
// to interrupt someone.
//
// Numbers come ONLY from TeamMember rows, resolved from ids the caller passes.
// It deliberately accepts no raw phone string: the one thing separating a staff
// text from a client text in this codebase is which table the number came out
// of, so that boundary is enforced by the signature, not by a comment.
//
// It also refuses to text OUR OWN OpenPhone line. That is not hypothetical —
// Kyle's TeamMember.phone is currently the company number (215) 645-4889, so a
// naive send would text the office line from itself and echo back through the
// inbound webhook as a fake client message. When that happens the alert is
// relayed to Slack instead of being silently dropped, because a missed alert is
// the failure this whole feature exists to prevent.
// ---------------------------------------------------------------------------
// "held" (Sep 26 2026, the notification schedule): kept — a Slack DM or a text
// dated to the end of the person's own quiet time. Like "deferred" it is a
// success for the relay below (the alert WILL reach them); `until` says when.
// ("quiet-hours" — a text queued for the morning because it was night — went
// with the texting window on Oct 6 2026.)
export type StaffSmsResult = {
  teamMemberId: string;
  name: string;
  outcome: "sent" | "slack" | "no-phone" | "own-line" | "deferred" | "held" | "failed";
  until?: string;
};

/** Anyone we could not reach still gets the alert — via Slack ops. Lifted out
 *  of notifyStaffSms (Sep 18) so the deferred path shares it: a routine alert
 *  the text queue could not hold must still land somewhere. "deferred" is a
 *  success — the line is queued and dated, not missed.
 *
 *  Since Sep 20 (audit F07) the PERSONAL bridge shares it too, with a
 *  one-person list: bridgePerson and bridgeBroadcast used to write a
 *  "slack failed" row and move on, which for a Slack-only teammate meant the
 *  alert ended at the bell. One relay policy for both paths, here.
 *
 *  It is honest about its own limit: opsAlert is Slack as well, so in a real
 *  Slack outage the relay fails with the DM it is relaying. It is the last
 *  channel we have, not a guarantee — which is why the deferred text and the
 *  bell row both stay exactly where they are.
 *
 *  `verb` because the line has to name the right problem (review, Sep 20).
 *  notifyStaffSms really is a texting path, so "Couldn't text" is accurate
 *  there. On the bridge the failing leg is often a Slack DM to somebody with
 *  no text switch at all — Kim Miguel has none — and an ops line reading
 *  "Couldn't text Kim Miguel" sends the office hunting for a phone problem
 *  that does not exist. */
async function relayUnreached(out: StaffSmsResult[], text: string, verb: "text" | "reach" = "text"): Promise<void> {
  const unreached = out.filter(
    (r) => r.outcome !== "sent" && r.outcome !== "slack" && r.outcome !== "deferred" && r.outcome !== "held",
  );
  if (unreached.length) {
    await opsAlert(`⚠️ Couldn't ${verb} ${unreached.map((r) => `${r.name} (${r.outcome})`).join(", ")} — relaying: ${text}`);
  }
}

// `kind` (Sep 16) names the alert in the delivery log. deliveryWatch's "photos
// still not delivered" passes "photos_undelivered" (Sep 18) — the label map
// already had a name for it, so the log reads "photos not delivered" instead of
// the "staff alert" default. Pass a kind when an alert wants its own name on
// that line.
//
// WHO IS ON, AND WHETHER THIS CAN WAIT (Sep 18, audit WF-06).
//
// `urgency` is OPT-IN and that is deliberate: leaving it off is byte-for-byte
// today's behaviour, so no existing caller changes because this landed. Pass
// it and the alert is routed:
//   · routine, out of cover → every recipient's line is QUEUED with the next
//     covered moment on it (PendingSms.deferUntil). Captured, logged, on the
//     boards — just not buzzing a phone on a Saturday;
//   · urgent, out of cover  → the named on-call takes it INSTEAD of the roster
//     the caller passed, because "urgent" out of hours should mean a person who
//     agreed to be reachable, not five people who happen to hold a role;
//   · urgent, NOBODY named  → the caller's own list, exactly as today. An unset
//     rota must degrade to the old behaviour, never to silence.
//
// AND WHETHER THIS PERSON MAY BE INTERRUPTED (Sep 26 2026, the notification
// schedule). Every recipient is asked notifySchedule.holdFor: inside their own
// quiet time (Jordan: Saturday until 7:30 PM) the alert is KEPT — as a held
// Slack DM when they have a Slack ID, else as a text dated to the window's
// end — and goes then, once. That is the ONLY hold (Oct 6 2026, Jordan:
// "Anyone on the team can get pinged anytime. Just not Jordan on Saturday
// until 7:30PM."): the Sep 26 rule that held an urgent on-call page from
// 10 PM to 7 AM ET, its Oct 5 extension to Kyle's notices and the desk tasks
// (`holdOvernight`), and the 7 AM–10 PM texting window that queued a night
// text "for the morning" are all gone. A page at 3 AM goes at 3 AM.
export async function notifyStaffSms(
  teamMemberIds: string[],
  text: string,
  kind = "staff_sms",
  opts: {
    urgency?: "routine" | "urgent";
  } = {},
): Promise<StaffSmsResult[]> {
  let ids = [...new Set(teamMemberIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const out: StaffSmsResult[] = [];
  const now = new Date();
  try {
    const { holdFor } = await import("@/lib/notifySchedule");
    if (opts.urgency) {
      const { routeAlert } = await import("@/lib/coverage");
      const route = await routeAlert(opts.urgency);
      if (route.send === "defer") {
        const members = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
        for (const m of members) {
          // Slack is deliberately NOT tried here. A DM buzzes a phone like a
          // text does, so holding the text and DMing anyway would deliver the
          // weekend page this exists to remove.
          // A person's own quiet time adds to the rota (Sep 26): Monday 9 AM
          // for everyone, later for somebody quiet on Monday morning.
          const personal = await holdFor(m.id, route.until);
          const queued = await queueStaffSms(m.id, text, { kind }, personal && personal > route.until ? personal : route.until);
          // Refused (no US number, or our own OpenPhone line — Kyle's roster
          // phone IS the office line) means the queue has nowhere to hold it.
          // That falls through to the ops-channel relay below rather than
          // vanishing: a deferred alert is quieter than today, never gone.
          out.push({ teamMemberId: m.id, name: m.name, outcome: queued ? "deferred" : "no-phone" });
        }
        await relayUnreached(out, text);
        return out;
      }
      // The rota answers for everyone on an urgent out-of-hours page — and
      // only when somebody is actually named (routeAlert returns null when
      // nobody is, which leaves `ids` as the caller sent them).
      if (route.toOnCall) ids = [route.toOnCall];
    }
    const members = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, slackId: true } });
    const { OpenPhone, defaultOpenPhoneNumber, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
    const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
    // Resolved ONCE — defaultOpenPhoneNumber is a live API round trip.
    const from = ids.length ? await defaultOpenPhoneNumber() : null;
    const body = `${HUB_SMS_PREFIX}: ${text}`;
    const log = (teamMemberId: string, channel: DeliveryChannel, status: DeliveryStatus, detail?: string) =>
      logDelivery({ teamMemberId, kind, channel, status, detail });

    for (const m of members) {
      // Held? Only by their own quiet time — an urgent page included. Kept on
      // the channel they would have got it on: a held DM for a Slack ID, else
      // a text dated to the end. Only when neither can keep it does it fall
      // through and go now (a hold never drops an alert).
      const until = await holdFor(m.id, now);
      if (until) {
        const kept = m.slackId
          ? await holdStaffDm({ teamMemberId: m.id, slackId: m.slackId, text, until, kind, why: opts.urgency === "urgent" ? "urgent page, their quiet time" : "their quiet time" })
          : await queueStaffSms(m.id, text, { kind }, until);
        if (kept) {
          out.push({ teamMemberId: m.id, name: m.name, outcome: "held", until: until.toISOString() });
          continue;
        }
      }
      // Slack first — Jordan (Aug 24): "instead of texting Kyle, message him
      // on Slack." Anyone with a Slack id gets a DM; SMS is the fallback.
      if (m.slackId) {
        const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
        const dm = await slackDmUserDetailed(m.slackId, text);
        if (dm.ok) {
          await log(m.id, "slack", "sent");
          out.push({ teamMemberId: m.id, name: m.name, outcome: "slack" });
          continue;
        }
        await log(m.id, "slack", "failed", dm.error);
      }
      const num = staffTextNumber(m.phone);
      if (!num) {
        await log(m.id, "sms", "skipped", (m.phone ?? "").replace(/\D/g, "").length >= 7 ? "no US number on file" : "no phone on file");
        out.push({ teamMemberId: m.id, name: m.name, outcome: "no-phone" });
        continue;
      }
      if (ours.has(num.key)) {
        // Loud, not silent: this is a data problem someone has to fix.
        console.warn(`notifyStaffSms: ${m.name}'s number is our own OpenPhone line — cannot text, relaying to ops`);
        await log(m.id, "sms", "skipped", "roster phone is our own OpenPhone line");
        out.push({ teamMemberId: m.id, name: m.name, outcome: "own-line" });
        continue;
      }
      try {
        if (!from) throw new Error("no OpenPhone number");
        await OpenPhone.sendMessage(from, num.to, body);
        await log(m.id, "sms", "sent");
        out.push({ teamMemberId: m.id, name: m.name, outcome: "sent" });
      } catch (e) {
        console.warn("notifyStaffSms send failed", m.name, e);
        await log(m.id, "sms", "failed", e instanceof Error ? e.message : "send failed");
        out.push({ teamMemberId: m.id, name: m.name, outcome: "failed" });
      }
    }
    await relayUnreached(out, text);
    // AN URGENT PAGE THAT IS WAITING IS SAID TO BE WAITING (Sep 26). A held
    // routine alert is quiet by design; a held URGENT one means nobody is
    // being interrupted until the hold ends, and the ops channel — which the
    // pagers post to first — is told that plainly, with the time. Since
    // Oct 6 2026 the only thing that can hold a page is the person's OWN
    // quiet time (Jordan on call on his Saturday, or a window somebody saved),
    // so the notice is rare — and still the one place a waiting page is said.
    if (opts.urgency === "urgent") {
      // Oct 5 2026: when the ops channel IS one person's DM and THEIR page is
      // the one being held, the notice could only reach them when the page
      // itself does (opsAlert holds a DM in their quiet time too) — so it names
      // only the OTHER people whose page is waiting, and says nothing when
      // there are none.
      const opsPerson = out.some((r) => r.outcome === "held") ? await opsDestinationPerson() : null;
      const slackOf = new Map(members.map((m) => [m.id, m.slackId]));
      const held = out.filter((r) => r.outcome === "held" && r.until && !(opsPerson && slackOf.get(r.teamMemberId) === opsPerson));
      if (held.length) {
        const { etDateTime } = await import("@/lib/datetime");
        const { scrubMoney } = await import("@/lib/text");
        await opsAlert(
          `⏸ Urgent page held (their quiet time) — ${held.map((r) => `${r.name} gets it ${etDateTime(r.until!)} ET`).join(", ")}. Relaying: ${scrubMoney(text)}`,
        );
      }
    }
  } catch (e) {
    console.warn("notifyStaffSms failed", e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HELD SLACK DMs (Sep 26 2026, the notification schedule).
//
// A text can wait: PendingSms has carried deferUntil since Sep 18. A Slack DM
// had nowhere to wait, which is why the Sep 20 coverage hold (removed Oct 6
// 2026) could only ever SUPPRESS a DM when the same sentence was held as a text. Jordan's quiet time
// needs more than that — "texts/Slack DMs to that person are held and go out
// when the window ends" — and turning his Slack-only notices into texts would
// quietly overrule the channel he chose on Team notifications.
//
// So a held DM is one AppSetting row (`held-dm:<person>:<stamp>`, created
// atomically), released by the same 5-minute flusher as the texts
// (flushPendingSms → releaseHeldStaffDms). CLAIM, SEND, THEN DELETE: a tick
// claims a row by compare-and-set on its exact stored value (two ticks cannot
// both win), sends, and only then deletes it — so a worker killed mid-release
// leaves a claimed row that the next tick takes back after 15 minutes, the
// same rule recoverUnclaimedStaffSms uses for texts. Deleting first would make
// that crash a lost notice; the cost of this order is a duplicate only if the
// worker dies in the instant between Slack accepting and the delete.
// Everything one person has waiting goes as ONE DM, oldest first, the way the
// text digest batches. Every step writes a delivery row: slack/queued when
// held ("held until …"), slack/sent or slack/failed when released. A refused
// release is retried on the next two ticks and then relayed to the ops channel
// — never dropped.
// ---------------------------------------------------------------------------
type HeldDm = {
  teamMemberId: string;
  slackId: string | null;
  text: string;
  until: string;
  kind: string;
  notificationId: string | null;
  heldAt: string;
  why: string;
  attempts: number;
  /** set while a release is in flight; older than HELD_DM_LEASE_MS = a dead worker */
  claimedAt?: string;
  /** TERMINAL (Sep 26 2026 review): the release finished with this row — sent,
   *  skipped or given up — but the delete that should have removed it failed.
   *  A row carrying it is never sent again; the next tick only deletes it. */
  settledAt?: string;
};
const HELD_DM_MAX_ATTEMPTS = 3;
const HELD_DM_LEASE_MS = 15 * 60_000;
/** One release per person per tick carries at most this many notices; the rest
 *  go on the next tick (Slack caps a message; a person's Saturday rarely nears it). */
const HELD_DM_BATCH = 20;

async function holdStaffDm(d: {
  teamMemberId: string;
  slackId: string | null;
  text: string;
  until: Date;
  kind: string;
  notificationId?: string | null;
  why: string;
}): Promise<boolean> {
  try {
    const { heldDmKey } = await import("@/lib/notifySchedule");
    const key = heldDmKey(d.teamMemberId);
    const row: HeldDm = {
      teamMemberId: d.teamMemberId,
      slackId: d.slackId,
      text: d.text,
      until: d.until.toISOString(),
      kind: d.kind,
      notificationId: d.notificationId ?? null,
      heldAt: new Date().toISOString(),
      why: d.why,
      attempts: 0,
    };
    await prisma.appSetting.create({ data: { key, value: JSON.stringify(row), updatedBy: "notify:held-dm" } });
    await logDelivery({
      notificationId: d.notificationId ?? null,
      teamMemberId: d.teamMemberId,
      kind: d.kind,
      channel: "slack",
      status: "queued",
      detail: `held until ${row.until} (${d.why}) — ${key}`,
    });
    return true;
  } catch (e) {
    console.warn("holding a Slack DM failed (sending now instead)", d.kind, e);
    return false;
  }
}

/** Is a DM for this bell row already held for this person, and not yet
 *  released? The held row is the durable record; its slack/queued log line is
 *  best-effort (see bridgePerson's retry gate). Never throws: a read that
 *  fails answers "no", which is today's behaviour. */
async function heldDmWaiting(teamMemberId: string, notificationId: string): Promise<boolean> {
  try {
    const { HELD_DM_PREFIX } = await import("@/lib/notifySchedule");
    const rows = await prisma.appSetting.findMany({
      where: { key: { startsWith: `${HELD_DM_PREFIX}${teamMemberId}:` } },
      select: { value: true },
    });
    return rows.some((r) => {
      try {
        const dm = JSON.parse(r.value) as HeldDm;
        return dm.notificationId === notificationId && !dm.settledAt;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/** Release every held DM whose hold has passed and whose person is not inside
 *  a new quiet window (a schedule saved since can only make it wait longer,
 *  never early). Returns how many DMs went and how many failed this tick. */
export async function releaseHeldStaffDms(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
  const res = { sent: 0, failed: 0 };
  const { HELD_DM_PREFIX, holdFor } = await import("@/lib/notifySchedule");
  const rows = await prisma.appSetting
    .findMany({ where: { key: { startsWith: HELD_DM_PREFIX } }, select: { key: true, value: true } })
    .catch(() => [] as { key: string; value: string }[]);
  if (rows.length === 0) return res;
  const byPerson = new Map<string, { key: string; raw: string; dm: HeldDm }[]>();
  const settledLeftovers: string[] = [];
  for (const r of rows) {
    let dm: HeldDm;
    try {
      dm = JSON.parse(r.value) as HeldDm;
    } catch {
      continue; // unreadable — left in place, visible on the store, never guessed at
    }
    // Finished with on an earlier tick whose delete failed: only the delete is
    // owed, never a second send.
    if (dm?.settledAt) {
      settledLeftovers.push(r.key);
      continue;
    }
    if (!dm?.teamMemberId || !dm.text || !dm.until || new Date(dm.until) > now) continue;
    // Another tick is releasing it right now — unless that claim is old enough
    // to belong to a worker that died.
    if (dm.claimedAt && now.getTime() - new Date(dm.claimedAt).getTime() < HELD_DM_LEASE_MS) continue;
    const list = byPerson.get(dm.teamMemberId) ?? [];
    list.push({ key: r.key, raw: r.value, dm });
    byPerson.set(dm.teamMemberId, list);
  }
  if (settledLeftovers.length) {
    await prisma.appSetting.deleteMany({ where: { key: { in: settledLeftovers } } }).catch((e) => {
      console.warn(`held Slack DMs: ${settledLeftovers.length} finished row(s) still could not be deleted (never re-sent; next tick tries again)`, e);
    });
  }
  const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
  for (const [teamMemberId, due] of byPerson) {
    if (await holdFor(teamMemberId, now)) continue;
    due.sort((a, b) => a.dm.heldAt.localeCompare(b.dm.heldAt));
    // CLAIM by compare-and-set on the exact stored value: the row whose value
    // this tick replaced is the row this tick owns.
    const mine: { key: string; raw: string; dm: HeldDm }[] = [];
    for (const r of due.slice(0, HELD_DM_BATCH)) {
      const claimed: HeldDm = { ...r.dm, claimedAt: now.toISOString() };
      const raw = JSON.stringify(claimed);
      const won = await prisma.appSetting
        .updateMany({ where: { key: r.key, value: r.raw }, data: { value: raw } })
        .catch(() => ({ count: 0 }));
      if (won.count === 1) mine.push({ key: r.key, raw, dm: claimed });
    }
    if (mine.length === 0) continue;
    // FINISHED MEANS FINISHED (Sep 26 2026 review). This used to be one
    // deleteMany with its failure swallowed — so a transient error right after
    // Slack accepted left the claimed rows in the store, the lease ran out 15
    // minutes later, and the next tick sent the same DM again. The code KNEW
    // the delete had failed and carried on. Now: the delete is tried twice;
    // if it still fails, each row is compare-and-set to a terminal settledAt
    // (on the exact value this tick claimed it with), which the loop above
    // only ever deletes. A duplicate is left only for a store that refuses
    // every write — the same thing as a worker killed between send and delete.
    const done = async () => {
      const keys = mine.map((r) => r.key);
      for (let i = 0; i < 2; i++) {
        if (await prisma.appSetting.deleteMany({ where: { key: { in: keys } } }).then(() => true, () => false)) return;
      }
      for (const r of mine) {
        const settled = JSON.stringify({ ...r.dm, settledAt: new Date().toISOString() } satisfies HeldDm);
        await prisma.appSetting
          .updateMany({ where: { key: r.key, value: r.raw }, data: { value: settled } })
          .catch((e) => console.warn("held Slack DM: could not delete or settle a finished row — it may be sent again", r.key, e));
      }
    };
    const log = (r: { dm: HeldDm }, status: DeliveryStatus, detail: string) =>
      logDelivery({ notificationId: r.dm.notificationId, teamMemberId, kind: r.dm.kind, channel: "slack", status, detail });
    const member = await prisma.teamMember
      .findUnique({ where: { id: teamMemberId }, select: { name: true, slackId: true, active: true } })
      .catch(() => null);
    if (!member?.active) {
      await done();
      for (const r of mine) await log(r, "skipped", "no longer on the active roster — held DM not sent");
      continue;
    }
    const slackId = member.slackId || mine[0].dm.slackId;
    const text =
      mine.length === 1
        ? mine[0].dm.text
        : [`🔕 Held during your quiet time — ${mine.length} notices, oldest first:`, ...mine.map((r) => r.dm.text)].join("\n\n");
    const dm = slackId ? await slackDmUserDetailed(slackId, text) : { ok: false as const, error: "no Slack ID on file" };
    if (dm.ok) {
      await done();
      res.sent++;
      for (const r of mine) await log(r, "sent", `held until ${r.dm.until}, sent when the hold ended`);
      continue;
    }
    res.failed++;
    const attempts = Math.max(...mine.map((r) => r.dm.attempts ?? 0)) + 1;
    if (attempts < HELD_DM_MAX_ATTEMPTS && slackId) {
      // Hand them back — claim released, attempt counted — for the next tick.
      for (const r of mine) {
        const back: HeldDm = { ...r.dm, attempts };
        delete back.claimedAt;
        await prisma.appSetting
          .updateMany({ where: { key: r.key, value: r.raw }, data: { value: JSON.stringify(back) } })
          .catch((e) => console.warn("could not hand a held Slack DM back after a refused release", r.key, e));
        await log(r, "failed", `${dm.error} — held DM will be retried (attempt ${attempts} of ${HELD_DM_MAX_ATTEMPTS})`);
      }
      continue;
    }
    await done();
    for (const r of mine) await log(r, "failed", `${dm.error} — gave up after ${attempts} attempt(s); relayed to the ops channel`);
    const { scrubMoney } = await import("@/lib/text");
    await relayUnreached(
      [{ teamMemberId, name: member.name, outcome: "failed" }],
      scrubMoney(mine.map((r) => r.dm.text).join(" · ")).slice(0, 2500),
      "reach",
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// KYLE'S TWO DIGESTS — the shared tail (Sep 26 2026; unified handoff items
// "digest reports sent on failure" and "inert alert switches").
//
// Both digests called slackDmUser, ignored its false, and returned
// { sent: true }: a refused DM kept the day's claim, so the list was lost AND
// recorded as sent, and no delivery row was ever written. The Settings switch
// "Kyle's Slack digests" was read by nothing. What they share now:
//   · digestGate — the switch, read before the day is claimed;
//   · kyleDigestRecipient — his roster row (id for the schedule and the log),
//     the long-standing literal Slack ID as the fallback;
//   · deliverDigestDm — his quiet time first (a held digest keeps its claim
//     and goes when the window ends), then the send, and on a refusal the
//     claim is RELEASED so the next 5-minute tick retries, a failed delivery
//     row is written with Slack's own words, and the answer is sent: false.
//
// NOT gated on the weekday, though the batch-0 design asked for it. Jordan's
// Sep 26 answer came after it: "no matter what is going on, James, Kyle, and
// myself should get a notification", with timing controlled per person in
// Settings. A weekend skip would stop Kyle's Saturday list with no switch that
// says so; his own quiet time on the schedule card is where that belongs.
// ---------------------------------------------------------------------------
export async function digestGate(): Promise<string | null> {
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  return rules.kyleDigests.enabled ? null : "switched off — Settings → Internal alerts → Kyle's Slack digests";
}

export async function kyleDigestRecipient(): Promise<{ teamMemberId: string | null; slackId: string }> {
  const kyle = await prisma.teamMember
    .findFirst({ where: { name: { contains: "Kyle", mode: "insensitive" }, active: true }, select: { id: true, slackId: true } })
    .catch(() => null);
  return { teamMemberId: kyle?.id ?? null, slackId: kyle?.slackId || (await kyleSlackId()) };
}

export async function deliverDigestDm(input: {
  teamMemberId: string | null;
  slackId: string;
  text: string;
  kind: string;
  /** the once-a-day AppSetting claim the caller already took */
  claimKey: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const { holdFor } = await import("@/lib/notifySchedule");
  const until = input.teamMemberId ? await holdFor(input.teamMemberId) : null;
  if (until && input.teamMemberId) {
    const kept = await holdStaffDm({ teamMemberId: input.teamMemberId, slackId: input.slackId, text: input.text, until, kind: input.kind, why: "their quiet time" });
    if (kept) return { sent: false, reason: `held until ${until.toISOString()} (quiet time) — it goes out then` };
  }
  const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
  const dm = await slackDmUserDetailed(input.slackId, input.text);
  if (dm.ok) {
    if (input.teamMemberId) await logDelivery({ teamMemberId: input.teamMemberId, kind: input.kind, channel: "slack", status: "sent" });
    return { sent: true };
  }
  // Release the day so the next tick tries again — the claim was taken before
  // Slack answered, and a refusal must not eat the day's list.
  await prisma.appSetting.deleteMany({ where: { key: input.claimKey } }).catch(() => {});
  if (input.teamMemberId) await logDelivery({ teamMemberId: input.teamMemberId, kind: input.kind, channel: "slack", status: "failed", detail: dm.error });
  return { sent: false, reason: `Slack refused the DM: ${dm.error}` };
}

// ---------------------------------------------------------------------------
// QUIET TIME FOR THE SENDERS THAT NEVER GO THROUGH THE BRIDGE (Sep 26 2026
// review). The 7 PM upload digest, the 10 PM chaser and its late split notice
// (uploadDigest.ts) text a photographer straight through OpenPhone, and the
// comms coaching note (commsCoaching.ts) DMs straight through Slack. None of
// them asked the schedule, so a Saturday job Jordan shot himself texted him at
// 7:00 PM — half an hour inside the window the Settings card tells him is
// quiet. These two are the whole change for them: ask holdFor, and when the
// person is quiet, KEEP the message on the channel it would have gone on —
//   · a text goes into the staff queue dated to the window's end. The flusher
//     asks the schedule again before it sends, batches it with anything else
//     that waited, and adds the hub prefix — which is also what tells the
//     OpenPhone receiver the text was ours, the job the upload texts' own comms
//     row does when they go straight out;
//   · a DM becomes a held row, released by the same flusher.
// Null back = not quiet, or nothing could keep it (no US number, our own line,
// no Slack ID): the caller sends now, exactly as before — notifySchedule rule
// 2, louder than asked beats silent. The caller keeps its own once-a-day claim
// either way, so a held message still goes once.
// ---------------------------------------------------------------------------
export async function holdStaffTextForQuietTime(teamMemberId: string, text: string, kind: string, at: Date = new Date()): Promise<Date | null> {
  const { holdFor } = await import("@/lib/notifySchedule");
  const until = await holdFor(teamMemberId, at);
  if (!until) return null;
  return (await queueStaffSms(teamMemberId, text, { kind }, until)) ? until : null;
}

export async function holdStaffDmForQuietTime(d: {
  teamMemberId: string;
  slackId: string | null;
  text: string;
  kind: string;
  notificationId?: string | null;
  at?: Date;
}): Promise<Date | null> {
  const { holdFor } = await import("@/lib/notifySchedule");
  const until = await holdFor(d.teamMemberId, d.at ?? new Date());
  if (!until || !d.slackId) return null;
  const kept = await holdStaffDm({ teamMemberId: d.teamMemberId, slackId: d.slackId, text: d.text, until, kind: d.kind, notificationId: d.notificationId ?? null, why: "their quiet time" });
  return kept ? until : null;
}

// What actually happened when we tried to reach an editor — callers use this
// to log the truth ("texted" vs "relayed to ops") instead of assuming Slack.
// Since Sep 15 the bridge answers "slack" | "sms" | "bell" (the matrix
// decides; a Manila editor with a login and no switches on hears the bell).
export type EditorChannel = "slack" | "sms" | "relay" | "quiet" | "none" | "bell";

export async function notifyInApp(n: {
  kind: string;
  title: string;
  body?: string;
  href: string; // default deep link; a target's href wins for its row
  targets: NotifyTarget[]; // ONE Notification row per target
  dedupeKey?: string; // suffixed "-0","-1",… per target index so multi-target events insert every row
}, opts: {
  /** Oct 5 2026: write the bell rows NOW and hand back their channel legs
   *  (Slack / text) as `bridgeRest`, for the caller to run in after(). A
   *  verdict answers on the click, and the row — the durable part, the thing
   *  a person can still open if the background dies — must not wait on a
   *  Slack round trip, nor be lost with the background. `bridged` is empty
   *  for rows handed back this way. */
  bridgeLater?: boolean;
} = {}): Promise<{ bridged: Array<{ userKey: string; channel: EditorChannel }>; silenced: number; bridgeRest?: () => Promise<void> }> {
  const bridged: Array<{ userKey: string; channel: EditorChannel }> = [];
  const later: Array<() => Promise<void>> = [];
  let silenced = 0;
  // TeamMember id → what went out for them in THIS call. An editor is
  // addressed through both a tm: row and an editor: row, and both resolve to
  // the same person; they get one DM and one text, not two — the second row
  // reads what the first already did.
  const delivered = new Map<string, Delivery>();
  try {
    const title = n.title.slice(0, 90);
    const rule: BellRule = BELL_RULES[n.kind] ?? "all";
    for (let i = 0; i < n.targets.length; i++) {
      const t = n.targets[i];
      // Bell policy (BELL_RULES above) — silence the ROW, never the emitter:
      // the caller's Slack ping, task and timeline row all still happen. `i`
      // keeps counting through a skip, so the dedupeKey suffixes stay
      // positional ("-0","-1",…) and the two callers that probe a concrete key
      // (commsSla.alreadySent, deliveryWatch) still match the row they wrote.
      if (rule === "off" || (rule === "person" && !t.userKey)) {
        silenced++;
        continue;
      }
      let roles = t.roles;
      let body = n.body ? n.body.slice(0, 140) : null;
      const href = t.href ?? n.href;
      // Money clamp — the SINGLE enforcement point (not 16 call sites): creatives
      // never see money. Any row that can reach an editor/photographer loses its
      // body; a money destination collapses the row to owner-only.
      //
      // ONE EXCEPTION, and it is the point of the row: a TAG. Jordan, Sep 17:
      // "I want to be able to tag james on the video - he gets a text with my
      // message." A tag whose body is dropped arrives as "Jordan tagged you"
      // and nothing else, which is a notification about a notification — the
      // person still has to open a screen to learn what was wanted. So a
      // mention keeps its text, run through the same money scrubber the task
      // and comms surfaces use, rather than being thrown away wholesale. The
      // destination rule below is untouched: a tag pointing at a money screen
      // still collapses to the owner.
      if (roles.includes("EDITOR") || roles.includes("PHOTOGRAPHER")) {
        body = n.kind === "mention" && body ? scrubMoney(body) : null;
        if (href.startsWith("/billing") || href.startsWith("/payouts") || n.kind === "order_paid") {
          roles = ["OWNER"];
          console.warn("notifyInApp money clamp", n.kind);
        }
      }
      // Who this row is addressed to, resolved BEFORE the insert (Sep 20) so
      // the dedupe branch below can reach the same person the bridge would
      // have. Nothing about the values changed — they were computed eight
      // lines lower until the retry landed.
      const tmId = t.userKey?.startsWith("tm:") ? t.userKey.slice(3) : null;
      const editorKey = t.userKey?.startsWith("editor:") ? t.userKey.slice(7) : null;
      const rowKey = n.dedupeKey ? `${n.dedupeKey}-${i}` : null;
      try {
        const row = await prisma.notification.create({
          data: {
            kind: n.kind,
            title,
            body,
            href,
            audience: JSON.stringify(roles),
            userKey: t.userKey ?? null,
            dedupeKey: rowKey,
          },
          select: { id: true },
        });
        // Row is NEW (a dedupe hit throws P2002 and takes the retry branch in
        // the catch below) — the bridge fires once per row.
        const rowRoles = roles;
        const bridgeRow = async () => {
          if (tmId || editorKey) {
            // A person: their matrix row for this event decides Slack / text /
            // both / neither (see the bridge header above and bridgePerson).
            const out = await bridgePerson(n.kind, t, { tmId, editorKey, title, href, notificationId: row.id }, delivered);
            if (editorKey && rowRoles.includes("EDITOR") && !opts.bridgeLater) {
              // A held ping is "quiet", never "slack": the emitters turn this
              // word into "pinged by Slack DM" on the job's timeline and the
              // brand panel, and a DM waiting in its row has pinged nobody yet.
              bridged.push({ userKey: t.userKey!, channel: out.held ? "quiet" : out.slack ? "slack" : out.sms ? "sms" : "bell" });
            }
          } else if ((rowRoles.includes("OWNER") || rowRoles.includes("ADMIN")) && t.ownerSms) {
            // A broadcast is bell-only — except the Review Room's OWNER+ADMIN
            // "cut ready" row, which carries a sentence for the owner (Sep 11)
            // and, since Sep 16, the office (bridgeBroadcast). `ownerActed` says
            // the owner filed this one himself: the office leg still goes, his
            // own is dropped inside the bridge (Sep 21 — see NotifyTarget).
            await bridgeBroadcast(
              n.kind,
              t.ownerSms,
              { roles: rowRoles, notificationId: row.id, ownerActed: t.ownerActed === true },
              delivered,
            );
          }
          // A NEW editor-addressed bell row with no login to see it → nudge Jordan
          // once (deduped inside) to send that editor their Hub invite.
          if (editorKey) {
            try {
              const { ensureEditorLoginNudge } = await import("@/lib/tasks");
              await ensureEditorLoginNudge(editorKey);
            } catch { /* the nudge must never break the bell */ }
          }
        };
        if (opts.bridgeLater) later.push(bridgeRow);
        else await bridgeRow();
      } catch (e) {
        // Unique violation on dedupeKey = this event was already announced.
        // Anything else is logged but still swallowed.
        if ((e as { code?: string } | null)?.code !== "P2002") {
          console.warn("notifyInApp failed", n.kind, e);
          continue;
        }
        // A RE-ANNOUNCEMENT IS A RETRY, NOT A NO-OP (Sep 20, journey 5).
        //
        // Until today this branch returned here, and bridgePerson sat inside
        // the try above, so the channel leg was never attempted again. Driven
        // in the drill: Slack ratelimits Kim Miguel's DM, one "slack/failed"
        // row is written, the ops relay fails too (relayUnreached is Slack as
        // well — it says so itself), and then NOTHING picks it up. No sweep
        // reads a failed delivery row: NotificationDelivery.status="failed" is
        // read by notifyPrefs.lastReachedByMember for the Settings "Last
        // reached" line and by nothing else. Re-announcing the same event gave
        // 0 further DM attempts; the only way to get the DM out was a NEW key,
        // which left TWO bell rows for one tag. No duplicates or a retry,
        // never both. Kim is the person this strands — mention.sms off and a
        // +63 number staffTextNumber refuses, so Slack is her only channel.
        //
        // So: find the row the collision names and re-drive the SAME row's
        // bridge. One bell row per event is untouched (nothing is inserted
        // here), and bridgePerson's own retry gate refuses to re-send anything
        // that already reached a channel — see MAX_BRIDGE_ATTEMPTS. A
        // BROADCAST row is deliberately not retried: its ownerSms fan-out is a
        // per-person loop of its own and the defect proved was the person leg.
        if (!rowKey || !(tmId || editorKey)) continue;
        try {
          const existing = await prisma.notification.findUnique({ where: { dedupeKey: rowKey }, select: { id: true, createdAt: true, userKey: true } });
          if (!existing) continue; // the collision was on some other constraint
          // THE KEY NAMES AN INDEX, NOT A PERSON (Sep 20 review). rowKey is
          // `<dedupeKey>-<i>`, the position in the target array — so if a
          // target list's composition changes between two announcements under
          // one base key (review/actions.ts builds [broadcast, editor IF
          // in-house, shooter IF resolvable], and the shooter's index moves
          // when the editor row is absent), this collision can be somebody
          // ELSE's row. Sending on the strength of a positional key would DM
          // person B and write B's legs against A's notification. Nothing
          // reaches that today — no delivery leg in production names a person
          // other than its notification's own userKey — and the retry is the
          // first code in this file that would send on it, so it checks.
          if (existing.userKey !== (t.userKey ?? null)) continue;
          // A ROW THIS YOUNG MAY STILL BE IN FLIGHT (Sep 20 review, the one
          // window the retry itself opened). The first pass commits the bell
          // row and THEN awaits Slack, so for as long as that call is running
          // there are no channel legs on the log yet. A second announcement
          // arriving inside that window would read an empty log, count zero
          // attempts and DM the same person a second time — the very
          // duplicate the old early-return used to make impossible, and there
          // is nothing else serialising two announcements of one event (an
          // advisory lock would have to be held across the Slack and
          // OpenPhone calls, which is not a transaction this code may take
          // out on a pooled Neon connection).
          //
          // So the retry refuses a row that has not had time to finish. The
          // number is measured, not guessed: across every delivery leg in
          // production the gap from the bell row's insert to its channel leg
          // is 0.02s median and 2.16s at the worst (the long sms/sent rows are
          // the flusher cron, a different process), so a minute is nearly
          // thirty times the slowest pass on record. Nothing legitimate is
          // lost: a re-announcement inside a minute is a double fire, not an
          // outage recovery, and before this wave NO re-announcement retried
          // at all.
          if (Date.now() - existing.createdAt.getTime() < BRIDGE_IN_FLIGHT_MS) continue;
          await bridgePerson(n.kind, t, { tmId, editorKey, title, href, notificationId: existing.id, retry: true }, delivered);
          // `bridged` is deliberately NOT appended to on a retry: the emitters
          // that read it write their own "texted / relayed" line, and this
          // announcement's line was already written the first time round.
        } catch (retryErr) {
          console.warn("notifyInApp bridge retry failed (bell row kept)", n.kind, retryErr);
        }
      }
    }
  } catch (e) {
    console.warn("notifyInApp failed", n.kind, e);
  }
  if (!opts.bridgeLater) return { bridged, silenced };
  return {
    bridged,
    silenced,
    bridgeRest: async () => {
      for (const run of later) {
        try {
          await run();
        } catch (e) {
          console.warn("notifyInApp channel legs failed (bell row kept)", n.kind, e);
        }
      }
    },
  };
}

// What went out for one person in one notifyInApp call (the `delivered` map).
// `held` (Sep 26 2026 review): everything that reached them was KEPT for later
// — a DM held through their quiet time, a text dated to its end — and nothing
// went now. slack/sms stay true for the relay (kept is reached, never
// unreached); `held` is what stops a caller from writing "pinged by Slack DM"
// on a timeline while the DM is still waiting in its row.
type Delivery = { slack: boolean; sms: boolean; held?: boolean };

/** How many times ONE person's channel legs may be driven for ONE bell row —
 *  the first announcement plus two re-announcements (Sep 20, journey 5).
 *
 *  The cap is read off the delivery log itself rather than a new column: every
 *  pass through the bridge writes exactly one row per channel it was asked for
 *  (sent / queued / failed / skipped), so the number of rows on the busiest
 *  channel IS the attempt count. A permanently broken Slack ID — a revoked
 *  account, an editor who left — therefore costs three DM attempts and then
 *  stops for good, however many times the emitter re-announces. Three because
 *  a Slack ratelimit clears in seconds and an outage in minutes, and the
 *  emitters that re-announce do so on a 5-minute cron at worst. */
const MAX_BRIDGE_ATTEMPTS = 3;

/** How long one bridge pass is allowed to still be running before a
 *  re-announcement of the same event is willing to treat it as finished
 *  (Sep 20 review). See the long note at the retry branch in notifyInApp:
 *  measured worst pass in production is 2.16s, so this is deliberately an
 *  order of magnitude clear of it. Err toward silence — a staff alert that
 *  arrives once late beats one that arrives twice. */
const BRIDGE_IN_FLIGHT_MS = 60_000;

// The events whose rows ALWAYS carry the emitter's sentence unless the row
// is a self-tag (mentions.ts, messageActions.ts leave slackDm off exactly
// then). No sentence on one of these = nothing but the bell — never a
// generic "title + link" DM about something the person just wrote themselves.
const SENTENCE_EVENTS = new Set<string>(["mention", "project_message"]);

// The person leg of a NEW bell row (see the call in notifyInApp). Resolves
// the person (tm:<id> directly; editor:<key> through the roster), reads their
// matrix row for the event (notifyPrefs.ts) and delivers on what it says:
//   · Slack — the sentence (or title + link) to their Slack ID; no ID on file
//     and Slack wanted → the weekly People nudge instead;
//   · text — the sentence's plain-text form (or "title → link") through the
//     staff queue, at any hour (their own quiet time aside).
// Since Sep 20 (audit F07) it also asks whether anything actually got through
// (if not, relayUnreached names the person on the ops channel instead of
// leaving the alert in a bell). The F07 weekend hold that came with it — a
// ROUTINE kind on a Saturday or Sunday dated to Monday morning — was removed
// on Oct 6 2026 (Jordan: "Anyone on the team can get pinged anytime."); the
// person's own quiet time is the only thing that holds either leg now.
// Since Sep 20 (journey 5) it can also be called a SECOND time for a bell row
// that already exists — `ctx.retry`, from notifyInApp's dedupeKey collision.
// That pass re-drives only the channels that reached nobody, at most
// MAX_BRIDGE_ATTEMPTS times, and adds no bell row of its own.
// Returns what went out for this person — on THIS row or an earlier one in
// the same call. A refused DM counts as not sent. Best-effort by contract:
// the note or message that carried the ping is already saved, so nothing
// here may throw past the bell. Every outcome lands in the delivery log
// (Sep 16): the bell row itself, a DM sent or failed with Slack's words, a
// text queued/skipped (queueStaffSms), and "skipped: no Slack ID on file"
// when the switch is on but the card has no ID.
async function bridgePerson(
  kind: string,
  t: NotifyTarget,
  ctx: {
    tmId: string | null;
    editorKey: string | null;
    title: string;
    href: string;
    notificationId: string;
    /** This bell row already exists and we are re-driving its channels after a
     *  dedupeKey collision (Sep 20, journey 5). Changes three things and
     *  nothing else: the delivery log is read first and the pass is abandoned
     *  if any channel already reached this person or the attempt cap is spent,
     *  and the bell leg is not logged again (the row and its "bell/sent" line
     *  were written on the first pass). */
    retry?: boolean;
  },
  delivered: Map<string, Delivery>,
): Promise<Delivery> {
  const none: Delivery = { slack: false, sms: false };
  try {
    const { eventForKind, notifyPrefsFor } = await import("@/lib/notifyPrefs");
    let personId = ctx.tmId;
    if (!personId && ctx.editorKey) {
      const { editorTeamMemberId } = await import("@/lib/editors");
      personId = await editorTeamMemberId(ctx.editorKey);
    }
    if (!personId) return none; // a vendor key (luma/external_agency) has no person
    const prior = delivered.get(personId);
    if (prior) return prior; // one delivery per person per event
    const state: Delivery = { slack: false, sms: false };
    delivered.set(personId, state);
    const member = await prisma.teamMember.findUnique({
      where: { id: personId },
      select: { name: true, slackId: true, phone: true, active: true },
    });
    if (!member?.active) return state;
    // IS THERE ANYTHING LEFT TO RETRY (Sep 20, journey 5)? Only on the retry
    // pass, and it is the whole safety of the retry:
    //   · a leg already "sent" or "queued" means this person WAS reached on
    //     this event, so re-driving would be a duplicate DM or a second text.
    //     A queued text counts — the line is in PendingSms with the flusher
    //     behind it, and queueStaffSms would happily queue a second copy;
    //   · otherwise every existing row is "failed" or "skipped", i.e. nobody
    //     got it, and the busiest channel's row count is the attempt number.
    // "skipped: no Slack ID on file" is a configuration gap the weekly People
    // nudge owns, and it burns attempts exactly like a failure does, so a new
    // hire cannot be re-bridged forever either.
    if (ctx.retry) {
      const legs = await prisma.notificationDelivery.findMany({
        where: { notificationId: ctx.notificationId, teamMemberId: personId, channel: { in: ["slack", "sms"] } },
        select: { channel: true, status: true },
      });
      if (legs.some((l) => l.status === "sent" || l.status === "queued")) return state;
      // A HELD DM IS ITS OWN RECORD (Sep 26 2026 review) — the same "ask the
      // queue, not the log" rule the text leg below follows. holdStaffDm writes
      // the held row FIRST and its slack/queued line SECOND, and that line is
      // best-effort; lose it and this gate reads "nobody reached", so a
      // re-announcement inside their quiet time would hold a second copy and
      // the release would put the same notice in their DM twice.
      if (await heldDmWaiting(personId, ctx.notificationId)) {
        state.slack = true;
        state.held = true;
        return state;
      }
      const attempts = Math.max(
        legs.filter((l) => l.channel === "slack").length,
        legs.filter((l) => l.channel === "sms").length,
      );
      if (attempts >= MAX_BRIDGE_ATTEMPTS) return state;
    }
    // The bell row is a delivery too — logged before any channel question, so
    // "bell only" is visible as such and not as silence. It sits BELOW the
    // per-person dedupe and the active check (review, Sep 16): an editor
    // addressed twice on one event (tm: and editor:) used to log two bell
    // rows, and a deactivated member logged one for a bell nobody reads.
    // A retry does not log it again: the same bell row is being re-bridged,
    // not rung a second time, and "Last reached" would otherwise read a bell
    // as the newest thing that happened to a DM that just landed.
    if (!ctx.retry) {
      await logDelivery({ notificationId: ctx.notificationId, teamMemberId: personId, kind, channel: "bell", status: "sent" });
    }
    const event = eventForKind(kind);
    if (!event) return state; // an unclassified kind is bell-only
    if (SENTENCE_EVENTS.has(event) && !t.slackDm) return state; // a self-tag
    const want = (await notifyPrefsFor(personId))[event];
    if (!want.slack && !want.sms) return state;
    const link = `${appBase()}${ctx.href}`;
    const meta = { kind, notificationId: ctx.notificationId };
    // WHEN (Sep 26 2026, the notification schedule; Oct 6 2026, Jordan's
    // "anyone on the team can get pinged anytime"). The person's own quiet
    // time — saved on the card, or Jordan's Saturday preset — and nothing else:
    // no night, no weekend, no office rota. Inside it BOTH legs wait for its
    // end (the text dated in the queue, the DM held in its own row); outside
    // it nothing is held and the two legs are independent.
    const { holdFor } = await import("@/lib/notifySchedule");
    const quiet = await holdFor(personId);
    if (want.sms) {
      const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
      const isOwner = (await ownerTeamMemberIds()).includes(personId);
      // The sentence, as text. ownerSms is read only for the owner: on a
      // non-owner it was built unscrubbed (it never used to reach anyone
      // else) — slackDm is the money-safe one for everybody.
      const line = t.slackDm ? smsLineFromSlackDm(t.slackDm) : isOwner && t.ownerSms ? t.ownerSms : `${ctx.title} → ${link}`;
      // ASK THE QUEUE, NOT THE LOG, BEFORE A RETRY TEXTS (Sep 20 review).
      // The gate above reads NotificationDelivery, and that log is best-effort
      // by its own contract: logDelivery "never throws; a failure is a console
      // line", and queueStaffSms writes the PendingSms row FIRST and logs the
      // queued leg SECOND. Lose that one write — or die between the two — and
      // the line really is in the queue with the flusher behind it while the
      // log says nobody was reached, so the retry would queue a second copy of
      // the same text. That is not hypothetical bookkeeping: 99 of the 126
      // PendingSms rows in production have no queued leg at all (every row
      // before the log landed on Sep 16). PendingSms is the durable record of
      // the send; the delivery log is the story about it, and only the record
      // may stop a text.
      //
      // Scoped to lines that have NOT gone out yet, on purpose: an unsent line
      // WILL reach them, so a second copy is pure duplication whatever wrote
      // it, whereas matching an already-sent line would suppress a real text —
      // production has two cases of one person legitimately getting the same
      // sentence twice, 47 minutes and 3.5 days apart.
      let queuedAlready = false;
      if (ctx.retry) {
        queuedAlready = !!(await prisma.pendingSms.findFirst({
          where: { teamMemberId: personId, line, sentAt: null, skippedAt: null },
          select: { id: true },
        }));
      }
      if (queuedAlready) {
        // Reached, as far as this event is concerned: the sentence is queued,
        // so the relay below must not call them unreached and the DM must not
        // buzz a phone the text is already going to.
        state.sms = true;
        await logDelivery({ ...meta, teamMemberId: personId, channel: "sms", status: "skipped", detail: "the same line is already queued and unsent — not queuing a second copy" });
      } else {
        // Dated only by their own quiet time (Oct 6 2026: no texting window,
        // no weekend rota) — null queues it for the next flush, at any hour.
        state.sms = await queueStaffSms(personId, line, meta, quiet);
      }
    }
    // Was the text KEPT for later (dated to the end of their quiet time)
    // rather than queued for the next flush? `held` at the bottom is decided
    // from this and the DM's own answer.
    const smsKept = state.sms && !!quiet;
    // Did the Slack leg ever actually get tried? A person who wants Slack and
    // has no ID on file is a CONFIGURATION gap, and the codebase already
    // handles it weekly (nudgeMissingSlackId, throttled, on the People page).
    // The relay at the bottom must not also fire on it — one new hire would
    // otherwise produce an unthrottled ops line per notification on top of
    // that nudge, for a week, saying nothing the nudge does not (review,
    // Sep 20).
    let slackIdMissing = false;
    let dmSentNow = false;
    let dmKept = false;
    if (want.slack) {
      const { escapeSlack } = await import("@/lib/text");
      const dmText = t.slackDm ?? `${escapeSlack(ctx.title)}\n${link}`;
      // Their quiet time: the DM itself waits, on Slack, for the window's end
      // (holdStaffDm) — never turned into a text they did not ask for. Only if
      // that row cannot be written does it fall back to the rules below.
      //
      // NOT THEIR NIGHT (Oct 6 2026). For one day (Oct 5) a Manila editor's DM
      // with no saved schedule waited for 7 AM their time. Jordan: "Editors can
      // get night time pings. Anyone on the team can get pinged anytime." Their
      // own saved schedule (`quiet`) is the only thing that holds it now.
      const heldDm = !!quiet && !!member.slackId &&
        (await holdStaffDm({ teamMemberId: personId, slackId: member.slackId, text: dmText, until: quiet, kind, notificationId: ctx.notificationId, why: "their quiet time" }));
      if (heldDm) {
        state.slack = true; // kept and dated — reached, as far as the relay is concerned
        dmKept = true;
      } else if (quiet && state.sms) {
        // Inside their OWN quiet time and the DM row could not be written: the
        // same sentence is in the digest queue dated to the window's end and
        // the bell row is already there, so a DM now would buzz the phone the
        // person asked to keep quiet. Only their own quiet time reaches here
        // (Oct 6 2026: the weekend rota that also skipped the DM is gone).
        await logDelivery({ ...meta, teamMemberId: personId, channel: "slack", status: "skipped", detail: `their quiet time — held as a text until ${quiet.toISOString()}` });
      } else if (member.slackId) {
        const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
        const dm = await slackDmUserDetailed(member.slackId, dmText);
        state.slack = dm.ok;
        dmSentNow = dm.ok;
        if (dm.ok) await logDelivery({ ...meta, teamMemberId: personId, channel: "slack", status: "sent" });
        else {
          console.warn("slack DM failed (bell row kept)", kind, member.name, dm.error);
          await logDelivery({ ...meta, teamMemberId: personId, channel: "slack", status: "failed", detail: dm.error });
        }
      } else {
        slackIdMissing = true;
        await logDelivery({ ...meta, teamMemberId: personId, channel: "slack", status: "skipped", detail: "no Slack ID on file" });
        await nudgeMissingSlackId(personId, member.name);
      }
    }
    // NOBODY WAS REACHED (Sep 20, audit F07). notifyStaffSms has always ended
    // in relayUnreached — anyone it could not reach is named on the ops channel
    // with the alert itself — and this bridge, which carries roughly a hundred
    // times that traffic, had no equivalent at all: a DM that failed to somebody
    // with their text switch off wrote one "failed" row and the function moved
    // on. Kim Miguel is exactly that person (Slack-only; her +63 number is
    // untextable by policy and her matrix has job_ping sms off), so a Slack
    // outage during a revision push would have left those asks in a bell and
    // nowhere else. Same helper, same policy, one place. A HELD line is not
    // unreached — it is dated, and state.sms says so.
    //
    // Only when a channel was genuinely ATTEMPTED and came back with nothing:
    // a missing Slack ID belongs to the weekly nudge above, not to an ops line
    // per event. And money is scrubbed on the way out even though no
    // person-addressed title carries any today — the same guard, for the same
    // reason, as the sentence bridgeBroadcast relays fifty lines below: the ops
    // channel is not the owner's DM.
    const slackTried = want.slack && !slackIdMissing;
    if (!state.slack && !state.sms && (slackTried || want.sms)) {
      const { scrubMoney } = await import("@/lib/text");
      await relayUnreached(
        [{ teamMemberId: personId, name: member.name, outcome: "failed" }],
        scrubMoney(`${ctx.title} → ${link}`),
        "reach",
      );
    }
    // Held = something was kept for later and nothing went now. A text queued
    // WITHOUT a date (the ordinary digest queue) counts as going now, exactly
    // as it always has; a DM that went out is going now whatever the text did.
    state.held = (dmKept || smsKept) && !dmSentNow && !(state.sms && !smsKept);
    return state;
  } catch (e) {
    console.warn("notify bridge failed (bell row kept)", kind, e);
    return none;
  }
}

// The Review Room's OWNER+ADMIN broadcast ("cut ready to review") is the one
// role row that reaches a phone or a DM. Sep 11 (Jordan: "make sure I get a
// text when a video is in review") texted him off his sms-prefs switch;
// since Sep 15 the same sentence goes out on whichever channels a person's
// "video in review" row on /settings → Team notifications says. Until Sep 16
// only the OWNER logins' roster rows were iterated, so Kyle's switch on the
// card could never fire (Kyle call, item 4). Now: every active roster row
// whose login role the broadcast addresses — the owner rows for OWNER, the
// office rows (smsPrefs.ts officeTeamMemberIds) for ADMIN — each once per
// event, each by their own row: the owner texts by default, Kyle's default
// stays off and his switch works when he flips it. The bell row is logged
// per addressed person, then the DM (Slack's words on failure) and the text
// (queueStaffSms, which refuses the company line and logs why). A row with no
// sentence at all never gets here — bell-only for everyone.
//
// `ctx.ownerActed` (Sep 21 2026) is the owner's own upload, and it now takes
// out HIS legs rather than the whole broadcast. Until today the Review Room
// said "he did it himself" by omitting the sentence, which is the same field
// this bridge is guarded on, so the office fell silent with him: Kyle got a
// bell row and nothing else on 3 of the last 41 cuts. Everyone else on the
// row is reached exactly as always.
async function bridgeBroadcast(
  kind: string,
  sentence: string,
  ctx: { roles: Role[]; notificationId: string; ownerActed?: boolean },
  delivered: Map<string, Delivery>,
): Promise<void> {
  try {
    const { eventForKind, notifyPrefsFor } = await import("@/lib/notifyPrefs");
    if (eventForKind(kind) !== "review_ready") return;
    const { ownerTeamMemberIds, officeTeamMemberIds } = await import("@/lib/smsPrefs");
    const { escapeSlack, scrubMoney } = await import("@/lib/text");
    const owners = new Set(await ownerTeamMemberIds());
    const ids = new Set<string>();
    if (ctx.roles.includes("OWNER")) for (const id of owners) ids.add(id);
    if (ctx.roles.includes("ADMIN")) for (const id of await officeTeamMemberIds()) ids.add(id);
    const meta = { kind, notificationId: ctx.notificationId };
    // WHEN: each person's own quiet time and nothing else (Oct 6 2026 — the
    // Sep 20 weekend rota answer for this broadcast is gone with Jordan's
    // "anyone on the team can get pinged anytime"). See bridgePerson.
    const { holdFor } = await import("@/lib/notifySchedule");
    for (const id of ids) {
      if (delivered.has(id)) continue;
      const state: Delivery = { slack: false, sms: false };
      delivered.set(id, state);
      const quiet = await holdFor(id);
      const member = await prisma.teamMember.findUnique({ where: { id }, select: { name: true, slackId: true, active: true } });
      if (!member?.active) continue;
      await logDelivery({ ...meta, teamMemberId: id, channel: "bell", status: "sent" });
      const want = (await notifyPrefsFor(id)).review_ready;
      // HIS OWN UPLOAD (Sep 11 carve-out, now per person — Sep 21). Both
      // channels, not just the text: a DM saying a video is waiting on him is
      // as wrong as a buzz when he is the one who just filed it. He keeps the
      // bell row, and `delivered` holds his name so no later target on the
      // same event reaches him by another leg. The skip is written to the
      // delivery log so a quiet phone here reads as this rule firing rather
      // than as a bridge that broke.
      if (ctx.ownerActed && owners.has(id)) {
        const detail = "the owner filed this cut himself — his own legs suppressed";
        if (want.slack) await logDelivery({ ...meta, teamMemberId: id, channel: "slack", status: "skipped", detail });
        if (want.sms) await logDelivery({ ...meta, teamMemberId: id, channel: "sms", status: "skipped", detail });
        continue;
      }
      if (!want.slack && !want.sms) continue;
      // ownerSms was written for the owner's eyes; since Sep 16 this bridge
      // also hands it to the office, so a non-owner reads it scrubbed (review,
      // Sep 16 — the Room's sentence carries no money today, but the guard the
      // contract on NotifyTarget.ownerSms promises must still be here).
      const line = owners.has(id) ? sentence : scrubMoney(sentence);
      // Text first: inside their own quiet time the DM below reads whether
      // the queue kept the line (see bridgePerson).
      if (want.sms) state.sms = await queueStaffSms(id, line, meta, quiet);
      // A missing Slack ID is the weekly People nudge's business, not the
      // relay's — see the same flag in bridgePerson (review, Sep 20).
      let slackIdMissing = false;
      if (want.slack) {
        // Their quiet time: the DM waits on Slack for the window's end.
        const heldDm = !!quiet && !!member.slackId &&
          (await holdStaffDm({ teamMemberId: id, slackId: member.slackId, text: escapeSlack(line), until: quiet, kind, notificationId: ctx.notificationId, why: "their quiet time" }));
        if (heldDm) {
          state.slack = true;
        } else if (quiet && state.sms) {
          await logDelivery({ ...meta, teamMemberId: id, channel: "slack", status: "skipped", detail: `their quiet time — held as a text until ${quiet.toISOString()}` });
        } else if (member.slackId) {
          const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
          const dm = await slackDmUserDetailed(member.slackId, escapeSlack(line));
          state.slack = dm.ok;
          if (dm.ok) await logDelivery({ ...meta, teamMemberId: id, channel: "slack", status: "sent" });
          else {
            console.warn("slack DM failed (bell row kept)", kind, member.name, dm.error);
            await logDelivery({ ...meta, teamMemberId: id, channel: "slack", status: "failed", detail: dm.error });
          }
        } else {
          slackIdMissing = true;
          await logDelivery({ ...meta, teamMemberId: id, channel: "slack", status: "skipped", detail: "no Slack ID on file" });
          await nudgeMissingSlackId(id, member.name);
        }
      }
      // Nobody reached, same relay as bridgePerson and notifyStaffSms (Sep 20).
      // Money-scrubbed regardless of who this row was for: the ops channel is
      // not the owner's DM.
      if (!state.slack && !state.sms && ((want.slack && !slackIdMissing) || want.sms)) {
        await relayUnreached([{ teamMemberId: id, name: member.name, outcome: "failed" }], scrubMoney(line), "reach");
      }
    }
  } catch (e) {
    console.warn("broadcast bridge failed (bell row kept)", kind, e);
  }
}

// The plain-text form of a Slack DM sentence, for a phone: the head, the
// quoted summary in quotes, the link — one line, Slack's escapes undone and
// its "> " quote prefix dropped. Money was already scrubbed for a non-owner
// when the sentence was built (mentions.ts slackMentionDm).
function smsLineFromSlackDm(dm: string): string {
  const un = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const lines = dm.split("\n").map((l) => l.trim()).filter(Boolean);
  const head = un(lines[0] ?? "");
  const quote = lines.slice(1).filter((l) => l.startsWith(">")).map((l) => un(l.replace(/^>\s?/, ""))).join(" ");
  const rest = lines.slice(1).filter((l) => !l.startsWith(">")).map(un).join(" ");
  return [quote ? `${head}: “${quote}”` : head, rest].filter(Boolean).join(" ");
}

// The office hears ONCE a week per person that a mention had nowhere to go on
// Slack — a bell row to OWNER/ADMIN linking to People, where the ID is typed.
// The first name stands in for a pronoun: the roster carries none.
async function nudgeMissingSlackId(tmId: string, name: string): Promise<void> {
  const first = name.split(/\s+/)[0] || name;
  await notifyInApp({
    kind: "slack_id_missing",
    title: `${first} has no Slack ID on file — add it on People so mentions reach ${first} on Slack`,
    body: `${name} was mentioned in the hub but has no Slack member ID, so no Slack DM went out (the bell row and any text fallback still did). People → ${first} → Slack member ID.`,
    href: "/users?tab=team",
    targets: [{ roles: ["OWNER", "ADMIN"] }],
    dedupeKey: `slack-id-missing-${tmId}-${isoWeekKey(new Date())}`,
  });
}

// "2026-W38" — ISO-8601 week (Monday start), in UTC. Only ever a dedupe bucket.
function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Ping the team about a just-created task that shouldn't wait for a hub visit
// (URGENT priority, a new lead, a revision request). Task titles are already
// self-describing ("Revision — 123 Main St", "New lead: …"), so the message is
// the title + a deep link into the queue.
export async function notifyUrgent(taskTitle: string, path: string = "/queue"): Promise<void> {
  await opsAlert(`🔔 ${taskTitle} → ${appBase()}${path}`);
}

// ---------------------------------------------------------------------------
// KYLE, BY NAME (Oct 5 2026, team notifications pass). Several things only the
// office can do arrived as an ADMIN-role bell and nothing else: a job handed
// to Luma Visuals (Kyle sends them the packet — the agency has no login), a
// job ready for editing with nobody routed to edit it, a new program task on
// his list. A role bell is a row Kyle may not open for a day. These go to HIM:
// notifyStaffSms — Slack first (his roster phone is the company line, so
// Slack is his only channel), at any hour (Oct 6 2026: the overnight hold
// these pings had for one day is gone — "anyone on the team can get pinged
// anytime"), held only by a quiet time saved for him, a delivery row per
// leg, and the ops relay if nothing could reach him. Exactly one active
// roster row named Kyle, as the delivery-ready alerts require; otherwise the
// line goes to the ops channel rather than to a guess.
// `exceptTeamMemberId`: the person who just did the thing — Kyle is not told
// about his own click.
// ---------------------------------------------------------------------------
export async function pingKyle(
  text: string,
  kind: string,
  opts: { exceptTeamMemberId?: string | null } = {},
): Promise<StaffSmsResult[] | "self" | "ops"> {
  try {
    const kyles = await prisma.teamMember.findMany({
      where: { active: true, name: { contains: "Kyle", mode: "insensitive" } },
      select: { id: true },
      take: 2,
    });
    if (kyles.length !== 1) {
      await opsAlert(text);
      return "ops";
    }
    if (opts.exceptTeamMemberId && opts.exceptTeamMemberId === kyles[0].id) return "self";
    return await notifyStaffSms([kyles[0].id], text, kind);
  } catch (e) {
    console.warn("pingKyle failed", kind, e);
    return [];
  }
}

/** Run follow-on notice work after the response when there is a request to
 *  run after (a server action stays instant), inline otherwise — a cron, a
 *  drill. The greetNewClient pattern (newClients.ts), shared. Never throws. */
export async function inBackground(work: () => Promise<unknown>): Promise<void> {
  const safe = async () => {
    try {
      await work();
    } catch (e) {
      console.warn("background notice failed", e);
    }
  };
  try {
    const { after } = await import("next/server");
    after(safe);
  } catch {
    await safe();
  }
}

// Cheap spike detector for webhook signature rejections: called from a
// receiver's rejection path AFTER it logs the REJECTED row. Counts the last
// hour's rejections for that provider and alerts once as the count crosses the
// threshold (equality check = natural rate limit; a steady rejection stream
// alerts at the crossing, not on every event). Best-effort by design.
const REJECTION_ALERT_THRESHOLD = 6; // "more than 5 in an hour"
export async function alertWebhookRejections(provider: string): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 3600_000);
    const n = await prisma.webhookEvent.count({
      where: { provider, status: "REJECTED", createdAt: { gt: cutoff } },
    });
    if (n === REJECTION_ALERT_THRESHOLD) {
      await opsAlert(
        `⚠️ ${provider} webhooks: ${n} signature rejections in the last hour — real events may be bouncing at the door. ${appBase()}/connections`,
      );
      await notifyInApp({
        kind: "system",
        title: `${provider} webhooks bouncing (${n}/hr)`,
        href: "/connections",
        targets: [{ roles: ["OWNER"] }],
        // Hour-bucketed key = the same natural rate limit as the Slack ping.
        dedupeKey: `whrej-${provider}-${new Date().toISOString().slice(0, 13).replace("T", "-")}`,
      });
    }
  } catch {
    /* never let alerting break the receiver */
  }
}


// ---------------------------------------------------------------------------
// Kyle's MORNING digest — the day's list at the start of the day (audit: the
// function literally named getMorningBrief was only ever delivered at 4 PM).
// Same shape and dedupe pattern as the 4 o'clock check; 8–10am ET window.
// Sep 26 2026: gated on the Settings switch, timed by Kyle's own schedule, and
// honest about a refused DM (deliverDigestDm above).
// ---------------------------------------------------------------------------
export async function kyleMorningDigest(): Promise<{ sent: boolean; reason?: string }> {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
  );
  if (etHour < 8 || etHour >= 10) return { sent: false, reason: "outside 8-10am ET" };
  // The switch BEFORE the day is claimed, so turning it back on mid-window
  // still gets that morning's list.
  const off = await digestGate();
  if (off) return { sent: false, reason: off };
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const claimKey = `kyle-morning-${day}`;
  try {
    await prisma.appSetting.create({ data: { key: claimKey, value: "sent" } });
  } catch {
    return { sent: false, reason: "already sent today" };
  }
  try {
    const to = await kyleDigestRecipient();
    const { getMorningBrief, getOverdueTasks, getClientTextTasks } = await import("@/lib/queries");
    const [brief, overdue, texts] = await Promise.all([
      getMorningBrief().catch(() => []),
      getOverdueTasks().catch(() => []),
      getClientTextTasks().catch(() => []),
    ]);
    const seen = new Set(overdue.map((t) => t.id));
    const openToday = brief.filter((t) => !seen.has(t.id));
    const send = (text: string) => deliverDigestDm({ ...to, text, kind: "kyle_morning", claimKey });
    // The exceptions with Kyle's name on them and the unanswered counts (§9,
    // Sep 26 — commsBoard.exceptionDigestLines, shared with the 4 o'clock).
    const exceptionLines = await import("@/lib/commsBoard")
      .then((m) => m.exceptionDigestLines(appBase()))
      .catch(() => [] as string[]);
    if (overdue.length + openToday.length + texts.length + exceptionLines.length === 0) {
      return await send("☀️ Morning — nothing on the board yet. Enjoy the quiet start.");
    }
    const lines: string[] = ["☀️ *Morning check* — today's list:"];
    for (const t of overdue.slice(0, 8)) lines.push(`• 🔴 ${t.title}`);
    if (overdue.length > 8) lines.push(`  …and ${overdue.length - 8} more overdue`);
    for (const t of openToday.slice(0, 10)) lines.push(`• ${t.title}`);
    if (openToday.length > 10) lines.push(`  …and ${openToday.length - 10} more`);
    if (texts.length > 0) lines.push(`✉️ ${texts.length} client text${texts.length === 1 ? "" : "s"} drafted & ready in the Outbox`);
    lines.push(...exceptionLines);
    // Land where the listed rows actually live: Slack asks moved to their own
    // tab on Sep 16 (the Other tab now excludes them), so a digest that lists
    // both must offer both doors rather than one that shows half the list.
    const slackAsks = await prisma.smartTask.count({
      where: { source: "slack", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    }).catch(() => 0);
    lines.push(`${appBase()}/tasks?tab=other`);
    if (slackAsks > 0) lines.push(`Slack asks (${slackAsks}): ${appBase()}/tasks?tab=slack`);
    return await send(lines.join("\n"));
  } catch (e) {
    console.warn("kyleMorningDigest failed", e);
    await prisma.appSetting.delete({ where: { key: claimKey } }).catch(() => {});
    return { sent: false, reason: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Kyle's 4 PM Slack digest — RETIRED into commsBoard.afternoonSlackDigest
// (Sep 16, Kyle's call: the rebuilt one leads with the Slack asks and links
// every line to the tab that holds it). Nothing calls this any more; it stays
// as a one-line alias so an old import cannot bring back the version that
// linked /today and reported "sent" on a refused DM (Sep 26 2026).
// ---------------------------------------------------------------------------
export async function kyleAfternoonDigest(): Promise<{ sent: boolean; reason?: string }> {
  const { afternoonSlackDigest } = await import("@/lib/commsBoard");
  return afternoonSlackDigest();
}
