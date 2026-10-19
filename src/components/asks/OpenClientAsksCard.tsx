import { MessageSquareWarning } from "lucide-react";
import type { AskView } from "@/lib/clientAsks";
import { AskActions } from "./AskActions";

// ---------------------------------------------------------------------------
// "OPEN CLIENT ASKS ON THIS JOB" (Oct 19 2026). Shown above the verdict in the
// Review Room on any cut, pending or approved, and on the photo job page.
// Jordan: "before it's approved, any open issues with the client via text
// message or email should be shown." Each ask: what to check in one line, the
// client's own words folded under it, who asked, how and when, and the two
// presses that close it (Confirmed, with an optional note, or Not needed).
// Approve stays one click and is never blocked here: a text or email ask holds
// the DELIVERY until it is confirmed, not the verdict.
// ---------------------------------------------------------------------------

export function holdWords(a: Pick<AskView, "holdsDelivery" | "medium">): string {
  if (!a.holdsDelivery) return "To check";
  return a.medium === "video" ? "Holds the video" : a.medium === "photo" ? "Holds the photos" : "Holds delivery";
}

const MEDIUM_WORDS: Record<string, string> = { video: "Video", photo: "Photos", both: "Photos and video", unclear: "Photos or video" };

export function OpenClientAsksCard({ asks, deliverWhat }: { asks: AskView[]; deliverWhat: "video" | "photo" }) {
  if (!asks.length) return null;
  const holding = asks.filter((a) => a.holdsDelivery && (a.medium === deliverWhat || a.medium === "both" || a.medium === "unclear")).length;
  const thing = deliverWhat === "video" ? "the video" : "the photos";
  return (
    <section aria-label="Open client asks on this job" data-open-asks className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
      <p className="flex items-center gap-1.5 font-semibold text-foreground">
        <MessageSquareWarning aria-hidden className="size-4 text-warning" />
        Open client asks on this job
        <span className="font-normal text-muted">· {asks.length}</span>
      </p>
      <p className="mt-0.5 text-xs text-muted">
        {holding
          ? `Check ${holding === 1 ? "this request" : `these ${holding} requests`} on ${thing} before it's sent. Approving is not blocked.`
          : "What the client asked us to get right. Check the work against these."}
      </p>
      <ul className="mt-2 divide-y divide-warning/20">
        {asks.map((a) => (
          <li key={a.id} className="space-y-1.5 py-2.5" data-ask-id={a.id}>
            <p className="font-medium text-foreground">{a.summary}</p>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
              <span>{a.askedBy ?? a.clientName ?? "The client"}</span>
              <span aria-hidden>·</span>
              <span>{a.sourceWords}</span>
              <span aria-hidden>·</span>
              <span>{a.whenWords}</span>
              <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${a.holdsDelivery ? "bg-warning/20 text-warning" : "bg-surface-2 text-muted"}`}>{holdWords(a)}</span>
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{MEDIUM_WORDS[a.medium] ?? a.medium}</span>
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer font-medium text-brand">The client&rsquo;s words</summary>
              <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-2 px-2 py-1.5 text-[13px] text-foreground/85">{a.text}</p>
            </details>
            <AskActions id={a.id} kind={a.kind} holdsDelivery={a.holdsDelivery} state={a.state} />
          </li>
        ))}
      </ul>
    </section>
  );
}
