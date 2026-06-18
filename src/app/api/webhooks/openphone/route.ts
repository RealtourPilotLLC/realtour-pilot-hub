import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { phoneKey, callTranscriptText, type OpTranscriptLine } from "@/lib/integrations/openphone";
import { resolveClientByPhones } from "@/lib/contacts";
import { recordClientCommunication } from "@/lib/comms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Receives OpenPhone events (message.received/delivered, call.completed/ringing/
// recording.completed), logs them, and attaches an activity to the matching
// client's most recent project so comms show up in real time.
export async function POST(req: NextRequest) {
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

function collectPhones(obj: unknown, acc: string[] = []): string[] {
  if (!obj) return acc;
  if (typeof obj === "string") {
    if (/^\+?\d[\d\s().-]{6,}$/.test(obj)) acc.push(obj);
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

async function processOpenPhoneEvent(type: string, payload: Record<string, unknown>) {
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
  const match = await resolveClientByPhones(phones);
  if (!match) return;
  const { clientId, clientName, project } = match;

  const isCall = type.startsWith("call");
  const direction = (data.direction as string) || "";
  const incoming = direction.toLowerCase().startsWith("in");
  const text = (data.text as string) || (data.body as string) || "";

  // Timeline log on the client's project (if any).
  if (project) {
    const body = isCall
      ? `OpenPhone: ${direction || "call"} call (${type.replace("call.", "")}).`
      : `OpenPhone ${direction || ""} text: ${text.slice(0, 140)}`.trim();
    await prisma.activity.create({ data: { projectId: project.id, type: "SYSTEM", body } });
  }

  // Listener-first: an inbound text becomes a tracked "reply" task in Daily
  // Tasks, and is cross-checked for a revision/change request on delivered jobs.
  if (type === "message.received" || (!isCall && incoming)) {
    await recordClientCommunication({
      clientId,
      clientName,
      projectId: project?.id,
      projectStatus: project?.status ?? null,
      propertyAddress: project?.title ?? null,
      text,
      kind: "text",
      source: "openphone",
    });
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
  const match = await resolveClientByPhones(phones);
  if (!match) return;
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

  // Scan the client's spoken words for a revision/change request.
  if (clientText) {
    await recordClientCommunication({
      clientId,
      clientName,
      projectId: project?.id,
      projectStatus: project?.status ?? null,
      propertyAddress: project?.title ?? null,
      text: clientText,
      kind: "voicemail",
      source: "openphone-call",
    });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "openphone-webhook" });
}
