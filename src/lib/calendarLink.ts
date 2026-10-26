// ---------------------------------------------------------------------------
// "ADD TO GOOGLE CALENDAR" (Oct 26 2026): the filming session confirmation
// email (lib/sessionConfirmation) and the portal's booked panel
// (PortalScheduler) link to the same event. Pure, so a client component may
// import it.
// ---------------------------------------------------------------------------

/** Google Calendar's own "add event" page, filled in. */
export function googleCalendarLink(input: { title: string; start: Date; end: Date; location: string | null; details: string }): string {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const q = new URLSearchParams({ action: "TEMPLATE", text: input.title, dates: `${stamp(input.start)}/${stamp(input.end)}`, details: input.details });
  if (input.location) q.set("location", input.location);
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

/** The session's event, worded once for both. */
export function filmingSessionEvent(input: { start: Date; end: Date | null; location: string | null; creativeName: string | null; office: { name: string; display: string } }) {
  return {
    title: "Realtour Pilot filming session",
    start: input.start,
    end: input.end ?? new Date(input.start.getTime() + 2 * 3_600_000),
    location: input.location,
    details: [input.creativeName ? `With ${input.creativeName}.` : null, `Anything within 24 hours: call or text ${input.office.name} at ${input.office.display}.`].filter(Boolean).join(" "),
  };
}
