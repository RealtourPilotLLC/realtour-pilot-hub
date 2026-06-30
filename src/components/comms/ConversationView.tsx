"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Send, Paperclip, Sparkles, Loader2, Phone, PhoneMissed, X, Building2, Mail, Image as ImageIcon,
  Camera, Activity as ActivityIcon, User, Users,
} from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { SegmentBadge } from "@/components/clients/SegmentBadge";
import { SocialBadge } from "@/components/clients/SocialBadge";
import { stageMeta } from "@/lib/pipeline";
import { cn, stripHtml } from "@/lib/utils";
import { sendThreadText, draftThreadReply, uploadCommAttachment } from "@/app/communications/threadActions";

export type ChatItem = {
  kind: "message" | "call";
  id: string;
  at: string;
  direction?: string;
  text?: string;
  duration?: number;
  status?: string;
  media?: string[];
  from?: string;
};
export type ChatMember = { phone: string; key: string; name: string; clientId: string | null; segment: string | null; socialClient: boolean; socialPlan: string | null };
function phoneKey10(p?: string) { return (p || "").replace(/\D/g, "").slice(-10); }
export type ConvoClient = {
  id: string; name: string; phone: string | null; email: string | null; backupEmail: string | null;
  company: string | null; segment: string | null; socialClient: boolean; socialPlan: string | null;
} | null;
export type ConvoProject = { id: string; title: string; status: string; shootDate: string | null; price: number | null };
export type ConvoActivity = { id: string; body: string; createdAt: string; type: string; projectTitle: string | null };

function fmtTime(iso: string): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
function isOut(d?: string) { return (d || "").toLowerCase().startsWith("out"); }

// The reusable chat box (header + bottom-up messages + composer). Used on both
// the Communications page and embedded on the client detail page.
export function ChatPanel({
  toPhone, title, items, client, members, heightClass = "h-[calc(100vh-9rem)]",
}: {
  toPhone: string; title: string; items: ChatItem[]; client: ConvoClient; members?: ChatMember[]; heightClass?: string;
}) {
  const isGroup = !!members && members.length > 1;
  const nameByKey = new Map((members ?? []).map((m) => [m.key, m.name]));
  const [msgs, setMsgs] = useState<ChatItem[]>(items);
  const [body, setBody] = useState("");
  const [attach, setAttach] = useState<{ url: string; name: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sending, startSend] = useTransition();
  const [drafting, startDraft] = useTransition();
  const [uploading, startUpload] = useTransition();
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setMsgs(items); }, [items]);
  // Auto-scroll to the newest message (bottom), like a normal texting app.
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [msgs.length]);

  const hasInbound = msgs.some((m) => m.kind === "message" && !isOut(m.direction) && m.text);

  function send() {
    const text = body.trim();
    if (!text && !attach) return;
    startSend(async () => {
      const r = await sendThreadText(toPhone, text, attach ? [attach.url] : undefined, client?.id ?? null);
      setNote(r.ok ? null : r.message);
      if (r.ok) {
        setMsgs((m) => [...m, {
          kind: "message", id: `local-${Date.now()}`, at: new Date().toISOString(),
          direction: "outgoing", text, media: attach ? [attach.url] : undefined,
        }]);
        setBody(""); setAttach(null);
      }
    });
  }

  return (
    <div className={cn("flex flex-col overflow-hidden rounded-2xl border bg-surface", heightClass)}>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        {isGroup ? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand"><Users className="size-4" /></span>
        ) : (
          <Avatar name={client?.name ?? title} size={32} color="#4f46e5" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{isGroup ? `Group · ${members!.length} people` : (client?.name ?? title)}</span>
            {!isGroup && <SegmentBadge segment={client?.segment} size="xs" />}
            {!isGroup && <SocialBadge socialClient={client?.socialClient} socialPlan={client?.socialPlan} size="xs" />}
          </div>
          <div className="truncate text-[11px] text-muted-2">{isGroup ? members!.map((m) => m.name).join(", ") : title}</div>
        </div>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto scroll-thin px-4 py-4">
        {msgs.length === 0 && <p className="text-center text-sm text-muted">No messages yet.</p>}
        {msgs.map((it) => {
          const out = isOut(it.direction);
          if (it.kind === "call") {
            const missed = /missed|no-answer|declined/i.test(it.status || "");
            return (
              <div key={it.id} className="flex justify-center">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">
                  {missed ? <PhoneMissed className="size-3 text-danger" /> : <Phone className="size-3" />}
                  {out ? "Outgoing" : "Incoming"} call{it.duration ? ` · ${Math.round(it.duration / 60)}m` : ""} · {fmtTime(it.at)}
                </span>
              </div>
            );
          }
          const senderName = isGroup && !out ? (nameByKey.get(phoneKey10(it.from)) ?? null) : null;
          return (
            <div key={it.id} className={cn("flex", out ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm", out ? "rounded-br-sm bg-brand text-white" : "rounded-bl-sm bg-surface-2 text-foreground")}>
                {senderName && <div className="mb-0.5 text-[11px] font-semibold text-brand">{senderName}</div>}
                {it.media?.map((m, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={i} src={m} alt="attachment" className="mb-1 max-h-52 rounded-lg object-cover" />
                ))}
                {it.text && <p className="whitespace-pre-wrap">{it.text}</p>}
                <div className={cn("mt-1 text-[10px]", out ? "text-white/70" : "text-muted-2")}>{fmtTime(it.at)}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="border-t border-border px-3 py-2.5">
        {attach && (
          <div className="mb-2 inline-flex items-center gap-2 rounded-lg bg-surface-2 px-2 py-1 text-xs">
            <ImageIcon className="size-3.5 text-brand" /> <span className="max-w-[180px] truncate">{attach.name}</span>
            <button onClick={() => setAttach(null)} className="text-muted-2 hover:text-foreground"><X className="size-3.5" /></button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => {
            const f = e.target.files?.[0]; if (!f) return;
            const fd = new FormData(); fd.append("file", f);
            startUpload(async () => { const r = await uploadCommAttachment(fd); if (r.ok && r.url) setAttach({ url: r.url, name: r.name ?? "image" }); else setNote(r.message); });
            e.target.value = "";
          }} />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} title="Attach a photo"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50">
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
          </button>
          <textarea
            value={body} onChange={(e) => setBody(e.target.value)} rows={1}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
            placeholder="Type a message…"
            className="max-h-32 min-h-[36px] flex-1 resize-none rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          <button onClick={() => startDraft(async () => {
            const transcript = msgs.map((m) => ({ kind: m.kind, direction: m.direction, text: m.text, at: m.at, from: m.from }));
            const memberNames = isGroup ? Object.fromEntries((members ?? []).map((m) => [m.key, m.name])) : undefined;
            const r = await draftThreadReply(client?.id ?? null, client?.name ?? null, transcript, { isGroup, memberNames });
            if (r.draft) setBody(r.draft); else setNote(r.message);
          })} disabled={drafting || !hasInbound} title="AI draft a reply"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-surface-2 disabled:opacity-50">
            {drafting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4 text-brand" />}
          </button>
          <button onClick={send} disabled={sending || (!body.trim() && !attach)} aria-label="Send"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white disabled:opacity-50">
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        </div>
        {note && <p className="mt-1.5 text-[11px] text-danger">{note}</p>}
        <p className="mt-1 text-[10px] text-muted-2">Review before sending — nothing auto-sends. ⌘/Ctrl+Enter to send.</p>
      </div>
    </div>
  );
}

// Full Communications conversation page: chat + a Details/Activity sidebar.
export function ConversationView({
  toPhone, title, items, client, projects, activities, members,
}: {
  toPhone: string; title: string; items: ChatItem[];
  client: ConvoClient; projects: ConvoProject[]; activities: ConvoActivity[]; members?: ChatMember[];
}) {
  const [tab, setTab] = useState<"details" | "activity">("details");
  const isGroup = !!members && members.length > 1;
  return (
    <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[1fr_340px]">
      <ChatPanel toPhone={toPhone} title={title} items={items} client={client} members={members} />
      <div className="space-y-4">
        <div className="rounded-2xl border bg-surface">
          <div className="flex border-b border-border text-sm">
            <TabBtn active={tab === "details"} onClick={() => setTab("details")} icon={isGroup ? <Users className="size-4" /> : <User className="size-4" />} label={isGroup ? "Members" : "Details"} />
            {!isGroup && <TabBtn active={tab === "activity"} onClick={() => setTab("activity")} icon={<ActivityIcon className="size-4" />} label="Activity" />}
          </div>
          <div className="p-4">
            {isGroup ? (
              <div className="space-y-2">
                {members!.map((m) => (
                  <div key={m.key} className="flex items-center gap-2">
                    <Avatar name={m.name} size={26} color="#4f46e5" />
                    <div className="min-w-0 flex-1">
                      {m.clientId ? <Link href={`/clients/${m.clientId}`} className="truncate text-sm font-medium hover:text-brand">{m.name}</Link> : <span className="truncate text-sm font-medium">{m.name}</span>}
                    </div>
                    <SegmentBadge segment={m.segment} size="xs" />
                    <SocialBadge socialClient={m.socialClient} socialPlan={m.socialPlan} size="xs" />
                  </div>
                ))}
              </div>
            ) : tab === "details" ? (
              client ? (
                <div className="space-y-3 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Link href={`/clients/${client.id}`} className="font-semibold hover:text-brand">{client.name}</Link>
                    <SegmentBadge segment={client.segment} size="xs" />
                    <SocialBadge socialClient={client.socialClient} socialPlan={client.socialPlan} size="xs" />
                  </div>
                  <div className="space-y-1 text-xs text-muted">
                    {client.company && <div className="flex items-center gap-1.5"><Building2 className="size-3.5" /> {client.company}</div>}
                    {client.email && <div className="flex items-center gap-1.5"><Mail className="size-3.5" /> {client.email}</div>}
                    {client.phone && <div className="flex items-center gap-1.5"><Phone className="size-3.5" /> {client.phone}</div>}
                  </div>
                  <div>
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2">Recent projects</div>
                    <div className="space-y-1.5">
                      {projects.length === 0 && <p className="text-xs text-muted">No projects.</p>}
                      {projects.map((p) => {
                        const s = stageMeta(p.status as never);
                        return (
                          <Link key={p.id} href={`/projects/${p.id}`} className="flex items-center gap-2 rounded-lg border bg-surface-2/50 px-2 py-1.5 hover:bg-surface-2">
                            <Camera className="size-3.5 shrink-0 text-muted-2" />
                            <span className="min-w-0 flex-1 truncate text-xs">{p.title}</span>
                            <Badge color={s.color} soft={s.soft} className="px-1.5 py-0 text-[10px]">{s.short}</Badge>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-muted">Unknown number — not matched to a client yet.</p>
              )
            ) : (
              <div className="space-y-2.5">
                {activities.length === 0 && <p className="text-sm text-muted">No recent activity.</p>}
                {activities.map((a) => (
                  <div key={a.id} className="border-b border-border pb-2 last:border-0">
                    <p className="text-xs text-foreground/90">{stripHtml(a.body)}</p>
                    <div className="mt-0.5 text-[10px] text-muted-2">{fmtTime(a.createdAt)}{a.projectTitle ? ` · ${a.projectTitle}` : ""}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={cn("flex flex-1 items-center justify-center gap-1.5 px-4 py-2.5 font-medium", active ? "border-b-2 border-brand text-foreground" : "text-muted hover:text-foreground")}>
      {icon} {label}
    </button>
  );
}
