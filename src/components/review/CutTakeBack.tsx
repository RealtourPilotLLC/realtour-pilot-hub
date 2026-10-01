"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRightLeft, Loader2, Search, Trash2, Undo2, X } from "lucide-react";
import { cutMoveTargets, reassignCut, removeCut, removeStrandedFinal, type TakeBackResult } from "@/app/review/actions";
import { ModalDialog } from "@/components/ui/ModalDialog";
import type { CutMoveOption, CutTakeBackInfo } from "./types";

// ---------------------------------------------------------------------------
// "Wrong video?" — the quiet escape hatch beside the loud button (Jordan,
// Sep 16: "I want the editor to be able to remove the video from upload / for
// review in case they mistakenly upload the wrong video or to the wrong
// project. It would also be cool if they could reassign that video to a
// different project.")
//
// Deliberately small and grey: the main action on both surfaces — upload the
// next version, or rule on the cut — stays the dominant thing on the row. This
// is a text link that opens one dialog with two choices:
//   · Remove this version — a one-line reason, required, and a two-step press,
//     because Jordan settled it that evening: "When removing the cut, I want
//     it to remove completely." The version, its file and its notes go; the
//     warning says so in those words and the press cannot be undone.
//   · Move to another job — the editor's own jobs, or a search for the office.
//     Unchanged, and still the right answer when the VIDEO is fine and the JOB
//     is wrong.
// On a cut Jordan has already approved the confirm names its finished file in
// Dropbox and offers, unticked, to delete that too (his rule 2 — "leave it and
// flag it with the option to remove it if I want" — is the default).
//
// The server (removeCut / reassignCut / removeStrandedFinal) is the real
// guard — everything here is presentation.
// ---------------------------------------------------------------------------

const fmtWhen = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
};

const control = "inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-normal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50";
const field = "min-h-11 w-full rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-base focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-60";

function useTakeBackMutation(submissionId: string) {
  const [busy, start] = useTransition();
  const [receipt, setReceipt] = useState<TakeBackResult | null>(null);
  const pending = useRef(false);
  const held = useRef(false);
  // All take-back controls for this exact cut share one opaque, tab-local
  // marker. No reason, job, file path or other draft is persisted here.
  const storageKey = `ops-cut-takeback-attempt:${submissionId}`;
  const previousAttempt = () => {
    held.current = true;
    setReceipt({ ok: false, outcome: "unknown", message: "A previous change to this exact version or its files is unconfirmed." });
  };
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || pending.current) return;
      try {
        if (sessionStorage.getItem(storageKey)) {
          held.current = true;
          setReceipt({ ok: false, outcome: "unknown", message: "A previous change to this exact version or its files is unconfirmed." });
        }
      } catch { /* The synchronous guard below refuses writes without storage. */ }
    });
    return () => { stopped = true; };
  }, [storageKey]);
  const run = (write: () => Promise<TakeBackResult>, after: (r: TakeBackResult) => void) => {
    if (pending.current || held.current) return;
    let attempt: string;
    try {
      // Check again before writing: another mounted flag/dialog may have
      // started a request since this control rendered.
      if (sessionStorage.getItem(storageKey)) { previousAttempt(); return; }
      attempt = crypto.randomUUID();
      sessionStorage.setItem(storageKey, attempt);
    } catch {
      setReceipt({ ok: false, outcome: "refused", message: "This browser could not keep the request's recovery status. No request was made. Restore browser storage before trying again." });
      return;
    }
    pending.current = true;
    setReceipt(null);
    start(async () => {
      let result: TakeBackResult;
      try {
        const r = await write();
        result = r.ok && r.outcome === "confirmed" || !r.ok && r.outcome === "refused" || !r.ok && r.outcome === "unknown"
          ? r : { ok: false, outcome: "unknown", message: "The request was not confirmed." };
      } catch {
        result = { ok: false, outcome: "unknown", message: "The request was not confirmed." };
      }
      if (result.outcome !== "unknown") {
        try {
          if (sessionStorage.getItem(storageKey) === attempt) sessionStorage.removeItem(storageKey);
        } catch {
          result = { ok: false, outcome: "unknown", message: `${result.message} The local recovery status could not be cleared; check this exact version before another change.` };
        }
      }
      held.current = result.outcome !== "refused";
      setReceipt(result);
      pending.current = false;
      after(result);
    });
  };
  return { busy, receipt, run, isPending: () => pending.current, isHeld: () => held.current };
}

function TakeBackReceipt({ receipt, submissionId }: { receipt: TakeBackResult | null; submissionId: string }) {
  if (!receipt) return null;
  return <div role={receipt.ok ? "status" : "alert"} className={`mt-2 space-y-2 break-words text-ui-status leading-relaxed ${receipt.ok ? "text-success" : "text-danger"}`}>
    <p>{receipt.message}</p>
    {receipt.outcome === "unknown" && <>
      <p>The version or files may already have changed. This attempt stays blocked in this tab, including after a refresh. Ask Kyle or Jordan to check this exact version, its job timeline and files before another attempt. Closing or refreshing does not prove that nothing changed.</p>
      <p className="text-muted">Cut reference: <span className="font-mono">{submissionId}</span></p>
      <a className={`${control} border border-border-strong text-foreground`} href="/review" target="_blank" rel="noopener noreferrer">Open Review Room in a separate tab</a>
    </>}
  </div>;
}

/** The state banners — moved here, leftover file, and the withdrawn line that
 *  only rows from the afternoon of Sep 16 can still carry — shown wherever a
 *  cut is shown, whether or not the viewer may act on it. */
export function CutTakeBackFlags({ info, onDone }: { info: CutTakeBackInfo; onDone?: () => void }) {
  const router = useRouter();
  const { busy, receipt, run, isPending, isHeld } = useTakeBackMutation(info.submissionId);
  const [confirming, setConfirming] = useState(false);

  const withdrawn = info.status === "WITHDRAWN";
  if (!withdrawn && !info.strandedFinalPath && !info.movedFromStreet) return null;

  const removeFile = () =>
    run(() => removeStrandedFinal(info.submissionId), (r) => {
      setConfirming(false);
      if (r.ok) {
        onDone?.();
        router.refresh();
      }
    });

  return (
    <div className="space-y-1.5">
      {withdrawn && (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-ui-status leading-relaxed text-muted">
          <span className="font-semibold text-foreground/80">Version {info.round} was withdrawn</span>
          {info.withdrawnBy ? ` by ${info.withdrawnBy}` : ""}
          {info.withdrawnAt ? ` on ${fmtWhen(info.withdrawnAt)}` : ""}
          {info.withdrawnReason ? ` — “${info.withdrawnReason}”` : ""}. It was kept rather than deleted; the next upload takes
          version {info.round} again, and &ldquo;Wrong video?&rdquo; will now remove it for good.
        </p>
      )}
      {info.movedFromStreet && !withdrawn && (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-ui-status leading-relaxed text-muted">
          <span className="font-semibold text-foreground/80">Moved here from {info.movedFromStreet}</span>
          {info.movedBy ? ` by ${info.movedBy}` : ""}
          {info.movedAt ? ` on ${fmtWhen(info.movedAt)}` : ""}. It hasn&apos;t been matched to any revision on this job — rule on it as a fresh cut.
        </p>
      )}
      {info.strandedFinalPath && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-status leading-relaxed">
          <p className="flex items-start gap-1.5 text-foreground/85">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              <span className="font-semibold">The approved file recorded for Dropbox follow-up:</span>{" "}
              <span className="break-all text-muted">{info.strandedFinalPath}</span>
            </span>
          </p>
          {info.office && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              {confirming ? (
                <>
                  <button
                    type="button"
                    onClick={removeFile}
                    disabled={busy || isHeld()}
                    className={`${control} bg-danger-action font-semibold text-white`}
                  >
                    {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />} Yes, delete that file
                  </button>
                  <button type="button" disabled={busy} onClick={() => { if (!isPending()) setConfirming(false); }} className={`${control} text-muted hover:text-foreground`}>
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={busy || isHeld()}
                  onClick={() => { if (!isPending() && !isHeld()) setConfirming(true); }}
                  className={`${control} border border-border-strong bg-surface text-muted hover:text-foreground`}
                >
                  <Trash2 className="size-3" /> Remove it from Dropbox too
                </button>
              )}
            </div>
          )}
          <TakeBackReceipt receipt={receipt} submissionId={info.submissionId} />
        </div>
      )}
    </div>
  );
}

/** The control itself — a text link that opens the dialog. Renders nothing
 *  when this viewer can't act on this cut (the server says so). */
export function CutTakeBack({
  info,
  cutLabel,
  className,
  onDone,
}: {
  info: CutTakeBackInfo;
  cutLabel: string;
  className?: string;
  /** the surface re-reads its own flags after a withdraw/move (the editor
   *  portal keeps them in local state; the Review Room gets them from the
   *  server render) */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Removal is the wider permission (an old round can be removed but not
  // moved), so it decides whether the link is drawn at all.
  if (!info.canRemove) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${control} ${className ?? "text-muted underline-offset-2 hover:text-foreground hover:underline"}`}
      >
        <Undo2 className="size-3" /> Wrong video?
      </button>
      <TakeBackDialog key={info.submissionId} open={open} info={info} cutLabel={cutLabel} onClose={() => setOpen(false)} onDone={onDone} />
    </>
  );
}

function TakeBackDialog({ open, info, cutLabel, onClose, onDone }: { open: boolean; info: CutTakeBackInfo; cutLabel: string; onClose: () => void; onDone?: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState<"remove" | "move">("remove");
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [options, setOptions] = useState<CutMoveOption[] | null>(null);
  const [picked, setPicked] = useState<CutMoveOption | null>(null);
  const [readError, setReadError] = useState(false);
  const [readRetry, setReadRetry] = useState(0);
  const [closing, setClosing] = useState(false);
  const closeChoice = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const { busy, receipt, run: mutate, isPending, isHeld } = useTakeBackMutation(info.submissionId);
  // The Dropbox copy of an approved cut, and whether this press takes it too.
  // OFF by default — Jordan's rule 2 stands, the box is the exception.
  const dropboxPath = info.finalPath ?? info.strandedFinalPath;
  const dropboxName = dropboxPath?.split("/").pop() ?? null;
  const [alsoDropbox, setAlsoDropbox] = useState(false);
  // The editor's own export behind a folder-discovered cut. A removal never
  // deletes it (it isn't a copy the hub made), so the warning has to say so —
  // "this deletes the version and its file" would otherwise promise something
  // this press can't do (reviewer, Sep 16).
  const folderName = info.folderSourcePath?.split("/").pop() ?? null;
  // Two-step press: nothing about this is undoable, so the button has to be
  // asked twice. Any edit to the reason or the Dropbox box takes the arming
  // back off, AND so does switching tabs — arming on Remove, stepping over to
  // Move and back used to leave the button already sitting on "Yes, remove it
  // permanently", one click from gone (reviewer, Sep 16). The second press
  // must mean what the first one said.
  const [armed, setArmedState] = useState(false);
  const armedRef = useRef(false);
  const setArmed = (value: boolean) => { armedRef.current = value; setArmedState(value); };

  const close = () => {
    if (isPending()) return;
    setArmed(false);
    if (reason || note || q || picked || alsoDropbox) setClosing(true);
    else onClose();
  };
  useEffect(() => { if (closing) closeChoice.current?.focus(); }, [closing]);

  // The job list loads when the Move tab is opened, and again 300ms after the
  // search settles — one query per pause, never one per keystroke.
  useEffect(() => {
    if (!open || tab !== "move" || !info.canMove) return;
    let live = true;
    const t = setTimeout(() => {
      setOptions(null);
      setReadError(false);
      void cutMoveTargets(info.submissionId, q)
        .then((rows) => { if (live) { setOptions(rows); setPicked((old) => old ? rows.find((r) => r.projectId === old.projectId) ?? null : null); } })
        .catch(() => { if (live) { setReadError(true); setPicked(null); } });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [open, tab, q, info.submissionId, info.canMove, readRetry]);

  const run = (fn: () => Promise<TakeBackResult>) =>
    mutate(fn, (r) => {
      setArmed(false);
      if (r.ok) {
        // Keep the confirmed receipt visible, including any file left behind.
        onDone?.();
        router.refresh();
      }
    });

  return (
      <ModalDialog open={open} label={`Remove or move ${cutLabel}`} busy={busy} holdEscape={closing} onCancel={close} className="sm:max-w-lg">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Undo2 className="size-4 text-brand" /> Wrong video?
            </div>
            <p className="mt-0.5 truncate text-ui-secondary leading-snug text-muted">
              {cutLabel} · version {info.round}
              {info.fileName ? ` · ${info.fileName}` : ""}
            </p>
          </div>
          <button ref={closeButton} type="button" data-modal-initial-focus disabled={busy} onClick={close} aria-label="Close" className={`${control} text-muted hover:bg-surface-2 hover:text-foreground`}>
            <X className="size-4" />
          </button>
        </div>

        {closing && <div className="mt-3 space-y-2 rounded-xl border border-border-strong bg-surface-2 p-3" role="group" aria-label="Close and keep draft">
          <p className="text-ui-body">Your reason, search and message stay in this tab when you close. Closing does not cancel a completed request or unlock an unconfirmed attempt.</p>
          <div className="flex flex-wrap gap-2">
            <button ref={closeChoice} type="button" className={`${control} border border-border-strong`} onClick={() => { setClosing(false); closeButton.current?.focus(); }}>Keep editing</button>
            <button type="button" className={`${control} border border-border-strong`} onClick={() => { if (!isPending()) { setClosing(false); setArmed(false); setOptions(null); onClose(); } }}>Close and keep draft</button>
          </div>
        </div>}

        <TakeBackReceipt receipt={receipt} submissionId={info.submissionId} />
        <p className="mt-2 text-ui-status text-muted">Reason and message drafts are kept in this tab when the dialog closes.</p>

        {info.status === "APPROVED" && (
          <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-status leading-relaxed text-foreground/85">
            This cut is approved, and its file was already copied into the job&apos;s Final folder. Removing it deletes the
            version here; the finished file in Dropbox only goes if you tick the box below.
          </p>
        )}

        <div className="mt-3 flex gap-1.5">
          <button
            type="button"
            disabled={busy || closing}
            onClick={() => { if (!isPending()) { setTab("remove"); setArmed(false); } }}
            aria-pressed={tab === "remove"}
            className={`${control} border ${tab === "remove" ? "border-brand bg-brand-action text-brand-fg" : "border-border-strong bg-surface hover:bg-surface-2"}`}
          >
            <Trash2 className="size-3" /> Remove this version
          </button>
          {/* An old round can be removed but not moved — the server refuses it,
              so the tab that would only walk them into that refusal isn't drawn. */}
          {info.canMove && (
            <button
              type="button"
              disabled={busy || closing}
              onClick={() => { if (!isPending()) { setTab("move"); setOptions(null); setReadError(false); setArmed(false); } }}
              aria-pressed={tab === "move"}
              className={`${control} border ${tab === "move" ? "border-brand bg-brand-action text-brand-fg" : "border-border-strong bg-surface hover:bg-surface-2"}`}
            >
              <ArrowRightLeft className="size-3" /> Move to another job
            </button>
          )}
        </div>

        {tab === "remove" || !info.canMove ? (
          <div className="mt-3 space-y-2">
            <p className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-ui-secondary leading-relaxed text-foreground/85">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" />
              <span>
                <span className="font-semibold">This deletes the version and its file. It cannot be undone.</span>{" "}
                Version {info.round}
                {info.fileName ? ` (${info.fileName})` : ""}
                {/* A folder-discovered cut has no copy in the hub to delete —
                    naming one would be wrong, and the note below says where
                    the video actually lives. */}
                {folderName ? " and its review notes go" : ", its review notes and its copy in the hub all go"}. Version{" "}
                {info.round} is free again for the right file.
              </span>
            </p>
            <input
              value={reason}
              disabled={busy || closing}
              aria-label="Reason for removing this version"
              onChange={(e) => { if (!isPending()) { setReason(e.target.value); setArmed(false); } }}
              maxLength={300}
              placeholder="What went wrong? e.g. wrong export — no captions"
              className={field}
            />
            <p className="text-ui-status leading-relaxed text-muted-2">
              Required — one line on the job&apos;s timeline naming you, the version and this reason is all that is kept.
            </p>
            {/* The one file a removal never touches. Said here rather than
                discovered afterwards, because this cut came FROM that file. */}
            {folderName && (
              <p className="rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-ui-status leading-relaxed text-muted">
                <span className="font-semibold text-foreground/80">The video itself stays in Dropbox.</span>{" "}
                This cut was picked up from a file you put in the job&apos;s Final folder (<span className="break-all font-medium">{folderName}</span>),
                and that export is yours, not a copy the hub made — so it is left there and Kyle gets a task with the full
                path. It won&apos;t come back into the Room on its own.
              </p>
            )}
            {/* The office's one Dropbox choice, on an approved cut only. */}
            {info.office && dropboxName && (
              <label className="flex min-h-11 items-start gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-ui-secondary leading-relaxed">
                <input
                  type="checkbox"
                  checked={alsoDropbox}
                  disabled={busy || closing}
                  onChange={(e) => { if (!isPending()) { setAlsoDropbox(e.target.checked); setArmed(false); } }}
                  className="mt-0.5 size-4 shrink-0 accent-[var(--danger)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                />
                <span>
                  also delete the finished file from Dropbox (<span className="break-all font-medium">{dropboxName}</span>)
                  <span className="mt-0.5 block text-ui-status text-muted-2">
                    {alsoDropbox
                      ? "That file will be deleted from the job's Final folder."
                      : "Left unticked it stays in the job's Final folder, and Kyle gets a task with the full path."}
                  </span>
                </span>
              </label>
            )}
            {armed ? (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy || isHeld() || closing}
                  onClick={() => { if (armedRef.current && !closing) run(() => removeCut(info.submissionId, reason, alsoDropbox)); }}
                  className={`${control} bg-danger-action font-semibold text-white`}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  Yes, remove it permanently
                </button>
                <button type="button" disabled={busy} onClick={() => { if (!isPending()) setArmed(false); }} className={`${control} text-muted hover:text-foreground`}>
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy || isHeld() || closing || !reason.trim()}
                onClick={() => { if (!isPending() && !isHeld() && !closing && reason.trim()) setArmed(true); }}
                className={`${control} bg-danger-action font-semibold text-white`}
              >
                <Trash2 className="size-4" /> Remove this version
              </button>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-ui-secondary leading-relaxed text-muted">
              The same video, its notes and its message move to the job you pick. The job it leaves goes back to where it
              stood; the job it lands on gets it as a fresh cut waiting on review.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-2" />
              <input
                value={q}
                aria-label="Search jobs by address or client"
                disabled={busy || closing}
                onChange={(e) => { if (!isPending()) { setQ(e.target.value); setPicked(null); setOptions(null); setReadError(false); } }}
                placeholder="Search by address or client…"
                className={`${field} border-transparent bg-transparent`}
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
              {readError ? (
                <div role="alert" className="space-y-2 p-3 text-ui-status">
                  <p>Jobs could not be loaded. This does not mean no matching jobs exist.</p>
                  <button type="button" disabled={busy} onClick={() => { setOptions(null); setReadError(false); setReadRetry((v) => v + 1); }} className={`${control} border border-border-strong`}>Retry job list</button>
                </div>
              ) : options === null ? (
                <p className="px-3 py-3 text-ui-secondary text-muted">Loading jobs…</p>
              ) : options.length === 0 ? (
                <p className="px-3 py-3 text-ui-secondary text-muted">
                  No job matches. {q ? "Try another address." : "Only jobs with video on the order can take a cut."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {options.map((o) => (
                    <li key={o.projectId}>
                      <button
                        type="button"
                        disabled={busy || closing}
                        onClick={() => { if (!isPending()) setPicked(o); }}
                        aria-pressed={picked?.projectId === o.projectId}
                        className={`${control} flex w-full flex-wrap justify-start gap-x-2 gap-y-0.5 text-left hover:bg-surface-2 ${picked?.projectId === o.projectId ? "bg-brand-soft" : ""}`}
                      >
                        <span className="font-medium">{o.street}</span>
                        {o.clientName && <span className="text-xs text-muted">{o.clientName}</span>}
                        <span className="ml-auto text-ui-status uppercase tracking-wide text-muted-2">{o.status.toLowerCase()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <input
              value={note}
              aria-label="Message for the reviewer on the destination job"
              disabled={busy || closing}
              onChange={(e) => { if (!isPending()) setNote(e.target.value); }}
              maxLength={1000}
              placeholder="Optional message for whoever reviews it there…"
              className={field}
            />
            <button
              type="button"
              disabled={busy || isHeld() || closing || readError || options === null || !picked}
              onClick={() => { if (picked && !closing && !readError && options !== null) run(() => reassignCut(info.submissionId, picked.projectId, note)); }}
              className={`${control} bg-brand-action font-semibold text-brand-fg`}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRightLeft className="size-4" />}
              {picked ? `Move it to ${picked.street}` : "Pick a job first"}
            </button>
          </div>
        )}
      </ModalDialog>
  );
}
