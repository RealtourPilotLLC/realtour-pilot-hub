"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { markWaitingOnSecondShootAction, releaseSecondShootVideoAction } from "@/app/projects/secondShootActions";

// ---------------------------------------------------------------------------
// WAITING ON A SECOND SHOOT, the office's control (Oct 22 2026). One line per
// video on the job, named the way the brief names it ("Video 3: Premium
// Social Reel, Video 3 of 3"), so on a job with several of the same product
// the office can tell which one is half shot. A video can be put on hold with
// a note and the expected appointment, and released to the editor by hand.
// The job page and the editor's brief show it to the office only.
// ---------------------------------------------------------------------------

export type SecondShootRowView = {
  outputId: string;
  number: number;
  label: string;
  /** the waiting line ("Waiting on a second shoot: half shot"), null when not waiting */
  waiting: string | null;
  note: string | null;
  /** YYYY-MM-DD, the expected appointment */
  expectedDay: string | null;
  /** "Released Oct 30 (footage from the Oct 30 shoot), due Nov 2" */
  released: string | null;
  /** has an approved cut or was sent: cannot be held */
  finished: boolean;
};

const DEFAULT_NOTE = "Half shot; needs a second appointment";

export function SecondShootControl({ projectId, rows }: { projectId: string; rows: SecondShootRowView[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [day, setDay] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(null);
  if (rows.length === 0) return null;
  const waitingCount = rows.filter((r) => r.waiting).length;

  const save = (outputId: string) =>
    start(async () => {
      const r = await markWaitingOnSecondShootAction({ projectId, outputId, note: note.trim() || DEFAULT_NOTE, expectedDay: day || null }).catch(() => ({ ok: false, message: "That did not go through. Reload the page and try again." }));
      setMsg(r);
      if (r.ok) {
        setOpen(null);
        router.refresh();
      }
    });
  const release = (outputId: string, n: number) => {
    if (!window.confirm(`Release video ${n} to the editor? Its due date starts now, from the latest shoot on the job.`)) return;
    start(async () => {
      const r = await releaseSecondShootVideoAction({ projectId, outputId }).catch(() => ({ ok: false, message: "That did not go through. Reload the page and try again." }));
      setMsg(r);
      if (r.ok) router.refresh();
    });
  };

  return (
    <section data-second-shoot aria-labelledby={`second-shoot-${projectId}`} className="rounded-2xl border border-border bg-surface p-4">
      <h2 id={`second-shoot-${projectId}`} className="flex items-center gap-2 text-sm font-semibold">
        <CalendarClock aria-hidden className="size-4 text-muted" />
        {waitingCount ? `${waitingCount === 1 ? "1 video" : `${waitingCount} videos`} waiting on a second shoot` : "Video half shot? Hold it for the next appointment"}
      </h2>
      <p className="mt-1 text-sm text-muted">
        A video waiting on a second shoot is off the editors&apos; queue, has no due date and does not hold up the others. It goes to the editor by itself when a later appointment&apos;s footage is uploaded, with its own due date from that shoot.
      </p>
      <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
        {rows.map((r) => (
          <li key={r.outputId} data-second-shoot-video={r.number} className="px-3 py-2.5 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">Video {r.number}: {r.label}</p>
                {r.waiting && <p className="text-warning">{r.waiting}</p>}
                {!r.waiting && r.released && <p className="text-muted">{r.released}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {r.waiting ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => release(r.outputId, r.number)} className="inline-flex min-h-11 items-center rounded-xl bg-brand-action px-3 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50 sm:min-h-9">
                      Release to the editor
                    </button>
                    <button type="button" disabled={busy} onClick={() => { setOpen(r.outputId); setNote(r.note ?? ""); setDay(r.expectedDay ?? ""); setMsg(null); }} className="inline-flex min-h-11 items-center rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50 sm:min-h-9">
                      Edit note
                    </button>
                  </>
                ) : !r.finished ? (
                  <button type="button" disabled={busy} onClick={() => { setOpen(r.outputId); setNote(DEFAULT_NOTE); setDay(""); setMsg(null); }} className="inline-flex min-h-11 items-center rounded-xl border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50 sm:min-h-9">
                    Waiting on a second shoot
                  </button>
                ) : null}
              </div>
            </div>
            {open === r.outputId && (
              <div className="mt-2 space-y-2 rounded-lg bg-surface-2 p-2.5">
                <label className="block text-[13px] font-medium text-muted" htmlFor={`ss-note-${r.outputId}`}>Note (what is missing)</label>
                <input id={`ss-note-${r.outputId}`} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-surface px-2.5 text-sm" />
                <label className="block text-[13px] font-medium text-muted" htmlFor={`ss-day-${r.outputId}`}>Second appointment, if known</label>
                <input id={`ss-day-${r.outputId}`} type="date" value={day} onChange={(e) => setDay(e.target.value)} className="min-h-11 rounded-lg border border-border bg-surface px-2.5 text-sm" />
                <div className="flex gap-2">
                  <button type="button" disabled={busy} onClick={() => save(r.outputId)} className="inline-flex min-h-11 items-center rounded-xl bg-brand-action px-3 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:opacity-50 sm:min-h-9">
                    {r.waiting ? "Save note" : `Hold video ${r.number}`}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setOpen(null)} className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm hover:bg-surface sm:min-h-9">Cancel</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {msg && <p role="status" className={`mt-2 text-sm ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </section>
  );
}
