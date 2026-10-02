import Link from "next/link";
import { MessageSquare } from "lucide-react";
import { requirePageAccess } from "@/lib/auth/guards";
import { PageHeader } from "@/components/PageHeader";
import { getCurrentUser } from "@/lib/auth/user";
import { editorScopeOf, isUnmappedEditor } from "@/lib/auth/guards";
import { AddToQueue } from "@/components/editing/AddToQueue";
import { FloatingStyleGuide } from "@/components/editing/FloatingStyleGuide";
import { SimpleQueue, type QueueRow } from "@/components/editing/SimpleQueue";
import { EditorQualityCard } from "@/components/editing/EditorQualityCard";
import { buildEditorQueue, unreadThreadCount, WAITING_ON_INSTRUCTIONS } from "@/lib/editorQueue";
import { editingWorkload, type WorkloadRow } from "@/lib/editorWorkload";
import { WorkloadPanel } from "@/components/editing/WorkloadPanel";
import { RecentlyRemoved } from "@/components/editing/RemoveFromQueue";
import { recentlyRemovedFromQueue } from "@/app/editing/actions";
import { AutoRefresh } from "@/components/ops/AutoRefresh";
import { WorkingNowPanel } from "@/components/editing/WorkingNowPanel";
import { EditingWorkSummary } from "@/components/editing/EditingWorkSummary";
import { EditorDesk } from "@/components/editing/EditorDesk";
import { myDesk, workingNow } from "@/lib/editorWork";
import { editorActivityToday, editorLines, rowEvidence } from "@/lib/editorActivity";
import { prisma } from "@/lib/prisma";
import { isSyntheticClientRow } from "@/lib/testClients";
import { editingQueueHref } from "@/lib/editingQueueUrl";

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
//   · EDITORS TODAY (§7.1, Sep 25; reworded Sep 28): one line per editor
//     above the backlog, re-read every minute. Green = they pressed Start
//     (lib/editorWork, the only thing that says someone is working). Amber =
//     no Start, but they DID something today with their own login — an
//     upload, the review check, a note, a chat message (lib/editorActivity) —
//     shown as evidence, "Last action 12:14pm — uploaded a version of …",
//     never as "working now". Jordan, Sep 28: the old panel said "Kim — Not
//     on anything" beside three of Kim's uploads that morning. The backlog
//     row carries the same evidence under its pill. The editor's own view
//     gets their desk (what they're on + Pause) and, once, "which one are you
//     on right now?" for the jobs the old pill left claimed.

// The door to the message center, with the viewer's unread count.
function MessagesButton({ unread }: { unread: number }) {
  return (
    <Link
      href="/editing/messages"
      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
    >
      <MessageSquare className="size-3.5" />
      Messages
      {unread > 0 && (
        <span className="rounded-full bg-brand px-1.5 text-[10px] font-bold text-white">{unread}</span>
      )}
    </Link>
  );
}

export default async function EditorQueuePage(props: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const { searchParams } = props ?? {};
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
                ? // "in production", not "in the edit": this counts every open
                  // job, and "in the edit" is what the edit page says only
                  // while an editor has pressed Start (§7.1).
                  `${inEdit} of your job${inEdit === 1 ? "" : "s"} still in production — open one to fix what you told the editor`
                : "Nothing of yours in production right now"
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

  // The photographer returned above; every remaining non-editor renders this
  // office queue, including a login with an explicit page-access override.
  // Editors retain their full assigned work and manual desk below.
  const office = me?.role !== "EDITOR";
  const sp = await searchParams ?? {};
  const includeTest = office && sp.test === "1";
  const excludeClientIds = office && !includeTest ? (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((client) => client.id) : [];
  const excludeProjectIds = excludeClientIds.length ? (await prisma.project.findMany({ where: { clientId: { in: excludeClientIds } }, select: { id: true } })).map((project) => project.id) : [];
  const excludedProjects = new Set(excludeProjectIds);
  const scopeParams = new URLSearchParams(Object.entries(sp).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  if (includeTest) scopeParams.delete("test"); else scopeParams.set("test", "1");
  const scopeToggleHref = editingQueueHref(scopeParams);
  const { notDone, upcoming: upcomingRows, done } = await buildEditorQueue({ excludeClientIds });
  // WORKLOAD, NOT A ROW COUNT (R08, Sep 18). The open rows PLUS the upcoming
  // ones, because a job whose footage has not landed is a real thing on the
  // board and the whole point of the lanes is that it is not editing work.
  // A job waiting on the photographer's instructions (O01) is not work the
  // editor can move, so it goes in the lane that says so — the one whose owner
  // is "the photographer or the office, nobody can edit yet" — rather than
  // laneOf's catch-all "Owed to the editor".
  const workloadRows = (rows: QueueRow[]): WorkloadRow[] =>
    rows.map((r) => ({ status: r.status === WAITING_ON_INSTRUCTIONS ? "Waiting" : r.status, editorKey: r.editorKey, editor: r.editor, videos: r.videos, dueISO: r.dueISO, late: r.late }));

  // THE EDITOR'S VIEW — the same table, filtered to rows whose resolved editor
  // (open task → Project.editor → routing rules, exactly what the owner's
  // Editor column shows) is them. Rows are creative-safe by construction: a
  // QueueRow carries no money fields.
  if (me?.role === "EDITOR" && editorScope) {
    const mine = (rows: QueueRow[]) => rows.filter((r) => r.editorKey === editorScope);
    const myNotDone = mine(notDone);
    const myUpcoming = mine(upcomingRows);
    const myDone = mine(done);
    const unread = await unreadThreadCount(me.id, [...myNotDone, ...myUpcoming, ...myDone].map((r) => r.id));
    // THE DESK (§7.1; Jordan, Sep 28: "the working on now button for the
    // editors needs to be clearer"). Always drawn: "What are you working on
    // now?" with one button per job they could be on, or "You're on … since"
    // with Pause and Switch job. Times in the editor's own timezone. A failed
    // read (null) still draws the list, with a line saying the read failed —
    // never an empty desk that reads "nothing". Starting from it is the same
    // §7.1 Start the job page's bar and the row's pill use.
    const desk = await myDesk(editorScope).catch(() => null);
    const { toDeskJobs, deskHeader } = await import("@/lib/editorDesk");
    const { editorMeta, DEFAULT_EDITOR_TZ } = await import("@/lib/editors");
    // "To edit" is work the EDITOR owes and can start — the desk's own list
    // (toDeskJobs), so the header, the desk and the table cannot disagree
    // (Sep 28 review). A cut with the office leaves a job off it only once no
    // video of it is still theirs; a Waiting job (no footage, or no
    // instructions yet — O01) is never on it; a job not handed to them yet is
    // on their list but not counted as something they can start.
    const deskJobs = toDeskJobs(myNotDone, editorScope, desk?.unconfirmed ?? []);
    // THEIR OWN REVIEW RESULTS (§8.4), here where they work — not only behind
    // /quality. Scoped to their assigned key (editorScopeOf, never the login
    // name), so an editor sees their own numbers and examples and no one
    // else's; the team view stays on /quality for James and Jordan. The same
    // 90-day window. A failed read leaves the card off, never a zero.
    const quality = isUnmappedEditor(editorScope)
      ? null
      : await (async () => {
          const { editorQuality } = await import("@/lib/editorQuality");
          const { prisma } = await import("@/lib/prisma");
          const { isSyntheticClientRow } = await import("@/lib/testClients");
          // Match the normal /quality editor results. Test quality remains
          // available in that page's explicit test view; queue ownership is separate.
          const excludeClientIds = (await prisma.client.findMany({ select: { id: true, name: true } }))
            .filter(isSyntheticClientRow).map((client) => client.id);
          const now = new Date();
          return editorQuality({ excludeClientIds, editorKey: editorScope, from: new Date(now.getTime() - 90 * 24 * 3600_000), to: now });
        })().catch(() => null);

    return (
      <div>
        <PageHeader
          eyebrow="Your edits"
          title={`Hi ${(me.name ?? "there").split(" ")[0]}`}
          // Short on purpose (Sep 28): what they owe and what is late. The
          // in-review / waiting / upcoming counts live on the table's tabs.
          subtitle={deskHeader(deskJobs)}
          actions={
            <div className="flex items-center gap-2">
              <MessagesButton unread={unread} />
              <FloatingStyleGuide />
            </div>
          }
        />
        <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
          <EditorDesk
            desk={desk}
            jobs={deskJobs}
            tz={editorMeta(editorScope)?.tz ?? DEFAULT_EDITOR_TZ}
            readOnly={!!me.impersonating}
          />
          {/* No workload panel here any more (Sep 28): its rates and lanes
              were the office's numbers, and its one link ("Offline or stuck?")
              now sits in the desk's footer. */}
          <section aria-labelledby="editing-queue-heading">
            <h2 id="editing-queue-heading" className="mb-3 text-base font-semibold">Your work queue</h2>
            <SimpleQueue notDone={myNotDone} upcoming={myUpcoming} done={myDone} hideEditor />
          </section>
          {quality && <EditorQualityCard report={quality} own />}
        </div>
      </div>
    );
  }

  const unread = await unreadThreadCount(me?.id ?? null, [...notDone, ...upcomingRows, ...done].map((r) => r.id));
  // ONE read time for both halves of "Editors today": what each editor said
  // they're on (Start/Pause) and what they did today (evidence). Neither read
  // throws; each says so when it failed.
  const now = new Date();
  const [wn, act] = await Promise.all([workingNow({ now, excludeProjectIds }), editorActivityToday({ now, excludeProjectIds })]);
  const today = editorLines(wn, act, now);
  const workload = await editingWorkload(workloadRows([...notDone, ...upcomingRows]));
  const capacityNow = Object.values(workload.capacity ?? {}).flatMap((windows) => windows.now);

  return (
    <div>
      <PageHeader
        eyebrow="Video projects only"
        title="Editing Room"
        subtitle={`${notDone.length} open projects · ${upcomingRows.length} upcoming projects · ${includeTest ? "real and test records" : "test records hidden"}`}
        // Pop-up Style Guide — a draggable floating window (remembers where
        // you put it), so the guide can sit beside the queue while working.
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href={scopeToggleHref} className="inline-flex min-h-11 items-center rounded-lg border border-border px-3 text-sm font-medium text-muted hover:bg-surface-2 hover:text-foreground">{includeTest ? "Hide test records" : "Show test records"}</Link>
            <MessagesButton unread={unread} />
            <FloatingStyleGuide />
          </div>
        }
      />
      {/* Wide on purpose — the Slack List is a wide table; max-w-4xl squeezed
          every column into a horizontal scroll. */}
      <div className="mx-auto max-w-7xl space-y-4 p-4 pb-16 sm:p-6">
        {/* EDITORS TODAY (§7.1) — their own Start/Pause, and, when there is
            no Start, what they did today as evidence. Separate from the
            backlog below. The page re-reads every minute while the tab is
            visible; the panel says when it read and says so when that read
            has gone stale or failed. */}
        <AutoRefresh seconds={60} />
        <EditingWorkSummary view={today} />
        {/* THE BACKLOG. Rows click straight through to /edit/<id> — the notes
            (customer + shoot) live there now, not in the table. A row reads
            "In editing" only while somebody has pressed Start on it; a row an
            editor touched today without a Start carries that as evidence
            under its pill ("Kim uploaded a version · 12:14pm"). */}
        <section aria-labelledby="editing-queue-heading">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="editing-queue-heading" className="text-base font-semibold">Work queue</h2>
              <p className="mt-0.5 text-sm text-muted">Open a project for its brief, files and latest cut.</p>
            </div>
            {/* The manual handoff stays available beside its queue. */}
            <div className="contents [&>div]:basis-full"><AddToQueue /></div>
          </div>
          <SimpleQueue notDone={notDone.map((r) => ({ ...r, lastAction: rowEvidence(r, act, now) }))} upcoming={upcomingRows} done={done} />
        </section>
        {/* The undo window for a job taken off the board, made visible. Renders
            nothing when nothing is in it. */}
        <RecentlyRemoved rows={(await recentlyRemovedFromQueue()).filter((row) => !excludedProjects.has(row.projectId))} />
        <details className="group rounded-xl border border-border bg-surface" id="editing-capacity">
          <summary className="min-h-11 cursor-pointer rounded-xl px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-brand">
            <span className="font-semibold">Capacity and activity details</span>
            <span className="text-muted"> · {workload.totals.editing.videos} videos to edit · {workload.overdue} overdue projects</span>
            {capacityNow.length > 0 && <span className="text-warning"> · {capacityNow.length} recorded availability {capacityNow.length === 1 ? "change" : "changes"} in force</span>}
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            <p className="text-sm text-muted">Project workload follows the record view above. Team availability is shared across both views.</p>
            <WorkloadPanel view={workload} />
            <WorkingNowPanel view={today} />
          </div>
        </details>
      </div>
    </div>
  );
}
