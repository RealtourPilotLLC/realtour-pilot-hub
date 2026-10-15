"use client";

import { Ban, Camera, CircleSlash, EyeOff, Hand, Undo2, UserRound, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJob } from "./JobContext";
import { HUMAN_CALL_LABEL, UNDOABLE } from "./format";
import type { FindingView } from "./types";

// ---------------------------------------------------------------------------
// The per-issue (or per-group) decision buttons, plan 8.3 and 9.4:
//   Fix (add to the Fix Cart) · Not worth fixing · Not there · Send to editor ·
//   Request reshoot (a recommendation only) · Override.
// A group-level decision applies to every open finding in the group (plan
// 7.5). Decided findings offer Undo instead. Findings already in a fix
// (approved, running, fixed) show no buttons: a click never pulls a finding
// out of a running fix.
// ---------------------------------------------------------------------------

const btn =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50";

/** What to do instead when Fix is not offered (huddle finding 6: the reason and the next step, on screen, not in a tooltip). */
const NEXT_STEP: Record<string, string> = {
  "permanent-feature": "Next: Send to editor, or fix it by hand in AutoHDR.",
  privacy: "Next: leave the photo out, or Send to editor to blur it.",
  "color-truth": "Next: compare it with the original, then Send to editor or mark it Not there.",
  reshoot: "Next: Reshoot (a recommendation), or Not worth fixing.",
  editor: "Next: Send to editor.",
  review: "Next: look at it, then decide with the buttons here.",
  "no-autohdr": "Next: the hub links the AutoHDR shoot within a few minutes; or fix it in AutoHDR.",
};

export function FindingActions({ findings, className, showFix = true }: { findings: FindingView[]; className?: string; showFix?: boolean }) {
  const { data, decide, addToCart, cartLineByFinding, selected, pending, viewer, stopFlagging } = useJob();
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))];
  const open = findings.filter((f) => f.status === "OPEN");
  const undoable = findings.filter((f) => UNDOABLE.has(f.status));
  const inFix = findings.filter((f) => f.status === "APPROVED_FIX" || f.status === "FIXING" || f.status === "FIXED");
  // Huddle finding 5: why the automatic plan fixed or skipped it.
  const notes = [...new Set(findings.map((f) => f.planNote).filter((x): x is string => !!x))];
  const planLine = notes.length === 1 ? <p className="w-full text-[12px] text-muted">Automatic plan: {notes[0]}</p> : null;
  if (!open.length && !undoable.length) {
    if (!inFix.length && !planLine) return null;
    const fixed = inFix.every((f) => f.status === "FIXED");
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {inFix.length > 0 && (
          <p className="w-full text-[12px] text-muted">
            {fixed
              ? "No buttons: already fixed (checked after the fix). To take a fix back, open the photo and Restore the version before it."
              : "No buttons: a fix is approved or running. Wait for it to finish; the photo's Versions show before and after."}
          </p>
        )}
        {planLine}
      </div>
    );
  }
  if (!open.length) {
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        <button type="button" className={btn} disabled={pending} onClick={() => void decide(undoable, "OPEN")}>
          <Undo2 aria-hidden className="size-3.5" /> Undo
        </button>
        {planLine}
      </div>
    );
  }
  const lines = open.map((f) => cartLineByFinding.get(f.id)).filter(Boolean);
  const fixable = open.filter((f) => {
    const l = cartLineByFinding.get(f.id);
    return !!l && !l.humanCall;
  });
  const inCart = fixable.length > 0 && fixable.every((f) => selected.has(f.id));
  const humanLine = lines.find((l) => l?.humanCall) ?? null;
  const humanWhy = humanLine?.humanCall ?? null;
  const damage = open.some((f) => f.ruleId === "FIX_DAMAGE_AI_EDIT");
  const belowFloor = open.every((f) => f.confidence < data.displayFloor);
  // Why Fix is not offered, and what to do instead.
  const whyNoFix = fixable.length
    ? null
    : damage
      ? "No Fix button: an earlier AI fix changed this photo. Next: open the photo, compare the Versions and Restore the one before the fix."
      : humanWhy === "autohdr-editor"
        ? `No Fix button: free in AutoHDR's own editor. ${humanLine?.howTo ?? HUMAN_CALL_LABEL["autohdr-editor"]}`
        : humanWhy
          ? `No Fix button: ${HUMAN_CALL_LABEL[humanWhy]} ${NEXT_STEP[humanWhy] ?? ""}`.trim()
          : !data.cart
            ? "No Fix button right now: the fix list could not be loaded. Reload the page."
            : belowFloor
              ? `No Fix button: the check was not sure enough (under ${Math.round(data.displayFloor * 100)}%). Next: look at the photo, then Not there, Not worth fixing or Send to editor.`
              : "No Fix button: AutoHDR has no edit for this. Next: Send to editor, or decide with the buttons here.";
  const n = open.length;
  const suffix = n > 1 ? ` (${n})` : "";
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} role="group" aria-label="Decide">
      {showFix && (
        <button
          type="button"
          className={cn(btn, fixable.length && !inCart && "border-brand/50 bg-brand-soft")}
          disabled={pending || !fixable.length}
          title={!fixable.length ? whyNoFix ?? undefined : inCart ? "Already in the Fix Cart" : "Add the fix to the Fix Cart"}
          onClick={() => addToCart(fixable.map((f) => f.id))}
        >
          <Wrench aria-hidden className="size-3.5" /> {inCart ? "In cart" : `Fix${fixable.length > 1 ? ` (${fixable.length})` : ""}`}
        </button>
      )}
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "IGNORED")} title="It is there, but not worth fixing here. After several of these, the hub stops fixing this kind of clutter on its own.">
        <Ban aria-hidden className="size-3.5" /> Not worth fixing{suffix}
      </button>
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "FALSE_POSITIVE")} title="The check got it wrong: it is not in the photo. After several of these, the hub fixes this only when the check is very sure.">
        <CircleSlash aria-hidden className="size-3.5" /> Not there
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
      {/* OTHER_DEFECT is the catch-all: switching it off would hide everything unnamed. An AI fix that changed the house is never switched off either. */}
      {viewer.isOwner && ruleIds.length === 1 && ruleIds[0] !== "OTHER_DEFECT" && ruleIds[0] !== "FIX_DAMAGE_AI_EDIT" && (
        <button type="button" className={btn} disabled={pending} onClick={() => void stopFlagging(ruleIds[0], findings[0].ruleLabel || ruleIds[0])} title="Stop checking for this on every shoot">
          <EyeOff aria-hidden className="size-3.5" /> Stop flagging this
        </button>
      )}
      {undoable.length > 0 && (
        <button type="button" className={btn} disabled={pending} onClick={() => void decide(undoable, "OPEN")} title="Reopen the decided ones in this group">
          <Undo2 aria-hidden className="size-3.5" /> Undo {undoable.length}
        </button>
      )}
      {showFix && whyNoFix && <p className="w-full text-[12px] text-muted">{whyNoFix}</p>}
      {showFix && inCart && <p className="w-full text-[12px] text-muted">In the Fix Cart: open the Fix Cart tab and press Run selected to send it.</p>}
      {planLine}
    </div>
  );
}
