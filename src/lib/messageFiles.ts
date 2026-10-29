// ---------------------------------------------------------------------------
// PHOTOS AND FILES ON TEAM MESSAGES (Jordan, Oct 28 2026: "allow message
// attachments (files or photos)"). The rules both halves share: what may be
// sent, how big, how many, and where in the private store it goes. Plain
// module (no server-only imports) so the composer refuses a file before it
// uploads a byte, and the server refuses the same file with the same words.
//
// The bytes go straight from the browser to the PRIVATE blob store (never a
// public URL, never Dropbox) under team-files/<conversation>/<login>/…, and
// come back only through /api/messages/file/<id>, which asks whether the
// viewer can read that conversation.
// ---------------------------------------------------------------------------

/** One file's cap. A phone photo is 3 to 12 MB; a short clip of a problem at a house fits too. */
export const MESSAGE_FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Files on one message. */
export const MESSAGE_FILES_PER_MESSAGE = 6;

/** Photos a browser can draw: these show as thumbnails. */
export const MESSAGE_IMAGE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);

/** Every type a message may carry, by the extension that names it. No SVG or
 *  HTML: a file served from the hub's own address must never be able to run
 *  script there. HEIC is allowed and shows as a file (most browsers can't draw it). */
const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  heic: "image/heic", heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain", csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
};

export const MESSAGE_FILE_TYPES: readonly string[] = Array.from(new Set(Object.values(TYPE_BY_EXT)));

/** What the file picker offers. */
export const MESSAGE_FILE_ACCEPT = ["image/*", ...Object.keys(TYPE_BY_EXT).map((e) => `.${e}`)].join(",");

const extOf = (name: string) => (/\.([a-z0-9]{1,5})$/i.exec(name.trim())?.[1] ?? "").toLowerCase();

/** The type the hub stores a file under: the browser's word when it is one we
 *  take, else the extension's (Chrome reports "" for .heic and some .csv). */
export function messageFileType(name: string, browserType: string | null | undefined): string | null {
  const t = (browserType ?? "").trim().toLowerCase();
  if (t && MESSAGE_FILE_TYPES.includes(t)) return t;
  if (t === "image/jpg") return "image/jpeg";
  if (t === "application/x-zip-compressed") return "application/zip";
  return TYPE_BY_EXT[extOf(name)] ?? null;
}

export const isMessageImage = (contentType: string | null | undefined) => MESSAGE_IMAGE_TYPES.has((contentType ?? "").toLowerCase());

/** Shown in the browser rather than downloaded: photos and PDFs. */
export const opensInline = (contentType: string | null | undefined) => isMessageImage(contentType) || (contentType ?? "").toLowerCase() === "application/pdf";

export function fmtFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Why this file can't be sent, in plain words; null when it can. */
export function messageFileRefusal(f: { name: string; size: number; type?: string | null }): string | null {
  const name = f.name.trim() || "That file";
  if (!messageFileType(f.name, f.type)) {
    return `${name} can't be sent. Photos, PDFs, Word, Excel, PowerPoint, text, zip, short videos and audio can.`;
  }
  if (!(f.size > 0)) return `${name} is empty.`;
  if (f.size > MESSAGE_FILE_MAX_BYTES) {
    return `${name} is ${fmtFileSize(f.size)}. The most one file can be is ${fmtFileSize(MESSAGE_FILE_MAX_BYTES)}.`;
  }
  return null;
}

// ---- conversations ---------------------------------------------------------

/** A conversation a message lives in: the team channel, or one job's thread. */
export type ConversationRef = { kind: "team" } | { kind: "project"; projectId: string };

const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

/** "team" | "project:<id>": the key stored on an attachment and sent by the composer. */
export function conversationKey(c: ConversationRef): string {
  return c.kind === "team" ? "team" : `project:${c.projectId}`;
}

export function parseConversationKey(key: string | null | undefined): ConversationRef | null {
  const k = (key ?? "").trim();
  if (k === "team") return { kind: "team" };
  const m = /^project:(.+)$/.exec(k);
  return m && ID_RE.test(m[1]) ? { kind: "project", projectId: m[1] } : null;
}

/** A file name safe as a path segment; the shown name is kept separately. */
export function safeMessageFileName(name: string): string {
  const ext = extOf(name);
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[^\w.\- ()]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "file";
  return ext ? `${base}.${ext}` : base;
}

/** Every upload for this conversation by this login lives under this prefix;
 *  the token route signs nothing outside it and the send action accepts
 *  nothing outside it. */
export function messageFilePrefix(c: ConversationRef, userId: string): string {
  const conv = c.kind === "team" ? "team" : `project-${c.projectId}`;
  return `team-files/${conv}/${userId.replace(/[^A-Za-z0-9_-]/g, "")}/`;
}

/** The pathname the browser asks for (the store adds a random suffix). */
export function messageFilePathname(c: ConversationRef, userId: string, fileName: string, nonce: string): string {
  return `${messageFilePrefix(c, userId)}${nonce.replace(/[^A-Za-z0-9]/g, "").slice(0, 16) || "f"}/${safeMessageFileName(fileName)}`;
}

/** What the composer hands the send action after an upload finished. */
export type PendingMessageFile = { pathname: string; name: string };

/** The preview line for a message with no words (the list rows, the DM). */
export function filesLine(n: number, images: number): string {
  if (n <= 0) return "";
  if (images === n) return n === 1 ? "Sent a photo" : `Sent ${n} photos`;
  return n === 1 ? "Sent a file" : `Sent ${n} files`;
}
