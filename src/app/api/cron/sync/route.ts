import { NextRequest, NextResponse } from "next/server";
import { syncAryeoOrders, syncAryeoAppointments } from "@/lib/integrations/aryeo";
import { cronBudget } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// HOURLY sync — keep orders + shoots fresh. Incremental (stops at known orders),
// so it's cheap. Heavy full-table jobs live in /api/cron/daily. Steps run under a
// time budget so a slow one degrades gracefully (the rest are reported as
// `skipped` and picked up next run) instead of being hard-killed mid-write.
export async function GET(req: NextRequest) {
  // FAIL CLOSED: in prod/Vercel a missing CRON_SECRET must refuse, not open the
  // door — same rule as the auth gate (losing an env var never fails open).
  const secret = process.env.CRON_SECRET;
  const enforced = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  if (!secret && enforced) return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 401 });
  if (secret) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
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

  await step("orders", () => syncAryeoOrders({ full: false }));
  // Recent + future only, so the hourly run stays well under the time limit.
  await step("appointments", () => syncAryeoAppointments({ recentOnlyDays: 21 }));
  // Orders that vanished from Aryeo (deleted / archived) while the hub still
  // holds a live job — the list scan can never see them. One GET per active
  // project (~35, ~9s); runs BEFORE statuses/tasks so those steps see the
  // flag the same tick. Flags + asks, never cancels.
  await step("orphanOrders", async () => {
    const { flagOrphanedOrders } = await import("@/lib/integrations/aryeo");
    return flagOrphanedOrders();
  });
  // Approved cuts → Dropbox: finish in-flight save_url copies, retry failed
  // ones, and retire uploads that never completed.
  await step("approvedCuts", async () => {
    const { finalizeApprovedCuts } = await import("@/lib/reviewCuts");
    return finalizeApprovedCuts();
  }, { maxMs: 45_000 });

  // The 1080p pass has its own */5 driver (/api/cron/topaz) — this is its
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
  // Runs after appointments so a fresh booking's shootDate is already on the
  // project, and before statuses so the evidence sweep finds the folders.
  await step("dropboxFolders", async () => {
    const { ensureFoldersForUpcomingShoots } = await import("@/lib/dropboxFolders");
    return ensureFoldersForUpcomingShoots();
  });
  // Every client with a video order gets a brand-assets folder (logos,
  // endcards) — feeds the Assets-available badge on /edit and /clients/assets.
  await step("clientAssetFolders", async () => {
    const { ensureVideoClientAssetFolders } = await import("@/lib/clientAssets");
    return ensureVideoClientAssetFolders();
  });
  // CP-06: a brand change whose inline alert never ran gets its Kyle task and
  // banner here, and — only once `brand_change_alerts` is on — changes held
  // while it was off get their editor DM. Database + the switch-gated bridge.
  await step("brandChangeAlerts", async () => {
    const { sweepBrandChangeAlerts } = await import("@/lib/brandProfile");
    return sweepBrandChangeAlerts();
  });
  // Content Creator Program: enrollments follow the Aryeo social flag, every
  // active client gets the current month's workspace, and monthly-plan shoots
  // attach to their month.
  await step("stripeSignups", async () => {
    // Website signup activation: paid Stripe checkouts for the program's
    // products become live enrollments (Jordan, Aug 28). Runs BEFORE the
    // program sweep so a brand-new enrollment gets its month workspace and
    // roster rows in the same cron pass.
    const { sweepStripeSignups, sweepSubscriptionHealth } = await import("@/lib/stripeSignups");
    const signups = await sweepStripeSignups();
    const health = await sweepSubscriptionHealth().catch(() => ({ checked: 0, alerts: 0 }));
    return { ...signups, subs: health };
  });
  await step("portalLibrary", async () => {
    // Fresh Aryeo deliveries on content jobs reach the client's portal library
    // within the hour (review-room approvals land instantly via the hook).
    const { sweepPortalLibraries } = await import("@/lib/portalLibrary");
    return sweepPortalLibraries();
  });
  // CP-09: a photographer's filmed-topic report that did not land at submit
  // (ContentFilmingReport FAILED / PENDING / a dead lease) is retried here
  // until it does. BEFORE contentLibrary, so the videos it confirms and binds
  // to their slots are on file when the library rebuilds. Database-only and
  // contacts nobody, so no switch — the same reasoning as contentLibrary.
  await step("filmingReports", async () => {
    const { sweepFilmingReports } = await import("@/lib/filmedTopics");
    return sweepFilmingReports();
  });
  await step("contentLibrary", async () => {
    // The NEW video library (ContentVideo), which the staff overview counts
    // production from. Without this it only ever filled when a client opened
    // their portal. Derives from each client's own work; contacts nobody.
    const { sweepContentVideoLibraries } = await import("@/lib/contentVideos");
    return sweepContentVideoLibraries();
  });
  await step("contentProgram", async () => {
    const { contentProgramSweep } = await import("@/lib/contentProgram");
    return contentProgramSweep();
  });
  // CP-07: scripted-but-unfilmed topics from a past month carry into the month
  // contentProgram has just minted (so this must run after it). Behind
  // `topic_carryover` (a missing row is off → `skipped`); a pointer move with
  // full history, never a draft, never a message.
  await step("topicCarryover", async () => {
    const { sweepCarryover } = await import("@/lib/contentTopics");
    return sweepCarryover();
  }, { maxMs: 20_000 });
  // Strategy calls: Calendly bookings stamp months, Drive transcripts ingest,
  // fresh transcripts auto-analyze into topics + draft scripts (all of which
  // wait in INTERNAL_REVIEW — the human-review rule holds), and on the 1st the
  // booking-link drafts are minted for clients who haven't scheduled.
  await step("contentCalls", async () => {
    const { syncStrategyCallsFromCalendly, sweepDriveTranscripts, mintStrategyCallInvites } = await import("@/lib/contentCalls");
    const cal = await syncStrategyCallsFromCalendly().catch(() => ({ skipped: "error" }));
    // Transcripts come from the Drive/Meet (Gemini) docs — through the call
    // records once a Calendly mapping is enabled, through the legacy sweep
    // below until then (it stands down by itself). Calendly Notetaker is NOT a
    // source: it answers 403 on our plan ("required features are not enabled")
    // and Jordan closed it on Sep 21 — not a requirement. This step
    // used to call it every hour anyway, under a comment calling it the primary
    // source, and every call failed. It is no longer called from here;
    // sweepNotetakerTranscripts stays in contentCalls.ts, and the staff "sync
    // calls" button still runs it on demand (CP-15, Sep 24 2026).
    const drv = await sweepDriveTranscripts().catch(() => ({ skipped: "error" }));
    const inv = await mintStrategyCallInvites().catch(() => ({ minted: 0 }));
    // Auto-process any transcript that landed without analysis (Drive sweep or
    // an unanalyzed paste): topics + scripts, all held for review.
    const { prisma } = await import("@/lib/prisma");
    const fresh = await prisma.contentMonth.findMany({
      where: { transcriptText: { not: null }, transcriptProcessedAt: null, historical: false },
      select: { id: true },
      take: 5,
    });
    let processed = 0;
    for (const m of fresh) {
      try {
        const { processMonthTranscript, generateScriptsForMonth } = await import("@/lib/contentPipeline");
        await processMonthTranscript(m.id);
        await generateScriptsForMonth(m.id);
        processed++;
      } catch { /* one bad transcript must not stop the rest */ }
    }
    return { calendly: cal, drive: drv, invites: inv.minted, processed };
  });
  // Re-evaluate project statuses (Aryeo has no media-upload webhook, so this is
  // how a shoot's media gets detected → SHOT/REVIEW) and (re)generate the QC /
  // delivery tasks for active jobs. Bounded to the active set, so it stays cheap.
  await step("statuses", async () => {
    const { syncProjectStatuses } = await import("@/lib/projectStatus");
    return syncProjectStatuses();
  });
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
  // FINISHED VIDEOS THAT MAY ALREADY BE UP THERE (Sep 17 2026). One Aryeo read
  // per job with a row on the Ready-to-send card: it refreshes what the card
  // says Aryeo is showing (the status sweep above stops carrying a job seven
  // days after delivery, which froze 2051 Old Sumneytown Pike's counts at
  // `videos: 0` while its video went up the next day), and it runs the delivery
  // webhook's own proof — individual videos matched to individual cuts by time
  // and length — on the jobs it applies to. That proof normally arrives with
  // Aryeo's LISTING_DELIVERED event; the lane has been silent since Sep 7 and
  // only Aryeo's team can switch it back on, so until they do, this is how it
  // gets run at all. Never clears a row it cannot prove: those keep their place
  // on the card and now carry the listing's own answer for Kyle to act on.
  // Runs straight after `statuses` so it only pays for the jobs that pass did
  // not already refresh.
  await step("readyToSendAryeo", async () => {
    const { sweepReadyToSendAgainstAryeo } = await import("@/lib/aryeoDelivery");
    return sweepReadyToSendAgainstAryeo({ max: 12, budgetMs: 25_000 });
  }, { maxMs: 30_000 });
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
  });
  await step("tasks", async () => {
    const { generateTasksForActiveProjects } = await import("@/lib/tasks");
    return generateTasksForActiveProjects();
  });
  // Client texts that send themselves (Jordan, Sep 1): shoot confirmations 48h
  // out and delivery texts once Aryeo shows every deliverable shipped. Both
  // self-gate to 9am-4pm ET, atomically claim the task + an idempotency marker
  // before sending, and share ONE per-client set so a multi-listing client
  // gets at most one auto-text per tick (confirmations first — time-critical).
  // Runs right after `tasks`/`statuses` so the evidence they read is fresh.
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
  // Pull missing scripts from the Script Writing platform (by external_id) so
  // the queue's Script chip and the shoot screen fill themselves — Jordan:
  // "Script studio should just get the script from the shoot on our script
  // writing platform via api." Pull-only; the signed webhook is the fast path.
  await step("scripts", async () => {
    const { sweepMissingScripts } = await import("@/lib/scriptSync");
    return sweepMissingScripts();
  });
  // Retry webhook events that errored on first receipt (transient blips) so a
  // dropped delivered/paid/inbound event doesn't silently vanish.
  await step("retryWebhooks", async () => {
    const { retryFailedWebhooks } = await import("@/lib/webhookRetry");
    return retryFailedWebhooks(25);
  });

  // CONTENT PROGRAM OPERATING SYSTEM (Sep 16 2026) — the verified call chain.
  // Bookings on the MAPPED Calendly event types become ProgramCallRecords
  // (identity by verified email only; unmatched → review task), each record is
  // linked to its Google Calendar event, and its Gemini notes doc is attached
  // only when the calendar's summary + start both match, uniquely. Every step
  // self-skips until an enabled mapping exists, so the legacy `contentCalls`
  // step keeps today's behaviour until then. Nothing here messages a client.
  //
  // LAST in the hour, on purpose: the client-text sweeps above are
  // time-critical and the sync has been running 78–89 s of its 250 s budget;
  // a slow Calendly/Drive pass here must never push a confirmation text into
  // `skipped`. Everything below resumes where it left off next tick.
  await step("contentCallRecords", async () => {
    const { syncCallRecordsFromCalendly, linkCalendarEvents, discoverTranscriptSources, sweepUnlinkedDriveTranscripts, reconcileCallReviewTasks } = await import("@/lib/contentCallRecords");
    const { hasEnabledCallMapping } = await import("@/lib/integrations/calendly");
    if (!(await hasEnabledCallMapping())) return { skipped: "no enabled Calendly mapping" };
    const bookings = await syncCallRecordsFromCalendly().catch((e) => ({ skipped: e instanceof Error ? e.message : "error" }));
    const calendar = await linkCalendarEvents({ max: 20 }).catch((e) => ({ skipped: e instanceof Error ? e.message : "error" }));
    const transcripts = await discoverTranscriptSources({ max: 40 }).catch((e) => ({ skipped: e instanceof Error ? e.message : "error" }));
    // Program Gemini docs no record has claimed → the import review queue (rows only, no text, no tasks, no analysis).
    const unlinked = await sweepUnlinkedDriveTranscripts({ sinceDays: 45, max: 10 }).catch((e) => ({ skipped: e instanceof Error ? e.message : "error" }));
    const review = await reconcileCallReviewTasks().catch(() => ({ closed: 0 }));
    return { bookings, calendar, transcripts, unlinked, review };
  }, { maxMs: 45_000 });
  // Transcript jobs: INGEST (ours) + the AI kinds W1-C provides. Runs ONLY when
  // the `transcript_jobs` automation is on (a missing row is off); with the
  // switch off the step reports `skipped` and queued rows simply wait.
  await step("transcriptJobs", async () => {
    const { driveTranscriptJobs } = await import("@/lib/transcriptJobs");
    return driveTranscriptJobs({ max: 5, budgetMs: 30_000, leaseBy: "sync-cron" });
  }, { maxMs: 40_000 });
  // THE DRAFTING CHAIN (F07/F08, Sep 22 2026). Both planning paths end here:
  // a client's written answers, and a reconciled planning call. Until today
  // neither reached a script on its own — SCRIPT_DRAFT was never enqueued by
  // anything, and submitInterview set a status and stopped while the portal
  // told the client "we'll draft the script from your answers". Behind
  // `script_drafting` (off at the database) AND `ai_runs`; drafts land in the
  // same review lane a hand-written one does.
  // F14: approved content cuts that never reached the client's library. The
  // approve-time write is best-effort by design (an approval must not fail over
  // it) and nothing looked again afterwards. Normally repairs nothing.
  await step("libraryRepair", async () => {
    const { repairApprovedCutLibrary } = await import("@/lib/portalLibrary");
    const library = await repairApprovedCutLibrary({ sinceDays: 45, max: 200 });
    // R2: a client change request whose work item never reached the queue. The
    // client was told "it's with the writer" and the writer had nothing.
    const { repairScriptChangeRequests } = await import("@/lib/scriptDecisions");
    const changes = await repairScriptChangeRequests({ sinceDays: 90, max: 300 });
    // R5: a video recorded as sent whose 1080p job was stamped delivered and
    // whose upload card was left open — the half-finished settle A04 described.
    // Deliberately NOT the other way round: an undelivered job with an open
    // card is Kyle's ordinary chase card and must not be closed.
    const { repairIncompleteDeliveries } = await import("@/lib/readyToSend");
    const deliveries = await repairIncompleteDeliveries({ sinceDays: 30, max: 200 });
    // CP-02: a content cut released since the review windows shipped whose
    // window write failed gets it now, from the TRUE release time. CP-03: a
    // client's change request whose routing failed after it was recorded — or
    // notes a racing submit left open beside it — reach the editor.
    const { repairReviewWindows } = await import("@/lib/reviewWindows");
    const reviewWindows = await repairReviewWindows({ max: 100 });
    const { repairPortalRevisionRequests } = await import("@/lib/clientDecisions");
    const portalRequests = await repairPortalRevisionRequests({ max: 50 });
    return { library, changes, deliveries, reviewWindows, portalRequests };
  }, { maxMs: 30_000 });
  await step("scriptDrafting", async () => {
    const { sweepInterviewPlans, sweepOwedScripts } = await import("@/lib/contentDrafting");
    // Questions first: phrasing them for the topic has to happen BEFORE the
    // client opens them, and a topic that gets answered this way produces a
    // better script than the same topic drafted from a call excerpt.
    const plans = await sweepInterviewPlans({ max: 4, budgetMs: 30_000 });
    const drafts = await sweepOwedScripts({ max: 6, budgetMs: 45_000 });
    return { plans, drafts };
  }, { maxMs: 90_000 });
  // 6.5: share a clean sweep-drafted script WITHOUT Jordan's individual
  // approval, after its hold. Behind `script_auto_share` — OFF at the database
  // (a missing row), so this reports `skipped`. The share email is its own
  // switch (script_share_email) either way.
  await step("scriptAutoShare", async () => {
    const { sweepAutoShare } = await import("@/lib/scriptAutoShare");
    return sweepAutoShare();
  }, { maxMs: 20_000 });
  // CP-07: the topic bank keeps itself stocked — the initial bank after a
  // strategy is approved, per-pillar refills when usable stock falls below the
  // target. Behind `topic_refresh` (and `ai_runs` under it); every result is a
  // suggestion Jordan reviews. Two runs per tick at most.
  await step("topicBanks", async () => {
    const { sweepTopicBanks } = await import("@/lib/contentTopics");
    return sweepTopicBanks({ max: 2, budgetMs: 60_000 });
  }, { maxMs: 75_000 });
  // 6.3: the client's recommendations for each open month, re-ranked only
  // when the month's slots, plan or bank changed. Pure ranking — no AI, no
  // spend, nothing sent. Behind `topic_refresh` (off → skipped).
  await step("topicRecommendations", async () => {
    const { sweepRecommendations } = await import("@/lib/contentTopics");
    return sweepRecommendations({ max: 60 });
  }, { maxMs: 20_000 });
  // Session requests: REQUESTED → CONFIRMED when the Aryeo appointment (synced
  // above) appears at the slot; CONFIRMED → CANCELLED when Aryeo cancels it;
  // stale ones expire. Read-only against Aryeo — it reads the rows the
  // appointments step just wrote.
  await step("sessionRequests", async () => {
    const { reconcileSessionRequests } = await import("@/lib/sessionRequests");
    return reconcileSessionRequests();
  }, { maxMs: 20_000 });
  // CP-04: the booking adapter, its own step with its own budget — a real
  // booking is several provider calls and must not share the reconcile's 20 s.
  // `session_booking` OFF (a missing row) = `skipped`, zero calls; ON, it books
  // only for clients the switch's config authorises (TEST fixtures), at most 3
  // a run, and starts no new write with under 30 s left.
  await step("sessionBookings", async () => {
    const { driveSessionBookings } = await import("@/lib/sessionBooking");
    return driveSessionBookings({ budgetMs: 60_000 });
  }, { maxMs: 70_000 });
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
    const r = await recalcOpenProgramMonths({ dryRun: !armed });
    // CP-08: Kyle's follow-up on answers that stop short of a script. Desk
    // truth, outside every switch (like the discovery task): it opens and
    // closes SmartTasks and contacts nobody.
    const { reconcileAnswerGapTasks } = await import("@/lib/programDeskTasks");
    const answerGaps = await reconcileAnswerGapTasks().catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
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
  // `strategy_generation`; the generation itself runs in the transcriptJobs
  // step above (W1-C's handler) and lands as a DRAFT for Jordan — nothing
  // here approves, activates or releases a strategy.
  await step("programOnboarding", async () => {
    const { sweepOnboarding } = await import("@/lib/programOnboarding");
    return sweepOnboarding({ max: 25 });
  }, { maxMs: 15_000 });
  // (Frame.io integration removed Sep 1 2026 per the owner — review runs through the in-hub Review Room.)

  // Persist this run (CronRun) + Slack-ping on a NEW failure/skip. Best-effort.
  await finish();

  return NextResponse.json({ ok: true, ...out });
}
