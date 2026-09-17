"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { resolvePortalViewer, submissionForEnrollment, scriptForEnrollment, topicForEnrollment, openMonthForEnrollment, type PortalViewer } from "@/lib/portal";
import { can, actorLabel, refusalMessage, type PortalPermission } from "@/lib/portalAccess";
import { approveCut, requestChangesOnCut, replyToComment, setCommentResolved, isMine, type OpenNotesChoice } from "@/lib/clientDecisions";
import { setPostedByClient, saveCaptionEdit, draftCaptionForVideo } from "@/lib/postingKit";
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

/** Client drops a (timestamped) note on one of their cuts — or, with `parentId`, a reply under an existing note. */
export async function portalAddComment(auth: PortalAuth, submissionId: string, timeSec: number | null, body: string, parentId?: string | null): Promise<RId> {
  const v = await viewerFor(auth, "comment");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  if (parentId) return replyToComment(v, parentId, body);
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
  const c = await prisma.portalComment.findUnique({ where: { id: commentId }, select: { enrollmentId: true, status: true, clientUserId: true, staffUserId: true } });
  if (!c || c.enrollmentId !== v.enrollment.id) return fail("That note isn't yours to remove.");
  // Same enrollment is not the same person: only the author removes a note.
  if (!isMine(v, c)) return fail("That note was written by someone else on your program — only they can remove it.");
  if (c.status !== "OPEN") return fail("That note was already sent to the editor.");
  await prisma.portalComment.delete({ where: { id: commentId } });
  return { ok: true, message: "Removed." };
}

/**
 * "Submit change request": every OPEN note on the cut (plus an optional
 * overall note) becomes ONE revision through the same machinery a text or
 * call uses, and a ClientDecision(REQUEST_CHANGES) keyed to the exact cut
 * records it. A second submit while that request is open joins it — one job.
 */
export async function portalRequestRevision(auth: PortalAuth, submissionId: string, generalNote: string): Promise<R & { duplicate?: boolean }> {
  const v = await viewerFor(auth, "requestChanges");
  if (typeof v === "string") return fail(v);
  const r = await requestChangesOnCut(v, submissionId, generalNote);
  if (!r.ok) return fail(r.message);
  return { ok: true, message: r.message, duplicate: r.duplicate };
}

/**
 * "Approve this version": an attributable ClientDecision(APPROVE) on the
 * immutable cut the client watched. OWNER only (can → approveEdits). Open
 * notes need an explicit choice: INCLUDE (send along as notes) or DISCARD
 * (resolve them).
 */
export async function portalApproveCut(auth: PortalAuth, submissionId: string, choice: OpenNotesChoice): Promise<R & { duplicate?: boolean }> {
  const v = await viewerFor(auth, "approveEdits");
  if (typeof v === "string") return fail(v);
  const c: OpenNotesChoice = choice === "INCLUDE" || choice === "DISCARD" ? choice : "NONE";
  const r = await approveCut(v, submissionId, c);
  if (!r.ok) return fail(r.message);
  await ownerBell(
    "portal_approval",
    `Video approved — ${v.enrollment.clientName || "a client"}`,
    `${actorLabel(v)} approved a cut${c === "INCLUDE" ? " (with notes attached)" : ""}.`,
    `/content/${v.enrollment.id}?tab=videos`,
    `portal-approve-${submissionId}`,
  );
  return { ok: true, message: r.message, duplicate: r.duplicate };
}

/** Resolve or reopen one of the notes on the viewer's cut. */
export async function portalResolveComment(auth: PortalAuth, commentId: string, resolved: boolean): Promise<R> {
  const v = await viewerFor(auth, "comment");
  if (typeof v === "string") return fail(v);
  return setCommentResolved(v, commentId, !!resolved);
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

// ===========================================================================
// WAVE 2 — Video Topics, the guided interview, My Strategy corrections, the
// planning path, session-request cancellation and the posting kit. Same
// shape as everything above: resolve, permit, prove ownership, then write.
// ===========================================================================

/** The W1-C topic layer's actor: the person, or staff on their behalf; the link is a client with no person. */
const topicActor = (v: PortalViewer) => ({
  kind: v.actor.kind === "STAFF" ? ("STAFF" as const) : ("CLIENT" as const),
  clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null,
  staffUserId: v.actor.kind === "STAFF" ? v.actor.staffUserId : null,
});

export type SelectTopicResult = R & { overflow?: boolean; capacity?: { owed: number; selected: number } };

/** Select one of the client's topics FOR a named month. Overflow is kept and explained, never deleted. */
export async function portalSelectTopic(auth: PortalAuth, topicId: string, monthId: string): Promise<SelectTopicResult> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const [topic, month] = await Promise.all([topicForEnrollment(v.enrollment.id, topicId), openMonthForEnrollment(v.enrollment.id, monthId)]);
  if (!topic) return fail("That topic isn't in your bank.");
  if (!month) return fail("Pick one of your open program months.");
  const { selectTopicForMonth } = await import("@/lib/contentTopics");
  try {
    const r = await selectTopicForMonth(topic.id, month.id, { source: "client", actor: topicActor(v), status: "SELECTED" });
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    const { monthLabel } = await import("@/lib/contentProgram");
    if (r.outcome === "WITHHELD") return fail("That topic was set aside earlier — text us if you'd like it back on the table.");
    return {
      ok: true, overflow: r.overflow, capacity: r.capacity,
      message: r.overflow
        ? `Added to ${monthLabel(month.monthKey)} as an extra — your package covers ${month.videosOwed} video${month.videosOwed === 1 ? "" : "s"} that month, so this one waits its turn (nothing is thrown away).`
        : `Selected for ${monthLabel(month.monthKey)}.`,
    };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/** Remove an uncommitted selection (a topic with a script or footage stays on its month). */
export async function portalRemoveSelection(auth: PortalAuth, topicId: string, monthId: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const topic = await topicForEnrollment(v.enrollment.id, topicId);
  if (!topic) return fail("That topic isn't in your bank.");
  const month = await prisma.contentMonth.findFirst({ where: { id: monthId, enrollmentId: v.enrollment.id }, select: { id: true } });
  if (!month) return fail("Pick one of your program months.");
  const { deselectTopic } = await import("@/lib/contentTopics");
  try {
    await deselectTopic(topic.id, month.id, topicActor(v));
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: "Removed from that month — it's back in your bank." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/** The client suggests a topic of their own. It joins their bank as theirs, proposed for staff to shape. */
export async function portalSuggestTopic(auth: PortalAuth, input: { title: string; concept?: string; pillarId?: string | null; monthId?: string | null }): Promise<RId> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const title = clip((input.title ?? "").trim(), 200);
  if (title.length < 3) return fail("Give your idea a title first.");
  const concept = clip((input.concept ?? "").trim(), 1000) || null;
  let pillarId: string | null = null;
  if (input.pillarId && /^[a-z0-9]{10,40}$/i.test(input.pillarId)) {
    const p = await prisma.contentPillar.findFirst({ where: { id: input.pillarId, enrollmentId: v.enrollment.id }, select: { id: true } });
    pillarId = p?.id ?? null;
  }
  const recent = await prisma.contentTopic.count({ where: { enrollmentId: v.enrollment.id, source: "client", createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
  if (recent >= 20) return fail("That's a lot of ideas for one day — we love it, but let's talk them through. Text us!");
  const { createTopic } = await import("@/lib/contentTopics");
  try {
    const actor = topicActor(v);
    const r = await createTopic({
      enrollmentId: v.enrollment.id, title, concept, pillarId, source: "client", clientUserId: actor.clientUserId, clientWording: title,
      approvalState: "PROPOSED", actor, eventKind: "CREATED", note: `Suggested on the portal by ${actorLabel(v)}`,
    });
    if (r.existed) return { ok: true, message: "That idea is already in your bank.", id: r.id };
    if (input.monthId) {
      const month = await openMonthForEnrollment(v.enrollment.id, input.monthId);
      if (month) {
        const { selectTopicForMonth } = await import("@/lib/contentTopics");
        await selectTopicForMonth(r.id, month.id, { source: "client", actor, status: "SELECTED" }).catch(() => {});
      }
    }
    await ownerBell("portal_topic", `Topic idea — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)}: ${clip(title, 120)}`, `/content/${v.enrollment.id}?tab=topics`, `portal-topic-${v.enrollment.id}-${new Date().toISOString().slice(0, 13)}`);
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: "Added to your bank — we'll shape it with you.", id: r.id };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/** A note on a topic — lands on its history as a discussion, changes nothing else. */
export async function portalDiscussTopic(auth: PortalAuth, topicId: string, note: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const topic = await topicForEnrollment(v.enrollment.id, topicId);
  if (!topic) return fail("That topic isn't in your bank.");
  const text = clip((note ?? "").trim(), 1000);
  if (text.length < 2) return fail("Write a quick note first.");
  const { discussTopic } = await import("@/lib/contentTopics");
  await discussTopic(topic.id, text, topicActor(v), "portal");
  await ownerBell("portal_topic_note", `Topic note — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)} on "${topic.title}": ${clip(text, 120)}`, `/content/${v.enrollment.id}?tab=topics`, `portal-topic-note-${topic.id}-${new Date().toISOString().slice(0, 13)}`);
  return { ok: true, message: "Noted — it's on the topic's history for us to read." };
}

/** Opening a topic for a month starts (or resumes) its guided interview. */
export async function portalOpenInterview(auth: PortalAuth, topicId: string, monthId: string): Promise<RId> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const [topic, month] = await Promise.all([topicForEnrollment(v.enrollment.id, topicId), openMonthForEnrollment(v.enrollment.id, monthId)]);
  if (!topic) return fail("That topic isn't in your bank.");
  if (!month) return fail("Pick one of your open program months.");
  const { getOrCreateInterview } = await import("@/lib/contentInterview");
  try {
    const a = topicActor(v);
    const id = await getOrCreateInterview(topic.id, month.id, { clientUserId: a.clientUserId, staffUserId: a.staffUserId });
    return { ok: true, message: "Let's go.", id };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Couldn't open the questions — try again.");
  }
}

async function interviewOwned(enrollmentId: string, interviewId: string) {
  if (!/^[a-z0-9]{10,40}$/i.test(interviewId)) return null;
  const iv = await prisma.contentInterview.findUnique({ where: { id: interviewId }, select: { id: true, enrollmentId: true, monthId: true, topicId: true } });
  return iv && iv.enrollmentId === enrollmentId ? iv : null;
}

/** Answer, skip or "I don't know" one question. Every answer is a new row; the earlier one stays. */
export async function portalAnswerInterview(auth: PortalAuth, interviewId: string, questionKey: string, text: string, kind: "TYPED" | "SKIPPED" | "DONT_KNOW", questionText?: string | null): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const iv = await interviewOwned(v.enrollment.id, interviewId);
  if (!iv) return fail("Those questions aren't on your page.");
  if (!/^[a-zA-Z]+(?::fu:[a-z-]+)?$/.test(questionKey)) return fail("Unknown question.");
  const k = kind === "SKIPPED" || kind === "DONT_KNOW" ? kind : "TYPED";
  const { answerQuestion } = await import("@/lib/contentInterview");
  try {
    const a = topicActor(v);
    await answerQuestion(iv.id, questionKey, { text: k === "TYPED" ? clip((text ?? "").trim(), 8000) : null, kind: k, actor: { clientUserId: a.clientUserId, staffUserId: a.staffUserId }, questionText: questionText ?? null });
    return { ok: true, message: k === "TYPED" ? "Saved." : k === "SKIPPED" ? "Skipped." : "Noted — no worries." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/** Send the answers: the month's written planning moves on and we draft the script from them (staff-side). */
export async function portalSubmitInterview(auth: PortalAuth, interviewId: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const iv = await interviewOwned(v.enrollment.id, interviewId);
  if (!iv) return fail("Those questions aren't on your page.");
  const { submitInterview } = await import("@/lib/contentInterview");
  try {
    const a = topicActor(v);
    await submitInterview(iv.id, { clientUserId: a.clientUserId, staffUserId: a.staffUserId });
    // The month's derived state (written path: preparation completes on submission) is recomputed by the program layer.
    const { recalcProgramMonth } = await import("@/lib/programMonths");
    await recalcProgramMonth(iv.monthId).catch(() => {});
    const topic = await prisma.contentTopic.findUnique({ where: { id: iv.topicId }, select: { title: true } });
    await ownerBell("portal_interview", `Planning answers in — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)} answered the questions for "${topic?.title ?? "a topic"}" — ready to draft.`, `/content/${v.enrollment.id}?tab=topics`, `portal-interview-${iv.id}`);
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: "Sent — we'll draft the script from your answers and share it here for your read-through." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't send — try again.");
  }
}

/** A correction to the released strategy → a proposal for staff, never an edit. */
export async function portalProposeStrategyCorrection(auth: PortalAuth, input: { summary: string; section?: string | null }): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const summary = clip((input.summary ?? "").trim(), 500);
  if (summary.length < 3) return fail("Tell us what to correct.");
  const open = await prisma.contentStrategyProposal.count({ where: { enrollmentId: v.enrollment.id, status: "PROPOSED", sourceKind: "client" } });
  if (open >= 10) return fail("You have a few corrections in already — we'll go through them with you. Text us if it's urgent.");
  const { createStrategyProposal } = await import("@/lib/contentStrategy");
  try {
    const section = clip((input.section ?? "").trim(), 120);
    await createStrategyProposal({
      enrollmentId: v.enrollment.id, kind: "STRATEGY", summary: section ? `[${section}] ${summary}` : summary, sourceKind: "client", sourceRef: `portal:${actorLabel(v)}`,
      clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null, impact: "Client correction from the portal — review against the released version before accepting.",
    });
    await ownerBell("portal_strategy_proposal", `Strategy correction — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)}: ${clip(summary, 120)}`, `/content/${v.enrollment.id}?tab=strategy`, `portal-strategy-${v.enrollment.id}-${new Date().toISOString().slice(0, 13)}`);
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: "Got it — we'll review the correction and update your strategy if it changes anything. Your current version stays as is until then." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't send — try again.");
  }
}

/**
 * "Plan without a call" for a month — only when the enrollment is eligible
 * (portalPlanning.noCallEligible: call mode OPTIONAL_WRITTEN and not switched
 * off for this client). Sets the written path and nothing else: a booked call
 * is NOT cancelled here (that is a separate, explicit act on Calendly).
 */
export async function portalPlanWithoutCall(auth: PortalAuth, monthId: string): Promise<R> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  const month = await openMonthForEnrollment(v.enrollment.id, monthId);
  if (!month) return fail("Pick one of your open program months.");
  const { portalPlanning } = await import("@/lib/portal");
  const p = await portalPlanning(v.enrollment, month.id);
  if (!p) return fail("Pick one of your open program months.");
  if (!p.noCallEligible) return fail("Your program plans each month on a strategy call — book it and we'll take it from there.");
  if (p.planningMode === "WRITTEN") return { ok: true, message: "You're already planning this month in writing." };
  const { setPlanningMode } = await import("@/lib/programMonths");
  await setPlanningMode(month.id, "WRITTEN");
  await ownerBell("portal_planning", `Planning in writing — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)} chose to plan ${month.monthKey} without a call.${p.callStatus === "SCHEDULED" ? " A call is still booked — cancel it on Calendly if it is no longer needed." : ""}`, `/content/${v.enrollment.id}`, `portal-planning-${month.id}`);
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return { ok: true, message: p.callStatus === "SCHEDULED" ? "Done — this month is planned in writing. Your booked call is still on the calendar; cancel it on Calendly if you no longer need it." : "Done — this month is planned in writing. Pick your topics and answer the questions; session booking opens once your answers are in." };
}

/** Cancel one of the client's own session requests (a confirmed one becomes a cancellation request the desk actions). */
export async function portalCancelSessionRequest(auth: PortalAuth, requestId: string, reason?: string): Promise<R> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  if (!/^[a-z0-9]{10,40}$/i.test(requestId)) return fail("That request isn't on your page.");
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { id: true, enrollmentId: true, status: true } });
  if (!r || r.enrollmentId !== v.enrollment.id) return fail("That request isn't on your page.");
  if (!["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED"].includes(r.status)) return fail("That request is already closed.");
  const { cancelSessionRequest } = await import("@/lib/sessionRequests");
  await cancelSessionRequest(r.id, v.actor.kind === "STAFF" ? v.actor.staffUserId : v.actor.kind === "CLIENT" ? v.actor.clientUserId : null, clip((reason ?? "").trim(), 300) || `Cancelled on the portal by ${actorLabel(v)}`);
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return { ok: true, message: r.status === "CONFIRMED" ? "Cancellation requested — the session is on the calendar, so we'll confirm once it's taken off." : "Cancelled." };
}

/** "Marked as posted by me" — the client's own note, never a verified publication. */
export async function portalMarkPosted(auth: PortalAuth, videoId: string, posted: boolean): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  return setPostedByClient(v, videoId, !!posted);
}

/** Save an edited caption as a new version (never overwrites the draft it came from). */
export async function portalSaveCaption(auth: PortalAuth, videoId: string, input: { kind: string; body: string; basedOnId?: string | null }): Promise<RId> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  return saveCaptionEdit(v, videoId, input);
}

/** "Draft a caption" — runs only when caption_assistant is ON; otherwise says why not. */
export async function portalDraftCaption(auth: PortalAuth, videoId: string): Promise<R & { drafted?: number }> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  return draftCaptionForVideo(v, videoId);
}
