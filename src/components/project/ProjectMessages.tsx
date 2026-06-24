"use client";

import { useRef, useState, useTransition } from "react";
import { Send, Reply, X } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { postProjectMessage } from "@/app/projects/messageActions";

export type ProjectMsg = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string; // ISO
  ago: string;
  replyTo?: { authorName: string | null; body: string } | null;
};

type Member = { id: string; name: string; avatarColor: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Render a message body with @mentions of teammates highlighted.
function renderBody(text: string, team: Member[]) {
  const names = team.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const re = new RegExp(`@(${names.map(escapeRe).join("|")})`, "g");
  const out: React.ReactNode[] = [];
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={i++} className="rounded bg-brand-soft px-1 font-medium text-brand">@{m[1]}</span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Team chat thread on a project — editors/Kyle/photographers coordinate here.
// Type "@" to tag a teammate (they get a to-do). Compact variant for the editor
// queue hides the heading + trims height.
export function ProjectMessages({
  projectId,
  messages,
  team,
  compact = false,
}: {
  projectId: string;
  messages: ProjectMsg[];
  team: Member[];
  compact?: boolean;
}) {
  const [body, setBody] = useState("");
  const [authorId, setAuthorId] = useState<string>(team[0]?.id ?? "");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string | null; body: string } | null>(null);
  const [pending, start] = useTransition();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const colorFor = (id: string | null) => team.find((m) => m.id === id)?.avatarColor ?? "#64748b";

  const suggestions =
    mentionQuery === null
      ? []
      : team.filter((m) => m.name.toLowerCase().includes(mentionQuery)).slice(0, 6);

  function onChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setBody(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/@([\p{L}\d]*)$/u);
    setMentionQuery(m ? m[1].toLowerCase() : null);
  }

  function pickMention(member: Member) {
    const ta = taRef.current;
    const caret = ta?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/@([\p{L}\d]*)$/u, `@${member.name} `);
    const next = before + body.slice(caret);
    setBody(next);
    setMentionQuery(null);
    requestAnimationFrame(() => { ta?.focus(); const pos = before.length; ta?.setSelectionRange(pos, pos); });
  }

  function submit() {
    const text = body.trim();
    if (!text) return;
    // Resolve @mentions to team ids by name match.
    const mentionIds = team.filter((m) => text.includes(`@${m.name}`)).map((m) => m.id);
    start(async () => {
      const r = await postProjectMessage(projectId, authorId || null, text, mentionIds, replyTo?.id ?? null);
      if (r.ok) { setBody(""); setReplyTo(null); }
    });
  }
  const taFocus = () => requestAnimationFrame(() => taRef.current?.focus());

  return (
    <div className={compact ? "" : "rounded-2xl border bg-surface"}>
      {!compact && (
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">Team messages</h2>
          <p className="text-[11px] text-muted-2">Notes for editors &amp; the crew on this job — not sent to the client. Type @ to tag someone.</p>
        </div>
      )}
      <div className={cn("space-y-3", compact ? "max-h-44 overflow-y-auto pb-2" : "px-5 py-4")}>
        {messages.length === 0 && (
          <p className="text-xs text-muted">No messages yet. Start the thread below.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="group flex gap-2.5">
            <Avatar name={m.authorName ?? "Team"} size={26} color={colorFor(m.authorId)} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold">{m.authorName ?? "Team"}</span>
                <span className="text-[10px] text-muted-2">{m.ago}</span>
                <button
                  type="button"
                  onClick={() => { setReplyTo({ id: m.id, authorName: m.authorName, body: m.body }); taFocus(); }}
                  className="ml-auto inline-flex items-center gap-0.5 text-[10px] text-muted-2 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                >
                  <Reply className="size-3" /> Reply
                </button>
              </div>
              {m.replyTo && (
                <div className="mt-0.5 border-l-2 border-border pl-2 text-[11px] text-muted-2">
                  <span className="font-medium">{m.replyTo.authorName ?? "Team"}</span>: {m.replyTo.body.replace(/\s+/g, " ").slice(0, 100)}
                </div>
              )}
              <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{renderBody(m.body, team)}</p>
            </div>
          </div>
        ))}
      </div>

      <div className={cn(compact ? "mt-2" : "border-t px-5 py-3")}>
        {replyTo && (
          <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1.5 text-[11px] text-muted">
            <Reply className="size-3 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate">
              Replying to <span className="font-medium">{replyTo.authorName ?? "Team"}</span>: {replyTo.body.replace(/\s+/g, " ").slice(0, 80)}
            </span>
            <button type="button" onClick={() => setReplyTo(null)} className="shrink-0 text-muted-2 hover:text-foreground"><X className="size-3.5" /></button>
          </div>
        )}
        <div className="relative">
          <textarea
            ref={taRef}
            value={body}
            onChange={onChange}
            onKeyDown={(e) => { if (e.key === "Escape") setMentionQuery(null); }}
            rows={2}
            placeholder="Leave a note for the team… (@ to tag)"
            className="w-full resize-none rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-brand"
          />
          {suggestions.length > 0 && (
            <ul className="absolute bottom-full left-0 z-[1200] mb-1 max-h-44 w-56 overflow-auto rounded-lg border border-border bg-surface py-1 shadow-lg">
              {suggestions.map((m) => (
                <li key={m.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
                  >
                    <Avatar name={m.name} size={20} color={m.avatarColor} /> {m.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          {team.length > 0 && (
            <select
              value={authorId}
              onChange={(e) => setAuthorId(e.target.value)}
              title="Posting as"
              className="rounded-lg border border-border bg-surface-2 px-2 py-1.5 text-xs outline-none focus:border-brand"
            >
              {team.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          )}
          <button
            disabled={pending || !body.trim()}
            onClick={submit}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            <Send className="size-4" /> {pending ? "Posting…" : "Post"}
          </button>
        </div>
      </div>
    </div>
  );
}
