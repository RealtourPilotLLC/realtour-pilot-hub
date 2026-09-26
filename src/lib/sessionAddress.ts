import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { ProgramSessionAddress } from "@prisma/client";
import { URGENT_CONTACT } from "@/lib/reviewWindows";
import { looksLikeGeneralArea } from "@/lib/programReminders";

// ---------------------------------------------------------------------------
// SESSION ADDRESSES (CP-05, Sep 24 2026) — pure helpers.
//
// §6.6 W02 (Sep 25 2026): a session booked FROM THE PORTAL starts from an exact,
// geocoded address — the session plan below (ProgramSessionPlan) — before any
// confirmable time is offered; the portal no longer takes "just the area".
// A GENERAL AREA ("West Chester, PA") remains the house pattern on sessions
// booked by hand in Aryeo and on legacy requests, and for those it is not an
// error. What the filming day needs is an exact street address, and this file
// is everything that turns the one into the other without guessing:
//
//   · parse what a client typed, but never invent a street for an area;
//   · validate the structured form the address link shows;
//   · compare two addresses the way a person would (so a resubmit of the same
//     address is a no-op, and a readback that matches is a match);
//
// The database and provider half — the per-session link, the save, the Aryeo
// sync and its readback — is below the divider.
// ---------------------------------------------------------------------------

export type ParsedAddress = {
  streetNumber: string | null;
  streetName: string | null;
  unit: string | null;
  city: string | null;
  stateCode: string | null;
  postalCode: string | null;
  /** a street number AND a street name were found — an address, not an area */
  exact: boolean;
};

export type ExactAddressInput = { street: string; unit?: string | null; city: string; state: string; zip: string };
export type ExactAddress = { streetNumber: string; streetName: string; unit: string | null; city: string; stateCode: string; postalCode: string };

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** "117 Kyle Lane" → number + name. A leading number is REQUIRED, the same test
 *  looksLikeGeneralArea uses, so "Main Street" alone is never an address. */
export function parseStreet(street: string): { street_number: string; street_name: string } | null {
  const m = /^\s*(\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?)\s+(\S.*?)\s*$/.exec(street ?? "");
  if (!m) return null;
  return { street_number: m[1], street_name: clean(m[2]) };
}

/**
 * What a client typed into the one booking box, read as far as it goes and no
 * further. "117 Kyle Lane, Unit 2, West Chester, PA 19382" is an address;
 * "West Chester, PA 19382" and "our office in Media" are areas, and an area
 * keeps its street fields null — Aryeo gets the town, never a made-up street.
 */
export function parseFreeAddress(text: string | null | undefined): ParsedAddress {
  const parts = clean(text).split(",").map((p) => p.trim()).filter(Boolean);
  const out: ParsedAddress = { streetNumber: null, streetName: null, unit: null, city: null, stateCode: null, postalCode: null, exact: false };
  if (parts.length === 0) return out;
  // The tail: "PA 19382", "PA", "19382", or "Pennsylvania 19382" (state words
  // are left alone — only a two-letter code is trusted as a state).
  const tail = parts[parts.length - 1];
  const tm = /^([A-Za-z]{2})?\s*(\d{5})?(?:-\d{4})?$/.exec(tail);
  if (tm && (tm[1] || tm[2])) {
    out.stateCode = tm[1] ? tm[1].toUpperCase() : null;
    out.postalCode = tm[2] ?? null;
    parts.pop();
  }
  const street = parts.length ? parseStreet(parts[0]) : null;
  if (street && !looksLikeGeneralArea(parts[0])) {
    out.streetNumber = street.street_number;
    out.streetName = street.street_name;
    parts.shift();
    if (parts.length > 1 && /^(unit|apt|apartment|suite|ste|#)\b/i.test(parts[0])) out.unit = parts.shift() ?? null;
  }
  if (parts.length) out.city = parts[parts.length - 1];
  out.exact = !!(out.streetNumber && out.streetName);
  return out;
}

/** The structured form, checked. Refuses anything that reads as an area. */
export function validateExactAddress(i: ExactAddressInput): { ok: true; value: ExactAddress } | { ok: false; message: string } {
  const street = clean(i.street).slice(0, 120);
  const parsed = parseStreet(street);
  if (!street || !parsed || looksLikeGeneralArea(street)) {
    return { ok: false, message: "Add the house or building number and the street, for example 117 Kyle Lane." };
  }
  const city = clean(i.city).slice(0, 60);
  if (!city) return { ok: false, message: "Add the town or city." };
  const state = clean(i.state).toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) return { ok: false, message: "Use the two-letter state, for example PA." };
  const zip = clean(i.zip);
  if (!/^\d{5}(-\d{4})?$/.test(zip)) return { ok: false, message: "Add the five-digit ZIP code." };
  const unit = clean(i.unit).slice(0, 30) || null;
  return { ok: true, value: { streetNumber: parsed.street_number, streetName: parsed.street_name, unit, city, stateCode: state, postalCode: zip.slice(0, 5) } };
}

const SUFFIX: Record<string, string> = {
  street: "st", avenue: "ave", av: "ave", road: "rd", lane: "ln", drive: "dr", court: "ct", boulevard: "blvd", place: "pl",
  circle: "cir", terrace: "ter", highway: "hwy", parkway: "pkwy", way: "way", trail: "trl", pike: "pike", square: "sq",
  north: "n", south: "s", east: "e", west: "w",
};
const normWords = (s: string | null | undefined) =>
  clean(s).toLowerCase().replace(/[.,#]/g, " ").split(/\s+/).filter(Boolean).map((w) => SUFFIX[w] ?? w).join(" ");
const normUnit = (s: string | null | undefined) => normWords(s).replace(/^(unit|apt|apartment|suite|ste)\s+/, "");

/** Two addresses a person would call the same: number, street, unit and ZIP. */
export function sameAddress(
  a: { streetNumber?: string | null; streetName?: string | null; unit?: string | null; postalCode?: string | null } | null,
  b: { streetNumber?: string | null; streetName?: string | null; unit?: string | null; postalCode?: string | null } | null,
): boolean {
  if (!a || !b) return false;
  if (!a.streetNumber || !b.streetNumber || !a.streetName || !b.streetName) return false;
  return (
    normWords(a.streetNumber) === normWords(b.streetNumber) &&
    normWords(a.streetName) === normWords(b.streetName) &&
    normUnit(a.unit) === normUnit(b.unit) &&
    clean(a.postalCode).slice(0, 5) === clean(b.postalCode).slice(0, 5)
  );
}

/** "117 Kyle Lane, Unit 2, West Chester, PA 19382". */
export function formatAddressLine(a: { streetNumber?: string | null; streetName?: string | null; unit?: string | null; city?: string | null; stateCode?: string | null; postalCode?: string | null }): string {
  const street = [a.streetNumber, a.streetName].filter(Boolean).join(" ");
  const unit = a.unit ? (/^(unit|apt|suite|ste|#)/i.test(a.unit) ? a.unit : `Unit ${a.unit}`) : null;
  const tail = [a.stateCode, a.postalCode].filter(Boolean).join(" ");
  return [street, unit, a.city, tail].filter(Boolean).join(", ");
}

/** Street and ZIP only. Project rows keep no unit, so the LOCAL readback (our own
 *  order sync) can only speak to these; the provider readback uses sameAddress. */
export function sameStreet(
  a: { streetNumber?: string | null; streetName?: string | null; postalCode?: string | null } | null,
  b: { streetNumber?: string | null; streetName?: string | null; postalCode?: string | null } | null,
): boolean {
  return sameAddress(a ? { ...a, unit: null } : null, b ? { ...b, unit: null } : null);
}

/** What the client reads about a saved address. Never "synced" on a local save. */
export function addressClientNote(syncState: string): string {
  if (syncState === "SYNCED") return "Confirmed on your booking.";
  if (syncState === "FAILED" || syncState === "CONFLICT") return "Saved. Kyle is updating your booking by hand.";
  return "Saved. Updating your booking.";
}

// ===========================================================================
// THE DATABASE AND PROVIDER HALF.
//
// ONE ROW PER SESSION, keyed on the session's identity — the same key
// countDistinctSessions gives it (`appt:<aryeoId>` | `project:<id>`). Not on a
// ProgramSessionRequest: nearly every real content session was booked by hand
// in Aryeo with no request behind it, and an address follow-up keyed on the
// request would miss almost all of them.
//
// THE LINK IS A BEARER CREDENTIAL. 32 random bytes, only its sha256 stored,
// bound to one session, dead at the session's start, never logged. It opens
// this one form and nothing else — not the portal. (The reminder emails' portal
// link is a 15-minute sign-in link that lands on /portal/me; a Friday email
// for a Monday session cannot use it, which is why this route exists.)
//
// SAVED IS NOT SYNCED. A save says "Saved. Updating your booking." The address
// is CONFIRMED only when Aryeo's copy reads back equal — through the hub's
// own PATCH (address_sync ON, authorised fixtures only) or through Kyle's hand
// edit arriving on the hourly order sync. Anything short of that is a Kyle task.
// ===========================================================================


export const ADDRESS_DEFAULTS = {
  authorizedFixtureClientIds: [] as string[],
  /** Straight-line miles from the booked area that make a travel alert. null = unset (Jordan has not given a number). */
  travelAlertMiles: null as number | null,
  /** Same creative, same day, another appointment within this many minutes of the session = a travel alert. */
  adjacentMinutes: 90,
};
export type AddressConfig = typeof ADDRESS_DEFAULTS;

const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
/** Resubmissions one session may take before the form points at Kyle instead — a flood guard for a forwarded link. */
const MAX_VERSIONS = 10;
const TASK_PREFIX = "program-session-address:";

/** One program session, as the address flow needs it. */
export type ProgramSession = {
  key: string;
  enrollmentId: string;
  clientId: string;
  monthId: string;
  monthKey: string;
  projectId: string | null;
  /** Appointment.aryeoId */
  appointmentId: string | null;
  orderId: string | null;
  requestId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  area: string | null;
};

/**
 * The upcoming sessions of one month, through the month-progress reader's own
 * count (monthBookedSessions → countDistinctSessions), so the address lane, the
 * portal and the sync agree on what a "session" is. Filmed/past sessions and
 * undated ones are left out: there is nobody to send there any more.
 */
export async function upcomingProgramSessions(monthId: string, now: Date = new Date()): Promise<ProgramSession[]> {
  const month = await prisma.contentMonth.findUnique({ where: { id: monthId }, select: { id: true, monthKey: true, enrollmentId: true, clientId: true } });
  if (!month) return [];
  const { monthBookedSessions } = await import("@/lib/monthProgress");
  const count = await monthBookedSessions(month.id, month.clientId, now);
  const live = count.sessions.filter((s) => !s.filmed && s.startsAt && s.startsAt > now);
  if (!live.length) return [];
  const projectIds = [...new Set(live.map((s) => s.projectId).filter((x): x is string => !!x))];
  const apptIds = live.map((s) => s.appointmentId).filter((x): x is string => !!x);
  const [projects, appts, requests] = await Promise.all([
    projectIds.length ? prisma.project.findMany({ where: { id: { in: projectIds } }, select: { id: true, addressLine: true, city: true, state: true, zip: true, aryeoOrderId: true } }) : [],
    apptIds.length ? prisma.appointment.findMany({ where: { aryeoId: { in: apptIds } }, select: { aryeoId: true, endAt: true, projectId: true } }) : [],
    prisma.programSessionRequest.findMany({ where: { monthId, status: "CONFIRMED" }, select: { id: true, aryeoAppointmentId: true, projectId: true, aryeoOrderId: true, locationText: true, slotEnd: true } }),
  ]);
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const apptOf = new Map(appts.map((a) => [a.aryeoId, a]));
  return live.map((s) => {
    const req = requests.find((r) => (s.appointmentId && r.aryeoAppointmentId === s.appointmentId) || (!s.appointmentId && s.projectId && r.projectId === s.projectId)) ?? null;
    const project = s.projectId ? projectOf.get(s.projectId) ?? null : null;
    const area = project
      ? [project.addressLine, project.city, [project.state, project.zip].filter(Boolean).join(" ")].filter((x) => x && String(x).trim()).join(", ") || null
      : req?.locationText ?? null;
    return {
      key: s.key, enrollmentId: month.enrollmentId, clientId: month.clientId, monthId: month.id, monthKey: month.monthKey,
      projectId: s.projectId, appointmentId: s.appointmentId, orderId: project?.aryeoOrderId ?? req?.aryeoOrderId ?? null, requestId: req?.id ?? null,
      startsAt: s.startsAt!, endsAt: (s.appointmentId ? apptOf.get(s.appointmentId)?.endAt : null) ?? req?.slotEnd ?? null,
      // What an exact address is judged against: the project's street when it
      // has one (addressLine), else the area it was booked with.
      area,
    };
  });
}

/** The street part the lane judges ("117 Kyle Lane" or "October 2026 Social Content"). */
async function streetOfSession(s: ProgramSession): Promise<string | null> {
  if (s.projectId) {
    const p = await prisma.project.findUnique({ where: { id: s.projectId }, select: { addressLine: true } });
    return p?.addressLine ?? null;
  }
  return s.area;
}

/** Does this session still need an exact address? No street number on file, and none submitted. */
export async function sessionNeedsAddress(s: ProgramSession): Promise<boolean> {
  const row = await prisma.programSessionAddress.findUnique({ where: { sessionKey: s.key }, select: { submittedAt: true } });
  if (row?.submittedAt) return false;
  return looksLikeGeneralArea(await streetOfSession(s));
}

/**
 * The link's row: found or made for this session, with a FRESH token (only the
 * hash is kept, so every send mints its own). The raw token goes back to the
 * one caller that will put it in the email, and nowhere else.
 */
export async function ensureSessionAddressRow(s: ProgramSession): Promise<{ row: ProgramSessionAddress; rawToken: string }> {
  const rawToken = randomBytes(32).toString("base64url");
  const link = { linkTokenHash: sha(rawToken), linkExpiresAt: s.startsAt };
  const facts = {
    enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId, projectId: s.projectId, aryeoAppointmentId: s.appointmentId,
    aryeoOrderId: s.orderId, requestId: s.requestId, shootStartAt: s.startsAt,
  };
  const existing = await prisma.programSessionAddress.findUnique({ where: { sessionKey: s.key } });
  const row = existing
    ? await prisma.programSessionAddress.update({ where: { id: existing.id }, data: { ...facts, ...link, ...(existing.submittedAt ? {} : { areaText: s.area }) } })
    : await prisma.programSessionAddress.create({ data: { sessionKey: s.key, ...facts, ...link, areaText: s.area } });
  return { row, rawToken };
}

/** The row a link opens, or why it will not. */
export async function sessionAddressByToken(rawToken: string, now: Date = new Date()): Promise<{ ok: true; row: ProgramSessionAddress } | { ok: false; reason: "unknown" | "expired" }> {
  if (!/^[A-Za-z0-9_-]{30,80}$/.test(rawToken ?? "")) return { ok: false, reason: "unknown" };
  const row = await prisma.programSessionAddress.findUnique({ where: { linkTokenHash: sha(rawToken) } });
  if (!row) return { ok: false, reason: "unknown" };
  if (!row.linkExpiresAt || row.linkExpiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, row };
}

/** The session behind a row, re-read now: gone, cancelled or started = null. */
async function liveSessionFor(monthId: string, key: string, now: Date): Promise<ProgramSession | null> {
  return (await upcomingProgramSessions(monthId, now)).find((s) => s.key === key) ?? null;
}

export type AddressActor =
  | { kind: "TOKEN"; token: string }
  | { kind: "PORTAL"; enrollmentId: string; sessionKey: string; by: string }
  | { kind: "STAFF"; enrollmentId: string; sessionKey: string; by: string };

export type SubmitAddressResult = { ok: boolean; message: string; state?: string; duplicate?: boolean };

const SESSION_GONE = `That session is no longer on the calendar, so this address was not saved. Call or text Kyle at ${URGENT_CONTACT} if you still need to change it.`;

/**
 * Save the exact address for ONE session. Idempotent on the address itself:
 * the same address again changes nothing and raises nothing. A new one is a
 * new version, PENDING until the sync reads it back.
 */
export async function submitSessionAddress(actor: AddressActor, input: ExactAddressInput, opts: { now?: Date } = {}): Promise<SubmitAddressResult> {
  const now = opts.now ?? new Date();
  const v = validateExactAddress(input);
  if (!v.ok) return { ok: false, message: v.message };

  let row: ProgramSessionAddress | null = null;
  let session: ProgramSession | null = null;
  if (actor.kind === "TOKEN") {
    const t = await sessionAddressByToken(actor.token, now);
    if (!t.ok) return { ok: false, message: t.reason === "expired" ? `This link has closed because the session has started or passed. Call or text Kyle at ${URGENT_CONTACT}.` : `This link is not active. Call or text Kyle at ${URGENT_CONTACT}.` };
    row = t.row;
    session = await liveSessionFor(row.monthId, row.sessionKey, now);
  } else {
    const months = await prisma.contentMonth.findMany({ where: { enrollmentId: actor.enrollmentId, historical: false }, select: { id: true } });
    for (const m of months) {
      session = await liveSessionFor(m.id, actor.sessionKey, now);
      if (session) break;
    }
    if (session && session.enrollmentId !== actor.enrollmentId) session = null;
    if (session) row = await prisma.programSessionAddress.findUnique({ where: { sessionKey: session.key } }) ?? (await ensureSessionAddressRowWithoutLink(session));
  }
  if (!row || !session) return { ok: false, message: SESSION_GONE };

  const value = v.value;
  const stored = { streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, postalCode: row.postalCode };
  if (row.submittedAt && sameAddress(stored, { ...value, unit: value.unit })) {
    return { ok: true, message: addressClientNote(row.syncState), state: row.syncState, duplicate: true };
  }
  if (row.version >= MAX_VERSIONS) return { ok: false, message: `This session's address has been changed several times already. Call or text Kyle at ${URGENT_CONTACT} and he will update it.` };

  const { geocodeAddress } = await import("@/lib/travel");
  const geo = await geocodeAddress(formatAddressLine(value)).catch(() => null);
  const by = actor.kind === "TOKEN" ? "client:link" : actor.kind === "PORTAL" ? `client:${actor.by}` : `staff:${actor.by}`;
  const updated = await prisma.programSessionAddress.update({
    where: { id: row.id },
    data: {
      streetNumber: value.streetNumber, streetName: value.streetName, unitNumber: value.unit, city: value.city, stateCode: value.stateCode, postalCode: value.postalCode,
      latitude: geo?.lat ?? null, longitude: geo?.lng ?? null,
      submittedAt: now, submittedBy: by, version: { increment: 1 }, syncState: "PENDING", syncAttempts: 0,
      lastError: null, lastErrorAt: null, nextAttemptAt: null, syncedAt: null, readbackJson: null,
      // the facts can have moved since the link was minted (a reschedule)
      shootStartAt: session.startsAt, projectId: session.projectId, aryeoAppointmentId: session.appointmentId, aryeoOrderId: session.orderId,
    },
  });
  // THE OLD ADDRESS'S TASKS GO WITH IT (review, Sep 24 2026). Each version's
  // desk task is keyed by its version, and only a successful sync closed them,
  // so a correction left Kyle two open tasks naming two addresses for one
  // session — and typing the stale one into Aryeo sent the creative there. The
  // earlier versions' tasks are cancelled now; the new one is raised as usual.
  await supersedeAddressTasks(updated);
  if (session.projectId) {
    await prisma.activity.create({
      data: { projectId: session.projectId, type: "SYSTEM", body: `Exact filming address for the ${session.startsAt.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET session: ${row.submittedAt ? formatAddressLine({ ...stored, city: row.city, stateCode: row.stateCode }) : row.areaText ?? "(general area)"} → ${formatAddressLine(value)} (${by}). Saved; not yet on the Aryeo booking.` },
    }).catch(() => null);
  }
  // Inside 24 hours the save still counts, and Kyle hears about it now rather
  // than on the next sync (Jordan: inside 24 hours is a person's job).
  if (session.startsAt.getTime() - now.getTime() < 24 * 3_600_000) {
    await kyleTask(updated, `${TASK_PREFIX}${updated.sessionKey}:urgent:v${updated.version}`, {
      priority: "URGENT",
      title: `Filming address changed inside 24 hours`,
      body: `The client gave ${formatAddressLine(value)} for the session starting ${session.startsAt.toISOString()}. Make sure the creative knows today.`,
    });
  }
  // §6.6 (Sep 25 2026): "Address edits revalidate travel." The booked slot is
  // measured again from the new address against the creative's day
  // (sessionTravel.travelFit). A slot that no longer fits is Kyle's task; the
  // booking is never moved. Aryeo is still asked too once the address reaches
  // the booking (aryeoConflictCheck, after the sync).
  await travelRecheck(updated, session, geo ? { lat: geo.lat, lng: geo.lng } : null, now).catch(() => null);
  return { ok: true, message: "Saved. We are updating your booking.", state: "PENDING" };
}

async function ensureSessionAddressRowWithoutLink(s: ProgramSession): Promise<ProgramSessionAddress> {
  return prisma.programSessionAddress.create({
    data: {
      sessionKey: s.key, enrollmentId: s.enrollmentId, clientId: s.clientId, monthId: s.monthId, projectId: s.projectId, aryeoAppointmentId: s.appointmentId,
      aryeoOrderId: s.orderId, requestId: s.requestId, shootStartAt: s.startsAt, areaText: s.area,
    },
  });
}

/** Per-session address state for the portal card (CP-05). */
export async function sessionAddressViews(
  enrollmentId: string,
  monthId: string,
  facts: { key: string; past: boolean; startsAtISO: string | null }[],
  now: Date = new Date(),
): Promise<Map<string, { area: string | null; needed: boolean; note: string | null }>> {
  const out = new Map<string, { area: string | null; needed: boolean; note: string | null }>();
  const upcoming = facts.filter((f) => !f.past && f.startsAtISO && new Date(f.startsAtISO) > now);
  if (!upcoming.length) return out;
  const sessions = await upcomingProgramSessions(monthId, now);
  const rows = await prisma.programSessionAddress.findMany({ where: { enrollmentId, sessionKey: { in: upcoming.map((f) => f.key) } } });
  for (const f of upcoming) {
    const s = sessions.find((x) => x.key === f.key);
    if (!s) continue;
    const row = rows.find((r) => r.sessionKey === f.key) ?? null;
    if (row?.submittedAt) {
      out.set(f.key, { area: formatAddressLine({ streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, city: row.city, stateCode: row.stateCode, postalCode: row.postalCode }), needed: false, note: addressClientNote(row.syncState) });
      continue;
    }
    out.set(f.key, { area: s.area, needed: looksLikeGeneralArea(await streetOfSession(s)), note: null });
  }
  return out;
}

// ---- Kyle's tasks --------------------------------------------------------------------

async function assignee(enrollmentId: string, monthId: string): Promise<string> {
  try {
    const { ownersFor } = await import("@/lib/contentProgram");
    const o = (await ownersFor(enrollmentId, monthId)).SCHEDULING;
    return (o.label ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "kyle";
  } catch {
    return "kyle";
  }
}

/** TEST clients make no owner work (the house rule) — unless a probe asks, or
 *  the hub really wrote to Aryeo for an authorised fixture, when a person must
 *  be able to find it. Find-then-create; a closed one with the same key stays closed. */
async function kyleTask(row: ProgramSessionAddress, dedupeKey: string, t: { title: string; body: string; priority?: string }): Promise<string | null> {
  const client = await prisma.client.findUnique({ where: { id: row.clientId }, select: { id: true, name: true } });
  const { isTestClientName } = await import("@/lib/testClients");
  if (isTestClientName(client?.name) && process.env.PROGRAM_DESK_TASKS_FOR_TEST !== "1" && row.syncAttempts === 0) return null;
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey }, select: { id: true } });
  if (existing) return existing.id;
  const task = await prisma.smartTask.create({
    data: {
      taskType: "todo", status: "OPEN", source: "content_program", priority: t.priority ?? "HIGH",
      title: `${t.title} — ${client?.name ?? "client"}`.slice(0, 140),
      summary: t.body.slice(0, 500),
      description: `${t.body}\n\nSession ${row.sessionKey}${row.aryeoOrderId ? ` · Aryeo order ${row.aryeoOrderId}` : ""}. Open /content/${row.enrollmentId}#sessions.`,
      reasonCreated: "Content session address (CP-05)", clientId: client?.id ?? null, projectId: row.projectId,
      assignedKey: await assignee(row.enrollmentId, row.monthId), dedupeKey, dueAt: new Date(Date.now() + 24 * 3_600_000),
    },
    select: { id: true },
  }).catch(() => null);
  return task?.id ?? null;
}

/** Cancel the open tasks of every EARLIER version of this session's address (all keys end `:v<n>`). */
async function supersedeAddressTasks(row: ProgramSessionAddress): Promise<void> {
  await prisma.smartTask.updateMany({
    where: { dedupeKey: { startsWith: `${TASK_PREFIX}${row.sessionKey}:` }, NOT: { dedupeKey: { endsWith: `:v${row.version}` } }, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
}

async function closeAddressTasks(row: ProgramSessionAddress): Promise<void> {
  await prisma.smartTask.updateMany({ where: { dedupeKey: { startsWith: `${TASK_PREFIX}${row.sessionKey}:` }, status: { notIn: ["COMPLETED", "CANCELLED"] } }, data: { status: "COMPLETED", completedAt: new Date() } });
}

/**
 * TRAVEL, the last fallback. Jordan, Sep 24 2026: "Aryeo's scheduling API
 * should show the live availability and allow travel time between one address
 * to another"; Sep 25: "Yes, estimate drive time." The measured check is
 * travelRecheck above (drive time + buffer). This same-day heads-up — same
 * creative, another appointment within `adjacentMinutes` (90) — runs only when
 * the drive could NOT be measured (no creative on record, no map point, OSRM
 * down) and Kyle carries the address to Aryeo by hand. The time is never
 * moved. There is no mileage rule (travelAlertMiles stays null).
 */
async function travelCheck(row: ProgramSessionAddress, s: ProgramSession, now: Date): Promise<void> {
  if (!s.appointmentId) return;
  const appt = await prisma.appointment.findUnique({ where: { aryeoId: s.appointmentId }, select: { assignedToId: true, startAt: true, endAt: true, assignedTo: { select: { name: true } } } });
  if (!appt?.assignedToId || !appt.startAt) return;
  const cfg = await addressConfig();
  const gap = cfg.adjacentMinutes * 60_000;
  const end = appt.endAt ?? new Date(appt.startAt.getTime() + 2 * 3_600_000);
  const others = await prisma.appointment.findMany({
    where: { assignedToId: appt.assignedToId, aryeoId: { not: s.appointmentId }, status: { not: "CANCELED" }, startAt: { lt: new Date(end.getTime() + gap) }, endAt: { gt: new Date(appt.startAt.getTime() - gap) } },
    select: { startAt: true, endAt: true },
    take: 3,
  });
  if (!others.length) return;
  const when = (d: Date | null) => (d ? d.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) : "?");
  await kyleTask(row, `${TASK_PREFIX}${row.sessionKey}:travel:v${row.version}`, {
    title: "New filming location may affect travel",
    body: `${appt.assignedTo?.name ?? "The creative"} has another appointment ${others.map((o) => `${when(o.startAt)}–${when(o.endAt)}`).join(", ")} within ${cfg.adjacentMinutes} minutes of this session, and the client just gave ${formatAddressLine({ streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, city: row.city, stateCode: row.stateCode, postalCode: row.postalCode })}. Check the drive. The session time was not changed.`,
  });
  void now;
}

/**
 * §6.6 — THE BOOKED SLOT, MEASURED AGAIN FROM A NEW ADDRESS (W02). The same
 * rule the portal offered the slot under (sessionTravel.travelFit: drive from
 * the creative's previous appointment and to the next, plus the buffer).
 *   · no longer fits  → Kyle's task, the reason in minutes; nothing is moved;
 *   · cannot be checked (no creative on record, no map location, OSRM down) →
 *     the old same-day heads-up, for an address Kyle carries by hand;
 *   · fits            → nothing to do.
 */
async function travelRecheck(row: ProgramSessionAddress, s: ProgramSession, dest: { lat: number; lng: number } | null, now: Date): Promise<void> {
  const req = s.requestId ? await prisma.programSessionRequest.findUnique({ where: { id: s.requestId }, select: { creativeTeamMemberId: true } }) : null;
  const appt = s.appointmentId ? await prisma.appointment.findUnique({ where: { aryeoId: s.appointmentId }, select: { endAt: true, assignedTo: { select: { aryeoTeamMemberId: true, name: true } } } }) : null;
  const creative = req?.creativeTeamMemberId ?? appt?.assignedTo?.aryeoTeamMemberId ?? null;
  if (!dest || !creative) {
    if (!(await aryeoWillBeAsked(row.clientId))) await travelCheck(row, s, now);
    return;
  }
  const { travelFit } = await import("@/lib/sessionTravel");
  const end = s.endsAt ?? appt?.endAt ?? new Date(s.startsAt.getTime() + 2 * 3_600_000);
  const fit = await travelFit({ creativeTeamMemberId: creative, start: s.startsAt, end, dest, now, excludeRequestId: s.requestId, excludeAppointmentIds: s.appointmentId ? [s.appointmentId] : [] });
  if (fit.fits === false) {
    await kyleTask(row, `${TASK_PREFIX}${row.sessionKey}:travel:v${row.version}`, {
      title: "New filming address leaves no room for the drive",
      body: `The client gave ${formatAddressLine({ streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, city: row.city, stateCode: row.stateCode, postalCode: row.postalCode })} for the session starting ${s.startsAt.toISOString()}. ${appt?.assignedTo?.name ?? "The creative"}'s day: ${fit.reason}. Talk to the client or move one of the appointments. The session time was not changed.`,
    });
    return;
  }
  if (fit.fits === null && !(await aryeoWillBeAsked(row.clientId))) await travelCheck(row, s, now);
}

/** Will the hub itself put this client's address on the Aryeo booking? Only
 *  then can Aryeo be asked about travel (the address_sync permit rule). */
async function aryeoWillBeAsked(clientId: string): Promise<boolean> {
  const { automationConfig } = await import("@/lib/programAutomation");
  const cfg = await automationConfig<{ authorizedFixtureClientIds: unknown }>("address_sync", { authorizedFixtureClientIds: [] });
  return !!cfg && Array.isArray(cfg.authorizedFixtureClientIds) && cfg.authorizedFixtureClientIds.includes(clientId);
}

/**
 * THE AUTHORITY ON TRAVEL, once the exact address is ON the Aryeo order: ask
 * Aryeo whether the booked creative is still clear for this appointment
 * (GET /appointments/{id}/availability — its own scheduling rules, including
 * any travel allowance it applies between addresses). A clash is Kyle's task;
 * nothing is moved automatically. A read only — no permit needed, nothing
 * written. Whether has_conflicts counts the appointment itself, and whether
 * Aryeo's answer includes drive time, are settled by the supervised provider
 * test before address_sync is switched on for anyone.
 */
async function aryeoConflictCheck(row: ProgramSessionAddress): Promise<"clear" | "conflict" | "unknown"> {
  if (!row.aryeoAppointmentId) return "unknown";
  const { AryeoBooking, teamMemberIdByUserId } = await import("@/lib/integrations/aryeo");
  let conflict: boolean;
  let who = "The creative";
  try {
    const appt = await AryeoBooking.getAppointment(row.aryeoAppointmentId);
    const teamMemberId = appt.teamMemberIds[0] ?? (appt.userIds[0] ? (await teamMemberIdByUserId()).get(appt.userIds[0]) : undefined);
    if (!teamMemberId || !appt.start_at) return "unknown";
    const minutes = appt.end_at ? Math.max(30, Math.round((new Date(appt.end_at).getTime() - new Date(appt.start_at).getTime()) / 60_000)) : 240;
    const local = await prisma.appointment.findUnique({ where: { aryeoId: row.aryeoAppointmentId }, select: { assignedTo: { select: { name: true } } } });
    who = local?.assignedTo?.name ?? who;
    conflict = await AryeoBooking.appointmentHasConflicts(row.aryeoAppointmentId, teamMemberId, minutes);
  } catch {
    return "unknown";
  }
  if (conflict) {
    await kyleTask(row, `${TASK_PREFIX}${row.sessionKey}:aryeo-conflict:v${row.version}`, {
      title: "Aryeo reports a clash at the new filming address",
      body: `${who}'s availability in Aryeo no longer clears this session now that the exact address is on the booking (${formatAddressLine({ streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, city: row.city, stateCode: row.stateCode, postalCode: row.postalCode })}). Check their day in Aryeo and move one of the appointments. The session time was not changed.`,
    });
  }
  return conflict ? "conflict" : "clear";
}

async function addressConfig(): Promise<AddressConfig> {
  const { automationConfig } = await import("@/lib/programAutomation");
  return (await automationConfig<AddressConfig>("address_sync", ADDRESS_DEFAULTS)) ?? ADDRESS_DEFAULTS;
}

// ---- the sync ------------------------------------------------------------------------

const OPEN_SYNC = ["PENDING", "RUNNING", "UNKNOWN", "DESK", "FAILED", "CONFLICT"];

/**
 * The cron step. Two halves:
 *   · ALWAYS: the local readback. A row whose project now carries the same
 *     street and ZIP (our own hourly order sync copied Aryeo's address in —
 *     Kyle's hand edit, or our PATCH) is SYNCED and its Kyle task closes.
 *   · Only with `address_sync` ON and the client authorised: PATCH the
 *     session's Aryeo address, then GET it back. Otherwise a PENDING row goes to
 *     Kyle's desk (DESK) with the address to type in.
 */
export async function syncSessionAddresses(opts: { now?: Date; max?: number; budgetMs?: number } = {}): Promise<{ checked: number; synced: number; desk: number; patched: number; conflicts: number; failed: number; unknown: number }> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 30_000);
  const tally = { checked: 0, synced: 0, desk: 0, patched: 0, conflicts: 0, failed: 0, unknown: 0 };
  const rows = await prisma.programSessionAddress.findMany({ where: { submittedAt: { not: null }, syncState: { in: OPEN_SYNC } }, orderBy: { submittedAt: "asc" }, take: 200 });
  const { automationConfig } = await import("@/lib/programAutomation");
  const on = await automationConfig<AddressConfig>("address_sync", ADDRESS_DEFAULTS);
  let provider = 0;
  for (const row of rows) {
    tally.checked++;
    if (await localReadback(row, now)) { tally.synced++; continue; }
    if (row.syncState === "DESK" || row.syncState === "CONFLICT" || row.syncState === "FAILED") continue; // Kyle has it; the readback above will close it
    if (!on) {
      if (row.syncState === "PENDING") { await toDesk(row, now, "the hub does not update Aryeo addresses itself yet (address_sync is off)"); tally.desk++; }
      continue;
    }
    if (provider >= (opts.max ?? 10) || deadline - Date.now() < 10_000) continue;
    if (row.nextAttemptAt && row.nextAttemptAt > now) continue;
    provider++;
    const r = await syncOne(row, now);
    if (r === "SYNCED") { tally.synced++; tally.patched++; } else if (r === "DESK") tally.desk++; else if (r === "CONFLICT") tally.conflicts++; else if (r === "FAILED") tally.failed++; else if (r === "UNKNOWN") tally.unknown++;
  }
  return tally;
}

async function localReadback(row: ProgramSessionAddress, now: Date): Promise<boolean> {
  if (!row.projectId) return false;
  const p = await prisma.project.findUnique({ where: { id: row.projectId }, select: { addressLine: true, zip: true, aryeoOrderId: true } });
  const street = p?.addressLine ? parseStreet(p.addressLine) : null;
  if (!street || !sameStreet({ streetNumber: street.street_number, streetName: street.street_name, postalCode: p?.zip ?? null }, { streetNumber: row.streetNumber, streetName: row.streetName, postalCode: row.postalCode })) return false;
  await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "SYNCED", syncedAt: now, readbackJson: JSON.stringify({ source: "order-sync", project: { addressLine: p!.addressLine, zip: p!.zip, orderId: p!.aryeoOrderId } }), lastError: null, leaseUntil: null, leaseBy: null } });
  await closeAddressTasks(row);
  return true;
}

async function toDesk(row: ProgramSessionAddress, now: Date, why: string, state: "DESK" | "CONFLICT" | "FAILED" = "DESK"): Promise<void> {
  const line = formatAddressLine({ streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, city: row.city, stateCode: row.stateCode, postalCode: row.postalCode });
  const taskId = await kyleTask(row, `${TASK_PREFIX}${row.sessionKey}:v${row.version}`, {
    title: state === "DESK" ? "Put the exact filming address on the booking" : state === "CONFLICT" ? "Filming address needs a person" : "Filming address did not update in Aryeo",
    body: `The client gave ${line} for the session starting ${row.shootStartAt?.toISOString() ?? "(unknown)"}${row.areaText ? ` (booked as "${row.areaText}")` : ""}. ${state === "DESK" ? "Update the order's address in Aryeo." : why} This closes on its own once the order sync shows the new street. (${why})`,
  });
  await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: state, lastError: why.slice(0, 1000), lastErrorAt: now, taskId: taskId ?? row.taskId, leaseUntil: null, leaseBy: null } });
}

/** Which Aryeo Address may be changed for this session, or why none may. */
async function resolveAddressTarget(row: ProgramSessionAddress, now: Date): Promise<{ ok: true; addressId: string; orderId: string; exactDiffers: boolean } | { ok: false; conflict: string } | { ok: false; retry: string }> {
  const project = row.projectId ? await prisma.project.findUnique({ where: { id: row.projectId }, select: { aryeoOrderId: true, aryeoListingId: true } }) : null;
  const orderId = row.aryeoOrderId ?? project?.aryeoOrderId ?? null;
  if (!orderId) return { ok: false, conflict: "the session has no Aryeo order on file yet" };
  const { AryeoBooking } = await import("@/lib/integrations/aryeo");
  let order;
  try { order = await AryeoBooking.getOrder(orderId); } catch (e) { return { ok: false, retry: `order read: ${e instanceof Error ? e.message : e}` }; }
  const addressId = order.address?.id ?? null;
  if (!addressId) return { ok: false, conflict: "the Aryeo order has no address record to update" };
  const live = (order.appointments ?? []).filter((a) => (a.status ?? "").toUpperCase() !== "CANCELED" && a.start_at);
  if (row.aryeoAppointmentId) {
    const ours = live.find((a) => a.id === row.aryeoAppointmentId);
    if (!ours) return { ok: false, conflict: "the appointment is no longer on the order (cancelled or moved)" };
    if (row.shootStartAt && Math.abs(new Date(ours.start_at!).getTime() - row.shootStartAt.getTime()) > 60_000) return { ok: false, conflict: "the appointment's time changed since the address was given" };
  }
  // ONE ADDRESS, TWO SESSIONS. An order's Address belongs to the order, so two
  // live sessions on one order share it — changing it for one moves the other.
  // Stricter than "only when the other has a different address": the other
  // session may simply not have answered yet. Hub bookings make one order per
  // session and never land here.
  const siblings = live.filter((a) => a.id !== row.aryeoAppointmentId && new Date(a.start_at!) > now);
  if (siblings.length) return { ok: false, conflict: `the Aryeo order has ${siblings.length + 1} sessions sharing one address record` };
  // A listing's Address is shared with every order on that listing.
  if (project?.aryeoListingId) {
    const others = await prisma.project.count({ where: { aryeoListingId: project.aryeoListingId, id: { not: row.projectId! } } });
    if (others > 0) return { ok: false, conflict: "the address record is shared with another job on the same Aryeo listing" };
  }
  const a = order.address!;
  const exactDiffers = !!a.street_number && !sameAddress({ streetNumber: a.street_number, streetName: a.street_name, unit: a.unit_number ?? null, postalCode: a.postal_code }, { streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, postalCode: row.postalCode });
  return { ok: true, addressId, orderId, exactDiffers };
}

async function syncOne(row: ProgramSessionAddress, now: Date): Promise<"SYNCED" | "DESK" | "CONFLICT" | "FAILED" | "UNKNOWN" | "PENDING" | "BUSY"> {
  const worker = `address:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
  const claimed = await prisma.programSessionAddress.updateMany({ where: { id: row.id, version: row.version, syncState: { in: ["PENDING", "RUNNING", "UNKNOWN"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseUntil: new Date(now.getTime() + 5 * 60_000), leaseBy: worker } });
  if (claimed.count === 0) return "BUSY";
  try {
    const client = await prisma.client.findUnique({ where: { id: row.clientId }, select: { id: true, name: true } });
    const { AryeoBooking, hubWritePermit, classifyAryeoWriteError } = await import("@/lib/integrations/aryeo");
    const target = await resolveAddressTarget(row, now);
    if (!target.ok) {
      if ("retry" in target) { await prisma.programSessionAddress.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(now.getTime() + 10 * 60_000), lastError: target.retry, lastErrorAt: now } }); return "PENDING"; }
      await toDesk(row, now, `The hub did not change the Aryeo address: ${target.conflict}.`, "CONFLICT");
      return "CONFLICT";
    }
    // A booking that already carries a DIFFERENT exact address is a person's
    // call the first time — unless our own earlier PATCH is what put it there,
    // or (§6.6 W02) the hub itself created that Address record when it booked
    // the session from the client's plan: the street on it is the client's own
    // earlier answer, not somebody else's.
    if (target.exactDiffers && row.syncAttempts === 0 && row.aryeoAddressId !== target.addressId) {
      await toDesk(row, now, "The Aryeo booking already has a different exact address. Check which one is right.", "CONFLICT");
      return "CONFLICT";
    }
    const want = { streetNumber: row.streetNumber, streetName: row.streetName, unit: row.unitNumber, postalCode: row.postalCode };
    const readback = async () => {
      const a = await AryeoBooking.getAddress(target.addressId);
      return { a, same: sameAddress({ streetNumber: a.street_number ?? null, streetName: a.street_name ?? null, unit: a.unit_number ?? null, postalCode: a.postal_code ?? null }, want) };
    };
    // Already there (a PATCH that timed out after landing, or Kyle's hand):
    // read, don't write.
    let first;
    try { first = await readback(); } catch (e) {
      await prisma.programSessionAddress.update({ where: { id: row.id }, data: { nextAttemptAt: new Date(now.getTime() + 10 * 60_000), lastError: `address read: ${e instanceof Error ? e.message : e}`, lastErrorAt: now } });
      return "PENDING";
    }
    if (first.same) return synced(row, now, target, first.a);
    if (row.syncAttempts >= 2) {
      await toDesk(row, now, "Two updates to the Aryeo address did not take.", "FAILED");
      return "FAILED";
    }
    const gate = await hubWritePermit({ switchKey: "address_sync", client, operation: "addresses.patch" });
    if (!gate.ok) { await toDesk(row, now, gate.reason); return "DESK"; }
    await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "RUNNING", syncAttempts: { increment: 1 }, aryeoAddressId: target.addressId, nextAttemptAt: new Date(now.getTime() + 10 * 60_000) } });
    const cur = { ...row, syncAttempts: row.syncAttempts + 1 };
    try {
      await AryeoBooking.patchAddress(gate.permit, target.addressId, {
        street_number: row.streetNumber, street_name: row.streetName, unit_number: row.unitNumber, city: row.city, state_or_province: row.stateCode, postal_code: row.postalCode,
        latitude: row.latitude, longitude: row.longitude,
      });
    } catch (e) {
      const kind = classifyAryeoWriteError(e);
      const msg = e instanceof Error ? e.message : String(e);
      if (kind === "REJECTED") { await toDesk(cur, now, `Aryeo refused the address update (${msg}).`, "FAILED"); return "FAILED"; }
      if (kind === "RETRYABLE") { await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "PENDING", syncAttempts: row.syncAttempts, nextAttemptAt: new Date(now.getTime() + 5 * 60_000), lastError: msg, lastErrorAt: now } }); return "PENDING"; }
      // MAYBE. The next tick reads it back before deciding anything.
      await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "UNKNOWN", nextAttemptAt: new Date(now.getTime() + 10 * 60_000), lastError: `address update outcome unknown: ${msg}`, lastErrorAt: now } });
      return "UNKNOWN";
    }
    let after;
    try { after = await readback(); } catch {
      await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "UNKNOWN", nextAttemptAt: new Date(now.getTime() + 10 * 60_000) } });
      return "UNKNOWN";
    }
    if (!after.same) { await toDesk(cur, now, "Aryeo accepted the address update but reads back a different address.", "FAILED"); return "FAILED"; }
    return synced(cur, now, target, after.a);
  } finally {
    await prisma.programSessionAddress.updateMany({ where: { id: row.id, leaseBy: worker }, data: { leaseUntil: null, leaseBy: null } });
  }
}

async function synced(row: ProgramSessionAddress, now: Date, target: { addressId: string; orderId: string }, readback: unknown): Promise<"SYNCED"> {
  await prisma.programSessionAddress.update({ where: { id: row.id }, data: { syncState: "SYNCED", syncedAt: now, aryeoAddressId: target.addressId, readbackJson: JSON.stringify({ source: "aryeo", address: readback }).slice(0, 10_000), lastError: null, lastErrorAt: null, nextAttemptAt: null } });
  await closeAddressTasks(row);
  // Now that Aryeo has the exact address, Aryeo says whether it still works.
  await aryeoConflictCheck(row).catch(() => "unknown");
  // Best-effort: pull the order so Project.addressLine shows the street here too.
  try {
    const { syncAryeoOrders } = await import("@/lib/integrations/aryeo");
    await syncAryeoOrders({ orderId: target.orderId });
  } catch { /* the hourly sync repairs it */ }
  return "SYNCED";
}

/** Staff "Recheck now": the local readback for one row, no provider call. */
export async function recheckSessionAddress(rowId: string, now: Date = new Date()): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.programSessionAddress.findUnique({ where: { id: rowId } });
  if (!row?.submittedAt) return { ok: false, message: "No exact address has been given for this session." };
  if (row.syncState === "SYNCED") return { ok: true, message: "Already confirmed on the booking." };
  return (await localReadback(row, now))
    ? { ok: true, message: "Confirmed: the booking now shows this address." }
    : { ok: false, message: "The booking does not show this address yet (as of the last order sync)." };
}

// ===========================================================================
// THE SESSION PLAN — EXACT ADDRESS FIRST (§6.6 W02 / A22, Sep 25 2026).
//
// "An exact address is required before confirmable filming slots are offered.
// This supersedes earlier area-only booking" (§3). One ProgramSessionPlan per
// session of a month (Pro has two: sessionIndex 1 and 2), created when the
// client saves the address and kept, so "Schedule later" loses nothing.
//
//   · validated (validateExactAddress: a street number and name, city, state,
//     ZIP — an area is refused) and GEOCODED. A geocode miss is still saved,
//     but it offers no confirmable time: Kyle confirms the address and the time
//     by hand (portalSessionSlots says so).
//   · addressVersion counts real changes. A request carries the version it was
//     offered under (planAddressVersion); the booking adapter refuses to book
//     it if the plan moved since, rather than send a creative to a stale address.
//   · Once a session is requested or booked, its address changes through the
//     booked session (CP-05 above, with its travel recheck), never here.
// ===========================================================================

export type PlanRow = {
  id: string; sessionIndex: number; streetNumber: string | null; streetName: string | null; unitNumber: string | null;
  city: string | null; stateCode: string | null; postalCode: string | null; latitude: number | null; longitude: number | null; addressVersion: number;
};

/** Exact (street number + name + ZIP) AND on the map: the only plan a confirmable slot is offered for. */
export function planBookable(p: Pick<PlanRow, "streetNumber" | "streetName" | "postalCode" | "latitude" | "longitude"> | null | undefined): boolean {
  return !!p && !!p.streetNumber && !!p.streetName && !!p.postalCode && typeof p.latitude === "number" && typeof p.longitude === "number";
}

/** Exact, whether or not it was placed on the map (a desk "when works" ask needs this much). */
export function planExact(p: Pick<PlanRow, "streetNumber" | "streetName" | "postalCode"> | null | undefined): boolean {
  return !!p && !!p.streetNumber && !!p.streetName && !!p.postalCode;
}

export const planAddressLine = (p: Pick<PlanRow, "streetNumber" | "streetName" | "unitNumber" | "city" | "stateCode" | "postalCode">): string =>
  formatAddressLine({ streetNumber: p.streetNumber, streetName: p.streetName, unit: p.unitNumber, city: p.city, stateCode: p.stateCode, postalCode: p.postalCode });

/** What the portal card shows for one session's plan. */
export type SessionPlanView = {
  planId: string;
  sessionIndex: number;
  addressLine: string | null;
  exact: boolean;
  /** placed on the map — confirmable times can be offered */
  bookable: boolean;
  addressVersion: number;
  /** a live request already made from this plan (its address then changes on the booked session) */
  requestId: string | null;
  deferred: boolean;
};

const PLAN_LOCKED = ["REQUESTED", "CONFIRMED", "RESCHEDULE_REQUESTED", "CANCEL_REQUESTED"];

/** The month's plans, one per session index that has one. */
export async function sessionPlanViews(monthId: string): Promise<SessionPlanView[]> {
  const plans = await prisma.programSessionPlan.findMany({ where: { monthId }, orderBy: { sessionIndex: "asc" } });
  if (!plans.length) return [];
  const live = await prisma.programSessionRequest.findMany({ where: { planId: { in: plans.map((p) => p.id) }, status: { in: PLAN_LOCKED } }, select: { id: true, planId: true } });
  return plans.map((p) => ({
    planId: p.id, sessionIndex: p.sessionIndex,
    addressLine: planExact(p) ? planAddressLine(p) : null,
    exact: planExact(p), bookable: planBookable(p), addressVersion: p.addressVersion,
    requestId: live.find((r) => r.planId === p.id)?.id ?? null,
    deferred: !!p.schedulingDeferredAt,
  }));
}

export type SavePlanResult = { ok: boolean; message: string; planId?: string; addressVersion?: number; bookable?: boolean; changed?: boolean };

/**
 * Save the exact address for session `sessionIndex` of a month (the portal's
 * first scheduling step). Idempotent on the address: the same address again
 * changes nothing and keeps the version, so an open slot list stays valid.
 */
export async function saveSessionPlanAddress(a: {
  enrollmentId: string; monthId: string; sessionIndex: number; input: ExactAddressInput; by: string; now?: Date;
}): Promise<SavePlanResult> {
  const now = a.now ?? new Date();
  const v = validateExactAddress(a.input);
  if (!v.ok) return { ok: false, message: v.message };
  const month = await prisma.contentMonth.findUnique({ where: { id: a.monthId }, select: { id: true, enrollmentId: true, clientId: true, historical: true } });
  if (!month || month.enrollmentId !== a.enrollmentId || month.historical) return { ok: false, message: "Pick one of your open program months." };
  const { sessionCapacity } = await import("@/lib/sessionRequests");
  const cap = await sessionCapacity(a.enrollmentId, a.monthId, { now });
  if (!Number.isInteger(a.sessionIndex) || a.sessionIndex < 1 || a.sessionIndex > Math.max(1, cap.allowed)) return { ok: false, message: "Pick one of this month's sessions." };

  const existing = await prisma.programSessionPlan.findUnique({ where: { monthId_sessionIndex: { monthId: a.monthId, sessionIndex: a.sessionIndex } } });
  if (existing) {
    const live = await prisma.programSessionRequest.count({ where: { planId: existing.id, status: { in: PLAN_LOCKED } } });
    const value = v.value;
    const same = sameAddress({ streetNumber: existing.streetNumber, streetName: existing.streetName, unit: existing.unitNumber, postalCode: existing.postalCode }, { ...value, unit: value.unit });
    if (same && (existing.latitude != null || live)) {
      return { ok: true, message: "That address is already saved for this session.", planId: existing.id, addressVersion: existing.addressVersion, bookable: planBookable(existing), changed: false };
    }
    if (live) return { ok: false, message: `This session already has a time requested or booked. Change its address on that session, or call or text Kyle at ${URGENT_CONTACT}.` };
  }

  const { geocodeAddress } = await import("@/lib/travel");
  const geo = await geocodeAddress(formatAddressLine(v.value)).catch(() => null);
  const data = {
    streetNumber: v.value.streetNumber, streetName: v.value.streetName, unitNumber: v.value.unit, city: v.value.city, stateCode: v.value.stateCode, postalCode: v.value.postalCode,
    latitude: geo?.lat ?? null, longitude: geo?.lng ?? null, geocodeSource: geo ? "GEOCODED" : "MISS",
    addressValidatedAt: geo ? now : null, lastStep: "ADDRESS",
  };
  const row = existing
    ? await prisma.programSessionPlan.update({ where: { id: existing.id }, data: { ...data, addressVersion: { increment: 1 } } })
    : await prisma.programSessionPlan.create({ data: { ...data, enrollmentId: a.enrollmentId, clientId: month.clientId, monthId: a.monthId, sessionIndex: a.sessionIndex, addressVersion: 1 } })
        .catch(async () => {
          // Two tabs saving the first address at once: the unique (month, index)
          // lets one create; the other becomes an update of that row.
          const again = await prisma.programSessionPlan.findUniqueOrThrow({ where: { monthId_sessionIndex: { monthId: a.monthId, sessionIndex: a.sessionIndex } } });
          return prisma.programSessionPlan.update({ where: { id: again.id }, data: { ...data, addressVersion: { increment: 1 } } });
        });
  return {
    ok: true,
    message: geo ? "Saved. Here are the times that work from this address." : `Saved. We could not find that address on a map, so Kyle will confirm it and your time with you. You can still tell us what works.`,
    planId: row.id, addressVersion: row.addressVersion, bookable: planBookable(row), changed: true,
  };
}
