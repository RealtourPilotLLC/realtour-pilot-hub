import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { phoneKey, callTranscriptText, openPhoneRequestAuthorized, ourOpenPhoneNumberKeys, type OpTranscriptLine } from "@/lib/integrations/openphone";
import { resolveClientByPhones, resolveSenderName, findActiveProjectByText, findClientProjectByText } from "@/lib/contacts";
import { recordClientCommunication } from "@/lib/comms";
import { logComm } from "@/lib/commLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives OpenPhone events (message.received/delivered, call.completed/ringing/
// recording.completed), logs them, and attaches an activity to the matching
// client's most recent project so comms show up in real time.
export async function POST(req: NextRequest) {
  // Reject spoofed events once the webhook has been (re)registered with a shared
  // token (backward compatible: allowed until a token is stored). See
  // registerOpenPhoneWebhooks / openPhoneRequestAuthorized.
  if (!(await openPhoneRequestAuthorized(req.nextUrl.searchParams.get("t")))) {
    // A token IS configured and this POST failed it (no token stored = the check
    // passes) — log the rejection so it's countable/visible on /connections, and
    // spike-alert if it keeps happening. Best-effort; the 401 always goes out.
    try {
      await prisma.webhookEvent.create({
        data: { provider: "openphone", eventType: "signature.rejected", status: "REJECTED", error: "unsigned: token missing or mismatched", payload: "{}" },
      });
      const { alertWebhookRejections } = await import("@/lib/notify");
      await alertWebhookRejections("openphone");
    } catch { /* ignore */ }
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const raw = await req.text();
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
    data: { provider: "openphone", eventType: type, externalId, payload: raw || "{}" },
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

  // Our own numbers: in a group thread our own replies echo back as "incoming"
  // events FROM our line — those are OURS (outbound), not a client's message.
  // Our lines are also excluded from client matching so a group thread resolves
  // on the real participants.
  const ourNumbers = await ourOpenPhoneNumberKeys();
  const fromPhone = phoneKey((data.from as string) || "");
  const fromUs = fromPhone.length === 10 && ourNumbers.has(fromPhone);
  const effIncoming = incoming && !fromUs;
  const isInboundText = !fromUs && (type === "message.received" || (!isCall && incoming));

  // Who actually sent this? (team member / client / synced contact — or nobody
  // we know). Robo-senders (Aryeo reminders etc.) are notifications, not client
  // messages: don't log them as such and never turn them into leads.
  const sender = !fromUs && fromPhone.length === 10 ? await resolveSenderName(fromPhone) : null;
  const robo = !fromUs && !!sender && AUTOMATED_SENDER_RE.test(sender.name);

  const match = await resolveClientByPhones(phones.filter((k) => !ourNumbers.has(k)));

  // For a multi-order client, prefer the project the message is actually ABOUT
  // (named by street) over their most-recent order — so a text about an older
  // active listing isn't filed on their newest one. Client-scoped, so it never
  // routes onto a different client's job.
  let effProject = match?.project ?? null;
  if (match && !isCall && text.trim()) {
    const named = await findClientProjectByText(match.clientId, text);
    if (named) effProject = named;
  }

  // Comms memory: record the full text (in or out) so Ask the Hub can recall it.
  // Attributed to the REAL sender: our own messages are "Us" (outbound even when
  // they echoed back as incoming), inbound gets the sender's resolved name (or
  // their number, so an unknown texter still leaves an identifiable trace), and
  // robo-texts are skipped entirely — they'd read as fake client messages.
  if (!isCall && text.trim() && !robo) {
    // The number a reply goes back to: whoever wrote in, or (on our own
    // outbound) whoever we texted. Our own lines are excluded so a group
    // thread resolves to a real person rather than to us.
    const counterparty = effIncoming
      ? fromPhone
      : [...new Set(collectPhones(data.to).map((p) => phoneKey(p)))].find(
          (k) => k.length === 10 && !ourNumbers.has(k),
        ) ?? "";
    await logComm({
      channel: "text",
      direction: effIncoming ? "in" : "out",
      clientId: match?.clientId ?? null,
      clientName: match?.clientName ?? null,
      projectId: effProject?.id ?? null,
      fromPhone: counterparty || null,
      contactName: fromUs
        ? "Us"
        : effIncoming
          ? sender?.name ?? match?.clientName ?? (fromPhone.length === 10 ? prettyPhone(fromPhone) : null)
          : "RealTour Pilot",
      body: text,
      source: "openphone",
      externalId: data.id ? `op-${data.id as string}` : undefined,
    });
  }

  // --- Client path: log + reply task + revision detection (when we know the client).
  if (match) {
    const { clientId, clientName } = match;

    if (effProject) {
      const body = isCall
        ? `OpenPhone: ${direction || "call"} call (${type.replace("call.", "")}).`
        : `OpenPhone ${direction || ""} text: ${text.slice(0, 140)}`.trim();
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
        await closeReplyForOutbound(clientId, text);
        // Kyle often sends the "your gallery is ready" text straight from his
        // phone — that outbound text to a client with a queued delivery_text
        // IS the delivery text. Close it (audit: delivery_texts were 36% of
        // all overdue, only ever swept by a 7-day timer).
        await prisma.smartTask
          .updateMany({
            where: { clientId, taskType: "delivery_text", status: { notIn: ["COMPLETED", "CANCELLED"] } },
            data: { status: "COMPLETED", completedAt: new Date() },
          })
          .catch(() => {});
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
    const counterparts = fromUs
      ? [...new Set(collectPhones(data.to).map((p) => phoneKey(p)).filter((k) => k.length === 10 && !ourNumbers.has(k)))]
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
  if (isInboundText && text.trim()) {
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

// A completed call transcript: fetch it, attach to the client's project, and
// run the client's portion through revision detection (calls count too).
async function handleTranscript(data: Record<string, unknown>) {
  const callId = (data.callId as string) || (data.id as string) || "";

  // Prefer the dialogue already in the webhook payload; fall back to the API.
  const inline = data.dialogue as OpTranscriptLine[] | undefined;
  let full = "";
  let clientText = "";
  if (Array.isArray(inline) && inline.length) {
    full = inline.map((l) => l.content ?? "").join(" ").replace(/\s+/g, " ").trim();
    clientText = inline
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

  // Resolve the client from phones in the payload + the transcript identifiers.
  const phones = [...new Set(collectPhones(data).map((p) => phoneKey(p)).filter((k) => k.length === 10))];
  const ourNumbers = await ourOpenPhoneNumberKeys();
  const match = await resolveClientByPhones(phones.filter((k) => !ourNumbers.has(k)));

  // Unknown caller → this is a LEAD, not noise. Log the transcript (previously
  // it vanished without a trace) and mint/upgrade the callback task with what
  // they actually said. Requires the OTHER party to have spoken (clientText) so
  // our own outbound voicemails don't lead on ourselves.
  if (!match) {
    const callerKey = phones.find((k) => !ourNumbers.has(k));
    if (!callerKey || !clientText) return;
    const sender = await resolveSenderName(callerKey);
    if (sender && (sender.isTeam || AUTOMATED_SENDER_RE.test(sender.name))) return; // teammate / robo-call
    await logComm({
      channel: "call",
      direction: "in",
      clientId: null,
      contactName: sender?.name ?? prettyPhone(callerKey),
      body: full,
      source: "openphone-call",
      externalId: callId ? `op-call-${callId}` : undefined,
    });
    await upsertPhoneLeadTask({ phone: callerKey, kind: "voicemail", senderName: sender?.name ?? null, snippet: clientText });
    return;
  }
  const { clientId, clientName, project } = match;

  if (project) {
    await prisma.activity.create({
      data: {
        projectId: project.id,
        type: "SYSTEM",
        body: `Call transcript: ${full.slice(0, 280)}${full.length > 280 ? "…" : ""}`,
      },
    });
  }

  // Comms memory: store the full call transcript.
  await logComm({
    channel: "call",
    direction: "in",
    clientId,
    clientName,
    projectId: project?.id ?? null,
    contactName: clientName,
    body: full,
    source: "openphone-call",
    externalId: callId ? `op-call-${callId}` : undefined,
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
      kind: "voicemail",
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
