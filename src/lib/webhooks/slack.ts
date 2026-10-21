import { NextRequest, NextResponse, after } from "next/server";
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
  // BYTE lengths, not character lengths (audit H19, Oct 20 2026): a header of
  // multi-byte characters matched the character count, timingSafeEqual threw
  // on the unequal buffers, and anyone could turn that into a 500, an error
  // row and an alert to Jordan. Same shape as openPhoneRequestAuthorized.
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Run after the response is sent (Next's after()); inline when there is no
 *  request scope (a drill calling POST directly). */
async function later(fn: () => Promise<void>): Promise<void> {
  try { after(fn); } catch { await fn(); }
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

  // ANSWER FIRST, WORK AFTER (audit H8, Oct 20 2026). Slack wants an answer
  // within 3 seconds and resends otherwise, and this receiver ran the AI
  // classification (maybeCreateSlackTask) before answering. A resend that
  // arrived while the first copy was still being worked found no PROCESSED
  // row and was worked again: double AI spend and error rows.
  //
  //   · A RETRY (x-slack-retry-num) of an event we already hold is answered at
  //     once, whatever state its row is in: the first copy owns it, and the
  //     hourly sweep (lib/webhookRetry) replays it if that copy failed. A
  //     retry we have NO row for is a first sighting (the original never got
  //     stored) and goes through the normal path, so nothing is dropped.
  //   · Otherwise the row is written, the 200 goes out, and the processing
  //     runs in after().
  const isRetry = !!req.headers.get("x-slack-retry-num");
  if (externalId) {
    const seen = await prisma.webhookEvent.findFirst({
      where: isRetry
        ? { provider: "slack", externalId, status: { in: ["RECEIVED", "PROCESSED", "ERROR", "FAILED"] } }
        : { provider: "slack", externalId, status: "PROCESSED" },
      select: { id: true },
    });
    if (seen) return NextResponse.json({ ok: true, deduped: true });
  }
  const log = await prisma.webhookEvent.create({
    data: { provider: "slack", eventType, externalId, payload: raw.slice(0, 8000) },
  });

  await later(async () => {
    try {
      await processSlackEvent(event);
      await prisma.webhookEvent.update({ where: { id: log.id }, data: { status: "PROCESSED", processedAt: new Date() } });
    } catch (e) {
      await prisma.webhookEvent
        .update({
          where: { id: log.id },
          data: { status: "ERROR", error: e instanceof Error ? e.message : String(e) },
        })
        .catch(() => {});
    }
  });
  return NextResponse.json({ ok: true });
}

export async function processSlackEvent(event: Record<string, unknown>) {
  if (event.type !== "message") return;
  if (event.bot_id || event.subtype) return; // skip bots + edits/joins
  // Slack HTML-escapes the user's own &/</> and wraps links/mentions in <…>
  // tokens — decode BEFORE storing: the externalId dedupe makes whatever this
  // path writes permanent (the hourly cron can never overwrite it clean).
  const { resolveSlackText } = await import("@/lib/integrations/slackSync");
  const text = resolveSlackText(((event.text as string) || "")).trim();
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
