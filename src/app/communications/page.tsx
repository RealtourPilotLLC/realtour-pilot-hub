import Link from "next/link";
import { MessageCircle, Phone, User, Users } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import { OpenPhone, phoneKey, recentOpenPhoneConversations, type OpConversation } from "@/lib/integrations/openphone";
import { formatDistanceToNow } from "date-fns";

export const dynamic = "force-dynamic";

function fmtPhone(p: string) {
  const d = p.replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p;
}

export default async function CommunicationsPage() {
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
