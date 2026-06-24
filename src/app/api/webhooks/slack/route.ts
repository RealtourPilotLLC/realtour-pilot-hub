import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { logComm } from "@/lib/commLog";
import { slackUserName } from "@/lib/integrations/slack";
import { maybeCreateSlackTask } from "@/lib/integrations/slackSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET ?? "";

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
  if (!text) return;

  const ts = (event.ts as string) || "";
  const channel = (event.channel as string) || "";
  const userId = (event.user as string) || "";

  // 1) LIVE comms memory — log every channel message in real time (ADMIN tier;
  // the bot only sees channels, not Jordan's DMs). Deduped with the hourly
  // user-token sync via the shared externalId scheme.
  const senderName = await slackUserName(userId).catch(() => userId);
  await logComm({
    channel: "slack",
    direction: "in",
    minRole: "ADMIN",
    contactName: senderName || "Slack",
    body: text,
    occurredAt: ts ? new Date(Number(ts) * 1000) : undefined,
    source: "slack-channel",
    externalId: `slack-${channel}-${ts}`,
  });

  // 2) Smart task creation — AI decides if it's actionable + writes a clean
  // title/detail and matches it to a project (shared with the user-token sync).
  await maybeCreateSlackTask({ text, ts, channel, senderName });
}

export async function GET() {
  return NextResponse.json({ ok: true, endpoint: "slack-webhook" });
}
