import { notFound, redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { TopazCompare } from "@/components/settings/TopazCompare";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// ONE "TRY THESE SETTINGS" TEST, SIDE BY SIDE (Jordan, Oct 22 2026).
//
// The original and the Topaz version as two synced players and a draggable
// wipe (no zoom on video, by Jordan's call). Owner only: a test is money and its
// cost is on this page. The Topaz file is streamed from Topaz itself, which
// keeps a finished file for 7 days; the link is minted fresh on every load (a
// free status read) and goes to the owner's browser only. Nothing here files,
// sends or publishes anything.
// ---------------------------------------------------------------------------
export default async function TopazTestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getCurrentUser().catch(() => null);
  if (authEnforced() && (!me || me.role !== "OWNER")) redirect("/settings");
  if (!/^[a-f0-9]{16}$/.test(id)) notFound();
  const { topazTestFor } = await import("@/lib/topazTests");
  const got = await topazTestFor(id).catch(() => null);
  if (!got) notFound();
  return (
    <>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/settings" label="Settings" />
      </div>
      <PageHeader title="Topaz test" subtitle={got.view.label} />
      <div className="mx-auto max-w-6xl space-y-6 p-4 pb-16 sm:p-6">
        <TopazCompare view={got.view} topazUrl={got.topazUrl} originalUrl={got.originalUrl} />
      </div>
    </>
  );
}
