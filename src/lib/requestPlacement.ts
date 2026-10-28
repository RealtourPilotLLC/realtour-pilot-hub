import "server-only";
import type { ActivityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clip, scrubMoney } from "@/lib/text";
import { etDateTime, etMonthDay } from "@/lib/datetime";
import {
  ASK_SOURCES, asMedium, closesOnDelivery, jobInFlight, messageAskKey, requestOwner, shootIsOver, sourceWords, viewerSeesMoney,
} from "@/lib/clientAsks";
import {
  FUTURE_STATE, TAKEN_OFF_LABEL, isLineOfAsk, livePlacements, outcomeWords, parseHistory, streetOf, takenOffLine, takenOffLineBody,
  takenOffProject, undoable, wordsOverlap,
  type HistoryEntry, type LineBefore, type PlaceKind, type PlaceRecord, type PlaceSpot,
} from "@/lib/requestPlacementCore";

// ---------------------------------------------------------------------------
// "NOT FOR THIS PROJECT" (Kyle, Oct 28 2026, 825 State St; the words and the
// record shape are in requestPlacementCore.ts). Beside "Checked", every client
// request card offers three ways off a project it was put on by mistake:
//   · Move to another project: one of this client's other open projects; it
//     shows there, for that project's people (the owner follows the job);
//   · Keep for a future project: off every project, kept on the client's page
//     and offered on the client's next project once it is booked;
//   · Not a request: set aside (Not needed), as Kyle would for any other.
// Each one is undone with one press, and both projects' timelines say who did
// what, when.
//
// WHAT GOES WITH IT. The request is the ClientAsk row, which the cards, the
// desks, the Projects list, the shoot brief (photographerBrief), the shoot-day
// text and the evening push read by project. The same message may also have
// put a copy of its words on the job's brief as a SPECIAL_REQUEST line (comms
// on an in-flight job, shootNotes for an access note, a Request typed in the
// composer): the editor brief, the shoot screen and the editor packet read
// those. That line goes with the request (moved to the other project, or kept
// on the timeline as an office note under "Taken off this project"), and Undo
// puts it back exactly as it was.
//
// NOT AGAIN. The Smart Brain files a message once (its key), and a request
// whose words were taken off a project is not filed on that project again
// from a new reading of the same words (clientAsks.fileAsksFromMessage reads
// takenOffWords; comms reads messageTakenOff before writing the brief line).
// ---------------------------------------------------------------------------

export type PlaceResult = { ok: boolean; message: string; projectIds?: string[]; clientId?: string | null };
export type MoveChoice = { id: string; label: string };

const ASK_SELECT = {
  id: true, clientId: true, projectId: true, state: true, kind: true, historyJson: true, summary: true, text: true,
  dedupeKey: true, source: true, sourceRef: true, createdAt: true, askedAt: true,
} satisfies Prisma.ClientAskSelect;
type AskRow = Prisma.ClientAskGetPayload<{ select: typeof ASK_SELECT }>;

class Stale extends Error {}
const STALE = "Someone changed this request a moment ago. Reload the page.";
const GONE = "That request is no longer here. Reload the page.";
const DAY = 86_400_000;
/** "Moved to 512 Firethorn Rd" → "moved to 512 Firethorn Rd" (the street keeps its capitals). */
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const recordId = () => `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const quoted = (a: { summary: string | null; text: string }) => `"${clip((a.summary?.trim() || a.text).replace(/\s+/g, " "), 160)}"`;

function pushEntry(json: string | null | undefined, entry: HistoryEntry): string {
  const arr = parseHistory(json);
  arr.push(entry);
  return JSON.stringify(arr.slice(-30));
}

async function timeline(projectId: string | null | undefined, body: string) {
  if (!projectId) return;
  await prisma.activity.create({ data: { projectId, type: "SYSTEM", body: clip(body, 600) } }).catch(() => {});
}

/** The client and everyone folded with them (an assistant's account folds onto the agent's). */
async function familyOf(clientId: string): Promise<string[]> {
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, parentClientId: true } });
  if (!c) return [clientId];
  const root = c.parentClientId ?? c.id;
  const kids = await prisma.client.findMany({ where: { parentClientId: root }, select: { id: true } });
  return [...new Set([root, c.id, ...kids.map((k) => k.id)])];
}

/** The client's open projects (not delivered, not cancelled), soonest shoot first, as picker choices. */
async function openProjectsOf(clientIds: string[], except: string | null): Promise<MoveChoice[]> {
  const rows = await prisma.project.findMany({
    where: { clientId: { in: clientIds }, status: { notIn: ["DELIVERED", "CANCELLED"] }, deliveredAt: null, ...(except ? { id: { not: except } } : {}) },
    orderBy: [{ shootDate: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 25,
    select: { id: true, title: true, shootDate: true, orderedAt: true, createdAt: true },
  });
  return rows.map((p) => ({
    id: p.id,
    label: `${streetOf(p.title) ?? "A project"}${p.shootDate ? `, shoot ${etMonthDay(p.shootDate)}` : `, ordered ${etMonthDay(p.orderedAt ?? p.createdAt)}`}`,
  }));
}

/** May this ask go on that project: the same client (or its fold), still open. */
async function checkTarget(clientId: string, projectId: string): Promise<{ ok: true; title: string; clientId: string } | { ok: false; message: string }> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, clientId: true, status: true, deliveredAt: true } });
  if (!p) return { ok: false, message: "That project is not in the hub. Reload the page." };
  if (!(await familyOf(clientId)).includes(p.clientId)) return { ok: false, message: "That project belongs to a different client." };
  if (!jobInFlight(p)) return { ok: false, message: `${streetOf(p.title) ?? "That project"} is already delivered or cancelled. Pick an open one.` };
  return { ok: true, title: p.title, clientId: p.clientId };
}

/** The brief lines this ask's message (or a Request typed for it) put on its project. */
async function linkedLines(tx: Prisma.TransactionClient, ask: AskRow): Promise<LineBefore[]> {
  if (!ask.projectId) return [];
  const key = ask.dedupeKey ?? "";
  if (key.startsWith("request-note:")) {
    const a = await tx.activity.findUnique({ where: { id: key.slice("request-note:".length) }, select: { id: true, projectId: true, type: true, body: true } });
    return a && a.projectId === ask.projectId && a.type === "SPECIAL_REQUEST" ? [{ id: a.id, projectId: a.projectId, type: a.type, body: a.body }] : [];
  }
  // A request the photographer logged on site (agentRequests.addOnSiteRequest)
  // writes "Client request (on site, logged by …)" right after its ask.
  const onSite = ask.source === "staff" && (ask.sourceRef ?? "").startsWith("on-site:");
  if (!onSite && !["text", "email", "call"].includes(ask.source)) return [];
  // Written in the same pass as the ask (comms writes the line, then files the asks).
  const at = ask.createdAt.getTime();
  const rows = await tx.activity.findMany({
    where: { projectId: ask.projectId, type: "SPECIAL_REQUEST", createdAt: { gte: new Date(at - 20 * 60_000), lte: new Date(at + 20 * 60_000) } },
    select: { id: true, projectId: true, type: true, body: true },
  });
  if (!rows.length) return [];
  const message = ask.sourceRef && !onSite ? (await tx.commLog.findUnique({ where: { id: ask.sourceRef }, select: { body: true } }).catch(() => null))?.body ?? null : null;
  return rows.filter((r) => isLineOfAsk(r.body, ask, message)).map((r) => ({ id: r.id, projectId: r.projectId, type: r.type, body: r.body }));
}

/** One placement change, in one transaction: the ask, its brief lines, its history. Throws Stale when the ask moved meanwhile. */
async function relocate(ask: AskRow, kind: PlaceKind, to: PlaceSpot, by: string, note: string, streets: { from: string | null; to: string | null }): Promise<PlaceRecord> {
  const from: PlaceSpot = { projectId: ask.projectId, state: ask.state };
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const lines = from.projectId && from.state === "OPEN" ? await linkedLines(tx, ask) : [];
    const record: PlaceRecord = { id: recordId(), kind, from, to, lines, fromStreet: streets.from, toStreet: streets.to };
    const what = `${lowerFirst(outcomeWords(record))}${from.projectId ? ` (not for ${streets.from ?? "that project"})` : ""}`;
    const r = await tx.clientAsk.updateMany({
      where: { id: ask.id, state: from.state, projectId: from.projectId },
      data: {
        projectId: to.projectId,
        state: to.state,
        ...(to.state === "NOT_NEEDED" ? { doneAt: now, doneBy: by, confirmNote: clip(note || "Not a request", 500) } : {}),
        historyJson: pushEntry(ask.historyJson, { at: now.toISOString(), by, what, placed: record }),
      },
    });
    if (!r.count) throw new Stale();
    for (const l of lines) {
      if (kind === "move" && to.projectId) await tx.activity.update({ where: { id: l.id }, data: { projectId: to.projectId } });
      else await tx.activity.update({ where: { id: l.id }, data: { type: "NOTE", body: takenOffLineBody(l.body, by, lowerFirst(outcomeWords(record))) } });
    }
    return record;
  });
}

async function readAsk(id: string): Promise<AskRow | null> {
  return prisma.clientAsk.findUnique({ where: { id }, select: ASK_SELECT });
}

// ---- writing ---------------------------------------------------------------------------------

/** Where a request can go from its project: for the picker the card opens (lazy, so any screen can carry the button). */
export async function placementContext(askId: string): Promise<{ ok: true; fromProjectId: string; street: string; clientName: string | null; choices: MoveChoice[] } | { ok: false; message: string }> {
  const ask = await readAsk(askId);
  if (!ask || ask.kind !== "SPECIAL_REQUEST") return { ok: false, message: GONE };
  if (ask.state === "OPEN" && !ask.projectId) return { ok: false, message: "This request is on no project yet. Pick its project on the client's page." };
  if (ask.state !== "OPEN" || !ask.projectId) return { ok: false, message: "This request is not open on a project any more. Reload the page." };
  const [p, client, family] = await Promise.all([
    prisma.project.findUnique({ where: { id: ask.projectId }, select: { title: true } }),
    prisma.client.findUnique({ where: { id: ask.clientId }, select: { name: true } }),
    familyOf(ask.clientId),
  ]);
  return { ok: true, fromProjectId: ask.projectId, street: streetOf(p?.title) ?? "this project", clientName: client?.name ?? null, choices: await openProjectsOf(family, ask.projectId) };
}

/**
 * "Not for this project": take an open request off `fromProjectId` (the page
 * the press came from; a request that moved meanwhile is refused). `move`
 * needs `toProjectId`, one of the client's other open projects.
 */
export async function takeRequestOffProject(input: { askId: string; fromProjectId: string; outcome: "move" | "future" | "dismiss"; toProjectId?: string | null; by: string }): Promise<PlaceResult> {
  const ask = await readAsk(input.askId);
  if (!ask || ask.kind !== "SPECIAL_REQUEST") return { ok: false, message: GONE };
  if (ask.projectId !== input.fromProjectId) return { ok: false, message: "This request is not on this project any more. Reload the page." };
  if (ask.state !== "OPEN") return { ok: false, message: "This request is already closed. Reload the page." };
  const fromP = await prisma.project.findUnique({ where: { id: input.fromProjectId }, select: { title: true, client: { select: { name: true } } } });
  const fromStreet = streetOf(fromP?.title) ?? "this project";
  const s = quoted(ask);
  try {
    if (input.outcome === "move") {
      const to = (input.toProjectId ?? "").trim();
      if (!to) return { ok: false, message: "Pick the project it is for." };
      if (to === input.fromProjectId) return { ok: false, message: `It is already on ${fromStreet}.` };
      const t = await checkTarget(ask.clientId, to);
      if (!t.ok) return t;
      const toStreet = streetOf(t.title) ?? "the other project";
      await relocate(ask, "move", { projectId: to, state: "OPEN" }, input.by, "", { from: fromStreet, to: toStreet });
      await timeline(input.fromProjectId, `Client request taken off this project by ${input.by}: moved to ${toStreet}. ${s}`);
      await timeline(to, `Client request moved here from ${fromStreet} by ${input.by}. ${s}`);
      return { ok: true, message: `Moved to ${toStreet}.`, projectIds: [input.fromProjectId, to], clientId: ask.clientId };
    }
    if (input.outcome === "future") {
      const who = fromP?.client?.name ?? "the client";
      await relocate(ask, "future", { projectId: null, state: FUTURE_STATE }, input.by, "", { from: fromStreet, to: null });
      await timeline(input.fromProjectId, `Client request taken off this project by ${input.by}: kept for ${who}'s next project. ${s}`);
      return { ok: true, message: `Kept for ${who}'s next project. It is on their client page.`, projectIds: [input.fromProjectId], clientId: ask.clientId };
    }
    if (input.outcome === "dismiss") {
      await relocate(ask, "dismiss", { projectId: input.fromProjectId, state: "NOT_NEEDED" }, input.by, "Not a request", { from: fromStreet, to: fromStreet });
      await timeline(input.fromProjectId, `Client request taken off this project by ${input.by}: not a request. ${s}`);
      return { ok: true, message: "Set aside: not a request.", projectIds: [input.fromProjectId], clientId: ask.clientId };
    }
    return { ok: false, message: "Pick what to do with it." };
  } catch (e) {
    if (e instanceof Stale) return { ok: false, message: STALE };
    throw e;
  }
}

/**
 * Waiting for a project: kept for a future one, or filed on none (the brain
 * files a request on no job when the client has several in flight, and Kyle's
 * list says "pick the job for each" on the client page).
 */
const waitingForProject = (a: { state: string; projectId: string | null }) => a.state === FUTURE_STATE || (a.state === "OPEN" && !a.projectId);
const NOT_WAITING = "This request is not waiting for a project any more. Reload the page.";

/** A request waiting for a project (kept for later, or filed on none), put on one of the client's open projects. */
export async function placeSavedRequest(input: { askId: string; projectId: string; by: string }): Promise<PlaceResult> {
  const ask = await readAsk(input.askId);
  if (!ask || ask.kind !== "SPECIAL_REQUEST") return { ok: false, message: GONE };
  if (!waitingForProject(ask)) return { ok: false, message: NOT_WAITING };
  const t = await checkTarget(ask.clientId, input.projectId);
  if (!t.ok) return t;
  const toStreet = streetOf(t.title) ?? "the project";
  const kept = livePlacements(parseHistory(ask.historyJson)).find((x) => x.record.kind === "future")?.record ?? null;
  try {
    await relocate(ask, "place", { projectId: input.projectId, state: "OPEN" }, input.by, "", { from: kept?.fromStreet ?? null, to: toStreet });
  } catch (e) {
    if (e instanceof Stale) return { ok: false, message: STALE };
    throw e;
  }
  await timeline(input.projectId, `${ask.state === FUTURE_STATE ? "Saved client request" : "Client request"} put on this project by ${input.by}${kept?.fromStreet ? ` (kept from ${kept.fromStreet})` : ""}. ${quoted(ask)}`);
  return { ok: true, message: `Put on ${toStreet}.`, projectIds: [input.projectId], clientId: ask.clientId };
}

/** A request waiting for a project, set aside after all. */
export async function dismissSavedRequest(input: { askId: string; by: string }): Promise<PlaceResult> {
  const ask = await readAsk(input.askId);
  if (!ask || ask.kind !== "SPECIAL_REQUEST") return { ok: false, message: GONE };
  if (!waitingForProject(ask)) return { ok: false, message: NOT_WAITING };
  try {
    await relocate(ask, "dismiss", { projectId: null, state: "NOT_NEEDED" }, input.by, ask.state === FUTURE_STATE ? "Not needed for a future project" : "Not a request", { from: null, to: null });
  } catch (e) {
    if (e instanceof Stale) return { ok: false, message: STALE };
    throw e;
  }
  return { ok: true, message: "Set aside: not needed.", projectIds: [], clientId: ask.clientId };
}

/** Undo the newest placement change, when the request still sits where it put it. Its brief lines go back as they were. */
export async function undoRequestPlacement(input: { askId: string; by: string }): Promise<PlaceResult> {
  const ask = await readAsk(input.askId);
  if (!ask) return { ok: false, message: GONE };
  const history = parseHistory(ask.historyJson);
  const top = undoable(history, { projectId: ask.projectId, state: ask.state });
  if (!top) return { ok: false, message: livePlacements(history).length ? "This request changed since then, so Undo would put back the wrong thing. Reload the page." : "Nothing to undo." };
  const r = top.record;
  const now = new Date();
  try {
    await prisma.$transaction(async (tx) => {
      const u = await tx.clientAsk.updateMany({
        where: { id: ask.id, state: r.to.state, projectId: r.to.projectId },
        data: {
          projectId: r.from.projectId,
          state: r.from.state,
          ...(r.to.state === "NOT_NEEDED" ? { doneAt: null, doneBy: null, confirmNote: null } : {}),
          historyJson: pushEntry(ask.historyJson, { at: now.toISOString(), by: input.by, what: `undo: ${lowerFirst(outcomeWords(r))}`, undo: { undoes: r.id } }),
        },
      });
      if (!u.count) throw new Stale();
      for (const l of r.lines ?? []) {
        // Only a line still as this change left it (moved, or kept as "Taken off").
        if (r.kind === "move") await tx.activity.updateMany({ where: { id: l.id, projectId: r.to.projectId ?? "" }, data: { projectId: l.projectId } });
        else await tx.activity.updateMany({ where: { id: l.id, body: { startsWith: TAKEN_OFF_LABEL } }, data: { type: l.type as ActivityType, body: l.body, projectId: l.projectId } });
      }
    });
  } catch (e) {
    if (e instanceof Stale) return { ok: false, message: STALE };
    throw e;
  }
  const s = quoted(ask);
  const back = r.fromStreet ?? "the project";
  if (r.from.projectId) await timeline(r.from.projectId, `${input.by} pressed Undo on "${outcomeWords(r)}": the client request is back on this project. ${s}`);
  const offAll = r.from.state === FUTURE_STATE ? "to the client's saved requests" : "to the client's requests on no project";
  if (r.to.projectId && r.to.projectId !== r.from.projectId) await timeline(r.to.projectId, `${input.by} pressed Undo: the client request went back ${r.from.projectId ? `to ${back}` : offAll}. ${s}`);
  const message = r.from.state === FUTURE_STATE
    ? "Undone: it is saved for the client's next project again."
    : r.from.projectId ? `Undone: back on ${back}.` : "Undone: it is on no project again.";
  return { ok: true, message, projectIds: [r.from.projectId, r.to.projectId].filter((x): x is string => !!x), clientId: ask.clientId };
}

// ---- the re-file guards ----------------------------------------------------------------------

/** The words of this client's requests taken off each project (and not put back): the Smart Brain does not file them there again. */
export async function takenOffWords(clientId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!clientId) return out;
  const rows = await prisma.clientAsk.findMany({
    where: { clientId, kind: "SPECIAL_REQUEST", historyJson: { contains: '"placed":' } },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { projectId: true, state: true, text: true, summary: true, historyJson: true },
  });
  for (const r of rows) {
    const h = parseHistory(r.historyJson);
    const spot = { projectId: r.projectId, state: r.state };
    for (const { record } of livePlacements(h)) {
      const from = record.from.projectId;
      if (!from || !takenOffProject(h, from, spot)) continue;
      out.set(from, [...(out.get(from) ?? []), r.text, ...(r.summary ? [r.summary] : [])]);
    }
  }
  return out;
}

/** Pure: do these words repeat a request already taken off that project? */
export function repeatsTakenOff(taken: Map<string, string[]>, projectId: string | null, words: (string | null | undefined)[]): boolean {
  if (!projectId) return false;
  const gone = taken.get(projectId);
  if (!gone?.length) return false;
  return words.some((w) => !!w && gone.some((g) => wordsOverlap(g, w)));
}

/** Was this message's request taken off this project? comms reads it before writing the message's brief line again. */
export async function messageTakenOff(clientId: string, projectId: string, message: string): Promise<boolean> {
  if (!clientId || !projectId || !message?.trim()) return false;
  const row = await prisma.clientAsk.findUnique({ where: { dedupeKey: messageAskKey(clientId, projectId, "SPECIAL_REQUEST", message) }, select: { projectId: true, state: true, historyJson: true } });
  if (row && takenOffProject(parseHistory(row.historyJson), projectId, { projectId: row.projectId, state: row.state })) return true;
  return repeatsTakenOff(await takenOffWords(clientId), projectId, [clip(message, 280)]);
}

// ---- reading: what the screens draw ----------------------------------------------------------

/** A request taken off a project, as that project shows it: what, what happened, and Undo while it still applies. */
export type TakenOffView = { askId: string; summary: string; line: string; canUndo: boolean };
/** A request kept for the client's next project. */
export type SavedRequestView = { askId: string; summary: string; text: string; askedBy: string | null; from: string; askedWords: string; keptLine: string; keptAtISO: string };

const summaryOf = (a: { summary: string | null; text: string }) => a.summary?.trim() || clip(a.text.replace(/\s+/g, " "), 140);

/** The requests taken off this project in the last `days` (newest first). */
export async function takenOffProjectList(projectId: string, opts: { days?: number; now?: Date } = {}): Promise<TakenOffView[]> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true } });
  if (!p) return [];
  const since = new Date((opts.now ?? new Date()).getTime() - (opts.days ?? 7) * DAY);
  const [rows, seesMoney] = await Promise.all([
    prisma.clientAsk.findMany({
      where: { clientId: { in: await familyOf(p.clientId) }, updatedAt: { gte: since }, historyJson: { contains: `"from":{"projectId":"${projectId}"` } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { id: true, projectId: true, state: true, summary: true, text: true, historyJson: true },
    }),
    viewerSeesMoney(),
  ]);
  const out: TakenOffView[] = [];
  for (const r of rows) {
    const h = parseHistory(r.historyJson);
    const spot = { projectId: r.projectId, state: r.state };
    const rec = takenOffProject(h, projectId, spot);
    if (!rec) continue;
    const entry = h.find((x) => x.placed?.id === rec.id);
    const top = undoable(h, spot);
    out.push({
      askId: r.id,
      summary: seesMoney ? summaryOf(r) : scrubMoney(summaryOf(r)),
      line: takenOffLine(rec, entry?.by ?? "someone", entry?.at ? etDateTime(entry.at) : ""),
      canUndo: top?.record.id === rec.id,
    });
  }
  return out;
}

async function savedRows(where: Prisma.ClientAskWhereInput) {
  return prisma.clientAsk.findMany({
    where: { kind: "SPECIAL_REQUEST", state: FUTURE_STATE, ...where },
    orderBy: { askedAt: "asc" },
    take: 60,
    select: { id: true, clientId: true, summary: true, text: true, askedBy: true, askedAt: true, source: true, historyJson: true },
  });
}

/** Open requests the brain filed on no project (several jobs in flight): the client page is where a job is picked. */
async function looseRows(where: Prisma.ClientAskWhereInput) {
  return prisma.clientAsk.findMany({
    where: { kind: "SPECIAL_REQUEST", state: "OPEN", projectId: null, source: { in: [...ASK_SOURCES] }, ...where },
    orderBy: { askedAt: "asc" },
    take: 60,
    select: { id: true, clientId: true, summary: true, text: true, askedBy: true, askedAt: true, source: true, historyJson: true },
  });
}

function savedView(r: Awaited<ReturnType<typeof savedRows>>[number], seesMoney: boolean): SavedRequestView {
  const kept = livePlacements(parseHistory(r.historyJson)).find((x) => x.record.kind === "future");
  const m = (s: string) => (seesMoney ? s : scrubMoney(s));
  return {
    askId: r.id,
    summary: m(summaryOf(r)),
    text: m(r.text),
    askedBy: r.askedBy,
    from: sourceWords(r.source),
    askedWords: etDateTime(r.askedAt),
    keptLine: kept ? `Kept from ${kept.record.fromStreet ?? "an earlier project"} by ${kept.entry.by}, ${etMonthDay(kept.entry.at)}` : "Kept for a future project",
    keptAtISO: kept?.entry.at ?? r.askedAt.toISOString(),
  };
}

/** A client's requests waiting for a project, for the client page: kept for their next one, and filed on none. */
export async function savedRequestsForClient(clientId: string): Promise<{ saved: SavedRequestView[]; loose: SavedRequestView[]; choices: MoveChoice[] }> {
  const family = await familyOf(clientId);
  const [rows, loose, seesMoney, choices] = await Promise.all([savedRows({ clientId: { in: family } }), looseRows({ clientId: { in: family } }), viewerSeesMoney(), openProjectsOf(family, null)]);
  return {
    saved: rows.map((r) => savedView(r, seesMoney)),
    loose: loose.map((r) => ({ ...savedView(r, seesMoney), keptLine: "On no project yet: pick the one it is for" })),
    choices,
  };
}

/**
 * The saved requests each of these projects is offered: its client's requests
 * kept for a future project BEFORE the project was booked (created). Open
 * projects only. Every id asked for is in the map (empty when none).
 */
export async function savedOffersFor(projects: { id: string; clientId: string; createdAt: Date; open: boolean }[]): Promise<Map<string, SavedRequestView[]>> {
  const out = new Map<string, SavedRequestView[]>(projects.map((p) => [p.id, []]));
  const open = projects.filter((p) => p.open);
  if (!open.length) return out;
  const rows = await savedRows({ clientId: { in: [...new Set(open.map((p) => p.clientId))] } });
  if (!rows.length) return out;
  const seesMoney = await viewerSeesMoney();
  const views = rows.map((r) => ({ clientId: r.clientId, v: savedView(r, seesMoney) }));
  for (const p of open) {
    out.set(p.id, views.filter((x) => x.clientId === p.clientId && Date.parse(x.v.keptAtISO) <= p.createdAt.getTime()).map((x) => x.v));
  }
  return out;
}

/** savedOffersFor by project id (the Projects list): nothing read beyond one probe when no request is kept for later. */
export async function savedOffersForProjectIds(projectIds: string[]): Promise<Map<string, SavedRequestView[]>> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  const any = ids.length ? await prisma.clientAsk.findFirst({ where: { kind: "SPECIAL_REQUEST", state: FUTURE_STATE }, select: { id: true } }) : null;
  if (!any) return new Map(ids.map((id) => [id, []]));
  const ps = await prisma.project.findMany({ where: { id: { in: ids } }, select: { id: true, clientId: true, createdAt: true, status: true, deliveredAt: true } });
  return savedOffersFor(ps.map((p) => ({ id: p.id, clientId: p.clientId, createdAt: p.createdAt, open: jobInFlight(p) })));
}

/** The project page's part: where its requests can go, what was taken off it, and the saved requests it is offered. */
export async function placementForProject(projectId: string): Promise<{ choices: MoveChoice[]; takenOff: TakenOffView[]; offers: SavedRequestView[]; clientName: string | null; street: string } | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, title: true, clientId: true, createdAt: true, status: true, deliveredAt: true, client: { select: { name: true } } } });
  if (!p) return null;
  const family = await familyOf(p.clientId);
  const [choices, takenOff, offers] = await Promise.all([
    openProjectsOf(family, p.id),
    takenOffProjectList(p.id),
    savedOffersFor([{ id: p.id, clientId: p.clientId, createdAt: p.createdAt, open: jobInFlight(p) }]),
  ]);
  return { choices, takenOff, offers: offers.get(p.id) ?? [], clientName: p.client?.name ?? null, street: streetOf(p.title) ?? "this project" };
}

// ---- the Projects list's Requests tab (Kyle, Oct 28 2026) ------------------------------------

/** One open request as the Projects list shows it under its project. */
export type RequestCardView = {
  id: string;
  summary: string;
  text: string;
  /** "Ashley Brunner by text, Wed, Oct 28, 10:08 AM" */
  fromLine: string;
  /** "John · video editing", "Kyle · photo editing and John · video editing", "Needs an owner" */
  forLine: string;
  needsOwner: boolean;
};

/** The job's video editor by name: the open edit card's, else the newest edit card's, else the Team panel's (as lib/jobChecks reads it). */
async function editorNameOf(tasks: { assignedKey: string | null; status: string }[], teamEditor: string | null): Promise<string | null> {
  const open = tasks.find((t) => t.assignedKey && t.status !== "COMPLETED" && t.status !== "CANCELLED");
  const key = (open ?? tasks.find((t) => t.assignedKey))?.assignedKey ?? null;
  if (!key) return teamEditor;
  const { editorMeta } = await import("@/lib/editors");
  return editorMeta(key)?.name ?? (/^[a-z_]+$/.test(key) ? key.replace(/_/g, " ").replace(/^[a-z]/, (c) => c.toUpperCase()) : key);
}

const SOURCE_SAID: Record<string, string> = { text: "by text", email: "by email", call: "on a call", staff: "typed by staff" };

/** Each project's open client requests, each with who it is for and where it came from (two reads for the lot). */
export async function openRequestCards(projectIds: string[], now: Date = new Date()): Promise<Map<string, RequestCardView[]>> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  const out = new Map<string, RequestCardView[]>(ids.map((id) => [id, []]));
  if (!ids.length) return out;
  const [asks, projects, seesMoney] = await Promise.all([
    prisma.clientAsk.findMany({
      where: { projectId: { in: ids }, state: "OPEN", kind: "SPECIAL_REQUEST", source: { in: [...ASK_SOURCES] } },
      orderBy: { askedAt: "asc" },
      select: { id: true, projectId: true, kind: true, summary: true, text: true, askedBy: true, askedAt: true, medium: true, source: true },
    }),
    prisma.project.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, status: true, deliveredAt: true, shootDate: true,
        photographer: { select: { name: true } }, editor: { select: { name: true } },
        appointments: { orderBy: { startAt: "asc" }, select: { startAt: true, endAt: true, durationMin: true, assignedTo: { select: { name: true } } } },
        smartTasks: { where: { taskType: "edit_video" }, orderBy: { createdAt: "desc" }, take: 10, select: { assignedKey: true, status: true } },
      },
    }),
    viewerSeesMoney(),
  ]);
  const owners = new Map<string, { shootOver: boolean; creative: string | null; editor: string | null }>();
  for (const p of projects) {
    const last = [...p.appointments].reverse().find((a) => a.startAt);
    const endAt = last?.endAt ?? (last?.startAt && last.durationMin ? new Date(last.startAt.getTime() + last.durationMin * 60_000) : null);
    owners.set(p.id, {
      shootOver: shootIsOver({ status: p.status, shootDate: p.shootDate ?? last?.startAt ?? null, endAt }, now),
      creative: p.appointments.find((a) => a.assignedTo?.name)?.assignedTo?.name ?? p.photographer?.name ?? null,
      editor: await editorNameOf(p.smartTasks, p.editor?.name ?? null),
    });
  }
  const pById = new Map(projects.map((p) => [p.id, p]));
  const m = (s: string) => (seesMoney ? s : scrubMoney(s));
  for (const a of asks) {
    if (!a.projectId || closesOnDelivery(a, pById.get(a.projectId) ?? null)) continue;
    const ctx = owners.get(a.projectId) ?? { shootOver: false, creative: null, editor: null };
    const med = asMedium(a.medium);
    const labels = med === "both" && ctx.shootOver
      ? [requestOwner(a, { ...ctx, card: "photo" }), requestOwner(a, { ...ctx, card: "video" })]
      : [requestOwner(a, { ...ctx, card: med === "video" ? "video" : med === "photo" ? "photo" : null })];
    out.get(a.projectId)?.push({
      id: a.id,
      summary: m(summaryOf(a)),
      text: m(a.text),
      fromLine: `${a.askedBy ?? (a.source === "staff" ? "The office" : "The client")} ${SOURCE_SAID[a.source] ?? `from ${sourceWords(a.source).toLowerCase()}`}, ${etDateTime(a.askedAt)}`,
      forLine: [...new Set(labels.map((l) => l.label))].join(" and "),
      needsOwner: labels.some((l) => l.needsOwner),
    });
  }
  return out;
}
