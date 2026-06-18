import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { matchProjectFromText } from "@/lib/matchProject";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";

// Phrases that signal Jordan is assigning work (→ create a task).
const INSTRUCTION_RE =
  /\b(can you|could you|do you mind|please|reach out|check with|let them know|follow up|make sure|send|add|upload|request a revision|schedule|confirm|call|email|fix)\b/i;
// Short acknowledgements to ignore.
const IGNORE_RE = /^(thanks|thank you|ok|okay|sounds good|got it|yep|yes|no problem|np|👍|🙏|done)\.?$/i;

function verifySlack(raw: string, req: NextRequest): boolean {
  if (!SIGNING_SECRET) return false;
  const ts = req.headers.get("x-slack-request-timestamp") || "";
  const sig = req.headers.get("x-slack-signature") || "";
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // replay guard
  const base = `v0:${ts}:${raw}`;
  const expected = "v0=" + crypto.createHmac("sha256", SIGNING_SECRET).update(base).digest("hex");
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    /* ignore */
  }

  // Slack endpoint verification handshake.
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (!verifySlack(raw, req)) {
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  // Log + process event.
  const event = (payload.event as Record<string, unknown>) || {};
  const eventType = (event.type as string) || (payload.type as string) || "unknown";
  const externalId = (payload.event_id as string) || undefined;

  if (externalId) {
    const seen = await prisma.webhookEvent.findFirst({ where: { provider: "slack", externalId, status: "PROCESSED" } });
    if (seen) return NextResponse.json({ ok: true, deduped: true });
  }
  const log = await prisma.webhookEvent.create({
    data: { provider: "slack", eventType, externalId, payload: raw.slice(0, 8000) },
  });

  try {
    await processSlackEvent(event);
    await prisma.webhookEvent.update({ where: { id: log.id }, data: { status: "PROCESSED", processedAt: new Date() } });
  } catch (e) {
    await prisma.webhookEvent.update({
      where: { id: log.id },
      data: { status: "ERROR", error: e instanceof Error ? e.message : String(e) },
    });
  }
  return NextResponse.json({ ok: true });
}

async function processSlackEvent(event: Record<string, unknown>) {
  if (event.type !== "message") return;
  if (event.bot_id || event.subtype) return; // skip bots + edits/joins
  const text = ((event.text as string) || "").trim();
  if (text.length < 6 || IGNORE_RE.test(text)) return;
  if (!INSTRUCTION_RE.test(text)) return; // only act on instruction-like messages

  const ts = (event.ts as string) || "";
  const channel = (event.channel as string) || "";
  const dedupeKey = `slack-${ts}`;
  const exists = await prisma.smartTask.findUnique({ where: { dedupeKey } });
  if (exists) return;

  const kyle = await prisma.teamMember.findFirst({ where: { name: { contains: "Kyle" } } });
  const title = text.length > 90 ? text.slice(0, 88) + "…" : text;

  // Figure out which job the message is about and attach the to-do there.
  const match = await matchProjectFromText(text);

  await prisma.smartTask.create({
    data: {
      taskType: "internal_instruction",
      title,
      description: text,
      reasonCreated: match
        ? `Discussed in Slack — re: ${match.title}`
        : "Action item posted in Slack",
      checklist: JSON.stringify(["Do the requested action", "Reply in Slack when done"]),
      source: "slack",
      sourceDetail: channel ? `channel ${channel} · ${ts}` : ts,
      priority: "MEDIUM",
      dueAt: new Date(Date.now() + 6 * 3600_000),
      ownerId: kyle?.id ?? null,
      projectId: match?.id ?? null,
      clientId: match?.clientId ?? null,
      propertyAddress: match?.title ?? null,
      dedupeKey,
    },
  });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "slack-webhook" });
}
