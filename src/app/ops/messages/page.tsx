import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CheckCircle2, Mail, MessageSquare, PhoneCall } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Avatar } from "@/components/ui/Avatar";
import { authEnforced, requirePageAccess } from "@/lib/auth/guards";
import { getCurrentUser } from "@/lib/auth/user";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { scrubMoney } from "@/lib/text";
import { isSyntheticClientRow } from "@/lib/testClients";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { messagesBoard, MESSAGE_BEHIND_HOURS } from "@/lib/opsHome";
import { LoopRow, ageText } from "@/components/home/DailyChecklist";
import { HandledButton } from "@/components/tasks/ChecklistButtons";
import { LoopActions } from "@/components/ops/LoopActions";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /ops/messages — CLIENT MESSAGES (Oct 19 2026). Jordan: "Our communications,
// make sure we're following up." No existing screen held the whole job: the
// Comms tab has texts and email but not follow-ups or leads, and the Replies
// tab is texts only. This one lists, from ONE read (lib/opsHome.messagesBoard,
// which also counts Home's Messages tile):
//   · clients waiting on an answer, text and email together;
//   · follow-ups owed now (overdue or due today);
//   · new leads waiting on a call or text back.
// Every row hands off to the screen that already acts on it (the reply
// composer, the email board, the existing Handled / Not needed buttons); this
// page adds no new way to answer a client.
// ---------------------------------------------------------------------------

type SP = { who?: string | string[]; test?: string | string[] };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const waited = (h: number) => (h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h`);

export default async function ClientMessagesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requirePageAccess("ops");
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/ops/messages");
  const sp = await searchParams;
  const isOwner = !me || me.role === "OWNER";
  const includeTest = one(sp.test) === "1";
  // The owner's default is the whole business; anyone else sees their own
  // follow-ups and leads (the clients waiting are everyone's either way).
  const team = one(sp.who) === "all" || (isOwner && one(sp.who) !== "me");
  const excludedClientIds = includeTest ? [] : (await prisma.client.findMany({ select: { id: true, name: true } })).filter(isSyntheticClientRow).map((c) => c.id);
  const now = new Date();
  const board = await messagesBoard({ now, excludeClientIds: excludedClientIds, team });
  const clean = (s: string) => (isOwner ? s : scrubMoney(s));
  const scopeHref = (href: string) => homeRecordHref(href, includeTest);
  const c = board.counts;
  const whoHref = (w: "all" | "me") => `/ops/messages?who=${w}${includeTest ? "&test=1" : ""}`;

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Client messages"
        subtitle={`${c.open} to handle · ${c.behind} behind · ${c.dueToday} due today. A client waiting over ${MESSAGE_BEHIND_HOURS} hours counts as behind.`}
      />
      <div className="mx-auto max-w-3xl space-y-5 p-4 pb-16 sm:p-6">
        <nav aria-label="Whose follow-ups" className="flex flex-wrap gap-2 text-sm">
          <Link href={whoHref("me")} aria-current={!team ? "page" : undefined} className={cn("inline-flex min-h-11 items-center rounded-full border px-3 font-medium", !team ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2")}>My follow-ups</Link>
          <Link href={whoHref("all")} aria-current={team ? "page" : undefined} className={cn("inline-flex min-h-11 items-center rounded-full border px-3 font-medium", team ? "border-brand bg-brand-soft text-brand" : "border-border text-muted hover:bg-surface-2")}>Everyone&rsquo;s</Link>
        </nav>

        {/* 1 · CLIENTS WAITING ON AN ANSWER */}
        <section aria-labelledby="waiting-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <h2 id="waiting-title" className="flex items-center gap-2 text-base font-semibold">
            <MessageSquare aria-hidden className="size-4 text-muted-2" /> Clients waiting on an answer
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums">{board.waiting.length}</span>
          </h2>
          {board.waiting.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Every client has an answer.</p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {board.waiting.map((w) => {
                const latest = w.group.items[w.group.items.length - 1];
                const replyHref = w.family === "email" ? scopeHref("/tasks?tab=comms&via=email") : "/communications?tab=replies";
                return (
                  <li key={`${w.family}:${w.group.groupKey}`} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                    <Avatar name={w.group.clientName} size={32} />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="font-semibold">{w.group.clientName}</span>
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                          {w.family === "email" ? <Mail aria-hidden className="size-3" /> : <PhoneCall aria-hidden className="size-3" />}
                          {w.family === "email" ? "Email" : "Text"}
                        </span>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", w.behind ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>waiting {waited(w.group.oldestHours)}</span>
                      </p>
                      {latest && <p className="mt-0.5 truncate text-[13px] text-muted">&ldquo;{clean(latest.subject ? `${latest.subject}: ${latest.snippet}` : latest.snippet)}&rdquo;</p>}
                    </div>
                    <Link href={replyHref} className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand px-3 text-sm font-semibold text-white hover:opacity-90">Reply</Link>
                    <HandledButton clientId={w.group.clientId} family={w.family} groupKey={w.group.groupKey} />
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 2 · FOLLOW-UPS OWED NOW */}
        <section aria-labelledby="loops-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <h2 id="loops-title" className="flex items-center gap-2 text-base font-semibold">
            Follow-ups owed now
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums">{board.loops.length}</span>
          </h2>
          <p className="mt-0.5 text-[13px] text-muted">Overdue or promised today{team ? ", for everyone" : ", on your plate"}.</p>
          {board.loops.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Nothing owed today.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {board.loops.map((l) => <LoopRow key={l.taskId} l={{ ...l, title: clean(l.title) }} now={now} includeTest={includeTest} />)}
            </div>
          )}
          {board.laterLoops > 0 && (
            <p className="mt-2 text-[12px] text-muted-2">
              {board.laterLoops} more not due yet. <Link href={scopeHref("/ops#loops")} className="hover:text-foreground">See them on the daily checklist</Link>.
            </p>
          )}
        </section>

        {/* 3 · NEW LEADS */}
        <section aria-labelledby="leads-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <h2 id="leads-title" className="flex items-center gap-2 text-base font-semibold">
            New leads waiting on a call or text back
            <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums">{board.leads.length}</span>
          </h2>
          {board.leads.length === 0 ? (
            <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> No leads waiting.</p>
          ) : (
            <div className="mt-2 space-y-2">
              {board.leads.map((l) => (
                <div key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border px-3.5 py-2">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="text-sm font-medium leading-snug">{clean(l.title)}</p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      came in {ageText(l.createdAt.toISOString(), now)} ago
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
        </p>
      </div>
    </div>
  );
}
