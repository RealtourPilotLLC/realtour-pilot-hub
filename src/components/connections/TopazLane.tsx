"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Film,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Ban,
  RotateCcw,
  CheckCheck,
  Coins,
  ExternalLink,
} from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import {
  markTopazDeliveredAction,
  cancelTopazJobAction,
  retryTopazJobAction,
} from "@/app/review/actions";

// ---------------------------------------------------------------------------
// THE 1080p PASS — what it is doing, what it has cost, what went wrong.
//
// Jordan (Sep 16): "Once the video cut is approved, it runs through the Topaz
// Video AI API, applies a preset, and exports it at 1080p to the Dropbox
// folder." This panel is the answer to the question he would otherwise have to
// ask somebody: is it on, is there credit left, what is running right now, what
// did it cost, and what failed.
//
// PROP SHAPES ARE DEFINED HERE ON PURPOSE. Everything this card renders is
// produced server-side by topazDashboard()/topazJobRows() and handed down as
// plain JSON. A client component that imported @/lib/topazJobs (or settings, or
// prisma) type-and-all is the single most common way this repo breaks the
// production build while tsc stays silent — so the server page does the
// mapping and this file knows nothing about the engine.
//
// `says` arrives already written for a non-technical reader, including the
// reason a job failed or was skipped. It is rendered VERBATIM — composing a
// second sentence here is how two surfaces end up disagreeing about the same
// job.
// ---------------------------------------------------------------------------

export type TopazLaneStats = {
  connected: boolean;
  enabled: boolean;
  /** null = Topaz couldn't be reached. Say so — never render it as 0 credits. */
  balance: { available: number; reserved: number; total: number } | null;
  balanceError: string | null;
  today: { renders: number; cap: number };
  month: { renders: number; cap: number; credits: number; creditCap: number };
  inFlight: number;
  concurrencyCap: number;
  waitingOnKyle: number;
  recentFailures: number;
  minBalanceCredits: number;
  /** ARYEO_MANUAL_NOTE — the one sentence that must appear wherever this
   *  pipeline is explained, so nobody waits on an automation that cannot exist. */
  aryeoNote: string;
};

export type TopazLaneJob = {
  id: string;
  projectId: string;
  street: string;
  fileName: string | null;
  state: string;
  says: string;
  estimateCredits: number | null;
  creditsCharged: number | null;
  sourceLabel: string | null;
  outputLabel: string | null;
  durationSec: number | null;
  finalPath: string | null;
  deliveredAt: string | null;
  createdAt: string;
  finishedAt: string | null;
};

const LIVE = new Set(["queued", "estimated", "uploading", "processing", "saving"]);

// Presentation only — the state itself is the server's word for what the job is
// doing. The label is short because the full sentence is `says`, right beside it.
const PILL: Record<string, { label: string; className: string; spin?: boolean }> = {
  queued: { label: "Waiting", className: "bg-surface-2 text-muted" },
  estimated: { label: "Priced", className: "bg-surface-2 text-muted" },
  uploading: { label: "Sending", className: "bg-brand-soft text-brand", spin: true },
  processing: { label: "Rendering", className: "bg-brand-soft text-brand", spin: true },
  saving: { label: "Saving", className: "bg-brand-soft text-brand", spin: true },
  done: { label: "Done", className: "bg-success-soft text-success" },
  failed: { label: "Didn't finish", className: "bg-danger-soft text-danger" },
  skipped: { label: "Left out", className: "bg-warning-soft text-warning" },
  cancelled: { label: "Stopped", className: "bg-surface-2 text-muted" },
};

const mmss = (sec: number | null) => {
  if (!sec || sec <= 0) return null;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

const folderOf = (path: string | null) => {
  if (!path) return null;
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || null;
};

export function TopazLane({ stats, jobs }: { stats: TopazLaneStats | null; jobs: TopazLaneJob[] }) {
  // A read that failed or took too long. The panel still appears, because a
  // missing panel reads as "there is nothing to see" — which is the one thing
  // we don't know.
  if (!stats) {
    return (
      <section className="rounded-2xl border bg-surface p-4">
        <div className="mb-2 flex items-center gap-2">
          <Film className="size-4 text-muted" />
          <h2 className="text-sm font-semibold">1080p video pass</h2>
        </div>
        <p className="text-[13px] leading-relaxed text-muted">
          We couldn&rsquo;t read how the 1080p pass is doing just now — reload the page to try again. Videos already
          running are unaffected; this panel is only the view of them.
        </p>
      </section>
    );
  }

  const {
    connected,
    enabled,
    balance,
    balanceError,
    today,
    month,
    inFlight,
    concurrencyCap,
    waitingOnKyle,
    recentFailures,
    minBalanceCredits,
    aryeoNote,
  } = stats;

  const lowBalance = balance !== null && balance.available < minBalanceCredits;
  const dayFull = today.cap > 0 && today.renders >= today.cap;
  const monthFull =
    (month.cap > 0 && month.renders >= month.cap) || (month.creditCap > 0 && month.credits >= month.creditCap);

  return (
    <section className="rounded-2xl border bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Film className="size-4 text-muted" />
        <h2 className="text-sm font-semibold">1080p video pass</h2>
        {!connected ? (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">Not connected</span>
        ) : enabled ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
            <CheckCircle2 className="size-3" /> On
          </span>
        ) : (
          <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">Switched off</span>
        )}
        <Link href="/settings#topaz" className="ml-auto text-[11px] font-medium text-brand hover:underline">
          Preset &amp; spending limits →
        </Link>
      </div>

      {/* What it does, in one line, before any numbers. */}
      <p className="text-[13px] leading-relaxed text-muted">
        When you approve a cut in the Review Room, the hub sends that video to Topaz, gets a cleaned-up 1080p version back,
        and puts it in the job&rsquo;s <b className="font-medium text-foreground/80">05-Final-Video</b> folder next to the
        editor&rsquo;s original. Then it gives Kyle a card to upload and deliver it.
      </p>

      {/* The step that is not ours to automate. It goes wherever this pipeline
          is explained, so nobody sits waiting for it to happen on its own. */}
      <p className="mt-2 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[12px] leading-relaxed text-muted">
        <b className="font-semibold text-foreground/80">The last step is Kyle&rsquo;s, by hand.</b> {aryeoNote}
      </p>

      {/* Setup states first: a page full of zeroes means nothing until you know
          whether anything is switched on. Each says the one thing to do next. */}
      {!connected && (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] leading-relaxed">
          No Topaz key is stored yet, so nothing is being sent anywhere. Paste your key on the{" "}
          <b>Topaz Video AI</b> card further down this page — &ldquo;Test &amp; connect&rdquo; only reads your credit
          balance and spends nothing.
        </p>
      )}
      {connected && !enabled && (
        <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] leading-relaxed">
          Topaz is connected, but the pass is switched off — approving a cut queues nothing. Turn it on in{" "}
          <Link href="/settings#topaz" className="font-semibold text-brand hover:underline">
            Settings → 1080p video pass
          </Link>{" "}
          when you&rsquo;re ready for the first render.
        </p>
      )}

      {/* The numbers. */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat
          label="Credits left"
          value={
            !connected
              ? "—"
              : balance
                ? balance.available.toLocaleString()
                : "Couldn't ask"
          }
          hint={
            !connected
              ? "connect Topaz to see this"
              : balance
                ? balance.reserved > 0
                  ? `${balance.reserved.toLocaleString()} held for jobs running now`
                  : "nothing held back"
                : "Topaz didn't answer just now"
          }
          tone={!connected ? "muted" : balance ? (lowBalance ? "warning" : "default") : "warning"}
        />
        <Stat label="Videos today" value={`${today.renders} of ${today.cap}`} hint="your daily limit" tone={dayFull ? "warning" : "default"} />
        <Stat
          label="Videos this month"
          value={`${month.renders} of ${month.cap}`}
          hint="your monthly limit"
          tone={month.cap > 0 && month.renders >= month.cap ? "warning" : "default"}
        />
        <Stat
          label="Credits this month"
          value={`${month.credits.toLocaleString()} of ${month.creditCap.toLocaleString()}`}
          hint="what the month has cost"
          tone={month.creditCap > 0 && month.credits >= month.creditCap ? "warning" : "default"}
        />
        <Stat label="Running now" value={`${inFlight} of ${concurrencyCap}`} hint="at once, by your limit" />
        <Stat
          label="Waiting for Kyle"
          value={String(waitingOnKyle)}
          hint="finished, not in Aryeo yet"
          tone={waitingOnKyle > 0 ? "warning" : "default"}
        />
      </div>

      {/* Anything that has stopped the lane, said plainly, with the fix. */}
      {connected && balanceError && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            We couldn&rsquo;t read your Topaz balance just now, so the number above is unknown rather than zero. Videos
            already running are unaffected; new ones wait until we can check. ({balanceError})
          </span>
        </p>
      )}
      {lowBalance && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed">
          <Coins className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            Credits are low. The pass stops sending new videos below {minBalanceCredits.toLocaleString()} credits so it
            can never fail halfway through a delivery — top up at topazlabs.com, or lower that floor in Settings.
          </span>
        </p>
      )}
      {(dayFull || monthFull) && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            {dayFull && !monthFull
              ? "Today's limit is used up. Videos approved now wait in line and start on their own after midnight — or raise the daily limit in Settings and they go within minutes."
              : "This month's limit is used up. Videos approved now wait in line and start on their own on the 1st — or raise the monthly limit in Settings and they go within minutes."}
          </span>
        </p>
      )}
      {recentFailures > 0 && (
        <p className="mt-2 flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-[12px] leading-relaxed text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {recentFailures} video{recentFailures === 1 ? "" : "s"} didn&rsquo;t finish in the last 7 days — each one says
            why below. Nothing was delivered wrong: the editor&rsquo;s original is untouched in Dropbox either way.
          </span>
        </p>
      )}

      {/* The jobs. */}
      <div className="mt-3">
        {jobs.length === 0 ? (
          <p className="rounded-lg bg-surface-2/50 px-3 py-2 text-[13px] text-muted">
            No videos have been through the pass yet. The next cut you approve shows up here.
          </p>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "warning" | "muted";
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2 ${
        tone === "warning" ? "border-warning/40 bg-warning/10" : "border-border bg-surface-2/50"
      }`}
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-2">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === "muted" ? "text-muted" : ""}`}>{value}</div>
      <div className="text-[11px] text-muted">{hint}</div>
    </div>
  );
}

function JobRow({ job }: { job: TopazLaneJob }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);

  const pill = PILL[job.state] ?? { label: job.state, className: "bg-surface-2 text-muted" };
  const live = LIVE.has(job.state);
  const cost = job.creditsCharged ?? job.estimateCredits;
  const folder = folderOf(job.finalPath);
  const duration = mmss(job.durationSec);

  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false, message: "That didn't go through — try again." }));
      setMsg({ ok: r.ok, text: r.message });
      setConfirmStop(false);
      if (r.ok) router.refresh();
    });

  return (
    <li className="bg-surface px-3 py-2.5">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${pill.className}`}>
          {pill.spin && <Loader2 className="size-3 animate-spin" />}
          {pill.label}
        </span>
        <Link href={`/projects/${job.projectId}`} className="text-[13px] font-semibold hover:underline">
          {job.street}
        </Link>
        <span className="ml-auto text-[11px] text-muted-2">{etDateTime(job.finishedAt ?? job.createdAt)}</span>
      </div>

      {/* The server's own sentence, rendered as written. */}
      <p className={`mt-0.5 text-[12px] leading-relaxed ${job.state === "failed" ? "text-danger" : "text-muted"}`}>{job.says}</p>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-2">
        {job.fileName && <span className="font-mono">{job.fileName}</span>}
        {job.sourceLabel && job.outputLabel && (
          <span>
            {job.sourceLabel} → {job.outputLabel}
          </span>
        )}
        {duration && <span>{duration}</span>}
        {cost != null && (
          <span className={job.creditsCharged != null ? "" : "italic"}>
            {Math.round(cost).toLocaleString()} credits{job.creditsCharged != null ? "" : " expected"}
          </span>
        )}
        {job.deliveredAt && <span className="text-success">delivered in Aryeo {etDateTime(job.deliveredAt)}</span>}
      </div>

      {folder && (
        <p className="mt-1 truncate font-mono text-[10px] text-muted-2" title={folder}>
          {folder}
        </p>
      )}

      {/* Actions. Kyle's "mark delivered" is the primary one, because a finished
          video sitting in Dropbox is only finished once it is in Aryeo. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {job.state === "done" && !job.deliveredAt && (
          <button
            onClick={() => run(() => markTopazDeliveredAction(job.id))}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1 text-[12px] font-semibold text-brand-fg hover:opacity-90 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />}
            Uploaded to Aryeo &amp; delivered
          </button>
        )}
        {live &&
          (confirmStop ? (
            <>
              <button
                onClick={() => run(() => cancelTopazJobAction(job.id))}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger-soft px-2.5 py-1 text-[12px] font-semibold text-danger hover:opacity-90 disabled:opacity-60"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
                Yes, stop it
              </button>
              <button onClick={() => setConfirmStop(false)} className="text-[12px] text-muted hover:text-foreground">
                Keep going
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmStop(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium hover:bg-surface-2"
              title="Stops this one video. Topaz is told to stop too, so you stop paying for it."
            >
              <Ban className="size-3.5" /> Stop
            </button>
          ))}
        {(job.state === "failed" || job.state === "skipped" || job.state === "cancelled") && (
          <button
            onClick={() => run(() => retryTopazJobAction(job.id))}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium hover:bg-surface-2 disabled:opacity-60"
            // What this button does is the whole reason it is safe to leave
            // next to a "this one was too expensive" message: a video that was
            // never sent goes back to the very start, so Topaz is asked for a
            // fresh price and every limit is checked again before a credit can
            // be spent. One that was already paid for is never re-rendered —
            // the hub just asks Topaz what became of it.
            title="Puts this video back at the start. It asks Topaz for a fresh price first and re-checks every limit you've set, so it can't spend more than you've allowed — and it never pays twice for work Topaz already did."
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} Try again
          </button>
        )}
        <Link
          href={`/review/${job.projectId}`}
          className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-foreground"
        >
          <ExternalLink className="size-3" /> Open the job
        </Link>
      </div>

      {msg && <p className={`mt-1 text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.text}</p>}
    </li>
  );
}
