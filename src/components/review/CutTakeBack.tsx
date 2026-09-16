"use client";

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRightLeft, Loader2, Search, Trash2, Undo2, X } from "lucide-react";
import { cutMoveTargets, reassignCut, removeCut, removeStrandedFinal } from "@/app/review/actions";
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

/** The state banners — moved here, leftover file, and the withdrawn line that
 *  only rows from the afternoon of Sep 16 can still carry — shown wherever a
 *  cut is shown, whether or not the viewer may act on it. */
export function CutTakeBackFlags({ info, onDone }: { info: CutTakeBackInfo; onDone?: () => void }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const withdrawn = info.status === "WITHDRAWN";
  if (!withdrawn && !info.strandedFinalPath && !info.movedFromStreet) return null;

  const removeFile = () =>
    start(async () => {
      setErr(null);
      setMsg(null);
      const r = await removeStrandedFinal(info.submissionId).catch(() => ({ ok: false, message: "That didn't work — try again." }));
      if (!r.ok) setErr(r.message);
      else {
        setMsg(r.message);
        setConfirming(false);
        onDone?.();
        router.refresh();
      }
    });

  return (
    <div className="space-y-1.5">
      {withdrawn && (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted">
          <span className="font-semibold text-foreground/80">Version {info.round} was withdrawn</span>
          {info.withdrawnBy ? ` by ${info.withdrawnBy}` : ""}
          {info.withdrawnAt ? ` on ${fmtWhen(info.withdrawnAt)}` : ""}
          {info.withdrawnReason ? ` — “${info.withdrawnReason}”` : ""}. It was kept rather than deleted; the next upload takes
          version {info.round} again, and &ldquo;Wrong video?&rdquo; will now remove it for good.
        </p>
      )}
      {info.movedFromStreet && !withdrawn && (
        <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted">
          <span className="font-semibold text-foreground/80">Moved here from {info.movedFromStreet}</span>
          {info.movedBy ? ` by ${info.movedBy}` : ""}
          {info.movedAt ? ` on ${fmtWhen(info.movedAt)}` : ""}. It hasn&apos;t been matched to any revision on this job — rule on it as a fresh cut.
        </p>
      )}
      {info.strandedFinalPath && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed">
          <p className="flex items-start gap-1.5 text-foreground/85">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              <span className="font-semibold">The approved file is still in Dropbox:</span>{" "}
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
                    disabled={busy}
                    className="inline-flex items-center gap-1 rounded-lg bg-danger px-2.5 py-1 text-[11px] font-semibold text-white disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />} Yes, delete that file
                  </button>
                  <button type="button" onClick={() => setConfirming(false)} className="text-[11px] font-medium text-muted hover:text-foreground">
                    Keep it
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-muted hover:text-foreground"
                >
                  <Trash2 className="size-3" /> Remove it from Dropbox too
                </button>
              )}
            </div>
          )}
          {msg && <p className="mt-1 text-[11px] text-success">{msg}</p>}
          {err && <p className="mt-1 text-[11px] text-danger">{err}</p>}
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
        className={className ?? "inline-flex items-center gap-1 text-[11px] font-medium text-muted-2 underline-offset-2 hover:text-foreground hover:underline"}
      >
        <Undo2 className="size-3" /> Wrong video?
      </button>
      {open && <TakeBackDialog info={info} cutLabel={cutLabel} onClose={() => setOpen(false)} onDone={onDone} />}
    </>
  );
}

function TakeBackDialog({ info, cutLabel, onClose, onDone }: { info: CutTakeBackInfo; cutLabel: string; onClose: () => void; onDone?: () => void }) {
  const router = useRouter();
  const [tab, setTab] = useState<"remove" | "move">("remove");
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [note, setNote] = useState("");
  const [options, setOptions] = useState<CutMoveOption[] | null>(null);
  const [picked, setPicked] = useState<CutMoveOption | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
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
  const [armed, setArmed] = useState(false);

  // Escape closes, like clicking the backdrop (same as the override dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The job list loads when the Move tab is opened, and again 300ms after the
  // search settles — one query per pause, never one per keystroke.
  useEffect(() => {
    if (tab !== "move") return;
    let live = true;
    const t = setTimeout(() => {
      void cutMoveTargets(info.submissionId, q)
        .then((rows) => { if (live) setOptions(rows); })
        .catch(() => { if (live) setOptions([]); });
    }, options === null ? 0 : 300);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, q, info.submissionId]);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      setErr(null);
      const r = await fn().catch(() => ({ ok: false, message: "That didn't work — try again." }));
      if (!r.ok) {
        setErr(r.message);
        // A refusal disarms: whatever they try next has to be confirmed again.
        setArmed(false);
      } else {
        onClose();
        onDone?.();
        router.refresh();
      }
    });

  return createPortal(
    <>
      <div className="fixed inset-0 z-[60] bg-black/50" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Remove or move ${cutLabel}`}
        className="fixed left-1/2 top-1/2 z-[70] max-h-[90vh] w-[min(94vw,32rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-surface p-4 shadow-2xl sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Undo2 className="size-4 text-brand" /> Wrong video?
            </div>
            <p className="mt-0.5 truncate text-[12px] leading-snug text-muted">
              {cutLabel} · version {info.round}
              {info.fileName ? ` · ${info.fileName}` : ""}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1 text-muted-2 hover:bg-surface-2 hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        {info.status === "APPROVED" && (
          <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] leading-relaxed text-foreground/85">
            This cut is approved, and its file was already copied into the job&apos;s Final folder. Removing it deletes the
            version here; the finished file in Dropbox only goes if you tick the box below.
          </p>
        )}

        <div className="mt-3 flex gap-1.5">
          <button
            type="button"
            onClick={() => { setTab("remove"); setErr(null); setArmed(false); }}
            className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${tab === "remove" ? "border-brand bg-brand text-white" : "border-border bg-surface hover:bg-surface-2"}`}
          >
            <Trash2 className="size-3" /> Remove this version
          </button>
          {/* An old round can be removed but not moved — the server refuses it,
              so the tab that would only walk them into that refusal isn't drawn. */}
          {info.canMove && (
            <button
              type="button"
              onClick={() => { setTab("move"); setErr(null); setArmed(false); }}
              className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium ${tab === "move" ? "border-brand bg-brand text-white" : "border-border bg-surface hover:bg-surface-2"}`}
            >
              <ArrowRightLeft className="size-3" /> Move to another job
            </button>
          )}
        </div>

        {tab === "remove" ? (
          <div className="mt-3 space-y-2">
            <p className="flex items-start gap-1.5 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-2 text-[12px] leading-relaxed text-foreground/85">
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
              autoFocus
              value={reason}
              onChange={(e) => { setReason(e.target.value); setArmed(false); }}
              maxLength={300}
              placeholder="What went wrong? e.g. wrong export — no captions"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <p className="text-[11px] leading-relaxed text-muted-2">
              Required — one line on the job&apos;s timeline naming you, the version and this reason is all that is kept.
            </p>
            {/* The one file a removal never touches. Said here rather than
                discovered afterwards, because this cut came FROM that file. */}
            {folderName && (
              <p className="rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-[11px] leading-relaxed text-muted">
                <span className="font-semibold text-foreground/80">The video itself stays in Dropbox.</span>{" "}
                This cut was picked up from a file you put in the job&apos;s Final folder (<span className="break-all font-medium">{folderName}</span>),
                and that export is yours, not a copy the hub made — so it is left there and Kyle gets a task with the full
                path. It won&apos;t come back into the Room on its own.
              </p>
            )}
            {/* The office's one Dropbox choice, on an approved cut only. */}
            {info.office && dropboxName && (
              <label className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 text-[12px] leading-relaxed">
                <input
                  type="checkbox"
                  checked={alsoDropbox}
                  onChange={(e) => { setAlsoDropbox(e.target.checked); setArmed(false); }}
                  className="mt-0.5 size-3.5 shrink-0 accent-[var(--danger)]"
                />
                <span>
                  also delete the finished file from Dropbox (<span className="break-all font-medium">{dropboxName}</span>)
                  <span className="mt-0.5 block text-[11px] text-muted-2">
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
                  disabled={busy}
                  onClick={() => run(() => removeCut(info.submissionId, reason, alsoDropbox))}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  Yes, remove it permanently
                </button>
                <button type="button" onClick={() => setArmed(false)} className="text-xs font-medium text-muted hover:text-foreground">
                  Keep it
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={busy || !reason.trim()}
                onClick={() => { setErr(null); setArmed(true); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
              >
                <Trash2 className="size-4" /> Remove this version
              </button>
            )}
          </div>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-[12px] leading-relaxed text-muted">
              The same video, its notes and its message move to the job you pick. The job it leaves goes back to where it
              stood; the job it lands on gets it as a fresh cut waiting on review.
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5">
              <Search className="size-3.5 shrink-0 text-muted-2" />
              <input
                autoFocus
                value={q}
                onChange={(e) => { setQ(e.target.value); setPicked(null); }}
                placeholder="Search by address or client…"
                className="w-full bg-transparent text-sm outline-none"
              />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
              {options === null ? (
                <p className="px-3 py-3 text-[12px] text-muted">Loading jobs…</p>
              ) : options.length === 0 ? (
                <p className="px-3 py-3 text-[12px] text-muted">
                  No job matches. {q ? "Try another address." : "Only jobs with video on the order can take a cut."}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {options.map((o) => (
                    <li key={o.projectId}>
                      <button
                        type="button"
                        onClick={() => setPicked(o)}
                        className={`flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-left text-sm hover:bg-surface-2 ${picked?.projectId === o.projectId ? "bg-brand-soft" : ""}`}
                      >
                        <span className="font-medium">{o.street}</span>
                        {o.clientName && <span className="text-xs text-muted">{o.clientName}</span>}
                        <span className="ml-auto text-[10px] uppercase tracking-wide text-muted-2">{o.status.toLowerCase()}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
              placeholder="Optional message for whoever reviews it there…"
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
            />
            <button
              type="button"
              disabled={busy || !picked}
              onClick={() => picked && run(() => reassignCut(info.submissionId, picked.projectId, note))}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRightLeft className="size-4" />}
              {picked ? `Move it to ${picked.street}` : "Pick a job first"}
            </button>
          </div>
        )}
        {err && <p className="mt-2 text-xs text-danger">{err}</p>}
      </div>
    </>,
    document.body,
  );
}
