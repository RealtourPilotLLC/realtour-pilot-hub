"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { etMonthDayTime } from "@/lib/datetime";
import { approveAryeoAction, deliverInAryeoAction } from "@/app/ops/photo-delivery/actions";
import { UPLOAD_HELD_PREFIX, UPLOAD_OVERRIDE_MIN } from "@/lib/photoDelivery/holding";
import { OPEN_ADDON_STEPS, addOnConfirmLines, addOnNextStep, type AddOnConfirmLine } from "@/lib/photoDelivery/addOnSteps";
import { useJob } from "./JobContext";
import type { AryeoPushView } from "./types";

// ---------------------------------------------------------------------------
// THE HUB UPLOADS AND DELIVERS IN ARYEO (Oct 14 2026, aryeoPush.ts).
// Oct 15 (Jordan): a job waits in Ready to review until Kyle approves it:
// "Approve and deliver" (the photos go on the listing in order, then Aryeo's
// own Deliver Listing) or "Approve and upload to Aryeo" (Kyle delivers).
// Photos already up: "Deliver in Aryeo". Same-day orders approve themselves
// once every check passes. The Deliver panel shows what is next
// (aryeoPushNext). While a push
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
  const { jobId, readOnly } = useJob();
  const router = useRouter();
  const server = push.progress;
  const [live, setLive] = useState<{ base: Progress | null; p: Progress } | null>(null);
  // The progress route is the office's (each ask also moves the push on a
  // step): a view-only page shows the server's line and never asks (Oct 22 2026).
  const active = !!server?.active && !readOnly;
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

/** What the job needs next: Kyle's approval (first time, after a failure or a change), a delivery of photos already up, or nothing (running, delivered, off). */
export function aryeoPushNext(push: AryeoPushView): "approve" | "deliver" | null {
  const p = push.progress;
  if (!aryeoPushOn(push)) return null;
  if (!p) return "approve";
  if (p.active || p.deliveredAt) return null;
  if (p.state === "FAILED") return "approve";
  if (p.state === "WAITING" || p.state === "DONE") return p.changed ? "approve" : "deliver";
  return null;
}

export function aryeoPushLine(push: AryeoPushView): { text: string; tone: "muted" | "good" | "bad" | "busy" } | null {
  const p = push.progress;
  if (!p) return null;
  // Oct 21 2026: Update on Aryeo (the hub's edit replacing photos on the listing); the run before it comes back when it ends.
  if (p.update) return { text: `Updating ${p.total} edited photo${p.total === 1 ? "" : "s"} on the Aryeo listing${p.note ? `: ${p.note}` : "."}`, tone: "busy" };
  if (p.deliveredAt && p.state === "DONE") return { text: `Delivered in Aryeo by the hub ${etMonthDayTime(p.deliveredAt)}.`, tone: "good" };
  if (p.state === "FAILED") return { text: p.note ?? "Sending to Aryeo stopped.", tone: "bad" };
  if (p.state === "PREPARING") return { text: p.note ?? "Getting the photos ready in 06-Ready-for-Aryeo first.", tone: "busy" };
  // Oct 22 2026 (a split job): the photos already on the listing stay first and are never sent again.
  const kept = p.kept ? ` The ${p.kept} already on the listing stay first, in their order.` : "";
  if (p.state === "SENDING") return { text: `Sending to Aryeo: ${p.sent} of ${p.total}${p.already ? ` (${p.already} already there)` : ""}.${kept}`, tone: "busy" };
  if (p.state === "ADDING") return { text: "Adding the photos to the listing.", tone: "busy" };
  if (p.state === "CHECKING") return { text: p.note ?? "Checking that Aryeo has every photo.", tone: "busy" };
  if (p.state === "ORDERING") return { text: "Putting the photos in delivery order.", tone: "busy" };
  if (p.state === "DELIVERING" || p.state === "CONFIRMING") return { text: "Delivering in Aryeo.", tone: "busy" };
  const after = p.kept ? `, after the ${p.kept} already there` : "";
  if (p.state === "WAITING") return { text: p.note ?? `All ${p.total} photos are on the listing, in order${after}. Ready to deliver.`, tone: p.note ? "bad" : "good" };
  if (p.state === "DONE") return p.changed ? { text: p.note ?? "", tone: "bad" } : { text: `All ${p.total} photos are on the listing, in order${after}${p.note ? ` (${p.note})` : ""}. Deliver in Aryeo when ready.`, tone: p.duplicates?.length ? "bad" : "good" };
  return null;
}

/** Oct 21 2026: the approve summary ("You're delivering with 6 exterior issues ignored (…)") on top of a delivery confirm. Shown, never a block. */
function withWarning(warning: string | null | undefined, body: string) {
  if (!warning) return body;
  return (
    <>
      <span className="mb-2 block font-medium text-warning">{warning}</span>
      <span className="block">{body} Go back to look at them first, or deliver as they are.</span>
    </>
  );
}

/** Oct 23 2026 (huddle item 7): the special requests listed on top of a send's confirmation, each done or not. */
function withAddOns(lines: AddOnConfirmLine[], body: ReactNode): ReactNode {
  if (!lines.length) return body;
  return (
    <>
      <span className="mb-2 block font-medium">Special requests on this order:</span>
      <span className="mb-2 block space-y-0.5" data-addon-confirm>
        {lines.map((l) => (
          <span key={l.key} className="block">{l.done ? "Done: " : "Not done: "}{l.words}</span>
        ))}
      </span>
      <span className="block">{body}</span>
    </>
  );
}

/** Kyle's presses, each with its confirm: Approve and deliver, Approve and upload to Aryeo (and "Upload anyway"), Deliver in Aryeo. `warning`: the approve summary. */
export function useAryeoPushActions() {
  const { jobId, run, confirm, ask, notify, readOnly, data } = useJob();
  // Oct 23 2026 (huddle item 7): before the photos go up or out, virtual
  // staging and lot lines asked for or ordered are confirmed done. One not
  // done stops the send here with the plain next step, and opens its steps at
  // the top of the job (SpecialRequests).
  const addOnLines = addOnConfirmLines(data.gate?.checks);
  const addOnsReady = async (): Promise<boolean> => {
    const open = addOnLines.filter((l) => !l.done);
    if (!open.length) return true;
    const go = await confirm({
      title: `${open.map((l) => l.name).join(" and ")} not done yet`,
      body: withAddOns(addOnLines, addOnNextStep(open.map((l) => l.name))),
      confirmLabel: "Show me the steps",
    });
    if (go) {
      document.getElementById("pd-special-requests")?.scrollIntoView({ behavior: "smooth", block: "start" });
      window.dispatchEvent(new CustomEvent(OPEN_ADDON_STEPS, { detail: open[0].key }));
    }
    return false;
  };
  const approve = async (deliver: boolean, warning?: string | null) => {
    // Kyle approves (Oct 22 2026: a view-only page has no such press; the action refuses it too).
    if (readOnly) return;
    if (!(await addOnsReady())) return;
    if (deliver) {
      const ok = await confirm({
        title: "Approve and deliver?",
        body: withAddOns(addOnLines, withWarning(warning, "The hub puts the photos on the Aryeo listing in this order, then delivers it. The listing's customers get Aryeo's usual delivery email, and the hub checks the delivery afterwards.")),
        confirmLabel: "Approve and deliver",
      });
      if (!ok) return;
    } else if (addOnLines.length) {
      const ok = await confirm({
        title: "Approve and upload to Aryeo?",
        body: withAddOns(addOnLines, "The hub puts the photos on the Aryeo listing in this order. They are not delivered until you press Deliver in Aryeo."),
        confirmLabel: "Approve and upload",
      });
      if (!ok) return;
    }
    const r = await approveAryeoAction(jobId, { deliver }).catch(() => ({ ok: false, message: "The hub didn't answer. Try again in a moment." }));
    // Oct 22 2026 (photo audit H2): Approve and upload checks the same holds as
    // Approve and deliver. Kyle can still put the photos up past them, only
    // with a typed reason (kept on the job's activity); they are not delivered.
    if (!r.ok && !deliver && r.message.startsWith(UPLOAD_HELD_PREFIX)) {
      const reason = await ask({
        title: "Upload to Aryeo with things still open?",
        description: `${r.message.slice(UPLOAD_HELD_PREFIX.length).trim()} The photos go on the listing but are not delivered: Deliver in Aryeo still waits for the checklist. Write why they can go up now. It is kept on the job's activity.`,
        required: true,
        minLength: UPLOAD_OVERRIDE_MIN,
        confirmLabel: "Upload anyway",
        danger: true,
      });
      if (reason !== null) await run(() => approveAryeoAction(jobId, { deliver: false, holdReason: reason }));
      return;
    }
    if (!r.ok && /Send anyway/.test(r.message)) {
      const go = await confirm({ title: "The listing already has other photos", body: r.message.replace("press Send anyway", "press Upload anyway"), confirmLabel: "Upload anyway" });
      if (go) await run(() => approveAryeoAction(jobId, { deliver, anyway: true }));
      return;
    }
    notify(r.ok ? "ok" : "err", r.message);
  };
  const deliver = async (warning?: string | null) => {
    if (!(await addOnsReady())) return;
    const ok = await confirm({
      title: "Deliver this listing in Aryeo?",
      body: withAddOns(addOnLines, withWarning(warning, "The hub presses Aryeo's Deliver Listing. The listing's customers get Aryeo's usual delivery email, and the hub checks the photo count afterwards.")),
      confirmLabel: "Deliver in Aryeo",
    });
    if (ok) await run(() => deliverInAryeoAction(jobId));
  };
  return { approve, deliver };
}
