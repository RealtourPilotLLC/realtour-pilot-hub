import "server-only";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import type { NotifyTarget } from "@/lib/notify";
import { classifyFeedback } from "@/lib/feedbackAttribution";

// Lightweight sentiment when there's no star rating to go on.
const NEG = /\b(bad|terrible|awful|disappointed|unhappy|not happy|wrong|blurry|dark|reflection|issue|problem|redo|fix|mistake|poor|sloppy|rushed|late)\b/i;
const POS = /\b(love|loved|great|amazing|awesome|perfect|beautiful|excellent|fantastic|wonderful|happy|impressed|stunning)\b/i;

// Does this feedback text carry criticism, regardless of the star rating?
// The creative-facing praise surfaces use this as a second gate: a 4-star
// "love it, but the video was shaky — please redo" is POSITIVE by rating yet
// must NOT render for the photographer (negative client feedback never reaches
// creatives — Jordan reads it first and briefs them himself).
export function hasNegativeCues(body: string | null | undefined): boolean {
  return !!body && NEG.test(body);
}

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
      // Whose problem it is, decided at intake so no score is ever computed
      // from an unclassified row. An owner can overrule it on /quality.
      ...(() => {
        const call = classifyFeedback({ body: opts.body, photographerRating: rating });
        return call ? { attribution: call.attribution, attributionWhy: call.why } : {};
      })(),
    },
  });

  await prisma.activity.create({
    data: {
      projectId: project.id,
      type: negative ? "FLAG" : "NOTE",
      body: `Client feedback${rating ? ` (${rating}/5)` : ""}: ${opts.body.slice(0, 240)}`,
    },
  });

  // NEGATIVE feedback keeps the URGENT resolve task — someone has to act NOW.
  // Positive/neutral is notification-only (the bell below): the old "Review
  // client feedback" task was ceremony nothing ever closed, and any pre-existing
  // rows still drain via closeStaleFeedbackReviews over the next week.
  if (negative) {
    const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
    await prisma.smartTask.create({
      data: {
        taskType: "feedback_review",
        title: `Resolve client feedback — ${project.title}`,
        summary:
          `${opts.authorName ? opts.authorName + " left" : "Client left"} unhappy feedback${rating ? ` (${rating}/5)` : ""} on ${project.title.split(",")[0]}: “${opts.body.slice(0, 200)}”` +
          " — reach out to make it right and brief the photographer.",
        description:
          `${opts.authorName ? opts.authorName + ": " : ""}${opts.body}` +
          (rating ? `\n\nRating: ${rating}/5` : "") +
          (project.photographer ? `\nPhotographer: ${project.photographer.name}` : ""),
        reasonCreated: "Negative client feedback — resolve and follow up",
        checklist: JSON.stringify(
          ["Read the full feedback", "Call/text the client to make it right", "Brief the photographer", "Log how it was resolved"],
        ),
        source: "feedback",
        priority: "URGENT",
        dueAt: new Date(),
        projectId: project.id,
        clientId: project.clientId,
        propertyAddress: project.title,
        ownerId: kyle?.id ?? null,
        dedupeKey: dedupeKey([fb.id, "feedback"]),
      },
    });
  }

  // Bell: every piece of feedback rings someone. Negative = an owner-only FYI
  // next to Kyle's URGENT task above — it NEVER reaches creatives (playbook
  // rule). Positive/neutral = ops broadcast + the photographer who shot it.
  // Best-effort — the Feedback row above is what matters.
  try {
    const { notifyInApp } = await import("@/lib/notify");
    const targets: NotifyTarget[] = negative ? [{ roles: ["OWNER"] }] : [{ roles: ["OWNER", "ADMIN"] }];
    if (!negative && project.photographerId) {
      // Per-target href: photographers can't open /projects/<id> (the default
      // below) — middleware bounces them and the praise evaporates. Their row
      // deep-links the shoot page, where the client-praise card renders it.
      targets.push({ roles: ["PHOTOGRAPHER"], userKey: `tm:${project.photographerId}`, href: `/shoot/${project.id}` });
    }
    await notifyInApp({
      kind: "client_feedback",
      title: `Client feedback${rating ? ` ${rating}/5` : ""} — ${project.title.split(",")[0].trim()}`,
      body: opts.body.slice(0, 140),
      href: `/projects/${project.id}`,
      targets,
      dedupeKey: `fb-${fb.id}`,
    });
  } catch { /* bell is best-effort */ }

  return { ok: true };
}
