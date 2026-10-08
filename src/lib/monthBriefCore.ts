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
  if (!name || !NAME_OK.test(name)) return "That file name can't be used — rename it and try again.";
  if (!BRIEF_EXT.test(name)) return "That type of file can't be added — PDFs, Word documents, pictures and text files work.";
  if (!Number.isFinite(size) || size <= 0) return "That file is empty.";
  if (size > BRIEF_MAX_BYTES) return `That file is over ${BRIEF_MAX_LABEL}. Send a smaller copy, or paste the text in the notes instead.`;
  return null;
}

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
