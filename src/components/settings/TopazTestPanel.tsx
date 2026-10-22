"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { FlaskConical, Loader2, RefreshCw } from "lucide-react";
import { estimateTopazTestAction, runTopazTestAction, applyTopazTestSettingsAction, listTopazTestsAction } from "@/app/settings/topazTestActions";
import { WHOLE_VIDEO_NOTE } from "@/lib/topazOriginal";
// Type-only: erased at build. lib/topazTests and lib/settings are server-only.
import type { TopazSettings } from "@/lib/settings";
import type { TestableCut, TopazTestView } from "@/lib/topazTests";
import { etDateTime } from "@/lib/datetime";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// "TRY THESE SETTINGS" (Jordan, Oct 22 2026). Owner only — the page renders it
// for the owner alone, and every action behind it is requireRole(OWNER),
// because a test spends real credits.
//
// Pick one of the last approved videos; the free price check runs with the
// sliders ON THIS SCREEN, saved or not; nothing is spent until "Run the test
// (about N credits)". The finished test opens on its own compare page
// (/settings/topaz-test/<id>): the original and the Topaz version as two
// synced players and a draggable wipe (no zoom on video: Jordan, Oct 22
// 2026, "I don't want to zoom in on video, just photos"). Nothing is ever
// filed to Dropbox, Aryeo or the client's portal.
// ---------------------------------------------------------------------------

const MODE_WORD: Record<string, string> = { Auto: "Auto (Topaz picks)", Manual: "Manual", Relative: "Relative" };

function sliderLine(t: TopazTestView): string {
  const p = t.settings.params;
  const n = (v: number) => Math.round(v * 100);
  return `${MODE_WORD[p.auto] ?? p.auto} · compression ${n(p.compression)} · detail ${n(p.details)} · sharpen ${n(p.blur)} · noise ${n(p.noise)} · dehalo ${n(p.halo)} · deblur ${n(p.preblur)} · recover ${n(p.recover_original_detail_value)}`;
}

export function TopazTestPanel({
  draft,
  cuts,
  tests,
  onApplied,
}: {
  /** The settings on screen right now, saved or not. */
  draft: TopazSettings;
  cuts: TestableCut[];
  tests: TopazTestView[];
  /** A test's settings were saved: re-seed the form from what was stored. */
  onApplied: (s: TopazSettings) => void;
}) {
  // No router: the rows are this component's own state, refreshed from the
  // actions' own answers (and "Check progress"), so it renders anywhere.
  const [rows, setRows] = useState<TopazTestView[]>(tests);
  const upsert = (t: TopazTestView) => setRows((prev) => [t, ...prev.filter((x) => x.id !== t.id)]);
  const [pick, setPick] = useState(cuts[0]?.submissionId ?? "");
  const [priced, setPriced] = useState<TopazTestView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();

  const check = () =>
    start(async () => {
      setMsg(null);
      setPriced(null);
      const r = await estimateTopazTestAction(pick, draft).catch(() => ({ ok: false, message: "Couldn't reach the hub just now. Try again." }) as { ok: boolean; message: string; test?: TopazTestView });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok && r.test) {
        setPriced(r.test);
        upsert(r.test);
      }
    });

  const run = (id: string) =>
    start(async () => {
      const r = await runTopazTestAction(id).catch(() => ({ ok: false, message: "Couldn't reach the hub just now. Try again." }) as { ok: boolean; message: string; test?: TopazTestView });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok) {
        setPriced(null);
        if (r.test) upsert(r.test);
      }
    });

  const apply = (id: string) =>
    start(async () => {
      const r = await applyTopazTestSettingsAction(id).catch(() => ({ ok: false, message: "Couldn't save just now. Try again." }) as { ok: boolean; message: string; settings?: TopazSettings });
      setMsg({ ok: r.ok, text: r.message });
      if (r.ok && r.settings) onApplied(r.settings);
    });

  const progress = () =>
    start(async () => {
      const r = await listTopazTestsAction().catch(() => ({ ok: false, message: "Couldn't reach the hub just now. Try again." }) as { ok: boolean; message: string; tests?: TopazTestView[] });
      if (r.ok && r.tests) setRows(r.tests);
      else setMsg({ ok: false, text: r.message });
    });

  const btn = "inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50";

  return (
    <div className="rounded-lg border border-border p-3" data-topaz-test-panel>
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <FlaskConical className="size-4" /> Try these settings
      </p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
        Runs one approved video through Topaz with the settings on this screen, saved or not, and puts the result beside the
        original. Nothing is filed to Dropbox, Aryeo or the client&rsquo;s portal. The price check is free; nothing is spent until
        you press Run. Tests count toward your monthly limits. {WHOLE_VIDEO_NOTE}
      </p>

      {cuts.length === 0 ? (
        <p className="mt-2 text-[13px] text-muted">No recent approved video is still held by the hub, so there is nothing to test on yet.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select
            value={pick}
            onChange={(e) => { setPick(e.target.value); setPriced(null); setMsg(null); }}
            aria-label="Video to test"
            className="min-h-11 min-w-0 max-w-full flex-1 rounded-lg border border-border bg-surface-2 px-2 text-sm outline-none focus:border-brand"
          >
            {cuts.map((c) => (
              <option key={c.submissionId} value={c.submissionId}>
                {c.label} · approved {etDateTime(new Date(c.approvedAtISO))}
              </option>
            ))}
          </select>
          <button type="button" onClick={check} disabled={busy || !pick} className={btn}>
            {busy && !priced ? <Loader2 className="size-4 animate-spin" /> : null} Check the price (free)
          </button>
        </div>
      )}

      {priced && priced.state === "estimated" && priced.estimateCredits != null && (
        <div className="mt-2 rounded-lg bg-surface-2/60 px-3 py-2 text-[13px]">
          <p>
            <b className="font-semibold">{priced.label}</b>: {Math.round(priced.source.durationSec)}s,{" "}
            {priced.source.width}x{priced.source.height}. Topaz prices it at about{" "}
            <b className="font-semibold">{Math.round(priced.estimateCredits)} credits</b>
            {priced.estimateLow != null && priced.estimateLow !== Math.round(priced.estimateCredits) ? ` (it bills the low end, ${priced.estimateLow})` : ""}.
          </p>
          <p className="mt-0.5 text-muted">Settings: {sliderLine(priced)}</p>
          <button type="button" onClick={() => run(priced.id)} disabled={busy} className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" /> : null} Run the test (about {Math.round(priced.estimateCredits)} credits)
          </button>
        </div>
      )}

      {msg && <p role={msg.ok ? "status" : "alert"} className={cn("mt-2 text-[13px]", msg.ok ? "text-muted" : "text-warning")}>{msg.text}</p>}

      {rows.length > 0 && (
        <div className="mt-3 border-t border-border pt-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[13px] font-semibold">Recent tests</p>
            <button type="button" onClick={progress} disabled={busy} className="inline-flex min-h-11 items-center gap-1 text-[12px] text-muted hover:text-foreground">
              <RefreshCw className="size-3.5" /> Check progress
            </button>
          </div>
          <ul className="mt-1 space-y-2">
            {rows.map((t) => (
              <li key={t.id} className="min-w-0 rounded-lg border border-border px-3 py-2 text-[13px]">
                <p className="break-words">
                  <b className="font-semibold">{t.label}</b>
                  <span className="text-muted"> · {etDateTime(new Date(t.createdAtISO))}{t.createdBy ? ` · ${t.createdBy}` : ""}</span>
                </p>
                <p className="text-muted">{t.says}</p>
                <p className="break-words text-[12px] text-muted-2">{sliderLine(t)}</p>
                <p className="text-[12px] text-muted-2">
                  Cost: {t.creditsCharged != null ? `${Math.round(t.creditsCharged)} credits` : t.estimateCredits != null ? `about ${Math.round(t.estimateCredits)} credits (estimate)` : "unknown"}
                  {t.state === "estimated" || t.state === "cancelled" ? " · nothing spent" : ""}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {t.state === "done" && (
                    <Link href={`/settings/topaz-test/${t.id}`} className="inline-flex min-h-11 items-center rounded-lg bg-brand-action px-3 text-sm font-semibold text-white hover:opacity-90">
                      Compare
                    </Link>
                  )}
                  {t.state === "estimated" && t.estimateCredits != null && (
                    <button type="button" onClick={() => run(t.id)} disabled={busy} className={btn}>
                      Run the test (about {Math.round(t.estimateCredits)} credits)
                    </button>
                  )}
                  {t.state === "done" && (
                    <button type="button" onClick={() => apply(t.id)} disabled={busy} className={btn}>
                      Use these settings for every video
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
