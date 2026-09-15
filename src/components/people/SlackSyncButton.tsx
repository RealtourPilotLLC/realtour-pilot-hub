"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { syncSlackIdsFromWorkspace, type SlackSyncReport } from "@/app/team/actions";

// "Sync Slack IDs from the workspace" (owner/admin, Sep 15). The bot token
// can't list users, but Jordan's own Slack token can — so one click asks the
// workspace for its people and fills every roster row that has no Slack ID
// yet, when exactly one human matches by email or by a unique first name.
// Anything ambiguous is left alone and named in the report, for the card's
// Add / Find buttons. The report stays on screen until the next click.
export function SlackSyncButton() {
  const router = useRouter();
  const [report, setReport] = useState<SlackSyncReport | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        title="Fill empty Slack IDs from the workspace's member list — only rows with one clear match"
        onClick={() => start(async () => {
          const r = await syncSlackIdsFromWorkspace().catch((e: unknown) => ({
            ok: false, message: e instanceof Error ? e.message : "Couldn’t reach Slack — try again.", set: [], skipped: [],
          } satisfies SlackSyncReport));
          setReport(r);
          // The cards read slackId from the server: refresh so the new chips
          // (and the per-row test buttons) light up without a reload.
          if (r.set.length) router.refresh();
        })}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Sync Slack IDs from the workspace
      </button>
      {report && (
        <div className={`max-w-sm text-right text-[11px] ${report.ok ? "text-success" : "text-warning"}`}>
          <p className="whitespace-pre-line">{report.message}</p>
          {report.set.length > 0 && (
            <ul className="mt-0.5 text-muted">
              {report.set.map((s) => (
                <li key={s.slackId}>{s.name} → <span className="font-mono">{s.slackId}</span> <span className="text-muted-2">(by {s.by})</span></li>
              ))}
            </ul>
          )}
          {report.skipped.length > 0 && (
            <ul className="mt-0.5 text-muted">
              {report.skipped.map((s) => (
                <li key={s.name}>{s.name}: {s.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
