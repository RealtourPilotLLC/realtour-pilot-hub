import "server-only";
import { prisma } from "@/lib/prisma";
import { slackNotify, slackChannels } from "@/lib/integrations/slack";
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
// Posting to a user id opens the bot's DM with him.
const KYLE_SLACK_ID = "U07SCBTPDC7";

function appBase(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")
  );
}

// Where alerts go: SLACK_ALERT_CHANNEL env (a channel id or #name) wins; else
// the ops channel the bot is already in (#rp-project-tracker family); else
// Kyle's DM. Cached ~1h so we don't list channels on every ping.
let destCache: { at: number; channel: string } | null = null;
export async function alertDestination(): Promise<string> {
  const env = process.env.SLACK_ALERT_CHANNEL;
  if (env) return env;
  if (destCache && Date.now() - destCache.at < 3600_000) return destCache.channel;
  let channel = KYLE_SLACK_ID;
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
export type NotifyTarget = { roles: Role[]; userKey?: string; href?: string }; // href overrides the default per row

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
  try {
    await prisma.pendingSms.create({ data: { teamMemberId, line: `${title} → ${appBase()}${href}` } });
    const recentSend = await prisma.pendingSms.findFirst({
      where: { teamMemberId, sentAt: { gte: new Date(Date.now() - SMS_BATCH_WINDOW_MS) } },
      select: { id: true },
    });
    // First ping in the window and daytime → deliver immediately (flushing
    // everything queued for them along the way). Otherwise the flusher cron
    // combines it into one message shortly.
    if (!recentSend && withinTextingHours()) await flushMemberSms(teamMemberId);
  } catch (e) {
    console.warn("smsPhotographer failed", e);
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
      ? `⚙️ RealTour Hub: ${mine[0].line}`
      : `⚙️ RealTour Hub — ${mine.length} updates:\n` + mine.map((r) => `• ${r.line}`).join("\n");
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
export async function flushPendingSms(): Promise<{ flushed: number }> {
  if (!withinTextingHours()) return { flushed: 0 };
  const pending = await prisma.pendingSms.groupBy({
    by: ["teamMemberId"],
    where: { sentAt: null },
    _min: { createdAt: true },
  });
  let flushed = 0;
  for (const p of pending) {
    const oldest = p._min.createdAt;
    if (!oldest) continue;
    const recentSend = await prisma.pendingSms.findFirst({
      where: { teamMemberId: p.teamMemberId, sentAt: { gte: new Date(Date.now() - SMS_BATCH_WINDOW_MS) } },
      select: { id: true },
    });
    if (recentSend && Date.now() - oldest.getTime() < SMS_BATCH_WINDOW_MS) continue;
    if (await flushMemberSms(p.teamMemberId)) flushed++;
  }
  return { flushed };
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
    const body = `⚙️ RealTour Hub: ${text}`;

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
}): Promise<{ bridged: Array<{ userKey: string; channel: EditorChannel }> }> {
  const bridged: Array<{ userKey: string; channel: EditorChannel }> = [];
  try {
    const title = n.title.slice(0, 90);
    for (let i = 0; i < n.targets.length; i++) {
      const t = n.targets[i];
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
        // Row is NEW (a dedupe hit threw P2002 above) — bridge person-addressed
        // photographer rows to SMS so shoot changes reach the field without push.
        if (SMS_KINDS.has(n.kind) && t.userKey?.startsWith("tm:") && roles.includes("PHOTOGRAPHER")) {
          await smsPhotographer(t.userKey.slice(3), title, href);
        }
        // …and bridge person-addressed EDITOR rows (editor:<key>) to Slack/SMS so
        // raws-landed / a revision / a review-back reaches Kim/Remar in Manila.
        if (EDITOR_CHANNEL_KINDS.has(n.kind) && t.userKey?.startsWith("editor:") && roles.includes("EDITOR")) {
          const channel = await channelForEditor(t.userKey.slice(7), title, href);
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
  return { bridged };
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
    const kyle = await prisma.teamMember.findFirst({
      where: { name: { contains: "Kyle", mode: "insensitive" }, active: true },
      select: { slackId: true },
    });
    const slackId = kyle?.slackId ?? KYLE_SLACK_ID;
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
    lines.push(`${appBase()}/tasks?tab=today&guided=1`);
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
    const kyle = await prisma.teamMember.findFirst({
      where: { name: { contains: "Kyle", mode: "insensitive" }, active: true },
      select: { slackId: true },
    });
    const slackId = kyle?.slackId ?? KYLE_SLACK_ID;
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
