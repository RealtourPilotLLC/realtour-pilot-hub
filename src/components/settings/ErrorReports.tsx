"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bug, ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { CopyButton } from "@/components/ui/CopyButton";
import { Section } from "@/components/ui/Section";
import { cn } from "@/lib/utils";
import { setErrorStatusAction } from "@/app/settings/errors/actions";
import type { ErrorRowView } from "@/lib/errorTracker";

// Settings → Errors, the list (Oct 6 2026). One row per problem; open one for
// its details and the three buttons. Plain and calm: this is a to-do list of
// bugs, not a dashboard.

export type ErrorReportRow = ErrorRowView & {
  firstSeenLabel: string;
  lastSeenLabel: string;
  resolvedLabel: string | null;
  reopenedLabel: string | null;
  /** A transient cron failure (lib/cronNoise.ts): what the quiet rule says
   *  about it, worded on the server. Null for every other row. */
  watchNote: string | null;
  report: string;
};

const TABS = [
  { key: "open", label: "Open", count: "OPEN" },
  { key: "fixed", label: "Fixed", count: "FIXED" },
  { key: "ignored", label: "Ignored", count: "IGNORED" },
  { key: "all", label: "All", count: null },
] as const;

const SOURCE_LABEL: Record<string, string> = {
  "server-request": "Page (server)",
  "server-action": "Button / save",
  "route-handler": "API / webhook",
  cron: "Scheduled job",
  client: "Browser",
  "client-portal": "Client portal",
  background: "Background work",
};

const STATUS_TONE: Record<string, string> = {
  OPEN: "bg-danger-soft text-danger",
  FIXED: "bg-success-soft text-success",
  IGNORED: "bg-surface-2 text-muted",
};

export function ErrorReports({
  rows,
  counts,
  status,
  sort,
  selectedId,
  canAct,
}: {
  rows: ErrorReportRow[];
  counts: Record<"OPEN" | "FIXED" | "IGNORED", number>;
  status: string;
  sort: "recent" | "frequent";
  selectedId: string | null;
  canAct: boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(selectedId);
  const href = (s: string, o: string) => `/settings/errors?status=${s}${o === "frequent" ? "&sort=frequent" : ""}`;

  return (
    <Section
      icon={Bug}
      title="Errors"
      count={rows.length}
      action={
        <div className="flex items-center gap-1 text-[12px]">
          <span className="text-muted-2">Sort:</span>
          <Link href={href(status, "recent")} aria-current={sort === "recent" ? "true" : undefined} className={cn("rounded-md px-2 py-1", sort === "recent" ? "bg-surface-2 font-semibold" : "text-muted hover:text-foreground")}>
            Newest
          </Link>
          <Link href={href(status, "frequent")} aria-current={sort === "frequent" ? "true" : undefined} className={cn("rounded-md px-2 py-1", sort === "frequent" ? "bg-surface-2 font-semibold" : "text-muted hover:text-foreground")}>
            Most frequent
          </Link>
        </div>
      }
      flush
    >
      <nav aria-label="Filter errors" className="flex flex-wrap gap-1 border-b px-4 py-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={href(t.key, sort)}
            aria-current={status === t.key ? "page" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-3 text-sm",
              status === t.key ? "bg-surface-2 font-semibold text-foreground" : "text-muted hover:bg-surface-2 hover:text-foreground",
            )}
          >
            {t.label}
            {t.count && <span className="text-[12px] text-muted-2">{counts[t.count]}</span>}
          </Link>
        ))}
      </nav>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted">
          {status === "open" ? "No open errors. New ones appear here and message you on Slack." : "Nothing here."}
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <ErrorRow key={r.id} row={r} open={openId === r.id} onToggle={() => setOpenId(openId === r.id ? null : r.id)} canAct={canAct} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ErrorRow({ row, open, onToggle, canAct }: { row: ErrorReportRow; open: boolean; onToggle: () => void; canAct: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const act = (s: "OPEN" | "FIXED" | "IGNORED") =>
    start(async () => {
      const r = await setErrorStatusAction({ id: row.id, status: s });
      setNote(r);
      if (r.ok) router.refresh();
    });

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-2 focus-visible:outline-brand"
      >
        {open ? <ChevronDown aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-2" /> : <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-2" />}
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-sm font-medium">{row.message}</span>
          <span className="mt-0.5 block text-[12px] text-muted">
            {SOURCE_LABEL[row.source] ?? row.source}
            {row.route ? ` · ${row.route}` : ""} · last {row.lastSeenLabel}
            {row.reopenCount > 0 ? ` · came back ${row.reopenCount}×` : ""}
          </span>
          {row.watchNote && <span className="mt-0.5 block text-[12px] text-muted-2">{row.watchNote}</span>}
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-sm font-semibold tabular-nums">{row.count}×</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[row.status])}>{row.status.toLowerCase()}</span>
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t bg-surface-2/30 px-4 py-3 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">Error</dt>
            <dd className="font-mono text-[12px]">{row.errorName ? `${row.errorName}: ` : ""}{row.message}</dd>
            <dt className="text-muted">Where</dt>
            <dd>{SOURCE_LABEL[row.source] ?? row.source}{row.route ? ` — ${row.route}` : ""}</dd>
            {row.recentPaths.length > 0 && (
              <>
                <dt className="text-muted">Pages</dt>
                <dd className="font-mono text-[12px]">{row.recentPaths.join(", ")}</dd>
              </>
            )}
            <dt className="text-muted">How often</dt>
            <dd>{row.count} time{row.count === 1 ? "" : "s"} — first {row.firstSeenLabel}, last {row.lastSeenLabel}</dd>
            {row.reopenedLabel && (
              <>
                <dt className="text-muted">Came back</dt>
                <dd>{row.reopenedLabel} (after being marked fixed{row.reopenCount > 1 ? `, ${row.reopenCount} times in all` : ""})</dd>
              </>
            )}
            {row.resolvedLabel && (
              <>
                <dt className="text-muted">{row.status === "IGNORED" ? "Ignored" : "Marked fixed"}</dt>
                <dd>{row.resolvedLabel}{row.resolvedBy ? ` by ${row.resolvedBy}` : ""}</dd>
              </>
            )}
            {row.lastUserRole && (
              <>
                <dt className="text-muted">Signed in as</dt>
                <dd>{row.lastUserRole.toLowerCase()}</dd>
              </>
            )}
            {row.digest && (
              <>
                <dt className="text-muted">Reference</dt>
                <dd className="font-mono text-[12px]">{row.digest}</dd>
              </>
            )}
          </dl>
          <pre className="max-h-72 overflow-auto rounded-lg border bg-surface p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {row.stack ?? "No stack was recorded for this error."}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton value={row.report} label="Copy for Claude" title="Copy a report to paste into Claude" className="rounded-xl border border-border-strong bg-surface px-3 text-foreground" />
            {canAct && row.status !== "FIXED" && (
              <Button onClick={() => act("FIXED")} busy={pending} busyLabel="Saving…">Mark fixed</Button>
            )}
            {canAct && row.status !== "IGNORED" && (
              <Button variant="secondary" onClick={() => act("IGNORED")} busy={pending} busyLabel="Saving…">Ignore</Button>
            )}
            {canAct && row.status !== "OPEN" && (
              <Button variant="secondary" onClick={() => act("OPEN")} busy={pending} busyLabel="Saving…">Reopen</Button>
            )}
          </div>
          {note && (
            <p role="status" className={cn("text-[13px]", note.ok ? "text-success" : "text-danger")}>
              {note.message}
            </p>
          )}
          {!canAct && <p className="text-[12px] text-muted">You&rsquo;re previewing — exit the preview to change an error&rsquo;s status.</p>}
        </div>
      )}
    </li>
  );
}
