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
  /** When the meeting happened — the recording's creation time. */
  createdAt: Date;
};

/** Meet transcript Docs created inside [since, until]. Newest first. */
export async function listMeetTranscripts(since: Date, until: Date): Promise<TranscriptFile[]> {
  const token = await ownerGoogleToken();
  if (!token) throw new DriveNotConnected();

  const q = [
    "mimeType = 'application/vnd.google-apps.document'",
    "'me' in owners",
    "trashed = false",
    `createdTime >= '${since.toISOString()}'`,
    `createdTime <= '${until.toISOString()}'`,
    // Google localises the suffix, so match the stem rather than an exact name.
    "(name contains 'Transcript' or name contains 'transcript')",
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
      out.push({ id: f.id, name: (f.name || "Meeting").replace(/\s*-\s*transcript\s*$/i, "").trim(), createdAt: new Date(f.createdTime) });
    }
    pageToken = data.nextPageToken;
    // A month of meetings is never 500 files; the cap is a runaway guard.
  } while (pageToken && out.length < 500);

  return out;
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
