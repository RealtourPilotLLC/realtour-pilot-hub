import { PageHeader } from "@/components/PageHeader";
import { AskHub } from "@/components/assistant/AskHub";

export const dynamic = "force-dynamic";

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Ask the Hub" subtitle="Answers from your live hub data — shoots, clients, schedule, to-dos, billing" />
      <AskHub initial={q} />
    </div>
  );
}
