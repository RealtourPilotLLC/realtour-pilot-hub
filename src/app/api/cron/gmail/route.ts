import { NextRequest, NextResponse } from "next/server";
import { syncGmail } from "@/lib/integrations/google";
import { sweepRepliedOpenPhoneTasks } from "@/lib/integrations/openphone";
import { syncSlackHistory } from "@/lib/integrations/slackSync";
import { sweepReplySla } from "@/lib/commsSla";
import { cronBudget } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// COMMS cron (runs every few minutes — see vercel.json). Keeps communications
// live: scans the inbox into tasks and closes OpenPhone reply tasks we've since
// answered. Inbound texts/calls already arrive in real time via OpenPhone
// webhooks; this covers Gmail (no push) + the answered-thread sweep. It's light
// on the DB (no full-table scans — those run in /api/cron/daily).
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
  // Budgeted steps (same pattern as /sync + /daily): each failure is captured
  // per-step, and the run lands in CronRun so a dead comms scan is visible on
  // /connections instead of silently degrading.
  const { step, out, finish } = cronBudget(100_000, Date.now(), "gmail"); // ~20s headroom under maxDuration

  await step("gmail", () => syncGmail());
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
  await step("slack", () => syncSlackHistory({ sinceHours: 2 }));
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
    const { recoverExpiredLeases, drainPending, unknownSendCount, outboxKind, isClientKind } = await import("@/lib/outbox");
    const { clientTextWindowOpen, recordDrainedSend, recoveredTextStillTrue } = await import("@/lib/clientTextSweeps");
    const leases = await recoverExpiredLeases();
    let windowOpen: boolean | null = null; // one settings read per run, not per row
    const recovered: string[] = [];
    const superseded: string[] = [];
    const drained = await drainPending({
      workerId: `cron-gmail-${Date.now().toString(36)}`,
      limit: 10,
      canSend: async (row) => {
        if (!isClientKind(outboxKind(row.dedupeKey))) return true; // team texts ignore the window by design
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
        const note = isClientKind(outboxKind(row.dedupeKey))
          ? await recordDrainedSend(row, providerId)
          : await import("@/lib/notify").then(({ recordDrainedStaffSms }) => recordDrainedStaffSms(row, providerId));
        if (note) recovered.push(note);
      },
    });
    return {
      leases: { returned: leases.returned, toUnknown: leases.unknown, released: leases.released },
      drained,
      ...(recovered.length > 0 ? { recovered } : {}),
      ...(superseded.length > 0 ? { superseded } : {}),
      unconfirmed: await unknownSendCount(),
    };
  });
  await step("kyleMorning", async () => {
    const { kyleMorningDigest } = await import("@/lib/notify");
    return kyleMorningDigest();
  });
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

  await finish();
  return NextResponse.json({ ok: true, ...out });
}
