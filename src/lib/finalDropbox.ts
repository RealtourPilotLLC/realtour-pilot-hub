import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dbx } from "@/lib/integrations/dropbox";
import { fetchableCutUrl } from "@/lib/reviewCuts";

type Source = { id: string; round: number; blobUrl: string | null; blobPathname: string | null; sizeBytes: number | null; contentHash: string | null; sourceRev: string | null };
export type DropboxFileProof = { id: string; rev: string; hash: string; size: number; path: string };
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const backupSourceStamp = (s: Source) => digest([s.id, s.round, s.blobUrl, s.blobPathname, s.sizeBytes, s.contentHash, s.sourceRev]);
const backupVersionStamp = (s: Source) => digest([s.id, s.round, s.sizeBytes, s.contentHash, s.sourceRev]);

/** A path or completedAt is not proof that Dropbox holds the submitted bytes. */
export async function readDropboxFile(path: string): Promise<DropboxFileProof | null> {
  const m = await dbx<{ ".tag"?: string; id?: string; rev?: string; content_hash?: string; size?: number; path_display?: string; path_lower?: string }>("files/get_metadata", { path }).catch(() => null);
  if (!m || m[".tag"] !== "file" || !m.id || !m.rev || !/^[a-f0-9]{64}$/i.test(m.content_hash ?? "") || !Number.isSafeInteger(m.size) || m.size! <= 0) return null;
  const actual = m.path_display ?? m.path_lower;
  if (!actual || actual.toLowerCase() !== path.toLowerCase()) return null;
  return { id: m.id, rev: m.rev, hash: m.content_hash!, size: m.size!, path: actual };
}

/** Dropbox hashes 4 MiB blocks, then hashes their concatenated digests. Stream
 * the private source only when reconciling an existing/legacy copy. */
export async function sourceDropboxHash(s: Source): Promise<{ hash: string; size: number } | null> {
  const link = await fetchableCutUrl(s, { ttlMs: 10 * 60_000, purpose: "verify final Dropbox backup" });
  if (!link.ok) return null;
  try {
    const response = await fetch(link.url, { signal: AbortSignal.timeout(90_000), cache: "no-store" });
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const result = createHash("sha256");
    let block = createHash("sha256"), inBlock = 0, size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      let offset = 0;
      size += chunk.value.byteLength;
      while (offset < chunk.value.byteLength) {
        const count = Math.min(4 * 1024 * 1024 - inBlock, chunk.value.byteLength - offset);
        block.update(chunk.value.subarray(offset, offset + count));
        inBlock += count; offset += count;
        if (inBlock === 4 * 1024 * 1024) { result.update(block.digest()); block = createHash("sha256"); inBlock = 0; }
      }
    }
    if (inBlock) result.update(block.digest());
    return size > 0 ? { hash: result.digest("hex"), size } : null;
  } catch { return null; }
}

export function backupReceiptData(s: Source, file: DropboxFileProof): Prisma.AuditLogCreateInput {
  const sourceFingerprint = backupSourceStamp(s);
  // File id/content survive a legitimate rename. No private URL or body is logged.
  const detail = { sourceFingerprint, versionFingerprint: backupVersionStamp(s), fileId: file.id, contentHash: file.hash, size: file.size };
  return { id: `cut-backup:${digest([s.id, detail])}`, actor: "system", action: "cut_dropbox_backup", target: s.id, detail: JSON.stringify(detail) };
}

export async function proveOriginalBackup(s: Source, path: string): Promise<DropboxFileProof | null> {
  const file = await readDropboxFile(path);
  if (!file || (s.sizeBytes != null && file.size !== s.sizeBytes)) return null;
  const receipt = backupReceiptData(s, file);
  if (await prisma.auditLog.findUnique({ where: { id: receipt.id }, select: { id: true } })) return file;
  // Retention intentionally clears the hub URL after a verified copy. Preserve
  // that exact version's recorded content proof without trusting completedAt.
  if (!s.blobUrl) {
    const receipts = await prisma.auditLog.findMany({ where: { action: "cut_dropbox_backup", target: s.id }, select: { detail: true } });
    if (receipts.some((row) => {
      try {
        const value = JSON.parse(row.detail);
        return value.versionFingerprint === backupVersionStamp(s) && value.fileId === file.id && value.contentHash === file.hash && value.size === file.size;
      } catch { return false; }
    })) return file;
  }
  const source = s.blobUrl ? await sourceDropboxHash(s) : s.sourceRev && /^[a-f0-9]{64}$/i.test(s.sourceRev) ? { hash: s.sourceRev, size: s.sizeBytes ?? file.size } : null;
  return source?.hash === file.hash && source.size === file.size ? file : null;
}

export async function completeDropboxBackup(s: Source, path: string): Promise<boolean> {
  const file = await proveOriginalBackup(s, path);
  if (!file) return false;
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReviewSubmission" WHERE id = ${s.id} FOR UPDATE`;
    const current = await tx.reviewSubmission.findUnique({ where: { id: s.id } });
    if (!current || backupSourceStamp(current) !== backupSourceStamp(s)) return false;
    await tx.auditLog.upsert({ where: { id: backupReceiptData(s, file).id }, create: backupReceiptData(s, file), update: {} });
    await tx.reviewSubmission.update({ where: { id: s.id }, data: { finalPath: file.path, completedAt: new Date(), dropboxJobId: null } });
    return true;
  });
}
