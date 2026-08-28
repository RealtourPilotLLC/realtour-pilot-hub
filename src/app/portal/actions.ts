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

/** Client updates their own brand + preference fields (Agent Profile tab). */
export async function portalSaveProfile(
  token: string,
  input: { brandColors?: string; videoStyle?: string; preferences?: string },
): Promise<R> {
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return fail("This link is no longer active.");
  // Blank means "leave it alone", never "erase". The style/preference text
  // lands in CLIENT-OWNED columns (portalVideoStyle / portalPreferences) —
  // the internal editingPreferences/clientPreferences are admin-authored
  // notes a public token must never rewrite (adversarial review, Aug 28).
  const data: { brandColors?: string; portalVideoStyle?: string; portalPreferences?: string } = {};
  const bc = clip((input.brandColors ?? "").trim(), 300);
  const vs = clip((input.videoStyle ?? "").trim(), 1500);
  const pf = clip((input.preferences ?? "").trim(), 1500);
  if (bc) data.brandColors = bc;
  if (vs) data.portalVideoStyle = vs;
  if (pf) data.portalPreferences = pf;
  if (Object.keys(data).length === 0) return fail("Nothing to save.");
  await prisma.client.update({ where: { id: enrollment.clientId }, data });
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { name: true } });
  await ownerBell(
    "portal_profile",
    `Profile updated — ${client?.name ?? "a client"}`,
    "They updated their brand or preferences on their portal.",
    `/clients/${enrollment.clientId}`,
    `portal-profile-${enrollment.id}-${new Date().toISOString().slice(0, 13)}`,
  );
  return { ok: true, message: "Saved — your team sees this on every job." };
}

/**
 * Client asks to schedule their content session: preferred times + the
 * filming location, gated until the strategy call is at least booked. Lands
 * as a HIGH task on the booking desk + your bell — the live-Aryeo slot picker
 * plugs into this same card when it ships.
 */
export async function portalRequestSession(
  token: string,
  input: { when?: string; slotISO?: string; location: string },
): Promise<R> {
  const enrollment = await portalEnrollment(token);
  if (!enrollment) return fail("This link is no longer active.");
  const location = clip((input.location ?? "").trim(), 300);
  if (!location) return fail("Tell us where we're filming.");

  // The gate, server-side (owner rule: strategy call first, session no
  // earlier than 3 BUSINESS DAYS after it) — the picker enforces it visually,
  // this enforces it for real.
  const { sessionGate } = await import("@/lib/portal");
  const gate = await sessionGate(enrollment.id);
  if (gate.locked) return fail(gate.reason);

  let when = clip((input.when ?? "").trim(), 500);
  if (input.slotISO) {
    const slot = new Date(input.slotISO);
    if (!Number.isFinite(slot.getTime())) return fail("Pick a time from the list.");
    if (slot < gate.earliest) return fail("That time is inside the prep window after your strategy call — pick a later slot.");
    when = `${slot.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" })} ET (picked from live availability)`;
  }
  if (!when) return fail("Pick a time from the list (or tell us what works).");

  const { etMonthKey } = await import("@/lib/contentProgram");
  const month = await prisma.contentMonth.findUnique({
    where: { enrollmentId_monthKey: { enrollmentId: enrollment.id, monthKey: etMonthKey() } },
    select: { id: true },
  });
  if (!month) return fail("Book your strategy call first — we plan the month on that call, then film it.");
  // Lookup WITHOUT a status filter: dedupeKey is unique, so a completed
  // task must be REOPENED, not re-created (the create path threw P2002 —
  // review finding). updatedAt doubles as the throttle.
  const existing = await prisma.smartTask.findFirst({
    where: { dedupeKey: `portal-session-${month.id}` },
    select: { id: true, updatedAt: true },
  });
  if (existing && Date.now() - existing.updatedAt.getTime() < 10 * 60_000) {
    return { ok: true, message: "Got it — we already have your request and we're on it." };
  }
  const client = await prisma.client.findUnique({ where: { id: enrollment.clientId }, select: { id: true, name: true } });
  const desc = `The client scheduled from their portal.\nTime: ${when}\nFilming location: ${location}\n\nBook it in Aryeo and it will attach to their month automatically.`;
  if (existing) {
    await prisma.smartTask.update({ where: { id: existing.id }, data: { description: desc, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({
      data: {
        taskType: "todo",
        title: `Book content session — ${client?.name ?? "client"}`,
        summary: `Portal request: ${clip(when, 120)} · ${clip(location, 80)}`,
        description: desc,
        reasonCreated: "Client requested their content session from the portal",
        source: "portal",
        priority: "HIGH",
        dueAt: new Date(Date.now() + 24 * 3600_000),
        assignedKey: "kyle",
        clientId: client?.id ?? null,
        dedupeKey: `portal-session-${month.id}`,
      },
    });
  }
  await ownerBell(
    "portal_session",
    `Session request — ${client?.name ?? "a client"}`,
    `${clip(when, 100)} · ${clip(location, 60)}`,
    "/tasks?tab=board",
    `portal-session-${month.id}-${new Date().toISOString().slice(0, 10)}`,
  );
  return { ok: true, message: "Got it — we'll get it booked and you'll see the date here." };
}
