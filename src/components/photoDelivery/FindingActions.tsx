"use client";

import { Ban, Camera, CircleSlash, Hand, Undo2, UserRound, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJob } from "./JobContext";
import { HUMAN_CALL_LABEL, UNDOABLE } from "./format";
import type { FindingView } from "./types";

// ---------------------------------------------------------------------------
// The per-issue (or per-group) decision buttons, plan 8.3 and 9.4:
//   Fix (add to the Fix Cart) · Ignore · Not an issue · Send to editor ·
//   Request reshoot (a recommendation only) · Override.
// A group-level decision applies to every open finding in the group (plan
// 7.5). Decided findings offer Undo instead. Findings already in a fix
// (approved, running, fixed) show no buttons: a click never pulls a finding
// out of a running fix.
// ---------------------------------------------------------------------------

const btn =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50";

export function FindingActions({ findings, className, showFix = true }: { findings: FindingView[]; className?: string; showFix?: boolean }) {
  const { decide, addToCart, cartLineByFinding, selected, pending } = useJob();
  const open = findings.filter((f) => f.status === "OPEN");
  const undoable = findings.filter((f) => UNDOABLE.has(f.status));
  if (!open.length && !undoable.length) return null;
  if (!open.length) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        <button type="button" className={btn} disabled={pending} onClick={() => void decide(undoable, "OPEN")}>
          <Undo2 aria-hidden className="size-3.5" /> Undo
        </button>
      </div>
    );
  }
  const lines = open.map((f) => cartLineByFinding.get(f.id)).filter(Boolean);
  const fixable = open.filter((f) => {
    const l = cartLineByFinding.get(f.id);
    return !!l && !l.humanCall;
  });
  const inCart = fixable.length > 0 && fixable.every((f) => selected.has(f.id));
  const humanWhy = lines.find((l) => l?.humanCall)?.humanCall ?? null;
  const n = open.length;
  const suffix = n > 1 ? ` (${n})` : "";
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} role="group" aria-label="Decide">
      {showFix && (
        <button
          type="button"
          className={cn(btn, fixable.length && !inCart && "border-brand/50 bg-brand-soft")}
          disabled={pending || !fixable.length}
          title={!fixable.length ? (humanWhy ? HUMAN_CALL_LABEL[humanWhy] : "No automatic fix for this one") : inCart ? "Already in the Fix Cart" : "Add the fix to the Fix Cart"}
          onClick={() => addToCart(fixable.map((f) => f.id))}
        >
          <Wrench aria-hidden className="size-3.5" /> {inCart ? "In cart" : `Fix${fixable.length > 1 ? ` (${fixable.length})` : ""}`}
        </button>
      )}
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "IGNORED")}>
        <Ban aria-hidden className="size-3.5" /> Ignore{suffix}
      </button>
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "FALSE_POSITIVE")}>
        <CircleSlash aria-hidden className="size-3.5" /> Not an issue
      </button>
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "SENT_TO_EDITOR")}>
        <UserRound aria-hidden className="size-3.5" /> Send to editor
      </button>
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "RESHOOT_REQUESTED")}>
        <Camera aria-hidden className="size-3.5" /> Reshoot
      </button>
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "OVERRIDDEN")}>
        <Hand aria-hidden className="size-3.5" /> Override
      </button>
      {undoable.length > 0 && (
        <button type="button" className={btn} disabled={pending} onClick={() => void decide(undoable, "OPEN")} title="Reopen the decided ones in this group">
          <Undo2 aria-hidden className="size-3.5" /> Undo {undoable.length}
        </button>
      )}
    </div>
  );
}
