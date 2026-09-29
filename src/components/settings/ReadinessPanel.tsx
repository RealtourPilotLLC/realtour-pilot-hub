import Link from "next/link";
import { ArrowRight, Check, Gauge, Minus, Plug, ShieldCheck, TriangleAlert, Users, X } from "lucide-react";
import { Section } from "@/components/ui/Section";
import type { ProgramScopeView, ReadinessReport, ReadinessRow } from "@/lib/readiness";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// THE READINESS PANEL (A56, unified handoff §11). The top of Settings: one line
// per automation with its four separate facts — configured, connected,
// enabled, healthy — then whether it actually takes effect and, when it does
// not, the exact reason; who hears about it; whom it may touch. Read-only: the
// switches stay in their own cards below, where they always were.
//
// A server component over lib/readiness.ts's one report. The CP-15 probe
// prints the same report's rows (its readinessFacts), so the two cannot
// disagree about what is on.
//
// Chips carry an icon as well as a colour (check, cross, dash) so the state
// reads without colour, and every problem is also written out in words under
// the chips: a phone has no hover, so nothing important lives in a tooltip.
// ---------------------------------------------------------------------------

// `quiet`: a "no" that is not a problem. A switch that is off is SUPPOSED to be
// off until launch, so its "not configured / not connected / off" chips are
// grey, not amber; amber is kept for a switch that is on and stopped.
function Chip({ label, ok, detail, quiet = false }: { label: string; ok: boolean | null; detail: string; quiet?: boolean }) {
  const Icon = ok === null ? Minus : ok ? Check : X;
  const state = ok === null ? "not applicable" : ok ? "yes" : "no";
  return (
    <span
      title={detail}
      aria-label={`${label}: ${state}. ${detail}`}
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        ok === null ? "bg-surface-2 text-muted-2" : ok ? "bg-success/15 text-success" : quiet ? "bg-surface-2 text-muted" : "bg-warning/15 text-warning",
      )}
    >
      <Icon className="size-3" aria-hidden />
      {label}
    </span>
  );
}

/** A list of reasons as one sentence, without a doubled full stop. */
const sentence = (parts: string[]) => {
  const t = parts.map((p) => p.trim().replace(/\.+$/, "")).join("; ");
  return `${t}.`;
};

/** One sentence: does it take effect, and if not, why — whether or not it is on. */
function effectLine(r: ReadinessRow): { text: string; tone: "ok" | "warn" | "muted" } {
  const needs = r.effective.blockers;
  const part = r.effective.partial;
  if (!r.enabled.ok) {
    const all = [...needs, ...part.map((x) => `for one part of it, ${x}`)];
    return {
      text: all.length ? `Off. Turning it on alone would not make it work: ${sentence(all)}` : "Off. Turning it on is all it needs.",
      tone: "muted",
    };
  }
  if (!r.effective.ok) return { text: `Switched on but NOT working: ${sentence(needs)}`, tone: "warn" };
  // R05: one path of it is blocked (the call processor, for example) — it is
  // working for the rest, and it is never called healthy.
  if (part.length) return { text: `Switched on, but PART of it is blocked: ${sentence(part)}`, tone: "warn" };
  if (r.healthy.ok === false) return { text: `Working, but unhealthy: ${sentence([r.healthy.detail])}`, tone: "warn" };
  return { text: `Working. ${sentence([r.healthy.detail[0].toUpperCase() + r.healthy.detail.slice(1)])}`, tone: "ok" };
}

function Row({ r }: { r: ReadinessRow }) {
  const line = effectLine(r);
  return (
    <li data-readiness-key={r.key} className="py-2.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 break-words text-sm font-medium">{r.title}</span>
        {r.reaches === "clients" && (
          <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-semibold text-warning">reaches clients</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        <Chip label="Configured" ok={r.configured.ok} detail={r.configured.detail} quiet={!r.enabled.ok} />
        <Chip label="Connected" ok={r.connected.ok} detail={r.connected.detail} quiet={!r.enabled.ok} />
        <Chip label="Enabled" ok={r.enabled.ok} detail={r.enabled.detail} quiet />
        <Chip label="Healthy" ok={r.healthy.ok} detail={r.healthy.detail} />
      </div>
      <p className={cn("mt-1 break-words text-[12px]", line.tone === "warn" ? "text-warning" : line.tone === "ok" ? "text-foreground" : "text-muted")}>
        {line.text}
      </p>
      {!r.configured.ok && r.enabled.ok && (
        <p className="break-words text-[12px] text-warning">Configuration: {r.configured.detail}.</p>
      )}
      <p className="break-words text-[12px] text-muted-2">
        Who hears about it: {r.recipients}.{r.scope && <> Who it may reach: {r.scope}.</>}
      </p>
      {r.note && <p data-readiness-note className="break-words text-[12px] text-muted-2">{r.note}</p>}
    </li>
  );
}

const needsAttention = (r: ReadinessRow) => r.enabled.ok && (!r.effective.ok || r.healthy.ok === false);

function Block({ title, rows, note }: { title: string; rows: ReadinessRow[]; note?: string }) {
  if (!rows.length) return null;
  const on = rows.filter((r) => r.enabled.ok).length;
  const working = rows.filter((r) => r.effective.ok).length;
  const attention = rows.filter(needsAttention).length;
  return (
    // Open by default only when something needs a look — otherwise four long
    // lists would push the actual settings a screen and a half down.
    <details open={attention > 0} className="group rounded-xl border border-border">
      <summary className="flex min-h-10 cursor-pointer list-none flex-wrap [&::-webkit-details-marker]:hidden items-center gap-x-2 gap-y-0.5 px-3 py-2 text-[13px] focus-visible:outline-2 focus-visible:outline-brand">
        <span className="font-semibold">{title}</span>
        <span className="text-muted">
          {on} of {rows.length} on · {working} working
        </span>
        {attention > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-semibold text-warning">
            <TriangleAlert className="size-3" aria-hidden /> {attention} need{attention === 1 ? "s" : ""} a look
          </span>
        )}
        <span className="ml-auto text-[11px] text-muted-2 group-open:hidden">Show</span>
        <span className="ml-auto hidden text-[11px] text-muted-2 group-open:inline">Hide</span>
      </summary>
      <div className="border-t border-border px-3">
        {note && <p className="pt-2 text-[12px] text-muted">{note}</p>}
        <ul className="divide-y divide-border">
          {rows.map((r) => <Row key={r.key} r={r} />)}
        </ul>
      </div>
    </details>
  );
}

const dayET = (d: Date | null) => (d ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }) : null);
const MODE_WORDS: Record<ProgramScopeView["mode"], string> = {
  TEST_ONLY: "Only your TEST clients",
  PILOT: "Your TEST clients and the pilot clients you named",
  ALL: "Every client with a program",
};
const TIER_WORDS = { TEST: "TEST client", PILOT: "in the pilot", ALL: "everyone (rollout)" } as const;
const CODE_WORDS: Record<string, string> = {
  rollout_test_only: "not reached: the rollout is TEST only",
  not_in_pilot: "not reached: not in the pilot",
  pilot_unapproved: "not reached: the pilot has no recorded approval",
  pilot_expired: "not reached: the pilot has ended",
  operation_not_in_pilot: "in the pilot, but for none of the program's features",
  feature_test_only: "not reached: a feature lock is on",
  client_missing: "not reached: the client is gone",
  scope_unreadable: "not reached: the rollout could not be read",
};

/**
 * WHO THE PROGRAM MAY REACH (R03, Sep 28 2026) — the rollout itself, read-only,
 * at the top of readiness. The mode in plain words, the pilot (who, what it
 * covers, who approved it and until when) and every program client with its
 * tier or the reason the rollout does not reach them. Edited in Content
 * program automations → Who the program may reach (owner only).
 */
function ProgramScope({ v }: { v: ProgramScopeView }) {
  return (
    <div data-program-scope={v.mode} className="rounded-xl border border-border p-3 text-[13px]">
      <p className="flex items-center gap-1.5 font-semibold"><Users className="size-4 text-muted-2" aria-hidden /> Who the program may reach</p>
      <p className="mt-1">
        <span className="font-medium">{MODE_WORDS[v.mode]}</span>
        {v.modeSince && <span className="text-muted"> · since {dayET(v.modeSince)}</span>}
        {v.updatedBy && <span className="text-muted"> · last changed by {v.updatedBy}{v.updatedAt ? ` on ${dayET(v.updatedAt)}` : ""}</span>}
      </p>
      {v.problem && <p className="mt-1 text-warning">The stored rollout could not be read, so only TEST clients are reached: {v.problem}.</p>}
      {v.pilot ? (
        <p className="mt-1 text-[12px] text-muted">
          Pilot ({v.pilotState.toLowerCase()}, {v.pilot.names.length} of at most {v.cap}): <span className="text-foreground">{v.pilot.names.join(", ")}</span>
          {" "}· covers {v.pilot.groups.length ? v.pilot.groups.map((g) => g.toLowerCase()).join("; ") : "nothing"}
          {v.pilot.approvedBy && <> · approved by {v.pilot.approvedBy}{v.pilot.approvedAt ? ` on ${dayET(v.pilot.approvedAt)}` : ""}</>}
          {v.pilot.expiresAt ? <> · ends {dayET(new Date(v.pilot.expiresAt.getTime() - 1))}</> : <> · no end date</>}
          {v.mode !== "PILOT" && <> · (on file, but the rollout is not set to a pilot)</>}
        </p>
      ) : (
        <p className="mt-1 text-[12px] text-muted">No pilot client is named.</p>
      )}
      {v.clients.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1">
          {v.clients.map((c) => (
            <li key={c.name} title={c.reason} className={cn("rounded-full px-2 py-0.5 text-[11px]", c.tier ? "bg-success/15 text-success" : "bg-surface-2 text-muted")}>
              {/* Per group, not one op (review fix, Sep 28 2026): a pilot
                  client reads "in the pilot — program emails, …". */}
              {c.name}: {c.tier ? TIER_WORDS[c.tier] : (c.code ? CODE_WORDS[c.code] ?? c.code : "not reached")}
              {c.tier === "PILOT" && c.groups.length > 0 && <> — {c.groups.join(", ")}</>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ago = (d: Date, now: Date) => {
  const min = Math.max(0, Math.round((now.getTime() - d.getTime()) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

export async function ReadinessPanel({ report: pending }: { report: Promise<ReadinessReport | null> }) {
  const report = await pending;
  const checkGmail = (
    // A plain GET form: the only live question this panel ever asks (Google's
    // send-permission probe, the same one /connections runs) happens when
    // somebody presses this, never on an ordinary visit.
    <form method="get" action="/settings#readiness">
      <input type="hidden" name="check" value="gmail" />
      <button type="submit" className="inline-flex min-h-8 items-center rounded-lg border border-border px-2.5 text-[11px] font-semibold text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-brand">
        Check Gmail
      </button>
    </form>
  );
  if (!report) {
    return (
      <Section icon={Gauge} title="Readiness" action={checkGmail}>
        <p className="text-sm text-muted">Readiness could not be read just now. Reload to try again. Nothing has been turned on or off.</p>
      </Section>
    );
  }
  const { rows, rolloutClosed, deploy, gmailSend, generatedAt: now, programScope } = report;
  const program = rows.filter((r) => r.kind === "program");
  const texts = rows.filter((r) => r.key.startsWith("auto_texts."));
  const alerts = rows.filter((r) => r.key.startsWith("internal_alerts."));
  const production = rows.filter((r) => r.kind === "business" && !r.key.startsWith("auto_texts.") && !r.key.startsWith("internal_alerts."));

  return (
    // No count badge in the header: at 375 px the title, a badge and the
    // button do not fit on one line, and each block below carries its own.
    <Section icon={Gauge} title="Readiness" action={checkGmail}>
      <div className="space-y-3">
        {/* THE LAUNCH GATE, first, in one sentence. */}
        <div
          data-rollout={rolloutClosed.ok ? "closed" : "open"}
          className={cn("flex items-start gap-2 rounded-xl border p-3 text-[13px]", rolloutClosed.ok ? "border-border bg-surface-2/40" : "border-warning/50 bg-warning-soft/40")}
        >
          {rolloutClosed.ok ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />}
          <div className="min-w-0">
            {rolloutClosed.ok ? (
              <p>
                <span className="font-semibold">Client launch is closed.</span> No content-program switch is working for a real client. The texts clients already get
                (confirmations, delivery feedback, after-hours replies, welcome) keep running as before.
              </p>
            ) : (
              // Each opener names WHO (R03): "open for the pilot: A, B" is not
              // "open for every client", and the sentence must not imply it.
              // The banner's WHO comes from the openers themselves (review
              // fix, Sep 28 2026), never from the mode alone.
              <p>
                <span className="font-semibold">Client launch is OPEN{rolloutClosed.openFor ? ` for ${rolloutClosed.openFor}` : ""}.</span>{" "}
                Working for real clients now: {rolloutClosed.openers.join("; ")}.
              </p>
            )}
            {rolloutClosed.armed.length > 0 && (
              <p className="mt-1 text-warning">
                Switched on for real clients but held only by a missing dependency, so fixing that would open it: {rolloutClosed.armed.join("; ")}.
              </p>
            )}
          </div>
        </div>

        <ProgramScope v={programScope} />

        <p className="text-[12px] text-muted">
          This page is build <code className="rounded bg-surface-2 px-1">{deploy.page ?? "unstamped"}</code>
          {deploy.lastSync
            ? <> · the last hourly run was build <code className="rounded bg-surface-2 px-1">{deploy.lastSync.deploy ?? "unstamped"}</code>, {ago(deploy.lastSync.startedAt, now)}</>
            : <> · no hourly run recorded</>}
          . {gmailSend.detail}
        </p>
        <p className="text-[12px] text-muted-2">
          <span className="font-medium text-muted">Configured</span>: saved, and its settings would run ·{" "}
          <span className="font-medium text-muted">Connected</span>: the outside services it needs are connected ·{" "}
          <span className="font-medium text-muted">Enabled</span>: switched on ·{" "}
          <span className="font-medium text-muted">Healthy</span>: running on time with no error. The switches themselves are in the cards below.
        </p>

        <Block title="Content program switches" rows={program} note="Turned on or off in Content program → Content program automations. A dash means it does not apply (it needs no connection, or it is off so there is nothing to check)." />
        <Block title="Client texts" rows={texts} note="Approved and already running for every client; not part of the launch gate. Turned on or off in Communication → Automated texts." />
        <Block title="Team alerts" rows={alerts} note="These reach the team, never clients. Turned on or off in Communication → Internal alerts." />
        <Block title="Production" rows={production} />
      </div>
    </Section>
  );
}

/** The Integrations group: connection and freshness by provider, read-only. */
export async function IntegrationsReadiness({ report: pending, isOwner }: { report: Promise<ReadinessReport | null>; isOwner: boolean }) {
  const report = await pending;
  const manage = isOwner ? (
    <Link href="/connections" className="inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
      Manage on Connections <ArrowRight className="size-3" aria-hidden />
    </Link>
  ) : null;
  if (!report) {
    return (
      <Section icon={Plug} title="Connections" action={manage}>
        <p className="text-sm text-muted">The connections could not be read just now. Reload to try again.</p>
      </Section>
    );
  }
  const now = report.generatedAt;
  const late = report.crons.filter((c) => c.stale);
  return (
    <Section icon={Plug} title="Connections" count={`${report.providers.filter((p) => p.connected).length}/${report.providers.length} connected`} action={manage}>
      <ul className="divide-y divide-border">
        {report.providers.map((p) => (
          <li key={p.id} data-provider={p.id} className="py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{p.label}</span>
              {/* A stored key that failed last time is still USED by the code
                  (review, Sep 28): connected, and amber for the failure. */}
              <Chip
                label={p.status === "error" ? (p.connected ? "Connected, refused last time" : "Refused last time") : p.connected ? "Connected" : "Not connected"}
                ok={p.status === "error" ? false : p.connected}
                detail={p.lastError ?? p.status}
                quiet={p.status !== "error"}
              />
              {p.lastSyncedAt && <span className="text-[11px] text-muted-2">last synced {ago(p.lastSyncedAt, now)}</span>}
            </div>
            {p.lastError && <p className="mt-0.5 break-words text-[12px] text-warning">{p.lastError.slice(0, 200)}</p>}
            <p className="mt-0.5 break-words text-[12px] text-muted-2">
              {p.usedBy.length ? <>Needed by: {p.usedBy.slice(0, 4).join(", ")}{p.usedBy.length > 4 ? ` and ${p.usedBy.length - 4} more` : ""}.</> : "No content-program switch depends on it."}
            </p>
          </li>
        ))}
      </ul>
      <p className={cn("mt-2 text-[12px]", late.length ? "text-warning" : "text-muted")}>
        {late.length
          ? <>Late scheduled runs: {late.map((c) => `${c.job} (last started ${c.lastRunAt ? ago(c.lastRunAt, now) : "never"})`).join(", ")}.</>
          : <>Every scheduled run that records itself started on time.</>}
        {!isOwner && <> Connections are managed by Jordan.</>}
      </p>
    </Section>
  );
}
