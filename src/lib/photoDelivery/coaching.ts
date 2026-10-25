import "server-only";

import { prisma } from "@/lib/prisma";
import { logJobEvent } from "./jobState";

// ---------------------------------------------------------------------------
// PHOTOGRAPHER COACHING NOTES (prompt pack 10, plan §12 item 3): the ones
// already drafted. The paid QC engine wrote a short note per shoot from its
// findings, as a DRAFT Jordan approves (or discards) on the job page before
// it reaches the photographer. Paid photo QC is off for good (Jordan, Oct 23
// 2026), and the engine and its Claude-written drafting were deleted with it
// (audit Oct 25 2026, D7), so no new note is drafted. The drafts already
// stored still show on their job page for the owner, with Send and Discard.
// A draft and its outcome live in the job's activity log (PhotoJobEvent
// actions coaching:draft / coaching:sent / coaching:discarded).
// ---------------------------------------------------------------------------

export type CoachingDraft = { eventId: string; at: Date; photographerId: string; photographerName: string; note: string; preShootReminders: string[]; status: "draft" | "sent" | "discarded" };

/** The latest coaching note on a job and what happened to it. */
export async function coachingFor(jobId: string): Promise<CoachingDraft | null> {
  const events = await prisma.photoJobEvent.findMany({ where: { jobId, action: { in: ["coaching:draft", "coaching:sent", "coaching:discarded"] } }, orderBy: { at: "desc" }, take: 10 });
  const draft = events.find((e) => e.action === "coaching:draft");
  if (!draft?.dataJson) return null;
  const d = JSON.parse(draft.dataJson) as { photographerId: string; photographerName: string; note: string; preShootReminders: string[] };
  const after = events.find((e) => e.at >= draft.at && e.action !== "coaching:draft");
  return { eventId: draft.id, at: draft.at, photographerId: d.photographerId, photographerName: d.photographerName, note: d.note, preShootReminders: d.preShootReminders, status: after?.action === "coaching:sent" ? "sent" : after?.action === "coaching:discarded" ? "discarded" : "draft" };
}

/** Owner approves (optionally edited) → Slack DM / text to the photographer. */
export async function sendCoachingNote(jobId: string, by: string, edited?: { note?: string; preShootReminders?: string[] }): Promise<{ ok: boolean; message: string }> {
  const c = await coachingFor(jobId);
  if (!c) return { ok: false, message: "No coaching note to send." };
  if (c.status !== "draft") return { ok: false, message: `This note was already ${c.status}.` };
  const note = (edited?.note ?? c.note).replace(/\s*[–—]\s*/g, ", ").trim();
  const reminders = (edited?.preShootReminders ?? c.preShootReminders).slice(0, 3).map((r) => r.replace(/\s*[–—]\s*/g, ", ").trim()).filter(Boolean);
  if (!note) return { ok: false, message: "The note is empty." };
  const text = `${note}\n\nBefore your next shoot:\n${reminders.map((r) => `- ${r}`).join("\n")}`;
  const { notifyStaffSms } = await import("@/lib/notify");
  const out = await notifyStaffSms([c.photographerId], text, "photo_coaching_note");
  // The words that went out are kept (audit C18): the photographer's feedback
  // hub shows sent coaching notes, not only the text message.
  await logJobEvent(jobId, by, "coaching:sent", { draftEventId: c.eventId, outcome: out[0]?.outcome ?? null, edited: !!edited, photographerId: c.photographerId, note, preShootReminders: reminders });
  return { ok: true, message: `Sent to ${c.photographerName.split(" ")[0]} (${out[0]?.outcome ?? "queued"}).` };
}

export async function discardCoachingNote(jobId: string, by: string): Promise<{ ok: boolean; message: string }> {
  const c = await coachingFor(jobId);
  if (!c || c.status !== "draft") return { ok: false, message: "No draft to discard." };
  await logJobEvent(jobId, by, "coaching:discarded", { draftEventId: c.eventId });
  return { ok: true, message: "Discarded." };
}
