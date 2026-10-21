import Link from "next/link";
import { Camera, CloudSun, ExternalLink, MessageSquare, Plane, Zap } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { cn } from "@/lib/utils";
import type { OpsShoot } from "@/lib/opsDay";
import { aryeoJobUrl, aryeoJobTitle } from "@/lib/aryeoUrl";

// ---------------------------------------------------------------------------
// WHAT THE OLD DAILY CHECKLIST LEFT BEHIND (Oct 19 2026, evening).
//
// This file held the ten time blocks of Jordan's "Daily Operations & Client
// Experience Structure" (Sep 1 2026), on Home and then, for one afternoon, on
// /ops. Jordan, that evening: the checklist belongs on Kyle's Home, "just
// keep it simplified" (components/home/Checklist.tsx, lib/opsHome). The
// blocks are gone. What other screens still use stays here:
//   · today's shoot cards (ShootList, RushChip): the drop-in card
//     components/home/TodaysShoots, on the dashboard;
//   · etMinutes (the dashboard's greeting). The review seat's Home helpers
//     went with his desk (Oct 19 2026, night: one dashboard for the office).
// ---------------------------------------------------------------------------

const ET = "America/New_York";

export function etMinutes(d: Date): number {
  const [h, m] = d
    .toLocaleTimeString("en-US", { timeZone: ET, hour: "2-digit", minute: "2-digit", hour12: false })
    .split(":")
    .map(Number);
  return h * 60 + m;
}
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: ET, hour: "numeric", minute: "2-digit" });

// "Tue 9:00 AM" — a turnaround promise needs the hour, not just the day.
const fmtDayTime = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit" });
// ---- Same-day rush (Jordan, Sep 2: "notify the morning tower about shoots
// with same-day delivery photos or floor plans") ------------------------------
// The flag is decided ONCE, in opsDay.ts (OpsShoot.sameDay, off the order's
// line items, dated by the SLA engine). Everything here is the length of the
// list it points at: the chip on "Today's shoots" is the count of flagged
// cards in it, and nothing else.
export const rushShoots = (shoots: OpsShoot[]) => shoots.filter((s) => s.sameDay);
/** "photos + floor plan" — the same words on the card, the chip and the tower row. */
const rushWhat = (s: OpsShoot) =>
  [s.sameDay?.photos ? "photos" : null, s.sameDay?.floorPlan ? "floor plan" : null].filter(Boolean).join(" + ");

/** The red "⚡ N same-day" chip — one component so the header, the jump bar
 *  and the shoots section can never phrase it three ways. */
export function RushChip({ n, small, onBrand }: { n: number; small?: boolean; onBrand?: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-full font-bold tabular-nums",
        small ? "px-1.5 text-[10px]" : "px-2.5 py-0.5 text-xs",
        onBrand ? "bg-white text-danger" : "bg-danger text-white",
      )}
      title={`${n} shoot${n === 1 ? "" : "s"} promised same-day delivery — photos or floor plan due by end of business`}
    >
      <Zap className={small ? "size-2.5" : "size-3"} /> {n} same-day
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed">
      <span className="font-semibold text-foreground/90">{label}: </span>
      <span className="text-foreground/75">{children}</span>
    </p>
  );
}

// A client's name with their Aryeo headshot in front of it, sized for a
// one-line row. Jordan (Sep 2): "if the agent has a profile photo in aryeo that
// should be shown … in other places the clients are mentioned." Inline-flex so
// it sits inside the existing text runs (" · shot Aug 21 · Harrison") without
// reflowing them; <Avatar> draws the initials disc when Aryeo has no photo, so
// callers pass the row's clientAvatarUrl straight through.
function ClientName({ name, src, size = 18 }: { name: string; src: string | null; size?: number }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 align-middle">
      <Avatar name={name} src={src} size={size} />
      <span className="min-w-0 whitespace-normal [overflow-wrap:anywhere]">{name}</span>
    </span>
  );
}

export function ShootList({ shoots, empty, showGaps, showDebrief }: { shoots: OpsShoot[]; empty: string; showGaps?: boolean; showDebrief?: boolean }) {
  if (shoots.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <div className="space-y-2.5">
      {shoots.map((s) => (
        <div key={s.id} className="rounded-xl border border-border px-4 py-3">
          {/* Header: time · address · quick links */}
          <div className="flex flex-wrap items-center gap-2">
            <Camera className="size-4 shrink-0 text-muted-2" />
            <Link href={`/projects/${s.id}`} className="min-w-0 flex-1 basis-48 [overflow-wrap:anywhere] text-[15px] font-semibold hover:text-brand">{s.title}</Link>
            {s.timeISO && <span className="shrink-0 text-sm font-semibold tabular-nums text-brand">{fmtTime(s.timeISO)}</span>}
            {/* The listing editor when the job has a listing, the ORDER
                editor when it doesn't: a job imported from a ghost order
                (39 Saratoga Ln) had an Aryeo button on its project page and
                none here (Kyle call, Sep 16). */}
            {aryeoJobUrl(s) && (
              <a
                href={aryeoJobUrl(s)!}
                target="_blank" rel="noopener noreferrer"
                title={aryeoJobTitle(s)}
                className="shrink-0 rounded-lg border border-border p-1.5 text-muted hover:bg-surface-2 hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>

          {/* Same-day rush strip — the client paid to have this media TODAY.
              Full-width, red, above every other field, so nobody reads the
              door code and misses that the gallery is due by 5. The hour is
              the SLA engine's (opsDay → tasks.ts sameDayDue), the same one on
              the QC card. Tomorrow's cards carry it too, with the day. */}
          {s.sameDay && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-danger/50 bg-danger/10 px-3 py-1.5 text-[13px] text-danger">
              <span className="inline-flex items-center gap-1.5 font-bold uppercase tracking-wide">
                <Zap className="size-4 shrink-0" /> Same-day {rushWhat(s)}
              </span>
              {s.sameDay.dueISO && (
                <span className="ml-auto font-semibold tabular-nums">due {fmtDayTime(s.sameDay.dueISO)}</span>
              )}
            </div>
          )}

          <div className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <Field label="Client"><ClientName name={s.clientName} src={s.clientAvatarUrl} size={16} /></Field>
            <Field label="Creative">{s.photographer ?? <span className="font-semibold text-danger">unassigned</span>}</Field>
            <Field label="Services">{s.services.join(", ") || "—"}</Field>
            {s.access.name && <Field label="Contact">{s.access.name}{s.access.phone ? ` · ${s.access.phone}` : ""}</Field>}
            {/* The door code is the single most operational thing on this card —
                give it its own emphasised row, not a buried note (audit HIGH). */}
            {s.access.lockbox && (
              <div className="sm:col-span-2">
                <Field label="Lockbox / door code">
                  <span className="font-semibold text-brand">{s.access.lockbox}</span>
                </Field>
              </div>
            )}
            {s.access.access && <div className="sm:col-span-2"><Field label="Getting in">{s.access.access}</Field></div>}
            {s.access.presence && <Field label="Who's there">{s.access.presence}</Field>}
            {s.access.special && (
              <div className="sm:col-span-2">
                <Field label="Special instructions"><span className="text-warning">{s.access.special}</span></Field>
              </div>
            )}
            {s.access.orderNotes && <div className="sm:col-span-2"><Field label="Order notes">{s.access.orderNotes}</Field></div>}
            {s.access.notes && <div className="sm:col-span-2"><Field label="Client preferences">{s.access.notes}</Field></div>}
            {s.specialRequests.length > 0 && (
              <div className="sm:col-span-2">
                <p className="text-[13px] leading-relaxed">
                  <span className="font-semibold text-warning">Special requests: </span>
                  <span className="text-foreground/75">{s.specialRequests.join(" · ").slice(0, 200)}</span>
                </p>
              </div>
            )}
          </div>

          {/* Conditions + comms strip */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 pt-2 text-[13px]">
            {s.weather && (
              <span className={cn("inline-flex items-center gap-1", s.weather.precipPct >= 40 || s.weather.windMph >= 20 ? "font-semibold text-warning" : "text-muted")}>
                <CloudSun className="size-3.5" />
                {s.weather.tempF}° · {s.weather.precipPct}% rain · wind {s.weather.windMph} mph
              </span>
            )}
            {s.droneOrdered && s.airspace && (
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  !s.airspace.available ? "text-muted" : s.airspace.warning ? "font-semibold text-warning" : "text-success",
                )}
                title={s.airspace.airport ? `Controlling airport: ${s.airspace.airport}` : undefined}
              >
                <Plane className="size-3.5" />
                {!s.airspace.available ? (
                  <>
                    Airspace check unavailable —{" "}
                    <a href="https://b4ufly.aloft.ai/" target="_blank" rel="noopener noreferrer" className="underline">
                      verify on B4UFLY
                    </a>
                  </>
                ) : s.airspace.status === "clear" ? (
                  "Airspace clear — OK to 400 ft"
                ) : s.airspace.status === "restricted" ? (
                  `No-fly without FAA authorization${s.airspace.airport ? ` (${s.airspace.airport})` : ""} — 0 ft grid`
                ) : (
                  `LAANC required — auto-auth to ${s.airspace.ceilingFt} ft${s.airspace.airport ? ` near ${s.airspace.airport}` : ""}`
                )}
              </span>
            )}
            {s.comms && (
              <Link href={`/communications`} className={cn("inline-flex min-h-9 items-center gap-1 hover:underline", s.comms.count > 0 && s.comms.latestInbound ? "font-semibold text-brand" : "text-muted")}>
                <MessageSquare className="size-3.5" />
                {s.comms.count > 0 && (
                  <>
                    {s.comms.count} msg{s.comms.count === 1 ? "" : "s"} (72h)
                    {s.comms.latestSnippet && <> · {s.comms.latestInbound ? "them" : "us"}: &ldquo;{s.comms.latestSnippet.slice(0, 60)}&rdquo;</>}
                  </>
                )}
                {s.comms.otherCount > 0 && (
                  <span className="text-muted-2">{s.comms.count > 0 ? "· " : ""}+{s.comms.otherCount} on other job{s.comms.otherCount === 1 ? "" : "s"}</span>
                )}
              </Link>
            )}
            {/* "Shot" is the appointment's END (OpsShoot.endISO), not its start:
                at 12:04 PM both cards read "upload page not submitted" for
                photographers still on site until 1:45 and 2:30 (audit5 F8).
                While the shoot is running, say that instead — and only print
                the hour when Aryeo booked one, not the 2h assumption. */}
            {showDebrief && s.timeISO && s.endISO && !s.debriefSubmitted &&
              new Date(s.timeISO) < new Date() && new Date(s.endISO) >= new Date() && (
              <span className="text-muted">On site now{s.endAssumed ? "" : ` — until ${fmtTime(s.endISO)}`}</span>
            )}
            {showDebrief && s.endISO && (s.debriefSubmitted || new Date(s.endISO) < new Date()) && (
              <span className={cn(s.debriefSubmitted ? "text-success" : "font-semibold text-warning")}>
                {s.debriefSubmitted ? "Upload page submitted ✓" : "Shot — upload page not submitted"}
              </span>
            )}
            {showGaps && s.gaps.length > 0 && (
              <span className="font-semibold text-danger">Missing: {s.gaps.join(" · ")}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

