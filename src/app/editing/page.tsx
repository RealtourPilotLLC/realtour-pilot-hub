import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { editorScopeOf } from "@/lib/auth/guards";
import { AddToQueue } from "@/components/editing/AddToQueue";
import { FloatingStyleGuide } from "@/components/editing/FloatingStyleGuide";
import { SimpleQueue, type QueueRow } from "@/components/editing/SimpleQueue";
import { buildEditorQueue, unreadThreadCount, WAITING_ON_OFFICE } from "@/lib/editorQueue";
import { editingWorkload, type WorkloadRow } from "@/lib/editorWorkload";
import { WorkloadPanel } from "@/components/editing/WorkloadPanel";
import { RecentlyRemoved } from "@/components/editing/RemoveFromQueue";
import { recentlyRemovedFromQueue } from "@/app/editing/actions";

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
//   · THE OVERRIDE (Jordan, Sep 13: "I want to be able to override anything")
//     lives on the row itself (SimpleQueue → EditOverridesDialog): the
//     sliders glyph beside the status pill, office only — the editor's scoped
//     view (hideEditor) never renders it, and the server refuses it anyway.
//     Row values arrive from editorQueue.ts AFTER overrides, so the counts in
//     the editor's header line below already honour them.

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
  // ONE ANSWER, NOT A THIRD COPY (review, Sep 18). This page had its own
  // name-slug fallback, so it disagreed with editorScopeOf — which fails closed
  // for an unlinked editor — and handed the Editing Room rows the guard would
  // have refused. editorScopeOf is the answer; isUnmappedEditor is how a page
  // tells "no scope" from "not an editor".
  const editorScope = editorScopeOf(me);

  // THE PHOTOGRAPHER'S VIEW (Jordan, Sep 18: "They should also see the editing
  // room and be able to make changes to their notes or instructions, but not
  // full control like I do or Kyle does"). It returns before the workload
  // panel, the message counts and the office's SimpleQueue are built for them
  // at all — a photographer must not receive the whole company's board and
  // have the markup decide what to draw. Their own board, and the only
  // writable thing on it, live in PhotographerJobs.
  //
  // It does NOT skip buildEditorQueue (this comment claimed it did, review Sep
  // 18): photographerEditingBoard calls it on the server to reuse the status
  // ladder, then keeps only the rows this person shot and only the fields the
  // type above can hold. Nothing that is not theirs crosses to the browser —
  // which is the guarantee that matters — but the office query does run.
  if (me?.role === "PHOTOGRAPHER") {
    const { photographerMemberId } = await import("@/lib/shoot");
    const mid = await photographerMemberId(me).catch(() => null);
    const { PhotographerJobs } = await import("@/components/editing/PhotographerJobs");
    // No roster row = nothing can say which jobs are theirs. Fail closed with
    // a nudge, exactly as an unmapped editor does below, rather than falling
    // through to the office view.
    const jobs = mid ? await (await import("@/lib/photographerEditing")).photographerEditingBoard(mid) : [];
    const inEdit = jobs.filter((j) => j.rail === "open").length;
    return (
      <div>
        <PageHeader
          eyebrow="Your shoots, after the shoot"
          title="Editing Room"
          subtitle={
            !mid
              ? "Your login isn't linked to a roster profile yet — ask Jordan or Kyle to finish it."
              : inEdit
                ? `${inEdit} of your job${inEdit === 1 ? "" : "s"} in the edit — open one to fix what you told the editor`
                : "Nothing of yours in the edit right now"
          }
        />
        <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16 sm:p-6">
          {mid && <PhotographerJobs jobs={jobs} />}
        </div>
      </div>
    );
  }

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
  // WORKLOAD, NOT A ROW COUNT (R08, Sep 18). The open rows PLUS the upcoming
  // ones, because a job whose footage has not landed is a real thing on the
  // board and the whole point of the lanes is that it is not editing work.
  const workloadRows = (rows: QueueRow[]): WorkloadRow[] =>
    rows.map((r) => ({ status: r.status, editorKey: r.editorKey, editor: r.editor, videos: r.videos, dueISO: r.dueISO, late: r.late }));

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
    const WAITING_ON_US = WAITING_ON_OFFICE;
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
          <WorkloadPanel view={await editingWorkload(workloadRows([...myNotDone, ...myUpcoming]))} mine />
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
        {/* Whose desk each job is on, and whether the person it is on can
            actually move it. See lib/editorWorkload for why there is not a
            single invented hour in it. */}
        <WorkloadPanel view={await editingWorkload(workloadRows([...notDone, ...upcomingRows]))} />
        {/* Rows click straight through to /edit/<id> — the notes (customer +
            shoot) live there now, not in the table. */}
        <SimpleQueue notDone={notDone} upcoming={upcomingRows} done={done} />
        {/* The undo window for a job taken off the board, made visible. Renders
            nothing when nothing is in it. */}
        <RecentlyRemoved rows={await recentlyRemovedFromQueue()} />
      </div>
    </div>
  );
}
