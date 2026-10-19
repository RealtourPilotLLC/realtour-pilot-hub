import { ClipboardCheck, Flag, MessageSquareWarning, StickyNote } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { jobChecks, type JobChecks, type JobMedium } from "@/lib/jobChecks";
import { CheckedButton } from "./CheckedButton";

// ---------------------------------------------------------------------------
// "BEFORE YOU SEND" (Oct 19 2026, lib/jobChecks). A server component; every
// job surface renders it the same way: the photo job page, the editor brief
// (video), the Review Room cut page and the Ready to send rows (`compact`).
// Only what exists, in this order: Flagged at the shoot, Client requests (with
// ONE "Checked" for all of them), Notes. Nothing at all: nothing renders.
//
// `hideNotes`: the editor brief already prints the order note and the job's
// notes in its own spot, so there the box adds only the flags and requests.
// The Checked button shows to the people who may press it (owner, admin, a
// named review seat; never while previewing someone else); anyone else reads
// "Kyle checks these before it goes out."
// ---------------------------------------------------------------------------

const MEDIUM_WORDS: Record<string, string> = { video: "video", photo: "photos", both: "photos and video", unclear: "photos or video" };

async function mayCheck(): Promise<boolean> {
  try {
    const { authEnforced } = await import("@/lib/auth/guards");
    const { getCurrentUser } = await import("@/lib/auth/user");
    const u = await getCurrentUser();
    if (!u) return !authEnforced();
    const { canRuleOnCuts } = await import("@/lib/reviewerAssignment");
    return (await canRuleOnCuts(u)).ok;
  } catch {
    return false;
  }
}

export async function BeforeYouSend({ projectId, medium, compact, hideNotes }: { projectId: string; medium: JobMedium; compact?: boolean; hideNotes?: boolean }) {
  const { data, canCheck } = await loadBeforeYouSend(projectId, medium);
  return <BeforeYouSendView data={data} medium={medium} compact={compact} hideNotes={hideNotes} canCheck={canCheck} />;
}

/**
 * The box's read, made up front: for a page that renders its tree in one
 * synchronous pass (and the drills that render it that way), await this with
 * the page's other reads and render BeforeYouSendView with it.
 */
export async function loadBeforeYouSend(projectId: string, medium: JobMedium): Promise<{ data: JobChecks; canCheck: boolean }> {
  const [data, canCheck] = await Promise.all([jobChecks(projectId, medium), mayCheck()]);
  return { data, canCheck };
}

/** The box itself, from a read already made (drills render this directly). */
export function BeforeYouSendView({ data, medium, compact, hideNotes, canCheck }: { data: JobChecks; medium: JobMedium; compact?: boolean; hideNotes?: boolean; canCheck: boolean }) {
  const notes = hideNotes ? [] : data.notes;
  if (!data.flags.length && !data.requests.length && !notes.length) return null;
  const thing = medium === "photo" ? "the photos" : "the video";
  const head = compact ? "text-[12px] font-semibold" : "text-sm font-semibold";
  const meta = "text-xs text-muted";
  return (
    <section aria-label="Before you send" data-before-you-send={medium} className={`rounded-xl border border-border bg-surface ${compact ? "space-y-2 px-2.5 py-2 text-[13px]" : "space-y-3 px-3 py-3 text-sm"}`}>
      <p className={`flex items-center gap-1.5 ${compact ? "text-[13px]" : "text-sm"} font-semibold text-foreground`}>
        <ClipboardCheck aria-hidden className="size-4 text-brand" />
        Before you send
        <span className="font-normal text-muted">· {thing}</span>
      </p>

      {data.flags.length > 0 && (
        <div data-box-flags className="space-y-1">
          <p className={`flex items-center gap-1.5 text-warning ${head}`}>
            <Flag aria-hidden className="size-3.5" /> Flagged at the shoot
          </p>
          <ul className="space-y-1.5">
            {data.flags.map((f) => (
              <li key={f.id} data-flag-id={f.id} className="rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5">
                <p className={`text-foreground ${compact ? "line-clamp-2" : ""}`}>{f.text}</p>
                <p className={meta}>
                  {f.by ?? "The photographer"} · {etDateTime(f.atISO)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.requests.length > 0 && (
        <div data-box-requests className="space-y-1.5">
          <p className={`flex items-center gap-1.5 text-foreground ${head}`}>
            <MessageSquareWarning aria-hidden className="size-3.5 text-warning" /> Client requests
            <span className="font-normal text-muted">· {data.requests.length}</span>
          </p>
          <ul className="divide-y divide-border">
            {data.requests.map((r) => (
              <li key={r.id} data-request-id={r.id} className="space-y-0.5 py-1.5 first:pt-0">
                <p className="font-medium text-foreground">{r.summary}</p>
                <p className={meta}>
                  {r.askedBy ?? "The client"} · {etDateTime(r.askedAtISO)} · {MEDIUM_WORDS[r.medium ?? "unclear"] ?? "photos or video"}
                </p>
                {!compact && r.text.trim() && r.text.trim() !== r.summary.trim() && (
                  <details className="text-xs">
                    <summary className="cursor-pointer font-medium text-brand">The client&rsquo;s words</summary>
                    <p className="mt-1 whitespace-pre-wrap rounded-lg bg-surface-2 px-2 py-1.5 text-[13px] text-foreground/85">{r.text}</p>
                  </details>
                )}
              </li>
            ))}
          </ul>
          {canCheck ? (
            <div className="space-y-1">
              <p className={meta}>Check {data.requests.length === 1 ? "this" : "these"} on {thing}, then press Checked once.</p>
              <CheckedButton projectId={data.projectId} medium={medium} count={data.requests.length} compact={compact} />
            </div>
          ) : (
            <p className={meta}>Kyle checks {data.requests.length === 1 ? "this" : "these"} before {thing} go{medium === "video" ? "es" : ""} out.</p>
          )}
        </div>
      )}
      {!data.requests.length && data.checked && (
        <p className={meta} data-box-checked>
          Client requests checked by {data.checked.by}, {etDateTime(data.checked.atISO)}.
        </p>
      )}

      {notes.length > 0 && (
        <div data-box-notes className="space-y-1">
          <p className={`flex items-center gap-1.5 text-foreground ${head}`}>
            <StickyNote aria-hidden className="size-3.5 text-muted" /> Notes
          </p>
          <dl className="space-y-1">
            {notes.map((n, i) => (
              <div key={`${n.label}-${i}`} className="flex flex-wrap gap-x-1.5">
                <dt className="font-medium text-muted">{n.label}:</dt>
                <dd className={`min-w-0 text-foreground/90 ${compact ? "line-clamp-1" : ""}`} title={compact ? n.text : undefined}>
                  {n.text}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}
