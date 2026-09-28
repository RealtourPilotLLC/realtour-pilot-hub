import { Wrench } from "lucide-react";
import { Section } from "@/components/ui/Section";
import { evidenceCandidates, reworkRowsForProject, REWORK_KIND_LABEL } from "@/lib/reworkCost";
import { CAUSE_LABEL, isIssueCause } from "@/lib/issueCauses";
import { etDate } from "@/lib/datetime";
import { ReworkCostForm, VoidReworkButton } from "@/components/project/ReworkCostForm";

// WHAT THE REDO COST (§10 AU-26, Sep 26) — OWNER ONLY; the caller renders it
// only when the viewer can see money. Actual and estimate are kept apart, a job
// with nothing recorded says so (unknown, not $0), and nothing here is ever
// subtracted into a profit figure: the Jobs tab shows it BESIDE the modelled
// margin.

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function evidenceWords(raw: string): string {
  const ref = raw.split("#void:")[0];
  if (ref.startsWith("manual:")) return "manual";
  if (ref.startsWith("round:")) return "revision round";
  if (ref.startsWith("stripe:")) return "Stripe refund";
  if (ref.startsWith("qbo:")) return "QuickBooks";
  if (ref.startsWith("payroll:")) return "payroll";
  return ref;
}

export async function ReworkCostPanel({ projectId }: { projectId: string }) {
  const [rows, candidates] = await Promise.all([
    reworkRowsForProject(projectId).catch(() => null),
    evidenceCandidates(projectId).catch(() => []),
  ]);
  if (rows === null) {
    return (
      <Section icon={Wrench} title="Rework cost">
        <p className="text-sm text-muted">The rework record couldn&rsquo;t be read just now — reload to try again.</p>
      </Section>
    );
  }
  const live = rows.filter((r) => !r.voidedAt);
  const actual = live.filter((r) => r.basis === "actual").reduce((s, r) => s + r.amountCents, 0);
  const estimate = live.filter((r) => r.basis === "estimate").reduce((s, r) => s + r.amountCents, 0);
  return (
    <Section icon={Wrench} title="Rework cost" count={live.length || null}>
      {live.length === 0 ? (
        <p className="text-sm text-muted">None recorded — which means unknown, not free.</p>
      ) : (
        <p className="text-sm">
          <strong className="tabular-nums">{actual ? usd(actual) : "—"}</strong> actual
          {estimate > 0 && <> · <span className="tabular-nums">{usd(estimate)}</span> estimated</>}
          <span className="text-xs text-muted"> · shown beside the job&rsquo;s modelled margin, never taken out of it</span>
        </p>
      )}
      {rows.length > 0 && (
        <ul className="mt-2 divide-y text-xs">
          {rows.map((r) => (
            <li key={r.id} className={`flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 ${r.voidedAt ? "text-muted-2 line-through" : ""}`}>
              <span className="font-medium">{REWORK_KIND_LABEL[r.kind]}</span>
              <span className="tabular-nums">{usd(r.amountCents)}</span>
              <span className="text-muted">{r.basis}</span>
              <span className="text-muted">· {evidenceWords(r.evidenceRef)}</span>
              {r.issueCause && isIssueCause(r.issueCause) && <span className="text-muted">· {CAUSE_LABEL[r.issueCause]}</span>}
              <span className="text-muted-2">· {r.enteredBy} {etDate(r.enteredAt)}</span>
              {r.note && <span className="w-full text-muted no-underline">{r.note}</span>}
              {!r.voidedAt && !r.enteredBy.startsWith("system:") && <VoidReworkButton projectId={projectId} id={r.id} />}
              {r.voidedAt && <span className="no-underline">(voided {etDate(r.voidedAt)})</span>}
            </li>
          ))}
        </ul>
      )}
      <ReworkCostForm projectId={projectId} candidates={candidates} />
    </Section>
  );
}
