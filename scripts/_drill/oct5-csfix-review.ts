// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: the Oct 5 2026 adversarial review of Settings → Client onboarding and
// the per-client rollout — seven fixes, each proved here by checks that FAIL
// on the code before the fix.
//
// Jordan, verbatim: "Don't send any notifications without my written approval.
// Don't even send anything. I will send it… give me a control panel… I'll do
// each client one by one… I can customize what gets sent or not sent."
//
//   1  HIGH  the OLD Settings pilot card ("Add a pilot client", "Change the
//            pilot") rebuilt the pilot with one shared list, wiping every
//            client's own choices: once anybody has their own choices it
//            refuses those writes and sends Jordan to Client onboarding; the
//            end date / note, Take out and the mode keep everyone exact; its
//            words name only clients who actually get something.
//   2  MED   after "Only my TEST clients", the next onboarding toggle flipped
//            the mode back and resurrected everyone's old choices, while the
//            message said "nobody else was turned on": now refused, naming
//            them, with "Turn on for <client> only"; the message is computed
//            from who is reached before and after.
//   3  MED   an ADMIN's outbox Retry could re-send an unconfirmed onboarding
//            message: owner only now, and the re-send is logged on the client.
//   4  MED   Jordan's own messages rode the "Program emails" toggle, which also
//            lets the automatic emails through: separate "Messages I send
//            myself" (manual_messages); the welcome also needs the account;
//            the copy says what each switch WOULD do, never "also needs".
//   5  LOW   the sign-in button's POST with neither a same-origin Origin nor
//            Sec-Fetch-Site: same-origin was accepted (and the page's
//            no-referrer policy made browsers send Origin: null).
//   6  LOW   the publication-gate writer skipped cuts with a client decision /
//            review window that every reader gated: one predicate now.
//   7  LOW   the "Portal account" toggle says approved monthly videos are put
//            in the portal by the hourly check (no message); a send the
//            outbox recovery drain delivers is written in the onboarding log.
//
// ISOLATION: PGlite on 127.0.0.1:6750 (DRILL_PORT overrides; this builder's
// range is 6750-6769). Gmail and OpenPhone are answered in-process at the HTTP
// fence (the shipped provider code runs and every send is recorded); every
// other outbound call is blocked. Nothing reaches a client or a provider.
// ---------------------------------------------------------------------------
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { buildContentMonth } from "./_fixtures/contentMonth";

const PORT = Number(process.env.DRILL_PORT ?? 6750);
const CRON_SECRET = "csfix-drill-cron-secret";

installNextStubs();

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

type Props = Record<string, unknown>;
function elements(tree: unknown, name: string): Props[] {
  if (Array.isArray(tree)) return tree.flatMap((part) => elements(part, name));
  if (!isValidElement<Props>(tree)) return [];
  const type = tree.type as string | { name?: string };
  return [...((typeof type === "string" ? type : type.name) === name ? [tree.props] : []), ...Object.values(tree.props).flatMap((part) => elements(part, name))];
}
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void } };
navigation.useRouter = () => ({ refresh() {} });

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-csfix-review", NEXT_PUBLIC_APP_URL: "https://hub.example.test", CRON_SECRET } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { setSession } = await import("@/lib/auth/session");
    const R = await import("@/lib/programRollout");
    const core = await import("@/lib/programRolloutCore");
    const ob = await import("@/lib/clientOnboarding");
    const obc = await import("@/lib/clientOnboardingCore");
    const A_ = await import("@/app/settings/onboarding/actions");
    const ra = await import("@/app/settings/rolloutActions");
    const G = await import("@/lib/programRolloutGate");
    type Op = import("@/lib/programRolloutCore").ProgramReachOp;

    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    await saveSecret("openphone", "drill-key-not-a-real-one");
    const now = new Date();
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan@csfix.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle@csfix.test", role: "ADMIN", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });
    const mkClient = async (name: string, email: string, phone: string | null = null) => {
      const client = await prisma.client.create({ data: { name, email, phone, firstSeenAt: now } });
      const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, status: "ACTIVE" } });
      return { ...client, enrollmentId: enrollment.id };
    };
    const A = await mkClient("Erica Example", "erica@example.test");
    const B = await mkClient("Kristin Example", "kristin@example.test");
    const C = await mkClient("Carla Example", "carla@example.test");
    const D = await mkClient("Dana Example", "dana@example.test", "(610) 555-0144");
    const E = await mkClient("Evan Example", "evan@example.test");
    const H = await mkClient("Hana Example", "hana@example.test");
    const rolloutRow = async () => (await prisma.appSetting.findUnique({ where: { key: core.PROGRAM_ROLLOUT_SETTING_KEY } }))?.value ?? null;
    const stored = async () => core.parseProgramRollout(await rolloutRow()).rollout;
    const reach = async (op: Op, id: string) => (await R.programReach(op, id)).ok;
    const reachedAny = async (id: string) => (await Promise.all(core.PROGRAM_REACH_OPS.filter((op) => core.pilotGroupOf(op)).map((op) => reach(op, id)))).some(Boolean);
    const setSwitch = (key: string, enabled: boolean, configJson: string | null = null) =>
      prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: enabled ? new Date() : null, enabledBy: "drill", configJson }, update: { enabled, enabledAt: enabled ? new Date() : null, configJson } });

    // =========================================================================
    c.head("2 · 'Only my TEST clients', then a toggle: nobody else comes back on");
    {
      await signIn(owner);
      const a1 = await A_.setOnboardingToggleAction({ clientId: A.id, toggle: "accounts", on: true });
      const b1 = await A_.setOnboardingToggleAction({ clientId: B.id, toggle: "caption_assistant", on: true }); // Oct 6 2026: the layout toggle is gone
      c.ok("(setup) A gets portal accounts, B the caption assistant, each their own list; the rollout is named clients", a1.ok && b1.ok && (await stored()).mode === "PILOT" && (await reach("portal_sign_in", A.id)) && (await reach("caption_assistant", B.id)), `${a1.message} | ${b1.message}`);
      const testOnly = await ra.setProgramRolloutModeAction({ mode: "TEST_ONLY" });
      c.ok("(setup) Jordan sets Who the program may reach back to 'Only my TEST clients': A and B are reached for nothing", testOnly.ok && !(await reachedAny(A.id)) && !(await reachedAny(B.id)), testOnly.message);
      const before = await rolloutRow();
      const audits = await prisma.auditLog.count({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY } });
      const cOn = await A_.setOnboardingToggleAction({ clientId: C.id, toggle: "emails", on: true });
      c.ok("turning something on for C is REFUSED: the list would wake A and B with their old choices",
        !cOn.ok && /Only my TEST clients/.test(cOn.message) && /Erica Example/.test(cOn.message) && /Kristin Example/.test(cOn.message) && /Turn on for Carla Example only/.test(cOn.message) && /Nothing was changed/.test(cOn.message), cOn.message);
      c.ok("…the refusal names them for the one-press way through (othersOnFile)", JSON.stringify([...(cOn.othersOnFile ?? [])].sort()) === JSON.stringify(["Erica Example", "Kristin Example"]), JSON.stringify(cOn.othersOnFile));
      c.ok("…NOTHING was written: the stored rollout is byte-identical, no audit row, still TEST only, and A, B and C are reached for nothing",
        (await rolloutRow()) === before && (await prisma.auditLog.count({ where: { target: core.PROGRAM_ROLLOUT_SETTING_KEY } })) === audits && (await stored()).mode === "TEST_ONLY" &&
        !(await reachedAny(A.id)) && !(await reachedAny(B.id)) && !(await reachedAny(C.id)));
      const only = await A_.setOnboardingToggleAction({ clientId: C.id, toggle: "emails", on: true, onlyThisClient: true });
      const st = await stored();
      c.ok("'Turn on for Carla only': C is reached for the automatic emails, the rollout is named clients again",
        only.ok && st.mode === "PILOT" && (await reach("reminders", C.id)) && (await reach("program_message_notice", C.id)), only.message);
      c.ok("…A and B are set to nothing (own empty lists) and reached for nothing", st.pilot?.clientOps?.[A.id]?.length === 0 && st.pilot?.clientOps?.[B.id]?.length === 0 && !(await reachedAny(A.id)) && !(await reachedAny(B.id)), JSON.stringify(st.pilot?.clientOps));
      c.ok("…and the words say exactly that: who was set to nothing, and 'Nobody else was turned on' (true)",
        /Set to nothing, so they were not turned back on: (Erica Example and Kristin Example|Kristin Example and Erica Example)\./.test(only.message) && /Nobody else was turned on\./.test(only.message) && /it was TEST clients only/.test(only.message) && /Nothing was sent/.test(only.message), only.message);
      c.ok("…and nothing was sent", sent.length === 0 && (await prisma.outboxMessage.count()) === 0);
    }

    // =========================================================================
    c.head("1 · the old Settings pilot card never rebuilds anyone's own choices");
    {
      await signIn(owner);
      const before = await rolloutRow();
      const add = await ra.addProgramPilotClientAction({ clientId: D.id, typedName: D.name, groups: core.PROGRAM_PILOT_GROUPS.map((g) => g.key) });
      c.ok("'Add a pilot client' (every group ticked) is REFUSED once clients have their own choices, and points to Client onboarding",
        !add.ok && /Client onboarding/.test(add.message) && /Nothing was changed/.test(add.message), add.message);
      c.ok("…nothing was written: A and B still get nothing, C exactly the emails, D nothing",
        (await rolloutRow()) === before && !(await reachedAny(A.id)) && !(await reachedAny(B.id)) && !(await reachedAny(D.id)) && (await reach("reminders", C.id)) && !(await reach("portal_sign_in", C.id)));
      const editGroups = await ra.editProgramPilotAction({ groups: ["emails", "bookings"] });
      c.ok("'Change the pilot' with group ticks is refused too (what each client gets is per client now)", !editGroups.ok && /Client onboarding/.test(editGroups.message) && (await rolloutRow()) === before, editGroups.message);
      const ownBefore = JSON.stringify((await stored()).pilot?.clientOps);
      const end = new Date(Date.now() + 20 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const editEnd = await ra.editProgramPilotAction({ expiresOnET: end });
      const after = await stored();
      c.ok("…changing only the END DATE works and keeps every client's own choices exactly", editEnd.ok && JSON.stringify(after.pilot?.clientOps) === ownBefore && !!after.pilot?.expiresAt, editEnd.message);
      c.ok("…and its words name only the client who gets something (C), never A or B", /each client keeps exactly their own choices/.test(editEnd.message) && /Carla Example/.test(editEnd.message) && !/Erica Example|Kristin Example/.test(editEnd.message), editEnd.message);
      await ra.setProgramRolloutModeAction({ mode: "TEST_ONLY" });
      const back = await ra.setProgramRolloutModeAction({ mode: "PILOT" });
      c.ok("choosing named clients again on purpose: the words name C only — A and B were set to nothing and are not reached",
        back.ok && /Carla Example/.test(back.message) && !/Erica Example|Kristin Example/.test(back.message) && !(await reachedAny(A.id)) && !(await reachedAny(B.id)) && (await reach("reminders", C.id)), back.message);
      const panel = await ra.loadProgramRolloutPanel();
      if ("error" in panel) throw new Error(panel.error);
      const { ProgramRolloutPanel, EditPilotForm } = await import("@/components/settings/ProgramRolloutPanel");
      const html = renderToStaticMarkup(createElement(ProgramRolloutPanel, { isOwner: true, initial: panel })).replace(/<!-- -->/g, "");
      const editHtml = renderToStaticMarkup(createElement(EditPilotForm, { data: panel, busy: false, onSave() {} }));
      c.ok("the card offers no 'Add a pilot client'; it sends Jordan to Client onboarding instead", !html.includes("Add a pilot client") && html.includes("data-per-client-home") && html.includes('href="/settings/onboarding"') && html.includes("Change when it ends"), html.slice(html.indexOf("Pilot"), html.indexOf("Pilot") + 200));
      c.ok("…its edit form has the end date only — no group ticks", !/type="checkbox"/.test(editHtml) && editHtml.includes('type="date"') && editHtml.includes("Change when the pilot ends"));
      const kept = JSON.stringify((await stored()).pilot?.clientOps?.[A.id]) + JSON.stringify((await stored()).pilot?.clientOps?.[B.id]);
      const out = await ra.removeProgramPilotClientAction({ clientId: C.id });
      c.ok("'Take out of the pilot' (a stop) keeps everyone else's own choices exactly", out.ok && JSON.stringify((await stored()).pilot?.clientOps?.[A.id]) + JSON.stringify((await stored()).pilot?.clientOps?.[B.id]) === kept && !(await reachedAny(C.id)), out.message);
      // A pilot made on this card before Oct 5 (no per-client choices) still works as it did.
      await ra.endProgramPilotAction();
      const legacy = await ra.addProgramPilotClientAction({ clientId: D.id, typedName: D.name, groups: ["portal_changes"] });
      c.ok("(unchanged) with no per-client choices on file, the old card still adds a client the old way", legacy.ok && (await reach("caption_assistant", D.id)) && !(await reach("reminders", D.id)), legacy.message);
      await ra.endProgramPilotAction();
    }

    // =========================================================================
    c.head("4 · Jordan's own messages have their own toggle; 'Program emails' is the automatic ones");
    {
      await signIn(owner);
      c.ok("the toggles: 'Messages I send myself' (no switch) beside 'Automatic program emails'",
        obc.toggleOf("messages").ops.join() === "manual_messages" && obc.toggleOf("messages").switches.length === 0 && obc.toggleOf("emails").label === "Automatic program emails" &&
        !obc.toggleOf("emails").ops.includes("manual_messages" as Op) && obc.STEP3_TOGGLES.some((t) => t.key === "messages"));
      c.ok("every message needs 'Messages I send myself'; the welcome also needs the portal account; none needs an automatic email op",
        obc.ONBOARDING_MESSAGES.every((m) => m.ops.includes("manual_messages" as Op) && !m.ops.some((op) => ["reminders", "script_share_email", "program_message_notice"].includes(op))) &&
        obc.messageOf("welcome").ops.join() === "manual_messages,portal_invites");
      const dOn = await A_.setOnboardingToggleAction({ clientId: D.id, toggle: "messages", on: true });
      c.ok("D: 'Messages I send myself' on — the words say a message goes only when Jordan presses Send now", dOn.ok && /A message goes only when you press Send now/.test(dOn.message) && /Nothing was sent/.test(dOn.message), dOn.message);
      c.ok("…D is reached for manual messages and for NO automatic email", (await reach("manual_messages", D.id)) && !(await reach("reminders", D.id)) && !(await reach("script_share_email", D.id)) && !(await reach("program_message_notice", D.id)));
      const eOn = await A_.setOnboardingToggleAction({ clientId: E.id, toggle: "emails", on: true });
      c.ok("E: 'Automatic program emails' on — the words say what each switch WOULD do, never 'also needs'",
        eOn.ok && /Client reminders \(off\) — would email them reminders on its own/.test(eOn.message) && /Those switches are all off, so nothing happens for Evan Example/.test(eOn.message) && !/also on|Also needs|only does anything/i.test(eOn.message), eOn.message);
      // Every automatic switch ON, locks lifted, exactly as a launch would leave them.
      await setSwitch("reminders", true, JSON.stringify({ testClientsOnly: false }));
      await setSwitch("script_share_email", true);
      await setSwitch("program_message_notice", true);
      const row = (key: string, clientId: string, toRef: string) => ({
        id: "g", channel: "email", toRef, body: "b", state: "attempting", attempts: 0, leaseUntil: null, leaseBy: null, providerId: null, providerError: null,
        dedupeKey: key, requestedBy: "drill", clientId, projectId: null, taskId: null, createdAt: new Date(), acceptedAt: null, resolvedAt: null, extraToRefsJson: null, mediaUrlsJson: null,
      });
      const dRem = await G.programDispatchGate(row(`program_reminder:x:d1:2026-10`, D.id, "dana@example.test"));
      const dMsg = await G.programDispatchGate(row(`program_message:e-d:1`, D.id, "dana@example.test"));
      const eRem = await G.programDispatchGate(row(`program_reminder:x:e1:2026-10`, E.id, "evan@example.test"));
      c.ok("with every automatic switch ON: an automatic reminder or office-replied email to D (manual messages only) is refused at sending", !dRem.ok && !dMsg.ok && dRem.code === "not_in_rollout_scope", JSON.stringify([dRem, dMsg]));
      c.ok("…while E (automatic emails on) passes — the gate decides by the toggle, not by the switch alone", eRem.ok, JSON.stringify(eRem));
      const dNote = await A_.sendOnboardingMessageAction({ clientId: D.id, message: "note", channel: "email", toRef: "dana@example.test", body: "Hi Dana, Jordan here.", intentId: "csfix-press-d-note" });
      c.ok("Jordan's note to D goes (Send now), to D's address, with his words", dNote.ok && sent.length === 1 && sent[0].to === "dana@example.test" && sent[0].body === "Hi Dana, Jordan here.", dNote.message);
      const eNote = await A_.sendOnboardingMessageAction({ clientId: E.id, message: "note", channel: "email", toRef: "evan@example.test", body: "Hi Evan", intentId: "csfix-press-e-note" });
      c.ok("…Jordan's note to E (automatic emails only) is REFUSED, naming 'Messages I send myself'; nothing sent", !eNote.ok && /Turn on "Messages I send myself" for Evan Example/.test(eNote.message) && sent.length === 1, eNote.message);
      c.ok("…and the dispatch gate refuses E's note at sending too", (await G.onboardingGate(row(`onboarding:note:${E.id}:csfixgate01`, E.id, "evan@example.test")) as { ok: boolean; code?: string }).code === "not_in_rollout_scope");
      await A_.setOnboardingToggleAction({ clientId: H.id, toggle: "accounts", on: true });
      const hWelcome = (await ob.loadOnboardingDetail(H.id))!.messages.find((m) => m.key === "welcome")!;
      const hSend = await A_.sendOnboardingMessageAction({ clientId: H.id, message: "welcome", channel: "email", toRef: "hana@example.test", body: "Welcome, Hana.", intentId: "csfix-press-h-welcome" });
      c.ok("H (portal account only): the welcome is held behind 'Messages I send myself', and Send is refused", !hWelcome.allowed && /Turn on "Messages I send myself" for Hana Example/.test(hWelcome.blockedWhy ?? "") && !hSend.ok && sent.length === 1, `${hWelcome.blockedWhy} | ${hSend.message}`);
      await A_.setOnboardingToggleAction({ clientId: H.id, toggle: "messages", on: true });
      const hWelcome2 = (await ob.loadOnboardingDetail(H.id))!.messages.find((m) => m.key === "welcome")!;
      const dWelcome = (await ob.loadOnboardingDetail(D.id))!.messages.find((m) => m.key === "welcome")!;
      c.ok("…with both on the welcome is allowed; D (messages, no account) still needs 'Portal account and sign-in'", hWelcome2.allowed && !dWelcome.allowed && /"Portal account and sign-in"/.test(dWelcome.blockedWhy ?? "") && !/"Messages I send myself"/.test(dWelcome.blockedWhy ?? ""), dWelcome.blockedWhy ?? "");
      const { default: page } = await import("@/app/settings/onboarding/page");
      const { ClientOnboardingPanel } = await import("@/components/settings/ClientOnboardingPanel");
      const tree = await page({ searchParams: Promise.resolve({ client: E.id }) });
      const O = renderToStaticMarkup(createElement(ClientOnboardingPanel, elements(tree, "ClientOnboardingPanel")[0] as Parameters<typeof ClientOnboardingPanel>[0])).replace(/<!-- -->/g, "");
      c.ok("the page: eight switches (the layout toggle retired Oct 6 2026), 'Messages I send myself' with no switch line, each automatic switch with what it would do — no 'Also needs'",
        (O.match(/role="switch"/g) ?? []).length === 8 && O.includes("Messages I send myself") && O.includes("Automatic program emails") && O.includes("would email them reminders on its own") &&
        O.includes("would email a welcome on its own when they pay") && !O.includes("Also needs"), (O.match(/role="switch"/g) ?? []).length + " switches");
      await setSwitch("reminders", false, null);
      await setSwitch("script_share_email", false);
      await setSwitch("program_message_notice", false);
    }

    // =========================================================================
    c.head("3 · Retry of an unconfirmed onboarding send is the owner's alone");
    {
      const key = `onboarding:note:${D.id}:csfix-unknown-0001`;
      const held = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "dana@example.test", body: "Hi Dana — the note that may not have landed.", state: "unknown", attempts: 1, providerError: "provider timed out", dedupeKey: key, requestedBy: `onboarding:${owner.email}`, clientId: D.id } });
      const { retryUnknownSend } = await import("@/app/tasks/sendAllActions");
      const before = sent.length;
      await signIn(admin);
      const byAdmin = await retryUnknownSend(held.id);
      const still = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: held.id } });
      c.ok("Kyle (admin) presses Retry on Jordan's unconfirmed onboarding note → refused, nothing sent, the row untouched",
        !byAdmin.ok && /Only Jordan can re-send an onboarding message/.test(byAdmin.message) && sent.length === before && still.state === "unknown" && still.dedupeKey === key, byAdmin.message);
      await signIn(owner, admin.id);
      let preview = "";
      try { preview = (await retryUnknownSend(held.id)).message; } catch (e) { preview = e instanceof Error ? e.message : String(e); }
      c.ok("…Jordan previewing as Kyle → refused too", /previewing|Only Jordan/.test(preview) && sent.length === before, preview);
      const other = await prisma.outboxMessage.create({ data: { channel: "sms", toRef: "6105550199", body: "Team ping", state: "unknown", attempts: 1, providerError: "timeout", dedupeKey: "staff:tm-csfix:2026-10-05T12:00:00.000Z", requestedBy: "drill" } });
      await signIn(admin);
      const adminOther = await retryUnknownSend(other.id);
      c.ok("(unchanged) an admin may still retry other kinds — the owner rule is onboarding only", !/Only Jordan/.test(adminOther.message), adminOther.message);
      await signIn(owner);
      const byOwner = await retryUnknownSend(held.id);
      const rec = await ob.readOnboardingRecord(D.id);
      const last = rec.log[rec.log.length - 1];
      c.ok("Jordan's own Retry sends it once, to the address on file", byOwner.ok && sent.filter((s) => s.to === "dana@example.test" && s.body.includes("may not have landed")).length === 1, byOwner.message);
      c.ok("…and it is written in D's onboarding log as sent, re-sent by Jordan (so the page shows it, and nobody presses twice)",
        last.kind === "sent" && last.message === "note" && last.by === owner.email && /re-sent by/.test(last.detail ?? "") && !!last.outboxId && last.outboxId !== held.id &&
        (await prisma.auditLog.count({ where: { action: "client_onboarding_send_retried", target: D.id } })) === 1, JSON.stringify(last));
    }

    // =========================================================================
    c.head("7 · 'Portal account' says what happens on its own; a recovered send is logged");
    {
      const words = obc.toggleOf("accounts").words;
      c.ok("the 'Portal account and sign-in' words say approved monthly videos are put in the portal by the hourly check, with no message",
        /approved monthly video is put in their portal automatically by the hourly check/.test(words) && /sends them no message/.test(words), words);
      const intent = "csfix-press-recovered-0001";
      const key = `onboarding:strategy_call:${D.id}:${intent}`;
      // The worker that took Jordan's press stopped before handing it over: the row sits pending.
      const pending = await prisma.outboxMessage.create({ data: { channel: "email", toRef: "dana@example.test", body: "Hi Dana, grab a time for your strategy call.", state: "pending", dedupeKey: key, requestedBy: `onboarding:${owner.email}`, clientId: D.id } });
      const { NextRequest } = await import("next/server");
      const { GET } = await import("@/app/api/cron/gmail/route");
      const before = sent.length;
      await GET(new NextRequest("http://127.0.0.1/api/cron/gmail", { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
      const row = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: pending.id } });
      c.ok("(the cron's recovery drain sends the stranded press once — the existing outbox behaviour)", row.state === "accepted" && sent.length === before + 1 && sent[sent.length - 1].subject === "Book your RealTour Pilot strategy call", `${row.state} ${sent.length - before}`);
      const rec = await ob.readOnboardingRecord(D.id);
      const logged = rec.log.filter((e) => e.outboxId === pending.id && e.kind === "sent");
      c.ok("NEW: the recovered send is written in D's onboarding log, as Jordan's press, saying the hub sent it after an interruption",
        logged.length === 1 && logged[0].message === "strategy_call" && logged[0].by === owner.email && /first try was interrupted/.test(logged[0].detail ?? "") &&
        (await prisma.auditLog.count({ where: { action: "client_onboarding_send_recovered", target: D.id } })) === 1, JSON.stringify(rec.log.slice(-1)));
      const d = (await ob.loadOnboardingDetail(D.id))!;
      c.ok("…so step 5 shows 'Book your strategy call' as sent (no second press invited)", d.messages.find((m) => m.key === "strategy_call")?.last?.kind === "sent");
      await GET(new NextRequest("http://127.0.0.1/api/cron/gmail", { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
      c.ok("…and a second cron run neither sends nor logs it again", sent.length === before + 1 && (await ob.readOnboardingRecord(D.id)).log.filter((e) => e.outboxId === pending.id).length === 1);
    }

    // =========================================================================
    c.head("5 · the sign-in button's POST must prove it came from this site");
    {
      const pa = await import("@/lib/portalAccess");
      const route = await import("@/app/portal/auth/[token]/route");
      const { NextRequest } = await import("next/server");
      const F = await buildContentMonth(prisma, { name: "Sign In TEST", owner: { email: "signin@realtourpilot.com", name: "Sign In Owner" } });
      const mint = async () => { const l = await pa.mintLoginLink(F.membershipId!, null, { emailed: true }); return { url: l.url, raw: new URL(l.url).pathname.split("/").pop()! }; };
      const post = (url: string, raw: string, headers: Record<string, string>) => route.POST(new NextRequest(url, { method: "POST", headers }), { params: Promise.resolve({ token: raw }) });
      const refused = (r: Response) => r.status === 303 && /\/portal\/login\?reason=invalid/.test(r.headers.get("location") ?? "") && !(r as unknown as { cookies: { get: (k: string) => unknown } }).cookies.get("rtp_client");
      const L = await mint();
      const page = await route.GET(new NextRequest(L.url), { params: Promise.resolve({ token: L.raw }) });
      const html = await page.text();
      c.ok("the button's page asks the browser to send its origin (Referrer-Policy same-origin, not no-referrer, which makes a browser send Origin: null)",
        page.headers.get("referrer-policy") === "same-origin" && html.includes('<meta name="referrer" content="same-origin">'), `${page.headers.get("referrer-policy")}`);
      const none = await post(L.url, L.raw, {});
      c.ok("a POST with NEITHER a same-origin Origin NOR Sec-Fetch-Site: same-origin is refused, and spends nothing", refused(none) && (await pa.peekLoginToken(L.raw)).ok, none.headers.get("location") ?? "");
      const nullOnly = await post(L.url, L.raw, { origin: "null" });
      const crossFetch = await post(L.url, L.raw, { "sec-fetch-site": "cross-site" });
      const forged = await post(L.url, L.raw, { origin: "https://evil.invalid", host: "hub.invalid", "sec-fetch-site": "same-origin" });
      c.ok("…so is Origin: null alone, Sec-Fetch-Site: cross-site, and another site's Origin whatever else it says; the link is still good",
        refused(nullOnly) && refused(crossFetch) && refused(forged) && (await pa.peekLoginToken(L.raw)).ok);
      const nullSame = await post(L.url, L.raw, { origin: "null", "sec-fetch-site": "same-origin" });
      c.ok("a browser on an older cached page (Origin: null) with Sec-Fetch-Site: same-origin signs in", nullSame.status === 303 && !!nullSame.cookies.get("rtp_client")?.value && !(await pa.peekLoginToken(L.raw)).ok, nullSame.headers.get("location") ?? "");
      const L2 = await mint();
      const sameOrigin = await post(L2.url, L2.raw, { origin: "https://hub.invalid", host: "hub.invalid" });
      c.ok("a same-origin Origin signs in", sameOrigin.status === 303 && !!sameOrigin.cookies.get("rtp_client")?.value, sameOrigin.headers.get("location") ?? "");
    }

    // =========================================================================
    c.head("6 · the publication gate: one predicate for the writer and every reader");
    {
      const cv = await import("@/lib/contentVideos");
      const ce = await import("@/lib/cutEntitlement");
      const { streamUrlFor } = await import("@/lib/reviewCuts");
      const M = await buildContentMonth(prisma, { name: "Gate Month TEST", owner: false });
      let seq = 0;
      const mkCut = async (label: string, data: Record<string, unknown>) => {
        const row = await prisma.reviewSubmission.create({ data: { projectId: M.projectId!, deliverableId: M.deliverableId, slot: ++seq, round: 1, source: "upload", sizeBytes: 5, fileName: `${label}.mp4`, status: "APPROVED", decidedBy: "James", decidedAt: new Date(), ...data }, select: { id: true } });
        await prisma.reviewSubmission.update({ where: { id: row.id }, data: { assetUrl: streamUrlFor(row.id), blobUrl: `https://drill.invalid/${row.id}.mp4`, blobPathname: `review-cuts/${row.id}.mp4` } });
        return { label, id: row.id };
      };
      const cuts = [
        await mkCut("plain", {}),
        await mkCut("decision-set-aside", {}),
        await mkCut("window-row", {}),
        await mkCut("released", { clientReleasedAt: new Date() }),
        await mkCut("sent", { sentToClientAt: new Date() }),
        await mkCut("client-approved", { clientApprovedDecisionId: "csfix-decision" }),
        await mkCut("before-gate", { decidedAt: new Date("2026-10-01T12:00:00Z") }),
      ];
      const byLabel = (l: string) => cuts.find((x) => x.label === l)!.id;
      // A client decision that was set aside, and a review window row — neither of the predicate's four facts.
      await prisma.clientDecision.create({ data: { submissionId: byLabel("decision-set-aside"), projectId: M.projectId!, enrollmentId: M.enrollmentId, clientId: M.clientId, decision: "APPROVE", actorLabel: "drill", receiptState: "SUPERSEDED" } });
      await prisma.contentReviewWindow.create({ data: { submissionId: byLabel("window-row"), videoKey: `${M.projectId}:w`, projectId: M.projectId!, enrollmentId: M.enrollmentId, clientId: M.clientId, round: 1, openedAt: new Date(), deadlineAt: new Date(Date.now() + 4 * 86_400_000), state: "SUPERSEDED" } });
      const ids = cuts.map((x) => x.id);
      const rows = await prisma.reviewSubmission.findMany({ where: { id: { in: ids } } });
      const pred = new Map(rows.map((r) => [r.id, !!cv.publicationRequiredAt(r, true)]));
      const where = new Set((await prisma.reviewSubmission.findMany({ where: { id: { in: ids }, ...cv.impliedPublicationGateWhere() }, select: { id: true } })).map((r) => r.id));
      const files = await ce.clientCutFiles(ids);
      const stampedN = await cv.stampImpliedPublicationGates({ projectIds: [M.projectId!] });
      const after = new Map((await prisma.reviewSubmission.findMany({ where: { id: { in: ids } }, select: { id: true, portalPublicationRequiredAt: true } })).map((r) => [r.id, !!r.portalPublicationRequiredAt]));
      const table = cuts.map((x) => `${x.label}: predicate=${pred.get(x.id)} where=${where.has(x.id)} reader=${files.get(x.id)?.kind === "finishing"} writer=${after.get(x.id)}`);
      c.ok("the writer stamps EXACTLY the cuts the predicate, its query form and the client's file reader gate — including a cut with a set-aside decision or a review window row",
        cuts.every((x) => pred.get(x.id) === where.has(x.id) && where.has(x.id) === (files.get(x.id)?.kind === "finishing") && (files.get(x.id)?.kind === "finishing") === after.get(x.id)), table.join(" · "));
      c.ok("…three gated (plain, set-aside decision, window row), four not (released, sent, client-approved, before the gate)",
        stampedN === 3 && ["plain", "decision-set-aside", "window-row"].every((l) => after.get(byLabel(l))) && ["released", "sent", "client-approved", "before-gate"].every((l) => !after.get(byLabel(l))), `${stampedN} stamped`);
      c.ok("…so the hourly repair can publish them (it reads only stamped cuts)", (await prisma.reviewSubmission.count({ where: { id: { in: ids }, status: "APPROVED", portalPublicationRequiredAt: { not: null }, clientReleasedAt: null, sentToClientAt: null } })) === 3);
    }

    c.ok("only Gmail and OpenPhone were answered (in-process); every send above is accounted for", fence.faked.every((u) => /googleapis\.com|api\.openphone\.com/.test(u)) && sent.length === 4, `${sent.length} sends`);
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
