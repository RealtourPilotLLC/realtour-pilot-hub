// @drill-run: conditions=none require=./scripts/_drill/_client-drill-preload.cjs
// ---------------------------------------------------------------------------
// DRILL: answer email in the hub, newest first, one week open (Oct 27 2026).
//
// Jordan: "One queue + Gmail draft. I want to be able to respond to emails in
// the hub. Also - newest emails should be at the top so we dont have to scroll
// to the bottom. Older than 7 days should be collapsed."
//
//   1. Who may send: signed out, a photographer, an editor and the creative
//      manager are refused (send, the reply box's header, the draft); an
//      owner previewing as Kyle is refused; nothing reaches Gmail.
//   2. An empty reply is refused before anything else happens (blank,
//      whitespace, not a string); so is a send with no identity.
//   3. The reply box's header: To (from the Gmail thread), From (the mailbox
//      it arrived in), the "Re:" subject; a mailbox without the send scope
//      says so plainly (owner and Kyle get different next steps); a row the
//      viewer can't read is not one they can answer.
//   4. THE SEND, through the real Gmail provider: one message, in the same
//      Gmail thread (threadId), To = the client, From = the mailbox,
//      In-Reply-To = their newest message, References = its chain plus it,
//      "Re: Floor plan" (never "Re: Re:"), the words untouched, Jordan's
//      blind copy on the same message. Logged as the Sent-folder reader would
//      (gmail-sent-<thread>-<id>, "Us", Kyle as sender), on the client's job
//      timeline, the thread's reply to-do closed (a revision stays open),
//      Waiting on us cleared, the thread's newest message is the reply. A
//      second press of the same reply never sends twice.
//   5. Refusals that send nothing: Gmail answers 403 (the clear reconnect
//      message, the owner told, the press can be retried), the thread's
//      recipient changed since the box opened, a test client, and on the
//      client page a recipient who isn't the client's email on file.
//   6. The client page's reply (by Gmail thread): "Re:" added to a fresh
//      subject, References = the one Message-ID.
//   7. Newest first and the seven-day fold: the helpers (ties, unreadable
//      dates, the exact boundary, all-old keeps the newest, the label), the
//      Email view's thread read, and the rendered thread (order, the fold
//      closed with its count, the reply box open on a Reply); a thread with
//      no Gmail id says to answer it in Gmail; the client page's card reads
//      the same helpers.
//
// ISOLATION: PGlite on 127.0.0.1 (DRILL_PORT). Gmail is a fake answered
// in-process at the HTTP fence (token, tokeninfo, message, thread, send): the
// shipped provider code runs and every raw message it hands "Gmail" is decoded
// and recorded here. Every other outbound call is blocked. NO REAL EMAIL.
// ---------------------------------------------------------------------------
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { bootDrillDb, installNextStubs, fenceFetch, makeChecker, quietPrismaErrors } from "./_harness";
import { plainTextOfMime } from "@/lib/emailHtml";

const PORT = Number(process.env.DRILL_PORT ?? 6971);
const DAY = 86_400_000;
const H = 3_600_000;

installNextStubs();
const navigation = createRequire(__filename)("next/navigation") as { useRouter: () => { refresh: () => void } };
navigation.useRouter = () => ({ refresh() {} });

// ---- the fake Gmail ------------------------------------------------------------
type Sent = { raw: string; threadId: string | null; to: string; from: string; subject: string; inReplyTo: string; references: string; bcc: string; body: string };
const sends: Sent[] = [];
const attempts: string[] = []; // every /messages/send call, accepted or not
const gmailCalls: string[] = [];
const msgThread = new Map<string, string>(); // Gmail message id → thread id
type Hdr = { name: string; value: string };
const threads = new Map<string, { id: string; messages: { id: string; threadId: string; payload: { headers: Hdr[] } }[] }>();
let scope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
let sendStatus = 200;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const fence = fenceFetch(async (url, init) => {
  const u = new URL(url);
  if (u.hostname === "oauth2.googleapis.com") {
    if (u.pathname.startsWith("/tokeninfo")) return json({ scope });
    return json({ access_token: "drill-access", expires_in: 3600 });
  }
  if (u.hostname !== "gmail.googleapis.com") return null;
  gmailCalls.push(`${(init?.method ?? "GET").toUpperCase()} ${u.pathname}${u.search}`);
  if (u.pathname.endsWith("/messages/send")) {
    attempts.push(url);
    if (sendStatus !== 200) return json({ error: { code: sendStatus, message: "drill: refused" } }, sendStatus);
    const posted = JSON.parse(String(init?.body ?? "{}")) as { raw: string; threadId?: string };
    const raw = Buffer.from(posted.raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const head = raw.slice(0, raw.indexOf("\r\n\r\n")).split("\r\n");
    const val = (name: string) => head.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}: `))?.slice(name.length + 2) ?? "";
    const enc = /^=\?UTF-8\?B\?(.+)\?=$/.exec(val("Subject"))?.[1];
    sends.push({
      raw,
      threadId: posted.threadId ?? null,
      to: val("To").trim().toLowerCase(),
      from: val("From").trim(),
      subject: enc ? Buffer.from(enc, "base64").toString("utf8") : val("Subject"),
      inReplyTo: val("In-Reply-To"),
      references: val("References"),
      bcc: val("Bcc").trim().toLowerCase(),
      body: plainTextOfMime(raw),
    });
    return json({ id: `sent${sends.length}`, threadId: posted.threadId ?? null });
  }
  const t = /\/threads\/([^/]+)$/.exec(u.pathname);
  if (t) {
    const th = threads.get(decodeURIComponent(t[1]));
    return th ? json(th) : json({ error: "not found" }, 404);
  }
  const m = /\/messages\/([^/]+)$/.exec(u.pathname);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const th = msgThread.get(id);
    return th ? json({ id, threadId: th }) : json({ error: "not found" }, 404);
  }
  return null;
});

/** One Gmail thread, oldest message first (as Gmail returns it). */
function gmailThread(id: string, msgs: { id: string; from: string; subject: string; messageId: string; references?: string; replyTo?: string }[]) {
  threads.set(id, {
    id,
    messages: msgs.map((x) => {
      msgThread.set(x.id, id);
      const headers: Hdr[] = [
        { name: "From", value: x.from },
        { name: "Subject", value: x.subject },
        { name: "Message-ID", value: x.messageId },
      ];
      if (x.references) headers.push({ name: "References", value: x.references });
      if (x.replyTo) headers.push({ name: "Reply-To", value: x.replyTo });
      return { id: x.id, threadId: id, payload: { headers } };
    }),
  });
}

async function main() {
  const drill = await bootDrillDb({ port: PORT, env: { AUTH_ENFORCE: "true", APP_SECRET: "isolated-oct27-email-replies", NEXT_PUBLIC_APP_URL: "https://hub.example.test" } });
  const quiet = quietPrismaErrors();
  const c = makeChecker();
  try {
    const { prisma } = await import("@/lib/prisma");
    const { saveSecret } = await import("@/lib/integrations/connections");
    await saveSecret("gmail", JSON.stringify({ "info@realtourpilot.com": "drill-refresh-token" }));
    const { setSession, clearSession } = await import("@/lib/auth/session");
    const A = await import("@/app/emailActions");
    const { getEmailThreads } = await import("@/components/comms/emailThreads");
    const O = await import("@/components/comms/emailOrder");
    const { EmailThreadList } = await import("@/components/comms/EmailThreadList");
    const { messagesBoard } = await import("@/lib/opsHome");
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);

    // ---- the office, and everyone who is not the office ----------------------------
    const tm = (name: string, role: "MANAGER" | "PHOTOGRAPHER", email: string) => prisma.teamMember.create({ data: { name, role, email } });
    const kyleTm = await tm("Kyle Smith", "MANAGER", "kyle@oct27e.invalid");
    const jordanTm = await tm("Jordan Spackman", "PHOTOGRAPHER", "jordan@oct27e.invalid");
    const user = (name: string, email: string, role: string, teamMemberId?: string) => prisma.appUser.create({ data: { name, email, role, teamMemberId, status: "ACTIVE" } });
    const kyle = await user("Kyle Smith", kyleTm.email!, "ADMIN", kyleTm.id);
    const owner = await user("Jordan Spackman", jordanTm.email!, "OWNER", jordanTm.id);
    const shooter = await user("Harrison Shooter", "harrison@oct27e.invalid", "PHOTOGRAPHER");
    const editor = await user("Edna Editor", "edna@oct27e.invalid", "EDITOR");
    const creative = await user("Cam Creative", "cam@oct27e.invalid", "CREATIVE_MANAGER");
    const signIn = (u: { id: string; email: string; role: string }, actingAs?: string) => setSession({ uid: u.id, email: u.email, role: u.role, ...(actingAs ? { actingAs } : {}) });

    // ---- Bea, her job, and her "Floor plan" thread (20, 10, 3 and 1 day old) -------
    const bea = await prisma.client.create({ data: { name: "Bea Broker", email: "bea@agent.example" } });
    await prisma.project.create({ data: { clientId: bea.id, title: "1 Old Rd, Town", status: "DELIVERED", orderedAt: ago(40 * DAY) } });
    const beaJob = await prisma.project.create({ data: { clientId: bea.id, title: "4 Elm St, Town", status: "DELIVERED", orderedAt: ago(5 * DAY) } });
    const email = (data: Record<string, unknown>) =>
      prisma.commLog.create({ data: { channel: "email", source: "gmail", direction: "in", clientId: bea.id, clientName: bea.name, contactName: bea.name, ...data } as never });
    const m1 = await email({ subject: "Floor plan", body: "Is the floor plan for 4 Elm St coming?", externalId: "gmail-info@realtourpilot.com:msgA1", occurredAt: ago(20 * DAY) });
    const m2 = await email({ direction: "out", source: "gmail-sent", contactName: "Us", subject: "Re: Floor plan", body: "It comes with the photos.", externalId: "gmail-sent-thrFP-msgA2", occurredAt: ago(10 * DAY) });
    const m3 = await email({ subject: "Re: Floor plan", body: "Got the photos, thanks.", externalId: "gmail-info@realtourpilot.com:msgA3", occurredAt: ago(3 * DAY) });
    const m4 = await email({ subject: "RE: Floor plan", body: "The kitchen is missing from the floor plan.", externalId: "gmail-INFO@realtourpilot.com:msgA4", occurredAt: ago(1 * DAY) });
    gmailThread("thrFP", [
      { id: "msgA1", from: "Bea Broker <bea@agent.example>", subject: "Floor plan", messageId: "<a1@agent.example>" },
      { id: "msgA2", from: "Realtour Pilot <info@realtourpilot.com>", subject: "Re: Floor plan", messageId: "<a2@realtourpilot.com>", references: "<a1@agent.example>" },
      { id: "msgA3", from: "Bea Broker <bea@agent.example>", subject: "Re: Floor plan", messageId: "<a3@agent.example>", references: "<a1@agent.example> <a2@realtourpilot.com>" },
      { id: "msgA4", from: "Bea Broker <bea@agent.example>", subject: "Re: Floor plan", messageId: "<a4@agent.example>", references: "<a1@agent.example>\r\n <a2@realtourpilot.com> <a3@agent.example>" },
    ]);
    const replyTask = await prisma.smartTask.create({ data: { taskType: "client_reply", source: "gmail", sourceDetail: "gmail-thread:info@realtourpilot.com:thrFP", title: "Reply to Bea Broker: Floor plan", status: "OPEN", clientId: bea.id } as never });
    const revisionTask = await prisma.smartTask.create({ data: { taskType: "revision", source: "gmail", sourceDetail: "gmail-thread:info@realtourpilot.com:thrFP", title: "Floor plan: add the kitchen", status: "OPEN", clientId: bea.id } as never });
    const logTarget = { kind: "log" as const, commLogId: m4.id };
    let seq = 0;
    const intent = () => `drillintent${String(++seq).padStart(4, "0")}`;
    const quietGmail = () => ({ calls: gmailCalls.length, attempts: attempts.length, sends: sends.length });
    const nothingMoved = (before: ReturnType<typeof quietGmail>) => gmailCalls.length === before.calls && attempts.length === before.attempts && sends.length === before.sends;

    // =====================================================================
    c.head("1 · who may send: the office only (the same guard as Messages)");
    // =====================================================================
    {
      const before = quietGmail();
      await clearSession();
      const out = await A.sendEmailThreadReply(logTarget, "Hi Bea", intent());
      c.ok("signed out: refused, asked to sign in", !out.ok && /sign in/i.test(out.message), out.message);
      for (const u of [shooter, editor, creative]) {
        await signIn(u);
        const r = await A.sendEmailThreadReply(logTarget, "Hi Bea", intent());
        const p = await A.prepareEmailReply(logTarget);
        const d = await A.draftEmailThreadReply(logTarget);
        c.ok(`${u.role}: Send, the reply box's header and the draft are all refused`, !r.ok && /don't have access/.test(r.message) && !p.ok && !p.to && !d.ok && !d.draft, `${r.message} | ${p.message} | ${d.message}`);
      }
      await signIn(owner, kyle.id);
      const preview = await A.sendEmailThreadReply(logTarget, "Hi Bea", intent());
      c.ok("an owner previewing as Kyle is refused (exit the preview to send)", !preview.ok && /previewing/.test(preview.message), preview.message);
      c.ok("…and none of it reached Gmail: no read, no send", nothingMoved(before), gmailCalls.slice(before.calls).join(" | "));
    }

    // =====================================================================
    c.head("2 · an empty reply is refused, before anything else happens");
    // =====================================================================
    {
      await signIn(kyle);
      const before = quietGmail();
      const blanks = await Promise.all(["", "   \n\t  ", null as never, undefined as never, 42 as never].map((b) => A.sendEmailThreadReply(logTarget, b, intent())));
      c.ok("blank, whitespace-only and non-text bodies: \"Write the reply first. Nothing was sent.\"", blanks.every((r) => !r.ok && r.message === "Write the reply first. Nothing was sent."), blanks.map((r) => r.message).join(" | "));
      const noId = await A.sendEmailThreadReply(logTarget, "Hi Bea", "short");
      c.ok("a send with no proper identity is refused rather than guessed (it could double up)", !noId.ok && /couldn't identify this send/.test(noId.message), noId.message);
      c.ok("…none of them asked Gmail anything", nothingMoved(before));
    }

    // =====================================================================
    c.head("3 · the reply box's header: who it goes to, from where, and can it send");
    // =====================================================================
    {
      await signIn(kyle);
      const p = await A.prepareEmailReply(logTarget);
      c.ok("To Bea (read from the Gmail thread), from the mailbox it arrived in, \"Re: Floor plan\", sending allowed", p.ok && p.to === "bea@agent.example" && p.from === "info@realtourpilot.com" && p.subject === "Re: Floor plan" && p.canSend === true, JSON.stringify(p));
      c.ok("…the thread was found from the email's own Gmail id (one metadata read)", gmailCalls.some((x) => x === "GET /gmail/v1/users/me/messages/msgA4?format=minimal"));
      const before = quietGmail();
      scope = "https://www.googleapis.com/auth/gmail.readonly";
      const k = await A.prepareEmailReply(logTarget);
      c.ok("no send scope: a clear message for Kyle (Jordan has been asked; use Open in Gmail), and who it would go to", !k.ok && k.needsReconnect === true && k.canSend === false && k.to === "bea@agent.example" && k.message === "Gmail can read info@realtourpilot.com but can't send from it yet. Jordan has been asked to reconnect Google. Nothing was sent; use Open in Gmail for now.", k.message);
      await signIn(owner);
      const o = await A.prepareEmailReply(logTarget);
      c.ok("…and for Jordan, the step only he can take (reconnect Google and allow sending)", !o.ok && o.message === "Gmail can read info@realtourpilot.com but can't send from it yet. Reconnect Google in Connections and allow sending. Nothing was sent.", o.message);
      scope = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
      c.ok("…reading the header never sends", attempts.length === before.attempts);
      // A row Kyle can't read on the Email view is not one he can answer.
      const ownerOnly = await prisma.commLog.create({ data: { channel: "email", source: "gmail", direction: "in", minRole: "OWNER", contactName: "A lead", subject: "Private", body: "Owner only", externalId: "gmail-info@realtourpilot.com:msgP1", occurredAt: ago(H) } as never });
      await signIn(kyle);
      const hidden = await A.prepareEmailReply({ kind: "log", commLogId: ownerOnly.id });
      const hiddenSend = await A.sendEmailThreadReply({ kind: "log", commLogId: ownerOnly.id }, "Hello", intent());
      c.ok("an owner-only email: Kyle can neither see who it goes to nor send", !hidden.ok && !hidden.to && !hiddenSend.ok && /isn't in the hub any more/.test(hiddenSend.message), hiddenSend.message);
      const ours = await A.prepareEmailReply({ kind: "log", commLogId: m2.id });
      c.ok("our own sent email is not something a reply is threaded onto", !ours.ok && ours.message === "This email can only be answered in Gmail.", ours.message);
    }

    // =====================================================================
    c.head("4 · THE SEND: one email, in the same Gmail thread, with the right headers");
    // =====================================================================
    const beforeBoard = await messagesBoard({ now: new Date(), viewer: { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id } });
    c.ok("before: Bea's email is waiting on us", beforeBoard.waiting.some((w) => w.family === "email" && w.group.clientId === bea.id));
    await signIn(kyle);
    const words = "Hi Bea,\n\nThanks for catching that. The kitchen goes on the floor plan today and I'll send it over by 5 PM.\n\nKyle";
    const sendIntent = intent();
    const s0 = sends.length;
    const sent = await A.sendEmailThreadReply(logTarget, `  ${words}\n`, sendIntent, "bea@agent.example");
    const mail = sends[s0];
    c.ok("Send: \"Sent to bea@agent.example.\"", sent.ok && sent.message === "Sent to bea@agent.example." && sent.to === "bea@agent.example", sent.message);
    c.ok("exactly one email went to Gmail", sends.length === s0 + 1 && attempts.length === sends.length);
    c.ok("threadId: the same Gmail thread (thrFP)", mail?.threadId === "thrFP", String(mail?.threadId));
    c.ok("To: Bea, the other party (not us)", mail?.to === "bea@agent.example", mail?.to);
    c.ok("From: the mailbox the email arrived in", mail?.from === "info@realtourpilot.com", mail?.from);
    c.ok("Subject: \"Re: Floor plan\" (her \"Re:\" kept, never \"Re: Re:\")", mail?.subject === "Re: Floor plan", mail?.subject);
    c.ok("In-Reply-To: her newest message's Message-ID", mail?.inReplyTo === "<a4@agent.example>", mail?.inReplyTo);
    c.ok("References: her message's whole chain, then her Message-ID (one line, in order)", mail?.references === "<a1@agent.example> <a2@realtourpilot.com> <a3@agent.example> <a4@agent.example>", mail?.references);
    c.ok("the words as written (trimmed), nothing added", mail?.body.trim() === words, mail?.body);
    c.ok("Jordan's blind copy rides on the same message, not a second email", mail?.bcc === "info@realtourpilot.com", mail?.bcc);
    const logged = await prisma.commLog.findFirst({ where: { direction: "out", externalId: "gmail-sent-thrFP-sent1" } });
    c.ok("logged as the Gmail Sent reader logs our replies (gmail-sent-<thread>-<id>, \"Us\", Kyle as sender), so the next Gmail scan can't double it", !!logged && logged.source === "gmail-sent" && logged.channel === "email" && logged.contactName === "Us" && logged.clientId === bea.id && logged.senderTeamMemberId === kyleTm.id && logged.body === words && logged.subject === "Re: Floor plan", JSON.stringify(logged));
    const act = await prisma.activity.findFirst({ where: { projectId: beaJob.id }, orderBy: { createdAt: "desc" } });
    c.ok("on Bea's activity: her latest job's timeline says who sent what", !!act && act.body.startsWith("Email reply sent to bea@agent.example by Kyle Smith: Hi Bea,") && act.authorId === kyleTm.id, act?.body);
    const taskAfter = await prisma.smartTask.findUnique({ where: { id: replyTask.id }, select: { status: true } });
    const revAfter = await prisma.smartTask.findUnique({ where: { id: revisionTask.id }, select: { status: true } });
    c.ok("the thread's reply to-do is done; the revision raised from it stays open", taskAfter?.status === "COMPLETED" && revAfter?.status === "OPEN", `${taskAfter?.status} / ${revAfter?.status}`);
    const afterBoard = await messagesBoard({ now: new Date(), viewer: { key: "kyle", role: "ADMIN", teamMemberId: kyleTm.id } });
    c.ok("Waiting on us: Bea's email is answered (off the queue)", !afterBoard.waiting.some((w) => w.family === "email" && w.group.clientId === bea.id));
    const refreshed = (await getEmailThreads()).threads.find((t) => t.key === `floor plan::${bea.id}`);
    c.ok("the refreshed thread shows the reply at the top", refreshed?.messages[0]?.direction === "out" && refreshed.messages[0].body === words && refreshed.lastDirection === "out", refreshed?.messages[0]?.body);
    const again = await A.sendEmailThreadReply(logTarget, words, sendIntent, "bea@agent.example");
    c.ok("a second press of the same reply: \"Already sent\", and Gmail got nothing new", again.ok && /Already sent to bea@agent.example/.test(again.message) && sends.length === s0 + 1 && attempts.length === s0 + 1, again.message);
    c.ok("…and the log has the reply once", await prisma.commLog.count({ where: { direction: "out", source: "gmail-sent", clientId: bea.id, body: words } }) === 1);

    // =====================================================================
    c.head("5 · refusals that send nothing");
    // =====================================================================
    {
      await signIn(kyle);
      const forbid = intent();
      const before = sends.length;
      sendStatus = 403;
      const r403 = await A.sendEmailThreadReply(logTarget, "One more thing", forbid);
      sendStatus = 200;
      c.ok("Gmail answers 403: the clear reconnect message, nothing sent", !r403.ok && r403.needsReconnect === true && r403.message === "Gmail can read info@realtourpilot.com but can't send from it yet. Jordan has been asked to reconnect Google. Nothing was sent; use Open in Gmail for now." && sends.length === before, r403.message);
      const fix = await prisma.smartTask.findFirst({ where: { taskType: "connection_fix" }, select: { status: true } });
      c.ok("…Jordan is told (a reconnect to-do), and the press is free to retry (its claim was let go)", fix?.status === "OPEN" && await prisma.webhookEvent.count({ where: { provider: "hub-email-reply", externalId: forbid } }) === 0);
      const moved = await A.sendEmailThreadReply(logTarget, "One more thing", intent(), "someone@else.example");
      c.ok("the thread's recipient changed since the box opened: refused, nothing sent", !moved.ok && /The thread changed\. The reply would now go to bea@agent\.example/.test(moved.message) && sends.length === before, moved.message);
      // A test client is only ever written to at Jordan's own test inboxes.
      const cara = await prisma.client.create({ data: { name: "Cara TEST", email: "cara@agent.example" } });
      gmailThread("thrCT", [{ id: "msgC1", from: "Cara <cara@agent.example>", subject: "Hello", messageId: "<c1@agent.example>" }]);
      const tc = await A.sendEmailThreadReply({ kind: "gmail", clientId: cara.id, mailbox: "info@realtourpilot.com", threadId: "thrCT" }, "Hi Cara", intent());
      c.ok("a test client: refused unless it's one of Jordan's test inboxes, nothing sent", !tc.ok && /Cara TEST is a test client/.test(tc.message) && sends.length === before, tc.message);
      // Client page: the reply must go to the client's own email on file.
      gmailThread("thrX", [{ id: "msgX1", from: "Someone Else <someone@else.example>", subject: "Fwd: listing", messageId: "<x1@else.example>" }]);
      const other = await A.sendEmailThreadReply({ kind: "gmail", clientId: bea.id, mailbox: "info@realtourpilot.com", threadId: "thrX" }, "Hi", intent());
      c.ok("client page: a thread whose reply would go to someone who isn't the client is refused", !other.ok && /someone@else\.example, which isn't Bea Broker's email on file/.test(other.message) && sends.length === before, other.message);
      const junk = await A.sendEmailThreadReply({ kind: "gmail", clientId: bea.id, mailbox: "info@realtourpilot.com", threadId: "../../x" }, "Hi", intent());
      c.ok("…and a thread id that isn't Gmail's is refused", !junk.ok && sends.length === before, junk.message);
    }

    // =====================================================================
    c.head("6 · the client page's reply (by Gmail thread)");
    // =====================================================================
    {
      await signIn(owner);
      gmailThread("thrTW", [{ id: "msgT1", from: "Bea Broker <BEA@agent.example>", subject: "Twilight shots", messageId: "<t1@agent.example>" }]);
      const target = { kind: "gmail" as const, clientId: bea.id, mailbox: "Info@RealtourPilot.com", threadId: "thrTW" };
      const p = await A.prepareEmailReply(target);
      c.ok("the header: To Bea (her address on file), \"Re: Twilight shots\"", p.ok && p.to === "bea@agent.example" && p.subject === "Re: Twilight shots", JSON.stringify(p));
      const before = sends.length;
      const r = await A.sendEmailThreadReply(target, "Yes, we can add twilight for Saturday.", intent(), p.to);
      const m = sends[before];
      c.ok("sent once into that thread: threadId, To, \"Re:\" added, In-Reply-To and References = her one Message-ID", r.ok && sends.length === before + 1 && m.threadId === "thrTW" && m.to === "bea@agent.example" && m.subject === "Re: Twilight shots" && m.inReplyTo === "<t1@agent.example>" && m.references === "<t1@agent.example>", JSON.stringify({ threadId: m?.threadId, to: m?.to, subject: m?.subject, inReplyTo: m?.inReplyTo, references: m?.references }));
      const row = await prisma.commLog.findFirst({ where: { externalId: `gmail-sent-thrTW-sent${before + 1}` } });
      c.ok("…logged on Bea, with Jordan as sender", row?.clientId === bea.id && row?.senderTeamMemberId === jordanTm.id && row?.direction === "out");
    }

    // =====================================================================
    c.head("7 · newest first, and anything older than seven days folded");
    // =====================================================================
    {
      const NOW = Date.UTC(2026, 9, 27, 16, 0, 0);
      const at = (d: number) => new Date(NOW - d * DAY).toISOString();
      const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();
      const list = [
        { id: "a", t: at(20) },
        { id: "b", t: "not a date" },
        { id: "c", t: at(1) },
        { id: "d", t: at(1) },
        { id: "e", t: at(7) },
        { id: "f", t: new Date(NOW - 7 * DAY - 1).toISOString() },
      ];
      c.ok("emailNewestFirst: newest at the top; a tie keeps its order; an unreadable date last", ids(O.emailNewestFirst(list, (x) => x.t)) === "c,d,e,f,a,b", ids(O.emailNewestFirst(list, (x) => x.t)));
      const f = O.foldOlderEmails(list, (x) => x.t, NOW);
      c.ok("foldOlderEmails: the last seven days show (exactly seven days still shows), the rest fold", ids(f.recent) === "c,d,e" && ids(f.older) === "f,a,b", `${ids(f.recent)} | ${ids(f.older)}`);
      const allOld = O.foldOlderEmails([{ id: "x", t: at(30) }, { id: "y", t: at(9) }], (x) => x.t, NOW);
      c.ok("all older than seven days: the newest still shows, so an open thread is never just a fold", ids(allOld.recent) === "y" && ids(allOld.older) === "x");
      const none = O.foldOlderEmails([] as { id: string; t: string }[], (x) => x.t, NOW);
      c.ok("no email: nothing either side", none.recent.length === 0 && none.older.length === 0);
      c.ok("Dates, numbers and strings all read; the window is seven days", O.EMAIL_OPEN_DAYS === 7 && ids(O.foldOlderEmails([{ id: "n", t: NOW - 2 * DAY }, { id: "o", t: new Date(NOW - 8 * DAY) }] as { id: string; t: number | Date }[], (x) => x.t, NOW).recent) === "n");
      c.ok("the fold's words: \"Show 1 older email\", \"Show 3 older emails\"", O.olderEmailsLabel(1) === "Show 1 older email" && O.olderEmailsLabel(3) === "Show 3 older emails");

      // The Email view's thread read, and the thread as it renders.
      await signIn(kyle);
      const read = await getEmailThreads();
      const fp = read.threads.find((t) => t.key === `floor plan::${bea.id}`)!;
      const order = fp.messages.map((m) => m.id);
      c.ok("Messages · Email: a thread's messages arrive newest first", fp.messages.every((m, i, a) => i === 0 || Date.parse(a[i - 1].atISO) >= Date.parse(m.atISO)) && order.slice(1).join() === [m4.id, m3.id, m2.id, m1.id].join(), order.join());
      c.ok("…its reply answers Bea's newest email, from its mailbox", fp.replyRef === m4.id && fp.replyMailbox === "info@realtourpilot.com", `${fp.replyRef} ${fp.replyMailbox}`);
      const split = O.foldOlderEmails(fp.messages, (m) => m.atISO, now.getTime());
      c.ok("…folded: the reply, 1 day and 3 days show; 10 and 20 days fold", split.recent.map((m) => m.id).slice(1).join() === [m4.id, m3.id].join() && split.older.map((m) => m.id).join() === [m2.id, m1.id].join());
      const html = renderToStaticMarkup(createElement(EmailThreadList, { threads: read.threads, focusKey: fp.key, nowMs: now.getTime() }));
      const shown = [...html.matchAll(/data-email-message="([^"]+)"/g)].map((m) => m[1]);
      c.ok("rendered: newest at the top, the older ones after it", shown.slice(1).join() === [m4.id, m3.id, m2.id, m1.id].join(), shown.join());
      const fold = /<details[^>]*data-older-emails="(\d+)"[^>]*>/.exec(html);
      c.ok("rendered: \"Show 2 older emails\", closed until someone opens it", fold?.[1] === "2" && !/\sopen(=|\s|>)/.test(fold?.[0] ?? "") && html.includes("Show 2 older emails") && html.indexOf(`data-email-message="${m3.id}"`) < html.indexOf("data-older-emails") && html.indexOf(`data-email-message="${m2.id}"`) > html.indexOf("data-older-emails"), fold?.[0]);
      c.ok("rendered: a Reply from Waiting on us opens the thread with its reply box ready; nothing says Sent", html.includes("data-email-reply") && html.includes('aria-label="Your reply"') && html.includes("Nothing goes until you press Send") && !html.includes("data-email-reply-sent"));
      // A thread the Gmail sync never gave an id (a backfill) is answered in Gmail.
      const old = await prisma.client.create({ data: { name: "Olive Older", email: "olive@agent.example" } });
      await prisma.commLog.create({ data: { channel: "email", source: "gmail", direction: "in", clientId: old.id, clientName: old.name, contactName: old.name, subject: "Old note", body: "From the backfill", occurredAt: ago(2 * DAY) } as never });
      const read2 = await getEmailThreads();
      const ol = read2.threads.find((t) => t.key === `old note::${old.id}`)!;
      const html2 = renderToStaticMarkup(createElement(EmailThreadList, { threads: read2.threads, focusKey: ol.key, nowMs: now.getTime() }));
      c.ok("a thread with no Gmail id: no reply box, \"This thread can only be answered in Gmail.\"", ol.replyRef === null && html2.includes("This thread can only be answered in Gmail.") && (html2.match(/data-email-reply(?!-)/g) ?? []).length === 0);
      // The client page's Email card reads the same helpers (it loads live from
      // Gmail after paint, so its source is what can be checked here).
      const card = readFileSync("src/components/clients/ClientEmails.tsx", "utf8");
      c.ok("the client page's Email card: newest first through foldOlderEmails, the older ones under the same closed fold", /foldOlderEmails\(emails, \(e\) => e\.date, readAt\)/.test(card) && /<details data-older-emails=\{older\.length\}/.test(card) && /olderEmailsLabel\(older\.length\)/.test(card) && !/<details[^>]*\sopen/.test(card));
      c.ok("…and its one reply tool is the Gmail-thread reply box (the AI draft is its starting text)", (card.match(/<EmailReplyBox/g) ?? []).length === 1 && /kind: "gmail", clientId, mailbox: theirs\.mailbox, threadId: theirs\.threadId/.test(card) && /draft=\{\(\) => draftEmailReply\(clientId\)\}/.test(card));
      const box = readFileSync("src/components/comms/EmailReplyBox.tsx", "utf8");
      c.ok("the reply box calls Send in one place, the Send button's handler (no effect, timer or draft sends)", (box.match(/sendEmailThreadReply\(/g) ?? []).length === 1 && /const send = \(\) => \{[\s\S]*?sendEmailThreadReply\(/.test(box) && !/useEffect\([\s\S]{0,400}sendEmailThreadReply/.test(box) && (box.match(/onClick=\{send\}/g) ?? []).length === 1);
    }

    c.ok("NO REAL EMAIL: every Gmail call was the in-process fake; nothing else left the box", fence.blocked.length === 0 && fence.faked.every((u) => /^https:\/\/(oauth2|gmail)\.googleapis\.com\//.test(u)), fence.blocked.join(", "));
    c.summary();
  } finally {
    quiet.restore();
    fence.restore();
    await drill.stop();
  }
  process.exit(process.exitCode ?? 0);
}
main().catch((error) => { console.error(error); process.exit(1); });
