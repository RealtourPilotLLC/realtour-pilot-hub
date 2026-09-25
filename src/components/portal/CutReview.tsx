"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, Clock, CornerDownRight, History, Loader2, MessageSquare, Send, ThumbsUp, Trash2, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { portalAddComment, portalApproveCut, portalDeleteComment, portalRequestRevision, portalResolveComment } from "@/app/portal/actions";
import { portalAuthFromLocation } from "@/components/portal/portalAuth";
import { PortalPlayer, type PortalPlayerHandle } from "@/components/portal/PortalPlayer";
import { contactLine } from "@/components/portal/ContactTeam";
import type { CutVersion, CommentView } from "@/lib/clientDecisions";

// ---------------------------------------------------------------------------
// REVIEW & APPROVAL of one video (spec §8). The current released cut plays;
// notes pin to the paused moment (or are general), reply under each other and
// resolve; "Save note" is one thing and "Submit change request" is another;
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

export function CutReview({ versions, perms, readOnly = false, poster = null, signInHref = null }: {
  /** Oldest → newest; assetUrl already carries the media token. */
  versions: CutVersion[];
  perms: { comment: boolean; request: boolean; approve: boolean };
  readOnly?: boolean;
  poster?: string | null;
  /** On the emailed link seat nobody may approve. Where the client goes to get
   *  a seat that can — the only route out of "waiting for approval". */
  signInHref?: string | null;
}) {
  const router = useRouter();
  const current = versions.find((v) => v.isCurrent) ?? null;
  const player = useRef<PortalPlayerHandle>(null);
  const [note, setNote] = useState("");
  const [atTime, setAtTime] = useState(true);
  // The player told us it could not play this file: there is no moment to pin
  // a note to, and the checkbox must not pretend otherwise.
  const [playerFailed, setPlayerFailed] = useState(false);
  const [overall, setOverall] = useState("");
  const [asking, setAsking] = useState(false);
  const [approving, setApproving] = useState(false);
  // No default: §8 asks for a CLEAR choice about open notes, and a pre-picked
  // "discard" would resolve a client's notes without them ever choosing.
  const [choice, setChoice] = useState<"INCLUDE" | "DISCARD" | null>(null);
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
  const canWrite = !readOnly && perms.comment && !approved;
  const done = (r: { ok: boolean; message: string }) => { setMsg({ ok: r.ok, text: r.message }); if (r.ok) router.refresh(); };
  // "your" is right when the reader is the one it is waiting ON, or the one who
  // acted. Nobody has decided an AWAITING version, so there is no actor to
  // compare — the reader's own seat decides the wording there.
  const yours = (v: CutVersion) => (v.clientState === "AWAITING_YOUR_DECISION" ? perms.request || perms.approve || perms.comment : v.decidedByMe);

  const add = () => {
    // currentTime() is null until the playhead has really moved. A note typed
    // against a video that never played (or failed to load) is a GENERAL note,
    // not a note pinned to 0:00 — that pin travelled into the editor's work
    // order as "fix the first frame" (review blocker, Sep 17).
    const t = atTime ? player.current?.currentTime() ?? null : null;
    player.current?.pause();
    const body = note.trim();
    if (!body) return;
    start(async () => {
      const r = await portalAddComment(portalAuthFromLocation(), current.submissionId, t, body).catch(() => ({ ok: false, message: "That didn't save — try again." }));
      if (r.ok) setNote("");
      done(r);
    });
  };
  const sendReply = (parentId: string) => {
    const body = reply.trim();
    if (!body) return;
    start(async () => {
      const r = await portalAddComment(portalAuthFromLocation(), current.submissionId, null, body, parentId).catch(() => ({ ok: false, message: "That didn't save — try again." }));
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
  const approve = () => start(async () => {
    const r = await portalApproveCut(portalAuthFromLocation(), current.submissionId, open.length ? (choice ?? "NONE") : "NONE").catch(() => ({ ok: false, message: "That didn't save — try again." }));
    if (r.ok) setApproving(false);
    done(r);
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Version {current.round}</span>
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

      {current.assetUrl ? (
        <div ref={playerBox} onContextMenu={(e) => e.preventDefault()}>
          <PortalPlayer ref={player} src={current.assetUrl} poster={poster} onError={() => setPlayerFailed(true)} />
        </div>
      ) : <p className="text-sm text-muted">This version has no playable file. {contactLine().replace(/^c/, "C")} and we&rsquo;ll sort it.</p>}

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
                {d.decision === "REQUEST_CHANGES" && <span className="text-muted"> · {d.receiptState === "DONE" ? "done — see the newer version" : d.receiptState === "SUPERSEDED" ? "a newer version replaced this one" : d.receiptState === "ROUTED" || d.receiptState === "IN_PROGRESS" ? "with your editor" : "received"}</span>}
                {d.decision === "APPROVE" && d.openNotesChoice === "INCLUDE" && <span className="text-muted"> · notes sent along</span>}
                {d.decision === "APPROVE" && d.openNotesChoice === "DISCARD" && <span className="text-muted"> · open notes resolved</span>}
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
                  <button type="button" onClick={() => remove(c.id)} disabled={busy} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-2 hover:text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><Trash2 className="size-3" /> Remove</button>
                )}
                {c.status === "SENT" && !c.resolvedAtISO && <span className="inline-flex items-center gap-1 text-success"><CheckCircle2 className="size-3" /> sent</span>}
                {canWrite && (
                  <button type="button" onClick={() => resolve(c.id, !c.resolvedAtISO)} disabled={busy} className="rounded-md px-1.5 py-0.5 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{c.resolvedAtISO ? "Reopen" : "Mark resolved"}</button>
                )}
                {c.resolvedAtISO && <span className="text-muted-2">resolved by {c.resolvedBy}</span>}
                {canWrite && <button type="button" onClick={() => { setReplyTo(replyTo === c.id ? null : c.id); setReply(""); }} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"><CornerDownRight className="size-3" /> Reply</button>}
              </div>
              {c.replies.length > 0 && (
                <ul className="mt-1.5 space-y-1 border-l-2 border-border pl-2.5">
                  {c.replies.map((r) => <li key={r.id} className="text-xs"><span className="font-semibold">{r.author}</span> <span className="text-muted-2">{fmtWhen(r.createdAtISO)}</span><div className="text-foreground/90">{r.body}</div></li>)}
                </ul>
              )}
              {replyTo === c.id && (
                <div className="mt-1.5 flex items-start gap-2">
                  <textarea value={reply} onChange={(e) => setReply(e.target.value)} rows={2} placeholder="Your reply…" aria-label="Reply" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-brand" />
                  <button type="button" onClick={() => sendReply(c.id)} disabled={busy || !reply.trim()} className="shrink-0 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Reply</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Composer: Save note (distinct from sending anything) */}
      {canWrite && (
        <div>
          <div className="flex items-start gap-2">
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Pause the video and write what you'd change — or a general note" rows={3} aria-label="New note" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
            <button type="button" onClick={add} disabled={busy || !note.trim()} className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-semibold text-foreground hover:bg-surface-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Save note"}
            </button>
          </div>
          <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-2">
            <input type="checkbox" checked={atTime && !playerFailed} disabled={playerFailed} onChange={(e) => setAtTime(e.target.checked)} className="accent-[var(--brand)] disabled:opacity-40" /> pin this note to the paused moment
          </label>
          <p className="mt-0.5 text-[11px] text-muted-2">{playerFailed ? "This version isn't playing, so notes are saved as general notes." : "Play the video first — until you do, a note is saved as a general note."}</p>
        </div>
      )}

      {/* The two decisions — separate, explicit. */}
      {!readOnly && !approved && (perms.request || perms.approve) && !(closed && !perms.approve) && (
        <div className="border-t border-border pt-3">
          {!asking && !approving && (
            <div className="flex flex-wrap gap-2">
              {perms.request && !closed && (
                <button type="button" onClick={() => setAsking(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                  <Send className="size-3.5" /> Submit change request{open.length ? ` (${open.length} note${open.length === 1 ? "" : "s"})` : ""}
                </button>
              )}
              {/* Asked for changes on this version? Its approval is the NEW
                  version's to give — the server refuses both verdicts on one cut. */}
              {perms.approve && !requested && (
                <button type="button" onClick={() => setApproving(true)} className="inline-flex items-center gap-1.5 rounded-lg bg-success px-3 py-2 text-sm font-semibold text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
                  <ThumbsUp className="size-3.5" /> Approve this version
                </button>
              )}
            </div>
          )}
          {!perms.approve && perms.request && !asking && !requested && (
            <p className="mt-1.5 text-[11px] text-muted-2">
              Only the program owner can approve a version.
              {signInHref && <> <a href={signInHref} className="font-semibold text-brand hover:underline">Sign in with your email</a> to approve it yourself.</>}
            </p>
          )}
          {asking && (
            <div className="space-y-2">
              <p className="text-xs text-muted">Your {open.length} open note{open.length === 1 ? " goes" : "s go"} with this request as one change list for your editor.{requested ? " A request is already open on this version — new notes join it." : ""}</p>
              <textarea value={overall} onChange={(e) => setOverall(e.target.value)} placeholder="Anything overall? (optional)" rows={2} aria-label="Overall note" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-brand" />
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
                <button type="button" onClick={submitChanges} disabled={busy || (needsAck && !(feeAck && (review?.mayAcknowledge ?? perms.approve)))} className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3.5 animate-spin" />} Send to the editor</button>
                <button type="button" onClick={() => setAsking(false)} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Cancel</button>
              </div>
            </div>
          )}
          {approving && (
            <div className="space-y-2 rounded-xl border border-success/30 bg-success-soft/30 p-3">
              <p className="text-sm font-medium">Approve version {current.round} as final?</p>
              <p className="text-xs text-muted">This records your approval on exactly this cut. If a newer cut ever replaces it, that one will need its own approval.</p>
              {open.length > 0 && (
                <fieldset className="space-y-1.5 text-sm">
                  <legend className="text-xs font-semibold">You have {open.length} open note{open.length === 1 ? "" : "s"} — what should we do with {open.length === 1 ? "it" : "them"}?</legend>
                  <label className="flex items-start gap-2"><input type="radio" name="notes" checked={choice === "DISCARD"} onChange={() => setChoice("DISCARD")} className="mt-1 accent-[var(--brand)]" /> <span>Nothing needs changing — mark {open.length === 1 ? "it" : "them"} resolved</span></label>
                  <label className="flex items-start gap-2"><input type="radio" name="notes" checked={choice === "INCLUDE"} onChange={() => setChoice("INCLUDE")} className="mt-1 accent-[var(--brand)]" /> <span>Send {open.length === 1 ? "it" : "them"} along as notes for the team (no new cut)</span></label>
                  {choice === null && <p className="text-xs text-muted-2">Pick one before you approve.</p>}
                </fieldset>
              )}
              <div className="flex items-center gap-2">
                <button type="button" onClick={approve} disabled={busy || (open.length > 0 && choice === null)} className="inline-flex items-center gap-1.5 rounded-lg bg-success px-3 py-2 text-sm font-semibold text-white disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">{busy && <Loader2 className="size-3.5 animate-spin" />} Yes, approve</button>
                <button type="button" onClick={() => setApproving(false)} className="rounded-lg border border-border px-3 py-2 text-sm text-muted hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">Not yet</button>
              </div>
            </div>
          )}
        </div>
      )}
      {msg && <p role="status" className={cn("text-xs", msg.ok ? "text-success" : "text-danger")}>{msg.text}</p>}

      {/* Version history — visible, with what happened to each. */}
      {versions.length > 1 && (
        <div className="border-t border-border pt-2">
          <button type="button" onClick={() => setShowHistory((s) => !s)} className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand">
            <History className="size-3.5" /> Version history ({versions.length})
          </button>
          {showHistory && (
            <ol className="mt-2 space-y-1.5">
              {[...versions].reverse().map((v) => (
                <li key={v.submissionId} className="rounded-lg border border-border bg-surface px-2.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">Version {v.round}</span>
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
  );
}

function Note({ c, onSeek }: { c: CommentView; onSeek: (t: number) => void }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {c.timeSec != null ? (
        <button type="button" onClick={() => onSeek(c.timeSec!)} className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md bg-brand-soft px-1.5 py-0.5 text-[11px] font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand" aria-label={`Jump to ${fmtT(c.timeSec)}`}>
          <Clock className="size-3" /> {fmtT(c.timeSec)}
        </button>
      ) : (
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted-2"><MessageSquare className="size-3" /> general</span>
      )}
      <span className="min-w-0 flex-1 leading-snug">
        <span className={cn(c.resolvedAtISO ? "text-muted-2 line-through" : "text-foreground/90")}>{c.body}</span>
        <span className="ml-1.5 text-[11px] text-muted-2">— {c.author}, {fmtWhen(c.createdAtISO)}</span>
      </span>
    </div>
  );
}

function StateChip({ state, mine }: { state: CutVersion["clientState"]; mine: boolean }) {
  const tone = state === "YOU_APPROVED" || state === "AUTO_APPROVED" ? "bg-success-soft text-success" : state === "AWAITING_YOUR_DECISION" ? "bg-brand-soft text-brand" : state === "YOU_REQUESTED_CHANGES" ? "bg-warning-soft text-warning" : "bg-surface-2 text-muted";
  return <span className={cn("rounded-md px-1.5 py-0.5 text-[10px] font-semibold", tone)}>{STATE_LABEL[state][mine ? 0 : 1]}</span>;
}
