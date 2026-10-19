// ---------------------------------------------------------------------------
// LIVE (Oct 19 2026): tell Rick Schultz the portal downloads are fixed and his
// scripts download as one PDF (Jordan: "send rick an email letting him know
// the download issue was fixed, and the scripts are able to be downloaded in
// one full PDF, and to let us know if hes running into any other issues").
// Sent from info@ (strict: that mailbox or nothing). DRY RUN prints it; --apply sends.
// ---------------------------------------------------------------------------
export {};
const APPLY = process.argv.includes("--apply");
const TO = "schultz4@comcast.net";
const SUBJECT = "Your video downloads and scripts PDF are ready";
const BODY = [
  "Hi Rick,",
  "",
  "Good news: the download issue in your content library is fixed. When you tap Download on a video now, it saves the file instead of just playing it. On your phone, let it finish, then tap Share / save and choose Save Video to put it right in your Photos at full quality.",
  "",
  "You can also download all of your scripts in one PDF. On your portal, open your sessions (Read the scripts) and tap \"Download all scripts (PDF)\" at the top. It has all 48 scripts in the order we plan to film them, with the session date on each one.",
  "",
  "If you run into anything else, just reply here or text us and we'll take care of it.",
  "",
  "Thanks,",
  "Jordan",
  "Realtour Pilot",
].join("\n");

async function main() {
  if (/[–—]/.test(BODY + SUBJECT)) throw new Error("No dashes in client copy.");
  console.log(`To: ${TO}\nSubject: ${SUBJECT}\n\n${BODY}\n`);
  if (!APPLY) { console.log("DRY RUN: nothing sent. Re-run with --apply."); return; }
  const { sendGmailNew } = await import("@/lib/integrations/google");
  const r = await sendGmailNew({ mailbox: "info@realtourpilot.com", to: TO, subject: SUBJECT, body: BODY, strict: true });
  console.log(r.ok ? `SENT (Gmail id ${r.id ?? "unknown"})` : `NOT SENT: ${r.error}`);
  const { prisma } = await import("@/lib/prisma");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
