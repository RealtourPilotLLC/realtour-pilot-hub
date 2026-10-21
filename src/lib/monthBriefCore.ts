import { PORTAL_UPLOAD_MAX_BYTES, PORTAL_UPLOAD_MAX_LABEL } from "@/lib/portalUploadLimit";

// ---------------------------------------------------------------------------
// THE CLIENT'S CREATIVE BRIEF FOR A MONTH (Oct 8 2026) — the pure half: the
// limits, the shapes and the keys. Imported by the portal page, the staff
// card, the upload route and a drill alike.
//
// Jordan: "have the ability for them to upload a creative brief document for
// the month if they had planned it out themselves."
//
// A brief is any number of files (PDF, Word, images, plain text) and one note
// of pasted text, per program month. The bytes live in the company Dropbox
// under the app's own private prefix (storage.STORAGE_PREFIX — never a public
// store); the records are AppSetting rows keyed by the month, one per file and
// one for the note, so concurrent uploads never overwrite each other and no
// schema change was needed:
//
//   content-brief:<monthId>:f:<fileId>   { name, size, mime, path, by… }
//   content-brief:<monthId>:notes        { text, by… }
//
// Files are served only through /api/portal/brief/<monthId>/<fileId>, which
// admits the client of THAT enrollment (scoped media token), owner/admin, and
// the photographer or editor on one of THAT month's jobs.
//
// Oct 21 2026 (Jordan: "Since Mike creates his own creatives, give him the
// ability to upload a PDF or Word document so our team can access it"): a new
// file now lands in the client's OWN Dropbox folder, under
// "Content Plans/<YYYY-MM>/" with the name they gave it, so the team can find
// it there too (the private prefix stays the fallback, and older files stay
// where they are). Every file's first bytes must match what its name says
// (briefContentRefusal): a renamed program or web page is refused.
// ---------------------------------------------------------------------------

/** The platform refuses request bodies over ~4.5 MB, so the brief uses the portal's one number. */
export const BRIEF_MAX_BYTES = PORTAL_UPLOAD_MAX_BYTES;
export const BRIEF_MAX_LABEL = PORTAL_UPLOAD_MAX_LABEL;
/** Files a month's brief may hold, and uploads an enrollment may make in a day. */
export const BRIEF_FILES_MAX = 12;
export const BRIEF_DAILY_CAP = 20;
export const BRIEF_NOTES_MAX = 6000;

/** PDF, Word, images, plain text. No SVG/HTML (they can carry script), no archives, no video. */
export const BRIEF_EXT = /\.(pdf|docx|doc|txt|md|rtf|png|jpe?g|webp|heic|gif)$/i;
const NAME_OK = /^[^\\/:?*"<>|\u0000-\u001f]{1,180}$/;

/** The content type the file is SERVED as — from the extension, never from what the browser claimed. */
export function briefMimeFor(name: string): string {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", rtf: "application/rtf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", heic: "image/heic", gif: "image/gif",
  };
  return map[ext] ?? "application/octet-stream";
}

/** Shown in the browser (PDF and pictures) rather than downloaded. */
export function briefInline(name: string): boolean {
  return /\.(pdf|png|jpe?g|webp|gif)$/i.test(name);
}

/** The refusal for one file, or null when it may be stored. */
export function briefFileRefusal(name: string, size: number): string | null {
  if (!name || !NAME_OK.test(name)) return "That file name can't be used. Rename it and try again.";
  if (!BRIEF_EXT.test(name)) return "That type of file can't be added. PDFs, Word documents, pictures and text files work.";
  if (!Number.isFinite(size) || size <= 0) return "That file is empty.";
  if (size > BRIEF_MAX_BYTES) return `That file is over ${BRIEF_MAX_LABEL}. Send a smaller copy, or paste the text in the notes instead.`;
  return null;
}

// ---- what is inside the file (Oct 21 2026) ---------------------------------

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
const PDF_MARK = ascii("%PDF-");
const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** "%PDF-" in the first 1 KB (the PDF rule: a few bytes of junk may come first). */
function hasPdfMark(b: Uint8Array): boolean {
  const end = Math.min(b.length, 1024) - PDF_MARK.length;
  for (let i = 0; i <= end; i++) if (startsWith(b, PDF_MARK, i)) return true;
  return false;
}

/** What each allowed type must start with, and the words for a mismatch. */
const CONTENT_RULES: { ext: RegExp; word: string; ok: (b: Uint8Array) => boolean }[] = [
  { ext: /\.pdf$/i, word: "a PDF", ok: hasPdfMark },
  // .docx is a zip; .doc is the older Office container (or RTF saved as .doc,
  // which Word opens). Google Docs exports either. A web page saved as .doc is not.
  { ext: /\.docx$/i, word: "a Word document", ok: (b) => startsWith(b, ZIP) },
  { ext: /\.doc$/i, word: "a Word document", ok: (b) => startsWith(b, OLE) || startsWith(b, ZIP) || startsWith(b, ascii("{\\rtf")) },
  { ext: /\.rtf$/i, word: "a Word document", ok: (b) => startsWith(b, ascii("{\\rtf")) },
  { ext: /\.png$/i, word: "a picture", ok: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { ext: /\.jpe?g$/i, word: "a picture", ok: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { ext: /\.gif$/i, word: "a picture", ok: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")) },
  { ext: /\.webp$/i, word: "a picture", ok: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) },
  { ext: /\.heic$/i, word: "a picture", ok: (b) => startsWith(b, ascii("ftyp"), 4) },
  // Text is text: no NUL byte in the first 4 KB (every program file has them).
  { ext: /\.(txt|md)$/i, word: "a text file", ok: (b) => !b.subarray(0, 4096).includes(0) },
];

/**
 * The refusal when a file's first bytes are not what its name says, or null.
 * `head` is the start of the file (the whole file is fine). The browser's
 * claimed type is never trusted: a program renamed "plan.pdf" is refused here,
 * before a byte is stored.
 */
export function briefContentRefusal(name: string, head: Uint8Array): string | null {
  const rule = CONTENT_RULES.find((r) => r.ext.test(name));
  if (!rule) return "That type of file can't be added. PDFs, Word documents, pictures and text files work.";
  if (rule.ok(head)) return null;
  return `That file isn't ${rule.word}, even though its name says so. Save it again as ${rule.word === "a picture" ? "a picture" : "a PDF or Word document"} and upload the new copy.`;
}

/** The client's own folder for their plans: "<client folder>/Content Plans/<YYYY-MM>". */
export const BRIEF_PLAN_FOLDER = "Content Plans";
export const briefClientFolderPath = (clientFolder: string, monthKey: string) => `${clientFolder.replace(/\/+$/, "")}/${BRIEF_PLAN_FOLDER}/${monthKey}`;

export type BriefBy = { kind: "client" | "staff"; label: string; id: string | null };

export type BriefFile = {
  id: string;
  name: string;
  size: number;
  mime: string;
  /** The Dropbox path — server-side only; never sent to a browser. */
  path: string;
  by: BriefBy;
  atISO: string;
};

export type BriefNotes = { text: string; by: BriefBy; atISO: string };

export type MonthBrief = {
  monthId: string;
  enrollmentId: string;
  monthKey: string;
  files: BriefFile[];
  notes: BriefNotes | null;
};

/** What a page is handed: no storage paths. `href` is filled by the caller (a portal page mints a scoped token). */
export type BriefFileView = { id: string; name: string; size: number; byKind: "client" | "staff"; byLabel: string; atISO: string; href: string };
export type MonthBriefView = { monthId: string; monthKey: string; files: BriefFileView[]; notes: { text: string; byLabel: string; atISO: string } | null };

export const BRIEF_KEY_PREFIX = "content-brief:";
export const briefMonthPrefix = (monthId: string) => `${BRIEF_KEY_PREFIX}${monthId}:`;
export const briefFileKey = (monthId: string, fileId: string) => `${briefMonthPrefix(monthId)}f:${fileId}`;
export const briefNotesKey = (monthId: string) => `${briefMonthPrefix(monthId)}notes`;
export const BRIEF_ID_RE = /^[a-z0-9]{10,40}$/i;

/** The served address of one file (the caller appends `?m=<token>` for a portal visit). */
export const briefFileHref = (monthId: string, fileId: string) => `/api/portal/brief/${monthId}/${fileId}`;

export function briefIsEmpty(b: Pick<MonthBrief, "files" | "notes"> | null | undefined): boolean {
  return !b || (b.files.length === 0 && !(b.notes?.text ?? "").trim());
}

export const fmtBriefSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
