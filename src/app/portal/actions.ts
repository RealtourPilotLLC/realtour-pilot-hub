"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { resolvePortalViewer, submissionForEnrollment, scriptForEnrollment, type PortalViewer } from "@/lib/portal";
import { can, actorLabel, refusalMessage, type PortalPermission } from "@/lib/portalAccess";
import { clip } from "@/lib/text";

// ---------------------------------------------------------------------------
// PORTAL ACTIONS — the client's interactive layer (Aug 28; identity layer
// Sep 16). Every action starts the same way: resolve WHO is asking (the link's
// token, the signed-in person's cookie, or staff through the owner iframe),
// check they MAY do this (role + program status, server-side — the page hides
// buttons, this refuses), then prove the target row belongs to that
// enrollment before writing. Every write is stamped with the person
// (clientUserId) or the staff member acting on their behalf (staffUserId).
// Flood guards keep a shared link from becoming a spam hose. Nothing here
// returns internal data; errors are client-safe sentences.
// ---------------------------------------------------------------------------

/** How the browser identifies the visit: the link's token (/portal/<token>)
 *  or nothing (the cookie does the talking on /portal/me, where `enrollmentId`
 *  picks the program when a person holds several). Derived from the address
 *  bar on the client (src/components/portal/portalAuth.ts) — never embedded
 *  in the page. */
export type PortalAuth = { token?: string | null; enrollmentId?: string | null };

type R = { ok: boolean; message: string };
type RId = { ok: boolean; message: string; id?: string };
const fail = (m: string): R => ({ ok: false, message: m });
const LINK_DEAD = "This link is no longer active — sign in with your email to continue.";

const OPEN_COMMENT_CAP = 30; // per enrollment — a review session, not a firehose
const OPEN_SUGGESTION_CAP = 15;

/** Resolve + permission gate in one call; a string is the refusal to return. */
async function viewerFor(auth: PortalAuth, permission: PortalPermission): Promise<PortalViewer | string> {
  const r = await resolvePortalViewer({ token: auth?.token ?? null, enrollmentId: auth?.enrollmentId ?? null });
  if (!r.ok) return r.reason === "no_session" || r.reason === "no_membership" ? "Please sign in to do that." : LINK_DEAD;
  if (!can(r.viewer, permission)) return refusalMessage(r.viewer, permission);
  return r.viewer;
}

/** The attribution columns every client-authored row now carries. */
const stamp = (v: PortalViewer) => ({
  clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null,
  staffUserId: v.actor.kind === "STAFF" ? v.actor.staffUserId : null,
});

async function ownerBell(kind: string, title: string, body: string, href: string, dedupeKey: string) {
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({ kind, title, body, href, targets: [{ roles: ["OWNER", "ADMIN"] }], dedupeKey });
  } catch { /* bell is best-effort */ }
}

/** Client suggests a change to one of their scripts. Creates a record — never edits the script. */
export async function portalSuggestScript(auth: PortalAuth, scriptId: string, body: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  const text = (body ?? "").trim();
  if (text.length < 3) return fail("Tell us what you'd like changed.");
  const script = await scriptForEnrollment(enrollment.id, scriptId);
  if (!script) return fail("That script isn't on your page.");
  const open = await prisma.scriptSuggestion.count({
    where: { enrollmentId: enrollment.id, status: "OPEN", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  });
  if (open >= OPEN_SUGGESTION_CAP) return fail("You have a lot of suggestions in already — we're on them! Text us if it's urgent.");
  await prisma.scriptSuggestion.create({
    data: { scriptId, enrollmentId: enrollment.id, body: clip(text, 2000), ...stamp(v) },
  });
  // Land the owner on the MONTH the script lives in — the scripts tab defaults
  // to the current month and a past-month suggestion would render an empty tab.
  const scriptMonth = script.monthId
    ? await prisma.contentMonth.findUnique({ where: { id: script.monthId }, select: { monthKey: true } })
    : null;
  await ownerBell(
    "portal_suggestion",
    `Script suggestion — ${enrollment.clientName || "a client"}`,
    `${actorLabel(v)} on "${script.title}": ${clip(text, 120)}`,
    `/content/${enrollment.id}?tab=scripts${scriptMonth ? `&month=${scriptMonth.monthKey}` : ""}`,
    // Hour-bucketed: several suggestions in one sitting ring once.
    `portal-sugg-${enrollment.id}-${new Date().toISOString().slice(0, 13)}`,
  );
  revalidatePath(`/content/${enrollment.id}`);
  return { ok: true, message: "Got it — we'll take a look and update the script." };
}

/** Client drops a (timestamped) note on one of their cuts. */
export async function portalAddComment(auth: PortalAuth, submissionId: string, timeSec: number | null, body: string): Promise<RId> {
  const v = await viewerFor(auth, "comment");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  const text = (body ?? "").trim();
  if (text.length < 2) return fail("Write a quick note first.");
  const sub = await submissionForEnrollment(enrollment, submissionId);
  if (!sub) return fail("That video isn't on your page.");
  const open = await prisma.portalComment.count({
    where: { enrollmentId: enrollment.id, status: "OPEN", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
  });
  if (open >= OPEN_COMMENT_CAP) return fail("That's a lot of notes — send them over with the button below and we'll get started.");
  const t = typeof timeSec === "number" && isFinite(timeSec) && timeSec >= 0 ? Math.round(timeSec * 10) / 10 : null;
  const created = await prisma.portalComment.create({
    data: { submissionId, projectId: sub.projectId, enrollmentId: enrollment.id, timeSec: t, body: clip(text, 1000), ...stamp(v) },
    select: { id: true },
  });
  await ownerBell(
    "portal_comment",
    `Video notes coming in — ${enrollment.clientName || "a client"}`,
    `${actorLabel(v)}: ${clip(text, 120)}`,
    `/review/${sub.projectId}`,
    // One ping per cut per day — the notes themselves arrive with the request.
    `portal-note-${submissionId}-${new Date().toISOString().slice(0, 10)}`,
  );
  return { ok: true, message: "Noted.", id: created.id };
}

/** Client removes one of their own notes (only before it's been sent). */
export async function portalDeleteComment(auth: PortalAuth, commentId: string): Promise<R> {
  const v = await viewerFor(auth, "comment");
  if (typeof v === "string") return fail(v);
  const c = await prisma.portalComment.findUnique({ where: { id: commentId }, select: { enrollmentId: true, status: true } });
  if (!c || c.enrollmentId !== v.enrollment.id) return fail("That note isn't yours to remove.");
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
export async function portalRequestRevision(auth: PortalAuth, submissionId: string, generalNote: string): Promise<R> {
  const v = await viewerFor(auth, "requestChanges");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  const sub = await submissionForEnrollment(enrollment, submissionId);
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
  // multi-video month. Names the PERSON too — "Jordan (on behalf of Cara
  // TEST)" when it came through the owner iframe.
  const cutName = await prisma.reviewSubmission.findUnique({ where: { id: submissionId }, select: { fileName: true } });
  const by = actorLabel(v);
  const compiled = `Video revision requested from the client portal by ${by}${sub.project?.title ? ` on ${sub.project.title.split(",")[0]}` : ""}${cutName?.fileName ? ` (cut: ${cutName.fileName})` : ""}:\n${lines.map((l) => `• ${l}`).join("\n")}`;

  try {
    const { raiseRevision } = await import("@/lib/comms");
    const ok = await raiseRevision({
      projectId: sub.projectId,
      clientId: enrollment.clientId,
      clientName: enrollment.clientName || null,
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
  // The client sent this cut back. The STATUS flip stays (the editor lane and
  // findNextCut read it: the same filename re-exported counts as a redo, and
  // the Review Room shows it as waiting on editor changes) — but the client's
  // request is now its own stamp, clientRequestedAt/By. Jordan's internal QC
  // verdict (decidedAt/decidedBy) is his and is no longer overwritten (spec
  // §8: five separate concepts). portalCuts keeps showing the cut to the
  // client because their own stamp marks it as seen.
  await prisma.reviewSubmission
    .updateMany({
      where: { id: submissionId, status: "APPROVED" },
      data: { status: "CHANGES_REQUESTED", clientRequestedAt: new Date(), clientRequestedBy: by },
    })
    .catch(() => {});
  return { ok: true, message: "Sent to the editor — we'll text you when the new cut is ready." };
}

/** Client updates their own brand + preference fields (Agent Profile). */
export async function portalSaveProfile(
  auth: PortalAuth,
  input: { brandColors?: string; videoStyle?: string; preferences?: string },
): Promise<R> {
  const v = await viewerFor(auth, "editBrandProfile");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
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
  await ownerBell(
    "portal_profile",
    `Profile updated — ${enrollment.clientName || "a client"}`,
    `${actorLabel(v)} updated the brand or preferences on the portal.`,
    `/clients/${enrollment.clientId}`,
    `portal-profile-${enrollment.id}-${new Date().toISOString().slice(0, 13)}`,
  );
  return { ok: true, message: "Saved — your team sees this on every job." };
}

export type SessionRequestResult = R & { requestId?: string; label?: string; duplicate?: boolean };

/**
 * Client asks for their content session, FOR AN EXPLICIT PROGRAM MONTH
 * (a request made in late September may be October's): preferred slot or
 * free-text time + the filming location. Since Sep 17 the ask is a durable
 * ProgramSessionRequest (W1-B's createSessionRequest) — "Requested, awaiting
 * confirmation" until the Aryeo appointment appears — and no longer a
 * SmartTask that forgot the request on reload. createSessionRequest raises
 * the desk task + owner bell itself (not for TEST clients), collides
 * duplicate clicks on its dedupeKey, checks the month's capacity and never
 * writes to Aryeo. The 3-business-day window is the month's DERIVED state
 * (sessionGate → deriveMonthState) — the picker enforces it visually, this
 * enforces it for real.
 */
export async function portalRequestSession(
  auth: PortalAuth,
  input: { monthId: string; when?: string; slotISO?: string; location: string },
): Promise<SessionRequestResult> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  const location = clip((input.location ?? "").trim(), 300);
  if (!location) return fail("Tell us where we're filming.");
  const monthId = String(input.monthId ?? "");
  if (!/^[a-z0-9]{10,40}$/i.test(monthId)) return fail("Pick one of your program months.");

  const { sessionGate } = await import("@/lib/portal");
  const gate = await sessionGate(enrollment.id, monthId); // refuses a month that is not this enrollment's
  if (gate.locked) return fail(gate.reason);

  const when = clip((input.when ?? "").trim(), 500);
  let startISO: string | null = null;
  let endISO: string | null = null;
  if (input.slotISO) {
    const slot = new Date(input.slotISO);
    if (!Number.isFinite(slot.getTime())) return fail("Pick a time from the list.");
    if (slot < gate.earliest) return fail("That time is inside the prep window after your strategy call — pick a later slot.");
    startISO = slot.toISOString();
    // The package's session length, so the desk sees the whole block.
    const hours = (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { sessionHours: true } }))?.sessionHours ?? 2;
    endISO = new Date(slot.getTime() + hours * 3600_000).toISOString();
  }
  if (!startISO && !when) return fail("Pick a time from the list (or tell us what works).");

  const a = v.actor;
  const actor =
    a.kind === "CLIENT" ? { kind: "CLIENT" as const, clientUserId: a.clientUserId }
    : a.kind === "STAFF" ? { kind: "STAFF" as const, userId: a.staffUserId }
    : { kind: "TOKEN" as const };
  const { createSessionRequest, sessionRequestLabel } = await import("@/lib/sessionRequests");
  const r = await createSessionRequest({
    enrollmentId: enrollment.id,
    monthId,
    slot: { startISO, endISO, timezone: null, when: when || null, locationText: location, notes: `Requested on the portal by ${actorLabel(v)}.` },
    actor,
  });
  if (!r.ok) return fail(r.reason);
  // Best-effort: the owner's workspace re-reads on its next render anyway,
  // and outside a request scope (a probe calling the action directly) Next
  // throws here — the request row is already written, so never let that
  // turn a successful request into an error.
  try { revalidatePath(`/content/${enrollment.id}`); } catch { /* not in a request */ }
  return {
    ok: true,
    message: r.duplicate
      ? "We already have this request — it stays “awaiting confirmation” until we book it in Aryeo."
      : "Requested — it stays “awaiting confirmation” until we book it in Aryeo, then the date shows here.",
    requestId: r.id,
    label: sessionRequestLabel(r.status),
    duplicate: r.duplicate,
  };
}
