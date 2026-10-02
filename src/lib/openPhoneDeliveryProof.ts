import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

export type StoredOpenPhoneEvent = {
  id: string;
  provider: string;
  eventType: string | null;
  externalId: string | null;
  payload: string;
};

const ACTOR = "provider:openphone";
const ACTION = "openphone_verified_delivery";
const receiptId = (id: string) => `openphone-verified:${id}`;
const detail = (row: StoredOpenPhoneEvent) => createHash("sha256")
  .update(JSON.stringify([1, row.id, row.provider, row.eventType, row.externalId, row.payload]))
  .digest("hex");

/** Only the authenticated POST receiver writes this receipt, in the same
 * transaction as its raw event. No token, secret or message body is copied to
 * the audit. Legacy/unsigned events cannot acquire proof through a replay. */
export function verifiedOpenPhoneDeliveryReceipt(row: StoredOpenPhoneEvent) {
  return { id: receiptId(row.id), actor: ACTOR, action: ACTION, target: row.id, detail: detail(row) };
}

/** A stored delivery retains authentication across a process restart only when
 * its original receipt binds every coordinate and the exact raw body. A failed
 * receipt read throws: treating it as absent would consume recoverable proof. */
export async function hasVerifiedOpenPhoneDeliveryProof(row: StoredOpenPhoneEvent): Promise<boolean> {
  if (row.provider !== "openphone" || row.eventType !== "message.delivered") return false;
  const receipt = await prisma.auditLog.findUnique({
    where: { id: receiptId(row.id) },
    select: { actor: true, action: true, target: true, detail: true },
  });
  return Boolean(receipt && receipt.actor === ACTOR && receipt.action === ACTION && receipt.target === row.id && receipt.detail === detail(row));
}
