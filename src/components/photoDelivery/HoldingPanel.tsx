"use client";

import { useMemo } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, CircleAlert, Clock, ExternalLink, Quote, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { holdingFor, type HoldingAction, type HoldingItem } from "@/lib/photoDelivery/holding";
import {
  clientAskedAnswerAction, clientAskedDoneAction, confirmAddOnAction, overrideWrapUpAction, releaseHoldAction, requestQcAction, startDeliveryAction, verifyDeliveryAction,
} from "@/app/ops/photo-delivery/actions";
import { useJob } from "./JobContext";
import { useAryeoPushActions } from "./AryeoPushControls";

// ---------------------------------------------------------------------------
// WHAT'S HOLDING THIS (Oct 22 2026), at the top of the job page.
//
// Jordan: "Sending a job should be clearer on what's holding it; it needs a
// decision. Kyle currently has to dig for what's holding it up." One panel,
// one list (lib/photoDelivery/holding.ts, the same order as the board card's
// one line and the Deliver bar's first line): each blocker in a plain
// sentence, who it waits on, and the one button that settles it or goes
// straight to it. "Lot Lines needed" carries the agent's own words under it
// and its "Lot lines added" (a short note). When nothing holds the job: "Ready
// to send" with the button. What is open but does not hold Kyle's approval
// (photo flags, shadow-mode checks) folds away under the list.
// View only (the creative manager): the same list, no buttons.
// ---------------------------------------------------------------------------

const btn = "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const primary = "bg-brand-action text-brand-fg hover:brightness-95";
const secondary = "border border-border-strong hover:bg-surface-2";

export function HoldingPanel() {
  const { data, jobId, run, ask, confirm, pending, readOnly, setTab } = useJob();
  // The server's push (the Deliver panel polls it live and reloads the page on each new state).
  const view = useMemo(
    () => holdingFor({ ...data.holdingBase, stage: data.header.stage, gate: data.gate, gateError: data.gateError, push: data.aryeoPush }),
    [data.holdingBase, data.header.stage, data.gate, data.gateError, data.aryeoPush],
  );
  const { approve, deliver } = useAryeoPushActions();
  const ignored = data.gate?.ignored ?? null;
  const delivered = data.header.stage === "DELIVERED";
  if (delivered && !view.items.length) return null;

  const openTab = (tab: "issues" | "cart" | "coverage" | "activity") => {
    setTab(tab);
    document.getElementById(`pd-tab-${tab}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  const confirmAddOn = async (key: string, label: string) => {
    const note = await ask({
      title: `${label}?`,
      description: "Only once it is really on the photos. Write what was added and on which photos (for example: lot lines drawn on photos 1 to 4 from the plat). It goes on the job's activity.",
      required: true,
      minLength: 5,
      confirmLabel: label,
    });
    if (note === null) return;
    await run(() => confirmAddOnAction(jobId, key, note));
  };
  const answer = async (askId: string) => {
    const note = await ask({
      title: "Answer this request",
      description: "Not doing it as asked? Write what you told the client, or why it stays as it is. It goes on the job's timeline.",
      required: true,
      minLength: 5,
      confirmLabel: "Save the answer",
    });
    if (note !== null) await run(() => clientAskedAnswerAction(jobId, askId, note));
  };
  const withoutWrapUp = async () => {
    const reason = await ask({
      title: "Let the photos go out without the wrap-up?",
      description: "Only once you know what was promised to the client and what must be removed (you asked the photographer, or the client). Write how you know. It is kept on the job's activity; the hub never delivers without the wrap-up by itself.",
      required: true,
      minLength: 10,
      confirmLabel: "Save the reason",
      danger: true,
    });
    if (reason !== null) await run(() => overrideWrapUpAction(jobId, reason));
  };
  const mark = async () => {
    const go = await confirm({ title: "Mark as delivering?", body: ignored ? `${ignored} Go back to look at them first, or deliver as they are.` : "Deliver the photos in Aryeo; the hub confirms when Aryeo says they were delivered.", confirmLabel: "Mark as delivering" });
    if (go) await run(() => startDeliveryAction(jobId));
  };

  const action = (a: HoldingAction, main?: boolean) => {
    const cls = cn(btn, main ? primary : secondary);
    switch (a.kind) {
      case "link":
        return a.external ? (
          <a href={a.href} target="_blank" rel="noreferrer" className={cls}>
            {a.label} <ExternalLink aria-hidden className="size-3.5" />
          </a>
        ) : (
          <Link href={a.href} className={cls}>{a.label}</Link>
        );
      case "wrapup":
        return (
          <>
            <Link href={a.href} className={cls}>{a.label}</Link>
            <button type="button" disabled={pending} onClick={() => void withoutWrapUp()} className={cn(btn, "border border-danger/50 text-danger hover:bg-danger-soft")}>Deliver without it</button>
          </>
        );
      case "tab":
        return <button type="button" onClick={() => openTab(a.tab)} className={cls}>{a.label}</button>;
      case "addon":
        return (
          <button type="button" disabled={pending} onClick={() => void confirmAddOn(a.addOn, a.label)} className={cls}>
            <CheckCircle2 aria-hidden className="size-4" /> {a.label}
          </button>
        );
      case "ask":
        return (
          <>
            <button type="button" disabled={pending} onClick={() => void run(() => clientAskedDoneAction(jobId, a.askId))} className={cls}>
              <CheckCircle2 aria-hidden className="size-4" /> {a.label}
            </button>
            <button type="button" disabled={pending} onClick={() => void answer(a.askId)} className={cn(btn, secondary)}>Answer with a note</button>
          </>
        );
      case "release":
        return <button type="button" disabled={pending} onClick={() => void run(() => releaseHoldAction(jobId))} className={cls}>{a.label}</button>;
      case "approve":
        return (
          <button type="button" disabled={pending} onClick={() => void approve(true, ignored)} className={cls}>
            <Send aria-hidden className="size-4" /> {a.label}
          </button>
        );
      case "deliver":
        return (
          <button type="button" disabled={pending} onClick={() => void deliver(ignored)} className={cls}>
            <Send aria-hidden className="size-4" /> {a.label}
          </button>
        );
      case "mark":
        return <button type="button" disabled={pending} onClick={() => void mark()} className={cls}>{a.label}</button>;
      case "verify":
        return <button type="button" disabled={pending} onClick={() => void run(() => verifyDeliveryAction(jobId))} className={cls}>{a.label}</button>;
      case "rerun":
        return <button type="button" disabled={pending} onClick={() => void run(() => requestQcAction(jobId))} className={cls}>{a.label}</button>;
    }
  };

  const row = (it: HoldingItem, n: number | null) => (
    <li key={it.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0" data-holding={it.kind}>
      {n != null ? (
        <span aria-hidden className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-warning-soft text-[12px] font-semibold text-warning">{n}</span>
      ) : (
        <CircleAlert aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
      )}
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-semibold">{it.text}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1"><Clock aria-hidden className="size-3" /> {it.waitingOn}</span>
          {it.detail && <span className="break-words">· {it.detail}</span>}
        </p>
        {it.quotes.length > 0 && (
          <ul className="mt-1.5 space-y-1" aria-label="In the agent's words">
            {it.quotes.map((q, i) => (
              <li key={i} className="flex gap-2 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[13px]">
                <Quote aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted" />
                <span className="min-w-0">
                  <span className="break-words">{q.text}</span>
                  <span className="block text-[12px] text-muted">{q.from}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {!readOnly && (it.action || it.link) && (
          <div className="mt-2 flex flex-wrap gap-2">
            {it.link && (
              <a href={it.link.href} target="_blank" rel="noreferrer" className={cn(btn, secondary)}>
                {it.link.label} <ExternalLink aria-hidden className="size-3.5" />
              </a>
            )}
            {it.action && action(it.action, n === 1)}
          </div>
        )}
      </div>
    </li>
  );

  const held = view.items.length > 0;
  return (
    <section
      aria-labelledby="pd-holding-h"
      data-holding-panel={held ? "held" : view.ready ? "ready" : "waiting"}
      className={cn("panel-shadow rounded-2xl border bg-surface p-4", held ? "border-warning/40" : view.ready ? "border-success/40" : "border-border")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pd-holding-h" className="flex items-center gap-2 text-base font-semibold">
          {held ? <CircleAlert aria-hidden className="size-5 text-warning" /> : <CheckCircle2 aria-hidden className="size-5 text-success" />}
          {held ? "What's holding this" : view.ready ? view.ready.text : "Nothing to send yet"}
        </h2>
        {held && <span className="text-[13px] text-muted">{view.items.length === 1 ? "1 thing to settle" : `${view.items.length} things, in order`}</span>}
      </div>
      {held ? (
        <ol className="mt-3 divide-y divide-border">
          {view.items.map((it, i) => row(it, i + 1))}
        </ol>
      ) : view.ready ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          {view.ready.detail && <p className="text-[13px] text-muted">{view.ready.detail}</p>}
          {!readOnly && view.ready.action && action(view.ready.action, true)}
        </div>
      ) : null}
      {view.also.length > 0 && (
        <details className="group mt-3 rounded-xl border border-border">
          <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-2 px-3 text-[13px] font-medium text-muted [&::-webkit-details-marker]:hidden">
            Also open ({view.also.length}): does not hold your approval, holds the hub&rsquo;s own same-day delivery
            <ChevronDown aria-hidden className="size-4 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="divide-y divide-border border-t border-border px-3 py-2">
            {view.also.map((it) => row(it, null))}
          </ul>
        </details>
      )}
    </section>
  );
}
