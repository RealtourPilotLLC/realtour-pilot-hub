// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026). Jordan: "Schedule Erica for Thursday October 29th
// at 8:30AM and make sure Jordan is not able to be scheduled. Just James
// Livingston for now."
//   1. program_session_creatives = James only (the hub's session list, see
//      lib/integrations/aryeo sessionCreativeEmails);
//   2. Erica's stuck request (filed under the wrong person before the fix,
//      CONFLICT, never retried) is cancelled the staff way;
//   3. Thu Oct 29 8:30 AM ET is booked with James through the portal's own
//      action (portalRequestSession), as Jordan acting for the client: every
//      check a client booking makes runs (gate, address plan, drive, Aryeo
//      recheck before any order).
// Dry run by default (reads only, Aryeo GETs only); --apply does all three.
// ---------------------------------------------------------------------------
import { installNextStubs, interceptModule } from "../_drill/_harness";

const ENROLLMENT = "cmt7h6b0300059kcj990r34x7"; // Erica Walker
const MONTH = "cmucv446y0046lc043pq9mitr"; // October 2026
const STUCK = "cmvjvktdd0006jp07npqff1vu";
const SLOT = "2026-10-29T12:30:00.000Z"; // Thu Oct 29, 8:30 AM ET
const JORDAN_EMAIL = "info@realtourpilot.com";

type U = Record<string, unknown> | null;
let me: U = null;
interceptModule(
  (r) => r === "@/lib/auth/user" || r === "./user" || /[\\/]src[\\/]lib[\\/]auth[\\/]user(\.ts)?$/.test(r),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, { get(t, k) { return k === "getCurrentUser" ? async () => me : t[k]; } }),
);
installNextStubs();

async function main() {
  const apply = process.argv.includes("--apply");
  const { prisma } = await import("../../src/lib/prisma");
  const A = await import("../../src/lib/integrations/aryeo");
  const { aryeoProductFor } = await import("../../src/lib/contentProgram");
  const en = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: ENROLLMENT }, select: { package: true, clientId: true } });
  const product = aryeoProductFor(en.package);
  if (!product) throw new Error(`no product for package ${en.package}`);
  A.resetProductProviderCache();
  const roster = await A.productProvidersFor(product.productId);
  console.log(`package ${en.package} → ${product.productId}; assigned: ${roster.map((r) => `${r.name} <${r.email}> ${r.bookable ? "bookable" : `not (${r.reason})`}`).join(" | ")}`);
  const james = roster.find((r) => /james livingston/i.test(r.name ?? ""));
  if (!james?.email) throw new Error("James is not assigned to the product in Aryeo (or has no email)");
  const plan = await prisma.programSessionPlan.findFirst({ where: { enrollmentId: ENROLLMENT, monthId: MONTH }, orderBy: { sessionIndex: "asc" } });
  console.log(`plan: ${plan ? `${plan.id} session ${plan.sessionIndex} v${plan.addressVersion} lat ${plan.latitude}` : "NONE"}`);
  const stuck = await prisma.programSessionRequest.findUnique({ where: { id: STUCK }, select: { status: true, bookingState: true, slotStart: true } });
  console.log(`stuck request: ${JSON.stringify(stuck)}`);
  const slots = await A.AryeoBooking.timeslotsFor({ date: "2026-10-29", durationMin: product.durationMinutes, teamMemberIds: [james.teamMemberId] });
  console.log(`Oct 29 8:30 AM free for James: ${slots.some((s) => new Date(s.startAt).getTime() === new Date(SLOT).getTime())}`);
  const owner = await prisma.appUser.findFirst({ where: { email: JORDAN_EMAIL }, select: { id: true, email: true, name: true, role: true, permissions: true, status: true, teamMemberId: true, editorKey: true } });
  if (!owner) throw new Error("owner user not found");
  if (!apply) { console.log("dry run: nothing written (add --apply)"); process.exit(0); }

  // 1. James only
  await prisma.appSetting.upsert({ where: { key: A.SESSION_CREATIVES_KEY }, create: { key: A.SESSION_CREATIVES_KEY, value: JSON.stringify({ emails: [james.email] }), updatedBy: `${JORDAN_EMAIL} (set by Claude on Jordan's instruction)` }, update: { value: JSON.stringify({ emails: [james.email] }), updatedBy: `${JORDAN_EMAIL} (set by Claude on Jordan's instruction)` } });
  A.resetProductProviderCache();
  console.log(`session list now: ${(await A.productProvidersFor(product.productId)).map((r) => `${r.name}: ${r.bookable ? "bookable" : "not"}`).join(", ")}`);

  // 2. the stuck request
  if (stuck && stuck.status === "REQUESTED") {
    const { cancelSessionRequest } = await import("../../src/lib/sessionRequests");
    const c = await cancelSessionRequest(STUCK, owner.id, "Filed under the wrong person before the Oct 22 booking fix; rebooked with James", { actor: "STAFF" });
    console.log(`cancel stuck: ${JSON.stringify(c)}`);
  }

  // 3. book through the same functions the portal action calls, with the same
  //    checks (portalRequestSession needs a signed-in browser session, which a
  //    script must not forge): weekend, 24 hours, the session gate, the month,
  //    the exact-address plan, the drive, then createSessionRequest as STAFF
  //    (Jordan acting for the client) and the booking adapter.
  const portal = await import("../../src/lib/portal");
  const SB = await import("../../src/lib/sessionBooking");
  const picked = new Date(SLOT);
  const refuse = (m: string) => { console.log(`REFUSED: ${m}`); process.exit(1); };
  if (portal.sessionSlotRefusal(picked)) refuse(String(portal.sessionSlotRefusal(picked)));
  if (SB.within24hElapsed(picked, new Date())) refuse("inside 24 hours");
  if (!plan) refuse("no session plan");
  const gate = await portal.sessionGate(ENROLLMENT, MONTH, { sessionIndex: plan!.sessionIndex });
  if (gate.locked) refuse(`gate: ${gate.reason}`);
  const otherMonth = await portal.sessionMonthRefusal(ENROLLMENT, MONTH, picked, { earliest: gate.earliest });
  if (otherMonth) refuse(otherMonth);
  if (picked < gate.earliest) refuse(`too soon: earliest ${gate.earliest.toISOString()}`);
  const { planBookable, planExact } = await import("../../src/lib/sessionAddress");
  if (!planExact(plan!) || !planBookable(plan!)) refuse("the filming address is not exact or not on the map");
  const hours = (await prisma.contentEnrollment.findUnique({ where: { id: ENROLLMENT }, select: { sessionHours: true } }))?.sessionHours ?? 2;
  const endISO = new Date(picked.getTime() + hours * 3600_000).toISOString();
  const { travelFit, travelEvidence } = await import("../../src/lib/sessionTravel");
  const fit = await travelFit({ creativeTeamMemberId: james.teamMemberId, start: picked, end: new Date(endISO), dest: { lat: plan!.latitude!, lng: plan!.longitude! } });
  if (fit.fits === false) refuse("no room for the drive from James's other shoot that day");
  const travel = { check: (fit.fits ? "HUB_DRIVE" : "UNCHECKED") as "HUB_DRIVE" | "UNCHECKED", evidenceJson: travelEvidence(fit, { at: "request", checkedAt: new Date().toISOString() }) };
  const g = gate.preparation;
  const gateSnap = g ? { route: g.route, anchorRef: g.anchor?.ref ?? null, anchorAt: g.anchor?.at ?? null, windowHours: g.windowHours, earliestAt: g.earliest } : null;
  const { createSessionRequest } = await import("../../src/lib/sessionRequests");
  const made = await createSessionRequest({
    enrollmentId: ENROLLMENT, monthId: MONTH,
    slot: { startISO: SLOT, endISO, timezone: null, when: null, locationText: "", notes: "Booked by Jordan Spackman for the client (set up by Claude on his instruction, Oct 22 2026), with James Livingston." },
    actor: { kind: "STAFF", userId: owner.id },
    creative: { teamMemberId: james.teamMemberId, name: james.name },
    sessionIndex: gate.sessionIndex, gate: gateSnap as never,
    plan: { planId: plan!.id, addressVersion: plan!.addressVersion },
    travel,
  });
  console.log(`request: ${JSON.stringify(made)}`);
  if (made.ok && !(made as { duplicate?: boolean }).duplicate) {
    const row = await prisma.programSessionRequest.findUnique({ where: { id: (made as { id: string }).id }, select: { bookingState: true } });
    console.log(`booking state after request: ${row?.bookingState}`);
    if (row?.bookingState === "QUEUED") console.log(`book: ${JSON.stringify(await SB.bookSessionRequest((made as { id: string }).id, { worker: "claude-oct22", budgetMs: 120_000 }).catch((e) => String(e)))}`.slice(0, 600));
  }
  const latest = await prisma.programSessionRequest.findFirst({ where: { enrollmentId: ENROLLMENT, monthId: MONTH }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, bookingState: true, slotStart: true, creativeTeamMemberId: true, aryeoOrderId: true, aryeoAppointmentId: true, lastError: true } as never });
  console.log(`request now: ${JSON.stringify(latest)}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
