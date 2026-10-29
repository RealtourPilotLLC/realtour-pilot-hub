import "server-only";
import { prisma } from "@/lib/prisma";
import {
  MESSAGE_FILES_PER_MESSAGE,
  conversationKey,
  isMessageImage,
  messageFilePrefix,
  messageFileRefusal,
  messageFileType,
  type ConversationRef,
  type PendingMessageFile,
} from "@/lib/messageFiles";

// ---------------------------------------------------------------------------
// WHERE MESSAGE FILES ARE KEPT (Oct 28 2026), PRIVATE ONLY. The same rule the
// photo desk's derivatives live by (lib/photoDelivery/blob): bytes are
// written only to a PRIVATE store, never the public one and never Dropbox.
//   MESSAGE_FILES_BLOB_TOKEN               a dedicated private store, if one is ever connected
//   REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN   the private review-cut store (live on
//                                          Vercel); our pathnames start team-files/,
//                                          which the cut store's delete guard refuses
// With neither (local dev), sending a file is refused in plain words; nothing
// falls back to a public store.
//
// The browser uploads straight to the store with a short-lived token from
// /api/messages/upload (a 50 MB file never passes through a server action).
// The send action then asks the STORE what landed (size and type from the
// store, never from the browser) and only accepts paths under this
// conversation's and this login's own prefix.
// ---------------------------------------------------------------------------

export type MessageFileStore = {
  head(pathname: string): Promise<{ pathname: string; url: string; size: number; contentType: string } | null>;
  read(pathname: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null } | null>;
};

/** The private store token, or null (then files can't be sent). */
export function messageFileToken(): string | null {
  const t = (process.env.MESSAGE_FILES_BLOB_TOKEN ?? "").trim() || (process.env.REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN ?? "").trim();
  return t || null;
}

const vercelPrivateStore = (token: string): MessageFileStore => ({
  async head(pathname) {
    const { head } = await import("@vercel/blob");
    const r = await head(pathname, { token, abortSignal: AbortSignal.timeout(15_000) }).catch(() => null);
    return r ? { pathname: r.pathname, url: r.url, size: r.size, contentType: r.contentType } : null;
  },
  async read(pathname) {
    const { get } = await import("@vercel/blob");
    const r = await get(pathname, { access: "private", token, abortSignal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!r || r.statusCode !== 200 || !r.stream) return null;
    return { stream: r.stream, size: r.blob.size ?? null };
  },
});

// undefined = no override; null = force "no store"; a store = use it.
let testStore: MessageFileStore | null | undefined;

/** Drills only: an in-memory store (or none). */
export function __setMessageFileStoreForTests(store: MessageFileStore | null | undefined): void {
  testStore = store;
}

export function messageFileStore(): MessageFileStore | null {
  if (testStore !== undefined) return testStore;
  const token = messageFileToken();
  return token ? vercelPrivateStore(token) : null;
}

export const NO_FILE_STORE = "Sending files isn't set up on this server yet. Send the words, and ask Jordan to connect the private file store.";

export type AcceptedFile = { pathname: string; url: string; name: string; contentType: string; size: number };
export type FileCheck = { ok: true; files: AcceptedFile[] } | { ok: false; message: string };

/** THE SEND-TIME CHECK on files the browser says it uploaded: each one is in
 *  this conversation's and this login's own folder, really in the store, of
 *  a type we take, and under the cap (as the store measured it). */
export async function acceptMessageFiles(c: ConversationRef, userId: string | null, pending: PendingMessageFile[] | null | undefined): Promise<FileCheck> {
  const list = (pending ?? []).filter((p) => p && typeof p.pathname === "string");
  if (list.length === 0) return { ok: true, files: [] };
  if (list.length > MESSAGE_FILES_PER_MESSAGE) return { ok: false, message: `Send up to ${MESSAGE_FILES_PER_MESSAGE} files on one message.` };
  const store = messageFileStore();
  if (!store) return { ok: false, message: NO_FILE_STORE };
  if (!userId) return { ok: false, message: "Sign in to send files." };
  const prefix = messageFilePrefix(c, userId);
  const out: AcceptedFile[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.pathname)) continue;
    seen.add(p.pathname);
    if (!p.pathname.startsWith(prefix) || p.pathname.includes("..")) return { ok: false, message: "That file wasn't uploaded to this conversation. Attach it again." };
    const name = String(p.name ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 120) || p.pathname.split("/").pop() || "file";
    const stored = await store.head(p.pathname);
    if (!stored) return { ok: false, message: `${name} didn't finish uploading. Attach it again.` };
    const type = messageFileType(name, stored.contentType);
    const why = messageFileRefusal({ name, size: stored.size, type });
    if (why || !type) return { ok: false, message: why ?? `${name} can't be sent.` };
    out.push({ pathname: stored.pathname, url: stored.url, name, contentType: type, size: stored.size });
  }
  return { ok: true, files: out };
}

/** The rows to create beside the message. */
export function attachmentRows(c: ConversationRef, userId: string | null, files: AcceptedFile[]) {
  return files.map((f) => ({ conversation: conversationKey(c), pathname: f.pathname, url: f.url, name: f.name, contentType: f.contentType, size: f.size, uploadedByUserId: userId }));
}

export type MessageFileView = { id: string; name: string; size: number; image: boolean; href: string };

export const messageFileHref = (id: string) => `/api/messages/file/${id}`;

/** The files on these messages, as the board draws them. Names go through the
 *  money scrub for anyone who doesn't see money (a file called "invoice $450"). */
export async function messageFileViews(
  ids: { projectMessageIds?: string[]; channelMessageIds?: string[] },
  opts: { money: boolean },
): Promise<Map<string, MessageFileView[]>> {
  const out = new Map<string, MessageFileView[]>();
  const pm = ids.projectMessageIds ?? [];
  const cm = ids.channelMessageIds ?? [];
  if (pm.length === 0 && cm.length === 0) return out;
  const rows = await prisma.messageAttachment
    .findMany({
      where: { OR: [...(pm.length ? [{ projectMessageId: { in: pm } }] : []), ...(cm.length ? [{ channelMessageId: { in: cm } }] : [])] },
      orderBy: { createdAt: "asc" },
      select: { id: true, projectMessageId: true, channelMessageId: true, name: true, size: true, contentType: true },
    })
    .catch(() => []);
  const { scrubMoney } = await import("@/lib/text");
  for (const r of rows) {
    const key = r.projectMessageId ?? r.channelMessageId;
    if (!key) continue;
    const list = out.get(key) ?? [];
    list.push({ id: r.id, name: opts.money ? r.name : scrubMoney(r.name), size: r.size, image: isMessageImage(r.contentType), href: messageFileHref(r.id) });
    out.set(key, list);
  }
  return out;
}
