import { CheckCircle2, EyeOff, MessageSquareText, Send } from "lucide-react";
import { etDateYear } from "@/lib/datetime";
import { scrubMoney } from "@/lib/text";
import { cn } from "@/lib/utils";
import type { CoachingAudit } from "@/lib/commsCoaching";

// ---------------------------------------------------------------------------
// One evening's audit, rendered the way it would arrive.
//
// THE STRUCTURE, NOT THE BLOB. The engine stores the note as a flat string
// (audit.note) and also as its parts — the thanks, what went well, and each
// suggestion as {said, tryInstead, why}. This card renders the PARTS, because
// that is what makes a report skimmable: Jordan can see at a glance whether a
// day produced advice or a thank-you, and read the "why" without reading the
// whole message. The flat note is what Kyle receives in Slack, and both are
// built from the same fields, so they cannot drift.
//
// TWO THINGS THIS CARD REFUSES TO DO.
//
// It never dresses a good day up as a finding. A day with no suggestions gets a
// green tick and the same size card as any other, because a report that only
// ever shows problems teaches the person reading it that being fine is
// invisible.
//
// It never prints money. The engine scrubs on the way in (its own safe() wraps
// scrubMoney) and this card scrubs again on the way out. Defence in depth on
// the one class of detail that must not travel: these notes quote client
// conversations and the coached person can read them.
// ---------------------------------------------------------------------------

/** ET day (YYYY-MM-DD) → "Sep 20, 2026". Parsed at noon UTC so the date never
 *  slides a day backwards on the way to the screen. */
function dayLabel(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : etDateYear(d);
}

export function NoteCard({
  audit,
  /** The owner's view says who a note is about; a person reading their own does not. */
  showPerson = false,
  /** The owner's view says whether it was delivered; the recipient already knows. */
  showDelivery = false,
}: {
  audit: CoachingAudit;
  showPerson?: boolean;
  showDelivery?: boolean;
}) {
  const clean = audit.suggestions.length === 0;
  const Icon = clean ? CheckCircle2 : MessageSquareText;
  return (
    <article className="rounded-xl border border-border bg-surface-2/40 p-3.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold",
            clean ? "bg-success/10 text-success" : "bg-brand-soft text-brand",
          )}
        >
          <Icon className="size-3.5" />
          {clean ? "Nothing to change" : audit.suggestions.length === 1 ? "One to try" : `${audit.suggestions.length} to try`}
        </span>
        <span className="text-[13px] font-medium">{dayLabel(audit.dayKey)}</span>
        {showPerson && <span className="text-[13px] text-muted">{`· ${audit.personName}`}</span>}
        {showDelivery && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-2">
            {/* The label sits on its own line: the parent's flex gap spaces it
                from the icon, and JSX drops a leading space that follows an
                element on the same line. */}
            {audit.sent ? (
              <>
                <Send className="size-3.5" />
                Sent
              </>
            ) : (
              <>
                <EyeOff className="size-3.5" />
                Not sent
              </>
            )}
          </span>
        )}
      </div>

      <p className="mt-2 text-sm leading-relaxed">{scrubMoney(audit.thanks)}</p>

      {audit.wentWell.length > 0 && (
        <ul className="mt-2 space-y-1">
          {audit.wentWell.map((w, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-muted">
              <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-success" />
              <span>{scrubMoney(w)}</span>
            </li>
          ))}
        </ul>
      )}

      {audit.suggestions.map((s, i) => (
        <div key={i} className="mt-2.5 rounded-lg border border-border bg-surface p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-2">{`With ${scrubMoney(s.client)}`}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{`“${scrubMoney(s.said)}”`}</p>
          <p className="mt-1.5 text-[13px] font-medium leading-relaxed">{`Try: “${scrubMoney(s.tryInstead)}”`}</p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{`Why: ${scrubMoney(s.why)}`}</p>
        </div>
      ))}

      {/* No "0 messages" branch. The engine returns before it writes an audit
          whenever the day had fewer than MIN_MESSAGES_TO_COACH attributable
          messages, so a stored audit can never carry 0, and a line describing a
          state the report cannot reach reads like a state it can. A day with
          nothing to read has no card at all; the page says so in its own words,
          and says it is not a verdict on anybody. */}
      <p className="mt-2.5 border-t border-border pt-2 text-[11px] leading-relaxed text-muted-2">
        {`From ${audit.messagesAnalysed} message${audit.messagesAnalysed === 1 ? "" : "s"} across ${audit.threadsAnalysed} conversation${audit.threadsAnalysed === 1 ? "" : "s"}`}
        {audit.clients.length > 0 && ` with ${audit.clients.slice(0, 5).join(", ")}`}
        {audit.clients.length > 5 && ` and ${audit.clients.length - 5} more`}
        {/* A capped day is visibly sampled rather than quietly truncated. */}
        {audit.droppedForCap > 0 && ` · ${audit.droppedForCap} more not read (daily cap)`}
        {/* WHY A THIN DAY IS THIN (review, Sep 21 2026). The engine records both
            of these expressly for this line and the card rendered neither, so
            the only place either number existed was the cron's HTTP response
            body, which nobody reads. Better than half of what leaves the
            company line goes to a teammate, so "From 6 messages across 2
            conversations" on a 40-text day looked like a gatherer losing work
            rather than a day of internal traffic. And a day where the quote
            gate threw suggestions away because the model paraphrased words the
            person never wrote — the exact failure this feature must never ship
            — said nothing at all on any human surface.
            Both fields are optional: absent means the row predates the counter,
            which is why this tests truthiness rather than `!== undefined`. A
            zero renders nothing, and nothing is the right amount to say about
            a day where neither happened. */}
        {audit.offClientSkipped ? ` · ${audit.offClientSkipped} not client work` : ""}
        {audit.suggestionsDropped ? ` · ${audit.suggestionsDropped} dropped as unquotable` : ""}
        {showDelivery && !audit.sent && audit.sendSkipped && ` · ${audit.sendSkipped}`}
      </p>
    </article>
  );
}
