"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { resolvePortalViewer, submissionForEnrollment, scriptForEnrollment, topicForEnrollment, openMonthForEnrollment, type PortalViewer } from "@/lib/portal";
import { can, actorLabel, refusalMessage, type PortalPermission } from "@/lib/portalAccess";
import { approveCut, requestChangesOnCut, replyToComment, setCommentResolved, isMine, type OpenNotesChoice } from "@/lib/clientDecisions";
import { setPostedByClient, saveCaptionEdit, draftCaptionForVideo } from "@/lib/postingKit";
import { clip } from "@/lib/text";
import { contentHref } from "@/lib/contentNav"; // UI-02: the one builder of staff client-file links

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
  if (open >= OPEN_SUGGESTION_CAP) return fail("You have a lot of suggestions in already — we're on them! If it's urgent, send us a message on the Messages page.");
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
    contentHref(enrollment.id, { tab: "plan", view: "scripts", month: scriptMonth?.monthKey ?? null }),
    // Hour-bucketed: several suggestions in one sitting ring once.
    `portal-sugg-${enrollment.id}-${new Date().toISOString().slice(0, 13)}`,
  );
  revalidatePath(`/content/${enrollment.id}`);
  return { ok: true, message: "Got it — we'll take a look and update the script." };
}

/**
 * "Yes — I'll film this." The client's own verdict on the script they were
 * shown, pinned to the exact version (F09). Staff approval and release are two
 * separate acts and stay ours; this is the third and it is theirs.
 */
export async function portalApproveScript(auth: PortalAuth, scriptId: string, readVersionId: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const { clientApproveScript } = await import("@/lib/scriptDecisions");
  // R1: readVersionId is the version the PAGE was showing. The server refuses
  // if a newer one has been released since, rather than approving words the
  // client never read.
  const r = await clientApproveScript(v, scriptId, readVersionId);
  if (!r.ok) return fail(r.message);
  if (!r.duplicate) {
    const script = await prisma.contentScript.findUnique({ where: { id: scriptId }, select: { title: true } });
    await ownerBell(
      "portal_script_approved",
      `Script signed off — ${v.enrollment.clientName || "a client"}`,
      `${actorLabel(v)} approved "${script?.title ?? "a script"}" as written.`,
      contentHref(v.enrollment.id, { tab: "plan", view: "scripts" }),
      `portal-script-ok-${scriptId}`,
    );
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  }
  return { ok: true, message: r.message };
}

/**
 * "Change this." Recorded against the version they read and routed into the
 * suggestion queue staff already work from — never an edit, never a model call
 * on the client's click.
 */
export async function portalRequestScriptChanges(auth: PortalAuth, scriptId: string, note: string, readVersionId: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const { clientRequestScriptChanges } = await import("@/lib/scriptDecisions");
  const r = await clientRequestScriptChanges(v, scriptId, note, readVersionId);
  if (!r.ok) return fail(r.message);
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return { ok: true, message: r.message };
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
 * overall note) becomes ONE revision round for this video, through the same
 * machinery a text or call uses, and a ClientDecision(REQUEST_CHANGES) keyed
 * to the exact cut records it. A second submit while that request is open is
 * an addendum to it — the same editor request, no second job (CP-03).
 *
 * `opts.requestKey` is the browser's id for this attempt (a retry returns the
 * same receipt); `opts.acknowledgeExtraFee` is the fee checkbox, which only an
 * OWNER seat or staff can give — enforced in clientDecisions, not here.
 */
export async function portalRequestRevision(
  auth: PortalAuth,
  submissionId: string,
  generalNote: string,
  opts: { requestKey?: string | null; acknowledgeExtraFee?: boolean } = {},
): Promise<R & { duplicate?: boolean; needsFeeAck?: boolean; ackText?: string | null }> {
  const v = await viewerFor(auth, "requestChanges");
  if (typeof v === "string") return fail(v);
  const r = await requestChangesOnCut(v, submissionId, generalNote, {
    requestKey: typeof opts?.requestKey === "string" ? opts.requestKey : null,
    acknowledgeExtraFee: opts?.acknowledgeExtraFee === true,
  });
  if (!r.ok) return { ok: false, message: r.message, needsFeeAck: r.needsFeeAck, ackText: r.ackText ?? null };
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
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
    contentHref(v.enrollment.id, { tab: "production", view: "videos" }),
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

/**
 * Client updates their own Brand Profile (CP-06). `undefined` leaves a field
 * alone; `null` or "" CLEARS it — the old rule ("blank means leave it alone")
 * made clearing impossible, and a mixed save reported "Saved" while silently
 * keeping the value the client had just removed. The work is
 * saveClientBrandProfile (src/lib/brandProfile.ts): client-owned fields only
 * (the internal editingPreferences/clientPreferences are admin-authored notes
 * a public token must never rewrite — adversarial review, Aug 28), a history
 * row per changed field, and the editor's banner + Kyle's confirmation task.
 */
export async function portalSaveProfile(
  auth: PortalAuth,
  input: import("@/lib/brandProfile").BrandPatch,
): Promise<R & { saved?: string[]; cleared?: string[] }> {
  const v = await viewerFor(auth, "editBrandProfile");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  const { saveClientBrandProfile } = await import("@/lib/brandProfile");
  const r = await saveClientBrandProfile(v, input ?? {});
  if (!r.ok) return fail(r.message);
  if (r.changeIds.length) {
    await ownerBell(
      "portal_profile",
      `Profile updated — ${enrollment.clientName || "a client"}`,
      `${actorLabel(v)} updated the brand profile on the portal${r.cleared.length ? ` (cleared ${r.cleared.join(", ").toLowerCase()})` : ""}.`,
      `/clients/${enrollment.clientId}`,
      `portal-profile-${enrollment.id}-${new Date().toISOString().slice(0, 13)}`,
    );
  }
  try { revalidatePath(`/content/${enrollment.id}`); } catch { /* outside a request */ }
  return { ok: true, message: r.message, saved: r.saved, cleared: r.cleared };
}

/** The account-setup checklist (CP-06), as this person sees it. */
export async function portalSetupChecklist(auth: PortalAuth): Promise<{ ok: boolean; message: string; checklist?: import("@/lib/portalSetup").SetupChecklist }> {
  const r = await resolvePortalViewer({ token: auth?.token ?? null, enrollmentId: auth?.enrollmentId ?? null });
  if (!r.ok) return fail(r.reason === "no_session" || r.reason === "no_membership" ? "Please sign in to do that." : LINK_DEAD);
  const { setupChecklist } = await import("@/lib/portalSetup");
  return { ok: true, message: "", checklist: await setupChecklist(r.viewer) };
}

/** "Skip for now" on a setup step, or put it back. Never marks anything done. */
export async function portalSkipSetupItem(auth: PortalAuth, key: string, skip: boolean): Promise<R> {
  const v = await viewerFor(auth, "editBrandProfile");
  if (typeof v === "string") return fail(v);
  const { skipSetupItem } = await import("@/lib/portalSetup");
  return skipSetupItem(v, String(key ?? ""), skip !== false);
}

/**
 * "This is my logo" / "This is my headshot" on a file already in their brand
 * folder: filed on the profile without uploading it a second time. The server
 * finds the file in their own folder by name (brandProfile.claimFolderFileForPortal).
 */
export async function portalUseFolderFile(auth: PortalAuth, name: string, kind: "LOGO" | "HEADSHOT"): Promise<R> {
  const v = await viewerFor(auth, "editBrandProfile");
  if (typeof v === "string") return fail(v);
  const { claimFolderFileForPortal } = await import("@/lib/brandProfile");
  try {
    const r = await claimFolderFileForPortal(v, { name: String(name ?? "").slice(0, 200), kind });
    if (r.ok) { try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ } }
    return { ok: r.ok, message: r.message };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
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
 * writes to Aryeo.
 *
 * THE PREPARATION WINDOW (§8; corrected in batch 1, Sep 21 2026). The rule is
 * 48 hours of WEEKDAY time after the strategy call ENDS, or after enough
 * online preparation — not the three business days this comment used to claim
 * and not measured from the call's start. `sessionGate` derives it
 * (deriveMonthState → addWeekdayHoursET) and returns `earliest`; the line
 * below is what actually enforces it. The picker only greys out the slots.
 *
 * HOW EXISTING BOOKINGS STAY STABLE (Jordan asked for this in writing). The
 * window is evaluated at REQUEST TIME and nowhere else. It is a derived value:
 * no ProgramSessionRequest stores it, no confirmed Aryeo appointment is
 * re-checked against it, and nothing in the tree revisits a request once it is
 * written — `sessionGate` has exactly two other callers and both are display
 * (src/lib/portal.ts scheduleMonths, and the reminder text's "earliest
 * session" line). So moving the rule moves the DOOR, never anything already
 * through it: every session already requested, confirmed or filmed keeps its
 * date, its desk task and its deadlines, and only a NEW request is measured
 * against the corrected clock. The one visible change for an existing client
 * is the earliest date their picker offers next time.
 */
export async function portalRequestSession(
  auth: PortalAuth,
  input: { monthId: string; when?: string; slotISO?: string; location: string; creativeTeamMemberId?: string | null },
): Promise<SessionRequestResult> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  const { enrollment } = v;
  const location = clip((input.location ?? "").trim(), 300);
  if (!location) return fail("Tell us where we're filming.");
  const monthId = String(input.monthId ?? "");
  if (!/^[a-z0-9]{10,40}$/i.test(monthId)) return fail("Pick one of your program months.");

  // CP-04: weekends and the 24-hour line are refused FIRST, server-side, with
  // their own words — a slot POSTed straight at this action never reaches the
  // picker that hides them, and neither rule depends on the month's planning
  // state. Inside 24 hours the answer is Kyle's number, not "the prep window"
  // (which is what the gate's 24-hour floor used to say).
  if (input.slotISO) {
    const picked = new Date(input.slotISO);
    if (!Number.isFinite(picked.getTime())) return fail("Pick a time from the list.");
    const { sessionSlotRefusal } = await import("@/lib/portal");
    const weekend = sessionSlotRefusal(picked);
    if (weekend) return fail(weekend);
    const { within24hElapsed, INSIDE_24H_MESSAGE } = await import("@/lib/sessionBooking");
    if (within24hElapsed(picked, new Date())) return fail(INSIDE_24H_MESSAGE);
  }

  const { sessionGate } = await import("@/lib/portal");
  const gate = await sessionGate(enrollment.id, monthId); // refuses a month that is not this enrollment's
  if (gate.locked) return fail(gate.reason);

  const when = clip((input.when ?? "").trim(), 500);
  let startISO: string | null = null;
  let endISO: string | null = null;
  if (input.slotISO) {
    const slot = new Date(input.slotISO);
    if (!Number.isFinite(slot.getTime())) return fail("Pick a time from the list.");
    // THE GATE, for real. `gate.earliest` is the later of the §8 preparation
    // window and a 24-hour floor (a same-day ask is not a request the desk can
    // honour), so this one comparison enforces both.
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
  // CP-04: the creative the client picked must be one Aryeo assigns to their
  // package's product. An id we cannot place is refused; an Aryeo we cannot
  // reach is not the client's problem — the adapter rechecks before any write.
  let creative: { teamMemberId: string; name: string | null } | null = null;
  const creativeId = String(input.creativeTeamMemberId ?? "").trim();
  if (creativeId) {
    if (!/^[0-9a-f-]{20,40}$/i.test(creativeId)) return fail("Pick a videographer from the list.");
    const pkg = (await prisma.contentEnrollment.findUnique({ where: { id: enrollment.id }, select: { package: true } }))?.package ?? null;
    const { aryeoProductFor } = await import("@/lib/contentProgram");
    const product = aryeoProductFor(pkg);
    if (!product) return fail("Pick a videographer from the list.");
    const { productProvidersFor } = await import("@/lib/integrations/aryeo");
    const roster = await productProvidersFor(product.productId).catch(() => null);
    const hit = roster?.find((p) => p.teamMemberId === creativeId && p.bookable) ?? null;
    if (roster && !hit) return fail("That videographer isn't available for your package. Pick another time or person.");
    creative = { teamMemberId: creativeId, name: hit?.name ?? null };
  }
  const { createSessionRequest, sessionRequestLabel } = await import("@/lib/sessionRequests");
  const r = await createSessionRequest({
    enrollmentId: enrollment.id,
    monthId,
    slot: { startISO, endISO, timezone: null, when: when || null, locationText: location, notes: `Requested on the portal by ${actorLabel(v)}.` },
    actor,
    creative,
  });
  if (!r.ok) return fail(r.reason);
  // Self-booking (only for a client the guard authorises): book it now, inside
  // this request, so the client sees "Booked" rather than waiting for the hour.
  // Anything that does not finish here, the cron finishes; nothing is lost.
  let state = { status: r.status, bookingState: "NONE" as string };
  if (!r.duplicate) {
    const row = await prisma.programSessionRequest.findUnique({ where: { id: r.id }, select: { status: true, bookingState: true } });
    if (row?.bookingState === "QUEUED") {
      const { bookSessionRequest } = await import("@/lib/sessionBooking");
      await bookSessionRequest(r.id, { worker: "portal", budgetMs: 25_000 }).catch(() => null);
    }
    const after = await prisma.programSessionRequest.findUnique({ where: { id: r.id }, select: { status: true, bookingState: true } });
    if (after) state = after;
  }
  // Best-effort: the owner's workspace re-reads on its next render anyway,
  // and outside a request scope (a probe calling the action directly) Next
  // throws here — the request row is already written, so never let that
  // turn a successful request into an error.
  try { revalidatePath(`/content/${enrollment.id}`); } catch { /* not in a request */ }
  const label = sessionRequestLabel(state.status, state.bookingState);
  return {
    ok: state.bookingState !== "CONFLICT",
    message: r.duplicate
      ? "We already have this request. It shows here as requested until it is on the calendar."
      : state.status === "CONFIRMED" ? "Booked. Your session is on the calendar."
      : state.bookingState === "CONFLICT" ? label
      : r.message,
    requestId: r.id,
    label,
    duplicate: r.duplicate,
  };
}

/** Move one of the client's own sessions (CP-04). Inside 24 hours → Kyle's number. */
export async function portalRescheduleSession(
  auth: PortalAuth,
  requestId: string,
  input: { slotISO: string; creativeTeamMemberId?: string | null; location?: string | null },
): Promise<R & { id?: string }> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  if (!/^[a-z0-9]{10,40}$/i.test(requestId)) return fail("That request isn't on your page.");
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { id: true, enrollmentId: true, monthId: true } });
  if (!r || r.enrollmentId !== v.enrollment.id) return fail("That request isn't on your page.");
  const slot = new Date(input.slotISO ?? "");
  if (!Number.isFinite(slot.getTime())) return fail("Pick a time from the list.");
  const { sessionGate } = await import("@/lib/portal");
  const gate = await sessionGate(v.enrollment.id, r.monthId);
  const { within24hElapsed, INSIDE_24H_MESSAGE } = await import("@/lib/sessionBooking");
  if (within24hElapsed(slot, new Date())) return fail(INSIDE_24H_MESSAGE);
  if (gate.locked) return fail(gate.reason);
  if (slot < gate.earliest) return fail("That time is inside the prep window after your strategy call. Pick a later slot.");
  const creativeId = String(input.creativeTeamMemberId ?? "").trim();
  const creative = creativeId && /^[0-9a-f-]{20,40}$/i.test(creativeId) ? { teamMemberId: creativeId, name: null } : null;
  const hours = (await prisma.contentEnrollment.findUnique({ where: { id: v.enrollment.id }, select: { sessionHours: true } }))?.sessionHours ?? 2;
  const a = v.actor;
  const actor =
    a.kind === "CLIENT" ? { kind: "CLIENT" as const, clientUserId: a.clientUserId }
    : a.kind === "STAFF" ? { kind: "STAFF" as const, userId: a.staffUserId }
    : { kind: "TOKEN" as const };
  const { requestReschedule } = await import("@/lib/sessionRequests");
  const out = await requestReschedule(r.id, { startISO: slot.toISOString(), endISO: new Date(slot.getTime() + hours * 3600_000).toISOString(), locationText: input.location ? clip(input.location.trim(), 300) : null }, creative, actor);
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return out;
}

/** The exact filming address for one session, from the signed-in portal (CP-05). */
export async function portalSubmitSessionAddress(
  auth: PortalAuth,
  sessionKey: string,
  input: { street: string; unit?: string | null; city: string; state: string; zip: string },
): Promise<R> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  if (!/^(appt|project|request):[A-Za-z0-9_-]{6,60}$/.test(sessionKey ?? "")) return fail("That session isn't on your page.");
  const { submitSessionAddress } = await import("@/lib/sessionAddress");
  const r = await submitSessionAddress({ kind: "PORTAL", enrollmentId: v.enrollment.id, sessionKey, by: actorLabel(v) }, input);
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return { ok: r.ok, message: r.message };
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
    if (r.outcome === "WITHHELD") return fail("That topic was set aside earlier. Send us a message on the Messages page if you'd like it back on the table.");
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

/**
 * The client suggests a topic of their own. It joins their bank as theirs and
 * is usable at once — no approval (Jordan, Sep 24) — and, when they ask, goes
 * straight into a month (CP-07). The selection's outcome comes back to them:
 * a full month says "added as an extra", a failure says it failed, instead of
 * the old `.catch(() => {})` reporting success over nothing.
 */
export async function portalSuggestTopic(auth: PortalAuth, input: { title: string; concept?: string; pillarId?: string | null; monthId?: string | null }): Promise<RId & { monthId?: string | null; selected?: boolean }> {
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
  if (recent >= 20) return fail("That's a lot of ideas for one day — we love it, but let's talk them through. Send us a message on the Messages page!");
  const { createTopic, selectTopicForMonth, undeclineTopicForClient, flagClientTopicAlignment, adoptTopicAsClientIdea } = await import("@/lib/contentTopics");
  const month = input.monthId ? await openMonthForEnrollment(v.enrollment.id, input.monthId) : null;
  if (input.monthId && !month) return fail("Pick one of your open program months.");
  try {
    const actor = topicActor(v);
    const r = await createTopic({
      enrollmentId: v.enrollment.id, title, concept, pillarId, source: "client", clientUserId: actor.clientUserId, clientWording: title,
      approvalState: "PROPOSED", actor, eventKind: "CREATED", note: `Suggested on the portal by ${actorLabel(v)}`,
    });
    let adopted = false;
    if (r.existed) {
      // The same idea again. Theirs to set aside was theirs to bring back; one
      // the office set aside is a conversation, not a silent revival.
      const prior = await prisma.contentTopic.findUnique({ where: { id: r.id }, select: { clientDeclinedAt: true, status: true, approvalState: true } });
      if (prior?.clientDeclinedAt) await undeclineTopicForClient(r.id, actor);
      if (prior && (prior.status === "REJECTED" || prior.status === "ARCHIVED" || prior.approvalState === "REJECTED" || prior.approvalState === "ARCHIVED")) {
        const { discussTopic } = await import("@/lib/contentTopics");
        await discussTopic(r.id, `The client suggested this again on the portal (${actorLabel(v)}) — it was set aside earlier; reintroduce it if that changed`, { kind: "SYSTEM" }, "portal");
        return { ok: true, message: "We set that one aside earlier — we'll talk it through with you.", id: r.id };
      }
      // A call's or the AI's topic they cannot see yet: their typing it makes
      // it theirs (usable without approval), rather than "already on your list"
      // about something that is not on their page.
      adopted = await adoptTopicAsClientIdea(r.id, v.enrollment.id, actor, title);
      if (adopted) await flagClientTopicAlignment(r.id).catch(() => null);
      else if (!prior?.clientDeclinedAt && !month) return { ok: true, message: "We already have that idea on your list.", id: r.id };
    } else {
      // Internal only, and never a block: a client's idea is usable as is.
      await flagClientTopicAlignment(r.id).catch(() => null);
    }
    let selected = false;
    let message = r.existed && !adopted ? "It's back in your bank." : "Added to your bank — it's yours to use.";
    if (month) {
      const { monthLabel } = await import("@/lib/contentProgram");
      try {
        const sel = await selectTopicForMonth(r.id, month.id, { source: "client", actor, status: "SELECTED" });
        if (sel.outcome === "WITHHELD") message = "Added to your bank, but that one was set aside earlier. Send us a message on the Messages page if you'd like it for this month.";
        else {
          selected = true;
          message = sel.overflow
            ? `Added for ${monthLabel(month.monthKey)} as an extra — your package covers ${month.videosOwed} video${month.videosOwed === 1 ? "" : "s"} that month, so this one waits its turn (nothing is thrown away).`
            : `Added and selected for ${monthLabel(month.monthKey)}.`;
        }
      } catch (e) {
        return { ok: false, message: `Your idea is saved in your bank, but it couldn't be added to ${monthLabel(month.monthKey)}: ${e instanceof Error ? e.message : "try selecting it again"}`, id: r.id };
      }
    }
    await ownerBell("portal_topic", `Topic idea — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)}: ${clip(title, 120)}${selected && month ? ` (selected for ${month.monthKey})` : ""}`, contentHref(v.enrollment.id, { tab: "plan", view: "topics" }), `portal-topic-${v.enrollment.id}-${new Date().toISOString().slice(0, 13)}`);
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message, id: r.id, monthId: selected ? month!.id : null, selected };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/** "Not interested" (CP-07): out of their bank with an optional reason, never re-suggested, and undoable. */
export async function portalDeclineTopic(auth: PortalAuth, topicId: string, reason?: string | null): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const topic = await topicForEnrollment(v.enrollment.id, topicId);
  if (!topic) return fail("That topic isn't in your bank.");
  const { declineTopicForClient } = await import("@/lib/contentTopics");
  const why = clip((reason ?? "").trim(), 500) || null;
  try {
    await declineTopicForClient(topic.id, topicActor(v), why);
    await ownerBell("portal_topic_declined", `Topic set aside — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)}: not interested in "${clip(topic.title, 100)}"${why ? ` — ${clip(why, 120)}` : ""}`, contentHref(v.enrollment.id, { tab: "plan", view: "topics" }), `portal-topic-declined-${topic.id}`);
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: "Set aside — we won't suggest it again. You can undo this below." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/** Undo "not interested". */
export async function portalUndeclineTopic(auth: PortalAuth, topicId: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const topic = await topicForEnrollment(v.enrollment.id, topicId, { allowDeclined: true });
  if (!topic) return fail("That topic isn't in your bank.");
  const { undeclineTopicForClient } = await import("@/lib/contentTopics");
  try {
    await undeclineTopicForClient(topic.id, topicActor(v));
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: "Back in your bank." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/**
 * Swap a carried-over, unfilmed script for another topic (CP-07). The script
 * and its history are kept ("scripted, not filmed"); the new topic takes the
 * slot, so the allowance is never counted twice.
 */
export async function portalSwapCarriedTopic(auth: PortalAuth, selectionId: string, replacementTopicId: string): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  if (!/^[a-z0-9]{10,40}$/i.test(selectionId ?? "")) return fail("That isn't on your plan.");
  const sel = await prisma.contentTopicSelection.findUnique({ where: { id: selectionId }, select: { id: true, enrollmentId: true, monthId: true } });
  if (!sel || sel.enrollmentId !== v.enrollment.id) return fail("That isn't on your plan.");
  const month = await openMonthForEnrollment(v.enrollment.id, sel.monthId);
  if (!month) return fail("That month is closed. Send us a message on the Messages page if something needs to change.");
  const repl = await topicForEnrollment(v.enrollment.id, replacementTopicId);
  if (!repl) return fail("Pick a topic from your bank to swap in.");
  const { swapCarriedTopic } = await import("@/lib/contentTopics");
  try {
    await swapCarriedTopic(sel.id, repl.id, topicActor(v));
    const { monthLabel } = await import("@/lib/contentProgram");
    await ownerBell("portal_topic", `Carried script swapped — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)} swapped a carried-over script for "${clip(repl.title, 100)}" in ${month.monthKey}.`, contentHref(v.enrollment.id, { tab: "plan", view: "topics" }), `portal-topic-swap-${sel.id}`);
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return { ok: true, message: `Swapped — "${clip(repl.title, 80)}" is on ${monthLabel(month.monthKey)} now. The earlier script is kept under "Scripted, not filmed".` };
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
  await ownerBell("portal_topic_note", `Topic note — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)} on "${topic.title}": ${clip(text, 120)}`, contentHref(v.enrollment.id, { tab: "plan", view: "topics" }), `portal-topic-note-${topic.id}-${new Date().toISOString().slice(0, 13)}`);
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
export async function portalAnswerInterview(auth: PortalAuth, interviewId: string, questionKey: string, text: string, kind: "TYPED" | "SKIPPED" | "DONT_KNOW", questionText?: string | null, suggestionId?: string | null): Promise<R> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const iv = await interviewOwned(v.enrollment.id, interviewId);
  if (!iv) return fail("Those questions aren't on your page.");
  if (!/^[a-zA-Z]+(?::fu:[a-z-]+)?$/.test(questionKey)) return fail("Unknown question.");
  const k = kind === "SKIPPED" || kind === "DONT_KNOW" ? kind : "TYPED";
  const { answerQuestion } = await import("@/lib/contentInterview");
  try {
    const a = topicActor(v);
    // A suggestion id is only a pointer; answerQuestion re-resolves it on the server.
    const sid = suggestionId && /^[a-f0-9]{10,40}$/i.test(suggestionId) ? suggestionId : null;
    await answerQuestion(iv.id, questionKey, { text: k === "TYPED" ? clip((text ?? "").trim(), 8000) : null, kind: k, actor: { clientUserId: a.clientUserId, staffUserId: a.staffUserId }, questionText: questionText ?? null, suggestionId: sid });
    return { ok: true, message: k === "TYPED" ? "Saved." : k === "SKIPPED" ? "Skipped." : "Noted — no worries." };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "That didn't save — try again.");
  }
}

/**
 * Send the answers. CP-08: "we'll draft the script" is said only when the
 * answers can carry one (SUBMITTED). Answers that cannot are refused unless the
 * client chooses to send what they have (`acknowledgeGaps`), which is
 * SUBMITTED_WITH_GAPS: nothing is drafted, the preparation clock does not
 * start, Kyle follows up — and the client is told exactly that.
 */
export async function portalSubmitInterview(auth: PortalAuth, interviewId: string, opts: { acknowledgeGaps?: boolean } = {}): Promise<R & { status?: "SUBMITTED" | "SUBMITTED_WITH_GAPS" }> {
  const v = await viewerFor(auth, "suggest");
  if (typeof v === "string") return fail(v);
  const iv = await interviewOwned(v.enrollment.id, interviewId);
  if (!iv) return fail("Those questions aren't on your page.");
  const { submitInterview } = await import("@/lib/contentInterview");
  try {
    const a = topicActor(v);
    const r = await submitInterview(iv.id, { clientUserId: a.clientUserId, staffUserId: a.staffUserId }, { acknowledgeGaps: opts?.acknowledgeGaps === true });
    // The month's derived state (written path: preparation completes on a SUFFICIENT submission) is recomputed by the program layer.
    const { recalcProgramMonth } = await import("@/lib/programMonths");
    await recalcProgramMonth(iv.monthId).catch(() => {});
    const topic = await prisma.contentTopic.findUnique({ where: { id: iv.topicId }, select: { title: true } });
    const gaps = r.status === "SUBMITTED_WITH_GAPS";
    await ownerBell(
      "portal_interview",
      gaps ? `Planning answers sent with gaps — ${v.enrollment.clientName || "a client"}` : `Planning answers in — ${v.enrollment.clientName || "a client"}`,
      gaps ? `${actorLabel(v)} sent what they have for "${topic?.title ?? "a topic"}" — not enough to draft yet; Kyle has the follow-up.` : `${actorLabel(v)} answered the questions for "${topic?.title ?? "a topic"}" — ready to draft.`,
      contentHref(v.enrollment.id, { tab: "plan", view: "topics" }),
      `portal-interview-${iv.id}${gaps ? "-gaps" : ""}`,
    );
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
    return gaps
      ? { ok: true, status: r.status, message: "Sent — thank you. It isn't quite enough to write the script yet, so we'll follow up with a question or two. Nothing is drafted until then, and you can add more here any time." }
      : { ok: true, status: r.status, message: "Sent — we'll draft the script from your answers and share it here for your read-through." };
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
  if (open >= 10) return fail("You have a few corrections in already — we'll go through them with you. If it's urgent, send us a message on the Messages page.");
  const { createStrategyProposal } = await import("@/lib/contentStrategy");
  try {
    const section = clip((input.section ?? "").trim(), 120);
    // CP-11: a correction that names a section of the strategy in force is
    // aimed at THAT section (Jordan writes the replacement when he accepts it);
    // one that names nothing recognisable stays unplaced, as before.
    const { approvedStrategy } = await import("@/lib/contentStrategy");
    const { resolveSection, SECTION_TARGET_PREFIX } = await import("@/lib/profileFields");
    const hit = section ? resolveSection((await approvedStrategy(v.enrollment.id).catch(() => null))?.stored ?? null, section) : null;
    await createStrategyProposal({
      enrollmentId: v.enrollment.id, kind: "STRATEGY", summary: section ? `[${section}] ${summary}` : summary, sourceKind: "client", sourceRef: `portal:${actorLabel(v)}`,
      clientUserId: v.actor.kind === "CLIENT" ? v.actor.clientUserId : null, impact: "Client correction from the portal — review against the released version before accepting.",
      ...(hit ? { targetKey: `${SECTION_TARGET_PREFIX}${hit.id}`, diff: [{ path: `${SECTION_TARGET_PREFIX}${hit.id}`, from: hit.text, to: "" }] } : {}),
    });
    await ownerBell("portal_strategy_proposal", `Strategy correction — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)}: ${clip(summary, 120)}`, contentHref(v.enrollment.id, { tab: "plan", view: "strategy" }), `portal-strategy-${v.enrollment.id}-${new Date().toISOString().slice(0, 13)}`);
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

/**
 * The way BACK from "plan in writing". Choosing the written path used to be a
 * one-way door on the portal — the card showed the status and nothing else, so
 * a client who tapped it by mistake could not get their call back without
 * texting us (review, Sep 17). Same permission and same eligibility check as
 * the outward choice; it only flips the month's planning mode, never a booking.
 */
export async function portalPlanWithCall(auth: PortalAuth, monthId: string): Promise<R> {
  const v = await viewerFor(auth, "requestSession");
  if (typeof v === "string") return fail(v);
  const month = await openMonthForEnrollment(v.enrollment.id, monthId);
  if (!month) return fail("Pick one of your open program months.");
  const { portalPlanning } = await import("@/lib/portal");
  const p = await portalPlanning(v.enrollment, month.id);
  if (!p) return fail("Pick one of your open program months.");
  if (!p.noCallEligible) return fail("Your program already plans each month on a strategy call.");
  if (p.planningMode !== "WRITTEN") return { ok: true, message: "This month is already on the strategy-call path." };
  const { setPlanningMode } = await import("@/lib/programMonths");
  await setPlanningMode(month.id, "CALL");
  await ownerBell("portal_planning", `Back to a strategy call — ${v.enrollment.clientName || "a client"}`, `${actorLabel(v)} moved ${month.monthKey} back to the strategy-call path.`, `/content/${v.enrollment.id}`, `portal-planning-back-${month.id}`);
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return { ok: true, message: p.callStatus === "SCHEDULED" ? "Done — this month is back on the call path, and your call is already booked." : "Done — book your strategy call and we'll plan the month on it." };
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
  // CP-04: inside 24 hours a client's cancel is a phone call (Kyle's number);
  // a session the hub booked is cancelled in Aryeo and read back; a hand-booked
  // one goes to Kyle as a CANCELLATION, not a booking.
  const out = await cancelSessionRequest(r.id, v.actor.kind === "STAFF" ? v.actor.staffUserId : v.actor.kind === "CLIENT" ? v.actor.clientUserId : null, clip((reason ?? "").trim(), 300) || `Cancelled on the portal by ${actorLabel(v)}`, { actor: v.actor.kind === "STAFF" ? "STAFF" : "CLIENT" });
  try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  return { ok: out.ok, message: out.message };
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

/**
 * CP-12: the page read every byte of a download — "Saved", distinct from the
 * door's "Download started". Resolve only, deliberately NOT can(): downloads
 * stay open to paused/ended programs and to view-only seats, so recording one
 * must too. The lib proves the video and the file (`ref`) are the ones the
 * release rule serves this viewer right now.
 */
export async function portalDownloadCompleted(auth: PortalAuth, videoId: string, ref: string): Promise<R> {
  const r = await resolvePortalViewer({ token: auth?.token ?? null, enrollmentId: auth?.enrollmentId ?? null });
  if (!r.ok) return fail(r.reason === "no_session" || r.reason === "no_membership" ? "Please sign in to do that." : LINK_DEAD);
  const { recordDownloadCompleted } = await import("@/lib/postingKit");
  return recordDownloadCompleted(r.viewer, videoId, ref);
}

// ===========================================================================
// THE CLIENT'S OWN TEAM (F19 / §4.9-4.10, Sep 21 2026)
//
// The logic lives in src/lib/portalTeam.ts since CP-06 (Sep 24 2026), so the
// Settings & team page and the drills run exactly what these actions run.
// Each wrapper resolves WHO is asking and checks manageTeam (only an OWNER
// seat — never the shared link); the lib re-checks and proves every row
// belongs to this enrollment before writing. With `portal_invites` off an
// invitation is HELD — nothing is created or sent — and it is listed on the
// page and can be cancelled (portalCancelHeldInvite).
// ===========================================================================

export type TeamSeat = import("@/lib/portalTeam").TeamSeat;

/** Who is on this account, for the Settings screen: live seats and held invitations. */
export async function portalTeamMembers(auth: PortalAuth): Promise<{ ok: boolean; message: string; seats: TeamSeat[]; invitationsOn: boolean; signInEmailOn?: boolean }> {
  const v = await viewerFor(auth, "manageTeam");
  if (typeof v === "string") return { ok: false, message: v, seats: [], invitationsOn: false };
  const { teamSeats } = await import("@/lib/portalTeam");
  return teamSeats(v);
}

/** Invite an assistant by name and email (§4.9). Default role OWNER — full program access. */
export async function portalInviteTeammate(
  auth: PortalAuth,
  input: { name: string; email: string; role?: string },
): Promise<R & { membershipId?: string; held?: boolean }> {
  const v = await viewerFor(auth, "manageTeam");
  if (typeof v === "string") return fail(v);
  const { inviteTeammate } = await import("@/lib/portalTeam");
  return inviteTeammate(v, input ?? { name: "", email: "" });
}

/** Change what a teammate may do. The account cannot be left with nobody who can approve. */
export async function portalSetTeammateRole(auth: PortalAuth, membershipId: string, role: string): Promise<R> {
  const v = await viewerFor(auth, "manageTeam");
  if (typeof v === "string") return fail(v);
  const { setTeammateRole } = await import("@/lib/portalTeam");
  return setTeammateRole(v, String(membershipId ?? ""), String(role ?? ""));
}

/** Remove a teammate. Immediate — the resolver re-reads seats on every request. */
export async function portalRevokeTeammate(auth: PortalAuth, membershipId: string): Promise<R> {
  const v = await viewerFor(auth, "manageTeam");
  if (typeof v === "string") return fail(v);
  const { revokeTeammate } = await import("@/lib/portalTeam");
  return revokeTeammate(v, String(membershipId ?? ""));
}

/** Take back an invitation that is still held (never sent). */
export async function portalCancelHeldInvite(auth: PortalAuth, email: string): Promise<R> {
  const v = await viewerFor(auth, "manageTeam");
  if (typeof v === "string") return fail(v);
  const { cancelHeldTeammate } = await import("@/lib/portalTeam");
  return cancelHeldTeammate(v, String(email ?? ""));
}

// ---------------------------------------------------------------------------
// CP-13 — THE PROGRAM CONVERSATION. One thread per account with the office;
// the rules (owner, task, bell, what it will NOT do with a video change) live
// in lib/programMessages.ts. A VIEWER seat and a paused/ended program are
// refused by the same `can()` every other action uses.
// ---------------------------------------------------------------------------

/** Write on the program conversation. Staff through the owner iframe are stored as the office, never as the client. */
export async function portalPostMessage(
  auth: PortalAuth,
  input: { body: string; replyToId?: string | null; ref?: { kind: "TOPIC" | "SCRIPT" | "VIDEO"; id: string } | null },
): Promise<RId> {
  const v = await viewerFor(auth, "message");
  if (typeof v === "string") return fail(v);
  const { postClientMessage } = await import("@/lib/programMessages");
  const r = await postClientMessage(v, { body: String(input?.body ?? ""), replyToId: input?.replyToId ?? null, ref: input?.ref ?? null });
  if (r.ok) {
    try { revalidatePath(`/content/${v.enrollment.id}`); } catch { /* outside a request */ }
  }
  return r;
}
