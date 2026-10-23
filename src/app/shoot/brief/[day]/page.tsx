import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardCheck, CloudSun, KeyRound, MapPin, Phone, Plane } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/user";
import { authEnforced } from "@/lib/auth/guards";
import { homeFor, isCreativeLead } from "@/lib/auth/access";
import { getShootPhotographer, photographerMemberId } from "@/lib/shoot";
import { etDateTime, etTime } from "@/lib/datetime";
import { PageHeader } from "@/components/PageHeader";
import { Section } from "@/components/ui/Section";
import { BriefGotIt } from "@/components/shoot/BriefGotIt";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// THE FULL BRIEF (Oct 23 2026, lib/photographerBrief). The page the brief text
// links to: every visit of one photographer's day, everything the text carries
// and the rest (the earlier visit's notes, folded; the forecast; the FAA map
// for a drone job), and "Got it".
//
// WHO. A signed-in photographer sees their OWN day only (fail closed). The
// office and the creative manager can open anyone's (?as=<team member>) to
// look; only the photographer whose brief it is can press Got it, never a
// preview. Everyone else goes home.
//
// Weather and airspace are for planning only: the flight decision stays with
// the pilot, so nothing here says go or no-go.
// ---------------------------------------------------------------------------

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export default async function ShootBriefPage({ params, searchParams }: { params: Promise<{ day: string }>; searchParams: Promise<{ as?: string }> }) {
  const { day } = await params;
  const { as } = await searchParams;
  const user = await getCurrentUser();
  if (!user && authEnforced()) redirect(`/login?next=/shoot/brief/${encodeURIComponent(day)}`);
  if (!DAY_KEY.test(day)) redirect("/shoot");
  if (user && user.role !== "PHOTOGRAPHER" && !isCreativeLead(user.role)) redirect(homeFor(user.role));

  const own = user ? await photographerMemberId(user).catch(() => null) : null;
  // A photographer never carries ?as=: always their own brief.
  const viewAs = user?.role !== "PHOTOGRAPHER" && as ? await getShootPhotographer(as) : null;
  const memberId = viewAs?.id ?? own;
  if (!memberId) {
    return (
      <div>
        <PageHeader eyebrow="Field" title="Shoot brief" />
        <div className="mx-auto max-w-2xl px-4 py-5 sm:px-6">
          <p className="text-sm text-muted">Your login isn&rsquo;t linked to a photographer on the team, so there is no brief to show.</p>
        </div>
      </div>
    );
  }
  const { briefPageView, dayWords } = await import("@/lib/photographerBrief");
  const v = await briefPageView(memberId, day);
  const canAck = !!user && !user.impersonating && own === memberId;
  const preview = !canAck;

  // Planning information, fetched for this page only (never in the text).
  const { shootWeatherAt } = await import("@/lib/opsDay");
  const { droneAirspace } = await import("@/lib/faa");
  const shoots = v.brief?.shoots ?? [];
  const extras = await Promise.all(
    shoots.map(async (s) => {
      const x = v.brief?.extras.get(s.appointmentId);
      if (!x || x.lat == null || x.lng == null) return { weather: null, airspace: null, x };
      const [weather, airspace] = await Promise.all([
        shootWeatherAt(x.lat, x.lng, s.startISO).catch(() => null),
        x.drone ? droneAirspace(x.lat, x.lng).catch(() => null) : Promise.resolve(null),
      ]);
      return { weather, airspace, x };
    }),
  );

  const title = `Shoot brief, ${dayWords(day)}`;
  const name = v.brief?.name ?? viewAs?.name ?? "";
  return (
    <div>
      <PageHeader eyebrow="Field" title={title} subtitle={preview ? `${name ? `${name}'s brief. ` : ""}Read only: only the photographer can tap Got it.` : "Everything for your shoots that day. Read it, then tap Got it at the bottom."} />
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-5 sm:px-6">
        {v.status && (
          <p className={`rounded-xl border px-3 py-2 text-sm ${v.ackHolds ? "border-success/30 bg-success/10 text-success" : v.changesSinceAck.length ? "border-warning/30 bg-warning/10" : "border-border bg-surface"}`}>
            {v.ackHolds && v.record?.ack
              ? `Got it, ${etDateTime(v.record.ack.at)}. Nothing has changed since.`
              : v.changesSinceAck.length
                ? `Changed since your Got it: ${v.changesSinceAck.join("; ")}. Please read it again and tap Got it.`
                : v.record?.firstSentAt
                  ? `Sent ${etDateTime(v.record.firstSentAt)}.`
                  : v.status.state === "off"
                    ? "The brief text is switched off for now; this page is still current."
                    : v.status.why ?? ""}
          </p>
        )}
        {!shoots.length && <p className="text-sm text-muted">No shoots on {dayWords(day)}.</p>}
        {shoots.map((s, i) => {
          const e = extras[i];
          const mapsHref = `https://maps.google.com/?q=${encodeURIComponent(s.address)}`;
          const tel = s.contact?.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0]?.replace(/\D/g, "") ?? null;
          return (
            <Section key={s.appointmentId} icon={ClipboardCheck} title={`${i + 1}. ${s.time}, ${s.street}`} count={s.visit ? `visit ${s.visit.n} of ${s.visit.of}` : undefined} bodyClassName="space-y-3 text-sm leading-relaxed">
              <p className="flex items-start gap-2"><MapPin className="mt-0.5 size-4 shrink-0 text-muted" /><a className="underline underline-offset-2" href={mapsHref} target="_blank" rel="noreferrer">{s.address}</a></p>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-brand">Services this visit</div>
                {s.servicesNote ? <p className="text-warning">{s.servicesNote}</p> : <ul className="list-disc pl-5">{s.services.map((x) => <li key={x}>{x}</li>)}</ul>}
              </div>
              {s.access.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-brand"><KeyRound className="size-3.5" /> Access</div>
                  <ul className="list-disc pl-5">{s.access.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              )}
              {s.contact && (
                <p className="flex items-center gap-2"><Phone className="size-4 shrink-0 text-muted" />{tel ? <a className="underline underline-offset-2" href={`tel:+1${tel.slice(-10)}`}>{s.contact}</a> : s.contact}</p>
              )}
              {([["Must get", s.must], ["Leave out", s.leave], ["Requests", s.requests]] as const).map(([label, list]) =>
                list.length ? (
                  <div key={label}>
                    <div className="text-[11px] font-bold uppercase tracking-wider text-brand">{label}</div>
                    <ul className="list-disc pl-5">{list.map((x) => <li key={x}>{x}</li>)}</ul>
                  </div>
                ) : null,
              )}
              {s.earlier.length > 0 && (
                <details className="rounded-lg border border-dashed border-border p-2">
                  <summary className="cursor-pointer text-[13px] text-muted">Notes from an earlier visit or the booking ({s.earlier.length}). Not for this visit unless Kyle says so.</summary>
                  <ul className="mt-2 list-disc pl-5 text-[13px] text-muted">{s.earlier.map((x) => <li key={x}>{x}</li>)}</ul>
                </details>
              )}
              {(e?.weather || e?.airspace) && (
                <div className="rounded-lg bg-surface-2/60 p-2 text-[13px]">
                  {e.weather && <p className="flex items-center gap-1.5"><CloudSun className="size-4 shrink-0 text-muted" />Forecast at {etTime(new Date(s.startISO))}: {e.weather.tempF}°F, {e.weather.precipPct}% chance of rain, wind {e.weather.windMph} mph.</p>}
                  {e.airspace && (
                    <p className="mt-1 flex items-start gap-1.5"><Plane className="mt-0.5 size-4 shrink-0 text-muted" />
                      {!e.airspace.available
                        ? "The FAA airspace map could not be read just now."
                        : e.airspace.status === "clear"
                          ? "FAA UAS map: uncontrolled airspace (Class G) here."
                          : e.airspace.status === "laanc"
                            ? `FAA UAS map: controlled airspace (Class ${e.airspace.airspaceClass ?? "?"}) near ${e.airspace.airport ?? "an airport"}, LAANC grid up to ${e.airspace.ceiling} ft.`
                            : `FAA UAS map: controlled airspace (Class ${e.airspace.airspaceClass ?? "?"}) near ${e.airspace.airport ?? "an airport"} with a 0 ft LAANC grid.`}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-muted-2">For planning only. Whether and how to fly is the pilot&rsquo;s call.</p>
                </div>
              )}
              <Link href={`/shoot/${s.projectId}${viewAs ? `?as=${viewAs.id}` : ""}`} className="inline-block text-[13px] font-medium text-brand underline underline-offset-2">Open the shoot screen</Link>
            </Section>
          );
        })}
        {shoots.length > 0 && v.brief && (canAck ? (
          v.ackHolds ? null : <BriefGotIt day={day} digest={v.brief.digest} again={!!v.record?.ack} />
        ) : (
          <p className="text-xs text-muted">Only {v.brief.name.split(" ")[0]} can tap Got it on this brief.</p>
        ))}
      </div>
    </div>
  );
}
