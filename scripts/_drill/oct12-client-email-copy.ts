// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: a copy of every client email to Jordan (Oct 12 2026).
//
// Jordan: "Anytime a client gets an email, I want to receive that email too so
// I can monitor what the emails look like."
//
//   1. The setting (AppSetting "client-email-monitor"): no row = ON to info@;
//      saved address and off switch round-trip; a corrupt row, an invalid
//      address and a database that throws all read as the default (ON);
//      an address carrying a header break can never be saved or used.
//   2. THE RAIL — every email kind the outbox sends, through the REAL Gmail
//      provider: each client kind goes out ONCE, to the client, with a true
//      `Bcc:` header naming the monitor, the client's subject and the client's
//      words untouched; `staff` (internal) carries no Bcc.
//   3. One-use sign-in links: the client's message is untouched (link and all,
//      no Bcc); Jordan gets a SEPARATE copy — same subject — with the link
//      replaced by "[sign-in link removed from your copy]", sent only after
//      the client's row reads accepted; a failed copy never changes the
//      client's outcome. Shared portal links are not touched.
//   4. Setting changes apply to the next send: another address, off (no Bcc,
//      no separate copy), unreadable (still Bcc to info@), recipient already
//      the monitor inbox, a team member's address.
//   5. No change to the client's own message: the raw MIME with the copy on
//      is byte-for-byte the raw MIME with it off, plus one Bcc header line;
//      what Gmail delivers to the client (Bcc stripped) is identical.
//   6. The REAL senders end to end: the exported outbox (welcome email), a
//      portal invitation, a portal sign-in request (the client's link still
//      signs THEM in after Jordan's copy went), the office-replied notice
//      sweep, the feedback reply on /quality, a threaded reply from a task
//      (client → Bcc; a team member's thread → none), and the owner's own
//      notification email (internal → none).
//   7. Settings: the owner saves (and an admin cannot), the card reads
//      "Every email a client gets is also sent to: … (blind copy)".
//
// ISOLATION: PGlite on 127.0.0.1:6960 (DRILL_PORT overrides). Gmail (and
// OpenPhone, for the one text) is answered in-process at the HTTP fence: the
// shipped provider code runs, and every raw message it hands Gmail is decoded
// and recorded. Every other outbound call is blocked.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrismaClient } from "@prisma/client";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6960);

// ---- the clock: Wed Oct 7 2026, 10:00 ET (inside every client window) --------
const RealDate = Date;
const PINNED = RealDate.UTC(2026, 9, 7, 14, 0, 0);
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

installNextStubs();

// ---- Gmail, answered in-process -------------------------------------------------
type Mail = {
  n: number; raw: string; head: string; body: string;
  to: string; bcc: string | null; bccLines: number; from: string; subject: string; threadId: string | null;
  /** What the To recipient receives: Gmail strips the Bcc header. */
  delivered: string;
  /** The outbox row this send belongs to, read at the moment Gmail was called (separate copies only). */
  rowStateAtSend?: string | null;
};
const mails: Mail[] = [];
const threads = new Map<string, { messages: { id: string; payload: { headers: { name: string; value: string }[] } }[] }>();
let failSendsTo: string | null = null;
let watchKey: string | null = null;
let prismaRef: PrismaClient | null = null;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { raw: string; threadId?: string };
    const raw = Buffer.from(sent.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const cut = raw.indexOf("\r\n\r\n");
    const head = raw.slice(0, cut);
    const body = raw.slice(cut + 4);
    const lines = head.split("\r\n");
    const val = (name: string) => lines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}: `))?.slice(name.length + 2) ?? "";
    const subjEnc = /^=\?UTF-8\?B\?(.+)\?=$/.exec(val("Subject"))?.[1];
    const bccLines = lines.filter((l) => /^bcc:/i.test(l)).length;
    const delivered = [...lines.filter((l) => !/^bcc:/i.test(l)), "", body].join("\r\n");
    const to = val("To").trim().toLowerCase();
    const m: Mail = {
      n: mails.length + 1, raw, head, body, to, bcc: bccLines ? val("Bcc").trim().toLowerCase() : null, bccLines,
      from: val("From"), subject: subjEnc ? Buffer.from(subjEnc, "base64").toString("utf8") : val("Subject"), threadId: sent.threadId ?? null, delivered,
    };
    if (watchKey && prismaRef) m.rowStateAtSend = (await prismaRef.outboxMessage.findFirst({ where: { dedupeKey: watchKey }, select: { state: true } }))?.state ?? null;
    mails.push(m);
    if (failSendsTo && to === failSendsTo) return json({ error: "drill: refused" }, 500);
    return json({ id: `gm-${m.n}` });
  }
  if (url.startsWith("https://api.openphone.com/v1/phone-numbers")) return json({ data: [{ id: "PNdrill", number: "+12155550000", name: "Office" }] });
  if (url.startsWith("https://api.openphone.com/v1/messages") && (init?.method ?? "GET").toUpperCase() === "POST") {
    const b = JSON.parse(String(init?.body ?? "{}")) as { to: string[]; content: string };
    texts.push({ to: b.to.join(","), body: b.content });
    return json({ data: { id: `op-${texts.length}` } }, 202);
  }
  if (u.hostname === "gmail.googleapis.com" && u.pathname.includes("/threads/")) {
    const id = u.pathname.split("/threads/")[1];
    const t = threads.get(id);
    return t ? json(t) : json({ error: "not found" }, 404);
  }
  return null;
});
const since = (i: number) => mails.slice(i);
const texts: { to: string; body: string }[] = [];

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-client-email-copy", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    prismaRef = prisma as unknown as PrismaClient;
    const M = await import("@/lib/clientEmailMonitor");
    const O = await import("@/lib/outbox");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    await saveSecret("openphone", "drill-key-not-a-real-one");
    const MONITOR = "info@realtourpilot.com";

    // The office.
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan-owner@drill.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle-admin@drill.test", role: "ADMIN", status: "ACTIVE" } });
    await prisma.teamMember.create({ data: { name: "Edna Editor", email: "edna.editor@gmail.com" } });
    const { setSession } = await import("@/lib/auth/session");
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const realClient = await prisma.client.create({ data: { name: "Rhea Real Realty", email: "rhea@example.test", firstSeenAt: new Date() } });

    // The rail, exactly as the hub builds it — the real table, the real Gmail
    // provider — without the rollout gate, so every kind can be driven here.
    const rail = O.createOutbox({ store: O.prismaOutboxStore(), provider: O.realOutboxProvider() });
    let seq = 0;
    const railSend = async (dedupeKey: string, toRef: string, body: string) => {
      const i = mails.length;
      const r = await rail.sendThroughOutbox({ channel: "email", toRef, body, dedupeKey, clientId: realClient.id, requestedBy: "drill" });
      return { r, out: since(i) };
    };
    const signInBody = (tok: string) => [
      "Hi Rhea,", "", "Your scripts are ready. Open them here:", `https://hub.example.test/portal/auth/${tok}?next=%2Fportal%2Fme%3Ftab%3Dtopics%26iv%3Dabcdefghij12`, "", "— Jordan",
    ].join("\n");

    // =========================================================================
    c.head("1. The setting");
    // =========================================================================
    {
      const d = await M.clientEmailMonitor();
      c.ok("no row: ON, to info@realtourpilot.com (source default)", d.enabled && d.address === MONITOR && d.source === "default", JSON.stringify(d));
      const s1 = await M.saveClientEmailMonitor({ enabled: true, address: " Ops-Monitor@Example.TEST " }, "jordan-owner@drill.test");
      c.ok("save: the address is stored clean (trimmed, lower-case), still on", s1.enabled && s1.address === "ops-monitor@example.test" && s1.source === "saved" && s1.updatedBy === "jordan-owner@drill.test", JSON.stringify(s1));
      const s2 = await M.saveClientEmailMonitor({ enabled: false, address: "ops-monitor@example.test" }, null);
      c.ok("save off: enabled false round-trips", !s2.enabled && s2.address === "ops-monitor@example.test", JSON.stringify(s2));
      let injected = "";
      try { await M.saveClientEmailMonitor({ enabled: true, address: "a@b.com\r\nBcc: evil@x.test" }, null); } catch (e) { injected = (e as Error).message; }
      c.ok("an address with a header break is refused at save, and the saved row is unchanged", /doesn't look like an email/.test(injected) && !(await M.clientEmailMonitor()).enabled, injected);
      c.ok("parse: corrupt JSON → ON to info@ (unreadable)", (() => { const p = M.parseClientEmailMonitor("{bad"); return p.enabled && p.address === MONITOR && p.source === "unreadable"; })());
      c.ok("parse: a stored address with a header break → the default address (unreadable)", (() => { const p = M.parseClientEmailMonitor(JSON.stringify({ enabled: true, address: "x@y.test\nBcc: evil@x.test" })); return p.enabled && p.address === MONITOR && p.source === "unreadable"; })());
      c.ok("parse: enabled must be literally false to be off (\"no\", 0, null read as on)", ["\"no\"", "0", "null"].every((v) => M.parseClientEmailMonitor(`{"enabled":${v},"address":"a@b.test"}`).enabled));
      // Back to no row for the rail.
      await prisma.appSetting.delete({ where: { key: M.CLIENT_EMAIL_MONITOR_KEY } });
    }

    // =========================================================================
    c.head("2. The rail: every client email kind carries a true Bcc to the monitor; staff does not");
    // =========================================================================
    const plainBody = (what: string) => `Hi Rhea,\n\n${what} — see your portal: https://hub.example.test/portal/sharedtok123456789\n\n— Jordan`;
    const kinds: { label: string; key: string }[] = [
      { label: "welcome (email fallback)", key: O.welcomeKey(realClient.id) },
      { label: "portal invitation", key: O.portalInviteKey("m-inv", new Date()) },
      { label: "portal welcome (portal_invite:…:welcome)", key: "portal_invite:m-wel:welcome" },
      ...["BOOK_SESSION", "REVIEW_WORK", "SESSION_REQUEST_FOLLOWUP", "CONFIRM_ADDRESS", "APPROVE_SCRIPTS", "PLAN_MONTH"].map((a) => ({ label: `program reminder ${a}`, key: O.programReminderKey(a, `rem-${a}`, "2026-10") })),
      { label: "scripts ready", key: O.scriptShareKey("rem-share") },
      { label: "strategy ready", key: O.strategyReadyKey("rem-strat") },
      { label: "office replied (program_message)", key: `program_message:msg-1:cu-1` },
      { label: "onboarding message Jordan sends", key: O.onboardingKey("welcome", realClient.id, "intent-1") },
      { label: "an unrecognised kind (default: a client's)", key: `misc:${++seq}` },
    ];
    for (const k of kinds) {
      const body = plainBody(k.label);
      const { r, out } = await railSend(k.key, "rhea@example.test", body);
      const m = out[0];
      const want = O.subjectFor(O.outboxKind(k.key), k.key);
      c.ok(
        `${k.label}: one send, To the client, Bcc ${MONITOR}, subject "${want}", the words untouched`,
        r.outcome === "accepted" && out.length === 1 && m.to === "rhea@example.test" && m.bcc === MONITOR && m.bccLines === 1 && m.subject === want && m.body === body,
        `${r.outcome} n=${out.length} to=${m?.to} bcc=${m?.bcc} subj=${m?.subject}`,
      );
    }
    {
      const { r, out } = await railSend(O.staffKey("tm-1", new Date()), "rhea@example.test", "Internal: Kyle, the 10:00 shoot moved.");
      c.ok("staff (internal) over email: sent, NO Bcc", r.outcome === "accepted" && out.length === 1 && out[0].bcc === null && out[0].bccLines === 0, `bcc=${out[0]?.bcc}`);
    }
    {
      const i = mails.length;
      const t = texts.length;
      const r = await rail.sendThroughOutbox({ channel: "sms", toRef: "6105550101", body: "Your shoot is confirmed for Thursday at 10.", dedupeKey: O.confirmationKey("p-sms", new Date()), clientId: realClient.id, requestedBy: "drill" });
      c.ok("a client TEXT is untouched: it goes to OpenPhone and nothing reaches Gmail (copies are email-only)", r.outcome === "accepted" && texts.length === t + 1 && mails.length === i, `${r.outcome} texts=${texts.length - t} mails=${mails.length - i}`);
    }

    // =========================================================================
    c.head("3. One-use sign-in links: a separate, redacted copy — never a Bcc");
    // =========================================================================
    const TOK = "A".repeat(20) + "b_c-" + "Z".repeat(19);
    for (const [label, key] of [
      ["portal sign-in email", O.portalLoginKey("cu-login", new Date())],
      ["program reminder with a 24h sign-in link", O.programReminderKey("REVIEW_WORK", "rem-link", "2026-10")],
      ["scripts-ready notice with a sign-in link", O.scriptShareKey("rem-share-link")],
    ] as const) {
      const body = signInBody(TOK);
      watchKey = key;
      const { r, out } = await railSend(key, "rhea@example.test", body);
      watchKey = null;
      const [client, copy] = out;
      const subject = O.subjectFor(O.outboxKind(key), key);
      c.ok(`${label}: the client's message goes out first, untouched (link and all) and with NO Bcc`, r.outcome === "accepted" && client?.to === "rhea@example.test" && client.bccLines === 0 && client.body === body && client.subject === subject, `${r.outcome} ${client?.to} bcc=${client?.bccLines}`);
      c.ok(`${label}: Jordan gets a SEPARATE copy, same subject, no Bcc on it`, out.length === 2 && copy.to === MONITOR && copy.bccLines === 0 && copy.subject === subject, `n=${out.length} to=${copy?.to} subj=${copy?.subject}`);
      c.ok(`${label}: …with the link replaced by "${M.SIGN_IN_LINK_REMOVED}" — no token, no /portal/auth/, the ?next= gone too`,
        !!copy && copy.body.includes(M.SIGN_IN_LINK_REMOVED) && !copy.body.includes(TOK) && !copy.body.includes("/portal/auth/") && !copy.body.includes("next=") && copy.body.includes("Your scripts are ready. Open them here:") && copy.body.includes("— Jordan"),
        copy?.body.slice(0, 220));
      c.ok(`${label}: …and it says whose copy it is`, !!copy && copy.body.startsWith("Your copy of the email sent to rhea@example.test."));
      c.ok(`${label}: the copy left only AFTER the client's row read accepted`, copy?.rowStateAtSend === "accepted", copy?.rowStateAtSend ?? "none");
      const row = await prisma.outboxMessage.findFirst({ where: { dedupeKey: key } });
      c.ok(`${label}: the outbox records the CLIENT's message (its Gmail id), nothing about the copy`, row?.state === "accepted" && row.providerId === `gm-${client.n}` && row.body === body, `${row?.state} ${row?.providerId}`);
    }
    {
      // The copy fails: the client's outcome does not move.
      failSendsTo = MONITOR;
      const key = O.portalLoginKey("cu-fail", new Date());
      const { r, out } = await railSend(key, "rhea@example.test", signInBody(TOK));
      failSendsTo = null;
      const row = await prisma.outboxMessage.findFirst({ where: { dedupeKey: key } });
      c.ok("a failed separate copy: the client's send is still accepted and recorded as such", r.outcome === "accepted" && row?.state === "accepted" && out.length === 2 && out[1].to === MONITOR, `${r.outcome} ${row?.state} n=${out.length}`);
    }
    {
      const { out } = await railSend(O.scriptShareKey("rem-token-only"), "rhea@example.test", plainBody("A shared portal link (not a sign-in)"));
      c.ok("a shared portal link (/portal/<token>) is kept: an ordinary Bcc", out.length === 1 && out[0].bcc === MONITOR && out[0].body.includes("/portal/sharedtok123456789"));
      const addr = "Hi Rhea,\n\nWhere are we filming? https://hub.example.test/portal/address/abcDEF123456789xyz\n\n— Jordan";
      const { out: o2 } = await railSend(O.programReminderKey("CONFIRM_ADDRESS", "rem-addr", "2026-10"), "rhea@example.test", addr);
      c.ok("the session-address form link is not a sign-in: an ordinary Bcc, link kept", o2.length === 1 && o2[0].bcc === MONITOR && o2[0].body === addr);
    }

    // =========================================================================
    c.head("4. Setting changes apply to the next send");
    // =========================================================================
    {
      await M.saveClientEmailMonitor({ enabled: true, address: "ops-monitor@example.test" }, null);
      const { out } = await railSend(`misc:${++seq}`, "rhea@example.test", plainBody("another address"));
      c.ok("a new address: the next email's Bcc names it", out.length === 1 && out[0].bcc === "ops-monitor@example.test", out[0]?.bcc ?? "none");
      const { out: o2 } = await railSend(O.portalLoginKey("cu-addr", new Date()), "rhea@example.test", signInBody(TOK));
      c.ok("…and a sign-in email's separate copy goes there too", o2.length === 2 && o2[1].to === "ops-monitor@example.test");

      await M.saveClientEmailMonitor({ enabled: false, address: "ops-monitor@example.test" }, null);
      const { r, out: o3 } = await railSend(`misc:${++seq}`, "rhea@example.test", plainBody("switched off"));
      c.ok("OFF: the client's email goes, with no Bcc", r.outcome === "accepted" && o3.length === 1 && o3[0].bccLines === 0);
      const { r: r4, out: o4 } = await railSend(O.portalLoginKey("cu-off", new Date()), "rhea@example.test", signInBody(TOK));
      c.ok("OFF: a sign-in email goes, and NO separate copy follows", r4.outcome === "accepted" && o4.length === 1 && o4[0].to === "rhea@example.test");

      await prisma.appSetting.update({ where: { key: M.CLIENT_EMAIL_MONITOR_KEY }, data: { value: "{bad" } });
      const { r: r5, out: o5 } = await railSend(`misc:${++seq}`, "rhea@example.test", plainBody("unreadable row"));
      c.ok("UNREADABLE row: the send still goes, Bcc to the default info@", r5.outcome === "accepted" && o5.length === 1 && o5[0].bcc === MONITOR, o5[0]?.bcc ?? "none");

      // The database itself fails on the setting read.
      const appSetting = prisma.appSetting as unknown as { findUnique: (...a: unknown[]) => Promise<unknown> };
      const realFind = appSetting.findUnique;
      appSetting.findUnique = async (...a: unknown[]) => {
        const where = (a[0] as { where?: { key?: string } } | undefined)?.where;
        if (where?.key === M.CLIENT_EMAIL_MONITOR_KEY) throw new Error("drill: Neon blinked");
        return realFind.apply(prisma.appSetting, a);
      };
      let r6: Awaited<ReturnType<typeof railSend>> | null = null;
      try { r6 = await railSend(`misc:${++seq}`, "rhea@example.test", plainBody("db error on the setting")); } finally { appSetting.findUnique = realFind; }
      c.ok("the setting READ THROWS: the send still goes, Bcc to the default info@", r6?.r.outcome === "accepted" && r6.out.length === 1 && r6.out[0].bcc === MONITOR, r6?.out[0]?.bcc ?? "none");

      await prisma.appSetting.delete({ where: { key: M.CLIENT_EMAIL_MONITOR_KEY } });
      const { out: o7 } = await railSend(`misc:${++seq}`, "info+rheatest@realtourpilot.com", plainBody("to Jordan's own inbox"));
      c.ok("the recipient already IS the monitor inbox (info+tag@): no Bcc, no duplicate", o7.length === 1 && o7[0].bccLines === 0);
      const { out: o8 } = await railSend(`misc:${++seq}`, "kyle@realtourpilot.com", plainBody("a staff mailbox"));
      c.ok("a realtourpilot.com recipient (staff): no Bcc", o8.length === 1 && o8[0].bccLines === 0);
      const { out: o9 } = await railSend(`misc:${++seq}`, "edna.editor@gmail.com", plainBody("a team member's own gmail"));
      c.ok("a team member on a personal address: no Bcc", o9.length === 1 && o9[0].bccLines === 0);
      const { out: o10 } = await railSend(`misc:${++seq}`, "kyle-admin@drill.test", plainBody("a hub login's address"));
      c.ok("a hub login's address: no Bcc", o10.length === 1 && o10[0].bccLines === 0);
    }

    // =========================================================================
    c.head("5. No change to the client's own message");
    // =========================================================================
    {
      const body = plainBody("byte for byte");
      const { out: on } = await railSend("welcome:byte-on", "rhea@example.test", body);
      await M.saveClientEmailMonitor({ enabled: false, address: MONITOR }, null);
      const { out: off } = await railSend("welcome:byte-off", "rhea@example.test", body);
      await prisma.appSetting.delete({ where: { key: M.CLIENT_EMAIL_MONITOR_KEY } });
      const onLines = on[0].head.split("\r\n");
      const withoutBcc = onLines.filter((l) => !/^bcc:/i.test(l)).join("\r\n");
      c.ok("with the copy ON the raw message = the raw message OFF plus exactly one Bcc header line", withoutBcc === off[0].head && on[0].body === off[0].body && onLines.length === off[0].head.split("\r\n").length + 1, `${onLines.length} vs ${off[0].head.split("\r\n").length}`);
      c.ok("the Bcc line sits in the header block, right under To (never in the body)", onLines[0].startsWith("To: ") && onLines[1] === `Bcc: ${MONITOR}` && !on[0].body.includes(MONITOR));
      c.ok("what Gmail delivers to the client (Bcc stripped) is identical with the copy on and off", on[0].delivered === off[0].delivered);
      c.ok("the client's From and To are unchanged (info@ sends, the client receives)", on[0].from === "info@realtourpilot.com" && on[0].to === "rhea@example.test");
      const { sendGmailNew } = await import("@/lib/integrations/google");
      const i = mails.length;
      await sendGmailNew({ mailbox: MONITOR, to: "rhea@example.test", subject: "hdr", body: "x", strict: true, bcc: "x@y.test\r\nX-Evil: 1" });
      await sendGmailNew({ mailbox: MONITOR, to: "rhea@example.test", subject: "hdr", body: "x", strict: true, bcc: "a@b.test, c@d.test" });
      await sendGmailNew({ mailbox: MONITOR, to: "rhea@example.test", subject: "hdr", body: "x", strict: true, bcc: "RHEA@example.test" });
      c.ok("sendGmailNew drops a Bcc with a header break, a list, or the recipient themself", since(i).length === 3 && since(i).every((m) => m.bccLines === 0 && !/X-Evil/.test(m.head)));
    }

    // =========================================================================
    c.head("6. The real senders, end to end");
    // =========================================================================
    {
      // (a) the exported outbox (TEST floor + gate wrapper) — a welcome email.
      const i = mails.length;
      const r = await O.sendThroughOutbox({ channel: "email", toRef: "rhea@example.test", body: "Hi Rhea,\n\nWelcome to RealTour Pilot.\n\n— Jordan", dedupeKey: O.welcomeKey(`${realClient.id}-e2e`), clientId: realClient.id, requestedBy: "drill" });
      c.ok("exported sendThroughOutbox (welcome email): Bcc to info@", r.outcome === "accepted" && since(i).length === 1 && since(i)[0].bcc === MONITOR, `${r.outcome}`);
    }
    // The program cast: a REAL client (renamed off TEST, like r03) inside a PILOT rollout.
    const { buildContentMonth } = await import("./_fixtures/contentMonth");
    const core = await import("@/lib/programRolloutCore");
    const f = await buildContentMonth(prisma as unknown as PrismaClient, { name: "Lena Login TEST", package: "Starter", videosPerMonth: 3, monthKey: "2026-10", owner: { email: "lena@example.test", name: "Lena Person" } });
    await prisma.client.update({ where: { id: f.clientId }, data: { name: "Lena Login Realty", email: "lena-client@example.test" } });
    const ops = core.opsForGroups(core.PROGRAM_PILOT_GROUPS.map((g) => g.key));
    const rollout: import("@/lib/programRolloutCore").ProgramRollout = {
      mode: "PILOT",
      modeSince: new Date(PINNED - 10 * DAY).toISOString(),
      pilot: { clientIds: [f.clientId], operations: ops, approvedBy: "info@realtourpilot.com", approvedAt: new Date(PINNED - 10 * DAY).toISOString(), expiresAt: new Date(PINNED + 60 * DAY).toISOString(), note: "drill pilot", joinedAt: { [f.clientId]: new Date(PINNED - 7 * DAY).toISOString() } },
    };
    await prisma.appSetting.create({ data: { key: core.PROGRAM_ROLLOUT_SETTING_KEY, value: core.serializeProgramRollout(rollout), updatedBy: "drill" } });
    const sw = (key: string, enabled: boolean) => prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledBy: "drill", enabledAt: new Date(PINNED - 10 * DAY) }, update: { enabled } });
    const pa = await import("@/lib/portalAccess");
    {
      // (b) a portal invitation.
      await sw("portal_invites", true);
      const i = mails.length;
      const inv = await pa.inviteClientUser(f.enrollmentId, "lena-assistant@example.test", "Lara Assistant", "COLLABORATOR", null);
      const out = since(i);
      c.ok("inviteClientUser: the invitation goes to the new person, Bcc info@", inv.emailed && out.length === 1 && out[0].to === "lena-assistant@example.test" && out[0].bcc === MONITOR, `${inv.note} n=${out.length} bcc=${out[0]?.bcc}`);
    }
    {
      // (c) a portal sign-in request: the magic link.
      await sw("portal_login_email", true);
      const i = mails.length;
      await pa.requestLoginLink("lena@example.test");
      const out = since(i);
      const client = out.find((m) => m.to === "lena@example.test");
      const copy = out.find((m) => m.to === MONITOR);
      const tok = client ? /portal\/auth\/([A-Za-z0-9_-]{30,80})/.exec(client.body)?.[1] ?? null : null;
      c.ok("requestLoginLink: the client gets their one-time link, no Bcc on it", !!client && !!tok && client.bccLines === 0 && client.subject === "Your Realtour Pilot sign-in link", `n=${out.length} ${out.map((m) => m.to).join(",")}`);
      c.ok("…Jordan gets a separate copy after it, same subject, link removed", !!copy && out.indexOf(copy) > out.indexOf(client!) && copy.subject === client?.subject && copy.body.includes(M.SIGN_IN_LINK_REMOVED) && !!tok && !copy.body.includes(tok) && !copy.body.includes("/portal/auth/"), copy?.body.slice(0, 200));
      const consumed = tok ? await pa.consumeLoginToken(tok) : null;
      c.ok("…and the client's link STILL signs the client in (Jordan's copy spent nothing)", !!consumed?.ok, JSON.stringify(consumed));
    }
    {
      // (d) the office-replied notice sweep.
      await sw("program_message_notice", true);
      await prisma.programMessage.create({ data: { enrollmentId: f.enrollmentId, clientId: f.clientId, authorKind: "STAFF", authorLabel: "Kyle Drill", body: "We moved your shoot to 10:30.", createdAt: new Date(PINNED - HOUR) } });
      const { sweepProgramMessageNotices } = await import("@/lib/programMessages");
      const i = mails.length;
      const res = await sweepProgramMessageNotices({ now: new Date(PINNED) });
      const out = since(i);
      c.ok("office-replied notice: each seat's email carries Bcc info@", res.sent >= 1 && out.length === res.sent && out.every((m) => m.bcc === MONITOR && m.subject === "New reply in your Realtour Pilot portal"), `sent=${res.sent} ${JSON.stringify(res.notes)} ${out.map((m) => `${m.to}/${m.bcc}`).join(",")}`);
    }
    {
      // (e) the /quality feedback reply.
      const project = await prisma.project.create({ data: { clientId: realClient.id, title: "12 Feedback Ln, Testville", status: "DELIVERED" } });
      const fb = await prisma.feedback.create({ data: { projectId: project.id, body: "Loved the photos, the drone shots could be brighter.", rating: 4 } });
      await signIn(admin);
      const { sendFeedbackReply } = await import("@/app/quality/actions");
      const i = mails.length;
      const r = await sendFeedbackReply(fb.id, "Hi Rhea, thank you for the notes on the drone shots — passed on.", "rhea@example.test", "Thank you for your feedback — 12 Feedback Ln");
      const out = since(i);
      c.ok("feedback reply (/quality): one email to the agent, Bcc info@", r.ok && out.length === 1 && out[0].to === "rhea@example.test" && out[0].bcc === MONITOR && out[0].subject === "Thank you for your feedback — 12 Feedback Ln", `${r.message} bcc=${out[0]?.bcc}`);
    }
    {
      // (f) a threaded reply from a gmail task: to a client, and to a team member.
      const mkThread = (id: string, from: string) => threads.set(id, { messages: [{ id: `${id}-m1`, payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: "Question about my shoot" }, { name: "Message-ID", value: `<${id}@mail.example.test>` }] } }] });
      mkThread("thr-client", "Carla Client <carla@example.test>");
      mkThread("thr-team", "Edna Editor <edna.editor@gmail.com>");
      const t1 = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply to Carla", source: "gmail", sourceDetail: "gmail-thread:info@realtourpilot.com:thr-client", clientId: realClient.id } });
      const t2 = await prisma.smartTask.create({ data: { taskType: "client_reply", title: "Reply to Edna", source: "gmail", sourceDetail: "gmail-thread:info@realtourpilot.com:thr-team" } });
      const { sendEmailReply } = await import("@/app/emailActions");
      let i = mails.length;
      const r1 = await sendEmailReply(t1.id, "Hi Carla, yes — Thursday at 10 works.", { expectedTo: "carla@example.test" });
      let out = since(i);
      c.ok("task reply to a client: threaded (same threadId, In-Reply-To), Bcc info@", r1.ok && out.length === 1 && out[0].to === "carla@example.test" && out[0].bcc === MONITOR && out[0].threadId === "thr-client" && /In-Reply-To: <thr-client@/.test(out[0].head) && out[0].subject === "Re: Question about my shoot", `${r1.message} bcc=${out[0]?.bcc}`);
      i = mails.length;
      const r2 = await sendEmailReply(t2.id, "Hi Edna, the raws are in the folder.", { expectedTo: "edna.editor@gmail.com" });
      out = since(i);
      c.ok("task reply to a TEAM MEMBER: no Bcc", r2.ok && out.length === 1 && out[0].to === "edna.editor@gmail.com" && out[0].bccLines === 0, `${r2.message} bcc=${out[0]?.bcc}`);
    }
    {
      // (g) the owner's own notification email: internal.
      const { notifyOwnerEmail } = await import("@/lib/integrations/google");
      const i = mails.length;
      const ok = await notifyOwnerEmail("New feedback on the platform", "Kyle left a note.");
      c.ok("notifyOwnerEmail (internal): no Bcc", ok && since(i).length === 1 && since(i)[0].bccLines === 0);
    }

    // =========================================================================
    c.head("7. Settings: owner saves, admin cannot, the card says it plainly");
    // =========================================================================
    {
      const { saveClientEmailMonitorAction } = await import("@/app/settings/actions");
      await signIn(admin);
      const a = await saveClientEmailMonitorAction({ enabled: false, address: MONITOR });
      c.ok("an ADMIN cannot change it", !a.ok && /Only Jordan/.test(a.message) && (await M.clientEmailMonitor()).enabled, a.message);
      await signIn(owner);
      const bad = await saveClientEmailMonitorAction({ enabled: true, address: "not-an-address" });
      c.ok("the owner: a bad address is refused", !bad.ok && /doesn't look like/.test(bad.message), bad.message);
      const o = await saveClientEmailMonitorAction({ enabled: true, address: "jordan.copies@example.test" });
      c.ok("the owner saves a new address", o.ok && o.address === "jordan.copies@example.test" && (await M.clientEmailMonitor()).address === "jordan.copies@example.test", o.message);
      const off = await saveClientEmailMonitorAction({ enabled: false, address: "jordan.copies@example.test" });
      c.ok("the owner turns it off", off.ok && !(await M.clientEmailMonitor()).enabled, off.message);
      const { ClientEmailMonitorSettings } = await import("@/components/settings/ClientEmailMonitorSettings");
      const html = renderToStaticMarkup(createElement(ClientEmailMonitorSettings, { initial: { enabled: true, address: MONITOR, unreadable: false }, isOwner: true }));
      const text = html.replace(/<[^>]+>/g, " ").replace(/&rsquo;/g, "’").replace(/\s+/g, " ");
      c.ok("the card: \"Every email a client gets is also sent to: [address] (blind copy)\" with an on/off switch", text.includes("Every email a client gets is also sent to:") && html.includes(`value="${MONITOR}"`) && text.includes("(blind copy)") && /role="switch"[^>]*aria-checked="true"/.test(html), text.slice(0, 200));
      const ro = renderToStaticMarkup(createElement(ClientEmailMonitorSettings, { initial: { enabled: true, address: MONITOR, unreadable: true }, isOwner: false }));
      c.ok("an admin reads it (disabled), told only Jordan changes it; an unreadable row is called out", ro.includes("Only Jordan can change this one.") && /<input[^>]*disabled/.test(ro) && ro.includes("could not be read"));
    }

    c.ok("nothing outside the machine was contacted (Gmail and OpenPhone answered in-process; nothing else was asked)", fence.blocked.length === 0 && fence.faked.every((u) => /googleapis\.com|api\.openphone\.com/.test(u)), fence.blocked.join(", "));
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
