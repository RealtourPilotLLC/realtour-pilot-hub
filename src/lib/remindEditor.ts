import "server-only";

import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// "REMIND EDITOR" ON A LATE VIDEO (Jordan, Oct 19 2026): "the late section:
// just how it is now, but it should have a button 'Remind editor' or
// something like that so it messages the editor and we can let the editor
// know to prioritize it."
//
// WHO, per video (the Video Review Room's Late rows, and In revision rows
// older than a day):
//   · a version waiting on review: the REVIEWER who holds it (the cut's own
//     reviewer seat, else the first seat of the chain that can act now,
//     reviewerAssignment.resolveActiveReviewer). The button says "Remind
//     reviewer";
//   · a version sent back with changes: the editor on the job's open revision
//     card, else the video's own owner, else whoever uploaded the version,
//     else the edit card's editor;
//   · a version the editor still has to finish their send-for-review check
//     on, or a video not cut yet: the edit card's editor;
//   · not shot yet, the footage not in yet, nobody on it, an outside agency
//     with no hub login, or yourself: no button, the row says what it waits on.
// Only the in-house editors with a roster row (Kim, John Mark) are messaged
// directly; that is the same rule the daily revision reminders use
// (revisionReminders.laneFor).
//
// WHAT: one sentence in plain words (the street, how late, a link to the job's
// edit page), as their bell row and their Slack DM / text through the staff
// bridge (notify.ts; the editor's "Job pings" switch, Slack by default; a
// reviewer's "Video in review" switch), and as a note in the job's team
// messages, so it is on the record and on the editor brief. Never a client
// message.
// AT MOST ONCE EVERY 4 HOURS PER VIDEO: AppSetting "video_remind:<video key>"
// is claimed by compare-and-swap BEFORE anything is sent, so a double press
// or two people at once send one reminder. The row shows "Reminded 2h ago by
// Kyle".
// ---------------------------------------------------------------------------

export const REMIND_EVERY_MS = 4 * 3_600_000;
const KEY = (videoKey: string) => `video_remind:${videoKey}`;
const ANY_ROLE = ["OWNER", "ADMIN", "EDITOR", "PHOTOGRAPHER"] as const;

export type RemindTarget =
  | { kind: "editor"; editorKey: string; name: string; teamMemberId: string | null }
  | { kind: "reviewer"; teamMemberId: string; name: string }
  | { kind: "none"; waitsOn: string };

export type RemindRecord = { at: string; by: string; to: string; kind: "editor" | "reviewer" };

export type RemindState = {
  target: RemindTarget;
  last: RemindRecord | null;
  /** The 4 hours since the last reminder have passed (or there was none). */
  canRemind: boolean;
  /** When the next reminder may go (null: now). */
  nextAtISO: string | null;
};

/** One video on the room (a board row). `key` is the row's own key: the cut id, or "<job>:uncut:<n>". */
export type RemindItem = {
  key: string;
  projectId: string;
  submissionId: string | null;
  street: string;
  promiseISO: string | null;
  late: boolean;
  dueToday: boolean;
  /** A version sent back: when the changes were asked for. */
  revisionSinceISO?: string | null;
};


function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** "3 hours" / "1 day" / "4 days", how late a video is. Pure. */
export function lateWords(promiseISO: string | null, now: Date): string | null {
  if (!promiseISO) return null;
  const h = Math.floor((now.getTime() - Date.parse(promiseISO)) / 3_600_000);
  if (!Number.isFinite(h) || h < 0) return null;
  if (h < 24) return `${Math.max(1, h)} hour${Math.max(1, h) === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

/** "2h ago" / "35m ago". Pure. */
export function agoWords(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The reminder, in plain words, to the person reading it ("you"). Pure, so
 * the drill reads exactly what the editor reads.
 */
export function remindMessage(input: { street: string; promiseISO: string | null; late: boolean; dueToday: boolean; kind: "editor" | "reviewer"; link: string; now: Date; revisionSinceISO?: string | null }): { title: string; sentence: string; text: string } {
  const how = input.late ? lateWords(input.promiseISO, input.now) : null;
  const back = !how && !input.dueToday && input.revisionSinceISO ? lateWords(input.revisionSinceISO, input.now) : null;
  const when = how ? `is ${how} late for the client` : input.dueToday ? "is due to the client today" : back ? `has been back with you for changes for ${back}` : "is waiting on you";
  const short = how ? `is ${how} late` : input.dueToday ? "is due today" : back ? `has waited ${back}` : "is waiting";
  const [title, sentence] = input.kind === "reviewer"
    ? [`${input.street}'s video ${short}: please review it first today`, `${input.street}'s video ${when} and is waiting on your review. Please review it first today. If something is in the way, reply in the job's team messages.`]
    : [`${input.street}'s video ${short}: please do it first today`, `${input.street}'s video ${when}. Please make it your first job today and upload it as soon as it's ready. If something is in the way, reply in the job's team messages.`];
  return { title, sentence, text: `${sentence} ${input.link}` };
}

/** Who holds each video, and when it was last reminded (one batch of reads for the room). */
export async function remindStatesFor(items: RemindItem[], opts: { now?: Date; viewerTeamMemberId?: string | null } = {}): Promise<Map<string, RemindState>> {
  const now = opts.now ?? new Date();
  const out = new Map<string, RemindState>();
  if (!items.length) return out;
  const projectIds = [...new Set(items.map((i) => i.projectId))];
  const cutIds = [...new Set(items.map((i) => i.submissionId).filter((x): x is string => !!x))];
  const [projects, cuts, tasks, outputs, records] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, status: true } }),
    cutIds.length
      ? prisma.reviewSubmission.findMany({ where: { id: { in: cutIds } }, select: { id: true, status: true, reviewerTeamMemberId: true, submittedByKey: true, deliverableId: true, slot: true, selfCheckId: true, selfCheckedAt: true } })
      : Promise.resolve([]),
    prisma.smartTask.findMany({ where: { projectId: { in: projectIds }, taskType: { in: ["edit_video", "revision"] }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { createdAt: "desc" }, select: { projectId: true, taskType: true, assignedKey: true } }),
    prisma.deliverableOutput.findMany({ where: { projectId: { in: projectIds } }, select: { projectId: true, deliverableId: true, slot: true, ownerKey: true } }),
    prisma.appSetting.findMany({ where: { key: { in: items.map((i) => KEY(i.key)) } }, select: { key: true, value: true } }),
  ]);
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const cutById = new Map(cuts.map((c) => [c.id, c]));
  const recordByKey = new Map<string, RemindRecord>();
  for (const r of records) {
    try {
      recordByKey.set(r.key.slice("video_remind:".length), JSON.parse(r.value) as RemindRecord);
    } catch { /* an unreadable record is no record */ }
  }
  const { editorMeta, editorTeamMemberId, isVideoEditorKey } = await import("@/lib/editors");
  // Reviewer names, and the seat that holds an unassigned cut.
  const reviewerIds = [...new Set(cuts.map((c) => c.reviewerTeamMemberId).filter((x): x is string => !!x))];
  const names = new Map((reviewerIds.length ? await prisma.teamMember.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } }) : []).map((t) => [t.id, t.name]));
  let active: { teamMemberId: string; name: string } | null | undefined;
  const activeReviewer = async () => {
    if (active === undefined) {
      const { resolveActiveReviewer } = await import("@/lib/reviewerAssignment");
      active = await resolveActiveReviewer(now).then((r) => (r ? { teamMemberId: r.teamMemberId, name: r.name } : null)).catch(() => null);
    }
    return active;
  };
  const editorTarget = async (key: string | null | undefined, why: string): Promise<RemindTarget> => {
    if (!key) return { kind: "none", waitsOn: why };
    const meta = editorMeta(key);
    if (!meta || meta.departed) return { kind: "none", waitsOn: "The editor on it has left. Pick a new one in the Editing Room." };
    if (meta.kind === "external") return { kind: "none", waitsOn: `With ${meta.name}, who has no hub login. Message them yourself.` };
    const tm = await editorTeamMemberId(key).catch(() => null);
    if (tm && opts.viewerTeamMemberId && tm === opts.viewerTeamMemberId) return { kind: "none", waitsOn: "With you." };
    if (!isVideoEditorKey(key, { includeDeparted: true })) return { kind: "none", waitsOn: `With ${meta.name}.` };
    return { kind: "editor", editorKey: key, name: meta.name, teamMemberId: tm };
  };

  for (const it of items) {
    const p = projectById.get(it.projectId);
    const cut = it.submissionId ? cutById.get(it.submissionId) : undefined;
    const editTask = tasks.find((t) => t.projectId === it.projectId && t.taskType === "edit_video" && t.assignedKey)?.assignedKey ?? null;
    const revisionTask = tasks.find((t) => t.projectId === it.projectId && t.taskType === "revision" && t.assignedKey)?.assignedKey ?? null;
    let target: RemindTarget;
    if (!p) target = { kind: "none", waitsOn: "This job could not be read." };
    else if (["BOOKED", "SCHEDULED"].includes(p.status)) target = { kind: "none", waitsOn: "Not shot yet." };
    else if (cut?.status === "PENDING" && !(cut.selfCheckId && !cut.selfCheckedAt)) {
      const seat = cut.reviewerTeamMemberId ? { teamMemberId: cut.reviewerTeamMemberId, name: names.get(cut.reviewerTeamMemberId) ?? "the reviewer" } : await activeReviewer();
      if (!seat) target = { kind: "none", waitsOn: "Waiting on review, and no reviewer holds it: the office." };
      else if (opts.viewerTeamMemberId && seat.teamMemberId === opts.viewerTeamMemberId) target = { kind: "none", waitsOn: "Waiting on your review." };
      else target = { kind: "reviewer", teamMemberId: seat.teamMemberId, name: seat.name };
    } else if (cut?.status === "PENDING") {
      target = await editorTarget(cut.submittedByKey ?? editTask, "Waiting on the editor's send-for-review check, and nobody is on the edit card.");
    } else if (cut?.status === "CHANGES_REQUESTED") {
      const owner = outputs.find((o) => o.projectId === it.projectId && o.deliverableId === cut.deliverableId && o.slot === cut.slot)?.ownerKey ?? null;
      target = await editorTarget(revisionTask ?? owner ?? cut.submittedByKey ?? editTask, "Sent back with changes, and no editor is on it. Pick one in the Editing Room.");
    } else if (cut?.status === "APPROVED") {
      target = { kind: "none", waitsOn: "Approved: it is on Ready to send." };
    } else if (!editTask && p.status !== "EDITING") {
      target = { kind: "none", waitsOn: "Waiting on the footage to be uploaded." };
    } else {
      const owner = outputs.find((o) => o.projectId === it.projectId && o.ownerKey)?.ownerKey ?? null;
      target = await editorTarget(editTask ?? owner, "No editor is on it yet. Pick one in the Editing Room.");
    }
    const last = recordByKey.get(it.key) ?? null;
    const next = last ? Date.parse(last.at) + REMIND_EVERY_MS : 0;
    out.set(it.key, { target, last, canRemind: !last || !Number.isFinite(next) || next <= now.getTime(), nextAtISO: last && next > now.getTime() ? new Date(next).toISOString() : null });
  }
  return out;
}

export type RemindResult = { ok: boolean; message: string; to?: string; atISO?: string };

/**
 * Send one reminder. The caller has checked the person may (requireAdmin);
 * this checks everything about the video: who holds it, and the 4 hours.
 */
export async function remindVideo(input: { item: RemindItem; by: { name: string; teamMemberId: string | null }; now?: Date }): Promise<RemindResult> {
  const now = input.now ?? new Date();
  const it = input.item;
  const state = (await remindStatesFor([it], { now, viewerTeamMemberId: input.by.teamMemberId })).get(it.key);
  if (!state) return { ok: false, message: "That video could not be read." };
  const t = state.target;
  if (t.kind === "none") return { ok: false, message: t.waitsOn };
  if (!state.canRemind && state.last) {
    const { etTime } = await import("@/lib/datetime");
    const who = state.last.by === input.by.name ? "you" : firstNameOf(state.last.by);
    return { ok: false, message: `${firstNameOf(state.last.to)} was reminded ${agoWords(state.last.at, now)} by ${who}. You can remind them again after ${etTime(new Date(state.nextAtISO ?? now))} ET.` };
  }
  // The claim first (compare-and-swap): two presses at once send one reminder.
  const record: RemindRecord = { at: now.toISOString(), by: input.by.name, to: t.name, kind: t.kind };
  const key = KEY(it.key);
  const prev = await prisma.appSetting.findUnique({ where: { key }, select: { value: true } });
  if (prev) {
    let prevAt = 0;
    try {
      prevAt = Date.parse((JSON.parse(prev.value) as RemindRecord).at);
    } catch {
      prevAt = 0;
    }
    if (Number.isFinite(prevAt) && now.getTime() - prevAt < REMIND_EVERY_MS) return { ok: false, message: "Someone reminded them a moment ago." };
    const u = await prisma.appSetting.updateMany({ where: { key, value: prev.value }, data: { value: JSON.stringify(record), updatedBy: input.by.name.slice(0, 120) } });
    if (u.count !== 1) return { ok: false, message: "Someone reminded them a moment ago." };
  } else {
    try {
      await prisma.appSetting.create({ data: { key, value: JSON.stringify(record), updatedBy: input.by.name.slice(0, 120) } });
    } catch {
      return { ok: false, message: "Someone reminded them a moment ago." };
    }
  }

  const { appBase } = await import("@/lib/appUrl");
  const href = t.kind === "reviewer" && it.submissionId ? `/review/${it.projectId}?cut=${it.submissionId}` : `/edit/${it.projectId}`;
  const msg = remindMessage({ street: it.street, promiseISO: it.promiseISO, late: it.late, dueToday: it.dueToday, kind: t.kind, link: `${appBase()}${href}`, now, revisionSinceISO: it.revisionSinceISO ?? null });
  const { escapeSlack } = await import("@/lib/text");
  const { notifyInApp } = await import("@/lib/notify");
  const stamp = now.getTime();
  // The staff bridge: their bell row, and their Slack DM or text on their own
  // switch. Kinds already mapped to the right switch (notifyPrefs.KIND_TO_EVENT):
  // an editor's "Job pings" (revision_waiting), a reviewer's "Video in review"
  // (review_cover_offer). The money clamp drops the body for an editor row,
  // so the ask is in the title.
  const dm = `${escapeSlack(msg.sentence)} ${appBase()}${href}`;
  const res = await notifyInApp(
    t.kind === "editor"
      ? { kind: "revision_waiting", title: msg.title, href, targets: [{ roles: ["EDITOR"], userKey: `editor:${t.editorKey}`, href, slackDm: dm }], dedupeKey: `video-remind:${it.key}:${stamp}` }
      : { kind: "review_cover_offer", title: msg.title, href, targets: [{ roles: [...ANY_ROLE], userKey: `tm:${t.teamMemberId}`, href, slackDm: dm }], dedupeKey: `video-remind:${it.key}:${stamp}` },
  ).catch((e) => {
    console.warn("[remind] notify failed", e);
    return null;
  });
  // On the record: the job's team messages (the editor's page and brief read them).
  const tmId = t.teamMemberId;
  await prisma.projectMessage.create({
    data: {
      projectId: it.projectId,
      authorId: input.by.teamMemberId,
      authorName: input.by.name.slice(0, 120),
      body: `@${t.name} ${msg.text}`.slice(0, 2000),
      mentions: tmId ? JSON.stringify([tmId]) : null,
    },
  }).catch((e) => console.warn("[remind] team message failed", e));
  await prisma.activity.create({ data: { projectId: it.projectId, type: "SYSTEM", body: `${input.by.name} reminded ${t.name} about ${it.street}'s video${it.late ? ` (${lateWords(it.promiseISO, now)} late)` : ""}.`.slice(0, 500) } }).catch(() => {});
  const reached = res?.bridged?.find((b) => b.channel === "slack" || b.channel === "sms");
  return {
    ok: true,
    to: t.name,
    atISO: record.at,
    message: `Reminded ${firstNameOf(t.name)}${reached ? ` (${reached.channel === "slack" ? "Slack" : "text"})` : ""}. It is also in the job's team messages.`,
  };
}
