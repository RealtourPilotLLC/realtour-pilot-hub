// ---------------------------------------------------------------------------
// DRILL: DISREGARD A LEAD (Oct 26 2026).
//
//   node scripts/_drill/run-all.cjs scripts/_drill/oct26-lead-disregard.ts
//
// Kyle, on the Needs Kyle → Replies & admin board: "can we have an option to
// disregard these? a lot are spam". The lead rows had Complete and a status
// menu, nothing else; the Texts tab's Spam muted a number but a muted number
// still opened a lead and a Slack ping on its next text.
//
//   1. The vocabulary: a lead's two reasons stay off every other task's menu.
//   2. Spam on a phone lead: closed with who and why, the number muted and its
//      Texts row cut, and its next text opens no lead and no ping. Un-muting
//      brings its leads back. A number muted on the Texts tab opens no lead.
//   3. Not a lead: closed, nothing muted, and a new text brings it back.
//   4. A teammate's number is never muted; an email lead closed as spam never
//      reopens; someone outside the office cannot disregard Kyle's lead.
//   5. The wiring: the compact row and the full card offer it on open leads.
//
// Isolated PGlite; fetch and raw sockets fenced (Slack answered in-process);
// the signed-in person is a real signed session cookie.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";

const stubs = installNextStubs();

const slack: string[] = [];
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const fence = fenceFetch((url, init) => {
  if (!url.startsWith("https://slack.com/api/")) return null;
  try { slack.push(String((JSON.parse(String(init?.body ?? "{}")) as { text?: string }).text ?? "")); } catch { slack.push(""); }
  return json({ ok: true, ts: String(slack.length) });
});

const REPO = path.resolve(__dirname, "../..");
const read = (f: string) => fs.readFileSync(path.join(REPO, f), "utf8");

async function main() {
  const db = await bootDrillDb({ port: Number(process.env.DRILL_PORT ?? 5981), env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct26-lead-disregard" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    c.head("§1 · the vocabulary");
    const triage = await import("@/lib/triage");
    c.ok("a lead's reasons are Spam and Not a lead", JSON.stringify(triage.LEAD_DISMISS_REASONS) === JSON.stringify(["spam", "not a lead"]));
    c.ok("…and 'not a lead' stays off every other task's Not needed menu", !(triage.DISMISS_REASONS as readonly string[]).includes("not a lead"));
    c.ok("a spam stamp reads as spam", triage.isSpamDismissal("Dismissed by Kyle Smith — spam.\nNew texter …") && !triage.isSpamDismissal("Dismissed by Kyle Smith — not a lead.") && !triage.isSpamDismissal("Auto-closed: this number is muted as spam"));

    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("slack", ["xo", "xb", "drill-not-a-real-token"].join("-"));
    const harrison = await prisma.teamMember.create({ data: { name: "Harrison Wells", email: "harrison@drill.invalid", role: "PHOTOGRAPHER", phone: "(610) 555-0144", active: true } });
    const kyleTm = await prisma.teamMember.create({ data: { name: "Kyle Smith", email: "hello@realtourpilot.com", role: "MANAGER", phone: "(215) 645-4889", active: true } });
    const kyle = await prisma.appUser.create({ data: { email: "hello@realtourpilot.com", name: "Kyle Smith", role: "ADMIN", status: "ACTIVE", teamMemberId: kyleTm.id } });
    const hUser = await prisma.appUser.create({ data: { email: "harrison@drill.invalid", name: "Harrison Wells", role: "PHOTOGRAPHER", status: "ACTIVE", teamMemberId: harrison.id } });
    const { signSession, SESSION_COOKIE } = await import("@/lib/auth/jwt");
    const signIn = async (u: { id: string; email: string; name: string | null; role: string }) => stubs.cookies.set(SESSION_COOKIE, await signSession({ uid: u.id, email: u.email, role: u.role, name: u.name ?? undefined }));
    await signIn(kyle);

    const { upsertPhoneLeadTask } = await import("@/lib/webhooks/openphone");
    const { dismissTask, markCommsHandled, unmuteCommsNumber } = await import("@/app/actions");
    const { commsMuteKey, threadAckKey, isMutedNumber } = await import("@/lib/replyQueue");
    const lead = (phone: string) => prisma.smartTask.findUnique({ where: { dedupeKey: `lead-${phone}` } });
    const setting = (key: string) => prisma.appSetting.findUnique({ where: { key } });

    c.head("§2 · Spam on a phone lead");
    await upsertPhoneLeadTask({ phone: "6105550199", kind: "text", senderName: null, snippet: "Get 5,000 followers today!!! Reply YES" });
    const spam = await lead("6105550199");
    const perLead = slack.length;
    c.ok("the texter is a lead, open, with its Slack ping", spam?.status === "OPEN" && perLead > 0, `${spam?.status} · ${perLead} post(s)`);
    const r1 = await dismissTask(spam!.id, "spam");
    const after = await lead("6105550199");
    c.ok("Disregard → Spam closes it as CANCELLED, never COMPLETED", r1.ok && after?.status === "CANCELLED" && after.completedAt === null, JSON.stringify(r1));
    c.ok("…with who and why on the row, the texter's words kept under it", (after?.summary ?? "").startsWith("Dismissed by Kyle Smith — spam.\n") && /not a client we recognize/.test(after?.summary ?? ""), (after?.summary ?? "").slice(0, 120));
    c.ok("…and says what it did: the number is muted, and where to undo it", /muted/.test(r1.message) && /un-mutes it on Messages/.test(r1.message) && !/[—–]/.test(r1.message), r1.message);
    c.ok("the number is muted (comms-mute) and its Texts conversation cut (thread ack, reason spam)", !!(await setting(commsMuteKey("6105550199"))) && /\|spam$/.test((await setting(threadAckKey("phone", "p:6105550199")))?.value ?? ""));
    const pingsBefore = slack.length;
    await upsertPhoneLeadTask({ phone: "6105550199", kind: "text", senderName: null, snippet: "Last chance!!!" });
    await upsertPhoneLeadTask({ phone: "6105550199", kind: "call", senderName: null, snippet: "" });
    c.ok("its next text and its next missed call open no lead and ping nobody", (await lead("6105550199"))?.status === "CANCELLED" && slack.length === pingsBefore, `${(await lead("6105550199"))?.status} · ${slack.length - pingsBefore} new ping(s)`);
    c.ok("a second Disregard on the closed row is harmless", (await dismissTask(spam!.id, "spam")).ok);

    await markCommsHandled(null, "phone", undefined, { threadKey: "p:6105550188", reason: "spam" });
    await upsertPhoneLeadTask({ phone: "6105550188", kind: "voicemail", senderName: null, snippet: "This is your car's extended warranty" });
    c.ok("a number marked Spam on the Texts tab opens no lead either (it used to)", !(await lead("6105550188")) && slack.length === pingsBefore);
    c.ok("the Texts tab's Spam still mutes through the shared helper", await isMutedNumber("6105550188"));

    await unmuteCommsNumber("6105550199");
    await upsertPhoneLeadTask({ phone: "6105550199", kind: "text", senderName: null, snippet: "Hi, it's actually Dana, I'm an agent in Malvern" });
    c.ok("un-muting on Messages brings that number's leads back, ping and all (the mute is the one switch)", (await lead("6105550199"))?.status === "OPEN" && slack.length > pingsBefore, `${(await lead("6105550199"))?.status}`);

    c.head("§3 · Not a lead");
    await upsertPhoneLeadTask({ phone: "6105550177", kind: "call", senderName: null, snippet: "" });
    const vendor = await lead("6105550177");
    const r2 = await dismissTask(vendor!.id, "not a lead");
    const v2 = await lead("6105550177");
    c.ok("Disregard → Not a lead closes it with that reason", r2.ok && v2?.status === "CANCELLED" && (v2.summary ?? "").startsWith("Dismissed by Kyle Smith — not a lead."), v2?.summary?.slice(0, 80));
    c.ok("…says a new message brings it back, and mutes nothing", /comes back/.test(r2.message) && !(await isMutedNumber("6105550177")) && !(await setting(threadAckKey("phone", "p:6105550177"))), r2.message);
    await upsertPhoneLeadTask({ phone: "6105550177", kind: "text", senderName: null, snippet: "Following up on my call" });
    c.ok("…and it does: their next text reopens the lead", (await lead("6105550177"))?.status === "OPEN");

    c.head("§4 · the edges");
    const teammate = await prisma.smartTask.create({ data: { taskType: "lead", title: "New texter — reply to (610) 555-0144", source: "openphone", sourceDetail: "phone:(610) 555-0144", status: "OPEN", dedupeKey: "lead-6105550144" } });
    const r3 = await dismissTask(teammate.id, "spam");
    c.ok("a teammate's number is never muted (Harrison's status texts are the field talking)", r3.ok && /one of our own numbers/.test(r3.message) && !(await isMutedNumber("6105550144")), r3.message);
    const emailLead = await prisma.smartTask.create({ data: { taskType: "lead", title: "New lead: SEO Experts", source: "gmail", sourceDetail: "gmail:thread-1", status: "OPEN", dedupeKey: "lead-seo@spam.example" } });
    const r4 = await dismissTask(emailLead.id, "spam");
    c.ok("an email lead closed as spam: that sender won't open a new lead", r4.ok && /sender won't open a new lead/.test(r4.message) && triage.isSpamDismissal((await prisma.smartTask.findUnique({ where: { id: emailLead.id } }))?.summary), r4.message);
    const g = read("src/lib/integrations/google.ts");
    c.ok("…the Gmail lead path checks for it before reopening (and still logs the mail)", /if \(existing\?\.status === "CANCELLED" && isSpamDismissal\(existing\.summary\)\) return 0;/.test(g));
    await upsertPhoneLeadTask({ phone: "6105550166", kind: "text", senderName: null, snippet: "Price for drone?" });
    await signIn(hUser);
    const r5 = await dismissTask((await lead("6105550166"))!.id, "spam");
    c.ok("someone outside the office can't disregard Kyle's lead", !r5.ok && (await lead("6105550166"))?.status === "OPEN" && !(await isMutedNumber("6105550166")), r5.message);
    await signIn(kyle);
    const r6 = await dismissTask((await lead("6105550166"))!.id, "whatever");
    c.ok("an unknown reason falls back to 'not needed', as before", r6.ok && ((await lead("6105550166"))?.summary ?? "").startsWith("Dismissed by Kyle Smith — not needed."));

    c.head("§5 · the wiring");
    const row = read("src/components/queue/TaskCompactRow.tsx");
    const card = read("src/components/queue/TaskCard.tsx");
    const btn = read("src/components/tasks/ChecklistButtons.tsx");
    c.ok("the compact row (Needs Kyle → Replies & admin) offers Disregard on an open lead, never to an editor", /task\.taskType === "lead" && !editorView && task\.status !== "COMPLETED" && task\.status !== "CANCELLED" && \(\s*<LeadDisregardButton/.test(row));
    c.ok("the full card (behind Review reply) offers it too", /task\.taskType === "lead" && task\.status !== "CANCELLED" && \(\s*<LeadDisregardButton/.test(card));
    c.ok("the button asks Spam or Not a lead, says what each does, and the server's words outlive the row (the board's notice)", /pick\("spam"\)/.test(btn) && /pick\("not a lead"\)/.test(btn) && /Spam mutes the number/.test(btn) && /flashNotice\(r\.message\)/.test(btn) && /setSaid\(r\.message\)/.test(btn) && /<NoticeHost \/>/.test(read("src/components/tasks/BoardView.tsx")));
    c.ok("nothing left the machine but Slack", fence.blocked.every((u) => !/openphone|quo|googleapis/i.test(u)), `${fence.blocked.length} blocked`);
  } finally {
    quiet.restore();
    c.summary();
    await db.stop();
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
