"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { decideRevisionFeeAction, holdReviewWindowAction, restartReviewClockAction } from "@/app/content/actions";
import { Button } from "@/components/ui/Action";

type Props = { mode: "window"; id: string; held: boolean } | { mode: "fee"; id: string };
type Operation = "restart" | "hold" | "release" | "CHARGE" | "WAIVE";
type Receipt = { outcome: "confirmed" | "refused" | "unknown"; message: string };
const label: Record<Operation, string> = { restart: "Clock restart", hold: "Review hold", release: "Hold release", CHARGE: "Charge decision", WAIVE: "Waive decision" };

/** Office-only caller controls visibility. Server actions retain role, CAS,
 * clock and fee rules. A receipt records the exact operation, never billing. */
export function ReviewMutationControls(props: Props) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, start] = useTransition();
  const pending = useRef(false);
  const held = useRef(false);
  const storageKey = `ops-review-attempt:${props.mode}:${props.id}`;
  useEffect(() => {
    let stopped = false;
    queueMicrotask(() => {
      if (stopped || pending.current) return;
      try {
        if (sessionStorage.getItem(storageKey)) {
          held.current = true;
          setReceipt({ outcome: "unknown", message: "A previous change on this exact record is unconfirmed." });
        }
      } catch { /* Every submission checks storage before starting a write. */ }
    });
    return () => { stopped = true; };
  }, [storageKey]);
  const run = (operation: Operation) => {
    if (pending.current || held.current) return;
    // Keep the same mode/ID guard on stale native handlers as on visible buttons.
    if (props.mode === "window" ? operation === "CHARGE" || operation === "WAIVE" : operation !== "CHARGE" && operation !== "WAIVE") return;
    let attempt: string;
    try {
      if (sessionStorage.getItem(storageKey)) {
        held.current = true;
        setReceipt({ outcome: "unknown", message: "A previous change on this exact record is unconfirmed." });
        return;
      }
      attempt = crypto.randomUUID();
      sessionStorage.setItem(storageKey, attempt);
    } catch {
      setReceipt({ outcome: "refused", message: "This browser could not keep the change's recovery status. No request was made. Restore browser storage before trying again." });
      return;
    }
    pending.current = true;
    start(async () => {
      try {
        const r = operation === "restart" ? await restartReviewClockAction(props.id)
          : operation === "hold" || operation === "release" ? await holdReviewWindowAction(props.id, operation === "hold", operation === "hold" ? "Held from the Content tab" : undefined)
          : await decideRevisionFeeAction(props.id, operation);
        const outcome = r.ok && r.outcome === "confirmed" ? "confirmed" : !r.ok && r.outcome === "refused" ? "refused" : "unknown";
        held.current = outcome === "unknown";
        setReceipt({ outcome, message: `${label[operation]}: ${outcome === "unknown" ? "not confirmed." : r.message}` });
        if (outcome !== "unknown") {
          try { if (sessionStorage.getItem(storageKey) === attempt) sessionStorage.removeItem(storageKey); }
          catch { held.current = true; setReceipt({ outcome: "unknown", message: `${label[operation]}: ${r.message} The local recovery status could not be cleared; check the exact record before another change.` }); }
        }
      } catch {
        held.current = true;
        setReceipt({ outcome: "unknown", message: `${label[operation]} was not confirmed.` });
      } finally { pending.current = false; }
    });
  };
  return <div className="max-w-full space-y-2">
    <div className="flex flex-wrap gap-2">
      {props.mode === "window" ? <>
        <Button variant="secondary" busy={busy} disabled={receipt?.outcome === "unknown"} onClick={() => run("restart")}>Restart clock</Button>
        <Button variant="secondary" busy={busy} disabled={receipt?.outcome === "unknown"} onClick={() => run(props.held ? "release" : "hold")}>{props.held ? "Release hold" : "Hold"}</Button>
      </> : <>
        <Button variant="secondary" busy={busy} disabled={receipt?.outcome === "unknown"} onClick={() => run("CHARGE")}>Charge</Button>
        <Button variant="secondary" busy={busy} disabled={receipt?.outcome === "unknown"} onClick={() => run("WAIVE")}>Waive</Button>
      </>}
    </div>
    {receipt && <p role={receipt.outcome === "confirmed" ? "status" : "alert"} className="break-words text-ui-secondary leading-relaxed">
      {receipt.message}
      {receipt.outcome === "unknown" && " It may already have been recorded. Further changes are blocked in this tab. Ask Kyle to inspect this exact review window or revision round before another change; refreshing is not proof that nothing changed."}
    </p>}
  </div>;
}
