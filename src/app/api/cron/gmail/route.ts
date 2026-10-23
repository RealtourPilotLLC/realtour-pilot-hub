import { NextRequest, NextResponse } from "next/server";
import { syncGmail } from "@/lib/integrations/google";
import { sweepRepliedOpenPhoneTasks } from "@/lib/integrations/openphone";
import { syncSlackHistory } from "@/lib/integrations/slackSync";
import { sweepReplySla } from "@/lib/commsSla";
import { cronBudget, authorizeCron, runParts } from "@/lib/cron";
import type { OutboxKind } from "@/lib/outbox";
import type { AutomationKey } from "@/lib/programAutomation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** The switch each content-program email answers to — the same pairs the
 *  dispatch gate uses (programRolloutGate KIND). */
const PROGRAM_KIND_SWITCH: Partial<Record<OutboxKind, AutomationKey>> = {
  program_reminder: "reminders",
  script_share: "script_share_email",
  strategy_ready: "script_share_email",
  program_message: "program_message_notice",
};

// COMMS cron (runs every few minutes — see vercel.json). Keeps communications
// live: scans the inbox into tasks and closes OpenPhone reply tasks we've since
// answered. Inbound texts/calls already arrive in real time via OpenPhone
// webhooks; this covers Gmail (no push) + the answered-thread sweep. It's light
// on the DB (no full-table scans — those run in /api/cron/daily).
//
// THE TWO BIG READS ARE CAPPED (Oct 20 2026, audit H14). Gmail and Slack had
// no cap, so a slow mailbox or Slack pass could spend the 100 s budget and
// push the last steps into `skipped`: the 6 PM wrap and the night-before shoot
// briefs ran last of all. A cap does not cut a step off: cronBudget stops
// WAITING for it, records `timedOut` and moves on while the read finishes
// underneath (both dedupe what they log, and the next tick, five minutes
// later, reads again). `evening` now runs before Kyle's lead and promise
// pings, which are cheaper to miss for one tick. The once-a-day digests keep
// no cap: each claims its day before it builds and sends, and a run that
// stopped waiting on one could end before it sent.
export async function GET(req: NextRequest) {
  // FAIL CLOSED: in prod/Vercel a missing CRON_SECRET must refuse, not open the
  // door — the one shared rule (lib/cron authorizeCron).
  const denied = authorizeCron(req);
  if (denied) return denied;
  // Budgeted steps (same pattern as /sync + /daily): each failure is captured
  // per-step, and the run lands in CronRun so a dead comms scan is visible on
  // /connections instead of silently degrading.
  const { step, out, finish } = cronBudget(100_000, Date.now(), "gmail"); // ~20s headroom under maxDuration

  // Per-mailbox reads (§9, Sep 26): the step reports `degraded` when any
  // mailbox — info@ or hello@ — was not read, and syncGmail itself opens the
  // owner's reconnect task. /connections reads the flag off this run.
  // Half the budget at most: the inbox scan matters most, but not more than
  // everything after it put together. Each Gmail read has its own 30 s limit.
  await step("gmail", () => syncGmail(), { maxMs: 50_000 });
  // Backstop only — the realtime webhook already closes answered threads.
  // Run it on the top-of-hour tick instead of all 12 (audit: the 5-minute poll
  // hit the OpenPhone API per open reply task per line, duplicating the webhook).
  await step("openphoneClosed", async () => {
    const min = Number(new Intl.DateTimeFormat("en-US", { minute: "numeric", timeZone: "UTC" }).format(new Date()));
    if (min >= 5) return { skipped: "hourly backstop — top-of-hour tick only" };
    return sweepRepliedOpenPhoneTasks();
  });
  // Keep Slack comms memory near-live (channels + Jordan's DMs) every few
  // minutes via the user token. Small window; logComm dedups the overlap.
  await step("slack", () => syncSlackHistory({ sinceHours: 2 }), { maxMs: 30_000 });
  // READ AGAIN WHAT THE AI REFUSED (Oct 22 2026, comms audit H5, lib/aiOutage):
  // client texts and emails the comms router could not read during a spend
  // limit or a refused key, oldest first, once the AI answers again. Stops at
  // the first refusal (one call a tick while it lasts). Idle when nothing waits.
  await step("aiRetry", async () => {
    const { sweepAiRetries } = await import("@/lib/aiOutage");
    return sweepAiRetries({ limit: 8 });
  }, { maxMs: 40_000 });
  // Team-SMS digest flusher (batched pings for Harrison/James) + Kyle's 4 PM
  // Slack check-in — both cheap no-ops most runs.
  await step("smsFlush", async () => {
    const { flushPendingSms } = await import("@/lib/notify");
    return flushPendingSms();
  });
  // RTP-08 (Sep 16): the outbox watchdog. Every message the hub sends now lives
  // in a durable row, and a worker that stops mid-send leaves that row behind.
  // Every five minutes:
  //   · an expired lease that never reached a provider goes back to pending;
  //   · one that HAD reached a provider becomes `unknown` and is never retried
  //     blindly — it may already be in the client's hands. It surfaces on
  //     Connections with its age and a Retry only a person can press.
  //   · a young pending row a stopped worker left behind is sent — but ONLY if
  //     the client-text window is still open, so a recovery can never put a
  //     client text out after Jordan's 4:30pm cutoff. An older one is released
  //     to its own sweep, which re-checks every gate before offering it again.
  // A drained row's CALLER is gone, so this step also writes the records that
  // caller would have written — the AppSetting marker, Client.welcomeTextAt, the
  // task's completion, the comm log (review, Sep 16). Without them the send is
  // real but invisible, and the sweep that queued it meets its own accepted row
  // on every tick for ever.
  await step("outboxRecover", async () => {
    const { recoverExpiredLeases, drainPending, unknownSendCount, outboxKind, isClientKind, isProgramKind } = await import("@/lib/outbox");
    const { clientTextWindowOpen, recordDrainedSend, recoveredTextStillTrue } = await import("@/lib/clientTextSweeps");
    const { isAutomationEnabled } = await import("@/lib/programAutomation");
    const leases = await recoverExpiredLeases();
    let windowOpen: boolean | null = null; // one settings read per run, not per row
    const switchOn = new Map<string, boolean>(); // one read per switch per run
    const recovered: string[] = [];
    const superseded: string[] = [];
    const switchedOff: string[] = [];
    const drained = await drainPending({
      workerId: `cron-gmail-${Date.now().toString(36)}`,
      limit: 10,
      canSend: async (row) => {
        const kind = outboxKind(row.dedupeKey);
        // A PROGRAM email's own switch, asked BEFORE the send (automation audit
        // item 13, Oct 13 2026). The dispatch gate inside deliver() refuses a
        // switched-off kind too, but only by marking the row failed; asked
        // here, the row is held — still pending — and the hourly
        // programReminderReconcile cancels it with the reason, the path a
        // switched-off reminder is meant to take. Never sent while it is off.
        if (isProgramKind(kind) && kind) {
          const key = PROGRAM_KIND_SWITCH[kind];
          if (key) {
            if (!switchOn.has(key)) switchOn.set(key, await isAutomationEnabled(key).catch(() => false));
            if (!switchOn.get(key)) {
              switchedOff.push(`${kind}: ${key} is off`);
              return false;
            }
          }
        }
        // A shoot-day text (lib/shootDayText) answers to its own switch on the
        // recovery path too: turned off since it was queued, it is held.
        if (kind === "shoot_day") {
          if (!switchOn.has("shootDayText")) {
            const { internalAlertRules } = await import("@/lib/settings");
            switchOn.set("shootDayText", await internalAlertRules().then((r) => r.shootDayText.enabled).catch(() => false));
          }
          if (!switchOn.get("shootDayText")) {
            switchedOff.push("shoot_day: Special requests at the shoot is off");
            return false;
          }
          return true;
        }
        // An upload-gap text (lib/uploadGaps) answers to its own switch the same way.
        if (kind === "upload_gap") {
          if (!switchOn.has("uploadGap")) {
            const { internalAlertRules } = await import("@/lib/settings");
            switchOn.set("uploadGap", await internalAlertRules().then((r) => r.uploadGap.enabled).catch(() => false));
          }
          if (!switchOn.get("uploadGap")) {
            switchedOff.push("upload_gap: Missing from the upload is off");
            return false;
          }
          return true;
        }
        // A missing-instructions text (lib/missingInstructions), the same way.
        if (kind === "instructions_missing") {
          if (!switchOn.has("missingInstructions")) {
            const { internalAlertRules } = await import("@/lib/settings");
            switchOn.set("missingInstructions", await internalAlertRules().then((r) => r.missingInstructions.enabled).catch(() => false));
          }
          if (!switchOn.get("missingInstructions")) {
            switchedOff.push("instructions_missing: Missing instructions, the morning after is off");
            return false;
          }
          return true;
        }
        // A photographer brief (lib/photographerBrief) answers to its own switch the same way.
        if (kind === "photographer_brief") {
          if (!switchOn.has("photographerBrief")) {
            const { photographerBriefSettings } = await import("@/lib/photographerBrief");
            switchOn.set("photographerBrief", await photographerBriefSettings().then((r) => r.enabled).catch(() => false));
          }
          if (!switchOn.get("photographerBrief")) {
            switchedOff.push("photographer_brief: Photographer brief is off");
            return false;
          }
          return true;
        }
        if (!isClientKind(kind)) return true; // team texts ignore the window by design
        if (windowOpen === null) windowOpen = await clientTextWindowOpen();
        if (!windowOpen) return false;
        // THE WINDOW IS NOT THE ONLY QUESTION (audit, Sep 17). "May we text a
        // client now" and "is this text still correct" are different, and this
        // only ever asked the first. A confirmation for a shoot that has since
        // moved, or a feedback ask for a job the client has since bounced back
        // into revisions, is wrong whatever time it is.
        const still = await recoveredTextStillTrue(row);
        if (!still.ok) {
          superseded.push(`${outboxKind(row.dedupeKey) ?? "message"}: ${still.why}`);
          return false;
        }
        return true;
      },
      onAccepted: async (row, providerId) => {
        // Each kind's bookkeeping lives with the code that owns it: client texts
        // in clientTextSweeps, staff digests in notify (where the PendingSms
        // lines behind the digest are).
        // Jordan's own onboarding sends (Oct 5 2026) go in the client's
        // onboarding log, so the page shows them sent and he never presses twice.
        const kind = outboxKind(row.dedupeKey);
        const note = isClientKind(kind)
          ? await recordDrainedSend(row, providerId)
          : kind === "onboarding"
            ? await import("@/lib/clientOnboarding").then(({ recordOnboardingOutboxSend }) => recordOnboardingOutboxSend(row, "recovered"))
            : kind === "shoot_day"
              ? await import("@/lib/shootDayText").then(({ recordDrainedShootDayText }) => recordDrainedShootDayText(row, providerId))
              : kind === "upload_gap"
                ? await import("@/lib/uploadGaps").then(({ recordDrainedUploadGapText }) => recordDrainedUploadGapText(row))
                : kind === "instructions_missing"
                  ? await import("@/lib/missingInstructions").then(({ recordDrainedInstructionsText }) => recordDrainedInstructionsText(row, providerId))
                  : kind === "photographer_brief"
                    ? await import("@/lib/photographerBrief").then(({ recordDrainedBriefText }) => recordDrainedBriefText(row, providerId))
                    : await import("@/lib/notify").then(({ recordDrainedStaffSms }) => recordDrainedStaffSms(row, providerId));
        if (note) recovered.push(note);
      },
    });
    return {
      leases: { returned: leases.returned, toUnknown: leases.unknown, released: leases.released },
      drained,
      ...(recovered.length > 0 ? { recovered } : {}),
      ...(superseded.length > 0 ? { superseded } : {}),
      ...(switchedOff.length > 0 ? { heldSwitchedOff: switchedOff } : {}),
      unconfirmed: await unknownSendCount(),
    };
  });
  await step("kyleMorning", async () => {
    const { kyleMorningDigest } = await import("@/lib/notify");
    return kyleMorningDigest();
  });
  // OLD ITEMS (Oct 19 2026): the separate morning bell + DM per person was
  // switched off the same evening (Jordan: "I just want it simplified"). Kyle's
  // Home checklist carries "from earlier days, still open", and his morning
  // message already lists what is overdue. taskAging.oldItemsMorning is kept,
  // uncalled.
  // Sep 16 (Kyle's call): the 4 o'clock check now leads with the Slack asks —
  // each line carrying the client, the property and its own deep link — and
  // lands on /tasks?tab=slack instead of /today, which redirected to a Comms
  // tab that did not contain a single row it had just listed. Same once-a-day
  // claim key as the old digest, so there is no way to double-send.
  await step("kyleDigest", async () => {
    const { afternoonSlackDigest } = await import("@/lib/commsBoard");
    return afternoonSlackDigest();
  });
  // Reply-SLA escalation: page the team when an inbound client text sits
  // unanswered (30m → ADMIN bell + Slack, 2h → OWNER + urgent; VIPs faster).
  // Best-effort by construction — sweepReplySla never throws — and the step()
  // wrapper keeps even a surprise failure from blocking Gmail polling.
  await step("replySla", () => sweepReplySla());

  // THE PHOTOGRAPHER BRIEF (Oct 23 2026, lib/photographerBrief): at the send
  // time on the business day before (Friday covers the weekend and Monday),
  // each photographer gets one brief for their shoot day; afterwards an
  // updated brief only when something material changes. Its own switch
  // (Settings, Internal alerts, Photographer brief), OFF until Jordan turns it
  // on. Ahead of the shoot-day text, which a sent brief stands in for.
  await step("photographerBrief", async () => {
    const { sweepPhotographerBriefs } = await import("@/lib/photographerBrief");
    return sweepPhotographerBriefs();
  }, { maxMs: 30_000 });

  // THE SPECIAL REQUESTS AT THE SHOOT (Oct 19 2026, lib/shootDayText): at each
  // appointment's start (and up to 30 minutes after, so a missed tick still
  // sends), its creative gets one text with the job's special requests. Its
  // own Settings switch; one per job, creative and shoot day through the
  // outbox. Idle unless an appointment just started.
  await step("shootDayText", async () => {
    const { sweepShootDayTexts } = await import("@/lib/shootDayText");
    return sweepShootDayTexts();
  }, { maxMs: 20_000 });

  // THE SCRIPTS LINK ON SESSION DAY (Oct 23 2026, lib/sessionScriptsText):
  // from 7 AM ET, each monthly content session's creative gets one text with
  // the session's shoot page. Idle before 7 and once every session is texted.
  await step("sessionScriptsText", async () => {
    const { sweepSessionScriptsTexts } = await import("@/lib/sessionScriptsText");
    return sweepSessionScriptsTexts();
  }, { maxMs: 20_000 });

  // MISSING FROM THE UPLOAD (Oct 19 2026, lib/uploadGaps): a job shot in the
  // last three days whose Dropbox upload is missing part of the order (only
  // drone photos, no ground photos) texts its creative once per gap, bells the
  // office and holds the photo delivery check. Each job's folders are read at
  // most every 15 minutes. Its own Settings switch.
  await step("uploadGaps", async () => {
    const { sweepUploadGaps } = await import("@/lib/uploadGaps");
    return sweepUploadGaps();
  }, { maxMs: 40_000 });

  // MISSING INSTRUCTIONS, THE MORNING AFTER (Oct 21 2026, lib/missingInstructions):
  // from 10 AM ET, a job whose upload page is still missing what the edit or
  // the photos wait on texts its photographer exactly what is missing and
  // pings the creative manager, once a morning per job for up to 3 mornings.
  // Database reads only; idle before 10 AM. Its own Settings switch.
  await step("missingInstructions", async () => {
    const { sweepMissingInstructions } = await import("@/lib/missingInstructions");
    return sweepMissingInstructions();
  }, { maxMs: 15_000 });

  // From 6 PM ET: tomorrow's shoot brief to each photographer, and Jordan's
  // 6 PM wrap (Mon to Sat) with a copy to Kyle. Idle every other tick. Ahead
  // of Kyle's reminders below since Oct 20 2026 (audit H14): it ran last and
  // was the first step a slow tick skipped, which delayed the brief and paged.
  await step("evening", async () => {
    const { runEveningAutomations } = await import("@/lib/eveningPush");
    return runEveningAutomations();
  }, { maxMs: 45_000 });

  // KYLE'S REMINDERS, AUTOMATED (Oct 14 2026 comms audit). All three are staff
  // messages only, each behind its own Settings switch (Internal alerts), each
  // claimed per lead / job / day so the next tick (or a twin) sends nothing
  // twice. Last in the run: the inbox and the reply pager come first.
  //  · a new lead still untouched at 15 and 60 covered minutes → Kyle's Slack;
  await step("leadPings", async () => {
    const { sweepLeadPings } = await import("@/lib/leadDesk");
    return sweepLeadPings();
  }, { maxMs: 15_000 });
  //  · 3 covered hours before a job's promise → Kyle's Slack with its stage,
  //    and a client update DRAFTED on his list (never sent);
  await step("promiseWatch", async () => {
    const { sweepPromiseWatch } = await import("@/lib/promiseWatch");
    return sweepPromiseWatch();
  }, { maxMs: 20_000 });
  //  · WE'RE BEHIND (Oct 19 2026, lib/behindAlert): when listing videos go
  //    past their promise, one post in #video-editing and the bells (Jordan,
  //    Kyle, James, the editors); when photo jobs do, a DM to Jordan and Kyle
  //    only (Oct 21). Again each morning while it lasts, and "back on track"
  //    when it clears. Before it, the client asks
  //    on jobs that were delivered close (lib/clientAsks: "the job was
  //    delivered"). Both cheap; idle most ticks.
  //    The three run even when one throws, and a failure fails the step
  //    instead of reading `{ closed: 0 }` (Oct 20 2026, audit H5/H6).
  await step("behindAlert", async () => {
    const { closeAsksOnDeliveredJobs } = await import("@/lib/clientAsks");
    const { runBehindAlert } = await import("@/lib/behindAlert");
    const { closeShootFlagsOnDeliveredJobs } = await import("@/lib/shootIssues");
    const { closeChasesOnDeliveredJobs } = await import("@/lib/chaseCounter");
    const { asks, flags, chases, behind } = await runParts({
      asks: () => closeAsksOnDeliveredJobs(),
      // Oct 22 2026: a "client chasing" task closes when the job is delivered.
      chases: () => closeChasesOnDeliveredJobs(),
      // A shoot's flags clear once the job is delivered (Jordan, Oct 19 2026).
      flags: () => closeShootFlagsOnDeliveredJobs(),
      behind: () => runBehindAlert(),
    });
    return { asksClosed: asks.closed, flagsClosed: flags.closed, chasesClosed: chases.closed, behind };
  }, { maxMs: 30_000 });

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
