import Link from "next/link";
import { UploadCloud, ArrowRight } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { getConnection } from "@/lib/integrations/connections";
import { ARYEO_WEB_PROVIDER } from "@/lib/integrations/aryeoWeb";
import { photoDeliverySettings } from "@/lib/photoDelivery/settings";
import { etDateTime } from "@/lib/datetime";
import { AryeoWebConnectForm, AryeoWebConnectedControls } from "./AryeoWebConnect";

// ARYEO HUB LOGIN on Connections (Oct 14 2026). Aryeo's public API cannot put
// photos on a listing or deliver it, so the hub signs in as its own Aryeo team
// member and does what the listing editor does (integrations/aryeoWeb.ts).
// The stage (off / upload / approve / auto) is in Photo Delivery settings.
const STAGE: Record<string, string> = {
  off: "Off: Kyle uploads and delivers by hand",
  on: "Kyle approves each job (Approve and deliver, or Approve and upload to Aryeo)",
};

export async function AryeoWebCard() {
  const me = await getCurrentUser().catch(() => null);
  const isOwner = me ? me.role === "OWNER" : !authEnforced();
  const [conn, settings] = await Promise.all([getConnection(ARYEO_WEB_PROVIDER).catch(() => null), photoDeliverySettings()]);
  const connected = !!conn?.secretEncrypted;
  let email: string | null = conn?.accountLabel ?? null;
  try {
    email = (conn?.metadata ? (JSON.parse(conn.metadata) as { email?: string }).email : null) ?? email;
  } catch { /* the label stands */ }
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5" data-card="aryeo-web">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <UploadCloud className="size-4 text-brand" /> Aryeo hub login
        <span className={`rounded-full px-2 py-0.5 text-ui-status font-medium ${conn?.lastError ? "bg-danger/10 text-danger" : connected ? "bg-success/10 text-success" : "bg-surface-2 text-muted"}`}>
          {conn?.lastError ? "Sign-in failing" : connected ? "Connected" : "Not set up"}
        </span>
        <Link href="/ops/photo-delivery/settings" className="ml-auto inline-flex min-h-11 items-center gap-1 text-ui-status font-semibold text-brand hover:underline">
          Stage <ArrowRight className="size-3" />
        </Link>
      </div>
      <p className="mt-2 text-xs text-muted">Lets the hub put the 06-Ready-for-Aryeo photos on a listing, in order, and deliver it, the way Kyle does in Aryeo. Aryeo&rsquo;s public API can&rsquo;t, so the hub signs in as its own team member.</p>
      <ul className="mt-2 space-y-1 text-xs text-muted">
        {connected && <li><span className="font-medium text-foreground">Login:</span> {email ?? "saved"}{conn?.updatedAt ? `, saved ${etDateTime(conn.updatedAt)}` : ""}</li>}
        <li><span className="font-medium text-foreground">Stage:</span> {STAGE[settings.aryeoPush] ?? settings.aryeoPush}</li>
        {settings.aryeoPush === "on" && settings.sameDayAutoDeliver && <li>Same-day orders deliver by themselves once every check passes.</li>}
        {!connected && settings.aryeoPush !== "off" && <li className="text-warning">The stage is not Off, but the login is not set up, so nothing reaches Aryeo yet.</li>}
        {conn?.lastError && <li className="text-danger"><span className="font-medium">Last error:</span> {conn.lastError}</li>}
      </ul>
      {isOwner && (connected ? <AryeoWebConnectedControls /> : <AryeoWebConnectForm />)}
      {!isOwner && !connected && <p className="mt-2 text-xs text-muted">Jordan sets the hub&rsquo;s Aryeo login up here.</p>}
    </section>
  );
}
