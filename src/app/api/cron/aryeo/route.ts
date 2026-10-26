import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ---------------------------------------------------------------------------
// THE ARYEO SYNC (every 15 minutes at :10 :25 :40 :55 — see vercel.json).
// Oct 13 2026, Jordan: "the aryeo sync should be every 15 minutes, not every
// hour."
//
// Until today orders and appointments came in once an hour, at the top of the
// hourly sync, so a booking made at 9:05 reached the hub after ten, and so did
// everything that reads it: a session request turning CONFIRMED, the booking
// driver's next step, and what the Ready-to-send card says Aryeo is showing.
// Those now live here, four times an hour:
//   · orders        the incremental sweep (stops at known orders — cheap);
//   · appointments  recent + future only (21 days back), as the hourly did;
//   · sessionRequests  REQUESTED → CONFIRMED when the appointment appears at
//                      the slot, CONFIRMED → CANCELLED when Aryeo cancels it,
//                      stale ones expire — database-only, reads the rows the
//                      appointments step just wrote;
//   · sessionBookings  CP-04's booking adapter — `session_booking` OFF = zero
//                      calls; ON, only clients its config authorises, at most
//                      3 a run, no new write with under 30 s left. Aryeo's
//                      customer notifications stay OFF (notifyCustomer false),
//                      exactly as before;
//   · sessionConfirmations  the hub's own confirmation email for each session
//                      confirmed or moved (lib/sessionConfirmation, Oct 26 2026),
//                      since Aryeo's is off;
//   · scripting     the scripting platform's reconcile: every job's current
//                      script (lib/scriptSync.reconcileScripting, Oct 20 2026);
//   · readyToSendAryeo  one Aryeo listing read per job on the Ready-to-send
//                      card (at most 12): it files what the listing shows
//                      (the card's evidence line) and runs the delivery proof
//                      that marks a video sent only when it can only be that
//                      cut. Never clears a row it cannot prove.
//
// Rate: the incremental order page(s), 2-4 appointment calls and ≤12 listing
// reads a run — well inside what Aryeo allowed the hourly sync, ×4.
//
// Offset from everything else that talks to Aryeo: the hourly sync is at :00
// (it no longer reads orders or appointments itself), the :30 reconcile walks
// the full order/appointment history in page slices and runs ~4 minutes, and
// this job's budget (240 s) ends each run well before the next one of those
// starts. The :30 reconcile remains the safety net under this one.
// ---------------------------------------------------------------------------
export async function GET(req: NextRequest) {
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish } = cronBudget(240_000, Date.now(), "aryeo");

  await step("orders", async () => {
    const { syncAryeoOrders } = await import("@/lib/integrations/aryeo");
    return syncAryeoOrders({ full: false });
  }, { maxMs: 100_000 });
  await step("appointments", async () => {
    const { syncAryeoAppointments } = await import("@/lib/integrations/aryeo");
    return syncAryeoAppointments({ recentOnlyDays: 21 });
  }, { maxMs: 90_000 });
  await step("sessionRequests", async () => {
    const { reconcileSessionRequests } = await import("@/lib/sessionRequests");
    return reconcileSessionRequests();
  }, { maxMs: 20_000 });
  // Its own step with its own budget — a real booking is several provider
  // calls and must not share the reconcile's 20 s.
  await step("sessionBookings", async () => {
    const { driveSessionBookings } = await import("@/lib/sessionBooking");
    return driveSessionBookings({ budgetMs: 60_000 });
  }, { maxMs: 70_000 });
  // Oct 26 2026 (Jordan: Mike Ciunci booked and got no confirmation): the
  // filming session confirmation email for every session confirmed or moved
  // since the last tick, however it was confirmed (lib/sessionConfirmation).
  // The portal sends its own at once; this catches Kyle's hand confirmations,
  // bookings the step above finished, and anything held while a conflict was open.
  await step("sessionConfirmations", async () => {
    const { sweepSessionConfirmations } = await import("@/lib/sessionConfirmation");
    return sweepSessionConfirmations();
  }, { maxMs: 25_000 });
  // The Ready-to-send card's Aryeo evidence and the delivery proof. Aryeo's
  // LISTING_DELIVERED webhook has been silent since Sep 7 and only Aryeo's
  // team can switch it back on; until they do, this is how the proof runs.
  await step("readyToSendAryeo", async () => {
    const { sweepReadyToSendAgainstAryeo } = await import("@/lib/aryeoDelivery");
    return sweepReadyToSendAgainstAryeo({ max: 12, budgetMs: 25_000 });
  }, { maxMs: 30_000 });
  // Oct 20 2026 (Jordan, via the scripting platform): every job's script kept
  // current. The platform's webhooks are one try with a 5-second timeout, so
  // this reads its project list (one call) and re-reads each job that changed,
  // was never read, or shoots within three days (lib/scriptSync). Riding the
  // 15-minute Aryeo job because an Aryeo booking is how most jobs are matched.
  await step("scripting", async () => {
    const { reconcileScripting } = await import("@/lib/scriptSync");
    return reconcileScripting({ max: 30, budgetMs: 40_000 });
  }, { maxMs: 45_000 });
  // Oct 24 2026 (Jordan: "we should have a lot more premium videos and monthly
  // social content in the gallery"): the media library's ONE-TIME backfill of
  // every delivered listing's videos and cover (lib/listingMediaIndex). Idle
  // (no Aryeo call) until it is started, and again once it has read them all.
  // At most 36 listing reads a tick, one at a time, 0.4 s apart, inside 60 s;
  // a 429 waits a minute, doubling to thirty. ~1,550 listings ≈ 11 hours.
  // Last, so it only ever uses time the steps above left over.
  await step("listingMediaBackfill", async () => {
    const { listingMediaBackfillTick } = await import("@/lib/listingMediaIndex");
    return listingMediaBackfillTick({ max: 36, budgetMs: 60_000, gapMs: 400 });
  }, { maxMs: 70_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
