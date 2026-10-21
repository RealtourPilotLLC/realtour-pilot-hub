// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: branded emails, "Also email" copies, sign-in email changes and the
// welcome resend (Oct 21 2026).
//
// Jordan: "For Arielle Roemer, can you please add a second email to her
// content program account so we can email her on both emails and add a way
// for me to do that? I think her Fox and Roach email should be the one with
// access to her account. We should resend the onboarding email to her. Also,
// I want the emails to be formatted really nicely and branded in our colors,
// like our website."
//
//   1. renderBrandedEmail (pure): every character escaped, a link on its own
//      line (or ending a "…: <link>" line) is an orange pill button with a
//      sensible label and the plain link beneath, a link in a sentence is an
//      orange link, bullets and numbers are lists, a single newline a <br>,
//      the preheader is the first sentence, the white wordmark on the dark
//      band, color-scheme declared, no em dash anywhere in the template.
//   2. The MIME sendGmailNew builds (real code, Gmail answered in-process):
//      multipart/alternative, plain first then HTML, base64, right
//      boundaries, the plain part word for word, a clean Cc header, the Bcc
//      still right under To; without html the old text/plain message.
//   3. The rail: a program email to a client with "Also email" addresses Cc's
//      them; one carrying a one-use sign-in link never does (a separate copy
//      with the sign-in page instead); the sign-in email itself and staff mail
//      get nothing; a TEST client's copies only reach Jordan's inboxes.
//   4. Change sign-in email: refusals (bad address, taken, TEST floor, a
//      person seated on another client), then the change: same person, same
//      seat, token cleared, an audit row, a signed-in session still works.
//   5. "Also email" add/remove: validated, de-duplicated (Gmail dots too),
//      never a seat's own address, ledgered, other overrides kept.
//   6. Resend the welcome: a fresh outbox row under the welcome's subject, the
//      Cc, through the same gates (a TEST client at Jordan's inbox passes with
//      invitations off; a real client is held with the reason).
//   7. The card renders: the three parts, plain words, no em dash.
//   8. Preview files of the welcome and a script-share email (os.tmpdir()).
//
// ISOLATION: PGlite on 127.0.0.1:6721 (DRILL_PORT overrides). Gmail is
// answered in-process at the HTTP fence; every other outbound call is blocked.
// ---------------------------------------------------------------------------
import fs from "fs";
import os from "os";
import path from "path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { renderBrandedEmail, multipartAlternative, mimePartOf, plainTextOfMime, buttonLabelFor, firstSentence } from "@/lib/emailHtml";

const PORT = Number(process.env.DRILL_PORT ?? 6721);
const EM_DASH = /—/;
const MONITOR = "info@realtourpilot.com";

installNextStubs();

// ---- Gmail, answered in-process -----------------------------------------------
type Mail = { n: number; raw: string; head: string; headLines: string[]; to: string; cc: string[]; bcc: string | null; subject: string; text: string; html: string | null };
const mails: Mail[] = [];
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const sent = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const raw = Buffer.from(sent.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const head = raw.slice(0, raw.indexOf("\r\n\r\n"));
    const headLines = head.split("\r\n");
    const val = (name: string) => headLines.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}: `))?.slice(name.length + 2) ?? "";
    const subjEnc = /^=\?UTF-8\?B\?(.+)\?=$/.exec(val("Subject"))?.[1];
    const ccLine = val("Cc");
    mails.push({
      n: mails.length + 1, raw, head, headLines, to: val("To").trim().toLowerCase(),
      cc: ccLine ? ccLine.split(",").map((s) => s.trim()) : [], bcc: val("Bcc") || null,
      subject: subjEnc ? Buffer.from(subjEnc, "base64").toString("utf8") : val("Subject"),
      text: plainTextOfMime(raw), html: mimePartOf(raw, "text/html"),
    });
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});
const since = (i: number) => mails.slice(i);

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-branded-email", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const O = await import("@/lib/outbox");
    const M = await import("@/lib/clientEmailMonitor");
    const PA = await import("@/lib/portalAccess");
    const A = await import("@/app/content/emailActions");
    const { setSession } = await import("@/lib/auth/session");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ [MONITOR]: "drill-refresh-token" }));
    const owner = await prisma.appUser.create({ data: { name: "Jordan", email: "jordan-owner@drill.test", role: "OWNER", status: "ACTIVE" } });
    const admin = await prisma.appUser.create({ data: { name: "Kyle", email: "kyle-admin@drill.test", role: "ADMIN", status: "ACTIVE" } });
    const signIn = (u: { id: string; email: string; role: string }) => setSession({ uid: u.id, email: u.email, role: u.role });
    const now = new Date();
    const mkProgram = async (name: string, overrides?: Record<string, unknown>) => {
      const client = await prisma.client.create({ data: { name, email: null, firstSeenAt: now } });
      const e = await prisma.contentEnrollment.create({
        data: { clientId: client.id, package: "Accelerator", videosPerMonth: 4, sessionsPerMonth: 1, sessionHours: 4, overridesJson: overrides ? JSON.stringify(overrides) : null },
      });
      return { clientId: client.id, enrollmentId: e.id, name };
    };
    const mkSeat = async (p: { clientId: string; enrollmentId: string }, email: string, role = "OWNER", name: string | null = null) => {
      const person = (await prisma.clientUser.findUnique({ where: { email } })) ?? (await prisma.clientUser.create({ data: { email, name } }));
      const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: p.enrollmentId, clientId: p.clientId, role } });
      return { person, seat };
    };
    const setSwitch = (key: string, enabled: boolean) =>
      prisma.programAutomation.upsert({ where: { key }, create: { key, enabled, enabledAt: enabled ? new Date() : null }, update: { enabled, enabledAt: enabled ? new Date() : null } });

    // =========================================================================
    c.head("1 · renderBrandedEmail: escaped, buttons, links, lists, preheader, the brand");
    // =========================================================================
    {
      const sample = [
        "Hi Avery,",
        "",
        "Your <b>scripts</b> & notes are ready. Here's the plan:",
        "• Kitchen tour",
        "- Market update",
        "",
        "1. Read them",
        "2. Approve them",
        "",
        "Open your portal any time:",
        "https://hub.realtourpilot.com/portal/login",
        "",
        "Book your strategy call here: https://calendly.com/realtourpilot-info/content-program-strategy-call",
        "",
        "Something else to look at:",
        "https://example.com/page",
        "",
        "We posted the recap at https://example.com/recap, take a look.",
        "Line two of the same paragraph.",
        "",
        "Jordan and the Realtour Pilot team",
        "(Reply to this email and it comes straight to us.)",
      ].join("\n");
      const html = renderBrandedEmail({ subject: "Your <scripts> & more", text: sample });
      c.ok("escaping: the client's words and the subject never become markup", html.includes("Your &lt;b&gt;scripts&lt;/b&gt; &amp; notes are ready.") && !html.includes("<b>scripts</b>") && html.includes(">Your &lt;scripts&gt; &amp; more</h1>") && html.includes("<title>Your &lt;scripts&gt; &amp; more</title>"));
      c.ok("a link on its own line is an orange pill button (\"Open your portal\" for /portal/login), with the plain link beneath",
        /<a class="rtp-btn" href="https:\/\/hub\.realtourpilot\.com\/portal\/login"[^>]*border-radius:9999px;background-color:#E96320;">Open your portal<\/a>/.test(html) && html.includes("Or open this link: <a class=\"rtp-muted\" href=\"https://hub.realtourpilot.com/portal/login\""));
      c.ok("…bulletproof: a VML roundrect for Outlook, the button bold, white on orange", /<v:roundrect[^>]*href="https:\/\/hub\.realtourpilot\.com\/portal\/login"[^>]*fillcolor="#E96320"/.test(html) && /class="rtp-btn"[^>]*font-weight:700;[^>]*color:#ffffff;/.test(html));
      c.ok("a line ending \"…here: <Calendly link>\" keeps its words and gets a \"Book your call\" button", html.includes("Book your strategy call here:</p>") && />Book your call<\/a>/.test(html));
      c.ok("any other link alone on a line: \"Open link\"", /href="https:\/\/example\.com\/page"[^>]*>Open link<\/a>/.test(html));
      c.ok("a link inside a sentence is an orange inline link, the comma kept outside it", /<a class="rtp-link" href="https:\/\/example\.com\/recap"[^>]*color:#E96320;[^>]*>https:\/\/example\.com\/recap<\/a>, take a look\./.test(html));
      c.ok("a single newline is a <br>; a blank line a new paragraph", html.includes("take a look.<br>Line two of the same paragraph.</p>"));
      const ul = /<ul class="rtp-list"[^>]*>(.*?)<\/ul>/.exec(html)?.[1] ?? "";
      const ol = /<ol class="rtp-list"[^>]*>(.*?)<\/ol>/.exec(html)?.[1] ?? "";
      c.ok("\"• \" and \"- \" lines are one bulleted list; \"1. \" lines a numbered one", (ul.match(/<li /g) ?? []).length === 2 && ul.includes("Kitchen tour") && ul.includes("Market update") && (ol.match(/<li /g) ?? []).length === 2 && ol.includes("Read them") && ol.includes("Approve them"));
      c.ok("the preheader is the first sentence after the greeting, hidden, escaped", firstSentence(sample) === "Your <b>scripts</b> & notes are ready." && /<div style="display:none;[^"]*">Your &lt;b&gt;scripts&lt;\/b&gt; &amp; notes are ready\.&#8199;/.test(html), firstSentence(sample));
      c.ok("the white wordmark on the dark header band, about 180 wide, alt \"Realtour Pilot\"", /<td class="rtp-band" bgcolor="#0a0a0a"[^>]*>\n<a href="https:\/\/realtourpilot\.com"[^>]*><img src="https:\/\/hub\.realtourpilot\.com\/brand\/wordmark-white\.png" width="180" alt="Realtour Pilot"/.test(html));
      c.ok("the footer band: \"Realtour Pilot · Pennsylvania's premier real estate media\" and realtourpilot.com", html.includes("Realtour Pilot &middot; Pennsylvania&#39;s premier real estate media") && html.includes(">realtourpilot.com</a>"));
      c.ok("color-scheme declared, a dark palette supplied, Inter with the fallback stack, an orange uppercase eyebrow",
        html.includes('<meta name="color-scheme" content="light dark">') && html.includes("@media (prefers-color-scheme: dark)") && html.includes("font-family:Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;") && /text-transform:uppercase;color:#E96320;">Your scripts<\/p>/.test(html));
      c.ok("table-based, 600 wide, centred", html.includes('style="max-width:600px;width:100%;"') && html.includes('<table role="presentation" width="600"') && html.includes('align="center"'));
      c.ok("the sign-off stays text (bold name, the reply line muted), never a button or list", /font-weight:700;color:#0a0a0a;">Jordan and the Realtour Pilot team<\/p><p class="rtp-muted"[^>]*>\(Reply to this email and it comes straight to us\.\)<\/p>/.test(html));
      c.ok("no em dash anywhere in the template", !EM_DASH.test(html));
      c.ok("labels from the link and the words before it",
        buttonLabelFor("https://hub.example.test/portal/auth/tok", "Read them here: 3 scripts for November are ready") === "Read your scripts" &&
        buttonLabelFor("https://hub.example.test/portal/auth/tok", "Here's your one-time link to sign in") === "Sign in to your portal" &&
        buttonLabelFor("https://hub.example.test/portal/address/x", "Add the exact address here") === "Add the address" &&
        buttonLabelFor("https://hub.example.test/portal/me", "waiting for your review in your portal") === "Review your videos" &&
        buttonLabelFor("https://calendly.com/x/brand-discovery-call", "book it here:") === "Book your call");
    }

    // =========================================================================
    c.head("2 · The message sendGmailNew builds");
    // =========================================================================
    {
      const G = await import("@/lib/integrations/google");
      const text = "Hi Avery,\n\nYour portal: https://hub.example.test/portal/login\n\nCafé • naïve, quotes \"here\" = fine.\n\nJordan and the Realtour Pilot team";
      const html = renderBrandedEmail({ subject: "Héllo", text });
      let i = mails.length;
      const r = await G.sendGmailNew({
        mailbox: MONITOR, to: "avery@example.test", subject: "Héllo", body: text, strict: true, bcc: MONITOR, html,
        cc: ["Copy@Example.test", "avery@example.test", "copy@example.test", "bad\r\nBcc: evil@x.test", "two@example.test"],
      });
      const m = since(i)[0];
      const boundary = /boundary="([^"]+)"/.exec(m?.head ?? "")?.[1] ?? "";
      c.ok("one send, multipart/alternative with a quoted boundary, MIME-Version", r.ok && since(i).length === 1 && /^Content-Type: multipart\/alternative; boundary="=_rtp_alt_[0-9a-f]{24}"$/m.test(m.head) && m.headLines.includes("MIME-Version: 1.0"), m?.head);
      const body = m.raw.slice(m.raw.indexOf("\r\n\r\n") + 4);
      const plainAt = body.indexOf(`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
      const htmlAt = body.indexOf(`--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`);
      c.ok("text/plain first, then text/html, both UTF-8 base64, closed with --boundary--", plainAt === 0 && htmlAt > plainAt && body.endsWith(`\r\n--${boundary}--\r\n`));
      c.ok("base64 lines stay within 76 characters", body.split("\r\n").filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).every((l) => l.length <= 76));
      c.ok("the plain part is the words exactly (accents and all); the HTML part is the render", m.text === text && m.html === html, JSON.stringify(m.text.slice(0, 60)));
      c.ok("Cc: clean, lower-cased, de-duplicated, never the recipient, a header break dropped", m.headLines.includes("Cc: copy@example.test, two@example.test") && !/evil/.test(m.head), m.headLines.find((l) => l.startsWith("Cc:")));
      c.ok("the Bcc stays right under To, and the Cc comes after it", m.headLines[0] === "To: avery@example.test" && m.headLines[1] === `Bcc: ${MONITOR}` && m.headLines[2].startsWith("Cc: "));
      c.ok("the same message builds the same boundary (deterministic)", multipartAlternative({ text, html }).boundary === boundary);
      i = mails.length;
      const plainOnly = await G.sendGmailNew({ mailbox: MONITOR, to: "avery@example.test", subject: "Plain", body: text, strict: true });
      const p = since(i)[0];
      c.ok("without html or cc: the old text/plain message, byte for byte", plainOnly.ok && p.headLines.includes("Content-Type: text/plain; charset=UTF-8") && !p.headLines.some((l) => /^Cc:/i.test(l)) && p.raw.endsWith(`\r\n\r\n${text}`) && p.html === null);
    }

    // =========================================================================
    c.head("3 · The rail: Also email = a Cc; never on a one-use sign-in link");
    // =========================================================================
    const avery = await mkProgram("Avery Example", { videoStyle: "SKITS", alsoEmails: ["avery.personal@example.test"] });
    {
      const rail = O.createOutbox({ store: O.prismaOutboxStore(), provider: O.realOutboxProvider() });
      const send = async (dedupeKey: string, toRef: string, body: string, clientId: string | null = avery.clientId) => {
        const i = mails.length;
        const r = await rail.sendThroughOutbox({ channel: "email", toRef, body, dedupeKey, clientId, requestedBy: "drill" });
        return { r, out: since(i) };
      };
      const plain = "Hi Avery,\n\nWelcome aboard. Your portal: https://hub.example.test/portal/sharedtok123456789\n\nJordan and the Realtour Pilot team";
      const a = await send(O.welcomeKey(avery.clientId), "avery@foxroach.example.test", plain);
      const am = a.out[0];
      c.ok("a client email: one send, To the client, Cc the Also email address, Bcc the owner, branded HTML with the same words",
        a.r.outcome === "accepted" && a.out.length === 1 && am.to === "avery@foxroach.example.test" && am.cc.join() === "avery.personal@example.test" && am.bcc === MONITOR && am.text === plain && !!am.html?.includes(">Open your portal</a>"),
        `${a.r.outcome} n=${a.out.length} cc=${am?.cc} bcc=${am?.bcc}`);

      const { renderReminder, reminderTemplate } = await import("@/lib/reminderTemplates");
      const TOK = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdEF";
      const share = renderReminder(reminderTemplate("scripts_ready.v1"), {
        firstName: "Avery", month: "November", portalLink: `https://hub.example.test/portal/auth/${TOK}`, bookCallLink: null, noCallEligible: false, answersStarted: false,
        sessionNote: null, earliestSession: null, itemCount: 1, titles: ["Why I love Lititz", "Three open houses"], updatedTitles: [], deadline: null,
      });
      const b = await send(O.scriptShareKey("rem-share-1"), "avery@foxroach.example.test", share);
      const client = b.out[0];
      const jordanCopy = b.out.find((m) => m.to === MONITOR);
      const alsoCopy = b.out.find((m) => m.to === "avery.personal@example.test");
      c.ok("a message with a one-use sign-in link: the client's own message carries NO Cc (and no Bcc), link intact",
        b.r.outcome === "accepted" && client.to === "avery@foxroach.example.test" && client.cc.length === 0 && client.bcc === null && client.text === share && client.text.includes(`/portal/auth/${TOK}`) && !!client.html?.includes(">Read your scripts</a>"),
        `cc=${client?.cc} bcc=${client?.bcc}`);
      c.ok("…the Also email address gets a SEPARATE copy after it: the sign-in link swapped for the sign-in page, a line saying which address signs in",
        !!alsoCopy && b.out.indexOf(alsoCopy) > 0 && alsoCopy.subject === client.subject && !alsoCopy.text.includes("/portal/auth/") && !alsoCopy.text.includes(TOK) &&
        alsoCopy.text.startsWith("A copy of the email we sent to avery@foxroach.example.test. To sign in to your portal, use that address.") &&
        alsoCopy.text.includes("Read them here: https://hub.example.test/portal/login") && !!alsoCopy.html?.includes(">Open your portal</a>") && alsoCopy.cc.length === 0,
        alsoCopy?.text.slice(0, 160));
      c.ok("…and the owner's redacted copy still goes, branded too", !!jordanCopy && jordanCopy.text.includes(M.SIGN_IN_LINK_REMOVED) && !jordanCopy.text.includes(TOK) && !!jordanCopy.html && !jordanCopy.html.includes(TOK));
      const row = await prisma.outboxMessage.findFirst({ where: { dedupeKey: O.scriptShareKey("rem-share-1") } });
      c.ok("…the outbox records the client's message only (accepted, its Gmail id)", row?.state === "accepted" && row.providerId === `gm-${client.n}`);

      const tm = await prisma.teamMember.create({ data: { name: "Edna Editor", email: "edna@drill-team.test" } });
      const s = await send(O.staffKey(tm.id, new Date()), "edna@drill-team.test", "Shoot tomorrow at 9.\nhttps://hub.example.test/jobs/1");
      const sm = s.out[0];
      c.ok("staff mail (even naming a client): plain text/plain, no HTML, no Cc", s.r.outcome === "accepted" && s.out.length === 1 && sm.html === null && sm.cc.length === 0 && sm.headLines.includes("Content-Type: text/plain; charset=UTF-8"));

      const none = M.planAlsoEmailWith({ kind: "portal_login", to: "a@x.test", body: "Your link:\nhttps://h.test/portal/auth/abc", alsoEmails: ["b@x.test"], synthetic: false });
      const viaDb = await M.planAlsoEmail({ clientId: avery.clientId, kind: "portal_login", to: "avery@foxroach.example.test", body: "x" });
      c.ok("the sign-in link email itself: no Cc and no copy (pure and with the client's list)", none.cc.length === 0 && !none.copy && none.why === "sign_in_email" && viaDb.cc.length === 0 && !viaDb.copy);
      const testPlan = M.planAlsoEmailWith({ kind: "script_share", to: "info+t@realtourpilot.com", body: "hello", alsoEmails: ["real.person@example.test", "jspackman215@gmail.com"], synthetic: true });
      c.ok("a TEST client's copies reach only Jordan's verified inboxes", testPlan.cc.join() === "jspackman215@gmail.com");
      const dots = M.planAlsoEmailWith({ kind: "script_share", to: "arielleroemer@gmail.com", body: "hello", alsoEmails: ["arielle.roemer@gmail.com", "Avery.P@Example.test", "avery.p@example.test"], synthetic: false });
      c.ok("duplicates and the recipient's own inbox (Gmail dots folded) are dropped", dots.cc.join() === "avery.p@example.test", dots.cc.join());
      const noClient = await send("misc:no-client", "someone@example.test", "Hi,\n\nNo client on this row.\n\nJordan", null);
      c.ok("a row with no client: still branded, no Cc (no list to read)", noClient.out.length === 1 && noClient.out[0].cc.length === 0 && !!noClient.out[0].html, `${noClient.out.length} cc=${noClient.out[0]?.cc}`);
    }

    // =========================================================================
    c.head("4 · Change sign-in email");
    // =========================================================================
    const tp = await mkProgram("Drill Emails TEST", { videoStyle: "SKITS" });
    const { person: tPerson, seat: tSeat } = await mkSeat(tp, "info+oldseat@realtourpilot.com", "OWNER", "Terry Test");
    await prisma.clientUser.update({ where: { id: tPerson.id }, data: { loginTokenHash: "a".repeat(64), loginTokenExpiresAt: new Date(Date.now() + 3600_000), lastLoginAt: new Date(Date.now() - 86_400_000), status: "ACTIVE" } });
    await prisma.clientUser.create({ data: { email: "info+taken@realtourpilot.com", name: "Someone Else" } });
    {
      const { signClientSession, CLIENT_COOKIE } = await import("@/lib/auth/clientSession");
      const { resolvePortalViewer } = await import("@/lib/portal");
      const cookie = await signClientSession({ cu: tPerson.id, email: tPerson.email });
      const viewerOk = async () => (await resolvePortalViewer({ cookies: { get: (n: string) => (n === CLIENT_COOKIE ? cookie : undefined) }, enrollmentId: tp.enrollmentId })).ok;
      c.ok("(setup) the seat holder is signed in on a session cookie", await viewerOk());

      await signIn(admin);
      const byAdmin = await A.changeSeatEmailAction(tp.enrollmentId, tSeat.id, "info+newseat@realtourpilot.com");
      c.ok("an ADMIN is refused (owner only, like every portal-access action)", !byAdmin.ok && (await prisma.clientUser.findUniqueOrThrow({ where: { id: tPerson.id } })).email === "info+oldseat@realtourpilot.com", byAdmin.message);
      await signIn(owner);
      const bad = await A.changeSeatEmailAction(tp.enrollmentId, tSeat.id, "not an address");
      c.ok("a bad address is refused", !bad.ok && /doesn't look like an email/.test(bad.message), bad.message);
      const taken = await A.changeSeatEmailAction(tp.enrollmentId, tSeat.id, "INFO+Taken@realtourpilot.com");
      c.ok("an address another account already has is refused, clearly, and nothing changes",
        !taken.ok && /info\+taken@realtourpilot\.com already belongs to another portal account \(with no seat on any program\)\. Two accounts can't share one sign-in email/.test(taken.message) &&
        (await prisma.clientUser.findUniqueOrThrow({ where: { id: tPerson.id } })).loginTokenHash === "a".repeat(64), taken.message);
      const realAddr = await A.changeSeatEmailAction(tp.enrollmentId, tSeat.id, "terry@example.test");
      c.ok("a TEST client keeps staff-controlled addresses", !realAddr.ok && /TEST client/.test(realAddr.message), realAddr.message);

      const ok = await A.changeSeatEmailAction(tp.enrollmentId, tSeat.id, " Info+NewSeat@RealtourPilot.com ");
      const after = await prisma.clientUser.findUniqueOrThrow({ where: { id: tPerson.id } });
      const seatAfter = await prisma.clientMembership.findUniqueOrThrow({ where: { id: tSeat.id } });
      const audit = await prisma.auditLog.findFirst({ where: { action: "portal_sign_in_email_change", target: tp.clientId } });
      c.ok("the change: same person (id kept), new lower-cased address, any unused sign-in link cleared",
        ok.ok && after.email === "info+newseat@realtourpilot.com" && after.loginTokenHash === null && after.loginTokenExpiresAt === null && !!after.lastLoginAt, ok.message);
      c.ok("…the seat, its role and its history are untouched", seatAfter.clientUserId === tPerson.id && seatAfter.role === "OWNER" && !seatAfter.revokedAt && seatAfter.invitedAt.getTime() === tSeat.invitedAt.getTime());
      c.ok("…an audit row says who changed what", !!audit && audit.actor === owner.email && audit.detail.includes("info+oldseat@realtourpilot.com") && audit.detail.includes("info+newseat@realtourpilot.com"), audit?.detail);
      c.ok("…the card's state comes back with the new address", ok.state?.seats.length === 1 && ok.state.seats[0].email === "info+newseat@realtourpilot.com" && ok.state.seats[0].signedIn);
      c.ok("…a session already signed in still works (it is bound to the person, not the address)", await viewerOk());

      await A.addAlsoEmailAction(tp.enrollmentId, "bobmike0214@gmail.com");
      const toAlso = await A.changeSeatEmailAction(tp.enrollmentId, tSeat.id, "bobmike0214@gmail.com");
      c.ok("changing the sign-in to an address on the Also email list takes it off the list", toAlso.ok && toAlso.state?.alsoEmails.length === 0 && toAlso.state.seats[0].email === "bobmike0214@gmail.com", JSON.stringify(toAlso.state?.alsoEmails));

      // A person seated on two clients' programs is not re-addressed from one.
      const p1 = await mkProgram("Shared One TEST");
      const p2 = await mkProgram("Shared Two TEST");
      const { seat: s1 } = await mkSeat(p1, "info+shared@realtourpilot.com");
      await mkSeat(p2, "info+shared@realtourpilot.com");
      const shared = await A.changeSeatEmailAction(p1.enrollmentId, s1.id, "info+sharednew@realtourpilot.com");
      c.ok("a person who also signs in to another client's portal is refused", !shared.ok && /also signs in to another client's portal/.test(shared.message), shared.message);
      const wrong = await A.changeSeatEmailAction(p2.enrollmentId, s1.id, "info+x@realtourpilot.com");
      c.ok("a seat from another program is refused", !wrong.ok && /isn't on this program/.test(wrong.message), wrong.message);
    }

    // =========================================================================
    c.head("5 · Also email: add and remove");
    // =========================================================================
    {
      await signIn(owner);
      const bad = await A.addAlsoEmailAction(tp.enrollmentId, "nope");
      c.ok("a bad address is refused", !bad.ok && /doesn't look like an email/.test(bad.message), bad.message);
      const seatOwn = await A.addAlsoEmailAction(tp.enrollmentId, "bob.mike0214@gmail.com");
      c.ok("a seat's own sign-in address (Gmail dots folded) is refused", !seatOwn.ok && /already signs in to this portal/.test(seatOwn.message), seatOwn.message);
      const real = await A.addAlsoEmailAction(tp.enrollmentId, "someone@example.test");
      c.ok("a TEST client's copies only go to Jordan's verified inboxes", !real.ok && /TEST client/.test(real.message), real.message);
      const add = await A.addAlsoEmailAction(tp.enrollmentId, " JSpackman215@gmail.com ");
      const bag = JSON.parse((await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: tp.enrollmentId } })).overridesJson ?? "{}") as Record<string, unknown>;
      c.ok("add: stored clean in the overrides bag, the other settings kept", add.ok && add.state?.alsoEmails.join() === "jspackman215@gmail.com" && JSON.stringify(bag.alsoEmails) === '["jspackman215@gmail.com"]' && bag.videoStyle === "SKITS", JSON.stringify(bag));
      const ledger = await prisma.programEnrollmentChange.findFirst({ where: { enrollmentId: tp.enrollmentId, field: "overrides", reason: { contains: "jspackman215@gmail.com added" } } });
      c.ok("…ledgered like every program setting", !!ledger && ledger.changedBy === owner.email);
      const again = await A.addAlsoEmailAction(tp.enrollmentId, "jspackman215@gmail.com");
      c.ok("adding it again is refused (de-duplicated)", !again.ok && /already on the list/.test(again.message), again.message);
      const missing = await A.removeAlsoEmailAction(tp.enrollmentId, "nobody@example.test");
      c.ok("removing an address not on the list is refused", !missing.ok && /not on the list/.test(missing.message), missing.message);
      await signIn(admin);
      const adminAdd = await A.addAlsoEmailAction(tp.enrollmentId, "bobmike0214@gmail.com");
      c.ok("an ADMIN cannot change the list", !adminAdd.ok, adminAdd.message);
      await signIn(owner);
      const rm = await A.removeAlsoEmailAction(tp.enrollmentId, "JSPACKMAN215@gmail.com");
      const bag2 = JSON.parse((await prisma.contentEnrollment.findUniqueOrThrow({ where: { id: tp.enrollmentId } })).overridesJson ?? "{}") as Record<string, unknown>;
      c.ok("remove: gone from the bag, the other settings still kept", rm.ok && rm.state?.alsoEmails.length === 0 && !("alsoEmails" in bag2) && bag2.videoStyle === "SKITS", JSON.stringify(bag2));
      const realAdd = await A.addAlsoEmailAction(avery.enrollmentId, "avery.second@example.test");
      c.ok("a real client may list any address", realAdd.ok && realAdd.state?.alsoEmails.join() === "avery.personal@example.test,avery.second@example.test", realAdd.message);
    }

    // =========================================================================
    c.head("6 · Resend the welcome email");
    // =========================================================================
    {
      const wp = await mkProgram("Drill Welcome TEST", { alsoEmails: ["jspackman215@gmail.com"] });
      const { seat: wSeat } = await mkSeat(wp, "info+welcome@realtourpilot.com", "OWNER", "Wendy Welcome");
      await mkSeat(wp, "info+helper@realtourpilot.com", "COLLABORATOR", "Hal Helper");
      // The first welcome, as it went on the day (the one-for-ever identity).
      await prisma.outboxMessage.create({ data: { channel: "email", toRef: "info+welcome@realtourpilot.com", body: "welcome", state: "accepted", dedupeKey: PA.portalWelcomeKey(wSeat.id), clientId: wp.clientId, acceptedAt: new Date(Date.now() - 7 * 86_400_000) } });
      c.ok("(setup) client invitations are switched off", !(await prisma.programAutomation.findUnique({ where: { key: "portal_invites" } }))?.enabled);
      const before = await PA.programEmailsState(wp.enrollmentId);
      c.ok("the card knows the first welcome, who it goes to, and that the gates pass (a TEST client at Jordan's inbox)",
        before?.welcome.to?.email === "info+welcome@realtourpilot.com" && before.welcome.gate.ok && before.welcome.sent.length === 1 && !before.welcome.sent[0].resend && before.welcome.sent[0].to === "info+welcome@realtourpilot.com");

      await signIn(admin);
      const adminTry = await A.resendWelcomeAction(wp.enrollmentId);
      c.ok("an ADMIN cannot resend it", !adminTry.ok, adminTry.message);
      await signIn(owner);
      let i = mails.length;
      const r1 = await A.resendWelcomeAction(wp.enrollmentId);
      const out = since(i);
      const rows = await prisma.outboxMessage.findMany({ where: { clientId: wp.clientId, dedupeKey: { startsWith: `portal_invite:${wSeat.id}:welcome:` } } });
      const row = rows[0];
      c.ok("the owner resends: sent, and the message names who got it and the copy", r1.ok && r1.message === "Welcome sent to info+welcome@realtourpilot.com (copy to jspackman215@gmail.com).", r1.message);
      c.ok("…a NEW outbox row under a fresh identity that still reads as the welcome",
        rows.length === 1 && row.state === "accepted" && new RegExp(`^portal_invite:${wSeat.id}:welcome:\\d{8}T\\d{9}Z:welcome$`).test(row.dedupeKey ?? "") &&
        O.outboxKind(row.dedupeKey) === "portal_invite" && O.subjectFor(O.outboxKind(row.dedupeKey), row.dedupeKey) === "Welcome to your Realtour Pilot content portal", row?.dedupeKey ?? "none");
      const wm = out.find((m) => m.to === "info+welcome@realtourpilot.com");
      c.ok("…the email: the welcome's subject, To the OWNER seat, Cc the Also email address, the sign-in line names the address, an \"Open your portal\" button",
        out.length === 1 && !!wm && wm.subject === "Welcome to your Realtour Pilot content portal" && wm.cc.join() === "jspackman215@gmail.com" &&
        wm.text.includes("To sign in, open the page below and enter info+welcome@realtourpilot.com.") && wm.text.includes("\nhttps://hub.example.test/portal/login\n") &&
        !!wm.html?.includes(">Open your portal</a>") && !EM_DASH.test(wm.html ?? ""), `${out.length} ${wm?.cc}`);
      c.ok("…the first welcome's identity is untouched (still one row)", (await prisma.outboxMessage.count({ where: { dedupeKey: PA.portalWelcomeKey(wSeat.id) } })) === 1);

      await new Promise((res) => setTimeout(res, 5));
      i = mails.length;
      const r2 = await A.resendWelcomeAction(wp.enrollmentId);
      c.ok("a second press is a second, separate welcome", r2.ok && since(i).length === 1 && (await prisma.outboxMessage.count({ where: { dedupeKey: { startsWith: `portal_invite:${wSeat.id}:welcome:` } } })) === 2);
      c.ok("…the card lists the resends (newest first) with who they went to", r2.state?.welcome.sent.length === 3 && r2.state.welcome.sent[0].resend && r2.state.welcome.sent[0].to === "info+welcome@realtourpilot.com" && !r2.state.welcome.sent[2].resend);

      // Oct 21 2026: the sign-in reminder (Jordan: "send a reminder to any
      // clients who have not signed in"). Same gates, the welcome's words with
      // one reminder line, its own subject, its own fresh identity.
      i = mails.length;
      const rem = await PA.resendPortalWelcome(wp.enrollmentId, { appUserId: null, actor: "drill" }, { reminder: true });
      const remOut = since(i);
      const remRow = (await prisma.outboxMessage.findMany({ where: { clientId: wp.clientId, dedupeKey: { endsWith: "-reminder:welcome" } } }))[0];
      const rm = remOut.find((m) => m.to === "info+welcome@realtourpilot.com");
      c.ok("REMINDER: sent to the OWNER seat with the Cc, under a -reminder identity that still reads as portal_invite",
        rem.ok && rem.message.startsWith("Sign-in reminder sent to info+welcome@realtourpilot.com") && !!remRow && O.outboxKind(remRow.dedupeKey) === "portal_invite" && !!rm && rm.cc.join() === "jspackman215@gmail.com", rem.message);
      c.ok("…subject \"Reminder: your Realtour Pilot content portal is ready\", the reminder line after the greeting, the sign-in steps kept",
        rm?.subject === "Reminder: your Realtour Pilot content portal is ready" && /^Hi [^\n]+,\n\nA quick reminder: your content portal is set up and waiting for you/.test(rm?.text ?? "") &&
        (rm?.text ?? "").includes("To sign in, open the page below and enter info+welcome@realtourpilot.com.") && !EM_DASH.test(rm?.text ?? ""), rm?.subject ?? "none");
      c.ok("…each one audited", (await prisma.auditLog.count({ where: { action: "portal_welcome_resent", target: wp.clientId } })) === 2);

      // Held, with the reason, and nothing queued.
      const real = await mkProgram("Riley Real");
      await mkSeat(real, "riley@example.test", "OWNER", "Riley Real");
      const heldOff = await A.resendWelcomeAction(real.enrollmentId);
      c.ok("a real client while invitations are off: held, says why, no outbox row", !heldOff.ok && /Client invitations are switched off/.test(heldOff.message) && (await prisma.outboxMessage.count({ where: { clientId: real.clientId } })) === 0, heldOff.message);
      await setSwitch("portal_invites", true);
      const scope = await PA.programEmailsState(real.enrollmentId);
      const heldScope = await A.resendWelcomeAction(real.enrollmentId);
      c.ok("switch on but outside the program rollout: held with the rollout's reason (and the card says so first)",
        !heldScope.ok && /not in the program rollout/.test(heldScope.message) && !scope?.welcome.gate.ok && (await prisma.outboxMessage.count({ where: { clientId: real.clientId } })) === 0, heldScope.message);
      await setSwitch("portal_invites", false);
      const colleague = await mkProgram("Colleague Inbox TEST");
      await mkSeat(colleague, "nick@realtourpilot.com", "OWNER");
      const heldTest = await A.resendWelcomeAction(colleague.enrollmentId);
      c.ok("a TEST client whose owner is not one of Jordan's inboxes: held", !heldTest.ok && /TEST client/.test(heldTest.message), heldTest.message);
      const empty = await mkProgram("Nobody Yet TEST");
      const heldEmpty = await A.resendWelcomeAction(empty.enrollmentId);
      c.ok("no owner seat: held, nobody to welcome", !heldEmpty.ok && /nobody to welcome/.test(heldEmpty.message), heldEmpty.message);

      // ---- 7 · the card ----------------------------------------------------
      c.head("7 · The card");
      const { ProgramEmailsCard } = await import("@/components/content/ProgramEmailsCard");
      const state = await PA.programEmailsState(wp.enrollmentId);
      const html = renderToStaticMarkup(createElement(ProgramEmailsCard, { enrollmentId: wp.enrollmentId, initial: state }));
      const words = html.replace(/<[^>]+>/g, " ").replace(/&rsquo;/g, "’").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
      c.ok("it shows who signs in (role, signed in or not), the Also email list, and the welcome with its resend button",
        words.includes("Signs in with") && words.includes("info+welcome@realtourpilot.com") && words.includes("Owner") && words.includes("Collaborator") && words.includes("Hasn't signed in yet") &&
        words.includes("Change sign-in email") && words.includes("Also email") && words.includes("jspackman215@gmail.com") && words.includes("Resend the welcome email") && words.includes("(resent)"), words.slice(0, 300));
      c.ok("plain, gender-neutral words, no em dash, 44px tap targets", !EM_DASH.test(html) && !/\b(he|she|her|his|him)\b/i.test(words) && html.includes("min-h-11"));
      const held = renderToStaticMarkup(createElement(ProgramEmailsCard, { enrollmentId: real.enrollmentId, initial: await PA.programEmailsState(real.enrollmentId) }));
      c.ok("a held welcome shows why, with no resend button", held.includes("Client invitations are switched off") && !held.includes("Resend the welcome email"));
      const ro = renderToStaticMarkup(createElement(ProgramEmailsCard, { enrollmentId: wp.enrollmentId, initial: state, canEdit: false }));
      c.ok("read-only: no change, add or resend controls", !ro.includes("Change sign-in email") && !ro.includes("Resend the welcome email") && !ro.includes(">Add<") && ro.includes("Read-only while previewing."));
    }

    // =========================================================================
    c.head("8 · Preview files");
    // =========================================================================
    {
      const { renderWelcomeEmail } = await import("@/lib/welcomeEmail");
      const { renderReminder, reminderTemplate } = await import("@/lib/reminderTemplates");
      const welcomeText = renderWelcomeEmail({
        firstName: "Sarah", signInUrl: "https://hub.realtourpilot.com/portal/login", signInEmail: "sarah.agent@example.com",
        discovery: { state: "needed" }, discoveryUrl: "https://calendly.com/realtourpilot-info/brand-discovery-call", strategyReady: false,
        planning: "CALL_OR_WRITTEN", strategyCallsOn: true, setupMissing: ["logo", "brand colors"],
      });
      const welcomeSubject = O.subjectFor("portal_invite", "portal_invite:m:welcome");
      const welcomeHtml = renderBrandedEmail({ subject: welcomeSubject, text: welcomeText });
      const shareText = renderReminder(reminderTemplate("scripts_ready.v1"), {
        firstName: "Sarah", month: "November", portalLink: "https://hub.realtourpilot.com/portal/auth/SampleOneTimeLinkNotRealxxxxxxxxxxxxxxxxxxx", bookCallLink: null, noCallEligible: false,
        answersStarted: false, sessionNote: null, earliestSession: null, itemCount: 3, titles: ["Why I love Lititz", "Three things buyers miss at open houses", "The 10-minute staging trick"], updatedTitles: ["Why I love Lititz"], deadline: null,
      });
      const shareHtml = renderBrandedEmail({ subject: O.subjectFor("script_share", "script_share:x"), text: shareText });
      c.ok("the welcome renders: a \"Book your call\" button in its first step, \"Open your portal\", numbered steps, no em dash",
        welcomeHtml.includes(">Book your call</a>") && welcomeHtml.includes(">Open your portal</a>") && /<ol class="rtp-list"/.test(welcomeHtml) && !EM_DASH.test(welcomeHtml));
      c.ok("the script share renders: the titles as a list, a \"Read your scripts\" button, no em dash",
        /<ul class="rtp-list"[^>]*>.*Three things buyers miss at open houses.*<\/ul>/.test(shareHtml) && shareHtml.includes(">Read your scripts</a>") && !EM_DASH.test(shareHtml));
      const dir = path.join(os.tmpdir(), "rtp-email-preview");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "welcome.html"), welcomeHtml);
      fs.writeFileSync(path.join(dir, "script-share.html"), shareHtml);
      console.log(`  previews written: ${path.join(dir, "welcome.html")} and ${path.join(dir, "script-share.html")}`);
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
