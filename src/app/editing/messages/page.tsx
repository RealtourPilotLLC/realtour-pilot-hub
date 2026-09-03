import Link from "next/link";
import { ArrowLeft, ExternalLink, MessageSquare, Search } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { getTeam } from "@/lib/queries";
import { ProjectMessages } from "@/components/project/ProjectMessages";
import { buildEditorQueue } from "@/lib/editorQueue";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

// The message center (Jordan, Aug 27, from his Luma Visuals screenshot): every
// job's team chat in ONE place — a conversation list with unread dots and
// last-message previews on the left, the selected job's thread on the right.
// The threads ARE the per-project ProjectMessages that already live on
// /edit/<id>; this page just puts them side by side. Editors see only their
// own jobs (same resolved-editor scoping as the queue); owner/admin see all.
// Opening a thread stamps the viewer's ThreadRead watermark, which is what
// the unread dots and the queue's Messages badge count against.

const fmtDay = (d: Date) =>
  d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

export default async function MessageCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; q?: string }>;
}) {
  await requirePageAccess("editing");
  const { t: selectedId, q } = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;
  if (me?.role === "EDITOR" && !editorScope) {
    return (
      <div>
        <PageHeader eyebrow="Editing Room" title="Messages" />
        <p className="m-4 rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted sm:m-6">
          Your login isn&rsquo;t linked to an editor profile yet — ask Jordan to set your editor key.
        </p>
      </div>
    );
  }

  const { notDone, upcoming, done } = await buildEditorQueue();
  let rows = [...notDone, ...upcoming, ...done];
  if (editorScope) rows = rows.filter((r) => r.editorKey === editorScope);

  const ids = rows.map((r) => r.id);
  const [latestRaw, reads] = await Promise.all([
    ids.length
      ? prisma.projectMessage.findMany({
          where: { projectId: { in: ids } },
          orderBy: { createdAt: "desc" },
          distinct: ["projectId"],
          select: { projectId: true, body: true, authorName: true, createdAt: true },
        })
      : Promise.resolve([]),
    me && ids.length
      ? prisma.threadRead.findMany({ where: { userKey: me.id, projectId: { in: ids } }, select: { projectId: true, seenAt: true } })
      : Promise.resolve([]),
  ]);
  const latest = new Map(latestRaw.map((m) => [m.projectId, m]));
  const seen = new Map(reads.map((r) => [r.projectId, r.seenAt]));

  // Conversations with messages first (newest activity on top), then the rest
  // of the queue in rail order — so a job with no thread yet is still one
  // click from starting one.
  const term = (q ?? "").trim().toLowerCase();
  const list = rows
    .filter((r) => !term || r.street.toLowerCase().includes(term) || r.client.toLowerCase().includes(term))
    .map((r) => {
      const m = latest.get(r.id);
      const s = seen.get(r.id);
      return { ...r, lastMsg: m ?? null, unread: !!m && (!s || m.createdAt > s) };
    })
    .sort((a, b) => {
      if (a.lastMsg && b.lastMsg) return b.lastMsg.createdAt.getTime() - a.lastMsg.createdAt.getTime();
      if (a.lastMsg) return -1;
      if (b.lastMsg) return 1;
      return 0; // keep rail order for message-less jobs
    });

  // The open thread — only a job the viewer's list actually contains (an
  // editor can't open another lane's thread by pasting an id).
  const selected = selectedId ? list.find((r) => r.id === selectedId) ?? null : null;
  let thread: { messages: Awaited<ReturnType<typeof loadThread>>; team: Awaited<ReturnType<typeof getTeam>> } | null = null;
  if (selected) {
    const [messages, team] = await Promise.all([loadThread(selected.id), getTeam()]);
    thread = { messages, team };
    // Stamp the read watermark — but never from a "view as" preview (read-only
    // by contract) and never without a session.
    if (me && !me.impersonating) {
      await prisma.threadRead
        .upsert({
          where: { userKey_projectId: { userKey: me.id, projectId: selected.id } },
          update: { seenAt: new Date() },
          create: { userKey: me.id, projectId: selected.id },
        })
        .catch(() => {});
    }
  }

  const unreadTotal = list.filter((r) => r.unread && r.id !== selected?.id).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        eyebrow="Editing Room"
        title="Messages"
        subtitle={unreadTotal > 0 ? `${unreadTotal} unread conversation${unreadTotal === 1 ? "" : "s"}` : "Every job's team chat, one place"}
        actions={
          <Link href="/editing" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Editing Room
          </Link>
        }
      />
      <div className="mx-auto grid w-full max-w-7xl flex-1 gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(280px,340px)_1fr]">
        {/* CONVERSATION LIST — hidden on mobile while a thread is open. */}
        <div className={cn("min-w-0", selected && "hidden lg:block")}>
          <form method="GET" action="/editing/messages" className="relative mb-3">
            {selected && <input type="hidden" name="t" value={selected.id} />}
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-2" />
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search conversations…"
              className="w-full rounded-xl border border-border bg-surface py-2 pl-8 pr-3 text-sm outline-none focus:border-brand"
            />
          </form>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface">
            {list.length === 0 ? (
              <p className="p-5 text-sm text-muted">{term ? "No jobs match that search." : "No jobs on the queue."}</p>
            ) : (
              <ul className="divide-y divide-border/60">
                {list.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/editing/messages?t=${r.id}${term ? `&q=${encodeURIComponent(q ?? "")}` : ""}`}
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
                          ? `${(r.lastMsg.authorName ?? "Someone").split(" ")[0]}: ${r.lastMsg.body}`
                          : "No messages yet — start the thread."}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* THE THREAD */}
        {selected && thread ? (
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 rounded-t-2xl border border-b-0 border-border bg-surface px-4 py-3">
              <Link href={`/editing/messages${term ? `?q=${encodeURIComponent(q ?? "")}` : ""}`} className="lg:hidden">
                <ArrowLeft className="size-4 text-muted" />
              </Link>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">
                  {selected.street} <span className="font-normal text-muted">({selected.client})</span>
                </div>
                <div className="text-[11px] text-muted-2">{selected.status}</div>
              </div>
              <Link
                href={`/edit/${selected.id}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                Open edit <ExternalLink className="size-3" />
              </Link>
            </div>
            <div className="rounded-b-2xl border border-border bg-surface p-4 sm:p-5">
              <ProjectMessages
                projectId={selected.id}
                team={thread.team.map((m) => ({ id: m.id, name: m.name, avatarColor: m.avatarColor }))}
                messages={thread.messages}
              />
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
    </div>
  );
}

async function loadThread(projectId: string) {
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
