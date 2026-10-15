"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Download, ExternalLink, FlaskConical, Loader2, RefreshCw, ShieldCheck, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { CopyButton } from "@/components/ui/CopyButton";
import { overrideDeliverAction, restageForAryeoAction, startDeliveryAction, verifyDeliveryAction } from "@/app/ops/photo-delivery/actions";
import { PhotoImg } from "./PhotoImg";
import { ReadyProgressBar, type ReadyBarState } from "./ReadyProgressBar";
import { useJob } from "./JobContext";
import { AryeoPushControls, aryeoPushLine, useAryeoPushPolling } from "./AryeoPushControls";

// ---------------------------------------------------------------------------
// THE DELIVER PANEL (plan 9.6), sticky at the bottom of the job page.
//   · The gate checklist, live. In shadow mode it is ADVISORY (a badge says
//     so): it is shown, but it never stops Kyle while QC is calibrated.
//   · "Replace these on the Aryeo listing": photos fixed through AutoHDR
//     after they went on the listing. The hub cannot upload to Aryeo, so each
//     has a Download of the fixed JPEG (named after the photo) to swap in.
//   · The steps: open the listing, the folder, the order to match (thumbnail
//     strip with the delivery names) and the pre-written message (Realtour
//     Pilot Team voice) with Copy.
//   · Mark as delivering; the owner-only "Override and deliver" with a typed
//     reason (never for an open privacy or wrong-property issue); Verify now.
// The hub confirms on its own when Aryeo says the listing was delivered.
// ---------------------------------------------------------------------------

const START_FROM = new Set(["READY", "QC_REVIEW", "EDITED", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);
const STAGE_WHY: Record<string, string> = {
  EDITING: "AutoHDR's edits are not in yet.",
  EDIT_FAILED: "The edit failed. Sort that out first.",
  QC_RUNNING: "QC is running on this gallery right now.",
  FIXING: "Approved fixes are still running.",
  ON_HOLD: "On hold: release the hold first.",
  DELIVERING: "Already marked as delivering. Waiting for Aryeo to confirm.",
  DELIVERED: "Delivered and verified.",
};
const btn = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl px-3.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";

export function DeliverPanel() {
  const { data, viewer, jobId, run, ask, pending, photoById, notify } = useJob();
  const [open, setOpen] = useState(false);
  const { gate, steps, header } = data;
  // Oct 14 2026: "Get them ready again" answers at once; the bar follows the copy.
  const [bar, setBarState] = useState<ReadyBarState | null>(() =>
    steps?.ready?.preparing ? { active: true, done: steps.ready.files, total: steps.ready.expected, failed: steps.ready.failed ?? 0, note: steps.ready.note ?? null } : null,
  );
  const setBar = useCallback((s: ReadyBarState | null) => setBarState(s), []);
  const [barKey, setBarKey] = useState(0);
  const getReady = () => {
    const total = steps?.ready?.expected ?? 0;
    setBarKey((k) => k + 1);
    setBarState({ active: true, done: 0, total, failed: 0, note: null });
    notify("ok", `Getting the ${total} photos ready. The bar at the bottom shows the progress.`);
    void restageForAryeoAction(jobId)
      .then((r) => { if (!r.ok) { setBarState(null); notify("err", r.message); } })
      .catch(() => { setBarState(null); notify("err", "The hub didn't answer. Try again in a moment."); });
  };
  const preparing = !!bar?.active;
  const stage = header.stage;
  const passing = gate?.checks.filter((c) => c.ok).length ?? 0;
  const total = gate?.checks.length ?? 0;
  const canStage = START_FROM.has(stage);
  const canStart = !!gate && canStage && gate.canDeliver;
  const startWhy = !gate ? "The checklist could not be read." : !canStage ? STAGE_WHY[stage] ?? "Not from this stage." : !gate.canDeliver ? "The checklist has open items." : null;
  const showOverride = viewer.isOwner && !!gate && canStage && !gate.canDeliver;
  const showVerify = ["DELIVERING", "DELIVERY_MISMATCH", "DELIVERED"].includes(stage);
  const replacements = steps?.replacements ?? [];
  const ready = steps?.ready ?? null;
  // Oct 14 2026 (huddle finding 12): while the hub waits for Aryeo, the page
  // refreshes itself, so a confirmed delivery shows without pressing anything.
  const router = useRouter();
  useEffect(() => {
    if (stage !== "DELIVERING") return;
    const t = setInterval(() => router.refresh(), 45_000);
    return () => clearInterval(t);
  }, [stage, router]);
  const checkLine = deliveryCheckLine(header);
  // Oct 14 2026: the hub's own upload and delivery into Aryeo.
  useAryeoPushPolling(data.aryeoPush);
  const pushLine = aryeoPushLine(data.aryeoPush);

  const override = async () => {
    const reason = await ask({
      title: "Override the checklist and deliver?",
      description: "Only for the owner. The reason is logged and sent to Kyle.",
      required: true,
      minLength: 5,
      confirmLabel: "Override and deliver",
      danger: true,
    });
    if (reason === null) return;
    await run(() => overrideDeliverAction(jobId, reason));
  };

  return (
    <section aria-label="Deliver" className="sticky bottom-0 z-20 mt-4 rounded-t-2xl border border-b-0 border-border bg-surface/95 shadow-[0_-12px_32px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      <ReadyProgressBar key={barKey} jobId={jobId} state={bar} setState={setBar} folderUrl={steps?.ready?.folderUrl ?? null} />
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 sm:px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="pd-deliver-body"
          className="inline-flex min-h-11 min-w-0 basis-full items-center gap-2 rounded-lg px-1 text-left text-sm hover:bg-surface-2/60 sm:basis-auto"
        >
          {gate?.passed ? <ShieldCheck aria-hidden className="size-5 shrink-0 text-success" /> : <CircleAlert aria-hidden className={cn("size-5 shrink-0", gate?.advisory ? "text-warning" : "text-danger")} />}
          <span className="min-w-0">
            <span className="block font-semibold">{gate ? `Delivery checklist: ${passing} of ${total} pass` : "Delivery checklist unavailable"}</span>
            <span className="block text-[12px] text-muted">
              {STAGE_WHY[stage] && !canStage ? STAGE_WHY[stage] : replacements.length ? `${replacements.length} fixed photo${replacements.length === 1 ? "" : "s"} to replace on Aryeo` : "Steps for Aryeo inside"}
            </span>
            {checkLine && <span className={cn("block text-[12px]", checkLine.bad ? "text-danger" : "text-muted")}>{checkLine.text}</span>}
            {pushLine && <span className={cn("block text-[12px]", pushLine.tone === "bad" ? "text-danger" : pushLine.tone === "good" ? "text-success" : "text-muted")}>{pushLine.text}</span>}
          </span>
          {open ? <ChevronDown aria-hidden className="ml-1 size-4 shrink-0" /> : <ChevronUp aria-hidden className="ml-1 size-4 shrink-0" />}
        </button>
        {gate?.advisory && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-muted ring-1 ring-inset ring-border" title="QC is in shadow mode: the checklist is advice, not a block">
            <FlaskConical aria-hidden className="size-3" /> Advisory
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Huddle finding 11: the one folder to upload from, always in reach. */}
          {ready && !preparing && (
            <a
              href={ready.folderUrl}
              target="_blank"
              rel="noreferrer"
              title="Opens 06-Ready-for-Aryeo in Dropbox: the finished photos, numbered in delivery order, every fix included. Press Download there for one zip."
              className={cn(btn, ready.ready ? "border border-brand/50 bg-brand-soft hover:brightness-95" : "border border-border-strong hover:bg-surface-2")}
            >
              <Download aria-hidden className="size-4" /> Download photos ({ready.files} of {ready.expected})
            </a>
          )}
          <AryeoPushControls push={data.aryeoPush} readyToSend={!!ready?.ready && !preparing} compact />
          {showVerify && (
            <button type="button" disabled={pending} onClick={() => void run(() => verifyDeliveryAction(jobId))} className={cn(btn, "border border-border-strong hover:bg-surface-2")}>
              <CheckCircle2 aria-hidden className="size-4" /> Verify now
            </button>
          )}
          {showOverride && (
            <button
              type="button"
              disabled={pending || !gate!.overrideAllowed}
              title={gate!.blockedForOverride ?? "Deliver with the checklist open (reason required)"}
              onClick={() => void override()}
              className={cn(btn, "border border-danger/50 text-danger hover:bg-danger-soft")}
            >
              Override and deliver
            </button>
          )}
          {stage !== "DELIVERED" && stage !== "DELIVERING" && (
            <button type="button" disabled={pending || !canStart} title={startWhy ?? undefined} onClick={() => void run(() => startDeliveryAction(jobId))} className={cn(btn, "bg-brand-action text-brand-fg hover:brightness-95")}>
              <Truck aria-hidden className="size-4" /> Mark as delivering
            </button>
          )}
        </div>
      </div>

      <div id="pd-deliver-body" hidden={!open} className="max-h-[60dvh] overflow-y-auto border-t border-border px-3 py-3 sm:px-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div>
            <h3 className="text-sm font-semibold">Checklist{gate?.advisory ? " (advisory in shadow mode)" : ""}</h3>
            {!gate ? (
              <p className="mt-1 text-[13px] text-warning">{data.gateError ?? "The checklist could not be read."}</p>
            ) : (
              <ul className="mt-1.5 space-y-1 text-sm">
                {gate.checks.map((c) => (
                  <li key={c.key} className="flex items-start gap-2">
                    {c.ok ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />}
                    <span>
                      <span className="sr-only">{c.ok ? "Passes: " : "Open: "}</span>
                      {c.label}
                      {c.detail && <span className="text-muted"> ({c.detail})</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {gate && !gate.canDeliver && gate.blockedForOverride && <p className="mt-2 text-[13px] text-danger">{gate.blockedForOverride}</p>}
            {header.paymentStatus && <p className="mt-2 text-[13px] text-muted">Payment in Aryeo: {header.paymentStatus.toLowerCase().replace(/_/g, " ")} (information only).</p>}
            <p className="mt-2 text-[13px] text-muted">The hub confirms by itself when Aryeo says the listing was delivered (Aryeo tells the hub at once, and the hub also asks every few minutes), then checks the photo count against what was approved.</p>
            {checkLine && <p className={cn("mt-1 text-[13px]", checkLine.bad ? "text-danger" : "text-muted")}>{checkLine.text}</p>}
          </div>

          <div className="space-y-3">
            {replacements.length > 0 && (
              <div className="rounded-xl border border-warning/40 bg-warning-soft/30 p-3">
                <h3 className="text-sm font-semibold">Replace these on the Aryeo listing</h3>
                <p className="mt-0.5 text-[13px] text-muted">Fixed through AutoHDR after they went on the listing. The hub can&rsquo;t upload to Aryeo: download each and swap it in.</p>
                <ul className="mt-2 space-y-1.5">
                  {replacements.map((r) => {
                    const p = photoById.get(r.photoId);
                    return (
                      <li key={r.versionId} className="flex items-center gap-2.5">
                        <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
                          <PhotoImg photoId={r.photoId} hash={p?.contentHash ?? null} versionId={r.versionId} size="thumb256" alt="" className="size-full object-cover" />
                        </span>
                        <span className="min-w-0 flex-1 text-sm">
                          <span className="block break-all font-medium">{r.photoName}</span>
                          <span className="block text-[12px] text-muted">{r.label} · {etMonthDayTime(r.at)}</span>
                        </span>
                        <a href={r.downloadUrl} download className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-semibold hover:bg-surface-2" aria-label={`Download the fixed ${r.photoName}`}>
                          <Download aria-hidden className="size-4" /> Download
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {!steps ? (
              <p className="text-[13px] text-warning">{data.stepsError ?? "The delivery steps could not be read."}</p>
            ) : (
              <ol className="space-y-3 text-sm">
                {steps.ready && (
                  // Oct 14 2026: the finished photos (fixes included), numbered, ready to drop into Aryeo.
                  <li>
                    <p className="font-semibold">1. Download the finished photos from 06-Ready-for-Aryeo</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {preparing ? (
                        <span aria-disabled="true" className="inline-flex min-h-11 cursor-not-allowed items-center gap-1.5 rounded-lg border border-border-strong px-3 font-semibold text-muted">
                          <Loader2 aria-hidden className="size-4 animate-spin" /> Getting them ready ({bar?.done ?? 0} of {bar?.total ?? steps.ready.expected})
                        </span>
                      ) : (
                        <a href={steps.ready.folderUrl} target="_blank" rel="noreferrer" className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 font-semibold", steps.ready.ready ? "bg-brand-action text-white hover:opacity-90" : "border border-border-strong hover:bg-surface-2")}>
                          <Download aria-hidden className="size-4" /> Download all ({steps.ready.files} of {steps.ready.expected})
                        </a>
                      )}
                      <button type="button" disabled={preparing} onClick={getReady} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 text-[13px] font-medium hover:bg-surface-2 disabled:opacity-50" title="Copy the current photos into the folder again">
                        <RefreshCw aria-hidden className="size-4" /> Get them ready again
                      </button>
                    </div>
                    <p className="mt-0.5 text-[12px] text-muted">
                      {preparing
                        ? "Copying into a fresh folder: every photo is checked in Dropbox before it replaces 06-Ready-for-Aryeo, so there are never duplicates. The bar at the bottom shows the progress."
                        : steps.ready.ready
                          ? "This is the only folder to upload from. It opens in Dropbox: press Download there for one zip. The photos are numbered in delivery order and include every fix and every restored version. Other folders (04-Final-Photos, AutoHDR's own) hold earlier edits without the fixes."
                          : steps.ready.note ?? `Only ${steps.ready.files} of ${steps.ready.expected} are in the folder. Press Get them ready again.`}
                    </p>
                  </li>
                )}
                <li>
                  <p className="font-semibold">{steps.ready ? "2" : "1"}. Open the listing in Aryeo{steps.ready ? " and upload them" : ""}</p>
                  {steps.listingUrl ? (
                    <a href={steps.listingUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 font-medium hover:bg-surface-2">
                      <ExternalLink aria-hidden className="size-4" /> Open listing
                    </a>
                  ) : steps.orderUrl ? (
                    <a href={steps.orderUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border-strong px-3 font-medium hover:bg-surface-2">
                      <ExternalLink aria-hidden className="size-4" /> Open the order (no listing yet)
                    </a>
                  ) : (
                    <p className="mt-0.5 text-[13px] text-muted">This job has no Aryeo listing or order linked.</p>
                  )}
                  {steps.listingUrl && <AryeoPushControls push={data.aryeoPush} readyToSend={!preparing} />}
                </li>
                {!steps.ready && (
                  <li>
                    <p className="font-semibold">2. The photos</p>
                    {steps.folderPath ? (
                      <div className="mt-1 flex items-center gap-1 rounded-lg border border-border bg-surface-2/50 pl-2">
                        <code className="min-w-0 flex-1 break-all text-[12px]">{steps.folderPath}</code>
                        <CopyButton value={steps.folderPath} label="Copy" title="Copy the folder path" />
                      </div>
                    ) : (
                      <p className="mt-0.5 text-[13px] text-muted">The edited photos are already on the Aryeo listing. Check their order against the strip below.</p>
                    )}
                    {steps.folderPath && <p className="mt-0.5 text-[12px] text-muted">{steps.folderLabel}</p>}
                  </li>
                )}
                <li>
                  <p className="font-semibold">3. Check the order ({steps.order.length})</p>
                  {steps.order.length === 0 ? (
                    <p className="mt-0.5 text-[13px] text-muted">No photos in the delivery yet.</p>
                  ) : (
                    <ol className="mt-1.5 flex gap-1.5 overflow-x-auto pb-1" aria-label="Delivery order">
                      {steps.order.map((o) => {
                        const p = photoById.get(o.photoId);
                        return (
                          <li key={o.photoId} className="w-24 shrink-0">
                            <span className="block aspect-[3/2] overflow-hidden rounded-md border border-border bg-surface-2">
                              <PhotoImg photoId={o.photoId} hash={p?.contentHash ?? null} fallbackUrl={p?.sourceUrl} size="thumb256" alt={o.name} className="size-full object-cover" />
                            </span>
                            <span className="mt-0.5 block truncate text-[11px] text-muted" title={`${o.deliveryName} (${o.name})`}>{o.deliveryName}</span>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </li>
                <li>
                  <p className="font-semibold">4. Deliver in Aryeo with this message</p>
                  <div className="mt-1 rounded-lg border border-border bg-surface-2/50 p-2">
                    <p className="whitespace-pre-wrap text-[13px]">{steps.message}</p>
                    <div className="mt-1 flex justify-end">
                      <CopyButton value={steps.message} label="Copy message" title="Copy the delivery message" />
                    </div>
                  </div>
                </li>
              </ol>
            )}
            {header.deliveredAt && <p className="text-[13px] text-success">Delivered {etMonthDayTime(header.deliveredAt)}.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

/** "Last asked Aryeo 3:41 PM: … Next check about 3:45 PM." (huddle finding 12) */
function deliveryCheckLine(h: { stage: string; deliveryCheckedAt: string | null; deliveryCheckNote: string | null; deliveryNextCheckAt: string | null }): { text: string; bad: boolean } | null {
  if (!["DELIVERING", "DELIVERY_MISMATCH"].includes(h.stage)) return null;
  const next = h.deliveryNextCheckAt ? ` Next check about ${etMonthDayTime(h.deliveryNextCheckAt)}.` : "";
  if (!h.deliveryCheckedAt) return { text: `Not checked with Aryeo yet.${next}`, bad: false };
  const note = (h.deliveryCheckNote ?? "").replace(/\.$/, "");
  const bad = h.stage === "DELIVERY_MISMATCH" || /couldn't|could not|no aryeo listing/i.test(note);
  return { text: `Last asked Aryeo ${etMonthDayTime(h.deliveryCheckedAt)}: ${note || "no answer recorded"}.${next}`, bad };
}
