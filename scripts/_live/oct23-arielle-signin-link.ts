// Live one-off (Oct 23 2026, Jordan: Arielle Roemer "is having trouble opening
// the link… can you see what the issue might be and fix it?"). She has never
// signed in; every emailed link was a one-time sign-in link (24 h, and each new
// email replaced the last one's), and her older emails went to her Gmail while
// her sign-in is her Fox & Roach address. Mint ONE fresh emailed link and send
// it to both addresses. --apply sends.
import { prisma } from "@/lib/prisma";
import { mintLoginLink } from "@/lib/portalAccess";
const MEMBERSHIP = "cmv7d4e2700019kc68itrygkj";
const CLIENT = "cmt7msalo000b9kg1kuk666hf";
const TO = ["arielle.roemer@foxroach.com", "arielleroemer@gmail.com"];
(async () => {
  if (!process.argv.includes("--apply")) { console.log("dry run: would mint one 24-hour link and email it to", TO.join(", ")); await prisma.$disconnect(); return; }
  const { url, expiresAt } = await mintLoginLink(MEMBERSHIP, null, { emailed: true });
  const body = [
    "Hi Arielle,",
    "",
    "Here's your link to sign in to your Realtour Pilot content portal:",
    url,
    "",
    "It works once and lasts 24 hours. Once you're in, you can book your first filming session. If it gives you any trouble, just reply to this email.",
    "",
    "Jordan and the Realtour Pilot team",
  ].join("\n");
  const { sendThroughOutbox } = await import("@/lib/outbox");
  for (const to of TO) {
    const r = await sendThroughOutbox({ channel: "email", toRef: to, body, dedupeKey: `portal_login_manual:${MEMBERSHIP}:${to}:${expiresAt.toISOString()}`, clientId: CLIENT, requestedBy: "jordan-via-claude" });
    console.log(to, r.outcome, "error" in r ? r.error : "");
  }
  console.log("link expires", expiresAt.toISOString());
  await prisma.$disconnect();
})();
