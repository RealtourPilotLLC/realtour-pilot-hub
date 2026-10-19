import Link from "next/link";
import { Camera, CloudSun, ExternalLink, MessageSquare, Plane, Zap } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import { etDayStartUtc } from "@/lib/datetime";
import type { OpsDay, OpsShoot } from "@/lib/opsDay";
import { isNeedsAssigning } from "@/lib/triage";
import { boardWhere, photoQcWhere } from "@/lib/taskBoard";
import { clientTextWhere } from "@/lib/clientTexts";
import { unansweredCommsBoard } from "@/lib/commsBoard";
import { aryeoJobUrl, aryeoJobTitle } from "@/lib/aryeoUrl";

// ---------------------------------------------------------------------------
// WHAT THE OLD DAILY CHECKLIST LEFT BEHIND (Oct 19 2026, evening).
//
// This file held the ten time blocks of Jordan's "Daily Operations & Client
// Experience Structure" (Sep 1 2026), on Home and then, for one afternoon, on
// /ops. Jordan, that evening: the checklist belongs on Kyle's Home, "just
// keep it simplified" (components/home/Checklist.tsx, lib/opsHome). The
// blocks are gone. What other screens still use stays here:
//   · today's shoot cards (ShootList, RushChip): /ops#shoots;
//   · the review seat's Home helpers (listingQc, offPageNumbers,
//     deliveryUnavailable, ageText, etMinutes).
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
// "3h" / "2 days" — how long something has sat, in the unit a person would use.
export function ageText(iso: string, now: Date): string {
  const h = Math.floor((now.getTime() - Date.parse(iso)) / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

// Listing QC only. Monthly personal-branding content runs on its own rhythm (a
// BATCH of videos on a 7-10 business-day window) and has its own card.
export const listingQc = (d: OpsDay) => d.qc.filter((q) => !q.monthly);

// ---------------------------------------------------------------------------
// The off-page numbers, each one its destination's own query.
// ---------------------------------------------------------------------------

// The review seat's Home counts use the destinations' shared queries,
// including their client scope.
export async function offPageNumbers(excludeClientIds: string[] = []) {
  const [board, qc, textsToSend, emailsWaiting] = await Promise.all([
    // The Other tab's rows themselves (a dozen or so) — "running late" and
    // "to assign" are then counted off that set with the tab's OWN arithmetic,
    // so a row can never disagree with the header it lands on.
    prisma.smartTask.findMany({
      where: boardWhere(null, { excludeClientIds }),
      select: { assignedKey: true, taskType: true, dueAt: true },
    }),
    prisma.smartTask.count({ where: photoQcWhere({ excludeClientIds }) }),
    // The comms Outbox lists exactly clientTextWhere() (ClientTextsPanel), and
    // its tab badge is this same count.
    prisma.smartTask.count({ where: clientTextWhere(new Date(), { excludeClientIds }) }),
    // The Comms tab's Email sub-tab renders one card per sender-group; its own
    // "Email N" pill is this number.
    unansweredCommsBoard("email", new Date(), { excludeClientIds }).then((g) => g.length).catch(() => 0),
  ]);
  // BoardView's overdue rule verbatim: due before the START of today in ET, so
  // something due later today is not "late".
  const startToday = etDayStartUtc(new Date()).getTime();
  return {
    boardOpen: board.length,
    late: board.filter((t) => t.dueAt !== null && t.dueAt.getTime() < startToday).length,
    toAssign: board.filter(isNeedsAssigning).length,
    qc,
    textsToSend,
    emailsWaiting,
  };
}

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

/** The delivery follow-up could not be fully checked (the review seat's notice). */
export function deliveryUnavailable(d: OpsDay): boolean {
  const b = d.readySend;
  return !!b.boardUnavailable || b.followUpChecks?.needsFinishing === null || b.followUpChecks?.notTold === null || b.noticeIncidentCheck === null;
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
              <Link href={`/communications`} className={cn("inline-flex items-center gap-1 hover:underline", s.comms.count > 0 && s.comms.latestInbound ? "font-semibold text-brand" : "text-muted")}>
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

