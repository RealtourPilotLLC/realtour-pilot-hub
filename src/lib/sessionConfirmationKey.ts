// ---------------------------------------------------------------------------
// THE IDENTITY OF A FILMING SESSION CONFIRMATION EMAIL (Oct 26 2026). Pure, so
// the outbox can name the email's subject without loading the sender
// (lib/sessionConfirmation): one email per request, per session start, per
// seat; ":moved" when it confirms a new time.
// ---------------------------------------------------------------------------

const DEFAULT_TZ = "America/New_York";

/** `20261112T1500Z`: the start, colon-free, so the key splits cleanly on ":". */
export const compactStart = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace(/(T\d{4})\d{2}Z$/, "$1Z");
export const sessionConfirmationKey = (requestId: string, start: Date, recipientId: string, moved = false) =>
  `session_confirmation:${requestId}:${compactStart(start)}:${recipientId}${moved ? ":moved" : ""}`;

/** The start a key names, or null. Pure (outbox.subjectFor reads it). */
export function sessionConfirmationStart(dedupeKey: string | null | undefined): Date | null {
  const m = /^session_confirmation:[^:]+:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z(?::|$)/.exec(dedupeKey ?? "");
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** The subject, from the key alone (the outbox has no subject column). Dates in ET, where every client is. */
export function sessionConfirmationSubject(dedupeKey: string | null | undefined): string {
  const start = sessionConfirmationStart(dedupeKey);
  const day = start ? new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, weekday: "long", month: "long", day: "numeric" }).format(start) : null;
  if ((dedupeKey ?? "").endsWith(":moved")) return day ? `Your filming session has moved to ${day}` : "Your filming session has moved";
  return day ? `Your filming session is booked for ${day}` : "Your filming session is booked";
}

