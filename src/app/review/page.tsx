import { SendBack } from "@/components/videoDelivery/SendBack";
import { WatchFile } from "@/components/videoDelivery/WatchFile";
import { requirePageAccess } from "@/lib/auth/guards";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Clapperboard, Download, ExternalLink, Eye, History, Hourglass, Pencil, PlayCircle, Send } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canAccess, homeFor, isOffice } from "@/lib/auth/access";
import { getReviewQueue, type QueueSubmission } from "@/lib/reviewRoom";
import { VerdictReceipts } from "@/components/review/VerdictReceipts";
import { CutRow, Holder, RowHead, ago, linkCls, type CutDue } from "@/components/review/ReviewRoomParts";
import { verdictLine } from "@/lib/reviewAttribution";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import type { VideoDeliveryBoard, VideoLane, VideoRow } from "@/lib/videoDelivery";
import type { RemindItem, RemindState } from "@/lib/remindEditor";
import { BeforeYouSend } from "@/components/jobs/BeforeYouSend";
import { MarkSent } from "@/components/ops/MarkSent";
import { MarkDelivered } from "@/components/ops/MarkDelivered";
import { HeldRender } from "@/components/ops/HeldRender";
import { DeliveryFollowUps, PortalFinishing } from "@/components/ops/ReadyToSendCard";
import { PushControls } from "@/components/videoDelivery/PushControls";
import { SendAll, SendVideo } from "@/components/videoDelivery/SendVideo";
import { AutoRefresh } from "@/components/ops/AutoRefresh";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Video Review Room" };
// A verdict pressed here answers at once and finishes its follow-ons (the
// Dropbox copy waits on Dropbox for up to 15 s, the client-library rebuild) in
// after(), inside this route's function budget (Oct 5) — the same 60 s ceiling
// /edit/<id> uses. Anything a cut-short run leaves undone, the hourly sweeps
// named in review/actions.ts finish.
export const maxDuration = 60;

// ---------------------------------------------------------------------------
// THE VIDEO REVIEW ROOM, tightened (Jordan, Oct 19 2026: "Can you check into
// the video review room too? I feel like we can tighten up that as well").
// The Dashboard oversees everything and the Shoots page lists every shoot
// with its stage; this room is for the video work itself. THREE sections,
// each answering "what do I do here", a count in every heading:
//   · To review          the reviewer's queue: each cut with street, video,
//                        version, editor, how long it has waited and when it
//                        is due to the client (late in red). The cuts held
//                        for the editor's own send-for-review check are one
//                        quiet line under it, not a section.
//   · Ready to send      approved listing videos whose file is ready: Upload
//                        to Aryeo and send (the ONLY way the hub uploads a
//                        video) or Upload to Aryeo only (Oct 23 2026: "On
//                        Aryeo, not sent yet", then Send now), Send all
//                        (never an uploaded-only row), the job's open requests and shoot
//                        flags (BeforeYouSend), the hand path folded under
//                        each row; held and still-in-1080p rows as status
//                        lines; the delivery follow-ups as one compact fold,
//                        only when there are any
//   · With the editors   ONE list for every listing video being edited or
//                        revised (it replaced Late, Due today and In
//                        revision): late first, then by due, who has it and
//                        Remind editor (at most once every 4 hours)
// Coming up and Monthly content live on the Shoots page and the Dashboard.
// The history (approved, sent, feedback follow-through, revision causes,
// review observations) is one quiet link away at /review/history. The photo
// media checks are on Photo Delivery (/ops/photo-delivery); /ops/video-delivery
// redirects here. The delivery parts are the office's (owner/admin); a seated
// reviewer on another login sees To review and the sent-back versions only.
// Creatives get their feedback on their own surfaces (/shoot for
// photographers, /edit for editors).
// ---------------------------------------------------------------------------

// The shared Button's secondary look (components/ui/Action.tsx), for the links
// in "Done it by hand?" (Oct 20 2026, audit B21: one look per row).
const quietBtn = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-2 rounded-xl border border-border-strong bg-surface px-4 py-2 text-sm font-semibold leading-snug whitespace-normal text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand";
const PUSH_TONE: Record<string, string> = {
  progress: "text-foreground",
  waiting: "text-foreground",
  held: "font-medium text-warning",
  failed: "font-medium text-danger",
  done: "text-success",
  info: "text-muted",
};
const DAY = 24 * 3_600_000;
const EDITORS_SHOWN = 15;

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

// `sendDesk` (Oct 21 2026): the office's buttons (Upload to Aryeo and send,
// Deliver now / Release, Done it by hand). The creative manager reads the same
// row as status, keeps Watch it and "Not ready? Send back", and leaves the
// sending to Kyle (videos reach Aryeo only on a person's press, the office's).
function ReadyRow({ r, checks, sendDesk = true }: { r: VideoRow; checks: React.ReactNode; sendDesk?: boolean }) {
  const s = r.send!;
  const p = r.push;
  const run = !!p?.state;
  const stopped = p?.tone === "failed" || p?.tone === "held";
  const canPress = sendDesk && !s.byHandWhy && (p ? p.canStart : false);
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
      {sendDesk && s.byHandWhy && <p className="mt-1 text-sm font-medium text-warning">{s.byHandWhy}</p>}
      {sendDesk && !s.byHandWhy && s.pushUnknown && <p className="mt-1 text-sm font-medium text-warning">Couldn&rsquo;t read where this upload stands just now. Reload the page to send it.</p>}
      {sendDesk && !s.byHandWhy && s.asksUnknown && <p className="mt-1 text-sm font-medium text-warning">The client&rsquo;s requests could not be read just now. Reload before sending.</p>}
      {!sendDesk && !run && !s.uploaded && <p className="mt-1 text-sm text-muted">Waiting on the office to send it.</p>}
      <WatchFile href={s.watchHref} fileName={s.fileName} isRender={s.fileSource === "topaz-1080p"} />
      {/* Upload to Aryeo only beside it (Jordan, Oct 23 2026): on the listing, not sent, until Send now. */}
      {canPress && <SendVideo submissionId={r.submissionId!} street={r.street} label={label} openAsks={s.openAsks} asksUnknown={s.asksUnknown} listingWarning={s.listingWarning} uploadOnly={label === "Upload to Aryeo and send"} />}
      {sendDesk && p && (p.canDeliverNow || p.canRelease) && <PushControls submissionId={r.submissionId!} canDeliverNow={p.canDeliverNow} canRelease={p.canRelease} uploadedOnly={p.uploadedOnly} />}
      {/* Not ready after all? Offered unless an upload is moving (Oct 20 2026,
          audit B18: a failed or held run no longer hides it). */}
      {(!run || stopped) && r.submissionId && <SendBack submissionId={r.submissionId} projectId={r.projectId} street={r.street} />}
      {sendDesk && <details className="mt-2 rounded-lg border border-border bg-surface-2/40" open={!!s.byHandWhy || (!!p?.canRetry && !p.canStart)}>
        <summary className="min-h-11 cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">Done it by hand?</summary>
        <div className="space-y-2 px-3 pb-3 text-sm">
          <p className="text-muted">{s.fileSays} <span className="break-all font-mono text-ui-status">{s.fileName}</span></p>
          <div className="flex flex-wrap items-center gap-2">
            <a href={s.downloadHref} className={quietBtn}><Download aria-hidden className="size-3.5" /> Download the file</a>
            {r.aryeoUrl && <a href={r.aryeoUrl} target="_blank" rel="noreferrer" className={quietBtn}><ExternalLink aria-hidden className="size-3.5" /> Aryeo listing</a>}
            {r.reviewHref && <Link href={r.reviewHref} prefetch={false} className={quietBtn}><Eye aria-hidden className="size-3.5" /> Open the review</Link>}
          </div>
          {s.uploaded
            ? <><p className="text-muted">Uploaded by {s.uploaded.by} · {etDateTime(s.uploaded.at)} ET. After you send the listing in Aryeo:</p><MarkSent submissionId={r.submissionId!} street={r.street} expectedFingerprint={s.uploadFingerprint ?? undefined} /></>
            : s.uploadFingerprint && !s.listingMissing
              ? <><p className="text-muted">Uploaded it and sent the listing in Aryeo yourself? Record it:</p><MarkDelivered submissionId={r.submissionId!} fingerprint={s.uploadFingerprint} /></>
              : null}
        </div>
      </details>}
    </li>
  );
}

function HeldRow({ r, sendDesk = true }: { r: VideoRow; sendDesk?: boolean }) {
  const p = r.push;
  return (
    <li className="min-w-0 px-5 py-3">
      <RowHead r={r} />
      <p className="mt-0.5 text-sm text-muted"><span className="font-medium text-foreground">{r.stage}</span> · <span className={cn(r.late && "font-semibold text-danger")}>{r.promiseWords}</span></p>
      {r.heldWhy && <p className="mt-1 text-sm font-medium text-warning">{r.heldWhy}</p>}
      {r.heldRender && <HeldRender jobId={r.heldRender.jobId} street={r.street} fileName={r.heldRender.fileName} dropboxUrl={r.heldRender.dropboxUrl} lastCheck={r.heldRender.lastCheck} />}
      {sendDesk && p && p.canStart && r.send && !r.send.byHandWhy && <SendVideo submissionId={r.submissionId!} street={r.street} label="Try again" openAsks={r.send.openAsks} asksUnknown={r.send.asksUnknown} listingWarning={null} />}
      {sendDesk && p && (p.canDeliverNow || p.canRelease) && <PushControls submissionId={r.submissionId!} canDeliverNow={p.canDeliverNow} canRelease={p.canRelease} uploadedOnly={p.uploadedOnly} />}
      {/* A held video can go back to the editor too (audit B18). */}
      {r.submissionId && (!p?.state || p.tone === "failed" || p.tone === "held") && <SendBack submissionId={r.submissionId} projectId={r.projectId} street={r.street} />}
    </li>
  );
}

/** One video with an editor: being edited, or sent back for changes. */
type EditorItem = {
  key: string;
  projectId: string;
  submissionId: string | null;
  street: string;
  clientName: string;
  label: string;
  round: number | null;
  lane: VideoLane;
  stage: string;
  promiseISO: string | null;
  promiseWords: string;
  late: boolean;
  dueToday: boolean;
  reviewHref: string | null;
  /** The sent-back version, as the review queue has it (who sent it back, when, the file). */
  cut: QueueSubmission | null;
  /** When the changes were asked for (a sent-back version only). */
  revisionSinceISO: string | null;
};

function EditorRow({ e, children }: { e: EditorItem; children?: React.ReactNode }) {
  return (
    <li className="min-w-0 px-5 py-3" data-editor-row={e.key}>
      <RowHead r={e} />
      <p className="mt-0.5 text-sm text-muted">
        <span className="font-medium text-foreground">{e.stage}</span>
        {e.promiseWords && <>{" · "}<span className={cn(e.late && "font-semibold text-danger")}>{e.promiseWords}</span></>}
      </p>
      {e.cut && (
        <p className="mt-0.5 text-xs text-muted">
          {verdictLine(e.cut.verdict) ?? (e.cut.decidedAt ? `Sent back ${ago(e.cut.decidedAt)}` : "Sent back")}
          {e.cut.fileName ? ` · ${e.cut.fileName}` : ""}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 text-sm">
        {e.reviewHref && <Link href={e.reviewHref} prefetch={false} className={linkCls}><Clapperboard aria-hidden className="size-3.5" /> Open the cut</Link>}
        <Link href={`/edit/${e.projectId}`} prefetch={false} className={linkCls}><Pencil aria-hidden className="size-3.5" /> Edit page</Link>
      </div>
      {children}
    </li>
  );
}

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
  // is the office's desk: every client's cut, the delivery sections and the
  // editors' list. None of it is theirs, and none of it loads.
  if (!ownerDesk && me?.role === "PHOTOGRAPHER") {
    // THE SAME RULE AS THE PAGE THIS INDEX LINKS TO (review, Sep 18): the
    // roster link on the login itself (AppUser.teamMemberId), the one the
    // writes are guarded by. No roster link = no way to say which shoots are
    // theirs: fail closed to their own home rather than to somebody else's cuts.
    const mid = me.teamMemberId;
    if (!mid) redirect(homeFor(me.role));
    const { PhotographerRoom } = await import("@/components/review/PhotographerRoom");
    return <PhotographerRoom memberId={mid} firstName={(me.name ?? "there").split(" ")[0]} />;
  }
  if (!ownerDesk) redirect(homeFor(me?.role));

  // THE DELIVERY PARTS are the office's (owner/admin); a seated reviewer on
  // another login gets To review and the sent-back versions. View-as shows
  // what that login would see; its buttons are refused by the actions.
  const deliveryDesk = !me || isOffice(me.role);
  // The creative manager (Oct 21 2026) oversees the whole room: the due
  // dates, what is ready to send and with whom, the editors' list and its
  // Remind buttons. The sending itself stays the office's (ReadyRow sendDesk).
  const boardDesk = deliveryDesk || me?.role === "CREATIVE_MANAGER";
  const now = new Date();
  const [q, board] = await Promise.all([
    getReviewQueue({ includeTest }),
    boardDesk
      ? import("@/lib/videoDelivery").then((m) => m.videoDeliveryBoard({ fresh: true, followUps: true })).catch((e) => {
          console.error("[video-review] delivery board failed", e);
          return null;
        })
      : Promise.resolve(null as VideoDeliveryBoard | null),
  ]);
  const viewerTeamMemberId = me && !me.impersonating ? me.teamMemberId : null;
  const viewerName = me ? (me.impersonating ? null : me.realName || me.name || null) : null;
  const rowByKey = new Map((board ? Object.values(board.lanes).flat() : []).map((r) => [r.key, r]));

  // ---- 1 · To review: late first, then by due, then the longest waiting ----
  const toReview = [...q.pending].sort((a, b) => {
    const ra = rowByKey.get(a.id);
    const rb = rowByKey.get(b.id);
    return Number(!!rb?.late) - Number(!!ra?.late) || (ra?.promiseISO ?? "9999").localeCompare(rb?.promiseISO ?? "9999") || a.createdAt.localeCompare(b.createdAt);
  });
  const held = q.waitingOnCheck;
  // The board does not count a version held for the editor's own check as a
  // cut, so it shows that video as "not cut yet". Pair each held version with
  // its job's not-cut row: the held version is listed once (the quiet line,
  // with its due date), never as "waiting on the footage" under the editors.
  const heldRowOf = new Map<string, VideoRow>();
  const pairedUncut = new Set<string>();
  if (board) {
    const uncut = (["late", "today", "upcoming"] as const).flatMap((l) => board.lanes[l]).filter((r) => r.cutStatus === null);
    for (const s of held) {
      const r = uncut.find((x) => x.projectId === s.projectId && !pairedUncut.has(x.key));
      if (r) {
        pairedUncut.add(r.key);
        heldRowOf.set(s.id, r);
      }
    }
  }

  /** When a cut is due to the client (listing videos, from the board). */
  const dueOf = (id: string): CutDue => {
    const r = rowByKey.get(id) ?? heldRowOf.get(id);
    return r?.promiseISO ? { words: r.promiseWords, late: r.late } : null;
  };
  const heldLate = held.filter((s) => dueOf(s.id)?.late).length;

  // ---- 2 · Ready to send ----
  const ready = board?.lanes.sending ?? [];
  const heldRows = board?.lanes.held ?? [];
  const finishing = board?.lanes.finishing ?? [];
  // The job's open requests and shoot flags, once per job (the job box's own component).
  // Oct 20 2026 (audit B9): read together, not one job after another.
  const checksFor = new Map<string, React.ReactNode>(
    await Promise.all([...new Set([...ready, ...heldRows].map((r) => r.projectId))].map(async (pid) => {
      try {
        // The board read every job's requests at once (audit B9); a job it has no list for reads its own.
        return [pid, await BeforeYouSend({ projectId: pid, medium: "video", compact: true, requests: board?.jobRequests?.[pid] })] as const;
      } catch (e) {
        console.warn("[video-review] job checks unavailable", e);
        return [pid, null] as const;
      }
    })),
  );
  const sendAllIds = ready.filter((r) => r.send && !r.send.byHandWhy && !r.send.openAsks.length && !r.send.asksUnknown && !r.send.listingWarning && r.push?.canStart && !r.push.state).map((r) => r.submissionId!);
  const moving = [...ready, ...heldRows].some((r) => !!r.push?.state && r.push.handledByHub && !r.push.waitingForKyle && r.push.tone === "progress");
  const fu = board?.followUps ?? null;
  const followUpCount = fu ? (fu.needsFinishing?.length ?? 0) + fu.notTold.length + fu.noticeIncidents.length + fu.portal.length : 0;
  const followUpUnchecked = !!fu && (!!fu.boardUnavailable || fu.followUpChecks?.needsFinishing === null || fu.followUpChecks?.notTold === null || fu.noticeIncidentCheck === null);

  // ---- 3 · With the editors: every listing video being edited or revised ----
  const revisionById = new Map(q.waitingOnEditor.map((s) => [s.id, s]));
  const onBoard: EditorItem[] = board
    ? (["late", "today", "upcoming"] as const)
        .flatMap((l) => board.lanes[l])
        .filter((r) => r.cutStatus === "CHANGES_REQUESTED" || (r.cutStatus === null && r.stage !== "Not shot yet" && !pairedUncut.has(r.key)))
        .map((r) => ({
          key: r.key, projectId: r.projectId, submissionId: r.submissionId, street: r.street, clientName: r.clientName, label: r.label, round: r.round, lane: r.lane,
          stage: r.stage, promiseISO: r.promiseISO, promiseWords: r.promiseWords, late: r.late, dueToday: r.dueToday, reviewHref: r.reviewHref,
          cut: r.submissionId ? (revisionById.get(r.submissionId) ?? null) : null,
          revisionSinceISO: r.cutStatus === "CHANGES_REQUESTED" ? r.sinceISO : null,
        }))
    : [];
  // A sent-back version the board does not date (a monthly video, a job the
  // board leaves out, or a seated reviewer's view with no board): still listed.
  const offBoard: EditorItem[] = q.waitingOnEditor
    .filter((s) => !rowByKey.has(s.id))
    .map((s) => ({
      key: s.id, projectId: s.projectId, submissionId: s.id, street: s.street, clientName: s.clientName, label: "Video", round: s.round, lane: "upcoming" as VideoLane,
      stage: `Changes asked, version ${s.round}`, promiseISO: null, promiseWords: "", late: false, dueToday: false, reviewHref: `/review/${s.projectId}?cut=${s.id}`,
      cut: s, revisionSinceISO: s.decidedAt,
    }));
  // Late first (the earliest promise is the most late), then by due; undated last.
  const editors = [...onBoard, ...offBoard].sort((a, b) => (a.promiseISO ?? "9999").localeCompare(b.promiseISO ?? "9999") || (a.revisionSinceISO ?? "").localeCompare(b.revisionSinceISO ?? ""));
  const editorsLate = editors.filter((e) => e.late).length;
  const notShotLate = board ? board.lanes.late.filter((r) => r.cutStatus === null && r.stage === "Not shot yet") : [];
  const remindButtonFor = (e: EditorItem) => e.late || e.dueToday || (!!e.revisionSinceISO && now.getTime() - Date.parse(e.revisionSinceISO) > DAY);

  // Who holds each video, and when it was last reminded (one batch of reads).
  const remindItems: RemindItem[] = boardDesk
    ? [
        ...editors.map((e) => ({ key: e.key, projectId: e.projectId, submissionId: e.submissionId, street: e.street, promiseISO: e.promiseISO, late: e.late, dueToday: e.dueToday, revisionSinceISO: e.revisionSinceISO })),
        // A late (or due today) cut waiting on someone else's review: Remind reviewer.
        ...toReview.flatMap((s) => {
          const r = rowByKey.get(s.id);
          return r && (r.late || r.dueToday) ? [{ key: s.id, projectId: s.projectId, submissionId: s.id, street: s.street, promiseISO: r.promiseISO, late: r.late, dueToday: r.dueToday }] : [];
        }),
      ]
    : [];
  const reminds: Map<string, RemindState> = remindItems.length
    ? await import("@/lib/remindEditor").then((m) => m.remindStatesFor([...new Map(remindItems.map((x) => [x.key, x])).values()], { now, viewerTeamMemberId })).catch((e) => {
        console.warn("[video-review] remind states unavailable", e);
        return new Map<string, RemindState>();
      })
    : new Map<string, RemindState>();

  // The Editing Room shortcut: anyone whose login opens that page (with
  // sign-in switched off, everyone).
  const showEditingRoom = me ? canAccess(me, "editing") : !authEnforced();
  const subtitle = [
    `${q.pending.length} to review`,
    board ? `${ready.length} ready to send` : null,
    `${editors.length} with editors${editorsLate ? ` (${editorsLate} late)` : ""}`,
  ].filter(Boolean).join(" · ");
  const editorRow = (e: EditorItem) => (
    <EditorRow key={e.key} e={e}>
      {boardDesk && <Holder st={reminds.get(e.key)} rowKey={e.key} projectId={e.projectId} submissionId={e.submissionId} viewerName={viewerName} showButton={remindButtonFor(e)} now={now} />}
    </EditorRow>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Video"
        title="Video Review Room"
        subtitle={subtitle}
        // The way over to the editors' side (Jordan, Oct 19 2026: "add a
        // shortcut to the editing room in the Video page").
        actions={showEditingRoom ? (
          <Link href="/editing" prefetch={false} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <Clapperboard aria-hidden className="size-4 text-brand" /> Editing Room
          </Link>
        ) : undefined}
      />

      <div className="space-y-6 p-4 sm:p-6">
        {/* While a video is on its way (Oct 20 2026, audit B9): every 30 s,
            not 20; the cron moves an upload once a minute. */}
        {moving && <AutoRefresh seconds={30} />}
        {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
        {includeTest && <p className="text-xs text-muted">Showing real and test records</p>}

        {boardDesk && !board && (
          <p role="alert" className="rounded-2xl border border-warning/30 bg-warning-soft/40 p-4 text-sm text-warning">Ready to send and the due dates could not be read just now. Refresh to try again.</p>
        )}

        {/* ————— 1 · TO REVIEW ————— */}
        <Section icon={PlayCircle} title="To review" count={q.pending.length}>
          {toReview.length === 0 ? (
            <p className="text-sm text-muted">
              No cuts waiting. When an editor uploads a version on the edit page and finishes the send-for-review
              check, it shows up here with a player and timestamped notes.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {toReview.map((s) => {
                const st = reminds.get(s.id);
                return (
                  <CutRow key={s.id} s={s} viewerTeamMemberId={viewerTeamMemberId} video={rowByKey.get(s.id)?.label ?? null} due={dueOf(s.id)}>
                    {st?.target.kind === "reviewer" && (
                      <div className="px-1">
                        <Holder st={st} rowKey={s.id} projectId={s.projectId} submissionId={s.id} viewerName={viewerName} showButton now={now} />
                      </div>
                    )}
                  </CutRow>
                );
              })}
            </ul>
          )}
          {/* §8.2: handed in, held for the editor's own send-for-review check
              (the found-in-the-folder cut, the upload that wasn't the file
              checked, the moved cut). Nothing here can be ruled on yet. */}
          {held.length > 0 && (
            <details className="mt-3 rounded-lg border border-border bg-surface-2/40" data-waiting-on-check={held.length}>
              <summary className="min-h-11 cursor-pointer rounded-lg px-3 py-2.5 text-sm text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                {held.length}{toReview.length ? " more" : ""} {held.length === 1 ? "is" : "are"} waiting on the editor&rsquo;s own check
                {heldLate > 0 && <span className="font-semibold text-danger"> ({heldLate} late)</span>}
              </summary>
              <div className="space-y-2.5 px-3 pb-3">
                <p className="text-xs text-muted">
                  They reach the list above once the editor finishes the send-for-review check on the job&rsquo;s edit page
                  (or the office can, for them).
                </p>
                <ul className="space-y-2.5">{held.map((s) => <CutRow key={s.id} s={s} video={(rowByKey.get(s.id) ?? heldRowOf.get(s.id))?.label ?? null} due={dueOf(s.id)} />)}</ul>
              </div>
            </details>
          )}
        </Section>

        {/* ————— 2 · READY TO SEND ————— */}
        {/* Kyle's door lands here (Oct 22 2026, sidebarNavigation OFFICE_MENU; labelled Video Delivery since Oct 23). */}
        {board && (
          <div id="ready-to-send" className="scroll-mt-24">
          <Section icon={Send} title="Ready to send" count={ready.length} flush action={deliveryDesk && sendAllIds.length >= 2 ? <SendAll submissionIds={sendAllIds} /> : undefined}>
            {ready.length ? (
              <ul className="divide-y divide-border">{ready.map((r) => <ReadyRow key={r.key} r={r} checks={checksFor.get(r.projectId) ?? null} sendDesk={deliveryDesk} />)}</ul>
            ) : (
              <p className="px-5 py-4 text-sm text-muted">No approved listing video is waiting to go out.</p>
            )}
            {heldRows.length > 0 && (
              <>
                <h3 className="border-t border-border px-5 pt-3 text-sm font-semibold text-warning">Held ({heldRows.length})</h3>
                <ul className="divide-y divide-border">{heldRows.map((r) => <HeldRow key={r.key} r={r} sendDesk={deliveryDesk} />)}</ul>
              </>
            )}
            {finishing.length > 0 && (
              <p className="border-t border-border px-5 py-3 text-sm text-muted">
                <span className="font-medium text-foreground">Finishing the 1080p pass ({finishing.length}):</span>{" "}
                {finishing.map((r) => `${r.street}${r.late ? " (late)" : ""}`).join(", ")}. They show up above when the file is back.
              </p>
            )}
            {/* Branding videos still in the 1080p pass, which can still go to
                Aryeo instead of the portal (Oct 21 2026). */}
            {deliveryDesk && fu && fu.portalFinishing.length > 0 && (
              <div className="border-t border-border px-5 py-3">
                <PortalFinishing rows={fu.portalFinishing} />
              </div>
            )}
            {/* The delivery card's follow-up lanes (here since Home stopped
                showing the card), one compact fold, only when there are any. */}
            {deliveryDesk && fu && (followUpCount > 0 || followUpUnchecked) && (
              <details className="border-t border-border" open={followUpUnchecked} data-follow-ups={followUpCount}>
                <summary className="min-h-11 cursor-pointer px-5 py-3 text-sm font-medium text-warning focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                  <span>Needs a follow-up</span> <span className="font-normal text-muted">({followUpCount})</span>
                </summary>
                <div className="px-5 pb-4">
                  <DeliveryFollowUps board={fu} includeTest={includeTest} />
                </div>
              </details>
            )}
          </Section>
          </div>
        )}

        {/* ————— 3 · WITH THE EDITORS ————— */}
        <Section
          icon={Hourglass}
          title="With the editors"
          count={editorsLate ? `${editors.length}, ${editorsLate} late` : editors.length}
          action={showEditingRoom ? <Link href="/editing" prefetch={false} className={linkCls}>Open the Editing Room</Link> : undefined}
          flush
        >
          {editors.length ? (
            <>
              <ul className="divide-y divide-border">{editors.slice(0, EDITORS_SHOWN).map(editorRow)}</ul>
              {editors.length > EDITORS_SHOWN && (
                <details className="border-t border-border">
                  <summary className="min-h-11 cursor-pointer px-5 py-3 text-sm font-medium">Show {editors.length - EDITORS_SHOWN} more</summary>
                  <ul className="divide-y divide-border">{editors.slice(EDITORS_SHOWN).map(editorRow)}</ul>
                </details>
              )}
            </>
          ) : (
            <p className="px-5 py-4 text-sm text-muted">No video is with an editor right now.</p>
          )}
          {notShotLate.length > 0 && (
            <p className="border-t border-border px-5 py-3 text-sm text-muted">
              Also late, not shot yet:{" "}
              {notShotLate.map((r, i) => (
                <span key={r.key}>
                  {i > 0 && ", "}
                  <Link href={`/projects/${r.projectId}`} className="font-medium text-foreground underline underline-offset-2 hover:text-brand">{r.street}</Link>
                </span>
              ))}
              .
            </p>
          )}
        </Section>

        <p className="text-center">
          <Link href={includeTest ? "/review/history?test=1" : "/review/history"} className="inline-flex min-h-11 items-center gap-1.5 text-sm text-muted underline underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            <History aria-hidden className="size-4" /> History: approved and sent videos
          </Link>
        </p>
      </div>
      {/* A verdict given in a cut follows the reviewer back here (Oct 5). */}
      <VerdictReceipts />
    </div>
  );
}
