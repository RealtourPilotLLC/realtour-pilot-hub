import { NextRequest, NextResponse } from "next/server";
import { cronBudget, authorizeCron, runParts } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// HOURLY sync — statuses, tasks, client texts, repairs and the program's desk
// work. Heavy full-table jobs live in /api/cron/daily. Steps run under a time
// budget so a slow one degrades gracefully (the rest are reported as `skipped`
// and picked up next run) instead of being hard-killed mid-write.
//
// WHAT MOVED OUT (Oct 13 2026):
//   · Aryeo orders + appointments, the session-request reconcile, the session
//     booking driver and the Ready-to-send Aryeo pass → /api/cron/aryeo, every
//     15 minutes (Jordan: "the aryeo sync should be every 15 minutes, not every
//     hour"). The :30 reconcile is still the safety net under it.
//   · Every unattended model call — the transcript queue, the AI queue's safety
//     net, the script-drafting sweep (and the topic banks before them) →
//     /api/cron/topics, the 15-minute AI work job, where each call starts only
//     with the time to finish. Here they could start with seconds left and
//     crowded the client texts out of the hour.
//   · The legacy call sweeps, the pasted-transcript auto-analysis and the
//     "send the booking link" tasks are retired (the portal books calls itself;
//     the Analyze button covers a pasted transcript).
//
// EVERY STEP HAS A CAP (Oct 20 2026, audit H4), except the four client-text
// steps (see there). Most of the steps before the texts had none, so one slow
// upstream step could spend the budget and push the texts into `skipped`. A cap does not cut a
// step off: cronBudget stops WAITING for it, records `timedOut` (which pages,
// once) and moves on while the step's own work finishes underneath. Every
// capped step works row by row with its own claim or upsert, so the next hour
// resumes whatever was left. The caps sit well above the steps' usual times
// (the whole hour has been running 78 to 89 s); they only bite when something
// upstream hangs. The client texts now run straight after `tasks`, the last
// step they read, instead of after ten unrelated ones.
export async function GET(req: NextRequest) {
  // FAIL CLOSED: in prod/Vercel a missing CRON_SECRET must refuse, not open the
  // door — the one shared rule (lib/cron authorizeCron).
  const denied = authorizeCron(req);
  if (denied) return denied;
  const { step, out, finish } = cronBudget(250_000, Date.now(), "sync"); // ~50s headroom under maxDuration

  // IS ANYTHING STILL TALKING TO US? — deliberately the FIRST step of the hour.
  //
  // This used to ride along at the end of retryFailedWebhooks, which made the
  // one alarm that watches for silence depend on an unrelated sweep finishing
  // first: a thrown error or an exhausted budget in the retry pass and the
  // alarm simply did not run, silently. The failure it exists to catch —
  // Aryeo delivering nothing for eight days while every screen stayed green —
  // is exactly the kind nobody is checking up on, so it now runs on its own,
  // before anything can starve it, and cronBudget catches its errors alone.
  await step("webhookSilence", async () => {
    const { alertQuietWebhookLanes } = await import("@/lib/webhookRetry");
    return alertQuietWebhookLanes();
  }, { maxMs: 30_000 });

  // (orders + appointments: /api/cron/aryeo, every 15 minutes — Oct 13 2026.
  // Everything below reads what its latest run wrote, at most 15 minutes old.)
  // Orders that vanished from Aryeo (deleted / archived) while the hub still
  // holds a live job — the list scan can never see them. One GET per active
  // project (~35, ~9s); runs BEFORE statuses/tasks so those steps see the
  // flag the same tick. Flags + asks, never cancels.
  await step("orphanOrders", async () => {
    const { flagOrphanedOrders } = await import("@/lib/integrations/aryeo");
    return flagOrphanedOrders();
  }, { maxMs: 45_000 });
  // Approved cuts → Dropbox: finish in-flight save_url copies, retry failed
  // ones, and retire uploads that never completed.
  await step("approvedCuts", async () => {
    const { finalizeApprovedCuts } = await import("@/lib/reviewCuts");
    return finalizeApprovedCuts();
  }, { maxMs: 45_000 });

  // The 1080p pass has its own every-minute driver (/api/cron/topaz) — this is its
  // SAFETY NET, not its engine. If that cron entry is ever lost in a deploy,
  // or a tick dies and leaves a lease behind, the lane still crawls forward
  // once an hour instead of stopping silently. Same lease, so the two can never
  // work on the same job; small budget, because this is not where the work
  // belongs.
  await step("topazLane", async () => {
    const { driveTopazJobs } = await import("@/lib/topazJobs");
    return driveTopazJobs({ max: 2, budgetMs: 40_000, leaseBy: "sync-cron" });
  }, { maxMs: 45_000 });

  // Dropbox folder creation — took over from the broken Zapier Zap (Aug 2026).
  // A fresh booking's shootDate is already on the project (the 15-minute Aryeo
  // job wrote it), and this runs before statuses so the evidence sweep finds
  // the folders.
  await step("dropboxFolders", async () => {
    const { ensureFoldersForUpcomingShoots } = await import("@/lib/dropboxFolders");
    return ensureFoldersForUpcomingShoots();
  }, { maxMs: 30_000 });
  // Every client with a video order gets a brand-assets folder (logos,
  // endcards) — feeds the Assets-available badge on /edit and /clients/assets.
  await step("clientAssetFolders", async () => {
    const { ensureVideoClientAssetFolders } = await import("@/lib/clientAssets");
    return ensureVideoClientAssetFolders();
  }, { maxMs: 20_000 });
  // CP-06: a brand change whose inline alert never ran gets its Kyle task and
  // banner here, and — only once `brand_change_alerts` is on — changes held
  // while it was off get their editor DM. Database + the switch-gated bridge.
  await step("brandChangeAlerts", async () => {
    const { sweepBrandChangeAlerts } = await import("@/lib/brandProfile");
    return sweepBrandChangeAlerts();
  }, { maxMs: 20_000 });
  // Content Creator Program: enrollments follow the Aryeo social flag, every
  // active client gets the current month's workspace, and monthly-plan shoots
  // attach to their month.
  await step("stripeSignups", async () => {
    // Website signup activation: paid Stripe checkouts for the program's
    // products become live enrollments (Jordan, Aug 28). Runs BEFORE the
    // program sweep so a brand-new enrollment gets its month workspace and
    // roster rows in the same cron pass.
    // The health check runs even when the signup sweep throws, and its own
    // failure is no longer turned into { checked: 0 } (Oct 20 2026, audit H6):
    // a dead subscription alarm now shows on the run instead of reading `ok`.
    const { sweepStripeSignups, sweepSubscriptionHealth } = await import("@/lib/stripeSignups");
    const r = await runParts({ signups: () => sweepStripeSignups(), subs: () => sweepSubscriptionHealth() });
    return { ...r.signups, subs: r.subs };
  }, { maxMs: 45_000 });
  // Oct 15 2026: once a day (the 4 AM ET run) look 60 days back, so videos
  // added to a listing after its delivery reach the library too. That run
  // gets the longer cap (no client text goes out at 4 AM anyway).
  const libraryEtHour = Number(new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  await step("portalLibrary", async () => {
    // Fresh Aryeo deliveries on content jobs reach the client's portal library
    // within the hour (review-room approvals land instantly via the hook).
    const { sweepPortalLibraries } = await import("@/lib/portalLibrary");
    return sweepPortalLibraries({ days: libraryEtHour === 4 ? 60 : 3 });
  }, { maxMs: libraryEtHour === 4 ? 120_000 : 45_000 });
  // CP-09: a photographer's filmed-topic report that did not land at submit
  // (ContentFilmingReport FAILED / PENDING / a dead lease) is retried here
  // until it does. BEFORE contentLibrary, so the videos it confirms and binds
  // to their slots are on file when the library rebuilds. Database-only and
  // contacts nobody, so no switch — the same reasoning as contentLibrary.
  await step("filmingReports", async () => {
    const { sweepFilmingReports } = await import("@/lib/filmedTopics");
    return sweepFilmingReports();
  }, { maxMs: 20_000 });
  await step("contentLibrary", async () => {
    // The NEW video library (ContentVideo), which the staff overview counts
    // production from. Without this it only ever filled when a client opened
    // their portal. Derives from each client's own work; contacts nobody.
    const { sweepContentVideoLibraries } = await import("@/lib/contentVideos");
    return sweepContentVideoLibraries();
  }, { maxMs: 30_000 });
  await step("contentProgram", async () => {
    const { contentProgramSweep } = await import("@/lib/contentProgram");
    return contentProgramSweep();
  }, { maxMs: 30_000 });
  // CP-07: scripted-but-unfilmed topics from a past month carry into the month
  // contentProgram has just minted (so this must run after it). Behind
  // `topic_carryover` (a missing row is off → `skipped`); a pointer move with
  // full history, never a draft, never a message.
  await step("topicCarryover", async () => {
    const { sweepCarryover } = await import("@/lib/contentTopics");
    return sweepCarryover();
  }, { maxMs: 20_000 });
  // (The old `contentCalls` step is RETIRED, Oct 13 2026 — Jordan approved B7
  // and C12. It ran the legacy name-matched Calendly/Drive sweeps, which
  // `legacy_call_sweeps` had already stood down; it auto-analysed any pasted
  // transcript an hour later, which the Analyze button on the call does at
  // once; and it minted a "send <client> their booking link" task for Kyle
  // every month, which the portal's own call booking replaced. Calls arrive
  // through the mapped call chain below (`contentCallRecords`). The library
  // functions stay in contentCalls.ts; nothing schedules them.)
  //
  // The booking-link tasks still open from before are closed once, as
  // CANCELLED (never COMPLETED: no link was sent). Cheap: one indexed count,
  // and a no-op from the first tick after the last one is closed.
  await step("retireCallInvites", async () => {
    const { retireStrategyCallInvites } = await import("@/lib/contentCalls");
    return retireStrategyCallInvites();
  }, { maxMs: 15_000 });
  // Re-evaluate project statuses (Aryeo has no media-upload webhook, so this is
  // how a shoot's media gets detected → SHOT/REVIEW) and (re)generate the QC /
  // delivery tasks for active jobs. Bounded to the active set, so it stays cheap.
  await step("statuses", async () => {
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    return syncProjectStatuses();
  }, { maxMs: 75_000 });
  // EVERY OWED VIDEO STILL HAS ITS OWN ROW (audit R06, Sep 18). The repair that
  // replaces scripts/materialise-outputs.ts being run by hand.
  //
  // The per-video rows (DeliverableOutput) are created at booking and updated
  // by the order reconcile, the office's waiver and the four cut events. That
  // is a lot of write paths, every one of them best-effort, and the ONE thing
  // the WF-02 build could not promise was that they all fire: 922 rows exist
  // today because a script made them, and nothing was watching for drift
  // afterwards. This is the watcher — it repairs what it can and, when the same
  // job fails twice running, THROWS, so the failure lands on the CronRun row
  // and in the Slack ping instead of sitting in a JSON blob nobody reads.
  //
  // Runs after `statuses` because that pass is what freezes a job's promise,
  // and the rows' deadline is read from it.
  await step("outputUnits", async () => {
    const { sweepOutputUnits } = await import("@/lib/deliverableOutputs");
    return sweepOutputUnits({ max: 40, budgetMs: 20_000 });
  }, { maxMs: 25_000 });
  // (FINISHED VIDEOS THAT MAY ALREADY BE UP THERE — the Ready-to-send card's
  // Aryeo read and the delivery proof — moved to /api/cron/aryeo, every 15
  // minutes, Oct 13 2026.)
  // Photos shot yesterday that still haven't been released to the client on
  // Aryeo → bell + a text to Kyle and Jordan. Hosted here, not in `daily`,
  // because daily fires 3-4am ET: inside SMS quiet hours (the text would be
  // silently dropped while the dedupe key was still consumed) and hours before
  // anyone could act. This self-gates to a late-afternoon ET window, so on
  // every other hourly tick it is a no-op. Runs straight after `statuses` so
  // the Aryeo evidence it reads was refreshed moments ago.
  await step("photosUndelivered", async () => {
    const { sweepUndeliveredPhotos } = await import("@/lib/deliveryWatch");
    return sweepUndeliveredPhotos();
  }, { maxMs: 20_000 });
  await step("tasks", async () => {
    const { generateTasksForActiveProjects } = await import("@/lib/tasks");
    return generateTasksForActiveProjects();
  }, { maxMs: 75_000 });
  // Client texts that send themselves (Jordan, Sep 1): shoot confirmations 48h
  // out and delivery texts once Aryeo shows every deliverable shipped. Both
  // self-gate to 9am-4pm ET, atomically claim the task + an idempotency marker
  // before sending, and share ONE per-client set so a multi-listing client
  // gets at most one auto-text per tick (confirmations first — time-critical).
  //
  // Straight after `tasks` (Oct 20 2026, audit H4): `statuses` and `tasks` are
  // the only steps whose writes they read, and ten unrelated steps used to run
  // in between. NO CAP on these four, on purpose: they share the per-client
  // set, and a capped step left running underneath would let the next one text
  // a client it is still texting. Uncapped, a step is still only waited on
  // until the run's budget is spent, and then nothing after it starts.
  const autoTexted = new Set<string>();
  await step("confirmationTexts", async () => {
    const { sweepConfirmationTexts } = await import("@/lib/clientTextSweeps");
    return sweepConfirmationTexts(autoTexted);
  });
  // Welcome comes right after confirmations: to a brand-new client it matters
  // more than a feedback ask, and it shares the one-text-per-client set.
  await step("welcomeTexts", async () => {
    const { sweepWelcomeTexts } = await import("@/lib/clientTextSweeps");
    return sweepWelcomeTexts(autoTexted);
  });
  await step("deliveryTexts", async () => {
    const { sweepDeliveryTexts } = await import("@/lib/clientTextSweeps");
    return sweepDeliveryTexts(autoTexted);
  });
  // A client who texts outside working hours gets the office hours + the portal
  // link, once per closed period (Jordan, Sep 2). Runs on every tick, including
  // the ones outside the send window — that is the whole point of it.
  await step("afterHoursReplies", async () => {
    const { sweepAfterHoursReplies } = await import("@/lib/clientTextSweeps");
    return sweepAfterHoursReplies(autoTexted);
  });
  // REOPENED WORK HAS A DATE (A52, Sep 25 2026). The net under every path that
  // puts a finished job back without dating it (a board move off Delivered, a
  // status sweep): same business day from the moment it was reopened, when
  // that moment is on the record and recent. Older or unknown reopens are left
  // for a person — they are on Kyle's exceptions — never back-dated into
  // "late". Internal dates only; nothing is sent.
  await step("reopenedClocks", async () => {
    const { reconcileReopenedClocks } = await import("@/lib/revisionBrief");
    return reconcileReopenedClocks();
  }, { maxMs: 20_000 });
  // A REVISION STILL WAITING ON ITS EDITOR (Jordan, Oct 6 2026: "notifications
  // sent to the editors for projects that have been in revision for over 24
  // hours"). The Editing Room's own "Revisions" rows, each open ask dated from
  // when the changes were asked for: at 24 hours and every 24 hours after,
  // the editor's bell + their Slack/text switch (Kyle instead for a Luma
  // Visuals or unassigned job), and Kyle's one daily list of revisions stuck
  // with an editor 3+ days. Deduped on the bell rows, so an hourly re-run
  // sends nothing twice. Staff only — never a client. Runs after `tasks` and
  // `reopenedClocks`, so the cards and clocks it reads are this tick's.
  await step("revisionReminders", async () => {
    const { sweepRevisionReminders } = await import("@/lib/revisionReminders");
    return sweepRevisionReminders();
  }, { maxMs: 30_000 });
  // SLACK ASKS CLOSE THEMSELVES ON EVIDENCE (Oct 14 2026, lib/slackAskEvidence).
  // An open Slack ask whose work is on record AFTER it was asked (the job
  // delivered or a cut marked sent, a message to that client, a new cut, a
  // recorded delivery) is completed with the evidence named on the row.
  // Ambiguous asks stay open. Runs after `statuses` and `tasks`, so the
  // delivery it reads is this tick's. Desk truth: no switch, nothing sent.
  await step("slackAskEvidence", async () => {
    const { closeSlackAsksOnEvidence } = await import("@/lib/slackAskEvidence");
    const r = await closeSlackAsksOnEvidence();
    return { checked: r.checked, closed: r.closed.length, leftOpen: r.leftOpen };
  }, { maxMs: 20_000 });
  // Lead and vendor-mail hygiene (Oct 14 2026): an open lead from a number
  // muted as spam, untouched 7 days, is cancelled (never deleted); stale
  // AutoHDR credit-mail and retired balance-check tasks are closed with a note.
  // Each runs even when the other throws (Oct 20 2026, audit H5; lib/cron runParts).
  await step("deskHygiene", async () => {
    const { cancelSpamLeads } = await import("@/lib/leadDesk");
    const { closeStaleAutohdrBalanceTasks } = await import("@/lib/vendorBalance");
    return runParts({ spamLeads: () => cancelSpamLeads(), autohdr: () => closeStaleAutohdrBalanceTasks() });
  }, { maxMs: 10_000 });
  // DELIVERED-JOB NOTES CLOSE THEMSELVES (Jordan, Sep 28 2026). Editor-cut and
  // delivery-fix notes (lanes EDITOR, EDIT — never a photographer's coaching)
  // still open or awaiting a re-look on a job delivered AFTER they were
  // written — and last moved before it — are resolved "Closed out: job
  // delivered", one timeline line per job, but only when the note is on a
  // Review Room cut whose own history answers it (a newer round, or an
  // approval, after the note). Photo/gallery notes, post-approval notes and a
  // person's reopen are left alone (lib/deliveredNotes.ts says why). A linked
  // revision issue is left as it is (a delivery is not a checked fix). Runs
  // after `statuses`, so the status it reads is this tick's. A reopened job is
  // no longer DELIVERED and keeps its notes. No message.
  await step("deliveredNotes", async () => {
    const { closeDeliveredJobNotes } = await import("@/lib/deliveredNotes");
    return closeDeliveredJobNotes({ max: 200 });
  }, { maxMs: 20_000 });
  // O05: a job whose photos (or video) went in, and whose other half was
  // excused afterwards by a road that did not complete it, has its whole
  // wrap-up stamped here — My Pay and the wrap-up KPI read that stamp. The
  // excusal paths complete it on the spot; this is only the net. No message.
  await step("wrapUps", async () => {
    const { reconcileWrapUps } = await import("@/lib/wrapUp");
    return reconcileWrapUps();
  }, { maxMs: 20_000 });
  // (The client texts run straight after `tasks`, above — Oct 20 2026.)
  // Pull missing scripts from the Script Writing platform so the queue's
  // Script chip and the shoot screen fill themselves — Jordan: "Script studio
  // should just get the script from the shoot on our script writing platform
  // via api." Pull-only; the signed webhook is the fast path and the 15-minute
  // reconcile (cron/aryeo) re-reads every job it can match. Since Oct 20 2026
  // (audit H29) this only asks about jobs that reconcile has never matched.
  await step("scripts", async () => {
    const { sweepMissingScripts } = await import("@/lib/scriptSync");
    return sweepMissingScripts({ budgetMs: 25_000 });
  }, { maxMs: 30_000 });
  // Retry webhook events that errored on first receipt (transient blips) so a
  // dropped delivered/paid/inbound event doesn't silently vanish.
  await step("retryWebhooks", async () => {
    const { retryFailedWebhooks } = await import("@/lib/webhookRetry");
    return retryFailedWebhooks(25);
  }, { maxMs: 60_000 });

  // CONTENT PROGRAM OPERATING SYSTEM (Sep 16 2026) — the verified call chain.
  // Bookings on the MAPPED Calendly event types become ProgramCallRecords
  // (identity by verified email only; unmatched → review task), each record is
  // linked to its Google Calendar event, and its Gemini notes doc is attached
  // only when the calendar's summary + start both match, uniquely. Every step
  // self-skips until an enabled mapping exists (the legacy name-matched sweeps
  // that stood in before are retired). Nothing here messages a client.
  //
  // LAST in the hour, on purpose: the client-text sweeps above are
  // time-critical and the sync has been running 78–89 s of its 250 s budget;
  // a slow Calendly/Drive pass here must never push a confirmation text into
  // `skipped`. Everything below resumes where it left off next tick.
  //
  // A FAILURE IS A FAILURE (Oct 20 2026, audit H6). Each call's error used to
  // become `{ skipped: <message> }` (or `{ closed: 0 }`), so a broken Calendly
  // or Drive pass recorded `ok` and paged nobody. Not being set up is still a
  // skip: each sweep returns `{ skipped }` itself when Calendly or Google is
  // not connected or no mapping is on. A real error now fails the step, after
  // the other four have run (lib/cron runParts).
  await step("contentCallRecords", async () => {
    const { syncCallRecordsFromCalendly, linkCalendarEvents, discoverTranscriptSources, sweepUnlinkedDriveTranscripts, reconcileCallReviewTasks } = await import("@/lib/contentCallRecords");
    const { hasEnabledCallMapping } = await import("@/lib/integrations/calendly");
    if (!(await hasEnabledCallMapping())) return { skipped: "no enabled Calendly mapping" };
    return runParts({
      bookings: () => syncCallRecordsFromCalendly(),
      calendar: () => linkCalendarEvents({ max: 20 }),
      transcripts: () => discoverTranscriptSources({ max: 40 }),
      // Program Gemini docs no record has claimed → the import review queue (rows only, no text, no tasks, no analysis).
      unlinked: () => sweepUnlinkedDriveTranscripts({ sinceDays: 45, max: 10 }),
      review: () => reconcileCallReviewTasks(),
    });
  }, { maxMs: 45_000 });
  // (Transcript jobs: /api/cron/topics, the 15-minute AI work job.)
  // F14: approved content cuts that never reached the client's library. The
  // approve-time write is best-effort by design (an approval must not fail over
  // it) and nothing looked again afterwards. Normally repairs nothing.
  //
  // NINE INDEPENDENT REPAIRS (Oct 20 2026, audit H5): each runs even when one
  // before it throws (lib/cron runParts), and the step's error names every
  // repair that failed. It used to stop at the first throw, so one broken
  // repair kept the eight after it from running every hour.
  await step("libraryRepair", async () => {
    const { repairMonthlyPublications } = await import("@/lib/monthlyFinal");
    const { repairApprovedCutLibrary } = await import("@/lib/portalLibrary");
    const { repairScriptChangeRequests } = await import("@/lib/scriptDecisions");
    const { repairIncompleteDeliveries, stampNoticesFromDeliveryTexts } = await import("@/lib/readyToSend");
    const { repairReviewWindows } = await import("@/lib/reviewWindows");
    const { repairPortalRevisionRequests } = await import("@/lib/clientDecisions");
    const { verifyApprovedCutsInLibrary } = await import("@/lib/contentVideos");
    const { closeProgramUploadCards } = await import("@/lib/topazJobs");
    return runParts({
      publications: () => repairMonthlyPublications(100),
      library: () => repairApprovedCutLibrary({ sinceDays: 45, max: 200 }),
      // R2: a client change request whose work item never reached the queue. The
      // client was told "it's with the writer" and the writer had nothing.
      changes: () => repairScriptChangeRequests({ sinceDays: 90, max: 300 }),
      // R5: a video recorded as sent whose 1080p job was stamped delivered and
      // whose upload card was left open — the half-finished settle A04 described.
      // Deliberately NOT the other way round: an undelivered job with an open
      // card is Kyle's ordinary chase card and must not be closed.
      deliveries: () => repairIncompleteDeliveries({ sinceDays: 30, max: 200 }),
      // CP-02: a content cut released since the review windows shipped whose
      // window write failed gets it now, from the TRUE release time. CP-03: a
      // client's change request whose routing failed after it was recorded — or
      // notes a racing submit left open beside it — reach the editor.
      reviewWindows: () => repairReviewWindows({ max: 100 }),
      portalRequests: () => repairPortalRevisionRequests({ max: 50 }),
      // A42: the client's ACTUAL library (ContentVideo) holds every recently
      // approved program cut; a client missing one is rebuilt, and a rebuild that
      // fails or still leaves it out is recorded for the exceptions board.
      programLibrary: () => verifyApprovedCutsInLibrary({ sinceDays: 45, max: 200 }),
      // 9.2: a delivery text the provider accepted is evidence the client was
      // told — stamped on the cuts it covered. 9.6b: "upload to Aryeo" cards made
      // for program videos (never on a listing) are closed with the reason.
      notices: () => stampNoticesFromDeliveryTexts({ sinceDays: 30, max: 200 }),
      programCards: () => closeProgramUploadCards({ max: 100 }),
    });
    // 45s (was 30s): the A42 check can rebuild a client's library, which is a
    // few seconds each on the rare hour one is missing a cut.
  }, { maxMs: 45_000 });
  // (The AI queue's safety net and the script-drafting sweep: /api/cron/topics,
  // the 15-minute AI work job, Oct 13 2026.)
  // 6.5: share a clean sweep-drafted script WITHOUT Jordan's individual
  // approval, after its hold. Behind `script_auto_share` — OFF at the database
  // (a missing row), so this reports `skipped`. The share email is its own
  // switch (script_share_email) either way.
  await step("scriptAutoShare", async () => {
    const { sweepAutoShare } = await import("@/lib/scriptAutoShare");
    return sweepAutoShare();
  }, { maxMs: 20_000 });
  // CP-07's topic banks moved to their own job (/api/cron/topics, every 15
  // minutes, Oct 13 2026): squeezed in here they were cut off mid-run.
  // 6.3: the client's recommendations for each open month, re-ranked only
  // when the month's slots, plan or bank changed. Pure ranking — no AI, no
  // spend, nothing sent. Behind `topic_refresh` (off → skipped).
  await step("topicRecommendations", async () => {
    const { sweepRecommendations } = await import("@/lib/contentTopics");
    return sweepRecommendations({ max: 60 });
  }, { maxMs: 20_000 });
  // (Session requests and CP-04's booking adapter: /api/cron/aryeo, every 15
  // minutes, straight after the appointments they read — Oct 13 2026.)
  // CP-05: exact filming addresses. The local readback always runs (a row
  // whose project now shows the street is confirmed and Kyle's task closes);
  // the Aryeo PATCH runs only with `address_sync` ON for an authorised
  // fixture. Otherwise a new address goes to Kyle's desk.
  await step("sessionAddresses", async () => {
    const { prisma } = await import("@/lib/prisma");
    const open = await prisma.programSessionAddress.count({ where: { submittedAt: { not: null }, syncState: { not: "SYNCED" } } });
    if (open === 0) return { skipped: "no exact addresses waiting" };
    const { syncSessionAddresses } = await import("@/lib/sessionAddress");
    return syncSessionAddresses({ budgetMs: 25_000 });
  }, { maxMs: 30_000 });
  // Program months: strategyCallStatus / preparationStatus are DERIVED from
  // call records + the enrollment's call mode, hourly, for every live month —
  // the rule that turns Mike Ciunci's NOT_SCHEDULED into NOT_REQUIRED without
  // anyone editing his row. Persisting is behind the SAME owner switch as the
  // rest of the chain (an enabled Calendly mapping): until then this is a DRY
  // RUN that only reports what it would change, so the first hourly tick after
  // a deploy rewrites nothing on the 30 live months.
  await step("programMonths", async () => {
    const { recalcOpenProgramMonths } = await import("@/lib/programMonths");
    const { hasEnabledCallMapping } = await import("@/lib/integrations/calendly");
    const armed = await hasEnabledCallMapping();
    // CP-08: Kyle's follow-up on answers that stop short of a script. Desk
    // truth, outside every switch (like the discovery task): it opens and
    // closes SmartTasks and contacts nobody. Its error used to be returned as
    // a result (`{ error }`), which read `ok`; now it fails the step, after
    // the month recalculation has run either way (Oct 20 2026, audit H6).
    const { reconcileAnswerGapTasks } = await import("@/lib/programDeskTasks");
    const { months: r, answerGaps } = await runParts({
      months: () => recalcOpenProgramMonths({ dryRun: !armed }),
      answerGaps: () => reconcileAnswerGapTasks(),
    });
    return { mode: armed ? "persisted" : "dry-run (no enabled Calendly mapping)", checked: r.checked, changed: r.changed, changes: r.changes.slice(0, 10), answerGaps };
  }, { maxMs: 20_000 });
  // A25 (Sep 25 2026): a booked session whose call moved, was cancelled or was
  // a no-show — or whose answers were sent again — is Kyle's to reassess with
  // the client. Every persisted recalculation already checks its own month;
  // this catches the rest hourly (a session booked in Aryeo by hand, the time
  // passing). Desk truth, outside every switch: it records, opens and closes
  // desk tasks, never moves or cancels a booking and contacts nobody. It reads
  // each month as a DRY derivation, so it persists nothing of the month itself.
  await step("sessionReassess", async () => {
    const { reassessOpenMonths } = await import("@/lib/sessionReassess");
    return reassessOpenMonths();
  }, { maxMs: 20_000 });
  // 6.5 (Jordan, Sep 25 2026): scripts not approved before filming. Desk truth,
  // outside every switch (the address task's rule): Kyle's follow-up 24 hours
  // before a session with scripts still unapproved, the scripts owner's bell
  // 72 hours out while scripts sit in our queue, and closing both when they
  // stop being true. It contacts no client and never touches a session — the
  // client's email is the reminders step's SCRIPTS lane, behind `reminders`.
  await step("scriptApprovalTasks", async () => {
    const { reconcileScriptApprovalTasks } = await import("@/lib/programDeskTasks");
    return reconcileScriptApprovalTasks();
  }, { maxMs: 15_000 });
  // CONTENT PROGRAM REMINDERS + SHARE NOTICES (W2-F, Sep 17 2026, spec §24/§22).
  // Both are OFF at the database (missing ProgramAutomation row = off) and
  // report `skipped` until Jordan authorises launch. When on: reconcile what
  // the outbox said about earlier sends (uncertain delivery, cancelled-by-
  // booking, persistent failures → a task), then evaluate every active month
  // for the ONE action it needs and send inside the client-text window, then
  // drain the batched "your scripts are ready" notices. Each step writes its
  // ledger row BEFORE it touches the outbox, so a crash here leaves a visible
  // state, never a silent gap (the Sep 8 lesson). Caps: 25 sends, 10 notices.
  // RECONCILE RUNS WHETHER OR NOT THE SWITCHES ARE ON, and only when open rows
  // exist. It sends nothing — it is the step that SETTLES what earlier sends
  // did, CANCELS anything still queued whose switch has since gone off (the
  // recovery drain in cron/gmail re-checks only the send window, not these
  // switches), and hands persistent failures to a person. Gating it behind the
  // same switch it is meant to police would mean turning reminders off left
  // half-sent rows frozen and unwatched — the Sep 8 shape. The count guard
  // keeps the pre-launch promise exact: with no open rows it writes nothing.
  await step("programReminderReconcile", async () => {
    const { prisma } = await import("@/lib/prisma");
    const openRows = await prisma.programReminder.count({ where: { state: { in: ["PENDING", "QUEUED", "UNKNOWN", "FAILED"] }, action: { not: "ESCALATION" } } });
    if (openRows === 0) return { skipped: "no open reminder rows" };
    const { reconcileReminderOutcomes } = await import("@/lib/programReminders");
    return reconcileReminderOutcomes();
  }, { maxMs: 20_000 });
  await step("programReminders", async () => {
    const { isAutomationEnabled, recordAutomationRun } = await import("@/lib/programAutomation");
    if (!(await isAutomationEnabled("reminders"))) return { skipped: "reminders is off" };
    const { evaluateReminders } = await import("@/lib/programReminders");
    try {
      const r = await evaluateReminders({ dryRun: false, requestedBy: "reminders-cron" });
      // A run that suppressed everything for an infrastructure reason is NOT a
      // clean run: healthError puts it on the automation row so the settings
      // screen and the monitoring page can see the silence.
      await recordAutomationRun("reminders", r.healthError);
      return { evaluated: r.evaluated, sent: r.sent.filter((s) => s.outcome === "sent").length, outcomes: r.sent.slice(0, 10), escalations: r.escalations.length, health: r.healthError, note: r.note };
    } catch (e) {
      await recordAutomationRun("reminders", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, { maxMs: 30_000 });
  // CLIENT REVIEW EXPIRY (CP-02). Behind `revision_policy` (off at the
  // database — the step reports `skipped`). When on: an expired review window
  // becomes a task for Kyle, or — only with `review_auto_approve` on too, only
  // for windows opened after it was, TEST clients only by default, and only
  // with no hold — the automatic approval. Never a client message.
  await step("reviewWindows", async () => {
    const { sweepReviewWindows } = await import("@/lib/reviewWindows");
    return sweepReviewWindows({ max: 25 });
  }, { maxMs: 20_000 });
  await step("shareNotices", async () => {
    const { isAutomationEnabled, recordAutomationRun } = await import("@/lib/programAutomation");
    if (!(await isAutomationEnabled("script_share_email"))) return { skipped: "script_share_email is off" };
    const { drainShareNotices } = await import("@/lib/scriptShare");
    try {
      const r = await drainShareNotices({ max: 10, requestedBy: "share-drain" });
      await recordAutomationRun("script_share_email", null);
      return r;
    } catch (e) {
      await recordAutomationRun("script_share_email", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, { maxMs: 15_000 });
  // CP-13: "the office replied" emails for the program conversation. Behind
  // `program_message_notice` (off); inside, client hours only, once per seat
  // per unread run. A reply written after 4:30pm goes out on the next working
  // morning's tick — this step is that floor.
  await step("programMessageNotices", async () => {
    const { isAutomationEnabled, recordAutomationRun } = await import("@/lib/programAutomation");
    if (!(await isAutomationEnabled("program_message_notice"))) return { skipped: "program_message_notice is off" };
    const { sweepProgramMessageNotices } = await import("@/lib/programMessages");
    try {
      const r = await sweepProgramMessageNotices();
      await recordAutomationRun("program_message_notice", r.refused ? r.notes.join("; ").slice(0, 400) : null);
      return r;
    } catch (e) {
      await recordAutomationRun("program_message_notice", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, { maxMs: 15_000 });
  // ONBOARDING (spec §21): advance each discovery → strategy record and queue
  // the STRATEGY_DRAFT job for a confirmed discovery transcript. Behind
  // `strategy_generation`; the generation itself runs in the transcript queue
  // (W1-C's handler, driven by the 15-minute AI work job, cron/topics) and
  // lands as a DRAFT for Jordan — nothing
  // here approves, activates or releases a strategy.
  await step("programOnboarding", async () => {
    const { sweepOnboarding } = await import("@/lib/programOnboarding");
    return sweepOnboarding({ max: 25 });
  }, { maxMs: 15_000 });
  // (Frame.io integration removed Sep 1 2026 per the owner — review runs through the in-hub Review Room.)

  // ERRORS THAT STOPPED HAPPENING CLOSE THEMSELVES (Oct 13 2026, B8). A server
  // error tied to a route or a background area that has not recurred in 24
  // hours is marked fixed with the reason (a cron step's own error closes
  // sooner, from cron.ts, after three clean runs of that step). One bounded
  // UPDATE; nothing is sent. If it happens again it reopens as before.
  await step("errorAutoResolve", async () => {
    const { autoResolveQuietErrors } = await import("@/lib/errorTracker");
    return autoResolveQuietErrors();
  }, { maxMs: 10_000 });

  // Persist this run (CronRun) + Slack-ping on a NEW failure/skip. Best-effort.
  await finish();

  return NextResponse.json({ ok: true, ...out });
}
