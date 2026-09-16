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
  // Deliberately NOT denial-aware (see DENIED below): this gate decides whether
  // a creative ever sees a client's words, and it fails closed on purpose.
  return !!body && NEG.test(body);
}

// A client naming a problem word to DENY it is not a complaint — "no issues at
// all, loved it" read NEGATIVE because the criticism words are tested first
// (Sep 16, Kyle call, item 10; latent until now because every live form row
// carries a star rating, which outranks the words). Strip the denial, then
// test as before.
// Widened Sep 16 (review): "nothing wrong at all" and "no real issues" still
// read NEGATIVE because the criticism word survived the strip — one optional
// adjective between the denial and the noun, and the "nothing wrong/bad" form,
// are the two shapes clients actually write.
const DENIED =
  /\b(?:(?:no|not any|without any|zero|didn'?t have any|haven'?t had any|never had any)\s+(?:\w+\s+)?(?:issues?|problems?|complaints?|mistakes?|errors?)|nothing\s+(?:\w+\s+)?(?:wrong|bad|off|to fix|to complain about))\b/gi;

function deriveSentiment(body: string, rating: number | null): "POSITIVE" | "NEUTRAL" | "NEGATIVE" {
  if (rating != null) return rating <= 2 ? "NEGATIVE" : rating === 3 ? "NEUTRAL" : "POSITIVE";
  const t = body.replace(DENIED, " ");
  if (NEG.test(t)) return "NEGATIVE";
  if (POS.test(t)) return "POSITIVE";
  return "NEUTRAL";
}

function dedupeKey(parts: string[]): string {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);
}

// The URGENT "Resolve client feedback" task minted for a NEGATIVE row below.
// Exported so /quality can CLOSE it when an owner re-reads the row as Neutral/
// Happy or dismisses it as not feedback (Sep 16 review) — otherwise correcting
// a row on /quality left Kyle's queue card standing with nothing to act on.
export function feedbackTaskKey(feedbackId: string): string {
  return dedupeKey([feedbackId, "feedback"]);
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
      // What the hub read it as, kept verbatim even after an owner re-reads the
      // row on /quality (Sep 16, Kyle call, item 10) — `sentiment` is the value
      // every count uses, and a human's override lands there instead.
      sentimentAuto: sentiment,
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
  // client feedback" task was ceremony nothing ever closed; every one of those
  // rows is gone (0 open on Sep 8), so nothing sweeps for them any more.
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
        dedupeKey: feedbackTaskKey(fb.id),
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
