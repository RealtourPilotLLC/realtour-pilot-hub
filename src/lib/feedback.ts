import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";

// Lightweight sentiment when there's no star rating to go on.
const NEG = /\b(bad|terrible|awful|disappointed|unhappy|not happy|wrong|blurry|dark|reflection|issue|problem|redo|fix|mistake|poor|sloppy|rushed|late)\b/i;
const POS = /\b(love|loved|great|amazing|awesome|perfect|beautiful|excellent|fantastic|wonderful|happy|impressed|stunning)\b/i;

function deriveSentiment(body: string, rating: number | null): "POSITIVE" | "NEUTRAL" | "NEGATIVE" {
  if (rating != null) return rating <= 2 ? "NEGATIVE" : rating === 3 ? "NEUTRAL" : "POSITIVE";
  if (NEG.test(body)) return "NEGATIVE";
  if (POS.test(body)) return "POSITIVE";
  return "NEUTRAL";
}

function dedupeKey(parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);
}

// Record client feedback: store it, drop it on the project timeline, alert Kyle,
// and flag the photographer who shot it. Negative feedback becomes urgent.
export async function recordFeedback(opts: {
  projectId: string;
  rating?: number | null;
  body: string;
  authorName?: string | null;
  source?: string;
}): Promise<{ ok: boolean }> {
  const project = await prisma.project.findUnique({
    where: { id: opts.projectId },
    select: {
      id: true,
      title: true,
      clientId: true,
      photographerId: true,
      photographer: { select: { name: true } },
    },
  });
  if (!project) return { ok: false };

  const rating = opts.rating ?? null;
  const sentiment = deriveSentiment(opts.body, rating);
  const negative = sentiment === "NEGATIVE";

  const fb = await prisma.feedback.create({
    data: {
      projectId: project.id,
      rating,
      sentiment,
      body: opts.body.slice(0, 2000),
      authorName: opts.authorName?.slice(0, 120) || null,
      source: opts.source ?? "form",
      photographerId: project.photographerId,
    },
  });

  await prisma.activity.create({
    data: {
      projectId: project.id,
      type: negative ? "FLAG" : "NOTE",
      body: `Client feedback${rating ? ` (${rating}/5)` : ""}: ${opts.body.slice(0, 240)}`,
    },
  });

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  await prisma.smartTask.create({
    data: {
      taskType: "feedback_review",
      title: `${negative ? "Resolve" : "Review"} client feedback — ${project.title}`,
      summary:
        `${opts.authorName ? opts.authorName + " left" : "Client left"} ${negative ? "unhappy" : ""} feedback${rating ? ` (${rating}/5)` : ""} on ${project.title.split(",")[0]}: “${opts.body.slice(0, 200)}”` +
        (negative ? " — reach out to make it right and brief the photographer." : "."),
      description:
        `${opts.authorName ? opts.authorName + ": " : ""}${opts.body}` +
        (rating ? `\n\nRating: ${rating}/5` : "") +
        (project.photographer ? `\nPhotographer: ${project.photographer.name}` : ""),
      reasonCreated: negative
        ? "Negative client feedback — resolve and follow up"
        : "Client submitted feedback",
      checklist: JSON.stringify(
        negative
          ? ["Read the full feedback", "Call/text the client to make it right", "Brief the photographer", "Log how it was resolved"]
          : ["Read the feedback", "Thank the client", "Note anything to carry forward"],
      ),
      source: "feedback",
      priority: negative ? "URGENT" : "MEDIUM",
      dueAt: new Date(),
      projectId: project.id,
      clientId: project.clientId,
      propertyAddress: project.title,
      ownerId: kyle?.id ?? null,
      dedupeKey: dedupeKey([fb.id, "feedback"]),
    },
  });

  return { ok: true };
}
