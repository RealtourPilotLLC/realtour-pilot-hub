import type { ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, ExternalLink, Mail, Phone, Star } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { unansweredCommsBoard, revisionsBoard, slackBoard } from "@/lib/commsBoard";
import { getCurrentUser } from "@/lib/auth/user";
import { scrubMoney } from "@/lib/text";
import { HandledButton, SlackDoneButton, NotNeededButton, SlackAssignPicker } from "@/components/tasks/ChecklistButtons";
import type { SlackTaskRow } from "@/lib/commsBoard";
import { etTime } from "@/lib/datetime";
import { TaskFocus } from "@/components/queue/TaskFocus";

// No money on an ADMIN screen (Jordan's standing rule): a Slack to-do's title,
// a client's revision ask, or the message a client is waiting on can carry a
// dollar figure, and for a non-owner it is redacted before it renders (audit5
// kyle-home §5, Sep 8). The Comms tab's message bodies go through the same
// scrub as the home's previews of the same rows (review, Sep 8 — "no money
// anywhere"): only the figure goes, the sentence stays, so Kyle can still
// answer. If Jordan wants client-quoted figures visible here, drop the three
// scrub() wraps in CommsView. Sessionless = owner, the same rule the home
// applies.
async function moneyScrubber(): Promise<(s: string) => string> {
  const me = await getCurrentUser().catch(() => null);
  return !me || me.role === "OWNER" ? (s) => s : scrubMoney;
}

// ---------------------------------------------------------------------------
// The Comms Checklist tabs (Jordan, Sep 1): Comms (Phone | Email, grouped by
// sender), Revisions (grouped by requester), Slack to-dos. Rows clear
// themselves when a reply/delivery is detected; the tick is the manual
// override for things handled outside the hub.
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

// ---------------- COMMS ----------------

export async function CommsView({ tabs, channel }: { tabs: ReactNode; channel: "phone" | "email" }) {
  const [phone, email, scrub] = await Promise.all([unansweredCommsBoard("phone"), unansweredCommsBoard("email"), moneyScrubber()]);
  const groups = channel === "phone" ? phone : email;
  const sub = "Everything still owed an answer, grouped by who's waiting. Rows clear on their own when a reply goes out — tick only what you handled outside the hub.";
  return (
    <Shell tabs={tabs} title="Unanswered Comms" subtitle={sub}>
      <div className="mb-4 flex gap-1.5">
        <Link href="/tasks?tab=comms" className={channel === "phone" ? subActive : subIdle}>
          <Phone className="mr-1.5 inline size-3.5" />Phone {phone.length > 0 && <b className="ml-1">{phone.length}</b>}
        </Link>
        <Link href="/tasks?tab=comms&via=email" className={channel === "email" ? subActive : subIdle}>
          <Mail className="mr-1.5 inline size-3.5" />Email {email.length > 0 && <b className="ml-1">{email.length}</b>}
        </Link>
      </div>
      {groups.length === 0 ? (
        <p className="flex items-center gap-2 rounded-2xl border border-success/20 bg-success/[0.05] px-5 py-4 text-[15px] text-success">
          <CheckCircle2 className="size-5" /> Nobody is waiting on a {channel === "phone" ? "text" : "email"} reply.
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={g.groupKey} className="panel-shadow rounded-2xl border bg-surface p-4">
              <div className="flex items-center gap-2.5">
                <Avatar name={g.clientName} color={nameColor(g.clientName)} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[15px] font-semibold">{g.clientName}</span>
                    {g.isVip && <Star className="size-3.5 shrink-0 text-warning" />}
                  </div>
                  <p className={cn("text-xs", g.oldestHours >= 24 ? "font-semibold text-danger" : "text-muted")}>
                    waiting {g.oldestHours >= 24 ? `${Math.floor(g.oldestHours / 24)}d ${g.oldestHours % 24}h` : `${g.oldestHours}h`}
                  </p>
                </div>
                <Link
                  href={`/communications?tab=replies`}
                  className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
                >
                  Reply
                </Link>
                <HandledButton clientId={g.clientId} family={channel} groupKey={g.groupKey} />
              </div>
              <div className="mt-2.5 space-y-2.5 border-t border-border pt-2.5">
                {g.items.map((i, idx) =>
                  channel === "email" ? (
                    <div key={idx} className="text-sm">
                      <p className="font-semibold text-foreground">
                        {i.subject ? scrub(i.subject) : "(no subject)"}
                        <span className="ml-2 font-normal text-muted-2">{i.ageHours}h ago</span>
                      </p>
                      {i.body && <p className="mt-0.5 whitespace-pre-wrap text-foreground/80">{scrub(i.body)}</p>}
                    </div>
                  ) : (
                    <p key={idx} className="text-sm text-foreground/85">
                      <span className="text-muted-2">{i.ageHours}h ago · </span>
                      &ldquo;{scrub(i.snippet)}&rdquo;
                    </p>
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Shell>
  );
}

const subActive = "rounded-lg bg-surface-2 px-3 py-1.5 text-sm font-semibold ring-1 ring-border";
const subIdle = "rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:bg-surface-2";

// ---------------- REVISIONS ----------------

export async function RevisionsView({ tabs }: { tabs: ReactNode }) {
  const [groups, scrub] = await Promise.all([revisionsBoard(), moneyScrubber()]);
  return (
    <Shell tabs={tabs} title="Revisions" subtitle="Every open revision, grouped by who asked. A row clears itself when the corrected work is delivered.">
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
export async function SlackView({ tabs, focusTaskId }: { tabs: ReactNode; focusTaskId?: string | null }) {
  const { listAssignees } = await import("@/lib/assignees");
  const [board, scrub, assignees] = await Promise.all([
    slackBoard(new Date(), { withPermalinks: true }),
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
      : `${board.total} open${board.capped ? ` · showing the oldest ${rows.length}` : ""}${board.unassignedCount ? ` · ${board.unassignedCount} still need assigning` : ""}${board.overdueCount ? ` · ${board.overdueCount} overdue` : ""}. Oldest first.`;
  return (
    <Shell tabs={tabs} title="Slack asks" subtitle={sub}>
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
export async function checklistCounts(): Promise<{ comms: number; revisions: number; slack: number }> {
  const [phone, email, revs, slack] = await Promise.all([
    unansweredCommsBoard("phone"),
    unansweredCommsBoard("email"),
    revisionsBoard(),
    slackBoard(),
  ]);
  return {
    comms: phone.length + email.length,
    revisions: revs.reduce((s, g) => s + g.jobs.length, 0),
    slack: slack.total,
  };
}
