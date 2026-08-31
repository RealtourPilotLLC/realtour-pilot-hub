import type { ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, Mail, Phone, Star } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { cn, nameColor } from "@/lib/utils";
import { unansweredCommsBoard, revisionsBoard, slackBoard } from "@/lib/commsBoard";
import { HandledButton, SlackDoneButton } from "@/components/tasks/ChecklistButtons";

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
  const [phone, email] = await Promise.all([unansweredCommsBoard("phone"), unansweredCommsBoard("email")]);
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
                        {i.subject || "(no subject)"}
                        <span className="ml-2 font-normal text-muted-2">{i.ageHours}h ago</span>
                      </p>
                      {i.body && <p className="mt-0.5 whitespace-pre-wrap text-foreground/80">{i.body}</p>}
                    </div>
                  ) : (
                    <p key={idx} className="text-sm text-foreground/85">
                      <span className="text-muted-2">{i.ageHours}h ago · </span>
                      &ldquo;{i.snippet}&rdquo;
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
  const groups = await revisionsBoard();
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
                        <span className="font-medium">The ask:</span> {(j.headline ?? j.note ?? "").slice(0, 180)}
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

export async function SlackView({ tabs }: { tabs: ReactNode }) {
  const { unassigned, assigned } = await slackBoard();
  const total = unassigned.length + assigned.length;
  return (
    <Shell tabs={tabs} title="Slack tasks" subtitle="Action items parsed from Slack — assign, do, or tick them off. They no longer clog the board.">
      {total === 0 ? (
        <p className="flex items-center gap-2 rounded-2xl border border-success/20 bg-success/[0.05] px-5 py-4 text-[15px] text-success">
          <CheckCircle2 className="size-5" /> Slack is clear.
        </p>
      ) : (
        <div className="space-y-5">
          {unassigned.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-brand">Needs assigning</h2>
              <div className="space-y-2">{unassigned.map((t) => <SlackRow key={t.taskId} t={t} />)}</div>
            </div>
          )}
          {assigned.length > 0 && (
            <div>
              <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-2">Assigned</h2>
              <div className="space-y-2">{assigned.map((t) => <SlackRow key={t.taskId} t={t} />)}</div>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function SlackRow({ t }: { t: { taskId: string; title: string; summary: string | null; ageDays: number; assignedKey: string | null; overdue: boolean } }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border bg-surface px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-sm font-medium">{t.title}</span>
          {t.overdue && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
          <span className="shrink-0 text-xs text-muted">{t.ageDays}d old{t.assignedKey ? ` · ${t.assignedKey}` : ""}</span>
        </div>
        {t.summary && <p className="mt-0.5 text-[13px] text-muted">{t.summary.slice(0, 160)}</p>}
      </div>
      <SlackDoneButton taskId={t.taskId} />
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
    slack: slack.unassigned.length + slack.assigned.length,
  };
}
