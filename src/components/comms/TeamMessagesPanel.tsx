import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Archive, ArrowLeft, ExternalLink, MessageSquare, Search } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getTeam } from "@/lib/queries";
import { ProjectMessages, ThreadCloseButton, type ProjectMsg } from "@/components/project/ProjectMessages";
import {
  latestMessagePerProject,
  teamChatConversations,
  threadIsClosed,
  type ChatConversation,
  type ChatScope,
  type LatestMsg,
} from "@/lib/editorQueue";
import { cn } from "@/lib/utils";

// TEAM CHAT BY PROPERTY (Kyle call, Sep 16). The two-pane message center
// Jordan asked for on Aug 27 (his Luma Visuals screenshot) — a conversation
// list with unread dots and last-message previews on the left, the selected
// job's thread on the right — was built into the Editing Room and reached
// only through the queue's Messages button, listing only video-queue jobs.
// Kyle's path is Communications → Team, which was a flat 40-row stream whose
// links landed on the top of the project page. This is now the ONE center
// behind both entries: the loader below answers "which conversations, which
// is open, what is unread", the component renders it, and each page keeps its
// own header. Editors see their lane (as before); the office sees every job
// with a thread plus every job in flight. Opening a thread stamps the
// viewer's ThreadRead watermark advances when the loaded last message becomes
// visible, so a thread read anywhere is read everywhere. A
// conversation the viewer closed sits under the Closed fold until someone
// posts on it again.

const fmtDay = (d: Date) =>
  d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export type ChatRow = ChatConversation & {
  lastMsg: LatestMsg | null;
  unread: boolean;
  closed: boolean;
  mine: boolean;
};

export type ChatView = "all" | "mine" | "unread" | "active";
export const chatView = (value: string | undefined): ChatView =>
  value === "mine" || value === "unread" || value === "active" ? value : "all";

export type TeamChatData = {
  term: string;
  view: ChatView;
  counts: Record<ChatView, number>;
  open: ChatRow[];
  closed: ChatRow[];
  selected: ChatRow | null;
  thread: { messages: ProjectMsg[]; team: { id: string; name: string; avatarColor: string }[] } | null;
  /** Unread conversations other than the one on screen — for the page subtitle. */
  unreadTotal: number;
};

export async function loadTeamChat(opts: {
  scope: ChatScope;
  viewer: { id: string; teamMemberId: string | null; impersonating: boolean } | null;
  selectedId?: string;
  q?: string;
  view?: string;
}): Promise<TeamChatData> {
  const { scope, viewer, selectedId, q } = opts;
  const view = chatView(opts.view);
  const rows = await teamChatConversations(scope);
  const ids = rows.map((r) => r.id);
  const [latest, reads, related] = await Promise.all([
    latestMessagePerProject(ids),
    viewer && ids.length
      ? prisma.threadRead.findMany({
          where: { userKey: viewer.id, projectId: { in: ids } },
          select: { projectId: true, seenAt: true, closedAt: true },
        })
      : Promise.resolve([]),
    scope.kind === "office" && viewer?.teamMemberId && ids.length
      ? prisma.projectMessage.findMany({
          where: {
            projectId: { in: ids },
            OR: [{ authorId: viewer.teamMemberId }, { mentions: { contains: `"${viewer.teamMemberId}"` } }],
          },
          distinct: ["projectId"],
          select: { projectId: true },
        })
      : Promise.resolve([]),
  ]);
  const read = new Map(reads.map((r) => [r.projectId, r]));
  const relatedIds = new Set(related.map((r) => r.projectId));

  // Conversations with messages first (newest activity on top), then the rest
  // by their date — so a job with no thread yet is still one click from
  // starting one.
  const term = (q ?? "").trim().toLowerCase();
  const all: ChatRow[] = rows
    .filter((r) => !term || r.street.toLowerCase().includes(term) || r.client.toLowerCase().includes(term))
    .map((r) => {
      const m = latest.get(r.id) ?? null;
      const s = read.get(r.id);
      return {
        ...r,
        lastMsg: m,
        closed: threadIsClosed(s?.closedAt, m),
        unread: !!m && (!s || m.createdAt > s.seenAt),
        mine: scope.kind === "editor" || !!viewer?.teamMemberId && (r.assignedTeamMemberIds.includes(viewer.teamMemberId) || relatedIds.has(r.id)),
      };
    })
    .sort((a, b) => {
      if (a.lastMsg && b.lastMsg) return b.lastMsg.createdAt.getTime() - a.lastMsg.createdAt.getTime();
      if (a.lastMsg) return -1;
      if (b.lastMsg) return 1;
      const at = a.sortAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const bt = b.sortAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return at - bt;
    });
  const matchesView = (r: ChatRow) => view === "all" || view === "mine" && r.mine || view === "unread" && r.unread && !r.closed || view === "active" && r.activeWork;
  const visible = all.filter(matchesView);
  const open = visible.filter((r) => !r.closed);
  const closed = visible.filter((r) => r.closed);

  // The open thread — only a job the viewer's list actually contains (an
  // editor can't open another lane's thread by pasting an id).
  const selected = selectedId ? visible.find((r) => r.id === selectedId) ?? null : null;
  let thread: TeamChatData["thread"] = null;
  if (selected) {
    const [messages, team] = await Promise.all([loadThread(selected.id), getTeam()]);
    thread = { messages, team: team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor })) };
  }

  return {
    term,
    view,
    counts: { all: all.length, mine: all.filter((r) => r.mine).length, unread: all.filter((r) => r.unread && !r.closed).length, active: all.filter((r) => r.activeWork).length },
    open,
    closed,
    selected,
    thread,
    unreadTotal: all.filter((r) => r.unread && !r.closed && r.id !== selected?.id).length,
  };
}

export async function loadThread(projectId: string): Promise<ProjectMsg[]> {
  const msgs = await prisma.projectMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    include: { replyTo: { select: { authorName: true, body: true } } },
  });
  return msgs.map((m) => ({
    id: m.id,
    authorId: m.authorId,
    authorName: m.authorName,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    ago: formatDistanceToNow(m.createdAt, { addSuffix: true }),
    replyTo: m.replyTo ? { authorName: m.replyTo.authorName, body: m.replyTo.body } : null,
  }));
}

// Where this center lives — the list links and the search form must come
// back to the same page with its own fixed params (Communications keeps
// ?tab=team; the Editing Room entry has none).
export type ChatBase = { pathname: string; params?: Record<string, string> };

function hrefFor(base: ChatBase, extra: Record<string, string | undefined>, hash?: string): string {
  const sp = new URLSearchParams(base.params ?? {});
  for (const [k, v] of Object.entries(extra)) if (v) sp.set(k, v);
  const qs = sp.toString();
  return `${base.pathname}${qs ? `?${qs}` : ""}${hash ? `#${hash}` : ""}`;
}

function monthLabel(value: string): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  return m ? new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}-01T12:00:00Z`)) : value;
}

export function TeamMessagesPanel({
  data,
  base,
  open,
  readOnly = false,
}: {
  data: TeamChatData;
  base: ChatBase;
  /** The thread header's jump-out button: the job file for the office, the edit page for editors. */
  open: { pathname: "/projects" | "/edit"; label: string };
  /** "View as" previews: no composer, no close button. */
  readOnly?: boolean;
}) {
  const { term, selected, thread, view } = data;
  const q = term || undefined;
  const filterHref = (next: ChatView) => hrefFor(base, { q, view: next === "all" ? undefined : next });

  const row = (r: ChatRow) => (
    <li key={r.id}>
      <Link
        // Straight to the newest message when there is one (#msg-<id>); the
        // board's :target tint marks it.
        href={hrefFor(base, { t: r.id, q, view: view === "all" ? undefined : view }, r.lastMsg ? `msg-${r.lastMsg.id}` : undefined)}
        className={cn("block px-4 py-3 hover:bg-surface-2/60", selected?.id === r.id && "bg-surface-2/80")}
      >
        <span className="flex items-center gap-2">
          <span
            className={cn("size-2 shrink-0 rounded-full", r.unread ? "bg-success" : "bg-transparent")}
            title={r.unread ? "New messages" : undefined}
          />
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">
            {r.street} <span className="font-normal text-muted">({r.client})</span>
          </span>
          {r.lastMsg && <span className="shrink-0 text-[11px] text-muted-2">{fmtDay(r.lastMsg.createdAt)}</span>}
        </span>
        <span className="mt-0.5 block truncate pl-4 text-xs text-muted">
          {r.lastMsg
            ? `${r.lastMsg.authorName.split(" ")[0]}: ${r.lastMsg.body}`
            : "No messages yet — start the thread."}
        </span>
        {(r.monthContext || r.topicContext.length > 0) && (
          <span className="mt-1 block truncate pl-4 text-[13px] text-muted" title={r.topicContext.join(", ")}>
            {r.monthContext?.split(", ").map(monthLabel).join(", ")}{r.monthContext && r.topicContext.length > 0 ? " · " : ""}
            {r.topicContext.length > 0 ? `Topics: ${r.topicContext.join(", ")}` : ""}
          </span>
        )}
      </Link>
    </li>
  );

  return (
    <div className="mx-auto grid w-full max-w-7xl flex-1 gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
      {/* CONVERSATION LIST — hidden on mobile while a thread is open. */}
      <div className={cn("min-w-0", selected && "hidden lg:block")}>
        <form method="GET" action={base.pathname} className="relative mb-3">
          {Object.entries(base.params ?? {}).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {selected && <input type="hidden" name="t" value={selected.id} />}
          {view !== "all" && <input type="hidden" name="view" value={view} />}
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-2" />
          <input
            name="q"
            defaultValue={term}
            placeholder="Search by street or client…"
            className="w-full rounded-xl border border-border bg-surface py-2 pl-8 pr-3 text-sm outline-none focus:border-brand"
          />
        </form>
        <nav aria-label="Team conversation filters" className="mb-3 flex flex-wrap gap-1.5">
          {(["all", "mine", "unread", "active"] as const).map((option) => (
            <Link key={option} href={filterHref(option)} aria-current={view === option ? "page" : undefined}
              className={cn("inline-flex min-h-11 items-center rounded-lg border px-3 text-sm font-medium", view === option ? "border-brand bg-brand/10 text-brand" : "border-border bg-surface text-muted hover:bg-surface-2")}>
              {option === "all" ? "All" : option === "mine" ? "Mine" : option === "unread" ? "Unread" : "Active work"}
              <span className="ml-1.5 text-xs">{data.counts[option]}</span>
            </Link>
          ))}
        </nav>
        {view === "mine" && <p className="mb-2 text-xs text-muted">Assigned jobs and conversations you posted in or were tagged in.</p>}
        <div className="overflow-hidden rounded-2xl border border-border bg-surface">
          {data.open.length === 0 && data.closed.length === 0 ? (
            <p className="p-5 text-sm text-muted">{term || view !== "all" ? "No conversations match these filters." : "No conversations yet."}</p>
          ) : (
            <>
              {data.open.length === 0 && <p className="p-5 text-sm text-muted">No open conversations match these filters.</p>}
              <ul className="divide-y divide-border/60">{data.open.map(row)}</ul>
              {/* THE CLOSED FOLD — conversations this viewer put away. A new
                  message on any of them moves it back up on its own. */}
              {data.closed.length > 0 && (
                <details className="border-t border-border/60" open={!!selected?.closed}>
                  <summary className="flex cursor-pointer items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-muted hover:bg-surface-2/60">
                    <Archive className="size-3.5" /> Closed
                    <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{data.closed.length}</span>
                  </summary>
                  <ul className="divide-y divide-border/60 opacity-80">{data.closed.map(row)}</ul>
                </details>
              )}
            </>
          )}
        </div>
      </div>

      {/* THE THREAD */}
      {selected && thread ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-border bg-surface px-4 py-3">
            <Link href={hrefFor(base, { q, view: view === "all" ? undefined : view })} className="lg:hidden">
              <ArrowLeft className="size-4 text-muted" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {selected.street} <span className="font-normal text-muted">({selected.client})</span>
              </div>
              <div className="text-[11px] text-muted-2">
                {selected.status}
                {selected.closed && " · closed — a new message reopens it"}
              </div>
              {(selected.monthContext || selected.topicContext.length > 0) && <div className="text-[13px] text-muted">
                {selected.monthContext?.split(", ").map(monthLabel).join(", ")}{selected.monthContext && selected.topicContext.length > 0 ? " · " : ""}
                {selected.topicContext.length > 0 ? `Topics: ${selected.topicContext.join(", ")}` : ""}
              </div>}
            </div>
            {!readOnly && <ThreadCloseButton projectId={selected.id} closed={selected.closed} />}
            <Link
              href={`${open.pathname}/${selected.id}#messages`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90"
            >
              {open.label} <ExternalLink className="size-3" />
            </Link>
          </div>
          <div className="rounded-b-2xl border border-border bg-surface p-4 sm:p-5">
            <ProjectMessages projectId={selected.id} team={thread.team} messages={thread.messages} readOnly={readOnly} canRequestRevision={open.pathname === "/projects"} />
          </div>
        </div>
      ) : (
        <div className="hidden items-center justify-center rounded-2xl border border-dashed border-border bg-surface/50 lg:flex">
          <div className="p-8 text-center text-sm text-muted">
            <MessageSquare className="mx-auto mb-2 size-6 text-muted-2" />
            Pick a conversation — every message stays on the job&rsquo;s own thread.
          </div>
        </div>
      )}
    </div>
  );
}
