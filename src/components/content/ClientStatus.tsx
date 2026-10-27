import Link from "next/link";
import { AlertTriangle, MessageSquareDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { contentHref } from "@/lib/contentNav";
import { bookingReminderLine, statusLine } from "@/lib/contentStatusLine";
import type { OverviewRow } from "@/lib/programOverview";

// ---------------------------------------------------------------------------
// THE CLIENT'S STATUS, AS WORDS (Oct 27 2026). Jordan on Monthly Content: "all
// of these little chips ... make it look much nicer and easy to identify where
// people are at and what they're waiting on."
//
// One sentence ("Waiting on Bernadette: answer 1 topic and book the October
// session"), the other side's asks under it in grey, then only what needs a
// look: an unread client message, what is overdue and why, a failed
// automation, the booking reminder's last send. Colour means attention and
// nothing else: our work gets a small brand dot, theirs a grey one, a month
// with nothing pending is plain text, and only overdue or a failure is amber.
// Server-safe (no hooks), shared by the roster row, the card and the Overview.
// ---------------------------------------------------------------------------

export function StatusSentence({ r, size = "sm" }: { r: OverviewRow; size?: "sm" | "lg" }) {
  const s = statusLine(r);
  const big = size === "lg";
  return (
    <div className="min-w-0">
      <p className={cn("flex items-start gap-2 leading-snug", big ? "text-[15px]" : "text-sm")}>
        {(s.side === "us" || s.side === "them") && (
          <span aria-hidden className={cn("mt-[0.45em] size-2 shrink-0 rounded-full", s.side === "us" ? "bg-brand" : "bg-muted-2")} />
        )}
        <span className={cn("min-w-0", s.side === "none" || s.side === "closed" ? "text-muted" : "text-foreground")}>
          {s.detail ? <><span className="font-semibold">{s.lead}:</span> {s.detail}</> : s.lead}
        </span>
      </p>
      {s.also && <p className={cn("mt-0.5 text-ui-status text-muted", (s.side === "us" || s.side === "them") && "pl-4")}>{s.also}</p>}
    </div>
  );
}

/** The quiet lines under the sentence: unread messages, overdue, failures, the booking reminder. */
export function StatusNotes({ r, now, reminderAction }: { r: OverviewRow; now: Date; reminderAction?: React.ReactNode }) {
  const booking = r.waiting.them.some((x) => x.key === "book_session") ? bookingReminderLine(r.comms, now) : null;
  const notes: React.ReactNode[] = [];
  if (r.comms.messagesWaiting > 0) {
    notes.push(
      <Link key="msg" href={contentHref(r.enrollmentId, { tab: "messages" })} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand hover:underline">
        <MessageSquareDot className="size-3" aria-hidden /> {r.comms.messagesWaiting === 1 ? "New message from the client" : `${r.comms.messagesWaiting} new messages from the client`}
      </Link>,
    );
  }
  if (r.overdue) {
    notes.push(
      <span key="due" className={cn("inline-flex items-start gap-1 text-xs", r.overdue.kind === "over" ? "font-medium text-warning" : "text-muted")}>
        {r.overdue.kind === "over" && <AlertTriangle className="mt-px size-3 shrink-0" aria-hidden />}
        {r.overdue.kind === "over" ? "Overdue" : "Due soon"}: {r.overdue.why}
      </span>,
    );
  }
  if (r.failures.length > 0) {
    notes.push(
      <Link key="fail" href={r.failures[0].href} className="inline-flex items-center gap-1 text-xs font-medium text-warning hover:underline">
        <AlertTriangle className="size-3" aria-hidden /> {r.failures.length === 1 ? `An automation failed: ${r.failures[0].title}` : `${r.failures.length} automations failed`}
      </Link>,
    );
  }
  if (booking) {
    notes.push(
      <span key="rem" className="inline-flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className={booking.tone === "attention" ? "text-foreground/80" : undefined}>{booking.text}</span>
        {reminderAction}
      </span>,
    );
  }
  if (notes.length === 0) return null;
  return <div className="flex flex-wrap items-center gap-x-3 gap-y-1">{notes}</div>;
}
