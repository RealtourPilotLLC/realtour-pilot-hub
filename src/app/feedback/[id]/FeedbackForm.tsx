"use client";

import { useActionState, useState } from "react";
import { Star, Loader2, CheckCircle2 } from "lucide-react";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { submitFeedback } from "./actions";

// ---------------------------------------------------------------------------
// The public client feedback form — the only screen in the hub a stranger with
// a link can reach. It asks EXACTLY what Jordan asked for (Sep 2 2026) and
// nothing else:
//
//   1. How was your experience with your photographer, <name>?   stars + words
//   2. What would you like to see done differently?                     words
//   3. How was the quality of your content?                      stars + words
//   + Overall, how did we do?                                           stars
//
// Rules it is built to:
//   • ONE SCREEN, phone-first. A client reads this standing in a driveway.
//     Every tap target is 44px; nothing is behind a "next" button.
//   • FORGIVING. Every field is optional and the form submits with one answer
//     filled in. A half-answered response is worth more than a bounced one, so
//     there is no required-field wall — the server decides what's enough.
//   • The photographer is NAMED. "your photographer, Harrison" reads as a
//     person, not a vendor, and the answer is stamped onto that person for
//     their KPI (see the columns in actions.ts).
//
// The <input name="projectId"> below is a CROSS-CHECK, never the target: the
// action takes the job from the route the submit came from and refuses a body
// that disagrees. See the header comment in actions.ts.
// ---------------------------------------------------------------------------

// The brand orange, matched to the delivery text's tone. Hard-coded rather than
// a token because a star only reads as "filled" against a real fill colour.
const BRAND = "#e96320";

function StarRow({
  name,
  value,
  onChange,
  ariaLabel,
}: {
  name: string;
  value: number;
  onChange: (n: number) => void;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <>
      {/* Empty string, not "0" — the action treats anything outside 1-5 as
          "they didn't answer this one", and an empty field is the honest
          version of that. */}
      <input type="hidden" name={name} value={value || ""} />
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="flex gap-1"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            // Tapping the star you already picked clears it. On a phone the
            // first tap is often a mis-tap, and without this the only way back
            // to "no answer" is reloading the page and losing what you typed.
            onClick={() => onChange(value === n ? 0 : n)}
            onMouseEnter={() => setHover(n)}
            className="-m-0.5 p-1.5 transition-transform active:scale-95"
            aria-label={`${n} star${n > 1 ? "s" : ""}`}
          >
            <Star
              className="size-8"
              style={{
                fill: shown >= n ? BRAND : "transparent",
                color: shown >= n ? BRAND : "var(--border-strong)",
              }}
            />
          </button>
        ))}
      </div>
    </>
  );
}

const FIELD =
  "w-full rounded-xl border bg-surface px-3.5 py-2.5 text-sm placeholder:text-muted-2 focus:outline-none focus:ring-2 focus:ring-brand/40";

export function FeedbackForm({
  projectId,
  street,
  clientFirstName,
  photographerFirstName,
}: {
  projectId: string;
  /** The property, so they know which shoot they're rating. */
  street: string;
  clientFirstName: string;
  /** null when nobody is assigned on the job — the question stays, the name goes. */
  photographerFirstName: string | null;
}) {
  const [state, action, pending] = useActionState(submitFeedback, null);
  const [photographerRating, setPhotographerRating] = useState(0);
  const [contentRating, setContentRating] = useState(0);
  const [overall, setOverall] = useState(0);

  if (state?.ok) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto mb-3 size-10 text-success" />
        <h1 className="text-xl font-semibold">Thank you{clientFirstName ? `, ${clientFirstName}` : ""}!</h1>
        <p className="mt-2 text-sm text-muted">{state.message}</p>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="projectId" value={projectId} />

      <div className="text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          How did we do{clientFirstName ? `, ${clientFirstName}` : ""}?
        </h1>
        <p className="mt-1 text-sm text-muted">{street}</p>
        <p className="mt-2 text-xs text-muted-2">
          Three quick questions. Answer whichever you like — even one helps.
        </p>
      </div>

      {/* 1 — the photographer, by name. */}
      <div className="space-y-2.5 border-t pt-5">
        <label htmlFor="photographerNote" className="block text-sm font-semibold">
          {photographerFirstName
            ? `How was your experience with your photographer, ${photographerFirstName}?`
            : "How was your experience with your photographer?"}
        </label>
        <StarRow
          name="photographerRating"
          value={photographerRating}
          onChange={setPhotographerRating}
          ariaLabel={
            photographerFirstName
              ? `Your experience with ${photographerFirstName}, out of 5`
              : "Your experience with your photographer, out of 5"
          }
        />
        <AutoTextarea
          id="photographerNote"
          name="photographerNote"
          minRows={2}
          maxRows={8}
          placeholder={
            photographerFirstName
              ? `How was ${photographerFirstName} on the day?`
              : "How were they on the day?"
          }
          className={FIELD}
        />
      </div>

      {/* 2 — the one that changes what we do next time. */}
      <div className="space-y-2.5 border-t pt-5">
        <label htmlFor="improveNote" className="block text-sm font-semibold">
          What would you like to see done differently?
        </label>
        <AutoTextarea
          id="improveNote"
          name="improveNote"
          minRows={3}
          maxRows={10}
          placeholder="Anything at all — the shots, the timing, how we keep you posted."
          className={FIELD}
        />
      </div>

      {/* 3 — the work itself. */}
      <div className="space-y-2.5 border-t pt-5">
        <label htmlFor="contentNote" className="block text-sm font-semibold">
          How was the quality of your content?
        </label>
        <StarRow
          name="contentRating"
          value={contentRating}
          onChange={setContentRating}
          ariaLabel="The quality of your content, out of 5"
        />
        <AutoTextarea
          id="contentNote"
          name="contentNote"
          minRows={2}
          maxRows={8}
          placeholder="The photos, the video, the floor plan…"
          className={FIELD}
        />
      </div>

      {/* The one number that gets scored. Kept last and kept small: it's a
          summary of the three answers above, not a fourth question. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-5">
        <label className="text-sm font-semibold">Overall, how did we do?</label>
        <StarRow name="rating" value={overall} onChange={setOverall} ariaLabel="Overall, out of 5" />
      </div>

      <div className="space-y-3">
        <input name="authorName" type="text" placeholder="Your name (optional)" className={FIELD} />
        <button
          type="submit"
          disabled={pending}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Send feedback
        </button>
        {state && !state.ok && <p className="text-center text-sm text-danger">{state.message}</p>}
      </div>
    </form>
  );
}
