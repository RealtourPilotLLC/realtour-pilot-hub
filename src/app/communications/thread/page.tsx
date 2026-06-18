import Link from "next/link";
import { ArrowLeft, Phone, PhoneIncoming, PhoneOutgoing, PhoneMissed } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { getSecret } from "@/lib/integrations/connections";
import { conversationThread, type ThreadItem } from "@/lib/integrations/openphone";
import { format } from "date-fns";

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
  const title = name || (p ? fmtPhone(p) : "Conversation");

  let items: ThreadItem[] = [];
  let error: string | null = null;
  if (!(await getSecret("openphone"))) {
    error = "OpenPhone is not connected.";
  } else if (pn && p) {
    try {
      items = await conversationThread(pn, p);
    } catch (e) {
      error = e instanceof Error ? e.message : "Could not load this conversation.";
    }
  } else {
    error = "Missing conversation details.";
  }

  return (
    <div>
      <PageHeader title={title} subtitle={p ? fmtPhone(p) : undefined} />
      <div className="mx-auto max-w-2xl p-6">
        <Link href="/communications" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" /> All communications
        </Link>

        {error && <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</div>}

        {!error && items.length === 0 && <p className="text-sm text-muted">No messages or calls in this conversation.</p>}

        <div className="space-y-3">
          {items.map((it) => {
            const outgoing = (it.direction || "").toLowerCase().startsWith("out");
            const when = it.at ? format(new Date(it.at), "MMM d, h:mm a") : "";
            if (it.kind === "message") {
              return (
                <div key={it.id} className={`flex ${outgoing ? "justify-end" : "justify-start"}`}>
                  <div className="max-w-[78%]">
                    <div
                      className={`rounded-2xl px-4 py-2 text-sm ${
                        outgoing ? "rounded-br-sm bg-brand text-brand-fg" : "rounded-bl-sm border bg-surface"
                      }`}
                    >
                      {it.text || <span className="italic opacity-70">(no text)</span>}
                    </div>
                    <div className={`mt-0.5 text-[11px] text-muted-2 ${outgoing ? "text-right" : ""}`}>{when}</div>
                  </div>
                </div>
              );
            }
            // call entry
            const missed = (it.status || "").toLowerCase().includes("missed") || (it.status || "").toLowerCase() === "no-answer";
            const Icon = missed ? PhoneMissed : outgoing ? PhoneOutgoing : PhoneIncoming;
            const mins = it.duration ? `${Math.floor(it.duration / 60)}m ${it.duration % 60}s` : null;
            return (
              <div key={it.id} className="flex justify-center">
                <div className="inline-flex items-center gap-2 rounded-full border bg-surface px-3 py-1.5 text-xs text-muted">
                  <Icon className={`size-3.5 ${missed ? "text-danger" : "text-muted"}`} />
                  <span className="font-medium text-foreground/80">{outgoing ? "Outgoing" : "Incoming"} call</span>
                  {mins && <span>· {mins}</span>}
                  {it.status && <span>· {it.status}</span>}
                  <span className="text-muted-2">· {when}</span>
                </div>
              </div>
            );
          })}
        </div>

        {items.length > 0 && (
          <p className="mt-6 flex items-center justify-center gap-1 text-xs text-muted-2">
            <Phone className="size-3" /> Live from OpenPhone · newest first
          </p>
        )}
      </div>
    </div>
  );
}
