"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Loader2, MessageSquare, User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ChatPanel, type ChatItem, type ConvoClient, type ChatMember } from "@/components/comms/ConversationView";
import { loadClientThread, loadClientGroupThreads, loadThreadItems, type ClientThread } from "@/app/communications/threadActions";

// Embeds the texting chat on the client detail page. Phase 1 paints the direct
// 1:1 line instantly; phase 2 scans recent OpenPhone conversations in the
// background and adds a switcher for any GROUP threads the client (or a folded
// teammate, e.g. Kelly on Jamie's team) is part of.
export function ClientChat({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [client, setClient] = useState<ConvoClient>(null);
  const [threads, setThreads] = useState<ClientThread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loadingItems, startItems] = useTransition();
  const directSeeded = useRef(false); // direct items already loaded in phase 1

  const selected = threads.find((t) => t.id === selectedId) ?? null;

  // Phase 1 — the direct line (fast: one thread fetch).
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await loadClientThread(clientId);
      if (!alive) return;
      if (r.ok && r.toPhone) {
        setClient(r.client ?? null);
        setThreads([{ id: "direct", participants: [r.toPhone], isGroup: false, label: clientName, members: [], lastActivityAt: null }]);
        setItems(r.items ?? []);
        directSeeded.current = true;
        setSelectedId("direct");
        setState("ready");
      } else {
        setError(r.message);
        setState("error");
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Phase 2 — group threads (slower scan), appended once ready.
  useEffect(() => {
    if (state !== "ready") return;
    let alive = true;
    (async () => {
      const r = await loadClientGroupThreads(clientId);
      if (!alive || !r.ok || !r.threads?.length) return;
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...r.threads!.filter((t) => !seen.has(t.id))];
      });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, clientId]);

  // Load messages when the selected thread changes (direct already seeded once).
  useEffect(() => {
    if (!selected) return;
    if (selected.id === "direct" && directSeeded.current) { directSeeded.current = false; return; }
    let alive = true;
    startItems(async () => {
      const r = await loadThreadItems(selected.participants.join(","));
      if (alive) setItems(r.ok && r.items ? r.items : []);
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  if (state !== "ready" || !selected) {
    return (
      <div className="flex h-[200px] items-center justify-center rounded-2xl border bg-surface text-sm text-muted">
        {state === "loading" ? (
          <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading conversation…</span>
        ) : (
          <span className="inline-flex items-center gap-2"><MessageSquare className="size-4" /> {error}</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Switcher — direct line + each group thread the client/team is in */}
      {threads.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors",
                t.id === selectedId
                  ? "border-brand/40 bg-brand-soft text-brand"
                  : "border-border text-muted hover:bg-surface-2 hover:text-foreground",
              )}
              title={t.isGroup ? `Group: ${t.members.map((m) => m.name).join(", ")}` : `Text ${t.label} directly`}
            >
              {t.isGroup ? <Users className="size-3.5" /> : <User className="size-3.5" />}
              <span className="max-w-[200px] truncate">{t.isGroup ? `Group · ${t.label}` : t.label}</span>
            </button>
          ))}
        </div>
      )}

      {loadingItems ? (
        <div className="flex h-[560px] items-center justify-center rounded-2xl border bg-surface text-sm text-muted">
          <span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Loading messages…</span>
        </div>
      ) : (
        <ChatPanel
          key={selected.id}
          toPhone={selected.participants.join(",")}
          title={selected.isGroup ? selected.label : clientName}
          items={items}
          client={client}
          members={selected.isGroup ? selected.members : undefined}
          heightClass="h-[560px]"
        />
      )}
    </div>
  );
}
