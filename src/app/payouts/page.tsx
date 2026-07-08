import { redirect } from "next/navigation";

// Payouts (photographer payroll) is now the Finance page's "Payroll" tab
// (owner-only, same as before). This route survives only so old links/
// notifications keep working; every query param — notably ?start=<period> from
// the bi-weekly picker — is forwarded so a deep link opens the exact period.
// Notifications emitted with an href of "/payouts" (see app/my-pay/actions)
// land here and hop through to the owner-only Payroll tab.
export default async function PayoutsRedirect({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const q = new URLSearchParams({ tab: "payroll" });
  for (const [k, v] of Object.entries(sp)) {
    if (k === "tab" || v == null) continue;
    for (const val of Array.isArray(v) ? v : [v]) q.append(k, val);
  }
  redirect(`/sales?${q.toString()}`);
}
