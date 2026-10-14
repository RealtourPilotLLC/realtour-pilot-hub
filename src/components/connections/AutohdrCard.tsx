import Link from "next/link";
import { Images, ArrowRight } from "lucide-react";
import { autohdrBalanceView } from "@/lib/vendorBalance";
import { etDate, etDateTime } from "@/lib/datetime";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { canSeeMoney } from "@/lib/auth/access";
import { creditView } from "@/lib/photoDelivery/credits";
import { autohdrClientIdHint, autohdrCredentials, AUTOHDR_DEVELOPER_URL } from "@/lib/integrations/autohdr";
import { AutohdrConnectForm, AutohdrConnectedControls } from "./AutohdrConnect";

// AUTOHDR on Connections. Since Oct 13 2026 (Jordan: "Set up the API on
// AutoHDR for me") the hub can READ the credit balance through AutoHDR's API
// once the owner pastes an API client here. Until then the card keeps the
// Sep 26 lines: the last reading a person typed and the last top-up seen.
//
// THE TOP-UP LINE IS THE OWNER'S (Sep 26 2026 review). This card also sits on
// Settings → AutoHDR balance, which Kyle and James (ADMIN) open — and the
// top-up is Jordan's own payment off his bank feed. For anyone but the owner
// the bank and the books are not read at all and the line is not drawn. The
// connect form is owner-only too: credentials are the owner's.
export async function AutohdrCard() {
  const me = await getCurrentUser().catch(() => null);
  const money = me ? canSeeMoney(me.role) : !authEnforced();
  const isOwner = me ? me.role === "OWNER" : !authEnforced();
  const [v, credits, creds, idHint] = await Promise.all([
    autohdrBalanceView(new Date(), { money }).catch(() => null),
    creditView().catch(() => null),
    autohdrCredentials().catch(() => null),
    autohdrClientIdHint().catch(() => null),
  ]);
  const connected = !!creds;
  const tone =
    credits?.level === "critical" ? "bg-danger/10 text-danger" : credits?.level === "warn" ? "bg-warning/15 text-warning" : connected ? "bg-success/10 text-success" : "bg-surface-2 text-muted";
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5" data-card="autohdr">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Images className="size-4 text-brand" /> AutoHDR
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>
          {connected ? (credits?.balance != null ? `${credits.balance.toLocaleString("en-US")} credits` : "Connected") : "API not connected"}
        </span>
        <Link href="/ops/photo-delivery/credits" className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-brand hover:underline">
          Credits <ArrowRight className="size-3" />
        </Link>
      </div>

      {connected ? (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          <li>
            <span className="font-medium text-foreground">API:</span> connected{idHint ? ` (client ${idHint})` : ""}
            {creds?.source === "env" ? ", from the deployment's environment" : ""}. The hub reads the balance every 15 minutes; it never buys credits and never spends them without a click.
          </li>
          <li>
            <span className="font-medium text-foreground">Balance:</span>{" "}
            {credits?.balance != null ? `${credits.balance.toLocaleString("en-US")} credits, read ${credits.checkedAt ? etDateTime(credits.checkedAt) : "just now"}` : "not read yet"}
            {credits?.runwayDays != null ? ` · about ${credits.runwayDays} days left at ${credits.perDay}/day` : ""}
          </li>
          <li>
            <span className="font-medium text-foreground">Alerts:</span> you and Kyle get one alert below {credits?.thresholds.warn ?? 250} and one below {credits?.thresholds.critical ?? 100} (bell, Slack or text).
          </li>
          {credits?.lastError && (
            <li className="text-danger">
              <span className="font-medium">Last error:</span> {credits.lastError}
            </li>
          )}
        </ul>
      ) : v ? (
        <ul className="mt-2 space-y-1 text-xs text-muted">
          <li>
            <span className="font-medium text-foreground">Last reading:</span>{" "}
            {v.lastReading
              ? `${v.lastReading.credits != null ? `${v.lastReading.credits.toLocaleString("en-US")} credits` : ""}${v.lastReading.credits != null && v.lastReading.dollars != null ? " · " : ""}${v.lastReading.dollars != null ? `$${v.lastReading.dollars.toFixed(2)}` : ""} on ${etDate(v.lastReading.observedAt)} (${v.lastReading.recordedBy})`
              : "none recorded yet"}
          </li>
          {money && (
            <li>
              <span className="font-medium text-foreground">Last top-up seen:</span>{" "}
              {v.lastTopUp ? `$${v.lastTopUp.amount.toFixed(2)} on ${etDate(v.lastTopUp.at)} (${v.lastTopUp.source === "bank" ? "bank feed" : "QuickBooks"})` : "none in the bank feed or QuickBooks"}
            </li>
          )}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">The AutoHDR record couldn&rsquo;t be read just now. Reload to try again.</p>
      )}

      {isOwner && (connected ? (creds?.source === "connection" ? <AutohdrConnectedControls /> : null) : <AutohdrConnectForm developerUrl={AUTOHDR_DEVELOPER_URL} />)}
      {!isOwner && !connected && <p className="mt-2 text-[11px] text-muted">Jordan connects the AutoHDR API here.</p>}
      <p className="mt-2 text-[11px] text-muted">
        Editing still runs through the Dropbox folders (AutoHDR watches /AutoHDR). The API adds the live balance, photo QC fixes and version history.{" "}
        <Link href="/settings/autohdr" className="font-medium text-brand hover:underline">Settings</Link>
      </p>
    </section>
  );
}
