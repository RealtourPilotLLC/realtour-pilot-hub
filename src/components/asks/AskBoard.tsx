import Link from "next/link";
import type { AskView, JobChoice, RequestGroup } from "@/lib/clientAsks";
import { AskActions } from "./AskActions";
import { holdWords } from "./OpenClientAsksCard";

// ---------------------------------------------------------------------------
// Rows and job cards for Kyle's Special requests and Scheduling screens
// (Oct 19 2026, lib/clientAsks). Server-rendered; only the buttons are client.
// ---------------------------------------------------------------------------

const MEDIUM_WORDS: Record<string, string> = { video: "Video", photo: "Photos", both: "Photos and video", unclear: "Photos or video" };

function DueChip({ a }: { a: AskView }) {
  if (a.state !== "OPEN") return null;
  if (a.behind) return <span className="rounded-md bg-danger/15 px-1.5 py-0.5 text-[11px] font-semibold text-danger" data-ask-behind>Behind</span>;
  if (a.dueToday) return <span className="rounded-md bg-warning/20 px-1.5 py-0.5 text-[11px] font-semibold text-warning">Due today</span>;
  if (a.dueWords) return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Due {a.dueWords}</span>;
  return null;
}

export function AskBoardRow({ a, showJob = false, jobChoices }: { a: AskView; showJob?: boolean; jobChoices?: { id: string; label: string }[] }) {
  return (
    <li className="space-y-1.5 px-4 py-3" data-ask-id={a.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 font-medium text-foreground">{a.summary}</p>
        <DueChip a={a} />
      </div>
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
        {showJob && (
          <>
            {a.projectId ? (
              <Link href={`/projects/${a.projectId}`} className="font-medium text-brand hover:underline">{a.street ?? "The job"}</Link>
            ) : (
              <span>No job picked</span>
            )}
            <span aria-hidden>·</span>
          </>
        )}
        <span>{a.askedBy ?? a.clientName ?? "The client"}{a.askedBy && a.clientName && a.askedBy !== a.clientName ? ` (${a.clientName})` : ""}</span>
        <span aria-hidden>·</span>
        <span>{a.sourceWords}</span>
        <span aria-hidden>·</span>
        <span>{a.whenWords}</span>
        {a.kind === "SPECIAL_REQUEST" && (
          <>
            <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium ${a.holdsDelivery ? "bg-warning/20 text-warning" : "bg-surface-2 text-muted"}`}>{holdWords(a)}</span>
            <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{MEDIUM_WORDS[a.medium] ?? a.medium}</span>
          </>
        )}
      </p>
      {a.text.trim() !== a.summary.trim() && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-brand">{a.source === "aryeo" ? "What changed" : "The client’s words"}</summary>
          <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-2 px-2 py-1.5 text-[13px] text-foreground/85">{a.text}</p>
        </details>
      )}
      {a.closedWords && <p className="text-xs text-muted">{a.closedWords}</p>}
      <AskActions id={a.id} kind={a.kind} holdsDelivery={a.holdsDelivery} state={a.state} jobChoices={a.projectId ? undefined : jobChoices} />
    </li>
  );
}

export function RequestGroupCard({ g, jobs }: { g: RequestGroup; jobs: JobChoice[] }) {
  const choices = g.projectId ? undefined : jobs.filter((j) => j.clientId === g.clientId).map((j) => ({ id: j.id, label: j.label }));
  return (
    <section aria-label={g.street ?? "Job not clear yet"} className={`panel-shadow overflow-hidden rounded-2xl border bg-surface ${g.behind ? "border-danger/40" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        <h2 className="min-w-0 text-base font-semibold">
          {g.projectId ? (
            <Link href={`/projects/${g.projectId}`} className="hover:underline">{g.street ?? "A job"}</Link>
          ) : (
            "Which job? Not clear yet"
          )}
        </h2>
        <span className="text-sm text-muted">{g.clientName ?? "Client"}</span>
        <span className="text-sm text-muted">{g.projectId ? (g.dueWords ? `Delivery due ${g.dueWords}` : "No delivery date") : "Pick the job below"}</span>
        <span className="flex flex-wrap gap-1">
          {g.media.map((m) => (
            <span key={m} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{MEDIUM_WORDS[m] ?? m}</span>
          ))}
        </span>
        {g.projectId && (
          <Link href={`/review/${g.projectId}`} className="ml-auto text-sm font-medium text-brand hover:underline">Review Room</Link>
        )}
      </div>
      <ul className="divide-y divide-border">
        {g.asks.map((a) => (
          <AskBoardRow key={a.id} a={a} jobChoices={choices} />
        ))}
      </ul>
    </section>
  );
}
