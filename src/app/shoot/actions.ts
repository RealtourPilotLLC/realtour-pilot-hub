"use server";

import { requireDeliverableAccess, requireShootAccess } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { shootStatusText, SHOOT_STATUS_META, type ShootStatusKind } from "@/lib/statusTexts";

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
        externalId: sentId ?? null,
      },
    })
    .catch(() => {}); // never let a log write fail the send result

  revalShoot(projectId);
  return { ok: true, message: "Sent." };
}

// Send a canned shoot status update (on my way / arrived / complete). The UI
// passes the photographer-edited text; we fall back to the default if blank.
export async function sendShootStatusText(
  projectId: string,
  kind: ShootStatusKind,
  edited?: string,
): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);
  let body = (edited || "").trim();
  if (!body) {
    const p = await prisma.project.findUnique({
      where: { id: projectId },
      select: { title: true, client: { select: { name: true } }, photographer: { select: { name: true } } },
    });
    body = shootStatusText(kind, {
      clientName: p?.client.name,
      propertyTitle: p?.title,
      photographerName: p?.photographer?.name,
    });
  }
  return sendClientText(projectId, body, SHOOT_STATUS_META[kind].sent);
}

// Send a free-form message the photographer typed (optionally AI-polished).
export async function sendClientMessage(projectId: string, text: string): Promise<{ ok: boolean; message: string }> {
  await requireShootAccess(projectId);
  return sendClientText(projectId, text, "Message");
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

// Flag an on-site problem (lockbox, access, hazard…). Lands on the project
// timeline + the upload portal's flag list for the team.
export async function flagShootIssue(projectId: string, body: string): Promise<{ ok: boolean }> {
  await requireShootAccess(projectId);
  const text = (body || "").trim();
  if (!text) return { ok: false };
  await prisma.activity.create({ data: { projectId, type: "FLAG", body: text } });
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
  if (project.status === "BOOKED" || project.status === "SCHEDULED") {
    await prisma.project.update({ where: { id: projectId }, data: { status: "SHOT" } });
  }

  const who = project.photographer?.name ?? "The photographer";
  const street = (project.title || "the property").split(",")[0].trim();
  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body: `Shoot marked complete on-site by ${who}.` },
  });
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
