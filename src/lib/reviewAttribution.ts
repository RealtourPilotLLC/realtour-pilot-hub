// ---------------------------------------------------------------------------
// WHO SAID IT, AND WHEN (Jordan, Sep 28 2026: "I'd like to make sure that in
// the review room, we know who left the review comments and requested the
// revision.").
//
// The author was almost always STORED — MediaNote.authorName, ReviewSubmission.
// decidedBy, ClientDecision.actorLabel — but most screens did not SHOW it, and
// one named the wrong person: a client's send-back on a cut the office had
// approved kept the office's decidedBy/decidedAt, so the editor's page read
// "sent back <the approval's time> by <the office approver>".
//
// This file is the one vocabulary for all of it, and it is PURE on purpose:
// the Review Room panel, the editor's brief card and the tracker are client
// components, and the same words have to come out of the server pages and the
// drill. Every line is the person (a display name — never an email when a
// roster or client name is known; "on behalf of" when staff acted for a
// client) and the moment, in ET.
// ---------------------------------------------------------------------------
import { etDateTime } from "@/lib/datetime";

/** The one name a write gets when nobody is signed in — local dev with auth
 *  off. Production never reaches it: every write there is behind a guard. */
export const LOCAL_DEV_AUTHOR = "Local dev";

/** "View as" is read-only everywhere, including local dev with auth off. */
export const PREVIEW_REFUSED = "You're previewing another user — exit the preview to make changes.";

/** reviewCuts.DELIVERED_STAMP, repeated here because that module is server
 *  only. It marks a cut the hub approved by itself when the job was delivered —
 *  a system verdict, not a person's. The drill asserts the two agree. */
export const DELIVERED_VERDICT = "Delivered to the client";

// ---- who asked for a revision (RevisionBrief.requestedBy*) -----------------

/** CLIENT = the client or their own teammate on the portal · CLIENT_STAFF =
 *  our staff on the client's behalf · OFFICE = a person here put the work back
 *  · EMAIL / TEXT / PHONE = the client over that channel · SYSTEM = the hub. */
export type RequesterKind = "CLIENT" | "CLIENT_STAFF" | "OFFICE" | "EMAIL" | "TEXT" | "PHONE" | "SYSTEM";
export const REQUESTER_KINDS: readonly RequesterKind[] = ["CLIENT", "CLIENT_STAFF", "OFFICE", "EMAIL", "TEXT", "PHONE", "SYSTEM"];
export const isRequesterKind = (k: unknown): k is RequesterKind => typeof k === "string" && (REQUESTER_KINDS as readonly string[]).includes(k);

export type Requester = { name: string | null; kind: RequesterKind; userId?: string | null };

/** The ET moment every attribution line prints ("Mon, Sep 28, 2:14 PM"). */
export const whenET = (at: Date | string | null | undefined): string => (at ? etDateTime(at) : "");

/** "Kyle Cabrera · Mon, Sep 28, 2:14 PM" — either half alone when that is all there is. */
export function byLine(name: string | null | undefined, at: Date | string | null | undefined): string {
  const who = (name ?? "").trim();
  const when = whenET(at);
  return [who, when].filter(Boolean).join(" · ");
}

/** Same person? Case and spacing are not a different person. */
export const sameName = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * How a revision's asker reads on a brief, a banner or a queue row. The name
 * is already the full attribution for the portal kinds — actorLabel writes
 * "Jordan Spackman (on behalf of Sarah Smith)" for staff — so this only adds
 * the channel for the others. Null when nobody was recorded (a brief from
 * before Sep 28): the caller keeps the words it printed before.
 */
export function requesterWords(kind: string | null | undefined, name: string | null | undefined): string | null {
  const who = (name ?? "").trim();
  if (kind === "SYSTEM") return "the hub, automatically";
  if (!who) return null;
  switch (kind) {
    case "EMAIL": return `${who}, by email`;
    case "TEXT": return `${who}, by text`;
    case "PHONE": return `${who}, on a call`;
    case "OFFICE": return `${who} (the office)`;
    default: return who; // CLIENT, CLIENT_STAFF, and a kind this file doesn't know yet
  }
}

/** "Asked by Olivia Chen, by email · Mon, Sep 28, 2:14 PM" — or "Put back by
 *  Kyle Cabrera (the office) · …" for work the office reopened. */
export function requesterLine(r: { requestedBy?: string | null; requestedByKind?: string | null; at?: Date | string | null }): string | null {
  const words = requesterWords(r.requestedByKind, r.requestedBy);
  if (!words) return null;
  const verb = r.requestedByKind === "OFFICE" || r.requestedByKind === "SYSTEM" ? "Put back by" : "Asked by";
  const when = whenET(r.at);
  return `${verb} ${words}${when ? ` · ${when}` : ""}`;
}

/** "Olivia Chen asked for changes by email" — the sentence form, for a line
 *  that reads "<who> asked for changes" (the project page's status card, which
 *  adds " after delivery"). Null when nobody was recorded, and for the hub's
 *  own reopen rows (SYSTEM): nobody asked. */
export function askedForChangesWords(kind: string | null | undefined, name: string | null | undefined, source?: string | null): string | null {
  const who = (name ?? "").trim();
  if (kind === "SYSTEM" || !who) return null;
  if (source === "review_room_staff" && kind === "CLIENT_STAFF") return `${who} recorded the client's changes in the Review Room`;
  switch (kind) {
    case "EMAIL": return `${who} asked for changes by email`;
    case "TEXT": return `${who} asked for changes by text`;
    case "PHONE": return `${who} asked for changes on a call`;
    case "OFFICE": return `${who} put the work back`;
    case "CLIENT":
    case "CLIENT_STAFF": return `${who} asked for changes on the portal`;
    default: return `${who} asked for changes`;
  }
}

// ---- the office's own reopen (the Editing Room's "New cut" queue-add) -------

/** The queue-add's reasonCreated. addToEditorQueue writes it and officeReopenOf
 *  reads it back: one sentence in one place, so the two cannot drift. */
export const officeQueueReason = (name: string | null | undefined): string =>
  `${name?.trim() || "The office"} added a finished job back to the Editing Room`;

/**
 * Is this open revision the OFFICE's reopen, and who pressed it? The queue-add
 * is the only writer of a source-"manual" revision titled "New cut". A client's
 * later ask reuses the same row and rewrites its source, title and reason, so
 * the office's name leaves with it (review, Sep 28 — the queue-add used to put
 * its presser in flaggedBy, which Kyle's and the editor's home banner read as
 * "Flagged for immediate review", and which stayed on the row over the
 * client's ask two weeks later). `by` is null on a reopen from before names
 * were written ("Owner added…"): the office, nobody named.
 */
export function officeReopenOf(t: { source?: string | null; title?: string | null; reasonCreated?: string | null } | null | undefined): { by: string | null } | null {
  if (!t || t.source !== "manual" || !(t.title ?? "").startsWith("New cut")) return null;
  const m = /^(.+?) added a finished job back to the Editing Room$/.exec((t.reasonCreated ?? "").trim());
  const who = m?.[1]?.trim() || null;
  return { by: who && who !== "The office" && who !== "Owner" ? who : null };
}

/** "Put back by Kyle Cabrera (the office)" — "Put back by the office" when
 *  nobody was named. No time unless the caller has the real one. */
export function officeReopenLine(r: { by: string | null }, at?: Date | string | null): string {
  return requesterLine({ requestedBy: r.by, requestedByKind: "OFFICE", at }) ?? `Put back by the office${at ? ` · ${whenET(at)}` : ""}`;
}

// ---- who ruled on a cut (ReviewSubmission) --------------------------------

export type Verdict = {
  kind: "approved" | "sent_back";
  /** office = a person at the review desk · client = the client's portal
   *  request (clientRequestedBy) · delivered = the hub's own stamp. */
  source: "office" | "client" | "delivered";
  by: string | null;
  atISO: string | null;
};

type VerdictRow = {
  status: string;
  decidedAt: Date | string | null;
  decidedBy: string | null;
  clientRequestedAt?: Date | string | null;
  clientRequestedBy?: string | null;
};

const iso = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const x = typeof d === "string" ? new Date(d) : d;
  return isNaN(x.getTime()) ? null : x.toISOString();
};

/**
 * Whose verdict a round is carrying, and when. THE GAP-1 RULE: a client's
 * send-back (clientDecisions.requestChangesOnCut) flips an APPROVED round to
 * CHANGES_REQUESTED and stamps clientRequestedAt/By, while decidedAt/By stay
 * the office's approval — deliberately, it is the office's QC record. So a
 * CHANGES_REQUESTED round whose client stamp is at or after the office's
 * verdict was sent back by the CLIENT, at the client's time. Reading
 * decidedBy alone credited the office approver with the client's ask.
 * PENDING / SUPERSEDED / WITHDRAWN rounds carry no verdict of their own.
 */
export function verdictOf(s: VerdictRow): Verdict | null {
  const decided = iso(s.decidedAt);
  const client = iso(s.clientRequestedAt ?? null);
  if (s.status === "CHANGES_REQUESTED") {
    if (client && (!decided || client >= decided)) {
      return { kind: "sent_back", source: "client", by: s.clientRequestedBy?.trim() || null, atISO: client };
    }
    return { kind: "sent_back", source: "office", by: s.decidedBy?.trim() || null, atISO: decided };
  }
  if (s.status === "APPROVED") {
    if (s.decidedBy === DELIVERED_VERDICT) return { kind: "approved", source: "delivered", by: null, atISO: decided };
    return { kind: "approved", source: "office", by: s.decidedBy?.trim() || null, atISO: decided };
  }
  return null;
}

/** The one sentence for a verdict, wherever it is shown to staff. */
export function verdictLine(v: Verdict | null | undefined): string | null {
  if (!v) return null;
  const when = whenET(v.atISO);
  const tail = (s: string) => (when ? `${s} · ${when}` : s);
  if (v.source === "delivered") return tail("Marked approved when the job was delivered");
  if (v.source === "client") return tail(v.by ? `Client changes by ${v.by}` : "The client asked for changes");
  if (v.kind === "approved") return tail(v.by ? `Approved by ${v.by}` : "Approved");
  return tail(v.by ? `Sent back by ${v.by}` : "Sent back");
}

/** The first name, for a pill with no room for the whole line. "Jordan
 *  Spackman (on behalf of Sarah Smith)" → "Jordan". */
export const firstName = (name: string | null | undefined): string | null => (name ?? "").trim().split(/[\s(]+/)[0] || null;

// ---- who changed a note's status (MediaNote.statusBy/statusAt) ------------

const STATUS_WORDS: Record<string, string> = { OPEN: "Reopened", FIXED: "Marked fixed", RESOLVED: "Resolved" };

/** "Resolved by James Rivera · Mon, Sep 28, 2:14 PM" — null when the note has
 *  never been moved by anyone (or was moved before Sep 28, when nobody was
 *  recorded). An OPEN note that was never touched has nothing to say. */
export function statusLine(n: { status: string; statusBy?: string | null; statusAt?: Date | string | null }): string | null {
  if (!n.statusBy) return null;
  const verb = STATUS_WORDS[n.status] ?? "Updated";
  return `${verb} by ${n.statusBy}${n.statusAt ? ` · ${whenET(n.statusAt)}` : ""}`;
}

// ---- the project page's "who asked" line (StatusEvidenceCard) -------------

/**
 * Who raised the outstanding revision, as "<who> asked for changes …" — or
 * null when nothing near the stamp says (the card then reads "Changes
 * requested"). Matched to THIS ask: a row within two hours of `askedAt`,
 * newest first, and nothing without a stamp to match against.
 *
 * BY THE REVIEW ROOM'S RULES (review, Sep 28). The card read only decidedBy
 * and the brief's source: a client's portal send-back read "Changes requested
 * in the hub", a Review Room bounce on a reopened job lost to the office's
 * clock row written milliseconds after it, and an assistant's email printed
 * the agent. Now a bounce is read through verdictOf (gap 1: a client's
 * send-back on an approved cut is the client's, at the client's time); a brief
 * names its requester (RevisionBrief.requestedBy*); and the office's reopen
 * rows come last — a SYSTEM row is never a hit, and a person's OFFICE row
 * speaks only when nothing else matched. A brief from before anyone was
 * recorded keeps the words it always had. Pure.
 */
export function revisionAskerLabel(o: {
  askedAt: Date | null;
  client: string | null;
  bounces: VerdictRow[];
  briefs: { source: string; createdAt: Date; requestedBy: string | null; requestedByKind: string | null }[];
}): string | null {
  const near = (at: Date | null | undefined) => !!at && !!o.askedAt && Math.abs(at.getTime() - o.askedAt.getTime()) < 2 * 3_600_000;
  type Hit = { at: Date; label: string };
  const hits: Hit[] = [];
  const officeHits: Hit[] = [];
  for (const b of o.bounces) {
    const v = verdictOf(b);
    const at = v?.atISO ? new Date(v.atISO) : null;
    if (!v || !at || !near(at)) continue;
    hits.push({
      at,
      label: v.source === "client" ? `${v.by || o.client || "The client"} asked for changes on the portal` : `${v.by || "The office"} asked for changes in the Review Room`,
    });
  }
  for (const b of o.briefs) {
    if (!near(b.createdAt)) continue;
    const named = askedForChangesWords(b.requestedByKind, b.requestedBy, b.source);
    if (b.source === "office") {
      if (named && b.requestedByKind === "OFFICE") officeHits.push({ at: b.createdAt, label: named });
      continue;
    }
    hits.push({
      at: b.createdAt,
      label: named ?? (b.source === "openphone" || b.source === "gmail" ? `${o.client || "The client"} asked for changes` : "Changes requested in the hub"),
    });
  }
  const newest = (xs: Hit[]) => [...xs].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
  return (newest(hits) ?? newest(officeHits))?.label ?? null;
}

// ---- a client's portal note, as the Review Room reads it --------------------

const CLIENT_NOTE_STATUS: Record<string, string> = { OPEN: "not sent yet", SENT: "sent to the editor", RESOLVED: "resolved" };

/**
 * The status words under a client's portal note in the Review Room. Keyed on
 * the RESOLVE STAMP, the way the portal keys it (review, Sep 28): a note
 * resolved after it was sent keeps status SENT (clientDecisions.
 * setCommentResolved), so testing `status === "RESOLVED"` read "sent to the
 * editor" with no resolver while the client's own page showed it struck
 * through — one row, two stories.
 */
export function clientNoteStatusWords(n: { status: string; resolvedBy?: string | null; resolvedAtISO?: string | null }): string {
  if (n.resolvedAtISO || n.resolvedBy) {
    const who = n.resolvedBy?.trim() ? ` by ${n.resolvedBy.trim()}` : "";
    const when = n.resolvedAtISO ? `, ${whenET(n.resolvedAtISO)}` : "";
    return `${n.status === "SENT" ? "sent to the editor · " : ""}resolved${who}${when}`;
  }
  return CLIENT_NOTE_STATUS[n.status] ?? n.status.toLowerCase();
}

// ---- a bundle of notes, each with its author --------------------------------

/**
 * A work order built from several people's notes names each author on their
 * own line — unless every line is the lead's, whose name is already on the
 * header. "Everything credited to whoever pressed Submit" was gap 9: a client
 * and their assistant both wrote on the video, one of them sent it, and the
 * editor's brief said it was all the sender's.
 */
export function attributeLines(lines: { text: string; author: string | null | undefined }[], lead: string | null | undefined): string[] {
  const allLead = lines.every((l) => !l.author || sameName(l.author, lead));
  return lines.map((l) => (allLead || !l.author ? l.text : `${l.text} — ${l.author.trim()}`));
}
