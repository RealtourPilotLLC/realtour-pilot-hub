"use client";

import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { AlertTriangle, Check, Loader2, ThumbsUp, Undo2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  dismissReceipt,
  receiptsServerSnapshot,
  receiptsSnapshot,
  subscribeReceipts,
  type VerdictReceipt,
} from "./verdictReceiptStore";

// ---------------------------------------------------------------------------
// The confirmation a verdict leaves behind (Oct 5 2026) — see verdictReceiptStore.ts.
// Bottom of the screen, out of the way of the player and the next cut's notes:
// one short card per verdict. A confirmed one fades on its own; a refusal stays
// until the reviewer deals with it, and says exactly why and how to get back.
// ---------------------------------------------------------------------------

const FADE_MS = 10_000;

export function VerdictReceipts() {
  const list = useSyncExternalStore(subscribeReceipts, receiptsSnapshot, receiptsServerSnapshot);

  // A confirmed card goes on its own; anything still waiting or refused stays.
  useEffect(() => {
    const timers = list
      .filter((r) => r.state === "done")
      .map((r) => setTimeout(() => dismissReceipt(r.id), Math.max(0, (r.doneAt ?? Date.now()) + FADE_MS - Date.now())));
    return () => timers.forEach(clearTimeout);
  }, [list]);

  if (list.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-2 sm:inset-x-auto sm:right-6 sm:w-[26rem]">
      {list.map((r) => (
        <ReceiptCard key={r.id} r={r} />
      ))}
    </div>
  );
}

function ReceiptCard({ r }: { r: VerdictReceipt }) {
  const trouble = r.state === "refused" || r.state === "unknown";
  const Icon = trouble ? AlertTriangle : r.title.startsWith("Approved") ? ThumbsUp : Undo2;
  return (
    <div
      role={trouble ? "alert" : "status"}
      className={cn(
        "pointer-events-auto rounded-xl border bg-surface p-3 text-sm shadow-lg",
        trouble ? "border-warning/50" : "border-success/40",
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", trouble ? "text-warning" : "text-success")} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-foreground">
            {r.state === "refused" ? "Not recorded — " : r.state === "unknown" ? "Couldn't confirm — " : ""}
            {r.title}
            <span className="font-normal text-muted"> · {r.cut}</span>
          </p>
          <p className="mt-0.5 text-foreground/85">{r.message}</p>
          {!trouble && r.next && <p className="mt-1 text-xs text-muted">{r.next}</p>}
          {r.state === "pending" && (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
              <Loader2 className="size-3 animate-spin" /> Saving the verdict…
            </p>
          )}
          {r.state === "done" && (
            <p className="mt-1 inline-flex items-center gap-1 text-xs text-success">
              <Check className="size-3" /> Saved
            </p>
          )}
          {trouble && (
            <div className="mt-2 flex flex-wrap gap-2">
              {r.approveAnyway && (
                <button
                  type="button"
                  onClick={r.approveAnyway}
                  className="inline-flex min-h-11 items-center rounded-lg bg-success px-3 text-sm font-semibold text-white hover:opacity-90"
                >
                  Approve anyway
                </button>
              )}
              <Link
                href={r.cutHref}
                onClick={() => dismissReceipt(r.id)}
                className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2"
              >
                {r.state === "unknown" ? "Open the cut to check" : "Back to that cut"}
              </Link>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => dismissReceipt(r.id)}
          className="-m-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
