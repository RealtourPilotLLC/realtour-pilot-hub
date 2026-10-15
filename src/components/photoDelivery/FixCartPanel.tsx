"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AlertTriangle, Ban, Hand, Play, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { approveFixesAction } from "@/app/ops/photo-delivery/actions";
import { PhotoImg } from "./PhotoImg";
import { photoTitle, useJob } from "./JobContext";
import { HUMAN_CALL_LABEL, SEVERITY_CLASS, SEVERITY_LABEL, STRATEGY_LABEL, plural, usd } from "./format";
import type { CartLineView } from "./types";

// ---------------------------------------------------------------------------
// THE FIX CART (plan 8.3). Three ways to decide, as Jordan asked: Proceed
// (Fix all), Ignore (per item, per group, or all Minor), Select (checkboxes,
// then Run selected). Every number comes from the cart the server built from
// AutoHDR's LIVE price list (lib/photoDelivery/fixes.ts): line credits and the
// planner's estimate are shown as given, never typed into this screen, and a
// price that could not be read says so and keeps Run disabled.
//
// Guard rails shown before the click, and enforced again on the server:
//   · blockers (fixes switched off, API not connected, shoot not linked,
//     price unknown) disable Run and are said plainly at the top;
//   · Kyle's per-batch approval limit (above it, Jordan approves);
//   · pre-flight: the balance must cover the estimate (top-up link), and a
//     run that would take the balance under the critical level asks first.
// Dollars appear for the owner only (the rate is null for everyone else).
// ---------------------------------------------------------------------------

// Several fixes on one photo run as one edit (one price), as the server batches them.
const MERGEABLE = new Set(["AUTOREMOVE_MASK", "CAMERA_REMOVAL", "DECLUTTER", "REEDIT_PROMPT"]);
const estimateOf = (lines: CartLineView[]): number | null => {
  if (lines.some((l) => l.credits == null)) return null;
  const seen = new Set<string>();
  let total = 0;
  lines.forEach((l, i) => {
    const key = MERGEABLE.has(l.strategy) ? `${l.photoId ?? "_"}:${l.strategy}` : `line:${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    total += l.credits ?? 0;
  });
  return total;
};
const cr = (n: number | null) => (n == null ? "price unknown" : `${n.toLocaleString("en-US")} cr`);

export function FixCartPanel({ inDrawer = false }: { inDrawer?: boolean }) {
  const { data, viewer, jobId, selected, setSelected, run, confirm, decide, pending, photoById, openLightbox, notify } = useJob();
  const cart = data.cart;
  const findingById = useMemo(() => new Map(data.findings.map((f) => [f.id, f])), [data.findings]);
  if (!cart) {
    return <p role="alert" className="rounded-xl border border-warning/30 bg-warning-soft/40 p-3 text-sm text-warning">The Fix Cart could not be built{data.cartError ? `: ${data.cartError}` : ""}. Reload to try again.</p>;
  }
  const runnable = cart.lines.filter((l) => !l.humanCall);
  const human = cart.lines.filter((l) => l.humanCall && l.humanCall !== "autohdr-editor");
  // Oct 14 2026: verticals, a tilted horizon, a roof the straightening cut off: free clicks in AutoHDR.
  const inAutohdr = cart.lines.filter((l) => l.humanCall === "autohdr-editor");
  const chosen = runnable.filter((l) => l.findingIds.some((id) => selected.has(id)));
  const est = estimateOf(chosen);
  const photoCount = new Set(chosen.map((l) => l.photoId ?? "gallery")).size;
  const after = cart.balance != null && est != null ? cart.balance - est : null;
  const rate = cart.usdPerCredit;
  const blocked = cart.blockers.length > 0;

  function preflight(lines: CartLineView[]): { ok: true; est: number; crosses: boolean } | { ok: false; why: string } {
    if (blocked) return { ok: false, why: cart!.blockers[0] };
    if (!lines.length) return { ok: false, why: "Nothing selected can be fixed automatically." };
    const e = estimateOf(lines);
    if (e == null) return { ok: false, why: "AutoHDR's price for one of these could not be read, so nothing can start." };
    if (!viewer.isOwner && e > cart!.adminCap) return { ok: false, why: `This batch is ${e} credits, above your ${cart!.adminCap}-credit approval limit. Jordan needs to approve it.` };
    const b = cart!.budget;
    if (b && !viewer.isOwner && !lines.every((l) => l.addOn) && b.spent + b.pending + e > b.maxCredits) {
      return { ok: false, why: `This would pass the shoot's fix budget (${b.spent + b.pending} of ${b.maxCredits} credits used, ${Math.max(0, b.maxCredits - b.spent - b.pending)} left). Pick fewer fixes, or ask Jordan.` };
    }
    if (cart!.balance != null && cart!.balance < e) return { ok: false, why: `The AutoHDR balance (${cart!.balance}) is below this estimate (${e}). Top up in AutoHDR first.` };
    const crosses = cart!.balance != null && cart!.balance >= cart!.criticalThreshold && cart!.balance - e < cart!.criticalThreshold;
    return { ok: true, est: e, crosses };
  }

  async function approve(lines: CartLineView[], mode: "ALL" | "SELECTED" | "CRITICAL_MAJOR_ONLY") {
    const p = preflight(lines);
    if (!p.ok) {
      notify("err", p.why);
      return;
    }
    if (p.crosses) {
      const go = await confirm({
        title: "This run crosses the critical credit level",
        body: `It takes the AutoHDR balance from ${cart!.balance} to about ${cart!.balance! - p.est}, below ${cart!.criticalThreshold}. New edits may fail until you top up. Run it anyway?`,
        confirmLabel: "Run anyway",
        danger: true,
      });
      if (!go) return;
    }
    const ids = lines.flatMap((l) => l.findingIds);
    const ok = await run(() => approveFixesAction({ jobId, findingIds: ids, mode }));
    if (ok) setSelected((s) => {
      for (const id of ids) s.delete(id);
      return s;
    });
  }

  const all = preflight(runnable);
  const cm = runnable.filter((l) => l.severity !== "MINOR");
  const minorLines = cart.lines.filter((l) => l.severity === "MINOR");
  const sel = preflight(chosen);
  const toggle = (l: CartLineView, on: boolean) =>
    setSelected((s) => {
      for (const id of l.findingIds) {
        if (on) s.add(id);
        else s.delete(id);
      }
      return s;
    });

  const lineRow = (l: CartLineView) => {
    const p = l.photoId ? photoById.get(l.photoId) : null;
    const isOn = l.findingIds.some((id) => selected.has(id));
    const id = `pd-cart-${l.findingIds[0]}`;
    return (
      <li key={l.findingIds.join(",")} className={cn("flex items-start gap-2.5 rounded-xl border p-2", isOn ? "border-brand/40 bg-brand-soft/30" : "border-border bg-surface")}>
        {!l.humanCall ? (
          <input id={id} type="checkbox" checked={isOn} disabled={pending} onChange={(e) => toggle(l, e.target.checked)} className="mt-3 size-5 shrink-0 accent-[var(--brand)]" />
        ) : (
          <AlertTriangle aria-hidden className="mt-3 size-5 shrink-0 text-warning" />
        )}
        {p ? (
          <button type="button" onClick={() => openLightbox(p.id)} className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border" aria-label={`Open ${photoTitle(p)}`}>
            <PhotoImg photoId={p.id} hash={p.contentHash} fallbackUrl={p.sourceUrl} size="thumb256" alt="" className="size-full object-cover" />
          </button>
        ) : (
          <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-[11px] text-muted">Gallery</span>
        )}
        <label htmlFor={l.humanCall ? undefined : id} className="min-w-0 flex-1 text-sm">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">{p ? `${p.position ? String(p.position).padStart(2, "0") : ""} ${p.roomLabel}`.trim() : "Whole gallery"}</span>
            <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset", SEVERITY_CLASS[l.severity])}>{SEVERITY_LABEL[l.severity]}</span>
          </span>
          <span className="mt-0.5 block break-words text-[13px]">{l.specificIssue || l.label}</span>
          {l.humanCall === "autohdr-editor" ? (
            <span className="mt-0.5 block text-[13px] text-foreground/90">
              <strong className="font-semibold text-success">Free in AutoHDR:</strong> {l.howTo ?? HUMAN_CALL_LABEL[l.humanCall]}
            </span>
          ) : l.humanCall ? (
            <span className="mt-0.5 block text-[13px] text-warning">
              <strong className="font-semibold">Needs your call:</strong> {HUMAN_CALL_LABEL[l.humanCall] ?? "a person decides this one."}
            </span>
          ) : (
            <span className="mt-0.5 block text-[13px] text-muted">
              {l.transform ?? STRATEGY_LABEL[l.strategy] ?? l.strategy} · {cr(l.credits)}
              {rate != null && l.credits != null ? ` (${usd(l.credits * rate)})` : ""}
            </span>
          )}
        </label>
        {l.humanCall && p && (
          <button type="button" onClick={() => openLightbox(p.id)} className="inline-flex min-h-10 shrink-0 items-center rounded-lg border border-border-strong px-2.5 text-[13px] font-medium hover:bg-surface-2">
            Decide
          </button>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-3">
      {blocked && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm">
          <p className="flex items-center gap-2 font-semibold text-danger">
            <AlertTriangle aria-hidden className="size-4" /> Fixes can&rsquo;t run right now
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-6">
            {cart.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <p className="mt-1 text-[13px] text-muted">You can still ignore, send to the editor, or decide each issue.</p>
        </div>
      )}

      {cart.budget && (
        // Oct 14 2026: the shoot's QC fix budget, so whoever submits knows what is left.
        <div className="rounded-xl border border-border bg-surface p-3">
          <p className="text-sm font-semibold">
            Fix budget for this shoot: {cart.budget.maxCredits} credits max ({cart.budget.targetCredits} normally){rate != null ? ` · ${usd(cart.budget.maxCredits * rate)} max` : ""}
          </p>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
            <div className={cn("h-full rounded-full", cart.budget.spent + cart.budget.pending > cart.budget.targetCredits ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, ((cart.budget.spent + cart.budget.pending) / Math.max(1, cart.budget.maxCredits)) * 100)}%` }} />
          </div>
          <p className="mt-1 text-[13px] text-muted">
            Used so far: {cart.budget.spent + cart.budget.pending} credit{cart.budget.spent + cart.budget.pending === 1 ? "" : "s"} ({cart.budget.automatic} automatic, {cart.budget.byHand} by hand{cart.budget.pending ? `; ${cart.budget.pending} still running` : ""}) · Left: {Math.max(0, cart.budget.maxCredits - cart.budget.spent - cart.budget.pending)}{rate != null ? ` (${usd(Math.max(0, cart.budget.maxCredits - cart.budget.spent - cart.budget.pending) * rate)})` : ""}.
            {" "}One credit per photo: several fixes on the same photo are one edit.
          </p>
          <BudgetRules b={cart.budget} />
        </div>
      )}

      <div className="rounded-xl border border-border bg-surface-2/40 p-3">
        <p className="text-sm font-semibold">
          {plural(chosen.length, "fix", "fixes")} on {plural(photoCount, "photo")} · est. {est == null ? "price unknown" : `${est.toLocaleString("en-US")} credit${est === 1 ? "" : "s"}`}
          {rate != null && est != null ? ` (${usd(est * rate)})` : ""}
        </p>
        <p className="mt-0.5 text-[13px] text-muted">
          {cart.balance != null ? `Balance ${cart.balance.toLocaleString("en-US")}${after != null ? ` → ${after.toLocaleString("en-US")}` : ""}` : "Balance not read yet"}
          {cart.estimatedCredits != null ? ` · the planner's suggested set: ${cart.estimatedCredits.toLocaleString("en-US")} credit${cart.estimatedCredits === 1 ? "" : "s"}` : runnable.length ? " · the planner could not price its suggested set" : ""}
          . Estimates; the ledger records what AutoHDR actually charges.
        </p>
        {!viewer.isOwner && <p className="mt-0.5 text-[13px] text-muted">Your approval limit is {cart.adminCap} credits per batch. Above that, Jordan approves.</p>}
        <div className="mt-2.5 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={pending || !all.ok}
            title={all.ok ? undefined : all.why}
            onClick={() => void approve(runnable, "ALL")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-3.5 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Wrench aria-hidden className="size-4" /> Fix all
          </button>
          <button
            type="button"
            disabled={pending || !cm.length || !preflight(cm).ok}
            title={!cm.length ? "No critical or major fixes in the cart" : undefined}
            onClick={() => void approve(cm, "CRITICAL_MAJOR_ONLY")}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-semibold hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Fix Critical + Major only
          </button>
          <button
            type="button"
            disabled={pending || !minorLines.length}
            onClick={() => {
              const list = minorLines.flatMap((l) => l.findingIds).map((id) => findingById.get(id)).filter((f): f is NonNullable<typeof f> => !!f);
              void decide(list, "IGNORED");
            }}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border-strong px-3.5 text-sm font-semibold hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Ban aria-hidden className="size-4" /> Ignore all Minor{minorLines.length ? ` (${minorLines.length})` : ""}
          </button>
        </div>
        {!all.ok && runnable.length > 0 && !blocked && <p className="mt-1.5 text-[13px] text-warning">{all.why}</p>}
      </div>

      {cart.lines.length === 0 ? (
        <p className="rounded-xl border border-border p-4 text-sm text-muted">Nothing in the cart: no open issue above the confidence floor right now.</p>
      ) : (
        <>
          {runnable.length > 0 && (
            <section aria-label="Fixes AutoHDR can run">
              <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium">AutoHDR can fix ({runnable.length})</span>
                <button type="button" className="min-h-10 px-1 text-muted hover:text-foreground" onClick={() => setSelected((s) => { for (const l of runnable) for (const id of l.findingIds) s.add(id); return s; })}>Select all</button>
                <button type="button" className="min-h-10 px-1 text-muted hover:text-foreground" onClick={() => setSelected(() => new Set())}>Clear</button>
              </div>
              <ul className={cn("space-y-1.5", inDrawer && "max-h-[50dvh] overflow-y-auto pr-1")}>{runnable.map(lineRow)}</ul>
            </section>
          )}
          {inAutohdr.length > 0 && (
            <section aria-label="Free in AutoHDR">
              <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
                <Hand aria-hidden className="size-4 text-success" /> Free in AutoHDR ({inAutohdr.length})
              </p>
              <ul className="space-y-1.5">{inAutohdr.map(lineRow)}</ul>
            </section>
          )}
          {human.length > 0 && (
            <section aria-label="Needs your call">
              <p className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium">
                <Hand aria-hidden className="size-4 text-warning" /> Needs your call ({human.length})
              </p>
              <ul className="space-y-1.5">{human.map(lineRow)}</ul>
            </section>
          )}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <button
          type="button"
          disabled={pending || !sel.ok}
          onClick={() => void approve(chosen, "SELECTED")}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-brand-action px-4 text-sm font-semibold text-brand-fg hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play aria-hidden className="size-4" /> Run selected ({plural(chosen.length, "fix", "fixes")}, {est == null ? "price unknown" : `${est} credit${est === 1 ? "" : "s"}`}
          {rate != null && est != null ? `, ${usd(est * rate)}` : ""})
        </button>
        {!sel.ok && chosen.length > 0 && <span className="text-[13px] text-warning">{sel.why}</span>}
        {cart.balance != null && est != null && cart.balance < est && (
          <Link href="/ops/photo-delivery/credits" className="text-[13px] font-medium text-brand hover:underline">Top up in AutoHDR</Link>
        )}
      </div>
    </div>
  );
}

/** What counts toward the budget and what never does (huddle finding 7). */
function BudgetRules({ b }: { b: { reverted: number; repeats: number; refunded: number } }) {
  return (
    <details className="mt-1.5 text-[13px]">
      <summary className="cursor-pointer text-muted hover:text-foreground">What counts toward this budget</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
        <li>Counts: every paid fix, automatic or by hand, and a fix still waiting to run.</li>
        <li>Counts: a second paid edit of the same photo{b.repeats ? ` (${b.repeats} credit${b.repeats === 1 ? "" : "s"} so far)` : ""}.</li>
        <li>Counts: a fix the check put back because it damaged the photo or changed the house; AutoHDR still charged it{b.reverted ? ` (${b.reverted} credit${b.reverted === 1 ? "" : "s"} so far)` : ""}.</li>
        <li>Never counts: a fix AutoHDR refunded because it failed or changed nothing{b.refunded ? ` (${b.refunded} credit${b.refunded === 1 ? "" : "s"} refunded)` : ""}.</li>
        <li>Never counts: ordered add-ons (virtual twilight, staging, declutter, the real-twilight look).</li>
        <li>Free, never counted: the checks, re-downloads, restoring an earlier version, and AutoHDR&rsquo;s own editor (Perspective Off, Crop &amp; Tilt).</li>
      </ul>
    </details>
  );
}
