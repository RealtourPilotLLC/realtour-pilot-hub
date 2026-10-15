import { redirect } from "next/navigation";
import { Images } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { Section } from "@/components/ui/Section";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { autohdrBalanceView } from "@/lib/vendorBalance";
import { etDate } from "@/lib/datetime";
import { AutohdrReadingForm } from "@/components/settings/AutohdrBalanceForms";
import { AutohdrCard } from "@/components/connections/AutohdrCard";

export const dynamic = "force-dynamic";

// Settings → AutoHDR balance (§10 AU-20, Sep 26): the AutoHDR card and an
// optional manual reading (owner + admin). It lives under /settings so Kyle
// can reach it; Connections is owner-only. The low-balance levels live on
// the Photo Delivery Credits page (the live credit monitor), so the old
// "What counts as low" form is retired here. Nothing links here any more.
export default async function AutohdrSettingsPage() {
  const me = await getCurrentUser().catch(() => null);
  if (authEnforced() && (!me || (me.role !== "OWNER" && me.role !== "ADMIN"))) redirect("/");
  const view = await autohdrBalanceView().catch(() => null);
  return (
    <div>
      <PageHeader title="AutoHDR balance" subtitle="The hub reads the balance through the AutoHDR API and never buys credits. Alert levels are on the Credits page." />
      <div className="mx-auto max-w-3xl space-y-6 p-4 pb-16 sm:p-6">
        <BackLink href="/settings" label="Settings" />
        <AutohdrCard />
        <Section icon={Images} title="Record a reading">
          <p className="mb-3 text-sm text-muted">
            Optional, and only needed while the AutoHDR API is not connected: when you check AutoHDR, put the credits left here.
            {view?.lastReading && ` Last reading: ${etDate(view.lastReading.observedAt)}.`}
          </p>
          <AutohdrReadingForm />
        </Section>
      </div>
    </div>
  );
}
