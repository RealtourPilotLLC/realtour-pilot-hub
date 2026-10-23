"use server";

import { requireAdmin } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { listAssignees, viewerAssigneeKey } from "@/lib/assignees";
import { addBusinessDayKeysET, etAt, etDayKey, etDateTime } from "@/lib/datetime";
import {
  MANUAL_CHECKS, closeoutSettingKey, officeDeskFor, waitingSettingKey,
  type CheckKey, type CloseoutRecord, type WaitingRecord,
} from "@/lib/officeDesk";

// ---------------------------------------------------------------------------
// KYLE'S DESK: the two writes the desk adds (Oct 23 2026). Everything else on
// the desk calls the actions the screens already use (Approve and deliver,
// Send, Reply, Done / Not needed / New date, Remind photographer, …).
//   · the Daily checks' manual ticks (a real review only: the system's own
//     evidence ticks the rest) and "Finish the day", one AppSetting row per
//     ET day (office_closeout:<YYYY-MM-DD>), each tick with who and when. A
//     tick never completes the work under it;
//   · "Create follow-up" from a conversation: a task linked to the client,
//     with a time it comes back (a reply never resolves the request under it);
//   · "Waiting on": a task's named person and follow-up time (the task's own
//     followUpAt, plus office_waiting:<taskId> for the name). A creative
//     question goes to the creative manager, a business or policy question to
//     the owner, each with a bell. It comes back to Kyle's desk at that time.
// Both refuse the owner's "view as" preview (requireAdmin does), and both are
// recorded in the AuditLog before they answer.
// ---------------------------------------------------------------------------

export type DeskResult = { ok: boolean; message: string };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]{10,40}$/i;

async function actor(): Promise<{ by: string; email: string | null }> {
  const me = await getCurrentUser().catch(() => null);
  return { by: me?.name ?? me?.email ?? "office", email: me?.email ?? null };
}

const denied = (e: unknown): DeskResult => ({ ok: false, message: (e as Error)?.message || "You can't do that here." });

async function readRecord(dayKey: string): Promise<CloseoutRecord> {
  const row = await prisma.appSetting.findUnique({ where: { key: closeoutSettingKey(dayKey) } });
  if (!row?.value) return { ticks: {}, finished: null };
  try {
    const parsed = JSON.parse(row.value) as Partial<CloseoutRecord>;
    return { ticks: parsed.ticks ?? {}, finished: parsed.finished ?? null };
  } catch {
    return { ticks: {}, finished: null };
  }
}

async function writeRecord(dayKey: string, rec: CloseoutRecord, by: string): Promise<void> {
  const value = JSON.stringify(rec);
  await prisma.appSetting.upsert({ where: { key: closeoutSettingKey(dayKey) }, create: { key: closeoutSettingKey(dayKey), value, updatedBy: by }, update: { value, updatedBy: by } });
}

/** Tick (or untick) one of today's manual checks. Only today's list can change,
 *  and only a check that is a real review (the system's evidence ticks the rest). */
export async function closeoutTickAction(dayKey: string, key: CheckKey, on: boolean): Promise<DeskResult> {
  try { await requireAdmin(); } catch (e) { return denied(e); }
  if (!DAY_KEY.test(String(dayKey)) || dayKey !== etDayKey(new Date())) return { ok: false, message: "Only today's checks can be changed. Reload the page." };
  if (!MANUAL_CHECKS.includes(key)) return { ok: false, message: "That check is ticked by the system when the work is done, not by hand." };
  const { by } = await actor();
  const rec = await readRecord(dayKey);
  const at = new Date().toISOString();
  if (on) rec.ticks[key] = { at, by };
  else delete rec.ticks[key];
  await prisma.auditLog.create({ data: { actor: by, action: on ? "office_closeout_tick" : "office_closeout_untick", target: `${dayKey}:${key}`, detail: JSON.stringify({ dayKey, key, at }) } });
  await writeRecord(dayKey, rec, by);
  return { ok: true, message: on ? "Ticked." : "Unticked." };
}

/** Finish the day: only when the end-of-day review is done (derived or ticked).
 *  Work that arrives afterwards still shows; finishing never hides it. */
export async function finishDayAction(dayKey: string): Promise<DeskResult> {
  try { await requireAdmin(); } catch (e) { return denied(e); }
  if (!DAY_KEY.test(String(dayKey)) || dayKey !== etDayKey(new Date())) return { ok: false, message: "Only today can be finished. Reload the page." };
  const me = await getCurrentUser().catch(() => null);
  const desk = await officeDeskFor(me, {});
  const open = (desk.checks.groups.find((g) => g.key === "eod")?.lines ?? []).filter((l) => !l.done);
  if (open.length) return { ok: false, message: `Still open: ${open.map((l) => l.label.toLowerCase()).join("; ")}.` };
  const { by } = await actor();
  const rec = await readRecord(dayKey);
  const at = new Date().toISOString();
  rec.finished = { at, by };
  await prisma.auditLog.create({ data: { actor: by, action: "office_day_finished", target: dayKey, detail: JSON.stringify({ dayKey, at, stillOpen: desk.sections.map((s) => [s.key, s.count]), waiting: desk.sections.reduce((n, s) => n + s.waiting.length, 0) }) } });
  await writeRecord(dayKey, rec, by);
  return { ok: true, message: `Day finished at ${etDateTime(at)}. Anything new still shows up.` };
}

export type WaitInput = {
  taskId: string;
  /** creative → the creative manager; owner → the owner; other → a named person */
  who: "creative" | "owner" | "other";
  name?: string | null;
  when: "2h" | "tomorrow" | "2days";
  note?: string | null;
};

/** "Waiting on …": a named person and a time it comes back. */
export async function deskWaitAction(input: WaitInput): Promise<DeskResult> {
  try { await requireAdmin(); } catch (e) { return denied(e); }
  if (!ID.test(String(input?.taskId))) return { ok: false, message: "That task id is not valid." };
  if (!["creative", "owner", "other"].includes(input.who)) return { ok: false, message: "Pick who it is waiting on." };
  if (!["2h", "tomorrow", "2days"].includes(input.when)) return { ok: false, message: "Pick when to follow up." };
  const task = await prisma.smartTask.findUnique({ where: { id: input.taskId }, select: { id: true, title: true, status: true, projectId: true } });
  if (!task || ["COMPLETED", "CANCELLED"].includes(task.status)) return { ok: false, message: "That task is already closed." };
  const now = new Date();
  const followUpAt = input.when === "2h" ? new Date(now.getTime() + 2 * 3_600_000) : etAt(addBusinessDayKeysET(now, input.when === "tomorrow" ? 1 : 2), 10);
  let who: string;
  let tmId: string | null = null;
  let role: "OWNER" | "ADMIN" = "ADMIN";
  if (input.who === "creative") {
    const cm = await prisma.teamMember.findFirst({ where: { creativeManager: true }, select: { id: true, name: true } });
    who = (cm?.name ?? "James").split(" ")[0];
    tmId = cm?.id ?? null;
  } else if (input.who === "owner") {
    const owner = await prisma.appUser.findFirst({ where: { role: "OWNER", status: "ACTIVE" }, select: { name: true, teamMemberId: true } });
    who = (owner?.name ?? "Jordan").split(" ")[0];
    tmId = owner?.teamMemberId ?? null;
    role = "OWNER";
  } else {
    const name = (input.name ?? "").replace(/\s+/g, " ").trim();
    if (name.length < 2 || name.length > 60) return { ok: false, message: "Name the person it is waiting on." };
    who = name;
  }
  const note = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const { by } = await actor();
  const rec: WaitingRecord = { who, role: input.who, note, at: now.toISOString(), by, followUpAt: followUpAt.toISOString() };
  await prisma.auditLog.create({ data: { actor: by, action: "office_waiting_on", target: task.id, detail: JSON.stringify(rec) } });
  await prisma.smartTask.update({ where: { id: task.id }, data: { followUpAt } });
  await prisma.appSetting.upsert({ where: { key: waitingSettingKey(task.id) }, create: { key: waitingSettingKey(task.id), value: JSON.stringify(rec), updatedBy: by }, update: { value: JSON.stringify(rec), updatedBy: by } });
  if (tmId) {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "office_question",
      title: `${by.split(" ")[0]} needs you: ${task.title}`.slice(0, 90),
      body: note ?? (input.who === "creative" ? "A creative question from the office." : "A business or policy question from the office."),
      href: task.projectId ? `/projects/${task.projectId}` : "/tasks",
      targets: [{ roles: [role], userKey: `tm:${tmId}` }],
      dedupeKey: `office_question:${task.id}:${now.getTime()}`,
    }).catch(() => undefined);
  }
  return { ok: true, message: `Waiting on ${who}. It comes back ${etDateTime(followUpAt)}.` };
}

export type FollowUpInput = {
  clientId: string | null;
  projectId?: string | null;
  title: string;
  when: "2h" | "tomorrow" | "2days";
  note?: string | null;
};

/** "Create follow-up" beside a reply: a task for the office, linked to the
 *  client (and job), coming back at the time picked. Replying never resolves
 *  the request under a conversation; this keeps it on the desk until it is. */
export async function deskFollowUpAction(input: FollowUpInput): Promise<DeskResult> {
  try { await requireAdmin(); } catch (e) { return denied(e); }
  const title = (input?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
  if (title.length < 3) return { ok: false, message: "Say what to follow up on." };
  if (!["2h", "tomorrow", "2days"].includes(input.when)) return { ok: false, message: "Pick when to follow up." };
  if (input.clientId != null && !ID.test(String(input.clientId))) return { ok: false, message: "That client id is not valid." };
  if (input.projectId != null && !ID.test(String(input.projectId))) return { ok: false, message: "That job id is not valid." };
  const now = new Date();
  const followUpAt = input.when === "2h" ? new Date(now.getTime() + 2 * 3_600_000) : etAt(addBusinessDayKeysET(now, input.when === "tomorrow" ? 1 : 2), 10);
  const me = await getCurrentUser().catch(() => null);
  const { by } = await actor();
  const note = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 300) || null;
  const row = await prisma.smartTask.create({
    data: {
      taskType: "comms_followup", source: "office", status: "OPEN", priority: "MEDIUM",
      title, summary: note, description: note, reasonCreated: `Follow-up created on the dashboard by ${by}`,
      assignedKey: me ? viewerAssigneeKey(me, await listAssignees().catch(() => [])) ?? "kyle" : "kyle", ownerId: me?.teamMemberId ?? null,
      clientId: input.clientId ?? null, projectId: input.projectId ?? null,
      dueAt: followUpAt, followUpAt,
    },
    select: { id: true },
  });
  await prisma.auditLog.create({ data: { actor: by, action: "office_follow_up_created", target: row.id, detail: JSON.stringify({ title, clientId: input.clientId ?? null, projectId: input.projectId ?? null, followUpAt: followUpAt.toISOString() }) } });
  return { ok: true, message: `Follow-up set for ${etDateTime(followUpAt)}.` };
}

export type DraftResult = { ok: boolean; message: string; draft?: string };

/** A Content Program message opens with a draft, as texts and email do (Jordan's
 *  huddle with Kyle, Oct 23 2026): the reply engine's own drafter, given the
 *  program conversation. Kyle sends it as is or edits it; nothing is sent here. */
export async function draftProgramReplyAction(enrollmentId: string): Promise<DraftResult> {
  try { await requireAdmin(); } catch (e) { return denied(e); }
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(String(enrollmentId))) return { ok: false, message: "That program id is not valid." };
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft replies." };
  const rows = await prisma.programMessage.findMany({
    where: { enrollmentId, refKind: null },
    orderBy: { createdAt: "desc" },
    take: 16,
    select: { authorKind: true, authorLabel: true, body: true, createdAt: true, clientId: true },
  });
  if (!rows.some((r) => r.authorKind === "CLIENT")) return { ok: false, message: "Nothing from the client to answer here." };
  const client = await prisma.client.findUnique({ where: { id: rows[0].clientId }, select: { name: true } }).catch(() => null);
  try {
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const draft = await draftReplyWithContext({
      channel: "email",
      clientName: client?.name ?? null,
      transcript: rows.reverse().map((r) => ({ role: r.authorKind === "STAFF" ? ("us" as const) : ("client" as const), text: r.body, at: r.createdAt.toISOString(), sender: r.authorKind === "STAFF" ? null : r.authorLabel })),
      note: "This is the client's Content Program conversation (their monthly social content), not a listing shoot.",
    });
    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(draft)) return { ok: false, message: "This one looks handled: nothing to answer." };
    return { ok: true, message: "Draft ready. Read it before sending.", draft };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not draft a reply." };
  }
}
