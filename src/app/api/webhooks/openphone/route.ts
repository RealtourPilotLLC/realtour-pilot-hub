import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { phoneKey } from "@/lib/integrations/openphone";

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

  // Find a client by any phone number in the event.
  const phones = [...new Set(collectPhones(data).map((p) => phoneKey(p)).filter((k) => k.length === 10))];
  if (phones.length === 0) return;

  const client = await prisma.client.findFirst({
    where: { OR: phones.map((k) => ({ phone: { contains: k.slice(-7) } })) },
    include: { projects: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true } } },
  });
  const projectId = client?.projects[0]?.id;
  if (!projectId) return;

  const isCall = type.startsWith("call");
  const direction = (data.direction as string) || "";
  const text = (data.text as string) || (data.body as string) || "";
  const body = isCall
    ? `OpenPhone: ${direction || "call"} call (${type.replace("call.", "")}).`
    : `OpenPhone ${direction || ""} text: ${text.slice(0, 140)}`.trim();

  await prisma.activity.create({
    data: { projectId, type: "SYSTEM", body },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "openphone-webhook" });
}
