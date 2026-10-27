"use client";

import { CheckCircle2, Circle, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import { Section } from "@/components/ui/Section";
import { AskOnJob, MarkBriefRead } from "@/components/shoot/AskOnJob";

// ---------------------------------------------------------------------------
// BEFORE THE SHOOT (Oct 27 2026, Jordan: "the brief has no way to resolve
// anything"). The top of the brief page, while the visit is today or ahead:
// what the shoot still needs, one line each, with the one thing to do about
// it. Only what is on the job: the shoot-day brief's Got it (Kyle's desk
// waits on it), access (Kyle's to chase: Ask Kyle), the script (Jordan's:
// Ask Jordan), the shot list and the client's special requests (links to
// where they are on this page). A question for either of them, and Flag a
// problem, close the card.
// ---------------------------------------------------------------------------

export type PrepLine = {
  key: string;
  label: string;
  tone: "ok" | "todo" | "info";
  action:
    | { kind: "link"; label: string; href: string }
    | { kind: "ask"; label: string; to: "kyle" | "jordan"; placeholder: string }
    | { kind: "ack"; day: string; digest: string; again: boolean }
    | null;
};

export function ShootPrepCard({ projectId, lines, readOnly }: { projectId: string; lines: PrepLine[]; readOnly: boolean }) {
  const open = lines.filter((l) => l.tone === "todo").length;
  return (
    <Section icon={ListChecks} title="Before the shoot" count={open ? `${open} to handle` : "Ready"} bodyClassName="space-y-1">
      <ul data-shoot-prep className="divide-y divide-border">
        {lines.map((l) => (
          <li key={l.key} data-prep-line={l.key} data-tone={l.tone} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            {l.tone === "ok"
              ? <CheckCircle2 aria-hidden className="size-4 shrink-0 text-success" />
              : <Circle aria-hidden className={cn("size-4 shrink-0", l.tone === "todo" ? "text-warning" : "text-muted-2")} />}
            <span className={cn("min-w-0 flex-1 text-sm [overflow-wrap:anywhere]", l.tone === "todo" && "font-medium")}>{l.label}</span>
            {l.action?.kind === "link" && <a href={l.action.href} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand hover:underline">{l.action.label}</a>}
            {l.action?.kind === "ask" && <AskOnJob projectId={projectId} to={l.action.to} label={l.action.label} placeholder={l.action.placeholder} readOnly={readOnly} variant="quiet" />}
            {l.action?.kind === "ack" && <MarkBriefRead day={l.action.day} digest={l.action.digest} again={l.action.again} readOnly={readOnly} />}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-x-4 border-t border-border pt-2">
        <AskOnJob projectId={projectId} label="Ask Kyle or Jordan" placeholder="Your question about this shoot" readOnly={readOnly} />
        <a href="#flag" className="inline-flex min-h-8 items-center text-[12px] font-medium text-brand hover:underline">Flag a problem</a>
      </div>
    </Section>
  );
}
