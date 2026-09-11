import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { slugForName } from "@/lib/assignees";
import { AddToQueue } from "@/components/editing/AddToQueue";
import { FloatingStyleGuide } from "@/components/editing/FloatingStyleGuide";
import { SimpleQueue, type QueueRow } from "@/components/editing/SimpleQueue";
import { buildEditorQueue, unreadThreadCount } from "@/lib/editorQueue";

export const dynamic = "force-dynamic";

// The Editor dashboard is VIDEO-ONLY — photos are edited by AI, so editors only
// touch video/reel jobs. Shown to users as the "Editing Room" (Jordan, Sep 2) —
// the /editing route, `editing` PageKey and editorQueue.ts names are unchanged.
//   · OWNER / ADMIN → the Slack-tracker view, rebuilt in-hub (Jordan: "make
//     this editor queue as simple as possible … I really like the way we have
//     it set up in Slack"): Queue | Upcoming edits | Delivered, one row per
//     job. The old SLA-panel + tracker-spreadsheet stack is gone — per-job
//     controls (reassign, review, chat) live on /edit/<id>.
//   · EDITOR (Kim / John Mark) → the SAME queue (Jordan, Aug 27: "I want them
//     to see the same queue I do, just with the jobs assigned to them and no
//     editor section"), scoped to rows whose resolved editor is them. Their
//     pings stay in the bell (Jordan, Aug 27: no For-you card here). The old
//     bespoke EditorDay worklist is gone.
// Row building lives in src/lib/editorQueue.ts, shared with the message center.

// The door to the message center, with the viewer's unread count.
function MessagesButton({ unread }: { unread: number }) {
  return (
    <Link
      href="/editing/messages"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface-2 hover:text-foreground"
    >
      <MessageSquare className="size-3.5" />
      Messages
      {unread > 0 && (
        <span className="rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">{unread}</span>
      )}
    </Link>
  );
}

export default async function EditorQueuePage() {
  await requirePageAccess("editing");
  const me = await getCurrentUser().catch(() => null);
  const editorScope = me?.role === "EDITOR" ? (me.editorKey || (me.name ? slugForName(me.name) : null)) : null;

  // An EDITOR whose login has no editorKey AND no name can't be scoped — fail
  // closed with a nudge, never fall through to the all-jobs view below.
  if (me?.role === "EDITOR" && !editorScope) {
    return (
      <div>
        <PageHeader eyebrow="Video projects only" title="Editing Room" />
        <p className="m-4 rounded-2xl border border-dashed border-border bg-surface p-6 text-sm text-muted sm:m-6">
          Your login isn&rsquo;t linked to an editor profile yet — ask Jordan to set your editor key and your
          queue will show up here.
        </p>
      </div>
    );
  }

  const { notDone, upcoming: upcomingRows, done } = await buildEditorQueue();

  // THE EDITOR'S VIEW — the same table, filtered to rows whose resolved editor
  // (open task → Project.editor → routing rules, exactly what the owner's
  // Editor column shows) is them. Rows are creative-safe by construction: a
  // QueueRow carries no money fields.
  if (me?.role === "EDITOR" && editorScope) {
    const mine = (rows: QueueRow[]) => rows.filter((r) => r.editorKey === editorScope);
    const myNotDone = mine(notDone);
    const myUpcoming = mine(upcomingRows);
    const myDone = mine(done);
    // "To edit" is work the EDITOR owes. A cut already sitting in the Review
    // Room (or approved and waiting on delivery) is on Jordan, not on Kim — now
    // that the row labels tell the truth (Sep 2 audit), the header has to as
    // well, or the count re-tells the same lie one line higher up.
    const WAITING_ON_US = new Set(["Ready for review", "Approved"]);
    // A Waiting row is not work either (Sep 11 review): the footage is not
    // in — the office is holding the job there, or the photographer has not
    // submitted — so it is counted on its own, never as "to edit".
    const myWaiting = myNotDone.filter((r) => r.status === "Waiting");
    const myToEdit = myNotDone.filter((r) => !WAITING_ON_US.has(r.status) && r.status !== "Waiting");
    const inReview = myNotDone.length - myToEdit.length - myWaiting.length;
    const overdue = myToEdit.filter((r) => r.late).length;
    const waitingNote = myWaiting.length ? ` · ${myWaiting.length} waiting on footage` : "";
    const unread = await unreadThreadCount(me.id, [...myNotDone, ...myUpcoming, ...myDone].map((r) => r.id));

    return (
      <div>
        <PageHeader
          eyebrow="Your edits"
          title={`Hi ${(me.name ?? "there").split(" ")[0]}`}
          subtitle={
            myToEdit.length
              ? `${myToEdit.length} to edit${overdue ? ` · ${overdue} overdue` : ""}${inReview ? ` · ${inReview} in review` : ""}${waitingNote} · ${myUpcoming.length} upcoming`
              : inReview || myWaiting.length
                ? `Nothing to edit${inReview ? ` · ${inReview} waiting on review` : ""}${waitingNote} · ${myUpcoming.length} upcoming`
                : "Nothing waiting — you're all caught up."
          }
          actions={
            <div className="flex items-center gap-2">
              <MessagesButton unread={unread} />
              <FloatingStyleGuide />
            </div>
          }
        />
        <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
          <SimpleQueue notDone={myNotDone} upcoming={myUpcoming} done={myDone} hideEditor />
        </div>
      </div>
    );
  }

  const unread = await unreadThreadCount(me?.id ?? null, [...notDone, ...upcomingRows, ...done].map((r) => r.id));

  return (
    <div>
      <PageHeader
        eyebrow="Video projects only"
        title="Editing Room"
        subtitle={`${notDone.length} open · ${upcomingRows.length} upcoming`}
        // Pop-up Style Guide — a draggable floating window (remembers where
        // you put it), so the guide can sit beside the queue while working.
        actions={
          <div className="flex items-center gap-2">
            <MessagesButton unread={unread} />
            <FloatingStyleGuide />
          </div>
        }
      />
      {/* Wide on purpose — the Slack List is a wide table; max-w-4xl squeezed
          every column into a horizontal scroll. */}
      <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
        {/* Manual add — the human override for jobs the automatic handoff never
            picks up (video added after booking, old footage, non-Aryeo work). */}
        <AddToQueue />
        {/* Rows click straight through to /edit/<id> — the notes (customer +
            shoot) live there now, not in the table. */}
        <SimpleQueue notDone={notDone} upcoming={upcomingRows} done={done} />
      </div>
    </div>
  );
}
