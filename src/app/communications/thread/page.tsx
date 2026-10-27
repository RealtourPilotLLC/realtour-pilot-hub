import { BackLink } from "@/components/ui/BackLink";
import { requirePageAccess } from "@/lib/auth/guards";
import { getSecret } from "@/lib/integrations/connections";
import { loadConversation } from "@/lib/commsThread";
import { getConversationContext, resolveParticipants } from "@/lib/queries";
import { ConversationView, type ChatItem } from "@/components/comms/ConversationView";
import { viewerMoneyView } from "@/components/comms/viewerScrub";
import { phoneKey } from "@/lib/phoneKey";

export const dynamic = "force-dynamic";

function fmtPhone(p: string) {
  const d = phoneKey(p);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

export default async function ThreadPage({
  searchParams,
}: {
  searchParams: Promise<{ pn?: string; p?: string; name?: string }>;
}) {
  // Oct 20 2026 (audit F14): the in-page gate every top-level page carries.
  // Middleware trusts a login-time claim that can be days old, so a revoked
  // Messages permission kept reading client threads until the token expired.
  await requirePageAccess("communications");
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

  const [members, ctx, { seesPrices, clean }] = await Promise.all([
    isGroup ? resolveParticipants(participants) : Promise.resolve([]),
    !isGroup && participants[0] ? getConversationContext(participants[0]) : Promise.resolve({ client: null, projects: [], activities: [] } as Awaited<ReturnType<typeof getConversationContext>>),
    viewerMoneyView(),
  ]);
  const title = name || ctx.client?.name || (participants[0] ? fmtPhone(participants[0]) : "Conversation");
  // Audit F7 (Oct 20 2026): the money rule, same as Messages · Waiting on us.
  // Client words and the Activity tab are scrubbed for anyone but the owner.
  // An order's price rides to the browser only for whoever may see prices
  // (Oct 27 2026: the owner and admins, "Admins can see prices of services
  // and billing").

  return (
    <div>
      <div className="border-b border-border px-4 py-3 sm:px-6">
        {/* Back to Messages · All, the list this conversation opens from. */}
        <BackLink href="/communications?tab=all" label="All conversations" />
      </div>
      {error ? (
        <div className="p-4 sm:p-6"><div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div></div>
      ) : (
        <ConversationView
          toPhone={participants.join(",")}
          title={title}
          items={items.map((it) => (it.text ? { ...it, text: clean(it.text) } : it))}
          note={note}
          client={ctx.client}
          members={isGroup ? members : undefined}
          projects={ctx.projects.map((pr) => ({ ...pr, price: seesPrices ? pr.price : null, shootDate: pr.shootDate ? pr.shootDate.toISOString() : null }))}
          activities={ctx.activities.map((a) => ({
            id: a.id, body: clean(a.body), type: a.type, createdAt: a.createdAt.toISOString(), projectTitle: a.project?.title ?? null,
          }))}
        />
      )}
    </div>
  );
}
