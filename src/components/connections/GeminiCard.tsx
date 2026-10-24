"use client";

import { useActionState, useState, useTransition } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Circle, Loader2, ScanEye } from "lucide-react";
import { etDate, etDateTime } from "@/lib/datetime";
import { fpsWords, FPS_MAX, FPS_MIN, DAILY_CAP_MAX } from "@/lib/videoAnalysisCore";
import { saveGeminiKey, testGeminiNow, disconnectGemini, saveGeminiOptions, type GeminiActionResult } from "@/app/connections/geminiActions";
import { SpellingFlagList } from "@/components/review/SpellingFlags";

// ---------------------------------------------------------------------------
// Connections → Gemini (video analysis), Oct 24 2026 (lib/videoAnalysis).
// Owner only, like this page. Paste the key, Test & save (encrypted); nothing
// is sent to Google before that. Below it: today's requests against the daily
// ceiling, the sampling rate with what it costs in tokens, the two halves'
// switches, and the spelling check's trial (flags, Right, Wrong, how often
// right, the ones still to mark).
// ---------------------------------------------------------------------------

export type GeminiCardProps = {
  key_: { configured: boolean; stored: boolean; accountLabel: string | null; savedAt: string | null; lastError: string | null };
  settings: { fps: number; dailyCap: number; covers: boolean; spelling: boolean; startedAt: string | null };
  usage: { calls: number; cap: number; cooldownUntil: string | null; lastRunAt: string | null; lastError: string | null };
  counts: { queued: number; waiting: number; done: number; failed: number; covers: number };
  recentErrors: { kind: "spell" | "cover"; href: string; error: string }[];
  trial: {
    words: string;
    barMet: boolean;
    startedAt: string | null;
    endsAt: string | null;
    reviewersOn: boolean;
    open: { submissionId: string; href: string; flagId: string; line: string }[];
  };
};

export function GeminiCard(p: GeminiCardProps) {
  const [state, action, pending] = useActionState(saveGeminiKey, null);
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<GeminiActionResult | null>(null);
  const [fps, setFps] = useState(p.settings.fps);
  const [cap, setCap] = useState(String(p.settings.dailyCap));
  const [covers, setCovers] = useState(p.settings.covers);
  const [spelling, setSpelling] = useState(p.settings.spelling);
  const k = p.key_;

  return (
    <div className="rounded-2xl border bg-surface p-4" data-card="gemini-video">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: "#1a73e81a", color: "#1a73e8" }}>
          <ScanEye className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Gemini (video analysis)</span>
            {k.configured ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success"><CheckCircle2 className="size-3" /> Key saved</span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted"><Circle className="size-3" /> Not connected</span>
            )}
          </div>
          <p className="text-xs text-muted">Instagram covers for every approved video, and an on-screen spelling check on trial that only you see. Google&apos;s free tier.</p>
        </div>
      </div>

      {k.stored && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {k.configured ? <CheckCircle2 className="size-3 text-success" /> : <AlertCircle className="size-3 text-warning" />}
          <span className={k.configured ? "text-muted" : "text-warning"}>
            {k.configured ? `${k.accountLabel ?? "Key saved"}${k.savedAt ? ` · saved ${etDateTime(k.savedAt)}` : ""}` : "Key saved, but its last check failed: not in use."}
          </span>
          {k.lastError && <span className="text-danger">{k.lastError}</span>}
          <span className="ml-auto flex gap-2">
            <button onClick={() => start(async () => setMsg(await testGeminiNow()))} disabled={busy} className="text-[11px] font-medium text-brand hover:underline disabled:opacity-60" title="Reads the model's description. Sends no video, costs nothing.">Test</button>
            <button onClick={() => start(async () => setMsg(await disconnectGemini()))} disabled={busy} className="text-[11px] font-medium text-muted hover:text-danger disabled:opacity-60">Remove</button>
          </span>
        </div>
      )}

      {k.configured && (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          <li>
            <span className="font-medium text-foreground">Today:</span> {p.usage.calls} of {p.usage.cap} requests (the day resets at midnight Pacific).
            {p.usage.cooldownUntil && <span className="text-warning"> Paused until {etDateTime(p.usage.cooldownUntil)} after Google said to slow down.</span>}
          </li>
          <li>
            <span className="font-medium text-foreground">Videos:</span> {p.counts.queued} waiting{p.counts.waiting ? ` · ${p.counts.waiting} waiting for the Topaz pass` : ""} · {p.counts.done} done ({p.counts.covers} with covers){p.counts.failed ? ` · ${p.counts.failed} failed` : ""}
            {p.settings.startedAt && <> · only videos from {etDate(p.settings.startedAt)} on</>}
          </li>
          {p.recentErrors.map((e, i) => (
            <li key={i} className="text-danger">
              <Link href={e.href} className="underline underline-offset-2">{e.kind === "cover" ? "Covers" : "Spelling check"}</Link>: {e.error}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}

      {k.configured && (
        <div className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3 text-xs">
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">Frames a second Gemini reads</span>
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))} className="rounded-lg border bg-surface px-2 py-1 text-sm">
              {Array.from({ length: FPS_MAX - FPS_MIN + 1 }, (_, i) => FPS_MIN + i).map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
            <span className="text-muted" data-fps-words>{fpsWords(fps)}</span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-foreground">Most requests a day</span>
            <input type="number" min={1} max={DAILY_CAP_MAX} value={cap} onChange={(e) => setCap(e.target.value)} className="w-20 rounded-lg border bg-surface px-2 py-1 text-sm" />
            <span className="text-muted">about 2 a video version</span>
          </label>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={covers} onChange={(e) => setCovers(e.target.checked)} /> Covers</label>
            <label className="flex items-center gap-1.5"><input type="checkbox" checked={spelling} onChange={(e) => setSpelling(e.target.checked)} /> Spelling check (trial)</label>
          </div>
          <button
            onClick={() => start(async () => setMsg(await saveGeminiOptions({ fps, dailyCap: Number(cap), covers, spelling })))}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-action px-3 py-1.5 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60"
          >
            {busy && <Loader2 className="size-4 animate-spin" />} Save
          </button>
        </div>
      )}

      {k.configured && (
        <div className="mt-3 rounded-xl border p-3 text-xs" data-spelling-trial>
          <p className="font-medium text-foreground">Spelling check trial: {p.trial.words}</p>
          <p className="mt-0.5 text-muted">
            {p.trial.startedAt ? `Started ${etDate(p.trial.startedAt)}${p.trial.endsAt ? `, two weeks to ${etDate(p.trial.endsAt)}` : ""}. ` : ""}
            Right = a real mistake on screen, Wrong = a false alarm. When at least 9 of 10 are right, you can show them to reviewers in Settings → Video Review Room
            {p.trial.reviewersOn ? " (on now)." : " (off)."}
            {p.trial.barMet && !p.trial.reviewersOn && <span className="font-medium text-success"> 9 of 10 reached.</span>}
          </p>
          <SpellingFlagList items={p.trial.open.map((o) => ({ submissionId: o.submissionId, href: o.href, flag: { id: o.flagId, line: o.line, verdict: null } }))} />
        </div>
      )}

      <form action={action} className="mt-3 space-y-2 rounded-xl border bg-surface-2 p-3">
        <input name="key" type="password" autoComplete="off" placeholder="Paste the Gemini API key" className="w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40" />
        <p className="text-[11px] text-muted">
          aistudio.google.com → Get API key. On the free tier Google may use what is sent to improve its products. The key is tested (it reads the model&apos;s description, nothing else), encrypted, and never shown again. A key that fails the test is not saved. Only videos that come in after you save it are read.
        </p>
        <button type="submit" disabled={pending} className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 disabled:opacity-60">
          {pending && <Loader2 className="size-4 animate-spin" />}
          Test &amp; save key
        </button>
        {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
      </form>
    </div>
  );
}
