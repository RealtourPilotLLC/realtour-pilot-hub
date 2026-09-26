// ---------------------------------------------------------------------------
// THE SUPERVISED CALENDLY TEST (W03, unified handoff Sep 25 2026).
//
// Jordan authorised ONE supervised Calendly write, run by the main session:
// book one invitee on the mapped MONTHLY_STRATEGY type for the TEST fixture
// "Jordan Spackman TEST" (info@realtourpilot.com), read it back, then cancel it.
// This script IS that operation, written ahead of time and proven against a
// fake Calendly (scripts/_drill/b3-calendly.ts). Never run by a cron or a build.
//
//   set -a && source .env; set +a      # APP_SECRET: the stored Calendly key and the token
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/calendly-supervised-test.ts
//       DRY RUN (the default). Reads only: the fixture, its month, the mapping,
//       the call_booking switch and its scope decision, the stored probe, and
//       the open times (GET, read-only). Prints the exact POST body. Writes
//       nothing anywhere.
//
//   … calendly-supervised-test.ts --apply [--start 2026-10-06T18:00:00Z]
//       1. refuses anything but a TEST client named "Jordan Spackman TEST"
//          (never a never-synthetic id) whose invitee address is info@
//       2. asks THE guard (calendlyWritePermit → call_booking ON, the fixture
//          in authorizedFixtureClientIds, the invitee a verified test inbox)
//       3. POST /invitees — once. A timeout is settled by READING the event
//          list for the portal token, never by a second POST
//       4. reads the event and its invitee back: the mapped type, active, the
//          start asked for, info@, tracking.utm_content === the token
//       5. checks the hub would MATCH it: the token verifies to this fixture's
//          enrollment and month (verifyPortalCallToken) — no row is written
//       6. POST /scheduled_events/{uuid}/cancellation and reads the event back
//          as canceled. If anything after step 3 fails the cancel is still
//          attempted, and the event URI is printed for hand cleanup if not.
//
// WHAT HAPPENS OUTSIDE THE HUB: one real event on Jordan's Calendly (and his
// Google calendar) for a few minutes; Calendly emails its own confirmation and
// cancellation to info@ per the event type's settings. The hourly sweep will
// later file the (cancelled) booking on the TEST client — matched by its token.
// Prisma self-loads .env, so this reads the LIVE database, by design. Needs
// APP_SECRET in the environment (set -a && source .env; set +a) so the token
// is the one production computes.
//
// ARMING IT (batch-3 review, Sep 25 2026): the command this printed used to be
// setAutomation("call_booking", true, …, JSON.stringify({ mode, fixtures })),
// which REPLACES the switch's whole config — an approved call_booking pilot
// would vanish with no audit record — and after --apply nothing said to switch
// it off or take the fixture off the list. It now prints
// scripts/_ops/hub-write-fixture.ts (audited: the fixture list and the on/off
// only), refuses while the switch carries a pilot with real clients (turning
// it on would write for them too), and every --apply ends with the disarm step.
// ---------------------------------------------------------------------------

type Log = (line: string) => void;
export type SupervisedResult = {
  code: number;
  mode: "dry-run" | "apply";
  refused?: string;
  eventUri?: string;
  booked?: boolean;
  cancelled?: boolean;
  wouldMatch?: boolean;
};

const FIXTURE_SCRIPT = "NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/hub-write-fixture.ts";

const arg = (argv: string[], name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

export async function runSupervisedTest(argv: string[], log: Log = (l) => console.log(l)): Promise<SupervisedResult> {
  const apply = argv.includes("--apply");
  const mode = apply ? "apply" : "dry-run";
  const refuse = (why: string): SupervisedResult => { log(`REFUSED: ${why}`); return { code: 2, mode, refused: why }; };
  if (!process.env.APP_SECRET) return refuse("APP_SECRET is not in the environment — run with `set -a && source .env; set +a` so the token matches production's.");

  const { prisma } = await import("@/lib/prisma");
  const t = await import("@/lib/testClients");
  const cb = await import("@/lib/callBooking");
  const cal = await import("@/lib/integrations/calendly");
  const { etMonthKey } = await import("@/lib/contentProgram");

  // ---- 1. the fixture, and only the fixture --------------------------------
  const name = arg(argv, "--client-name") ?? t.JORDAN_TEST_CLIENT_NAME;
  if (!t.isTestClientName(name)) return refuse(`"${name}" is not a TEST client — this test only ever books for a TEST fixture.`);
  const clients = await prisma.client.findMany({ where: { name }, select: { id: true, name: true, email: true } });
  if (clients.length !== 1) return refuse(`expected exactly one client named "${name}", found ${clients.length}.`);
  const client = clients[0];
  try { t.assertTestClient(client); } catch (e) { return refuse(e instanceof Error ? e.message : "not a TEST client"); }
  const enrollment = await prisma.contentEnrollment.findFirst({ where: { clientId: client.id, status: "ACTIVE" }, select: { id: true, timezone: true } });
  if (!enrollment) return refuse(`${name} has no ACTIVE enrollment.`);
  const inviteeEmail = t.JORDAN_TEST_EMAIL;
  if (!t.isVerifiedTestDestinationEmail(inviteeEmail)) return refuse(`${inviteeEmail} is not a verified test inbox.`);
  log(`Fixture: ${client.name} (${client.id}) · enrollment ${enrollment.id}`);
  log(`Invitee: ${client.name} <${inviteeEmail}>, ${enrollment.timezone || "America/New_York"}`);

  // ---- the event type, the switch, the probe ---------------------------------
  const mapping = await cb.monthlyStrategyMapping();
  if (!mapping) return refuse("no enabled MONTHLY_STRATEGY mapping with a Calendly page.");
  log(`Event type: ${mapping.eventName} — ${mapping.eventTypeUri}`);
  const cfg = await cb.callBookingConfig();
  // The STORED scope, on or off (callBookingConfig is null while the switch is
  // off, so it cannot see a pilot waiting there).
  const { storedAutomationConfigForDisplay } = await import("@/lib/programAutomation");
  const { parseHubWriteConfig } = await import("@/lib/hubWritePermit");
  const stored = parseHubWriteConfig(await storedAutomationConfigForDisplay("call_booking"));
  const pilotIds = stored.pilot?.clientIds ?? [];
  if (pilotIds.length) {
    log(`call_booking carries a pilot with ${pilotIds.length} real client(s) (${pilotIds.join(", ")}). Switching it on for this test would write for them too. End that pilot in Settings first.`);
    if (apply) return refuse("call_booking carries a pilot with real clients; end it before the supervised test");
  }
  const scopeCreate = await cb.callBookingScope({ client: { id: client.id, name: client.name }, operation: "invitees.create", inviteeEmail });
  const scopeCancel = await cb.callBookingScope({ client: { id: client.id, name: client.name }, operation: "scheduled_events.cancel", inviteeEmail });
  log(`call_booking: ${cfg ? `ON (mode ${cfg.mode}; fixtures ${JSON.stringify(cfg.authorizedFixtureClientIds)}; pilot ${cfg.pilot ? "set" : "none"})` : "OFF"}`);
  log(`Guard: invitees.create → ${scopeCreate.ok ? scopeCreate.scope : `refused (${scopeCreate.reason})`}; scheduled_events.cancel → ${scopeCancel.ok ? scopeCancel.scope : `refused (${scopeCancel.reason})`}`);
  const probe = await cb.storedSchedulingProbe();
  log(`Stored probe: ${probe ? `${probe.status} (HTTP ${probe.httpStatus ?? "—"}) ${probe.checkedAt}` : "none — run scripts/_ops/calendly-capability-probe.ts first"}`);

  // ---- an open time (read-only) --------------------------------------------------
  const shape = await cal.getEventType(mapping.eventTypeUri);
  const duration = shape?.durationMinutes ?? 30;
  const location = shape?.locations[0] ?? null;
  const wanted = arg(argv, "--start");
  const from = new Date(Date.now() + 26 * 3600_000); // tomorrow at the earliest: nobody's calendar is surprised today
  let open: { startTime: string }[] = [];
  try {
    open = await cal.eventTypeAvailableTimes(mapping.eventTypeUri, from.toISOString(), new Date(from.getTime() + cal.AVAILABLE_TIMES_MAX_WINDOW_MS - 60_000).toISOString());
  } catch (e) {
    return refuse(`could not list open times (${e instanceof cal.CalendlyError ? `HTTP ${e.status}` : "error"}: ${e instanceof Error ? e.message : e}) — a 403 means the plan lacks the Scheduling API and this test cannot run.`);
  }
  const slot = wanted ? open.find((s) => Date.parse(s.startTime) === Date.parse(wanted)) : open[0];
  if (!slot) return refuse(wanted ? `${wanted} is not an open time in the next 7 days.` : "no open time in the next 7 days.");
  const startISO = new Date(slot.startTime).toISOString();
  // The month the call is booked FOR: the first open month no earlier than the
  // call's own month — the same "not a stale page" rule the hub's token check
  // applies (a call held in November never plans October).
  const month = await prisma.contentMonth.findFirst({
    where: { enrollmentId: enrollment.id, historical: false, monthKey: { gte: etMonthKey(new Date(startISO)) } },
    orderBy: { monthKey: "asc" }, select: { id: true, monthKey: true },
  });
  if (!month) return refuse(`${name} has no open program month for a call on ${startISO} (${etMonthKey(new Date(startISO))}).`);
  log(`Month booked for: ${month.monthKey} (${month.id})`);
  const token = cb.portalCallToken(enrollment.id, month.id);
  const body = {
    event_type: mapping.eventTypeUri, start_time: startISO,
    invitee: { name: client.name, email: inviteeEmail, timezone: enrollment.timezone || "America/New_York" },
    ...(location ? { location: location.location ? { kind: location.kind, location: location.location } : { kind: location.kind } } : {}),
    tracking: { utm_source: "rtp-portal", utm_content: token },
  };
  log(`Open times seen: ${open.length}. Chosen: ${startISO} (${duration} min).`);
  log(`POST https://api.calendly.com/invitees ${JSON.stringify(body)}`);
  log("Then: GET the event + invitees → verify → POST /scheduled_events/{uuid}/cancellation → GET (canceled).");

  if (!apply) {
    if (!scopeCreate.ok || !scopeCancel.ok) {
      log("To arm the guard for this fixture ONLY (the main session; audited; only the fixture list and the on/off change, never the pilot or the mode):");
      log(`  ${FIXTURE_SCRIPT} --switch call_booking --add ${client.id} --on --apply`);
    }
    log("…and afterwards, whatever happened (off, and the fixture off the list):");
    log(`  ${FIXTURE_SCRIPT} --switch call_booking --remove ${client.id} --off --apply`);
    log("DRY RUN: nothing was booked, cancelled or stored. Re-run with --apply.");
    return { code: 0, mode };
  }
  const disarm = () => {
    log("CLEANUP: switch call_booking off and take the fixture off its list (audited):");
    log(`  ${FIXTURE_SCRIPT} --switch call_booking --remove ${client.id} --off --apply`);
  };

  // ---- 2. THE guard ------------------------------------------------------------
  const permit = await cal.calendlyWritePermit({ client: { id: client.id, name: client.name }, operation: "invitees.create", inviteeEmail });
  if (!permit.ok) { disarm(); return refuse(`the write guard said no: ${permit.reason}`); }

  // ---- 3. book once --------------------------------------------------------------
  let eventUri: string | null = null;
  try {
    const inv = await cal.createInvitee(permit.permit, {
      eventTypeUri: mapping.eventTypeUri, startISO,
      invitee: body.invitee, location: location ? { kind: location.kind, location: location.location ?? null } : null,
      tracking: body.tracking,
    });
    eventUri = inv.event ?? null;
    log(`Booked: invitee ${inv.uri} on ${inv.event}`);
  } catch (e) {
    const kind = cal.classifyCalendlyWriteError(e);
    log(`POST /invitees → ${kind}: ${e instanceof Error ? e.message : e}`);
    if (kind !== "UNKNOWN") { disarm(); return { code: 1, mode, booked: false }; }
    // Maybe it landed. READ for the token — never a second POST.
    const seen = await cal.listScheduledEvents(new Date(Date.parse(startISO) - 60_000).toISOString(), new Date(Date.parse(startISO) + 60_000).toISOString(), { eventTypeUris: new Set([mapping.eventTypeUri]) });
    const hit = seen.find(({ event, invitees }) => event.event_type === mapping.eventTypeUri && invitees.some((i) => cb.tokenOfInvitee(i) === token));
    if (!hit) { log("No booking with this token on Calendly: nothing was made. Not retried."); disarm(); return { code: 1, mode, booked: false }; }
    eventUri = hit.event.uri;
    log(`The timeout had committed: found ${eventUri} by its token.`);
  }
  if (!eventUri) { disarm(); return { code: 1, mode, booked: false }; }

  let wouldMatch = false;
  let checks = true;
  let cancelled = false;
  try {
    // ---- 4. read back ------------------------------------------------------------
    const got = await cal.getScheduledEvent(eventUri);
    const inv = got?.invitees.find((i) => cb.tokenOfInvitee(i) === token) ?? null;
    const lines: [string, boolean][] = [
      ["the event reads back", !!got],
      ["on the mapped monthly type", got?.event.event_type === mapping.eventTypeUri],
      ["active", got?.event.status === "active"],
      ["at the time asked for", !!got?.event.start_time && Date.parse(got.event.start_time) === Date.parse(startISO)],
      [`the invitee is ${inviteeEmail}`, inv?.email?.toLowerCase() === inviteeEmail],
      ["tracking.utm_content is the portal token", !!inv],
    ];
    // ---- 5. the hub would MATCH it ----------------------------------------------
    const v = await cb.verifyPortalCallToken(cb.tokenOfInvitee(inv), { bookedAt: cb.bookedAtOfInvitee(inv), callStart: got?.event.start_time ? new Date(got.event.start_time) : null });
    wouldMatch = !!v && v.enrollmentId === enrollment.id && v.monthId === month.id;
    lines.push([`the hub would MATCH it by token to ${name}, ${month.monthKey}`, wouldMatch]);
    for (const [label, ok] of lines) { log(`  ${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) checks = false; }
  } finally {
    // ---- 6. cancel, whatever happened above ----------------------------------------
    const cp = await cal.calendlyWritePermit({ client: { id: client.id, name: client.name }, operation: "scheduled_events.cancel", inviteeEmail });
    if (cp.ok) {
      try {
        await cal.cancelScheduledEvent(cp.permit, eventUri, "Supervised hub test — cancelled by the hub");
        const after = await cal.getScheduledEvent(eventUri);
        cancelled = after?.event.status === "canceled";
      } catch (e) {
        log(`Cancel failed: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      log(`Cancel refused by the guard: ${cp.reason}`);
    }
    log(cancelled ? `Cancelled and read back as canceled: ${eventUri}` : `NOT CANCELLED — cancel it by hand on Calendly: ${eventUri}`);
    disarm();
  }
  return { code: checks && cancelled ? 0 : 1, mode, eventUri, booked: true, cancelled, wouldMatch };
}

if (require.main === module) {
  runSupervisedTest(process.argv.slice(2))
    .then((r) => process.exit(r.code))
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
