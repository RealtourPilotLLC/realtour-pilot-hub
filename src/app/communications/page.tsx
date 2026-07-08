import Link from "next/link";
import { Mail, MessageCircle, Phone, Send, User, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import { OpenPhone, phoneKey, recentOpenPhoneConversations, type OpConversation } from "@/lib/integrations/openphone";
import { getClientTextTasks } from "@/lib/queries";
import { ClientTextsPanel } from "@/components/texts/ClientTextsPanel";
import { getEmailThreads } from "@/components/comms/emailThreads";
import { EmailThreadList } from "@/components/comms/EmailThreadList";
import { TeamMessagesPanel } from "@/components/comms/TeamMessagesPanel";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

function fmtPhone(p: string) {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

// One comms surface, four tabs (Jordan: "keep comms all in one tab" → "sick
// messaging and comms hub"): the live OpenPhone inbox, client email threads,
// internal team messaging, and the Outbox — today's drafted confirmation +
// delivery texts waiting for a human to review and send. Every tab is
// shareable via ?tab= and loads ONLY its own data (the heavy OpenPhone pull
// never runs for the other three).
type CommsTab = "inbox" | "email" | "team" | "outbox";

function CommsTabs({ tab, pending, emailFresh = 0 }: { tab: CommsTab; pending: number; emailFresh?: number }) {
  const active = "rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white";
  const idle = "rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2";
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5">
      <Link href="/communications" className={tab === "inbox" ? active : idle}>
        <MessageCircle className="mr-1.5 inline size-3.5" />
        Inbox
      </Link>
      <Link href="/communications?tab=email" className={tab === "email" ? active : idle}>
        <Mail className="mr-1.5 inline size-3.5" />
        Email
        {/* "Unread-ish": threads where the client wrote last, in the past 48h.
            Computed by the email tab's own query, so it shows there (no extra
            CommLog scan is spent on the other tabs). */}
        {emailFresh > 0 && (
          <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${tab === "email" ? "bg-white/20" : "bg-brand/15 text-brand"}`}>
            {emailFresh}
          </span>
        )}
      </Link>
      <Link href="/communications?tab=team" className={tab === "team" ? active : idle}>
        <Users className="mr-1.5 inline size-3.5" />
        Team
      </Link>
      <Link href="/communications?tab=outbox" className={tab === "outbox" ? active : idle}>
        <Send className="mr-1.5 inline size-3.5" />
        Outbox
        {pending > 0 && (
          <span className={`ml-1.5 rounded-full px-1.5 text-xs font-semibold ${tab === "outbox" ? "bg-white/20" : "bg-brand/15 text-brand"}`}>
            {pending}
          </span>
        )}
      </Link>
    </div>
  );
}

export default async function CommunicationsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const sp = await searchParams;
  const tab: CommsTab = sp.tab === "outbox" || sp.tab === "email" || sp.tab === "team" ? sp.tab : "inbox";
  const pendingTexts = (await getClientTextTasks()).length;

  // The Outbox renders without the (slow) OpenPhone conversation pull — drafts
  // come from SmartTasks; OpenPhone is only involved when a human hits Send.
  if (tab === "outbox") {
    return (
      <div>
        <PageHeader
          eyebrow="Eastern time"
          title="Communications"
          subtitle="Today's confirmation and delivery texts — review each draft, then send."
        />
        <div className="p-4 sm:p-6">
          <CommsTabs tab="outbox" pending={pendingTexts} />
          <ClientTextsPanel />
        </div>
      </div>
    );
  }

  // Email: read-only client/lead threads from the Gmail sync (CommLog rows) —
  // no OpenPhone involved. Replies happen in Gmail (no send scope connected).
  if (tab === "email") {
    const { threads, fresh } = await getEmailThreads();
    return (
      <div>
        <PageHeader
          title="Communications"
          subtitle="Client email from the last 60 days, grouped into threads. Reply from Gmail."
          actions={<Badge soft="var(--surface-2)">Synced from Gmail</Badge>}
        />
        <div className="p-4 sm:p-6">
          <CommsTabs tab="email" pending={pendingTexts} emailFresh={fresh} />
          <EmailThreadList threads={threads} />
        </div>
      </div>
    );
  }

  // Team: internal project-message threads across every job — one stream, no
  // external providers touched. Rows deep-link to the project's composer.
  if (tab === "team") {
    return (
      <div>
        <PageHeader
          title="Communications"
          subtitle="Team messages across all projects — click a thread to reply on the project page."
        />
        <div className="p-4 sm:p-6">
          <CommsTabs tab="team" pending={pendingTexts} />
          <TeamMessagesPanel />
        </div>
      </div>
    );
  }

  const connected = await getSecret("openphone");
  if (!connected) {
    return (
      <div>
        <PageHeader title="Communications" subtitle="Calls & texts from OpenPhone" />
        <div className="p-6">
          <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
            <Phone className="mx-auto mb-2 size-6 text-muted-2" />
            <p className="text-sm text-muted">
              Connect OpenPhone in <strong>Connections</strong> to see your calls &amp; texts here.
            </p>
          </div>
        </div>
      </div>
    );
  }

  let conversations: OpConversation[] = [];
  let error: string | null = null;
  let ourNumbers = new Set<string>();
  try {
    // Page through ALL conversations and sort newest-first — OpenPhone's native
    // order is arbitrary, so fetching a single page drops active threads (incl.
    // group texts) from the inbox.
    const [convs, phones] = await Promise.all([
      recentOpenPhoneConversations(),
      OpenPhone.phoneNumbers(),
    ]);
    conversations = convs;
    ourNumbers = new Set(phones.map((p) => phoneKey(p.number)).filter(Boolean));
  } catch (e) {
    error = e instanceof Error ? e.message : "Could not load conversations.";
  }

  // Match conversation participants to clients by phone.
  const clients = await prisma.client.findMany({
    where: { phone: { not: null } },
    select: { id: true, name: true, phone: true },
  });
  const clientByPhone = new Map<string, { id: string; name: string }>();
  for (const c of clients) {
    const k = phoneKey(c.phone);
    if (k) clientByPhone.set(k, { id: c.id, name: c.name });
  }

  // Fall back to synced OpenPhone/HubSpot contact names for numbers that aren't
  // one of our clients (each contact can carry several numbers).
  const contacts = await prisma.contact.findMany({
    where: { phones: { not: null } },
    select: { firstName: true, lastName: true, company: true, phones: true },
  });
  const contactByPhone = new Map<string, { name: string; company: string | null }>();
  for (const ct of contacts) {
    const display = [ct.firstName, ct.lastName].filter(Boolean).join(" ").trim() || ct.company;
    if (!display) continue;
    let nums: string[] = [];
    try { nums = ct.phones ? JSON.parse(ct.phones) : []; } catch { nums = []; }
    for (const n of nums) {
      const k = phoneKey(n);
      if (k.length === 10 && !contactByPhone.has(k)) contactByPhone.set(k, { name: display, company: ct.company });
    }
  }

  // Team members often appear in group threads (a photographer looped in, etc.).
  const team = await prisma.teamMember.findMany({
    where: { phone: { not: null } },
    select: { name: true, phone: true },
  });
  const teamByPhone = new Map<string, string>();
  for (const t of team) {
    const k = phoneKey(t.phone);
    if (k.length === 10) teamByPhone.set(k, t.name);
  }

  const nameFor = (ph: string) => {
    const k = phoneKey(ph);
    return clientByPhone.get(k)?.name || contactByPhone.get(k)?.name || teamByPhone.get(k) || fmtPhone(ph);
  };

  const DISPLAY_CAP = 150;
  const totalConversations = conversations.length;
  const rows = conversations
    .map((conv) => {
      const others = (conv.participants ?? []).filter((p) => !ourNumbers.has(phoneKey(p)));
      const isGroup = others.length > 1;
      const phone = others[0] ?? conv.participants?.[0] ?? "";
      const client = clientByPhone.get(phoneKey(phone));
      const contact = client ? undefined : contactByPhone.get(phoneKey(phone));
      const groupName = isGroup ? (conv.name || others.map(nameFor).join(", ")) : "";
      return { conv, phone, others, isGroup, groupName, client, contact };
    })
    .sort((a, b) => new Date(b.conv.lastActivityAt ?? 0).getTime() - new Date(a.conv.lastActivityAt ?? 0).getTime())
    .slice(0, DISPLAY_CAP);

  return (
    <div>
      <PageHeader
        title="Communications"
        subtitle={totalConversations > rows.length ? `${rows.length} most recent of ${totalConversations} conversations` : `${rows.length} conversations`}
        actions={<Badge soft="var(--surface-2)">Live from OpenPhone</Badge>}
      />
      <div className="p-6">
        <CommsTabs tab="inbox" pending={pendingTexts} />
        {error && <div className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
        {rows.length === 0 && !error ? (
          <p className="text-sm text-muted">No conversations found.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-surface">
            {rows.map(({ conv, phone, others, isGroup, groupName, client, contact }) => {
              const name = isGroup ? groupName : (client?.name || contact?.name || conv.name || fmtPhone(phone));
              const pParam = isGroup ? others.join(",") : phone;
              const href = `/communications/thread?pn=${encodeURIComponent(conv.phoneNumberId ?? "")}&p=${encodeURIComponent(pParam)}&name=${encodeURIComponent(name)}`;
              return (
                <Link key={conv.id} href={href} className="flex items-center gap-3 border-b px-5 py-3 last:border-0 hover:bg-surface-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                    {isGroup ? <Users className="size-4" /> : <MessageCircle className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{name}</span>
                      {isGroup ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-brand-soft px-1.5 text-[10px] font-medium text-brand">
                          <Users className="size-2.5" /> group · {others.length}
                        </span>
                      ) : client ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-success-soft px-1.5 text-[10px] font-medium text-success">
                          <User className="size-2.5" /> client
                        </span>
                      ) : contact ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-surface-2 px-1.5 text-[10px] font-medium text-muted">
                          <User className="size-2.5" /> contact
                        </span>
                      ) : null}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {isGroup ? `${others.length} people` : fmtPhone(phone)}
                      {!isGroup && contact?.company ? ` · ${contact.company}` : ""}
                    </div>
                  </div>
                  {conv.lastActivityAt && (
                    <span className="shrink-0 text-xs text-muted-2">
                      {formatDistanceToNow(new Date(conv.lastActivityAt), { addSuffix: true })}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
