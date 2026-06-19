import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { createCommTask } from "@/lib/tasks";

// ---------------------------------------------------------------------------
// Communications cross-check for the smart-status engine.
//
// Clients often ask for changes AFTER we've delivered ("can you brighten the
// kitchen", "the video is missing the backyard", "swap the cover photo"). Aryeo
// still shows the order fulfilled, so without watching comms a revision request
// silently falls through. This layer classifies every inbound client message
// and, when it reads as a change/revision request on a delivered-ish job, kicks
// the project into REVISION with an urgent task.
//
// Source-agnostic on purpose: OpenPhone calls it today; Gmail / Facebook
// Messenger / web form listeners call the SAME entry point as they come online.
// ---------------------------------------------------------------------------

// Phrases that signal the client wants something changed/added/fixed. Kept
// deliberately broad — a false positive just shows up as a dismissible REVISION
// flag with the triggering message, which is far cheaper than missing a real one.
const REVISION_PATTERNS: RegExp[] = [
  /\brevis(e|ion|ions)\b/i,
  /\bre-?(do|edit|shoot|take|deliver)\b/i,
  /\bredo\b/i,
  /\bedit (it|them|again|the)\b/i,
  /\bchange[sd]?\b/i,
  /\badjust(ed|ment)?\b/i,
  /\b(can|could|would|please|pls|plz) (you )?(also )?(add|change|fix|redo|adjust|edit|update|remove|replace|swap|retouch|brighten|darken|crop)\b/i,
  /\bfix(ed|ing)?\b/i,
  /\bcorrect(ed|ion)?\b/i,
  /\breplace\b/i,
  /\bswap\b/i,
  /\bretouch\b/i,
  /\bremove\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\b(too )?(dark|bright|blurry|grainy|crooked|tilted)\b/i,
  /\b(not|isn'?t|doesn'?t look) (right|good|happy)\b/i,
  /\b(missing|forgot|left out|didn'?t (get|include|send))\b/i,
  /\b(issue|problem|mistake|wrong|error)\b/i,
  /\bre-?send\b/i,
  /\bdifferent (photo|image|angle|shot|version)\b/i,
];

const PRAISE_ONLY = /\b(thank|thanks|thx|love|great|perfect|awesome|amazing|looks good|beautiful|gorgeous)\b/i;

export type CommClassification = { isRevision: boolean; matched: string[] };

export function classifyComm(text: string): CommClassification {
  const t = (text || "").trim();
  if (!t) return { isRevision: false, matched: [] };
  const matched: string[] = [];
  for (const re of REVISION_PATTERNS) {
    const m = t.match(re);
    if (m) matched.push(m[0].toLowerCase());
  }
  return { isRevision: matched.length > 0, matched: [...new Set(matched)] };
}

function dedupeKey(parts: (string | null | undefined)[]): string {
  return crypto.createHash("sha1").update(parts.filter(Boolean).join("|")).digest("hex").slice(0, 24);
}

// Statuses where a "change" message means a real REVISION (work was delivered or
// is in final QC). On earlier stages the same message is just a special request.
const DELIVERED_ISH = new Set(["DELIVERED", "REVISION", "REVIEW"]);

// Single entry point for an inbound client communication from ANY source.
// Creates the reply task and, when warranted, raises a revision.
export async function recordClientCommunication(opts: {
  clientId: string;
  clientName: string;
  projectId?: string | null;
  projectStatus?: string | null;
  propertyAddress?: string | null;
  text: string;
  kind: "text" | "missed_call" | "voicemail" | "email";
  source?: string; // openphone | gmail | facebook | form | ...
}): Promise<{ replyTask: boolean; revision: boolean }> {
  const cls = classifyComm(opts.text);

  // If the AI assistant is connected, turn the message into a specific to-do
  // ("Reschedule 320 Tarbert to Thursday") instead of a generic "Reply to X".
  let aiTitle: string | null = null;
  let aiDetail: string | null = null;
  try {
    const { getSecret } = await import("@/lib/integrations/connections");
    if (await getSecret("ai")) {
      const { messageToTodo } = await import("@/lib/integrations/ai");
      const todo = await messageToTodo({
        channel: opts.kind === "email" ? "email" : opts.kind === "text" ? "text" : "call",
        clientName: opts.clientName,
        propertyAddress: opts.propertyAddress,
        message: opts.text,
      });
      if (todo) {
        aiTitle = todo.title;
        aiDetail = todo.detail;
      }
    }
  } catch {
    /* fall back to the generic task */
  }

  // Always surface the inbound message as a reply/callback task.
  const replyTask = await createCommTask({
    clientId: opts.clientId,
    clientName: opts.clientName,
    projectId: opts.projectId ?? null,
    propertyAddress: opts.propertyAddress ?? null,
    kind: opts.kind === "email" ? "text" : opts.kind,
    snippet: opts.text,
    source: opts.source,
    aiTitle,
    aiDetail,
  });

  let revision = false;
  if (cls.isRevision && opts.projectId) {
    if (opts.projectStatus && DELIVERED_ISH.has(opts.projectStatus)) {
      revision = await raiseRevision({
        projectId: opts.projectId,
        clientId: opts.clientId,
        clientName: opts.clientName,
        propertyAddress: opts.propertyAddress ?? null,
        note: opts.text,
        source: opts.source ?? "comms",
      });
    } else {
      // In-flight job: capture the ask as a special request, no status churn.
      await prisma.activity.create({
        data: {
          projectId: opts.projectId,
          type: "SPECIAL_REQUEST",
          body: `Client request (${opts.source ?? "comms"}): ${opts.text.slice(0, 220)}`,
        },
      });
    }
  }

  return { replyTask, revision };
}

// Reopen a delivered job for changes: flag it, move DELIVERED → REVISION, and
// raise an urgent revision task (deduped to one open revision per project).
export async function raiseRevision(opts: {
  projectId: string;
  clientId?: string | null;
  clientName?: string | null;
  propertyAddress?: string | null;
  note: string;
  source: string;
}): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: opts.projectId },
    select: { id: true, status: true, title: true, clientId: true, revisionRequestedAt: true },
  });
  if (!project) return false;

  const note = opts.note.slice(0, 300);
  await prisma.project.update({
    where: { id: project.id },
    data: {
      revisionRequestedAt: new Date(),
      revisionNote: note,
      // Only a delivered job changes stage; REVIEW/REVISION keep their stage.
      ...(project.status === "DELIVERED" ? { status: "REVISION" } : {}),
    },
  });

  await prisma.activity.create({
    data: {
      projectId: project.id,
      type: "FLAG",
      body: `Revision requested (${opts.source}): ${note}`,
    },
  });

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const key = dedupeKey([project.id, "revision"]);
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  const data = {
    taskType: "revision",
    title: `Revision — ${project.title}`,
    description: note,
    reasonCreated: `Client requested changes via ${opts.source} after delivery`,
    checklist: JSON.stringify([
      "Read the full request in Communications",
      "Confirm exactly what needs to change",
      "Make the edits / reshoot if needed",
      "Re-upload to Aryeo + re-deliver to client",
      "Mark the revision resolved",
    ]),
    source: opts.source,
    priority: "URGENT" as const,
    dueAt: new Date(),
    clientId: opts.clientId ?? project.clientId,
    projectId: project.id,
    propertyAddress: opts.propertyAddress ?? project.title,
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };
  if (existing) {
    await prisma.smartTask.update({
      where: { id: existing.id },
      data: { ...data, status: "OPEN", completedAt: null },
    });
  } else {
    await prisma.smartTask.create({ data });
  }
  return true;
}

// Clear a revision once it's been handled: drop the flag, close the task, and
// return a reopened (REVISION) job to DELIVERED. A REVIEW job that merely
// carried a revision note keeps its stage.
export async function resolveRevision(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { status: true },
  });
  await prisma.project.update({
    where: { id: projectId },
    data: {
      revisionRequestedAt: null,
      revisionNote: null,
      ...(project?.status === "REVISION" ? { status: "DELIVERED", deliveredAt: new Date() } : {}),
    },
  });
  await prisma.smartTask.updateMany({
    where: { projectId, taskType: "revision", status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "COMPLETED", completedAt: new Date() },
  });
  await prisma.activity.create({
    data: { projectId, type: "STATUS_CHANGE", body: "Revision marked resolved — back to Delivered." },
  });
}

// Backfill / sweep: scan a project's recent inbound-text activities for a
// revision request it may have missed (e.g. comms that arrived before this
// feature existed). Used by the status sync so "Recheck statuses" catches them.
export async function scanProjectCommsForRevision(projectId: string): Promise<boolean> {
  const acts = await prisma.activity.findMany({
    where: { projectId, type: "SYSTEM", body: { contains: "text:" } },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { body: true },
  });
  for (const a of acts) {
    // Only client→us texts ("in text"), not our outbound replies.
    if (!/\bin(coming)?\b.*text:/i.test(a.body) && !/openphone in/i.test(a.body)) continue;
    const msg = a.body.split("text:").slice(1).join("text:").trim();
    if (classifyComm(msg).isRevision) {
      await raiseRevision({ projectId, note: msg, source: "openphone" });
      return true;
    }
  }
  return false;
}
