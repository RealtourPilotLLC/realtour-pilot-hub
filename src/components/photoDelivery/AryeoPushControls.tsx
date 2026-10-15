"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { etMonthDayTime } from "@/lib/datetime";
import { deliverInAryeoAction, sendToAryeoAction } from "@/app/ops/photo-delivery/actions";
import { useJob } from "./JobContext";
import type { AryeoPushView } from "./types";

// ---------------------------------------------------------------------------
// THE HUB UPLOADS AND DELIVERS IN ARYEO (Oct 14 2026, aryeoPush.ts).
// "Send to Aryeo" puts the 06-Ready-for-Aryeo photos on the listing, in
// order, checked through Aryeo's API; "Deliver in Aryeo" presses Aryeo's own
// Deliver Listing once the delivery checklist passes. The Deliver panel shows
// whichever is next as its one main button (aryeoPushNext). While a push
// runs, useLivePush asks how far it is (each ask also moves it on a step)
// and reloads the page only when the push reaches a new state.
// ---------------------------------------------------------------------------

type Progress = NonNullable<AryeoPushView["progress"]>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The push as the panel should show it: the server's view, kept live while a
 * push runs. Asks every 8 s through a GET route (a server action would make
 * Kyle's clicks wait behind it), never while the tab is hidden.
 */
export function useLivePush(push: AryeoPushView): AryeoPushView {
  const { jobId } = useJob();
  const router = useRouter();
  const server = push.progress;
  const [live, setLive] = useState<{ base: Progress | null; p: Progress } | null>(null);
  const active = !!server?.active;
  const state = server?.state ?? null;
  useEffect(() => {
    if (!active) return;
    let stop = false;
    void (async () => {
      while (!stop) {
        await sleep(8_000);
        if (stop) return;
        if (document.hidden) continue;
        const r = (await fetch(`/api/photo-delivery/progress/${jobId}?what=push`, { cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null)) as { progress: Progress | null } | null;
        const p = r?.progress;
        if (stop || !p) continue;
        // A new state (or the end) changes what the page shows: reload it. Otherwise only the line moves.
        if (p.state !== state || !p.active) router.refresh();
        else setLive({ base: server, p });
      }
    })();
    return () => {
      stop = true;
    };
  }, [active, state, server, jobId, router]);
  return live && live.base === server ? { ...push, progress: live.p } : push;
}

/** The hub's upload is switched on and its Aryeo login is saved. */
export const aryeoPushOn = (push: AryeoPushView) => push.mode !== "off" && push.connected;

/** What the hub's push needs next: send, send again (after a failure or a change), deliver, or nothing (running, delivered, off). */
export function aryeoPushNext(push: AryeoPushView): "send" | "send-again" | "deliver" | null {
  const p = push.progress;
  if (!aryeoPushOn(push)) return null;
  if (!p) return "send";
  if (p.active || p.deliveredAt) return null;
  if (p.state === "FAILED") return "send-again";
  if (p.state === "WAITING" || p.state === "DONE") return /Send to Aryeo again/.test(p.note ?? "") ? "send-again" : "deliver";
  return null;
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

/** The two presses, each with its confirm: "Send to Aryeo" (and "Send anyway") and "Deliver in Aryeo". */
export function useAryeoPushActions() {
  const { jobId, run, confirm, notify } = useJob();
  const send = async () => {
    const r = await sendToAryeoAction(jobId, { anyway: false }).catch(() => ({ ok: false, message: "The hub didn't answer. Try again in a moment." }));
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
  return { send, deliver };
}
