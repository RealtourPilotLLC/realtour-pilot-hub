import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { editorScopeOf, isUnmappedEditor, requirePageAccess, UNMAPPED_EDITOR_MESSAGE } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
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
  searchParams: Promise<{ t?: string; q?: string; view?: string }>;
}) {
  await requirePageAccess("editing");
  const { t: selectedId, q, view } = await searchParams;
  const me = await getCurrentUser().catch(() => null);
  // A PHOTOGRAPHER holds the `editing` key from Sep 18 (their read-only board
  // of jobs they shot) and this page rides the SAME key. They must never fall
  // into the office branch below, which hands out every lane's threads. Until
  // Oct 28 2026 they were sent away; now this is their message center too
  // (Jordan: "a team messages channel so all team members can message"): the
  // team channel and the threads of THEIR OWN shoots (the shoot screen's
  // ownership rule), opening to /shoot/<id>. The messages icon is their door.
  const photographer = me?.role === "PHOTOGRAPHER";
  const photographerId = photographer ? await (await import("@/lib/shoot")).photographerMemberId(me).catch(() => null) : null;
  // The one editor scope (guards.editorScopeOf): an assigned editorKey or the
  // fail-closed sentinel. Oct 20 2026 (audit B2): this page used to rebuild it
  // with the first-name fallback the Sep 17 audit removed, so an unlinked
  // EDITOR could read another editor's threads by sharing a first name.
  const editorScope = editorScopeOf(me);
  // Fail CLOSED for an editor whose scope can't resolve — a null scope would
  // read as "the office" below and hand them every lane's threads. They still
  // get the team channel (Oct 28 2026), which is every login's.
  const unmapped = me?.role === "EDITOR" && (!editorScope || isUnmappedEditor(editorScope));

  const chat = await loadTeamChat({
    scope: photographer
      ? photographerId ? { kind: "photographer", memberId: photographerId } : { kind: "channel" }
      : unmapped ? { kind: "channel" }
      : editorScope ? { kind: "editor", editorKey: editorScope } : { kind: "office" },
    viewer: me ? { id: me.id, teamMemberId: me.teamMemberId, impersonating: !!me.impersonating } : null,
    selectedId,
    q,
    view,
    user: me,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        eyebrow={photographer ? "Team" : "Editing Room"}
        title="Messages"
        subtitle={
          chat.unreadTotal > 0
            ? `${chat.unreadTotal} unread conversation${chat.unreadTotal === 1 ? "" : "s"}`
            : photographer ? "The team channel and your shoots' threads" : "The team channel and every job's team chat, one place"
        }
        actions={
          <Link href={photographer ? "/shoot" : "/editing"} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground">
            <ArrowLeft className="size-3.5" /> {photographer ? "My Shoots" : "Editing Room"}
          </Link>
        }
      />
      <div className="flex-1 p-4 sm:p-6">
        {unmapped && (
          <p className="mb-4 rounded-2xl border border-dashed border-border bg-surface p-4 text-sm text-muted">
            {UNMAPPED_EDITOR_MESSAGE} Until then you have the team channel.
          </p>
        )}
        <TeamMessagesPanel
          data={chat}
          base={{ pathname: "/editing/messages" }}
          open={photographer ? { pathname: "/shoot", label: "Open the shoot" } : { pathname: "/edit", label: "Open edit" }}
          readOnly={!!me?.impersonating}
        />
      </div>
    </div>
  );
}
