"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Action";
import { syncSlackIdsFromWorkspace, type SlackSyncReport } from "@/app/team/actions";
import { useSlackAttempt } from "./useSlackAttempt";

// Same roster matching and saved/skipped report from the existing action.
export function SlackSyncButton() {
  const router = useRouter();
  const [report, setReport] = useState<SlackSyncReport | null>(null);
  const attempt = useSlackAttempt("slack-sync-unconfirmed");
  async function sync() {
    const id = attempt.begin("sync");
    if (!id) return;
    setReport(null);
    let r: SlackSyncReport;
    try { r = await syncSlackIdsFromWorkspace(); }
    catch { attempt.finish(id, false); return; }
    const known = r.outcome === "confirmed" && r.ok || r.outcome === "refused" && !r.ok;
    setReport(r); attempt.finish(id, known);
    if (known && r.set.length) router.refresh();
  }
  return (
    <div className="flex max-w-full flex-col items-start gap-2 sm:items-end">
      <Button variant="secondary" disabled={attempt.blocked} busy={attempt.pending}
        title="Fill empty Slack IDs from the workspace's member list — only rows with one clear match" onClick={sync}>
        <RefreshCw className="size-4" /> Sync Slack IDs from the workspace
      </Button>
      {attempt.held && <div role="alert" className="max-w-md rounded-xl border border-warning/30 bg-warning-soft p-3 text-sm leading-relaxed text-warning">
        <p>The Slack ID sync is unconfirmed. Some Team rows may already have changed. Ask Kyle to inspect the roster and request logs before syncing again.</p>
        <p className="mt-2">This tab holds repeat syncs. Reloading does not prove the earlier writer ended.</p>
      </div>}
      {attempt.localError && <p role="alert" className="max-w-md text-sm text-danger">{attempt.localError}</p>}
      {report && <div role={report.ok && report.outcome === "confirmed" ? "status" : "alert"}
        className={`max-w-md text-sm leading-relaxed sm:text-right ${report.ok && report.outcome === "confirmed" ? "text-success" : "text-warning"}`}>
        <p className="whitespace-pre-line break-words">{report.message}</p>
        {report.set.length > 0 && <ul className="mt-1 text-muted">
          {report.set.map((s) => <li key={s.slackId} className="break-words">{s.name} → <span className="font-mono">{s.slackId}</span> <span className="text-muted-2">(by {s.by})</span></li>)}
        </ul>}
        {report.skipped.length > 0 && <ul className="mt-1 text-muted">
          {report.skipped.map((s) => <li key={s.name} className="break-words">{s.name}: {s.reason}</li>)}
        </ul>}
      </div>}
    </div>
  );
}
