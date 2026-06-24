import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getSecret } from "@/lib/integrations/connections";
import { conversationThread } from "@/lib/integrations/openphone";
import { getConversationContext, resolveParticipants } from "@/lib/queries";
import { ConversationView, type ChatItem } from "@/components/comms/ConversationView";

export const dynamic = "force-dynamic";

function fmtPhone(p: string) {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

export default async function ThreadPage({
  searchParams,
}: {
  searchParams: Promise<{ pn?: string; p?: string; name?: string }>;
}) {
  const { pn, p, name } = await searchParams;
  // `p` may carry several comma-separated participants for a group conversation.
  const participants = (p ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const isGroup = participants.length > 1;

  const connected = !!(await getSecret("openphone"));
  let items: ChatItem[] = [];
  let error: string | null = null;
  if (!connected) error = "OpenPhone is not connected.";
  else if (pn && participants.length) {
    try {
      // conversationThread returns newest-first; reverse to oldest→newest (chat order).
      const thread = await conversationThread(pn, participants);
      items = thread.reverse().map((t) => ({
        kind: t.kind, id: t.id, at: t.at, direction: t.direction,
        text: t.kind === "message" ? t.text : undefined,
        from: t.kind === "message" ? t.from : undefined,
        duration: t.kind === "call" ? t.duration : undefined,
        status: t.kind === "call" ? t.status : undefined,
      }));
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load this conversation.";
    }
  } else error = "Missing conversation details.";

  const members = isGroup ? await resolveParticipants(participants) : [];
  const ctx = !isGroup && participants[0] ? await getConversationContext(participants[0]) : { client: null, projects: [], activities: [] };
  const title = name || ctx.client?.name || (participants[0] ? fmtPhone(participants[0]) : "Conversation");

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <Link href="/communications" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> All communications
        </Link>
      </div>
      {error ? (
        <div className="p-6"><div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div></div>
      ) : (
        <ConversationView
          toPhone={participants.join(",")}
          title={title}
          items={items}
          client={ctx.client}
          members={isGroup ? members : undefined}
          projects={ctx.projects.map((pr) => ({ ...pr, shootDate: pr.shootDate ? pr.shootDate.toISOString() : null }))}
          activities={ctx.activities.map((a) => ({
            id: a.id, body: a.body, type: a.type, createdAt: a.createdAt.toISOString(), projectTitle: a.project?.title ?? null,
          }))}
        />
      )}
    </div>
  );
}
