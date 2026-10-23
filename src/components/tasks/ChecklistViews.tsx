import type { ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { revisionsBoard, slackBoard } from "@/lib/commsBoard";
import { getCurrentUser } from "@/lib/auth/user";
import { scrubMoney } from "@/lib/text";
import { SlackDoneButton, NotNeededButton, SlackAssignPicker } from "@/components/tasks/ChecklistButtons";
import type { SlackTaskRow } from "@/lib/commsBoard";
import { etTime } from "@/lib/datetime";
import { TaskFocus } from "@/components/queue/TaskFocus";

// No money on an ADMIN screen (Jordan's standing rule): a Slack to-do's title
// or a client's revision ask can carry a dollar figure, and for a non-owner it
// is redacted before it renders (audit5 kyle-home §5, Sep 8): only the figure
// goes, the sentence stays. Sessionless = owner, the same rule the home
// applies.
async function moneyScrubber(): Promise<(s: string) => string> {
  const me = await getCurrentUser().catch(() => null);
  return !me || me.role === "OWNER" ? (s) => s : scrubMoney;
}

// ---------------------------------------------------------------------------
// The Checklist tabs (Jordan, Sep 1): Revisions (grouped by requester) and
// Slack to-dos. Rows clear themselves when a delivery is detected; the tick is
// the manual override for things handled outside the hub. (The Replies tab,
// Comms, was unreachable once Messages took it over and was removed on Oct 21
// 2026, audit F15: clients are answered on Messages.)
// ---------------------------------------------------------------------------

function Shell({ tabs, title, subtitle, children }: { tabs: ReactNode; title: string; subtitle: string; children: ReactNode }) {
  return (
    <div>
      <PageHeader eyebrow="Tasks" title={title} subtitle={subtitle} />
      <div className="mx-auto max-w-4xl p-4 pb-16 sm:p-6">
        {tabs}
        {children}
      </div>
    </div>
  );
}

// ---------------- REVISIONS ----------------

export async function RevisionsView({ tabs, excludeClientIds = [], showTest = false }: { tabs: ReactNode; excludeClientIds?: string[]; showTest?: boolean }) {
  const [groups, scrub] = await Promise.all([revisionsBoard(new Date(), { excludeClientIds }), moneyScrubber()]);
  return (
    <Shell tabs={tabs} title="Revisions" subtitle={`${showTest ? "Every open revision" : "Open revisions for real clients"}, grouped by who asked. A row clears itself when the corrected work is delivered.`}>
      {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
      {groups.length === 0 ? (
        <p className="flex items-center gap-2 rounded-2xl border border-success/20 bg-success/[0.05] px-5 py-4 text-[15px] text-success">
          <CheckCircle2 className="size-5" /> No revisions in flight.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.clientId ?? "none"} className="panel-shadow rounded-2xl border bg-surface p-4">
              <div className="flex items-center gap-2.5">
                <Avatar name={g.clientName} color={nameColor(g.clientName)} size={32} />
                <span className="text-[15px] font-semibold">{g.clientName}</span>
              </div>
              <div className="mt-2.5 space-y-2.5 border-t border-border pt-2.5">
                {g.jobs.map((j) => (
                  <Link key={j.projectId} href={`/edit/${j.projectId}`} className="block rounded-xl border border-border px-3.5 py-2.5 transition-colors hover:bg-surface-2/60">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{j.title}</span>
                      {j.editor && <span className="shrink-0 text-xs text-muted">→ {j.editor}</span>}
                      <span className={cn("shrink-0 text-xs", j.ageDays >= 2 ? "font-semibold text-danger" : "text-muted")}>{j.ageDays}d</span>
                    </div>
                    {(j.headline || j.note) && (
                      <p className="mt-1 text-[13px] text-foreground/80">
                        <span className="font-medium">The ask:</span> {scrub((j.headline ?? j.note ?? "").slice(0, 180))}
                      </p>
                    )}
                    {j.itemsTotal > 0 && (
                      <p className="mt-0.5 text-xs text-muted">{j.itemsDone} of {j.itemsTotal} work-order items done</p>
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

// ---------------- SLACK ----------------

// THE SLACK ASKS PAGE (Kyle's call, Sep 16: "the Slack reminders are hard to
// find, and you can't tell what they're about"). One sequential list — the
// unassigned at the top, then oldest first — and every row now says who asked,
// who it is for, which client and which property, what was actually said (with
// a link straight back into Slack) and what the required action is. Two ways
// to clear it: Done ✓ when it happened, "Not needed" when it didn't and won't.
export async function SlackView({ tabs, focusTaskId, excludeClientIds, showTest = false }: { tabs: ReactNode; focusTaskId?: string | null; excludeClientIds?: string[]; showTest?: boolean }) {
  const { listAssignees } = await import("@/lib/assignees");
  const [board, scrub, assignees] = await Promise.all([
    slackBoard(new Date(), { withPermalinks: true, excludeClientIds, focusTaskId }),
    moneyScrubber(),
    listAssignees().catch(() => []),
  ]);
  const assignOptions = assignees.map((a) => ({ key: a.key, name: a.name }));
  const rows = board.rows.map((t) => ({
    ...t,
    title: scrub(t.title),
    summary: t.summary == null ? t.summary : scrub(t.summary),
    quote: t.quote == null ? t.quote : scrub(t.quote),
  }));
  // The counts describe the rows ON THE PAGE, except `total`, which is every
  // open ask counted in SQL. When the page can't hold them all it says so
  // rather than quoting a capped list as the whole pile (review, Sep 16).
  const sub =
    board.total === 0
      ? "Action items parsed from Slack — assign, do, or tick them off."
      : `${board.total} open${board.capped ? ` · showing ${rows.length}` : ""}${board.unassignedCount ? ` · ${board.unassignedCount} still need assigning` : ""}${board.overdueCount ? ` · ${board.overdueCount} overdue` : ""}. Unassigned and oldest first.`;
  return (
    <Shell tabs={tabs} title="Slack asks" subtitle={sub}>
      {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
      {(showTest || focusTaskId) && <p className="mb-3 text-xs text-muted">{showTest ? "Showing real and test records" : "Real client work and the linked ask"}</p>}
      {rows.length === 0 ? (
        <p className="flex items-center gap-2 rounded-2xl border border-success/20 bg-success/[0.05] px-5 py-4 text-[15px] text-success">
          <CheckCircle2 className="size-5" /> Slack is clear.
        </p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((t) => <SlackRow key={t.taskId} t={t} focused={t.taskId === focusTaskId} assignOptions={assignOptions} />)}
        </div>
      )}
      <p className="mt-4 text-xs text-muted-2">
        A Slack ask closes itself a week after it arrives, and whoever it is assigned to gets a
        &ldquo;still needed?&rdquo; reminder in the hub the day before.
      </p>
      {/* ?task=<id> from a Slack digest line: scroll to the row and flash it. */}
      <TaskFocus />
    </Shell>
  );
}

function SlackRow({ t, focused, assignOptions }: { t: SlackTaskRow; focused?: boolean; assignOptions: { key: string; name: string }[] }) {
  const who = [t.askedBy, t.forWhom].filter(Boolean);
  const context = [t.clientName, t.propertyAddress?.split(",")[0]?.trim()].filter(Boolean);
  return (
    <div
      id={`task-${t.taskId}`}
      className={cn(
        "scroll-mt-24 rounded-2xl border bg-surface px-4 py-3",
        focused ? "border-brand ring-2 ring-brand/30" : !t.assignedKey ? "border-brand/40" : "border-border",
      )}
    >
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-64">
          {/* WHO → WHO, then the client and the property: the four facts that
              tell Kyle whether this row is his problem before he reads it. */}
          <p className="text-[11px] font-medium text-muted-2">
            {who.length === 2 ? `${who[0]} → ${who[1]}` : who[0] ?? "Slack"}
            {!t.assignedKey && <span className="ml-1.5 font-bold uppercase tracking-wide text-brand">needs assigning</span>}
            {context.length > 0 && <span> · {context.join(" · ")}</span>}
          </p>
          <p className="mt-0.5 text-sm font-medium leading-snug">{t.title}</p>
          {t.summary && t.summary !== t.title && (
            <p className="mt-0.5 text-[13px] text-muted">{t.summary.slice(0, 220)}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <span className={cn("text-xs", t.overdue ? "font-semibold text-danger" : "text-muted")}>
            {t.dueISO ? (t.overdue ? "overdue" : `due ${etTime(new Date(t.dueISO))}`) : "no date"} · {t.ageDays}d old
          </span>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {!t.assignedKey && <SlackAssignPicker taskId={t.taskId} options={assignOptions} />}
            <SlackDoneButton taskId={t.taskId} />
            <NotNeededButton taskId={t.taskId} />
          </div>
        </div>
      </div>
      {(t.quote || t.permalink) && (
        <details className="group/q mt-2 border-t border-border pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-2 hover:text-foreground">
            They said
          </summary>
          {t.quote && (
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-foreground/80">
              &ldquo;{t.quote.slice(0, 900)}&rdquo;
            </p>
          )}
          {t.permalink && (
            <a
              href={t.permalink}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
            >
              <ExternalLink className="size-3.5" /> Open in Slack
            </a>
          )}
        </details>
      )}
      {t.projectId && (
        <Link href={`/projects/${t.projectId}`} className="mt-1.5 inline-block text-xs font-medium text-brand hover:underline">
          Open the job
        </Link>
      )}
    </div>
  );
}

// Tab-badge counts, shared with the page so the badges match the tabs.
export async function checklistCounts(opts: { excludeRevisionClientIds?: string[]; excludeSlackClientIds?: string[] } = {}): Promise<{ revisions: number; slack: number }> {
  const [revs, slack] = await Promise.all([
    revisionsBoard(new Date(), { excludeClientIds: opts.excludeRevisionClientIds }),
    slackBoard(new Date(), { excludeClientIds: opts.excludeSlackClientIds }),
  ]);
  return {
    revisions: revs.reduce((s, g) => s + g.jobs.length, 0),
    slack: slack.total,
  };
}
