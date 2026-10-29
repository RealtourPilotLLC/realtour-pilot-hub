"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Send, Reply, X, Archive, ArchiveRestore, Loader2, Paperclip, Link2, FileText, Search, ExternalLink, Lock, ChevronRight } from "lucide-react";
import { upload } from "@vercel/blob/client";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import { closeConversation, markProjectMessagesRead, postProjectMessage, reopenConversation } from "@/app/projects/messageActions";
import { checkHubPage, markTeamChannelRead, messageUploadStart, postTeamChannelMessage, searchHubPages } from "@/app/projects/teamChannelActions";
import { AutoTextarea } from "@/components/ui/AutoTextarea";
import { messageToRevision, type ApprovedRevisionTarget } from "@/app/review/staffRevisionActions";
import {
  MESSAGE_FILE_ACCEPT,
  MESSAGE_FILES_PER_MESSAGE,
  conversationKey,
  fmtFileSize,
  isMessageImage,
  messageFileRefusal,
  messageFileType,
  safeMessageFileName,
  type ConversationRef,
} from "@/lib/messageFiles";
import { MAX_LINKS_PER_MESSAGE, type HubLinkRef, type HubLinkView } from "@/lib/hubLinks";

/** A file on a message as the board draws it (lib/messageAttachments). */
export type ProjectMsgFile = { id: string; name: string; size: number; image: boolean; href: string };

export type ProjectMsg = {
  id: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string; // ISO
  ago: string;
  replyTo?: { authorName: string | null; body: string } | null;
  /** Photos and files (Oct 28 2026). */
  files?: ProjectMsgFile[];
  /** Hub pages, as THIS viewer may open them (href null: they can't). */
  links?: HubLinkView[];
  /** Older than ten ET days: folds (decided on the server, lib/messageExtras). */
  old?: boolean;
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
// queue and the photographer's shoot screen hides the heading + trims height.
// Deep links (Sep 16): the board is id="messages" and every message is
// id="msg-<id>", so a Slack DM / text / bell link opens the page scrolled to
// the words that rang (the :target row is tinted). readOnly hides the
// composer for look-don't-touch views ("view as" previews).
//
// Oct 28 2026 (Jordan): the same board draws THE TEAM CHANNEL
// (TeamChannelMessages below: every login on the team), and every message can
// carry photos and files ("allow message attachments (files or photos)": picked,
// pasted or dropped, uploaded straight to the private store) and hub pages
// ("Link a hub page": only pages everyone in the conversation can open). And
// messages older than ten days fold under one line ("any communications older
// than 10 days should be collapsed ... you have to scroll a lot to get to the
// bottom of the page"); the newest message always stays open, and a recent
// reply to an old message stays visible with its quote.
type ProjectMessagesProps = {
  projectId: string;
  messages: ProjectMsg[];
  team: Member[];
  compact?: boolean;
  readOnly?: boolean;
  canRequestRevision?: boolean;
};

export function ProjectMessages(props: ProjectMessagesProps) {
  // A conversation switch is a new reading visit. A same-project refresh is
  // not: it must not silently acknowledge a message that arrived after open.
  const { projectId, ...rest } = props;
  return <MessageBoard key={projectId} conv={{ kind: "project", projectId }} {...rest} />;
}

/** The team channel's board (Oct 28 2026). */
export function TeamChannelMessages(props: { messages: ProjectMsg[]; team: Member[]; readOnly?: boolean }) {
  return <MessageBoard key="team" conv={{ kind: "team" }} {...props} />;
}

type PendingFile = {
  key: string;
  name: string;
  size: number;
  image: boolean;
  preview: string | null;
  state: "uploading" | "done" | "error";
  pct: number;
  pathname?: string;
  error?: string;
};
type PendingLink = HubLinkRef & { href: string };
type SearchResult = Awaited<ReturnType<typeof searchHubPages>>;

function MessageBoard({
  conv,
  messages,
  team,
  compact = false,
  readOnly = false,
  canRequestRevision = false,
}: Omit<ProjectMessagesProps, "projectId"> & { conv: ConversationRef }) {
  const projectId = conv.kind === "project" ? conv.projectId : null;
  const convKey = conversationKey(conv);
  const [body, setBody] = useState("");
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<{ id: string; authorName: string | null; body: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [links, setLinks] = useState<PendingLink[]>([]);
  const [picker, setPicker] = useState(false);
  const [dragging, setDragging] = useState(false);
  // Oct 14 2026: one click sends a message's words to the editor as a revision
  // (the approved video reopens); several videos → pick one. No form.
  const [revision, setRevision] = useState<{ messageId: string; busy: boolean; text: string | null; ok: boolean; choices: ApprovedRevisionTarget[] } | null>(null);
  const sendRevision = (messageId: string, submissionId?: string) => {
    if (!projectId) return;
    setRevision({ messageId, busy: true, text: null, ok: false, choices: [] });
    void messageToRevision(projectId, messageId, submissionId ?? null)
      .then((r) => setRevision({ messageId, busy: false, text: r.message, ok: r.ok, choices: r.choices ?? [] }))
      .catch(() => setRevision({ messageId, busy: false, text: "That didn't go through. Try again.", ok: false, choices: [] }));
  };
  const [pending, start] = useTransition();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const [lastMessageId] = useState(() => messages.at(-1)?.id ?? null);
  const markRead = (id: string) => (projectId ? markProjectMessagesRead(projectId, id) : markTeamChannelRead(id));

  // THE TEN-DAY FOLD: every old message but the newest one in the thread.
  const newestId = messages.at(-1)?.id ?? null;
  const folded = messages.filter((m) => m.old && m.id !== newestId);
  const open = messages.filter((m) => !(m.old && m.id !== newestId));
  const [foldOpen, setFoldOpen] = useState(false);
  useEffect(() => {
    // A link to an old message (#msg-<id>, from a bell row or a DM) opens the fold first.
    const reveal = () => {
      const h = window.location.hash.slice(1);
      if (!h.startsWith("msg-") || !folded.some((m) => `msg-${m.id}` === h)) return;
      setFoldOpen(true);
      requestAnimationFrame(() => document.getElementById(h)?.scrollIntoView({ block: "center" }));
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folded.length]);

  useEffect(() => {
    if (readOnly || !lastMessageId || !lastMessageRef.current) return;
    // A brief can be several screens long. Reading its header or downloading
    // footage does not read this conversation. Only the loaded last message
    // entering the viewport advances the bounded watermark.
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void markRead(lastMessageId)
        .then((r) => { if (!r.ok) setReadError(r.message); else setReadError(null); })
        .catch(() => setReadError("Could not save read state. Try again."));
    }, { rootMargin: "0px 0px -80px 0px", threshold: 0.1 });
    observer.observe(lastMessageRef.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convKey, lastMessageId, readOnly]);
  // Photo previews are object URLs; give them back when the board goes away.
  const filesRef = useRef(files);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => () => { for (const f of filesRef.current) if (f.preview) URL.revokeObjectURL(f.preview); }, []);
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

  // ---- files: picked, pasted or dropped; each uploads the moment it's added ----
  const patchFile = (key: string, patch: Partial<PendingFile>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  async function addFiles(list: File[]) {
    if (list.length === 0) return;
    setError(null);
    const room = MESSAGE_FILES_PER_MESSAGE - files.length;
    if (room <= 0) { setError(`Send up to ${MESSAGE_FILES_PER_MESSAGE} files on one message.`); return; }
    if (list.length > room) setError(`Only the first ${room} were added. Send up to ${MESSAGE_FILES_PER_MESSAGE} files on one message.`);
    const take = list.slice(0, room);
    const started = await messageUploadStart(convKey).catch(() => ({ ok: false as const, message: "Files can't be sent right now. Try again." }));
    const rows: (PendingFile & { file: File })[] = take.map((file) => {
      const type = messageFileType(file.name, file.type);
      const refusal = !started.ok ? started.message : messageFileRefusal({ name: file.name, size: file.size, type: file.type });
      const image = isMessageImage(type);
      return {
        file,
        key: Math.random().toString(36).slice(2, 12),
        name: file.name || "file",
        size: file.size,
        image,
        preview: image && !refusal ? URL.createObjectURL(file) : null,
        state: refusal ? "error" : "uploading",
        pct: 0,
        ...(refusal ? { error: refusal } : {}),
      };
    });
    setFiles((cur) => [...cur, ...rows.map(({ file: _f, ...r }) => r)]); // eslint-disable-line @typescript-eslint/no-unused-vars
    if (!started.ok) return;
    for (const r of rows) {
      if (r.state !== "uploading") continue;
      const type = messageFileType(r.file.name, r.file.type) ?? "application/octet-stream";
      const pathname = `${started.prefix}${r.key}/${safeMessageFileName(r.file.name || "file")}`;
      void upload(pathname, r.file, {
        access: "private",
        handleUploadUrl: "/api/messages/upload",
        clientPayload: JSON.stringify({ conversation: convKey }),
        contentType: type,
        multipart: r.file.size > 8 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => patchFile(r.key, { pct: percentage }),
      })
        .then((blob) => patchFile(r.key, { state: "done", pct: 100, pathname: blob.pathname }))
        .catch((e: unknown) => patchFile(r.key, { state: "error", error: e instanceof Error && e.message ? e.message : "That didn't upload. Remove it and try again." }));
    }
  }
  function removeFile(key: string) {
    setFiles((list) => {
      const f = list.find((x) => x.key === key);
      if (f?.preview) URL.revokeObjectURL(f.preview);
      return list.filter((x) => x.key !== key);
    });
  }
  const uploading = files.some((f) => f.state === "uploading");
  const readyFiles = files.filter((f) => f.state === "done" && f.pathname);

  function submit() {
    const text = body.trim();
    if (!text && readyFiles.length === 0 && links.length === 0) return;
    if (uploading) { setError("Wait for the files to finish uploading."); return; }
    if (files.some((f) => f.state === "error")) { setError("Remove the files that didn't upload, then post."); return; }
    // Resolve @mentions to team ids by name match.
    const mentionIds = team.filter((m) => text.includes(`@${m.name}`)).map((m) => m.id);
    const extras = {
      files: readyFiles.map((f) => ({ pathname: f.pathname as string, name: f.name })),
      links: links.map((l) => ({ kind: l.kind, id: l.id, cut: l.cut ?? null })),
    };
    start(async () => {
      // Author = the logged-in person, derived server-side from the session.
      try {
        const r = projectId
          ? await postProjectMessage(projectId, null, text, mentionIds, replyTo?.id ?? null, extras)
          : await postTeamChannelMessage(text, mentionIds, replyTo?.id ?? null, extras);
        if (r.ok) {
          setBody(""); setReplyTo(null); setError(null); setLinks([]); setPicker(false);
          setFiles((list) => { for (const f of list) if (f.preview) URL.revokeObjectURL(f.preview); return []; });
        } else setError(r.message);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn’t post that.");
      }
    });
  }
  const taFocus = () => requestAnimationFrame(() => taRef.current?.focus());
  const canPost = !!body.trim() || readyFiles.length > 0 || links.length > 0;

  const renderMsg = (m: ProjectMsg) => (
    <div
      key={m.id}
      ref={m.id === lastMessageId ? lastMessageRef : undefined}
      id={`msg-${m.id}`}
      className="group -mx-2 flex gap-2.5 rounded-lg px-2 py-1 scroll-mt-24 target:bg-brand-soft/60 target:ring-1 target:ring-brand/30"
    >
      <Avatar name={m.authorName ?? "Team"} size={26} color={colorFor(m.authorId)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-semibold">{m.authorName ?? "Team"}</span>
          <span className="shrink-0 text-[10px] text-muted-2">{m.ago}</span>
          {!readOnly && (
            <button
              type="button"
              onClick={() => { setReplyTo({ id: m.id, authorName: m.authorName, body: m.body }); taFocus(); }}
              className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-2 transition-opacity hover:text-foreground focus-visible:opacity-100 pointer-coarse:min-h-9 pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100"
            >
              <Reply className="size-3" /> Reply
            </button>
          )}
        </div>
        {m.replyTo && (
          <div className="mt-0.5 border-l-2 border-border pl-2 text-[11px] text-muted-2">
            <span className="font-medium">{m.replyTo.authorName ?? "Team"}</span>: {(m.replyTo.body || "a file").replace(/\s+/g, " ").slice(0, 100)}
          </div>
        )}
        {m.body && <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">{renderBody(m.body, team)}</p>}
        <MessageAttachments files={m.files ?? []} links={m.links ?? []} />
        {canRequestRevision && projectId && !readOnly && m.body && (
          <div className="mt-1.5 space-y-1.5">
            <button type="button" disabled={revision?.messageId === m.id && revision.busy} onClick={() => sendRevision(m.id)} className="inline-flex min-h-9 items-center gap-1 text-[11px] font-medium text-brand hover:underline disabled:opacity-60">
              {revision?.messageId === m.id && revision.busy && <Loader2 className="size-3 animate-spin" />} Send to the editor as a revision
            </button>
            {revision?.messageId === m.id && revision.text && (
              <p role="status" className={cn("text-[11px]", revision.ok ? "text-success" : "text-muted")}>{revision.text}</p>
            )}
            {revision?.messageId === m.id && revision.choices.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {revision.choices.map((c) => (
                  <button key={c.submissionId} type="button" onClick={() => sendRevision(m.id, c.submissionId)} className="min-h-9 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-surface-2">{c.label} (v{c.round})</button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div id="messages" className={cn("scroll-mt-24", compact ? "" : "rounded-2xl border bg-surface")}>
      {!compact && (
        <div className="border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">{projectId ? "Team messages" : "Team channel"}</h2>
          <p className="text-[11px] text-muted-2">
            {projectId
              ? <>Notes for editors &amp; the crew on this job — not sent to the client. Type @ to tag someone.</>
              : <>Everyone on the team reads this. Type @ to tag someone; only the people you tag are notified.</>}
          </p>
        </div>
      )}
      <div className={cn("space-y-3", compact ? "max-h-64 overflow-y-auto pb-2" : "px-5 py-4")}>
        {messages.length === 0 && (
          <p className="text-xs text-muted">No messages yet. Start the thread below.</p>
        )}
        {folded.length > 0 && (
          <details
            data-message-fold={folded.length}
            open={foldOpen}
            onToggle={(e) => setFoldOpen((e.currentTarget as HTMLDetailsElement).open)}
            className="group/fold rounded-lg border border-border/70 bg-surface-2/40"
          >
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-3 text-xs font-medium text-muted hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-open/fold:rotate-90" />
              Earlier messages ({folded.length}), more than 10 days old
            </summary>
            <div className="space-y-3 px-3 pb-3 pt-1">{folded.map(renderMsg)}</div>
          </details>
        )}
        {open.map(renderMsg)}
        {readError && !readOnly && <p role="alert" className="text-xs text-danger">{readError} <button type="button" className="underline" onClick={() => {
          if (!lastMessageId) return;
          void markRead(lastMessageId)
            .then((r) => setReadError(r.ok ? null : r.message))
            .catch(() => setReadError("Could not save read state. Try again."));
        }}>Retry</button></p>}
      </div>

      {!readOnly && (
        <div
          className={cn(compact ? "mt-2" : "border-t px-5 py-3", dragging && "rounded-lg ring-2 ring-brand/40")}
          onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            if (e.dataTransfer.files.length === 0) return;
            e.preventDefault();
            setDragging(false);
            void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {replyTo && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 py-1.5 text-[11px] text-muted">
              <Reply className="size-3 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate">
                Replying to <span className="font-medium">{replyTo.authorName ?? "Team"}</span>: {(replyTo.body || "a file").replace(/\s+/g, " ").slice(0, 80)}
              </span>
              <button type="button" onClick={() => setReplyTo(null)} aria-label="Cancel the reply" className="-my-1.5 inline-flex size-9 shrink-0 items-center justify-center text-muted-2 hover:text-foreground"><X aria-hidden className="size-3.5" /></button>
            </div>
          )}
          <div className="relative">
            <AutoTextarea
              ref={taRef}
              value={body}
              onChange={onChange}
              onKeyDown={(e) => { if (e.key === "Escape") setMentionQuery(null); }}
              onPaste={(e) => {
                const pasted = Array.from(e.clipboardData?.files ?? []);
                if (pasted.length === 0) return;
                e.preventDefault();
                void addFiles(pasted);
              }}
              minRows={2}
              aria-label={projectId ? "Note for the team" : "Message to the whole team"}
              placeholder={projectId ? "Leave a note for the team… (@ to tag)" : "Message everyone on the team… (@ to tag)"}
              className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-base sm:text-sm outline-none focus:border-brand"
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

          {/* What will go with the message: files (uploading or ready) and pages. */}
          {files.length > 0 && (
            <ul aria-label="Files to send" className="mt-2 flex flex-wrap gap-2">
              {files.map((f) => (
                <li key={f.key} className={cn("relative flex min-w-0 max-w-full items-center gap-2 rounded-lg border bg-surface-2/60 p-1.5 pr-1", f.state === "error" ? "border-danger/50" : "border-border")}>
                  {f.preview ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={f.preview} alt="" className="size-11 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-surface"><FileText aria-hidden className="size-4 text-muted-2" /></span>
                  )}
                  <span className="min-w-0 max-w-[11rem] text-xs">
                    <span className="block truncate font-medium">{f.name}</span>
                    <span className={cn("block", f.state === "error" ? "text-danger" : "text-muted-2")}>
                      {f.state === "uploading" ? `Uploading ${Math.round(f.pct)}%` : f.state === "error" ? f.error : fmtFileSize(f.size)}
                    </span>
                  </span>
                  <button type="button" onClick={() => removeFile(f.key)} aria-label={`Remove ${f.name}`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-2 hover:bg-surface hover:text-foreground">
                    <X aria-hidden className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {links.length > 0 && (
            <ul aria-label="Pages to send" className="mt-2 space-y-1.5">
              {links.map((l) => (
                <li key={`${l.kind}:${l.id}:${l.cut ?? ""}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2/60 pl-3">
                  <Link2 aria-hidden className="size-4 shrink-0 text-brand" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{l.title}</span>
                  <button type="button" onClick={() => setLinks((cur) => cur.filter((x) => x !== l))} aria-label={`Remove ${l.title}`} className="inline-flex size-11 shrink-0 items-center justify-center text-muted-2 hover:text-foreground">
                    <X aria-hidden className="size-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picker && (
            <HubLinkPicker
              conversation={convKey}
              team={conv.kind === "team"}
              chosen={links}
              onPick={(l) => { setError(null); setLinks((cur) => (cur.length >= MAX_LINKS_PER_MESSAGE || cur.some((x) => x.kind === l.kind && x.id === l.id && (x.cut ?? null) === (l.cut ?? null)) ? cur : [...cur, l])); }}
              onClose={() => setPicker(false)}
            />
          )}

          <input
            ref={fileRef}
            type="file"
            multiple
            accept={MESSAGE_FILE_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={files.length >= MESSAGE_FILES_PER_MESSAGE}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
            >
              <Paperclip aria-hidden className="size-4" /> <span>Photo or file</span>
            </button>
            <button
              type="button"
              onClick={() => setPicker((v) => !v)}
              aria-expanded={picker}
              disabled={links.length >= MAX_LINKS_PER_MESSAGE && !picker}
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium hover:bg-surface-2 hover:text-foreground disabled:opacity-50", picker ? "border-brand text-brand" : "border-border bg-surface text-muted")}
            >
              <Link2 aria-hidden className="size-4" /> <span>Link a hub page</span>
            </button>
            {/* No "posting as" selector — messages post under the logged-in
                person's own name (server-derived; a picked name was a lie
                waiting to happen). */}
            <button
              disabled={pending || uploading || !canPost}
              onClick={submit}
              className="ml-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-3 py-2 text-sm font-medium text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              <Send className="size-4" /> {pending ? "Posting…" : uploading ? "Uploading…" : "Post"}
            </button>
            {error && <p role="alert" className="w-full text-xs text-danger">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Photos as thumbnails that open full size; files as a named chip that
 *  downloads; hub pages as titled cards (a page this viewer can't open shows
 *  its title and no link). */
export function MessageAttachments({ files, links }: { files: ProjectMsgFile[]; links: HubLinkView[] }) {
  if (files.length === 0 && links.length === 0) return null;
  const photos = files.filter((f) => f.image);
  const others = files.filter((f) => !f.image);
  return (
    <div className="mt-1.5 space-y-1.5">
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {photos.map((f) => (
            <a key={f.id} href={f.href} target="_blank" rel="noopener" title={f.name} className="block overflow-hidden rounded-lg border border-border bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.href} alt={f.name} loading="lazy" className="size-24 object-cover sm:size-28" />
            </a>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {others.map((f) => (
            <a key={f.id} href={`${f.href}?download=1`} download={f.name} className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-2.5 text-xs hover:bg-surface-2">
              <FileText aria-hidden className="size-4 shrink-0 text-muted-2" />
              <span className="min-w-0 truncate font-medium">{f.name}</span>
              <span className="shrink-0 text-muted-2">{fmtFileSize(f.size)}</span>
            </a>
          ))}
        </div>
      )}
      {links.map((l, i) =>
        l.href ? (
          <a key={i} href={l.href} className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 text-sm hover:border-brand/50 hover:bg-surface-2">
            <Link2 aria-hidden className="size-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate font-medium">{l.title}</span>
            <ExternalLink aria-hidden className="size-3.5 shrink-0 text-muted-2" />
          </a>
        ) : (
          <div key={i} className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-sm text-muted" title="You can't open this page">
            <Lock aria-hidden className="size-4 shrink-0 text-muted-2" />
            <span className="min-w-0 flex-1 truncate">{l.title}</span>
            <span className="shrink-0 text-[11px] text-muted-2">Not open to you</span>
          </div>
        ),
      )}
    </div>
  );
}

// "Link a hub page": search by address or client, or paste a hub link. Only
// pages EVERYONE in this conversation can open are offered (the server
// decides, lib/hubLinkAccess); the ones someone can't open are counted, with
// who, so nobody wonders where a page went.
function HubLinkPicker({ conversation, team, chosen, onPick, onClose }: {
  conversation: string;
  team: boolean;
  chosen: PendingLink[];
  onPick: (l: PendingLink) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [pasted, setPasted] = useState<{ ok: true; link: PendingLink } | { ok: false; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const term = q.trim();
    const looksLikeUrl = /^(https?:\/\/|\/|hub\.realtourpilot\.com)/i.test(term);
    const t = setTimeout(() => {
      setBusy(true);
      const run = looksLikeUrl
        ? checkHubPage(conversation, term).then((r) => { if (n === seq.current) { setPasted(r); setResult(null); } })
        : searchHubPages(conversation, term).then((r) => { if (n === seq.current) { setResult(r); setPasted(null); } });
      void run
        .catch((e: unknown) => { if (n === seq.current) setPasted({ ok: false, message: e instanceof Error ? e.message : "That search didn't work. Try again." }); })
        .finally(() => { if (n === seq.current) setBusy(false); });
    }, term ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, conversation]);

  const isChosen = (l: { kind: string; id: string; cut?: string | null }) => chosen.some((x) => x.kind === l.kind && x.id === l.id && (x.cut ?? null) === (l.cut ?? null));
  const groups = new Map<string, NonNullable<SearchResult>["offered"]>();
  for (const o of result?.offered ?? []) groups.set(o.group, [...(groups.get(o.group) ?? []), o]);

  return (
    <div className="mt-2 rounded-xl border border-border bg-surface p-3 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-2" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search for a hub page"
            placeholder="Address, client, page name, or paste a hub link"
            className="min-h-11 w-full rounded-lg border border-border bg-surface-2 py-2 pl-8 pr-3 text-base outline-none focus:border-brand sm:text-sm"
          />
        </div>
        <button type="button" onClick={onClose} aria-label="Close the page picker" className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-2 hover:bg-surface-2 hover:text-foreground">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted-2">
        {team
          ? "Only pages everyone on the team can open are listed. A job's own pages can go in that job's thread."
          : "Only pages everyone in this conversation can open are listed."}
      </p>
      <div className="mt-2 max-h-72 space-y-3 overflow-y-auto" aria-live="polite">
        {busy && <p className="flex items-center gap-1.5 text-xs text-muted"><Loader2 aria-hidden className="size-3.5 animate-spin" /> Looking…</p>}
        {pasted && !pasted.ok && <p role="alert" className="text-xs text-danger">{pasted.message}</p>}
        {pasted && pasted.ok && (
          <button type="button" disabled={isChosen(pasted.link)} onClick={() => onPick(pasted.link)} className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg border border-border px-3 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
            <Link2 aria-hidden className="size-4 shrink-0 text-brand" />
            <span className="min-w-0 flex-1 truncate font-medium">{pasted.link.title}</span>
            <span className="shrink-0 text-xs text-muted-2">{isChosen(pasted.link) ? "Added" : "Add"}</span>
          </button>
        )}
        {[...groups.entries()].map(([group, items]) => (
          <div key={group}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-2">{group}</p>
            <ul className="space-y-1">
              {items.map((o) => (
                <li key={`${o.kind}:${o.id}:${o.cut ?? ""}`}>
                  <button type="button" disabled={isChosen(o)} onClick={() => onPick(o)} className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-surface-2 disabled:opacity-50">
                    <Link2 aria-hidden className="size-4 shrink-0 text-brand" />
                    <span className="min-w-0 flex-1 truncate">{o.title}</span>
                    <span className="shrink-0 text-xs text-muted-2">{isChosen(o) ? "Added" : "Add"}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {result && result.offered.length === 0 && !busy && (
          <p className="text-xs text-muted">{q.trim().length >= 2 ? "No page everyone here can open matches that." : "Type an address or a client's name."}</p>
        )}
        {result && result.hidden.length > 0 && (
          <details className="text-xs text-muted">
            <summary className="flex min-h-11 cursor-pointer items-center">
              {result.hidden.length} {result.hidden.length === 1 ? "page isn't" : "pages aren't"} listed because someone here can't open {result.hidden.length === 1 ? "it" : "them"}
            </summary>
            <ul className="space-y-1 pb-1">
              {result.hidden.map((h, i) => (
                <li key={i} className="min-w-0 break-words"><span className="font-medium text-foreground/80">{h.title}</span>: {h.why}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}

// "Close conversation" on the message center's thread header (Kyle call, Sep
// 16): folds this job's thread under Closed for the viewer until someone
// posts again. Lives here (the one client module every thread surface
// already imports) rather than in a component of its own.
export function ThreadCloseButton({ projectId, closed }: { projectId: string; closed: boolean }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  function toggle() {
    start(async () => {
      try {
        const r = closed ? await reopenConversation(projectId) : await closeConversation(projectId);
        setNote(r.ok ? null : r.message);
      } catch (e) {
        setNote(e instanceof Error ? e.message : "Couldn’t do that.");
      }
    });
  }
  return (
    <span className="inline-flex items-center gap-2">
      {note && <span className="text-[11px] text-danger">{note}</span>}
      <button
        type="button"
        onClick={toggle}
        disabled={pending}
        title={closed ? "Put this conversation back in the active list" : "Fold this conversation away until someone posts again"}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground disabled:opacity-50"
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : closed ? <ArchiveRestore className="size-3.5" /> : <Archive className="size-3.5" />}
        {closed ? "Reopen conversation" : "Close conversation"}
      </button>
    </span>
  );
}
