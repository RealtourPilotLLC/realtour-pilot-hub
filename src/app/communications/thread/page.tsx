import { BackLink } from "@/components/ui/BackLink";
import { getSecret } from "@/lib/integrations/connections";
import { loadConversation } from "@/lib/commsThread";
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
  let note: string | null = null;
  if (!connected) error = "OpenPhone is not connected.";
  else if (pn && participants.length) {
    // Live thread, backed by our own logged texts — a provider hiccup shows the
    // saved history with a banner instead of an empty "No messages yet."
    const loaded = await loadConversation(pn, participants);
    items = loaded.items;
    note = loaded.note;
  } else error = "Missing conversation details.";

  const members = isGroup ? await resolveParticipants(participants) : [];
  const ctx = !isGroup && participants[0] ? await getConversationContext(participants[0]) : { client: null, projects: [], activities: [] };
  const title = name || ctx.client?.name || (participants[0] ? fmtPhone(participants[0]) : "Conversation");

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        <BackLink href="/communications" label="All communications" />
      </div>
      {error ? (
        <div className="p-6"><div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div></div>
      ) : (
        <ConversationView
          toPhone={participants.join(",")}
          title={title}
          items={items}
          note={note}
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
