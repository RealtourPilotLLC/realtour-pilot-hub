"use server";

import { recordFeedback } from "@/lib/feedback";

export type FeedbackResult = { ok: boolean; message: string };

export async function submitFeedback(
  _prev: FeedbackResult | null,
  formData: FormData,
): Promise<FeedbackResult> {
  const projectId = String(formData.get("projectId") || "");
  const body = String(formData.get("body") || "").trim();
  const ratingRaw = String(formData.get("rating") || "");
  const rating = ratingRaw ? Number(ratingRaw) : null;
  const authorName = String(formData.get("authorName") || "").trim() || null;

  if (!projectId) return { ok: false, message: "Missing project." };
  if (!body && !rating) return { ok: false, message: "Please add a rating or a comment." };

  const r = await recordFeedback({
    projectId,
    rating: rating && rating >= 1 && rating <= 5 ? rating : null,
    body: body || `(${rating}/5, no comment)`,
    authorName,
    source: "form",
  });
  if (!r.ok) return { ok: false, message: "We couldn't find that project." };
  return { ok: true, message: "Thank you! Your feedback went straight to our team." };
}
