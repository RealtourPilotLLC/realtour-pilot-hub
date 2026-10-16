import Link from "next/link";
import { MessageSquareWarning } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { STATE_WORDS, causeLabel } from "@/lib/clientIssuesCore";
import type { ClientIssueView } from "@/lib/clientIssues";

// ---------------------------------------------------------------------------
// Open complaints across every client, on /quality (Oct 15 2026). Each row
// links to the client file, where the cause, the correction and the client's
// confirmation are recorded (ClientIssuesCard).
// ---------------------------------------------------------------------------

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }) : "");

export function OpenComplaintsList({ issues }: { issues: ClientIssueView[] }) {
  return (
    <Section icon={MessageSquareWarning} title="Open complaints" count={issues.length} tone={issues.length ? "warning" : "default"} flush>
      {issues.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted">Nothing open. Every complaint on record is resolved or confirmed with the client.</p>
      ) : (
        <ul className="divide-y divide-border" data-open-complaints>
          {issues.map((i) => (
            <li key={i.id} className="px-5 py-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-2">
                <Link href={`/clients/${i.clientId}`} className="font-medium text-brand hover:underline">{i.clientName ?? "Client"}</Link>
                <span className="font-medium">{i.title}</span>
                <span className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">{STATE_WORDS[i.state]}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-foreground/85">{i.whatHappened}</p>
              <p className="mt-0.5 text-xs text-muted">
                Opened {day(i.createdAtISO)} · cause: {causeLabel(i.cause)}{i.ownerName ? ` · owner: ${i.ownerName}` : ""}{i.dueAtISO ? ` · due ${day(i.dueAtISO)}` : ""}
                {i.state === "CORRECTED" ? " · waiting on the client's answer" : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
