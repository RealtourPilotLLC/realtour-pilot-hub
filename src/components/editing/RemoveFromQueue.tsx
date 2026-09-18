"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Undo2 } from "lucide-react";
import { removeFromEditorQueue, restoreToEditorQueue } from "@/app/editing/actions";

// ---------------------------------------------------------------------------
// "Delete" a job from the Editing Room — which is not a delete, and the copy
// says so at the moment it matters rather than in a tooltip nobody opens.
//
// It asks WHY, for the same reason the approved-cut door does: the sentence is
// what the timeline carries and what the person bringing it back reads. Unlike
// that door the reason is optional, because taking a test job off a board is
// not a decision anybody needs to justify.
// ---------------------------------------------------------------------------

export function RemoveFromQueueButton({
  projectId,
  street,
  onReceipt,
}: {
  projectId: string;
  street: string;
  onReceipt?: (msg: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState("");
  const [busy, start] = useTransition();

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Take this job off the Editing Room — nothing else about it changes, and it can come back for 7 days"
        className="rounded-lg border border-border px-1.5 py-1 text-muted-2 hover:border-danger/40 hover:text-danger"
      >
        <Trash2 className="size-3.5" />
      </button>
    );
  }

  return (
    <div className="mt-1 w-64 rounded-xl border border-danger/35 bg-danger-soft/30 p-2.5">
      <p className="text-xs font-semibold">Take {street} off this board?</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-foreground/80">
        The edit card is cancelled. Nothing else changes — the job keeps its status, its videos, its
        cuts and its delivery. You can bring it back for 7 days.
      </p>
      <input
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        placeholder="Why? (optional)"
        className="mt-2 w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs outline-none focus:border-brand"
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            start(async () => {
              const r = await removeFromEditorQueue(projectId, why.trim() || undefined).catch(() => ({
                ok: false,
                message: "Couldn't do that — try again.",
              }));
              onReceipt?.(r.message);
              setOpen(false);
              setWhy("");
              router.refresh();
            })
          }
          className="rounded-lg bg-danger px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-60"
        >
          {busy ? "Removing" : "Remove it"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => { setOpen(false); setWhy(""); }}
          className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2"
        >
          Keep it
        </button>
      </div>
    </div>
  );
}

export type RemovedRow = {
  projectId: string;
  street: string;
  by: string | null;
  atISO: string;
  note: string | null;
  expiresISO: string;
};

const ET = "America/New_York";
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const daysLeft = (iso: string) =>
  Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

/** The undo window, made visible. Renders nothing when nothing is in it — an
 *  empty "Recently removed" box on every visit is how a control teaches people
 *  to stop reading it. */
export function RecentlyRemoved({ rows }: { rows: RemovedRow[] }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <section className="panel-shadow overflow-hidden rounded-2xl border border-border bg-surface">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-5 py-2.5">
        <Undo2 className="size-4 shrink-0 text-muted-2" />
        <h2 className="text-[15px] font-semibold">Recently removed</h2>
        <span className="text-xs text-muted">
          {rows.length} job{rows.length === 1 ? "" : "s"} off this board · still able to come back
        </span>
      </div>
      {msg && <p className="border-b border-border bg-surface-2/60 px-5 py-2 text-xs text-foreground/85">{msg}</p>}
      <ul className="divide-y divide-border">
        {rows.map((r) => (
          <li key={r.projectId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{r.street}</span>
              <span className="mt-0.5 block text-[11px] text-muted-2">
                {r.by ?? "The office"} · {when(r.atISO)} ET
                {r.note ? ` — “${r.note}”` : ""}
                {" · "}
                {daysLeft(r.expiresISO)} day{daysLeft(r.expiresISO) === 1 ? "" : "s"} left to bring it back
              </span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                start(async () => {
                  const res = await restoreToEditorQueue(r.projectId).catch(() => ({
                    ok: false,
                    message: "Couldn't do that — try again.",
                  }));
                  setMsg(res.message);
                  router.refresh();
                })
              }
              className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-brand hover:bg-surface-2 disabled:opacity-60"
            >
              Bring it back
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
