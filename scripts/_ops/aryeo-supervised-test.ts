// ---------------------------------------------------------------------------
// THE SUPERVISED ARYEO TEST (§5 A27 / R03, unified handoff Sep 25 2026).
//
// Jordan authorised ONE supervised write test against the real Aryeo account,
// on a disposable TEST fixture, run by the main session — not by a cron, not by
// a build, not by a builder. This script IS that operation, written ahead of
// time and proven end to end against the fake Aryeo (scripts/_drill/
// b3-travel-booking.ts §17). It drives the hub's OWN booking code (the plan,
// createSessionRequest, the adapter, the CP-05 address sync, the reschedule and
// the cancel), so what it proves is the code clients will use.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/aryeo-supervised-test.ts \
//       --fixture <clientId> --address "117 Kyle Lane|West Chester|PA|19382" \
//       --new-address "42 Oak Street|West Chester|PA|19380"
//       DRY RUN (the default). Reads only: the fixture, its identity (its own
//       email AND its Aryeo customer's must be info@realtourpilot.com), both
//       switches' scopes, the Accelerator's price in Aryeo, James's assignment
//       and his free weekday slots at least 24 hours out. Prints exactly what
//       --apply would do. Writes nothing anywhere.
//
//   … --apply   (same flags; optional --start <ISO> and --move-to <ISO>)
//       1. saves the plan address and makes the request (Video Accelerator,
//          240 minutes, James, a weekday at least 24 hours out)
//       2. the adapter books it: POST /addresses, POST /orders (notify false),
//          POST /appointments/store (customer notice off), then READS BACK the
//          appointment and the order: total, balance, payment_status recorded
//       3. exact-address PATCH through the CP-05 sync, and its readback
//       4. one reschedule (PUT, readback of start, end and creative)
//       5. one cancel (PUT notify false, readback CANCELED)
//       6. a read-only measurement: does Aryeo's appointment-scoped
//          availability (filter[appointment_id]) and has_conflicts see the
//          destination? (decides session_booking.travelSource)
//       7. prints the manual cleanup list
//
// IT REFUSES, before anything is sent:
//   · a client that is not TEST, a never-synthetic id, or a TEST name whose
//     own email or linked Aryeo customer's email is not the verified test inbox
//     (testClients.assertFixtureIdentity — a real row renamed TEST keeps its
//     real inbox);
//   · unless session_booking AND address_sync are both ON with this fixture as
//     the ONLY authorised fixture;
//   · when either switch carries a pilot with any client in it (a real client
//     could be written for while the test runs);
//   · when Aryeo prices the Accelerator above $0 (R03: never bill a
//     Stripe-prepaid client — and this script never calls a payment route).
//
// It never flips a switch or edits configuration: the main session arms the
// two switches for the fixture before --apply and disarms them after, with
// scripts/_ops/hub-write-fixture.ts (audited; it changes only the fixture list
// and the on/off, never a pilot). The printed commands are that script's.
//
// THE CLEANUP LIST FOLLOWS WHAT HAPPENED (batch-3 review, Sep 25 2026). It
// used to print the success path's list on every stop: "the test order (none
// made)" after an order timeout that may have committed, and "confirm the
// appointment reads CANCELED" for one that was never cancelled and is still on
// James's calendar. Now a stop says, first, to switch both OFF (a switch left
// on lets the hourly cron finish the half-made booking by itself), then what
// to look for: the order's marker when no order id came back, the appointment
// to CANCEL by hand when it is live, the order to close, the QuickBooks
// invoice to void, and that James got Aryeo's notice for a test booking
// (notifyCompany is on: the hub's bookings notify our team).
// ---------------------------------------------------------------------------

type Log = (line: string) => void;
export type SupervisedResult = {
  code: number;
  mode: "dry-run" | "apply";
  refused?: string;
  requestId?: string;
  report?: Record<string, unknown>;
};

const SCRIPT = "NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/aryeo-supervised-test.ts";
const FIXTURE_SCRIPT = "NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/hub-write-fixture.ts";
const ACCELERATOR_MINUTES = 240;

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

function parseAddress(s: string | null): { street: string; city: string; state: string; zip: string } | null {
  if (!s) return null;
  const [street, city, state, zip] = s.split("|").map((x) => x.trim());
  return street && city && state && zip ? { street, city, state, zip } : null;
}

/** The next weekday ET day keys after `from`, skipping Saturday and Sunday. */
function weekdayKeys(from: Date, count: number, etDayKey: (d: Date) => string): string[] {
  const out: string[] = [];
  for (let i = 1; out.length < count && i < 30; i++) {
    const d = new Date(from.getTime() + i * 864e5);
    const key = etDayKey(d);
    const dow = new Date(`${key}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6 && !out.includes(key)) out.push(key);
  }
  return out;
}

export async function aryeoSupervisedTest(argv: string[], log: Log = (l) => console.log(l)): Promise<SupervisedResult> {
  const apply = argv.includes("--apply");
  const mode = apply ? "apply" : "dry-run";
  const refuse = (why: string): SupervisedResult => { log(`REFUSED: ${why}`); return { code: 2, mode, refused: why }; };
  const { prisma } = await import("@/lib/prisma");
  const tc = await import("@/lib/testClients");
  const aryeo = await import("@/lib/integrations/aryeo");
  const { parseHubWriteConfig } = await import("@/lib/hubWritePermit");
  const { ARYEO_CONTENT_PRODUCTS, etMonthKey } = await import("@/lib/contentProgram");
  const { etDayKey } = await import("@/lib/datetime");
  const now = new Date();

  log(`Aryeo supervised test — ${apply ? "APPLY (real writes to the fixture's Aryeo records)" : "DRY RUN (reads only)"}`);

  // ---- 1. the fixture, and that it IS one --------------------------------
  const fixtureId = arg(argv, "--fixture");
  if (!fixtureId) {
    const candidates = await prisma.client.findMany({ where: { name: { contains: "TEST" } }, select: { id: true, name: true, email: true, aryeoCustomerId: true }, take: 20 });
    log("Pass --fixture <clientId>. TEST-named clients on file:");
    for (const c of candidates) log(`  ${c.id}  ${c.name}  email=${c.email ?? "-"}  aryeoCustomer=${c.aryeoCustomerId ?? "-"}`);
    return refuse("no --fixture given");
  }
  const client = await prisma.client.findUnique({ where: { id: fixtureId }, select: { id: true, name: true, email: true, aryeoCustomerId: true } });
  if (!client) return refuse(`client ${fixtureId} does not exist`);
  if (!tc.isTestClientName(client.name)) return refuse(`"${client.name}" is a real client. This test only ever writes for a TEST fixture.`);
  if (tc.isNeverSyntheticClientId(client.id)) return refuse(`"${client.name}" is a real client renamed TEST (never-synthetic id).`);
  if (!client.aryeoCustomerId) return refuse(`"${client.name}" has no linked Aryeo customer.`);
  const customer = await aryeo.aryeoRequest<{ data?: { email?: string | null } }>(`/customers/${client.aryeoCustomerId}`).catch(() => null);
  const customerEmail = customer?.data?.email ?? null;
  try {
    tc.assertFixtureIdentity({ clientEmail: client.email, aryeoCustomerId: client.aryeoCustomerId, aryeoCustomerEmail: customerEmail });
  } catch (e) {
    return refuse(e instanceof Error ? e.message : "fixture identity not proven");
  }
  log(`Fixture: ${client.name} (${client.id}) · own email ${client.email} · Aryeo customer ${client.aryeoCustomerId} reads ${customerEmail} ✓ (both the verified test inbox)`);

  // ---- 2. the switches: ON, this fixture only, no pilot ---------------------
  const switchProblems: string[] = [];
  for (const key of ["session_booking", "address_sync"] as const) {
    const row = await prisma.programAutomation.findUnique({ where: { key }, select: { enabled: true, configJson: true } });
    let raw: unknown = {};
    try { raw = row?.configJson ? JSON.parse(row.configJson) : {}; } catch { raw = {}; }
    const cfg = parseHubWriteConfig(raw);
    const pilotIds = cfg.pilot?.clientIds ?? [];
    if (pilotIds.length) return refuse(`${key} carries a pilot with ${pilotIds.length} client(s) (${pilotIds.join(", ")}). Empty every pilot before the supervised test.`);
    const fixtures = cfg.authorizedFixtureClientIds;
    if (!row?.enabled) switchProblems.push(`${key} is OFF`);
    if (fixtures.length !== 1 || fixtures[0] !== client.id) switchProblems.push(`${key}.authorizedFixtureClientIds is ${JSON.stringify(fixtures)}, not ["${client.id}"]`);
  }
  if (switchProblems.length) {
    log(`Switches not ready: ${switchProblems.join("; ")}.`);
    log("Arm BOTH for this fixture only (audited; only the fixture list and the on/off change, never a pilot):");
    for (const key of ["session_booking", "address_sync"]) log(`  ${FIXTURE_SCRIPT} --switch ${key} --add ${client.id} --on --apply`);
    if (apply) return refuse("both switches must be ON for this fixture only");
  } else {
    log("Switches: session_booking and address_sync ON, this fixture only, no pilot ✓");
  }

  // ---- 3. the enrollment, the product and its price (R03) ------------------
  const enrollment = await prisma.contentEnrollment.findFirst({ where: { clientId: client.id, status: "ACTIVE" }, select: { id: true, package: true } });
  if (!enrollment) return refuse(`"${client.name}" has no ACTIVE content enrollment to book for.`);
  if (enrollment.package !== "Accelerator") return refuse(`the fixture's enrollment is on "${enrollment.package}"; this test books Video Accelerator (240 minutes). Set the fixture's package to Accelerator first.`);
  const product = ARYEO_CONTENT_PRODUCTS.Accelerator;
  let price: number | null;
  try { price = await aryeo.AryeoBooking.productVariantPrice(product.productId, product.variantId); } catch (e) { return refuse(`could not read the Accelerator's price from Aryeo (${e instanceof Error ? e.message : e})`); }
  if (price !== 0) return refuse(price == null ? "Aryeo's catalogue does not list the Accelerator variant" : `Aryeo prices the Accelerator at $${(price / 100).toFixed(2)}; a hub order would bill a Stripe-prepaid client`);
  log(`Product: ${product.title}, variant ${product.variantId}, ${ACCELERATOR_MINUTES} minutes, price $0 ✓`);

  // ---- 4. James, and a weekday slot at least 24 hours out ------------------
  const providers = await aryeo.productProvidersFor(product.productId).catch(() => []);
  const james = providers.find((p) => p.bookable && /james/i.test(p.name ?? ""));
  if (!james) return refuse(`James is not a bookable creative on ${product.title} in Aryeo (${providers.map((p) => `${p.name}:${p.bookable ? "bookable" : p.reason}`).join(", ") || "no providers"})`);
  const floor = new Date(now.getTime() + 24 * 3_600_000);
  let start: Date | null = arg(argv, "--start") ? new Date(arg(argv, "--start")!) : null;
  const offered: string[] = [];
  for (const day of weekdayKeys(now, 6, etDayKey)) {
    const slots = await aryeo.AryeoBooking.timeslotsFor({ date: day, durationMin: ACCELERATOR_MINUTES, teamMemberIds: [james.teamMemberId] }).catch(() => []);
    for (const s of slots) if (new Date(s.startAt) >= floor) offered.push(s.startAt);
    // Two days' worth: the booking on one, the reschedule onto another.
    if (new Set(offered.map((s) => etDayKey(new Date(s)))).size >= 2) break;
  }
  if (start && !offered.some((s) => new Date(s).getTime() === start!.getTime())) return refuse(`--start ${start.toISOString()} is not one of James's free weekday starts at least 24 hours out (${offered.slice(0, 4).join(", ") || "none found"})`);
  start = start ?? (offered[0] ? new Date(offered[0]) : null);
  if (!start) return refuse("James has no free weekday start at least 24 hours out in the next six weekdays");
  const moveTo = arg(argv, "--move-to") ? new Date(arg(argv, "--move-to")!) : (offered.map((s) => new Date(s)).find((d) => etDayKey(d) !== etDayKey(start!)) ?? null);
  const month = await prisma.contentMonth.findFirst({ where: { enrollmentId: enrollment.id, monthKey: etMonthKey(start), historical: false }, select: { id: true, monthKey: true } });
  if (!month) return refuse(`the fixture has no open ${etMonthKey(start)} program month for a ${start.toISOString()} session`);
  log(`James: ${james.name} (${james.teamMemberId}) · slot ${start.toISOString()} (${month.monthKey}) · move to ${moveTo?.toISOString() ?? "(none offered)"}`);

  const address = parseAddress(arg(argv, "--address"));
  const newAddress = parseAddress(arg(argv, "--new-address"));
  if (!address || !newAddress) {
    log(`Addresses: pass --address "street|city|ST|zip" (the booking) and --new-address "street|city|ST|zip" (the PATCH step).`);
    if (apply) return refuse("both addresses are required for --apply");
  }

  log("");
  log("Would run, in order (every write through the hub's own code and its permit):");
  log("  1. save the plan address → createSessionRequest (James, the slot, travel checked)");
  log("  2. bookSessionRequest: POST /addresses, POST /orders (notify false), POST /appointments/store (notifyCustomer false, notifyCompany true: James gets Aryeo's new-appointment notice), readback of appointment AND order");
  log("  3. submitSessionAddress(new address) → syncSessionAddresses: PATCH /addresses/{id} + GET readback");
  log(`  4. requestReschedule → PUT /appointments/{id}/reschedule (notify false) → readback${moveTo ? ` to ${moveTo.toISOString()}` : ""}`);
  log("  5. cancelSessionRequest → PUT /appointments/{id}/cancel (notify false) → readback CANCELED");
  log("  6. read-only: filter[appointment_id] availability and has_conflicts for the booked appointment");
  if (!apply) {
    log("");
    log(`DRY RUN: nothing was written. To run it: ${SCRIPT} --fixture ${client.id} --address "…" --new-address "…" --apply`);
    return { code: 0, mode };
  }
  if (switchProblems.length) return refuse("switches not ready");

  // ======================= APPLY ============================================
  const sa = await import("@/lib/sessionAddress");
  const sr = await import("@/lib/sessionRequests");
  const sb = await import("@/lib/sessionBooking");
  const st = await import("@/lib/sessionTravel");
  const report: Record<string, unknown> = { fixture: client.id, slot: start.toISOString() };

  // 1. plan + request
  const idx = 1;
  const plan = await sa.saveSessionPlanAddress({ enrollmentId: enrollment.id, monthId: month.id, sessionIndex: idx, input: { ...address!, unit: null }, by: "supervised-test" });
  if (!plan.ok || !plan.planId || !plan.bookable) return refuse(`plan address not saved as bookable: ${plan.message}`);
  const planRow = await prisma.programSessionPlan.findUniqueOrThrow({ where: { id: plan.planId } });
  const end = new Date(start.getTime() + ACCELERATOR_MINUTES * 60_000);
  const fit = await st.travelFit({ creativeTeamMemberId: james.teamMemberId, start, end, dest: { lat: planRow.latitude!, lng: planRow.longitude! } });
  if (fit.fits !== true) return refuse(`travel for that slot is ${fit.fits === false ? "refused" : "unchecked"} (${fit.reason}); pick another --start`);
  const made = await sr.createSessionRequest({
    enrollmentId: enrollment.id, monthId: month.id,
    slot: { startISO: start.toISOString(), endISO: end.toISOString(), notes: "Supervised Aryeo test (§5 A27)." },
    actor: { kind: "STAFF", userId: null }, creative: { teamMemberId: james.teamMemberId, name: james.name },
    plan: { planId: plan.planId, addressVersion: plan.addressVersion! }, sessionIndex: idx,
    travel: { check: "HUB_DRIVE", evidenceJson: st.travelEvidence(fit, { at: "supervised-test" }) },
  });
  if (!made.ok) return refuse(`request refused: ${made.reason}`);
  const requestId = made.id;
  report.requestId = requestId;
  const queued = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } });
  if (queued.bookingState !== "QUEUED") return refuse(`the request was not queued for the hub (${queued.bookingState}: ${queued.lastError})`);
  log(`1. request ${requestId} QUEUED`);

  // 2. book + readback
  const booked = await sb.bookSessionRequest(requestId, { worker: "supervised", budgetMs: 180_000 });
  const row = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } });
  const attempt = row.currentAttemptId ? await prisma.programBookingAttempt.findUnique({ where: { id: row.currentAttemptId } }) : null;
  log(`2. booking: ${booked.outcome} — ${booked.detail}`);
  report.booking = { outcome: booked.outcome, status: row.status, bookingState: row.bookingState, order: row.aryeoOrderId, appointment: row.aryeoAppointmentId, permitScope: attempt?.permitScope ?? null };
  report.money = { totalCents: attempt?.orderTotalCents ?? null, balanceCents: attempt?.orderBalanceCents ?? null, paymentStatus: attempt?.orderPaymentStatus ?? null };
  report.notifyFlagsSent = { order: { notify: false }, appointmentStore: { notify: false, notifyCustomer: false, notifyCompany: true }, reschedule: { notify: false }, cancel: { notify: false } };
  // R03: a hub order must read back $0 total and $0 owed AFTER the booking
  // too (a fee Aryeo attaches with the creative shows up only then).
  let moneyProblem: string | null = null;
  if (row.aryeoOrderId) {
    const order = await aryeo.AryeoBooking.getOrder(row.aryeoOrderId).catch(() => null);
    const o = order as ({ number?: number; total_amount?: number; balance_amount?: number; payment_status?: string; invoice_url?: string | null; payment_url?: string | null } | null);
    report.orderReadback = o ? { number: o.number ?? null, total_amount: o.total_amount ?? null, balance_amount: o.balance_amount ?? null, payment_status: o.payment_status ?? null, invoice_url: o.invoice_url ?? null, payment_url: o.payment_url ?? null } : "could not read";
    log(`   order readback: ${JSON.stringify(report.orderReadback)}`);
    if (!o) moneyProblem = "the order could not be read back, so its money is unproven";
    else if (o.total_amount !== 0 || o.balance_amount !== 0) moneyProblem = `the order reads back total ${o.total_amount ?? "?"} / balance ${o.balance_amount ?? "?"} (cents), not $0 / $0`;
    if (moneyProblem) log(`   FAIL (R03): ${moneyProblem}`);
  }
  report.moneyCheck = moneyProblem ? `FAIL: ${moneyProblem}` : row.aryeoOrderId ? "PASS: $0 total, $0 owed after the booking" : "no order";
  if (row.status !== "CONFIRMED" || !row.aryeoAppointmentId) {
    log(`   The booking did not confirm: request ${row.status}/${row.bookingState}${row.lastError ? ` (${row.lastError})` : ""}. Stop here and clean up by hand, starting with the switches (list below).`);
    printCleanup(log, await cleanupFacts(requestId, client.id, false));
    return { code: 1, mode, requestId, report, refused: "booking-not-confirmed" };
  }

  // 6 (read-only, while the appointment is live): does Aryeo see the destination?
  const scoped = await aryeo.AryeoBooking.timeslotsForAppointment({ appointmentId: row.aryeoAppointmentId, date: etDayKey(start), expectDurationMin: ACCELERATOR_MINUTES, expectTeamMemberIds: [james.teamMemberId] }).catch((e: unknown) => ({ honoured: false, why: e instanceof Error ? e.message : String(e), slots: [] }));
  const conflicts = await aryeo.AryeoBooking.appointmentHasConflicts(row.aryeoAppointmentId, james.teamMemberId, ACCELERATOR_MINUTES).catch(() => null);
  report.aryeoTravelProbe = { appointmentScopedHonoured: scoped.honoured, why: scoped.why, slotsThatDay: scoped.slots.length, hasConflicts: conflicts };
  log(`6. Aryeo appointment-scoped availability: honoured=${scoped.honoured} (${scoped.why}); has_conflicts=${conflicts}`);

  // 3. exact-address PATCH + readback
  const sessionKey = `appt:${row.aryeoAppointmentId}`;
  const submitted = await sa.submitSessionAddress({ kind: "STAFF", enrollmentId: enrollment.id, sessionKey, by: "supervised-test" }, { ...newAddress!, unit: null });
  const sync = await sa.syncSessionAddresses({ max: 3 });
  const addrRow = await prisma.programSessionAddress.findUnique({ where: { sessionKey } });
  report.addressPatch = { submitted: submitted.message, sync, syncState: addrRow?.syncState ?? null, readback: addrRow?.readbackJson ? JSON.parse(addrRow.readbackJson) : null };
  log(`3. address: ${submitted.message} → sync ${JSON.stringify(sync)} → ${addrRow?.syncState}`);

  // 4. one reschedule
  if (moveTo) {
    const moved = await sr.requestReschedule(requestId, { startISO: moveTo.toISOString(), endISO: null }, null, { kind: "STAFF", userId: null });
    const after = await prisma.programSessionRequest.findUniqueOrThrow({ where: { id: requestId } });
    report.reschedule = { ok: moved.ok, message: moved.message, slotStart: after.slotStart?.toISOString() ?? null };
    log(`4. reschedule: ${moved.message} (now ${after.slotStart?.toISOString()})`);
  } else {
    report.reschedule = "skipped: no second free start offered";
    log("4. reschedule skipped: no second free start was offered");
  }

  // 5. one cancel
  const cancelled = await sr.cancelSessionRequest(requestId, "supervised-test", "supervised Aryeo test cleanup", { actor: "STAFF" });
  report.cancel = cancelled;
  log(`5. cancel: ${cancelled.status} — ${cancelled.message}`);

  log("");
  log(`REPORT ${JSON.stringify(report, null, 2)}`);
  printCleanup(log, await cleanupFacts(requestId, client.id, true));
  const ok = cancelled.status === "CANCELLED" && !moneyProblem;
  return { code: ok ? 0 : 1, mode, requestId, report, ...(moneyProblem ? { refused: "money-readback" } : {}) };
}

type CleanupFacts = {
  clientId: string; requestId: string; completed: boolean;
  status: string; bookingState: string; orderId: string | null; appointmentId: string | null; marker: string;
};

/** What actually happened, read back from the request and its attempts — the cleanup list follows it. */
async function cleanupFacts(requestId: string, clientId: string, completed: boolean): Promise<CleanupFacts> {
  const { prisma } = await import("@/lib/prisma");
  const r = await prisma.programSessionRequest.findUnique({ where: { id: requestId }, select: { status: true, bookingState: true, aryeoOrderId: true, aryeoAppointmentId: true } });
  // An order may exist that the request never heard about (a timeout after
  // Aryeo committed): any attempt's order id counts; otherwise the marker is
  // how a person finds it.
  const attempts = await prisma.programBookingAttempt.findMany({ where: { requestId, kind: "CREATE" }, orderBy: { attemptNo: "desc" }, select: { aryeoOrderId: true, aryeoAppointmentId: true } });
  return {
    clientId, requestId, completed,
    status: r?.status ?? "(gone)", bookingState: r?.bookingState ?? "(gone)",
    orderId: r?.aryeoOrderId ?? attempts.find((a) => a.aryeoOrderId)?.aryeoOrderId ?? null,
    appointmentId: r?.aryeoAppointmentId ?? attempts.find((a) => a.aryeoAppointmentId)?.aryeoAppointmentId ?? null,
    marker: `hub-session:${requestId}:`,
  };
}

export function printCleanup(log: Log, f: CleanupFacts): void {
  let n = 0;
  const step = (line: string) => log(`  ${++n}. ${line}`);
  log("");
  log(`MANUAL CLEANUP (a person, in this order)${f.completed ? "" : " — THE TEST STOPPED PART-WAY"}:`);
  // FIRST, on a stop: while the switches are on, the hourly cron keeps driving
  // a half-made booking (it can find the order by its marker and store the
  // appointment on James's calendar by itself).
  if (!f.completed) {
    step(`Switch both OFF now, before anything else (the hourly run would otherwise carry on with this booking):
       ${FIXTURE_SCRIPT} --switch session_booking --remove ${f.clientId} --off --apply
       ${FIXTURE_SCRIPT} --switch address_sync --remove ${f.clientId} --off --apply`);
  }
  if (f.orderId) step(`In Aryeo, open test order ${f.orderId}.`);
  else step(`In Aryeo, SEARCH ORDERS for the internal note "${f.marker}" (request ${f.requestId}, state ${f.bookingState}). No order id came back, but one may exist (a timeout after Aryeo committed). If one carries the note, clean it up as below.`);
  if (f.appointmentId && f.status !== "CANCELLED") step(`CANCEL appointment ${f.appointmentId} by hand: it is LIVE on James's calendar (request ${f.status}/${f.bookingState}; the hub did not cancel it).`);
  else if (f.appointmentId) step(`Confirm appointment ${f.appointmentId} reads CANCELED.`);
  else step("If the order carries an appointment, cancel it by hand (none was recorded here).");
  step("Close or cancel the test order itself (a $0 order with a cancelled appointment stays on the TEST customer otherwise). If it shows ANY balance, void that balance by hand: the hub never voids, refunds or edits an order. The Address the hub made for it books nothing and can stay.");
  step("QuickBooks: if an ORDER_SYNCED_TO_QUICKBOOKS invoice was made for that order, void or delete it by hand, and note its amount ($0 expected) for R03.");
  step("Tell James the 117 Kyle Lane booking was a supervised TEST: the hub's bookings notify our team (notifyCompany), so Aryeo sent him the new-appointment notice. It is unproven whether Aryeo tells him about the move or the cancel.");
  if (f.completed) {
    step(`Disarm both switches (audited; only the fixture list and the on/off):
       ${FIXTURE_SCRIPT} --switch session_booking --remove ${f.clientId} --off --apply
       ${FIXTURE_SCRIPT} --switch address_sync --remove ${f.clientId} --off --apply`);
  }
  step("R03 observations: check info@realtourpilot.com for any Aryeo order/invoice/appointment email to the CUSTOMER; record it and the QuickBooks invoice on the checklist (R03 / A27).");
  step("Record report.aryeoTravelProbe: if appointment-scoped availability was honoured AND a far/near pair shows it counts drive time, session_booking.travelSource may become ARYEO_APPOINTMENT; otherwise it stays HUB_DRIVE.");
}

if (require.main === module) {
  aryeoSupervisedTest(process.argv.slice(2))
    .then((r) => { process.exitCode = r.code; })
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
    .finally(async () => {
      const { prisma } = await import("@/lib/prisma");
      await prisma.$disconnect();
    });
}
