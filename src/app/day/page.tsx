import { redirect } from "next/navigation";
import Link from "next/link";
import {
  Sun, Camera, Brain, Coffee, CalendarClock, AlertTriangle, Inbox, TrendingUp,
  Wallet, Landmark, Package, CheckCircle2, Users2, Video, CalendarOff,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { QuickAdd } from "@/components/day/QuickAdd";
import { TodoRow } from "@/components/day/TodoRow";
import { BlockDayButton, BlockRowControls } from "@/components/day/BlockControls";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { buildDayPlan, ownerTodoLists, ownerMemberId, DAY_SHAPE } from "@/lib/ownerDay";
import { ownerPulse } from "@/lib/ownerPulse";
import { etDayKey } from "@/lib/datetime";

export const dynamic = "force-dynamic";

// MY DAY — the owner's command centre.
//
// Built to answer "what am I doing next?" without asking anything of the reader.
// The plan comes first because that is the question; the lists come second
// because they are the raw material; the business numbers come last because
// they are context, not an action. Nothing here is a wall of text and nothing
// requires a decision to be useful on first glance.

const usd0 = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
const hhmm = (d: Date) =>
  d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-2">
        {icon} {label}
      </div>
      <div className={`mt-0.5 text-xl font-bold tabular-nums ${tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted-2">{sub}</div>}
    </div>
  );
}

export default async function MyDayPage() {
  const me = await getCurrentUser().catch(() => null);
  if (!me && authEnforced()) redirect("/login?next=/day");
  if (me && me.role !== "OWNER") redirect("/");

  const todayKey = etDayKey(new Date());
  const myMemberId = await ownerMemberId(me?.teamMemberId);
  const [plan, lists, pulse] = await Promise.all([
    buildDayPlan(todayKey, { memberId: myMemberId }),
    ownerTodoLists(),
    ownerPulse().catch(() => null),
  ]);

  // The plan and the fixed commitments, merged into one chronological column —
  // one timeline, not two lists to reconcile in your head.
  const timeline = [
    ...plan.fixed.map((f) => ({ kind: "fixed" as const, start: f.start, end: f.end, f })),
    ...plan.planned.map((p) => ({ kind: "todo" as const, start: p.start, end: p.end, p })),
  ].sort((a, b) => a.start.getTime() - b.start.getTime());

  const hours = Math.floor(plan.freeMinutes / 60);
  const mins = plan.freeMinutes % 60;
  const unblocked = plan.planned.filter((p) => !p.onCalendar).length;
  // The picker hands back Eastern wall-clock; the server turns it into a real
  // instant. Formatting it here keeps the two ends speaking the same language.
  const hhmm24 = (d: Date) =>
    d.toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" });

  return (
    <div>
      <PageHeader
        eyebrow="Eastern time"
        title="My Day"
        subtitle={`${DAY_SHAPE.startHour}am–${DAY_SHAPE.endHour - 12}pm · mornings kept for deep work`}
      />
      <div className="mx-auto max-w-3xl space-y-4 p-4 sm:p-6">
        <QuickAdd />

        {/* THE PLAN — the answer to "what now", above everything else. */}
        <Section
          icon={Sun}
          title="Today"
          action={
            <span className="text-[11px] text-muted-2">
              {plan.freeMinutes > 0 ? `${hours ? `${hours}h ` : ""}${mins}m free` : "fully booked"}
              {plan.deepMinutesFree > 0 ? ` · ${Math.floor(plan.deepMinutesFree / 60)}h deep` : ""}
            </span>
          }
        >
          {timeline.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">
              Nothing scheduled. Add something above and hit <span className="font-medium">Today</span> — it will find a slot.
            </p>
          ) : (
            <div className="space-y-1.5">
              {timeline.map((row, i) =>
                row.kind === "fixed" ? (
                  <div key={`f${i}`} className="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent/[0.06] px-3 py-2">
                    <span className="w-16 shrink-0 pt-0.5 text-[11px] font-medium tabular-nums text-muted">{hhmm(row.start)}</span>
                    {row.f.kind === "shoot" ? (
                      <Camera className="mt-0.5 size-4 shrink-0 text-accent" />
                    ) : row.f.virtual ? (
                      <Video className="mt-0.5 size-4 shrink-0 text-accent" />
                    ) : (
                      <Users2 className="mt-0.5 size-4 shrink-0 text-accent" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">
                        {row.f.projectId ? (
                          <Link href={`/projects/${row.f.projectId}`} className="hover:underline">{row.f.title}</Link>
                        ) : (
                          row.f.title
                        )}
                      </div>
                      <div className="text-[11px] text-muted-2">
                        {hhmm(row.start)}–{hhmm(row.end)}
                        {row.f.where ? ` · ${row.f.where}` : ""}
                        {/* Say exactly what was held, and why — a plan that hides
                            its own assumptions is one you stop believing. */}
                        {row.f.bufferBeforeMin > 0
                          ? ` · ${row.f.bufferBeforeMin}m drive held each side`
                          : row.f.bufferAfterMin > 0
                            ? ` · ${row.f.bufferAfterMin}m after to write it up`
                            : ""}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={`t${i}`} className="flex items-start gap-3 rounded-xl border border-border bg-surface-2/50 px-3 py-2">
                    <span className="w-16 shrink-0 pt-0.5 text-[11px] font-medium tabular-nums text-muted">{hhmm(row.start)}</span>
                    {row.p.energy === "DEEP" ? (
                      <Brain className="mt-0.5 size-4 shrink-0 text-brand" />
                    ) : (
                      <Coffee className="mt-0.5 size-4 shrink-0 text-muted-2" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm">{row.p.title}</span>
                        {row.p.onCalendar && (
                          <span className="rounded bg-success/12 px-1 text-[10px] font-medium text-success">on calendar</span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-2">
                        {hhmm(row.start)}–{hhmm(row.end)} · {row.p.energy === "DEEP" ? "deep work" : "admin"}
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
                ),
              )}
            </div>
          )}

          {plan.unplaced.length > 0 && (
            <p className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-muted">
              <span className="font-semibold text-warning">{plan.unplaced.length} didn&rsquo;t fit today</span> —{" "}
              {plan.unplaced.map((u) => u.title).slice(0, 3).join(", ")}
              {plan.unplaced.length > 3 ? "…" : ""}. They stay on the list rather than being squeezed in; a day you can finish is worth
              more than one that looks productive.
            </p>
          )}

          {/* Something real landed on a block we'd already written to Google —
              almost always a Calendly booking. Never moved silently: the hub and
              the calendar would then disagree about where the hour went. */}
          {plan.conflicts.length > 0 && (
            <div className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-[11px] leading-relaxed text-muted">
              <span className="font-semibold text-danger">Double-booked.</span>{" "}
              {plan.conflicts.map((c) => `“${c.title}” now overlaps ${c.clashesWith}`).join("; ")}. Use the clock icon to move the block,
              or the calendar icon to give the time back.
            </div>
          )}

          {plan.calendarOk ? (
            unblocked > 0 && (
              <div className="mt-3">
                <BlockDayButton dayKey={todayKey} pending={unblocked} />
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-2">
                  Blocks go on your main calendar on purpose — that&rsquo;s the one Calendly reads, so this is what actually stops a
                  client booking over your focus time.
                </p>
              </div>
            )
          ) : (
            <div className="mt-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-muted">
              <span className="inline-flex items-center gap-1.5 font-semibold text-warning">
                <CalendarOff className="size-3.5" /> Google Calendar isn&rsquo;t connected.
              </span>{" "}
              This plan is built from shoots only — meetings and Calendly bookings aren&rsquo;t in it yet, and nothing is being blocked
              off. One reconnect fixes it:{" "}
              <Link href="/connections" className="font-medium text-brand hover:underline">
                Connections → Gmail → Reconnect
              </Link>
              , signing in as info@realtourpilot.com.
            </div>
          )}
        </Section>

        {lists.overdue.length > 0 && (
          <Section icon={AlertTriangle} title="Overdue" tone="warning" action={<span className="text-[11px] text-muted-2">{lists.overdue.length}</span>}>
            <div className="divide-y divide-border/60">
              {lists.overdue.map((t) => (
                <TodoRow key={t.id} t={t} todayKey={todayKey} overdue />
              ))}
            </div>
          </Section>
        )}

        <Section
          icon={Inbox}
          title="Not scheduled yet"
          action={<span className="text-[11px] text-muted-2">{lists.unscheduled.length} waiting</span>}
        >
          {lists.unscheduled.length === 0 ? (
            <p className="py-3 text-center text-sm text-muted-2">Nothing waiting. Everything you&rsquo;ve captured has a day.</p>
          ) : (
            <div className="divide-y divide-border/60">
              {lists.unscheduled.slice(0, 20).map((t) => (
                <TodoRow key={t.id} t={t} todayKey={todayKey} />
              ))}
            </div>
          )}
        </Section>

        {lists.doneToday > 0 && (
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-muted-2">
            <CheckCircle2 className="size-3.5 text-success" /> {lists.doneToday} finished today
          </p>
        )}

        {/* WHERE THE BUSINESS IS — context, deliberately last. */}
        {pulse && (
          <Section icon={TrendingUp} title="Where the business is" action={<span className="text-[11px] text-muted-2">{pulse.monthLabel} so far</span>}>
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <Stat icon={<Wallet className="size-3" />} label="Revenue" value={usd0(pulse.revenueMonth)} sub={`${usd0(pulse.revenueYtd)} this year`} />
              <Stat
                icon={<TrendingUp className="size-3" />}
                label="Profit"
                value={usd0(pulse.profitMonth)}
                sub={pulse.marginPct != null ? `${Math.round(pulse.marginPct)}% margin` : undefined}
                tone={pulse.profitMonth >= 0 ? "good" : "bad"}
              />
              <Stat
                icon={<Landmark className="size-3" />}
                label="In the bank"
                value={pulse.bankBalance == null ? "—" : usd0(pulse.bankBalance)}
                sub={
                  pulse.bankLabel
                    ? `${pulse.bankLabel}${pulse.bankAsOf ? ` · ${pulse.bankAsOf.toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}`
                    : "not connected"
                }
                tone={pulse.bankBalance != null && pulse.bankBalance < 0 ? "bad" : undefined}
              />
              <Stat
                icon={<Wallet className="size-3" />}
                label="Owed to you"
                value={usd0(pulse.owedToYou)}
                sub={`${pulse.owedCount} unpaid`}
                tone={pulse.owedToYou > 0 ? "bad" : undefined}
              />
              <Stat icon={<Camera className="size-3" />} label="Shoots this week" value={String(pulse.shootsThisWeek)} />
              <Stat icon={<Package className="size-3" />} label="Delivered" value={String(pulse.deliveredThisMonth)} sub="this month" />
              <Stat icon={<CalendarClock className="size-3" />} label="Team tasks open" value={String(pulse.openTasks)} sub={`${pulse.overdueTasks} overdue`} tone={pulse.overdueTasks > 0 ? "bad" : undefined} />
              <div className="rounded-xl border border-border bg-surface p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-2">Go deeper</div>
                <div className="mt-1 flex flex-col gap-0.5 text-xs">
                  <Link href="/trends" className="text-brand hover:underline">Trends →</Link>
                  <Link href="/sales" className="text-brand hover:underline">Finance →</Link>
                </div>
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-2">
              Revenue is cash across all three rails; profit is that minus categorised business spend — the same arithmetic as Finance →
              Overview, so the two screens can never disagree. Monthly retainers billed in QuickBooks are included.
            </p>
          </Section>
        )}
      </div>
    </div>
  );
}
