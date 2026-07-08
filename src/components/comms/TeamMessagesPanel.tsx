import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { MessagesSquare, Phone, Reply, Users } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { Avatar } from "@/components/ui/Avatar";

// Team tab for the Communications hub: every project's message thread in one
// stream, newest first. Read-only here on purpose — posting/replying lives on
// the project page (ProjectMessages has the composer, @mentions, and reply
// wiring), so each row just deep-links there.
const THREAD_CAP = 40;

export async function TeamMessagesPanel() {
  // Threads = root messages (replies hang off replyToId); pulling roots + a
  // reply count keeps this one cheap query instead of re-assembling trees.
  const roots = await prisma.projectMessage.findMany({
    where: { replyToId: null },
    orderBy: { createdAt: "desc" },
    take: THREAD_CAP,
    select: {
      id: true,
      authorName: true,
      body: true,
      createdAt: true,
      project: { select: { id: true, title: true, client: { select: { name: true } } } },
      _count: { select: { replies: true } },
    },
  });

  // Author avatar colors come from the roster — one lookup keyed by name
  // (ProjectMessage stores authorName denormalized, so name is the join).
  const team = await prisma.teamMember.findMany({ select: { name: true, avatarColor: true } });
  const colorFor = new Map(team.map((t) => [t.name, t.avatarColor]));

  return (
    <div className="space-y-3">
      {/* There's no dedicated team-texting surface yet — the Team directory has
          everyone's number, so point people there instead of a dead end. */}
      <Link
        href="/team"
        className="flex items-center gap-2 rounded-2xl border bg-surface px-4 py-2.5 text-sm text-muted hover:bg-surface-2"
      >
        <Phone className="size-3.5 text-muted-2" />
        Need to text a teammate? Numbers are in the <span className="font-medium text-brand">Team directory</span>.
      </Link>

      {roots.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-surface p-8 text-center">
          <MessagesSquare className="mx-auto mb-2 size-6 text-muted-2" />
          <p className="text-sm text-muted">
            No team messages yet. Start one from any project page — it&apos;ll show up here.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-surface">
          {roots.map((m) => (
            <Link
              key={m.id}
              // The project page hosts the composer; no #anchor exists for the
              // messages section, so land on the page itself.
              href={`/projects/${m.project.id}`}
              className="flex items-center gap-3 border-b px-5 py-3 last:border-0 hover:bg-surface-2"
            >
              <Avatar name={m.authorName ?? "?"} size={36} color={colorFor.get(m.authorName ?? "") ?? "#64748b"} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{m.authorName ?? "Team"}</span>
                  <span className="hidden truncate rounded bg-brand-soft px-1.5 text-[10px] font-medium text-brand sm:inline">
                    {m.project.title}
                  </span>
                  <span className="hidden shrink-0 items-center gap-0.5 rounded bg-surface-2 px-1.5 text-[10px] font-medium text-muted sm:inline-flex">
                    <Users className="size-2.5" /> {m.project.client.name}
                  </span>
                </div>
                <div className="truncate text-xs text-muted">{m.body}</div>
              </div>
              {m._count.replies > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-muted">
                  <Reply className="size-2.5" /> {m._count.replies}
                </span>
              )}
              <span className="shrink-0 text-xs text-muted-2">
                {formatDistanceToNow(m.createdAt, { addSuffix: true })}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
