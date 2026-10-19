import { requirePageAccess } from "@/lib/auth/guards";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle, CalendarClock, Camera, CheckCircle2, Clapperboard, Download, ExternalLink, Eye, Flag, Hourglass, MessageSquare, Pencil, PlayCircle, Send, Sun,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { Avatar } from "@/components/ui/Avatar";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor } from "@/lib/auth/access";
import { followUpHref, getReviewQueue, type QueueSubmission } from "@/lib/reviewRoom";
import { getFixPatterns, getQcStats } from "@/lib/qc";
import { revisionQuality } from "@/lib/revisionQuality";
import { RevisionQualitySummary } from "@/components/review/RevisionQualitySummary";
import { VerdictReceipts } from "@/components/review/VerdictReceipts";
import { verdictLine } from "@/lib/reviewAttribution";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { dueTodayRows, type ProgramRow, type VideoDeliveryBoard, type VideoRow } from "@/lib/videoDelivery";
import type { RemindState } from "@/lib/remindEditor";
import { BeforeYouSend } from "@/components/jobs/BeforeYouSend";
import { MarkSent } from "@/components/ops/MarkSent";
import { MarkDelivered } from "@/components/ops/MarkDelivered";
import { HeldRender } from "@/components/ops/HeldRender";
import { DeliveryFollowUps } from "@/components/ops/ReadyToSendCard";
import { PushControls } from "@/components/videoDelivery/PushControls";
import { AutoRefresh, RemindButton, SendAll, SendVideo } from "@/components/videoDelivery/SendVideo";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Video Review Room" };
// A verdict pressed here answers at once and finishes its follow-ons (the
// Dropbox copy waits on Dropbox for up to 15 s, the client-library rebuild) in
// after(), inside this route's function budget (Oct 5) — the same 60 s ceiling
// /edit/<id> uses. Anything a cut-short run leaves undone, the hourly sweeps
// named in review/actions.ts finish.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// THE VIDEO REVIEW ROOM (Jordan, Oct 19 2026: "For the video delivery screen,
// I want a 'ready to send' at the top with a button that says 'upload to aryeo
// and send' ... Then the late section ... 'Remind editor' ... Then Due today
// ... 'in revision', and then coming up. I think all of this could be in the
// review room, maybe change review room name to video review room").
// Top to bottom, counts in every heading:
//   · Ready to send   approved listing videos whose file is ready: Upload to
//                     Aryeo and send (the ONLY way the hub uploads a video),
//                     Send all, the job's open requests and shoot flags
//                     (BeforeYouSend), and the hand path folded under each row
//   · To review       the cuts editors submitted (unchanged)
//   · Late            listing videos past their promise, not approved yet,
//                     with who holds each and Remind editor / Remind reviewer
//   · Due today       due by tonight, the late ones included and marked
//   · In revision     sent back to the editor: how long ago, who has it
//   · Coming up       everything else still owed
//   · Monthly content only the late program videos (they publish to the
//                     client's portal by themselves)
// then the folded history (follow-through, approved, sent, causes). The photo
// media checks moved to Photo Delivery (/ops/photo-delivery): this room is
// video only. /ops/video-delivery redirects here. The delivery sections are
// the office's (owner/admin); a seated reviewer on another login sees the
// review sections only. Creatives get their feedback on their own surfaces
// (/shoot for photographers, /edit for editors).
// ---------------------------------------------------------------------------

const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

// Secondary panels, folded to their title line (Oct 5): the desk opens on the
// cuts to rule on; history and scoreboards are one tap away.
function Fold({ icon: Icon, title, count, children }: { icon: LucideIcon; title: string; count?: number | null; children: React.ReactNode }) {
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

// §8.1: who the cut waits on, from the row itself — never from a notice.
function ReviewerChip({ s, viewerTeamMemberId }: { s: QueueSubmission; viewerTeamMemberId: string | null }) {
  if (s.status !== "PENDING" || s.heldForCheck) return null;
  if (!s.reviewer) {
    return <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">Nobody holds it — the office</span>;
  }
  if (viewerTeamMemberId && s.reviewer.id === viewerTeamMemberId) {
    return <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand">Waiting on you</span>;
  }
  return <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">With {s.reviewer.name.split(/\s+/)[0]}</span>;
}

function CutRow({ s, decided, viewerTeamMemberId = null }: { s: QueueSubmission; decided?: boolean; viewerTeamMemberId?: string | null }) {
  return (
    <li>
      <CutCard s={s} decided={decided} viewerTeamMemberId={viewerTeamMemberId} />
    </li>
  );
}

function CutCard({ s, decided, viewerTeamMemberId = null }: { s: QueueSubmission; decided?: boolean; viewerTeamMemberId?: string | null }) {
  return (
      <Link
        // ?cut= opens THIS submission — a monthly package's videos each get
        // their own row here and are reviewed one by one.
        href={`/review/${s.projectId}?cut=${s.id}`}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border bg-surface p-3.5 hover:border-brand/40"
      >
        <PlayCircle className="size-5 shrink-0 text-brand" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-semibold">{s.street}</span>
            {s.fileName && (
              <span className="max-w-48 truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">{s.fileName}</span>
            )}
            {s.premium && (
              <span className="rounded-md px-1.5 py-0.5 text-[11px] font-medium" style={{ backgroundColor: "#a78bfa1a", color: "#a78bfa" }}>
                Premium
              </span>
            )}
            {s.round > 1 && (
              <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-muted">Round {s.round}</span>
            )}
            {!s.hasAsset && (
              <span className="rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">No file found</span>
            )}
            <ReviewerChip s={s} viewerTeamMemberId={viewerTeamMemberId} />
            {s.openEditorNotes > 0 && (
              <span className="rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-medium text-brand">
                {s.openEditorNotes} open note{s.openEditorNotes === 1 ? "" : "s"}
              </span>
            )}
          </div>
          {/* The agent's headshot beside their name (Jordan, Sep 2: show the
              Aryeo profile photo "in other places the clients are mentioned").
              18px sits inside the text-xs line, so the row doesn't grow. */}
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
            {s.clientName && <Avatar name={s.clientName} src={s.clientAvatarUrl} size={18} />}
            <span className="truncate">
              {s.clientName}
              {s.submittedByName ? ` · from ${s.submittedByName}` : ""}
              {" · "}
              {/* WHO RULED, AND WHEN (Sep 28): "Sent back by James Rivera · Mon,
                  Sep 28, 2:14 PM", or the client's own send-back on an approved
                  cut — the row used to say only "decided 2 hours ago". */}
              {decided && s.decidedAt
                ? verdictLine(s.verdict) ?? `decided ${ago(s.decidedAt)}`
                : `submitted ${ago(s.createdAt)}`}
            </span>
          </div>
          {s.note && <div className="mt-1 truncate text-xs italic text-muted-2">“{s.note}”</div>}
        </div>
      </Link>
  );
}

// ---- the delivery sections (Oct 19 2026) ----------------------------------------------------

const linkCls = "inline-flex min-h-11 items-center gap-1 underline underline-offset-2 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const quietBtn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const PUSH_TONE: Record<string, string> = {
  progress: "text-foreground",
  waiting: "text-foreground",
  held: "font-medium text-warning",
  failed: "font-medium text-danger",
  done: "text-success",
  info: "text-muted",
};

function RowHead({ r }: { r: VideoRow }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <Link href={`/projects/${r.projectId}`} className="font-semibold hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{r.street}</Link>
      <span className="text-muted">· {r.clientName}</span>
      <span className="min-w-0 font-medium">· {r.label}{r.round ? `, version ${r.round}` : ""}</span>
      {r.late && r.lane !== "delivered" && <span className="rounded bg-danger/10 px-1.5 py-0.5 text-ui-status font-bold text-danger">Late</span>}
    </div>
  );
}

/** The three steps of a press: Uploading, On the listing, Sent. */
function Steps({ progress, stopped }: { progress: "uploading" | "on-listing" | "sent" | null; stopped: boolean }) {
  const order = ["uploading", "on-listing", "sent"] as const;
  const words = { uploading: "Uploading", "on-listing": "On the listing", sent: "Sent" };
  const at = progress ? order.indexOf(progress) : -1;
  return (
    <ol className="mt-1.5 flex flex-wrap items-center gap-1.5 text-ui-status" aria-label="Where the upload is">
      {order.map((k, i) => (
        <li key={k} aria-current={i === at ? "step" : undefined} className={cn(
          "rounded-full border px-2 py-0.5 font-medium",
          i < at || (i === at && k === "sent") ? "border-success/40 bg-success/10 text-success"
            : i === at ? (stopped ? "border-warning/40 bg-warning/10 text-warning" : "border-brand/40 bg-brand/10 text-brand")
            : "border-border text-muted",
        )}>
          {words[k]}
        </li>
      ))}
    </ol>
  );
}

function ReadyRow({ r, checks }: { r: VideoRow; checks: React.ReactNode }) {
  const s = r.send!;
  const p = r.push;
  const run = !!p?.state;
  const stopped = p?.tone === "failed" || p?.tone === "held";
  const canPress = !s.byHandWhy && (p ? p.canStart : false);
  const label = p?.canRetry ? "Try again" : s.uploaded ? "Send" : "Upload to Aryeo and send";
  return (
    <li className="min-w-0 px-5 py-3">
      <RowHead r={r} />
      <p className="mt-0.5 text-sm text-muted">
        Approved {r.approvedAtISO ? `${etDateTime(r.approvedAtISO)} ET` : ""}{s.approvedBy ? ` by ${s.approvedBy}` : ""}
        {" · "}<span className={cn(r.late && "font-semibold text-danger")}>{r.promiseWords}</span>
      </p>
      {checks}
      {run && <Steps progress={p!.progress} stopped={stopped} />}
      {p && (run || s.uploaded) && <p className={cn("mt-1 text-sm", PUSH_TONE[p.tone])}>{p.says}</p>}
      {s.byHandWhy && <p className="mt-1 text-sm font-medium text-warning">{s.byHandWhy}</p>}
      {!s.byHandWhy && s.asksUnknown && <p className="mt-1 text-sm font-medium text-warning">The client&rsquo;s requests could not be read just now. Reload before sending.</p>}
      {canPress && <SendVideo submissionId={r.submissionId!} street={r.street} label={label} openAsks={s.openAsks} asksUnknown={s.asksUnknown} listingWarning={s.listingWarning} />}
      {p && (p.canDeliverNow || p.canRelease) && <PushControls submissionId={r.submissionId!} street={r.street} canRetry={false} canDeliverNow={p.canDeliverNow} canHold={false} canRelease={p.canRelease} />}
      <details className="mt-2 rounded-lg border border-border bg-surface-2/40" open={!!s.byHandWhy || (!!p?.canRetry && !p.canStart)}>
        <summary className="min-h-11 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Done it by hand?</summary>
        <div className="space-y-2 px-3 pb-3 text-sm">
          <p className="text-muted">{s.fileSays} <span className="break-all font-mono text-ui-status">{s.fileName}</span></p>
          <div className="flex flex-wrap items-center gap-2">
            <a href={s.downloadHref} className={quietBtn}><Download aria-hidden className="size-3.5" /> Download the file</a>
            {r.aryeoUrl && <a href={r.aryeoUrl} target="_blank" rel="noreferrer" className={quietBtn}><ExternalLink aria-hidden className="size-3.5" /> Aryeo listing</a>}
            {r.reviewHref && <Link href={r.reviewHref} prefetch={false} className={quietBtn}><Eye aria-hidden className="size-3.5" /> Watch it</Link>}
          </div>
          {s.uploaded
            ? <><p className="text-muted">Uploaded by {s.uploaded.by} · {etDateTime(s.uploaded.at)} ET. After you send the listing in Aryeo:</p><MarkSent submissionId={r.submissionId!} street={r.street} expectedFingerprint={s.uploadFingerprint ?? undefined} /></>
            : s.uploadFingerprint && !s.listingMissing
              ? <><p className="text-muted">Uploaded it and sent the listing in Aryeo yourself? Record it:</p><MarkDelivered submissionId={r.submissionId!} fingerprint={s.uploadFingerprint} /></>
              : null}
        </div>
      </details>
    </li>
  );
}

function HeldRow({ r }: { r: VideoRow }) {
  const p = r.push;
  return (
    <li className="min-w-0 px-5 py-3">
      <RowHead r={r} />
      <p className="mt-0.5 text-sm text-muted"><span className="font-medium text-foreground">{r.stage}</span> · <span className={cn(r.late && "font-semibold text-danger")}>{r.promiseWords}</span></p>
      {r.heldWhy && <p className="mt-1 text-sm font-medium text-warning">{r.heldWhy}</p>}
      {r.heldRender && <HeldRender jobId={r.heldRender.jobId} street={r.street} fileName={r.heldRender.fileName} dropboxUrl={r.heldRender.dropboxUrl} lastCheck={r.heldRender.lastCheck} />}
      {p && p.canStart && r.send && !r.send.byHandWhy && <SendVideo submissionId={r.submissionId!} street={r.street} label="Try again" openAsks={r.send.openAsks} asksUnknown={r.send.asksUnknown} listingWarning={null} />}
      {p && (p.canDeliverNow || p.canRelease) && <PushControls submissionId={r.submissionId!} street={r.street} canRetry={false} canDeliverNow={p.canDeliverNow} canHold={false} canRelease={p.canRelease} />}
    </li>
  );
}

/** Who holds a waiting video, when it was last reminded, and the Remind button. */
function Holder({ st, rowKey, projectId, submissionId, viewerName, showButton, now }: { st: RemindState | undefined; rowKey: string; projectId: string; submissionId: string | null; viewerName: string | null; showButton: boolean; now: Date }) {
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

function agoText(iso: string, now: Date): string {
  const m = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000));
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

function WaitingRow({ r, children }: { r: VideoRow; children?: React.ReactNode }) {
  return (
    <li className="min-w-0 px-5 py-3">
      <RowHead r={r} />
      <p className="mt-0.5 text-sm text-muted">
        <span className="font-medium text-foreground">{r.stage}</span>
        {" · "}
        <span className={cn(r.late && "font-semibold text-danger")}>{r.promiseWords}</span>
      </p>
      <div className="flex flex-wrap items-center gap-x-3 text-sm">
        {r.reviewHref && <Link href={r.reviewHref} prefetch={false} className={linkCls}><Clapperboard aria-hidden className="size-3.5" /> Open the cut</Link>}
        {r.stage !== "Not shot yet" && <Link href={`/edit/${r.projectId}`} prefetch={false} className={linkCls}><Pencil aria-hidden className="size-3.5" /> Edit page</Link>}
      </div>
      {children}
    </li>
  );
}

function ProgramList({ rows }: { rows: ProgramRow[] }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((r) => (
        <li key={r.outputId} className="min-w-0 px-5 py-3 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <Link href={`/projects/${r.projectId}`} className="font-semibold hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{r.clientName}</Link>
            <span className="text-muted">· {r.monthWords}</span>
            <span className="min-w-0 font-medium">· {r.title}</span>
          </div>
          <p className="mt-0.5 text-muted">
            <span className="font-medium text-foreground">{r.stage}</span> · <span className="font-semibold text-danger">{r.promiseWords}</span>
          </p>
          {r.why && <p className="mt-0.5 text-muted">{r.why}</p>}
        </li>
      ))}
    </ul>
  );
}

const COMING_UP_SHOWN = 15;

export default async function ReviewRoomPage({ searchParams }: { searchParams: Promise<{ test?: string }> }) {
  await requirePageAccess("review");
  const includeTest = (await searchParams).test === "1";
  const me = await getCurrentUser().catch(() => null);
  // THE SAME QUESTION THE ACTIONS ASK (§8.1, review fix Sep 25): owner/admin,
  // or a login seated as one of the three reviewers. It used to be the
  // OWNER/ADMIN role alone, so a seated reviewer on a narrower login was rung
  // for cuts and allowed to rule on them by the server, with no desk to do it
  // from. View-as is still refused (canRuleOnCuts says no to a preview).
  const { isReviewDesk } = await import("@/lib/reviewerAssignment");
  const ownerDesk = await isReviewDesk(me, { authEnforced: authEnforced() });
  // A PHOTOGRAPHER gets the Room narrowed to their own shoots rather than the
  // door (Jordan, Sep 18). Sending them to /shoot — the Sep 17 answer — meant
  // the only way into a cut was a tag, so a video from their own shoot that
  // nobody thought to tag them on was unreachable. Everything below this line
  // is the office's desk: every client's cut, Kyle's photo QC, the follow-up
  // rollup and the scoreboards. None of it is theirs, and none of it loads.
  if (!ownerDesk && me?.role === "PHOTOGRAPHER") {
    // THE SAME RULE AS THE PAGE THIS INDEX LINKS TO (review, Sep 18). This read
    // the roster with photographerMemberId, which falls back to an email match
    // when the login carries no teamMemberId; /review/<id> and askCutChange
    // both require AppUser.teamMemberId itself. An unlinked login therefore got
    // an index of cuts where every row redirected it straight back out, and a
    // composer that refused it. One rule, and it is the narrower one, because
    // it is the one the writes are guarded by. (Live today: the one
    // photographer login is linked, so nobody's list changes.)
    const mid = me.teamMemberId;
    // No roster link = no way to say which shoots are theirs. Fail closed to
    // their own home rather than to somebody else's cuts.
    if (!mid) redirect(homeFor(me.role));
    const { PhotographerRoom } = await import("@/components/review/PhotographerRoom");
    return <PhotographerRoom memberId={mid} firstName={(me.name ?? "there").split(" ")[0]} />;
  }
  if (!ownerDesk) redirect(homeFor(me?.role));

  // THE DELIVERY SECTIONS are the office's (owner/admin); a seated reviewer
  // on another login gets the review sections only. View-as shows what that
  // login would see; its buttons are refused by the actions (requireAdmin).
  const deliveryDesk = !me || me.role === "OWNER" || me.role === "ADMIN";
  const now = new Date();
  const [q, patterns, qcStats, causes, board] = await Promise.all([
    getReviewQueue({ includeTest }),
    getFixPatterns(60, { includeTest }),
    getQcStats(30, { includeTest }),
    revisionQuality(30, { includeTest }).catch(() => null),
    deliveryDesk
      ? import("@/lib/videoDelivery").then((m) => m.videoDeliveryBoard({ fresh: true, followUps: true })).catch((e) => {
          console.error("[video-review] delivery board failed", e);
          return null;
        })
      : Promise.resolve(null as VideoDeliveryBoard | null),
  ]);
  // "Waiting on YOUR verdict" counts only the cuts that are yours (§8.1) —
  // Kyle's Room must not tell him James's cuts are his to rule on.
  // A cut nobody holds (no chain configured, or everyone away) is the
  // office's, so it counts as waiting on an owner/admin viewer.
  const viewerTeamMemberId = me && !me.impersonating ? me.teamMemberId : null;
  const viewerName = me ? (me.impersonating ? null : me.realName || me.name || null) : null;
  const officeViewer = !!me && !me.impersonating && (me.realRole === "OWNER" || me.realRole === "ADMIN");
  const mine = viewerTeamMemberId || officeViewer
    ? q.pending.filter((s) => (s.reviewer ? s.reviewer.id === viewerTeamMemberId : officeViewer)).length
    : 0;
  const withOthers = q.pending.length - mine;
  const laneMeta = {
    EDIT: { label: "Delivery fixes", icon: Pencil },
    PHOTOGRAPHER: { label: "Photographer: capture", icon: Camera },
    EDITOR: { label: "Editor: cut", icon: Clapperboard },
  } as const;

  // ---- the delivery sections' data ----
  const ready = board?.lanes.sending ?? [];
  const held = board?.lanes.held ?? [];
  const finishing = board?.lanes.finishing ?? [];
  const late = board?.lanes.late ?? [];
  const due = board ? dueTodayRows(board) : [];
  const comingUp = (board?.lanes.upcoming ?? []).filter((r) => r.cutStatus !== "CHANGES_REQUESTED");
  const programLate = board?.program.late ?? [];
  const revisions = [...q.waitingOnEditor].sort((a, b) => (a.decidedAt ?? a.createdAt).localeCompare(b.decidedAt ?? b.createdAt));
  const rowByKey = new Map((board ? Object.values(board.lanes).flat() : []).map((r) => [r.key, r]));
  // The job's open requests and shoot flags, once per job (the job box's own component).
  const checksFor = new Map<string, React.ReactNode>();
  for (const pid of [...new Set([...ready, ...held].map((r) => r.projectId))]) {
    try {
      checksFor.set(pid, await BeforeYouSend({ projectId: pid, medium: "video", compact: true }));
    } catch (e) {
      console.warn("[video-review] job checks unavailable", e);
    }
  }
  // Who holds each late or sent-back video, and when it was last reminded.
  const remindItems = deliveryDesk
    ? [
        ...late.map((r) => ({ key: r.key, projectId: r.projectId, submissionId: r.submissionId, street: r.street, promiseISO: r.promiseISO, late: r.late, dueToday: r.dueToday })),
        ...revisions.map((s) => {
          const r = rowByKey.get(s.id);
          return { key: s.id, projectId: s.projectId, submissionId: s.id, street: s.street, promiseISO: r?.promiseISO ?? null, late: r?.late ?? false, dueToday: r?.dueToday ?? false, revisionSinceISO: s.decidedAt };
        }),
      ]
    : [];
  const reminds: Map<string, RemindState> = remindItems.length
    ? await import("@/lib/remindEditor").then((m) => m.remindStatesFor([...new Map(remindItems.map((x) => [x.key, x])).values()], { now, viewerTeamMemberId })).catch((e) => {
        console.warn("[video-review] remind states unavailable", e);
        return new Map<string, RemindState>();
      })
    : new Map<string, RemindState>();
  const sendAllIds = ready.filter((r) => r.send && !r.send.byHandWhy && !r.send.openAsks.length && !r.send.asksUnknown && !r.send.listingWarning && r.push?.canStart && !r.push.state).map((r) => r.submissionId!);
  const moving = [...ready, ...held].some((r) => !!r.push?.state && r.push.handledByHub && !r.push.waitingForKyle && r.push.tone === "progress");
  const DAY = 24 * 3_600_000;
  const fu = board?.followUps ?? null;
  const followUpCount = fu ? (fu.needsFinishing?.length ?? 0) + fu.notTold.length + fu.noticeIncidents.length + fu.portal.length : 0;
  const followUpUnchecked = !!fu && (!!fu.boardUnavailable || fu.followUpChecks?.needsFinishing === null || fu.followUpChecks?.notTold === null || fu.noticeIncidentCheck === null);
  const cutsLine = !viewerTeamMemberId && !officeViewer && q.pending.length
    ? `${q.pending.length} cut${q.pending.length === 1 ? "" : "s"} waiting on a verdict`
    : mine
      ? `${mine} cut${mine === 1 ? "" : "s"} waiting on you${withOthers ? ` · ${withOthers} with someone else` : ""}`
      : withOthers
        ? `No cuts awaiting your verdict · ${withOthers} cut${withOthers === 1 ? "" : "s"} with someone else`
        : "No cuts awaiting your verdict · check revisions and delivery below";
  // The same three numbers as Home's summary (videoSummary): late counts every listing video past its promise, the approved ones too.
  const lateApproved = board ? [...ready, ...held, ...finishing].filter((r) => r.late) : [];
  const deliveryLine = board ? `${ready.length} ready to send · ${board.counts.lateListing} late · ${due.length} due today · ` : "";

  return (
    <div>
      <PageHeader eyebrow="Video" title="Video Review Room" subtitle={`${deliveryLine}${cutsLine}`} />

      <div className="space-y-6 p-4 sm:p-6">
        {moving && <AutoRefresh active />}
        <div className="flex justify-end">
          <Link href={includeTest ? "/review" : "/review?test=1"} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            {includeTest ? "Hide test records" : "Show test records"}
          </Link>
        </div>

        {deliveryDesk && !board && (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">Ready to send, Late and Due today could not be read just now. Refresh to try again.</p>
        )}

        {/* ————— (a) READY TO SEND ————— */}
        {board && (
          <Section icon={Send} title="Ready to send" count={ready.length} flush action={sendAllIds.length >= 2 ? <SendAll submissionIds={sendAllIds} /> : undefined}>
            {ready.length ? (
              <ul className="divide-y divide-border">{ready.map((r) => <ReadyRow key={r.key} r={r} checks={checksFor.get(r.projectId) ?? null} />)}</ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">No approved listing video is waiting to go out.</p>
            )}
            {held.length > 0 && (
              <>
                <h3 className="border-t border-border px-5 pt-3 text-sm font-semibold text-warning">Held ({held.length})</h3>
                <ul className="divide-y divide-border">{held.map((r) => <HeldRow key={r.key} r={r} />)}</ul>
              </>
            )}
            {finishing.length > 0 && (
              <p className="border-t border-border px-5 py-3 text-sm text-muted">
                <span className="font-medium text-foreground">Finishing the 1080p pass ({finishing.length}):</span>{" "}
                {finishing.map((r) => `${r.street}${r.late ? " (late)" : ""}`).join(", ")}. They show up above when the file is back.
              </p>
            )}
          </Section>
        )}

        {/* NEEDS A FOLLOW-UP (Oct 19 2026): the delivery card's follow-up lanes,
            here since Home stopped showing the card. Only when non-empty. */}
        {board?.followUps && (followUpCount > 0 || followUpUnchecked) && (
          <Section icon={MessageSquare} title="Needs a follow-up" count={followUpCount} tone="warning">
            <DeliveryFollowUps board={board.followUps} includeTest={includeTest} />
          </Section>
        )}

        {/* ————— (b) TO REVIEW ————— */}
        <Section icon={PlayCircle} title="To review" count={q.pending.length}>
          {q.pending.length === 0 ? (
            <p className="text-sm text-muted">
              No cuts waiting. When an editor uploads a version on the edit page and finishes the send-for-review
              check, it shows up here with a player and timestamped notes.
            </p>
          ) : (
            <ul className="space-y-2.5">{q.pending.map((s) => <CutRow key={s.id} s={s} viewerTeamMemberId={viewerTeamMemberId} />)}</ul>
          )}
        </Section>

        {/* §8.2: handed in, held for the editor's own send-for-review check —
            the found-in-the-folder cut, the upload that wasn't the file
            checked, the moved cut. Nothing here can be ruled on yet. */}
        {q.waitingOnCheck.length > 0 && (
          <Section icon={Hourglass} title="Waiting on the editor's check" count={q.waitingOnCheck.length}>
            <p className="mb-3 text-xs text-muted">
              These are in, but the editor hasn&rsquo;t finished the send-for-review check on them. They reach the list
              above once they do. They can finish it on the job&rsquo;s edit page (or the office can, for them).
            </p>
            <ul className="space-y-2.5">{q.waitingOnCheck.map((s) => <CutRow key={s.id} s={s} />)}</ul>
          </Section>
        )}

        {/* ————— (c) LATE ————— */}
        {board && (
          <Section icon={AlertTriangle} title="Late" count={late.length} tone={late.length ? "warning" : "default"} flush>
            {late.length ? (
              <ul className="divide-y divide-border">
                {late.map((r) => (
                  <WaitingRow key={r.key} r={r}>
                    <Holder st={reminds.get(r.key)} rowKey={r.key} projectId={r.projectId} submissionId={r.submissionId} viewerName={viewerName} showButton now={now} />
                  </WaitingRow>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">{lateApproved.length ? "Nothing late waiting on an editor or a review." : "Nothing late."}</p>
            )}
            {lateApproved.length > 0 && (
              <p className="border-t border-border px-5 py-3 text-sm text-muted">
                Also late, already approved: {lateApproved.map((r) => r.street).join(", ")}. {lateApproved.length === 1 ? "It is" : "They are"} under Ready to send.
              </p>
            )}
          </Section>
        )}

        {/* ————— (d) DUE TODAY (the late ones too) ————— */}
        {board && (
          <Section icon={Sun} title="Due today" count={due.length} flush>
            {due.length ? (
              <>
                <p className="px-5 pt-3 text-sm text-muted">Everything due by tonight, the late ones first.</p>
                <ul className="divide-y divide-border">{due.map((r) => <WaitingRow key={r.key} r={r} />)}</ul>
              </>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">Nothing else due today.</p>
            )}
          </Section>
        )}

        {/* ————— (e) IN REVISION ————— */}
        <Section icon={Hourglass} title="In revision" count={revisions.length}>
          {revisions.length ? (
            <ul className="space-y-2.5">
              {revisions.map((s) => (
                <li key={s.id}>
                  <CutCard s={s} decided />
                  {deliveryDesk && (
                    <div className="px-1">
                      <Holder st={reminds.get(s.id)} rowKey={s.id} projectId={s.projectId} submissionId={s.id} viewerName={viewerName} showButton={!!s.decidedAt && now.getTime() - Date.parse(s.decidedAt) > DAY} now={now} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Nothing is back with an editor.</p>
          )}
        </Section>

        {/* ————— (f) COMING UP ————— */}
        {board && (
          <Section icon={CalendarClock} title="Coming up" count={comingUp.length} flush>
            {comingUp.length ? (
              <>
                <ul className="divide-y divide-border">{comingUp.slice(0, COMING_UP_SHOWN).map((r) => <WaitingRow key={r.key} r={r} />)}</ul>
                {comingUp.length > COMING_UP_SHOWN && (
                  <details className="border-t border-border">
                    <summary className="min-h-11 cursor-pointer px-5 py-3 text-sm font-medium">Show {comingUp.length - COMING_UP_SHOWN} more</summary>
                    <ul className="divide-y divide-border">{comingUp.slice(COMING_UP_SHOWN).map((r) => <WaitingRow key={r.key} r={r} />)}</ul>
                  </details>
                )}
              </>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">Nothing else owed.</p>
            )}
          </Section>
        )}

        {/* ————— (g) MONTHLY CONTENT (late only) ————— */}
        {board && (
          <Section icon={Clapperboard} title="Monthly content" count={programLate.length} flush>
            {board.program.unavailable ? (
              <p role="alert" className="px-5 py-4 text-sm text-warning">The monthly videos could not be read just now.</p>
            ) : programLate.length ? (
              <>
                <p className="px-5 pt-3 text-sm text-muted">Late monthly videos. These publish to the client&rsquo;s portal by themselves once approved.</p>
                <ProgramList rows={programLate} />
              </>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">No monthly video is late. They publish to the client&rsquo;s portal by themselves once approved.</p>
            )}
          </Section>
        )}

        {q.followUps.length > 0 && (
          <Fold icon={MessageSquare} title="Feedback follow-through" count={q.followUps.length}>
            <p className="mb-3 text-xs text-muted">
              Review notes still moving: <span className="font-medium text-foreground/80">open</span> = someone owes a
              fix · <span className="font-medium text-foreground/80">fixed</span> = they say it&rsquo;s done, you owe a
              re-look.
            </p>
            <ul className="divide-y divide-border">
              {q.followUps.map((f) => {
                const m = laneMeta[f.lane];
                return (
                  <li key={`${f.projectId}-${f.lane}`}>
                    <Link
                      // The cut with its notes (Sep 28) — the project page only
                      // when the notes are not on a cut (photos).
                      href={followUpHref(f)}
                      className="flex items-center justify-between gap-3 py-2.5 hover:text-brand"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <m.icon className="size-4 shrink-0 text-muted-2" />
                        <span className="truncate text-sm font-medium">{f.street}</span>
                        <span className="text-xs text-muted">{m.label}</span>
                      </div>
                      <span className="shrink-0 text-xs">
                        {f.awaitingReply > 0 && (
                          <span className="mr-2 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                            {f.awaitingReply} unanswered {f.awaitingReply === 1 ? "reply" : "replies"}
                          </span>
                        )}
                        {f.open > 0 && <span className="font-medium text-brand">{f.open} open</span>}
                        {f.open > 0 && f.awaitingReReview > 0 && <span className="text-muted-2"> · </span>}
                        {f.awaitingReReview > 0 && <span className="font-medium text-success">{f.awaitingReReview} fixed</span>}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </Fold>
        )}

        {q.recentlyApproved.length > 0 && (
          <Fold icon={CheckCircle2} title="Approved, last 14 days" count={q.recentlyApproved.length}>
            <ul className="space-y-2.5">{q.recentlyApproved.map((s) => <CutRow key={s.id} s={s} decided />)}</ul>
          </Fold>
        )}

        {board && board.lanes.delivered.length > 0 && (
          <Fold icon={CheckCircle2} title="Sent this week" count={board.lanes.delivered.length}>
            <ul className="divide-y divide-border">
              {board.lanes.delivered.map((r) => (
                <li key={r.key} className="py-2.5 text-sm">
                  <RowHead r={{ ...r, late: false }} />
                  <p className="text-muted">Sent {r.deliveredAtISO ? `${etDateTime(r.deliveredAtISO)} ET` : ""}{r.deliveredBy ? ` by ${r.deliveredBy}` : ""}{r.late ? " · after its promised date" : ""}</p>
                </li>
              ))}
            </ul>
          </Fold>
        )}

        {causes ? (
          <Fold icon={Flag} title="Revision causes">
            <RevisionQualitySummary report={causes} />
          </Fold>
        ) : (
          <Section icon={Flag} title="Revision causes">
            <p role="status" className="text-sm text-warning">Revision causes could not be loaded. Refresh to retry; no quality result is available from this read.</p>
          </Section>
        )}

        {/* Recording gaps and reported observations are separate from confirmed causes. */}
        {(patterns.flagsTotal > 0 || qcStats.byMiss.length > 0 || patterns.captureByPhotographer.length > 0) && (
          <Fold icon={Flag} title="Review observations and optional check records">
            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  Photo fix reasons — last {patterns.windowDays} days
                </h3>
                {patterns.byTag.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No photos flagged for fixes. 🎉</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {patterns.byTag.slice(0, 6).map((t) => (
                      <li key={t.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{t.label}</span>
                        <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-xs font-semibold tabular-nums text-warning">
                          {t.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-muted-2">
                  {patterns.flagsTotal} photo{patterns.flagsTotal === 1 ? "" : "s"} flagged
                  {patterns.flagsOpen > 0 ? ` · ${patterns.flagsOpen} still open` : ""}
                  {patterns.editNotes > 0 ? ` · +${patterns.editNotes} review fix note${patterns.editNotes === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  Optional QC checks not recorded — last {qcStats.windowDays} days
                </h3>
                {qcStats.byMiss.length === 0 ? (
                  <p className="mt-2 text-sm text-muted">No unrecorded checklist items found across {qcStats.qcPasses} QC passes. This does not measure defects.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {qcStats.byMiss.slice(0, 6).map((m) => (
                      <li key={m.label} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{m.label}</span>
                        <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold tabular-nums text-muted">
                          {m.count}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {qcStats.qcPasses > 0 && (
                  <p className="mt-2 text-[11px] text-muted-2">
                    {qcStats.qcPasses} QC pass{qcStats.qcPasses === 1 ? "" : "es"} · {qcStats.reopenedRate}% later
                    reopened after a revision (cause not assigned)
                  </p>
                )}
              </div>
            </div>
            {patterns.captureByPhotographer.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-2">
                  Capture notes by photographer — last {patterns.windowDays} days
                </h3>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {patterns.captureByPhotographer.map((p) => (
                    <span key={p.name} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium">
                      <Camera className="size-3 text-muted-2" /> {p.name}
                      <span className="tabular-nums text-muted">{p.count}</span>
                    </span>
                  ))}
                  <Link href="/shoot/feedback" className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-xs font-medium text-brand hover:bg-surface-2">
                    Photographer scoreboard →
                  </Link>
                </div>
              </div>
            )}
          </Fold>
        )}
      </div>
      {/* A verdict given in a cut follows the reviewer back here (Oct 5). */}
      <VerdictReceipts />
    </div>
  );
}
