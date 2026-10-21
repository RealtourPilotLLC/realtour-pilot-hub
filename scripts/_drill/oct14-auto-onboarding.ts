// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: "automate this and turn everything on" (Oct 14 2026).
//
// Jordan, Oct 13: "Can you just automate this and turn everything on when you
// are done? I want a sign-up email to go out and for everything to be
// activated. ... Lehigh Valley should not be confidential. Nothing in the
// content strategy should be confidential. The only thing that should be
// confidential is if they say so on the strategy call."
//
//   1. The strategy release is no longer refused by a confidential FACT
//      ("Lehigh Valley."); the working-notes and [CONFIDENTIAL] marker
//      refusals stay.
//   2. Approving a version releases it (and a refused release leaves the
//      approval standing, saying why).
//   3. confidentialFilter: a piece under six words never matches by overlap.
//   4. autoOnboardClient: everything done once; a second run sends no second
//      welcome and opens no second seat; never "Share scripts without my
//      approval"; one welcome whichever road (the payment grant's, the
//      panel's, the automatic one).
//   5. PAUSED and TEST clients are skipped (TEST runs with allowTest, at the
//      verified test inbox only).
//   6. The activation hook runs it with the auto_onboarding switch on, and
//      not with it off (maybeAutoOnboard, setEnrollmentStatus).
//   7. The un-mark script's test keeps explicit requests.
//   8. turn-everything-on's plan: everyone ACTIVE named, never auto-share.
//
// ISOLATION: PGlite on 127.0.0.1:6687 (DRILL_PORT overrides). Gmail is
// answered in-process at the HTTP fence; every other outbound call is blocked.
// ---------------------------------------------------------------------------
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6687);

installNextStubs();

type Sent = { to: string; subject: string; body: string };
const sent: Sent[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const [head, ...rest] = text.split("\r\n\r\n");
    const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=$/m.exec(head)?.[1] ?? "";
    sent.push({ to: /^To: (.+)$/m.exec(head)?.[1] ?? "", subject: Buffer.from(subj, "base64").toString("utf8"), body: rest.join("\r\n\r\n") });
    return json({ id: `gm-${sent.length}` });
  }
  return null;
});

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-auto-onboarding", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const cs = await import("@/lib/contentStrategy");
    const facts = await import("@/lib/clientFacts");
    const actions = await import("@/app/content/actions");
    const auto = await import("@/lib/autoOnboarding");
    const core = await import("@/lib/programRolloutCore");
    const R = await import("@/lib/programRollout");
    const { explicitPrivateRequest } = await import("@/lib/explicitConfidential");
    const { planEveryoneInScope, everythingOnOps } = await import("@/lib/everythingOnCore");
    const { CONFIDENTIAL_ONLY_WHEN_ASKED } = await import("@/lib/contentGeneration");

    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    const now = new Date();
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@auto.test", role: "OWNER", status: "ACTIVE" } });
    await setSession({ uid: owner.id, email: owner.email, role: owner.role });
    const setSwitch = (key: string, enabled: boolean) => prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: enabled ? now : null }, update: { enabled, enabledAt: enabled ? now : null } });
    const mkClient = async (name: string, email: string | null, status = "ACTIVE") => {
      const client = await prisma.client.create({ data: { name, email, firstSeenAt: now } });
      const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, status } });
      return { ...client, enrollmentId: enrollment.id };
    };
    const section = (id: string, heading: string, text: string, order: number) => ({ id, number: order, heading, order, text });
    const mkVersion = async (cl: { id: string; enrollmentId: string }, versionNo: number, status: string, sections: ReturnType<typeof section>[]) => {
      const strat = (await prisma.contentStrategy.findFirst({ where: { enrollmentId: cl.enrollmentId } })) ?? (await prisma.contentStrategy.create({ data: { enrollmentId: cl.enrollmentId, clientId: cl.id, sectionsJson: "{}" } }));
      return prisma.contentStrategyVersion.create({ data: { strategyId: strat.id, enrollmentId: cl.enrollmentId, clientId: cl.id, versionNo, sectionsJson: JSON.stringify({ structureVersion: "LEGACY", sections, document: null }), sourceKind: "import", status, ...(status === "APPROVED" ? { approvedAt: now, approvedBy: "drill" } : {}) } });
    };
    const LEHIGH_FACT = "Bernadette's financial target for the Discover Lehigh Valley project is about twenty thousand dollars, framed as recouping a lost commission";
    const sentTo = (email: string) => sent.filter((s) => s.to.toLowerCase().includes(email.toLowerCase()));

    // =========================================================================
    c.head("1 · The release is not refused by a confidential fact; the marker and working notes still are");
    {
      const B = await mkClient("Bernadette Example", "bern@example.test");
      await facts.createFact({ clientId: B.id, enrollmentId: B.enrollmentId, category: "DECISION", body: LEHIGH_FACT, source: "note_migration", confidential: true });
      const v = await mkVersion(B, 1, "APPROVED", [section("brand-overview", "Brand Overview", "The trusted agent for families across the\nLehigh Valley.", 1)]);
      let err = "";
      try { await cs.releaseStrategyVersion(v.id, "drill"); } catch (e) { err = e instanceof Error ? e.message : String(e); }
      const after = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v.id } });
      c.ok("\"Lehigh Valley.\" beside a confidential Lehigh Valley fact: released", !err && !!after.releasedAt, err);
      const m = await mkVersion(B, 2, "APPROVED", [section("brand-overview", "Brand Overview", "[CONFIDENTIAL] Leaving the brokerage", 1)]);
      let mErr = "";
      try { await cs.releaseStrategyVersion(m.id, "drill"); } catch (e) { mErr = e instanceof Error ? e.message : String(e); }
      c.ok("a literal [CONFIDENTIAL] marker still refuses the release", /\[CONFIDENTIAL\] marker/.test(mErr), mErr);
      const g = await mkVersion(B, 3, "APPROVED", [section("gaps", "Gaps the draft could not fill", "- price point", 1)]);
      let gErr = "";
      try { await cs.releaseStrategyVersion(g.id, "drill"); } catch (e) { gErr = e instanceof Error ? e.message : String(e); }
      c.ok("the team's working-notes section still refuses the release", /working notes/.test(gErr), gErr);
    }

    // =========================================================================
    c.head("2 · Approving releases it to the portal");
    {
      const S = await mkClient("Sam Approve", "sam@example.test");
      const v = await mkVersion(S, 1, "INTERNAL_REVIEW", [section("brand-overview", "Brand Overview", "Serving the\nLehigh Valley.", 1)]);
      const r = await actions.approveStrategy(v.id);
      const after = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v.id } });
      c.ok("approve → APPROVED and released in the same press, and the message says so", r.ok && after.status === "APPROVED" && !!after.releasedAt && /Released to the portal/.test(r.message), r.message);
      c.ok("the strategy-ready email is not queued while script_share_email is off (the normal gate)", /suppressed/i.test(r.message) && (await prisma.programReminder.count({ where: { enrollmentId: S.enrollmentId, action: "STRATEGY_READY" } })) === 0, r.message);
      const v2 = await mkVersion(S, 2, "INTERNAL_REVIEW", [section("brand-overview", "Brand Overview", "Serving the valley.", 1), section("gaps", "Gaps the draft could not fill", "- price point", 2)]);
      const r2 = await actions.approveStrategy(v2.id);
      const after2 = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v2.id } });
      c.ok("a release the guard refuses: the approval stands, not released, and the message says why", r2.ok && after2.status === "APPROVED" && !after2.releasedAt && /Not released to their portal: .*working notes/.test(r2.message), r2.message);
      const again = await actions.approveStrategy(v2.id);
      c.ok("approving again does not release a second time or throw", again.ok, again.message);
    }

    // =========================================================================
    c.head("2b · Oct 21 2026: only Jordan's approval releases; an admin's waits for his Release");
    {
      const { setOwnerOverride } = await import("@/lib/contentProgram");
      const kyle = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@auto.test", role: "ADMIN", status: "ACTIVE" } });
      const W = await mkClient("Wren Waiting", "wren@example.test");
      await setOwnerOverride("ENROLLMENT", W.enrollmentId, "STRATEGY", kyle.id, owner.email);
      const v = await mkVersion(W, 1, "INTERNAL_REVIEW", [section("brand-overview", "Brand Overview", "Serving the Main Line.", 1)]);
      await setSession({ uid: kyle.id, email: kyle.email, role: kyle.role });
      const r = await actions.approveStrategy(v.id);
      const after = await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v.id } });
      c.ok("an admin holding the strategy duty approves: APPROVED, not released, and the message says it waits for Jordan", r.ok && after.status === "APPROVED" && !after.releasedAt && /waiting for Jordan to release/.test(r.message), r.message);
      c.ok("…Jordan's bell says so, once", (await prisma.notification.count({ where: { kind: "strategy_release_waiting" } })) === 1);
      const releaseByAdmin = await actions.releaseStrategy(v.id);
      c.ok("…the admin still cannot release it (the Release button stays owner-only)", !releaseByAdmin.ok && !(await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v.id } })).releasedAt, releaseByAdmin.message);
      const unattended = await auto.autoOnboardClient(W.id, "auto-onboarding (drill sweep)", { sendWelcome: false, unattended: true, dryRun: true });
      c.ok("…an unattended onboarding run does not release an admin's approval either", unattended.steps.find((s) => s.key === "strategy")?.status === "skipped" && /waiting for Jordan to release/.test(unattended.steps.find((s) => s.key === "strategy")?.detail ?? ""), JSON.stringify(unattended.steps.find((s) => s.key === "strategy")));
      await setSession({ uid: owner.id, email: owner.email, role: owner.role });
      const rel = await actions.releaseStrategy(v.id);
      c.ok("Jordan's Release puts it in the portal", rel.ok && !!(await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v.id } })).releasedAt, rel.message);
      const v2 = await mkVersion(W, 2, "INTERNAL_REVIEW", [section("brand-overview", "Brand Overview", "Serving the whole Main Line.", 1)]);
      const ownRun = await actions.approveStrategy(v2.id);
      c.ok("Jordan's own approval still releases at once", ownRun.ok && !!(await prisma.contentStrategyVersion.findUniqueOrThrow({ where: { id: v2.id } })).releasedAt && /Released to the portal/.test(ownRun.message), ownRun.message);
    }

    // =========================================================================
    c.head("3 · confidentialFilter ignores short pieces");
    {
      const F = await mkClient("Filter Example", "filter@example.test");
      await facts.createFact({ clientId: F.id, enrollmentId: F.enrollmentId, category: "DECISION", body: LEHIGH_FACT, source: "call", confidential: true });
      const secret = await facts.confidentialFilter(F.id, { phrases: false });
      c.ok("\"Lehigh Valley.\" (2 words) never matches", !secret("Lehigh Valley."));
      c.ok("a five-word piece inside the secret does not match", !secret("the Discover Lehigh Valley project"));
      c.ok("a six-word piece inside the secret still matches", secret("financial target for the Discover Lehigh"));
      c.ok("a long sentence sharing most of its words still matches", secret("Her financial target for Discover Lehigh Valley is twenty thousand dollars to recoup a commission"));
      c.ok("a text holding the WHOLE secret still matches", secret(`Note: ${LEHIGH_FACT}.`));
      c.ok("the minimum is six words", facts.CONFIDENTIAL_MIN_PIECE_WORDS === 6);
      c.ok("the analysis prompt's definition: only when the client explicitly asks", /ONLY when the client explicitly asks/.test(CONFIDENTIAL_ONLY_WHEN_ASKED) && /not enough on its own/.test(CONFIDENTIAL_ONLY_WHEN_ASKED));
    }

    // =========================================================================
    c.head("4 · autoOnboardClient: everything once, idempotent, never auto-share");
    const A = await mkClient("Alice Auto", "alice@example.test");
    {
      await setSwitch("portal_login_email", true);
      await mkVersion(A, 1, "APPROVED", [section("brand-overview", "Brand Overview", "Serving the Main Line.", 1)]);
      const before = sent.length;
      const r1 = await auto.autoOnboardClient(A.id, "drill@auto.test", { sendWelcome: true });
      const seats1 = await prisma.clientMembership.count({ where: { clientId: A.id } });
      c.ok("first run: onboarded", r1.outcome === "onboarded", JSON.stringify(r1.steps.map((s) => `${s.key}:${s.status}`)));
      c.ok("the approved strategy was released", r1.steps.find((s) => s.key === "strategy")?.status === "done" && !!(await prisma.contentStrategyVersion.findFirstOrThrow({ where: { enrollmentId: A.enrollmentId, status: "APPROVED" } })).releasedAt);
      c.ok("exactly one OWNER seat, at the email on file", seats1 === 1 && (await prisma.clientMembership.count({ where: { clientId: A.id, role: "OWNER" } })) === 1);
      c.ok("exactly one email: the welcome, to alice@example.test, under the welcome subject", sent.length === before + 1 && sentTo("alice@example.test").length === 1 && /Welcome to your Realtour Pilot content portal/.test(sent.at(-1)!.subject), sent.slice(before).map((s) => `${s.to}: ${s.subject}`).join(" | "));
      const { rollout } = await R.loadProgramRollout();
      const ops = core.clientAllowedOps(rollout, { id: A.id, name: A.name });
      c.ok("every feature on but \"Share scripts without my approval\"", ["portal_invites", "portal_login_email", "portal_sign_in", "manual_messages", "reminders", "script_share_email", "program_message_notice", "revision_policy", "review_auto_approve", "topic_carryover", "caption_assistant"].every((op) => ops.includes(op as never)) && !ops.includes("script_auto_share"), ops.join(","));
      c.ok("bookings stays with Kyle while automatic booking is not proven (said in the report)", !ops.includes("hub_writes") && /bookings stay with Kyle/.test(r1.steps.find((s) => s.key === "features")?.detail ?? ""));
      const rec = await prisma.appSetting.findUnique({ where: { key: `client-onboarding:${A.id}` } });
      c.ok("marked onboarded", !!rec && !!JSON.parse(rec.value).onboardedAt);

      const r2 = await auto.autoOnboardClient(A.id, "drill@auto.test", { sendWelcome: true });
      c.ok("second run: no second welcome, no second seat", sent.length === before + 1 && (await prisma.clientMembership.count({ where: { clientId: A.id } })) === 1 && r2.steps.find((s) => s.key === "welcome")?.status === "already", r2.steps.find((s) => s.key === "welcome")?.detail);
      c.ok("…every step reads already", r2.steps.every((s) => s.status === "already"), JSON.stringify(r2.steps.map((s) => `${s.key}:${s.status}`)));
      c.ok("one onboarding welcome row in the outbox, under the automatic intent", (await prisma.outboxMessage.count({ where: { dedupeKey: `onboarding:welcome:${A.id}:auto-welcome-${A.id}` } })) === 1);

      // The payment grant after the automatic welcome: no second welcome.
      await setSwitch("portal_invites", true);
      const { grantProgramAccess } = await import("@/lib/portalAccess");
      const g = await grantProgramAccess({ enrollmentId: A.enrollmentId, emailRaw: "alice@example.test", name: "Alice Auto", reason: "welcome", requestedBy: "stripe-signup" });
      c.ok("a payment grant after it: the seat is the same and the welcome is \"already\" (nothing sent)", g.outcome === "GRANTED" && g.welcome === "already" && sent.length === before + 1, JSON.stringify(g));
      await setSwitch("portal_invites", false);

      // A welcome the grant already sent: the automatic run sends none.
      const G = await mkClient("Grace Granted", "grace@example.test");
      const person = await prisma.clientUser.create({ data: { email: "grace@example.test", name: "Grace" } });
      const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: G.enrollmentId, clientId: G.id, role: "OWNER" } });
      const { portalWelcomeKey } = await import("@/lib/portalAccess");
      await prisma.outboxMessage.create({ data: { channel: "email", toRef: "grace@example.test", clientId: G.id, body: "welcome", state: "accepted", dedupeKey: portalWelcomeKey(seat.id) } });
      const beforeG = sent.length;
      const rg = await auto.autoOnboardClient(G.id, "drill@auto.test", { sendWelcome: true });
      c.ok("a welcome already sent with their portal account: the run sends none and still marks them onboarded", sent.length === beforeG && rg.steps.find((s) => s.key === "welcome")?.status === "already" && rg.outcome === "onboarded", rg.steps.find((s) => s.key === "welcome")?.detail);

      // Sign-in emails off: the welcome is held (it would tell them to sign in by email).
      await setSwitch("portal_login_email", false);
      const H = await mkClient("Hal Held", "hal@example.test");
      const beforeH = sent.length;
      const rh = await auto.autoOnboardClient(H.id, "drill@auto.test", { sendWelcome: true });
      c.ok("sign-in links off: the welcome is held, not sent, and they are not marked onboarded", sent.length === beforeH && rh.steps.find((s) => s.key === "welcome")?.status === "skipped" && /Held/.test(rh.steps.find((s) => s.key === "welcome")?.detail ?? "") && rh.outcome === "partial");
      await setSwitch("portal_login_email", true);

      // No email on file.
      const N = await mkClient("Nora Noemail", null);
      const rn = await auto.autoOnboardClient(N.id, "drill@auto.test", { sendWelcome: true });
      c.ok("no email on file: reported, no account, no welcome", rn.steps.find((s) => s.key === "account")?.status === "failed" && /No email on file/.test(rn.steps.find((s) => s.key === "account")?.detail ?? "") && (await prisma.clientMembership.count({ where: { clientId: N.id } })) === 0);

      // A dry run writes nothing.
      const D = await mkClient("Dora Dry", "dora@example.test");
      const beforeD = sent.length;
      const rd = await auto.autoOnboardClient(D.id, "drill@auto.test", { sendWelcome: true, dryRun: true });
      const { rollout: rr } = await R.loadProgramRollout();
      c.ok("dry run: says what it would do and changes nothing", rd.outcome === "would" && sent.length === beforeD && (await prisma.clientMembership.count({ where: { clientId: D.id } })) === 0 && core.clientAllowedOps(rr, { id: D.id, name: D.name }).length === 0);
    }

    // =========================================================================
    c.head("5 · PAUSED and TEST clients are skipped (TEST only with allowTest, at the test inbox)");
    {
      const P = await mkClient("Paula Paused", "paula@example.test", "PAUSED");
      const rp = await auto.autoOnboardClient(P.id, "drill@auto.test", { sendWelcome: true });
      c.ok("a paused program is skipped, nothing written", rp.outcome === "skipped" && /paused/.test(rp.reason ?? "") && (await prisma.clientMembership.count({ where: { clientId: P.id } })) === 0);
      const T = await mkClient("Auto TEST", "info+auto@realtourpilot.com");
      const rt = await auto.autoOnboardClient(T.id, "drill@auto.test", { sendWelcome: true });
      c.ok("a TEST client without allowTest is skipped", rt.outcome === "skipped" && /TEST/.test(rt.reason ?? ""));
      const beforeT = sent.length;
      const rt2 = await auto.autoOnboardClient(T.id, "drill@auto.test", { sendWelcome: true, allowTest: true });
      c.ok("with allowTest: onboarded, the welcome goes to the verified test inbox only", rt2.outcome === "onboarded" && sent.length === beforeT + 1 && /info\+auto@realtourpilot\.com/i.test(sent.at(-1)!.to), JSON.stringify(rt2.steps.map((s) => `${s.key}:${s.status}:${s.detail}`)));
      const { rollout } = await R.loadProgramRollout();
      c.ok("a TEST client is never named in the rollout", !(rollout.pilot?.clientIds ?? []).includes(T.id));
      const all = await auto.autoOnboardAll("drill@auto.test", { sendWelcome: true, dryRun: true });
      c.ok("Onboard all: only ACTIVE real clients (no TEST, no paused)", !all.some((r) => r.clientId === T.id || r.clientId === P.id) && all.some((r) => r.clientId === A.id));
    }

    // =========================================================================
    c.head("6 · The activation hook: on with the switch, off without it");
    {
      const K = await mkClient("Kim Hook", "kim@example.test", "PAUSED");
      await setSwitch("auto_onboarding", false);
      const off = await auto.maybeAutoOnboard(K.id, "auto-onboarding", "drill");
      c.ok("switch off: maybeAutoOnboard does nothing", off === null && (await prisma.clientMembership.count({ where: { clientId: K.id } })) === 0);
      const { setEnrollmentStatus } = await import("@/lib/enrollmentChanges");
      await setEnrollmentStatus(K.enrollmentId, "ACTIVE", "drill@auto.test");
      c.ok("switch off: a reactivation onboards nobody", (await prisma.clientMembership.count({ where: { clientId: K.id } })) === 0 && sentTo("kim@example.test").length === 0);
      await setEnrollmentStatus(K.enrollmentId, "PAUSED", "drill@auto.test");
      await setSwitch("auto_onboarding", true);
      await setEnrollmentStatus(K.enrollmentId, "ACTIVE", "drill@auto.test");
      c.ok("switch on: the reactivation onboards them and sends ONE welcome", (await prisma.clientMembership.count({ where: { clientId: K.id } })) === 1 && sentTo("kim@example.test").length === 1);
      await setEnrollmentStatus(K.enrollmentId, "PAUSED", "drill@auto.test");
      await setEnrollmentStatus(K.enrollmentId, "ACTIVE", "drill@auto.test");
      c.ok("…paused and reactivated again: still one welcome", sentTo("kim@example.test").length === 1);
      const on = await auto.maybeAutoOnboard(K.id, "auto-onboarding", "drill");
      c.ok("maybeAutoOnboard with the switch on returns the report", on?.outcome === "onboarded");
      await setSwitch("auto_onboarding", false);
    }

    // =========================================================================
    c.head("7 · The un-mark script keeps explicit requests only");
    {
      const keep = [
        ["Please don't share this with anyone yet", null],
        ["She is moving brokerages", JSON.stringify([{ speaker: "client", text: "This is off the record, okay?" }])],
        ["Keep it private until January", null],
        ["Keep this between us", null],
        ["That number is not for the video", null],
        ["Don’t put that on camera", null],
        ["Confidentially, the team is splitting", null],
        ["Do not share the price", null],
      ] as const;
      const unmark = [
        ["Bernadette agreed to a $500-per-video rate for her portion of the Discover Lehigh Valley proposal", null],
        ["Lehigh Valley", null],
        ["Joe's baby is due September 3rd", JSON.stringify([{ speaker: "client", text: "the doctor said she's hanging out super low" }])],
        ["She shares listings on Instagram", null],
      ] as const;
      c.ok("explicit requests are kept (body or excerpt)", keep.every(([b, x]) => !!explicitPrivateRequest(b, x)), keep.filter(([b, x]) => !explicitPrivateRequest(b, x)).map(([b]) => b).join(" | "));
      c.ok("everything else is un-marked (sensitive is not enough)", unmark.every(([b, x]) => !explicitPrivateRequest(b, x)), unmark.filter(([b, x]) => !!explicitPrivateRequest(b, x)).map(([b]) => b).join(" | "));
    }

    // =========================================================================
    c.head("8 · turn-everything-on's plan: every active client, never auto-share");
    {
      const X = { id: "cx_drill_x", name: "Xena Real" };
      const Y = { id: "cx_drill_y", name: "Yuri Real" };
      const cur: import("@/lib/programRolloutCore").ProgramRollout = {
        mode: "PILOT", modeSince: now.toISOString(),
        pilot: { clientIds: [X.id], operations: [], approvedBy: "jordan", approvedAt: now.toISOString(), expiresAt: null, note: null, joinedAt: { [X.id]: now.toISOString() }, clientOps: { [X.id]: ["hub_writes", "script_auto_share"] } },
      };
      const p = planEveryoneInScope(cur, { clients: [X, Y], bookings: false, by: "drill", now });
      const ok = !("error" in p);
      const r = ok ? p.rollout : null;
      const xOps = r ? core.clientAllowedOps(r, X) : [];
      const yOps = r ? core.clientAllowedOps(r, Y) : [];
      c.ok("both named, mode PILOT", ok && r!.mode === "PILOT" && r!.pilot!.clientIds.includes(Y.id));
      c.ok("each gets everything autoOnboard turns on", everythingOnOps(false).every((op) => xOps.includes(op) && yOps.includes(op)));
      c.ok("script_auto_share is never ADDED (kept only where Jordan already chose it)", !yOps.includes("script_auto_share") && xOps.includes("script_auto_share"));
      c.ok("bookings not added while unproven, kept where it was", !yOps.includes("hub_writes") && xOps.includes("hub_writes"));
    }

    // =========================================================================
    c.head("9 · The portal already built for them (Jordan: \"the portals we already have built\")");
    {
      // Janice's shape: an older record (ENDED program, old address) and the
      // ACTIVE record with her months, topics and scripts, a welcome held
      // from her payment for a different address.
      const old = await mkClient("Janet Dup", "janet.old@example.test", "ENDED");
      const J = await mkClient("Janet Dup", "janet@example.test");
      const month = await prisma.contentMonth.create({ data: { enrollmentId: J.enrollmentId, clientId: J.id, monthKey: "2026-10", videosOwed: 4, status: "OPEN" } });
      const topic = await prisma.contentTopic.create({ data: { enrollmentId: J.enrollmentId, clientId: J.id, title: "Why Paoli", status: "SELECTED" } });
      await prisma.contentScript.create({ data: { enrollmentId: J.enrollmentId, clientId: J.id, monthId: month.id, topicId: topic.id, title: "Why Paoli", body: "x", status: "APPROVED", releaseState: "released" } });
      await prisma.appSetting.create({ data: { key: `portal-access-owed:${J.enrollmentId}:janet.pay@example.test`, value: JSON.stringify({ enrollmentId: J.enrollmentId, clientId: J.id, email: "janet.pay@example.test", name: "Janet Dup", role: "OWNER", reason: "welcome", since: now.toISOString() }) } });
      const enrollmentsBefore = await prisma.contentEnrollment.count();
      const clientsBefore = await prisma.client.count();
      const beforeJ = sent.length;
      const r = await auto.autoOnboardClient(J.id, "drill@auto.test", { sendWelcome: true });
      const seat = await prisma.clientMembership.findFirst({ where: { clientId: J.id, role: "OWNER", revokedAt: null }, select: { enrollmentId: true, clientUserId: true } });
      c.ok("the OWNER seat is on her EXISTING program (the one with her month, topic and script)", r.outcome === "onboarded" && seat?.enrollmentId === J.enrollmentId && r.enrollmentId === J.enrollmentId && /1 month, 1 script, 1 topic/.test(r.steps.find((s) => s.key === "account")?.detail ?? ""), r.steps.find((s) => s.key === "account")?.detail);
      c.ok("no program and no client record was created", (await prisma.contentEnrollment.count()) === enrollmentsBefore && (await prisma.client.count()) === clientsBefore);
      c.ok("the seat uses the email on THIS record (not the older record's, not the held payment address)", r.seatEmail === "janet@example.test" && sentTo("janet@example.test").length === 1 && sentTo("janet.old@example.test").length === 0 && sent.length === beforeJ + 1);
      c.ok("the differing held payment address is reported and left held", /janet\.pay@example\.test/.test(r.steps.find((s) => s.key === "account")?.detail ?? "") && !!(await prisma.appSetting.findUnique({ where: { key: `portal-access-owed:${J.enrollmentId}:janet.pay@example.test` } })));
      c.ok("the older record is flagged as a duplicate (with its ENDED program), and never used", r.duplicates.length === 1 && r.duplicates[0].includes(old.id) && /program ENDED/.test(r.duplicates[0]) && (await prisma.clientMembership.count({ where: { clientId: old.id } })) === 0 && /DUPLICATE CLIENT RECORD/.test(auto.reportLine(r)), r.duplicates.join(" | "));
      c.ok("the welcome tells her to sign in at the portal sign-in page", /\/portal\/login/.test(sent.at(-1)!.body));

      // She signs in the way the welcome says: her email on the sign-in page.
      const { requestLoginLink, consumeLoginToken } = await import("@/lib/portalAccess");
      const { signClientSession } = await import("@/lib/auth/clientSession");
      const portal = await import("@/lib/portal");
      const beforeLink = sent.length;
      await requestLoginLink("janet@example.test");
      const loginRow = await prisma.outboxMessage.findFirst({ where: { dedupeKey: { startsWith: `portal_login:${seat?.clientUserId}:` } }, orderBy: { createdAt: "desc" }, select: { body: true, state: true } });
      const link = /\/portal\/auth\/([A-Za-z0-9_-]{40,60})/.exec(loginRow?.body ?? "")?.[1] ?? null;
      c.ok("asking for a sign-in link emails her one", !!link && loginRow?.state === "accepted" && sent.slice(beforeLink).filter((s) => /janet@example\.test/.test(s.to)).length === 1, `${loginRow?.state ?? "no outbox row"} · ${sent.slice(beforeLink).map((s) => `${s.to}: ${s.subject}`).join(" / ")}`);
      const used = link ? await consumeLoginToken(link) : null;
      const cookie = used?.ok ? await signClientSession({ cu: used.clientUserId, email: used.email }) : null;
      const view = cookie ? await portal.resolvePortalViewer({ cookies: { get: (n: string) => (n === "rtp_client" ? cookie : undefined) } }) : null;
      c.ok("…and signing in lands her in that same program, as its owner", !!view && view.ok && view.viewer.enrollment.id === J.enrollmentId && view.viewer.actor.kind === "CLIENT" && view.viewer.actor.membershipRole === "OWNER", view && !view.ok ? view.reason : "");
      const scripts = await prisma.contentScript.count({ where: { enrollmentId: view && view.ok ? view.viewer.enrollment.id : "none" } });
      c.ok("…where her existing script is", scripts === 1);

      // Joseph's shape: the welcome is held on a program id that no longer exists.
      const Jo = await mkClient("Joe Folded", "joe@example.test");
      const staleKey = "portal-access-owed:cm_gone_enrollment_000000:joe@example.test";
      await prisma.appSetting.create({ data: { key: staleKey, value: JSON.stringify({ enrollmentId: "cm_gone_enrollment_000000", clientId: Jo.id, email: "joe@example.test", name: "Joe", role: "OWNER", reason: "welcome", since: now.toISOString() }) } });
      const dryJo = await auto.autoOnboardClient(Jo.id, "drill@auto.test", { sendWelcome: true, dryRun: true });
      c.ok("dry run: names the hold on a program that no longer exists, clears nothing", dryJo.steps.some((s) => s.status === "would" && /no longer exists/.test(s.detail)) && !!(await prisma.appSetting.findUnique({ where: { key: staleKey } })));
      const rJo = await auto.autoOnboardClient(Jo.id, "drill@auto.test", { sendWelcome: true });
      c.ok("live: the account opens on his existing program, the stale hold is cleared (audited), ONE welcome", rJo.outcome === "onboarded" && !(await prisma.appSetting.findUnique({ where: { key: staleKey } })) && (await prisma.auditLog.count({ where: { action: "auto_onboarding_cleared_stale_hold", target: Jo.id } })) === 1 && sentTo("joe@example.test").length === 1);
    }

    c.ok("nothing outside the machine was contacted (Gmail answered in-process)", fence.blocked.length === 0 && fence.faked.every((u) => /googleapis\.com/.test(u)), fence.blocked.join(", "));
    console.log(`\n${await drill.evidence()}`);
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
