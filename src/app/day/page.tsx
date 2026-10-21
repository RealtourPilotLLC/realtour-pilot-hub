import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Camera, Brain, Coffee, AlertTriangle, Inbox, Users2, Video,
  CalendarOff, Mic, ChevronRight, Clock, Sun,
} from "lucide-react";
import { QuickAdd } from "@/components/day/QuickAdd";
import { TodoRow } from "@/components/day/TodoRow";
import { BlockDayButton, BlockRowControls } from "@/components/day/BlockControls";
import { MeetingCard, ScanMeetingsButton } from "@/components/day/MeetingCard";
import { FinishedList } from "@/components/day/FinishedList";
import { DayAssistant } from "@/components/day/DayAssistant";
import { WeekCalendar } from "@/components/day/WeekCalendar";
import { meetingsForReview } from "@/lib/meetings";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { buildDayPlan, ownerTodoLists, ownerMemberId, calendarAhead } from "@/lib/ownerDay";
import { etDayKey } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// MY DAY — the owner's command centre.
//
// REBUILT for readability. The first version was correct and unreadable: every
// line was 11px and the same grey, so the page had no shape and you had to read
// all of it to find any of it. Jordan: "too much of the text looks the same and
// is same color, it's just hard to read."
//
// So the rules now are:
//  · SIZE CARRIES RANK. The one thing he's doing next is large; the list is
//    normal; only labels are small. Nothing below 12px.
//  · COLOUR MEANS SOMETHING. Red is late, amber is a warning, brand is deep
//    work, accent is a real commitment. Everything else is plain foreground —
//    grey is for labels, never for content he has to read.
//  · ONE QUESTION PER BLOCK, with a heading that answers it in plain words.
//  · Reference material (the week) sits at the bottom and stays out of the
//    way of the doing. The money lives on the dashboard only (Jordan, Oct 21
//    2026, audit A12): this page links there instead of repeating it.

const hhmm = (d: Date) =>
  d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

/** A section that looks like a section: one clear heading, real spacing. */
function Block({
  title, icon: Icon, count, tone = "plain", action, children,
}: {
  title: string;
  icon: React.ElementType;
  count?: number;
  tone?: "plain" | "danger";
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-2xl border bg-surface p-4 sm:p-5 ${
        tone === "danger" ? "border-danger/40 bg-danger/[0.04]" : "border-border"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon className={`size-5 ${tone === "danger" ? "text-danger" : "text-muted"}`} />
        <h2 className={`text-base font-semibold ${tone === "danger" ? "text-danger" : ""}`}>{title}</h2>
        {count !== undefined && count > 0 && (
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
              tone === "danger" ? "bg-danger text-white" : "bg-surface-2 text-muted"
            }`}
          >
            {count}
          </span>
        )}
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export default async function MyDayPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/day");
  if (me && me.role !== "OWNER") redirect("/");

  const todayKey = etDayKey(new Date());
  const myMemberId = await ownerMemberId(me?.teamMemberId);
  const [plan, lists, meetings, week] = await Promise.all([
    buildDayPlan(todayKey, { memberId: myMemberId }),
    ownerTodoLists(),
    meetingsForReview().catch(() => []),
    calendarAhead(7, { memberId: myMemberId }).catch(() => null),
  ]);

  const now = new Date();
  const timeline = [
    ...plan.fixed.map((f) => ({ kind: "fixed" as const, start: f.start, end: f.end, f })),
    ...plan.planned.map((p) => ({ kind: "todo" as const, start: p.start, end: p.end, p })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());

  // The headline: what he is in the middle of, or what is next. One thing, not
  // a list — the whole point of the card is that it needs no reading.
  const current = timeline.find((r) => r.start <= now && r.end > now);
  const next = timeline.find((r) => r.start > now);
  const hero = current ?? next;
  const heroTitle = hero ? (hero.kind === "fixed" ? hero.f.title : hero.p.title) : null;
  const minsLeft = current ? Math.round((current.end.getTime() - now.getTime()) / 60000) : null;
  const minsUntil = !current && next ? Math.round((next.start.getTime() - now.getTime()) / 60000) : null;

  const hours = Math.floor(plan.freeMinutes / 60);
  const mins = plan.freeMinutes % 60;
  const unblocked = plan.planned.filter((p) => !p.onCalendar).length;
  const hhmm24 = (d: Date) =>
    d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

  const dayLabel = now.toLocaleDateString("en-US", {
    timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric",
  });

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 pb-16 sm:p-6">
      {/* ── RIGHT NOW ──────────────────────────────────────────────────────
          The reason the page exists. Big enough to read from across the desk,
          and it says one thing. */}
      <div className="rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/[0.10] to-brand/[0.02] p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-muted">{dayLabel}</span>
          <span className="text-sm text-muted-2">
            {plan.freeMinutes > 0 ? `${hours ? `${hours}h ` : ""}${mins}m free` : "fully booked"}
          </span>
        </div>

        {heroTitle ? (
          <div className="mt-3">
            <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-brand">
              {current ? (
                <>
                  <Clock className="size-4" /> Right now
                </>
              ) : (
                <>
                  <ChevronRight className="size-4" /> Next up · {hhmm(hero!.start)}
                </>
              )}
            </div>
            <h1 className="mt-1 text-2xl font-bold leading-tight sm:text-3xl">{heroTitle}</h1>
            <p className="mt-1.5 text-base text-muted">
              {hhmm(hero!.start)}–{hhmm(hero!.end)}
              {minsLeft !== null && ` · ${minsLeft} min left`}
              {minsUntil !== null && ` · in ${minsUntil < 60 ? `${minsUntil} min` : `${Math.round(minsUntil / 60)}h`}`}
              {hero!.kind === "fixed" && hero!.f.where ? ` · ${hero!.f.where}` : ""}
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <h1 className="text-2xl font-bold leading-tight sm:text-3xl">Nothing scheduled.</h1>
            <p className="mt-1.5 text-base text-muted">
              {lists.unscheduled.length > 0
                ? `${lists.unscheduled.length} waiting to be planned — add one to today below, or ask me what to start with.`
                : "The day is yours. Capture something below and it'll find a slot."}
            </p>
          </div>
        )}
      </div>

      {/* Capture, always within reach. */}
      <QuickAdd />

      {/* ── LATE ───────────────────────────────────────────────────────────
          Loud on purpose, and above everything except what he's doing now. */}
      {lists.overdue.length > 0 && (
        <Block title="Late" icon={AlertTriangle} count={lists.overdue.length} tone="danger">
          <div className="divide-y divide-border/60">
            {lists.overdue.map((t) => (
              <TodoRow key={t.id} t={t} todayKey={todayKey} overdue />
            ))}
          </div>
        </Block>
      )}

      {/* ── THE ASSISTANT ──────────────────────────────────────────────────
          High on the page: it's faster to ask than to scan. */}
      <DayAssistant />

      {/* ── TODAY'S PLAN ───────────────────────────────────────────────────── */}
      <Block
        title="Today's plan"
        icon={Sun}
        action={
          plan.deepMinutesFree > 0 ? (
            <span className="text-sm text-muted-2">{Math.floor(plan.deepMinutesFree / 60)}h deep left</span>
          ) : undefined
        }
      >
        {timeline.length === 0 ? (
          <p className="py-4 text-center text-base text-muted">
            Nothing on the calendar and nothing planned. Add something above and hit{" "}
            <span className="font-semibold text-foreground">Today</span>.
          </p>
        ) : (
          <div className="space-y-2">
            {timeline.map((row, i) => {
              const isNow = row === current;
              const past = row.end <= now;
              return row.kind === "fixed" ? (
                <div
                  key={`f${i}`}
                  className={`flex items-start gap-3 rounded-xl border-l-4 border-accent bg-accent/[0.07] py-2.5 pl-3 pr-3 ${
                    isNow ? "ring-2 ring-accent/40" : ""
                  } ${past ? "opacity-45" : ""}`}
                >
                  <span className="w-[4.5rem] shrink-0 pt-0.5 text-sm font-semibold tabular-nums">{hhmm(row.start)}</span>
                  {row.f.kind === "shoot" ? (
                    <Camera className="mt-0.5 size-5 shrink-0 text-accent" />
                  ) : row.f.virtual ? (
                    <Video className="mt-0.5 size-5 shrink-0 text-accent" />
                  ) : (
                    <Users2 className="mt-0.5 size-5 shrink-0 text-accent" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-base font-semibold leading-snug">
                      {row.f.projectId ? (
                        <Link href={`/projects/${row.f.projectId}`} className="hover:underline">{row.f.title}</Link>
                      ) : (
                        row.f.title
                      )}
                    </div>
                    <div className="text-sm text-muted">
                      until {hhmm(row.end)}
                      {row.f.where ? ` · ${row.f.where}` : ""}
                      {row.f.bufferBeforeMin > 0
                        ? ` · ${row.f.bufferBeforeMin}m drive held each side`
                        : row.f.bufferAfterMin > 0
                          ? ` · ${row.f.bufferAfterMin}m after to write it up`
                          : ""}
                    </div>
                  </div>
                </div>
              ) : (
                <div
                  key={`t${i}`}
                  className={`flex items-start gap-3 rounded-xl border-l-4 py-2.5 pl-3 pr-3 ${
                    row.p.energy === "DEEP" ? "border-brand bg-brand/[0.06]" : "border-border bg-surface-2/40"
                  } ${isNow ? "ring-2 ring-brand/40" : ""} ${past ? "opacity-45" : ""}`}
                >
                  <span className="w-[4.5rem] shrink-0 pt-0.5 text-sm font-semibold tabular-nums">{hhmm(row.start)}</span>
                  {row.p.energy === "DEEP" ? (
                    <Brain className="mt-0.5 size-5 shrink-0 text-brand" />
                  ) : (
                    <Coffee className="mt-0.5 size-5 shrink-0 text-muted" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-base leading-snug">{row.p.title}</div>
                    <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
                      <span>until {hhmm(row.end)}</span>
                      <span className={row.p.energy === "DEEP" ? "font-medium text-brand" : ""}>
                        {row.p.energy === "DEEP" ? "deep work" : "admin"}
                      </span>
                      {row.p.onCalendar && <span className="font-medium text-success">on your calendar</span>}
                    </div>
                  </div>
                  {plan.calendarOk && (
                    <BlockRowControls
                      id={row.p.id}
                      dayKey={todayKey}
                      onCalendar={row.p.onCalendar}
                      hhmm={hhmm24(row.start)}
                      minutes={Math.round((row.end.getTime() - row.start.getTime()) / 60000)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {plan.unplaced.length > 0 && (
          <p className="mt-3 rounded-xl border border-warning/40 bg-warning/[0.07] px-3 py-2.5 text-sm leading-relaxed">
            <span className="font-semibold text-warning">{plan.unplaced.length} didn&rsquo;t fit today</span> —{" "}
            {plan.unplaced.map((u) => u.title).slice(0, 3).join(", ")}
            {plan.unplaced.length > 3 ? "…" : ""}. They stay on the list rather than being squeezed in.
          </p>
        )}

        {plan.conflicts.length > 0 && (
          <p className="mt-3 rounded-xl border border-danger/40 bg-danger/[0.07] px-3 py-2.5 text-sm leading-relaxed">
            <span className="font-semibold text-danger">Double-booked.</span>{" "}
            {plan.conflicts.map((c) => `“${c.title}” overlaps ${c.clashesWith}`).join("; ")}. Use the clock icon to move it.
          </p>
        )}

        {plan.calendarOk ? (
          unblocked > 0 && (
            <div className="mt-3">
              <BlockDayButton dayKey={todayKey} pending={unblocked} />
              <p className="mt-2 text-sm text-muted-2">
                Blocks go on your main calendar — the one Calendly reads, so this is what stops a client booking over your focus time.
              </p>
            </div>
          )
        ) : (
          <div className="mt-3 rounded-xl border border-warning/40 bg-warning/[0.07] px-3 py-2.5 text-sm leading-relaxed">
            <span className="inline-flex items-center gap-1.5 font-semibold text-warning">
              <CalendarOff className="size-4" /> Google Calendar isn&rsquo;t readable.
            </span>{" "}
            This plan is shoots only — meetings and Calendly bookings aren&rsquo;t in it.
            {plan.calendarError && /has not been used in project|is disabled/i.test(plan.calendarError) ? (
              <span className="mt-1 block text-muted">
                The Calendar API is switched off in your Google Cloud project. {plan.calendarError}
              </span>
            ) : (
              <>
                {" "}
                <Link href="/connections" className="font-semibold text-brand hover:underline">
                  Reconnect Google
                </Link>
                .
              </>
            )}
          </div>
        )}
      </Block>

      {/* ── CALL RECAPS ────────────────────────────────────────────────────── */}
      {(meetings.length > 0 || plan.calendarOk) && (
        <Block title="From your calls" icon={Mic} count={meetings.length}>
          {meetings.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-2">
              <p className="text-base text-muted">No call recaps waiting.</p>
              <ScanMeetingsButton />
            </div>
          ) : (
            <div className="space-y-3">
              {meetings.map((m) => (
                <MeetingCard key={m.id} m={m} />
              ))}
              <ScanMeetingsButton />
            </div>
          )}
        </Block>
      )}

      {/* ── THE BACKLOG ────────────────────────────────────────────────────── */}
      <Block title="Not scheduled yet" icon={Inbox} count={lists.unscheduled.length}>
        {lists.unscheduled.length === 0 ? (
          <p className="py-3 text-center text-base text-muted">Everything you&rsquo;ve captured has a day.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {lists.unscheduled.slice(0, 20).map((t) => (
              <TodoRow key={t.id} t={t} todayKey={todayKey} />
            ))}
          </div>
        )}
      </Block>

      <FinishedList rows={lists.finished} />

      {/* ── REFERENCE ──────────────────────────────────────────────────────
          The week. Deliberately last and deliberately quiet: it is not
          something to act on right now. */}
      {week?.calendarOk && (
        <div className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
          <WeekCalendar
            calendarOk
            days={week.days.map((d) => ({
              dayKey: d.dayKey,
              isToday: d.isToday,
              isWeekend: d.isWeekend,
              allDay: d.allDay,
              freeMinutes: d.freeMinutes,
              plannedCount: d.plannedCount,
              blocks: d.blocks.map((b) => ({
                kind: b.kind,
                title: b.title,
                where: b.where,
                start: b.start.toISOString(),
                end: b.end.toISOString(),
                virtual: b.virtual,
                projectId: b.projectId,
                bufferBeforeMin: b.bufferBeforeMin,
                bufferAfterMin: b.bufferAfterMin,
              })),
            }))}
          />
        </div>
      )}

      {/* The money (revenue, profit, the bank, what is owed) is the dashboard's
          (Oct 21 2026): one place, never two copies that can disagree. */}
      <p className="text-sm text-muted">
        Revenue, profit, the bank and what you&rsquo;re owed are on the{" "}
        <Link href="/" className="inline-flex min-h-11 items-center font-medium text-brand hover:underline">dashboard</Link>.
      </p>
    </div>
  );
}
