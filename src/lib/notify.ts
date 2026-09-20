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

// Where alerts go: SLACK_ALERT_CHANNEL env (a channel id or #name) wins; else
// the ops channel the bot is already in (#rp-project-tracker family); else
// Kyle's DM. Cached ~1h so we don't list channels on every ping.
let destCache: { at: number; channel: string } | null = null;
export async function alertDestination(): Promise<string> {
  const env = process.env.SLACK_ALERT_CHANNEL;
  if (env) return env;
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

// Post one internal alert line. Never throws; false = not delivered.
export async function opsAlert(text: string): Promise<boolean> {
  try {
    return await slackNotify(await alertDestination(), text);
  } catch {
    return false;
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
   *  bell-only for everyone — the emitter's way of saying "the owner did this
   *  himself" (his own upload). Person-addressed rows carry slackDm instead. */
  ownerSms?: string;
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
  review_approved: "all", // the editor's loop closes here
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
  edit_started: "all", // the editor set the queue to In editing (owner/admin hear it; Sep 10)
  edit_finished: "all",
  shoot_add_on: "all", // sold in the field; it doesn't get invoiced unless someone sees it
  portal_suggestion: "all", // a client asked for a script change
  portal_asset: "all", // a client's brand file: the bell is its ONLY signal, so it stays
  reply_sla: "all", // the client pager (see the warning above)
  system: "all", // integration failures — the owner is the only one who can fix them
  slack_id_missing: "all", // a mention had no Slack ID to go to — the office fixes that on People (Sep 15)
};

// ---------------------------------------------------------------------------
// WHEN A BELL ROW IS ALLOWED TO BUZZ A PHONE ON A DAY NOBODY WORKS
// (Sep 20 2026, audit F07 — narrowed the same day after review).
//
// coverage.ts landed on Sep 18 with the rule Jordan asked for — "queue routine
// alerts for the next covered period" — but only ONE helper ever consulted it
// (notifyStaffSms, and it has two callers). The personal bridge below, which
// carries essentially all of the traffic, never imported it. What that cost,
// counted off the delivery log: on Saturday Sep 19 a "cut ready" went out as a
// DM AND a text to Jordan, Kyle and Harrison at 09:26 and again at 12:22, a
// "review approved" followed on the Sunday, and 23 bridge deliveries in all
// landed on a Saturday or a Sunday. That weekend wave is the whole of what
// this block exists to stop.
//
// WHAT IS *NOT* HELD, AND WHY — the first cut of this fix reached further and
// the review was right to send it back. It deferred every routine alert raised
// outside Mon–Fri 9–6, which swept up weekday evenings too: a 7:15pm cut_ready
// to Jordan on Wed Sep 16 and a 7:34pm one on Thu Sep 17 would have waited
// until 9am the next morning, adding fourteen hours to the review→delivery
// clock the premium promise is measured against. Worse, it would have done so
// over the top of a switch he set by hand — every one of the six active roster
// rows has a saved notify-prefs matrix, and his review_ready row is
// {slack:true, sms:true}, the Sep 11 "make sure I get a text when a video is
// in review" ask in matrix form. An automated sweep does not get to quietly
// undo a person's own decision; that is the assignedManually invariant wearing
// a different hat.
//
// So the question this asks is narrower and it is about the DAY, not the hour:
// is this a day the rota covers at all? A Saturday is nobody's shift, and
// holding until Monday 9am is exactly the queue Jordan described. A Tuesday
// evening is the same working day as the Tuesday morning — the person whose
// switch is on is still the person who wanted to know, and the 7:00–22:00
// texting window in queueStaffSms already keeps it off their phone overnight.
// Note what that implies about the reviewer's other suggestion, to skip the
// hold for anyone with an explicitly saved matrix: all six active roster rows
// ARE explicit (verified against production), so that gate would hold nothing
// for anybody — a fix that reads as a fix and does nothing. The day rule is
// the honest narrow version.
//
// ROUTINE = work arriving in a lane somebody reads during the workday: raws
// in, a cut ready, an edit finished, a verdict on a cut. On an uncovered day,
// those wait. EVERYTHING ELSE IS TREATED AS URGENT, which is byte-for-byte
// today's behaviour — a kind nobody thought to classify must never go quiet by
// accident, the same fail-open rule BELL_RULES follows. A tag, a message, a
// revision ask, a reschedule, a cull, a task landing on your name: all
// unlisted, all unchanged. Field kinds are unlisted ON PURPOSE (see
// review_feedback below): the office rota is not the field's calendar.
//
// "Urgent" here means only "send now". routeAlert's on-call redirect is
// deliberately NOT applied: a bridge row is addressed to ONE named human
// about their own work, so handing James's tag to whoever is on call would
// deliver it to the wrong person entirely. The redirect stays where it makes
// sense — a role page (notifyStaffSms).
//
// TWO CARVE-OUTS, both of which would be regressions without them:
//  · A recipient on their OWN clock is not governed by the office rota.
//    Mon–Fri is the wrong calendar for Manila — Saturday is a working day for
//    Kim and John Mark, and 4 of the weekend DMs in the log were theirs. Their
//    quiet hours already run on their own timezone (queueStaffSms's `tz`);
//    that stays their only gate.
//  · Holding is only a hold when the alert is actually KEPT. The text queue
//    can keep a line (PendingSms.deferUntil, since Sep 18); a Slack DM has
//    nowhere to wait, so the DM is suppressed ONLY when the same sentence was
//    successfully held as a text. If nothing could be held — no text switch,
//    no US number, or Kyle's roster phone being the office line — the DM goes
//    now exactly as before. Quieter than today is the goal; silent never is.
//
// KNOWN LIMIT, disclosed rather than papered over (review, Sep 20): a held
// line can still die in the queue. parkUntextableSms retires every unsent line
// for a member whose roster phone is edited or blanked before the flush, and
// flushMemberSms's RTP-08 "held" outcome (OpenPhone never confirmed) keeps the
// rows claimed and never re-queues them. In either case a held alert ends at
// the bell with no DM and no relay, where before it had already been DM'd.
// Narrowing the hold to uncovered DAYS is what keeps that exposure to the
// handful of weekend rows above rather than to every evening. Closing it
// properly means relaying from the flusher's park/held paths for any line
// carrying a notificationId — the flusher is a different owner's surface, so
// it is on the handoff list, not smuggled in here.
// ---------------------------------------------------------------------------
const OFFICE_TZ = "America/New_York";

const ROUTINE_KINDS = new Set<string>([
  "raws_landed", // the files are in; the edit starts on a working day
  "edit_assigned",
  "edit_started",
  "edit_finished",
  "review_submitted", // a cut came back for a verdict
  "review_changes", // …and the changes asked for on it
  "review_approved", // the editor's loop closing
  "cut_ready", // the Saturday 09:26 and 12:22 pages, by name
  "cut_change_ask", // the photographer asking the editor for a tweak
  // review_feedback is deliberately ABSENT (review, Sep 20). It was listed in
  // the first cut and it does not belong: notifyPrefs maps it to shoot_change,
  // BELL_RULES calls it "capture feedback the photographer has to fix", and it
  // is addressed to the person standing at the property. 23 Saturday shoots in
  // the last 180 days say the office rota is the wrong calendar for it — "you
  // missed the basement", dated to Monday 9am, reaches a photographer two days
  // and one job too late. If the field ever wants a hold it needs a field
  // coverage window, not this one.
]);

/** The instant a routine alert should wait for, or null to send it now.
 *  ONE definition, shared by both bridges and by the acceptance drill
 *  (scripts/_drill/fix-F07.ts) — the same reason dueSmsWhere is exported: a
 *  second copy of this rule in a test is exactly how the two drift apart.
 *  `at` exists so the drill can replay a real Saturday instead of asking what
 *  the answer happens to be right now.
 *
 *  It asks routeAlert's question one notch coarser on purpose: routeAlert
 *  defers anything outside the covered HOURS, which is right for an unattended
 *  cron pager and wrong for a person's own subscription (see the block above).
 *  Here only a day the rota does not cover at all holds the alert, so the
 *  answer changes for a Saturday and never for a Tuesday evening. A rota set
 *  to cover every day therefore holds nothing — correctly: there is no day
 *  left for the alert to wait for.
 *
 *  Never throws: a coverage read that fails sends the alert rather than
 *  swallowing it (rule 3 in coverage.ts — silence is the one outcome an alert
 *  must never have). */
export async function holdUntilCovered(kind: string, tz: string | undefined, at: Date = new Date()): Promise<Date | null> {
  if (!ROUTINE_KINDS.has(kind)) return null;
  if (tz && tz !== OFFICE_TZ) return null; // not on the office clock (Manila)
  try {
    const { coverageRules, nextCoveredMomentAt } = await import("@/lib/coverage");
    const { isWeekdayET } = await import("@/lib/datetime");
    const c = await coverageRules();
    if (!c.weekdaysOnly || isWeekdayET(at)) return null; // a day somebody works
    const until = nextCoveredMomentAt(at, c);
    return until > at ? until : null;
  } catch (e) {
    console.warn("coverage check failed (sending now)", kind, e);
    return null;
  }
}

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
//     summary, the link), else the title and the link. Immediate, EXCEPT for
//     a routine kind raised on a day the rota does not cover at all, where the
//     same sentence was successfully held as a text (see the coverage block
//     above; until Sep 20 this was unconditionally immediate on the grounds
//     that Slack has its own do-not-disturb — true, and it still did not stop
//     the Saturday Sep 19 "cut ready" wave).
//   · Text — the same sentence in plain-text form, through the staff SMS
//     queue below: 7:00–22:00 quiet hours (ET; an editor's own timezone),
//     the 30-minute digest, the "⚙️ RealTour Hub:" prefix, TEAM MEMBERS ONLY
//     (the number comes off the roster row, never a client contact — the
//     drafts-only policy for client texting is not weakened here), never our
//     own OpenPhone line, and — for a routine kind raised on a Saturday or a
//     Sunday — Monday 9am on the line instead of a buzz at the weekend. An
//     evening on a working day is untouched: the texting window already owns
//     that, and the switch is the person's own.
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
 *  quiet-hours branch of notifyStaffSms, the payroll digest) have no queued
 *  row and log under "staff_sms". */
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

// Quiet hours in a SPECIFIC timezone (7:00–22:00 local). Photographer texting
// stays ET via the default; editor texting passes the recipient's tz so a
// Manila editor isn't pinged at 3am (their night = the old ET window exactly).
function withinTextingHours(tz = "America/New_York"): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date()),
  );
  return hour >= 7 && hour < 22;
}

// One text per person per window; everything else queues and flushes as ONE
// combined message (Aug 24: Harrison & James were getting blown up with
// back-to-back texts). Quiet-hours pings queue too — they become part of the
// next morning's digest instead of silently vanishing.
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
// 30-minute window, quiet hours (`tz` = the recipient's, ET by default), the
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
  tz?: string,
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
    // First ping in the window and daytime → deliver immediately (flushing
    // everything queued for them along the way). Otherwise the flusher cron
    // combines it into one message shortly. A DEFERRED line never takes this
    // branch — an immediate flush is exactly what it was queued to avoid.
    if (!deferUntil && !recentSend && withinTextingHours(tz)) {
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
  // DUE, not merely unsent (Sep 18): a routine alert raised out of cover
  // carries the next covered moment, and a flush triggered by somebody else's
  // line must not sweep it up early — the body is built from exactly the rows
  // this claim wins, so a held line joining the batch IS the weekend text we
  // are removing.
  const rows = await prisma.pendingSms.findMany({
    where: { teamMemberId, ...dueSmsWhere() },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return "none";
  // CLAIM before sending — the immediate flush and the 5-minute cron can race
  // on the same unsent rows and text the digest twice (audit). The claim stamp
  // is a unique instant; the body is then built from EXACTLY the rows this
  // claim won, so a partial claim can never re-text a competitor's rows
  // (review finding), and an unclaim can only release our own.
  const claimStamp = new Date();
  const claimed = await prisma.pendingSms.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, sentAt: null },
    data: { sentAt: claimStamp },
  });
  if (claimed.count === 0) return "none";
  const mine = await prisma.pendingSms.findMany({
    where: { teamMemberId, sentAt: claimStamp },
    orderBy: { createdAt: "asc" },
  });
  if (mine.length === 0) return "none";
  const unclaim = () =>
    prisma.pendingSms.updateMany({ where: { id: { in: mine.map((r) => r.id) } }, data: { sentAt: null } }).catch(() => {});
  // The bell rows and kinds behind these lines, for the log (one lookup).
  const meta = await queuedMeta(mine.map((r) => r.id));
  const logAll = (status: "sent" | "failed", detail?: string) =>
    Promise.all(
      mine.map((r) => {
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
  const body =
    mine.length === 1
      ? `${HUB_SMS_PREFIX}: ${mine[0].line}`
      : `${HUB_SMS_PREFIX} — ${mine.length} updates:\n` + mine.map((r) => `• ${r.line}`).join("\n");
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
      body: body.slice(0, 1500),
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
async function recoverUnclaimedStaffSms(): Promise<number> {
  const { outboxStateOf, staffKey } = await import("@/lib/outbox");
  const firstStaff = await prisma.outboxMessage
    .findFirst({ where: { requestedBy: FLUSH_REQUESTED_BY }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
    .catch(() => null);
  if (!firstStaff) return 0; // the outbox has never carried a staff digest here
  const from = new Date(firstStaff.createdAt.getTime() + 5 * 60_000);
  const until = new Date(Date.now() - 15 * 60_000);
  if (from >= until) return 0;
  const claimed = await prisma.pendingSms
    .findMany({ where: { sentAt: { gt: from, lt: until }, skippedAt: null }, select: { id: true, teamMemberId: true, sentAt: true }, take: 200 })
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
    let held: unknown;
    try {
      held = await outboxStateOf(key);
    } catch {
      continue; // can't tell → leave it claimed
    }
    if (held) continue; // the outbox owns this flush: accepted, held, or queued for the drain
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
// passed (or daylight returns after quiet hours). Never inside the RECIPIENT's
// quiet hours: until Sep 15 this checked ET for everyone, so a line the
// immediate send in queueStaffSms had rightly held for a Manila editor's
// night went out here in ET daytime — still their night (review, Sep 15).
// An editor's timezone comes off editors.ts; everyone else is ET. `skipped`
// (Sep 16) counts lines parked because the member can never be texted, and
// `held` (Sep 16, RTP-08) counts digests OpenPhone did not confirm — those are
// NOT re-queued, they wait on Connections for a person. `recovered` (review,
// Sep 16) counts lines a killed flush left claimed and unsent, put back in the
// queue by the watchdog above — it runs FIRST, and before the early return,
// because those lines are claimed and so never appear in the pending groups.
export async function flushPendingSms(): Promise<{ flushed: number; failed: string[]; skipped: number; held: number; recovered: number }> {
  const recovered = await recoverUnclaimedStaffSms().catch(() => 0);
  // DUE lines only. Held lines are excluded from the grouping itself, not just
  // from the send: `_min.createdAt` drives the 30-minute batch window below, so
  // a Saturday line held until Monday would otherwise make every one of that
  // person's later lines look "old enough to go now".
  const pending = await prisma.pendingSms.groupBy({
    by: ["teamMemberId"],
    where: dueSmsWhere(),
    _min: { createdAt: true },
  });
  if (pending.length === 0) return { flushed: 0, failed: [], skipped: 0, held: 0, recovered };
  const { editorKeysByTeamMemberId } = await import("@/lib/notifyPrefs");
  const { editorMeta, DEFAULT_EDITOR_TZ } = await import("@/lib/editors");
  const editorKeys = await editorKeysByTeamMemberId();
  let flushed = 0;
  let skipped = 0;
  let held = 0;
  const failed: string[] = [];
  for (const p of pending) {
    const oldest = p._min.createdAt;
    if (!oldest) continue;
    const editorKey = editorKeys.get(p.teamMemberId);
    // A member with no textable number is parked regardless of the hour —
    // there is nothing to wait for (Sep 16).
    const member = await prisma.teamMember.findUnique({ where: { id: p.teamMemberId }, select: { phone: true } });
    if (!staffTextNumber(member?.phone)) {
      try {
        if ((await flushMemberSms(p.teamMemberId)) === "parked") skipped++;
      } catch (e) {
        failed.push(`${p.teamMemberId}: ${e instanceof Error ? e.message : "park failed"}`);
      }
      continue;
    }
    if (!withinTextingHours(editorKey ? editorMeta(editorKey)?.tz ?? DEFAULT_EDITOR_TZ : undefined)) continue;
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
  return { flushed, failed, skipped, held, recovered };
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
export type StaffSmsResult = { teamMemberId: string; name: string; outcome: "sent" | "slack" | "no-phone" | "own-line" | "quiet-hours" | "deferred" | "failed" };

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
    (r) => r.outcome !== "sent" && r.outcome !== "slack" && r.outcome !== "quiet-hours" && r.outcome !== "deferred",
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
export async function notifyStaffSms(
  teamMemberIds: string[],
  text: string,
  kind = "staff_sms",
  opts: { urgency?: "routine" | "urgent" } = {},
): Promise<StaffSmsResult[]> {
  let ids = [...new Set(teamMemberIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const out: StaffSmsResult[] = [];
  try {
    if (opts.urgency) {
      const { routeAlert } = await import("@/lib/coverage");
      const route = await routeAlert(opts.urgency);
      if (route.send === "defer") {
        const members = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
        for (const m of members) {
          // Slack is deliberately NOT tried here. A DM buzzes a phone like a
          // text does, so holding the text and DMing anyway would deliver the
          // weekend page this exists to remove.
          const queued = await queueStaffSms(m.id, text, undefined, { kind }, route.until);
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
    const quiet = !withinTextingHours();
    const { OpenPhone, defaultOpenPhoneNumber, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
    const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
    // Resolved ONCE — defaultOpenPhoneNumber is a live API round trip.
    const from = ids.length ? await defaultOpenPhoneNumber() : null;
    const body = `${HUB_SMS_PREFIX}: ${text}`;
    const log = (teamMemberId: string, channel: DeliveryChannel, status: DeliveryStatus, detail?: string) =>
      logDelivery({ teamMemberId, kind, channel, status, detail });

    for (const m of members) {
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
      if (quiet) {
        // Queue for the morning flusher instead of dropping (audit: quiet-hours
        // staff alerts vanished — not sent, not queued, excluded from the relay).
        const queued = await prisma.pendingSms.create({ data: { teamMemberId: m.id, line: text }, select: { id: true } }).catch(() => null);
        await log(m.id, "sms", queued ? "queued" : "failed", queued ? queued.id : "could not queue for the morning");
        out.push({ teamMemberId: m.id, name: m.name, outcome: "quiet-hours" });
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
  } catch (e) {
    console.warn("notifyStaffSms failed", e);
  }
  return out;
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
}): Promise<{ bridged: Array<{ userKey: string; channel: EditorChannel }>; silenced: number }> {
  const bridged: Array<{ userKey: string; channel: EditorChannel }> = [];
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
        if (tmId || editorKey) {
          // A person: their matrix row for this event decides Slack / text /
          // both / neither (see the bridge header above and bridgePerson).
          const out = await bridgePerson(n.kind, t, { tmId, editorKey, title, href, notificationId: row.id }, delivered);
          if (editorKey && roles.includes("EDITOR")) {
            bridged.push({ userKey: t.userKey!, channel: out.slack ? "slack" : out.sms ? "sms" : "bell" });
          }
        } else if ((roles.includes("OWNER") || roles.includes("ADMIN")) && t.ownerSms) {
          // A broadcast is bell-only — except the Review Room's OWNER+ADMIN
          // "cut ready" row, which carries a sentence for the owner (Sep 11)
          // and, since Sep 16, the office (bridgeBroadcast).
          await bridgeBroadcast(n.kind, t.ownerSms, { roles, notificationId: row.id }, delivered);
        }
        // A NEW editor-addressed bell row with no login to see it → nudge Jordan
        // once (deduped inside) to send that editor their Hub invite.
        if (editorKey) {
          try {
            const { ensureEditorLoginNudge } = await import("@/lib/tasks");
            await ensureEditorLoginNudge(editorKey);
          } catch { /* the nudge must never break the bell */ }
        }
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
  return { bridged, silenced };
}

// What went out for one person in one notifyInApp call (the `delivered` map).
type Delivery = { slack: boolean; sms: boolean };

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
//     staff queue, quiet hours in the recipient's timezone.
// Since Sep 20 (audit F07) it also asks the two questions notifyStaffSms has
// always asked and this path never did: is this a day anybody works, for a
// ROUTINE kind (holdUntilCovered — if not, the text is dated to Monday morning
// and the DM waits with it; an evening on a working day is left alone), and
// did anything actually get through (if not, relayUnreached names the person
// on the ops channel instead of leaving the alert in a bell).
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
    const { eventForKind, notifyPrefsFor, editorKeysByTeamMemberId } = await import("@/lib/notifyPrefs");
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
    // The recipient's own clock, read BEFORE either channel (Sep 20): it is
    // half of the coverage answer as well as the texting-hours one, and the
    // Slack leg needs the answer too.
    const editorKey = ctx.editorKey ?? (await editorKeysByTeamMemberId()).get(personId) ?? null;
    const { editorMeta, DEFAULT_EDITOR_TZ } = await import("@/lib/editors");
    const tz = editorKey ? editorMeta(editorKey)?.tz ?? DEFAULT_EDITOR_TZ : undefined;
    const hold = await holdUntilCovered(kind, tz);
    // THE TEXT GOES FIRST when the alert is being held (Slack went first until
    // Sep 20, audit F07). The digest queue is the only channel that can keep a
    // line until Monday, so whether it took the line is what decides whether
    // suppressing the DM is a hold or a drop. In cover — the ordinary case —
    // nothing is held and the two legs are as independent as they always were.
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
        // Quiet hours in the recipient's own timezone: a Manila editor's night
        // is exactly the ET texting window. `hold` is the coverage answer on top
        // of that — null for everyone on their own clock, and for every kind
        // that is not routine.
        state.sms = await queueStaffSms(personId, line, tz, meta, hold);
      }
    }
    // Did the Slack leg ever actually get tried? A person who wants Slack and
    // has no ID on file is a CONFIGURATION gap, and the codebase already
    // handles it weekly (nudgeMissingSlackId, throttled, on the People page).
    // The relay at the bottom must not also fire on it — one new hire would
    // otherwise produce an unthrottled ops line per notification on top of
    // that nudge, for a week, saying nothing the nudge does not (review,
    // Sep 20).
    let slackIdMissing = false;
    if (want.slack) {
      if (hold && state.sms) {
        // Held, not dropped: the same sentence is in the digest queue dated to
        // the next covered moment, and the bell row is already there. A DM
        // buzzes a phone exactly like a text does, which is why notifyStaffSms's
        // own defer branch does not try Slack either.
        await logDelivery({
          ...meta,
          teamMemberId: personId,
          channel: "slack",
          status: "skipped",
          detail: `routine alert, nobody works today — held as a text until ${hold.toISOString()}`,
        });
      } else if (member.slackId) {
        const { slackDmUserDetailed } = await import("@/lib/integrations/slack");
        const { escapeSlack } = await import("@/lib/text");
        const dm = await slackDmUserDetailed(member.slackId, t.slackDm ?? `${escapeSlack(ctx.title)}\n${link}`);
        state.slack = dm.ok;
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
// (queueStaffSms, which refuses the company line and logs why). No sentence
// (the owner's own upload) never gets here — bell-only for everyone.
async function bridgeBroadcast(
  kind: string,
  sentence: string,
  ctx: { roles: Role[]; notificationId: string },
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
    // One coverage answer for the whole broadcast (Sep 20, audit F07): the
    // kind is the same for everyone on it and the office is on the office
    // clock, so the rota is asked once rather than per person. This is the
    // path the Saturday Sep 19 09:26 and 12:22 "cut ready" DMs and texts to
    // Jordan, Kyle and Harrison came down — the wave the hold is scoped to,
    // and the reason it is scoped to weekend days and nothing else.
    const hold = await holdUntilCovered(kind, undefined);
    for (const id of ids) {
      if (delivered.has(id)) continue;
      const state: Delivery = { slack: false, sms: false };
      delivered.set(id, state);
      const member = await prisma.teamMember.findUnique({ where: { id }, select: { name: true, slackId: true, active: true } });
      if (!member?.active) continue;
      await logDelivery({ ...meta, teamMemberId: id, channel: "bell", status: "sent" });
      const want = (await notifyPrefsFor(id)).review_ready;
      if (!want.slack && !want.sms) continue;
      // ownerSms was written for the owner's eyes; since Sep 16 this bridge
      // also hands it to the office, so a non-owner reads it scrubbed (review,
      // Sep 16 — the Room's sentence carries no money today, but the guard the
      // contract on NotifyTarget.ownerSms promises must still be here).
      const line = owners.has(id) ? sentence : scrubMoney(sentence);
      // Text first, for the reason bridgePerson carries in full: only the
      // digest queue can actually hold a line until Monday, so it answers
      // first and the DM reads that answer.
      if (want.sms) state.sms = await queueStaffSms(id, line, undefined, meta, hold);
      // A missing Slack ID is the weekly People nudge's business, not the
      // relay's — see the same flag in bridgePerson (review, Sep 20).
      let slackIdMissing = false;
      if (want.slack) {
        if (hold && state.sms) {
          await logDelivery({
            ...meta,
            teamMemberId: id,
            channel: "slack",
            status: "skipped",
            detail: `routine alert, nobody works today — held as a text until ${hold.toISOString()}`,
          });
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
// ---------------------------------------------------------------------------
export async function kyleMorningDigest(): Promise<{ sent: boolean; reason?: string }> {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
  );
  if (etHour < 8 || etHour >= 10) return { sent: false, reason: "outside 8-10am ET" };
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  try {
    await prisma.appSetting.create({ data: { key: `kyle-morning-${day}`, value: "sent" } });
  } catch {
    return { sent: false, reason: "already sent today" };
  }
  try {
    const slackId = await kyleSlackId();
    const { slackDmUser } = await import("@/lib/integrations/slack");
    const { getMorningBrief, getOverdueTasks, getClientTextTasks } = await import("@/lib/queries");
    const [brief, overdue, texts] = await Promise.all([
      getMorningBrief().catch(() => []),
      getOverdueTasks().catch(() => []),
      getClientTextTasks().catch(() => []),
    ]);
    const seen = new Set(overdue.map((t) => t.id));
    const openToday = brief.filter((t) => !seen.has(t.id));
    if (overdue.length + openToday.length + texts.length === 0) {
      await slackDmUser(slackId, "☀️ Morning — nothing on the board yet. Enjoy the quiet start.");
      return { sent: true };
    }
    const lines: string[] = ["☀️ *Morning check* — today's list:"];
    for (const t of overdue.slice(0, 8)) lines.push(`• 🔴 ${t.title}`);
    if (overdue.length > 8) lines.push(`  …and ${overdue.length - 8} more overdue`);
    for (const t of openToday.slice(0, 10)) lines.push(`• ${t.title}`);
    if (openToday.length > 10) lines.push(`  …and ${openToday.length - 10} more`);
    if (texts.length > 0) lines.push(`✉️ ${texts.length} client text${texts.length === 1 ? "" : "s"} drafted & ready in the Outbox`);
    // Land where the listed rows actually live: Slack asks moved to their own
    // tab on Sep 16 (the Other tab now excludes them), so a digest that lists
    // both must offer both doors rather than one that shows half the list.
    const slackAsks = await prisma.smartTask.count({
      where: { source: "slack", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    }).catch(() => 0);
    lines.push(`${appBase()}/tasks?tab=other`);
    if (slackAsks > 0) lines.push(`Slack asks (${slackAsks}): ${appBase()}/tasks?tab=slack`);
    await slackDmUser(slackId, lines.join("\n"));
    return { sent: true };
  } catch (e) {
    console.warn("kyleMorningDigest failed", e);
    await prisma.appSetting.delete({ where: { key: `kyle-morning-${day}` } }).catch(() => {});
    return { sent: false, reason: "failed" };
  }
}

// ---------------------------------------------------------------------------
// Kyle's 4 PM Slack digest — open to-dos and things to check, once per ET day
// in the 4-6pm window (the 5-minute cron calls this; the AppSetting key makes
// it fire exactly once). Jordan (Aug 24): "by 4PM that day, send Kyle a
// reminder of his open to-dos and things to check."
// ---------------------------------------------------------------------------
export async function kyleAfternoonDigest(): Promise<{ sent: boolean; reason?: string }> {
  const etHour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date()),
  );
  if (etHour < 16 || etHour >= 18) return { sent: false, reason: "outside 4-6pm ET" };
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  try {
    await prisma.appSetting.create({ data: { key: `kyle-digest-${day}`, value: "sent" } });
  } catch {
    return { sent: false, reason: "already sent today" };
  }
  try {
    const slackId = await kyleSlackId();
    const { slackDmUser } = await import("@/lib/integrations/slack");
    const { getMorningBrief, getOverdueTasks, getClientTextTasks } = await import("@/lib/queries");
    const [brief, overdue, texts] = await Promise.all([
      getMorningBrief().catch(() => []),
      getOverdueTasks().catch(() => []),
      getClientTextTasks().catch(() => []),
    ]);
    const seen = new Set(overdue.map((t) => t.id));
    const openToday = brief.filter((t) => !seen.has(t.id));
    if (overdue.length + openToday.length + texts.length === 0) {
      await slackDmUser(slackId, "🕓 4 o'clock check — everything's clear. Nice work today. 🎉");
      return { sent: true };
    }
    const lines: string[] = ["🕓 *4 o'clock check* — still open today:"];
    for (const t of overdue.slice(0, 8)) lines.push(`• 🔴 ${t.title}`);
    if (overdue.length > 8) lines.push(`  …and ${overdue.length - 8} more overdue`);
    for (const t of openToday.slice(0, 10)) lines.push(`• ${t.title}`);
    if (openToday.length > 10) lines.push(`  …and ${openToday.length - 10} more`);
    if (texts.length > 0) lines.push(`✉️ ${texts.length} client text${texts.length === 1 ? "" : "s"} drafted & waiting in the Outbox`);
    lines.push(`${appBase()}/today`);
    await slackDmUser(slackId, lines.join("\n"));
    return { sent: true };
  } catch (e) {
    console.warn("kyleAfternoonDigest failed", e);
    // Release the day claim — marking "sent" BEFORE a Slack hiccup permanently
    // ate that day's digest with no retry (audit). The next 5-min tick retries.
    await prisma.appSetting.delete({ where: { key: `kyle-digest-${day}` } }).catch(() => {});
    return { sent: false, reason: "failed" };
  }
}
