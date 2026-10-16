"use client";

import { useId, useTransition } from "react";
import { Home } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/components/ui/Toast";
import { setPrepModeAction } from "@/app/ops/photo-delivery/actions";
import type { PrepModeKey, PrepView } from "./types";

// ---------------------------------------------------------------------------
// HOW PREPARED THE HOME IS (Oct 15 2026, prep.ts). Jordan: "I want to focus
// on removing things from properties where they took the time to prepare, not
// the ones that are dumps." The hub reads it from the photo check; the chip
// says what it decided and why. The owner can set it for this job (As-is,
// Prepared, Vacant) or put it back to automatic; clutter follows at once.
// ---------------------------------------------------------------------------

const LABEL: Record<PrepModeKey, string> = { AS_IS: "As-is home", PREPARED: "Prepared home", VACANT: "Vacant home" };
const TONE: Record<PrepModeKey, string> = {
  AS_IS: "bg-warning-soft text-warning ring-warning/30",
  PREPARED: "bg-success-soft text-success ring-success/30",
  VACANT: "bg-surface-2 text-foreground ring-border",
};
const WHAT: Record<PrepModeKey, string> = {
  AS_IS: "Clutter is not checked.",
  PREPARED: "Clutter is checked in the rooms that look ready.",
  VACANT: "Things left in empty rooms are checked.",
};

export function PrepModeControl({ jobId, prep, canSet }: { jobId: string; prep: PrepView; canSet: boolean }) {
  const [pending, start] = useTransition();
  const { toast, show } = useToast();
  const id = useId();
  const byPerson = !!prep.by && prep.by !== "auto";
  const why = byPerson ? `Set by ${prep.by}.` : prep.reason ? `Read from the photos: ${prep.reason}.` : "The photo check has not rated enough rooms yet.";
  const hidden = prep.hiddenAsIs + prep.hiddenRooms;
  const set = (value: string) =>
    start(async () => {
      try {
        const r = await setPrepModeAction({ jobId, mode: value === "auto" ? null : (value as PrepModeKey) });
        show(r.ok ? "ok" : "err", r.message);
      } catch {
        show("err", "The hub didn't answer. Reload the page to see what is saved.");
      }
    });
  return (
    <div className="space-y-1">
      <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-semibold ring-1 ring-inset", prep.mode ? TONE[prep.mode] : "bg-surface-2 text-muted ring-border")}>
        <Home aria-hidden className="size-3.5" />
        {prep.mode ? LABEL[prep.mode] : "Not rated yet"}
      </span>
      <span className="block text-[13px] text-muted">
        {prep.mode ? `${WHAT[prep.mode]} ` : ""}
        {why}
        {hidden > 0 ? ` ${hidden} clutter item${hidden === 1 ? "" : "s"} not shown.` : ""}
      </span>
      {canSet && (
        <div className="flex items-center gap-2">
          <label htmlFor={id} className="text-[13px] text-muted">Set for this job</label>
          <select
            id={id}
            disabled={pending}
            value={byPerson && prep.mode ? prep.mode : "auto"}
            onChange={(e) => set(e.target.value)}
            className="min-h-10 rounded-lg border border-border-strong bg-surface-2 px-2 text-[13px] disabled:opacity-50"
          >
            <option value="auto">Automatic</option>
            <option value="PREPARED">Prepared</option>
            <option value="AS_IS">As-is</option>
            <option value="VACANT">Vacant</option>
          </select>
        </div>
      )}
      {toast}
    </div>
  );
}
