import "server-only";
import { prisma } from "@/lib/prisma";
import { can } from "@/lib/portalAccess";
import { contentHref } from "@/lib/contentNav";
import { clip } from "@/lib/text";
import { appBase } from "@/lib/appUrl";
import type { PortalRole, PortalViewer } from "@/lib/portal";
import { UNSENT_NOTE_QUIET_MINUTES } from "@/components/portal/cutReviewCopy";

// ---------------------------------------------------------------------------
// A CLIENT'S NOTE ON A VIDEO GOES TO THE EDITOR (Oct 26 2026).
//
// Jordan: "Mike sent a revision so it should open up in the ops hub as
// revision status and the editor should see the notes etc".
//
// Mike Ciunci left a note at 0:19 on his Video 2 at 8:52 AM Oct 26 and emailed
// "i sent my note to you in the video. Hopefully it goes through this time."
// It never did: on the portal a note is saved with "Send note" and only reaches
// the editor when the client also presses "Request changes", and he never did
// (twice: his Oct 22 "I made an edit to the reel" went the same way).
// Bernadette Rabel on Oct 13 and Mike Flatley on Oct 24 (two notes) are the same
// miss. The page says so in a yellow line; clients read "Send note" as sending.
//
// So a note is a change request. A client's notes that are still unsent 15
// minutes after their LAST note on a video (time to add the rest, or to press
// the button themselves) are sent for them through the portal's own Request
// changes path (clientDecisions.requestChangesOnCut), as that client, under
// their own seat: the same revision round, fee rule, late rule, editor task,
// brief, bells and receipt as the button. A note added while a request is
// already open joins it as an addendum, the same way.
//
// WHAT IT NEVER DOES. Send a note our staff wrote in the owner view, a reply in
// a thread, or a note already resolved, sent, or bundled into an approval.
// Agree to an extra-round fee for anyone: a request that would need the fee
// acknowledged, a seat that may not request changes, a program that is paused,
// or anything else the portal itself would refuse, goes to Kyle (bell + Slack)
// with the client's words, so a person picks it up. A refusal that may clear
// (the hourly cap on change requests) is tried again on the next tick and
// handed to Kyle after two hours.
// ---------------------------------------------------------------------------

/** Minutes after the client's last note on a video before it is sent for them (the page says the same number). */
export { UNSENT_NOTE_QUIET_MINUTES };
/** Notes from here on are sent: Oct 23 2026 ET, so Mike Flatley's Oct 24 notes go too. */
export const UNSENT_NOTES_FROM = new Date("2026-10-23T04:00:00Z");
const GIVE_UP_MS = 2 * 3_600_000;

export type UnsentNotesRun = { considered: number; sent: number; toKyle: number; waiting: number; notes: string[] };

export async function sweepUnsentClientNotes(opts: { now?: Date; dryRun?: boolean; max?: number } = {}): Promise<UnsentNotesRun> {
  const now = opts.now ?? new Date();
  const out: UnsentNotesRun = { considered: 0, sent: 0, toKyle: 0, waiting: 0, notes: [] };
  const open = await prisma.portalComment.findMany({
    where: { status: "OPEN", parentId: null, decisionId: null, clientUserId: { not: null }, createdAt: { gte: UNSENT_NOTES_FROM } },
    select: { id: true, submissionId: true, enrollmentId: true, clientUserId: true, body: true, timeSec: true, createdAt: true },
    orderBy: { createdAt: "asc" },
    take: 300,
  });
  // One video at a time: everything the client left on it, sent together.
  const byCut = new Map<string, typeof open>();
  for (const n of open) byCut.set(`${n.enrollmentId}|${n.submissionId}`, [...(byCut.get(`${n.enrollmentId}|${n.submissionId}`) ?? []), n]);
  for (const notes of [...byCut.values()].slice(0, opts.max ?? 10)) {
    const last = notes[notes.length - 1];
    out.considered++;
    if (now.getTime() - last.createdAt.getTime() < UNSENT_NOTE_QUIET_MINUTES * 60_000) { out.waiting++; continue; } // still writing
    // Already with Kyle: his task now, not the next tick's.
    if (await prisma.notification.count({ where: { dedupeKey: `portal-unsent-notes:${last.submissionId}:${last.id}-0` } })) continue;
    const viewer = await clientViewer(last.enrollmentId, last.clientUserId!);
    const who = viewer.ok ? viewer.viewer.enrollment.clientName : viewer.clientName;
    const toKyle = async (why: string) => {
      out.notes.push(`${who}: ${why}`);
      if (opts.dryRun) return;
      if (await handToKyle({ enrollmentId: last.enrollmentId, submissionId: last.submissionId, lastId: last.id, clientName: who, why, notes })) out.toKyle++;
    };
    if (!viewer.ok) { await toKyle(viewer.why); continue; }
    if (!can(viewer.viewer, "requestChanges")) { await toKyle(viewer.viewer.access === "FULL" ? "the person who left it can't send change requests from their seat" : "the program is paused, so the portal can't send it"); continue; }
    if (opts.dryRun) { out.sent++; out.notes.push(`${who}: would send ${notes.length} note${notes.length === 1 ? "" : "s"} to the editor`); continue; }
    try {
      const { requestChangesOnCut } = await import("@/lib/clientDecisions");
      const r = await requestChangesOnCut(viewer.viewer, last.submissionId, "", { requestKey: `auto-notes-${last.id}` });
      if (r.ok) { out.sent++; out.notes.push(`${who}: sent to the editor${r.duplicate ? " (already sent)" : ""}`); continue; }
      const stale = now.getTime() - last.createdAt.getTime() > GIVE_UP_MS;
      if (("needsFeeAck" in r && r.needsFeeAck) || stale) await toKyle(r.message);
      else out.notes.push(`${who}: not sent yet (${r.message}); trying again`);
    } catch (e) {
      out.notes.push(`${who}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200)}`);
    }
  }
  return out;
}

/** The client's own portal identity for the person who wrote the note. */
async function clientViewer(enrollmentId: string, clientUserId: string): Promise<{ ok: true; viewer: PortalViewer } | { ok: false; why: string; clientName: string }> {
  const e = await prisma.contentEnrollment.findUnique({ where: { id: enrollmentId }, select: { id: true, clientId: true, status: true, videosPerMonth: true, sessionsPerMonth: true } });
  const clientName = e ? (await prisma.client.findUnique({ where: { id: e.clientId }, select: { name: true } }))?.name ?? "A client" : "A client";
  if (!e) return { ok: false, why: "the program is gone", clientName };
  const seat = await prisma.clientMembership.findFirst({ where: { enrollmentId, clientUserId, revokedAt: null }, select: { id: true, role: true } });
  const person = await prisma.clientUser.findUnique({ where: { id: clientUserId }, select: { email: true, name: true, status: true } });
  if (!seat || !person || person.status === "DISABLED") return { ok: false, why: "the person who left it no longer has a seat on the portal", clientName };
  return {
    ok: true,
    viewer: {
      enrollment: { id: e.id, clientId: e.clientId, clientName, status: e.status, videosPerMonth: e.videosPerMonth ?? 0, sessionsPerMonth: e.sessionsPerMonth ?? 0 },
      actor: { kind: "CLIENT", clientUserId, email: person.email, name: person.name, membershipId: seat.id, membershipRole: seat.role as PortalRole },
      access: e.status === "ACTIVE" ? "FULL" : "READ_ONLY",
      via: "LOGIN",
    },
  };
}

/** Kyle's bell and Slack DM, once per note run. True when this call raised it. */
async function handToKyle(n: { enrollmentId: string; submissionId: string; lastId: string; clientName: string; why: string; notes: { body: string; timeSec: number | null }[] }): Promise<boolean> {
  const cut = await prisma.reviewSubmission.findUnique({ where: { id: n.submissionId }, select: { fileName: true, round: true } });
  const at = (s: number | null) => (s == null ? "" : `[${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}] `);
  const words = n.notes.map((x) => `• ${at(x.timeSec)}${clip(x.body.replace(/\s+/g, " ").trim(), 300)}`).join("\n");
  const video = cut?.fileName ? `${cut.fileName} (v${cut.round})` : "a video";
  const href = contentHref(n.enrollmentId, { tab: "production", view: "videos" });
  const { noticeForKyle } = await import("@/lib/kyleNotice");
  const r = await noticeForKyle({
    kind: "portal_unsent_notes",
    title: `Notes not sent to the editor — ${n.clientName}`,
    body: `${n.clientName} left notes on ${video} that the hub could not send to the editor: ${n.why}\n${words}`,
    href,
    dedupeKey: `portal-unsent-notes:${n.submissionId}:${n.lastId}`,
    slack: `${n.clientName} left notes on ${video} that the hub could not send to the editor (${n.why}). Take a look: ${appBase()}${href}\n${words}`,
  });
  return r.bell;
}
