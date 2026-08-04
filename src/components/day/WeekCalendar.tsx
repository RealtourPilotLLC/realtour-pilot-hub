"use client";

import { useState } from "react";
import Link from "next/link";
import { Camera, Video, Users2, ChevronDown, CalendarDays } from "lucide-react";

// WHAT IS ACTUALLY ON THE CALENDAR.
//
// The plan above answers "what am I doing next". This answers the other
// question — "what is coming" — and it is deliberately a read-only view. No
// controls, nothing to decide: just the week as it really stands, so a glance
// tells him which mornings survive and which days are already gone.

export type WeekBlock = {
  kind: string;
  title: string;
  where: string | null;
  start: string;
  end: string;
  virtual: boolean;
  projectId: string | null;
  bufferBeforeMin: number;
  bufferAfterMin: number;
};
export type WeekDay = {
  dayKey: string;
  isToday: boolean;
  isWeekend: boolean;
  blocks: WeekBlock[];
  allDay: string[];
  freeMinutes: number;
  plannedCount: number;
};

const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
const label = (dayKey: string) => {
  const d = new Date(`${dayKey}T12:00:00Z`);
  return {
    dow: d.toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short" }),
    num: d.toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric" }),
    month: d.toLocaleDateString("en-US", { timeZone: "UTC", month: "short" }),
  };
};
const hrs = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`);

export function WeekCalendar({ days, calendarOk }: { days: WeekDay[]; calendarOk: boolean }) {
  const [open, setOpen] = useState(true);
  if (!calendarOk) return null;

  const busiest = Math.max(1, ...days.map((d) => 540 - d.freeMinutes));

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="mb-2 flex w-full items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-2 hover:text-foreground"
      >
        <CalendarDays className="size-3.5" /> The week ahead
        <ChevronDown className={`size-3 transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="space-y-1.5">
          {days.map((d) => {
            const { dow, num, month } = label(d.dayKey);
            const booked = 540 - d.freeMinutes;
            return (
              <div
                key={d.dayKey}
                className={`flex items-start gap-3 rounded-xl border px-3 py-2 ${
                  d.isToday ? "border-brand/40 bg-brand/[0.05]" : "border-border bg-surface"
                } ${d.isWeekend && d.blocks.length === 0 ? "opacity-50" : ""}`}
              >
                {/* The date rail — same width on every row so the eye can run down it. */}
                <div className="w-11 shrink-0 text-center">
                  <div className={`text-[10px] uppercase ${d.isToday ? "font-semibold text-brand" : "text-muted-2"}`}>{dow}</div>
                  <div className={`text-lg font-bold leading-none tabular-nums ${d.isToday ? "text-brand" : ""}`}>{num}</div>
                  <div className="text-[9px] uppercase text-muted-2">{month}</div>
                </div>

                <div className="min-w-0 flex-1">
                  {d.allDay.length > 0 && (
                    <div className="mb-1 flex flex-wrap gap-1">
                      {d.allDay.map((a, i) => (
                        <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-muted">
                          {a}
                        </span>
                      ))}
                    </div>
                  )}

                  {d.blocks.length === 0 ? (
                    <p className="py-1 text-[11px] text-muted-2">
                      {d.isWeekend ? "Weekend — nothing booked." : "Clear. A whole day for deep work."}
                    </p>
                  ) : (
                    <div className="space-y-0.5">
                      {d.blocks.map((b, i) => (
                        <div key={i} className="flex items-baseline gap-2 text-xs">
                          <span className="w-24 shrink-0 tabular-nums text-muted-2">
                            {hhmm(b.start)}–{hhmm(b.end)}
                          </span>
                          {b.kind === "shoot" ? (
                            <Camera className="size-3 shrink-0 translate-y-0.5 text-accent" />
                          ) : b.virtual ? (
                            <Video className="size-3 shrink-0 translate-y-0.5 text-muted-2" />
                          ) : (
                            <Users2 className="size-3 shrink-0 translate-y-0.5 text-muted-2" />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {b.projectId ? (
                              <Link href={`/projects/${b.projectId}`} className="hover:underline">
                                {b.title}
                              </Link>
                            ) : (
                              b.title
                            )}
                            {b.bufferBeforeMin > 0 && (
                              <span className="ml-1 text-[10px] text-muted-2">+{b.bufferBeforeMin}m drive each side</span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* How much of the working day survives — the number he's actually
                    scanning for, with a bar so the shape of the week is visible
                    without reading any of it. */}
                <div className="w-20 shrink-0 text-right">
                  <div className={`text-[11px] font-medium tabular-nums ${d.freeMinutes < 120 ? "text-warning" : "text-muted"}`}>
                    {hrs(d.freeMinutes)} free
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={`h-full rounded-full ${d.freeMinutes < 120 ? "bg-warning" : "bg-brand/50"}`}
                      style={{ width: `${Math.min(100, (booked / busiest) * 100)}%` }}
                    />
                  </div>
                  {d.plannedCount > 0 && <div className="mt-0.5 text-[10px] text-muted-2">{d.plannedCount} planned</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
