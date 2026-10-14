import "server-only";
import { prisma } from "@/lib/prisma";
import { askMedium } from "@/lib/comms";

// ---------------------------------------------------------------------------
// SLACK ASKS CLOSE THEMSELVES ON EVIDENCE (Oct 14 2026 comms audit).
//
// Slack messages become task cards (slackSync.maybeCreateSlackTask). In 120
// days 40% of them were cancelled by the 7-day timer, 66% had nobody's name on
// them and the median one took 92 hours to close, while Jordan asked "did it
// go out?" about four times a week. Most of those asks were DONE: the job was
// delivered, Kyle texted the client, the editor uploaded the cut. Nothing on
// the card heard about it.
//
// HOURLY (cron/sync), every open Slack ask is read for what it asks and what
// would prove it done, and closed only when that proof is on record AFTER the
// ask was made:
//   deliver   "send / deliver / did it go out"   the job delivered, or a cut
//                                                marked sent to the client
//   message   "tell / text / call / let them know" a message to that client
//   edit      a video edit ("re-edit the reel")   a new cut uploaded on the job
//   upload    "upload it to Aryeo"               a delivery recorded on the job
// Every intent an ask carries needs its own proof. CONSERVATIVE: no intent
// found, no job or client linked, a card that rolled several asks together,
// a message ask that names a teammate, a photo edit (no reliable proof), a
// card a person assigned or flagged by hand: all left open. The closed row
// says which evidence closed it (summary, and ` · evidence:<kinds>` appended
// to sourceDetail, which taskSource.ts still parses for the channel).
//
// And Jordan's own asks to Kyle are no longer cancelled by the 7-day timer
// (tasks.expireStaleSlackTasks skips them): after day 3 they ride on Jordan's
// 6 PM wrap, and Kyle's morning digest lists them with their ages.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const LOOKBACK_DAYS = 30;

const DELIVER_RE =
  /\b(deliver(?:ed|y|ing)?|release (?:it|them|the)|go(?:ne)? out|went out|get (?:it|them|that|this) out|send\b[^.?!]{0,30}\b(?:photos?|pics|video|reel|gallery|files?|link|cut|edits?))\b/i;
// Money and paperwork: "send them the invoice" is not a delivery, and a
// delivered job is no proof an invoice or refund went anywhere.
const NOT_MEDIA_RE = /\b(invoice|payment|paid|bill(?:ing)?|receipt|quote|contract|refund|credit|discount|w-?9|agreement)\b/i;
const MESSAGE_RE =
  /\b(tell (?:him|her|them|the client|the agent)|let (?:him|her|them|the client|the agent) know|reach out to (?:him|her|them|the client|the agent)|(?:text|call|email) (?:him|her|them|the client|the agent|back)|reply to (?:him|her|them|the client|the agent)|respond to (?:him|her|them|the client|the agent)|follow up with (?:him|her|them|the client|the agent)|get back to (?:him|her|them|the client|the agent)|update (?:him|her|them|the client|the agent))\b/i;
const EDIT_RE = /\b(re-?edit|edit(?:s|ing)?|re-?cut|recut|redo|re-?do|new version|revis(?:e|ion|ions)|fix(?:es)?)\b/i;
const UPLOAD_RE = /\b(upload\w*|put (?:it|them) (?:up|on)|add (?:it|them) to)\b[^.?!]{0,40}\b(aryeo|listing)\b/i;

export type AskIntent = "deliver" | "message" | "edit" | "upload";

/** What an ask asks for, from its own words. Pure. Empty = ambiguous. */
export function askIntents(text: string): AskIntent[] {
  const t = (text ?? "").replace(/[‘’]/g, "'");
  const out: AskIntent[] = [];
  if (UPLOAD_RE.test(t)) out.push("upload");
  if (DELIVER_RE.test(t) && !out.includes("upload")) out.push("deliver");
  if (MESSAGE_RE.test(t)) out.push("message");
  if (EDIT_RE.test(t)) out.push("edit");
  return out;
}

type Parties = {
  ownerIds: Set<string>;
  kyle: { id: string; key: string } | null;
  /** roster entry for a sender name (same alias rule as the addressee reader) */
  find: (name: string | null | undefined) => { key: string; teamMemberId: string | null } | null;
  /** names of everyone on the roster, as one alternation, for "names a teammate" */
  alt: string;
};

async function parties(): Promise<Parties> {
  const [{ ownerTeamMemberIds }, { kyleDesk }, { loadSlackRoster, rosterLookup }] = await Promise.all([
    import("@/lib/smsPrefs"),
    import("@/lib/kyleNotice"),
    import("@/lib/integrations/slackSync"),
  ]);
  const [ownerIds, kyle, roster] = await Promise.all([ownerTeamMemberIds().catch(() => []), kyleDesk(), loadSlackRoster().catch(() => [])]);
  const { find, alt } = rosterLookup(roster);
  return { ownerIds: new Set(ownerIds), kyle: kyle ? { id: kyle.id, key: kyle.key } : null, find, alt };
}

type AskRow = { id: string; contactName: string | null; ownerId: string | null; assignedKey: string | null };
const fromOwner = (p: Parties, t: AskRow) => {
  const who = p.find(t.contactName);
  return !!who?.teamMemberId && p.ownerIds.has(who.teamMemberId);
};
const fromKyle = (p: Parties, t: AskRow) => !!p.kyle && p.find(t.contactName)?.teamMemberId === p.kyle.id;
const toKyle = (p: Parties, t: AskRow) => !!p.kyle && (t.ownerId === p.kyle.id || t.assignedKey === p.kyle.key);
const toOwner = (p: Parties, t: AskRow) => (!!t.ownerId && p.ownerIds.has(t.ownerId));

const OPEN_SLACK = { taskType: "internal_instruction", source: "slack", status: { notIn: ["COMPLETED", "CANCELLED"] } };

export type OpenAsk = { id: string; title: string; createdAt: Date; ageDays: number; propertyAddress: string | null };

/** Jordan's open Slack asks to Kyle, oldest first. `minAgeDays` keeps the older ones only. */
export async function jordansOpenAsksToKyle(opts: { now?: Date; minAgeDays?: number } = {}): Promise<OpenAsk[]> {
  const now = opts.now ?? new Date();
  const p = await parties();
  if (!p.kyle || p.ownerIds.size === 0) return [];
  const rows = await prisma.smartTask.findMany({
    where: { ...OPEN_SLACK, ...(opts.minAgeDays ? { createdAt: { lte: new Date(now.getTime() - opts.minAgeDays * DAY) } } : {}) },
    select: { id: true, title: true, createdAt: true, contactName: true, ownerId: true, assignedKey: true, propertyAddress: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return rows
    .filter((t) => fromOwner(p, t) && toKyle(p, t))
    .map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, ageDays: Math.floor((now.getTime() - t.createdAt.getTime()) / DAY), propertyAddress: t.propertyAddress }));
}

/** The ids the 7-day timer must leave alone (Jordan's asks to Kyle). */
export async function protectedSlackAskIds(): Promise<string[]> {
  return (await jordansOpenAsksToKyle().catch(() => [])).map((a) => a.id);
}

/** Kyle's open Slack asks to Jordan, oldest first. */
export async function kylesOpenAsksToJordan(opts: { now?: Date } = {}): Promise<OpenAsk[]> {
  const now = opts.now ?? new Date();
  const p = await parties();
  if (!p.kyle || p.ownerIds.size === 0) return [];
  const rows = await prisma.smartTask.findMany({
    where: OPEN_SLACK,
    select: { id: true, title: true, createdAt: true, contactName: true, ownerId: true, assignedKey: true, propertyAddress: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return rows
    .filter((t) => fromKyle(p, t) && toOwner(p, t))
    .map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, ageDays: Math.floor((now.getTime() - t.createdAt.getTime()) / DAY), propertyAddress: t.propertyAddress }));
}

export type EvidenceClose = { taskId: string; evidence: string[] };
export type EvidenceSweep = { checked: number; closed: EvidenceClose[]; leftOpen: { ambiguous: number; noEvidence: number } };

/** Hourly (cron/sync). Closes only what the record proves. */
export async function closeSlackAsksOnEvidence(now: Date = new Date()): Promise<EvidenceSweep> {
  const asks = await prisma.smartTask.findMany({
    where: { ...OPEN_SLACK, createdAt: { gte: new Date(now.getTime() - LOOKBACK_DAYS * DAY) }, assignedManually: false, flaggedAt: null },
    select: { id: true, title: true, description: true, summary: true, createdAt: true, projectId: true, clientId: true, sourceDetail: true, contactName: true, ownerId: true, assignedKey: true },
    take: 300,
  });
  const p = asks.length ? await parties() : null;
  const teammateRe = p?.alt ? new RegExp(`(^|[^\\w@])@?(${p.alt})(?![\\w'])`, "i") : null;
  const closed: EvidenceClose[] = [];
  let ambiguous = 0, noEvidence = 0;
  for (const t of asks) {
    // Several asks rolled onto one card (slackSync's 24h consolidation): one
    // piece of proof cannot speak for all of them.
    if (/\(\+\d+ more\)$/.test(t.title)) { ambiguous++; continue; }
    const words = `${t.title}\n${t.description ?? ""}`;
    const intents = askIntents(words);
    if (intents.length === 0) { ambiguous++; continue; }
    if (NOT_MEDIA_RE.test(words)) { ambiguous++; continue; }
    if ((intents.includes("deliver") || intents.includes("edit") || intents.includes("upload")) && !t.projectId) { ambiguous++; continue; }
    if (intents.includes("message")) {
      if (!t.clientId) { ambiguous++; continue; }
      // "Let Harrison know" is a message to a teammate, not to the client.
      const named = teammateRe ? words.match(teammateRe)?.[2] : null;
      if (named && p) {
        const who = p.find(named);
        const sender = p.find(t.contactName);
        if (who && who.key !== sender?.key && who.teamMemberId !== t.ownerId) { ambiguous++; continue; }
      }
    }
    if (intents.includes("edit") && askMedium(words) !== "video") { ambiguous++; continue; }

    const since = t.createdAt;
    const proof: string[] = [];
    let missing = false;
    for (const intent of intents) {
      let found: string | null = null;
      if (intent === "deliver" || intent === "upload") {
        const [proj, sent, outs] = await Promise.all([
          prisma.project.findUnique({ where: { id: t.projectId! }, select: { status: true, deliveredAt: true } }),
          prisma.reviewSubmission.findFirst({ where: { projectId: t.projectId!, sentToClientAt: { gt: since } }, select: { sentToClientAt: true } }),
          intent === "upload"
            ? prisma.deliverableOutput.findFirst({ where: { projectId: t.projectId!, deliveredAt: { gt: since } }, select: { deliveredAt: true, deliveredVia: true } })
            : Promise.resolve(null),
        ]);
        if (proj?.status === "DELIVERED" && proj.deliveredAt && proj.deliveredAt > since) found = `${intent === "upload" ? "upload" : "delivered"}: the job was delivered ${proj.deliveredAt.toISOString()}`;
        else if (outs?.deliveredAt) found = `upload: a video was recorded delivered${outs.deliveredVia ? ` (${outs.deliveredVia})` : ""} ${outs.deliveredAt.toISOString()}`;
        else if (intent === "deliver" && sent?.sentToClientAt) found = `delivered: a cut was marked sent to the client ${sent.sentToClientAt.toISOString()}`;
      } else if (intent === "message") {
        const out = await prisma.commLog.findFirst({
          where: { clientId: t.clientId!, direction: "out", channel: { in: ["text", "email", "call"] }, occurredAt: { gt: since } },
          orderBy: { occurredAt: "asc" },
          select: { channel: true, occurredAt: true },
        });
        if (out) found = `message: a ${out.channel} went to the client ${out.occurredAt.toISOString()}`;
      } else if (intent === "edit") {
        const cut = await prisma.reviewSubmission.findFirst({
          where: { projectId: t.projectId!, createdAt: { gt: since }, status: { notIn: ["UPLOADING", "UPLOAD_FAILED", "WITHDRAWN"] } },
          orderBy: { createdAt: "asc" },
          select: { round: true, createdAt: true },
        });
        if (cut) found = `edit: cut v${cut.round} was uploaded ${cut.createdAt.toISOString()}`;
      }
      if (!found) { missing = true; break; }
      proof.push(found);
    }
    if (missing) { noEvidence++; continue; }
    const kinds = [...new Set(intents)].join("+");
    const r = await prisma.smartTask.updateMany({
      // Compare-and-set: a person closing it this second keeps their close.
      where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: {
        status: "COMPLETED",
        completedAt: now,
        summary: `Closed on evidence: ${proof.join("; ")}.${t.summary ? `\n${t.summary}` : ""}`.slice(0, 500),
        sourceDetail: `${t.sourceDetail ?? ""}${t.sourceDetail ? " · " : ""}evidence:${kinds}`.slice(0, 190),
      },
    });
    if (r.count > 0) closed.push({ taskId: t.id, evidence: proof });
  }
  return { checked: asks.length, closed, leftOpen: { ambiguous, noEvidence } };
}
