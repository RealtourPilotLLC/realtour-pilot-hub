import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { PlayCircle, type LucideIcon } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { RemindButton } from "@/components/videoDelivery/SendVideo";
import type { QueueSubmission } from "@/lib/reviewRoom";
import type { VideoRow } from "@/lib/videoDelivery";
import type { RemindState } from "@/lib/remindEditor";
import { verdictLine } from "@/lib/reviewAttribution";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// The Video Review Room's rows (Oct 19 2026), shared by the room (/review) and
// its history page (/review/history), so a cut reads the same on both.
// Server components only: the one button here (Remind) is its own client
// component.
// ---------------------------------------------------------------------------

export const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });
export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
export const linkCls = "inline-flex min-h-11 items-center gap-1 underline underline-offset-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";

/** A secondary panel folded to its title line (Oct 5). */
export function Fold({ icon: Icon, title, count, children }: { icon: LucideIcon; title: string; count?: number | null; children: React.ReactNode }) {
  return (
    <details className="panel-shadow rounded-2xl border bg-surface px-5 py-1">
      <summary className="flex min-h-12 cursor-pointer items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-muted">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="text-base font-semibold">{title}</span>
        {count != null && <span className="rounded-full bg-surface-2 px-2 text-ui-status font-medium text-muted">{count}</span>}
      </summary>
      <div className="border-t border-border py-4">{children}</div>
    </details>
  );
}

// §8.1: who the cut waits on, from the row itself, never from a notice.
function ReviewerChip({ s, viewerTeamMemberId }: { s: QueueSubmission; viewerTeamMemberId: string | null }) {
  if (s.status !== "PENDING" || s.heldForCheck) return null;
  if (!s.reviewer) {
    return <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">Nobody holds it: the office</span>;
  }
  if (viewerTeamMemberId && s.reviewer.id === viewerTeamMemberId) {
    return <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">Waiting on you</span>;
  }
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">With {firstName(s.reviewer.name)}</span>;
}

/** When the video is due to the client, from the room's delivery board (listing videos only). */
export type CutDue = { words: string; late: boolean } | null;

/**
 * One cut. On the queue (To review): the street, which video and version,
 * who it waits on, the editor, how long it has waited and when it is due to
 * the client (late in red). Decided (history): who ruled and when.
 */
export function CutRow({ s, decided, viewerTeamMemberId = null, video = null, due = null, children }: { s: QueueSubmission; decided?: boolean; viewerTeamMemberId?: string | null; video?: string | null; due?: CutDue; children?: React.ReactNode }) {
  return (
    <li>
      <CutCard s={s} decided={decided} viewerTeamMemberId={viewerTeamMemberId} video={video} due={due} />
      {children}
    </li>
  );
}

export function CutCard({ s, decided, viewerTeamMemberId = null, video = null, due = null }: { s: QueueSubmission; decided?: boolean; viewerTeamMemberId?: string | null; video?: string | null; due?: CutDue }) {
  const what = video ?? (decided ? null : s.fileName);
  const editor = s.editorName ?? s.submittedByName;
  return (
    <Link
      // ?cut= opens THIS submission: a monthly package's videos each get
      // their own row here and are reviewed one by one.
      href={`/review/${s.projectId}?cut=${s.id}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface p-3.5 hover:border-brand/40"
    >
      <PlayCircle aria-hidden className="size-5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-semibold">{s.street}</span>
          <span className="min-w-0 text-sm text-muted">
            {what ? `${what}, ` : ""}version {s.round}
          </span>
          {s.premium && (
            <span className="rounded-md bg-violet-400/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-400 light:text-violet-600">
              Premium
            </span>
          )}
          {!s.hasAsset && <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">No file found</span>}
          <ReviewerChip s={s} viewerTeamMemberId={viewerTeamMemberId} />
          {s.openEditorNotes > 0 && (
            <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
              {s.openEditorNotes} open note{s.openEditorNotes === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
          {decided && s.clientName && <Avatar name={s.clientName} src={s.clientAvatarUrl} size={18} />}
          {decided ? (
            // WHO RULED, AND WHEN (Sep 28): "Sent back by James Rivera · Mon,
            // Sep 28, 2:14 PM", or the client's own send-back on an approved cut.
            <span className="min-w-0 truncate">
              {s.clientName ? `${s.clientName} · ` : ""}
              {s.decidedAt ? (verdictLine(s.verdict) ?? `decided ${ago(s.decidedAt)}`) : `submitted ${ago(s.createdAt)}`}
            </span>
          ) : (
            <>
              <span>{editor ? `from ${editor} · ` : ""}waiting {formatDistanceToNow(new Date(s.createdAt))}</span>
              {due && <span className={cn(due.late ? "font-semibold text-danger" : "text-muted")}>· {due.words}</span>}
            </>
          )}
          {s.fileName && what !== s.fileName && <span className="min-w-0 max-w-56 truncate text-muted-2" title={s.fileName}>· {s.fileName}</span>}
        </div>
      </div>
    </Link>
  );
}

/** A delivery row's head line: street (to the job), client, which video, Late. */
export function RowHead({ r }: { r: Pick<VideoRow, "projectId" | "street" | "clientName" | "label" | "round" | "late" | "lane"> }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <Link href={`/projects/${r.projectId}`} className="font-semibold hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{r.street}</Link>
      <span className="text-muted">· {r.clientName}</span>
      <span className="min-w-0 font-medium">· {r.label}{r.round ? `, version ${r.round}` : ""}</span>
      {r.late && r.lane !== "delivered" && <span className="rounded bg-danger/10 px-1.5 py-0.5 text-ui-status font-bold text-danger">Late</span>}
    </div>
  );
}

export function agoText(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

/** Who holds a waiting video, when it was last reminded, and the Remind button (at most once every 4 hours, lib/remindEditor). */
export function Holder({ st, rowKey, projectId, submissionId, viewerName, showButton, now }: { st: RemindState | undefined; rowKey: string; projectId: string; submissionId: string | null; viewerName: string | null; showButton: boolean; now: Date }) {
  if (!st) return null;
  const t = st.target;
  const who = t.kind === "editor" ? `With ${t.name}.` : t.kind === "reviewer" ? `Waiting on ${t.name}'s review.` : t.waitsOn;
  const last = st.last ? `Reminded ${agoText(st.last.at, now)} by ${viewerName && st.last.by === viewerName ? "you" : firstName(st.last.by)}.` : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-muted">{who}{last ? ` ${last}` : ""}</span>
      {showButton && t.kind !== "none" && st.canRemind && (
        <RemindButton rowKey={rowKey} projectId={projectId} submissionId={submissionId} label={t.kind === "reviewer" ? "Remind reviewer" : "Remind editor"} name={t.name} />
      )}
    </div>
  );
}
