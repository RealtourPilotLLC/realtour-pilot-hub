"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { upload } from "@vercel/blob/client";
import { AlertTriangle, ArrowRight, CheckCircle2, CloudUpload, Loader2, MessageSquarePlus, RotateCcw, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
// The 1080p export spec and its words, from the file that owns both
// (lib/videoStyles — plain data and pure functions, safe in a client bundle).
import { protectUploadWorkspace } from "@/lib/uploadNavigation";
import { EXPORT_SPEC, exportRefusal, isOverExportSpec, resolutionLabel } from "@/lib/videoStyles";
import { startCutUpload, finishCutUpload, abandonCutUpload, cutTakeBackFlags } from "@/app/review/actions";
import { cutUploadFinishReceipt } from "@/lib/cutUploadFinishReceipt";
import { saveCutMessage } from "@/components/editing/cutMessage.actions";
import { CutTakeBack, CutTakeBackFlags } from "@/components/review/CutTakeBack";
import type { CutTakeBackInfo } from "@/components/review/types";
import { SelfCheckDialog, type SelfCheckContextView } from "@/components/editing/SelfCheckDialog";
import type { SelfCheckInput } from "@/lib/selfCheck";
import { firstName, verdictLine, type Verdict } from "@/lib/reviewAttribution";
import { StillWorkingPrompt } from "@/components/editing/StillWorkingPrompt";
import { stillWorkingRemaining } from "@/lib/editorDesk";
import { uploadPanelSummary, type UploadPanelSummary, type UploadPanelVideo } from "@/app/review/selfCheckActions";

// ---------------------------------------------------------------------------
// "Upload version N" — the editor's way into the Review Room (Jordan, Sep 1:
// cuts come in through the editor portal as Version 1, get reviewed, come
// back with revisions marked, and on approval go to Dropbox and get marked
// complete — per deliverable). One row per cut the job owes.
//
// The file goes straight from this browser to the hub's store in resumable
// parts (nothing large touches a server); the server only hands out a
// path-scoped token and records the result.
//
// Each row also carries the editor's MESSAGE to whoever reviews it (Jordan,
// Sep 2: "no border version", "couldn't fix the audio at 0:42"). It is stored
// on the submission's own note field, so the Review Room shows it next to that
// cut with nothing new to wire up.
// ---------------------------------------------------------------------------

// THE ONE LINE THAT FLIPS THE CUT STORE (RTP-01, Sep 17). `access` is the
// BROWSER's decision, not the server's: the SDK turns it into the
// `x-vercel-blob-access` header on this client's own PUT (createPutHeaders,
// @vercel/blob 2.8.0), and the signed token the hub hands back cannot overrule
// it — onBeforeGenerateToken's return type is
// Pick<GenerateClientTokenOptions,'allowedContentTypes'|'maximumSizeInBytes'
// |'validUntil'|'addRandomSuffix'|'allowOverwrite'|'cacheControlMaxAge'
// |'ifMatch'>, which has no `access` key at all. That is why the fix for 14
// world-readable client videos has to be made here and not in the route that
// audits the upload.
//
// So it reads an environment variable instead of a literal: the day the store
// is replaced with a private one, the hub's side of the change is
// NEXT_PUBLIC_REVIEW_CUT_ACCESS=private in Vercel plus a redeploy, and nobody
// has to find this file. It is NOT flipped ahead of the store: private access
// against the public store that exists today is refused by the control plane
// ("Cannot use private access on a public store") and every editor's upload
// stops that minute. Store first, rows moved second, token third, THIS
// VARIABLE LAST — docs/REVIEW-CUT-STORE-HANDOVER.md §3 has the order and why
// each step is where it is. No private upload has ever been performed, so the
// first one is the test. The finalize no longer refuses a private upload (Sep
// 18: finishCutUpload accepts an object on any store the hub holds a token for,
// under review-cuts/ — see that note's §2), so this upload path needs no
// further change before an editor meets the private store.
//
// Sep 25 2026: the server now says which store this upload is for —
// startCutUpload returns `access` from reviewCuts.cutStoreAccess(), which
// follows the private store's connection. This constant is only the fallback
// for a server that predates that field.
const CUT_STORE_ACCESS = process.env.NEXT_PUBLIC_REVIEW_CUT_ACCESS === "private" ? "private" : "public";

export type CutRow = {
  deliverableId: string;
  slot: number;
  label: string;
  latest: {
    id: string; round: number; status: string; fileName: string | null; completedAt: string | null; note: string | null;
    /** What that version actually was, when we could measure it (Sep 16). */
    sourceWidth: number | null; sourceHeight: number | null;
    /** §8.2: uploaded but waiting on the send-for-review check — not in
     *  front of the reviewer yet. */
    held?: boolean;
    /** Who ruled on it, and when (Sep 28) — named on the pill. */
    verdict?: Verdict | null;
  } | null;
  openNotes: number;
  /**
   * May THIS viewer replace the approved video on THIS slot? The /edit page
   * gets it from the server's own uploadAuthor, per row (canReplaceApprovedCut)
   * — never from the role, which is how ten doors came to be drawn over a
   * refusal the editor only met after choosing the file and typing their reason
   * (drill, Sep 18). Absent = no door, which is the safe way round for a caller
   * that hasn't asked.
   */
  canReplace?: boolean;
};

const fmtBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);

// ---------------------------------------------------------------------------
// THE EXPORT CHECK — read the file's shape BEFORE a byte is uploaded.
//
// The browser already knows: hand a <video> a blob: URL of the chosen file and
// `loadedmetadata` carries videoWidth/videoHeight, rotation already applied, in
// a few milliseconds and with nothing sent anywhere. Doing it here rather than
// server-side is the whole point — a 355 MB 4K upload that gets refused on
// arrival has already cost an editor twenty minutes of their evening.
//
// It FAILS OPEN, deliberately and in three ways: an unreadable header, a codec
// the browser won't decode, or a machine slow enough to miss the timeout all
// resolve to null, and null is not a refusal. The server records what really
// arrived afterwards (review/actions recordArrivedDimensions). A diagnostic
// must never be the thing that stops an editor delivering.
// ---------------------------------------------------------------------------
const EXPORT_CHECK_TIMEOUT_MS = 8_000;

function readDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    let el: HTMLVideoElement;
    let url: string;
    try {
      el = document.createElement("video");
      url = URL.createObjectURL(file);
    } catch {
      resolve(null); // no object URLs (a locked-down browser) — let it through
      return;
    }
    // One holder so the timeout can be cleared from inside the handler it
    // races (and so the whole thing resolves exactly once, whichever wins).
    const run: { timer?: ReturnType<typeof setTimeout>; done: boolean } = { done: false };
    const finish = (v: { width: number; height: number } | null) => {
      if (run.done) return;
      run.done = true;
      if (run.timer) clearTimeout(run.timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      el.removeAttribute("src");
      el.load(); // drop the decoder's hold on the file before we revoke the URL
      URL.revokeObjectURL(url);
      resolve(v);
    };
    run.timer = setTimeout(() => finish(null), EXPORT_CHECK_TIMEOUT_MS);
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () =>
      finish(el.videoWidth > 0 && el.videoHeight > 0 ? { width: el.videoWidth, height: el.videoHeight } : null);
    el.onerror = () => finish(null);
    el.src = url;
  });
}

// The hourly folder sweep parks its OWN provenance line in the same column
// ("Cut detected in the Dropbox Final folder — auto-entered for review.").
// That is the system talking, not the editor: 11 of the 13 cuts on file carry
// it. Never show it as somebody's message and never pre-fill the composer with
// it — the editor would end up "editing" a sentence they never wrote.
const AUTO_NOTE = /^Cut detected in the Dropbox Final folder/i;
const editorMessage = (n: string | null | undefined) => (n && !AUTO_NOTE.test(n) ? n : null);

function StatusPill({ latest, reopened, officeReopen }: { latest: CutRow["latest"]; reopened?: boolean; officeReopen?: { by: string | null } | null }) {
  if (!latest) return <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted">Not uploaded yet</span>;
  if (latest.status === "APPROVED" && reopened) {
    // The client asked for changes after this version was approved — the
    // slot takes the corrected cut as the next version (Sep 8). Unless it was
    // the OFFICE that put the job back (the queue-add): then it says who, not
    // "client" (review, Sep 28).
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
        <Undo2 className="size-3" /> v{latest.round} approved · {officeReopen ? `reopened by ${firstName(officeReopen.by) ?? "the office"}` : "client asked for changes"}
      </span>
    );
  }
  // WHO, on the pill (Sep 28): the first name fits; the whole line and the
  // time are on the hover.
  const v = latest.verdict ?? null;
  const who = v?.source === "office" ? firstName(v.by) : null;
  if (latest.status === "APPROVED") {
    return (
      <span title={verdictLine(v) ?? undefined} className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
        <CheckCircle2 className="size-3" /> Approved{who ? ` by ${who}` : ""}{latest.completedAt ? " · in Dropbox" : " · copying to Dropbox"}
      </span>
    );
  }
  if (latest.status === "CHANGES_REQUESTED") {
    return (
      <span title={verdictLine(v) ?? undefined} className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
        <Undo2 className="size-3" />{" "}
        {v?.source === "client" ? `The client asked for changes on v${latest.round}` : `Changes requested on v${latest.round}${who ? ` by ${who}` : ""}`}
      </span>
    );
  }
  // Withdrawn (rows from the afternoon of Sep 16 only — a take-back deletes
  // the version now). Nothing is in front of the reviewer, and v{round} is
  // free again for the right file.
  if (latest.status === "WITHDRAWN") {
    return <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-muted"><Undo2 className="size-3" /> v{latest.round} withdrawn</span>;
  }
  if (latest.status === "PENDING" && latest.held) {
    return <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">v{latest.round} waiting on your check</span>;
  }
  return <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">v{latest.round} in review</span>;
}

// The message that rides with one cut. Two shapes, because a message belongs to
// a VERSION, not to a slot:
//  · the version is already with the reviewer (PENDING) → editing it saves
//    straight onto that submission, so the reviewer sees the correction;
//  · nothing uploaded yet, or the last version was bounced → the next upload is
//    the one this message is about, so it is held here and sent up with it.
function CutMessage({
  savedNote,
  liveTargetId,
  draft,
  onDraft,
  nextVersion,
  canWrite,
  onSaved,
}: {
  savedNote: string | null;
  liveTargetId: string | null;
  draft: string;
  onDraft: (v: string) => void;
  nextVersion: number | null;
  canWrite: boolean;
  onSaved: (note: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, start] = useTransition();

  // Nothing to write and nothing written — say nothing.
  if (!canWrite && !savedNote) return null;

  const save = () => {
    if (!liveTargetId) {
      // Draft: no version exists to attach it to yet, so hold it for the upload.
      onDraft(text.trim());
      setOpen(false);
      return;
    }
    start(async () => {
      setErr(null);
      const r = await saveCutMessage(liveTargetId, text).catch(() => ({ ok: false as const, message: "That didn't save — try again." }));
      if (!r.ok) setErr(r.message);
      else {
        onSaved(text.trim() || null);
        setOpen(false);
      }
    });
  };

  if (open) {
    return (
      <div className="mt-2 space-y-1.5">
        <textarea
          autoFocus
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={1000}
          placeholder="e.g. no border version · client's logo added · couldn't fix the audio at 0:42"
          className="w-full resize-none rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-sm outline-none focus:border-brand"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
          >
            {saving && <Loader2 className="size-3 animate-spin" />}
            {liveTargetId ? "Save message" : `Send with version ${nextVersion ?? ""}`.trim()}
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); setErr(null); }}
            className="rounded-lg border border-border px-2.5 py-1 text-[11px] font-medium text-muted hover:bg-surface-2"
          >
            Cancel
          </button>
          {err && <span className="text-[11px] text-danger">{err}</span>}
        </div>
      </div>
    );
  }

  // In draft mode the message on the LAST version is not shown: it belongs to
  // a cut the reviewer has already seen (and the round history still carries
  // it) — reprinting it here reads as if it were about the version they are
  // uploading next.
  // Read-only viewers (and an approved cut, where nobody rewrites what the
  // reviewer signed off) always see the message that was actually sent.
  const shown = liveTargetId || !canWrite ? savedNote : (draft || null);
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {shown ? (
        <p className="min-w-0 flex-1 text-xs italic leading-relaxed text-foreground/75">
          &ldquo;{shown}&rdquo;
          {!liveTargetId && canWrite && (
            <span className="ml-1.5 not-italic text-[10px] font-semibold uppercase tracking-wide text-muted-2">goes with version {nextVersion}</span>
          )}
        </p>
      ) : null}
      {canWrite && (
        <button
          type="button"
          onClick={() => { setText(liveTargetId ? (savedNote ?? "") : draft); setOpen(true); }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted hover:bg-surface-2 hover:text-foreground"
        >
          <MessageSquarePlus className="size-2.5" /> {shown ? "Edit message" : "Message for the reviewer"}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// THE HAND-IN, SAID AT ONCE (Jordan, Oct 5: "smooth and seamless and every
// action instant"). The moment the bytes finish, the top of this panel says
// what happened — "Video 1 v1 sent to James for review" — with the
// still-working question under it and a one-tap way to the next owed video.
// The finalize runs behind it; if it fails, the same card says so plainly and
// offers "Try again" (the bytes are kept — a retry is the same finish call,
// which answers "Already in review." when the store's callback beat it).
//
// It used to be lost: the finalize refreshed the page, the page (with no video
// in its URL) opened on the NEXT un-uploaded video, this panel was handed only
// that video's row, and the "still working?" card for the one just sent never
// drew. So before the finalize is even sent, the URL is pinned to the video
// just handed in (?output=<id>, the parameter the page already reads), and the
// refresh the finalize triggers re-renders THAT video.
// ---------------------------------------------------------------------------

/** "Video 1 v1 sent to James for review" — the reviewer is who a new version
 *  goes to first (the review seats), or the one actually holding it once the
 *  hub has assigned it; nobody set up reads "the review team". */
export function handInLine(what: string, round: number, reviewer: string | null | undefined): string {
  return `${what} v${round} sent to ${reviewer?.trim() || "the review team"} for review`;
}

/** The next video on the job that still owes a cut, after this one in the
 *  page's own numbering (wrapping round to an earlier one). */
export function nextOwedVideo(videos: readonly UploadPanelVideo[], currentKey: string, alsoOpen: readonly string[] = []): UploadPanelVideo | null {
  const ordered = [...videos].sort((a, b) => a.number - b.number);
  const here = ordered.find((v) => v.key === currentKey)?.number ?? 0;
  const owed = ordered.filter((v) => v.key !== currentKey && !!v.outputId && (v.open || alsoOpen.includes(v.key)));
  return owed.find((v) => v.number > here) ?? owed[0] ?? null;
}

export type HandInPhase = "confirming" | "done" | "problem";

/** The card at the top of the panel after a version is handed in. Pure
 *  presentation — CutUploader owns the state and the calls. */
export function UploadSentCard({
  what, round, reviewer, phase, problem = null, retrying = false, onRetry, prompt = null, receipt = null, next = null,
}: {
  /** "Video 1" — the page's own number for it */
  what: string;
  round: number;
  reviewer: string | null;
  phase: HandInPhase;
  /** why it isn't confirmed (phase "problem") */
  problem?: string | null;
  retrying?: boolean;
  onRetry?: () => void;
  /** the still-working question, when this viewer may be asked */
  prompt?: ReactNode;
  receipt?: string | null;
  next?: { href: string; label: string; onNavigate?: () => void } | null;
}) {
  return (
    <div className={cn("border-b px-4 py-3 sm:px-5", phase === "problem" ? "border-warning/40 bg-warning-soft/40" : "border-border bg-success/5")} role="status">
      {phase === "problem" ? (
        <>
          <p className="flex items-start gap-2 text-sm font-semibold text-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
            <span>{what} v{round} is uploaded, but the hub hasn&rsquo;t confirmed it&rsquo;s in review yet.</span>
          </p>
          {problem && <p className="mt-1 pl-6 text-xs leading-relaxed text-foreground/85">{problem}</p>}
          {onRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="ml-6 mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-60"
            >
              {retrying ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />} Try again
            </button>
          )}
        </>
      ) : (
        <p className="flex items-start gap-2 text-sm font-semibold text-foreground">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
          <span>
            {handInLine(what, round, reviewer)}
            {phase === "confirming" && <span className="ml-1.5 text-xs font-normal text-muted">· confirming…</span>}
          </span>
        </p>
      )}
      {prompt}
      {receipt && <p className="mt-1.5 text-xs text-success">{receipt}</p>}
      {next && (
        <Link
          href={next.href}
          onClick={next.onNavigate}
          className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-semibold text-foreground hover:bg-surface-2"
        >
          Next: {next.label} <ArrowRight className="size-4" />
        </Link>
      )}
    </div>
  );
}

type HandIn = {
  key: string;
  round: number;
  submissionId: string;
  url: string;
  pathname: string;
  phase: HandInPhase;
  problem: string | null;
  /** the reviewer the hub actually assigned, once it says */
  sentTo: string | null;
  /** the still-working question was answered (or declined) */
  answered: boolean;
  /** the editor's message typed before the file existed, to save on the version */
  message: string;
  /** the page's URL once pinned to this video — a later re-pin never pulls an
   *  editor back who has moved on to another video meanwhile */
  pinnedHref: string | null;
};

// reopenedSlotKeys: approved videos whose own slot has a newer named ask.
// A job-level revision does not say every approved video needs replacing.
// canOverrideExport: OWNER/ADMIN. Jordan or Kyle will occasionally have a
// reason to send an over-spec file anyway, and a hard wall at 6pm with a client
// waiting is its own kind of failure. An EDITOR never sees that button — and
// this prop only decides whether it is DRAWN: startCutUpload checks the real
// role and records the override with a name on it (a browser's claim about who
// it is has never been worth anything).
// checks (§8.2): the send-for-review checklist per slot, keyed
// `${deliverableId}:${slot}` — the list in force for that product, whether it
// is a revision, and the notes still open on it. onBehalfOf: the office is
// uploading for an editor or a vendor; the dialog says so and the server
// records it.
// stillWorking (Jordan, Sep 28): set by the page ONLY for the editor who could
// press Start on this job and is not on it right now — never the office, a
// preview, a blocked editor or the outside shop. After a version of theirs
// lands, the row asks "Are you still working on this job?" (StillWorkingPrompt)
// while other videos are still owed here. Asked, never assumed: this panel
// calls no work action itself, and "No" writes nothing.
// jobSummary (Oct 5): the job-level facts (approved count, first reviewer,
// every owed video's number and topic). Optional — the panel reads them itself
// (selfCheckActions.uploadPanelSummary) and re-reads whenever a version moves.
export function CutUploader({
  projectId, cuts, canUpload, reopenedSlotKeys = [], officeReopen = null, canOverrideExport = false, checks = {}, onBehalfOf = null, stillWorking = null, jobSummary = null,
}: {
  projectId: string; cuts: CutRow[]; canUpload: boolean; reopenedSlotKeys?: string[];
  /** Every open video-lane ask is the office's reopen (officeReopenOf). */
  officeReopen?: { by: string | null } | null;
  canOverrideExport?: boolean;
  checks?: Record<string, SelfCheckContextView>; onBehalfOf?: string | null;
  stillWorking?: { openSlotKeys: string[]; elsewhereStreet: string | null; paused: boolean } | null;
  jobSummary?: UploadPanelSummary | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  // The version just handed in (from the moment its bytes finished), and the
  // Start's own sentence once the editor has answered Yes.
  const [sent, setSent] = useState<HandIn | null>(null);
  const [receipt, setReceipt] = useState<{ key: string; text: string } | null>(null);
  const [retrying, setRetrying] = useState(false);
  // The job's own facts — the count, the first reviewer, the videos in order.
  const [summary, setSummary] = useState<UploadPanelSummary | null>(jobSummary);
  const summaryNow = useRef<UploadPanelSummary | null>(jobSummary);
  summaryNow.current = summary;
  // THE CHECK COMES BEFORE THE BYTES (§8.2). A file picked for a slot opens
  // the checklist first; the answers ride up with startCutUpload and the
  // server binds them to what lands. They are kept per slot for the SAME file
  // only, so the approved-cut reason box or an owner's "send it anyway" does
  // not ask twice — and a different export always asks again.
  // `context` is the list the SERVER says is in force, when it refused the
  // last answers (review, Oct 5 night): reopening the page-load copy asked the
  // same lines again, missed the note that had just arrived, and was refused
  // again — a loop the editor could not get out of.
  type Pending = { cut: CutRow; file: File; dim: { width: number; height: number } | null; override: boolean; reopenReason?: string; notice?: string | null; context?: SelfCheckContextView | null };
  const [checking, setChecking] = useState<Pending | null>(null);
  const [checked, setChecked] = useState<Record<string, { input: SelfCheckInput; name: string; size: number }>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [busy, setBusy] = useState<Record<string, { pct: number; label: string }>>({});
  const hasUploadInProgress = Object.keys(busy).length > 0;
  useEffect(() => {
    if (!hasUploadInProgress && !checking) return;
    return protectUploadWorkspace(() => {
      setErr((previous) => ({ ...previous, [cuts[0] ? `${cuts[0].deliverableId}:${cuts[0].slot}` : "navigation"]: "Finish or cancel this upload before switching videos. This file remains attached to the selected output." }));
    });
  }, [hasUploadInProgress, checking, cuts]);
  const [err, setErr] = useState<Record<string, string>>({});
  // Messages typed before the file exists (held until the upload creates the
  // version they belong to) and messages already saved this session (so the row
  // reads right without waiting on the refresh).
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string | null>>({});
  // A file the export check stopped, held so it can still be sent (owner/admin)
  // or simply replaced — the picker is one click away either way.
  const [blocked, setBlocked] = useState<Record<string, { file: File; width: number; height: number }>>({});
  const clearBlocked = (key: string) => setBlocked((s) => { const n = { ...s }; delete n[key]; return n; });
  // A file for a video that is ALREADY APPROVED, held until the editor says why
  // they are replacing it (Jordan, Sep 18: "they need a way to re upload content
  // after it was already approved submitted and delivered"). The server refuses
  // without a reason and answers needsReason, so this box is drawn from the
  // server's answer rather than from the browser's guess about the cut's state —
  // the browser's copy of "is it approved" can be a minute old.
  const [reopen, setReopen] = useState<Record<string, { file: File; dim: { width: number; height: number } | null; override: boolean }>>({});
  const clearReopen = (key: string) => setReopen((s) => { const n = { ...s }; delete n[key]; return n; });
  // THE WORDS, HELD APART FROM THE FILE (Sep 18 review). They used to live on
  // the reopen entry, so every path that rebuilt that entry — re-picking the
  // file, or the server answering needsReason a second time — retyped the box
  // as "". A sentence somebody wrote about why a delivered video is wrong is
  // not something to throw away because they changed which export they are
  // sending. It survives here until the upload the reason belongs to lands.
  const [reopenWhy, setReopenWhy] = useState<Record<string, string>>({});
  // Remove / move state per version (Sep 16). The /edit page hands this panel
  // the cut rows, not these columns, so the panel asks for them itself — one
  // read per job, re-read whenever a version changes here or a control fires.
  const [flags, setFlags] = useState<Record<string, CutTakeBackInfo>>({});
  const [tick, setTick] = useState(0);
  const sig = useMemo(
    () => cuts.map((c) => `${c.deliverableId}:${c.slot}:${c.latest?.id ?? ""}:${c.latest?.status ?? ""}`).join("|"),
    [cuts],
  );
  useEffect(() => {
    let live = true;
    void cutTakeBackFlags(projectId)
      .then((rows) => { if (live) setFlags(Object.fromEntries(rows.map((r) => [r.submissionId, r]))); })
      .catch(() => { /* the panel works without the flags */ });
    return () => { live = false; };
  }, [projectId, sig, tick]);
  useEffect(() => {
    let live = true;
    void uploadPanelSummary(projectId)
      .then((r) => { if (live && r) setSummary(r); })
      .catch(() => { /* the panel works without the job's totals */ });
    return () => { live = false; };
  }, [projectId, sig]);

  // Picking a file runs the export check first, then hands off to send(). The
  // check is local and quick; an over-spec file never reaches the network.
  //
  // `replacing` is the approved-cut door (the control at the foot of the row).
  // It takes the file to the reason box directly instead of firing an upload
  // the server is certain to turn down, purely so the editor can read the
  // refusal and discover the box exists. Nothing about the RULE moves: the
  // server re-reads the cut's real state on the send that follows, and a reason
  // it turns out not to need is ignored rather than filed.
  async function begin(cut: CutRow, file: File, replacing = false) {
    setSent(null);
    setReceipt(null);
    setRetrying(false);
    const key = `${cut.deliverableId}:${cut.slot}`;
    setErr((e) => ({ ...e, [key]: "" }));
    clearBlocked(key);
    // A NEW FILE RETIRES THE HELD ONE. Both cards below hold a File, and
    // whichever one is drawn is the file the next press sends — so a row that
    // shows the refusal card and the reason card at the same time is a row
    // where "Replace it" quietly sends the export they just replaced (Sep 18
    // review). Only the words survive a re-pick; the override does not, because
    // the check below is about to decide it again for the file actually chosen.
    clearReopen(key);
    setBusy((b) => ({ ...b, [key]: { pct: 0, label: "Checking the export…" } }));
    const dim = await readDimensions(file);
    if (dim && isOverExportSpec(dim.width, dim.height)) {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setBlocked((s) => ({ ...s, [key]: { file, width: dim.width, height: dim.height } }));
      return;
    }
    if (replacing) {
      // Asked AFTER the export check and never before: a reason typed for a 4K
      // file that is about to be refused anyway is a sentence written for
      // nothing. Any words already in the box survive re-picking the file.
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setReopen((r) => ({ ...r, [key]: { file, dim, override: false } }));
      return;
    }
    await send(cut, file, dim, false);
  }

  // `dim` is what the browser measured (null = it couldn't); `override` is an
  // owner/admin knowingly sending an over-spec file. Both ride up to the server
  // so the row records what arrived and who waved it through.
  async function send(cut: CutRow, file: File, dim: { width: number; height: number } | null, override: boolean, reopenReason?: string, selfCheck?: SelfCheckInput) {
    const key = `${cut.deliverableId}:${cut.slot}`;
    const kept = checked[key];
    const check = selfCheck ?? (kept && kept.name === file.name && kept.size === file.size ? kept.input : null);
    if (!check) {
      // No check for THIS file yet: the list first, the bytes after. The row
      // is not busy while the list is open (begin() set "Checking the export…").
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setChecking({ cut, file, dim, override, reopenReason });
      return;
    }
    setErr((e) => ({ ...e, [key]: "" }));
    setBusy((b) => ({ ...b, [key]: { pct: 0, label: "Starting…" } }));
    const started = await startCutUpload({
      projectId, deliverableId: cut.deliverableId, slot: cut.slot, fileName: file.name, sizeBytes: file.size,
      width: dim?.width ?? null, height: dim?.height ?? null, overrideExportSpec: override,
      ...(reopenReason ? { reopenReason } : {}),
      selfCheck: check,
    })
      .catch(() => ({ ok: false as const, message: "Couldn't start the upload — try again." }));
    if (!started.ok) {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      // The server would not take the check (a note arrived on this video
      // meanwhile, or the list changed): back to the list, with its reason.
      if ("needsSelfCheck" in started && started.needsSelfCheck) {
        setChecked((s) => { const n = { ...s }; delete n[key]; return n; });
        setChecking({ cut, file, dim, override, reopenReason, notice: started.message, context: "checkContext" in started ? started.checkContext ?? null : null });
        return;
      }
      // The video is approved and nobody has asked for changes: hold the file
      // and ask why, rather than sending the editor away with a refusal. The
      // override the server was already sent rides along, so an owner who
      // waved a large export through does not have to wave it through twice.
      if ("needsReason" in started && started.needsReason) {
        setReopen((r) => ({ ...r, [key]: { file, dim, override } }));
        // The refusal card was holding this same file for exactly this reason,
        // and it has now moved into the card below. Leaving it drawn put two
        // cards on the row, each with its own way to send (Sep 18 review) —
        // and clearing it here is safe where clearing it before the call was
        // not, because the File reference is in the reopen entry above.
        clearBlocked(key);
        setErr((e) => ({ ...e, [key]: started.message }));
        return;
      }
      setErr((e) => ({ ...e, [key]: started.message }));
      return;
    }
    clearReopen(key);
    // The reason has been accepted and filed on the job's timeline by the line
    // above, so the words have somewhere permanent to be and the box can empty.
    setReopenWhy((w) => { const n = { ...w }; delete n[key]; return n; });
    // The reservation exists, so the refusal card (and the file it was holding)
    // has done its job and can go. NOT a moment earlier (Sep 16 review): if the
    // server turns an override down — a session that timed out, a role that
    // changed, a job no longer on the order — clearing first would have thrown
    // away the File reference too, and Jordan or Kyle would be picking the same
    // file off disk again to read the reason why.
    clearBlocked(key);
    let blob: { url: string; pathname: string };
    try {
      const b = await upload(started.pathname, file, {
        access: started.access ?? CUT_STORE_ACCESS,
        handleUploadUrl: "/api/review/upload",
        clientPayload: JSON.stringify({ submissionId: started.submissionId }),
        multipart: true,
        contentType: file.type || "application/octet-stream",
        onUploadProgress: ({ percentage }) => setBusy((b) => ({ ...b, [key]: { pct: percentage, label: `Uploading ${fmtBytes(file.size)}…` } })),
      });
      blob = { url: b.url, pathname: b.pathname };
    } catch (e) {
      // Nothing landed, so the reservation is released. (Once bytes HAVE
      // landed nothing here ever abandons them — see confirm below.)
      await abandonCutUpload(started.submissionId, null).catch(() => {});
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setErr((er) => ({ ...er, [key]: e instanceof Error && e.message ? e.message : "The upload failed — try again." }));
      return;
    }
    // THE BYTES ARE IN: say so now (Oct 5). The check was for this file and has
    // done its job; the row stops being busy; the version's saved-note memory
    // belongs to the version that just went (the fresh render carries the truth).
    setChecked((s) => { const n = { ...s }; delete n[key]; return n; });
    setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
    setSaved((s) => { const n = { ...s }; delete n[key]; return n; });
    const handIn: HandIn = {
      key, round: started.round, submissionId: started.submissionId, url: blob.url, pathname: blob.pathname,
      phase: "confirming", problem: null, sentTo: null, answered: false, message: (draft[key] ?? "").trim(), pinnedHref: null,
    };
    // Pinned BEFORE the finish is sent, so the refresh it triggers re-renders
    // this video and not the next un-uploaded one. The native replaceState is
    // Next's own documented way to change the URL without a fetch (it updates
    // the router's URL in place); server actions queue behind it.
    pinToVideo(key, null);
    handIn.pinnedHref = typeof window === "undefined" ? null : window.location.href;
    setSent(handIn);
    void confirmHandIn(handIn);
  }

  // Keep the video just handed in selected: ?output=<its id> is what the page
  // reads. Before the finish, only the id from the job summary will do (the
  // version isn't readable by ?cut= until it is in); after it, ?cut= works too.
  function pinToVideo(key: string, submissionId: string | null): boolean {
    if (typeof window === "undefined") return false;
    const outputId = summaryNow.current?.videos.find((v) => v.key === key)?.outputId ?? null;
    if (!outputId && !submissionId) return false;
    const url = new URL(window.location.href);
    url.searchParams.delete("cut");
    url.searchParams.delete("output");
    if (outputId) url.searchParams.set("output", outputId);
    else url.searchParams.set("cut", submissionId!);
    if (url.href === window.location.href) return false;
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    return true;
  }

  // The finish, in the background behind the card. Never abandons: the bytes
  // are in the store, and the store's own callback may already have entered
  // the cut — a failure here is shown, with a retry, never thrown away.
  async function confirmHandIn(h: HandIn) {
    const done = await cutUploadFinishReceipt(() => finishCutUpload({ submissionId: h.submissionId, url: h.url, pathname: h.pathname }));
    setRetrying(false);
    if (!done.ok) {
      // HELD is not failed (§8.2): the bytes are safe, they just aren't the
      // file that was checked (or the answer was lost) — the page's held card
      // or a retry finishes it. Either way the editor reads why.
      setSent((s) => (s && s.submissionId === h.submissionId ? { ...s, phase: "problem", problem: done.message } : s));
      router.refresh();
      return;
    }
    // The message the editor typed BEFORE the file existed now has a version
    // to belong to. Best-effort: the cut is already in review, so a failure
    // keeps the draft and says so rather than losing the words.
    if (h.message) {
      const m = await saveCutMessage(h.submissionId, h.message).catch(() => ({ ok: false as const, message: "" }));
      if (m.ok) setDraft((d) => ({ ...d, [h.key]: "" }));
      else setErr((e) => ({ ...e, [h.key]: "The cut went to review, but your message didn't save — add it again below." }));
    }
    setSent((s) => (s && s.submissionId === h.submissionId ? { ...s, phase: "done", problem: null } : s));
    // Who actually has it now (the hub assigned the reviewer as it entered).
    void uploadPanelSummary(projectId, { submissionId: h.submissionId })
      .then((r) => {
        if (!r) return;
        setSummary(r);
        if (r.sentTo) setSent((s) => (s && s.submissionId === h.submissionId ? { ...s, sentTo: r.sentTo } : s));
      })
      .catch(() => {});
    if (typeof window !== "undefined" && window.location.href === h.pinnedHref) pinToVideo(h.key, h.submissionId);
    router.refresh();
  }

  if (cuts.length === 0) return null;
  // THE JOB'S COUNT, not the rows in hand (Oct 5): the page hands this panel
  // the selected video only, and "0 of 1 approved" on a four-video job read as
  // the job's tally. Until the job's own read lands, a multi-row panel can
  // still count what it holds; a one-row panel says nothing rather than "of 1".
  const tally = summary
    ? `${summary.approved} of ${summary.total} video${summary.total === 1 ? "" : "s"} approved`
    : cuts.length > 1 ? `${cuts.filter((c) => c.latest?.status === "APPROVED").length} of ${cuts.length} approved` : null;
  // The hand-in card belongs to the video it was for — drawn while that video
  // is the one on screen, and, until its finish is confirmed, on whichever
  // video is (review, Oct 5 night): pressing "Next" while it said
  // "confirming…" used to take the card away, so a finish that then failed
  // was never seen and never retried.
  const handIn = sent && (sent.phase !== "done" || cuts.some((c) => `${c.deliverableId}:${c.slot}` === sent.key)) ? sent : null;
  const handInVideo = handIn ? summary?.videos.find((v) => v.key === handIn.key) ?? null : null;
  const handInRow = handIn ? cuts.find((c) => `${c.deliverableId}:${c.slot}` === handIn.key) ?? null : null;
  const nextVideo = handIn && summary ? nextOwedVideo(summary.videos, handIn.key, [...reopenedSlotKeys, ...(stillWorking?.openSlotKeys ?? [])]) : null;
  const nextHref = (outputId: string) => {
    const q = new URLSearchParams({ output: outputId });
    const queue = params?.get("queue");
    if (queue) q.set("queue", queue);
    return `/edit/${projectId}?${q.toString()}`;
  };
  // Asked only once the finish says the version is in, and only of the
  // editor the page says may be asked (never the office, a preview, a blocked
  // editor or the outside shop), while another video is still owed here.
  const askRemaining = handIn && handIn.phase === "done" && !handIn.answered && stillWorking ? stillWorkingRemaining(stillWorking.openSlotKeys, handIn.key) : 0;
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-brand/25 bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-5">
        <CloudUpload className="size-4 text-brand" />
        {/* Named for what the panel DOES — it is how a cut gets in front of
            the reviewer (Jordan, Sep 2: "instead of Cuts to deliver, it
            should say Send to Review"). */}
        <h2 className="text-sm font-semibold">Send to Review</h2>
        {tally && <span className="text-xs text-muted">{tally}</span>}
      </div>
      {handIn && (
        <UploadSentCard
          what={handInVideo ? `Video ${handInVideo.number}` : handInRow?.label ?? "This video"}
          round={handIn.round}
          reviewer={handIn.sentTo ?? summary?.firstReviewer ?? null}
          phase={handIn.phase}
          problem={handIn.problem}
          retrying={retrying}
          onRetry={() => {
            setRetrying(true);
            setSent((s) => (s && s.submissionId === handIn.submissionId ? { ...s, phase: "confirming", problem: null } : s));
            void confirmHandIn({ ...handIn, message: (draft[handIn.key] ?? "").trim() });
          }}
          prompt={
            askRemaining > 0 && stillWorking ? (
              <StillWorkingPrompt
                projectId={projectId}
                remaining={askRemaining}
                elsewhereStreet={stillWorking.elsewhereStreet}
                resumes={stillWorking.paused}
                onClose={(text) => {
                  setSent((s) => (s ? { ...s, answered: true } : s));
                  if (text) setReceipt({ key: handIn.key, text });
                }}
              />
            ) : null
          }
          receipt={receipt?.key === handIn.key ? receipt.text : null}
          next={nextVideo?.outputId ? {
            href: nextHref(nextVideo.outputId),
            label: `Video ${nextVideo.number}${nextVideo.topic ? ` — ${nextVideo.topic}` : ""}`,
            // A hand-in still being confirmed (or one that failed) stays on
            // screen through the move (review, Oct 5 night): clearing it here
            // hid a finish that then failed, with nobody told to retry.
            onNavigate: () => { if (handIn.phase === "done") { setSent(null); setReceipt(null); } },
          } : null}
        />
      )}
      {/* THE EXPORT SPEC, right above the Upload buttons. It is also in "What
          to make" further up the brief — that is where it is read before the
          edit starts, and this is where it is read at the moment of export,
          which is the last minute it can still save somebody a re-render.
          Same words in both places (lib/videoStyles EXPORT_SPEC). */}
      <div className="border-b border-border bg-surface-2/40 px-4 py-2 sm:px-5">
        <details className="text-sm leading-relaxed text-foreground/85">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">Export requirements · {EXPORT_SPEC.headline}</summary>
        <p className="pb-2">
          <span className="font-semibold">{EXPORT_SPEC.headline}.</span> {EXPORT_SPEC.finalCut}{" "}
          <span className="text-muted">{EXPORT_SPEC.edit}</span>{" "}
          <span className="font-medium">{EXPORT_SPEC.audio}</span>
        </p>
        </details>
      </div>
      <ul className="divide-y divide-border">
        {cuts.map((c) => {
          const key = `${c.deliverableId}:${c.slot}`;
          const b = busy[key];
          const reopened = c.latest?.status === "APPROVED" && reopenedSlotKeys.includes(key);
          // A withdrawn version FREES its number (Sep 16): the next upload is
          // that same version, not the one after it.
          const withdrawn = c.latest?.status === "WITHDRAWN";
          const next = (c.latest?.status === "APPROVED" && !reopened)
            ? null
            : c.latest ? (withdrawn ? c.latest.round : c.latest.round + 1) : 1;
          const isRedo = c.latest?.status === "CHANGES_REQUESTED" || reopened || withdrawn;
          // The version just handed in, while this row's data is older than it
          // (the refresh is on its way): the row agrees with the card above
          // rather than offering "Upload version 1" beside "sent".
          const handed = sent && sent.key === key && sent.phase !== "problem" && (!c.latest || c.latest.round < sent.round) ? sent : null;
          // THE APPROVED CUT'S OWN DOOR (Jordan, Sep 18: "they need a way to re
          // upload content after it was already approved submitted and
          // delivered"). The round a replacement would supersede — null on
          // every other row.
          //
          // `next` is null here, and until now that ended the conversation: the
          // whole upload block, hidden file picker included, hung off
          // `canUpload && next`, so an approved cut had no way to choose a file
          // at all. startCutUpload has taken a reopenReason since Sep 18 and
          // the reason box below has been built since then — it simply sat
          // behind a send() that could never start. Not a rare corner either:
          // 10 of the 12 cut slots holding a standing version sit at APPROVED,
          // every one of them with no open revision, 6 already gone to the
          // client, and the door has been walked through exactly 0 times. (The
          // Sep 18 commit said 16 of 20, 15 and 9: that count included the
          // legacy rows the Dropbox sweep filed with no deliverable, which
          // never become a row in this panel at all. Re-measured Sep 18.)
          //
          // `canReplace` is the server's answer for THIS viewer on THIS slot,
          // not a role test — see CutRow. Eight of the ten doors used to be
          // drawn for an editor the server would then refuse.
          const approvedRound = canUpload && !next && c.canReplace && c.latest?.status === "APPROVED" ? c.latest.round : null;
          // The remove/move state for this version. The flags read lands a
          // moment after the page does, so until it arrives the control is
          // drawn from what the row already knows: anyone who may upload here
          // may take their own cut back, and the server (removeCut) refuses
          // anyone it shouldn't — this only decides whether the link is drawn,
          // never whether the action is allowed. The optimistic guess is the
          // NARROW one (reviewer, Sep 16): only a version still in front of the
          // reviewer. An APPROVED cut is the office's call and a co-editor's
          // cut is theirs, so offering "Wrong video?" on either before the read
          // lands would only walk the editor into a refusal. `office` stays
          // false so the Dropbox checkbox is never drawn on a guess.
          const live = c.latest?.status === "PENDING" || c.latest?.status === "CHANGES_REQUESTED";
          const flag: CutTakeBackInfo | null =
            (c.latest ? flags[c.latest.id] : undefined) ??
            (c.latest && canUpload
              ? {
                  submissionId: c.latest.id, round: c.latest.round, status: c.latest.status,
                  fileName: c.latest.fileName,
                  canRemove: live,
                  canMove: live,
                  office: false,
                  finalPath: null, folderSourcePath: null,
                  withdrawnAt: null, withdrawnBy: null, withdrawnReason: null,
                  strandedFinalPath: null, movedFromStreet: null, movedAt: null, movedBy: null,
                }
              : null);
          // A message edits in place only while its version is with the
          // reviewer; otherwise the next upload is the one it describes.
          const liveTargetId = c.latest && c.latest.status === "PENDING" ? c.latest.id : null;
          const savedNote = key in saved ? saved[key] : editorMessage(c.latest?.note);
          const latestRes = resolutionLabel(c.latest?.sourceWidth, c.latest?.sourceHeight);
          const latestOver = isOverExportSpec(c.latest?.sourceWidth, c.latest?.sourceHeight);
          // A file this browser just stopped, and the words to hand back.
          const blk = blocked[key];
          const refusal = blk ? exportRefusal(blk.width, blk.height) : null;
          return (
            <li key={key} className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{c.label}</span>
                  {handed ? (
                    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">
                      v{handed.round} {handed.phase === "confirming" ? "going to review…" : "in review"}
                    </span>
                  ) : (
                    <StatusPill latest={c.latest} reopened={reopened} officeReopen={officeReopen} />
                  )}
                  {c.openNotes > 0 && (
                    <span className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">{c.openNotes} note{c.openNotes === 1 ? "" : "s"} to fix</span>
                  )}
                </div>
                {c.latest?.fileName && (
                  <p className="mt-0.5 truncate text-xs text-muted-2">
                    {c.latest.fileName}
                    {/* What that version actually was. Said out loud on every
                        row so "are we exporting 1080p now?" is answerable by
                        looking, and flagged when it isn't (Sep 16). */}
                    {latestRes && (
                      <span className={cn("ml-1.5", latestOver ? "font-semibold text-warning" : "text-muted-2")}>
                        · {latestRes}{latestOver ? " — over spec" : ""}
                      </span>
                    )}
                  </p>
                )}
                <CutMessage
                  savedNote={savedNote}
                  liveTargetId={liveTargetId}
                  draft={draft[key] ?? ""}
                  onDraft={(v) => setDraft((d) => ({ ...d, [key]: v }))}
                  nextVersion={next}
                  // Approved cuts are history — the message stays readable, but
                  // nobody rewrites what the reviewer already signed off.
                  canWrite={canUpload && (c.latest?.status !== "APPROVED" || reopened)}
                  onSaved={(n) => setSaved((s) => ({ ...s, [key]: n }))}
                />
                {flag && <div className="mt-2"><CutTakeBackFlags info={flag} onDone={() => setTick((t) => t + 1)} /></div>}
                {flag?.canRemove && (
                  <div className="mt-1.5">
                    <CutTakeBack info={flag} cutLabel={c.label} onDone={() => setTick((t) => t + 1)} />
                  </div>
                )}
                {b && (
                  <div className="mt-2">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${Math.max(2, b.pct)}%` }} />
                    </div>
                    <p className="mt-1 text-[11px] text-muted">{b.label} {b.pct > 0 && b.pct < 100 ? `${Math.round(b.pct)}%` : ""}</p>
                  </div>
                )}
                {err[key] && <p className="mt-1 text-xs text-danger">{err[key]}</p>}
                {/* THE REFUSAL. Whoever is reading this has just finished an
                    edit and been told "no" by a dialog, so the first line is
                    the only one that has to land: the work is fine. Then what
                    is wrong, then the exact export to use — in that order, and
                    never a word of telling-off. The rule is new; they have been
                    doing nothing wrong. */}
                {/* REPLACING AN APPROVED VIDEO. The server held the upload and
                    asked why; the file is still here, so answering is one line
                    and a press rather than picking the file again. The reason
                    is not paperwork — it is what goes on the job's timeline and
                    what tells the office a video they may already have sent is
                    being replaced. */}
                {/* Never beside the export refusal: one card, one held file,
                    one way to send it (Sep 18 review). */}
                {reopen[key] && !blk && (
                  <div className="mt-2 rounded-xl border border-brand/40 bg-brand-soft/30 p-3">
                    <p className="text-sm font-semibold">{c.label} is already approved</p>
                    <p className="mt-1 text-xs leading-relaxed text-foreground/85">
                      You can still replace it. Say why in a line — it goes on the job&rsquo;s timeline and tells the
                      office. The approved version is kept, and the new one still has to be reviewed
                      {" "}(and sent, if the client already has the old one).
                    </p>
                    {/* WHICH FILE. The door asks why AFTER the file is chosen,
                        so this line is the only thing on screen that says which
                        export is about to replace a video somebody signed off. */}
                    <p className="mt-1.5 truncate text-[11px] text-muted-2">
                      {reopen[key].file.name} · {fmtBytes(reopen[key].file.size)}
                      {approvedRound !== null && ` · goes in as v${approvedRound + 1}; v${approvedRound} keeps its file and its approval`}
                    </p>
                    <input
                      value={reopenWhy[key] ?? ""}
                      onChange={(e) => setReopenWhy((w) => ({ ...w, [key]: e.target.value }))}
                      placeholder="e.g. the agent's name was spelled wrong in the end card"
                      className="mt-2 w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand"
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!!b || (reopenWhy[key] ?? "").trim().length < 4}
                        onClick={() => { const r = reopen[key]; void send(c, r.file, r.dim, r.override, (reopenWhy[key] ?? "").trim()); }}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        <CloudUpload className="size-3.5" /> Replace it
                      </button>
                      <button
                        type="button"
                        disabled={!!b}
                        onClick={() => { clearReopen(key); setErr((e) => ({ ...e, [key]: "" })); }}
                        className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-60"
                      >
                        Leave it as it is
                      </button>
                    </div>
                  </div>
                )}
                {blk && refusal && (
                  <div className="mt-2 rounded-xl border border-warning/40 bg-warning-soft/40 p-3">
                    <p className="flex items-start gap-2 text-sm font-semibold">
                      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                      <span>{refusal.lead}</span>
                    </p>
                    <p className="mt-1.5 text-xs leading-relaxed text-foreground/85">{refusal.what}</p>
                    <p className="mt-1.5 text-xs font-medium leading-relaxed text-foreground">{refusal.fix}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{refusal.orientation}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted">{refusal.why}</p>
                    {/* THE WAY OUT. Everything above assumes re-exporting is
                        easy, and most evenings it is — but the evening it
                        isn't is the one that matters, and a refusal with no
                        named next step leaves somebody holding a finished edit
                        (Sep 16 review). Kyle is the route, and he is an ADMIN,
                        so it is not a polite fiction: the button below is
                        genuinely his to press. */}
                    <p className="mt-2 text-xs leading-relaxed text-foreground/85">{refusal.stuck}</p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={!!b}
                        onClick={() => inputs.current[key]?.click()}
                        className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
                      >
                        <CloudUpload className="size-3.5" /> Choose the 1080p export
                      </button>
                      <button
                        type="button"
                        disabled={!!b}
                        onClick={() => clearBlocked(key)}
                        className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      {canOverrideExport && (
                        <button
                          type="button"
                          // Left drawn (and the file left held) until the
                          // server has actually taken it — send() clears this
                          // card the moment the reservation exists, and not
                          // before, so a refused override is still readable
                          // with the same file still in hand.
                          disabled={!!b}
                          onClick={() => { void send(c, blk.file, { width: blk.width, height: blk.height }, true); }}
                          className="rounded-lg border border-warning/50 px-2.5 py-1.5 text-xs font-medium text-warning hover:bg-warning-soft disabled:opacity-60"
                        >
                          Send the {resolutionLabel(blk.width, blk.height)} file anyway
                        </button>
                      )}
                    </div>
                    {canOverrideExport && (
                      <p className="mt-1.5 text-[11px] text-muted-2">
                        Sending it anyway is yours to do — it goes on the job&apos;s history with your name.
                      </p>
                    )}
                  </div>
                )}
                {/* THE DOOR, drawn as what it is. Deliberately NOT the primary
                    button in the primary place: handing in the next version is
                    routine work, and replacing a video the reviewer has already
                    signed off — and in 6 of the 10 approved cut slots on file,
                    already sent to the client — is a decision. So it sits under
                    the row, quiet, with the consequence said before it is
                    pressed rather than after. It stands down while either card
                    above is open, so a row never offers two ways to pick a file
                    at once. */}
                {approvedRound !== null && !reopen[key] && !blk && (
                  <div className="mt-2">
                    <button
                      type="button"
                      disabled={!!b}
                      onClick={() => inputs.current[key]?.click()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[11px] font-semibold text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-60"
                    >
                      <RotateCcw className="size-3" /> Replace the approved video
                    </button>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-2">
                      Only if this cut itself is wrong. You pick the file, say why in a line, and it goes back through
                      review as v{approvedRound + 1} — v{approvedRound} keeps its approval either way.
                    </p>
                  </div>
                )}
                {/* NO DOOR, AND SAID SO. The alternative to drawing a control
                    the server will refuse is not silence: an editor looking at
                    an approved cut of somebody else's still needs to know where
                    a corrected file goes. One line, and it names the route. */}
                {canUpload && !next && !c.canReplace && c.latest?.status === "APPROVED" && (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-2">
                    Approved — replacing it is the office&rsquo;s call. If this cut is wrong, tell Kyle or Jordan and
                    they can put the corrected file through review.
                  </p>
                )}
              </div>
              {/* ONE PICKER PER ROW, shared by every control that chooses a
                  file: the button below, the export refusal's "Choose the 1080p
                  export", and the replace door above. It lives outside the
                  `next` gate because on an approved cut `next` is null and the
                  door still has to be able to open a file dialog. */}
              {canUpload && (next !== null || approvedRound !== null) && (
                <input
                  ref={(el) => { inputs.current[key] = el; }}
                  type="file"
                  accept="video/mp4,video/quicktime,video/x-m4v,video/webm,.mp4,.mov,.m4v,.webm"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void begin(c, f, approvedRound !== null); }}
                />
              )}
              {canUpload && next && !handed && (
                <button
                  type="button"
                  disabled={!!b}
                  onClick={() => inputs.current[key]?.click()}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60",
                    isRedo ? "bg-danger hover:opacity-90" : "bg-brand hover:opacity-90",
                  )}
                >
                  {b ? <Loader2 className="size-4 animate-spin" /> : isRedo ? <RotateCcw className="size-4" /> : <CloudUpload className="size-4" />}
                  {b ? "Uploading" : `Upload version ${next}`}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="border-t border-border px-4 py-2 text-[11px] text-muted-2 sm:px-5">
        Pick your 1080p export, tick the short check, and it goes straight to the Review Room with your message. Approved cuts
        are copied to the job&apos;s Final folder in Dropbox for you.
      </p>
      {checking && (() => {
        const key = `${checking.cut.deliverableId}:${checking.cut.slot}`;
        const ctx = checking.context ?? checks[key];
        if (!ctx) {
          return (
            <p className="border-t border-border px-4 py-2 text-xs text-danger sm:px-5">
              The checklist for {checking.cut.label} didn&apos;t load — reload the page and pick the file again.
            </p>
          );
        }
        return (
          <SelfCheckDialog
            context={ctx}
            file={{ name: checking.file.name, size: checking.file.size, lastModified: checking.file.lastModified }}
            title={`Before ${(() => { const v = summary?.videos.find((x) => x.key === key); return v ? `Video ${v.number}` : checking.cut.label; })()} goes to review`}
            onBehalfOf={onBehalfOf}
            notice={checking.notice ?? null}
            onCancel={() => setChecking(null)}
            onSubmit={async (input) => {
              const p = checking;
              setChecked((s) => ({ ...s, [key]: { input, name: p.file.name, size: p.file.size } }));
              setChecking(null);
              // The upload runs under the row's own progress bar; a refusal of
              // the check brings this list back with the reason (send above).
              void send(p.cut, p.file, p.dim, p.override, p.reopenReason, input);
              return { ok: true, message: "" };
            }}
          />
        );
      })()}
    </section>
  );
}
