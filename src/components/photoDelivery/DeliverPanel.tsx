"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ChevronDown, ChevronUp, CircleAlert, Download, ExternalLink, FlaskConical, Loader2, RefreshCw, Send, ShieldCheck, Truck, UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { etMonthDayTime } from "@/lib/datetime";
import { CopyButton } from "@/components/ui/CopyButton";
import { overrideDeliverAction, restageForAryeoAction, startDeliveryAction, verifyDeliveryAction } from "@/app/ops/photo-delivery/actions";
import { PhotoImg } from "./PhotoImg";
import { ReadyProgressBar, type ReadyBarState } from "./ReadyProgressBar";
import { useJob } from "./JobContext";
import { aryeoPushLine, aryeoPushNext, aryeoPushOn, useAryeoPushActions, useLivePush } from "./AryeoPushControls";

// ---------------------------------------------------------------------------
// THE DELIVER PANEL (plan 9.6), sticky at the bottom of the job page.
//   · The bar: the checklist count, one line saying where things stand, the
//     Download photos button and what comes next (Oct 15 2026): with the
//     hub's upload on, a job Ready to review waits for Kyle's "Approve and
//     deliver" (or "Approve and upload to Aryeo"), then Deliver in Aryeo for
//     photos already up; a same-day order approves itself once every check
//     passes; with the upload off, Mark as delivering. When the next step
//     can't be taken yet, there is no button, only the reason.
//   · Inside: the gate checklist (in shadow mode it is ADVISORY, the bar's
//     badge says so: shown, but it never stops Kyle while QC is calibrated),
//     Verify now and the owner-only "Override and deliver" with a typed
//     reason (never for an open privacy or wrong-property issue).
//   · "Replace these on the Aryeo listing": photos fixed through AutoHDR
//     after they went on the listing, each with a Download of the fixed JPEG.
//   · The steps by hand: the folder, the listing, the order to match
//     (thumbnail strip with the delivery names) and the pre-written message
//     (Realtour Pilot Team voice) with Copy. With the hub's upload on they sit
//     behind "Do it by hand instead".
// The hub confirms on its own when Aryeo says the listing was delivered.
// ---------------------------------------------------------------------------

const START_FROM = new Set(["READY", "QC_REVIEW", "EDITED", "DELIVERY_MISMATCH", "REVISION_REQUESTED"]);
const STAGE_WHY: Record<string, string> = {
  EDITING: "AutoHDR's edits are not in yet.",
  EDIT_FAILED: "The edit failed. Sort that out first.",
  QC_RUNNING: "QC is running on this gallery right now.",
  FIXING: "Approved fixes are still running.",
  ON_HOLD: "On hold: release the hold first.",
  QC_REVIEW: "Decide the open issues first (Issues tab).",
  DELIVERING: "Already marked as delivering. Waiting for Aryeo to confirm.",
  DELIVERED: "Delivered and verified.",
};
/** Bar buttons (top level). */
const btn = "inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50";
/** Buttons inside the panel body. */
const cardBtn = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const primary = "bg-brand-action text-brand-fg hover:brightness-95";
const secondary = "border border-border-strong hover:bg-surface-2";
const TONE = { muted: "text-muted", busy: "text-muted", good: "text-success", bad: "text-danger" } as const;

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
  const startWhy = !gate ? "The checklist could not be read." : !canStage ? STAGE_WHY[stage] ?? "Not from this stage." : !gate.canDeliver ? gate.blockedForOverride ?? "The checklist has open items." : null;
  const showOverride = viewer.isOwner && !!gate && canStage && !gate.canDeliver;
  const showVerify = ["DELIVERING", "DELIVERY_MISMATCH", "DELIVERED"].includes(stage);
  const replacements = steps?.replacements ?? [];
  const ready = steps?.ready ?? null;

  // Oct 14 2026 (huddle finding 12): while the hub waits for Aryeo, the page
  // refreshes itself, so a confirmed delivery shows without pressing anything.
  // Oct 15: once, just after the next check is due, then every minute until
  // that check has happened (never while the tab is hidden).
  const router = useRouter();
  const nextCheckAt = header.deliveryNextCheckAt;
  useEffect(() => {
    if (stage !== "DELIVERING") return;
    const due = nextCheckAt ? Date.parse(nextCheckAt) + 10_000 - Date.now() : 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (!document.hidden) router.refresh();
      t = setTimeout(tick, 60_000);
    };
    t = setTimeout(tick, due > 0 ? due : 60_000);
    return () => clearTimeout(t);
  }, [stage, nextCheckAt, router]);

  // Oct 14 2026: the hub's own upload and delivery into Aryeo.
  const push = useLivePush(data.aryeoPush);
  const hubOn = aryeoPushOn(push);
  const pushNext = aryeoPushNext(push);
  const pushLine = aryeoPushLine(push);
  const { approve, deliver } = useAryeoPushActions();
  const checkLine = deliveryCheckLine(header);

  // What comes next, only when it can be pressed. Kyle approves a job that is
  // Ready to review (or one already marked as delivering whose upload stopped).
  const canGoOn = canStart || stage === "DELIVERING";
  const approvable = hubOn && pushNext === "approve" && !preparing && !!steps?.listingUrl && (stage === "READY" || stage === "DELIVERING");
  const next: "approve" | "deliver" | "mark" | null = hubOn ? (pushNext === "deliver" && canGoOn ? "deliver" : approvable ? "approve" : null) : canStart ? "mark" : null;
  // Approve and deliver needs the checklist (the usual gate); Approve and upload only puts the photos up.
  const approveDeliver = next === "approve" && canGoOn;
  // Photos already up (a change came in, or more photos): Upload again sits inside.
  const showResend = hubOn && pushNext === "deliver" && !preparing && !!steps?.listingUrl;

  // What the bar says under the title. On a phone only the first line shows (all of them once the panel is open).
  // A delivered job: the bar says so (the checklist no longer matters), once.
  const delivered = stage === "DELIVERED";
  // With the hub's upload on, Kyle approves from Ready to review: open issues are decided first.
  const why = !canStage || (hubOn && stage === "QC_REVIEW") ? STAGE_WHY[stage] ?? null : startWhy;
  const lines: { text: string; tone: keyof typeof TONE }[] = [];
  if (pushLine) lines.push(pushLine);
  else if (hubOn && push.sameDayAuto && !delivered) lines.push({ text: "Same-day order: the hub approves and delivers it by itself once every check passes.", tone: "muted" });
  if (why && !(delivered && pushLine)) lines.push({ text: why, tone: delivered ? "good" : "muted" });
  else if (replacements.length) lines.push({ text: `${replacements.length} fixed photo${replacements.length === 1 ? "" : "s"} to replace on Aryeo`, tone: "muted" });
  else if (hubOn && steps && !steps.listingUrl) lines.push({ text: "No Aryeo listing linked yet.", tone: "muted" });
  else if (!hubOn && !lines.length) lines.push({ text: "Steps for Aryeo inside", tone: "muted" });
  if (checkLine) lines.push({ text: checkLine.text, tone: checkLine.bad ? "bad" : "muted" });

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

  const listingLink: ReactNode = !steps ? null : steps.listingUrl ? (
    <a href={steps.listingUrl} target="_blank" rel="noreferrer" className={cn(cardBtn, secondary, "font-medium")}>
      <ExternalLink aria-hidden className="size-4" /> Open listing
    </a>
  ) : steps.orderUrl ? (
    <a href={steps.orderUrl} target="_blank" rel="noreferrer" className={cn(cardBtn, secondary, "font-medium")}>
      <ExternalLink aria-hidden className="size-4" /> Open the order (no listing yet)
    </a>
  ) : (
    <p className="text-[13px] text-muted">This job has no Aryeo listing or order linked.</p>
  );

  const byHand = steps && (
    <ol className="space-y-3 text-sm">
      {steps.ready && (
        // Oct 14 2026: the finished photos (fixes included), numbered, ready to drop into Aryeo. The bar holds the one download.
        <li>
          <p className="font-semibold">1. Press Download photos</p>
          <p className="mt-0.5 text-[12px] text-muted">
            {preparing
              ? "Copying the photos. The bar above shows progress."
              : steps.ready.ready
                ? "The only folder to upload from. Numbered in delivery order, every fix included."
                : steps.ready.note ?? `Only ${steps.ready.files} of ${steps.ready.expected} are in the folder. Press Get them ready again.`}
          </p>
          <button type="button" disabled={preparing} onClick={getReady} className={cn(cardBtn, secondary, "mt-1 font-medium")} title="Copy the current photos into the folder again">
            {preparing ? <Loader2 aria-hidden className="size-4 animate-spin" /> : <RefreshCw aria-hidden className="size-4" />} Get them ready again
          </button>
        </li>
      )}
      <li>
        <p className="font-semibold">{steps.ready ? "2" : "1"}. Open the listing in Aryeo{steps.ready ? " and upload them" : ""}</p>
        {!hubOn && <div className="mt-1">{listingLink}</div>}
        {!hubOn && steps.listingUrl && (
          <p className="mt-1 text-[12px] text-muted">
            {push.connected ? "The hub can upload and deliver for you: choose a stage in Photo Delivery settings." : "The hub can upload and deliver for you once its Aryeo login is set up (Connections → Aryeo hub login)."}
          </p>
        )}
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
  );

  return (
    <section aria-label="Deliver" className="sticky bottom-0 z-20 mt-4 rounded-t-2xl border border-b-0 border-border bg-surface/95 shadow-[0_-12px_32px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      <ReadyProgressBar key={barKey} jobId={jobId} state={bar} setState={setBar} />
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="pd-deliver-body"
          className="inline-flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1 text-left text-sm hover:bg-surface-2/60 sm:flex-initial"
        >
          {delivered ? <CheckCircle2 aria-hidden className="size-5 shrink-0 text-success" /> : gate?.passed ? <ShieldCheck aria-hidden className="size-5 shrink-0 text-success" /> : <CircleAlert aria-hidden className={cn("size-5 shrink-0", gate?.advisory ? "text-warning" : "text-danger")} />}
          <span className="min-w-0">
            <span className="block font-semibold">
              {delivered ? "Delivered" : gate ? `Delivery checklist: ${passing} of ${total} pass` : "Delivery checklist unavailable"}
              {gate?.advisory && !delivered && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 align-middle text-[12px] font-medium text-muted ring-1 ring-inset ring-border" title="QC is in shadow mode: the checklist is advice, not a block">
                  <FlaskConical aria-hidden className="size-3" /> <span className="sr-only sm:not-sr-only">Advisory</span>
                </span>
              )}
            </span>
            {lines.map((l, i) => (
              <span key={i} className={cn("block text-[12px]", TONE[l.tone], i > 0 && !open && "hidden sm:block")}>{l.text}</span>
            ))}
          </span>
          {open ? <ChevronDown aria-hidden className="ml-auto size-4 shrink-0" /> : <ChevronUp aria-hidden className="ml-auto size-4 shrink-0" />}
        </button>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* Huddle finding 11: the one folder to upload from, always in reach (the only download button). */}
          {ready && !preparing && (
            <a
              href={ready.folderUrl}
              target="_blank"
              rel="noreferrer"
              title="Opens 06-Ready-for-Aryeo in Dropbox: the finished photos, numbered in delivery order, every fix included. Press Download there for one zip."
              className={cn(btn, secondary)}
            >
              <Download aria-hidden className="size-4" /> <span className="sr-only sm:not-sr-only">Download photos</span>
            </a>
          )}
          {next === "deliver" ? (
            <button type="button" disabled={pending} onClick={() => void deliver()} className={cn(btn, primary)}>
              <Send aria-hidden className="size-4" /> Deliver in Aryeo
            </button>
          ) : next === "approve" ? (
            <>
              <button type="button" disabled={pending} onClick={() => void approve(false)} title="Put the photos on the Aryeo listing in this order; Kyle delivers in Aryeo" className={cn(btn, approveDeliver ? secondary : primary)}>
                <UploadCloud aria-hidden className="size-4" /> <span className={cn(approveDeliver && "sr-only sm:not-sr-only")}>Approve and upload to Aryeo</span>
              </button>
              {approveDeliver && (
                <button type="button" disabled={pending} onClick={() => void approve(true)} title="Put the photos on the Aryeo listing in this order, then deliver it" className={cn(btn, primary)}>
                  <Send aria-hidden className="size-4" /> Approve and deliver
                </button>
              )}
            </>
          ) : next === "mark" ? (
            <button type="button" disabled={pending} onClick={() => void run(() => startDeliveryAction(jobId))} className={cn(btn, primary)}>
              <Truck aria-hidden className="size-4" /> Mark as delivering
            </button>
          ) : null}
        </div>
      </div>

      <div id="pd-deliver-body" hidden={!open} className="max-h-[50dvh] overflow-y-auto border-t border-border px-3 py-3 sm:px-4">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
          <div>
            <h3 className="text-sm font-semibold">Checklist</h3>
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
            <p className="mt-2 text-[13px] text-muted">The hub confirms delivery on its own once Aryeo does.</p>
            {(showVerify || showOverride) && (
              <div className="mt-2 flex flex-wrap gap-2">
                {showVerify && (
                  <button type="button" disabled={pending} onClick={() => void run(() => verifyDeliveryAction(jobId))} className={cn(cardBtn, secondary)}>
                    <CheckCircle2 aria-hidden className="size-4" /> Verify now
                  </button>
                )}
                {showOverride && (
                  <button
                    type="button"
                    disabled={pending || !gate!.overrideAllowed}
                    title={gate!.blockedForOverride ?? "Deliver with the checklist open (reason required)"}
                    onClick={() => void override()}
                    className={cn(cardBtn, "border border-danger/50 text-danger hover:bg-danger-soft")}
                  >
                    Override and deliver
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="space-y-3">
            {replacements.length > 0 && (
              <div className="rounded-xl border border-warning/40 bg-warning-soft/30 p-3">
                <h3 className="text-sm font-semibold">Replace these on the Aryeo listing</h3>
                <p className="mt-0.5 text-[13px] text-muted">
                  {hubOn ? "Fixed after they went on the listing. Approve again (or Upload again), or download each and swap it in." : "Fixed after they went on the listing. Download each and swap it in on Aryeo."}
                </p>
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
                        <a href={r.downloadUrl} download className={cn(cardBtn, secondary, "shrink-0")} aria-label={`Download the fixed ${r.photoName}`}>
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
            ) : hubOn ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {listingLink}
                  {showResend && (
                    <button type="button" disabled={pending} onClick={() => void approve(false)} title="Upload the photos again: new ones go up, changed ones are swapped" className={cn(cardBtn, secondary)}>
                      <UploadCloud aria-hidden className="size-4" /> Upload again
                    </button>
                  )}
                </div>
                <details className="group rounded-xl border border-border">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
                    Do it by hand instead
                    <ChevronDown aria-hidden className="size-4 shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="border-t border-border p-3">{byHand}</div>
                </details>
              </>
            ) : (
              byHand
            )}
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
