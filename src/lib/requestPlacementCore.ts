// ---------------------------------------------------------------------------
// "NOT FOR THIS PROJECT" (Oct 28 2026), the pure part. Kyle, from 825 State St:
// "This request was assigned to this project but it was just a general
// request for a future video, not this one, needs an option besides
// 'Checked' to disregard it or unassign it to the project (Or potentially
// mark it as a task for a different project or leave it as a follow up for a
// future project)". The Smart Brain had put Ashley Brunner's 10:08 AM text
// ("I want a reel like this with specific points to our selling experience")
// on the one job she had in flight (clientAsks.fileAsksFromMessage).
//
// Every placement change of a client request is ONE record on the ask's own
// history (ClientAsk.historyJson, no new column): where it was, where it went,
// and the brief lines that went with it, so Undo puts back exactly that.
//   · move     OPEN on A      → OPEN on B (the client's other open project)
//   · future   OPEN on A      → FUTURE, no project (kept on the client and
//                                offered on their next project)
//   · dismiss  OPEN on A      → NOT_NEEDED on A ("Not a request")
//   · place    FUTURE         → OPEN on C (a saved request put on a project)
//   · dismiss  FUTURE         → NOT_NEEDED, no project
// The lib (requestPlacement.ts) writes them; this file reads them and holds
// the words, so the drills check them without a database.
// ---------------------------------------------------------------------------

/** The ask state for a request kept for the client's next project (ClientAsk.state is a plain string). */
export const FUTURE_STATE = "FUTURE";

export type PlaceKind = "move" | "future" | "dismiss" | "place";
export type PlaceSpot = { projectId: string | null; state: string };
/** A brief line (Activity SPECIAL_REQUEST) as it was before the change, so Undo restores it. */
export type LineBefore = { id: string; projectId: string; type: string; body: string };
export type PlaceRecord = { id: string; kind: PlaceKind; from: PlaceSpot; to: PlaceSpot; lines: LineBefore[]; fromStreet?: string | null; toStreet?: string | null };
export type UndoRecord = { undoes: string };
export type HistoryEntry = { at: string; by: string; what: string; placed?: PlaceRecord; undo?: UndoRecord };

/** The ask's history, whatever is stored (bad JSON reads as none). */
export function parseHistory(json: string | null | undefined): HistoryEntry[] {
  try {
    const arr = json ? (JSON.parse(json) as unknown) : [];
    return Array.isArray(arr) ? (arr.filter((x) => x && typeof x === "object") as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** Placement records not undone yet, newest first, each with its history entry. */
export function livePlacements(history: HistoryEntry[]): { entry: HistoryEntry; record: PlaceRecord }[] {
  const undone = new Set(history.map((h) => h.undo?.undoes).filter((x): x is string => !!x));
  const out: { entry: HistoryEntry; record: PlaceRecord }[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.placed && h.placed.id && !undone.has(h.placed.id)) out.push({ entry: h, record: h.placed });
  }
  return out;
}

const sameSpot = (a: PlaceSpot, b: PlaceSpot) => (a.projectId ?? null) === (b.projectId ?? null) && a.state === b.state;

/** The change Undo would reverse: the newest live record, when the ask still sits where it put it. */
export function undoable(history: HistoryEntry[], now: PlaceSpot): { entry: HistoryEntry; record: PlaceRecord } | null {
  const top = livePlacements(history)[0];
  return top && sameSpot(top.record.to, now) ? top : null;
}

/** Was this ask taken off `projectId` (and not put back)? The re-file guard reads it. */
export function takenOffProject(history: HistoryEntry[], projectId: string, now: PlaceSpot): PlaceRecord | null {
  if (now.projectId === projectId && now.state === "OPEN") return null;
  return livePlacements(history).find((x) => x.record.from.projectId === projectId)?.record ?? null;
}

// ---- which brief lines are this ask's own -------------------------------------------------

/** "Client request (gmail): …" / "Client access note (openphone): …" → the words alone. */
export const stripLineLabel = (s: string) => (s ?? "").replace(/^Client (?:request|access note) \([^)]*\):\s*/i, "").trim();
const norm = (s: string) => (s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** One inside the other, after normalizing; a short side needs 12+ characters. */
export function wordsOverlap(a: string, b: string): boolean {
  const x = norm(a.replace(/…$/, ""));
  const y = norm(b.replace(/…$/, ""));
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 12 && long.includes(short);
}

/**
 * Is this SPECIAL_REQUEST line the copy of this ask that the same message put
 * on the job's brief (comms writes "Client request (<source>): <message>" on
 * an in-flight job, shootNotes "Client access note (…)")? Pure. Only labelled
 * client lines count; a line staff typed is matched by its own key instead.
 */
export function isLineOfAsk(lineBody: string, ask: { text: string; summary?: string | null }, message?: string | null): boolean {
  const body = (lineBody ?? "").trim();
  if (!/^Client (?:request|access note) \(/i.test(body)) return false;
  const words = stripLineLabel(body);
  if (!words) return false;
  if (message && wordsOverlap(words, message)) return true;
  return wordsOverlap(words, ask.text) || (!!ask.summary && wordsOverlap(words, ask.summary));
}

/** A brief line taken off the project keeps its words on the office timeline under this label. */
export const TAKEN_OFF_LABEL = "Taken off this project";
export function takenOffLineBody(body: string, by: string, why: string): string {
  return `${TAKEN_OFF_LABEL} (${by}, ${why}): ${body}`.slice(0, 4000);
}

// ---- the words -------------------------------------------------------------------------------

/** "825 State St, Philadelphia, PA" → "825 State St". */
export const streetOf = (title?: string | null) => (title ?? "").split(",")[0].trim() || null;

/** What a record did, from the project it left: "Moved to 512 Firethorn Rd", "Kept for a future project", "Not a request". */
export function outcomeWords(r: Pick<PlaceRecord, "kind" | "toStreet" | "from">): string {
  if (r.kind === "move") return `Moved to ${r.toStreet ?? "another project"}`;
  if (r.kind === "future") return "Kept for a future project";
  if (r.kind === "place") return `Put on ${r.toStreet ?? "a project"}`;
  return r.from.state === FUTURE_STATE ? "Set aside, not needed" : "Not a request";
}

/** A row's one line on the project it left: "Moved to 512 Firethorn Rd by Kyle Smith, Wed, Oct 28, 10:30 AM". */
export function takenOffLine(r: Pick<PlaceRecord, "kind" | "toStreet" | "from">, by: string, when: string): string {
  return `${outcomeWords(r)} by ${by}${when ? `, ${when}` : ""}`;
}
