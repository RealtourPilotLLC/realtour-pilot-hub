import "server-only";
import { prisma } from "@/lib/prisma";
import { noDashes } from "@/lib/text";

// ---------------------------------------------------------------------------
// LEADS GO TO KYLE, AND KYLE HEARS ABOUT THEM (Oct 14 2026 comms audit).
//
// A new caller, texter or emailer the hub does not recognise becomes ONE
// `lead` task per sender (openphone.ts upsertPhoneLeadTask, google.ts's Gmail
// lead). Those rows were minted with no assignedKey, so they sat in "Needs
// assigning" next to Slack to-dos while the person who calls leads back had
// nothing on his own list, and Jordan reminded him by hand.
//
//   · ASSIGNED: the lead goes to the DELIVERY duty owner (kyleNotice.kyleDesk:
//     the owner's login, its roster link, never a name search). When that does
//     not resolve the row stays unassigned exactly as before.
//   · AN EPISODE MARKER: `lead-episode:<taskId>` (AppSetting) records when THIS
//     lead was minted or reopened. The pings below count from it, so a lead
//     reopened by a new call next month gets its own two pings, and a lead
//     that existed before this shipped never gets any (no marker, no ping: the
//     backfill guard).
//   · TWO PINGS, IN COVERED TIME: a Slack DM (noticeForKyle: his bell row plus
//     the DM) at 15 and at 60 covered minutes while the lead is still OPEN,
//     only while somebody is on shift (coverage.ts). A 7:40 PM lead is pinged
//     at 9:15 the next covered morning, not at 7:55 PM. One AppSetting claim
//     per lead, per episode, per step: two sweeps racing claim once.
//   · SPAM: the only spam signal the hub has is a NUMBER muted as spam on the
//     Replies tab (replyQueue.commsMuteKey). An open lead from a muted number
//     that nobody touched for seven days is CANCELLED with the reason. Never
//     deleted, and email leads are left alone (there is no email spam signal).
// Staff only: nothing here writes to a client.
// ---------------------------------------------------------------------------

export const LEAD_EPISODE_PREFIX = "lead-episode:";
const LEAD_PING_PREFIX = "lead-ping:";
/** Covered minutes after a lead lands at which Kyle is pinged if it is still untouched. */
export const LEAD_PING_MINUTES = [15, 60] as const;
const SPAM_AFTER_DAYS = 7;
const DAY = 86_400_000;

/** Who a NEW lead row is filed to: Kyle's roster id and slug, or nobody. */
export async function leadAssignee(): Promise<{ ownerId: string | null; assignedKey: string | null }> {
  const { kyleDesk } = await import("@/lib/kyleNotice");
  const kyle = await kyleDesk();
  return { ownerId: kyle?.id ?? null, assignedKey: kyle?.key ?? null };
}

/**
 * Called right after a lead row is CREATED or REOPENED (never on a refresh of
 * an open one). Files a reopened row to Kyle when nobody holds it and no
 * person chose its assignee, and starts the episode the pings count from.
 * Never throws: lead capture must not fail on its bookkeeping.
 */
export async function startLeadEpisode(taskId: string, at: Date = new Date()): Promise<void> {
  try {
    const who = await leadAssignee();
    if (who.assignedKey) {
      await prisma.smartTask.updateMany({
        where: { id: taskId, taskType: "lead", assignedKey: null, assignedManually: false },
        data: { assignedKey: who.assignedKey, ownerId: who.ownerId },
      });
    }
    const key = `${LEAD_EPISODE_PREFIX}${taskId}`;
    const value = JSON.stringify({ at: at.toISOString() });
    await prisma.appSetting.upsert({ where: { key }, create: { key, value, updatedBy: "lead-desk" }, update: { value, updatedBy: "lead-desk" } });
  } catch (e) {
    console.warn("startLeadEpisode failed", taskId, e);
  }
}

const claim = async (key: string): Promise<boolean> => {
  try {
    await prisma.appSetting.create({ data: { key, value: new Date().toISOString(), updatedBy: "lead-desk" } });
    return true;
  } catch {
    return false; // already claimed (P2002), by an earlier sweep or its twin
  }
};


export type LeadPingResult = { checked: number; pinged: number; skipped?: string; sent: string[] };

/** The 15 and 60 covered-minute nudges. Every 5 minutes (cron/gmail). */
export async function sweepLeadPings(now: Date = new Date()): Promise<LeadPingResult> {
  const { internalAlertRules } = await import("@/lib/settings");
  const rules = await internalAlertRules();
  if (!rules.leadPing.enabled) return { checked: 0, pinged: 0, skipped: "switched off (Settings, Internal alerts, New lead pings)", sent: [] };
  const { withinCoverageAt, coveredMsBetween } = await import("@/lib/coverage");
  if (!withinCoverageAt(now, rules.coverage)) return { checked: 0, pinged: 0, skipped: "outside covered hours", sent: [] };

  // Episodes from the last week only: a lead untouched longer than that is the
  // board's problem (and the spam rule's), not a 15-minute nudge.
  const markers = await prisma.appSetting.findMany({
    where: { key: { startsWith: LEAD_EPISODE_PREFIX }, updatedAt: { gte: new Date(now.getTime() - 7 * DAY) } },
    select: { key: true, value: true },
  });
  const episodeOf = new Map<string, Date>();
  for (const m of markers) {
    try {
      const at = new Date((JSON.parse(m.value) as { at?: string }).at ?? "");
      if (!isNaN(at.getTime())) episodeOf.set(m.key.slice(LEAD_EPISODE_PREFIX.length), at);
    } catch { /* an unreadable marker is no episode */ }
  }
  if (episodeOf.size === 0) return { checked: 0, pinged: 0, sent: [] };
  // OPEN only: IN_PROGRESS, waiting, completed and cancelled are all a person
  // (or the outbound-reply close) having touched it.
  const leads = await prisma.smartTask.findMany({
    where: { id: { in: [...episodeOf.keys()] }, taskType: "lead", status: "OPEN" },
    select: { id: true, title: true, summary: true, sourceDetail: true },
  });
  const { noticeForKyle } = await import("@/lib/kyleNotice");
  const { appBase } = await import("@/lib/appUrl");
  const { scrubMoney } = await import("@/lib/text");
  let pinged = 0;
  const sent: string[] = [];
  for (const lead of leads) {
    const at = episodeOf.get(lead.id)!;
    if (at.getTime() > now.getTime()) continue;
    const covered = coveredMsBetween(at, now, rules.coverage) / 60_000;
    const due = LEAD_PING_MINUTES.filter((m) => covered >= m);
    if (due.length === 0) continue;
    // Claim every step that is due; only the highest one claimed here speaks
    // (a sweep that missed the 15 because the cron was down sends the 60 once,
    // and never a stale 15 afterwards).
    let top: number | null = null;
    for (const m of due) {
      if (await claim(`${LEAD_PING_PREFIX}${lead.id}:${at.toISOString()}:${m}`)) top = top === null ? m : Math.max(top, m);
    }
    if (top === null) continue;
    const href = `/tasks?tab=work&type=lead&task=${lead.id}`;
    const said = (lead.summary ?? "").match(/[“"]([^”"]{3,160})[”"]/)?.[1] ?? null;
    const age = top >= 60 ? "an hour" : `${top} minutes`;
    const text = noDashes(scrubMoney(
      `New lead still waiting after ${age} of office time: ${lead.title}.${said ? ` They said: "${said}".` : ""} Call or text them back, then mark the task done. ${appBase()}${href}`,
    ));
    await noticeForKyle({
      kind: "lead_waiting",
      title: noDashes(`Lead waiting ${age}: ${lead.title}`).slice(0, 90),
      body: "Still untouched. Call or text them back.",
      href,
      dedupeKey: `lead-ping-${lead.id}-${at.getTime()}-${top}`,
      slack: text,
    });
    pinged++;
    sent.push(`${lead.id}@${top}`);
  }
  return { checked: leads.length, pinged, sent };
}

/** Open lead rows from a number muted as spam, untouched for seven days → CANCELLED. Hourly. */
export async function cancelSpamLeads(now: Date = new Date()): Promise<{ cancelled: number }> {
  const mutes = await prisma.appSetting.findMany({ where: { key: { startsWith: "comms-mute:" } }, select: { key: true } });
  const phones = mutes.map((m) => m.key.slice("comms-mute:".length)).filter((p) => /^\d{10}$/.test(p));
  if (phones.length === 0) return { cancelled: 0 };
  const cutoff = new Date(now.getTime() - SPAM_AFTER_DAYS * DAY);
  const candidates = await prisma.smartTask.findMany({
    where: { taskType: "lead", status: "OPEN", dedupeKey: { in: phones.map((p) => `lead-${p}`) }, assignedManually: false, flaggedAt: null },
    select: { id: true, createdAt: true, summary: true },
  });
  if (candidates.length === 0) return { cancelled: 0 };
  const episodes = await prisma.appSetting.findMany({
    where: { key: { in: candidates.map((c) => `${LEAD_EPISODE_PREFIX}${c.id}`) } },
    select: { key: true, value: true },
  });
  const startOf = new Map<string, Date>();
  for (const e of episodes) {
    try {
      const at = new Date((JSON.parse(e.value) as { at?: string }).at ?? "");
      if (!isNaN(at.getTime())) startOf.set(e.key.slice(LEAD_EPISODE_PREFIX.length), at);
    } catch { /* fall back to createdAt */ }
  }
  let cancelled = 0;
  for (const c of candidates) {
    const since = startOf.get(c.id) ?? c.createdAt;
    if (since > cutoff) continue;
    // Compare-and-set on OPEN: a person who picks it up this second wins.
    const r = await prisma.smartTask.updateMany({
      where: { id: c.id, status: "OPEN" },
      data: {
        status: "CANCELLED",
        summary: `Auto-closed: this number is muted as spam on the Replies tab and the lead sat untouched for ${SPAM_AFTER_DAYS} days.${c.summary ? `\n${c.summary}` : ""}`.slice(0, 500),
      },
    });
    cancelled += r.count;
  }
  return { cancelled };
}

/** Open leads for a Home viewer: the owner sees every one; anyone else the
 *  leads filed to them plus the ones nobody holds. Oldest first. */
export async function openLeadsFor(viewer: { isOwner: boolean; key: string | null; teamMemberId: string | null }): Promise<{ id: string; title: string; createdAt: Date }[]> {
  const mine = [
    { assignedKey: null },
    ...(viewer.key ? [{ assignedKey: viewer.key }] : []),
    ...(viewer.teamMemberId ? [{ ownerId: viewer.teamMemberId }] : []),
  ];
  return prisma.smartTask.findMany({
    where: { taskType: "lead", status: { notIn: ["COMPLETED", "CANCELLED"] }, ...(viewer.isOwner ? {} : { OR: mine }) },
    select: { id: true, title: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
}
