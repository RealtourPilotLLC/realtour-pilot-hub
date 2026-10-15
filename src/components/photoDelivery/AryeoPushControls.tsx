"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, CircleAlert, Loader2, Send, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { aryeoPushProgressAction, deliverInAryeoAction, sendToAryeoAction } from "@/app/ops/photo-delivery/actions";
import { useJob } from "./JobContext";
import type { AryeoPushView } from "./types";

// ---------------------------------------------------------------------------
// THE HUB UPLOADS AND DELIVERS IN ARYEO (Oct 14 2026, aryeoPush.ts).
// "Send to Aryeo" puts the 06-Ready-for-Aryeo photos on the listing, in
// order, checked through Aryeo's API; "Deliver in Aryeo" presses Aryeo's own
// Deliver Listing once the delivery checklist passes. While a push runs, the
// panel moves it on and refreshes itself, like the Ready bar.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";

export function useAryeoPushPolling(push: AryeoPushView) {
  const { jobId } = useJob();
  const router = useRouter();
  const active = !!push.progress?.active;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      void aryeoPushProgressAction(jobId)
        .then(() => router.refresh())
        .catch(() => undefined);
    }, 8_000);
    return () => clearInterval(t);
  }, [active, jobId, router]);
}

export function aryeoPushLine(push: AryeoPushView): { text: string; tone: "muted" | "good" | "bad" | "busy" } | null {
  const p = push.progress;
  if (!p) return null;
  if (p.deliveredAt && p.state === "DONE") return { text: `Delivered in Aryeo by the hub ${etMonthDayTime(p.deliveredAt)}.`, tone: "good" };
  if (p.state === "FAILED") return { text: p.note ?? "Sending to Aryeo stopped.", tone: "bad" };
  if (p.state === "PREPARING") return { text: p.note ?? "Getting the photos ready in 06-Ready-for-Aryeo first.", tone: "busy" };
  if (p.state === "SENDING") return { text: `Sending to Aryeo: ${p.sent} of ${p.total}${p.already ? ` (${p.already} already there)` : ""}.`, tone: "busy" };
  if (p.state === "ADDING") return { text: "Adding the photos to the listing.", tone: "busy" };
  if (p.state === "CHECKING") return { text: p.note ?? "Checking that Aryeo has every photo.", tone: "busy" };
  if (p.state === "ORDERING") return { text: "Putting the photos in delivery order.", tone: "busy" };
  if (p.state === "DELIVERING" || p.state === "CONFIRMING") return { text: "Delivering in Aryeo.", tone: "busy" };
  if (p.state === "WAITING") return { text: p.note ?? `All ${p.total} photos are on the listing, in order. Ready to deliver.`, tone: p.note ? "bad" : "good" };
  if (p.state === "DONE") return { text: `All ${p.total} photos are on the listing, in order${p.note ? ` (${p.note})` : ""}. Deliver in Aryeo when ready.`, tone: "good" };
  return null;
}

export function AryeoPushControls({ push, readyToSend, compact = false }: { push: AryeoPushView; readyToSend: boolean; compact?: boolean }) {
  const { jobId, run, pending, confirm, notify } = useJob();
  const p = push.progress;
  if (push.mode === "off" || !push.connected) {
    if (compact) return null;
    return (
      <p className="mt-0.5 text-[12px] text-muted">
        {push.connected ? "The hub can upload and deliver for you: choose a stage in Photo Delivery settings." : "The hub can upload and deliver for you once its Aryeo login is set up (Connections → Aryeo hub login)."}
      </p>
    );
  }
  const busy = !!p?.active;
  const canDeliver = !!p && !p.deliveredAt && (p.state === "WAITING" || (p.state === "DONE" && !p.deliveredAt));
  const canSend = !busy && !(p?.deliveredAt);
  const send = async (anyway = false) => {
    const r = await sendToAryeoAction(jobId, { anyway });
    if (!r.ok && /Send anyway/.test(r.message)) {
      const go = await confirm({ title: "The listing already has other photos", body: r.message, confirmLabel: "Send anyway" });
      if (go) await run(() => sendToAryeoAction(jobId, { anyway: true }));
      return;
    }
    notify(r.ok ? "ok" : "err", r.message);
  };
  const deliver = async () => {
    const ok = await confirm({
      title: "Deliver this listing in Aryeo?",
      body: "The hub presses Aryeo's Deliver Listing. The listing's customers get Aryeo's usual delivery email, and the hub checks the photo count afterwards.",
      confirmLabel: "Deliver in Aryeo",
    });
    if (ok) await run(() => deliverInAryeoAction(jobId));
  };
  const line = aryeoPushLine(push);
  if (compact) {
    return canDeliver ? (
      <button type="button" disabled={pending} onClick={() => void deliver()} className={cn(btn, "bg-brand-action text-brand-fg hover:brightness-95")}>
        <Send aria-hidden className="size-4" /> Deliver in Aryeo
      </button>
    ) : null;
  }
  return (
    <div className="mt-1 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {canSend && (
          <button type="button" disabled={pending || !readyToSend} onClick={() => void send()} title={readyToSend ? "Put the finished photos on the listing, in order (06-Ready-for-Aryeo is made first when needed)" : "The photos are being copied to 06-Ready-for-Aryeo; send them when that finishes"} className={cn(btn, "border border-border-strong hover:bg-surface-2")}>
            <UploadCloud aria-hidden className="size-4" /> {p?.state === "FAILED" ? "Send to Aryeo again" : "Send to Aryeo"}
          </button>
        )}
        {busy && (
          <span className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-semibold text-muted">
            <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> Working in Aryeo
          </span>
        )}
        {canDeliver && (
          <button type="button" disabled={pending} onClick={() => void deliver()} className={cn(btn, "bg-brand-action text-brand-fg hover:brightness-95")}>
            <Send aria-hidden className="size-4" /> Deliver in Aryeo
          </button>
        )}
      </div>
      {line && (
        <p className={cn("flex items-start gap-1.5 text-[12px]", line.tone === "bad" ? "text-danger" : line.tone === "good" ? "text-success" : "text-muted")}>
          {line.tone === "good" ? <CheckCircle2 aria-hidden className="mt-px size-3.5 shrink-0" /> : line.tone === "bad" ? <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" /> : null}
          {line.text}
        </p>
      )}
    </div>
  );
}
