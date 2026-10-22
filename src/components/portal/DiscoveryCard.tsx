import { CalendarClock, ExternalLink, Video } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardTitle } from "@/components/portal/ui";
import { STRATEGY_PENDING_NEXT, discoveryLine, type PortalStrategyGate } from "@/lib/yourMonth";

// ---------------------------------------------------------------------------
// WHERE A NEW CLIENT STANDS (Oct 21 2026). Jordan, after Kristen Pavillard
// signed up and asked "Am I supposed to have a branding call first?": the
// portal should show that her brand discovery call is scheduled. While the
// strategy gate is closed (lib/strategyGate), Home and the Strategy page show
// this card: the discovery call (with its Meet link, or the booking link while
// it is still needed), then what comes next. No em dashes (client copy).
// ---------------------------------------------------------------------------

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

export function DiscoveryCard({ gate, timezone, className }: { gate: PortalStrategyGate; timezone?: string; className?: string }) {
  const done = gate.discovery === "held" || gate.discovery === "waived";
  // Once the call is behind them, the first line is what's next, not the call.
  const next = done ? STRATEGY_PENDING_NEXT.slice(1) : STRATEGY_PENDING_NEXT;
  return (
    <Card tone="brand" className={className}>
      <CardTitle icon={CalendarClock}>{done ? "Your content strategy" : "Your brand discovery call"}</CardTitle>
      <p data-discovery-line className="mt-2 break-words text-lg font-semibold leading-snug">{discoveryLine(gate, timezone)}</p>
      {gate.discovery === "booked" && gate.meetLink && (
        <a href={gate.meetLink} target="_blank" rel="noopener noreferrer" className={cn("mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand hover:underline", focusRing)}>
          <Video className="size-4" aria-hidden /> Join on Google Meet
        </a>
      )}
      {gate.discovery === "needed" && gate.discoveryUrl && (
        <a href={gate.discoveryUrl} target="_blank" rel="noopener noreferrer" className={cn("mt-3 inline-flex min-h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-action px-5 text-sm font-semibold text-white shadow hover:opacity-90 sm:w-auto", focusRing)}>
          Book your brand discovery call <ExternalLink className="size-4" aria-hidden />
        </a>
      )}
      <div className="mt-3 text-[11px] font-semibold uppercase tracking-widest text-muted-2">What happens next</div>
      <ol className="mt-1 space-y-1 text-sm text-muted">
        {next.map((line, i) => (
          <li key={i} className="flex gap-2"><span className="font-semibold tabular-nums text-brand">{i + 1}.</span><span>{line}</span></li>
        ))}
      </ol>
      <p className="mt-2 text-sm text-muted">You don&rsquo;t need to book a strategy call or filming yet.</p>
    </Card>
  );
}
