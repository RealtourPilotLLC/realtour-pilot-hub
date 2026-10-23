// ---------------------------------------------------------------------------
// DRILL: portal sign-in links that keep working (Oct 23 2026).
//
// Arielle Roemer never got into her portal: every emailed link was a one-time
// link that lasted 24 hours, each new email REPLACED the link in the last
// (one hash column per person), and typing her Gmail (her client email) on the
// sign-in page sent nothing because her seat signs in with her Fox & Roach
// address. Now: every link is its own row (several live at once, each single
// use), emailed links last 7 days, the typed-request throttle only counts
// typed links, a link minted before the change is still accepted, and an
// address we know for the client gets the link at that address.
//
// ISOLATION: PGlite via the shared harness; nothing outbound (the email send
// is refused by the fence; the outbox row is what is checked).
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const PORT = Number(process.env.DRILL_PORT ?? 6752);
installNextStubs();
const mails: { to: string; text: string }[] = [];
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") return json({ access_token: "drill-access", expires_in: 3600 });
  if (u.hostname === "gmail.googleapis.com" && u.pathname.endsWith("/messages/send")) {
    const { raw } = JSON.parse(String(init?.body ?? "{}")) as { raw: string };
    const text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    mails.push({ to: /^To: (.+)$/m.exec(text)?.[1] ?? "", text });
    return json({ id: `gm-${mails.length}` });
  }
  return null;
});

async function main() {
  const { stop } = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct23-signin-links", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const pa = await import("@/lib/portalAccess");
    const { PROGRAM_ROLLOUT_SETTING_KEY } = await import("@/lib/programRolloutCore");
    const { renderSignInLinkEmail } = await import("@/lib/welcomeEmail");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    const now = new Date();
    await prisma.appSetting.create({ data: { key: PROGRAM_ROLLOUT_SETTING_KEY, value: JSON.stringify({ mode: "ALL", modeSince: now.toISOString(), pilot: null }) } });
    for (const key of ["portal_login_email", "portal_sign_in"]) await prisma.programAutomation.upsert({ where: { key }, create: { key, enabled: true, enabledAt: now }, update: { enabled: true } });

    c.head("1 · The world: Arielle, seat on her Fox & Roach address, Gmail on her client record");
    const client = await prisma.client.create({ data: { name: "Arielle Roemer", email: "arielle.personal@gmail.example" } });
    const enrollment = await prisma.contentEnrollment.create({ data: { clientId: client.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE", overridesJson: JSON.stringify({ alsoEmails: ["assistant@team.example"] }) } });
    const person = await prisma.clientUser.create({ data: { email: "arielle@brokerage.example", name: "Arielle Roemer", status: "INVITED" } });
    const seat = await prisma.clientMembership.create({ data: { clientUserId: person.id, enrollmentId: enrollment.id, clientId: client.id, role: "OWNER" } });
    c.ok("the world is built", !!seat);
    const tok = (url: string) => /\/portal\/auth\/([A-Za-z0-9_-]{40,60})/.exec(url)?.[1] ?? "";

    c.head("2 · Two emailed links both work; using one leaves the other");
    const a = await pa.mintLoginLink(seat.id, null, { emailed: true });
    const b = await pa.mintLoginLink(seat.id, null, { emailed: true });
    const days = (a.expiresAt.getTime() - now.getTime()) / 86_400_000;
    c.ok("an emailed link lasts 7 days", days > 6.99 && days < 7.01, days.toFixed(3));
    c.ok("the older link still peeks valid after a newer one is minted", (await pa.peekLoginToken(tok(a.url))).ok && (await pa.peekLoginToken(tok(b.url))).ok);
    const useB = await pa.consumeLoginToken(tok(b.url));
    c.ok("the newer link signs her in, and her account turns ACTIVE", useB.ok && (await prisma.clientUser.findUnique({ where: { id: person.id } }))?.status === "ACTIVE");
    c.ok("…the seat is accepted", !!(await prisma.clientMembership.findUnique({ where: { id: seat.id } }))?.acceptedAt);
    c.ok("a used link does not work twice", !(await pa.consumeLoginToken(tok(b.url))).ok && !(await pa.peekLoginToken(tok(b.url))).ok);
    c.ok("the OLDER link still works after the newer one was used", (await pa.consumeLoginToken(tok(a.url))).ok);
    const race = await pa.mintLoginLink(seat.id, null, { emailed: true });
    const [r1, r2] = await Promise.all([pa.consumeLoginToken(tok(race.url)), pa.consumeLoginToken(tok(race.url))]);
    c.ok("two presses of one link at once: exactly one wins", [r1, r2].filter((r) => r.ok).length === 1);

    c.head("3 · A link minted before the change (the old one-link columns) is still accepted");
    const raw = "L".repeat(43);
    await prisma.clientUser.update({ where: { id: person.id }, data: { loginTokenHash: createHash("sha256").update(raw).digest("hex"), loginTokenExpiresAt: new Date(now.getTime() + 3600_000) } });
    c.ok("legacy link peeks valid", (await pa.peekLoginToken(raw)).ok);
    c.ok("legacy link signs in once", (await pa.consumeLoginToken(raw)).ok && !(await pa.consumeLoginToken(raw)).ok);
    c.ok("new links no longer write the old columns", (await pa.mintLoginLink(seat.id, null, { emailed: true })) && (await prisma.clientUser.findUnique({ where: { id: person.id } }))?.loginTokenHash === null);
    const expired = await pa.mintLoginLink(seat.id, null, { emailed: true });
    await prisma.clientLoginToken.updateMany({ where: { tokenHash: createHash("sha256").update(tok(expired.url)).digest("hex") }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    c.ok("an expired link is refused", !(await pa.peekLoginToken(tok(expired.url))).ok && !(await pa.consumeLoginToken(tok(expired.url))).ok);

    c.head("4 · Typing an address: her seat address, her Gmail, the also-email; a 7-day link never blocks it");
    const rows = (to: string) => prisma.outboxMessage.findMany({ where: { dedupeKey: { startsWith: `portal_login:${person.id}:` }, toRef: to, state: "accepted" }, select: { body: true } });
    await pa.requestLoginLink("Arielle@Brokerage.example");
    const seatRows = await rows("arielle@brokerage.example");
    c.ok("her sign-in address gets a link, though she holds live 7-day emailed links", seatRows.length === 1 && /\/portal\/auth\//.test(seatRows[0].body), String(seatRows.length));
    c.ok("…and the email says it lasts 15 minutes", /expires in 15 minutes/.test(seatRows[0]?.body ?? ""));
    await pa.requestLoginLink("arielle@brokerage.example");
    c.ok("a second typed request inside 15 minutes sends nothing (the throttle)", (await rows("arielle@brokerage.example")).length === 1);
    await prisma.clientLoginToken.updateMany({ where: { clientUserId: person.id, purpose: "TYPED" }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    await pa.requestLoginLink("arielle.personal@gmail.example");
    const gmailRows = await rows("arielle.personal@gmail.example");
    c.ok("typing her client email (Gmail) emails the link TO her Gmail, for her seat", gmailRows.length === 1, String(gmailRows.length));
    const gmailLink = /\/portal\/auth\/([A-Za-z0-9_-]{40,60})/.exec(gmailRows[0]?.body ?? "")?.[1] ?? "";
    const signed = await pa.consumeLoginToken(gmailLink);
    c.ok("…and that link signs her in as her own account", signed.ok && signed.clientUserId === person.id);
    await prisma.clientLoginToken.updateMany({ where: { clientUserId: person.id, purpose: "TYPED" }, data: { expiresAt: new Date(now.getTime() - 1000) } });
    await pa.requestLoginLink("assistant@team.example");
    c.ok("an also-email on her program works too", (await rows("assistant@team.example")).length === 1);

    c.head("5 · Silence for strangers, and for an address two people share");
    const before = await prisma.outboxMessage.count();
    await pa.requestLoginLink("nobody@nowhere.example");
    c.ok("an unknown address sends nothing", (await prisma.outboxMessage.count()) === before);
    const shared = await prisma.client.create({ data: { name: "Team Shared", email: "front@desk.example" } });
    const en2 = await prisma.contentEnrollment.create({ data: { clientId: shared.id, package: "Starter", videosPerMonth: 2, sessionsPerMonth: 1, sessionHours: 2, status: "ACTIVE" } });
    for (const [i, role] of (["VIEWER", "VIEWER"] as const).entries()) {
      const p = await prisma.clientUser.create({ data: { email: `member${i}@desk.example`, name: `Member ${i}` } });
      await prisma.clientMembership.create({ data: { clientUserId: p.id, enrollmentId: en2.id, clientId: shared.id, role } });
    }
    const before2 = await prisma.outboxMessage.count();
    await pa.requestLoginLink("front@desk.example");
    c.ok("a client address behind two people (no single owner) sends nothing", (await prisma.outboxMessage.count()) === before2);

    c.head("6 · The words");
    c.ok("the sign-in email states the lifetime it is given", /expires in 7 days/.test(renderSignInLinkEmail({ firstName: "A", url: "https://x/portal/auth/abc", lifetime: "7 days" })) && /expires in 15 minutes/.test(renderSignInLinkEmail({ firstName: "A", url: "https://x" })));
    const outside = mails.filter((m) => !/info@realtourpilot\.com/.test(m.to)); // the office copy aside
    c.ok("every email went to the address typed (Gmail fake), and only those", outside.length === 3 && outside.some((m) => /arielle@brokerage\.example/.test(m.to)) && outside.some((m) => /arielle\.personal@gmail\.example/.test(m.to)) && outside.some((m) => /assistant@team\.example/.test(m.to)), mails.map((m) => m.to).join(","));
    c.ok("nothing else left the machine", fence.blocked.length === 0, fence.blocked.join(" "));
  } finally {
    c.summary();
    quiet.restore();
    await stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
