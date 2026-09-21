import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { phoneKey, callTranscriptText, openPhoneRequestAuthorized, ourOpenPhoneNumberKeys, type OpTranscriptLine } from "@/lib/integrations/openphone";
import { resolveClientByPhones, resolveSenderName, findActiveProjectByText, findClientProjectByText } from "@/lib/contacts";
import { recordClientCommunication } from "@/lib/comms";
import { logComm } from "@/lib/commLog";
import { HUB_REPLY_SOURCE, HUB_SMS_SOURCES, isHubSms } from "@/lib/hubSms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives OpenPhone events (message.received/delivered, call.completed/ringing/
// recording.completed), logs them, and attaches an activity to the matching
// client's most recent project so comms show up in real time.

// Stamped on the WebhookEvent row of every event we let through WITHOUT
// verifying it, so an unsigned acceptance is self-describing forever instead of
// looking identical to a verified one. /connections counts rows on this prefix,
// and the Aryeo receiver stamps the same marker — keep the three in step.
const UNSIGNED_MARKER = "UNSIGNED: accepted without verification — no webhook token configured";

export async function POST(req: NextRequest) {
  // Reject spoofed events once the webhook has been (re)registered with a shared
  // token (backward compatible: allowed until a token is stored). See
  // registerOpenPhoneWebhooks / openPhoneRequestAuthorized.
  const auth = await openPhoneRequestAuthorized(req.nextUrl.searchParams.get("t"));
  const raw = await req.text();
  if (!auth.ok) {
    // A token IS configured and this POST failed it (no token stored = the check
    // passes) — record the refusal so it's countable/visible on /connections
    // with its reason, and spike-alert if it keeps happening. Best-effort; the
    // 401 always goes out. RTP-28 (Sep 16): the body is kept too, so a token
    // mismatch can be replayed against a candidate on /connections.
    const { refuseWebhook } = await import("@/lib/webhookRetry");
    await refuseWebhook("openphone", { code: "bad-signature", rawBody: raw, header: "?t= query token", sig: null });
    console.warn(`[webhook] openphone: REFUSED — ${auth.reason}.`);
    // Reason to the log and the stored row, never to the caller — see the note in
    // webhookRetry's REFUSALS block (RTP-28 review, Sep 16).
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.unsigned) {
    // No token stored. The per-provider office setting decides whether this
    // receiver still accepts (its default, and its behaviour to date) or
    // refuses — RTP-28's coordinated cutover, not a code flip.
    const { gateMissingSecret, refuseWebhook } = await import("@/lib/webhookRetry");
    const gate = await gateMissingSecret("openphone", "openphone_webhook");
    if (!gate.allow) {
      await refuseWebhook("openphone", { code: gate.code, rawBody: raw, header: null, sig: null });
      return NextResponse.json({ error: "unverified" }, { status: 401 });
    }
    // Accepted, but nothing was verified. Say so on every single request (Vercel
    // logs) as well as on the stored row — a silent accept-all is the fault:
    // this receiver waved through 1,380 events in 30 days with no way to tell
    // a real client text from a forged one.
    console.warn("[webhook] openphone: UNSIGNED event accepted — no token configured. Press “Enable real-time” on /connections to close this.");
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    /* keep empty */
  }

  const type = (payload.type as string) || "unknown";
  const externalId = (payload.id as string) || undefined;

  // Idempotency.
  if (externalId) {
    const seen = await prisma.webhookEvent.findFirst({
      where: { provider: "openphone", externalId, status: "PROCESSED" },
    });
    if (seen) return NextResponse.json({ ok: true, deduped: true });
  }

  const log = await prisma.webhookEvent.create({
    data: {
      provider: "openphone",
      eventType: type,
      externalId,
      payload: raw || "{}",
      // Marker only — status stays on its normal RECEIVED→PROCESSED path so
      // dedupe and the hourly retry sweep behave exactly as before.
      error: auth.unsigned ? UNSIGNED_MARKER : null,
    },
  });

  try {
    await processOpenPhoneEvent(type, payload);
    await prisma.webhookEvent.update({
      where: { id: log.id },
      data: { status: "PROCESSED", processedAt: new Date() },
    });
  } catch (e) {
    await prisma.webhookEvent.update({
      where: { id: log.id },
      data: { status: "ERROR", error: e instanceof Error ? e.message : String(e) },
    });
  }
  return NextResponse.json({ ok: true });
}

// Automated/system senders (Aryeo reminders, no-reply alerts, our own org…):
// notifications, not humans — never leads, never logged as client messages,
// never project instructions.
const AUTOMATED_SENDER_RE = /aryeo|notif|no-?reply|do-?not-?reply|automat|alert|reminder|noreply|system|notify|real\s*tour/i;

// Format a 10-digit key back into a readable US number for titles/log rows.
function prettyPhone(k: string): string {
  return k.length === 10 ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : k;
}

// The street half of an Aryeo-style title ("1033 Preserve Ln, West Chester,
// PA 19382" → "1033 preserve ln"), so two orders at one address compare equal
// however the city/zip half was formatted ("West Chester, 19382" vs "West
// Chester, PA 19382" both exist for the same house). Used to scope the
// delivery-text close below.
function streetOf(title: string | null | undefined): string | null {
  const s = (title ?? "").split(",")[0].toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return s.length >= 4 ? s : null;
}

// ---------------------------------------------------------------------------
// WHICH NUMBERS ARE US
//
// Two kinds, and telling them apart is the whole of the direction problem:
//
//   • the LINE — our OpenPhone (Quo) workspace number, +1 215 645 4889. Anything
//     it sends, we sent. OpenPhone stamps those `outgoing` and always has.
//
//   • a TEAM HANDSET — Jordan's, James's, Harrison's own phone. They text
//     clients from their own handsets in group threads that carry the workspace
//     line, so those messages arrive HERE, and OpenPhone stamps every one of
//     them `incoming` — identical to a client writing in. (Probe over the stored
//     webhook archive: 190 team-handset message events in the last 30 days,
//     100% stamped `incoming`.) That single ambiguity is what logged our own
//     words as the client's: escalations that we were "keeping a client
//     waiting", to-dos minted from our own sentences, and a reply that ADDED a
//     card to the queue instead of clearing one.
//
// Cached for ten minutes per lambda (same window as ourOpenPhoneNumberKeys), so
// a new hire's number can be up to ten minutes late — read that cost against a
// roster lookup on every inbound text. Best-effort: if the query fails we hand
// back an empty team set, which degrades to the old (line-only) behaviour rather
// than mistaking a client for one of ours.
// The staff texts that predate the "⚙️ RealTour Hub" prefix — the upload-page
// digest, its 10 PM chaser and the one-time intro (src/lib/uploadDigest.ts,
// "Hi Jordan — RealTour Pilot here…") — are known by the comms row the sender
// logs the moment the send returns: the same words, to one of these numbers,
// in the last half hour. Reviewer, Sep 11: their echo was still landing as an
// "Us" → Jordan row, which the reply queue reads as "we answered him".
// Best-effort — a lookup failure leaves that echo on the old path; it can
// never drop a client's message, because the caller already knows nobody
// outside the company is on the thread.
async function hubSentToStaff(text: string, recipients: string[]): Promise<boolean> {
  const body = text.trim().slice(0, 6_000); // logComm stores the trimmed body, capped the same way
  if (!body || recipients.length === 0) return false;
  try {
    const row = await prisma.commLog.findFirst({
      where: {
        source: { in: [...HUB_SMS_SOURCES] },
        direction: "out",
        fromPhone: { in: recipients },
        body,
        createdAt: { gte: new Date(Date.now() - 30 * 60_000) },
      },
      select: { id: true },
    });
    return !!row;
  } catch {
    return false;
  }
}

// Did the hub text the owner in the last two hours? (The prefixed lines leave
// a sent PendingSms row; the pre-prefix chasers leave a comms row on his
// number.) His next text to the office is then a reply to the hub, not a
// question for Kyle — see `hubReply` below. Best-effort false.
async function recentHubTextTo(fromPhone: string): Promise<boolean> {
  const since = new Date(Date.now() - 2 * 3600_000);
  try {
    const { ownerTeamMemberIds } = await import("@/lib/smsPrefs");
    const ids = await ownerTeamMemberIds();
    if (ids.length > 0) {
      const sent = await prisma.pendingSms.findFirst({
        where: { teamMemberId: { in: ids }, sentAt: { gte: since } },
        select: { id: true },
      });
      if (sent) return true;
    }
    const chaser = await prisma.commLog.findFirst({
      where: { source: { in: [...HUB_SMS_SOURCES] }, direction: "out", fromPhone, createdAt: { gte: since } },
      select: { id: true },
    });
    return !!chaser;
  } catch {
    return false;
  }
}

let teamNumbersCache: { at: number; keys: Set<string>; owner: Set<string> } | null = null;
async function ourNumberKeys(): Promise<{ line: Set<string>; team: Set<string>; owner: Set<string> }> {
  const line = await ourOpenPhoneNumberKeys();
  if (teamNumbersCache && Date.now() - teamNumbersCache.at < 10 * 60_000) {
    return { line, team: teamNumbersCache.keys, owner: teamNumbersCache.owner };
  }
  let team = new Set<string>();
  // The OWNER's own handset(s), a subset of `team` (smsPrefs.ownerPhoneKeys —
  // resolved from the login roster, never a hard-coded number). Read for the
  // echo guard below; a lookup failure leaves it empty, which only means his
  // texts are treated like any other teammate's.
  let owner = new Set<string>();
  try {
    const { ownerPhoneKeys } = await import("@/lib/smsPrefs");
    owner = await ownerPhoneKeys();
  } catch {
    owner = teamNumbersCache?.owner ?? new Set();
  }
  try {
    // INACTIVE members included on purpose: a message Sarah sent while she was
    // on the roster is still ours, and dropping her the day she leaves would
    // silently re-open every one of her old threads as "a stranger waiting".
    // (Probed: no TeamMember phone collides with a Client phone or with a
    // synced contact linked to a client, so this can never eat a real client.)
    const rows = await prisma.teamMember.findMany({
      where: { phone: { not: null } },
      select: { phone: true },
    });
    team = new Set(rows.map((r) => phoneKey(r.phone)).filter((k) => k.length === 10));
    teamNumbersCache = { at: Date.now(), keys: team, owner };
  } catch {
    team = teamNumbersCache?.keys ?? new Set();
  }
  return { line, team, owner };
}

function collectPhones(obj: unknown, acc: string[] = []): string[] {
  if (!obj) return acc;
  if (typeof obj === "string") {
    // Group texts arrive with `to` as ONE comma-joined string ("+1555…,+1444…")
    // — split it so every participant is matched, not none.
    for (const part of obj.split(",")) {
      const s = part.trim();
      if (/^\+?\d[\d\s().-]{6,}$/.test(s)) acc.push(s);
    }
    return acc;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v) => collectPhones(v, acc));
    return acc;
  }
  if (typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (["from", "to", "participants", "phoneNumber"].includes(k) || typeof v !== "object") collectPhones(v, acc);
      else collectPhones(v, acc);
    }
  }
  return acc;
}

export async function processOpenPhoneEvent(type: string, payload: Record<string, unknown>) {
  const data = ((payload.data as Record<string, unknown>)?.object ?? payload.data ?? payload) as Record<string, unknown>;

  // Call transcripts arrive on their own event — pull the transcript, log it,
  // and cross-check the CLIENT's spoken words for a revision request.
  if (type === "call.transcript.completed") {
    return handleTranscript(data);
  }

  // Collect every phone in the event and resolve to a client (direct phone or a
  // synced contact's alternate number) + their most recent project.
  const phones = [...new Set(collectPhones(data).map((p) => phoneKey(p)).filter((k) => k.length === 10))];
  if (phones.length === 0) return;

  const isCall = type.startsWith("call");
  const direction = (data.direction as string) || "";
  const incoming = direction.toLowerCase().startsWith("in");
  const text = (data.text as string) || (data.body as string) || "";

  // --- WHO WROTE THIS, AND DID IT LEAVE THE COMPANY? -----------------------
  // OpenPhone's own `direction` cannot answer this: it describes the LINE, not
  // the company. Everything that is not the line — a client, and equally our own
  // photographer's handset — arrives stamped `incoming`. So we decide from the
  // numbers on the thread (see ourNumberKeys above).
  const { line: ourLine, team: ourTeam, owner: ourOwner } = await ourNumberKeys();
  // Neither kind is ever the CLIENT a message is about: a group thread must
  // resolve on the real participant, and an all-hands internal thread on nobody.
  const ourNumbers = new Set([...ourLine, ...ourTeam]);

  const fromPhone = phoneKey((data.from as string) || "");
  const fromLine = fromPhone.length === 10 && ourLine.has(fromPhone);
  const fromTeamPhone = fromPhone.length === 10 && !fromLine && ourTeam.has(fromPhone);

  // Everyone this went TO, split into our own people and the outside world.
  // (Group texts arrive with `to` as one comma-joined string — collectPhones
  // splits it, so every participant counts, not just the first.)
  const recipients = [...new Set(collectPhones(data.to).map((p) => phoneKey(p)).filter((k) => k.length === 10))];
  const outsiders = recipients.filter((k) => !ourNumbers.has(k));

  // OURS — the message left this company, so its direction is "out":
  //   • anything the workspace line sent (in a group thread our own replies also
  //     echo back as "incoming" events FROM the line — still ours), and
  //   • anything a team member sent from their own handset with an OUTSIDE
  //     number on the thread. That is Jordan answering Stephen Kennedy from his
  //     pocket while the line watches: our words, our commitment, our reply.
  //
  // A teammate texting ONLY the office (no outsider on the thread) is NOT this.
  // It is a real message arriving that somebody here owes an answer to — it
  // keeps direction "in" so the reply queue can still show it, and it is
  // structurally safe because our own numbers are filtered out of the client
  // match below, so an internal thread can never attach to a client, never
  // reach revision detection, and never mint a lead.
  const fromUs = fromLine || (fromTeamPhone && outsiders.length > 0);
  const effIncoming = incoming && !fromUs;
  const isInboundText = !fromUs && (type === "message.received" || (!isCall && incoming));

  // --- THE HUB TALKING TO ITS OWN PEOPLE (Sep 11) ----------------------------
  // The hub texts staff from this same line — "⚙️ RealTour Hub: Video in
  // review…", a mention, payday, photos-not-delivered — and every one of those
  // echoes back here as an outgoing message to a teammate's number. Before
  // this guard the echo was logged as a conversation ("Us" → Jordan), and a
  // direction-"out" row on his number is exactly what the reply queue reads as
  // "we answered him": a payday notice could clear a question Jordan had
  // asked Kyle an hour earlier (replyQueue.clearFor kills the row's own
  // bucket). Probed Sep 11: 154 such echoes in 60 days, none attached to a
  // client. So a hub-prefixed text on a thread with nobody outside the
  // company is INTERNAL: archived as a WebhookEvent like everything else, and
  // then nothing — no comms row, no client match, no task close, no reply
  // credit, no brain, no lead. The prefix is the contract (src/lib/hubSms.ts),
  // and the two chasers that predate it are recognised by the row they log
  // (hubSentToStaff). Kyle's own human texts from the line carry neither and
  // keep the old path — they legitimately answer a teammate's question.
  const staffOnly = outsiders.length === 0;
  if (!isCall && fromLine && staffOnly && (isHubSms(text) || (await hubSentToStaff(text, recipients)))) return;
  // And the owner answering that text from his pocket ("Approved", "looks
  // good, 1033 Preserve Ln") must never be minted into a to-do by the
  // project-routing pass below — that pass exists for a photographer or a
  // coordinator giving the office an instruction, and the owner texting the
  // office alone is a conversation with Kyle, which the comms row (still
  // written, still his name) and the reply queue already carry. Probed Sep
  // 11: zero comms_followup tasks from his number in 60 days, so nothing
  // real is lost. Keyed on the TeamMember roster first (ourOwner ⊂ ourTeam),
  // so a Client row that ever carried his number could not turn it back on.
  const ownerToOffice = fromTeamPhone && staffOnly && ourOwner.has(fromPhone);
  // …and when his text follows a hub text to him by less than two hours, the
  // row is stamped source "hub-reply": kept for the record (Kyle's handset is
  // the line, so he read it on his phone anyway), skipped by the reply queue,
  // which otherwise listed "Jordan Spackman: Approved" as a thread Kyle owed
  // an answer to and pre-drafted one (reviewer, Sep 11).
  const hubReply = ownerToOffice && !isCall && incoming && (await recentHubTextTo(fromPhone));

  // Who actually sent this? (team member / client / synced contact — or nobody
  // we know). Resolved for every sender except our own workspace line, whose
  // name we already know: the same set of lookups as before, and a team-sent row
  // needs the name to label itself with. Robo-senders (Aryeo reminders etc.) are
  // notifications, not client messages: don't log them as such and never turn
  // them into leads.
  const sender = !fromLine && fromPhone.length === 10 ? await resolveSenderName(fromPhone) : null;
  const robo = !fromUs && !!sender && AUTOMATED_SENDER_RE.test(sender.name);

  const match = await resolveClientByPhones(phones.filter((k) => !ourNumbers.has(k)));

  // For a multi-order client, prefer the project the message is actually ABOUT
  // (named by street) over their most-recent order — so a text about an older
  // active listing isn't filed on their newest one. Client-scoped, so it never
  // routes onto a different client's job.
  let effProject = match?.project ?? null;
  // Track HOW the project was resolved: a street named in the text is a real
  // filing; the mostRelevantProject default is a guess, and project-scoped
  // surfaces (the /ops shoot-card comms chip) must know the difference.
  let projectNamed = false;
  if (match && !isCall && text.trim()) {
    const named = await findClientProjectByText(match.clientId, text);
    if (named) { effProject = named; projectNamed = true; }
  }
  const projectGuess = !!effProject && !projectNamed;

  // Comms memory: record the full text (in or out) so Ask the Hub can recall it.
  // Attributed to the REAL sender: our own messages are "Us" (outbound even when
  // they echoed back as incoming), inbound gets the sender's resolved name (or
  // their number, so an unknown texter still leaves an identifiable trace), and
  // robo-texts are skipped entirely — they'd read as fake client messages.
  if (!isCall && text.trim() && !robo) {
    // The number a reply goes back to: whoever wrote in, or (on our own
    // outbound) whoever we texted. An OUTSIDE recipient wins over one of our own
    // — in a mixed group thread ("Jordan + Kyle + the client") the reply belongs
    // to the client, and the old first-non-line pick could hand it to whichever
    // teammate happened to sit first in the `to` list. Falling back to a
    // non-line recipient keeps a line→teammate thread threaded on the teammate's
    // number exactly as before.
    const counterparty = effIncoming
      ? fromPhone
      : outsiders[0] ?? recipients.find((k) => !ourLine.has(k)) ?? "";
    await logComm({
      channel: "text",
      direction: effIncoming ? "in" : "out",
      clientId: match?.clientId ?? null,
      clientName: match?.clientName ?? null,
      projectId: effProject?.id ?? null,
      fromPhone: counterparty || null,
      contactName: fromUs
        // A team member's own handset: name WHO on our side wrote it. The
        // direction already marks the row as ours, and "Jordan Spackman" beats
        // "Us" when the thread is read back months later.
        ? (fromTeamPhone ? sender?.name ?? "Us" : "Us")
        : effIncoming
          ? sender?.name ?? match?.clientName ?? (fromPhone.length === 10 ? prettyPhone(fromPhone) : null)
          : "RealTour Pilot",
      body: text,
      source: hubReply ? HUB_REPLY_SOURCE : "openphone",
      externalId: data.id ? `op-${data.id as string}` : undefined,
      projectGuess,
    });

    // --- WHO ON OUR SIDE WROTE IT (Sep 21 2026) -----------------------------
    // Jordan: "make sure we track Kyle's responses in OpenPhone." Kyle's
    // handset IS the company line, so until now every text the office sent was
    // logged "Us" and the hub could not tell his words from Jordan's — 481 of
    // the last 639 outbound texts. OpenPhone has always told us: the event
    // carries data.object.userId. We simply threw it away.
    //
    // THE GATE IS NARROW ON PURPOSE. `userId` is present on INBOUND events too,
    // and there it names the OpenPhone user whose INBOX the message landed in,
    // not the person who typed it: all 730 stored incoming payloads carry the
    // owner's id. The same is true of a teammate texting a client from their
    // own handset, which OpenPhone stamps "incoming" — those rows are already
    // named from the phone roster above, so nothing is lost by refusing them.
    // So we trust this field only when OpenPhone's OWN direction is outgoing
    // and the message left the workspace line. (Verified against 1,528 stored
    // payloads: 692 outgoing, 692 with a userId, split 367 Kyle / 286 Jordan —
    // which is the proof it varies with the sender rather than being a
    // constant.) Everything else stays null, and null means UNKNOWN.
    //
    // Best-effort: attribution is a nice-to-have on top of the message, never a
    // reason for the receiver to fail an event and retry the whole thing.
    // THE GATE ITSELF NOW LIVES IN commSenders (Sep 21 2026, second pass). It
    // was four conditions written out here and transcribed into the drill, so
    // the drill would have gone on passing if the two ever drifted. One exported
    // predicate, two callers, and the proof exercises the shipped rule.
    //
    // AND IT CANNOT INVENT AN ATTRIBUTION FOR A MESSAGE THE HUB SENT — without
    // any send rail having to remember anything (Sep 21 2026, third pass).
    //
    // The first two passes made each rail stamp its own row. Four were fixed and
    // the reviewers then found seven more doing the same thing, so the rule was
    // moved here, where the echo is actually read, and restated as positive
    // evidence: the hub's OpenPhone API key can only ever send as its own owner,
    // so an echo carrying SOMEBODY ELSE'S id (Kyle's) can only have come from
    // that person's handset and is attributed, while an echo carrying the KEY
    // OWNER'S id is ambiguous forever — Jordan typing on his handset and the hub
    // sending for Kyle look identical to OpenPhone — and is refused outright by
    // stampCommSender. The cost is real and deliberate: Jordan's own
    // handset-typed texts from the line stay UNKNOWN. He is not the one being
    // coached, and inventing an attribution for him is the exact failure mode.
    //
    // The per-rail session stamps stay, because a session is BETTER evidence
    // than an echo. Nothing here depends on them any more.
    const { payloadIsAttributable, stampCommSender, hubComposedProviderId, noteApiKeySender } =
      await import("@/lib/commSenders");
    const senderUserId = typeof data.userId === "string" ? data.userId.trim() : "";
    const messageId = typeof data.id === "string" ? data.id : "";
    if (payloadIsAttributable({ eventType: type, direction, fromWorkspaceLine: fromLine, senderUserId, messageId })) {
      // WHICH ID IS THE AMBIGUOUS ONE, learned from a message we KNOW we sent.
      // An OutboxMessage holding this provider id is the hub's own record that
      // it handed the text to the API, so the id on this echo is the key's
      // owner by definition. That keeps the rule true through a key rotation
      // with no deploy and no settings screen. Costs one indexed lookup on the
      // ~690 outgoing message events a month, and writes only when it changes.
      if (await hubComposedProviderId(messageId).catch(() => false)) {
        await noteApiKeySender(senderUserId).catch((e) => {
          console.warn("[webhook] openphone: could not record the API key's sender —", e instanceof Error ? e.message : e);
        });
      }
      await stampCommSender({ externalId: `op-${messageId}`, senderUserId }).catch((e) => {
        console.warn("[webhook] openphone: sender attribution skipped —", e instanceof Error ? e.message : e);
      });
    }
  }

  // --- Client path: log + reply task + revision detection (when we know the client).
  if (match) {
    const { clientId, clientName } = match;

    if (effProject) {
      // Label the project timeline with the EFFECTIVE direction, not OpenPhone's
      // raw stamp: a text Jordan sent a client from his own handset arrives
      // stamped "incoming", and the job's history read "OpenPhone incoming text:
      // Absolutely! They're deleted." — our own promise, filed as the client's.
      const body = isCall
        ? `OpenPhone: ${direction || "call"} call (${type.replace("call.", "")}).`
        : `OpenPhone ${effIncoming ? "incoming" : "outgoing"} text: ${text.slice(0, 140)}`.trim();
      await prisma.activity.create({ data: { projectId: effProject.id, type: "SYSTEM", body } });
    }

    if (isInboundText) {
      await recordClientCommunication({
        clientId,
        clientName,
        projectId: effProject?.id,
        projectStatus: effProject?.status ?? null,
        propertyAddress: effProject?.title ?? null,
        text,
        kind: "text",
        source: "openphone",
      });
    }

    // An inbound call we DIDN'T answer → a "call back" task. Texts already make a
    // reply task; calls didn't, so a missed call was invisible to the daily queue.
    // Deduped (client_reply key) with any voicemail transcript task that follows.
    if (isCall && incoming && type === "call.completed") {
      const status = String(data.status ?? "").toLowerCase();
      const dur = Number(data.duration ?? 0);
      const missed = /no[-\s]?answer|missed|unanswered|declined|rejected/.test(status) || (data.answeredAt === null && !(dur > 0));
      if (missed) {
        const { createCommTask } = await import("@/lib/tasks");
        await createCommTask({ clientId, clientName, projectId: effProject?.id ?? null, propertyAddress: effProject?.title ?? null, kind: "missed_call", source: "openphone" });
      }
    }

    // We responded (outbound) → close the reply/callback task for the order this
    // addressed. A text infers the order from its content; an outbound call closes
    // the callback only if we actually CONNECTED (a no-answer leaves it open so we
    // still try again), and never guesses across a multi-order client's tasks.
    // A group-thread reply from our own line echoes back as "incoming" — that's
    // still us replying, so it closes the task too.
    if (direction.toLowerCase().startsWith("out") || (fromUs && !isCall)) {
      const { closeReplyForOutbound, closeReplyForOutboundCall } = await import("@/lib/tasks");
      if (!isCall) {
        // The hub's OWN automated sends (confirmation/delivery sweeps) echo
        // through here too. They complete exactly their own task themselves —
        // the human-send heuristics below must NOT fire for them: an auto
        // confirmation used to blanket-close every pending delivery_text for
        // the client, and an auto text answers no one's question (review).
        const autoSent = await prisma.commLog
          .findFirst({
            where: {
              // "auto-afterhours" belongs here too: the echo of our OWN
              // out-of-hours auto-reply must not be read as a human answering,
              // or it closes the client's reply task and blanket-completes their
              // queued delivery text with nothing actually sent (Sep 2).
              source: { in: ["auto-confirmation", "auto-delivery", "auto-afterhours", "auto-welcome"] },
              OR: [
                ...(data.id ? [{ externalId: `op-${data.id as string}` }] : []),
                { clientId, body: text, createdAt: { gte: new Date(Date.now() - 30 * 60_000) } },
              ],
            },
            select: { id: true },
          })
          .catch(() => null);
        if (!autoSent) {
          await closeReplyForOutbound(clientId, text);
          // Kyle often sends the "your gallery is ready" text straight from his
          // phone — that outbound text to a client with a queued delivery_text
          // IS the delivery text. Close it (audit: delivery_texts were 36% of
          // all overdue, only ever swept by a 7-day timer).
          //
          // Scoped to the JOB the text is about (Sep 8 audit). This closed
          // every open delivery_text for the client, so one "9 AM, is it not
          // going to be vacant?" to Stephen Kennedy about 1655 N 60th St
          // credited the feedback asks for 5318 Cedar Ave AND 5039 N Smedley
          // St as sent — 7 of 46 closes in 30 days were a text about another
          // job, and the Done ledger counted them. deliveryTextSendProof
          // (tasks.ts) is deliberately project-scoped; the close now matches
          // it: a text that names a street closes that job's ask only (a text
          // about job A leaves job B's open), and a text naming nothing closes
          // the client's ONE open ask — otherwise all of them wait for the
          // 7-day proof sweep. Same single-open rule as closeReplyScoped.
          // `effProject` is the named job only when `projectNamed`; the
          // router's most-recent-order guess is not evidence of what a text
          // was about.
          //
          // "Names the job" is by STREET, not project id: same-address orders
          // are routine here (Mike Ciunci has six "1033 Preserve Ln" rows, a
          // monthly shoot at his own place; 632 Greenridge Rd has a re-shoot
          // beside the delivered order), and findClientProjectByText hands
          // back the newest of them — which is not the one holding the ask.
          // A text about that address is about that address.
          const namedStreet = projectNamed && effProject ? streetOf(effProject.title) : null;
          const openAsks = await prisma.smartTask
            .findMany({
              where: { clientId, taskType: "delivery_text", status: { notIn: ["COMPLETED", "CANCELLED"] } },
              select: { id: true, projectId: true, propertyAddress: true },
            })
            .catch(() => [] as { id: string; projectId: string | null; propertyAddress: string | null }[]);
          const askIds = namedStreet
            ? openAsks.filter((a) => a.projectId === effProject?.id || streetOf(a.propertyAddress) === namedStreet).map((a) => a.id)
            : openAsks.length === 1
              ? [openAsks[0].id]
              : [];
          if (askIds.length > 0) {
            await prisma.smartTask
              .updateMany({ where: { id: { in: askIds } }, data: { status: "COMPLETED", completedAt: new Date() } })
              .catch(() => {});
          }
          // Same for hand-sent confirmations: an outbound text to a client
          // whose shoot is inside the next 48h IS the confirmation — complete
          // the task so the hourly sweep doesn't send a second one. Scoped to
          // the confirmation window so an unrelated text can't suppress a
          // real confirmation for a far-out shoot.
          await prisma.smartTask
            .updateMany({
              where: {
                clientId,
                taskType: "confirmation_text",
                status: { notIn: ["COMPLETED", "CANCELLED"] },
                project: { is: { shootDate: { gt: new Date(), lte: new Date(Date.now() + 48 * 3_600_000) } } },
              },
              data: { status: "COMPLETED", completedAt: new Date() },
            })
            .catch(() => {});
        }
      } else if (type === "call.completed") {
        const dur = Number(data.duration ?? 0);
        if (!!data.answeredAt || dur > 0) {
          await closeReplyForOutboundCall(clientId, effProject?.id ?? null);
          // Record the ANSWERED outbound call in comms memory — the reply-SLA
          // scan clears "still unanswered" off outbound rows, and without this
          // write no outbound call ever existed in CommLog (review finding:
          // the SLA's call branch was dead code).
          const { logComm } = await import("@/lib/commLog");
          await logComm({
            channel: "call",
            direction: "out",
            clientId,
            projectId: effProject?.id ?? null,
            contactName: "Us",
            body: `Outgoing call — answered (${Math.max(1, Math.round(dur / 60))} min)`,
            source: "openphone",
            externalId: data.id ? `op-call-out-${data.id}` : undefined,
            projectGuess, // calls carry no text to name a street — always the router's guess
          }).catch(() => {});
        }
      }
    }
  }

  // --- Phone-lead follow-up: an OUTBOUND text/answered call to a number that
  // has an open lead task means we replied — the callback happened. Leads have
  // no client match, so the client-scoped close above never reaches them
  // (audit: phone-lead tasks could never auto-close).
  if (!match && (direction.toLowerCase().startsWith("out") || fromUs)) {
    // EVERY external recipient counts — a group text's lead can sit anywhere in
    // the `to` list (the old to[0]-only pick missed them; a comma-joined string
    // resolved to whichever number phoneKey's last-10 happened to keep).
    // `outsiders` is already every recipient that is neither the line nor one of
    // our own handsets, so a teammate on the thread can never be read as a lead.
    const counterparts = fromUs
      ? outsiders
      : fromPhone.length === 10 && !ourNumbers.has(fromPhone) ? [fromPhone] : [];
    const answeredCall = isCall && type === "call.completed" && (!!data.answeredAt || Number(data.duration ?? 0) > 0);
    if (!isCall || answeredCall) {
      for (const counterpart of counterparts) {
        await prisma.smartTask
          .updateMany({
            where: {
              taskType: "lead",
              status: { notIn: ["COMPLETED", "CANCELLED"] },
              OR: [{ dedupeKey: { contains: counterpart } }, { sourceDetail: { contains: prettyPhone(counterpart) } }],
            },
            data: { status: "COMPLETED", completedAt: new Date() },
          })
          .catch(() => {});
      }
    }
  }

  // --- Smart project routing: an inbound text that NAMES a specific job, sent
  // by a known person other than that job's own client (a photographer like
  // Harrison, a coordinator like Ruthie), becomes an instruction task on that
  // exact project. Works even when the sender isn't a client at all.
  let routedToProject = false; // a project instruction isn't a lead (see below)
  if (isInboundText && text.trim() && !ownerToOffice) {
    if (fromPhone.length === 10) {
      const hitProject = await findActiveProjectByText(text);
      // Don't make tasks from automated/system senders (Aryeo reminders,
      // no-reply alerts, etc.) — they're notifications, not human instructions.
      // Our OWN org is already excluded (isInboundText is false for our echoes).
      // Skip when it's the client texting about the same project the reply task
      // already covers (no duplicate); otherwise file it on the named project.
      if (sender && !robo && hitProject && hitProject.id !== match?.project?.id) {
        routedToProject = true;
        // Route through the Smart Brain (the sender is a teammate/photographer,
        // not the client): it skips chatter, confirms the order, sets priority,
        // and can merge into an existing open to-do instead of duplicating.
        let aiTitle: string | null = null;
        let aiDetail: string | null = null;
        let aiPriority: "URGENT" | "HIGH" | "MEDIUM" | "LOW" | undefined;
        let handled = false; // brain merged it, or judged it non-actionable → no new task
        let usedBrain = false;
        if (hitProject.clientId) {
          try {
            const { routeCommTask } = await import("@/lib/brain");
            const decision = await routeCommTask({
              channel: "text", message: text, clientId: hitProject.clientId,
              senderName: sender.name, senderIsClient: false,
            });
            if (decision) {
              usedBrain = true;
              if (!decision.actionable) {
                handled = true;
              } else if (decision.mergeIntoTaskId) {
                const { mergeIntoExistingTask } = await import("@/lib/tasks");
                await mergeIntoExistingTask(decision.mergeIntoTaskId, { title: decision.title, detail: decision.detail, priority: decision.priority, snippet: text });
                handled = true;
              } else {
                aiTitle = decision.title; aiDetail = decision.detail; aiPriority = decision.priority;
              }
            }
          } catch { /* fall through to the single-message helper */ }
        }
        if (!usedBrain) {
          try {
            const { getSecret } = await import("@/lib/integrations/connections");
            if (await getSecret("ai")) {
              const { messageToTodo } = await import("@/lib/integrations/ai");
              const todo = await messageToTodo({ channel: "text", clientName: sender.name, propertyAddress: hitProject.title, message: text });
              if (todo && !/no action needed/i.test(todo.title)) { aiTitle = todo.title; aiDetail = todo.detail; }
            }
          } catch { /* fall back to a generic title */ }
        }
        if (!handled) {
          const { createProjectFollowupTask } = await import("@/lib/tasks");
          await createProjectFollowupTask({
            projectId: hitProject.id,
            clientId: hitProject.clientId,
            propertyAddress: hitProject.title,
            senderName: sender.name,
            text,
            source: "openphone",
            aiTitle,
            aiDetail,
            priority: aiPriority,
          });
          await prisma.activity.create({
            data: { projectId: hitProject.id, type: "NOTE", body: `${sender.name} (text): ${text.slice(0, 220)}` },
          });
        }
      }
    }
  }

  // --- Lead path: an inbound call or text from a number we DON'T know. The
  // phone line is the highest-intent lead source, so it must never just vanish
  // — mirror the Gmail lead flow: leave a CommLog trace (texts were logged
  // above) and mint ONE open HIGH lead task per phone number for Kyle. Never
  // for teammates, robo-senders, or a message that just routed to a project as
  // an instruction (a coordinator, not a lead).
  if (!match && effIncoming && !robo && !sender?.isTeam && !routedToProject) {
    const callerKey = fromPhone.length === 10 ? fromPhone : phones.find((k) => !ourNumbers.has(k)) ?? "";
    if (callerKey.length === 10 && !ourNumbers.has(callerKey)) {
      if (!isCall && text.trim()) {
        await upsertPhoneLeadTask({ phone: callerKey, kind: "text", senderName: sender?.name ?? null, snippet: text });
      } else if (isCall && type === "call.completed") {
        const status = String(data.status ?? "").toLowerCase();
        const dur = Number(data.duration ?? 0);
        const missed = /no[-\s]?answer|missed|unanswered|declined|rejected/.test(status) || (data.answeredAt === null && !(dur > 0));
        // The call itself leaves a comms-memory trace (there may never be a
        // transcript to log later).
        await logComm({
          channel: "call",
          direction: "in",
          clientId: null,
          contactName: sender?.name ?? prettyPhone(callerKey),
          body: `Inbound ${missed ? "missed call" : "call"} from ${prettyPhone(callerKey)}${dur > 0 ? ` (${Math.round(dur)}s)` : ""} — no matching client.`,
          source: "openphone",
          externalId: data.id ? `op-${data.id as string}` : undefined,
        });
        // Only a MISSED call needs an immediate callback task — an answered one
        // was already handled live, and if they left a voicemail the transcript
        // event upgrades this lead with what they actually said.
        if (missed) await upsertPhoneLeadTask({ phone: callerKey, kind: "call", senderName: sender?.name ?? null, snippet: "" });
      }
    }
  }
}

// WHICH WAY DID THIS CALL GO?
//
// The transcript event is the ONE call event that carries no `direction` and no
// `participants` — just a callId, a duration and the dialogue (checked against
// all 45 transcript payloads in the stored archive). Every transcript was
// therefore hard-coded as inbound, which meant that of the 45 calls transcribed
// so far, the 18 WE PLACED were all logged as the client reaching out to us:
// the client showed as waiting on a call we had just had with them, and a
// "Return the voicemail" card could be minted for it. Recover the truth, best
// evidence first.
async function callTranscriptDirection(
  data: Record<string, unknown>,
  callId: string,
  dialogue: OpTranscriptLine[],
): Promise<"in" | "out"> {
  // 1) A direction on the transcript payload itself, should OpenPhone add one.
  const own = String(data.direction ?? "").toLowerCase();
  if (own.startsWith("out")) return "out";
  if (own.startsWith("in")) return "in";

  // 2) The call events we ALREADY stored for this same call. call.ringing,
  //    call.completed and call.recording.completed all carry the real direction
  //    and all land before the transcript does (probe: 45/45 transcripts resolve
  //    here — 18 outgoing, 27 incoming). Bounded to a week and to OpenPhone's
  //    own call events so this stays a small scan, not a walk of the archive,
  //    and the id is re-checked after parsing because a payload can merely
  //    MENTION another call's id.
  if (callId) {
    try {
      const rows = await prisma.webhookEvent.findMany({
        where: {
          provider: "openphone",
          eventType: { in: ["call.completed", "call.recording.completed", "call.ringing"] },
          createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) },
          payload: { contains: callId },
        },
        orderBy: { createdAt: "desc" },
        take: 6, // one call emits at most 3 of these; headroom for a false substring hit
        select: { payload: true },
      });
      for (const r of rows) {
        try {
          const o = (JSON.parse(r.payload) as { data?: { object?: { id?: string; direction?: string } } })
            ?.data?.object;
          if (!o || o.id !== callId) continue;
          const d = String(o.direction ?? "").toLowerCase();
          if (d.startsWith("out")) return "out";
          if (d.startsWith("in")) return "in";
        } catch { /* try the next row */ }
      }
    } catch { /* fall through to the dialogue */ }
  }

  // 3) The dialogue. OpenPhone tags a line with a userId only when one of OUR
  //    people is speaking, so a transcript in which nobody but us spoke is a
  //    voicemail WE left. The mirror rule ("only they spoke" → inbound) is
  //    deliberately NOT applied: an outbound call into an IVR looks exactly the
  //    same, and the archive holds one ("Welcome to merchant serve…", outgoing).
  if (dialogue.length && dialogue.every((l) => l.userId)) return "out";

  // 4) Unknown. Hold the old assumption — a call we didn't place — but say so
  //    out loud: a silent guess here is what put the wrong number on screen.
  console.warn(
    `[webhook] openphone: call ${callId || "?"} transcript carries no recoverable direction — logging it as inbound.`,
  );
  return "in";
}

// A completed call transcript: fetch it, attach to the client's project, and
// run the client's portion through revision detection (calls count too).
async function handleTranscript(data: Record<string, unknown>) {
  const callId = (data.callId as string) || (data.id as string) || "";

  // Prefer the dialogue already in the webhook payload; fall back to the API.
  const inline = data.dialogue as OpTranscriptLine[] | undefined;
  const dialogue = Array.isArray(inline) ? inline : [];
  let full = "";
  let clientText = "";
  if (dialogue.length) {
    full = dialogue.map((l) => l.content ?? "").join(" ").replace(/\s+/g, " ").trim();
    clientText = dialogue
      .filter((l) => !l.userId)
      .map((l) => l.content ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } else if (callId) {
    const t = await callTranscriptText(callId);
    full = t.full;
    clientText = t.clientText;
  }
  if (!full) return;

  // Did we place this call, or did they? Everything below turns on it.
  const dir = await callTranscriptDirection(data, callId, dialogue);
  const wePlacedIt = dir === "out";

  // Resolve the client from phones in the payload + the transcript identifiers.
  // Our own numbers — the line AND every team handset — are excluded, so a
  // teammate who dialled in from their own phone is never mistaken for a client.
  const phones = [...new Set(collectPhones(data).map((p) => phoneKey(p)).filter((k) => k.length === 10))];
  const { line: ourLine, team: ourTeam } = await ourNumberKeys();
  const ourNumbers = new Set([...ourLine, ...ourTeam]);
  const match = await resolveClientByPhones(phones.filter((k) => !ourNumbers.has(k)));

  // A number we don't know. If THEY rang us, that's a LEAD, not noise: log the
  // transcript (previously it vanished without a trace) and mint/upgrade the
  // callback task with what they actually said. Requires the OTHER party to have
  // spoken (clientText) so our own outbound voicemails don't lead on ourselves —
  // and, now that the direction is known, a call WE placed is logged but never
  // turned into a "they called us, ring them back" claim.
  if (!match) {
    const callerKey = phones.find((k) => !ourNumbers.has(k));
    if (!callerKey || !clientText) return;
    const sender = await resolveSenderName(callerKey);
    if (sender && (sender.isTeam || AUTOMATED_SENDER_RE.test(sender.name))) return; // teammate / robo-call
    await logComm({
      channel: "call",
      direction: dir,
      clientId: null,
      contactName: sender?.name ?? prettyPhone(callerKey),
      body: full,
      source: "openphone-call",
      externalId: callId ? `op-call-${callId}` : undefined,
    });
    // A number WE dialled did not "call us". Minting a call-them-back lead off
    // our own outgoing call is precisely how calls we placed turned up on Kyle's
    // queue as strangers waiting on us — keep the transcript, drop the invented
    // callback. (If we want outbound calls to unknown numbers to become leads,
    // that's a lead task worded as one, not this.)
    if (wePlacedIt) return;
    await upsertPhoneLeadTask({ phone: callerKey, kind: "voicemail", senderName: sender?.name ?? null, snippet: clientText });
    return;
  }
  const { clientId, clientName, project } = match;

  if (project) {
    await prisma.activity.create({
      data: {
        projectId: project.id,
        type: "SYSTEM",
        body: `${wePlacedIt ? "Outgoing" : "Incoming"} call transcript: ${full.slice(0, 280)}${full.length > 280 ? "…" : ""}`,
      },
    });
  }

  // Comms memory: store the full call transcript. The project is always the
  // router's most-relevant guess (a call has no parsed street), so stamp it.
  await logComm({
    channel: "call",
    direction: dir,
    clientId,
    clientName,
    projectId: project?.id ?? null,
    contactName: clientName,
    body: full,
    source: "openphone-call",
    externalId: callId ? `op-call-${callId}` : undefined,
    projectGuess: !!project,
  });

  // Scan the client's spoken words for a revision/change request.
  if (clientText) {
    await recordClientCommunication({
      clientId,
      clientName,
      projectId: project?.id,
      projectStatus: project?.status ?? null,
      propertyAddress: project?.title ?? null,
      text: clientText,
      // The whole call, for the revision brief: the client's half of a live
      // conversation reads as a ramble on its own ("Okay. Okay. There we go."),
      // and every specific they gave is an answer to something we asked.
      fullText: full,
      // A call WE placed and they answered is not a voicemail. Labelling it one
      // put "Return the voicemail — Voicemail from client" on a card for a
      // conversation we had already finished having, minutes after the
      // answered-outbound close had cleared the real callback. Their words still
      // run through revision detection either way — that is the point of this
      // call. (tasks.ts has no "call" kind yet; "text" is the honest one of the
      // three it does have. Worth a real kind — noted for its owner.)
      kind: wePlacedIt ? "text" : "voicemail",
      // Task source stays "openphone" (not "openphone-call") so the reply sweep +
      // real-time outbound close pick up voicemail callbacks like any other reply.
      source: "openphone",
    });
  }
}

// One open "call this lead back" task per unknown phone number, owned by Kyle —
// mirrors the Gmail lead flow (google.ts `lead-<email>` dedupe keys) so a phone
// lead gets the same treatment an emailed one always did. Missed call →
// voicemail → text about the same number all collapse onto one task; a
// voicemail upgrades an open task's summary with what the caller actually said.
async function upsertPhoneLeadTask(opts: {
  phone: string; // 10-digit key
  kind: "call" | "voicemail" | "text";
  senderName: string | null;
  snippet: string;
}) {
  const pretty = prettyPhone(opts.phone);
  const who = opts.senderName ? `${opts.senderName} (${pretty})` : pretty;
  const key = `lead-${opts.phone}`;
  const kindLabel =
    opts.kind === "voicemail" ? "left a voicemail" : opts.kind === "text" ? "texted us" : "called us (missed)";
  const quote = opts.snippet ? ` They said: “${opts.snippet.slice(0, 200)}”.` : "";
  const summary =
    `${who} ${kindLabel} — not a client we recognize, so treat it as a lead.${quote} Call back, qualify (listing, timeline, budget), and add them to the CRM.`.slice(0, 500);
  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const data = {
    taskType: "lead",
    title: (opts.kind === "text" ? `New texter — reply to ${who}` : `New caller — call back ${who}`).slice(0, 120),
    summary,
    description: opts.snippet.slice(0, 400) || null,
    reasonCreated: `Unmatched inbound ${opts.kind} on the business line`,
    checklist: JSON.stringify(["Call / text them back", "Qualify (listing, timeline, budget)", "Book the shoot or a strategy call", "Add to CRM"]),
    source: "openphone",
    sourceDetail: `phone:${pretty}`,
    priority: "HIGH" as const,
    dueAt: new Date(Date.now() + 4 * 3600_000),
    ownerId: kyle?.id ?? null,
    dedupeKey: key,
  };
  const existing = await prisma.smartTask.findUnique({ where: { dedupeKey: key } });
  if (existing) {
    if (existing.status !== "COMPLETED" && existing.status !== "CANCELLED") {
      // Already open: only a voicemail improves it (the transcript beats a bare
      // "missed call" — Kyle sees what they want before calling back).
      if (opts.kind === "voicemail" && opts.snippet) {
        await prisma.smartTask.update({ where: { id: existing.id }, data: { summary, description: data.description } });
      }
      return;
    }
    await prisma.smartTask.update({ where: { id: existing.id }, data: { ...data, status: "OPEN", completedAt: null } });
  } else {
    await prisma.smartTask.create({ data });
  }
  // The phone line is the highest-intent lead source — ping Slack the moment the
  // lead task is (re)minted instead of waiting for a hub visit, and mirror it to
  // the in-app bell (deduped per number per day). Best-effort.
  try {
    const { notifyUrgent, notifyInApp } = await import("@/lib/notify");
    await notifyUrgent(data.title);
    await notifyInApp({
      kind: "new_lead",
      title: `New lead — ${who}`,
      href: "/queue",
      targets: [{ roles: ["OWNER", "ADMIN"] }],
      dedupeKey: `lead-op-${opts.phone}-${new Date().toISOString().slice(0, 10)}`,
    });
  } catch { /* never break lead capture on a notify failure */ }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "openphone-webhook" });
}
