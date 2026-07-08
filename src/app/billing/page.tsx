import { redirect } from "next/navigation";

// Billing (accounts receivable) is now the Finance page's "Unpaid" tab (Jordan:
// "the toolbar has too many things" — Sales/Billing/Payouts collapsed into one
// Finance item). This route survives only so old links/notifications keep
// working; every query param is forwarded. Notifications emitted with an href of
// "/billing" (see lib/queries, lib/integrations/aryeo) land here and hop through.
export default async function BillingRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "unpaid" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/sales?${q.toString()}`);
}
