import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2, Mail, MessageSquare, PhoneCall, UserPlus } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { scrubMoney } from "@/lib/text";
import { isSyntheticClientRow } from "@/lib/testClients";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { listAssignees, viewerAssigneeKey } from "@/lib/assignees";
import { messagesBoard, replyHref, waitedWords, MESSAGE_BEHIND_HOURS } from "@/lib/opsHome";
import { HandledButton } from "@/components/tasks/ChecklistButtons";
import { LoopActions } from "@/components/ops/LoopActions";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/messages: MESSAGES (Oct 19 2026, evening). Jordan approved: "Messages =
// only clients waiting on a reply + new leads". The audit that day found 27
// of 39 rows here were the office's own internal follow-ups; those are on
// the daily checklist now ("Follow-ups due", "From earlier days"), not here.
//
// From ONE read (lib/opsHome.messagesBoard; the Home summary box counts the
// same waiting list):
//   · clients waiting on a reply, text and email together, longest wait
//     first: who, how long, Reply (the reply screen that already answers
//     them) and Handled (answered elsewhere, or no reply needed);
//   · new leads waiting on a call or text back: View, Handled, Not needed.
// This page adds no new way to answer a client.
// ---------------------------------------------------------------------------

type SP = { test?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function MessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/ops/messages");
  const sp = await searchParams;
  const isOwner = !me || me.role === "OWNER";
  const includeTest = one(sp.test) === "1";
  const excludedClientIds = includeTest ? [] : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const roster = me ? await listAssignees().catch(() => []) : [];
  const viewer = me ? { key: viewerAssigneeKey(me, roster), role: me.role, teamMemberId: me.teamMemberId } : null;
  const now = new Date();
  const board = await messagesBoard({ now, excludeClientIds: excludedClientIds, viewer });
  const clean = (s: string) => (isOwner ? s : scrubMoney(s));
  const scopeHref = (href: string) => homeRecordHref(href, includeTest);
  const behind = board.waiting.filter((w) => w.behind).length;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Messages"
        subtitle={`${board.waiting.length} client${board.waiting.length === 1 ? "" : "s"} waiting on a reply${behind ? ` (${behind} over a day)` : ""} · ${board.leads.length} new lead${board.leads.length === 1 ? "" : "s"}. A client waiting over ${MESSAGE_BEHIND_HOURS} hours counts as behind.`}
      />
      <div className="mx-auto max-w-3xl space-y-5 p-4 pb-16 sm:p-6">
        {/* 1 · CLIENTS WAITING ON A REPLY */}
        <section aria-labelledby="waiting-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <h2 id="waiting-title" className="flex items-center gap-2 text-base font-semibold">
            <MessageSquare aria-hidden className="size-4 text-muted-2" /> Clients waiting on a reply
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums">{board.waiting.length}</span>
          </h2>
          {board.waiting.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Every client has an answer.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {board.waiting.map((w) => {
                const latest = w.group.items[w.group.items.length - 1];
                return (
                  <li key={`${w.family}:${w.group.groupKey}`} data-waiting={w.family} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                    <Avatar name={w.group.clientName} size={32} />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="font-semibold">{w.group.clientName}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                          {w.family === "email" ? <Mail aria-hidden className="size-3" /> : <PhoneCall aria-hidden className="size-3" />}
                          {w.family === "email" ? "Email" : "Text"}
                        </span>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", w.behind ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>waiting {waitedWords(w.group.oldestHours)}</span>
                      </p>
                      {latest && <p className="mt-0.5 truncate text-[13px] text-muted">&ldquo;{clean(latest.subject ? `${latest.subject}: ${latest.snippet}` : latest.snippet)}&rdquo;</p>}
                    </div>
                    <Link href={w.family === "email" ? scopeHref(replyHref(w.family)) : replyHref(w.family)} className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:opacity-90">Reply</Link>
                    <HandledButton clientId={w.group.clientId} family={w.family} groupKey={w.group.groupKey} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 2 · NEW LEADS */}
        <section aria-labelledby="leads-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <h2 id="leads-title" className="flex items-center gap-2 text-base font-semibold">
            <UserPlus aria-hidden className="size-4 text-muted-2" /> New leads waiting on a call or text back
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums">{board.leads.length}</span>
          </h2>
          {board.leads.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> No leads waiting.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {board.leads.map((l) => (
                <div key={l.id} data-lead={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-sm font-medium leading-snug">{clean(l.title)}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      waiting {waitedWords(Math.max(0, Math.floor((now.getTime() - l.createdAt.getTime()) / 3_600_000)))}
                      {l.behind ? " · past its callback time" : l.dueToday ? " · call back today" : ""}
                    </p>
                  </div>
                  {l.behind && <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-[10px] font-semibold text-danger">overdue</span>}
                  <LoopActions taskId={l.id} viewHref={scopeHref(`/tasks?tab=work&type=lead&task=${l.id}`)} />
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
          {board.outbox > 0 && (
            <Link href={scopeHref("/communications?tab=outbox")} className="inline-flex min-h-11 items-center gap-1 hover:text-foreground">
              {board.outbox} client text{board.outbox === 1 ? "" : "s"} drafted and ready in the Outbox <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
          <Link href="/communications?tab=replies" className="inline-flex min-h-11 items-center gap-1 hover:text-foreground">
            Reply queue: every unanswered text, including unknown numbers <ArrowRight aria-hidden className="size-3.5" />
          </Link>
          {!isOwner && (
            <Link href={scopeHref("/#followups")} className="inline-flex min-h-11 items-center gap-1 hover:text-foreground">
              Internal follow-ups are on your daily checklist <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </p>
      </div>
    </div>
  );
}
