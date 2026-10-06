import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/ui/BackLink";
import { getCurrentUser } from "@/lib/auth/user";
import { requirePageAccess } from "@/lib/auth/guards";
import { strategyCallDesk } from "@/lib/strategyCallDesk";
import { StrategyCallsDesk } from "@/components/content/StrategyCallsDesk";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// STRATEGY CALLS · LAST 30 DAYS (Oct 6 2026). Jordan: "Maybe having an option
// to look through the strategy calls over the past 30 days to manually assign
// to a client's month would be great." Owner or admin only — assigning files a
// call on a client's month and moves the month to the call route.
// ---------------------------------------------------------------------------
export default async function StrategyCallsPage() {
  await requirePageAccess("content");
  const me = await getCurrentUser().catch(() => null);
  if (me && me.role !== "OWNER" && me.role !== "ADMIN") redirect("/content");
  const data = await strategyCallDesk();
  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/content" label="Content Program" />
      </div>
      <PageHeader eyebrow="Content program" title="Strategy calls" subtitle="last 30 days and the next 14 · file each call on a client's month" />
      <div className="mx-auto max-w-5xl p-4 pb-16 sm:p-6">
        <StrategyCallsDesk data={JSON.parse(JSON.stringify(data))} />
      </div>
    </div>
  );
}
