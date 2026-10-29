import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { Archive, ArrowLeft, ExternalLink, MessageSquare, Search, Users } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getTeam } from "@/lib/queries";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/user";
import { ProjectMessages, TeamChannelMessages, ThreadCloseButton, type ProjectMsg } from "@/components/project/ProjectMessages";
import {
  finishedWork,
  latestMessagePerProject,
  teamChatConversations,
  threadIsArchived,
  threadIsClosed,
  type ChatConversation,
  type ChatScope,
  type LatestMsg,
} from "@/lib/editorQueue";
import { messageExtras } from "@/lib/messageExtras";
import { latestChannelMessage, loadTeamChannel, teamChannelUnread, TEAM_CHANNEL_ID } from "@/lib/teamChannel";
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
//
// Oct 28 2026 (Jordan): THE TEAM CHANNEL sits at the top of the list in every
// entry (?t=team: lib/teamChannel), photographers get the center too (their
// own shoots' threads), and a thread whose work is finished folds under
// ARCHIVED by itself ("messages for any inactive work should be archived":
// lib/editorQueue finishedWork + threadIsArchived), coming back when someone
// posts or the job is reopened.

const fmtDay = (d: Date) =>
  d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export type ChatRow = ChatConversation & {
  lastMsg: LatestMsg | null;
  unread: boolean;
  closed: boolean;
  /** Finished work, nothing open, nothing unread (Oct 28 2026). */
  archived: boolean;
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
  archived: ChatRow[];
  selected: ChatRow | null;
  thread: { messages: ProjectMsg[]; team: { id: string; name: string; avatarColor: string }[] } | null;
  /** The team channel's row, and its thread when it is the one open. */
  channel: { lastMsg: LatestMsg | null; unread: boolean; selected: boolean };
  /** Unread conversations other than the one on screen — for the page subtitle. */
  unreadTotal: number;
};

export async function loadTeamChat(opts: {
  scope: ChatScope;
  viewer: { id: string; teamMemberId: string | null; impersonating: boolean } | null;
  selectedId?: string;
  q?: string;
  view?: string;
  /** Whose links and files the thread draws for; defaults to the signed-in viewer. */
  user?: CurrentUser | null;
}): Promise<TeamChatData> {
  const { scope, viewer, selectedId, q } = opts;
  const view = chatView(opts.view);
  const now = new Date();
  const rows = await teamChatConversations(scope);
  const ids = rows.map((r) => r.id);
  const [latest, reads, related, channelLast, channelUnread] = await Promise.all([
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
    latestChannelMessage(),
    viewer ? teamChannelUnread(viewer.id) : Promise.resolve(false),
  ]);
  const read = new Map(reads.map((r) => [r.projectId, r]));
  const relatedIds = new Set(related.map((r) => r.projectId));
  const finished = await finishedWork(rows.filter((r) => !r.activeWork).map((r) => r.id)).catch(() => new Map<string, { endedAt: Date }>());

  // Conversations with messages first (newest activity on top), then the rest
  // by their date — so a job with no thread yet is still one click from
  // starting one.
  const term = (q ?? "").trim().toLowerCase();
  const all: ChatRow[] = rows
    .filter((r) => !term || r.street.toLowerCase().includes(term) || r.client.toLowerCase().includes(term))
    .map((r) => {
      const m = latest.get(r.id) ?? null;
      const s = read.get(r.id);
      const closed = threadIsClosed(s?.closedAt, m);
      const unread = !!m && (!s || m.createdAt > s.seenAt);
      return {
        ...r,
        lastMsg: m,
        closed,
        unread,
        archived: !closed && threadIsArchived({ finished: finished.get(r.id), last: m, unread, now }),
        mine: scope.kind === "editor" || scope.kind === "photographer" || !!viewer?.teamMemberId && (r.assignedTeamMemberIds.includes(viewer.teamMemberId) || relatedIds.has(r.id)),
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
  const open = visible.filter((r) => !r.closed && !r.archived);
  const closed = visible.filter((r) => r.closed);
  const archived = visible.filter((r) => r.archived);

  // The open thread — only a job the viewer's list actually contains (an
  // editor can't open another lane's thread by pasting an id). ?t=team is
  // the team channel, which every login on the team reads.
  const channelSelected = selectedId === TEAM_CHANNEL_ID;
  const selected = selectedId && !channelSelected ? visible.find((r) => r.id === selectedId) ?? null : null;
  let thread: TeamChatData["thread"] = null;
  if (selected || channelSelected) {
    const user = opts.user !== undefined ? opts.user : await getCurrentUser().catch(() => null);
    const [messages, team] = await Promise.all([selected ? loadThread(selected.id, user) : loadTeamChannel(user), getTeam()]);
    thread = { messages, team: team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor })) };
  }

  return {
    term,
    view,
    counts: { all: all.length, mine: all.filter((r) => r.mine).length, unread: all.filter((r) => r.unread && !r.closed).length, active: all.filter((r) => r.activeWork).length },
    open,
    closed,
    archived,
    selected,
    thread,
    channel: { lastMsg: channelLast, unread: channelUnread, selected: channelSelected },
    unreadTotal: all.filter((r) => r.unread && !r.closed && r.id !== selected?.id).length + (channelUnread && !channelSelected ? 1 : 0),
  };
}

export async function loadThread(projectId: string, user?: CurrentUser | null): Promise<ProjectMsg[]> {
  const msgs = await prisma.projectMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    include: { replyTo: { select: { authorName: true, body: true } } },
  });
  const viewer = user !== undefined ? user : await getCurrentUser().catch(() => null);
  const extra = await messageExtras(msgs, viewer);
  return msgs.map((m) => ({
    id: m.id,
    authorId: m.authorId,
    authorName: m.authorName,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    ago: formatDistanceToNow(m.createdAt, { addSuffix: true }),
    replyTo: m.replyTo ? { authorName: m.replyTo.authorName, body: m.replyTo.body } : null,
    ...extra(m.id),
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
  /** The thread header's jump-out button: the job file for the office, the edit page for editors, the shoot for photographers. */
  open: { pathname: "/projects" | "/edit" | "/shoot"; label: string };
  /** "View as" previews: no composer, no close button. */
  readOnly?: boolean;
}) {
  const { term, selected, thread, view, channel } = data;
  const q = term || undefined;
  const filterHref = (next: ChatView) => hrefFor(base, { q, view: next === "all" ? undefined : next });
  const anyOpen = !!selected || channel.selected;

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
            ? `${r.lastMsg.authorName.split(" ")[0]}: ${r.lastMsg.body || "Sent a file or a page"}`
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

  // THE TEAM CHANNEL'S ROW: first in the list whatever the search or filter.
  const channelRow = (
    <Link
      href={hrefFor(base, { t: TEAM_CHANNEL_ID, q, view: view === "all" ? undefined : view }, channel.lastMsg ? `msg-${channel.lastMsg.id}` : undefined)}
      data-team-channel-row
      className={cn("block border-b border-border/60 px-4 py-3 hover:bg-surface-2/60", channel.selected && "bg-surface-2/80")}
    >
      <span className="flex items-center gap-2">
        <span className={cn("size-2 shrink-0 rounded-full", channel.unread ? "bg-success" : "bg-transparent")} title={channel.unread ? "New messages" : undefined} />
        <Users aria-hidden className="size-4 shrink-0 text-brand" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          Team channel <span className="font-normal text-muted">(everyone)</span>
        </span>
        {channel.lastMsg && <span className="shrink-0 text-[11px] text-muted-2">{fmtDay(channel.lastMsg.createdAt)}</span>}
      </span>
      <span className="mt-0.5 block truncate pl-4 text-xs text-muted">
        {channel.lastMsg ? `${channel.lastMsg.authorName.split(" ")[0]}: ${channel.lastMsg.body}` : "Message everyone on the team."}
      </span>
    </Link>
  );

  return (
    <div className="mx-auto grid w-full max-w-7xl flex-1 gap-4 lg:grid-cols-[minmax(280px,340px)_1fr]">
      {/* CONVERSATION LIST — hidden on mobile while a thread is open. */}
      <div className={cn("min-w-0", anyOpen && "hidden lg:block")}>
        <form method="GET" action={base.pathname} className="relative mb-3">
          {Object.entries(base.params ?? {}).map(([k, v]) => (
            <input key={k} type="hidden" name={k} value={v} />
          ))}
          {(selected || channel.selected) && <input type="hidden" name="t" value={channel.selected ? TEAM_CHANNEL_ID : selected!.id} />}
          {view !== "all" && <input type="hidden" name="view" value={view} />}
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-2" />
          <input
            name="q"
            defaultValue={term}
            placeholder="Search by street or client…"
            className="w-full rounded-xl border border-border bg-surface py-2 pl-8 pr-3 text-base outline-none focus:border-brand sm:text-sm"
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
          {channelRow}
          {data.open.length === 0 && data.closed.length === 0 && data.archived.length === 0 ? (
            <p className="p-5 text-sm text-muted">{term || view !== "all" ? "No job conversations match these filters." : "No job conversations yet."}</p>
          ) : (
            <>
              {data.open.length === 0 && <p className="p-5 text-sm text-muted">No open job conversations match these filters.</p>}
              <ul className="divide-y divide-border/60">{data.open.map(row)}</ul>
              {/* THE CLOSED FOLD — conversations this viewer put away. A new
                  message on any of them moves it back up on its own. */}
              {data.closed.length > 0 && (
                <details className="border-t border-border/60" open={!!selected?.closed}>
                  <summary className="flex min-h-11 cursor-pointer items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-muted hover:bg-surface-2/60">
                    <Archive className="size-3.5" /> Closed
                    <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{data.closed.length}</span>
                  </summary>
                  <ul className="divide-y divide-border/60 opacity-80">{data.closed.map(row)}</ul>
                </details>
              )}
              {/* THE ARCHIVED FOLD (Oct 28 2026) — finished jobs with nothing
                  open and nothing unread. A new message or reopened work
                  brings one back by itself. */}
              {data.archived.length > 0 && (
                <details data-archived-fold={data.archived.length} className="border-t border-border/60" open={!!selected?.archived}>
                  <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-1.5 px-4 py-2.5 text-xs font-semibold text-muted hover:bg-surface-2/60">
                    <Archive className="size-3.5" /> Archived
                    <span className="rounded-full bg-surface-2 px-1.5 text-[10px] font-medium">{data.archived.length}</span>
                    <span className="font-normal text-muted-2">finished jobs, nothing open</span>
                  </summary>
                  <ul className="divide-y divide-border/60 opacity-80">{data.archived.map(row)}</ul>
                </details>
              )}
            </>
          )}
        </div>
      </div>

      {/* THE THREAD */}
      {channel.selected && thread ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-border bg-surface px-4 py-3">
            <Link href={hrefFor(base, { q, view: view === "all" ? undefined : view })} aria-label="Back to the conversations" className="-ml-2 inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2 lg:hidden">
              <ArrowLeft aria-hidden className="size-4 text-muted" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">Team channel</div>
              <div className="text-[11px] text-muted-2">Everyone on the team reads this. Only the people you tag are notified.</div>
            </div>
          </div>
          <div className="rounded-b-2xl border border-border bg-surface p-4 sm:p-5">
            <TeamChannelMessages team={thread.team} messages={thread.messages} readOnly={readOnly} />
          </div>
        </div>
      ) : selected && thread ? (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-border bg-surface px-4 py-3">
            <Link href={hrefFor(base, { q, view: view === "all" ? undefined : view })} aria-label="Back to the conversations" className="-ml-2 inline-flex size-11 items-center justify-center rounded-lg hover:bg-surface-2 lg:hidden">
              <ArrowLeft aria-hidden className="size-4 text-muted" />
            </Link>
            {/* A floor under the title (basis-52): on a phone the buttons wrap
                below it instead of squeezing it to one word a line. */}
            <div className="min-w-0 flex-1 basis-52">
              <div className="truncate text-sm font-semibold">
                {selected.street} <span className="font-normal text-muted">({selected.client})</span>
              </div>
              <div className="text-[11px] text-muted-2">
                {selected.status}
                {selected.closed && " · closed — a new message reopens it"}
                {selected.archived && " · archived: the work is finished. A new message or new work brings it back."}
              </div>
              {(selected.monthContext || selected.topicContext.length > 0) && <div className="text-[13px] text-muted">
                {selected.monthContext?.split(", ").map(monthLabel).join(", ")}{selected.monthContext && selected.topicContext.length > 0 ? " · " : ""}
                {selected.topicContext.length > 0 ? `Topics: ${selected.topicContext.join(", ")}` : ""}
              </div>}
            </div>
            {!readOnly && <ThreadCloseButton projectId={selected.id} closed={selected.closed} />}
            <Link
              href={`${open.pathname}/${selected.id}#messages`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-brand-action px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90"
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
            Pick a conversation — the team channel, or a job&rsquo;s own thread.
          </div>
        </div>
      )}
    </div>
  );
}
