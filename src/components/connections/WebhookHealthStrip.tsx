"use client";

import { useActionState, useState, useTransition } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RadioTower,
  ShieldCheck,
  ShieldOff,
  RotateCw,
  X,
} from "lucide-react";
import { etDateTime } from "@/lib/datetime";
import {
  setWebhookVerification,
  testWebhookSecret,
  retryWebhookFailure,
  dismissWebhookFailure,
  type ActionResult,
} from "@/app/connections/webhookActions";

// ---------------------------------------------------------------------------
// RTP-28 (Sep 16 2026) — "is anything still talking to us?"
//
// Written because of a real eight-day outage nobody saw: Aryeo stopped
// delivering on Sep 8 after 36 signature rejections, the hourly reconcile
// quietly covered for it, and every screen in the hub stayed green. "Connected"
// and "last sync" both said yes — because the API key worked and the cron ran.
// Neither was the question.
//
// So this strip answers the question directly, per lane: when did something last
// ARRIVE, when did something last get REFUSED and why, and — in one plain
// sentence — what the office loses while it's quiet and what to do about it.
// ---------------------------------------------------------------------------

export type WebhookLane = {
  provider: string;
  name: string;
  lastAcceptedAt: string | null;
  lastAcceptedType: string | null;
  lastSeenAt: string | null;
  lastRejectedAt: string | null;
  lastRejectedReason: string | null;
  accepted24h: number;
  accepted7d: number;
  baseline: number;
  rejected7d: number;
  unresolved: number;
  quietHours: number | null;
  silent: boolean;
  neverDelivered: boolean;
  startedWithRejections: boolean;
  enforced: boolean;
  enforceable: boolean;
  isReceiver: boolean;
  secretStored: boolean;
  secretReadable: boolean;
  replayable: number;
  sentence: string | null;
};

export type WebhookFailure = {
  id: string;
  provider: string;
  eventType: string | null;
  at: string;
  status: string;
  message: string;
  attempts: number;
  nextAt: string | null;
  gaveUp: boolean;
  superseded: boolean;
};

export function WebhookHealthStrip({
  lanes,
  failures,
  unresolvedTotal,
  degraded = false,
}: {
  lanes: WebhookLane[];
  failures: WebhookFailure[];
  unresolvedTotal?: number | null;
  degraded?: boolean;
}) {
  const loud = lanes.filter((l) => l.sentence);
  return (
    <section className="rounded-2xl border bg-surface p-4">
      <div className="mb-1 flex items-center gap-2">
        <RadioTower className="size-4 text-muted" />
        <h2 className="text-sm font-semibold">Webhook health — what is actually reaching us</h2>
      </div>
      <p className="mb-3 text-[11px] text-muted-2">
        “Connected” only means the key works. This is whether live events are still arriving, per provider.
      </p>

      {/* The one thing this panel must never do is show a calm face because its
          own query fell over. An empty strip and "nothing is waiting on a human"
          are indistinguishable from health — so say plainly that we could not
          look (RTP-28 review, Sep 16). */}
      {degraded && (
        <div className="mb-3 flex items-start gap-3 rounded-xl border-2 border-warning/60 bg-warning-soft p-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <p className="text-sm font-medium text-warning">
            Couldn’t read webhook health just now — this panel is not saying everything is fine. Reload the page.
          </p>
        </div>
      )}

      {/* The sentence(s) the office actually needs, above the table. */}
      {loud.length > 0 && (
        <div className="mb-3 space-y-2">
          {loud.map((l) => (
            <div key={l.provider} className="flex items-start gap-3 rounded-xl border-2 border-danger/60 bg-danger-soft p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
              <p className="text-sm font-medium text-danger">{l.sentence}</p>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {lanes.map((l) => (
          <LaneRow key={l.provider} lane={l} />
        ))}
      </div>

      <UnresolvedFailures failures={failures} total={unresolvedTotal ?? failures.length} degraded={degraded} />
    </section>
  );
}

function LaneRow({ lane }: { lane: WebhookLane }) {
  const [testing, setTesting] = useState(false);
  return (
    <div className="rounded-xl bg-surface-2/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium">{lane.name}</span>
        <StateChip lane={lane} />
        <span className="text-[11px] text-muted">
          {lane.lastAcceptedAt ? (
            <>
              last delivered {etDateTime(lane.lastAcceptedAt)}
              {lane.lastAcceptedType ? ` · ${lane.lastAcceptedType}` : ""}
            </>
          ) : (
            "nothing this provider delivered is still on record"
          )}
        </span>
        <span className="text-[11px] text-muted-2">
          {lane.accepted24h} in 24h · {lane.accepted7d} in 7 days
        </span>
      </div>

      {lane.lastRejectedAt && (
        <p className="mt-1 text-[11px] text-danger">
          last refused {etDateTime(lane.lastRejectedAt)} — {lane.lastRejectedReason}
        </p>
      )}

      {lane.isReceiver && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <VerificationChip lane={lane} />
          {lane.enforceable && <EnforceToggle lane={lane} />}
          <button
            onClick={() => setTesting((t) => !t)}
            className="text-[11px] font-medium text-brand hover:underline"
            title="Check a secret against a post this receiver already refused — no call to the provider, nothing saved"
          >
            {testing ? "Close" : "Test a secret"}
          </button>
        </div>
      )}

      {testing && <SecretTester lane={lane} />}
    </div>
  );
}

function StateChip({ lane }: { lane: WebhookLane }) {
  // Checked FIRST. A lane with nothing on record is not a calm lane: it is
  // either unproven or an outage that has outlived the 30-day event log, and
  // before this it fell through to the benign grey chip below.
  if (lane.neverDelivered)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">
        <AlertTriangle className="size-3" /> Nothing on record
      </span>
    );
  if (lane.silent)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
        <AlertTriangle className="size-3" /> Quiet {lane.quietHours !== null ? `${lane.quietHours}h` : ""}
      </span>
    );
  if (lane.rejected7d > 0)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning">
        <AlertTriangle className="size-3" /> {lane.rejected7d} refused in 7 days
      </span>
    );
  if (lane.accepted24h > 0)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
        <Activity className="size-3" /> Delivering
      </span>
    );
  // Never enough traffic to call it quiet — say so rather than pretending either way.
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted">
      No events in 24h — this lane is quiet by nature
    </span>
  );
}

function VerificationChip({ lane }: { lane: WebhookLane }) {
  // A stored-but-undecryptable secret is the fail-open that is genuinely live:
  // getSecret() swallows the decrypt error and the receiver reverts to
  // accepting anything. Never let that read as "signed".
  if (lane.secretStored && !lane.secretReadable)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-medium text-danger">
        <ShieldOff className="size-3" /> Secret stored but unreadable — accepting unsigned
      </span>
    );
  if (lane.secretStored)
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success">
        <ShieldCheck className="size-3" /> Verifies every post
      </span>
    );
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        lane.enforced ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger"
      }`}
    >
      <ShieldOff className="size-3" />
      {lane.enforced ? "No secret — refusing every post" : "No secret — accepting unsigned"}
    </span>
  );
}

function EnforceToggle({ lane }: { lane: WebhookLane }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);
  const next = !lane.enforced;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        onClick={() => start(async () => setMsg(await setWebhookVerification(lane.provider, next)))}
        disabled={pending}
        className="inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-surface disabled:opacity-60"
        title={
          next
            ? "Refuse any post this receiver can't verify. Reversible here."
            : "Go back to accepting posts that can't be verified (each one is stamped “unsigned”)."
        }
      >
        {pending && <Loader2 className="size-3 animate-spin" />}
        {next ? "Refuse unverified posts" : "Accept unsigned again"}
      </button>
      {msg && <span className={`text-[11px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</span>}
    </span>
  );
}

function SecretTester({ lane }: { lane: WebhookLane }) {
  const [state, action, pending] = useActionState(testWebhookSecret, null);
  return (
    <form action={action} className="mt-2 space-y-2 rounded-xl border bg-surface p-3">
      <input type="hidden" name="provider" value={lane.provider} />
      <label className="block text-xs font-medium text-foreground/80">
        Check a secret before you save it — {lane.name}
      </label>
      <p className="text-[11px] text-muted">
        Paste a candidate and we replay it against a post this receiver already refused. Nothing is sent to {lane.name}, nothing is
        saved, and the value is never shown back.{" "}
        {lane.replayable > 0
          ? `${lane.replayable} refused post${lane.replayable === 1 ? "" : "s"} can be tested against.`
          : lane.lastRejectedAt
            ? "Nothing here can be tested against yet — the refusals we still hold were recorded before the hub kept the signature and the whole body. The next one will be testable."
            : "Nothing has been refused here yet, so there is nothing to test against. The first refusal will be."}
        {lane.provider === "openphone" &&
          " OpenPhone's token rides in the URL rather than a signature, and the hub deliberately doesn't keep a token it was sent — so this test stays empty for OpenPhone by design."}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          name="secret"
          type="password"
          autoComplete="off"
          placeholder="Paste the secret to test"
          className="min-w-0 flex-1 rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium hover:bg-surface-2 disabled:opacity-60"
        >
          {pending && <Loader2 className="size-4 animate-spin" />}
          Test it
        </button>
      </div>
      {state && (
        <p className={`text-[11px] ${state.ok ? "text-success" : "text-danger"}`}>
          {state.ok ? <CheckCircle2 className="mr-1 inline size-3" /> : <AlertTriangle className="mr-1 inline size-3" />}
          {state.message}
        </p>
      )}
    </form>
  );
}

function UnresolvedFailures({ failures, total, degraded }: { failures: WebhookFailure[]; total: number; degraded: boolean }) {
  if (failures.length === 0)
    return (
      <p className="mt-3 border-t border-border pt-3 text-xs text-muted-2">
        {degraded
          ? "Couldn’t read the unresolved-event list — this is not an all-clear."
          : "No incoming event is waiting on a human. Anything that fails to process stays on this list until it processes or someone dismisses it — nothing ages out on its own."}
      </p>
    );
  return (
    <div className="mt-3 border-t border-border pt-3">
      <p className="mb-2 text-xs font-medium">
        {total} incoming event{total === 1 ? "" : "s"} still unresolved
        <span className="font-normal text-muted"> — retried on a backoff, and they stay here until they process or you dismiss them.</span>
        {total > failures.length && (
          <span className="font-normal text-muted"> Showing the {failures.length} most recent.</span>
        )}
      </p>
      <div className="space-y-1.5">
        {failures.map((f) => (
          <FailureRow key={f.id} f={f} />
        ))}
      </div>
    </div>
  );
}

function FailureRow({ f }: { f: WebhookFailure }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionResult | null>(null);
  return (
    <div className="rounded-lg bg-surface-2/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-xs font-medium">{f.provider}</span>
        <span className="text-[11px] text-muted">{f.eventType ?? "unknown event"}</span>
        <span className="text-[11px] text-muted-2">{etDateTime(f.at)}</span>
        <span
          className={`text-[11px] ${f.superseded ? "text-muted" : f.gaveUp ? "font-medium text-danger" : "text-warning"}`}
          title={f.superseded ? "A newer event for the same record already processed, so replaying this one could undo it." : undefined}
        >
          {f.superseded
            ? "not replayed — superseded"
            : f.gaveUp
            ? `gave up after ${f.attempts} tr${f.attempts === 1 ? "y" : "ies"}`
            : f.attempts === 0
              ? "not tried yet"
              : `${f.attempts} tr${f.attempts === 1 ? "y" : "ies"}${f.nextAt ? `, next ${etDateTime(f.nextAt)}` : ""}`}
        </span>
        <span className="ml-auto flex gap-2">
          <button
            onClick={() => start(async () => setMsg(await retryWebhookFailure(f.id)))}
            disabled={pending}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline disabled:opacity-60"
          >
            {pending ? <Loader2 className="size-3 animate-spin" /> : <RotateCw className="size-3" />} Retry now
          </button>
          <button
            onClick={() => start(async () => setMsg(await dismissWebhookFailure(f.id)))}
            disabled={pending}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-danger disabled:opacity-60"
            title="Keep the row, stop it counting"
          >
            <X className="size-3" /> Dismiss
          </button>
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted">{f.message}</p>
      {msg && <p className={`mt-0.5 text-[11px] ${msg.ok ? "text-success" : "text-danger"}`}>{msg.message}</p>}
    </div>
  );
}
