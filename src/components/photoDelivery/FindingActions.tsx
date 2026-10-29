"use client";

import { Ban, Camera, CheckCircle2, ChevronDown, CircleSlash, EyeOff, Hand, Undo2, UserRound, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { isFixedInAutohdr } from "@/lib/photoDelivery/fixedInAutohdr";
import { useJob } from "./JobContext";
import { HUMAN_CALL_LABEL, isUndoable } from "./format";
import type { FindingView } from "./types";

// ---------------------------------------------------------------------------
// The per-issue (or per-group) decision buttons, plan 8.3 and 9.4. In sight:
// Fix (add to the Fix Cart, only when there is a fix), Not worth fixing, Not
// there, and Fixed in AutoHDR (Oct 28 2026, Kyle: he fixes some himself in
// AutoHDR's editor; it records the issue as fixed, by him, now, with Undo:
// fixedInAutohdr.ts). The rest sit under "More": Send to editor, Reshoot (a
// recommendation only), Override, and the owner's Stop flagging this.
// A group-level decision applies to every open finding in the group (plan
// 7.5). Decided findings offer Undo instead (and Fixed in AutoHDR, so a "Not
// there" that was really a fix is put right in one tap). Findings in the
// hub's own fix (approved, running, fixed) show no buttons: a click never
// pulls a finding out of a running fix.
// ---------------------------------------------------------------------------

const btn =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-border-strong px-2.5 text-[13px] font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-50";

/** What to do instead when Fix is not offered (huddle finding 6: the reason and the next step, on screen, not in a tooltip). */
const NEXT_STEP: Record<string, string> = {
  "permanent-feature": "Next: Send to editor (under More), or fix it by hand in AutoHDR, then press Fixed in AutoHDR.",
  privacy: "Next: leave the photo out, or Send to editor (under More) to blur it.",
  "color-truth": "Next: compare it with the original, then Not there, or Send to editor (under More).",
  reshoot: "Next: Reshoot (under More, a recommendation only), or Not worth fixing.",
  editor: "Next: Send to editor (under More).",
  review: "Next: look at it, then decide with the buttons here.",
  "no-autohdr": "Next: the hub links the AutoHDR shoot within a few minutes, or fix it in AutoHDR.",
};

export function FindingActions({ findings, className, showFix = true }: { findings: FindingView[]; className?: string; showFix?: boolean }) {
  const { data, decide, addToCart, cartLineByFinding, queued, pending, viewer, stopFlagging, readOnly } = useJob();
  const ruleIds = [...new Set(findings.map((f) => f.ruleId))];
  const open = findings.filter((f) => f.status === "OPEN");
  // Oct 28 2026: a person's "Fixed in AutoHDR" is undoable; the hub's own fix is not (restore the photo's earlier version instead).
  const undoable = findings.filter((f) => isUndoable(f));
  const inFix = findings.filter((f) => (f.status === "APPROVED_FIX" || f.status === "FIXING" || f.status === "FIXED") && !isFixedInAutohdr(f));
  // Only on a job whose photos are in AutoHDR (the hub reads the fix back from there).
  const inAutohdr = !!data.header.autohdrPhotoshootId || data.photos.some((p) => p.sourceKind === "AUTOHDR");
  const fixedThere = (list: FindingView[], label = "Fixed in AutoHDR") => (
    <button
      type="button"
      className={btn}
      disabled={pending}
      onClick={() => void decide(list, "FIXED_IN_AUTOHDR")}
      title="You fixed it yourself in AutoHDR's editor. It counts as fixed, with your name and the time; Undo puts it back. The hub then reads AutoHDR's latest version of the photo."
      data-fixed-in-autohdr
    >
      <CheckCircle2 aria-hidden className="size-3.5" /> {label}
    </button>
  );
  // Huddle finding 5: why the automatic plan fixed or skipped it.
  const notes = [...new Set(findings.map((f) => f.planNote).filter((x): x is string => !!x))];
  const planLine = notes.length === 1 ? <p className="w-full text-[12px] text-muted">Automatic plan: {notes[0]}</p> : null;
  // Oct 21 2026: the client asked for this to be removed (an order note, a text, the wrap-up).
  const asked = findings.find((f) => f.clientAsk)?.clientAsk ?? null;
  const askedLine = asked ? (
    <p className="w-full text-[12px] font-medium text-warning">
      {asked.label}: &ldquo;{asked.what}&rdquo;. Fix it, or answer the request first (Deliver panel) before setting it aside.
    </p>
  ) : null;
  // VIEW ONLY (Oct 22 2026): keep, fix, ignore and every other call on a
  // finding is the office's. A viewer reads where it stands, no buttons.
  if (readOnly) {
    const fixing = inFix.length > 0 ? (inFix.every((f) => f.status === "FIXED") ? "Fixed." : "Fix running.") : findings.some((f) => isFixedInAutohdr(f)) ? "Fixed in AutoHDR." : null;
    if (!asked && !planLine && !fixing) return null;
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {asked && (
          <p className="w-full text-[12px] font-medium text-warning">
            {asked.label}: &ldquo;{asked.what}&rdquo;.
          </p>
        )}
        {fixing && <p className="w-full text-[12px] text-muted">{fixing}</p>}
        {planLine}
      </div>
    );
  }
  if (!open.length && !undoable.length) {
    if (!inFix.length && !planLine && !askedLine) return null;
    const fixed = inFix.every((f) => f.status === "FIXED");
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {askedLine}
        {inFix.length > 0 && (
          <p className="w-full text-[12px] text-muted">{fixed ? "Fixed. To undo, open the photo and restore an earlier version." : "Fix running."}</p>
        )}
        {planLine}
      </div>
    );
  }
  if (!open.length) {
    // Oct 28 2026 (Kyle's "Not there: Fixed with autohdr"): a call that was really a fix in AutoHDR, put right in one tap.
    const notFixed = undoable.filter((f) => !isFixedInAutohdr(f));
    return (
      <div className={cn("flex flex-wrap gap-1.5", className)}>
        {askedLine}
        <button type="button" className={btn} disabled={pending} onClick={() => void decide(undoable, "OPEN")}>
          <Undo2 aria-hidden className="size-3.5" /> Undo
        </button>
        {inAutohdr && notFixed.length > 0 && fixedThere(notFixed, "It was fixed in AutoHDR")}
        {planLine}
      </div>
    );
  }
  const lines = open.map((f) => cartLineByFinding.get(f.id)).filter(Boolean);
  const fixable = open.filter((f) => {
    const l = cartLineByFinding.get(f.id);
    return !!l && !l.humanCall;
  });
  // Oct 23 2026 (huddle item 6): Fix queues the fix where Kyle is (no jump to
  // the cart, the lightbox stays), and moves on: the Issues tab folds the
  // group into "Queued to fix" and the next issue takes the focus.
  const inCart = fixable.length > 0 && fixable.every((f) => queued.has(f.id));
  const fix = (e: React.MouseEvent<HTMLButtonElement>) => {
    const here = e.currentTarget.closest<HTMLElement>("[data-issue-group]");
    const next = (here?.nextElementSibling as HTMLElement | null) ?? null;
    if (addToCart(fixable.map((f) => f.id), { stay: true }) && next?.matches("[data-issue-group]")) {
      requestAnimationFrame(() => next.focus({ preventScroll: true }));
    }
  };
  const humanLine = lines.find((l) => l?.humanCall) ?? null;
  const humanWhy = humanLine?.humanCall ?? null;
  const damage = open.some((f) => f.ruleId === "FIX_DAMAGE_AI_EDIT");
  const belowFloor = open.every((f) => f.confidence < data.displayFloor);
  // Why Fix is not offered, and what to do instead.
  const whyNoFix = fixable.length
    ? null
    : damage
      ? "An earlier AI fix changed this photo. Next: open the photo, compare the Versions and Restore the one before the fix."
      : humanWhy === "autohdr-editor"
        ? `${humanLine?.howTo ? `Free in AutoHDR's editor: ${humanLine.howTo}` : HUMAN_CALL_LABEL["autohdr-editor"]} Then press Fixed in AutoHDR.`
        : humanWhy
          ? `${HUMAN_CALL_LABEL[humanWhy]} ${NEXT_STEP[humanWhy] ?? ""}`.trim()
          : !data.cart
            ? "The fix list could not be loaded. Reload the page."
            : belowFloor
              ? "The check was not sure. Next: look at the photo, then Not there or Not worth fixing."
              : "AutoHDR has no edit for this. Next: Send to editor (under More), or decide with the buttons here.";
  const n = open.length;
  const suffix = n > 1 ? ` (${n})` : "";
  // OTHER_DEFECT is the catch-all: switching it off would hide everything unnamed. An AI fix that changed the house is never switched off either,
  // nor a check the house always fixes, trash cans above all (audit C19, Oct 20 2026).
  const canStopFlagging = viewer.isOwner && ruleIds.length === 1 && ruleIds[0] !== "OTHER_DEFECT" && ruleIds[0] !== "FIX_DAMAGE_AI_EDIT" && !findings.some((f) => f.alwaysFixed || f.alwaysFlagged);
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)} role="group" aria-label="Decide">
      {askedLine}
      {showFix && fixable.length > 0 && (
        <button
          type="button"
          className={cn(btn, !inCart && "border-brand/50 bg-brand-soft")}
          disabled={pending}
          title={inCart ? "Queued in the Fix Cart: run it from the Fix Cart tab" : "Queue the fix in the Fix Cart and move on to the next issue"}
          onClick={fix}
        >
          <Wrench aria-hidden className="size-3.5" /> {inCart ? "Queued" : `Fix${fixable.length > 1 ? ` (${fixable.length})` : ""}`}
        </button>
      )}
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "IGNORED")} title="It is there, but not worth fixing here. After several of these, the hub stops fixing this kind of clutter on its own.">
        <Ban aria-hidden className="size-3.5" /> Not worth fixing{suffix}
      </button>
      <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "FALSE_POSITIVE")} title="The check got it wrong: it is not in the photo. After several of these, the hub fixes this only when the check is very sure.">
        <CircleSlash aria-hidden className="size-3.5" /> Not there
      </button>
      {inAutohdr && fixedThere(open, `Fixed in AutoHDR${suffix}`)}
      {undoable.length > 0 && (
        <button type="button" className={btn} disabled={pending} onClick={() => void decide(undoable, "OPEN")} title="Reopen the decided ones in this group">
          <Undo2 aria-hidden className="size-3.5" /> Undo {undoable.length}
        </button>
      )}
      {/* An opened "More" drops onto its own row, so its buttons never wedge between the others. */}
      <details className="group/more open:basis-full">
        <summary className={cn(btn, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
          More <ChevronDown aria-hidden className="size-3.5 transition-transform group-open/more:rotate-180" />
        </summary>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "SENT_TO_EDITOR")}>
            <UserRound aria-hidden className="size-3.5" /> Send to editor
          </button>
          <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "RESHOOT_REQUESTED")}>
            <Camera aria-hidden className="size-3.5" /> Reshoot
          </button>
          <button type="button" className={btn} disabled={pending} onClick={() => void decide(open, "OVERRIDDEN")}>
            <Hand aria-hidden className="size-3.5" /> Override
          </button>
          {canStopFlagging && (
            <button type="button" className={btn} disabled={pending} onClick={() => void stopFlagging(ruleIds[0], findings[0].ruleLabel || ruleIds[0])} title="Stop checking for this on every shoot">
              <EyeOff aria-hidden className="size-3.5" /> Stop flagging this
            </button>
          )}
        </div>
      </details>
      {showFix && whyNoFix && <p className="w-full text-[12px] text-muted">{whyNoFix}</p>}
      {planLine}
    </div>
  );
}
