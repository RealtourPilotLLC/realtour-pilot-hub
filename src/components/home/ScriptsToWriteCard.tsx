import Link from "next/link";
import { CheckCircle2, PenLine } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ScriptsToWrite, ScriptRow } from "@/lib/scriptsToWrite";

// SCRIPTS TO WRITE (Oct 20 2026): Jordan's and the creative manager's
// Dashboard. What still needs a person first, then what the hub drafts itself,
// then drafts waiting on a review. lib/scriptsToWrite reads it.

const SHOWN = 6;
const monthWord = (key: string) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

function Row({ r }: { r: ScriptRow }) {
  return (
    <li className="py-2.5">
      <Link href={r.href} className="text-sm font-semibold leading-snug [overflow-wrap:anywhere] hover:text-brand">{r.title}</Link>
      <p className="mt-0.5 text-[12px] text-muted">
        {r.clientName} · {monthWord(r.monthKey)} ·{" "}
        <span className={cn(r.tone === "warn" && "font-medium text-warning", r.tone === "brand" && "font-medium text-brand")}>{r.state}</span>
      </p>
    </li>
  );
}

export function ScriptsToWriteCard({ data }: { data: ScriptsToWrite | null }) {
  if (!data) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">Scripts to write couldn&rsquo;t load. Refresh to try again.</p>;
  }
  const rows = [...data.toWrite.filter((r) => r.tone === "warn"), ...data.toReview, ...data.toWrite.filter((r) => r.tone !== "warn")];
  const needPerson = data.toWrite.filter((r) => r.tone === "warn").length;
  return (
    <section aria-labelledby="scripts-to-write-title" data-scripts-to-write className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="scripts-to-write-title" className="flex items-center gap-2 text-base font-semibold"><PenLine aria-hidden className="size-4 text-brand" /> Scripts to write</h2>
        <p className="text-sm text-muted">
          {data.toWrite.length} without a script{needPerson ? ` (${needPerson} need you)` : ""} · {data.toReview.length} to review
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Every video this month and next has a script, and none is waiting on a review.</p>
      ) : (
        <>
          <ul className="mt-2 divide-y divide-border">{rows.slice(0, SHOWN).map((r) => <Row key={r.key} r={r} />)}</ul>
          {rows.length > SHOWN && (
            <details className="border-t border-border">
              <summary className="min-h-11 cursor-pointer py-2.5 text-sm font-medium">Show {rows.length - SHOWN} more</summary>
              <ul className="divide-y divide-border">{rows.slice(SHOWN).map((r) => <Row key={r.key} r={r} />)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
