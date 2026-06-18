import Link from "next/link";
import { MessageCircle, Phone, User } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Avatar } from "@/components/ui/Avatar";
import { prisma } from "@/lib/prisma";
import { getSecret } from "@/lib/integrations/connections";
import { OpenPhone, phoneKey, type OpConversation } from "@/lib/integrations/openphone";
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
    const [convRes, phones] = await Promise.all([
      OpenPhone.conversations({ maxResults: 40 }),
      OpenPhone.phoneNumbers(),
    ]);
    conversations = convRes.data ?? [];
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

  const rows = conversations
    .map((conv) => {
      const others = (conv.participants ?? []).filter((p) => !ourNumbers.has(phoneKey(p)));
      const phone = others[0] ?? conv.participants?.[0] ?? "";
      const client = clientByPhone.get(phoneKey(phone));
      return { conv, phone, client };
    })
    .sort((a, b) => new Date(b.conv.lastActivityAt ?? 0).getTime() - new Date(a.conv.lastActivityAt ?? 0).getTime());

  return (
    <div>
      <PageHeader
        title="Communications"
        subtitle={`${rows.length} recent conversations`}
        actions={<Badge soft="var(--surface-2)">Live from OpenPhone</Badge>}
      />
      <div className="p-6">
        {error && <div className="mb-4 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}
        {rows.length === 0 && !error ? (
          <p className="text-sm text-muted">No conversations found.</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border bg-surface">
            {rows.map(({ conv, phone, client }) => {
              const name = client?.name || conv.name || fmtPhone(phone);
              const href = `/communications/thread?pn=${encodeURIComponent(conv.phoneNumberId ?? "")}&p=${encodeURIComponent(phone)}&name=${encodeURIComponent(name)}`;
              return (
                <Link key={conv.id} href={href} className="flex items-center gap-3 border-b px-5 py-3 last:border-0 hover:bg-surface-2">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                    <MessageCircle className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{name}</span>
                      {client && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-success-soft px-1.5 text-[10px] font-medium text-success">
                          <User className="size-2.5" /> client
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted">{fmtPhone(phone)}</div>
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
