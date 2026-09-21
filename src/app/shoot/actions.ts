"use server";

import { requireDeliverableAccess, requireShootAccess } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { shootStatusText, SHOOT_STATUS_META, type ShootStatusKind } from "@/lib/statusTexts";
import { isAdditionalShootRow } from "@/app/upload/additionalShoots";

// Server actions for the guided photographer experience (/shoot). Client texts
// are DRAFT-then-SEND: the photographer always reviews the wording and taps Send
// — nothing here auto-sends. Every send is logged to the project timeline + the
// comms memory so the whole team stays looped in.

function revalShoot(projectId: string) {
  revalidatePath(`/shoot/${projectId}`);
  revalidatePath("/shoot");
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
}

// Resolve the client's number, send the text via OpenPhone, and record it
// (project timeline + comms log). Shared by status updates + free-form messages.
async function sendClientText(
  projectId: string,
  body: string,
  label: string,
  // WHOSE WORDS THESE ARE (Sep 21 2026). Required, with no default, because the
  // end-of-day comms audit reads the answer: a message the photographer typed is
  // his and can be coached on, a status template he tapped through unchanged is
  // the hub's and must not be. Coaching somebody on our own sentence is the
  // fastest way to prove the feature is not paying attention. Making it an
  // argument rather than a guess also means the next rail added to this file has
  // to state which it is instead of silently inheriting "person".
  wrote: "the person" | "the hub",
): Promise<{ ok: boolean; message: string }> {
  const text = (body || "").trim();
  if (!text) return { ok: false, message: "Nothing to send." };

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, clientId: true, client: { select: { name: true, phone: true } } },
  });
  if (!project) return { ok: false, message: "Shoot not found." };
  if (!project.client.phone) return { ok: false, message: "No phone number on file for this client." };

  const { phoneKey, OpenPhone, defaultOpenPhoneNumber } = await import("@/lib/integrations/openphone");
  const k = phoneKey(project.client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn’t connected." };

  let sentId: string | undefined;
  try {
    const res = await OpenPhone.sendMessage(from, `+1${k}`, text);
    sentId = res?.data?.id;
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }

  // Project timeline (team-visible) + full comms memory (Ask-the-Hub).
  await prisma.activity.create({
    data: { projectId: project.id, type: "SYSTEM", body: `${label} — texted ${project.client.name}: ${text.slice(0, 200)}` },
  });
  await prisma.commLog
    .create({
      data: {
        channel: "text",
        direction: "out",
        minRole: "ADMIN",
        clientId: project.clientId,
        clientName: project.client.name,
        projectId: project.id,
        contactName: "Us",
        body: text,
        occurredAt: new Date(),
        source: "openphone",
        // Match the OpenPhone webhook's "op-<id>" format so its later echo of this
        // same outbound text dedupes instead of double-logging the conversation.
        externalId: sentId ? `op-${sentId}` : null,
      },
    })
    .catch(() => {}); // never let a log write fail the send result

  // WHO ON OUR SIDE WROTE IT. This send leaves through the OpenPhone API key,
  // which belongs to Jordan, so the delivery echo comes back carrying HIS
  // OpenPhone user id — and without this line Harrison's on-my-way text is
  // recorded as Jordan's. The session is the only honest evidence here, and
  // when there is none the row keeps the hub-sent sentinel and stays unknown.
  if (sentId) {
    const { getCurrentUser } = await import("@/lib/auth/user");
    const actor = await getCurrentUser().catch(() => null);
    const { stampCommActor } = await import("@/lib/commSenders");
    await stampCommActor(
      wrote === "the hub"
        ? { externalId: `op-${sentId}`, wrote: "the hub" }
        : {
            externalId: `op-${sentId}`,
            wrote: "the person",
            // "View as" is a read-only preview; recording a send against the
            // previewed person would be a lie about who did it.
            teamMemberId: actor && !actor.impersonating ? actor.teamMemberId : null,
          },
    ).catch(() => {});
  }

  revalShoot(projectId);
  return { ok: true, message: "Sent." };
}

/**
 * Same words, ignoring the noise a text box adds. Case, surrounding and
 * repeated whitespace, and the curly quotes / dashes a mobile keyboard
 * substitutes for the straight ones in our template are all NOT edits. A
 * difference in any actual word is.
 *
 * Deliberately generous about what counts as unchanged: a photographer who only
 * retyped a comma is recorded as the hub, which costs one message of coaching
 * signal. Calling our own sentence his costs his trust in the whole report.
 */
function sameWords(a: string, b: string): boolean {
  const flatten = (s: string) =>
    s
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return flatten(a) === flatten(b);
}

// Send a canned shoot status update (on my way / arrived / complete). The UI
// passes the photographer-edited text; we fall back to the default if blank.
export async function sendShootStatusText(
  projectId: string,
  kind: ShootStatusKind,
  edited?: string,
): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);

  // ---- DID HE CHANGE A WORD, OR DID HE TAP THROUGH OUR SENTENCE? -----------
  //
  // Sep 21 2026, second adversarial review. This used to read `edited ? "the
  // person" : "the hub"`, which can never choose "the hub": the only caller
  // (components/shoot/ShootScreen.tsx) prefills the sheet with the exact
  // shootStatusText(...) template and hands that same string straight back, so
  // `edited` is never empty. A photographer tapping "On my way" and sending it
  // untouched had our canned sentence written to CommLog under HIS name, with a
  // clientId, in exactly the shape the end-of-day comms audit reads — and would
  // have been coached on our wording. That is the manufactured-criticism failure
  // the whole feature is trying not to commit.
  //
  // So compare against the template instead of against emptiness. The server can
  // build it itself, which also means the answer does not depend on the client
  // being honest about what it prefilled.
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, client: { select: { name: true } }, photographer: { select: { name: true } } },
  });
  const template = shootStatusText(kind, {
    clientName: p?.client.name,
    propertyTitle: p?.title,
    photographerName: p?.photographer?.name,
  });

  const typed = (edited || "").trim();
  const body = typed || template;
  const wrote: "the person" | "the hub" = typed && !sameWords(typed, template) ? "the person" : "the hub";

  // WHAT I WOULD PREFER THE CALLER DID, for a later pass: ShootScreen.tsx is
  // not in this lane's file set, but the honest fix is for it to send only what
  // the photographer actually changed — pass the template back as undefined
  // when the box is untouched, or pass an explicit `edited: boolean` alongside
  // the text. The server would then be told rather than having to infer, and
  // this comparison could stay as the fence behind it rather than being the
  // only thing standing between our template and his coaching report.
  return sendClientText(projectId, body, SHOOT_STATUS_META[kind].sent, wrote);
}

// Send a free-form message the photographer typed (optionally AI-polished).
export async function sendClientMessage(projectId: string, text: string): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);
  // Free-form: the photographer typed it (or polished a rough note of his own).
  return sendClientText(projectId, text, "Message", "the person");
}

// Polish a rough note into a clean client text. DRAFT ONLY — returns the text
// for the photographer to review and send.
export async function draftClientMessage(
  projectId: string,
  rough: string,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  await requireShootAccess(projectId);
  const note = (rough || "").trim();
  if (!note) return { ok: false, error: "Type a rough note first." };
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, error: "Connect the AI Assistant in Connections first." };

  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { title: true, client: { select: { name: true } }, photographer: { select: { name: true } } },
  });
  try {
    const { polishOutbound } = await import("@/lib/integrations/ai");
    const text = await polishOutbound({
      rough: note,
      clientName: p?.client.name,
      propertyAddress: p?.title,
      photographerName: p?.photographer?.name,
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Draft failed." };
  }
}

// Tick a required item off the on-site capture checklist (or untick it).
export async function setDeliverableCaptured(
  deliverableId: string,
  captured: boolean,
): Promise<{ ok: boolean }> {
  await requireDeliverableAccess(deliverableId);
  // ---- AN EXTRA SHOOT'S ONLY IDENTITY IS capturedAt (Sep 18 review, F5) ----
  //
  // A return trip to the upload portal files the second video as a manual
  // Deliverable whose capturedAt holds the day it was shot, and EVERY reader of
  // that shape keys on manual AND capturedAt: the /upload day buckets, the card
  // on the portal, the withdraw action, the editing rail. Untick it here — one
  // tap, by the same photographer, on the original shoot's checklist, where the
  // row arrived pre-ticked — and capturedAt went to null: the job dropped out of
  // the day buckets, the card vanished, and withdrawAdditionalShoot refused with
  // "That isn't an extra shoot you can remove". A video owed, that nobody could
  // see and nobody could take back.
  //
  // WHY A REFUSAL RATHER THAN A SECOND IDENTITY COLUMN. A new column would have
  // to be adopted by all five readers at once and back-filled on a live
  // production database, and capturedAt is not the wrong word for this row —
  // "the photographer stood at the property and shot it" is exactly what it
  // means, and evidenceUnits reads it as RAW_IN, which is exactly right. What
  // was wrong is that a checklist tick and a shoot record were the same write.
  // The extra shoot has its own way off the job, one that keeps the row and its
  // history: Remove on the upload portal (withdrawAdditionalShoot).
  //
  // It throws rather than returning ok:false because the caller
  // (components/shoot/ShootScreen.tsx toggleCapture) is optimistic — it rolls
  // the checkbox back and flashes on a rejected promise, and ignores the
  // returned shape. The checklist no longer offers these rows at all
  // (lib/shoot.ts), so this is the fence behind that, for a stale page.
  if (!captured) {
    const row = await prisma.deliverable.findUnique({
      where: { id: deliverableId },
      select: { type: true, manual: true, capturedAt: true, removedFromOrderAt: true },
    });
    if (row && isAdditionalShootRow(row)) {
      throw new Error("That's an extra shoot filed from the upload portal — remove it there, not here.");
    }
  }
  const d = await prisma.deliverable.update({
    where: { id: deliverableId },
    data: { capturedAt: captured ? new Date() : null },
    select: { projectId: true },
  });
  revalShoot(d.projectId);
  return { ok: true };
}

// Save the photographer's on-site notes. These flow straight into the editor
// brief the upload portal uses (Project.editorBrief), so nothing is re-typed.
export async function saveShootNote(projectId: string, note: string): Promise<{ ok: boolean }> {
  await requireShootAccess(projectId);
  await prisma.project.update({ where: { id: projectId }, data: { editorBrief: note.trim() || null } });
  revalShoot(projectId);
  return { ok: true };
}

// Flag an on-site problem (lockbox, access, hazard…). This is feedback about
// the SHOOT, so it stays on the job: the project timeline (which the upload
// portal's flag list, the editor brief and the photographer-feedback surface
// all read) plus an ops loop for Kyle. It does NOT go to the Feedback &
// requests board — that board is for changes to the hub itself, and the
// floating feedback widget on this very screen is the way there.
export async function flagShootIssue(projectId: string, body: string): Promise<{ ok: boolean }> {
  await requireShootAccess(projectId);
  const text = (body || "").trim();
  if (!text) return { ok: false };
  await prisma.activity.create({ data: { projectId, type: "FLAG", body: text } });
  const { fileFieldIssue } = await import("@/lib/fieldIssues");
  // URGENT: they're standing at the property right now — an answer four hours
  // from now is no answer at all.
  await fileFieldIssue({ projectId, note: text, page: `/shoot/${projectId}`, label: "Shoot issue", priority: "URGENT" });
  revalShoot(projectId);
  return { ok: true };
}

// Mark the shoot complete from the field. Records the moment, moves the job to
// SHOT (so the pipeline + Kyle see it’s captured), and drops a clear note in the
// project’s team thread. Does NOT text the client — that’s the separate "Shoot
// complete" status button the photographer reviews.
export async function completeShoot(projectId: string): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true, title: true, status: true,
      photographer: { select: { id: true, name: true } },
      appointments: {
        where: { status: { not: "CANCELED" } },
        orderBy: { startAt: "asc" },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!project) return { ok: false, message: "Shoot not found." };

  const appt = project.appointments[0];
  if (appt) {
    await prisma.appointment.update({ where: { id: appt.id }, data: { completedAt: new Date() } });
  }

  // Captured → advance to SHOT (unless already further along the pipeline).
  // The photographer's word is a human status write, and a human write ends
  // the office's status pin (Sep 13, editOverrides.ts) — a pinned Waiting
  // gives way the same day the office's Waiting hold does.
  if (project.status === "BOOKED" || project.status === "SCHEDULED") {
    await prisma.project.update({ where: { id: projectId }, data: { status: "SHOT", statusPinnedAt: null } });
    // The office's Waiting hold (Sep 11, queueWaiting.ts) ends with the
    // photographer's own word that the shoot happened — the same word the
    // upload page carries. SHOT is off the hold's rails anyway; deleting the
    // marker keeps it from re-arming if the job is ever parked again by hand.
    try {
      const { releaseWaitingHold } = await import("@/lib/queueWaiting");
      if (await releaseWaitingHold(projectId)) {
        await prisma.activity.create({
          data: { projectId, type: "SYSTEM", body: "Waiting hold released — the photographer marked the shoot complete on-site." },
        }).catch(() => {});
      }
    } catch { /* hygiene only — the SHOT write above stands */ }
    // Refresh the evidence + run the editor handoff NOW instead of waiting up
    // to an hour for the cron. The old button set SHOT and told no one — the
    // sweep saw no transition, so the editor's task never minted (July 2026
    // audit). syncProjectStatuses({projectId}) re-reads Aryeo/Dropbox and its
    // stage-independent ensureEditorHandoff does the rest, all idempotent.
    try {
      const { syncProjectStatuses } = await import("@/lib/projectStatus");
      await syncProjectStatuses({ projectId });
    } catch { /* the hourly sweep is the backstop */ }
  }

  const who = project.photographer?.name ?? "The photographer";
  const street = (project.title || "the property").split(",")[0].trim();
  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Shoot marked complete on-site by ${who}.` },
  });
  try {
    const { notifyInApp } = await import("@/lib/notify");
    await notifyInApp({
      kind: "shoot_completed",
      title: `Shoot done — ${street} (${who})`,
      href: `/projects/${projectId}`,
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `shootdone-${appt?.id ?? projectId}`,
    });
  } catch { /* bell is best-effort */ }
  await prisma.projectMessage
    .create({
      data: {
        projectId,
        authorId: project.photographer?.id ?? null,
        authorName: who,
        body: `Shoot complete at ${street}. Ready to upload content.`,
      },
    })
    .catch(() => {});

  revalShoot(projectId);
  revalidatePath("/pipeline");
  return { ok: true, message: "Shoot marked complete." };
}
