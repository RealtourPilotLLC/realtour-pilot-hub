import "server-only";
import { ownerGoogleToken } from "./google";

// ---------------------------------------------------------------------------
// GOOGLE DRIVE — read Meet transcripts, and nothing else.
//
// Google Meet drops a transcript into Drive as a Google Doc named like
// "<Meeting name> - Transcript" (usually inside a "Meet Recordings" folder).
// We hold `drive.readonly`, which is broad — it can see the whole Drive — so
// the narrowing happens HERE, in the query, not in what we were granted:
//
//   · Docs only, never binary files.
//   · Name must look like a transcript.
//   · Owned by the account (not something shared in from a client).
//   · Inside the requested date window only.
//
// Jordan asked for "only backfilling this month", and that is enforced as a
// hard floor on the query rather than a limit applied after fetching.
// ---------------------------------------------------------------------------

const FILES = "https://www.googleapis.com/drive/v3/files";

export class DriveNotConnected extends Error {
  constructor(detail?: string) {
    super(detail || "Google Drive isn't connected. Reconnect Google on the Connections page.");
    this.name = "DriveNotConnected";
  }
}

async function driveFetch(url: string, token: string): Promise<Response> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (res.ok) return res;
  const body = await res.text();
  const msg = (() => {
    try {
      return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      return "";
    }
  })();
  // Same split as Calendar: a missing scope means reconnect, but "API disabled"
  // means a switch in Cloud Console. Telling him to reconnect for the second one
  // sends him round a loop that cannot fix it.
  if (res.status === 401 || (res.status === 403 && /insufficient|invalid credentials/i.test(msg))) {
    throw new DriveNotConnected();
  }
  throw new Error(msg || `Google Drive ${res.status}`);
}

export type TranscriptFile = {
  id: string;
  name: string;
  /** When the meeting actually happened (see heldAtFromTitle). */
  createdAt: Date;
};

/**
 * The real meeting time, read out of the file NAME.
 *
 * Gemini titles its notes "<people> - 2026/08/03 15:57 EDT - Notes by Gemini",
 * and that stamp is when the call STARTED. Drive's own createdTime is when the
 * notes were finalised — on Jordan's files that runs about ninety minutes late,
 * which would file a 4pm call under 5:25pm and land every deadline a day out.
 * The title wins; createdTime is only the fallback.
 */
export function heldAtFromTitle(name: string, fallback: Date): Date {
  const m = /(\d{4})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*([A-Z]{2,4})?/.exec(name);
  if (!m) return fallback;
  const [, y, mo, d, h, min, zone] = m;
  // The title states its own zone. EDT/EST are the only ones these ever carry;
  // anything else falls back rather than guessing an offset.
  const offset = zone === "EDT" ? "-04:00" : zone === "EST" ? "-05:00" : null;
  if (!offset) return fallback;
  const parsed = new Date(`${y}-${mo}-${d}T${h.padStart(2, "0")}:${min}:00${offset}`);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

/** Strip the machine noise so the card is headed with who the call was with. */
function cleanTitle(name: string): string {
  return (
    name
      .replace(/\s*-\s*Notes by Gemini\s*$/i, "")
      // The stamp trails the name, with or without its own dash — Gemini titles
      // a call with no named attendees "Meeting started 2026/06/16 14:40 EDT".
      .replace(/\s*-?\s*\d{4}\/\d{2}\/\d{2}\s+\d{1,2}:\d{2}\s*[A-Z]{2,4}\s*$/, "")
      .replace(/\s*\bMeeting started\s*$/i, "Meeting")
      .replace(/\s*-\s*transcript\s*$/i, "")
      .replace(/\s+and Jordan Spackman\s*$/i, "")
      .trim() || "Meeting"
  );
}

/**
 * Meeting notes for calls held inside [since, until]. Newest first.
 *
 * Matches BOTH shapes Google produces: raw Meet transcripts, and the "Notes by
 * Gemini" documents that Jordan's account actually generates — his Drive holds
 * no file named "Transcript" at all, so a transcript-only filter finds nothing.
 *
 * The window is applied to the MEETING time, not the file's createdTime, so a
 * call late on the last day of a month doesn't get filed into the next one.
 */
export async function listMeetTranscripts(since: Date, until: Date): Promise<TranscriptFile[]> {
  const token = await ownerGoogleToken();
  if (!token) throw new DriveNotConnected();

  // Query a little wider than asked, because notes are written AFTER the call
  // and a meeting can be inside the window while its file isn't yet.
  const pad = 2 * 86_400_000;
  const q = [
    "mimeType = 'application/vnd.google-apps.document'",
    "'me' in owners",
    "trashed = false",
    `createdTime >= '${new Date(since.getTime() - pad).toISOString()}'`,
    `createdTime <= '${new Date(until.getTime() + pad).toISOString()}'`,
    "(name contains 'Notes by Gemini' or name contains 'Transcript' or name contains 'transcript')",
  ].join(" and ");

  const out: TranscriptFile[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(FILES);
    url.searchParams.set("q", q);
    url.searchParams.set("fields", "nextPageToken, files(id, name, createdTime)");
    url.searchParams.set("orderBy", "createdTime desc");
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await driveFetch(url.toString(), token);
    const data = (await res.json()) as {
      nextPageToken?: string;
      files?: { id?: string; name?: string; createdTime?: string }[];
    };
    for (const f of data.files ?? []) {
      if (!f.id || !f.createdTime) continue;
      const heldAt = heldAtFromTitle(f.name || "", new Date(f.createdTime));
      // Now filter on when the MEETING was, which is what was actually asked for.
      if (heldAt < since || heldAt > until) continue;
      out.push({ id: f.id, name: cleanTitle(f.name || "Meeting"), createdAt: heldAt });
    }
    pageToken = data.nextPageToken;
    // A month of meetings is never 500 files; the cap is a runaway guard.
  } while (pageToken && out.length < 500);

  return out.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** The transcript text. Exported as plain text — we only ever read the words. */
export async function readTranscript(fileId: string): Promise<string> {
  const token = await ownerGoogleToken();
  if (!token) throw new DriveNotConnected();
  const res = await driveFetch(
    `${FILES}/${encodeURIComponent(fileId)}/export?mimeType=text/plain`,
    token,
  );
  return await res.text();
}

/** Cheap reachable/not check that doesn't depend on any file existing. */
export async function driveConnected(): Promise<boolean> {
  const token = await ownerGoogleToken();
  if (!token) return false;
  try {
    await driveFetch(`${FILES}?pageSize=1&fields=files(id)`, token);
    return true;
  } catch {
    return false;
  }
}
