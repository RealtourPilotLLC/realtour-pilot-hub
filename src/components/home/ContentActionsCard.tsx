import Link from "next/link";
import { CheckCircle2, Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContentActions, ContentActionRow } from "@/lib/contentActions";

// MONTHLY CONTENT, WHAT NEEDS YOU (Oct 20 2026): Jordan's and the creative
// manager's Dashboard. One line per client and month: "Ashley Brunner ·
// October", then what is owed on it ("Needs 4 scripts · 2 messages waiting on
// a reply"), each a link to the tab where it is done. lib/contentActions reads it.

const SHOWN = 6;
const monthWord = (key: string) => new Date(`${key}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

function Row({ r }: { r: ContentActionRow }) {
  return (
    <li className="py-2.5">
      <Link href={r.href} className="text-sm font-semibold leading-snug hover:text-brand">
        {r.clientName} <span className="font-normal text-muted">· {monthWord(r.monthKey)}</span>
      </Link>
      <p className="mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0.5 text-[13px]">
        {r.items.map((i, k) => (
          <span key={i.key} className="inline-flex items-center gap-1.5">
            {k > 0 && <span aria-hidden className="text-muted-2">·</span>}
            <Link href={i.href} className={cn("underline-offset-2 hover:underline", i.tone === "warn" ? "font-medium text-warning" : i.tone === "brand" ? "font-medium text-brand" : "text-muted")}>{i.words}</Link>
          </span>
        ))}
      </p>
    </li>
  );
}

export function ContentActionsCard({ data }: { data: ContentActions | null }) {
  if (!data) {
    return <p role="status" className="rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-muted">Monthly content couldn&rsquo;t load. Refresh to try again.</p>;
  }
  const { rows } = data;
  return (
    <section aria-labelledby="content-actions-title" data-content-actions className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id="content-actions-title" className="flex items-center gap-2 text-base font-semibold"><Clapperboard aria-hidden className="size-4 text-brand" /> Monthly content</h2>
        <p className="text-sm text-muted">{rows.length ? `${rows.length} ${rows.length === 1 ? "client needs" : "clients need"} something` : "nothing waiting"}</p>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" /> Nothing in this month&rsquo;s or next month&rsquo;s content is waiting on you.</p>
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
