import Link from "next/link";
import { Images, ArrowRight } from "lucide-react";
import { autohdrBalanceView } from "@/lib/vendorBalance";
import { etDate } from "@/lib/datetime";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney } from "@/lib/auth/access";

// AUTOHDR on Connections (§10 AU-20, Sep 26). Three separate lines on purpose,
// because they are three different kinds of knowledge: whether the hub can read
// the balance (it cannot), what a person last read off the account, and what
// the bank last saw paid to AutoHDR. None of them is a live balance.
//
// THE TOP-UP LINE IS THE OWNER'S (Sep 26 2026 review). This card also sits on
// Settings → AutoHDR balance, which Kyle and James (ADMIN) open to record the
// Monday reading — and the top-up is Jordan's own payment off his bank feed or
// QuickBooks. An admin gets full ops and no money (access.ts canSeeMoney), so
// the card asks who is looking rather than trusting each page to remember:
// for anyone but the owner the bank and the books are not read at all and the
// line is not drawn. The reading Kyle typed himself stays.
export async function AutohdrCard() {
  const me = await getCurrentUser().catch(() => null);
  const money = me ? canSeeMoney(me.role) : !authEnforced();
  const v = await autohdrBalanceView(new Date(), { money }).catch(() => null);
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Images className="size-4 text-brand" /> AutoHDR
        <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-muted">Not connected</span>
        <Link href="/settings/autohdr" className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
          Balance &amp; settings <ArrowRight className="size-3" />
        </Link>
      </div>
      {!v ? (
        <p className="mt-2 text-sm text-muted">The AutoHDR record couldn&rsquo;t be read just now — reload to try again.</p>
      ) : (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          <li><span className="font-medium text-foreground">API:</span> not connected — the credit balance can&rsquo;t be read by the hub (no verified balance endpoint). Processing is AutoHDR watching the Dropbox folders; the hub counts, registers and chases.</li>
          <li>
            <span className="font-medium text-foreground">Last reading:</span>{" "}
            {v.lastReading
              ? `${v.lastReading.credits != null ? `${v.lastReading.credits.toLocaleString("en-US")} credits` : ""}${v.lastReading.credits != null && v.lastReading.dollars != null ? " · " : ""}${v.lastReading.dollars != null ? `$${v.lastReading.dollars.toFixed(2)}` : ""} on ${etDate(v.lastReading.observedAt)} (${v.lastReading.recordedBy})`
              : "none recorded yet"}
            {v.since && ` · since then ~${v.since.finishedPhotos} finished photos (estimate)${v.since.uncountedJobs ? `, ${v.since.uncountedJobs} job${v.since.uncountedJobs === 1 ? "" : "s"} not counted yet` : ""}`}
          </li>
          {money && (
            <li>
              <span className="font-medium text-foreground">Last top-up seen:</span>{" "}
              {v.lastTopUp ? `$${v.lastTopUp.amount.toFixed(2)} on ${etDate(v.lastTopUp.at)} (${v.lastTopUp.source === "bank" ? "bank feed" : "QuickBooks"})` : "none in the bank feed or QuickBooks"}
            </li>
          )}
          <li>
            <span className="font-medium text-foreground">Low-credit alert:</span>{" "}
            {v.threshold ? (v.low === null ? "set — no reading to compare yet" : v.low ? "BELOW the threshold" : "above the threshold") : "no threshold set (Jordan hasn't named one), so nothing is compared"}
            {v.openWarnings > 0 && ` · ${v.openWarnings} AutoHDR warning email task open`}
          </li>
        </ul>
      )}
    </section>
  );
}
