"use client";

import { useState, useTransition } from "react";
import { CalendarPlus, Plus, Check, X, Clapperboard } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDate, etDateTime } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { reopenForAdditionalShoot, withdrawAdditionalShoot } from "@/app/upload/actions";
import {
  ADDITIONAL_VIDEO_CHOICE,
  ADDITIONAL_VIDEO_TYPES,
  type AdditionalShoot as Row,
  type AdditionalVideoType,
} from "@/app/upload/additionalShoots";

// Jordan, Sep 18 2026: "I also need a way to add an additional video to a
// project that was already approved and delivered … he ended up doing a second
// reel for that listing and it was shot on a separate day."
//
// This is the door back in. Deliberately NOT a second upload page: the job, the
// client, the Dropbox folder, the brief and the checklist all already exist on
// this screen, so the extra shoot becomes one more video ON this job and the
// checklist above simply grows a row to tick. What it can never do is change
// anything about the delivery that already went out — the server action is the
// place that promise is kept, and the copy here says so out loud so nobody taps
// it thinking it un-delivers the job.
//
// No money on this surface (it is creative-facing): what was shot and when,
// never a price and never what the extra one is worth.
export function AdditionalShoot({
  projectId,
  initial,
  /** ET day keys, resolved on the server — the browser's own clock may be in
   *  another timezone and would offer a day ET has not reached. */
  todayKey,
  minKey,
  jobShootISO,
  delivered,
}: {
  projectId: string;
  initial: Row[];
  todayKey: string;
  minKey: string;
  jobShootISO: string | null;
  delivered: boolean;
}) {
  const [rows, setRows] = useState<Row[]>(initial);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AdditionalVideoType>("SOCIAL_REEL");
  const [shotOn, setShotOn] = useState(todayKey);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, start] = useTransition();

  // Both actions answer with {ok, message} — including when the session guard
  // refuses — but a server action can still REJECT outright (dropped signal, a
  // deploy mid-tap, an unexpected server error), and an uncaught rejection
  // inside startTransition leaves the photographer with a control that looks
  // dead. Same handling as AddedAtShoot, for the same reason: they are standing
  // in a driveway and this is the only record the extra footage exists.
  const failed = (e: unknown) => {
    const m = e instanceof Error ? e.message.trim() : "";
    const usable = m && m.length <= 160 && !/server components|omitted in production|digest/i.test(m);
    setMsg({
      text: usable ? m : "Couldn’t save that — you may have been signed out, or the connection dropped. Refresh this page and try again.",
      ok: false,
    });
  };

  const submit = () => {
    start(async () => {
      try {
        const r = await reopenForAdditionalShoot(projectId, { type, shotOn, note });
        setMsg({ text: r.message, ok: r.ok });
        if (r.ok && r.row) {
          setRows((prev) => [...prev.filter((x) => x.id !== r.row!.id), r.row!]);
          setOpen(false);
          setNote("");
        }
        // The typed note and the picked day stay put on any failure, so a retry
        // is one tap and nothing they filled in is lost.
      } catch (e) {
        failed(e);
      }
    });
  };

  const remove = (id: string) => {
    start(async () => {
      try {
        const r = await withdrawAdditionalShoot(projectId, id);
        if (r.ok) {
          setRows((prev) => prev.filter((x) => x.id !== id));
          setMsg(null);
        } else setMsg({ text: r.message ?? "Couldn’t remove that.", ok: false });
      } catch (e) {
        failed(e);
      }
    });
  };

  return (
    <section className="mt-4 rounded-2xl border bg-surface p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <CalendarPlus className="size-4 text-brand" />
        Shot something else for this job?
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        A second reel or video filmed on a different day. It joins this job as its own video —
        with its own row in the Editing Room — and the office adds it to the order.
        {delivered && " What already went to the client stays exactly as it is."}
      </p>

      {rows.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-2 rounded-xl border bg-surface-2 px-3 py-2">
              <Clapperboard className="mt-0.5 size-4 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {r.label}
                  {r.uploadedISO ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success">
                      <Check className="size-3" /> raws in
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-brand/15 px-1.5 py-0.5 text-[11px] font-semibold text-brand">
                      still to upload
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-2">
                  shot {etDate(r.shotOnISO)}
                  {r.addedBy ? ` · added by ${r.addedBy}` : ""} · {etDateTime(r.addedAtISO)}
                </div>
              </div>
              {/* Removable only while nothing hangs off it — once the raws are
                  in, or a cut exists, taking the row away would orphan real
                  work, so the office does that one. */}
              {!r.uploadedISO && !r.hasWork && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(r.id)}
                  aria-label={`Remove ${r.label}`}
                  className="shrink-0 rounded-lg p-1 text-muted-2 hover:bg-surface hover:text-danger disabled:opacity-50"
                >
                  <X className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2"
        >
          <Plus className="size-4" /> Add another shoot
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {ADDITIONAL_VIDEO_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setType(t)}
                aria-pressed={type === t}
                className={cn(
                  "rounded-lg border px-3 py-1.5 text-sm font-medium",
                  type === t ? "border-brand bg-brand-soft text-brand" : "border-border hover:bg-surface-2",
                )}
              >
                {ADDITIONAL_VIDEO_CHOICE[t]}
              </button>
            ))}
          </div>
          <label className="block text-xs font-medium text-muted">
            What day did you shoot it?
            <input
              type="date"
              value={shotOn}
              min={minKey}
              max={todayKey}
              onChange={(e) => setShotOn(e.target.value)}
              className="mt-1 block w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg outline-none focus:border-brand"
            />
          </label>
          {jobShootISO && (
            <p className="text-[11px] text-muted-2">
              The original shoot was {etDate(jobShootISO)} — that date stays as this job&rsquo;s shoot date.
            </p>
          )}
          {/* SAY IT BEFORE THEY FILE IT, not after they check My Pay (Jordan,
              Sep 18: "photographer does not get paid for a second shoot day
              unless explicitly stated. Either by an aerial, a appointment, or
              order"). Filing here is none of the three, and payroll is
              appointment-centric — a second appointment on another day already
              pays a return trip at the person's flat rate, and a second order
              pays as its own job. So this box is about the WORK, and the pay
              follows the appointment or the order, never this form. */}
          <p className="text-[11px] text-muted-2">
            This doesn&rsquo;t put the day on your pay. A return visit is paid when it has an
            appointment or an order of its own — ask the office to add one if this was a paid trip.
          </p>
          <AutoTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minRows={2}
            maxLength={500}
            placeholder="Anything the office and the editor should know (optional) — who asked for it, what it's for…"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={pending || !shotOn}
              onClick={submit}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Saving…" : "Add this shoot"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => { setOpen(false); setMsg(null); }}
              className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p
          role="status"
          aria-live="polite"
          className={cn("mt-2 text-xs", msg.ok ? "text-success" : "text-danger")}
        >
          {msg.text}
        </p>
      )}
    </section>
  );
}
