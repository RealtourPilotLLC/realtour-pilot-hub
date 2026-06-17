import { PageHeader } from "@/components/PageHeader";
import { AskHub } from "@/components/assistant/AskHub";

export const dynamic = "force-dynamic";

export default function AssistantPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Ask the Hub" subtitle="Your SOP & operations assistant" />
      <AskHub />
    </div>
  );
}
