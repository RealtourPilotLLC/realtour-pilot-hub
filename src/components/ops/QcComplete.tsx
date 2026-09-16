"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Check } from "lucide-react";
import { completeQcTask, acknowledgeQcCategory } from "@/app/ops/actions";

/**
 * "Photos done" — the button Kyle was missing (call, Sep 16). One press says
 * THIS category is QC'd and out; the card stays open for whatever the job
 * still owes, so the video's QC still comes back here. It ticks that
 * category's optional rows and writes nothing else — never the job's status,
 * never a delivery date.
 */
export function QcCategoryDone({ taskId, category }: { taskId: string; category: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const press = () =>
    start(async () => {
      const r = await acknowledgeQcCategory(taskId, category).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      setErr(r.ok ? null : r.message);
      if (r.ok) router.refresh();
    });
  return (
    <>
      <button
        onClick={press}
        disabled={busy}
        title={`Tick every ${category.toLowerCase()} check in one press. The card stays open for the rest of the job — use it when you've QC'd and delivered the ${category.toLowerCase()}.`}
        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-success/40 px-1.5 py-0.5 text-[11px] font-medium text-success hover:bg-success/10 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />} {category} done
      </button>
      {err && <span className="text-[11px] font-medium text-danger">{err}</span>}
    </>
  );
}

// "We should have a way to mark it completed" (Jordan, Sep 1 — 195 Woodhill,
// whose floor plan was REMOVED from the order for a discount, so the hub
// waits forever for a deliverable nobody owes). Asks for the reason in page,
// which lands on the project timeline so the close is explainable later.
// The QC checks are notes, not a gate (Sep 8): this button never waits on a
// tick, and its wording must not suggest it does.
export function QcComplete({ taskId, waitingOn, liveUnticked = [] }: { taskId: string; waitingOn: string[]; liveUnticked?: string[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const submit = () =>
    start(async () => {
      const r = await completeQcTask(taskId, note).catch(() => ({ ok: false, message: "Couldn’t save — try again." }));
      if (r.ok) { setOpen(false); setNote(""); router.refresh(); }
      else setErr(r.message);
    });

  if (!open) {
    return (
      <button
        onClick={() => { setOpen(true); setErr(null); }}
        title="Close this QC card now. The checks are optional notes, not a gate — e.g. the outstanding item was removed from the order, or everything is out and you're done."
        className="shrink-0 rounded-lg border border-border px-2 py-1 text-[11px] font-medium text-muted hover:bg-success/10 hover:text-success"
      >
        Mark complete
      </button>
    );
  }
  return (
    <div className="mt-1.5 w-full rounded-lg border border-success/30 bg-success/10 p-2.5">
      {/* Sep 16 (Kyle call): this button is the WHOLE card, and Kyle was using
          it to mean "the photos are out". Say what it costs — the outstanding
          category's QC leaves this screen until the media actually lands — and
          point at the per-category button that keeps the card alive. */}
      <p className="text-[11px] font-medium text-foreground/80">
        {waitingOn.length > 0
          ? `This closes the whole card and ${waitingOn.length === 1 ? `the ${waitingOn[0].toLowerCase()}'s` : "the rest of the"} QC will not come back here until it lands.${
              liveUnticked.length > 0 ? ` Use ${liveUnticked[0]} done to keep it open.` : ""
            } Why close it anyway?`
          : "Why is this done?"}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        <input
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") { setOpen(false); setNote(""); }
            if (e.key === "Enter" && !busy) { e.preventDefault(); submit(); }
          }}
          placeholder="e.g. floor plan removed from the order"
          className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-brand"
        />
        <button
          disabled={busy}
          onClick={submit}
          className="inline-flex items-center gap-1.5 rounded-lg bg-success px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />} Complete
        </button>
        <button onClick={() => { setOpen(false); setNote(""); setErr(null); }} className="rounded-lg px-2 py-1.5 text-xs text-muted hover:text-foreground">
          Cancel
        </button>
      </div>
      {err && <p className="mt-1.5 text-[11px] font-medium text-danger">{err}</p>}
    </div>
  );
}
