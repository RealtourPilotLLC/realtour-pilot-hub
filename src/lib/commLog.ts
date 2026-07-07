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
    subject: input.subject?.slice(0, 300) ?? null,
    body: body.slice(0, 6000),
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
