import { ChevronDown } from "lucide-react";
import { olderLabel, RECENT_DAYS } from "@/lib/recentWindow";

// The fold under a recent window (lib/recentWindow): the older messages or
// notes, closed until someone opens it. No state of its own, so it renders the
// same on the server, in a client component and in the drills.
export function OlderFold({ count, noun, days = RECENT_DAYS, children }: { count: number; noun: string; days?: number; children: React.ReactNode }) {
  if (count <= 0) return null;
  return (
    <details className="group mt-2 rounded-lg border border-border" data-older-fold={count}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-sm text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronDown aria-hidden className="size-4 shrink-0 transition-transform group-open:rotate-180" />
        {olderLabel(count, noun, days)}
      </summary>
      <div className="border-t border-border p-2">{children}</div>
    </details>
  );
}
