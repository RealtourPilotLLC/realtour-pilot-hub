// ---------------------------------------------------------------------------
// DRILL: R03/R04/R05 REVIEW FIXES — the Sep 28 2026 review of the rollout
// build (the fixer's pass). One check per finding, each written so that it
// FAILS on the code before the fix (the fixer ran this file against the
// pre-fix tree to prove it — see the report), and, where the defect can be
// shown in the same process, the OLD rule is shown reproducing first.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/r03-review-fixes.ts
//
//    1. A seat media token stops streaming the moment the rollout drops its
//       client (removal, and an expiry that writes nothing) — portalMedia
//       asks liveMemberships, the resolver's own seat rule.
//    2. The caption assistant is a rollout op: the kit offers it, and the
//       drafter drafts, only for clients the rollout reaches; it is labelled
//       client-facing and readiness lists it.
//    3. A failed LOCK read at dispatch is gate_error (the reminder retries),
//       never launch_not_authorised (suppressed for good).
//    4. "What would go out now?" = dispatch: reminders OFF → no "send";
//       auto-share's eligible draft → "send" (switch on) exactly as the live
//       run shares it; the office-replied lane skips a TEST seat on an
//       unverified inbox in the dry run AND the live run (no throw); the
//       readiness line and the sign-in offer say the same.
//    5. A queued Instagram job is cancelled at run time when the rollout no
//       longer reaches its client (retried, never cancelled, when it cannot be
//       read), before any Meta call.
//    6. An excluded client's Team page: invitations off FOR THEM, and the held
//       reply no longer says "the moment we switch invitations on".
//    7. The address-sync travel check follows the program pilot.
//    8. "since" survives PILOT → ALL and a widening (review deadlines already
//       shown stay enforced).
//    9. The owner's messages: taking a client out / ending the pilot worded by
//       the mode; "every client" names the locked switches as locked and says
//       WHEN each starts; the per-client list is per group; the end date is
//       the chosen day.
//   10. The call processor: a lifted hold and a full tick's passed-over jobs
//       are not "queue not draining"; Re-run says when a job will wait;
//       "skip" restores the FIRST switch-on.
//   11. The readiness banner's "who" comes from its openers.
//
// ISOLATION: PGlite on 127.0.0.1:6230 (DRILL_PORT overrides; the fixer's range
// is 6200-6239). Gmail and Google's token endpoint are FAKES in the fence; the
// model and Instagram are stubbed modules; nothing leaves this machine.
// THE CLOCK IS PINNED to Fri Oct 2 2026 10:00 ET.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, fenceFetch, installNextStubs, interceptModule, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6230);
const REPO = path.resolve(__dirname, "../..");

// ---- the clock ----------------------------------------------------------------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 2, 14, 0, 0); // Fri Oct 2 2026, 10:00 EDT
const offset = PINNED - RealDate.now();
globalThis.Date = new Proxy(RealDate, {
  construct(target, args: unknown[]) {
    if (args.length === 0) return new target(RealDate.now() + offset);
    return Reflect.construct(target, args);
  },
  get(target, prop, recv) {
    if (prop === "now") return () => RealDate.now() + offset;
    return Reflect.get(target, prop, recv);
  },
}) as DateConstructor;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date(PINNED);
const T0 = new Date(PINNED - 2 * DAY); // P joined the pilot Wed Sep 30

installNextStubs();

// ---- fault injection on @/lib/prisma ---------------------------------------------
const faults = { lockRead: false, clientFindUnique: false };
interceptModule(
  (r) => r === "@/lib/prisma",
  (mod) => {
    const m = mod as { prisma: Record<string, unknown> };
    const real = m.prisma;
    const wrap = (name: string, d: object) =>
      new Proxy(d, {
        get(t, k) {
          const v = Reflect.get(t, k, t);
          if (typeof v !== "function" || typeof k !== "string") return v;
          return (...args: unknown[]) => {
            // The feature LOCK read alone (programRollout.storedConfigs: a
            // findMany over configJson); every switch read stays healthy.
            if (name === "programAutomation" && k === "findMany" && faults.lockRead) throw new Error("drill: injected lock read failure");
            if (name === "client" && k === "findUnique" && faults.clientFindUnique) throw new Error("drill: injected client read failure");
            return (v as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    const proxy = new Proxy(real, {
      get(t, k) {
        const v = Reflect.get(t, k, t);
        if ((k === "programAutomation" || k === "client") && v && typeof v === "object") return wrap(k, v);
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { ...m, prisma: proxy };
  },
);

// ---- the model, stubbed and counted -------------------------------------------------
let modelCalls = 0;
interceptModule(
  (r) => r === "@/lib/integrations/ai" || r.endsWith("/integrations/ai"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k !== "aiJsonWithUsage") return t[k];
      return async () => {
        modelCalls++;
        return { result: { captionBody: "Your first weekend decides your price.", shorterAlternative: "First weekend, first price.", captionCta: null, ctaOptions: [], coverTitle: null, gaps: [] }, usage: { inputTokens: 500, outputTokens: 80 }, model: "drill-stub" };
      };
    },
  }),
);

// ---- Instagram, stubbed: "configured", and every provider call recorded --------------
const igCalls: string[] = [];
interceptModule(
  (r) => r === "@/lib/integrations/instagram" || r.endsWith("/integrations/instagram"),
  (loaded) => new Proxy(loaded as Record<string | symbol, unknown>, {
    get(t, k) {
      if (k === "configured") return async () => true;
      const v = t[k];
      if (typeof v !== "function" || typeof k !== "string") return v;
      if (["createMediaContainer", "containerStatus", "publishContainer", "mediaPermalink", "recentMedia"].includes(k)) {
        return async () => { igCalls.push(k); return { ok: false, reason: "not_configured", message: "drill: no Instagram here", retryable: false }; };
      }
      return v;
    },
  }),
);

// ---- fake Gmail -----------------------------------------------------------------------
const mails: string[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const head = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split("\r\n\r\n")[0];
    mails.push((/^To: (.+)$/m.exec(head)?.[1] ?? "").trim().toLowerCase());
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});
const mailsSince = (i: number) => mails.slice(i);

async function main(): Promise<void> {
  const drill = await bootDrillDb({ port: PORT });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  const { prisma } = await import("@/lib/prisma");
  const db = prisma as unknown as PrismaClient;
  const { buildContentMonth } = await import("./_fixtures/contentMonth");
  const core = await import("@/lib/programRolloutCore");
  const pr = await import("@/lib/programRollout");
  const outbox = await import("@/lib/outbox");
  type Rollout = import("@/lib/programRolloutCore").ProgramRollout;
  type Viewer = import("@/lib/portal").PortalViewer;

  // ---- the cast ----------------------------------------------------------------------
  type Fx = { clientId: string; enrollmentId: string; monthId: string; projectId: string | null; clientUserId: string | null; membershipId: string | null; name: string };
  const mk = async (name: string, realName: string | null, owner: string): Promise<Fx> => {
    const f = await buildContentMonth(db, { name, package: "Starter", videosPerMonth: 3, monthKey: "2026-10", owner: { email: owner, name: `${name.split(" ")[0]} Person` }, topics: [{ title: `${name} topic`, selection: "SELECTED" }] });
    await prisma.contentMonth.update({ where: { id: f.monthId }, data: { planningMode: "WRITTEN" } });
    if (realName) await prisma.client.update({ where: { id: f.clientId }, data: { name: realName } });
    return { clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: f.monthId, projectId: f.projectId, clientUserId: f.clientUserId, membershipId: f.membershipId, name: realName ?? name };
  };
  const T = await mk("Rollout TEST", null, "info+rt@realtourpilot.com");
  const T2 = await mk("Second Rollout TEST", null, "nick@realtourpilot.com");
  const P = await mk("Pat Pilot TEST", "Pat Pilot Realty", "pat@example.test");
  const X = await mk("Xena Excluded TEST", "Xena Excluded Homes", "xo@example.test");
  const ownerUser = await prisma.appUser.create({ data: { email: "info@realtourpilot.com", name: "Jordan Spackman", role: "OWNER", status: "ACTIVE" } });
  const { saveSecret } = await import("@/lib/integrations/connections");
  await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": ["drill", "refresh", "token"].join("-") }));
  await saveSecret("ai", ["drill", "model", "key", "not", "real"].join("-"));

  const ALL_OPS = core.opsForGroups(core.PROGRAM_PILOT_GROUPS.map((g) => g.key));
  const pilotOf = (ids: string[], ops = ALL_OPS, extra: Partial<NonNullable<Rollout["pilot"]>> = {}): Rollout => ({
    mode: "PILOT",
    modeSince: new Date(PINNED - 5 * DAY).toISOString(),
    pilot: { clientIds: ids, operations: ops, approvedBy: "info@realtourpilot.com", approvedAt: new Date(PINNED - 5 * DAY).toISOString(), expiresAt: new Date(PINNED + 30 * DAY).toISOString(), note: "drill pilot", joinedAt: Object.fromEntries(ids.map((id) => [id, T0.toISOString()])), ...extra },
  });
  const writeRollout = (r: Rollout | string) => {
    const value = typeof r === "string" ? r : core.serializeProgramRollout(r);
    return prisma.appSetting.upsert({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY }, create: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value, updatedBy: "drill" }, update: { value, updatedBy: "drill" } });
  };
  const setSwitch = async (key: string, enabled: boolean, config: Record<string, unknown> | null = null, enabledAt: Date = new Date(PINNED - 10 * DAY)) => {
    const configJson = config ? JSON.stringify(config) : null;
    await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt, configJson }, update: { enabled, enabledAt, configJson } });
  };
  const viewerOf = (f: Fx): Viewer => ({
    enrollment: { id: f.enrollmentId, clientId: f.clientId, clientName: f.name, status: "ACTIVE", videosPerMonth: 3, sessionsPerMonth: 1 },
    actor: { kind: "CLIENT", clientUserId: f.clientUserId!, email: "seat@example.test", name: f.name, membershipId: f.membershipId!, membershipRole: "OWNER" },
    access: "FULL", via: "LOGIN",
  } as unknown as Viewer);
  const { setSession } = await import("@/lib/auth/session");
  const asOwner = async () => {
    process.env.AUTH_ENFORCE = "true";
    await setSession({ uid: ownerUser.id, email: ownerUser.email, role: ownerUser.role, name: ownerUser.name ?? undefined, permissions: ownerUser.permissions } as Parameters<typeof setSession>[0]);
  };
  await writeRollout(pilotOf([P.clientId]));

  // =========================================================================
  c.head("1 · a seat media token follows the rollout (portalMedia.mediaScopeLive)");
  // =========================================================================
  {
    const media = await import("@/lib/portalMedia");
    const stream = await import("@/app/api/review/cut/[id]/stream/route");
    const { NextRequest } = await import("next/server");
    const cut = async (f: Fx) => prisma.reviewSubmission.create({ data: { projectId: f.projectId!, round: 1, fileName: `${f.name}.mp4`, status: "APPROVED", decidedAt: new Date(), source: "upload" } });
    const cutP = await cut(P), cutT = await cut(T);
    const seatP = { kind: "membership" as const, id: P.membershipId! };
    const seatT = { kind: "membership" as const, id: T.membershipId! };
    const tokP = media.mediaToken(cutP.id, seatP);
    const status = async () => {
      process.env.AUTH_ENFORCE = "true";
      try { return (await stream.GET(new NextRequest(`http://127.0.0.1/api/review/cut/${cutP.id}/stream?m=${encodeURIComponent(tokP)}`), { params: Promise.resolve({ id: cutP.id }) })).status; }
      finally { delete process.env.AUTH_ENFORCE; }
    };
    // The rule mediaScopeLive kept before the fix, restated: seat not revoked,
    // program not revoked, clientIds agree, person not disabled — no rollout.
    const oldRule = async (membershipId: string) => {
      const m = await prisma.clientMembership.findUniqueOrThrow({ where: { id: membershipId } });
      const e = await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: m.enrollmentId } });
      const u = await prisma.clientUser.findUniqueOrThrow({ where: { id: m.clientUserId } });
      return !m.revokedAt && !e.accessRevokedAt && e.clientId === m.clientId && u.status !== "DISABLED";
    };
    c.ok("P in the pilot: P's seat token is live and the stream door admits it (not 403)", (await media.mediaScopeLive(seatP, new Date())) && (await status()) !== 403);
    const upd = await pr.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, clientIds: [] } }), "info@realtourpilot.com", "program_pilot_remove");
    const liveAfter = await media.mediaScopeLive(seatP, new Date());
    const st = await status();
    c.ok("OLD rule (no rollout) still calls P's seat live after the removal — the six-hour leak", upd.ok && (await oldRule(P.membershipId!)));
    c.ok("NEW: P taken out → the same token is dead at once: mediaScopeLive false, the stream door 403", !liveAfter && st === 403, `${liveAfter} ${st}`);
    c.ok("…a TEST seat's token is untouched", await media.mediaScopeLive(seatT, new Date()) && !!cutT);
    await writeRollout(pilotOf([P.clientId], ALL_OPS, { expiresAt: new Date(PINNED - HOUR).toISOString() }));
    c.ok("NEW: the pilot's end date passing (no write at all) → dead too", !(await media.mediaScopeLive(seatP, new Date())) && (await status()) === 403);
    await writeRollout(pilotOf([P.clientId]));
    c.ok("P back in the pilot → live again", await media.mediaScopeLive(seatP, new Date()));
  }

  // =========================================================================
  c.head("2 · the caption assistant reaches only the clients the rollout reaches");
  // =========================================================================
  {
    const { AUTOMATION_EFFECTS } = await import("@/lib/programAutomationCopy");
    const cap = AUTOMATION_EFFECTS.caption_assistant;
    c.ok("labelled client-facing, read with the rollout (programScope), and NOT blocked on ai_runs (a click is attended)", cap.reaches === "clients" && cap.launchGate === "programScope" && !(cap.requires?.switches ?? []).includes("ai_runs"), JSON.stringify({ reaches: cap.reaches, gate: cap.launchGate, requires: cap.requires }));
    c.ok("caption_assistant is a reach op in 'Automatic portal changes'", core.isProgramReachOp("caption_assistant") && core.pilotGroupOf("caption_assistant")?.key === "portal_changes");

    const pk = await import("@/lib/postingKit");
    const cv = await import("@/lib/contentVideos");
    const ce = await import("@/lib/cutEntitlement");
    const { streamUrlFor } = await import("@/lib/reviewCuts");
    const program = async (name: string, realName: string | null) => {
      const f = await buildContentMonth(db, { name, package: "Starter", monthKey: "2026-09", project: { status: "SCHEDULED", shootDate: new Date(PINNED - 20 * DAY) }, owner: { email: `${name.split(" ")[0].toLowerCase()}@example.test`, name } });
      if (realName) await prisma.client.update({ where: { id: f.clientId }, data: { name: realName } });
      const s = await prisma.contentStrategy.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, sectionsJson: "{}" } });
      const sv = await prisma.contentStrategyVersion.create({ data: { strategyId: s.id, enrollmentId: f.enrollmentId, clientId: f.clientId, versionNo: 1, sectionsJson: "{}", sourceKind: "manual", status: "APPROVED", approvedAt: new Date(PINNED - DAY), releasedAt: new Date(PINNED - DAY) } });
      await prisma.contentStrategy.update({ where: { id: s.id }, data: { approvedVersionId: sv.id, currentVersionId: sv.id } });
      const sub = await prisma.reviewSubmission.create({ data: { projectId: f.projectId!, deliverableId: f.deliverableId!, slot: 1, round: 1, fileName: `${name.split(" ")[0]} v1.mp4`, status: "APPROVED", source: "upload", decidedBy: "James", decidedAt: new Date(PINNED - HOUR), completedAt: new Date(PINNED - HOUR), sizeBytes: 5 }, select: { id: true } });
      await prisma.reviewSubmission.update({ where: { id: sub.id }, data: { assetUrl: streamUrlFor(sub.id), blobUrl: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${sub.id}.mp4`, blobPathname: `review-cuts/${sub.id}.mp4` } });
      await cv.syncEnrollmentVideos({ id: f.enrollmentId, clientId: f.clientId });
      const video = await prisma.contentVideo.findFirstOrThrow({ where: { currentSubmissionId: sub.id } });
      await prisma.contentScript.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, monthId: f.monthId, videoId: video.id, title: "First weekend pricing", body: "Your first weekend decides your price.\nPrice it right and buyers compete.\nThat's the whole game.", status: "CLIENT_VISIBLE", releaseState: "released" } });
      const row = await prisma.reviewSubmission.findUniqueOrThrow({ where: { id: sub.id } });
      await prisma.clientDecision.create({ data: { submissionId: sub.id, projectId: f.projectId!, videoId: video.id, enrollmentId: f.enrollmentId, clientId: f.clientId, round: 1, contentHash: ce.stableCutIdentity(row), decision: "APPROVE", actorLabel: "client", clientUserId: f.clientUserId, membershipRole: "OWNER", receiptState: "DONE" } });
      const fx: Fx = { clientId: f.clientId, enrollmentId: f.enrollmentId, monthId: f.monthId, projectId: f.projectId, clientUserId: f.clientUserId, membershipId: f.membershipId, name: realName ?? name };
      return { fx, video, viewer: viewerOf(fx) };
    };
    const capT = await program("Cap Drill TEST", null);
    const capP = await program("Cam Pilot TEST", "Cam Pilot Realty");
    const capX = await program("Cole Excluded TEST", "Cole Excluded Homes");
    await writeRollout(pilotOf([P.clientId, capP.fx.clientId]));
    await setSwitch("caption_assistant", true);
    const { isAutomationEnabled } = await import("@/lib/programAutomation");
    c.ok("OLD gate (the switch alone) says yes for the EXCLUDED client too", await isAutomationEnabled("caption_assistant"));
    const kit = async (p: typeof capT) => (await pk.postingKitFor(p.viewer, p.video)).assistant.enabled;
    c.ok("NEW: the kit offers 'Draft a caption' to T and the pilot client, NOT to the excluded client", (await kit(capT)) && (await kit(capP)) && !(await kit(capX)));
    const m0 = modelCalls;
    const dx = await pk.draftCaptionForVideo(capX.viewer, capX.video.id);
    c.ok("NEW: a click on the excluded client's portal drafts nothing and calls no model", !dx.ok && /switched off/.test(dx.message) && modelCalls === m0, dx.message);
    const dp = await pk.draftCaptionForVideo(capP.viewer, capP.video.id);
    c.ok("NEW: the pilot client's click drafts (one model call)", dp.ok && modelCalls === m0 + 1, dp.message);
    await writeRollout(pilotOf([P.clientId, capP.fx.clientId], core.opsForGroups(["accounts", "emails", "bookings"])));
    const dpNo = await pk.draftCaptionForVideo(capP.viewer, capP.video.id);
    c.ok("NEW: a pilot WITHOUT 'Automatic portal changes' → the pilot client gets no drafter either", !dpNo.ok && !(await kit(capP)) && modelCalls === m0 + 1, dpNo.message);
    await writeRollout(pilotOf([P.clientId, capP.fx.clientId]));
    const { readinessReport } = await import("@/lib/readiness");
    const row = (await readinessReport({ now: NOW })).rows.find((r) => r.key === "caption_assistant")!;
    c.ok("readiness lists it as a client-reaching program switch, naming the pilot", row.launchGated && row.realClients && /pilot: .*Cam Pilot Realty/.test(row.scope ?? ""), row.scope ?? "");
    await setSwitch("caption_assistant", false);
    await writeRollout(pilotOf([P.clientId]));
  }

  // =========================================================================
  c.head("3 · a failed LOCK read at dispatch is gate_error — the reminder retries");
  // =========================================================================
  {
    const R = await import("@/lib/programReminders");
    await setSwitch("reminders", true, { testClientsOnly: false });
    const reminder = async (tag: string) => prisma.programReminder.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, monthId: P.monthId, monthKey: "2026-10", action: "COMPLETE_ANSWERS", templateKey: "drill", channel: "email", attempt: 1, state: "QUEUED", toRef: "pat@example.test", dedupeKey: `${P.enrollmentId}:2026-10:COMPLETE_ANSWERS:${tag}` } });
    const rid = (await reminder("lock-blip")).id;
    const i = mails.length;
    faults.lockRead = true;
    const r = await outbox.sendThroughOutbox({ channel: "email", toRef: "pat@example.test", body: "a reminder", dedupeKey: outbox.programReminderKey("COMPLETE_ANSWERS", rid, "2026-10"), clientId: P.clientId, requestedBy: "reminders-cron" });
    faults.lockRead = false;
    c.ok("NEW: the lock cannot be read → refused gate_error ('could not decide'), nothing sent", r.outcome === "failed" && r.refused === "gate_error" && mailsSince(i).length === 0, JSON.stringify(r));
    await R.recordSendResult(rid, r, NOW);
    const after = await prisma.programReminder.findUniqueOrThrow({ where: { id: rid } });
    c.ok("NEW: the reminder is FAILED with a retry time — not SUPPRESSED launch_not_authorised for good", after.state === "FAILED" && !!after.nextAttemptAt && after.suppressionReason === null, `${after.state} ${after.suppressionReason} ${after.nextAttemptAt?.toISOString()}`);
    // The reconcile pass: a queued reminder (its outbox row pending) is not
    // cancelled on a lock it could not read.
    const q = await reminder("lock-blip-queued");
    const qo = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "pat@example.test", body: "queued reminder", dedupeKey: outbox.programReminderKey("COMPLETE_ANSWERS", q.id, "2026-10"), clientId: P.clientId, state: "pending", requestedBy: "reminders-cron", createdAt: new Date(PINNED - 20 * 60_000) } });
    await prisma.programReminder.update({ where: { id: q.id }, data: { outboxMessageId: qo.id } });
    faults.lockRead = true;
    await R.reconcileReminderOutcomes({ now: NOW }).catch(() => null);
    faults.lockRead = false;
    const qa = await prisma.programReminder.findUniqueOrThrow({ where: { id: q.id } });
    const qoa = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: qo.id } });
    c.ok("NEW: reconcile cancels nothing on a lock it could not read (the reminder is not CANCELLED, its outbox row not failed)", qa.state !== "CANCELLED" && qa.suppressionReason === null && qoa.state === "pending", `${qa.state} ${qa.suppressionReason} outbox=${qoa.state}`);
    await prisma.outboxMessage.update({ where: { id: qo.id }, data: { state: "failed", dedupeKey: null } });
    await prisma.programReminder.updateMany({ where: { id: { in: [rid, q.id] } }, data: { state: "CANCELLED" } });
    await setSwitch("reminders", false, null);
  }

  // =========================================================================
  c.head("4 · 'What would go out now?' marks send exactly what dispatch sends");
  // =========================================================================
  {
    const R = await import("@/lib/programReminders");
    const { previewProgramAudience } = await import("@/lib/programAudiencePreview");
    const sendRows = async (lanes: string[]) => (await previewProgramAudience({ now: NOW })).filter((r) => lanes.includes(r.lane) && r.decision === "send");
    const REM = ["PLANNING", "REVIEW", "ADDRESS", "APPROVE_SCRIPTS"];

    // (a) reminders OFF: the dry run evaluates on the default policy anyway.
    await setSwitch("reminders", false, { testClientsOnly: false });
    const dryOff = await R.evaluateReminders({ dryRun: true, now: NOW });
    c.ok("(a) with reminders OFF the reminder dry run itself still says send for T (it evaluates on defaults)", !dryOff.enabled && dryOff.candidates.some((x) => x.clientId === T.clientId && x.decision === "send"));
    c.ok("(a) NEW: …but the preview marks NO reminder row 'send' while the switch is off", (await sendRows(REM)).length === 0, (await sendRows(REM)).map((x) => `${x.clientName}:${x.lane}`).join(","));
    await setSwitch("reminders", true, { testClientsOnly: false });
    const dryPairs = (await sendRows(REM)).map((x) => `${x.clientId}|${x.to}`).sort();
    await R.evaluateReminders({ dryRun: false, now: NOW });
    const acc = await prisma.outboxMessage.findMany({ where: { dedupeKey: { startsWith: "program_reminder:" }, state: "accepted" }, select: { clientId: true, toRef: true } });
    const livePairs = acc.map((x) => `${x.clientId}|${outbox.maskToRef("email", x.toRef)}`).sort();
    c.ok("(a) with reminders ON: preview 'send' = what the live run sent (client, masked to)", dryPairs.length > 0 && JSON.stringify(dryPairs) === JSON.stringify(livePairs), `${dryPairs.join(" ")} vs ${livePairs.join(" ")}`);
    await setSwitch("reminders", false, null);

    // (b) automatic sharing: an eligible TEST draft.
    const s = await prisma.contentStrategy.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, sectionsJson: "{}" } });
    const sv = await prisma.contentStrategyVersion.create({ data: { strategyId: s.id, enrollmentId: T.enrollmentId, clientId: T.clientId, versionNo: 1, sectionsJson: "{}", sourceKind: "manual", status: "APPROVED", approvedAt: new Date(PINNED - DAY), releasedAt: new Date(PINNED - DAY) } });
    await prisma.contentStrategy.update({ where: { id: s.id }, data: { approvedVersionId: sv.id, currentVersionId: sv.id } });
    const topic = await prisma.contentTopic.findFirstOrThrow({ where: { enrollmentId: T.enrollmentId, monthId: T.monthId } });
    const script = await prisma.contentScript.create({ data: { enrollmentId: T.enrollmentId, clientId: T.clientId, title: "Why list in the fall", body: "b", topicId: topic.id, monthId: T.monthId } });
    const points = JSON.stringify([{ role: "RE_HOOK", text: "Buyers decide in two days." }, { role: "BUILD_UP", text: "Price it right and they compete." }, { role: "PAYOFF", text: "That's how you win the weekend." }]);
    const v = await prisma.contentScriptVersion.create({ data: { scriptId: script.id, enrollmentId: T.enrollmentId, clientId: T.clientId, versionNo: 1, title: "Why list in the fall", hook: "Fall buyers are serious buyers.", pointsJson: points, close: "Call me before you list.", body: "Fall buyers are serious buyers.", source: "AI", createdBy: "cron", aiRunId: "drill-run", validationJson: JSON.stringify({ findings: [] }), strategyVersionId: sv.id, status: "DRAFT", createdAt: new Date(PINNED - 3 * HOUR) } });
    await prisma.contentScript.update({ where: { id: script.id }, data: { currentVersionId: v.id } });
    const { autoShareEligible, sweepAutoShare } = await import("@/lib/scriptAutoShare");
    c.ok("(b) the TEST draft is eligible for automatic sharing", (await autoShareEligible(v.id, { now: NOW })).ok, (await autoShareEligible(v.id, { now: NOW })).reasons.join("; "));
    const autoRows = async () => (await previewProgramAudience({ now: NOW })).filter((r) => r.lane === "AUTO_SHARE" && r.clientId === T.clientId);
    const off = await autoRows();
    c.ok("(b) NEW: switch OFF → 'no', saying it is eligible but the switch is off", off.length === 1 && off[0].decision === "no" && /switch is off/.test(off[0].detail), JSON.stringify(off.map((x) => [x.decision, x.detail])));
    await setSwitch("script_auto_share", true);
    const on = await autoRows();
    c.ok("(b) NEW: switch ON → the eligible draft is 'send' (it read 'no' because the dry run never set shared)", on.length === 1 && on[0].decision === "send", JSON.stringify(on.map((x) => [x.decision, x.reason])));
    const live = await sweepAutoShare({ now: NOW });
    const shared = "outcomes" in live ? live.outcomes.filter((o) => o.shared).map((o) => o.title) : [];
    c.ok("(b) the live run shares exactly that draft (preview send set = live shared set)", JSON.stringify(shared) === JSON.stringify(["Why list in the fall"]) && on.every((x) => x.reason.includes("Why list in the fall")), JSON.stringify(live));
    await setSwitch("script_auto_share", false);

    // (c) the office replied: T (verified inbox), T2 (a colleague's inbox), P.
    await setSwitch("program_message_notice", true);
    for (const f of [T, T2, P]) {
      await prisma.programMessage.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, authorKind: "STAFF", authorLabel: "Kyle Drill", body: "We moved your shoot.", createdAt: new Date(PINNED - HOUR) } });
    }
    const pm = await import("@/lib/programMessages");
    const dry = await pm.sweepProgramMessageNotices({ now: NOW, dryRun: true });
    const t2Dry = dry.preview.filter((x) => x.clientId === T2.clientId);
    c.ok("(c) NEW: the dry run SKIPS T2's seat on nick@ (test_client_real_address) — it said send", t2Dry.length === 1 && t2Dry[0].decision === "skip" && /test_client_real_address/.test(t2Dry[0].reason), JSON.stringify(t2Dry.map((x) => [x.decision, x.reason])));
    const drySend = dry.preview.filter((x) => x.decision === "send").map((x) => x.to).sort();
    const i = mails.length;
    const liveMsg = await pm.sweepProgramMessageNotices({ now: NOW });
    const liveTo = mailsSince(i).map((x) => outbox.maskToRef("email", x)).sort();
    c.ok("(c) NEW: the live run skips it too — nothing refused, nothing thrown on the floor", liveMsg.refused === 0 && !mailsSince(i).includes("nick@realtourpilot.com"), JSON.stringify({ refused: liveMsg.refused, notes: liveMsg.notes }));
    c.ok("(c) dry 'send' = the live emails (T's and P's seats)", drySend.length === 2 && JSON.stringify(drySend) === JSON.stringify(liveTo), `${drySend.join(",")} vs ${liveTo.join(",")}`);
    const line = (await pr.programAudience("program_message_notice", { now: NOW })).line;
    c.ok("(d) NEW: the readiness line marks T2 'no verified inbox, not emailed' and leaves T plain", line.includes("Second Rollout TEST — no verified inbox, not emailed") && /[(,] ?Rollout TEST[,)]/.test(line), line);
    await setSwitch("portal_login_email", true);
    const pa = await import("@/lib/portalAccess");
    c.ok("(e) NEW: email sign-in is offered to T and P, not to T2 (no verified inbox) or X",
      (await pa.portalLoginEmailEnabledFor(T.clientId)) && (await pa.portalLoginEmailEnabledFor(P.clientId)) && !(await pa.portalLoginEmailEnabledFor(T2.clientId)) && !(await pa.portalLoginEmailEnabledFor(X.clientId)));
    await setSwitch("program_message_notice", false);
    await setSwitch("portal_login_email", false);
  }

  // =========================================================================
  c.head("5 · a queued Instagram job re-checks the rollout when it runs");
  // =========================================================================
  {
    const pub = await import("@/lib/publishing");
    const { encryptSecret } = await import("@/lib/integrations/crypto");
    await setSwitch("publishing", true);
    const acct = await prisma.programPublishingAccount.create({ data: { enrollmentId: P.enrollmentId, clientId: P.clientId, provider: "INSTAGRAM", providerAccountId: "ig-drill-p", credentialEncrypted: encryptSecret(JSON.stringify({ accessToken: ["drill", "ig", "token"].join("-") })), status: "CONNECTED" } });
    const cut = await prisma.reviewSubmission.create({ data: { projectId: P.projectId!, round: 1, fileName: "p-reel.mp4", status: "APPROVED", decidedAt: new Date(PINNED - HOUR), source: "upload", sizeBytes: 5_000_000 } });
    await prisma.reviewSubmission.update({ where: { id: cut.id }, data: { blobUrl: `https://drillstore.public.blob.vercel-storage.com/review-cuts/${cut.id}.mp4`, blobPathname: `review-cuts/${cut.id}.mp4` } });
    const caption = await prisma.contentCaptionDraft.create({ data: { videoId: "drill-video-p", submissionId: cut.id, enrollmentId: P.enrollmentId, clientId: P.clientId, kind: "CAPTION", body: "Your first weekend decides your price.", authorKind: "STAFF", status: "DRAFT" } });
    const create = () => pub.createPublishingJob({ submissionId: cut.id, captionDraftId: caption.id, accountId: acct.id, approvedBy: { staffUserId: ownerUser.id } });
    await writeRollout({ mode: "ALL", modeSince: new Date(PINNED - DAY).toISOString(), pilot: pilotOf([P.clientId]).pilot });
    const job = await create();
    c.ok("created while the rollout reached everyone", job.ok, JSON.stringify(job));
    await writeRollout(pilotOf([P.clientId])); // publishing is never a pilot op
    const calls0 = igCalls.length;
    await pub.runPublishingDriver({ leaseBy: "drill" });
    const j1 = await prisma.programPublishingJob.findFirstOrThrow({ where: { accountId: acct.id } });
    c.ok("NEW: set back to a pilot → the queued job is CANCELLED 'not_in_rollout_scope' before ANY Instagram call", j1.state === "CANCELLED" && j1.invalidatedReason === "not_in_rollout_scope" && igCalls.length === calls0, `${j1.state} ${j1.invalidatedReason} ${j1.lastError} calls=${igCalls.slice(calls0).join(",")}`);
    await writeRollout({ mode: "ALL", modeSince: new Date(PINNED - DAY).toISOString(), pilot: pilotOf([P.clientId]).pilot });
    await create(); // a renewed approval re-opens the same row
    await prisma.programPublishingJob.update({ where: { id: j1.id }, data: { nextAttemptAt: new Date(PINNED - 60_000) } });
    faults.clientFindUnique = true;
    await pub.runPublishingDriver({ leaseBy: "drill" });
    faults.clientFindUnique = false;
    const j2 = await prisma.programPublishingJob.findUniqueOrThrow({ where: { id: j1.id } });
    c.ok("NEW: the rollout cannot be read → retried later, never cancelled, no Instagram call", j2.state !== "CANCELLED" && !!j2.nextAttemptAt && j2.nextAttemptAt.getTime() > PINNED && igCalls.length === calls0, `${j2.state} ${j2.lastError}`);
    await prisma.programPublishingJob.update({ where: { id: j1.id }, data: { nextAttemptAt: new Date(PINNED - 60_000) } });
    await pub.runPublishingDriver({ leaseBy: "drill" });
    const j3 = await prisma.programPublishingJob.findUniqueOrThrow({ where: { id: j1.id } });
    c.ok("…and while the rollout reaches the client, the job goes past the check", j3.state !== "CANCELLED" && j3.invalidatedReason !== "not_in_rollout_scope", `${j3.state} ${j3.lastError}`);
    await setSwitch("publishing", false);
    await writeRollout(pilotOf([P.clientId]));
  }

  // =========================================================================
  c.head("6 · an excluded client's Team page says what will happen");
  // =========================================================================
  {
    const team = await import("@/lib/portalTeam");
    await setSwitch("portal_invites", true);
    await setSwitch("portal_login_email", true);
    const tx = await team.teamSeats(viewerOf(X));
    const tp = await team.teamSeats(viewerOf(P));
    c.ok("NEW: invitations are OFF for the excluded client (switch on, rollout out), ON for the pilot client", tx.ok && !tx.invitationsOn && tp.ok && tp.invitationsOn, `${tx.invitationsOn} ${tp.invitationsOn}`);
    c.ok("NEW: email sign-in likewise per client", !tx.signInEmailOn && tp.signInEmailOn);
    const inv = await team.inviteTeammate(viewerOf(X), { name: "Xavier Helper", email: "xhelper@example.test" });
    c.ok("NEW: the held reply no longer promises 'the moment we switch invitations on' (it is on)", inv.ok && inv.held === true && !/switch invitations on/.test(inv.message) && /as soon as your account is set up/.test(inv.message), inv.message);
    c.ok("…and nothing went to them", (await prisma.outboxMessage.count({ where: { toRef: "xhelper@example.test" } })) === 0);
    await setSwitch("portal_invites", false);
    await setSwitch("portal_login_email", false);
  }

  // =========================================================================
  c.head("7 · the address travel check follows the program pilot");
  // =========================================================================
  {
    const sa = (await import("@/lib/sessionAddress")) as typeof import("@/lib/sessionAddress");
    const F = await buildContentMonth(db, { name: "Fixture Address TEST", project: false, owner: false });
    await setSwitch("address_sync", true, { authorizedFixtureClientIds: [F.clientId] });
    const oldAnswer = (id: string) => [F.clientId].includes(id);
    c.ok("OLD (the fixture list alone): P — whose address the hub now writes to Aryeo — was 'not asked'", !oldAnswer(P.clientId));
    c.ok("NEW: P (program pilot, bookings) → Aryeo is asked; X no; the TEST fixture still yes", (await sa.aryeoWillBeAsked(P.clientId)) && !(await sa.aryeoWillBeAsked(X.clientId)) && (await sa.aryeoWillBeAsked(F.clientId)));
    await writeRollout(pilotOf([P.clientId], core.opsForGroups(["accounts", "emails", "portal_changes"])));
    c.ok("NEW: bookings not ticked → P not asked (the write guard refuses it too)", !(await sa.aryeoWillBeAsked(P.clientId)));
    await writeRollout(pilotOf([P.clientId]));
    await setSwitch("address_sync", false, { authorizedFixtureClientIds: [F.clientId] });
    c.ok("switch off → nobody", !(await sa.aryeoWillBeAsked(P.clientId)) && !(await sa.aryeoWillBeAsked(F.clientId)));
  }

  // =========================================================================
  c.head("8 · 'since' survives PILOT → ALL and a widening");
  // =========================================================================
  {
    const rw = await import("@/lib/reviewWindows");
    await setSwitch("revision_policy", true, null, new Date(PINNED - 10 * DAY));
    await writeRollout(pilotOf([P.clientId]));
    c.ok("in the pilot: P's review deadlines run from its join", (await rw.revisionPolicyFor(P.clientId, NOW)).enabledAt?.getTime() === T0.getTime());
    const toAll = await pr.updateProgramRollout((cur) => ({ ...cur, mode: "ALL" }), "info@realtourpilot.com", "program_rollout_mode");
    const pAll = await rw.revisionPolicyFor(P.clientId, NOW);
    const xAll = await rw.revisionPolicyFor(X.clientId, NOW);
    const nowish = (d: Date | null | undefined) => !!d && Math.abs(d.getTime() - Date.now()) < 5 * 60_000; // the writer stamps its own clock
    c.ok("NEW: after PILOT → ALL, P keeps its join (windows it was already shown stay enforced); X starts now", toAll.ok && pAll.enabledAt?.getTime() === T0.getTime() && nowish(xAll.enabledAt), `P ${pAll.enabledAt?.toISOString()} X ${xAll.enabledAt?.toISOString()}`);
    await writeRollout(pilotOf([P.clientId], core.opsForGroups(["emails"]), { groupSince: { emails: T0.toISOString() } }));
    const widen = await pr.updateProgramRollout((cur) => ({ ...cur, pilot: { ...cur.pilot!, operations: ALL_OPS } }), "info@realtourpilot.com", "program_pilot_edit");
    const rem = await pr.programReach("reminders", P.clientId, { now: NOW });
    const rev = await pr.programReach("revision_policy", P.clientId, { now: NOW });
    c.ok("NEW: widening keeps reminders' since at the join; the newly ticked review deadlines start now", widen.ok && rem.ok && rem.since?.getTime() === T0.getTime() && rev.ok && nowish(rev.since), `${rem.ok ? rem.since?.toISOString() : rem.code} / ${rev.ok ? rev.since?.toISOString() : rev.code}`);
    await setSwitch("revision_policy", false);
    await writeRollout(pilotOf([P.clientId]));
  }

  // =========================================================================
  c.head("9 · the owner's rollout messages say what actually changes");
  // =========================================================================
  {
    const ra = await import("@/app/settings/rolloutActions");
    await asOwner();
    // Taking P out, by mode.
    await writeRollout({ mode: "ALL", modeSince: new Date(PINNED - DAY).toISOString(), pilot: pilotOf([P.clientId]).pilot });
    const rmAll = await ra.removeProgramPilotClientAction({ clientId: P.clientId });
    c.ok("NEW: out of the pilot in 'every client' → they STILL get every feature; only the bookings stop", rmAll.ok && /still get every program feature/.test(rmAll.message) && /stops booking/.test(rmAll.message) && !/Nothing further goes out/.test(rmAll.message), rmAll.message);
    await writeRollout({ ...pilotOf([P.clientId]), mode: "TEST_ONLY" });
    const rmTest = await ra.removeProgramPilotClientAction({ clientId: P.clientId });
    c.ok("NEW: out of the pilot in TEST only → 'Nothing changes for them now'", rmTest.ok && /Nothing changes for them now/.test(rmTest.message) && !/Nothing further goes out/.test(rmTest.message), rmTest.message);
    await writeRollout(pilotOf([P.clientId]));
    const rmPilot = await ra.removeProgramPilotClientAction({ clientId: P.clientId });
    c.ok("in a pilot: today's sentence (nothing further goes out)", rmPilot.ok && /Nothing further goes out/.test(rmPilot.message), rmPilot.message);
    await writeRollout({ mode: "ALL", modeSince: new Date(PINNED - DAY).toISOString(), pilot: pilotOf([P.clientId]).pilot });
    const endAll = await ra.endProgramPilotAction();
    c.ok("NEW: ending the pilot in 'every client' → every feature still reaches every client", endAll.ok && /still reaches every client/.test(endAll.message), endAll.message);
    await writeRollout({ ...pilotOf([P.clientId]), mode: "TEST_ONLY" });
    const endTest = await ra.endProgramPilotAction();
    c.ok("NEW: ending the pilot in TEST only → 'Nothing changes now'", endTest.ok && /Nothing changes now/.test(endTest.message), endTest.message);

    // "Every client": locked switches are named as locked, and each says when.
    await writeRollout(pilotOf([P.clientId]));
    await setSwitch("reminders", true, null); // no stored policy → its lock reads ON
    // Oct 6 2026: the portal-layout switch is retired (one layout); the
    // caption assistant stands in as the unlocked switch that reaches everyone.
    await setSwitch("caption_assistant", true);
    const all = await ra.setProgramRolloutModeAction({ mode: "ALL", typedConfirm: "EVERY CLIENT" });
    const reaching = /Switched on now, and reaching every client with a program: ([^]*?)\.( Still|$)/.exec(all.message)?.[1] ?? "";
    const locked = /Still TEST clients only because[^:]*: ([^]*?)\.$/.exec(all.message)?.[1] ?? "";
    c.ok("NEW: 'every client' lists the caption assistant as reaching everyone (when they press it) and reminders as STILL TEST-only (its lock)",
      all.ok && /Caption assistant/.test(reaching) && /when they press Draft a caption/.test(reaching) && !/Client reminders/.test(reaching) && /Client reminders/.test(locked), all.message);
    c.ok("NEW: the panel's 'every client' words mention the feature locks", fs.readFileSync(path.join(REPO, "src/components/settings/ProgramRolloutPanel.tsx"), "utf8").includes("unless a feature's own lock holds it to TEST clients"));
    await setSwitch("reminders", false, null);
    await setSwitch("caption_assistant", false);

    // The per-client list: per group, not through one op.
    await writeRollout(pilotOf([P.clientId], core.opsForGroups(["emails"])));
    const panel = await ra.loadProgramRolloutPanel();
    const chip = "audience" in panel ? panel.audience.find((a) => a.clientId === P.clientId) : undefined;
    c.ok("NEW: an emails-only pilot client reads 'in the pilot — program emails' (it read 'not reached for this')", chip?.tier === "PILOT" && chip.groups?.join() === "program emails" && chip.code === null, JSON.stringify(chip));
    const { readinessReport } = await import("@/lib/readiness");
    const scopeP = (await readinessReport({ now: NOW })).programScope.clients.find((x) => x.name === P.name);
    c.ok("NEW: the readiness header says the same", scopeP?.tier === "PILOT" && scopeP.groups?.join() === "program emails", JSON.stringify(scopeP));

    // The end date Jordan chose, everywhere.
    await writeRollout({ mode: "PILOT", modeSince: new Date(PINNED - DAY).toISOString(), pilot: null });
    const add = await ra.addProgramPilotClientAction({ clientId: P.clientId, typedName: P.name, groups: core.PROGRAM_PILOT_GROUPS.map((g) => g.key), expiresOnET: "2026-10-18" });
    const stored = core.parseProgramRollout((await prisma.appSetting.findUniqueOrThrow({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } })).value).rollout;
    const remLine = (await pr.programAudience("portal_invites", { now: NOW })).line; // an op with no feature lock
    const sbScope = (await readinessReport({ now: NOW })).rows.find((r) => r.key === "session_booking")?.scope ?? "";
    c.ok("(the owner chose Oct 18; the stored end is the next ET midnight)", add.ok && stored.pilot?.expiresAt === "2026-10-19T04:00:00.000Z", `${add.message} ${stored.pilot?.expiresAt}`);
    c.ok("NEW: the scope line and the hub-write row say 'through Oct 18', never Oct 19", remLine.includes("through Oct 18") && sbScope.includes("through Oct 18") && !/Oct 19|2026-10-19/.test(remLine + sbScope), `${remLine} || ${sbScope}`);
    delete process.env.AUTH_ENFORCE;
    await writeRollout(pilotOf([P.clientId]));
  }

  // =========================================================================
  c.head("10 · the call processor: draining, Re-run and the first switch-on");
  // =========================================================================
  {
    const tj = await import("@/lib/transcriptJobs");
    const { readinessReport } = await import("@/lib/readiness");
    const { rerunTranscriptJob, setTranscriptBacklogAction } = await import("@/app/settings/calendlyActions");
    await setSwitch("ai_runs", true);
    await setSwitch("transcript_jobs", true, {}, new Date(PINNED - 10 * DAY));
    await setSwitch("strategy_generation", false);
    const call = async (f: Fx) => (await prisma.programCallRecord.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, callType: "BRAND_DISCOVERY", status: "COMPLETED", matchState: "MATCHED", scheduledStart: new Date(PINNED - 3 * DAY) }, select: { id: true } })).id;
    let k = 0;
    const job = async (callRecordId: string, kind: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
      prisma.programTranscriptJob.create({ data: { callRecordId, kind, dedupeKey: `${callRecordId}:${kind}:drill-${++k}`, createdAt, requestedBy: "drill", ...extra } });
    const tjRow = async () => (await readinessReport({ now: NOW })).rows.find((r) => r.key === "transcript_jobs")!;

    // (a) a hold that lifts.
    const cT = await call(T);
    const draft = await job(cT, "STRATEGY_DRAFT", new Date(PINNED - 2 * DAY));
    await tj.driveTranscriptJobs({ now: NOW, leaseBy: "drill" });
    c.ok("(the draft waits: strategy_generation is off)", (await prisma.programTranscriptJob.findUniqueOrThrow({ where: { id: draft.id } })).lastError === "waiting: strategy_generation is off");
    await setSwitch("strategy_generation", true);
    const b1 = await tj.transcriptQueueBatch(NOW);
    const r1 = await tjRow();
    c.ok("NEW: its switch on, no tick yet → runnable since NOW, not two days ago; readiness is NOT 'queue not draining'",
      b1.runnableNow >= 1 && b1.oldestRunnableSince?.getTime() === PINNED && !/queue not draining/.test(r1.healthy.detail), `${b1.oldestRunnableSince?.toISOString()} · ${r1.healthy.detail}`);
    await prisma.programTranscriptJob.update({ where: { id: draft.id }, data: { state: "CANCELLED" } });
    await setSwitch("strategy_generation", false);

    // (b) a long drain: a full tick passes the rest over, legitimately.
    const cT2 = await call(T);
    const ingest = [];
    for (let n = 0; n < 8; n++) ingest.push(await job(cT2, "INGEST", new Date(PINNED - 5 * HOUR), { transcriptSourceId: `drill-src-${n}` }));
    const tick = await tj.driveTranscriptJobs({ now: NOW, max: 5, leaseBy: "drill" });
    const b2 = await tj.transcriptQueueBatch(NOW);
    const r2 = await tjRow();
    c.ok("(a full tick took 5 of the 8 five-hour-old jobs)", "ran" in tick && tick.ran === 5 && b2.runnableNow === 3, JSON.stringify(tick));
    c.ok("NEW: the 3 it passed over are 'waiting their turn', not neglected — no 'queue not draining' (5 h > 2 h + 1 tick)", b2.oldestRunnableSince?.getTime() === PINNED && !/queue not draining/.test(r2.healthy.detail), `${b2.oldestRunnableSince?.toISOString()} · ${r2.healthy.detail}`);
    await job(cT2, "INGEST", new Date(PINNED - 5 * HOUR), { transcriptSourceId: "drill-src-late" });
    const r3 = await tjRow();
    c.ok("…and a runnable job NO tick has seen for 5 h still reads 'queue not draining' (the alarm works)", /queue not draining/.test(r3.healthy.detail), r3.healthy.detail);
    await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });

    // (c) Re-run says when a job will wait.
    await asOwner();
    const cX = await call(X);
    const failedX = await job(cX, "ANALYZE", new Date(PINNED - DAY), { state: "FAILED", attempts: 3, enrollmentId: X.enrollmentId });
    const rx = await rerunTranscriptJob(failedX.id);
    c.ok("NEW: Re-run on the excluded client's job → 'Re-queued, but it waits: … outside the rollout (add the client to the pilot…)'", rx.ok && /waits/.test(rx.message) && /outside the rollout/.test(rx.message) && !/runs on the next hourly run/.test(rx.message), rx.message);
    const failedT = await job(cT, "ANALYZE", new Date(PINNED - DAY), { state: "FAILED", attempts: 3, enrollmentId: T.enrollmentId });
    const rt = await rerunTranscriptJob(failedT.id);
    c.ok("…a job nothing holds is promised the next hourly run", rt.ok && /It runs on the next hourly run/.test(rt.message), rt.message);
    const failedD = await job(cT, "STRATEGY_DRAFT", new Date(PINNED - DAY), { state: "FAILED", attempts: 3, enrollmentId: T.enrollmentId });
    const rd = await rerunTranscriptJob(failedD.id);
    c.ok("NEW: a STRATEGY_DRAFT while strategy_generation is off → it waits, and says so", rd.ok && /waits: strategy_generation is off/.test(rd.message), rd.message);
    await prisma.programTranscriptJob.updateMany({ where: { state: "QUEUED" }, data: { state: "CANCELLED" } });

    // (d) "skip" restores the FIRST switch-on.
    const E1 = new Date(PINNED - 10 * DAY), E2 = new Date(PINNED - DAY);
    await setSwitch("transcript_jobs", true, {}, E1);
    await tj.driveTranscriptJobs({ now: NOW, leaseBy: "drill" });
    const cfgOf = async () => JSON.parse((await prisma.programAutomation.findUniqueOrThrow({ where: { key: "transcript_jobs" } })).configJson ?? "{}") as Record<string, unknown>;
    const c1 = await cfgOf();
    c.ok("(the first run pinned the cutoff AND recorded the first switch-on, both E1)", c1.onlyQueuedAfter === E1.toISOString() && c1.firstSwitchedOnAt === E1.toISOString(), JSON.stringify(c1));
    await setTranscriptBacklogAction("include");
    await prisma.programAutomation.update({ where: { key: "transcript_jobs" }, data: { enabled: false } });
    await prisma.programAutomation.update({ where: { key: "transcript_jobs" }, data: { enabled: true, enabledAt: E2 } }); // switched off and on again
    const between = await job(cT, "INGEST", new Date(PINNED - 3 * DAY), { transcriptSourceId: "drill-between" }); // after E1, before E2
    const skip = await setTranscriptBacklogAction("skip");
    const c2 = await cfgOf();
    const b4 = await tj.transcriptQueueBatch(NOW);
    c.ok("NEW: 'skip' restores the cutoff to the FIRST switch-on (E1), not the latest (E2)", skip.ok && c2.onlyQueuedAfter === E1.toISOString() && b4.backlog.cutoff?.getTime() === E1.getTime(), `${JSON.stringify(c2)} · ${skip.message}`);
    c.ok("NEW: …so a job queued between the two switch-ons is NOT skipped as backlog", b4.heldBacklog === 0 && b4.runnableNow >= 1, b4.line);
    await prisma.programTranscriptJob.update({ where: { id: between.id }, data: { state: "CANCELLED" } });
    delete process.env.AUTH_ENFORCE;
    for (const key of ["ai_runs", "transcript_jobs"]) await setSwitch(key, false);
  }

  // =========================================================================
  c.head("11 · the readiness banner's 'who' comes from its openers");
  // =========================================================================
  {
    const { readinessReport } = await import("@/lib/readiness");
    await saveSecret("aryeo", ["drill", "aryeo", "key"].join("-"));
    await writeRollout({ mode: "ALL", modeSince: new Date(PINNED - DAY).toISOString(), pilot: pilotOf([P.clientId]).pilot });
    await setSwitch("session_booking", true, { authorizedFixtureClientIds: [] });
    await setSwitch("reminders", true, null); // lock on: TEST only
    const rep = await readinessReport({ now: NOW });
    c.ok("mode ALL, but the only opener is the pilot's bookings (reminders held by its lock)", !rep.rolloutClosed.ok && rep.rolloutClosed.openers.every((o) => /pilot: Pat Pilot Realty/.test(o)), rep.rolloutClosed.openers.join(" | "));
    c.ok("NEW: the banner says 'OPEN for the pilot: Pat Pilot Realty', not 'for every client with a program'", rep.rolloutClosed.openFor === "the pilot: Pat Pilot Realty", String(rep.rolloutClosed.openFor));
    await setSwitch("reminders", true, { testClientsOnly: false });
    const rep2 = await readinessReport({ now: NOW });
    c.ok("…with the reminders lock lifted in ALL → 'every client with a program'", rep2.rolloutClosed.openFor === "every client with a program", `${rep2.rolloutClosed.openFor} · ${rep2.rolloutClosed.openers.join(" | ")}`);
    for (const key of ["session_booking", "reminders"]) await setSwitch(key, false, null);
    await writeRollout(pilotOf([P.clientId]));
  }

  c.ok("nothing left this process but the fakes", fence.blocked.length === 0, fence.blocked.join(" "));
  console.log(`\n${await drill.evidence()} · Gmail sends faked: ${mails.length} · model calls stubbed: ${modelCalls} · Instagram calls stubbed: ${igCalls.length}`);
  c.summary();
  quiet.restore();
  fence.restore();
  await drill.stop();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
