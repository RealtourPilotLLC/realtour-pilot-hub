"use client";

import { useState, useTransition } from "react";
import { UserPlus, X } from "lucide-react";
import { addShootCrew, removeShootCrew } from "@/app/upload/crewActions";

// ---------------------------------------------------------------------------
// WHO WAS ON THIS SHOOT (Oct 21 2026). One line for everyone: the shoot's
// photographer and any second shooter. The office, the owner and the
// creative manager can add a second shooter so they can open this page too.
// ---------------------------------------------------------------------------

export type CrewMember = { memberId: string; name: string };

export function ShootCrew({
  projectId, photographerName, crew, choices, canEdit,
}: {
  projectId: string;
  photographerName: string | null;
  crew: CrewMember[];
  /** Active photographers who could be added (not the photographer, not already crew). */
  choices: CrewMember[];
  canEdit: boolean;
}) {
  const [pending, start] = useTransition();
  const [pick, setPick] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(false);
  if (!crew.length && !canEdit) return null;

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) => start(async () => {
    const r = await fn().catch(() => ({ ok: false, message: "Couldn't save that. Try again." }));
    setMsg({ ok: r.ok, text: r.message });
    if (r.ok) { setPick(""); setOpen(false); }
  });

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm text-muted">
      {photographerName && <span><span className="font-medium text-foreground">{photographerName}</span> shot this</span>}
      {crew.map((c) => (
        <span key={c.memberId} className="inline-flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-[13px]">
          Second shooter: <span className="font-medium text-foreground">{c.name}</span>
          {canEdit ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => run(() => removeShootCrew(projectId, c.memberId))}
              aria-label={`Remove ${c.name} from this shoot`}
              className="inline-flex size-8 items-center justify-center rounded-full hover:bg-surface hover:text-foreground disabled:opacity-50"
            >
              <X className="size-3.5" />
            </button>
          ) : <span className="w-1.5" />}
        </span>
      ))}
      {canEdit && choices.length > 0 && !open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-brand hover:underline"
        >
          <UserPlus className="size-4" /> Add a second shooter
        </button>
      )}
      {canEdit && open && (
        <span className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto">
          <select
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            aria-label="Photographer to add"
            className="min-h-11 rounded-lg border border-border bg-surface px-2.5 text-sm text-foreground"
          >
            <option value="">Who else was there?</option>
            {choices.map((c) => <option key={c.memberId} value={c.memberId}>{c.name}</option>)}
          </select>
          <button
            type="button"
            disabled={!pick || pending}
            onClick={() => run(() => addShootCrew(projectId, pick))}
            className="min-h-11 rounded-lg bg-brand-action px-3 text-sm font-semibold text-brand-fg hover:opacity-90 disabled:opacity-50"
          >
            Add
          </button>
          <button type="button" onClick={() => setOpen(false)} className="min-h-11 rounded-lg px-2 text-sm text-muted hover:text-foreground">
            Cancel
          </button>
        </span>
      )}
      {msg && <span role="status" className={msg.ok ? "basis-full text-xs text-success" : "basis-full text-xs text-danger"}>{msg.text}</span>}
    </div>
  );
}
