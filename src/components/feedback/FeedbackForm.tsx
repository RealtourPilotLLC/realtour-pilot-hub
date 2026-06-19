"use client";

import { useActionState, useState } from "react";
import { Star, Loader2, CheckCircle2 } from "lucide-react";
import { submitFeedback } from "@/app/feedback/[id]/actions";

export function FeedbackForm({
  projectId,
  title,
  clientName,
}: {
  projectId: string;
  title: string;
  clientName: string;
}) {
  const [state, action, pending] = useActionState(submitFeedback, null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);

  if (state?.ok) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto mb-3 size-10 text-success" />
        <h1 className="text-xl font-semibold">Thank you{clientName ? `, ${clientName.split(" ")[0]}` : ""}!</h1>
        <p className="mt-2 text-sm text-muted">{state.message}</p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="rating" value={rating || ""} />

      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">How was your experience?</h1>
        <p className="mt-1 text-sm text-muted">{title}</p>
      </div>

      <div className="flex justify-center gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setRating(n)}
            onMouseEnter={() => setHover(n)}
            onMouseLeave={() => setHover(0)}
            className="p-1 transition-transform hover:scale-110"
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            <Star
              className="size-9"
              style={{
                fill: (hover || rating) >= n ? "#e96320" : "transparent",
                color: (hover || rating) >= n ? "#e96320" : "var(--border-strong)",
              }}
            />
          </button>
        ))}
      </div>

      <textarea
        name="body"
        rows={4}
        placeholder="Tell us what you loved, or anything we can improve…"
        className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
      />
      <input
        name="authorName"
        type="text"
        placeholder="Your name (optional)"
        className="w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
      />

      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60"
      >
        {pending && <Loader2 className="size-4 animate-spin" />}
        Send feedback
      </button>
      {state && !state.ok && <p className="text-center text-sm text-danger">{state.message}</p>}
    </form>
  );
}
