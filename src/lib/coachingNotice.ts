import { prisma } from "@/lib/prisma";
import { escapeSlack, scrubMoney } from "@/lib/text";
import { appBase } from "@/lib/appUrl";
import { etDayKey, etMonthDayTime, etTime } from "@/lib/datetime";
import type { DevGroupKey, DevItemView, DevLog } from "@/lib/teamDevelopment";

// ---------------------------------------------------------------------------
// COACHING REACHES THE PERSON (Oct 29 2026, Jordan's call table: "You could
// log an improvement, but could not establish where Harrison would see it or
// whether he was notified. Put reviewed feedback in his Hub and send a text
// with a direct link.")
//
// Feedback, a follow-up or a verified improvement recorded on a coaching item
// (app/creativeDeskActions) now:
//   · shows on the person's own page: a field creative's "My quality notes"
//     (/shoot/feedback#coaching), everyone else's /my-coaching
//     (components/coaching/MyCoachingList);
//   · rings their bell with that link, and goes on to Slack or a text by
//     their own switch for the event (notifyPrefs: field creatives and the
//     office on "Shoot changes & feedback", editors on "Job pings"), held for
//     their quiet time like any other ping. The sentence is money-scrubbed and
//     laid out for a phone by the text queue (hubSms.staffTextLayout);
//   · keeps the bell row's key on the log line (`notice`), so the coaching
//     entry says how it went: "Harrison was texted at 5:12 PM", "Slack DM at
//     …", "text held for quiet time until …", or why nothing went.
// ---------------------------------------------------------------------------

/** Field creatives and the office: their "Shoot changes & feedback" switch. */
export const COACHING_KIND = "coaching_feedback";
/** Editors: their "Job pings" switch (Slack by default). */
export const COACHING_KIND_EDITOR = "coaching_feedback_editor";

export type NoticeWhat = "created" | "feedback" | "follow_up" | "verified";

export const coachingHref = (group: DevGroupKey) => (group === "FIELD" ? "/shoot/feedback#coaching" : "/my-coaching");
export const noticeKey = (itemId: string, logIndex: number) => `coaching:${itemId}:${logIndex}`;

const first = (n: string) => n.trim().split(/\s+/)[0] || n;
const plain = (s: string, max: number) => {
  const t = scrubMoney(s.replace(/\s+/g, " ").replace(/\s*[—–]\s*/g, ", ").trim());
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/** The sentence and where it points, for one note (pure, for the drill). */
export function noticeWords(o: { personName: string; group: DevGroupKey; skill: string; what: NoticeWhat; by: string; note: string | null }) {
  const by = first(o.by);
  const skill = plain(o.skill.replace(/^Photo check:\s*/i, "Photo check, "), 80);
  const head =
    o.what === "follow_up" ? `${by} followed up on your coaching: ${skill}`
    : o.what === "verified" ? `${by} marked your coaching improved: ${skill}`
    : `${by} left you coaching feedback: ${skill}`;
  const href = coachingHref(o.group);
  const quote = o.note ? plain(o.note, 160) : "";
  const slackDm = [escapeSlack(head), quote ? `>${escapeSlack(quote)}` : null, `Read it in the hub: ${appBase()}${href}`].filter(Boolean).join("\n");
  return { title: plain(head, 90), slackDm, href };
}

/**
 * Ring the person's bell and their own channel. Never throws: the coaching
 * record stands whatever happens to the notice, and the entry says so.
 */
export async function tellCreativeAboutCoaching(o: {
  itemId: string; personId: string; personName: string; group: DevGroupKey; skill: string;
  what: NoticeWhat; by: string; note: string | null; notice: string; actorTeamMemberId?: string | null;
}): Promise<void> {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const w = noticeWords(o);
    const editorKey = o.personId.startsWith("editor:") ? o.personId.slice(7) : null;
    const userKey = editorKey ? `editor:${editorKey}` : `tm:${o.personId}`;
    const roles = o.group === "FIELD" ? (["PHOTOGRAPHER"] as const) : o.group === "EDITOR" ? (["EDITOR"] as const) : (["ADMIN"] as const);
    await notifyInApp({
      kind: o.group === "EDITOR" ? COACHING_KIND_EDITOR : COACHING_KIND,
      title: w.title,
      href: w.href,
      targets: [{ roles: [...roles], userKey, href: w.href, slackDm: w.slackDm }],
      dedupeKey: o.notice,
      actorTeamMemberId: o.actorTeamMemberId ?? null,
    });
  } catch (e) {
    console.warn("coaching notice failed", o.itemId, (e as Error)?.message);
  }
}

// ---- how it went, in words -------------------------------------------------------------

type Leg = { channel: string; status: string; detail: string | null; createdAt: Date };

function when(d: Date, now: Date): string {
  return etDayKey(d) === etDayKey(now) ? etTime(d) : etMonthDayTime(d);
}

/** "Harrison was texted at 5:12 PM" and the like, from the delivery log (pure, for the drill). */
export function toldWords(name: string, legs: Leg[], pending: Map<string, { sentAt: Date | null; deferUntil: Date | null; skippedAt: Date | null; skipReason: string | null }>, now: Date): string {
  const who = first(name);
  if (!legs.length) return `${who} has not been told yet`;
  const parts: string[] = [];
  const sms = legs.filter((l) => l.channel === "sms");
  const slack = legs.filter((l) => l.channel === "slack");
  const smsSent = sms.find((l) => l.status === "sent");
  const queued = sms.find((l) => l.status === "queued");
  const p = queued?.detail ? pending.get(queued.detail) : undefined;
  if (smsSent) parts.push(`was texted at ${when(smsSent.createdAt, now)}`);
  else if (p?.skippedAt) parts.push(`could not be texted${p.skipReason ? ` (${plain(p.skipReason, 60)})` : ""}`);
  else if (p?.deferUntil && p.deferUntil > now && !p.sentAt) parts.push(`gets the text after their quiet time, ${when(p.deferUntil, now)}`);
  else if (p?.sentAt) parts.push(`was texted at ${when(p.sentAt, now)}`);
  else if (queued) parts.push("has a text on its way");
  else if (sms.some((l) => l.status === "failed")) parts.push("could not be texted (the text failed)");
  else if (sms.some((l) => l.status === "skipped")) parts.push(`was not texted (${plain(sms.find((l) => l.status === "skipped")?.detail ?? "skipped", 60)})`);
  const dm = slack.find((l) => l.status === "sent");
  if (dm) parts.push(`got a Slack DM at ${when(dm.createdAt, now)}`);
  else if (slack.some((l) => l.status === "queued")) parts.push("gets a Slack DM after their quiet time");
  else if (slack.some((l) => l.status === "failed")) parts.push("could not be sent a Slack DM");
  if (!parts.length) {
    return legs.some((l) => l.channel === "bell")
      ? `${who} has it in the hub bell only: their switch for this is off, so no text or Slack went`
      : `${who} has not been told yet`;
  }
  return `${who} ${parts.join(" and ")}`;
}

/** Fill `told` on every log line that carries a notice (one read for all of them). */
export async function attachToldWords(items: DevItemView[], now = new Date()): Promise<void> {
  const lines: { item: DevItemView; line: DevLog }[] = [];
  for (const item of items) for (const line of item.log) if (line.notice) lines.push({ item, line });
  if (!lines.length) return;
  const rows = await prisma.notification.findMany({ where: { dedupeKey: { in: lines.map((l) => `${l.line.notice}-0`) } }, select: { id: true, dedupeKey: true } });
  const idOf = new Map(rows.map((r) => [r.dedupeKey!.replace(/-0$/, ""), r.id]));
  const legs = idOf.size
    ? await prisma.notificationDelivery.findMany({ where: { notificationId: { in: [...idOf.values()] } }, select: { notificationId: true, teamMemberId: true, channel: true, status: true, detail: true, createdAt: true }, orderBy: { createdAt: "asc" } })
    : [];
  const pendingIds = legs.filter((l) => l.channel === "sms" && l.status === "queued" && l.detail).map((l) => l.detail!);
  const pend = pendingIds.length
    ? await prisma.pendingSms.findMany({ where: { id: { in: pendingIds } }, select: { id: true, sentAt: true, deferUntil: true, skippedAt: true, skipReason: true } })
    : [];
  const pending = new Map(pend.map((p) => [p.id, p]));
  for (const { item, line } of lines) {
    const id = idOf.get(line.notice!);
    if (!id) {
      // Written moments ago and still going out (the notice runs after the save), or it never could.
      line.told = now.getTime() - Date.parse(line.at) < 120_000 ? `Telling ${first(item.personName)} now` : `${first(item.personName)} has not been told: the notice did not go out`;
      continue;
    }
    line.told = toldWords(item.personName, legs.filter((l) => l.notificationId === id), pending, now);
  }
}
