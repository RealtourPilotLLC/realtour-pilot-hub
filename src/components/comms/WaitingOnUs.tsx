import Link from "next/link";
import { ArrowRight, Camera, CheckCircle2, ChevronDown, Mail, MessageSquare, PhoneCall, Star, User, UserPlus } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { CommsDismissButton } from "@/components/tasks/ChecklistButtons";
import { LoopActions } from "@/components/ops/LoopActions";
import { AtRiskUpdates } from "@/components/tasks/AtRiskUpdates";
import { MutedNumbers } from "@/components/comms/ReplyQueue";
import { normalizeSubject } from "@/components/comms/emailThreads";
import { emailNewestFirst } from "@/components/comms/emailOrder";
import { messagesHref, waitingReplyHref } from "@/components/comms/messagesNav";
import { homeRecordHref } from "@/lib/homeRecordScope";
import { MESSAGE_BEHIND_HOURS, waitedWords, type MessagesBoard, type WaitingClient } from "@/lib/opsHome";
import type { ReplyCard } from "@/lib/replyQueue";
import { cn } from "@/lib/utils";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// MESSAGES · WAITING ON US (Oct 19 2026): the first view of the one inbox.
// It is what /ops/messages showed (that route now opens this view), from the
// same single read, lib/opsHome.messagesBoard, which the Home summary box and
// the checklist's "Messages to answer" group also read:
//   · every client waiting on a reply, text and email together, longest wait
//     first: who, how long, what they sent, Reply (the view on this page that
//     answers them) and Dismiss (answered elsewhere, no reply needed, or
//     spam: Oct 21 2026, the Texts tab's own control and reasons, so this is
//     the one place a waiting client is cleared, by one path);
//   · new leads waiting on a call or text back: View, Handled, Not needed;
//   · promises at risk: work due inside a day or just past, so the client
//     hears from us before they have to ask (this lived only on the Tasks
//     page's Replies tab, which now opens this view).
// ONE QUEUE (Jordan, Oct 27 2026: "One queue"). This is the only list of
// things to answer. What only the Texts tab listed is here now: texts from
// numbers we have not saved (their own section, Reply and Dismiss like a
// client), and, folded, the ones that probably need nothing (thank-yous, our
// own team), with the muted numbers under them.
// Internal follow-ups are not messages: they are on the daily checklist.
// No money for anyone but the owner: every client line goes through `clean`
// (the page cleans the text cards before they get here).
// ---------------------------------------------------------------------------

/** The Email view's thread key for a waiting email (emailThreads groups by
 *  normalized subject and the client). */
export function emailFocusKey(w: WaitingClient): string {
  const latest = w.group.items[w.group.items.length - 1];
  return `${normalizeSubject(latest?.subject)}::${w.group.clientId}`;
}

/** Where this row's Reply goes, on this page. */
export function waitingRowReplyHref(w: WaitingClient, includeTest: boolean): string {
  return waitingReplyHref(w.family, w.family === "email" ? emailFocusKey(w) : w.group.groupKey, includeTest);
}

/** One text conversation that is not a waiting client's (an unsaved number,
 *  our own team, a thank-you): Reply opens its reply screen. */
function TextRow({ card, test }: { card: ReplyCard; test: boolean }) {
  return (
    <li data-waiting-text={card.key} className="py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={card.displayName} size={32} />
        <div className="min-w-0 flex-1 basis-48">
          <p className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-semibold">{card.displayName}</span>
            {card.isTeam ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted"><Camera aria-hidden className="size-3" /> our team</span>
            ) : !card.isClient ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-1.5 py-0.5 text-[11px] text-warning"><User aria-hidden className="size-3" /> not a saved client</span>
            ) : null}
            <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", card.hoursWaiting >= MESSAGE_BEHIND_HOURS && !card.likelyHandled ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>waiting {waitedWords(card.hoursWaiting)}</span>
          </p>
          {card.lastInbound && <p className="mt-0.5 truncate text-[13px] text-muted">&ldquo;{card.lastInbound}&rdquo;</p>}
        </div>
        <Link href={messagesHref("texts", { focus: card.key, test })} className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand-action px-3 text-sm font-semibold text-white hover:opacity-90">Reply</Link>
        <CommsDismissButton threadKey={card.key} family={card.family} clientId={card.clientId} />
      </div>
    </li>
  );
}

export function WaitingOnUs({ board, now, clean, includeTest, excludeClientIds, showFollowupsLink, texts = { unsaved: [], aside: [] } }: {
  board: MessagesBoard;
  now: Date;
  clean: (s: string) => string;
  includeTest: boolean;
  excludeClientIds: string[];
  /** a non-owner's internal follow-ups are on their daily checklist */
  showFollowupsLink: boolean;
  /** Oct 27 2026 (one queue): texts from numbers we have not saved, and the
   *  ones that probably need nothing (thank-yous, our own team). Cleaned. */
  texts?: { unsaved: ReplyCard[]; aside: ReplyCard[] };
}) {
  const scopeHref = (href: string) => homeRecordHref(href, includeTest);
  return (
    <div className="space-y-5">
      {/* Oct 23 2026 (Jordan): no "Show test records" button; test clients stay hidden. */}
      {includeTest && <p className="text-xs text-muted">Showing real and test records</p>}

      {/* 1 · CLIENTS WAITING ON A REPLY */}
      <section aria-labelledby="waiting-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="waiting-title" className="flex items-center gap-2 text-base font-semibold">
          <MessageSquare aria-hidden className="size-4 text-muted-2" /> Clients waiting on a reply
        </h2>
        {board.waiting.length === 0 ? (
          <p className="mt-2 flex items-center gap-1.5 text-sm text-success"><CheckCircle2 aria-hidden className="size-4" /> Every client has an answer.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border">
            {board.waiting.map((w) => {
              const latest = w.group.items[w.group.items.length - 1];
              return (
                <li key={`${w.family}:${w.group.groupKey}`} data-waiting={w.family} className="py-3">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <Avatar name={w.group.clientName} size={32} />
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm">
                        <span className="font-semibold">{w.group.clientName}</span>
                        {w.group.isVip && <Star aria-label="VIP client" className="size-3.5 shrink-0 text-warning" />}
                        <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">
                          {w.family === "email" ? <Mail aria-hidden className="size-3" /> : <PhoneCall aria-hidden className="size-3" />}
                          {w.family === "email" ? "Email" : "Text"}
                        </span>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[11px] font-semibold", w.behind ? "bg-danger/15 text-danger" : "bg-surface-2 text-muted")}>waiting {waitedWords(w.group.oldestHours)}</span>
                      </p>
                      {latest && <p className="mt-0.5 truncate text-[13px] text-muted">&ldquo;{clean(latest.subject ? `${latest.subject}: ${latest.snippet}` : latest.snippet)}&rdquo;</p>}
                      {/* Oct 22 2026 (audit H4): we said we would come back with the answer. */}
                      {w.group.holding && (
                        <p data-holding className={cn("mt-0.5 text-xs", w.group.holding.overdue ? "font-semibold text-danger" : "text-muted")}>
                          We said &ldquo;{clean(w.group.holding.text.length > 90 ? `${w.group.holding.text.slice(0, 89)}…` : w.group.holding.text)}&rdquo; ({etDateTime(w.group.holding.atISO)}). {w.group.holding.overdue ? "The answer was due" : "Answer due by"} {etDateTime(w.group.holding.dueISO)}.
                        </p>
                      )}
                      {w.group.schedulingAsks.length > 0 && (
                        <p data-scheduling-asks className="mt-0.5 text-xs text-muted">
                          Open scheduling request: {clean(w.group.schedulingAsks[w.group.schedulingAsks.length - 1])}
                          {w.group.schedulingAsks.length > 1 ? ` (and ${w.group.schedulingAsks.length - 1} more)` : ""}.{" "}
                          <Link href={scopeHref("/ops/scheduling")} className="font-medium text-brand underline">Scheduling to handle</Link>
                        </p>
                      )}
                    </div>
                    <Link href={waitingRowReplyHref(w, includeTest)} className="inline-flex min-h-11 shrink-0 items-center rounded-lg bg-brand-action px-3 text-sm font-semibold text-white hover:opacity-90">Reply</Link>
                    {/* Oct 21 2026: the Texts tab's Dismiss, with its reasons: one way to clear a waiting client. */}
                    <CommsDismissButton threadKey={w.group.key} family={w.family} clientId={w.group.clientId} groupKey={w.group.groupKey} />
                  </div>
                  {/* Everything they sent since our last answer, so the row can
                      be read without leaving the list (an email's text too). */}
                  <details className="mt-1 sm:pl-11">
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-xs font-medium text-brand">Read what they sent</summary>
                    <div className="space-y-2 rounded-xl border border-border bg-surface-2/50 p-3">
                      {/* An email's messages newest first (Jordan, Oct 27 2026); a text reads in order. */}
                      {(w.family === "email" ? emailNewestFirst(w.group.items, (i) => -i.ageHours) : w.group.items).map((i, idx) =>
                        w.family === "email" ? (
                          <div key={idx} className="text-sm">
                            <p className="font-semibold">
                              {i.subject ? clean(i.subject) : "(no subject)"}
                              <span className="ml-2 font-normal text-muted-2">{waitedWords(i.ageHours)} ago</span>
                            </p>
                            {i.body && <p className="mt-0.5 whitespace-pre-wrap text-foreground/80">{clean(i.body)}</p>}
                          </div>
                        ) : (
                          <p key={idx} className="text-sm text-foreground/85">
                            <span className="text-muted-2">{waitedWords(i.ageHours)} ago · </span>&ldquo;{clean(i.snippet)}&rdquo;
                          </p>
                        ),
                      )}
                      {w.group.fromLedger && w.group.clientId && (
                        <p className="text-xs text-muted">
                          This request is older than a week, so only the message it was raised on is here.{" "}
                          <Link href={`/clients/${w.group.clientId}`} className="font-medium text-brand underline">The whole conversation is on the client page.</Link>
                        </p>
                      )}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* 1b · TEXTS FROM NUMBERS WE HAVE NOT SAVED (Oct 27 2026, one queue:
          the Texts tab was the only list that had them). */}
      {texts.unsaved.length > 0 && (
        <section aria-labelledby="unsaved-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <h2 id="unsaved-title" className="flex items-center gap-2 text-base font-semibold">
            <PhoneCall aria-hidden className="size-4 text-muted-2" /> Texts from numbers we have not saved
          </h2>
          <ul className="mt-2 divide-y divide-border">
            {texts.unsaved.map((card) => <TextRow key={card.key} card={card} test={includeTest} />)}
          </ul>
        </section>
      )}

      {/* 2 · NEW LEADS */}
      <section aria-labelledby="leads-title" className="panel-shadow rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <h2 id="leads-title" className="flex items-center gap-2 text-base font-semibold">
          <UserPlus aria-hidden className="size-4 text-muted-2" /> New leads waiting on a call or text back
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

      {/* 3 · PROMISES AT RISK (renders nothing when nothing is at risk) */}
      <AtRiskUpdates excludeClientIds={excludeClientIds} />

      {/* 4 · TEXTS THAT PROBABLY NEED NOTHING: thank-yous and our own team.
          Out of the count, folded, still answerable or dismissable; then the
          muted numbers, so a mute can always be undone (both lived on Texts). */}
      <div>
        {texts.aside.length > 0 && (
          <details data-aside-texts={texts.aside.length} className="group">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-muted hover:text-foreground">
              <ChevronDown aria-hidden className="size-4 transition group-open:rotate-180" />
              {texts.aside.length} more {texts.aside.length === 1 ? "text that probably needs" : "texts that probably need"} nothing
              <span className="text-xs text-muted-2">(thank-yous and our own team)</span>
            </summary>
            <ul className="mt-1 divide-y divide-border rounded-2xl border border-border bg-surface px-4">
              {texts.aside.map((card) => <TextRow key={card.key} card={card} test={includeTest} />)}
            </ul>
          </details>
        )}
        <MutedNumbers />
      </div>

      {showFollowupsLink && (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-muted">
          <Link href={scopeHref("/#followups")} className="inline-flex min-h-11 items-center gap-1 hover:text-foreground">
            Internal follow-ups are on your daily checklist <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </p>
      )}
    </div>
  );
}
