import { Activity, AlertTriangle, ShieldOff } from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import { cadenceLabel, type CronJobHealth } from "@/lib/cronHealth";

// "Sync health" panel for the (owner-only) Connections page: the last few runs
// of each cron job (red/green), per-provider webhook rejected/error counts for
// the last 7 days, and a warning chip for any receiver still accepting unsigned
// events. Before this, a dead sync or 13 days of bounced webhooks looked
// identical to a healthy system on every screen (audit cracks #7/#8).

// One row per job vercel.json schedules (plus any job that recorded runs but is
// no longer scheduled), built in lib/cronHealth so the readiness report and
// the config probe read the same thing. Re-exported for existing importers.
export type { CronJobHealth };

/** The full Aryeo order reconcile is resumable across daily runs; this is its
 *  cursor, so "did the safety net ever finish?" is a date, not a guess. */
export type ReconcileHealth = { lastCompletedAt: string | null; inProgressPage: number | null; startedAt: string | null };

export type WebhookHealthRow = { provider: string; rejected: number; errored: number };

function Dot({ ok }: { ok: boolean | null }) {
  const color = ok === null ? "#94a3b8" : ok ? "#22c55e" : "#dc2626";
  const label = ok === null ? "unfinished (killed mid-run?)" : ok ? "ok" : "failed/skipped steps";
  return <span title={label} className="inline-block size-2.5 rounded-full" style={{ background: color }} />;
}

export function SyncHealth({
  crons,
  webhooks,
  unsignedProviders,
  cronLogReady,
  reconcile,
}: {
  crons: CronJobHealth[];
  webhooks: WebhookHealthRow[];
  unsignedProviders: string[];
  cronLogReady: boolean;
  reconcile?: ReconcileHealth | null;
}) {
  const troubledWebhooks = webhooks.filter((w) => w.rejected > 0 || w.errored > 0);
  return (
    <section className="rounded-2xl border bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Activity className="size-4 text-muted" />
        <h2 className="text-sm font-semibold">Sync health</h2>
      </div>

      {/* Receivers accepting unsigned events (no signing token stored yet). */}
      {unsignedProviders.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {unsignedProviders.map((p) => (
            <span
              key={p}
              title="No signing token is configured for this receiver — a forged POST would be accepted. Re-register the webhook to store a token."
              className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning"
            >
              <ShieldOff className="size-3" /> {p}: accepting unsigned events
            </span>
          ))}
        </div>
      )}

      {/* Cron runs: last 5 per job, newest first. */}
      <div className="space-y-2">
        {!cronLogReady && (
          <p className="text-xs text-muted-2">
            Cron run history isn&apos;t available yet (the CronRun table hasn&apos;t been created in this database).
          </p>
        )}
        {crons.map((c) => {
          // The newest firing that DID something (or failed) — a no-op DST
          // twin is only a dot (lib/cronHealth, review Sep 28).
          const latest = c.lastActing ?? c.runs[0];
          const healthy = latest?.ok === true && !c.stale;
          return (
            <div key={c.job} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-surface-2/50 px-3 py-2">
              <span className="text-sm font-medium">{c.job}</span>
              <span className="text-[11px] text-muted-2">{c.expected ? cadenceLabel(c) : "not scheduled any more"}</span>
              <span className="inline-flex items-center gap-1">
                {c.runs.map((r) => <Dot key={r.id} ok={r.ok} />)}
              </span>
              {/* A scheduled job with no row at all used to be simply absent,
                  which read as healthy. Say it. */}
              {c.neverRecorded && (
                <span className="text-[11px] font-medium text-danger">never recorded a run</span>
              )}
              {latest && (
                <span className={`text-[11px] ${healthy ? "text-muted" : "font-medium text-danger"}`}>
                  {c.stale && "stale: "}last run {etDateTime(new Date(latest.at))}
                  {latest.ok === false && (latest.error ? ` — ${latest.error.slice(0, 120)}` : latest.skipped.length ? ` — skipped: ${latest.skipped.join(", ")}` : latest.timedOut.length ? ` — timed out: ${latest.timedOut.join(", ")}` : " — degraded")}
                  {latest.ok === null && " — didn't finish"}
                  {c.stale && ` — it should run ${cadenceLabel(c)}`}
                  {latest.slowest && <span className="text-muted-2"> · slowest: {latest.slowest}</span>}
                </span>
              )}
            </div>
          );
        })}
        {reconcile && (
          <p className="px-1 text-[11px] text-muted">
            Full Aryeo order reconcile:{" "}
            {reconcile.lastCompletedAt
              ? <>last completed {etDateTime(new Date(reconcile.lastCompletedAt))}</>
              : <span className="font-medium text-danger">has never completed a full pass</span>}
            {reconcile.inProgressPage && reconcile.inProgressPage > 1 && (
              <> · a pass is in progress (resumes at page {reconcile.inProgressPage}{reconcile.startedAt ? `, started ${etDateTime(new Date(reconcile.startedAt))}` : ""})</>
            )}
          </p>
        )}
        {cronLogReady && crons.length > 0 && crons.every((c) => c.neverRecorded) && (
          <p className="text-xs text-muted-2">No cron runs recorded yet — the next hourly sync will show up here.</p>
        )}
      </div>

      {/* Webhook rejections/errors, last 7 days, per provider. */}
      <div className="mt-3 border-t border-border pt-3">
        {troubledWebhooks.length === 0 ? (
          <p className="text-xs text-muted-2">Webhooks: no rejected or failed events in the last 7 days.</p>
        ) : (
          <div className="space-y-1">
            {troubledWebhooks.map((w) => (
              <p key={w.provider} className="flex items-center gap-1.5 text-xs font-medium text-danger">
                <AlertTriangle className="size-3.5 shrink-0" />
                {w.provider}: {w.rejected > 0 ? `${w.rejected} rejected at the door` : ""}
                {w.rejected > 0 && w.errored > 0 ? " · " : ""}
                {w.errored > 0 ? `${w.errored} failed to process` : ""} (7 days)
              </p>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
