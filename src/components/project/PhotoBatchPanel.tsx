import { Images, AlertTriangle } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { batchesForProject, AUTOHDR_DELAY_DAYS, PARTIAL_TOLERANCE, type BatchState } from "@/lib/photoEditBatches";
import { etDateTime } from "@/lib/datetime";
import { PhotoBatchControls } from "@/components/project/PhotoBatchControls";

// THE AUTOHDR BATCH, on the job (§10 A53, Sep 26). What was sent (the raws the
// hub saw), what came back (the finals), and every earlier attempt — the three
// things a person needs in front of them BEFORE re-running a batch. Office
// only: counts and dates, no money.

const STATE: Record<BatchState, { label: string; tone: string }> = {
  AWAITING_RAWS: { label: "No raws yet", tone: "bg-surface-2 text-muted" },
  SUBMITTED_BY_UPLOAD: { label: "With AutoHDR", tone: "bg-brand-soft text-brand" },
  PARTIAL: { label: "Came back short", tone: "bg-warning-soft text-warning" },
  COMPLETE: { label: "Complete", tone: "bg-success-soft text-success" },
  MISSING: { label: "Nothing back yet", tone: "bg-danger-soft text-danger" },
  UNKNOWN: { label: "Couldn't read Dropbox", tone: "bg-surface-2 text-muted" },
};

function evidenceWords(e: string | null): string {
  if (!e) return "—";
  if (e === "dropbox-upload") return "Raws uploaded to the AutoHDR folder";
  if (e.startsWith("vendor-email:")) return "AutoHDR emailed that the job was done";
  if (e.startsWith("manual:")) return `Re-run recorded by ${e.slice(7)}`;
  return e;
}

export async function PhotoBatchPanel({ projectId, canAct }: { projectId: string; canAct: boolean }) {
  const rows = await batchesForProject(projectId).catch(() => null);
  if (!rows || rows.length === 0) return null;
  const [b, ...earlier] = rows;
  const st = STATE[b.state] ?? STATE.UNKNOWN;
  return (
    <div id="photo-batch" className="scroll-mt-6">
      <Section
        icon={Images}
        title="AutoHDR batch"
        action={<span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.tone}`}>{st.label}</span>}
      >
        <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Fact label="Raws sent" value={b.rawCount != null ? `${b.rawCount}${b.droneCount ? ` (${b.droneCount} drone)` : ""}` : "—"} />
          <Fact label="Expected back" value={b.expectedFinals != null ? `~${b.expectedFinals}` : "—"} />
          <Fact label="Back so far" value={b.finalsCount != null ? String(b.finalsCount) : "unknown"} />
          <Fact label="Attempt" value={String(b.attempt)} />
        </div>
        <ul className="mt-3 space-y-1 text-xs text-muted">
          <li>Sent: {evidenceWords(b.submissionEvidence)}{b.lastRawAt ? ` · the hub last saw the raws change ${etDateTime(b.lastRawAt)}` : ""}</li>
          <li>
            Last looked: {b.lastReadAt ? etDateTime(b.lastReadAt) : "never"}
            {!b.readOk && <span className="text-warning"> · the latest look failed, so these are the last good counts</span>}
          </li>
          {b.resubmittedAt && <li>Re-run {etDateTime(b.resubmittedAt)} by {b.resubmittedBy}: {b.resubmitReason}</li>}
          <li className="text-muted-2">
            Complete at {Math.round(PARTIAL_TOLERANCE * 100)}% of the expected count (bracket sets ÷ 5 + drone singles, an estimate); short or missing only after AutoHDR&rsquo;s {AUTOHDR_DELAY_DAYS} days.
          </li>
        </ul>
        {b.duplicateUploadSuspected && (
          <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Some raws look uploaded twice (the same file name twice, or a Finder &ldquo;(1)&rdquo; copy). They are left out of the expected count — check AutoHDR&rsquo;s bill for a double charge.
          </p>
        )}
        {earlier.length > 0 && (
          <details className="mt-3 text-xs">
            <summary className="cursor-pointer text-muted">Earlier attempts ({earlier.length})</summary>
            <ul className="mt-1.5 space-y-1 text-muted">
              {earlier.map((e) => (
                <li key={e.id}>
                  Attempt {e.attempt}: {STATE[e.state]?.label ?? e.state} · {e.finalsCount ?? "?"} of ~{e.expectedFinals ?? "?"} back · {evidenceWords(e.submissionEvidence)}
                </li>
              ))}
            </ul>
          </details>
        )}
        {canAct && <PhotoBatchControls projectId={projectId} canRecordRerun={b.state === "PARTIAL" || b.state === "MISSING"} />}
      </Section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-2">{label}</div>
      <div className="font-semibold tabular-nums">{value}</div>
    </div>
  );
}
