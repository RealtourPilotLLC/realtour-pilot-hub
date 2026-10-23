import { Sparkles } from "lucide-react";
import { ownerAiSpend, canSeeAiSpend, aiFeatureLabel, type AiSpendLine } from "@/lib/aiUsage";
import { aiOutageNow, readAiFailures } from "@/lib/aiOutage";
import { etDate, etDateTime, etDayKey } from "@/lib/datetime";
import { usd2 } from "@/lib/money";

// AI SPEND, on Finance → Overview (Oct 22 2026). What the hub's own Anthropic
// key spent in the last 30 days, by feature and by model: the usage ledger
// (lib/aiUsage) from the day it started, and before that the content
// program's and photo QC's own run records. Money, so owner only — the
// loader refuses anyone else too. Read-only.
export async function AiSpendCard() {
  if (!(await canSeeAiSpend())) return null;
  const spend = await ownerAiSpend().catch(() => null);
  // REFUSALS (Oct 22 2026, comms audit H5): calls the AI turned away for a
  // spend limit, an empty balance or a refused key, by feature, and whether it
  // is refusing right now (lib/aiOutage).
  const now = new Date();
  const [refusals, outage] = await Promise.all([
    readAiFailures(etDayKey(new Date(now.getTime() - 29 * 86_400_000)), etDayKey(now)).catch(() => []),
    aiOutageNow().catch(() => null),
  ]);
  const refusedBy = new Map<string, number>();
  for (const r of refusals) refusedBy.set(r.feature, (refusedBy.get(r.feature) ?? 0) + r.count);
  const refusedTotal = [...refusedBy.values()].reduce((a, b) => a + b, 0);
  if (!spend) {
    return (
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-brand" /> AI spend</div>
        <p className="mt-2 text-sm text-muted">This couldn&rsquo;t be read just now. Reload to try again.</p>
      </section>
    );
  }
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-brand" /> AI spend · last {spend.days} days
        </div>
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-semibold tabular-nums">{usd2(spend.totalUsd)}</span>
      </div>
      <p className="mb-3 text-xs text-muted">
        Estimated from list prices, {spend.totalCalls.toLocaleString("en-US")} calls on the hub&rsquo;s own key. The Anthropic invoice is the final word.
      </p>
      {outage || refusedTotal > 0 ? (
        <div className="mb-3 rounded-xl border border-danger/40 bg-danger/5 p-3 text-sm">
          {outage ? (
            <p className="font-semibold text-danger">
              The AI is refusing the hub&rsquo;s calls since {etDateTime(outage.since)} ({outage.reason === "credit" ? "the credit balance ran out" : outage.reason === "auth" ? "the key was refused" : "the usage limit was reached"}). Texts and emails are read again when it answers.
            </p>
          ) : null}
          {refusedTotal > 0 ? (
            <p className="mt-1 text-xs text-muted">
              {refusedTotal.toLocaleString("en-US")} refused call{refusedTotal === 1 ? "" : "s"} in {spend.days} days:{" "}
              {[...refusedBy.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${aiFeatureLabel(f)} ${n}`).join(", ")}.
            </p>
          ) : null}
        </div>
      ) : null}
      {spend.totalCalls === 0 ? (
        <p className="rounded-xl bg-surface-2/50 p-3 text-sm text-muted">Nothing recorded yet. Calls show up here as they happen.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SpendList title="By feature" lines={spend.byFeature} />
          <SpendList title="By model" lines={spend.byModel} />
        </div>
      )}
      <ul className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted-2">
        <li>
          {spend.ledgerSince
            ? `Every call has been recorded since ${etDate(new Date(spend.ledgerSince))}. Before that, only the content program and photo QC kept their own costs, and those are what is counted for the earlier days.`
            : "The hub starts recording every call with its next AI answer. Until then only the content program and photo QC costs are counted."}
        </li>
        <li>
          Script Studio, the Social Content Funnel and the other apps use their own API keys and are not counted here. To see them, open the Anthropic Console, Usage, and group by API key.
        </li>
      </ul>
    </section>
  );
}

function SpendList({ title, lines }: { title: string; lines: AiSpendLine[] }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2/40 p-3">
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-2">{title}</div>
      <ul className="divide-y divide-border/60 text-sm">
        {lines.slice(0, 12).map((l) => (
          <li key={l.key} className="flex items-baseline justify-between gap-3 py-1.5">
            <span className="min-w-0 truncate text-foreground/90">{l.label}</span>
            <span className="shrink-0 tabular-nums text-muted">
              <span className="mr-2 text-[11px] text-muted-2">{l.calls.toLocaleString("en-US")} calls</span>
              {usd2(l.usd)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
