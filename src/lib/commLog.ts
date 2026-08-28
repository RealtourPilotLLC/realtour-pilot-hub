import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Central comms-memory writer. Every client text, call transcript, email, and
// note flows through here so "Ask the Hub" can recall what was actually said.
// Idempotent on externalId (provider message/call id) so webhook retries and
// re-syncs never duplicate. Only a genuine duplicate is swallowed — any other
// insert failure (a DB blip) THROWS so the caller's error path (webhook ERROR
// row, cron error report) can retry it instead of silently losing the message.
export async function logComm(input: {
  channel: string; // text | call | email | slack | note
  direction?: string; // in | out
  minRole?: string; // CREATIVE | ADMIN | OWNER (default ADMIN); Slack DMs = OWNER
  clientId?: string | null;
  clientName?: string | null;
  projectId?: string | null;
  contactName?: string | null;
  fromPhone?: string | null; // the OTHER party's number — what a reply gets sent to
  subject?: string | null;
  body: string;
  occurredAt?: Date | null;
  source: string;
  externalId?: string | null;
}): Promise<boolean> {
  // Returns true if a NEW row was inserted (false if it already existed / empty),
  // so callers (e.g. the Slack sync) can act only on genuinely-new messages.
  const body = (input.body ?? "").trim();
  if (!body) return false;
  const role = input.minRole === "OWNER" || input.minRole === "CREATIVE" ? input.minRole : "ADMIN";
  const data = {
    channel: input.channel,
    direction: input.direction === "out" ? "out" : "in",
    minRole: role,
    clientId: input.clientId ?? null,
    clientName: input.clientName ?? null,
    projectId: input.projectId ?? null,
    contactName: input.contactName ?? null,
    // Normalize to the same 10-digit key everything else compares on, so a row
    // logged as "+1 (610) 555-0100" still matches a lookup for "6105550100".
    fromPhone: (() => {
      const k = (input.fromPhone ?? "").replace(/\D/g, "").slice(-10);
      return k.length === 10 ? k : null;
    })(),
    subject: input.subject?.slice(0, 300) ?? null,
    // A long CALL is the one thing that legitimately runs past a few thousand
    // characters, and truncating it loses real instructions — Marcee's 21-minute
    // revision call hit the old 6k ceiling mid-word and the back third (music
    // direction, video length) never reached the editor. Texts and email stay
    // on the tighter cap; a transcript gets room.
    body: body.slice(0, input.channel === "call" ? 60_000 : 6_000),
    occurredAt: input.occurredAt ?? new Date(),
    source: input.source,
    externalId: input.externalId ?? null,
  };
  if (data.externalId) {
    // Pre-check so the common dedup case is clean (no thrown constraint error).
    const existing = await prisma.commLog.findUnique({ where: { externalId: data.externalId }, select: { id: true } });
    if (existing) return false;
  }
  try {
    await prisma.commLog.create({ data });
    return true;
  } catch (e) {
    // Lost a race on the same externalId — already logged, harmless. Anything
    // else is a REAL write failure: rethrow it so the message stays retryable
    // (treating every failure as a dupe silently punched holes in comms memory).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    throw e;
  }
}
