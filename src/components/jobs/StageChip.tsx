import type { DeliverableStage, JobRow, StageTone } from "@/lib/jobsBoard";

// ---------------------------------------------------------------------------
// The Shoots chips (Oct 19 2026, lib/jobsBoard): one for where the photos
// stand, one for the video, one for the client's open requests. The same
// chips sit on the Shoots page, the dashboard and the job page's two cards,
// so a word means the same thing everywhere. Colour follows the tone:
// done green, in progress brand, waiting amber, late red, nothing muted.
// ---------------------------------------------------------------------------

export const TONE_CLASS: Record<StageTone, string> = {
  done: "bg-success/15 text-success",
  active: "bg-brand/15 text-brand",
  waiting: "bg-warning/15 text-warning",
  late: "bg-danger/15 text-danger",
  none: "bg-surface-2 text-muted",
};

const chip = "inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium";

/** A stage chip; `stage` null is "Not ordered" (or `empty`, e.g. "n/a" on monthly content). */
export function StageChip({ stage, empty = "Not ordered", title }: { stage: DeliverableStage | null; empty?: string; title?: string }) {
  if (!stage) {
    return (
      <span data-stage-chip="none" className={`${chip} ${TONE_CLASS.none}`}>
        {empty}
      </span>
    );
  }
  return (
    <span data-stage-chip={stage.tone} title={title} className={`${chip} ${TONE_CLASS[stage.tone]}`}>
      <i aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
      <span className="truncate">{stage.label}</span>
    </span>
  );
}

/** What the requests chip says: "3 open", "1 photo", "2 video", or "none". */
export function requestsWords(r: JobRow["requests"]): string | null {
  if (!r.open) return null;
  if (r.photo === r.open && r.video === 0) return `${r.open} photo`;
  if (r.video === r.open && r.photo === 0) return `${r.open} video`;
  return `${r.open} open`;
}

export function RequestsChip({ requests }: { requests: JobRow["requests"] }) {
  const words = requestsWords(requests);
  if (!words) return <span className="text-xs text-muted">none</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span data-requests-chip className={`${chip} border border-border bg-surface text-foreground`} title="Open client requests on this shoot">
        {words}
      </span>
      {requests.needsOwner > 0 && (
        <span data-needs-owner className={`${chip} ${TONE_CLASS.waiting}`}>
          {requests.needsOwner === 1 ? "1 needs an owner" : `${requests.needsOwner} need an owner`}
        </span>
      )}
    </span>
  );
}
