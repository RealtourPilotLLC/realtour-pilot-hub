"use client";

import { useState, useTransition } from "react";
import { PackagePlus, Plus, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { addShootAddOn, removeShootAddOn } from "@/app/upload/actions";
import type { ShootAddOn } from "@/app/upload/shootAddOns";

// Jordan, Sep 2 2026: "On the upload portal for the checks, they should be able
// to add an item that was added on at the shoot so that Kyle sees that next day
// on the ops day page to add an item to the order."
//
// Deliberately NOT a deliverable tick: the order in Aryeo is the source of
// truth for what's owed, and only the office can change it. What the
// photographer creates here is a job for Kyle — one internal_instruction task
// per item, which /ops Open Loops already renders with a "Handled" button.
//
// No money on this surface (it's creative-facing): the item and the context,
// never a price.
export function AddedAtShoot({
  projectId,
  initial,
}: {
  projectId: string;
  initial: ShootAddOn[];
}) {
  const [rows, setRows] = useState<ShootAddOn[]>(initial);
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pending, start] = useTransition();

  // Both actions answer with {ok, message} — including when the session guard
  // refuses — but a server action can still REJECT outright (dropped signal,
  // a deploy mid-tap, an unexpected server error), and an uncaught rejection
  // inside startTransition leaves the photographer with a control that looks
  // dead. Nothing on this page may fail silently: they're standing in the
  // driveway and this is the only record that the agent added work.
  const failed = (e: unknown) => {
    const m = e instanceof Error ? e.message.trim() : "";
    // Next redacts unexpected server errors in production, so only show a
    // message that actually reads like one of ours.
    const usable = m && m.length <= 160 && !/server components|omitted in production|digest/i.test(m);
    setMsg({
      text: usable ? m : "Couldn’t save that — you may have been signed out, or the connection dropped. Refresh this page and try again.",
      ok: false,
    });
  };

  const submit = () => {
    const name = item.trim();
    if (!name) return;
    start(async () => {
      try {
        const r = await addShootAddOn(projectId, name, note);
        setMsg({ text: r.message, ok: r.ok });
        if (r.ok && r.row) {
          // Merge by id so the "already on the list" path updates the existing
          // row instead of showing it twice.
          setRows((prev) => [...prev.filter((x) => x.id !== r.row!.id), r.row!]);
          setItem("");
          setNote("");
        }
        // The typed item + note are deliberately LEFT in the boxes on any
        // failure, so a retry is one tap and nothing they wrote is lost.
      } catch (e) {
        failed(e);
      }
    });
  };

  const remove = (id: string) => {
    start(async () => {
      try {
        const r = await removeShootAddOn(projectId, id);
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
        <PackagePlus className="size-4 text-brand" />
        Added at the shoot
      </h2>
      <p className="mt-0.5 text-xs text-muted">
        Did the agent add anything on site that wasn&apos;t on the order — an extra twilight, drone,
        a second reel? List it here and the office will add it to the order.
      </p>

      {rows.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-start gap-2 rounded-xl border bg-surface-2 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {r.item}
                  {r.handled && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[11px] font-semibold text-success">
                      <Check className="size-3" /> added to the order
                    </span>
                  )}
                </div>
                {r.note && <div className="mt-0.5 text-xs text-muted">{r.note}</div>}
                <div className="mt-0.5 text-[11px] text-muted-2">
                  {r.addedBy ? `${r.addedBy} · ` : ""}
                  {etDateTime(r.addedAtISO)}
                  {!r.handled && " · waiting on the office"}
                </div>
              </div>
              {!r.handled && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => remove(r.id)}
                  aria-label={`Remove ${r.item}`}
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
          <Plus className="size-4" /> Add an item
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            value={item}
            onChange={(e) => setItem(e.target.value)}
            maxLength={80}
            placeholder="What was added? (e.g. Twilight photos, Drone add-on)"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <AutoTextarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            minRows={2}
            maxLength={500}
            placeholder="Anything the office should know (optional) — who asked, what was agreed…"
            className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button
            type="button"
            disabled={pending || !item.trim()}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Add item"}
          </button>
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
