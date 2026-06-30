import Link from "next/link";
import { History } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { AskHub } from "@/components/assistant/AskHub";
import { isOwnerView } from "@/lib/access";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";

export const dynamic = "force-dynamic";

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const owner = await isOwnerView();
  const me = await getCurrentUser();
  const tier = me ? contentTier(me.role) : "OWNER";
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Ask the Hub"
        subtitle="Answers from your live hub data — shoots, clients, schedule, to-dos, billing"
        actions={
          owner ? (
            <Link
              href="/assistant/history"
              className="inline-flex items-center gap-1.5 rounded-lg border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
            >
              <History className="size-3.5" /> History &amp; insights
            </Link>
          ) : null
        }
      />
      <AskHub initial={q} tier={tier} />
    </div>
  );
}
