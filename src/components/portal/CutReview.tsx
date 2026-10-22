"use client";

import { memo, useCallback, useEffect, useImperativeHandle, useRef, useState, useTransition, type Ref, type RefObject } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, Clock, CornerDownRight, History, Loader2, MessageSquare, Send, ThumbsUp, Trash2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalAddComment, portalApproveCut, portalDeleteComment, portalRecordClientApproval, portalRequestRevision, portalResolveComment } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { PortalPlayer, type PortalPlayerHandle } from "@/components/portal/PortalPlayer";
import { contactLine } from "@/components/portal/ContactTeam";
import { approvalCopy, NOTE_COPY, noteDraftKey } from "@/components/portal/cutReviewCopy";
import type { CutVersion, CommentView } from "@/lib/clientDecisions";

// ---------------------------------------------------------------------------
// REVIEW & APPROVAL of one video (spec §8). The current released cut plays;
// notes pin to the paused moment (or are general), reply under each other and
// resolve; "Send note" is one thing and "Request changes" is another;
// "Approve this version" writes a decision on THIS cut and asks what to do
// with any open notes. Every older version stays listed with what happened to
// it — receipt and status come from the server's persisted state, and the
// page re-reads after every write (router.refresh) so what shows is what was
// stored, not what the click hoped.
//
// CP-02/03 (Sep 24 2026): the current version may carry `review` — its review
// deadline and the revision rounds this video has used — straight from the
// window the server enforces (reviewWindows.reviewPanelFor). It is null while
// the revision policy is off, and then this page is exactly what it was. Only
// the current version is playable. Each "Send to the editor" attempt carries a
// request key, kept across a retry and renewed after it lands, so a double
// click or a flaky network cannot send one request twice.
//
// STAFF (Oct 21 2026): our team looking through the owner iframe does not
// approve for the client; they RECORD an approval the client gave elsewhere
// (a text, a call), with a required note saying how and when. The client's
// own login and the shared link never see this. Oct 22 2026: the staff words
// read "Approve for <first name>" with one line saying they act on the
// client's behalf (cutReviewCopy), and only when `staff` is set and this is
// not the shared link.
//
// NO NOTE IS LOST (Oct 22 2026, Mike Ciunci said he left a note; none ever
// reached the server). The note box is its own component (NoteComposer): its
// text autosaves on this device per cut, the button says "Send note", an
// unsent note is called out before an approval, a change request or leaving
// the page, and a sent note gets a plain confirmation. Typing re-renders the
// composer alone; the player is a memoised element that never re-renders for
// it (see the flash note in PortalPlayer).
// ---------------------------------------------------------------------------

const fmtT = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const fmtWhen = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

// "you" only when it WAS you. A collaborator or a viewer seat reading
// "Approved by you" about the owner's approval is told they did something they
// did not do (review, Sep 17) — the receipt underneath always names the person.
const STATE_LABEL: Record<CutVersion["clientState"], [mine: string, theirs: string]> = {
  AWAITING_YOUR_DECISION: ["Awaiting your review", "Awaiting review"],
  YOU_REQUESTED_CHANGES: ["You requested changes", "Changes requested"],
  YOU_APPROVED: ["Approved by you", "Approved"],
  AUTO_APPROVED: ["Approved automatically", "Approved automatically"],
  SUPERSEDED: ["Replaced by a newer version", "Replaced by a newer version"],
  NOT_RELEASED: ["Not shared with you", "Not shared with you"],
};

export function CutReview({ versions, perms, readOnly = false, poster = null, signInHref = null, linkVisitor = false, linkHasSeat = true, staff = false, clientFirst = null }: {
  /** Oldest → newest; assetUrl already carries the media token. */
  versions: CutVersion[];
  perms: { comment: boolean; request: boolean; approve: boolean };
  readOnly?: boolean;
  poster?: string | null;
  /** On the emailed link seat nobody may approve. Where the client goes to get
   *  a seat that can — the only route out of "waiting for approval". */
  signInHref?: string | null;
  /**
   * A1 (Oct 13 2026): the plain shared link. It can never approve (portalAccess
   * LEGACY_TOKEN), so it watches here and is asked to sign in to decide:
   * no note box, no request or approve buttons, one clear line instead.
   */
  linkVisitor?: boolean;
  /** Oct 20 2026 (audit E2): a seat exists on this program. Without one there
   *  is no invitation email to sign in from; the office sets one up. */
  linkHasSeat?: boolean;
  /** Oct 21 2026: staff through the owner iframe; approving RECORDS the client's sign-off, with a note. */
  staff?: boolean;
  /** Oct 22 2026: the client's first name for "Approve for Mike" (sent for staff only). */
  clientFirst?: string | null;
}) {
  const router = useRouter();
  const current = versions.find((v) => v.isCurrent) ?? null;
  const player = useRef<PortalPlayerHandle>(null);
  const composer = useRef<NoteComposerHandle>(null);
  // The player told us it could not play this file: there is no moment to pin
  // a note to, and the checkbox must not pretend otherwise.
  const [playerFailed, setPlayerFailed] = useState(false);
  // Something typed in the note box and not sent. Changes only when the box
  // goes from empty to not (or back), never per keystroke.
  const [hasDraft, setHasDraft] = useState(false);
  const [overall, setOverall] = useState("");
  const [asking, setAsking] = useState(false);
  const [approving, setApproving] = useState(false);
  // No default: §8 asks for a CLEAR choice about open notes, and a pre-picked
  // "discard" would resolve a client's notes without them ever choosing.
  const [choice, setChoice] = useState<"INCLUDE" | "DISCARD" | null>(null);
  // Staff only: how and when the client approved ("by text, Oct 15").
  const [how, setHow] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, start] = useTransition();
  // The fee acknowledgement (an extra round, revision policy on) and the
  // server's own words for it when the page's copy was stale.
  const [feeAck, setFeeAck] = useState(false);
  const [serverAck, setServerAck] = useState<string | null>(null);
  // One key per submit ATTEMPT: the same key on a retry, a new one after success.
  const requestKey = useRef<string | null>(null);
  // A version under review is PLAYABLE, not downloadable (CP-01): the file
  // unlocks with its own approval, through the posting kit. The browser's own
  // player offered "Download" in its ⋮ menu and "Save video as…" on
  // right-click, both fetching the same tokened stream without dl=1. Hiding
  // them is a deterrent, not a lock — anything a browser can play can be
  // captured — so the server's dl=1 gate stays the real control. Set on the
  // element PortalPlayer renders (React does not manage these attributes, so a
  // re-render never puts the menu back).
  const playerBox = useRef<HTMLDivElement>(null);
  const currentSrc = versions.find((v) => v.isCurrent)?.assetUrl ?? null;
  useEffect(() => {
    const el = playerBox.current?.querySelector("video");
    if (!el) return;
    el.setAttribute("controlslist", "nodownload noremoteplayback");
    el.disablePictureInPicture = true;
  }, [currentSrc]);
  // THE PLAYER IS ISOLATED. PlayerFrame is memoised and every prop it gets is
  // stable (two refs, the file's address, the poster, a callback made once),
  // so no state on this page (the note box, a reply, a panel opening) gives
  // React anything to re-render it with. A fresh media token after a refresh
  // does reach it, and PortalPlayer keeps the same file loaded for that.
  const onPlayerError = useCallback(() => setPlayerFailed(true), []);

  if (!current) {
    return <p className="rounded-xl border border-border bg-surface-2/40 p-4 text-sm text-muted">No version of this video has been shared with you yet.</p>;
  }
  const open = current.comments.filter((c) => c.status === "OPEN" && !c.resolvedAtISO);
  const approved = current.clientState === "YOU_APPROVED" || current.clientState === "AUTO_APPROVED";
  const requested = current.clientState === "YOU_REQUESTED_CHANGES";
  const review = current.review ?? null;
  // Past the deadline an undecided version takes no NEW request (the server
  // refuses it too). Notes on a request already sent can still join it. It
  // closes the REQUEST only: a late approval is always accepted server-side
  // (approveCut), and hiding the Approve button with it left a client who
  // came back on day five wanting to approve with no way to unlock the file.
  const closed = !!review?.closed && !requested;
  const ackText = serverAck ?? review?.ackText ?? null;
  const needsAck = !requested && (!!serverAck || !!review?.nextRoundNeedsAck);
  // Oct 14 2026: an approved version can still take notes and a change
  // request (it reopens the video for the editor), when it is the newest one.
  const reopenable = approved && !!current.isCurrent && perms.request && !linkVisitor && !readOnly;
  const canWrite = !readOnly && perms.comment && (!approved || reopenable) && !linkVisitor;
  // Staff acting for the client: never on the shared link, whatever else says so.
  const onBehalf = staff && !linkVisitor;
  const copy = approvalCopy(current.clientVersion, onBehalf ? (clientFirst?.trim() || "the client") : null);
  const yourEditor = onBehalf ? "the editor" : "your editor";
  const done = (r: { ok: boolean; message: string }) => { setMsg({ ok: r.ok, text: r.message }); if (r.ok) router.refresh(); };
  // "your" is right when the reader is the one it is waiting ON, or the one who
  // acted. Nobody has decided an AWAITING version, so there is no actor to
  // compare — the reader's own seat decides the wording there.
  const yours = (v: CutVersion) => (v.clientState === "AWAITING_YOUR_DECISION" ? perms.request || perms.approve || perms.comment : v.decidedByMe);
  // What a sent note does next, said plainly under "We have your note".
  const afterSend = perms.request && !linkVisitor
    ? approved
      ? `When you're ready, press Request changes below and it goes to ${yourEditor}.`
      : `When you've added everything, press Request changes below to send your notes to ${yourEditor}${perms.approve && !requested ? ", or approve if nothing needs changing" : ""}.`
    : "Our team can see it. The program owner sends notes to the editor with a change request.";

  const sendReply = (parentId: string) => {
    const body = reply.trim();
    if (!body) return;
    start(async () => {
      const r = await portalAddComment(portalAuthFromLocation(), current.submissionId, null, body, parentId).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
      if (r.ok) { setReply(""); setReplyTo(null); }
      done(r);
    });
  };
  const remove = (id: string) => start(async () => done(await portalDeleteComment(portalAuthFromLocation(), id).catch(() => ({ ok: false, message: "Couldn't remove that note." }))));
  const resolve = (id: string, resolved: boolean) => start(async () => done(await portalResolveComment(portalAuthFromLocation(), id, resolved).catch(() => ({ ok: false, message: "Couldn't update that note." }))));
  const submitChanges = () => start(async () => {
    if (!requestKey.current) requestKey.current = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `rk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const r: { ok: boolean; message: string; needsFeeAck?: boolean; ackText?: string | null } = await portalRequestRevision(portalAuthFromLocation(), current.submissionId, overall, { requestKey: requestKey.current, acknowledgeExtraFee: needsAck && feeAck }).catch(() => ({ ok: false, message: `That didn't send. Try again, or ${contactLine()} and we'll get on it.` }));
    if (r.ok) { setAsking(false); setOverall(""); setFeeAck(false); setServerAck(null); requestKey.current = null; }
    else if (r.needsFeeAck && r.ackText) setServerAck(r.ackText);
    done(r);
  });
  const howOk = how.trim().length >= 6;
  const approve = () => start(async () => {
    const notes = open.length ? (choice ?? "NONE") : "NONE";
    const r = await (onBehalf
      ? portalRecordClientApproval(portalAuthFromLocation(), current.submissionId, notes, how)
      : portalApproveCut(portalAuthFromLocation(), current.submissionId, notes)).catch(() => ({ ok: false, message: "That didn't save. Try again." }));
    if (r.ok) { setApproving(false); setHow(""); }
    done(r);
  });
  // A typed note nobody sent is never left sitting there (the Bernadette and
  // Mike lesson): while one is in the box, approving and requesting changes
  // first ask to send it or discard it, and their final buttons wait.
  const draftBlocks = hasDraft && canWrite;
  const draftWarning = draftBlocks ? (
    <div role="alert" className="rounded-lg border border-warning/40 bg-warning-soft/40 p-2.5 text-xs">
      <p className="font-semibold text-foreground">{NOTE_COPY.unsentWarning}</p>
      <p className="mt-0.5 text-muted">It&rsquo;s in the note box above. Send it so {asking ? "it goes with this request" : "we have it"}, or discard it.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => void composer.current?.send()} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Send className="size-3.5" /> {NOTE_COPY.sendIt}</button>
        <button type="button" onClick={() => composer.current?.discard()} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{NOTE_COPY.discardIt}</button>
      </div>
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Version {current.clientVersion}</span>
        <StateChip state={current.clientState} mine={yours(current)} />
        {current.revisionOpen && !approved && <span className="inline-flex items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[10px] font-semibold text-brand"><Undo2 className="size-3" /> Editor working on changes</span>}
        {current.releasedAtISO && <span className="text-[11px] text-muted-2">shared {fmtWhen(current.releasedAtISO)}</span>}
      </div>
      {review && (
        <div className="space-y-0.5 text-[11px] text-muted">
          <p className="inline-flex flex-wrap items-center gap-x-1.5">
            <CalendarClock className="size-3.5 text-muted-2" />
            {review.deadlineLabel && review.state === "OPEN" && !review.closed && <span>Review by <span className="font-semibold text-foreground">{review.deadlineLabel}</span> (business days, Mon to Fri)</span>}
            {review.deadlineLabel && review.state === "OPEN" && !review.closed && <span aria-hidden>·</span>}
            <span>Revision rounds used: {review.roundsUsed} of {review.includedRounds} included</span>
          </p>
          {review.closed && <p className="text-warning">The review window for this version closed {review.deadlineLabel}.{review.urgentContact ? ` Need a change? Call or text Kyle at ${review.urgentContact}.` : ""}</p>}
          {!review.closed && review.state === "OPEN" && review.autoApproveOn && <p>If we don&rsquo;t hear from you by then, this version is approved automatically.</p>}
          {!review.closed && review.state === "OPEN" && review.urgentContact && <p>Need something inside 24 hours? Call or text Kyle at {review.urgentContact}.</p>}
        </div>
      )}

      <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start xl:gap-5">
        <div className="min-w-0 xl:sticky xl:top-4">
          {currentSrc
            ? <PlayerFrame boxRef={playerBox} playerRef={player} src={currentSrc} poster={poster} onError={onPlayerError} />
            : <p className="text-sm text-muted">This version has no playable file. {contactLine().replace(/^c/, "C")} and we&rsquo;ll sort it.</p>}
        </div>
        <div className="mt-3 min-w-0 space-y-3 xl:mt-0">

      {/* Receipt — persisted decisions on THIS version. */}
      {current.decisions.length > 0 && (
        <ul className="space-y-1">
          {current.decisions.map((d) => (
            <li key={d.id} className={cn("flex items-start gap-2 rounded-xl border p-2.5 text-xs", d.decision === "APPROVE" ? "border-success/25 bg-success-soft/40" : "border-brand/25 bg-brand-soft/30")}>
              {d.decision === "APPROVE" ? <ThumbsUp className="mt-0.5 size-3.5 shrink-0 text-success" /> : <Send className="mt-0.5 size-3.5 shrink-0 text-brand" />}
              <span>
                {d.basis === "AUTO_EXPIRY"
                  ? <><span className="font-semibold">Approved automatically</span> on {fmtWhen(d.decidedAtISO)} · {d.actorLabel}</>
                  : <><span className="font-semibold">{d.decision === "APPROVE" ? "Approved" : "Change request sent"}</span> by {d.actorLabel} on {fmtWhen(d.decidedAtISO)}</>}
                {d.decision === "REQUEST_CHANGES" && <span className="text-muted"> · {d.receiptState === "DONE" ? "done, see the newer version" : d.receiptState === "SUPERSEDED" ? "a newer version replaced this one" : d.receiptState === "ROUTED" || d.receiptState === "IN_PROGRESS" ? "with your editor" : "received"}</span>}
                {d.decision === "APPROVE" && d.openNotesChoice === "INCLUDE" && <span className="text-muted"> · notes sent along</span>}
                {d.decision === "APPROVE" && d.openNotesChoice === "DISCARD" && <span className="text-muted"> · open notes resolved</span>}
                {onBehalf && d.decision === "APPROVE" && d.basis === "STAFF" && d.note && <span className="text-muted"> · how they approved: {d.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Notes on this version */}
      {current.comments.length > 0 && (
        <ul className="space-y-2">
          {current.comments.map((c) => (
            <li key={c.id} className={cn("rounded-xl border border-border bg-surface p-2.5", c.resolvedAtISO && "opacity-70")}>
              <Note c={c} onSeek={(t) => player.current?.seek(t)} />
              <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px]">
                {c.status === "OPEN" && !c.resolvedAtISO && c.mine && canWrite && (
                  <button type="button" onClick={() => remove(c.id)} disabled={busy} className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted-2 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Trash2 className="size-3" /> Remove</button>
                )}
                {c.status === "SENT" && !c.resolvedAtISO && <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3" /> sent to the editor</span>}
                {canWrite && (
                  <button type="button" onClick={() => resolve(c.id, !c.resolvedAtISO)} disabled={busy} className="inline-flex min-h-11 items-center rounded-md px-2 text-xs text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{c.resolvedAtISO ? "Reopen" : "Mark resolved"}</button>
                )}
                {c.resolvedAtISO && <span className="text-muted-2">resolved by {c.resolvedBy}</span>}
                {canWrite && <button type="button" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReply(""); }} className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-xs text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><CornerDownRight className="size-3" /> Reply</button>}
              </div>
              {c.replies.length > 0 && (
                <ul className="mt-1.5 space-y-1 border-l-2 border-border pl-2.5">
                  {c.replies.map((r) => <li key={r.id} className="text-xs"><span className="font-semibold">{r.author}</span> <span className="text-muted-2">{fmtWhen(r.createdAtISO)}</span><div className="text-foreground/90">{r.body}</div></li>)}
                </ul>
              )}
              {replyTo === c.id && (
                <div className="mt-1.5 flex items-start gap-2">
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Your reply…" aria-label="Reply" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-base outline-none focus:border-brand sm:text-sm" />
                  <button type="button" onClick={() => sendReply(c.id)} disabled={busy || !reply.trim()} className="min-h-11 shrink-0 rounded-lg bg-brand-action px-3 text-sm font-semibold text-white disabled:opacity-50">Reply</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Composer: Send note (distinct from requesting changes). Keyed by the
          cut, so a newer version starts with its own box and its own draft. */}
      {canWrite && (
        <NoteComposer key={current.submissionId} ref={composer} submissionId={current.submissionId} player={player} playerFailed={playerFailed} afterSend={afterSend} onDraftChange={setHasDraft} />
      )}

      {/* A1: the shared link watches; a signed-in seat decides. */}
      {linkVisitor && !readOnly && !approved && (
        <div className="rounded-xl border border-brand/25 bg-brand-soft/30 p-3 text-sm">
          <p className="font-semibold">Sign in to approve or request changes.</p>
          {signInHref
            ? <a href={signInHref} className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Sign in</a>
            : linkHasSeat
              ? <p className="mt-1 text-xs text-muted">Use the sign-in link in your invitation email, or {contactLine()} and we&rsquo;ll send you one.</p>
              : <p className="mt-1 text-xs text-muted">{contactLine().replace(/^c/, "C")} and we&rsquo;ll set up your sign-in.</p>}
        </div>
      )}

      {/* The two decisions — separate, explicit. */}
      {reopenable && !asking && (
        <p className="border-t border-border pt-3 text-xs text-muted">Want something changed after all? Pause where you want the change, send a note, then press Request changes. The video goes back to {yourEditor}.</p>
      )}
      {!linkVisitor && !readOnly && (!approved || (reopenable && open.length > 0)) && (perms.request || perms.approve) && !(closed && !perms.approve && !reopenable) && (
        <div className="border-t border-border pt-3">
          {/* Notes saved but not yet in a change request have not reached the
              editor. Say so, every time, until they go or are resolved. */}
          {open.length > 0 && perms.request && !asking && !approving && (
            <p className="mb-2 rounded-lg border border-warning/30 bg-warning-soft/30 px-2.5 py-2 text-xs">
              {open.length === 1 ? "1 note hasn't" : `${open.length} notes haven't`} gone to {yourEditor} yet. Press Request changes to send {open.length === 1 ? "it" : "them"}{perms.approve && !requested && !approved ? ", or approve if nothing needs changing" : ""}.
            </p>
          )}
          {!asking && !approving && (
            <div className="flex flex-wrap gap-2">
              {perms.request && (!closed || reopenable) && (
                <button type="button" onClick={() => setAsking(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                  <Send className="size-3.5" /> Request changes{open.length ? ` (${open.length} note${open.length === 1 ? "" : "s"})` : ""}
                </button>
              )}
              {/* Asked for changes on this version? Its approval is the NEW
                  version's to give — the server refuses both verdicts on one cut. */}
              {perms.approve && !requested && !approved && (
                <button type="button" onClick={() => setApproving(true)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-success-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                  <ThumbsUp className="size-3.5" /> {copy.button}
                </button>
              )}
            </div>
          )}
          {!asking && !approving && copy.onBehalf && perms.approve && !requested && !approved && (
            <p className="mt-1.5 text-[11px] text-muted-2">{copy.onBehalf}</p>
          )}
          {!perms.approve && perms.request && !asking && !requested && (
            <p className="mt-1.5 text-[11px] text-muted-2">Only the program owner can approve a version.</p>
          )}
          {asking && (
            <div className="space-y-2">
              {draftWarning}
              <p className="text-xs text-muted">Your {open.length} open note{open.length === 1 ? " goes" : "s go"} with this request as one change list for {yourEditor}.{requested ? " A request is already open on this version, so new notes join it." : ""}</p>
              <textarea value={overall} onChange={(e) => setOverall(e.target.value)} placeholder="Anything overall? (optional)" rows={2} aria-label="Overall note" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm" />
              {needsAck && ackText && (review?.mayAcknowledge ?? perms.approve) && (
                <label className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft/30 p-2.5 text-xs">
                  <input type="checkbox" checked={feeAck} onChange={(e) => setFeeAck(e.target.checked)} className="mt-0.5 accent-[var(--brand)]" />
                  <span>{ackText}</span>
                </label>
              )}
              {needsAck && !(review?.mayAcknowledge ?? perms.approve) && (
                <p className="text-xs text-warning">This would be an extra revision round for this video, which may carry a fee. Please sign in with your own account to send it, so we know who agreed.</p>
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={submitChanges} disabled={busy || draftBlocks || (needsAck && !(feeAck && (review?.mayAcknowledge ?? perms.approve)))} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3.5 animate-spin" />} Send to the editor</button>
                <button type="button" onClick={() => setAsking(false)} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
              </div>
            </div>
          )}
          {approving && (
            <div className="space-y-2 rounded-xl border border-success/30 bg-success-soft/30 p-3">
              <p className="text-sm font-medium">{copy.title}</p>
              {copy.onBehalf && <p className="text-xs font-medium text-foreground">{copy.onBehalf}</p>}
              <p className="text-xs text-muted">{copy.body}</p>
              {onBehalf && (
                <label className="block text-xs">
                  <span className="font-semibold">How and when did they approve? (required)</span>
                  <input type="text" value={how} onChange={(e) => setHow(e.target.value)} maxLength={300} placeholder="For example: by text, Oct 15" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-surface px-3 text-base outline-none focus:border-brand sm:text-sm" />
                </label>
              )}
              {draftWarning}
              {open.length > 0 && (
                <fieldset className="space-y-1.5 text-sm">
                  <legend className="text-xs font-semibold">{onBehalf ? `There ${open.length === 1 ? "is" : "are"}` : "You have"} {open.length} open note{open.length === 1 ? "" : "s"}. What should we do with {open.length === 1 ? "it" : "them"}?</legend>
                  <label className="flex items-start gap-2"><input type="radio" name="notes" checked={choice === "DISCARD"} onChange={() => setChoice("DISCARD")} className="mt-1 accent-[var(--brand)]" /> <span>Nothing needs changing, so mark {open.length === 1 ? "it" : "them"} resolved</span></label>
                  <label className="flex items-start gap-2"><input type="radio" name="notes" checked={choice === "INCLUDE"} onChange={() => setChoice("INCLUDE")} className="mt-1 accent-[var(--brand)]" /> <span>Send {open.length === 1 ? "it" : "them"} along as notes for the team (no new version)</span></label>
                  {choice === null && <p className="text-xs text-muted-2">Pick one before you approve.</p>}
                </fieldset>
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={approve} disabled={busy || draftBlocks || (open.length > 0 && choice === null) || (onBehalf && !howOk)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-success-action px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3.5 animate-spin" />} {copy.confirm}</button>
                <button type="button" onClick={() => setApproving(false)} className="min-h-11 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Not yet</button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}

      {/* Version history — visible, with what happened to each. */}
      {versions.length > 1 && (
        <div className="border-t border-border pt-2">
          <button type="button" onClick={() => setShowHistory((s) => !s)} className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
            <History className="size-3.5" /> Version history ({versions.length})
          </button>
          {showHistory && (
            <ol className="mt-2 space-y-1.5">
              {[...versions].reverse().map((v) => (
                <li key={v.submissionId} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Version {v.clientVersion}</span>
                    <StateChip state={v.clientState} mine={yours(v)} />
                    {v.releasedAtISO && <span className="text-muted-2">shared {fmtWhen(v.releasedAtISO)}</span>}
                    <span className="text-muted-2">{v.comments.length} note{v.comments.length === 1 ? "" : "s"}</span>
                  </div>
                  {v.decisions.map((d) => <div key={d.id} className="mt-0.5 text-muted">{d.decision === "APPROVE" ? "Approved" : "Changes requested"} by {d.actorLabel} on {fmtWhen(d.decidedAtISO)}{d.receiptState === "SUPERSEDED" ? " (superseded)" : ""}</div>)}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
        </div>
      </div>
    </div>
  );
}

/** The player and its right-click guard, memoised: with the same props (and
 *  CutReview only ever passes stable ones) React never re-renders it, so
 *  nothing typed or clicked elsewhere on the page reaches the <video>. */
export const PlayerFrame = memo(function PlayerFrame({ boxRef, playerRef, src, poster, onError }: {
  boxRef: RefObject<HTMLDivElement | null>;
  playerRef: RefObject<PortalPlayerHandle | null>;
  src: string;
  poster: string | null;
  onError: () => void;
}) {
  return (
    <div ref={boxRef} onContextMenu={(e) => e.preventDefault()}>
      <PortalPlayer ref={playerRef} src={src} poster={poster} onError={onError} />
    </div>
  );
});

// ---------------------------------------------------------------------------
// THE NOTE BOX. Owns its own text, so typing re-renders this box and nothing
// else on the page (the player above all). It tells the page only when the box
// goes from empty to not and back (onDraftChange), and the page asks it to
// send or discard through the handle.
//
//   · the text autosaves on this device per cut (localStorage, every access
//     guarded: a private window or blocked storage just means no autosave);
//   · a draft found on the way in is put back, with a line saying it was kept;
//   · while there is text, leaving the page asks first (the browser's own
//     prompt on reload or close, a confirm on a link inside the portal);
//   · a sent note clears the draft and says plainly that we have it.
// ---------------------------------------------------------------------------

export type NoteComposerHandle = { send(): Promise<boolean>; discard(): void };

function readDraft(key: string): string {
  try { return window.localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function writeDraft(key: string, text: string): void {
  try {
    if (text.trim()) window.localStorage.setItem(key, text);
    else window.localStorage.removeItem(key);
  } catch { /* storage unavailable: the box still holds the text */ }
}

/** A click on a link that would take this tab to another page: the only clicks
 *  the unsent-note confirm interrupts (a new tab, a download or a jump on the
 *  same page are left alone). */
export function leavesThePage(a: { href: string; target?: string | null; hasDownload?: boolean }, here: { href: string }): boolean {
  if ((a.target && a.target !== "_self") || a.hasDownload) return false;
  try {
    const to = new URL(a.href, here.href);
    const now = new URL(here.href);
    if (!/^https?:$/.test(to.protocol)) return false; // tel:, mailto:, sms: open another app
    return !(to.origin === now.origin && to.pathname === now.pathname && to.search === now.search);
  } catch {
    return false;
  }
}

function NoteComposer({ ref, submissionId, player, playerFailed, afterSend, onDraftChange }: {
  ref?: Ref<NoteComposerHandle>;
  submissionId: string;
  player: RefObject<PortalPlayerHandle | null>;
  playerFailed: boolean;
  /** The next step after a note lands, in the page's words. */
  afterSend: string;
  /** Called when the box goes from empty to holding text, and back. */
  onDraftChange: (hasDraft: boolean) => void;
}) {
  const router = useRouter();
  const key = noteDraftKey(submissionId);
  const [text, setText] = useState("");
  const [restored, setRestored] = useState(false);
  const [atTime, setAtTime] = useState(true);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  // The newest text for the handle, which may be called between renders.
  const latest = useRef("");
  const has = text.trim().length > 0;

  // A draft left on this device (a reload, a flash, a closed tab) comes back.
  useEffect(() => {
    const saved = readDraft(key);
    if (!saved.trim()) return;
    latest.current = saved;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- storage exists only in the browser, after hydration
    setText(saved);
    setRestored(true);
  }, [key]);

  useEffect(() => { onDraftChange(has); }, [has, onDraftChange]);
  useEffect(() => () => onDraftChange(false), [onDraftChange]);

  // Leaving with an unsent note asks first. The text is on this device either
  // way, so saying "leave" loses nothing.
  useEffect(() => {
    if (!has) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (!(a instanceof HTMLAnchorElement)) return;
      if (!leavesThePage({ href: a.href, target: a.target, hasDownload: a.hasAttribute("download") }, window.location)) return;
      if (!window.confirm(NOTE_COPY.leaveConfirm)) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [has]);

  const update = (v: string) => {
    latest.current = v;
    setText(v);
    setResult(null);
    if (!v.trim()) setRestored(false);
    writeDraft(key, v);
  };

  const send = async (): Promise<boolean> => {
    const body = latest.current.trim();
    if (!body || sending) return false;
    // currentTime() is null until the playhead has really moved. A note typed
    // against a video that never played (or failed to load) is a GENERAL note,
    // not a note pinned to 0:00 — that pin travelled into the editor's work
    // order as "fix the first frame" (review blocker, Sep 17).
    const t = atTime && !playerFailed ? player.current?.currentTime() ?? null : null;
    player.current?.pause();
    setSending(true);
    const fallback = "That didn't send. Your note is still here, so try again.";
    const r = await portalAddComment(portalAuthFromLocation(), submissionId, t, body).catch(() => ({ ok: false, message: fallback }));
    setSending(false);
    if (r.ok) {
      update("");
      setRestored(false);
      setResult({ ok: true, text: afterSend });
      router.refresh();
      return true;
    }
    setResult({ ok: false, text: r.message || fallback });
    return false;
  };
  useImperativeHandle(ref, () => ({ send, discard: () => update("") }));

  return (
    <div>
      {restored && has && <p className="mb-1.5 text-xs font-medium text-warning">{NOTE_COPY.restored}</p>}
      <div className="flex items-start gap-2">
        <textarea value={text} onChange={(e) => update(e.target.value)} placeholder="Pause the video and write what you'd change, or leave a general note" rows={3} aria-label="New note" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-brand sm:text-sm" />
        <button type="button" onClick={() => void send()} disabled={sending || !has} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
          {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-3.5" />} {NOTE_COPY.send}
        </button>
      </div>
      {has && !restored && <p className="mt-1 text-[11px] font-medium text-warning">{NOTE_COPY.unsentHint}</p>}
      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-2">
        <input type="checkbox" checked={atTime && !playerFailed} disabled={playerFailed} onChange={(e) => setAtTime(e.target.checked)} className="accent-[var(--brand)] disabled:opacity-40" /> pin this note to the paused moment
      </label>
      <p className="mt-0.5 text-[11px] text-muted-2">{playerFailed ? "This version isn't playing, so notes are saved as general notes." : "Play the video first. Until you do, a note is saved as a general note."}</p>
      {result && (result.ok ? (
        <div role="status" className="mt-2 rounded-lg border border-success/30 bg-success-soft/40 p-2.5 text-xs">
          <p className="inline-flex items-center gap-1.5 font-semibold text-success"><CheckCircle2 className="size-3.5" /> Got it. We have your note.</p>
          <p className="mt-0.5 text-muted">{result.text}</p>
        </div>
      ) : <p role="alert" className="mt-2 text-xs text-danger">{result.text}</p>)}
    </div>
  );
}

function Note({ c, onSeek }: { c: CommentView; onSeek: (t: number) => void }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {c.timeSec != null ? (
        <button type="button" onClick={() => onSeek(c.timeSec!)} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md bg-brand-soft px-2 text-xs font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" aria-label={`Jump to ${fmtT(c.timeSec)}`}>
          <Clock className="size-3" /> {fmtT(c.timeSec)}
        </button>
      ) : (
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted-2"><MessageSquare className="size-3" /> general</span>
      )}
      <span className="min-w-0 flex-1 leading-snug">
        <span className={cn(c.resolvedAtISO ? "text-muted-2 line-through" : "text-foreground/90")}>{c.body}</span>
        <span className="ml-1.5 text-[11px] text-muted-2">· {c.author}, {fmtWhen(c.createdAtISO)}</span>
      </span>
    </div>
  );
}

function StateChip({ state, mine }: { state: CutVersion["clientState"]; mine: boolean }) {
  const tone = state === "YOU_APPROVED" || state === "AUTO_APPROVED" ? "bg-success-soft text-success" : state === "AWAITING_YOUR_DECISION" ? "bg-brand-soft text-brand" : state === "YOU_REQUESTED_CHANGES" ? "bg-warning-soft text-warning" : "bg-surface-2 text-muted";
  return <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", tone)}>{STATE_LABEL[state][mine ? 0 : 1]}</span>;
}
