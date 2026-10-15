import { askMedium } from "@/lib/comms";

// ---------------------------------------------------------------------------
// WHAT OF A JOB'S SPECIAL REQUESTS AN EDITOR READS (Oct 15 2026).
//
// A SPECIAL_REQUEST row is the photographer's brief as much as the editor's:
// since Oct 14 a client's texted access note ("the gate code is 4417") is
// filed there so /shoot shows it (shootNotes.ts), and every in-flight client
// ask lands there too (comms.ts), photo asks included. The editor brief, the
// outside shop's packet and the photo-edit PDF printed every row, so the next
// access note would have put a gate code in front of the editors, and a photo
// complaint ("the kitchen floor looks like two colours") sat on a video brief.
//
//   · an access note (filed by shootNotes, or any row naming a code, a key or
//     a lockbox) never reaches an editor of any kind;
//   · a client's ask about the PHOTOS is not on a VIDEO editor's brief.
// Staff-typed requests stay as written: the office chose who reads them.
// ---------------------------------------------------------------------------

/** The label a client's access note is filed under (shootNotes.ts). */
export const ACCESS_NOTE_LABEL = "Client access note";

/** "Client request (gmail): …" / "Client access note (openphone): …" → the words alone. */
export const stripRequestLabel = (s: string) => s.replace(/^Client (?:request|access note) \([^)]*\):\s*/i, "").trim();

// How to get in: never editing material, and never for anyone off site.
const SECRET = /\b(lock\s?-?box|door code|gate code|garage code|alarm(?: code)?|keypad|(?:the )?code (?:is|to|for)|access code|combo|combination|supra|keys? (?:is|are|will be|under|in|on))\b/i;

/** A row a client's access note became, or any row that names a code or a key. */
export function isAccessNote(body: string | null | undefined): boolean {
  const b = (body ?? "").trim();
  return b.startsWith(`${ACCESS_NOTE_LABEL} (`) || SECRET.test(b);
}

/** The rows an editor may read. `video`: a video editor (photo asks from the client are left out). */
export function requestsForEditors<T extends { body: string | null }>(rows: T[], opts: { video: boolean }): T[] {
  return rows.filter((r) => {
    const body = (r.body ?? "").trim();
    if (!body || isAccessNote(body)) return false;
    if (opts.video && /^Client request \(/i.test(body) && askMedium(stripRequestLabel(body)) === "photo") return false;
    return true;
  });
}
