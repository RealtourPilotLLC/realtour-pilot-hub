import { Star } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { etDate } from "@/lib/datetime";
import type { ClientFeedbackRow } from "@/lib/review";

// "What the client said" — the praise a shoot earned, on the photographer's
// own shoot page. Server-rendered; the rows arrive already creative-safe from
// getClientFeedback (POSITIVE/NEUTRAL only, money-scrubbed) — negative client
// feedback never reaches creatives, and this card never fetches on its own.

function Stars({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${n} out of 5 stars`}>
      {Array.from({ length: 5 }).map((_, i) => (
        <Star
          key={i}
          className={i < n ? "size-3.5 fill-current text-warning" : "size-3.5 text-muted-2/50"}
        />
      ))}
    </span>
  );
}

export function ClientPraiseCard({ items }: { items: ClientFeedbackRow[] }) {
  if (items.length === 0) return null;
  return (
    <Section icon={Star} title="What the client said" bodyClassName="space-y-3">
      {items.map((f) => (
        <div key={f.id}>
          {f.rating != null && <Stars n={f.rating} />}
          {f.body && (
            <p className="mt-1 text-sm leading-snug text-foreground/90">&ldquo;{f.body}&rdquo;</p>
          )}
          <p className="mt-1 text-[11px] text-muted-2">
            {f.authorName ?? "Client"} · {etDate(f.createdAt)}
          </p>
        </div>
      ))}
    </Section>
  );
}
