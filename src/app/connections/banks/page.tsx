import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { plaidConfigured, getPlaidCreds, listPlaidBanks } from "@/lib/integrations/plaid";
import { PlaidConnect, type PlaidBankView } from "@/components/connections/PlaidConnect";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // full-history backfill can page thousands of txns

export default async function BanksPage() {
  const user = await getCurrentUser();
  if (authEnforced() && user?.realRole !== "OWNER") redirect("/");

  const [configured, creds, { items, txnCount }] = await Promise.all([
    plaidConfigured(),
    getPlaidCreds(),
    listPlaidBanks(),
  ]);

  const banks: PlaidBankView[] = items.map((b) => ({
    id: b.id,
    institutionName: b.institutionName,
    status: b.status,
    lastError: b.lastError,
    lastSyncedAt: b.lastSyncedAt ? b.lastSyncedAt.toISOString() : null,
    accounts: b.accounts.map((a) => ({
      id: a.id,
      accountId: a.accountId,
      name: a.name,
      officialName: a.officialName,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      currentBalance: a.currentBalance,
      availableBalance: a.availableBalance,
      isBusiness: a.isBusiness,
    })),
  }));

  return (
    <div>
      <PageHeader
        eyebrow="Connections"
        title="Bank & card accounts"
        subtitle="Link your personal account, Venmo & credit cards via Plaid — read-only — to complete the money picture"
      />
      <div className="mx-auto max-w-3xl space-y-5 p-4 sm:p-6">
        <Link href="/connections" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-brand">
          <ArrowLeft className="size-4" /> All connections
        </Link>
        <PlaidConnect configured={configured} env={creds?.env ?? null} banks={banks} txnCount={txnCount} />
      </div>
    </div>
  );
}
