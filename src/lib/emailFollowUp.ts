import "server-only";
import { prisma } from "@/lib/prisma";
import { emailSlaRules, emailSlaSince, findUnansweredInbound, pagerView, type UnansweredInbound } from "@/lib/commsSla";
import { coverageRules, coveredHoursBetween } from "@/lib/coverage";
import { notifyInApp, notifyStaffSms } from "@/lib/notify";

// ---------------------------------------------------------------------------
// KYLE'S EMAIL FOLLOW-UP (Oct 14 2026).
//
// Jordan: "Sometimes both Kyle and I get emailed. If Kyle responds on his end,
// close it out on my end. If he forgets to follow up, remind him."
//
// The first half is the walk's job (replyQueue.ts) once our replies are on
// record from every inbox (staffEmail.ts, google.ts): any teammate's reply
// after the client's last message clears the thread everywhere. This file is
// the second half, and the one rule that decides whose a thread is:
//
//   A THREAD IS KYLE'S when the still-unanswered email landed in an inbox Kyle
//   holds (hello@ — his login and his roster email). "Holds" is read off the
//   roster, not a hard-coded address: the inbox's address is a TeamMember's or
//   an active login's email, and the holder is not the owner. A thread that
//   only reached info@ stays Jordan's and nothing here touches it.
//
// For a thread that is Kyle's, with the email alerts on and `kyleFollowUp` on:
//   · at `kyleCoveredHours` (4) of covered time unanswered → ONE follow-up task
//     on Kyle's list (dedupe key per sender group) and his bell. The bell uses
//     the email lane's own tier-1 key, so it is the same single bell the lane
//     always rang, never a second one;
//   · at `kyleEscalateCoveredHours` (13: the reminder plus a full covered day)
//     still unanswered → ONE Slack DM to Kyle (notifyStaffSms: Slack first,
//     his own quiet time honoured), at most once per waiting episode;
//   · Jordan is not reminded (commsSla.sweepEmailSla skips his tier for it;
//     an UNHAPPY client still reaches him) and his Home card files the row
//     under "Kyle has it" instead of "waiting";
//   · the moment the walk stops showing the thread — a reply from anyone, a
//     Handled tick — the task closes itself. That runs whether or not the
//     switch is on: a task that says somebody is waiting when nobody is, is a
//     wrong list (the desk-truth rule, programDeskTasks.ts).
//
// Nothing here writes to a client. Bell, task, and one internal DM.
// ---------------------------------------------------------------------------

export const EMAIL_FOLLOWUP_SOURCE = "email_followup";
const DONE = ["COMPLETED", "CANCELLED"];
/** The walk's own window — what Jordan's card shows is what this lane sees. */
const WINDOW_DAYS = 7;

export const followUpKey = (clientId: string, groupKey: string) => `email-followup:${clientId}:${groupKey}`;
const escalationKey = (taskKey: string, episodeISO: string) => `email-followup-dm:${taskKey}@${episodeISO}`;

export type InboxHolder = { mailbox: string; teamMemberId: string; name: string; isOwner: boolean };

/** Who holds each of these inboxes, off the roster: the TeamMember whose email
 *  it is, or the TeamMember linked to the active login whose email it is. The
 *  owner flag comes from the login's role. An inbox nobody holds is absent. */
export async function inboxHolders(mailboxes: string[]): Promise<Map<string, InboxHolder>> {
  const out = new Map<string, InboxHolder>();
  const want = [...new Set(mailboxes.map((m) => m.trim().toLowerCase()).filter((m) => m.includes("@")))];
  if (!want.length) return out;
  const ci = want.map((m) => ({ email: { equals: m, mode: "insensitive" as const } }));
  const [members, logins] = await Promise.all([
    prisma.teamMember.findMany({ where: { active: true, OR: ci }, select: { id: true, name: true, email: true } }),
    prisma.appUser.findMany({ where: { status: "ACTIVE", OR: ci }, select: { email: true, role: true, teamMemberId: true } }),
  ]);
  const ownerMembers = new Set(
    (await prisma.appUser.findMany({ where: { status: "ACTIVE", role: "OWNER", teamMemberId: { not: null } }, select: { teamMemberId: true } }))
      .map((u) => u.teamMemberId as string),
  );
  const memberById = new Map<string, { id: string; name: string }>();
  const linked = logins.map((l) => l.teamMemberId).filter((x): x is string => !!x);
  if (linked.length) {
    for (const m of await prisma.teamMember.findMany({ where: { id: { in: linked }, active: true }, select: { id: true, name: true } })) memberById.set(m.id, m);
  }
  for (const mb of want) {
    const login = logins.find((l) => l.email.toLowerCase() === mb);
    const member = members.find((m) => m.email.toLowerCase() === mb) ?? (login?.teamMemberId ? memberById.get(login.teamMemberId) : undefined);
    if (!member) continue;
    out.set(mb, {
      mailbox: mb,
      teamMemberId: member.id,
      name: member.name,
      isOwner: login?.role === "OWNER" || ownerMembers.has(member.id),
    });
  }
  return out;
}

/** The teammate a thread is held by: the first non-owner holder among the
 *  inboxes it landed in. Null when only the owner's inbox got it. */
export function holderOf(inboxes: string[], holders: Map<string, InboxHolder>): InboxHolder | null {
  for (const mb of [...inboxes].map((m) => m.toLowerCase()).sort()) {
    const h = holders.get(mb);
    if (h && !h.isOwner) return h;
  }
  return null;
}

/** threadKey → holder, for waiting EMAIL threads only. */
export async function holdersForThreads(list: Pick<UnansweredInbound, "threadKey" | "inboxes" | "family">[]): Promise<Map<string, { teamMemberId: string; name: string }>> {
  const out = new Map<string, { teamMemberId: string; name: string }>();
  const email = list.filter((w) => w.family === "email" && w.inboxes.length);
  if (!email.length) return out;
  const holders = await inboxHolders(email.flatMap((w) => w.inboxes));
  for (const w of email) {
    const h = holderOf(w.inboxes, holders);
    if (h) out.set(w.threadKey, { teamMemberId: h.teamMemberId, name: h.name });
  }
  return out;
}

/** For the Home card: which waiting rows a teammate has, by thread — only
 *  while the follow-up lane is ON (off, nobody is reminding Kyle, so Jordan's
 *  card must keep showing them as waiting). Never throws. */
export async function teammateHeldThreads(list: Pick<UnansweredInbound, "threadKey" | "inboxes" | "family">[]): Promise<Map<string, { teamMemberId: string; name: string }>> {
  try {
    const rules = await emailSlaRules();
    if (!rules.enabled || !rules.kyleFollowUp) return new Map();
    return await holdersForThreads(list);
  } catch (e) {
    console.warn("teammate-held lookup failed (rows stay on the card)", e);
    return new Map();
  }
}

export type FollowUpCounts = { enabled: boolean; held: number; opened: number; belled: number; escalated: number; closed: number };

function fmtCovered(h: number): string {
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  if (whole === 0) return `${min}m`;
  return min ? `${whole}h ${min}m` : `${whole}h`;
}

/** `<threadKey>@<ISO>` — the waiting episode a task was raised for. */
function episodeOf(sourceDetail: string | null): string | null {
  const at = (sourceDetail ?? "").lastIndexOf("@");
  if (at < 0) return null;
  const iso = (sourceDetail as string).slice(at + 1);
  return isNaN(Date.parse(iso)) ? null : iso;
}

/** The every-5-minutes sweep (commsSla.sweepReplySla). Exported for the drill. */
export async function sweepEmailFollowUps(now: Date = new Date()): Promise<FollowUpCounts> {
  const rules = await emailSlaRules();
  const on = rules.enabled && rules.kyleFollowUp;
  const counts: FollowUpCounts = { enabled: on, held: 0, opened: 0, belled: 0, escalated: 0, closed: 0 };

  const open = await prisma.smartTask.findMany({
    where: { source: EMAIL_FOLLOWUP_SOURCE, status: { notIn: DONE } },
    select: { id: true, dedupeKey: true, clientId: true, sourceDetail: true },
  });
  if (!on && open.length === 0) return counts;

  const waiting = await findUnansweredInbound(now, { families: ["email"], windowDays: WINDOW_DAYS });
  const holders = await holdersForThreads(waiting);
  const held = waiting.filter((w) => holders.has(w.threadKey));
  counts.held = held.length;

  // ---- close: the thread is no longer waiting (answered, ticked, muted) ----
  const liveKeys = new Set(held.map((w) => followUpKey(w.clientId, w.groupKey)));
  const liveClients = new Set(held.map((w) => w.clientId));
  for (const t of open) {
    if (t.dedupeKey && liveKeys.has(t.dedupeKey)) continue;
    // A sender group's key can settle on a fuller name between sweeps; while
    // the same client still has a Kyle thread waiting, the task stays.
    if (t.clientId && liveClients.has(t.clientId)) continue;
    // Off the walk's window is not evidence of an answer — that task is left
    // for a person to close, never closed on silence.
    const ep = episodeOf(t.sourceDetail);
    if (ep && now.getTime() - Date.parse(ep) > WINDOW_DAYS * 86_400_000) continue;
    const r = await prisma.smartTask.updateMany({
      where: { id: t.id, status: { notIn: DONE } },
      data: { status: "COMPLETED", completedAt: now },
    });
    counts.closed += r.count;
  }

  if (!on) return counts;
  const since = await emailSlaSince(rules, now);
  if (!since) return counts;
  const cover = await coverageRules();
  const { appBase } = await import("@/lib/appUrl");

  // A holding line ("I'll get back to you", audit H4) is a follow-up only
  // once its answer is due, counted from then (commsSla.pagerView). It still
  // keeps an open follow-up open above: the thread is still waiting.
  for (const w of pagerView(held, now)) {
    // The backlog — a wait that began before the email alerts were switched
    // on — is listed, never rung (the lane's own watermark).
    if (w.occurredAt.getTime() < since.getTime()) continue;
    const holder = holders.get(w.threadKey)!;
    const covered = coveredHoursBetween(w.occurredAt, now, cover);
    if (covered < rules.kyleCoveredHours) continue;

    const key = followUpKey(w.clientId, w.groupKey);
    const episode = w.occurredAt.toISOString();
    const subject = w.snippet.replace(/^Email:\s*/, "");
    const age = fmtCovered(covered);
    const title = `Follow up: ${w.clientName}'s email — "${subject.slice(0, 60)}"`.slice(0, 140);
    const description = [
      `${w.clientName} emailed and nobody on the team has replied yet (${age} of business hours).`,
      `Subject: ${subject}`,
      `Reply from your inbox (or tick it Handled on Tasks → Comms → Email if it was answered another way). This task closes itself when anyone replies.`,
    ].join("\n");
    const sourceDetail = `${w.threadKey}@${episode}`;
    const firstName = holder.name.trim().split(/\s+/)[0]?.toLowerCase() ?? null;

    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key }, select: { id: true, status: true, sourceDetail: true } });
    let taskId: string | null = null;
    if (!existing) {
      const created = await prisma.smartTask
        .create({
          data: {
            taskType: "todo", status: "OPEN", source: EMAIL_FOLLOWUP_SOURCE, sourceDetail, priority: "HIGH",
            title, summary: title, description,
            reasonCreated: `Client email in ${holder.name.split(" ")[0]}'s inbox unanswered for ${rules.kyleCoveredHours} business hours`,
            clientId: w.clientId, ownerId: holder.teamMemberId, assignedKey: firstName,
            dedupeKey: key, dueAt: now,
          },
          select: { id: true },
        })
        .catch(() => null); // a racing sweep made it — the bell below still dedupes
      if (created) { taskId = created.id; counts.opened++; }
    } else if (DONE.includes(existing.status)) {
      // Closed for THIS episode by a person → their call stands. A NEW
      // episode (the client wrote again after an answer) is new work.
      if (episodeOf(existing.sourceDetail) === episode) continue;
      await prisma.smartTask.update({
        where: { id: existing.id },
        data: { status: "OPEN", completedAt: null, title, summary: title, description, sourceDetail, ownerId: holder.teamMemberId, assignedKey: firstName, dueAt: now },
      });
      taskId = existing.id;
      counts.opened++;
    } else {
      taskId = existing.id;
      if (existing.sourceDetail !== sourceDetail) {
        await prisma.smartTask.update({ where: { id: existing.id }, data: { sourceDetail, description } }).catch(() => {});
      }
    }
    if (!taskId) continue;

    // The bell — on the email lane's tier-1 ledger key, so this IS the one
    // "Kyle's bell after 4 covered hours" and can never ring twice.
    const bellKey = `sla-e1-${w.clientId}-${episode}`;
    const rung = await prisma.notification.findUnique({ where: { dedupeKey: `${bellKey}-0` }, select: { id: true } });
    if (!rung) {
      await notifyInApp({
        kind: "reply_sla_email",
        title: `${w.clientName} — email waiting ${age} — "${subject.slice(0, 40)}"`,
        body: `No reply after ${age} of business hours. It's on your list as a follow-up.`,
        href: `/tasks?tab=other&task=${taskId}`,
        targets: [{ roles: ["ADMIN"], userKey: `tm:${holder.teamMemberId}` }],
        dedupeKey: bellKey,
      });
      counts.belled++;
    }

    // The one escalation: a Slack DM, at most once per waiting episode. The
    // claim row is written BEFORE the send, so two overlapping sweeps cannot
    // both send it.
    if (covered >= rules.kyleEscalateCoveredHours) {
      const claim = await prisma.appSetting
        .createMany({ data: [{ key: escalationKey(key, episode), value: now.toISOString() }], skipDuplicates: true })
        .catch(() => ({ count: 0 }));
      if (claim.count === 1) {
        // The email_followup template (Settings → Text messages, Oct 21 2026).
        const { loadTextTemplates } = await import("@/lib/textTemplateStore");
        await notifyStaffSms(
          [holder.teamMemberId],
          (await loadTextTemplates()).render("email_followup", { clientName: w.clientName, subject: subject.slice(0, 70), age, link: `${appBase()}/tasks?tab=other&task=${taskId}` }),
          "email_followup",
        ).catch((e) => console.warn("follow-up DM failed (the task and bell stand)", e));
        counts.escalated++;
      }
    }
  }
  return counts;
}
