// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: Settings → Client onboarding (Oct 5 2026).
//
// Jordan: "Let's do all of them. Just don't send any notifications without my
// written approval. Don't even send anything. I will send it." and "I'll do
// each client one by one … a step by step process in a nice settings page …
// I can customize what gets sent or not sent."
//
//   1. Default: ALL OFF — no rollout row, every real client refused for every
//      op, every toggle off, every message held behind its toggle.
//   2. Loading the page (owner, admin, "view as") writes nothing and sends
//      nothing: no rollout row, no record, no portal token, no outbox row.
//   3. Per-client toggles reach ONLY that client for ONLY that feature; the
//      first one turns the rollout to named clients; nothing is sent; an admin
//      or a "view as" preview cannot toggle.
//   4. "Create the account without emailing": a seat, no email; refused while
//      the client's "Portal account" toggle is off.
//   5. A manual send by the owner goes to EXACTLY the chosen recipient with
//      the EDITED text, under the message's subject, through the outbox, and
//      is logged (record + AuditLog); a double press sends once; an address
//      not on file, a toggle that is off and a TEST client's real address are
//      refused; the dispatch gate re-checks at sending.
//   6. An admin, and the owner previewing as someone, cannot send.
//   7. "Mark as sent by me" records without sending.
//   8. No sweep sends anything (reminders, share notices, office replies,
//      auto-share, the outbox recovery drain).
//   9. The page renders for the owner (controls) and the admin (read-only,
//      addresses masked, the private portal link hidden).
//
// Oct 5 2026 review fix: Jordan's own messages need "Messages I send myself"
// (op manual_messages), no longer "Program emails" (the automatic ones), so
// step 5 turns that on first, and turning "Program emails" off no longer
// stops his note — turning "Messages I send myself" off does. The full
// before/after proof is scripts/_drill/oct5-csfix-review.ts.
//
// ISOLATION: PGlite on 127.0.0.1:6632 (DRILL_PORT overrides; this builder's
// range is 6620-6639). Gmail and OpenPhone are answered in-process at the HTTP
// fence (the shipped provider code runs and is recorded); every other
// outbound call is blocked.
// ---------------------------------------------------------------------------
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6632);

installNextStubs();

// ---- the providers: the REAL Gmail and OpenPhone code, answered in-process -----
// Every request is decoded and recorded exactly as the provider would receive it.
type Sent = { channel: "email" | "sms"; to: string; subject?: string; body: string };
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
    sent.push({ channel: "email", to: /^To: (.+)$/m.exec(head)?.[1] ?? "", subject: Buffer.from(subj, "base64").toString("utf8"), body: rest.join("\r\n\r\n") });
    return json({ id: `gm-${sent.length}` });
  }
  if (url.startsWith("https://api.openphone.com/v1/phone-numbers")) return json({ data: [{ id: "PNdrill", number: "+12155550000", name: "Office" }] });
  if (url.startsWith("https://api.openphone.com/v1/messages") && (init?.method ?? "GET").toUpperCase() === "POST") {
    const b = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; content: string };
    sent.push({ channel: "sms", to: b.to.join(","), body: b.content });
    return json({ data: { id: `op-${sent.length}` } }, 202);
  }
  return null;
});

// ---- rendering helpers -------------------------------------------------------
type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
function textOf(tree: unknown): string {
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(" ");
  return isValidElement<{ children?: unknown }>(tree) ? textOf(tree.props.children) : "";
}
class Redirect extends Error { constructor(readonly href: string) { super(href); } }
const navigation = createRequire(__filename)("next/navigation") as { redirect: (href: string) => never; useRouter: () => { refresh: () => void } };
navigation.redirect = (href) => { throw new Redirect(href); };
navigation.useRouter = () => ({ refresh() {} });

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-onboarding-panel", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const R = await import("@/lib/programRollout");
    const core = await import("@/lib/programRolloutCore");
    const ob = await import("@/lib/clientOnboarding");
    const obc = await import("@/lib/clientOnboardingCore");
    const A_ = await import("@/app/settings/onboarding/actions");
    const { default: page } = await import("@/app/settings/onboarding/page");
    const { ClientOnboardingPanel } = await import("@/components/settings/ClientOnboardingPanel");
    const { onboardingGate } = await import("@/lib/programRolloutGate");

    // ---- fixtures --------------------------------------------------------------
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    await saveSecret("openphone", "drill-key-not-a-real-one");
    const now = new Date();
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@onboarding.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@onboarding.test", role: "ADMIN", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const mkClient = async (name: string, email: string | null, phone: string | null, status = "ACTIVE", billingType: string | null = null) => {
      const client = await prisma.client.create({ data: { name, email, phone, firstSeenAt: now } });
      const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, status, billingType } });
      return { ...client, enrollmentId: enrollment.id };
    };
    const A = await mkClient("Erica Example", "erica@example.test", "(610) 555-0101");
    const B = await mkClient("Kristin Example", "kristin@example.test", null);
    const Pz = await mkClient("Paula Paused", "paula@example.test", null, "PAUSED");
    const Tr = await mkClient("Ashley Trial", "ashley@example.test", null, "ACTIVE", "TRIAL");
    const T = await mkClient("Onboard TEST", "info+onboard@realtourpilot.com", null);
    // A real person's address on file for the TEST client (the floor's case).
    await prisma.client.update({ where: { id: T.id }, data: { backupEmail: "someone@example.test" } });
    // A strategy waiting for approval on A (one of the seven).
    const strat = await prisma.contentStrategy.create({ data: { enrollmentId: A.enrollmentId, clientId: A.id, sectionsJson: "{}" } });
    await prisma.contentStrategyVersion.create({ data: { strategyId: strat.id, enrollmentId: A.enrollmentId, clientId: A.id, versionNo: 1, sectionsJson: "{}", sourceKind: "import", status: "INTERNAL_REVIEW" } });

    const outboxCount = () => prisma.outboxMessage.count();
    const rolloutRow = () => prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } });
    const realOps = core.PROGRAM_REACH_OPS;

    // =========================================================================
    c.head("1. Default: ALL OFF — nobody real is reached for anything");
    {
      const refusedAll = async (id: string) => (await Promise.all(realOps.map((op) => R.programReach(op, id)))).every((d) => !d.ok);
      c.ok("no rollout row; every real client refused for every op (A, B, the paused and the trial client)", !(await rolloutRow()) && (await refusedAll(A.id)) && (await refusedAll(B.id)) && (await refusedAll(Pz.id)) && (await refusedAll(Tr.id)));
      c.ok("the TEST client is in scope (always), as before", (await R.programReach("reminders", T.id)).ok);
      const list = await ob.listOnboardingClients();
      c.ok("the list: every ACTIVE and PAUSED program, real clients by name, TEST last and marked; all 'Not started'",
        list.map((r) => r.name).join("|") === "Ashley Trial|Erica Example|Kristin Example|Paula Paused|Onboard TEST" && list[4].isTest && !list.slice(0, 4).some((r) => r.isTest) &&
        list.filter((r) => !r.isTest).every((r) => r.chip === "Not started") && list.find((r) => r.name === "Ashley Trial")?.trial === true && list.find((r) => r.name === "Paula Paused")?.paused === true,
        JSON.stringify(list.map((r) => [r.name, r.chip, r.isTest])));
      const d = (await ob.loadOnboardingDetail(A.id))!;
      c.ok("A's detail: every toggle OFF (bookings too), nothing allowed", d.toggles.every((t) => !t.on) && d.allowed.length === 0 && !d.booking.auto);
      c.ok("…every message is held behind its toggle, and says which one and that turning it on sends nothing",
        d.messages.every((m) => !m.allowed && !!m.blockedWhy && /Turn on ".+" for Erica Example in step 3 first/.test(m.blockedWhy) && /nothing is sent until you press Send now/.test(m.blockedWhy)));
      c.ok("…the steps: strategy needs you (v1 waiting), features needs you (all off), portal blocked behind step 3, messages and done need you",
        d.steps.map((s) => `${s.key}:${s.status}`).join(",") === "account:done,strategy:needs_you,features:needs_you,portal:blocked,messages:needs_you,filming:done,done:needs_you",
        d.steps.map((s) => `${s.key}:${s.status}`).join(","));
      c.ok("…the strategy step names v1 as waiting; automatic booking is unavailable and says why", d.strategy.inReview?.versionNo === 1 && !d.booking.autoAvailable && d.booking.whyNot.some((w) => /switched off/.test(w)));
      c.ok("…the messages are composed for reading: the welcome greets Erica, the strategy call carries Jordan's link, the subjects are set",
        /^Hi Erica,/.test(d.messages.find((m) => m.key === "welcome")!.body.email) &&
        d.messages.find((m) => m.key === "strategy_call")!.body.email.includes("https://calendly.com/realtourpilot-info/strategy-call") &&
        obc.messageOf("strategy_call").subject === "Book your RealTour Pilot strategy call");
      c.ok("…the recipients are the addresses on file (email and text), never a typed one",
        JSON.stringify(d.messages[0].recipients.map((r) => [r.channel, r.toRef])) === JSON.stringify([["email", "erica@example.test"], ["sms", "6105550101"]]));
      const dt = (await ob.loadOnboardingDetail(T.id))!;
      c.ok("the TEST client: offered only its verified test inbox; every message allowed (always in scope)", dt.messages.every((m) => m.allowed) && dt.messages[0].recipients.map((r) => r.toRef).join() === "info+onboard@realtourpilot.com");
    }

    // =========================================================================
    c.head("2. Loading the page writes nothing and sends nothing");
    {
      const before = { outbox: await outboxCount(), settings: await prisma.appSetting.count(), users: await prisma.clientUser.count(), audits: await prisma.auditLog.count() };
      await clearSession();
      let anon = "";
      // requirePageAccess imports next/navigation lazily, so the real redirect
      // (a NEXT_REDIRECT error carrying the target in its digest) can arrive.
      try { await page({ searchParams: Promise.resolve({ client: A.id }) }); } catch (e) {
        const digest = (e as { digest?: string }).digest;
        if (e instanceof Redirect) anon = e.href; else if (digest?.startsWith("NEXT_REDIRECT")) anon = decodeURIComponent(digest.split(";")[2] ?? ""); else throw e;
      }
      c.ok("signed out → the login page", anon.startsWith("/login"), anon);
      await signIn(owner);
      const ownerTree = await page({ searchParams: Promise.resolve({ client: A.id }) });
      await signIn(admin);
      const adminTree = await page({ searchParams: Promise.resolve({ client: A.id }) });
      await signIn(owner, admin.id);
      const previewTree = await page({ searchParams: Promise.resolve({ client: A.id }) });
      const panel = (t: unknown) => elements(t, "ClientOnboardingPanel")[0];
      c.ok("owner: the panel offers controls (canAct); admin and 'view as' do not", panel(ownerTree).canAct === true && panel(adminTree).canAct === false && panel(previewTree).canAct === false);
      c.ok("admin sees the read-only line; the owner previewing sees the preview line", /only Jordan can change/.test(textOf(adminTree)) && /previewing as someone else/.test(textOf(previewTree)) && !/only Jordan can change/.test(textOf(ownerTree)));
      const after = { outbox: await outboxCount(), settings: await prisma.appSetting.count(), users: await prisma.clientUser.count(), audits: await prisma.auditLog.count() };
      const enr = await prisma.contentEnrollment.findUnique({ where: { id: A.enrollmentId }, select: { portalToken: true } });
      c.ok("three page loads: no outbox row, no setting written (no rollout, no record), no account, no audit row, no portal link minted, nothing handed to a provider",
        JSON.stringify(before) === JSON.stringify(after) && !enr?.portalToken && sent.length === 0, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    }

    // =========================================================================
    c.head("3. Per-client toggles: only that client, only that feature, nothing sent");
    {
      await signIn(owner);
      const t1 = await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "emails", on: true });
      const st = core.parseProgramRollout((await rolloutRow())!.value).rollout;
      c.ok("owner turns on Program emails for A: saved, and the words say nothing was sent and which switches it still needs",
        t1.ok && /Nothing was sent/.test(t1.message) && /Client reminders \(off\)/.test(t1.message) && /TEST clients only/.test(t1.message), t1.message);
      c.ok("…the rollout is now named clients (PILOT), A's OWN list is exactly the email ops, approved by the owner", st.mode === "PILOT" && st.pilot?.clientIds.join() === A.id && st.pilot.clientOps?.[A.id]?.join() === "reminders,script_share_email,program_message_notice" && st.pilot.approvedBy === owner.email);
      const reach = async (op: import("@/lib/programRolloutCore").ProgramReachOp, id: string) => (await R.programReach(op, id)).ok;
      c.ok("A is reached for the email ops — and for nothing else", (await reach("reminders", A.id)) && (await reach("program_message_notice", A.id)) && !(await reach("portal_sign_in", A.id)) && !(await reach("portal_layout_v2", A.id)) && !(await reach("revision_policy", A.id)));
      c.ok("B, the trial client and the paused client: still nothing", !(await reach("reminders", B.id)) && !(await reach("reminders", Tr.id)) && !(await reach("reminders", Pz.id)));
      const t2 = await A_.setOnboardingToggleAction({ clientId: B.id, toggle: "layout", on: true });
      c.ok("B gets ONLY the new layout; A keeps only emails", t2.ok && (await reach("portal_layout_v2", B.id)) && !(await reach("reminders", B.id)) && !(await reach("portal_layout_v2", A.id)) && (await reach("reminders", A.id)), t2.message);
      const t3 = await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "accounts", on: true });
      c.ok("A + Portal account: sign-in ops on for A only", t3.ok && (await reach("portal_sign_in", A.id)) && (await reach("portal_invites", A.id)) && !(await reach("portal_sign_in", B.id)));
      const auto = await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "bookings", on: true });
      c.ok("automatic Aryeo booking is refused while its switches are off / unproven; Kyle keeps booking by hand", !auto.ok && /can't be chosen yet/.test(auto.message) && !(await reach("hub_writes", A.id)), auto.message);
      const paused = await A_.setOnboardingToggleAction({ clientId: Pz.id, toggle: "emails", on: true });
      c.ok("a paused program can't be turned on", !paused.ok && /paused/.test(paused.message));
      const test = await A_.setOnboardingToggleAction({ clientId: T.id, toggle: "emails", on: true });
      c.ok("a TEST client has nothing to turn on (it always gets everything, at the test inbox)", !test.ok && /TEST client always gets everything/.test(test.message));
      const same = await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "emails", on: true });
      const auditsBefore = await prisma.auditLog.count({ where: { action: "client_onboarding_toggle" } });
      c.ok("turning on what is already on changes nothing", same.ok && /already on/.test(same.message));
      await signIn(admin);
      const adm = await A_.setOnboardingToggleAction({ clientId: B.id, toggle: "emails", on: true });
      await signIn(owner, admin.id);
      const prev = await A_.setOnboardingToggleAction({ clientId: B.id, toggle: "emails", on: true });
      c.ok("an admin, and the owner previewing as someone, cannot toggle; nothing was written", !adm.ok && !prev.ok && /previewing/.test(prev.message) && !(await reach("reminders", B.id)) && (await prisma.auditLog.count({ where: { action: "client_onboarding_toggle" } })) === auditsBefore, `${adm.message} | ${prev.message}`);
      c.ok("every toggle is audited (one AuditLog row each) and noted in the client's onboarding log", auditsBefore === 3 && (await ob.readOnboardingRecord(A.id)).log.filter((e) => e.kind === "toggle").length === 2);
      c.ok("toggling sent nothing (no outbox row, no provider call)", (await outboxCount()) === 0 && sent.length === 0);
      const list = await ob.listOnboardingClients();
      c.ok("the list chips: A and B 'In progress', the trial client still 'Not started'", list.find((r) => r.clientId === A.id)?.chip === "In progress" && list.find((r) => r.clientId === B.id)?.chip === "In progress" && list.find((r) => r.clientId === Tr.id)?.chip === "Not started");
    }

    // =========================================================================
    c.head("4. Create the account without emailing");
    {
      await signIn(owner);
      const noB = await A_.createOnboardingSeatAction({ clientId: B.id, email: "kristin@example.test", name: "Kristin Example" });
      c.ok("B (Portal account off) → refused, nothing created", !noB.ok && /Turn on "Portal account and sign-in"/.test(noB.message) && (await prisma.clientUser.count()) === 0, noB.message);
      await prisma.appSetting.create({ data: { key: `portal-access-owed:${A.enrollmentId}:erica@example.test`, value: JSON.stringify({ enrollmentId: A.enrollmentId, clientId: A.id, email: "erica@example.test", name: "Erica Example", role: "OWNER", reason: "welcome", since: now.toISOString() }) } });
      const seat = await A_.createOnboardingSeatAction({ clientId: A.id, email: " Erica@Example.test ", name: "Erica Example" });
      const m = await prisma.clientMembership.findFirst({ where: { clientId: A.id }, select: { role: true, revokedAt: true, clientUserId: true } });
      c.ok("A → an OWNER seat for erica@example.test, and the words say no email was sent", seat.ok && /No email was sent/.test(seat.message) && m?.role === "OWNER" && !m.revokedAt && (await prisma.clientUser.findUnique({ where: { id: m.clientUserId } }))?.email === "erica@example.test", seat.message);
      c.ok("…the welcome held from their payment is cleared (so it can never go out on its own) and that is said", !(await prisma.appSetting.findUnique({ where: { key: `portal-access-owed:${A.enrollmentId}:erica@example.test` } })) && /held from their payment is cleared/.test(seat.message));
      c.ok("…nothing was sent, no sign-in link minted, and the account step is done", (await outboxCount()) === 0 && sent.length === 0 && !(await prisma.clientUser.findFirst({ where: { loginTokenHash: { not: null } } })) && (await ob.loadOnboardingDetail(A.id))!.steps.find((s) => s.key === "portal")?.status === "done");
      const again = await A_.createOnboardingSeatAction({ clientId: A.id, email: "erica@example.test", name: null });
      c.ok("pressing it again changes nothing", again.ok && /already has a portal account/.test(again.message) && (await prisma.clientMembership.count({ where: { clientId: A.id } })) === 1);
    }

    // =========================================================================
    c.head("5. The owner's manual send: exactly the chosen recipient, exactly the edited text, logged");
    {
      await signIn(owner);
      const own = await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "messages", on: true });
      c.ok("'Messages I send myself' on for A (its own toggle, not Program emails): saved, nothing sent", own.ok && /A message goes only when you press Send now/.test(own.message) && sent.length === 0 && (await outboxCount()) === 0, own.message);
      const EDITED = "Hi Erica,\n\nJordan here — grab a time for your strategy call: https://calendly.com/realtourpilot-info/strategy-call\n\nTalk soon,\nJordan";
      const intent = "press-0001-strategy";
      const s1 = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "strategy_call", channel: "email", toRef: "erica@example.test", body: `  ${EDITED}\n\n`, intentId: intent });
      const row = await prisma.outboxMessage.findFirst({ orderBy: { createdAt: "desc" } });
      c.ok("sent: one provider call, to erica@example.test, with the edited words exactly, under the message's subject",
        s1.ok && sent.length === 1 && sent[0].channel === "email" && sent[0].to === "erica@example.test" && sent[0].body === EDITED && sent[0].subject === "Book your RealTour Pilot strategy call", JSON.stringify({ s1, sent }));
      c.ok("…through the outbox as the 'onboarding' kind, accepted, naming the client", row?.state === "accepted" && row.dedupeKey === `onboarding:strategy_call:${A.id}:${intent}` && row.toRef === "erica@example.test" && row.clientId === A.id && row.body === EDITED && row.requestedBy === `onboarding:${owner.email}`);
      const rec = await ob.readOnboardingRecord(A.id);
      const last = rec.log[rec.log.length - 1];
      const audit = await prisma.auditLog.findFirst({ where: { action: "client_onboarding_send", target: A.id } });
      c.ok("…logged on the client (who, what, to whom, when) and in AuditLog", last.kind === "sent" && last.message === "strategy_call" && last.to === "erica@example.test" && last.by === owner.email && !!audit && audit.actor === owner.email && audit.detail.includes("erica@example.test"));
      const dup = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "strategy_call", channel: "email", toRef: "erica@example.test", body: EDITED, intentId: intent });
      c.ok("the same press arriving twice sends ONCE", dup.ok && /already handled/.test(dup.message) && sent.length === 1, dup.message);
      const typed = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "note", channel: "email", toRef: "someone@else.test", body: "Hi", intentId: "press-0002-typed" });
      c.ok("an address NOT on file for the client is refused, nothing sent", !typed.ok && /not on file/.test(typed.message) && sent.length === 1);
      const bNote = await A_.sendOnboardingMessageAction({ clientId: B.id, message: "note", channel: "email", toRef: "kristin@example.test", body: "Hi Kristin", intentId: "press-0003-b" });
      c.ok("B's 'Messages I send myself' is off → refused and told which toggle, nothing sent", !bNote.ok && /Turn on "Messages I send myself" for Kristin Example/.test(bNote.message) && sent.length === 1, bNote.message);
      const empty = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "note", channel: "email", toRef: "erica@example.test", body: "   ", intentId: "press-0004-empty" });
      c.ok("an empty message is refused", !empty.ok && /empty/.test(empty.message) && sent.length === 1);
      const sms = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "video_ready", channel: "sms", toRef: "6105550101", body: "Hi Erica, a new video is waiting in your portal.", intentId: "press-0005-sms" });
      c.ok("a text goes to A's phone on file, with the edited words", sms.ok && sent.length === 2 && sent[1].channel === "sms" && sent[1].to === "+16105550101" && sent[1].body === "Hi Erica, a new video is waiting in your portal.", JSON.stringify(sent[1]));
      const welcome = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "welcome", channel: "email", toRef: "erica@example.test", body: "Welcome, Erica.", intentId: "press-0006-welcome" });
      c.ok("the welcome (Portal account on for A) goes, under the welcome subject", welcome.ok && sent.length === 3 && sent[2].subject === "Welcome to your RealTour Pilot content portal");
      const tReal = await A_.sendOnboardingMessageAction({ clientId: T.id, message: "note", channel: "email", toRef: "someone@example.test", body: "x", intentId: "press-0007-treal" });
      const tOk = await A_.sendOnboardingMessageAction({ clientId: T.id, message: "note", channel: "email", toRef: "info+onboard@realtourpilot.com", body: "Test note", intentId: "press-0008-tok" });
      c.ok("the TEST client: a real address ON FILE is refused by the TEST floor; its verified test inbox is sent", !tReal.ok && /verified test inbox/.test(tReal.message) && tOk.ok && sent.length === 4 && sent[3].to === "info+onboard@realtourpilot.com", `${tReal.message} | ${tOk.message}`);

      // The dispatch gate re-checks at the moment of sending.
      const gateRow = (key: string, clientId: string, toRef: string, channel = "email") => ({
        id: "g", channel, toRef, body: "b", state: "attempting", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null,
        dedupeKey: key, requestedBy: "drill", clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null,
      });
      const code = (v: Awaited<ReturnType<typeof onboardingGate>>) => (v.ok ? "ok" : v.code);
      c.ok("gate: A's note to her address on file → ok; to an address not on file → seat_mismatch; a row naming another client → seat_mismatch",
        code(await onboardingGate(gateRow(`onboarding:note:${A.id}:x12345678`, A.id, "erica@example.test"))) === "ok" &&
        code(await onboardingGate(gateRow(`onboarding:note:${A.id}:x12345678`, A.id, "not@file.test"))) === "seat_mismatch" &&
        code(await onboardingGate(gateRow(`onboarding:note:${A.id}:x12345678`, B.id, "kristin@example.test"))) === "seat_mismatch");
      await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "messages", on: false });
      c.ok("gate: A's 'Messages I send myself' turned off → the same queued note is refused at sending (not_in_rollout_scope)", code(await onboardingGate(gateRow(`onboarding:note:${A.id}:x12345678`, A.id, "erica@example.test"))) === "not_in_rollout_scope");
      c.ok("gate: a TEST client's row to a real address → test_client_real_address", code(await onboardingGate(gateRow(`onboarding:note:${T.id}:x12345678`, T.id, "someone@example.test"))) === "test_client_real_address");
      const off = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "note", channel: "email", toRef: "erica@example.test", body: "Hi", intentId: "press-0009-off" });
      c.ok("…and the send action refuses it too, nothing sent", !off.ok && sent.length === 4);
      await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "messages", on: true });
    }

    // =========================================================================
    c.head("6. An admin, and the owner previewing, cannot send");
    {
      const outBefore = await outboxCount();
      await signIn(admin);
      const adm = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "note", channel: "email", toRef: "erica@example.test", body: "From Kyle", intentId: "press-0010-admin" });
      const admMark = await A_.markOnboardingSentAction({ clientId: A.id, message: "note", channel: "email", toRef: "erica@example.test" });
      await signIn(owner, admin.id);
      const prev = await A_.sendOnboardingMessageAction({ clientId: A.id, message: "note", channel: "email", toRef: "erica@example.test", body: "Preview", intentId: "press-0011-preview" });
      c.ok("admin → refused; the owner previewing as Kyle → refused ('exit the preview'); no outbox row, no provider call",
        !adm.ok && !admMark.ok && !prev.ok && /previewing/.test(prev.message) && (await outboxCount()) === outBefore && sent.length === 4, `${adm.message} | ${prev.message}`);
    }

    // =========================================================================
    c.head("7. Mark as sent by me — records, sends nothing");
    {
      await signIn(owner);
      const outBefore = await outboxCount();
      const r = await A_.markOnboardingSentAction({ clientId: A.id, message: "strategy_ready", channel: "sms", toRef: "6105550101" });
      const rec = await ob.readOnboardingRecord(A.id);
      const last = rec.log[rec.log.length - 1];
      c.ok("recorded as 'marked' by the owner, with no outbox row and no provider call", r.ok && /The hub sent nothing/.test(r.message) && last.kind === "marked" && last.message === "strategy_ready" && last.by === owner.email && (await outboxCount()) === outBefore && sent.length === 4);
      c.ok("…audited", (await prisma.auditLog.count({ where: { action: "client_onboarding_mark_sent", target: A.id } })) === 1);
      const d = (await ob.loadOnboardingDetail(A.id))!;
      c.ok("…the message shows it, and the welcome (sent) completes step 5", d.messages.find((m) => m.key === "strategy_ready")?.last?.kind === "marked" && d.messages.find((m) => m.key === "welcome")?.last?.kind === "sent" && d.steps.find((s) => s.key === "messages")?.status === "done");
      const done = await A_.setOnboardedAction({ clientId: A.id, done: true });
      c.ok("Onboarded: stamped with the date and who, chip 'Onboarded'", done.ok && !!(await ob.readOnboardingRecord(A.id)).onboardedAt && (await ob.listOnboardingClients()).find((x) => x.clientId === A.id)?.chip === "Onboarded");
    }

    // =========================================================================
    c.head("8. No sweep sends anything");
    {
      const outBefore = await outboxCount();
      const sentBefore = sent.length;
      const { evaluateReminders } = await import("@/lib/programReminders");
      const { drainShareNotices } = await import("@/lib/scriptShare");
      const { sweepProgramMessageNotices } = await import("@/lib/programMessages");
      const { sweepAutoShare } = await import("@/lib/scriptAutoShare");
      const outbox = await import("@/lib/outbox");
      const ran: string[] = [];
      const step = async (name: string, f: () => Promise<unknown>) => { try { await f(); ran.push(name); } catch (e) { ran.push(`${name} threw: ${e instanceof Error ? e.message.slice(0, 80) : e}`); } };
      await step("reminders", () => evaluateReminders({ dryRun: false, requestedBy: "reminders-cron" }));
      await step("share notices", () => drainShareNotices({}));
      await step("office replies", () => sweepProgramMessageNotices({}));
      await step("auto-share", () => sweepAutoShare({}));
      await step("outbox recovery", async () => { await outbox.recoverExpiredLeases(); await outbox.drainPending({ workerId: "drill-cron" }); });
      c.ok("reminders, share notices, office replies, auto-share and the outbox recovery ran — A's toggles on, the global switches off as in production — and sent NOTHING",
        ran.length === 5 && ran.every((x) => !x.includes("threw")) && (await outboxCount()) === outBefore && sent.length === sentBefore, ran.join(" · "));
    }

    // =========================================================================
    c.head("9. Renders for the owner and the admin");
    {
      await signIn(owner);
      const ownerTree = await page({ searchParams: Promise.resolve({ client: A.id }) });
      const ownerProps = elements(ownerTree, "ClientOnboardingPanel")[0];
      const O = renderToStaticMarkup(createElement(ClientOnboardingPanel, ownerProps as Parameters<typeof ClientOnboardingPanel>[0])).replace(/<!-- -->/g, "");
      await signIn(admin);
      const adminTree = await page({ searchParams: Promise.resolve({ client: A.id }) });
      const adminProps = elements(adminTree, "ClientOnboardingPanel")[0];
      const Ad = renderToStaticMarkup(createElement(ClientOnboardingPanel, adminProps as Parameters<typeof ClientOnboardingPanel>[0])).replace(/<!-- -->/g, "");
      c.ok("owner: the seven steps, the client list with the TEST client marked, the nine feature switches and the send controls",
        (O.match(/data-step="/g) ?? []).length === 7 && O.includes(`data-onboarding-client="${T.id}"`) && />TEST</.test(O) && (O.match(/role="switch"/g) ?? []).length === 9 &&
        O.includes("Send now") && O.includes("Mark as sent by me") && O.includes("Copy portal link") && O.includes("Erica Example"));
      c.ok("owner: the toggles show their state (emails and accounts on, the rest off) and the switches they need",
        O.includes('data-toggle="emails" data-toggle-on="1"') && O.includes('data-toggle="accounts" data-toggle-on="1"') && O.includes('data-toggle="layout" data-toggle-on="0"') && /Client reminders/.test(O) && /Content program automations/.test(O));
      c.ok("owner: 'only allows … never sends anything by itself' is said on the page; automatic approval and auto-share say they are off by default",
        /only <strong>allows<\/strong> it for Erica Example\. It never sends anything by itself/.test(O) && (O.match(/Off by default/g) ?? []).length === 2);
      c.ok("owner: the history lists the send and the mark", /History \(/.test(O) && /Marked sent/.test(O));
      c.ok("admin: the same steps, READ-ONLY — no send, no mark, no copy link, every switch disabled",
        (Ad.match(/data-step="/g) ?? []).length === 7 && !/Send now<\/button>/.test(Ad) && !/Mark as sent by me<\/button>/.test(Ad) && !Ad.includes("Copy portal link") && /Send now<\/button>/.test(O) && /Mark as sent by me<\/button>/.test(O) &&
        (Ad.match(/role="switch"/g) ?? []).length === 9 && (Ad.match(/<button[^>]*role="switch"[^>]*>/g) ?? []).every((tag) => /\sdisabled=""/.test(tag)),
        [...new Set((Ad.match(/<button[^>]*role="switch"[^>]*>/g) ?? []))].slice(0, 2).join(" ") + ` · Send now ${/Send now<\/button>/.test(Ad)} · Mark ${/Mark as sent by me<\/button>/.test(Ad)} · Copy ${Ad.includes("Copy portal link")}`);
      const leak = ["erica@example.test", "6105550101"].map((x) => { const i = Ad.indexOf(x); return i < 0 ? "" : `${x} at …${Ad.slice(Math.max(0, i - 120), i + 40)}…`; }).filter(Boolean).join(" | ");
      c.ok("admin: addresses are masked (no full email or phone anywhere)", !leak && Ad.includes("er…@example.test"), leak);
      const enr = await prisma.contentEnrollment.findUnique({ where: { id: A.enrollmentId }, select: { portalToken: true } });
      c.ok("rendering minted no portal link", !enr?.portalToken);
      // A token issued elsewhere is kept out of the admin's view.
      await prisma.contentEnrollment.update({ where: { id: A.enrollmentId }, data: { portalToken: "tok_onboarding_drill_private_123456", portalTokenIssuedAt: now } });
      const adminTree2 = await page({ searchParams: Promise.resolve({ client: A.id }) });
      const Ad2 = renderToStaticMarkup(createElement(ClientOnboardingPanel, elements(adminTree2, "ClientOnboardingPanel")[0] as Parameters<typeof ClientOnboardingPanel>[0]));
      await signIn(owner);
      const ownerTree2 = await page({ searchParams: Promise.resolve({ client: A.id }) });
      const O2 = renderToStaticMarkup(createElement(ClientOnboardingPanel, elements(ownerTree2, "ClientOnboardingPanel")[0] as Parameters<typeof ClientOnboardingPanel>[0]));
      c.ok("the client's private portal link is in the owner's composed messages and hidden from the admin's", O2.includes("/portal/tok_onboarding_drill_private_123456") && !Ad2.includes("tok_onboarding_drill_private_123456") && Ad2.includes("[their portal link]"));
      const at390 = /md:grid-cols-\[minmax\(0,15rem\)_minmax\(0,1fr\)\]/.test(O) && /md:hidden/.test(O);
      c.ok("phone layout: one column with the client list folded into a disclosure below md (390px)", at390);
    }

    c.ok("nothing outside the machine was contacted (Gmail and OpenPhone were answered in-process; nothing else was asked)", fence.blocked.length === 0 && fence.faked.every((u) => /googleapis\.com|api\.openphone\.com/.test(u)), fence.blocked.join(", "));
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
