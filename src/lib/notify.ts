import "server-only";
import { prisma } from "@/lib/prisma";
import { slackNotify, slackChannels } from "@/lib/integrations/slack";
import { appBase } from "@/lib/appUrl";
import { HUB_SMS_PREFIX } from "@/lib/hubSms";
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
export type NotifyTarget = {
  roles: Role[];
  userKey?: string;
  href?: string; // overrides the default per row
  /** Sep 11: the exact digest line the OWNER's phone gets when this row
   *  bridges to his text (see the owner branch in notifyInApp). Leave it OFF
   *  and the row is bell-only for him — the emitter's way of saying "he did
   *  this himself" (his own upload, a self-tag). Photographer rows never read
   *  it — they stay title + link (money clamp). */
  ownerSms?: string;
  /** Sep 15: the exact Slack DM this row earns the person it is addressed to
   *  (tm:<id>, or editor:<key> resolved to its TeamMember) — sent the moment
   *  the row is new, when their roster row carries a Slack ID. The emitter's
   *  own sentence, money already scrubbed for a non-owner (mentions.ts
   *  slackMentionDm). Leave it OFF for a self-tag, exactly like ownerSms. */
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
  revision_raised: "all", // a client wants a change
  revision_resolved: "all", // it came back — check it and re-deliver
  cut_ready: "all", // a cut is waiting on a verdict
  review_ready: "all",
  review_submitted: "all",
  review_changes: "all", // changes asked for on a cut (the editor must act)
  review_approved: "all", // the editor's loop closes here
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
// SMS bridge: photographers have no push notifications, so person-addressed
// bell rows for the kinds below ALSO go out as a text via OpenPhone. Rules:
// TEAM MEMBERS ONLY (the recipient's number comes off their TeamMember row,
// never a client contact — the drafts-only policy for client texting is not
// weakened here); title + deep link only, never the body (money-clamp
// philosophy: an SMS is even leakier than the bell); "⚙️ RealTour Hub:" prefix
// so an automated text is never mistaken for Kyle texting from the same
// number; quiet hours 7:00–22:00 ET (the bell row still lands — the text just
// doesn't wake anyone); only fires when the bell row was NEWLY created, so a
// deduped re-announcement can't re-text.
//
// Sep 11: the OWNER rides the same queue for two kinds of his own — a cut
// waiting on his verdict and an @mention of him — switched on /settings
// (src/lib/smsPrefs.ts, default ON). See the owner branch in notifyInApp.
// ---------------------------------------------------------------------------
const SMS_KINDS = new Set([
  "appointment_change", "order_canceled", "mention", "review_feedback", "cull", "raws_missing", "task_assigned",
  // Someone answered on a note thread the photographer is part of — their
  // question finally has a reply; reach the field. (feedback_shared stays
  // NON-SMS: the share-text flow already sends its own text.)
  "note_reply",
]);
// The video editors (Kim/Remar) have no push either, and the whole point of the
// editor platform is that raws-landed / a revision / a review-back actually
// REACH them — in Manila. These kinds bridge an `editor:<key>` bell row to their
// channel (Slack DM if we have their id, else SMS via their TeamMember phone),
// gated by quiet hours in THEIR timezone (see channelForEditor).
const EDITOR_CHANNEL_KINDS = new Set([
  "raws_landed", "revision_raised", "revision_resolved", "mention", "edit_finished",
  // Review Room round-trips: changes requested on a cut / cut approved.
  "review_changes", "review_approved",
  // Owner/admin manually put a job in this editor's queue (/editing → Add a job).
  "edit_assigned",
  // A reply landed on a note thread this editor is part of.
  "note_reply",
]);

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

async function smsPhotographer(teamMemberId: string, title: string, href: string): Promise<void> {
  await queueStaffSms(teamMemberId, `${title} → ${appBase()}${href}`);
}

// One digest line into a team member's queue — the ONLY way onto the bridge.
// The photographer path builds "title → link"; the owner path (Sep 11) hands
// in its own sentence. Everything downstream is shared: the 30-minute window,
// quiet hours, the claim-then-send flush.
async function queueStaffSms(teamMemberId: string, line: string): Promise<void> {
  try {
    await prisma.pendingSms.create({ data: { teamMemberId, line } });
    const recentSend = await prisma.pendingSms.findFirst({
      where: { teamMemberId, sentAt: { gte: new Date(Date.now() - SMS_BATCH_WINDOW_MS) } },
      select: { id: true },
    });
    // First ping in the window and daytime → deliver immediately (flushing
    // everything queued for them along the way). Otherwise the flusher cron
    // combines it into one message shortly.
    if (!recentSend && withinTextingHours()) await flushMemberSms(teamMemberId);
  } catch (e) {
    console.warn("queueStaffSms failed", e);
  }
}

// Send EVERYTHING queued for one member as a single text.
async function flushMemberSms(teamMemberId: string): Promise<boolean> {
  const rows = await prisma.pendingSms.findMany({
    where: { teamMemberId, sentAt: null },
    orderBy: { createdAt: "asc" },
  });
  if (rows.length === 0) return false;
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
  if (claimed.count === 0) return false;
  const mine = await prisma.pendingSms.findMany({
    where: { teamMemberId, sentAt: claimStamp },
    orderBy: { createdAt: "asc" },
  });
  if (mine.length === 0) return false;
  const unclaim = () =>
    prisma.pendingSms.updateMany({ where: { id: { in: mine.map((r) => r.id) } }, data: { sentAt: null } }).catch(() => {});
  const member = await prisma.teamMember.findUnique({ where: { id: teamMemberId }, select: { phone: true } });
  const phone = member?.phone?.replace(/[^\d+]/g, "");
  if (!phone) { await unclaim(); return false; }
  const { OpenPhone, defaultOpenPhoneNumber, phoneKey } = await import("@/lib/integrations/openphone");
  const from = await defaultOpenPhoneNumber();
  if (!from) { await unclaim(); return false; }
  const to = phone.startsWith("+") ? phone : `+1${phoneKey(phone)}`;
  const body =
    mine.length === 1
      ? `${HUB_SMS_PREFIX}: ${mine[0].line}`
      : `${HUB_SMS_PREFIX} — ${mine.length} updates:\n` + mine.map((r) => `• ${r.line}`).join("\n");
  try {
    await OpenPhone.sendMessage(from, to, body.slice(0, 1500));
  } catch (e) {
    await unclaim(); // failed send → rows go back in the queue for the next flush
    throw e;
  }
  return true;
}

// Cron flusher (every 5 min): deliver queued digests once the batch window has
// passed (or daylight returns after quiet hours). Never inside quiet hours.
export async function flushPendingSms(): Promise<{ flushed: number; failed: string[] }> {
  if (!withinTextingHours()) return { flushed: 0, failed: [] };
  const pending = await prisma.pendingSms.groupBy({
    by: ["teamMemberId"],
    where: { sentAt: null },
    _min: { createdAt: true },
  });
  let flushed = 0;
  const failed: string[] = [];
  for (const p of pending) {
    const oldest = p._min.createdAt;
    if (!oldest) continue;
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
      if (await flushMemberSms(p.teamMemberId)) flushed++;
    } catch (e) {
      failed.push(`${p.teamMemberId}: ${e instanceof Error ? e.message : "send failed"}`);
    }
  }
  return { flushed, failed };
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
export type StaffSmsResult = { teamMemberId: string; name: string; outcome: "sent" | "slack" | "no-phone" | "own-line" | "quiet-hours" | "failed" };

export async function notifyStaffSms(teamMemberIds: string[], text: string): Promise<StaffSmsResult[]> {
  const ids = [...new Set(teamMemberIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const out: StaffSmsResult[] = [];
  try {
    const members = await prisma.teamMember.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, phone: true, slackId: true } });
    const quiet = !withinTextingHours();
    const { OpenPhone, defaultOpenPhoneNumber, phoneKey, ourOpenPhoneNumberKeys } = await import("@/lib/integrations/openphone");
    const ours = await ourOpenPhoneNumberKeys().catch(() => new Set<string>());
    // Resolved ONCE — defaultOpenPhoneNumber is a live API round trip.
    const from = ids.length ? await defaultOpenPhoneNumber() : null;
    const body = `${HUB_SMS_PREFIX}: ${text}`;

    for (const m of members) {
      // Slack first — Jordan (Aug 24): "instead of texting Kyle, message him
      // on Slack." Anyone with a Slack id gets a DM; SMS is the fallback.
      if (m.slackId) {
        const { slackDmUser } = await import("@/lib/integrations/slack");
        if (await slackDmUser(m.slackId, text)) {
          out.push({ teamMemberId: m.id, name: m.name, outcome: "slack" });
          continue;
        }
      }
      const digits = m.phone?.replace(/[^\d+]/g, "") ?? "";
      const key = digits ? phoneKey(digits) : "";
      if (!digits || key.length !== 10) {
        out.push({ teamMemberId: m.id, name: m.name, outcome: "no-phone" });
        continue;
      }
      if (ours.has(key)) {
        // Loud, not silent: this is a data problem someone has to fix.
        console.warn(`notifyStaffSms: ${m.name}'s number is our own OpenPhone line — cannot text, relaying to ops`);
        out.push({ teamMemberId: m.id, name: m.name, outcome: "own-line" });
        continue;
      }
      if (quiet) {
        // Queue for the morning flusher instead of dropping (audit: quiet-hours
        // staff alerts vanished — not sent, not queued, excluded from the relay).
        await prisma.pendingSms.create({ data: { teamMemberId: m.id, line: text } }).catch(() => {});
        out.push({ teamMemberId: m.id, name: m.name, outcome: "quiet-hours" });
        continue;
      }
      try {
        if (!from) throw new Error("no OpenPhone number");
        await OpenPhone.sendMessage(from, digits.startsWith("+") ? digits : `+1${key}`, body);
        out.push({ teamMemberId: m.id, name: m.name, outcome: "sent" });
      } catch (e) {
        console.warn("notifyStaffSms send failed", m.name, e);
        out.push({ teamMemberId: m.id, name: m.name, outcome: "failed" });
      }
    }
    // Anyone we could not reach by text still gets the alert — via Slack ops.
    const unreached = out.filter((r) => r.outcome !== "sent" && r.outcome !== "slack" && r.outcome !== "quiet-hours");
    if (unreached.length) {
      await opsAlert(`⚠️ Couldn't text ${unreached.map((r) => `${r.name} (${r.outcome})`).join(", ")} — relaying: ${text}`);
    }
  } catch (e) {
    console.warn("notifyStaffSms failed", e);
  }
  return out;
}

// What actually happened when we tried to reach an editor — callers use this
// to log the truth ("texted" vs "relayed to ops") instead of assuming Slack.
export type EditorChannel = "slack" | "sms" | "relay" | "quiet" | "none" | "bell";

// Reach an editor addressed by `editor:<key>` (Kim/Remar) on THEIR channel:
//   · Slack DM if the roster carries a slackUserId (preferred — same path as
//     Kyle's DM, no phone dependency, no quiet-hours phone leak);
//   · else SMS via their TeamMember phone (Kim has one; Remar until Jordan adds
//     hers — the lookup no-ops cleanly when absent).
// Quiet hours are checked in the EDITOR's timezone (default Asia/Manila) so an
// offshore editor isn't pinged at 3am. Title + deep link only (money clamp —
// same as photographer SMS). Best-effort; never throws — returns which channel
// actually carried the ping.
async function channelForEditor(editorKey: string, title: string, href: string): Promise<EditorChannel> {
  // Jordan (Aug 25): editors get their notifications ON THE DASHBOARD — the
  // in-app bell row plus the editor home's feed. ONE exception (review): an
  // editor with NO hub login can't see any dashboard — until their login
  // exists, a phone on file gets the queued-SMS fallback (PendingSms handles
  // batching + quiet hours), so work pings don't land in a room nobody enters.
  const { editorMeta, editorTeamMemberId } = await import("@/lib/editors");
  const meta = editorMeta(editorKey);
  if (!meta) return "none";
  try {
    const tmId = await editorTeamMemberId(editorKey);
    if (tmId) {
      const [login, member] = await Promise.all([
        prisma.appUser.findFirst({ where: { OR: [{ editorKey }, { teamMemberId: tmId }], status: "ACTIVE" }, select: { id: true } }),
        prisma.teamMember.findUnique({ where: { id: tmId }, select: { phone: true } }),
      ]);
      if (!login && member?.phone) {
        await prisma.pendingSms.create({ data: { teamMemberId: tmId, line: `${title} → ${appBase()}${href}` } });
        return "sms";
      }
    }
  } catch { /* fall through to bell */ }
  return "bell";
}

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
  // TeamMember id → did a Slack DM go out for them in THIS call. An editor is
  // addressed through both a tm: row and an editor: row, and both resolve to
  // the same person; they get one DM, not two — and the second row still
  // learns the DM landed, so its text fallback stands down too.
  const slackDmDone = new Map<string, boolean>();
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
      if (roles.includes("EDITOR") || roles.includes("PHOTOGRAPHER")) {
        body = null;
        if (href.startsWith("/billing") || href.startsWith("/payouts") || n.kind === "order_paid") {
          roles = ["OWNER"];
          console.warn("notifyInApp money clamp", n.kind);
        }
      }
      try {
        await prisma.notification.create({
          data: {
            kind: n.kind,
            title,
            body,
            href,
            audience: JSON.stringify(roles),
            userKey: t.userKey ?? null,
            dedupeKey: n.dedupeKey ? `${n.dedupeKey}-${i}` : null,
          },
        });
        // Row is NEW (a dedupe hit threw P2002 above) — the bridges below fire
        // once per row, which is what makes a re-announcement unable to re-text.
        const tmId = t.userKey?.startsWith("tm:") ? t.userKey.slice(3) : null;
        // THE SLACK DM (Jordan, Sep 15: "anytime someone is messaged in the
        // Ops Hub a notification gets sent via Slack to whoever was mentioned
        // … with a link to the message and a summary"). A person-addressed
        // row that brought its own sentence goes straight to that person's
        // Slack DM when their roster row carries a Slack ID. Immediately: no
        // hub quiet hours and no digest — Slack has its own do-not-disturb,
        // and a mention is one person asking another. ONE DM per person per
        // event (slackDmDone). A self-tag never carries slackDm — the
        // emitters leave it off, exactly like ownerSms. It runs FIRST: when
        // the DM lands, the photographer text and the no-login editor text
        // below stand down (reviewer, Sep 15 — one mention, one delivery);
        // no Slack ID on file, and those fallbacks fire as before while the
        // office is nudged once a week. The owner's text is his own switch
        // on /settings and is not touched by the DM either way.
        const dmSent = t.slackDm ? await bridgeSlackDm(t, tmId, slackDmDone) : false;
        // THE OWNER'S TEXT (Jordan, Sep 11: "make sure I get a text when a
        // video is in review or I'm mentioned in a chat"). A cut landing in the
        // Review Room rings OWNER+ADMIN as a broadcast; a mention rings his
        // tm: row. Either way the row reaches him — so the row itself is the
        // trigger and the dedupe, no second bell. Which kinds he wants is his
        // switch on /settings (smsPrefs.ts; no row = both ON). The line is the
        // emitter's own sentence (ownerSms) so the text reads "Video in review
        // — 1033 Preserve Ln (Kim, v2). <link>" rather than a bell title. Same
        // queue as the photographers': quiet hours and the 30-minute digest
        // apply, and a text that can't go out yet waits in PendingSms.
        const { ownerSmsRecipient } = await import("@/lib/smsPrefs");
        const owner = await ownerSmsRecipient(n.kind, { tmId, roles });
        // Only a row that brought its own sentence texts him. An emitter that
        // leaves ownerSms off is saying "bell only": the owner's own upload,
        // a self-tag (reviewer, Sep 11) — and a future emitter of these kinds
        // that has not yet thought about his phone stays quiet by default.
        if (owner.textTo && t.ownerSms) {
          await queueStaffSms(owner.textTo, t.ownerSms);
        }
        // …and bridge person-addressed photographer rows to SMS so shoot changes
        // reach the field without push. NOT for the owner's own row on a kind
        // his switch governs: Jordan is PHOTOGRAPHER on the roster, and the
        // switch has to be the only thing deciding whether he is texted.
        if (!dmSent && !owner.ownerRow && SMS_KINDS.has(n.kind) && tmId && roles.includes("PHOTOGRAPHER")) {
          await smsPhotographer(tmId, title, href);
        }
        // …and bridge person-addressed EDITOR rows (editor:<key>) to Slack/SMS so
        // raws-landed / a revision / a review-back reaches Kim/Remar in Manila.
        // A DM that already landed IS their channel for this event.
        if (EDITOR_CHANNEL_KINDS.has(n.kind) && t.userKey?.startsWith("editor:") && roles.includes("EDITOR")) {
          const channel = dmSent ? "slack" : await channelForEditor(t.userKey.slice(7), title, href);
          bridged.push({ userKey: t.userKey, channel });
        }
        // A NEW editor-addressed bell row with no login to see it → nudge Jordan
        // once (deduped inside) to send that editor their Hub invite.
        if (t.userKey?.startsWith("editor:")) {
          try {
            const { ensureEditorLoginNudge } = await import("@/lib/tasks");
            await ensureEditorLoginNudge(t.userKey.slice(7));
          } catch { /* the nudge must never break the bell */ }
        }
      } catch (e) {
        // Unique violation on dedupeKey = this event was already announced —
        // silently skip (recurring events put the changing part IN the key, e.g.
        // a reschedule's new startAt). Anything else is logged but still swallowed.
        if ((e as { code?: string } | null)?.code !== "P2002") {
          console.warn("notifyInApp failed", n.kind, e);
        }
      }
    }
  } catch (e) {
    console.warn("notifyInApp failed", n.kind, e);
  }
  return { bridged, silenced };
}

// The Slack leg of a person-addressed bell row (see the call in notifyInApp).
// Resolves the person (tm:<id> directly; editor:<key> through the roster),
// DMs their Slack ID, or — with no ID — raises the weekly People nudge.
// Returns whether a DM reached this person for this event — on THIS row or
// an earlier one (an editor's tm: row DMs, their editor: row then learns it
// landed and skips its text fallback). A refused DM counts as not sent, so
// the fallbacks still carry the ping. Best-effort by contract: the note or
// message that carried the mention is already saved, so nothing here may
// throw past the bell.
async function bridgeSlackDm(t: NotifyTarget, tmId: string | null, done: Map<string, boolean>): Promise<boolean> {
  try {
    let personId = tmId;
    if (!personId && t.userKey?.startsWith("editor:")) {
      const { editorTeamMemberId } = await import("@/lib/editors");
      personId = await editorTeamMemberId(t.userKey.slice(7));
    }
    if (!personId) return false;
    if (done.has(personId)) return done.get(personId) === true;
    done.set(personId, false); // one DM (or one nudge) per person per event, whatever happens below
    const member = await prisma.teamMember.findUnique({ where: { id: personId }, select: { name: true, slackId: true } });
    if (!member) return false;
    if (member.slackId) {
      const { slackDmUser } = await import("@/lib/integrations/slack");
      const sent = await slackDmUser(member.slackId, t.slackDm ?? "");
      if (!sent) console.warn("slack mention DM failed (bell row kept)", member.name);
      done.set(personId, sent);
      return sent;
    }
    await nudgeMissingSlackId(personId, member.name);
    return false;
  } catch (e) {
    console.warn("slack mention DM bridge failed (bell row kept)", e);
    return false;
  }
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
    // The guided Today walkthrough is gone (Sep 1 restructure) — land on the
    // Other tab, where the listed to-dos actually live.
    lines.push(`${appBase()}/tasks?tab=other`);
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
