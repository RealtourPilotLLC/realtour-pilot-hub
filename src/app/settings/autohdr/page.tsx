import { redirect } from "next/navigation";
import { Images } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { autohdrBalanceView } from "@/lib/vendorBalance";
import { etDate } from "@/lib/datetime";
import { AutohdrReadingForm, AutohdrSettingsForm } from "@/components/settings/AutohdrBalanceForms";
import { AutohdrCard } from "@/components/connections/AutohdrCard";

export const dynamic = "force-dynamic";

// Settings → AutoHDR balance (§10 AU-20, Sep 26). Where Kyle's Monday check
// lands: the reading form (owner + admin) and, for the owner, who checks and
// what counts as low. It lives under /settings so Kyle can reach it —
// Connections is owner-only.
export default async function AutohdrSettingsPage() {
  const me = await getCurrentUser().catch(() => null);
  if (authEnforced() && (!me || (me.role !== "OWNER" && me.role !== "ADMIN"))) redirect("/");
  const isOwner = me ? me.role === "OWNER" : !authEnforced();
  const view = await autohdrBalanceView().catch(() => null);
  return (
    <div>
      <PageHeader title="AutoHDR balance" subtitle="A reading, never a purchase — the hub can't read AutoHDR's balance and never buys credits" />
      <div className="mx-auto max-w-3xl space-y-6 p-4 pb-16 sm:p-6">
        <BackLink href="/settings" label="Settings" />
        <AutohdrCard />
        <Section icon={Images} title="Record a reading">
          <p className="mb-3 text-sm text-muted">
            Optional: when you check AutoHDR, put the credits left here. There is no weekly check task any more; AutoHDR&rsquo;s own low-credit emails alert Jordan.
            {view?.lastReading && ` Last reading: ${etDate(view.lastReading.observedAt)}.`}
          </p>
          <AutohdrReadingForm />
        </Section>
        {isOwner && view && (
          <Section icon={Images} title="What counts as low">
            <AutohdrSettingsForm initial={view.settings} />
          </Section>
        )}
      </div>
    </div>
  );
}
