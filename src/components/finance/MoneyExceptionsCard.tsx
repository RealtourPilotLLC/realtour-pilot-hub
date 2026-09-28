import Link from "next/link";
import { ShieldAlert } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { moneyExceptions, MONEY_EXCEPTION_LABEL } from "@/lib/moneyExceptions";

// MONEY AND IDENTITY EXCEPTIONS, on Finance → Overview (§10 AU-25, Sep 26).
// Where what a client pays for, what they are given and who they are stop
// agreeing. Report-only: every row says what to check, and not one of them has
// a button that charges, refunds, moves a credit or merges anybody.
export async function MoneyExceptionsCard() {
  const me = await getCurrentUser().catch(() => null);
  // Same rule as the Finance page: no session is the owner only with auth off.
  const viewer = me ?? (authEnforced() ? null : { role: "OWNER", realRole: "OWNER" });
  const rows = await moneyExceptions(viewer).catch(() => null);
  if (rows === null) {
    return (
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center gap-2 text-sm font-semibold"><ShieldAlert className="size-4 text-warning" /> Money &amp; identity checks</div>
        <p className="mt-2 text-sm text-muted">These couldn&rsquo;t be read just now — reload to try again. Nothing has been changed.</p>
      </section>
    );
  }
  if (rows.length === 0) return null;
  return (
    <section className="rounded-2xl border border-warning/40 bg-surface p-4 sm:p-5">
      <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <ShieldAlert className="size-4 text-warning" /> Money &amp; identity checks
        <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">{rows.length}</span>
      </div>
      <p className="mb-3 text-xs text-muted">Things that don&rsquo;t agree. Nothing here is acted on automatically — no charges, refunds, credit moves or merges.</p>
      <ul className="divide-y">
        {rows.slice(0, 12).map((r) => (
          <li key={r.id} className="py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[11px] font-medium uppercase tracking-wide text-warning">{MONEY_EXCEPTION_LABEL[r.kind]}</span>
              <Link href={r.href} className="text-sm font-semibold hover:text-brand hover:underline">{r.title}</Link>
            </div>
            <p className="mt-0.5 text-xs text-foreground/85">{r.why}</p>
            <ul className="mt-1 list-disc pl-4 text-[11px] text-muted">
              {r.evidence.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
            <p className="mt-1 text-xs"><span className="font-medium">Next:</span> {r.nextAction}</p>
          </li>
        ))}
      </ul>
      {rows.length > 12 && <p className="mt-2 text-xs text-muted">{rows.length - 12} more not shown.</p>}
    </section>
  );
}
