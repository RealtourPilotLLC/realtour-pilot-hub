"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { portalEnrollment, submissionForEnrollment, scriptForEnrollment } from "@/lib/portal";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// PORTAL ACTIONS — the client's interactive layer (Aug 28). These run with NO
// login: the token is the auth, so every action re-resolves it and proves the
// target row belongs to that enrollment before writing (never trust a bare id
// from the page). Flood guards keep a shared link from becoming a spam hose.
// Nothing here returns internal data; errors are client-safe sentences.
// ---------------------------------------------------------------------------

type R = { ok: boolean; message: string };
type RId = { ok: boolean; message: string; id?: string };
const fail = (m: string): R => ({ ok: false, message: m });

const OPEN_COMMENT_CAP = 30; // per enrollment — a review session, not a firehose
const OPEN_SUGGESTION_CAP = 15;

async function ownerBell(kind: string, title: string, body: string, href: string, dedupeKey: string) {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({ kind, title, body, href, targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey });
  } catch { /* bell is best-effort */ }
}

/** Client suggests a change to one of their scripts. Creates a record — never edits the script. */
export async function portalSuggestScript(token: string, scriptId: string, body: string): Promise<R> {
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return fail("This link is no longer active.");
  const text = (body ?? "").trim();
  if (text.length < 3) return fail("Tell us what you'd like changed.");
  const script = await scriptForEnrollment(enrollment.id, scriptId);
  if (!script) return fail("That script isn't on your page.");
  const open = await prisma.scriptSuggestion.count({
    where: { enrollmentId: enrollment.id, status: "OPEN", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  });
  if (open >= OPEN_SUGGESTION_CAP) return fail("You have a lot of suggestions in already — we're on them! Text us if it's urgent.");
  await prisma.scriptSuggestion.create({
    data: { scriptId, enrollmentId: enrollment.id, body: clip(text, 2000) },
  });
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
  // Land the owner on the MONTH the script lives in — the scripts tab defaults
  // to the current month and a past-month suggestion would render an empty tab.
  const scriptMonth = script.monthId
    ? await prisma.contentMonth.findUnique({ where: { id: script.monthId }, select: { monthKey: true } })
    : null;
  await ownerBell(
    "portal_suggestion",
    `Script suggestion — ${client?.name ?? "a client"}`,
    `On "${script.title}": ${clip(text, 120)}`,
    `/content/${enrollment.id}?tab=scripts${scriptMonth ? `&month=${scriptMonth.monthKey}` : ""}`,
    // Hour-bucketed: several suggestions in one sitting ring once.
    `portal-sugg-${enrollment.id}-${new Date().toISOString().slice(0, 13)}`,
  );
  revalidatePath(`/content/${enrollment.id}`);
  return { ok: true, message: "Got it — we'll take a look and update the script." };
}

/** Client drops a (timestamped) note on one of their cuts. */
export async function portalAddComment(token: string, submissionId: string, timeSec: number | null, body: string): Promise<RId> {
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return fail("This link is no longer active.");
  const text = (body ?? "").trim();
  if (text.length < 2) return fail("Write a quick note first.");
  const sub = await submissionForEnrollment(enrollment.id, submissionId);
  if (!sub) return fail("That video isn't on your page.");
  const open = await prisma.portalComment.count({
    where: { enrollmentId: enrollment.id, status: "OPEN", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  });
  if (open >= OPEN_COMMENT_CAP) return fail("That's a lot of notes — send them over with the button below and we'll get started.");
  const t = typeof timeSec === "number" && isFinite(timeSec) && timeSec >= 0 ? Math.round(timeSec * 10) / 10 : null;
  const created = await prisma.portalComment.create({
    data: { submissionId, projectId: sub.projectId, enrollmentId: enrollment.id, timeSec: t, body: clip(text, 1000) },
    select: { id: true },
  });
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
  await ownerBell(
    "portal_comment",
    `Video notes coming in — ${client?.name ?? "a client"}`,
    clip(text, 120),
    `/review/${sub.projectId}`,
    // One ping per cut per day — the notes themselves arrive with the request.
    `portal-note-${submissionId}-${new Date().toISOString().slice(0, 10)}`,
  );
  return { ok: true, message: "Noted.", id: created.id };
}

/** Client removes one of their own notes (only before it's been sent). */
export async function portalDeleteComment(token: string, commentId: string): Promise<R> {
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return fail("This link is no longer active.");
  const c = await prisma.portalComment.findUnique({ where: { id: commentId }, select: { enrollmentId: true, status: true } });
  if (!c || c.enrollmentId !== enrollment.id) return fail("That note isn't yours to remove.");
  if (c.status !== "OPEN") return fail("That note was already sent to the editor.");
  await prisma.portalComment.delete({ where: { id: commentId } });
  return { ok: true, message: "Removed." };
}

/**
 * Client sends their notes as ONE revision request. Bundles every OPEN note on
 * the cut (plus an optional overall note), raises the revision through the
 * same machinery a text or call uses — work-order brief, editor task, bells —
 * and marks the notes SENT.
 */
export async function portalRequestRevision(token: string, submissionId: string, generalNote: string): Promise<R> {
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return fail("This link is no longer active.");
  const sub = await submissionForEnrollment(enrollment.id, submissionId);
  if (!sub) return fail("That video isn't on your page.");

  // THROTTLE (review finding: this action fed a billable AI analysis + several
  // DB rows per call with no guard). One send per project per 15 minutes —
  // notes keep accumulating meanwhile and ride the next send.
  const recent = await prisma.revisionBrief.count({
    where: { projectId: sub.projectId, source: "portal", createdAt: { gte: new Date(Date.now() - 15 * 60_000) } },
  });
  if (recent > 0) {
    return fail("We already got your last request — add any extra notes above and send again in a few minutes.");
  }

  const notes = await prisma.portalComment.findMany({
    where: { submissionId, enrollmentId: enrollment.id, status: "OPEN" },
    orderBy: [{ timeSec: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    select: { id: true, timeSec: true, body: true },
  });
  const overall = clip((generalNote ?? "").trim(), 1000);
  if (notes.length === 0 && overall.length < 3) {
    return fail("Add a note on the video (or an overall note) first, so the editor knows what to change.");
  }

  const fmtT = (t: number | null) =>
    t == null ? "" : `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}] `;
  const lines = [
    ...notes.map((n) => `${fmtT(n.timeSec)}${n.body}`),
    ...(overall ? [overall] : []),
  ];
  // Names the video explicitly: the revision router reads deliverable words to
  // pick the video lane, and the editor needs to know WHICH cut on a
  // multi-video month.
  const cutName = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { fileName: true } });
  const compiled = `Video revision requested from the client portal${sub.project?.title ? ` on ${sub.project.title.split(",")[0]}` : ""}${cutName?.fileName ? ` (cut: ${cutName.fileName})` : ""}:\n${lines.map((l) => `• ${l}`).join("\n")}`;

  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
  try {
    const { raiseRevision } = await import("@/lib/comms");
    const ok = await raiseRevision({
      projectId: sub.projectId,
      clientId: enrollment.clientId,
      clientName: client?.name ?? null,
      propertyAddress: sub.project?.title ?? null,
      note: compiled,
      source: "portal",
    });
    if (!ok) return fail("Something hiccuped on our side — text us and we'll get right on it.");
  } catch {
    return fail("Something hiccuped on our side — text us and we'll get right on it.");
  }
  await prisma.portalComment.updateMany({
    where: { id: { in: notes.map((n) => n.id) } },
    data: { status: "SENT" },
  });
  // The client sent this cut back — record the verdict on the round itself so
  // the editor's re-export of the SAME filename counts as a redo (findNextCut
  // skips approved paths otherwise) and the Review Room shows it as waiting on
  // editor changes. portalCuts keeps showing it to the client because their
  // own notes mark it as seen.
  await prisma.reviewSubmission
    .updateMany({
      where: { id: submissionId, status: "APPROVED" },
      data: { status: "CHANGES_REQUESTED", decidedAt: new Date(), decidedBy: `${client?.name ?? "Client"} (portal)` },
    })
    .catch(() => {});
  return { ok: true, message: "Sent to the editor — we'll text you when the new cut is ready." };
}
