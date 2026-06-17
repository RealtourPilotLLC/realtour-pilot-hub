import "server-only";
import { prisma } from "@/lib/prisma";
import { encryptSecret, decryptSecret } from "./crypto";

// Server-only helpers for reading/writing integration connections. The plaintext
// secret never leaves this layer except to the provider's own API client.

export async function getConnection(provider: string) {
  return prisma.connection.findUnique({ where: { provider } });
}

export async function getAllConnections() {
  return prisma.connection.findMany();
}

// Returns the decrypted secret for a provider, or null if not connected.
export async function getSecret(provider: string): Promise<string | null> {
  const conn = await prisma.connection.findUnique({ where: { provider } });
  if (!conn?.secretEncrypted) return null;
  try {
    return decryptSecret(conn.secretEncrypted);
  } catch {
    return null;
  }
}

export async function saveSecret(
  provider: string,
  secret: string,
  extra: { accountLabel?: string; metadata?: Record<string, unknown> } = {},
) {
  const data = {
    secretEncrypted: encryptSecret(secret),
    status: "CONNECTED",
    lastError: null,
    accountLabel: extra.accountLabel ?? null,
    metadata: extra.metadata ? JSON.stringify(extra.metadata) : undefined,
  };
  return prisma.connection.upsert({
    where: { provider },
    create: { provider, ...data },
    update: data,
  });
}

export async function markError(provider: string, error: string) {
  return prisma.connection.upsert({
    where: { provider },
    create: { provider, status: "ERROR", lastError: error },
    update: { status: "ERROR", lastError: error },
  });
}

export async function markSynced(provider: string, accountLabel?: string) {
  return prisma.connection.update({
    where: { provider },
    data: { lastSyncedAt: new Date(), status: "CONNECTED", lastError: null, ...(accountLabel ? { accountLabel } : {}) },
  });
}

export async function disconnect(provider: string) {
  return prisma.connection.upsert({
    where: { provider },
    create: { provider, status: "DISCONNECTED" },
    update: { status: "DISCONNECTED", secretEncrypted: null, lastError: null, accountLabel: null },
  });
}
