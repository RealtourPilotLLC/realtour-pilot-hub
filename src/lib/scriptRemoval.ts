// ---------------------------------------------------------------------------
// REMOVE A SCRIPT FROM THE MONTH (Oct 26 2026). Jordan: "Can you add an option
// for me to remove a script from the month?" A script's topic otherwise stays
// on the month for good once it has a script ("This topic already has a script
// or footage for this month, so it stays on the month").
//
// WHAT ONE PRESS DOES (the same withdrawal Send Question Request uses,
// questionRequests.ts, so every queue, count, sweep, writer and the portal
// already read it as "not this month's script"):
//   · refuses imported history and a script tied to a video or footage;
//   · a script on the client's portal is pulled back first (the house pull
//     back, contentScripts.returnScriptToQueue, with the reason), so it leaves
//     the portal the way every pull back does;
//   · the script steps off the month and the topic and reads WITHDRAWN, with
//     its live versions; NOTHING is deleted;
//   · the topic's pick for the month is REMOVED (reason SCRIPT_REMOVED) and the
//     topic goes back to the bank (SAVED, or SCRIPTED when another script for
//     it exists elsewhere), so the slot opens for another topic;
//   · the ledger is a ContentScriptRelease row (action REMOVED_FROM_MONTH):
//     who, when, why, and everything Put it back needs.
//
// PUT IT BACK restores the script, its versions, the pick and the topic as
// they were, except the portal: a script pulled off the portal comes back to
// the review queue and is never re-sent on its own (Jordan's rule). Refused
// once the topic has another script on the month or sits on another month.
// ---------------------------------------------------------------------------
import { prisma } from "@/lib/prisma";
import { recordTopicEvent, reconcileMonthExtras, type Actor } from "@/lib/contentTopics";

export const REMOVED_FROM_MONTH = "REMOVED_FROM_MONTH";
const WITHDRAWN = "WITHDRAWN";
const LIVE_SELECTION = ["SELECTED", "RECONCILED", "CARRIED", "PROPOSED"];
const LIVE_VERSION = ["DRAFT", "INTERNAL_REVIEW", "APPROVED", "SHARED"];
const FOOTAGE_VIDEO_STATUSES = ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"];

export type RemovalLedger = {
  v: 1;
  state: "REMOVED" | "PUT_BACK";
  monthId: string;
  monthKey: string;
  topicId: string | null;
  title: string;
  reason: string | null;
  /** It was on the client's portal and was pulled back first. */
  pulledFromPortal: boolean;
  removedBy: string;
  removedByName: string | null;
  putBackBy?: string;
  putBackAt?: string;
  prior: {
    script: { monthId: string; topicId: string | null; interviewId: string | null; status: string; releaseState: string | null; approvedVersionId: string | null; approvedAt: string | null; approvedBy: string | null };
    versions: Record<string, string>;
    selection: { id: string; status: string; rank: number | null; overflow: boolean } | null;
    topic: { monthId: string | null; status: string } | null;
  };
};

type By = { email: string; appUserId?: string | null; name?: string | null };
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const date = (s: string | null | undefined) => (s ? new Date(s) : null);
const staffOf = (by: By): Actor => ({ kind: "STAFF", staffUserId: by.appUserId ?? by.email });

export function readRemovalLedger(note: string | null | undefined): RemovalLedger | null {
  if (!note) return null;
  try {
    const v = JSON.parse(note) as RemovalLedger;
    return v && v.v === 1 && v.prior?.script ? v : null;
  } catch {
    return null;
  }
}

/** Why a script can't come off its month, in words; null when it can. */
export async function removalRefusal(scriptId: string): Promise<string | null> {
  const s = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { historical: true, status: true, monthId: true, topicId: true, videoId: true } });
  if (!s) return "That script isn't there any more. Reload the page.";
  if (s.historical) return "Imported history stays where it is.";
  if (s.status === WITHDRAWN) return "This script is already off the month.";
  if (!s.monthId) return "This script isn't on a month.";
  const video = s.videoId ?? (await prisma.contentVideo.findFirst({ where: { scriptId }, select: { id: true } }))?.id
    ?? (s.topicId ? (await prisma.contentVideo.findFirst({ where: { topicId: s.topicId, monthId: s.monthId, OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: FOOTAGE_VIDEO_STATUSES } }] }, select: { id: true } }))?.id : null);
  if (video) return "This one is tied to a video that was filmed, so it stays on the month.";
  return null;
}

/** Take a script off its month. Returns the ledger row's id (Put it back). */
export async function removeScriptFromMonth(scriptId: string, by: By, reason: string | null): Promise<{ removalId: string; monthId: string; enrollmentId: string; pulledFromPortal: boolean }> {
  const refused = await removalRefusal(scriptId);
  if (refused) throw new Error(refused);
  let s = await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptId } });
  const why = (reason ?? "").trim() || null;
  const onPortal = !!s.sharedVersionId && s.releaseState === "released";
  if (onPortal && !why) throw new Error("Say why it comes off their portal. The reason is kept with the script's history.");
  // 1 · Off the portal first, the way every pull back is done (its own ledger row).
  if (onPortal) {
    const { returnScriptToQueue } = await import("@/lib/contentScripts");
    await returnScriptToQueue(scriptId, { email: by.email, appUserId: by.appUserId ?? null }, `Removed from the month: ${why}`);
    s = await prisma.contentScript.findUniqueOrThrow({ where: { id: scriptId } });
  }
  const monthId = s.monthId!;
  const [month, versions, sel, topic] = await Promise.all([
    prisma.contentMonth.findUniqueOrThrow({ where: { id: monthId }, select: { monthKey: true } }),
    prisma.contentScriptVersion.findMany({ where: { scriptId }, select: { id: true, status: true } }),
    s.topicId ? prisma.contentTopicSelection.findUnique({ where: { topicId_monthId: { topicId: s.topicId, monthId } } }) : Promise.resolve(null),
    s.topicId ? prisma.contentTopic.findUnique({ where: { id: s.topicId }, select: { id: true, monthId: true, status: true, enrollmentId: true } }) : Promise.resolve(null),
  ]);
  const changed = versions.filter((v) => LIVE_VERSION.includes(v.status));
  const liveSel = sel && LIVE_SELECTION.includes(sel.status) ? sel : null;
  const ledger: RemovalLedger = {
    v: 1, state: "REMOVED", monthId, monthKey: month.monthKey, topicId: s.topicId, title: s.title, reason: why, pulledFromPortal: onPortal, removedBy: by.email, removedByName: by.name ?? null,
    prior: {
      script: { monthId, topicId: s.topicId, interviewId: s.interviewId, status: s.status, releaseState: s.releaseState, approvedVersionId: s.approvedVersionId, approvedAt: iso(s.approvedAt), approvedBy: s.approvedBy },
      versions: Object.fromEntries(changed.map((v) => [v.id, v.status])),
      selection: liveSel ? { id: liveSel.id, status: liveSel.status, rank: liveSel.rank, overflow: liveSel.overflow } : null,
      topic: topic ? { monthId: topic.monthId, status: topic.status } : null,
    },
  };
  // 2 · The withdrawal, the pick and the topic, in one transaction. Nothing is deleted.
  const removalId = await prisma.$transaction(async (tx) => {
    const moved = await tx.contentScript.updateMany({
      where: { id: scriptId, historical: false, status: s.status, monthId, currentVersionId: s.currentVersionId, sharedVersionId: null, videoId: null },
      data: { monthId: null, topicId: null, interviewId: null, status: WITHDRAWN, releaseState: "withheld", approvedVersionId: null, approvedAt: null, approvedBy: null },
    });
    if (moved.count !== 1) throw new Error("The script changed while it was being removed. Look at it again, then remove it if you still want to.");
    if (changed.length) await tx.contentScriptVersion.updateMany({ where: { id: { in: changed.map((v) => v.id) } }, data: { status: WITHDRAWN } });
    if (liveSel) await tx.contentTopicSelection.update({ where: { id: liveSel.id }, data: { status: "REMOVED", rank: null, removedAt: new Date(), removedBy: by.email, removedReason: "SCRIPT_REMOVED" } });
    if (topic && topic.monthId === monthId) {
      const other = await tx.contentScript.findFirst({ where: { topicId: topic.id, historical: false }, select: { id: true } });
      await tx.contentTopic.update({ where: { id: topic.id }, data: { monthId: null, ...(other ? {} : { status: "SAVED" }) } });
    }
    const rel = await tx.contentScriptRelease.create({
      data: { scriptId, scriptVersionId: s.currentVersionId ?? changed[0]?.id ?? versions[0]?.id ?? scriptId, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId, action: REMOVED_FROM_MONTH, actorAppUserId: by.appUserId ?? null, actorEmail: by.email, note: JSON.stringify(ledger) },
      select: { id: true },
    });
    return rel.id;
  });
  if (topic) {
    const after = await prisma.contentTopic.findUnique({ where: { id: topic.id }, select: { status: true } });
    await recordTopicEvent(topic.id, topic.enrollmentId, "DESELECTED", staffOf(by), { monthId, fromStatus: topic.status, toStatus: after?.status ?? topic.status, sourceRef: `ContentScriptRelease:${removalId}`, note: `Its script was removed from the month${why ? `: ${why}` : ""}` }).catch(() => null);
  }
  await reconcileMonthExtras(monthId, { by: by.email }).catch(() => null);
  return { removalId, monthId, enrollmentId: s.enrollmentId, pulledFromPortal: onPortal };
}

/** Put a removed script back on its month, as it was (never back on the portal by itself). */
export async function putScriptBack(removalId: string, by: By): Promise<{ monthId: string; enrollmentId: string; title: string; pulledFromPortal: boolean }> {
  const rel = await prisma.contentScriptRelease.findUnique({ where: { id: removalId } });
  const ledger = readRemovalLedger(rel?.note);
  if (!rel || rel.action !== REMOVED_FROM_MONTH || !ledger) throw new Error("That removal isn't on file.");
  if (ledger.state !== "REMOVED") throw new Error("Already put back.");
  const p = ledger.prior;
  if (p.script.topicId) {
    const fresh = await prisma.contentScript.findFirst({ where: { topicId: p.script.topicId, monthId: ledger.monthId, historical: false }, select: { id: true } });
    if (fresh) throw new Error("This topic has another script on the month now, so this one stays off. It's kept in its history.");
    const t = await prisma.contentTopic.findUnique({ where: { id: p.script.topicId }, select: { monthId: true } });
    if (t?.monthId && t.monthId !== ledger.monthId) {
      const other = await prisma.contentMonth.findUnique({ where: { id: t.monthId }, select: { monthKey: true } });
      throw new Error(`This topic is on ${other?.monthKey ?? "another month"} now, so it can't come back to this one.`);
    }
  }
  await prisma.$transaction(async (tx) => {
    const back = await tx.contentScript.updateMany({
      where: { id: rel.scriptId, status: WITHDRAWN, monthId: null },
      data: { monthId: p.script.monthId, topicId: p.script.topicId, interviewId: p.script.interviewId, status: p.script.status, releaseState: p.script.releaseState, approvedVersionId: p.script.approvedVersionId, approvedAt: date(p.script.approvedAt), approvedBy: p.script.approvedBy },
    });
    if (back.count !== 1) throw new Error("The script is not where the removal left it, so nothing was changed.");
    for (const [id, status] of Object.entries(p.versions)) await tx.contentScriptVersion.updateMany({ where: { id, scriptId: rel.scriptId, status: WITHDRAWN }, data: { status } });
    if (p.selection) await tx.contentTopicSelection.updateMany({ where: { id: p.selection.id }, data: { status: p.selection.status, rank: p.selection.rank, overflow: p.selection.overflow, removedAt: null, removedBy: null, removedReason: null, replacedByTopicId: null } });
    if (p.topic && p.script.topicId) await tx.contentTopic.update({ where: { id: p.script.topicId }, data: { monthId: p.topic.monthId, status: p.topic.status } });
    await tx.contentScriptRelease.update({ where: { id: rel.id }, data: { note: JSON.stringify({ ...ledger, state: "PUT_BACK", putBackBy: by.email, putBackAt: new Date().toISOString() } satisfies RemovalLedger) } });
  });
  if (p.script.topicId && p.topic) {
    const t = await prisma.contentTopic.findUnique({ where: { id: p.script.topicId }, select: { enrollmentId: true, status: true } });
    if (t) await recordTopicEvent(p.script.topicId, t.enrollmentId, "SELECTED", staffOf(by), { monthId: ledger.monthId, toStatus: t.status, sourceRef: `ContentScriptRelease:${rel.id}`, note: "Its script was put back on the month" }).catch(() => null);
  }
  await reconcileMonthExtras(ledger.monthId, { by: by.email }).catch(() => null);
  return { monthId: ledger.monthId, enrollmentId: rel.enrollmentId, title: ledger.title, pulledFromPortal: ledger.pulledFromPortal };
}

export type RemovedScriptUi = { removalId: string; title: string; reason: string | null; by: string; at: string; pulledFromPortal: boolean };

/** The month's removed scripts still off it, newest first (the Scripts tab's "Removed from this month"). */
export async function removedScriptsForMonth(monthId: string): Promise<RemovedScriptUi[]> {
  const rows = await prisma.contentScriptRelease.findMany({ where: { monthId, action: REMOVED_FROM_MONTH }, orderBy: { createdAt: "desc" }, take: 40 });
  const out: RemovedScriptUi[] = [];
  for (const r of rows) {
    const l = readRemovalLedger(r.note);
    if (!l || l.state !== "REMOVED") continue;
    out.push({ removalId: r.id, title: l.title, reason: l.reason, by: l.removedByName?.trim().split(/\s+/)[0] || l.removedBy, at: r.createdAt.toISOString(), pulledFromPortal: l.pulledFromPortal });
  }
  return out;
}
