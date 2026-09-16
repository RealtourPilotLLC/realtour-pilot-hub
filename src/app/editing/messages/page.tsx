import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { TeamMessagesPanel, loadTeamChat } from "@/components/comms/TeamMessagesPanel";

export const dynamic = "force-dynamic";

// The message center (Jordan, Aug 27, from his Luma Visuals screenshot): every
// job's team chat in ONE place — a conversation list with unread dots and
// last-message previews on the left, the selected job's thread on the right.
//
// Sep 16 (Kyle call): this page and Communications → Team were two different
// screens for the same conversations — this one a two-pane centre listing only
// video-queue jobs, Kyle's one a flat 40-row stream whose links landed on the
// top of the project page. They are now ONE implementation
// (loadTeamChat + TeamMessagesPanel, src/components/comms/TeamMessagesPanel.tsx);
// each page keeps its own header, its own base URL and its own jump-out button.
// What changes here: an editor still sees their own lane and nothing else, but
// the office opening the Editing Room's Messages button now gets every job
// with a thread — photo-only jobs included, which never appeared before — plus
// every job in flight. Reading a thread stamps the same ThreadRead watermark
// /projects/<id> and /edit/<id> stamp, so a thread read anywhere is read
// everywhere; "Close conversation" folds a finished one away until someone
// posts again.

export default async function MessageCenterPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string; q?: string }>;
}) {
  await requirePageAccess("editing");
  const { t: selectedId, q } = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;
  // Fail CLOSED for an editor whose scope can't resolve — a null scope would
  // read as "the office" below and hand them every lane's threads.
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

  const chat = await loadTeamChat({
    scope: editorScope ? { kind: "editor", editorKey: editorScope } : { kind: "office" },
    viewer: me ? { id: me.id, impersonating: !!me.impersonating } : null,
    selectedId,
    q,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        eyebrow="Editing Room"
        title="Messages"
        subtitle={
          chat.unreadTotal > 0
            ? `${chat.unreadTotal} unread conversation${chat.unreadTotal === 1 ? "" : "s"}`
            : "Every job's team chat, one place"
        }
        actions={
          <Link href="/editing" className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            <ArrowLeft className="size-3.5" /> Editing Room
          </Link>
        }
      />
      <div className="flex-1 p-4 sm:p-6">
        <TeamMessagesPanel
          data={chat}
          base={{ pathname: "/editing/messages" }}
          open={{ pathname: "/edit", label: "Open edit" }}
          readOnly={!!me?.impersonating}
        />
      </div>
    </div>
  );
}
