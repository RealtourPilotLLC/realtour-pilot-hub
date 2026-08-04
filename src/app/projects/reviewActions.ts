"use server";

import { authEnforced, requireAdmin } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { notifyInApp } from "@/lib/notify";

// ---------------------------------------------------------------------------
// Mutations for the in-house media review room (Frame.io-style). The owner
// drops pin-point notes on delivered assets in two lanes — EDIT (Kyle fixes
// it) and PHOTOGRAPHER (capture feedback to whoever shot it; kind "fix" is
// actionable, "coaching" is do-better-next-time and never mints a task).
// Statuses flow OPEN → FIXED (the creative marks it done) → RESOLVED (owner
// approves). "Send to lane" bundles the open notes into ONE deduped task —
// same many-notes-one-task philosophy as flagActions' 24h fix task — and rings
// the right bell. Reads live in src/lib/review.ts.
//
// The bundled tasks use taskType "todo", NOT "image_fixes": image_fixes is in
// tasks.ts DELIVERED_CLOSE_TYPES, so closeObsoleteTasks(projectId,"DELIVERED")
// — which re-fires whenever a revision resolves on a delivered job (comms.ts)
// or the status flaps back to DELIVERED — would silently blanket-complete the
// review task while notes were still open. Review happens ON delivered jobs,
// so that sweep would fight our own closer (last EDIT note FIXED → complete).
// "todo" is swept by nothing; with assignedKey set it also never lands in the
// "Needs assigning" triage pile (src/lib/triage.ts).
// ---------------------------------------------------------------------------

export type NoteLane = "EDIT" | "PHOTOGRAPHER";
export type NoteKind = "fix" | "coaching";

const EDIT_TASK_KEY = (projectId: string) => `review-edit-${projectId}`;
const PHOTOG_TASK_KEY = (projectId: string) => `review-photog-${projectId}`;

const streetOf = (title?: string | null) => (title || "project").split(",")[0].trim();
const firstNameOf = (name?: string | null) => (name || "").trim().split(/\s+/)[0] || "the photographer";

function refresh(projectId: string) {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/shoot/${projectId}`);
}

// Who's writing — authorKey follows the MediaNote convention ("owner" |
// "tm:<teamMemberId>" | "editor:<key>"). Sessionless local dev (enforcement
// off, no cookie) falls back to the owner so the room still works pre-login.
// A photographer whose AppUser row hasn't linked its teamMemberId yet resolves
// through the live roster-email fallback (same one the page guards use) — and
// no signed-in NON-owner is ever aliased to "owner": that key is an identity
// in the thread-reply notifier (it suppresses Jordan's ping and can self-ping
// the addressee), so an unresolvable user gets a neutral key instead.
async function sessionAuthor(): Promise<{ authorKey: string; authorName: string | null }> {
  const u = await getCurrentUser().catch(() => null);
  if (!u) return { authorKey: "owner", authorName: "Jordan" };
  const name = u.name ?? u.email;
  if (u.role === "OWNER") return { authorKey: "owner", authorName: name };
  if (u.teamMemberId) return { authorKey: `tm:${u.teamMemberId}`, authorName: name };
  if (u.editorKey) return { authorKey: `editor:${u.editorKey}`, authorName: name };
  if (u.role === "PHOTOGRAPHER") {
    try {
      const { photographerMemberId } = await import("@/lib/shoot");
      const mid = await photographerMemberId(u);
      if (mid) return { authorKey: `tm:${mid}`, authorName: name };
    } catch { /* fall through to the neutral key */ }
  }
  return { authorKey: `user:${u.id}`, authorName: name };
}

// Whose capture feedback a PHOTOGRAPHER-lane note is: the project's assigned
// photographer, else the earliest appointment assignee (same resolution order
// the shoot pages use).
async function projectPhotographerId(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { photographerId: true } });
  if (p?.photographerId) return p.photographerId;
  const appt = await prisma.appointment.findFirst({
    where: { projectId, assignedToId: { not: null } },
    orderBy: { startAt: "asc" },
    select: { assignedToId: true },
  });
  return appt?.assignedToId ?? null;
}

// Owner/admin, OR the photographer the ROOT note is addressed to (they may
// only touch their own capture feedback). Mirrors requireShootAccess: no-op
// until enforcement is on, fail-closed after, "view as" is read-only.
// `allowMentionedRootId` widens the REPLY path only: a photographer @-tagged
// anywhere on that thread got a ping saying "reply on the note" — the door has
// to open for them. Status/acknowledge callers must NOT pass it, so a mention
// never lets someone flip another photographer's fix status.
async function requireNoteAccess(
  rootPhotographerId: string | null,
  allowMentionedRootId?: string,
): Promise<string | null> {
  if (!authEnforced()) return null;
  const u = await getCurrentUser();
  if (!u) throw new Error("Please sign in to do that.");
  if (u.impersonating) throw new Error("You're previewing another user — exit the preview to make changes.");
  if (u.realRole === "OWNER" || u.realRole === "ADMIN") return null;
  if (u.realRole === "PHOTOGRAPHER") {
    const { photographerMemberId } = await import("@/lib/shoot");
    const mid = await photographerMemberId(u);
    if (mid && rootPhotographerId && mid === rootPhotographerId) return mid;
    if (mid && allowMentionedRootId) {
      // isMentionedIn runs the SAME roster-aware matcher that minted the ping,
      // so the guard admits exactly the people who were told to come here.
      const thread = await prisma.mediaNote.findMany({
        where: { OR: [{ id: allowMentionedRootId }, { parentId: allowMentionedRootId }] },
        select: { body: true },
      });
      const { isMentionedIn } = await import("@/lib/mentions");
      if (await isMentionedIn(thread.map((n) => n.body), mid)) return mid;
    }
  }
  throw new Error("You don't have access to do that.");
}

// Drop one pin-point note on an asset. Owner/admin only — the review room is
// the owner's desk; creatives respond via reply / mark-fixed, never new pins.
export async function addMediaNote(input: {
  projectId: string;
  assetUrl: string;
  thumbUrl?: string | null;
  assetType: "image" | "video";
  x?: number | null;
  y?: number | null;
  timeSec?: number | null;
  lane: NoteLane;
  kind: NoteKind;
  body: string;
}): Promise<{ ok: boolean; id?: string; message?: string }> {
  try {
    await requireAdmin(); // blocks "view as" + non-owner/admin roles
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const body = (input.body ?? "").trim();
  if (!body) return { ok: false, message: "Write the note first." };
  if (input.lane !== "EDIT" && input.lane !== "PHOTOGRAPHER") return { ok: false, message: "Bad lane." };
  if (input.kind !== "fix" && input.kind !== "coaching") return { ok: false, message: "Bad note kind." };
  if (!input.assetUrl) return { ok: false, message: "No asset to note." };

  const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { id: true } });
  if (!project) return { ok: false, message: "That project no longer exists." };

  // PHOTOGRAPHER lane: pin the feedback to whoever shot it (scopes their view).
  const photographerId = input.lane === "PHOTOGRAPHER" ? await projectPhotographerId(input.projectId) : null;
  const { authorKey, authorName } = await sessionAuthor();

  const note = await prisma.mediaNote.create({
    data: {
      projectId: input.projectId,
      assetUrl: input.assetUrl,
      thumbUrl: input.thumbUrl ?? null,
      assetType: input.assetType === "video" ? "video" : "image",
      x: input.x ?? null,
      y: input.y ?? null,
      timeSec: input.timeSec ?? null,
      lane: input.lane,
      kind: input.lane === "PHOTOGRAPHER" ? input.kind : "fix", // EDIT lane is always actionable
      body: body.slice(0, 2000),
      status: "OPEN",
      authorKey,
      authorName,
      photographerId,
    },
  });
  const { notifyMentions } = await import("@/lib/mentions");
  await notifyMentions({ text: body, projectId: input.projectId, authorName, context: "a review note", noteId: note.id });
  refresh(input.projectId);
  return { ok: true, id: note.id };
}

// Threaded reply under a root note. Owner/admin, or the photographer the root
// note is addressed to (they can talk back on their own feedback only).
// Replies inherit the root's asset/lane/kind, carry no pin, and are never
// counted in rollups (those filter parentId null).
export async function replyMediaNote(noteId: string, body: string): Promise<{ ok: boolean; message?: string }> {
  const text = (body ?? "").trim();
  if (!text) return { ok: false, message: "Write a reply first." };

  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  // Replying to a reply re-roots onto the thread's root note.
  const root = note.parentId ? await prisma.mediaNote.findUnique({ where: { id: note.parentId } }) : note;
  if (!root) return { ok: false, message: "That note no longer exists." };

  try {
    // Replies also open to photographers @-tagged on the thread — their
    // mention ping says "reply on the note", so the guard must let them.
    await requireNoteAccess(root.photographerId, root.id);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const { authorKey, authorName } = await sessionAuthor();

  const reply = await prisma.mediaNote.create({
    data: {
      projectId: root.projectId,
      assetUrl: root.assetUrl,
      thumbUrl: root.thumbUrl,
      assetType: root.assetType,
      lane: root.lane,
      kind: root.kind,
      body: text.slice(0, 2000),
      status: "OPEN", // status is meaningless on replies; rollups skip them
      authorKey,
      authorName,
      photographerId: root.photographerId,
      parentId: root.id,
    },
  });
  // Reply is saved — everything below is best-effort notification fan-out.
  // Mentions ring first (they carry the note deep-link); whoever they reached
  // is excluded from the thread-participant ping so nobody hears it twice.
  const { notifyMentions, notifyThreadReply } = await import("@/lib/mentions");
  const excludeTmIds = await notifyMentions({
    text,
    projectId: root.projectId,
    authorName,
    context: "a note comment",
    noteId: root.id,
  });
  await notifyThreadReply({
    rootId: root.id,
    replyId: reply.id,
    replierKey: authorKey,
    replierName: authorName,
    text,
    projectId: root.projectId,
    surface: "gallery",
    excludeTmIds,
  });
  refresh(root.projectId);
  return { ok: true };
}

// Flip a root note OPEN → FIXED → RESOLVED. Owner/admin set anything; a
// photographer may only mark THEIR OWN photographer-lane notes FIXED. When the
// LAST open EDIT note flips to FIXED, Kyle's bundled review task auto-completes
// and the owner gets a "Ready for re-review" bell.
export async function setMediaNoteStatus(
  noteId: string,
  status: "OPEN" | "FIXED" | "RESOLVED",
): Promise<{ ok: boolean; message?: string }> {
  if (status !== "OPEN" && status !== "FIXED" && status !== "RESOLVED") return { ok: false, message: "Bad status." };

  const note = await prisma.mediaNote.findUnique({ where: { id: noteId } });
  if (!note) return { ok: false, message: "That note no longer exists." };
  if (note.parentId) return { ok: false, message: "Replies don't have a status." };

  try {
    if (status === "FIXED" && note.lane === "PHOTOGRAPHER") {
      await requireNoteAccess(note.photographerId); // owner/admin OR that photographer
    } else {
      await requireAdmin(); // reopen + approve stay with the owner's desk
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }

  await prisma.mediaNote.update({
    where: { id: noteId },
    data: {
      status,
      // RESOLVED stamps the approval; reopening clears it; FIXED leaves it be.
      ...(status === "RESOLVED" ? { resolvedAt: new Date() } : status === "OPEN" ? { resolvedAt: null } : {}),
    },
  });

  // Kyle just fixed the LAST open edit note → close his bundled task and ring
  // the owner for a re-review pass. Best-effort: a bell/task hiccup must never
  // fail the status flip itself.
  if (status === "FIXED" && note.lane === "EDIT") {
    try {
      const stillOpen = await prisma.mediaNote.count({
        where: { projectId: note.projectId, parentId: null, lane: "EDIT", status: "OPEN" },
      });
      if (stillOpen === 0) {
        const task = await prisma.smartTask.findUnique({ where: { dedupeKey: EDIT_TASK_KEY(note.projectId) } });
        if (task && task.status !== "COMPLETED" && task.status !== "CANCELLED") {
          await prisma.smartTask.update({
            where: { id: task.id },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        }
        const [project, fixedCount] = await Promise.all([
          prisma.project.findUnique({ where: { id: note.projectId }, select: { title: true } }),
          prisma.mediaNote.count({ where: { projectId: note.projectId, parentId: null, lane: "EDIT", status: "FIXED" } }),
        ]);
        await notifyInApp({
          kind: "review_ready",
          title: `Ready for re-review — ${streetOf(project?.title)}`,
          href: `/projects/${note.projectId}`,
          targets: [{ roles: ["OWNER"] }],
          // FIXED count in the key = one bell per review round, not per click.
          dedupeKey: `review-ready-${note.projectId}-${fixedCount}`,
        });
      }
    } catch (e) {
      console.warn("review re-review rollup failed", e);
    }
  }

  // Same loop-closer for the PHOTOGRAPHER lane: when the photographer marks
  // the LAST open capture fix done, close the "Capture fixes" follow-up task
  // (review-photog-*) — it had NO closer at all (audit) — and ping the owner
  // for the re-review pass.
  if (status === "FIXED" && note.lane === "PHOTOGRAPHER") {
    try {
      const stillOpen = await prisma.mediaNote.count({
        where: { projectId: note.projectId, parentId: null, lane: "PHOTOGRAPHER", kind: "fix", status: "OPEN" },
      });
      if (stillOpen === 0) {
        await prisma.smartTask.updateMany({
          where: { dedupeKey: `review-photog-${note.projectId}`, status: { notIn: ["COMPLETED", "CANCELLED"] } },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
        const [project, fixedCount] = await Promise.all([
          prisma.project.findUnique({ where: { id: note.projectId }, select: { title: true } }),
          prisma.mediaNote.count({ where: { projectId: note.projectId, parentId: null, lane: "PHOTOGRAPHER", status: "FIXED" } }),
        ]);
        await notifyInApp({
          kind: "review_ready",
          title: `Capture fixes marked done — ${streetOf(project?.title)}`,
          href: `/shoot/${note.projectId}`,
          targets: [{ roles: ["OWNER"] }],
          dedupeKey: `review-photog-ready-${note.projectId}-${fixedCount}`,
        });
      }
    } catch (e) {
      console.warn("photographer fix rollup failed", e);
    }
  }

  refresh(note.projectId);
  return { ok: true };
}

// Quick per-asset verdict while arrowing through the gallery. Upsert; null
// clears it back to "unreviewed".
export async function setMediaVerdict(
  projectId: string,
  assetUrl: string,
  verdict: "APPROVED" | "NEEDS_WORK" | null,
): Promise<{ ok: boolean }> {
  try {
    await requireAdmin();
  } catch {
    return { ok: false };
  }
  if (!assetUrl) return { ok: false };
  if (verdict === null) {
    await prisma.mediaVerdict.deleteMany({ where: { projectId, assetUrl } });
  } else if (verdict === "APPROVED" || verdict === "NEEDS_WORK") {
    await prisma.mediaVerdict.upsert({
      where: { projectId_assetUrl: { projectId, assetUrl } },
      update: { verdict },
      create: { projectId, assetUrl, verdict },
    });
  } else {
    return { ok: false };
  }
  refresh(projectId);
  return { ok: true };
}

// Bundle a lane's OPEN notes and hand them off: EDIT → ONE deduped 24h task on
// Kyle's plate (+ admin bell); PHOTOGRAPHER → "fix" notes become ONE follow-up
// task on Jordan's plate, and the photographer gets a bell (+ SMS via the
// notify bridge — "review_feedback" is in SMS_KINDS) pointing at their shoot
// page. Re-sending reopens + refreshes the same task instead of duplicating.
export async function sendReviewToLane(projectId: string, lane: NoteLane): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (lane !== "EDIT" && lane !== "PHOTOGRAPHER") return { ok: false, message: "Bad lane." };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, clientId: true },
  });
  if (!project) return { ok: false, message: "That project no longer exists." };
  const street = streetOf(project.title);

  const open = await prisma.mediaNote.findMany({
    where: { projectId, lane, status: "OPEN", parentId: null },
    orderBy: { createdAt: "asc" },
  });
  if (open.length === 0) {
    return { ok: false, message: lane === "EDIT" ? "No open edit notes to send." : "No open photographer notes to send." };
  }
  const s = open.length === 1 ? "" : "s";
  const preview = open.slice(0, 3).map((n) => `• ${n.body.trim()}`).join("\n");
  const description = open.map((n) => `• ${n.body.trim()}`).join("\n").slice(0, 1500);
  const latestId = open[open.length - 1].id;

  if (lane === "EDIT") {
    const key = EDIT_TASK_KEY(projectId);
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
    const data = {
      taskType: "todo", // NOT image_fixes — see header comment (DELIVERED sweep would eat it)
      title: `Review fixes — ${street}`.slice(0, 120),
      summary: `${open.length} fix note${s} from the ${street} media review:\n${preview}${open.length > 3 ? `\n…and ${open.length - 3} more` : ""}`.slice(0, 500),
      description,
      reasonCreated: "Owner left fix notes in the media review room",
      source: "system",
      priority: "HIGH" as const,
      dueAt: new Date(Date.now() + 24 * 3600_000), // fix within 24h, same clock as flagActions
      assignedKey: "kyle",
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: key,
    };
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    if (existing) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
    } else {
      await prisma.smartTask.create({ data });
    }
    await notifyInApp({
      kind: "review_feedback",
      title: `Review fixes — ${street}`,
      body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
      href: `/projects/${projectId}`,
      targets: [{ roles: ["ADMIN"] }],
      // Latest note id in the key = each fresh send announces once.
      dedupeKey: `review-fb-edit-${projectId}-${latestId}`,
    });
    refresh(projectId);
    return { ok: true, message: `Sent ${open.length} note${s} to Kyle.` };
  }

  // PHOTOGRAPHER lane — feedback goes to whoever shot it.
  const photographerId = open.find((n) => n.photographerId)?.photographerId ?? (await projectPhotographerId(projectId));
  if (!photographerId) return { ok: false, message: "No photographer on this job to send feedback to." };
  const member = await prisma.teamMember.findUnique({ where: { id: photographerId }, select: { name: true } });
  const first = firstNameOf(member?.name);

  // Only "fix" notes are actionable enough for a task; coaching rides the bell.
  const fixes = open.filter((n) => n.kind === "fix");
  if (fixes.length > 0) {
    const key = PHOTOG_TASK_KEY(projectId);
    const fs = fixes.length === 1 ? "" : "s";
    const data = {
      taskType: "todo",
      title: `Capture fixes — ${street} (${first})`.slice(0, 120),
      summary: `${fixes.length} capture fix note${fs} for ${first} from the ${street} media review:\n${fixes.slice(0, 3).map((n) => `• ${n.body.trim()}`).join("\n")}${fixes.length > 3 ? `\n…and ${fixes.length - 3} more` : ""}`.slice(0, 500),
      description: fixes.map((n) => `• ${n.body.trim()}`).join("\n").slice(0, 1500),
      reasonCreated: "Owner flagged capture issues in the media review room",
      source: "system",
      priority: "HIGH" as const,
      dueAt: new Date(Date.now() + 24 * 3600_000),
      assignedKey: "jordan", // owner follows up on capture quality personally
      projectId,
      clientId: project.clientId,
      propertyAddress: project.title,
      dedupeKey: key,
    };
    const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
    if (existing) {
      await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
    } else {
      await prisma.smartTask.create({ data });
    }
  }

  // One bell for ALL open notes (fix + coaching). The SMS bridge sends TITLE +
  // link only, so keep the title short + money-free; the body would carry the
  // note text but the clamp nulls bodies on creative-visible rows anyway.
  await notifyInApp({
    kind: "review_feedback",
    title: `Shoot feedback — ${street}`,
    body: `${open.length} note${s}: ${open[0].body}`.slice(0, 140),
    href: `/shoot/${projectId}`,
    targets: [{ roles: ["PHOTOGRAPHER"], userKey: `tm:${photographerId}`, href: `/shoot/${projectId}` }],
    dedupeKey: `review-fb-photog-${projectId}-${latestId}`,
  });
  refresh(projectId);
  return { ok: true, message: `Sent ${open.length} note${s} to ${first}.` };
}

// ---------------------------------------------------------------------------
// Feedback-loop receipts (Jordan, Jul 2026): share the feedback by TEXT with a
// link, know when the creative actually OPENED it, and let them say "Got it"
// on coaching. Fixes already have Mark-fixed; this closes the loop on the rest.
// ---------------------------------------------------------------------------

// The creative's explicit thumbs-up on a coaching note.
export async function acknowledgeMediaNote(noteId: string): Promise<{ ok: boolean; message?: string }> {
  const note = await prisma.mediaNote.findUnique({
    where: { id: noteId },
    select: { id: true, parentId: true, lane: true, kind: true, photographerId: true, projectId: true, acknowledgedAt: true },
  });
  if (!note || note.parentId) return { ok: false, message: "That note no longer exists." };
  if (note.lane !== "PHOTOGRAPHER") return { ok: false, message: "Only capture feedback can be acknowledged." };
  try {
    await requireNoteAccess(note.photographerId);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  if (!note.acknowledgedAt) {
    await prisma.mediaNote.update({ where: { id: note.id }, data: { acknowledgedAt: new Date() } });
  }
  refresh(note.projectId);
  return { ok: true };
}

// Text the photographer their feedback link — "Jordan left feedback on your
// shoot for 238 Hudson Dr — check it out here: …/shoot/<id>". Owner presses
// the button; the hub sends exactly that. Stamps sharedAt on the lane's root
// notes so the review side shows Shared/Seen receipts.
export async function shareShootFeedback(projectId: string): Promise<{ ok: boolean; message: string }> {
  try {
    await requireAdmin();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const notes = await prisma.mediaNote.findMany({
    where: { projectId, parentId: null, lane: "PHOTOGRAPHER" },
    select: { id: true, photographerId: true },
  });
  if (notes.length === 0) return { ok: false, message: "No capture feedback on this shoot yet." };
  const memberId = notes.find((n) => n.photographerId)?.photographerId ?? (await projectPhotographerId(projectId));
  if (!memberId) return { ok: false, message: "No photographer is linked to this feedback." };

  const [member, project, me] = await Promise.all([
    prisma.teamMember.findUnique({ where: { id: memberId }, select: { name: true, phone: true } }),
    prisma.project.findUnique({ where: { id: projectId }, select: { title: true } }),
    getCurrentUser().catch(() => null),
  ]);
  if (!member?.phone) return { ok: false, message: `${member?.name ?? "The photographer"} has no phone on file.` };
  const street = project?.title.split(",")[0].trim() ?? "your shoot";
  const author = me?.name?.split(/\s+/)[0] ?? "Jordan";

  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");
  const body = `Hey ${member.name?.split(/\s+/)[0] ?? "there"} — ${author} left some feedback on your shoot for ${street}. Check it out here: ${base}/shoot/${projectId}`;

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(member.phone);
  if (k.length !== 10) return { ok: false, message: "The photographer's phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };
  try {
    await OpenPhone.sendMessage(from, `+1${k}`, body);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Text failed to send." };
  }

  const now = new Date();
  await prisma.mediaNote.updateMany({
    where: { projectId, parentId: null, lane: "PHOTOGRAPHER", photographerId: memberId },
    data: { sharedAt: now },
  });
  // Re-summarize their "work-ons" NOW, so the themed bullets are fresh the
  // moment they tap the link in that text. Best-effort: a model hiccup must
  // never fail a send that already went out.
  try {
    const { rebuildShootFocusSummary } = await import("@/lib/photographerFeedback");
    await rebuildShootFocusSummary(memberId);
  } catch { /* the daily cron rebuilds as the backstop */ }
  // Bell too (their own person-addressed row), deduped per share round.
  // Kind "feedback_shared" is deliberately NOT in SMS_KINDS — the custom-worded
  // text above is the one SMS; the bridge must not send a second one.
  await notifyInApp({
    kind: "feedback_shared",
    title: `${author} left feedback — ${street}`,
    body: "Tap to see what to fix and what to keep doing.",
    href: `/shoot/${projectId}`,
    targets: [{ roles: ["OWNER", "ADMIN", "PHOTOGRAPHER"], userKey: `tm:${memberId}`, href: `/shoot/${projectId}` }],
    dedupeKey: `fb-share-${projectId}-${now.toISOString().slice(0, 10)}`,
  }).catch(() => {});
  refresh(projectId);
  return { ok: true, message: `Texted ${member.name?.split(/\s+/)[0] ?? "them"} the feedback link.` };
}
