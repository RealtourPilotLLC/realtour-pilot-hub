import "server-only";
import { formatDistanceToNow } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { etDateTime } from "@/lib/datetime";
import { mailboxOfExternalId, NOT_CLIENT_LABEL, notClientEmailReason, notClientVerdicts } from "@/lib/replyQueue";

// ---------------------------------------------------------------------------
// Email tab data for the Communications hub.
//
// Client/lead email already syncs into CommLog (channel "email", source
// "gmail"): recent mail grouped into threads, with an "Open in Gmail" jump-out
// per thread. REPLY IN THE HUB (Jordan, Oct 27 2026: "I want to be able to
// respond to emails in the hub"): each thread also names the message a reply
// answers (`replyRef`, the newest email they sent us that the Gmail sync
// logged), and app/emailActions.sendEmailThreadReply sends into that Gmail
// thread when a person presses Send. Messages are newest first (emailOrder.ts).
// ---------------------------------------------------------------------------

export type EmailMessage = {
  id: string;
  direction: "in" | "out";
  sender: string; // who wrote it (contact/client name, or us)
  body: string;
  atLabel: string; // absolute ET timestamp (ET-everywhere date rule)
  atISO: string; // for the seven-day fold (emailOrder.ts)
  ago: string;
};

export type EmailThread = {
  key: string;
  counterpart: string; // the human/account on the other side
  isClient: boolean; // known client → gets the green chip, like the Inbox
  subject: string; // display subject (latest message's raw subject)
  gmailHref: string; // jump-out — Gmail is still where replies happen
  count: number;
  snippet: string; // latest message, one line
  lastAgo: string;
  lastDirection: "in" | "out";
  fresh: boolean; // latest is inbound within 48h — "probably needs eyes"
  messages: EmailMessage[]; // NEWEST first (Jordan, Oct 27 2026)
  /** The CommLog row a hub reply answers: the newest email from them that the
   *  Gmail sync logged with its mailbox and Gmail id. Null = answer in Gmail. */
  replyRef: string | null;
  /** The mailbox that email arrived in (the reply goes out from it). */
  replyMailbox: string | null;
  /** When they last wrote on this thread (null = only we did): unread is
   *  "newer than my read mark" (lib/messageReads, Oct 27 2026). */
  lastInboundISO: string | null;
  /** Set by the page from the viewer's read marks. */
  unread?: boolean;
};

/** An email Messages · Email keeps off the list (Oct 27 2026, "client
 *  communications only"), one line each, in a fold under the list. */
export type HiddenEmail = {
  id: string;
  from: string;
  subject: string;
  atLabel: string;
  /** why: a rule's label, or the AI check's */
  why: string;
  /** true when the AI check hid it (it can be shown again) */
  byAi: boolean;
};

/** `gmail-<mailbox>:<gmailMessageId>`, the inbound row's externalId the Gmail
 *  sync writes, as its two parts. Anything else (our own sends, a backfill)
 *  is not something a reply can be threaded onto. */
export function gmailMessageOfExternalId(externalId: string | null | undefined): { mailbox: string; messageId: string } | null {
  const m = /^gmail-([^:\s]+@[^:\s]+):([A-Za-z0-9_-]+)$/.exec(externalId ?? "");
  return m ? { mailbox: m[1].toLowerCase(), messageId: m[2] } : null;
}

// Same role tiers as every other CommLog reader (see hubTools.ts search_comms):
// a viewer only sees rows at or below their tier. ADMIN sees ADMIN+CREATIVE
// mail but NOT owner-only rows (unknown-sender leads on Jordan's personal
// inbox are logged minRole OWNER); OWNER sees everything.
const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };

/** The CommLog minRole values an app role may read (the reply actions hold a
 *  row to the same rule as this view). */
export function visibleEmailRoles(role: string): string[] {
  const tier = contentTier(role);
  return Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[tier]);
}

// "Re: Re: Fwd: 12 Main St" and "12 Main St" are the same conversation — strip
// any run of reply/forward prefixes (incl. "RE[2]:" counters some clients use)
// and compare case-insensitively.
const SUBJECT_PREFIX = /^\s*((re|fwd?|fw)\s*(\[\d+\])?\s*[:：]\s*)+/i;
export function normalizeSubject(s: string | null | undefined): string {
  const stripped = (s ?? "").replace(SUBJECT_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
  return stripped || "(no subject)";
}

// Gmail's API returns `snippet` HTML-entity encoded ("It&#39;s", "&lt;info@…&gt;")
// and many logged bodies ARE that snippet — decode the common entities so the
// UI doesn't show raw escapes. (React re-escapes on render, so this is safe.)
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1] === "x" || code[1] === "X";
      const num = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      // Guard: an out-of-range codepoint must not crash the whole page render.
      try { return Number.isFinite(num) ? String.fromCodePoint(num) : whole; } catch { return whole; }
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** Gmail search in a named mailbox; /u/0/ (the browser's first account) when
 *  we don't know which mailbox it was. */
export function gmailSearchHref(query: string, mailbox: string | null): string {
  const q = encodeURIComponent(query);
  return mailbox
    ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#search/${q}`
    : `https://mail.google.com/mail/u/0/#search/${q}`;
}

/** A logged email's thread on this view: its normalized subject and the
 *  person (the client record, else the name). The reply drafter reads a
 *  thread back by the same key (app/emailActions). */
export function emailThreadKey(r: { subject: string | null; clientId: string | null; clientName: string | null; contactName: string | null }): string {
  const who = r.clientId ?? (r.clientName ?? r.contactName ?? "").trim().toLowerCase();
  return `${normalizeSubject(r.subject)}::${who || "unknown"}`;
}

export const EMAIL_WINDOW_DAYS = 60;
const WINDOW_DAYS = EMAIL_WINDOW_DAYS;
const THREAD_CAP = 50;
const FRESH_MS = 48 * 3600_000;

/** How many hidden emails the fold lists (the count says how many in all). */
const HIDDEN_SHOWN = 60;

export async function getEmailThreads(opts: { excludeClientIds?: string[] } = {}): Promise<{ threads: EmailThread[]; fresh: number; hidden: HiddenEmail[]; hiddenTotal: number }> {
  // Sessionless local dev renders the full owner view — same convention as the
  // dashboard (src/app/page.tsx). contentTier folds app roles (EDITOR,
  // PHOTOGRAPHER, …) onto the CREATIVE/ADMIN/OWNER sensitivity ladder.
  const me = await getCurrentUser().catch(() => null);
  const allowed = visibleEmailRoles(me?.role ?? "OWNER");

  const excludedProjectIds = opts.excludeClientIds?.length
    ? (await prisma.project.findMany({ where: { clientId: { in: opts.excludeClientIds } }, select: { id: true } })).map((p) => p.id)
    : [];
  const rows = await prisma.commLog.findMany({
    where: {
      channel: "email",
      ...(opts.excludeClientIds?.length ? { AND: [
        { OR: [{ clientId: null }, { clientId: { notIn: opts.excludeClientIds } }] },
        ...(excludedProjectIds.length ? [{ OR: [{ projectId: null }, { projectId: { notIn: excludedProjectIds } }] }] : []),
      ] } : {}),
      occurredAt: { gte: new Date(Date.now() - WINDOW_DAYS * 86400_000) },
      minRole: { in: allowed },
    },
    orderBy: { occurredAt: "desc" },
    // Bound the pull — 60 days of agency mail sits comfortably under this, and
    // the thread cap below trims the display regardless.
    take: 800,
    select: {
      id: true,
      direction: true,
      clientId: true,
      clientName: true,
      contactName: true,
      subject: true,
      body: true,
      occurredAt: true,
      externalId: true,
    },
  });

  // CLIENT COMMUNICATIONS ONLY (Jordan, Oct 27 2026 Loom, 38:23: "it should
  // really just be communications with clients ... accepted a Google Meet
  // invitation ... Core9, your shipment is on the way ... Laura Hayes, top
  // tier capital program, we don't need that in here"). An email from them
  // shows only when it is from a saved client and is not what the rules
  // (replyQueue notClientEmailReason) or the AI check (lib/commsNotClient)
  // call something else; our own sends show on a client's thread. The rest
  // folds under the list with the reason, so nothing is lost from sight.
  const verdicts = await notClientVerdicts(rows.filter((r) => r.direction !== "out" && r.clientId).map((r) => r.id));
  const hiddenAll: HiddenEmail[] = [];
  const clientRows = rows.filter((r) => {
    if (r.direction === "out") return !!r.clientId;
    const rule = r.clientId ? notClientEmailReason(r) : null;
    const why = !r.clientId ? "Not from a saved client" : rule ? NOT_CLIENT_LABEL[rule] : verdicts.has(r.id) ? NOT_CLIENT_LABEL.ai : null;
    if (!why) return true;
    hiddenAll.push({
      id: r.id,
      from: r.contactName || r.clientName || "Unknown sender",
      subject: oneLine(decodeEntities((r.subject ?? "").trim() || "(no subject)"), 120),
      atLabel: etDateTime(r.occurredAt),
      why,
      byAi: !!r.clientId && !rule && verdicts.has(r.id),
    });
    return false;
  });

  // Group into threads: normalized subject + counterpart. Gmail's threadId isn't
  // stored on CommLog, so subject+person is the closest stable stand-in — it
  // correctly merges "Re:"/"Fwd:" chains without gluing two clients' identically
  // titled mail ("Photos ready!") into one thread.
  const buckets = new Map<string, typeof rows>();
  for (const r of clientRows) {
    const key = emailThreadKey(r);
    const b = buckets.get(key);
    if (b) b.push(r);
    else buckets.set(key, [r]);
  }

  // Rows arrive newest-first, so each bucket's first row is its latest message
  // and Map insertion order already equals "newest thread first".
  const now = Date.now();
  const threads: EmailThread[] = [];
  for (const [key, all] of buckets) {
    if (threads.length >= THREAD_CAP) break;
    // The Gmail sweep watches several mailboxes (info@, hello@, …), and mail
    // addressed to more than one gets logged once PER mailbox with distinct
    // externalIds — visually the same email twice. Collapse copies: same
    // direction + same opening text within a 10-minute bucket is one email.
    const seen = new Set<string>();
    const msgs = all.filter((m) => {
      const dupKey = `${m.direction}::${Math.round(m.occurredAt.getTime() / 600_000)}::${m.body.replace(/\s+/g, " ").trim().slice(0, 200).toLowerCase()}`;
      if (seen.has(dupKey)) return false;
      seen.add(dupKey);
      return true;
    });
    const latest = msgs[0];
    const counterpart = latest.clientName || latest.contactName || "Unknown sender";
    // What a hub reply answers: their newest email the sync logged by Gmail id.
    const answerable = msgs.find((m) => m.direction !== "out" && gmailMessageOfExternalId(m.externalId));
    threads.push({
      key,
      counterpart,
      isClient: Boolean(latest.clientId),
      subject: (latest.subject ?? "").trim() || "(no subject)",
      // Gmail itself, for anything the hub's reply box can't do: a subject
      // search is the most reliable deep link we can build without
      // the Gmail thread id. Oct 20 2026 (audit F13): in the mailbox the email
      // actually landed in (`authuser`), not whichever Google account is
      // first in this browser (/u/0/), so Kyle searches the right inbox.
      gmailHref: gmailSearchHref((latest.subject ?? "").trim() || counterpart, msgs.map((m) => mailboxOfExternalId(m.externalId)).find(Boolean) ?? null),
      count: msgs.length,
      snippet: oneLine(decodeEntities(latest.body), 140),
      lastAgo: formatDistanceToNow(latest.occurredAt, { addSuffix: true }),
      lastDirection: latest.direction === "out" ? "out" : "in",
      fresh: latest.direction !== "out" && now - latest.occurredAt.getTime() <= FRESH_MS,
      // Rows arrive newest first, and that is the order shown (Jordan, Oct 27
      // 2026: "newest emails should be at the top").
      messages: msgs.map((m) => ({
        id: m.id,
        direction: m.direction === "out" ? "out" : "in",
        sender: m.direction === "out" ? m.contactName || "Realtour Pilot" : m.contactName || m.clientName || "Unknown sender",
        body: decodeEntities(m.body),
        atLabel: etDateTime(m.occurredAt),
        atISO: m.occurredAt.toISOString(),
        ago: formatDistanceToNow(m.occurredAt, { addSuffix: true }),
      })),
      replyRef: answerable?.id ?? null,
      replyMailbox: answerable ? gmailMessageOfExternalId(answerable.externalId)?.mailbox ?? null : null,
      lastInboundISO: msgs.find((m) => m.direction !== "out")?.occurredAt.toISOString() ?? null,
    });
  }

  return { threads, fresh: threads.filter((t) => t.fresh).length, hidden: hiddenAll.slice(0, HIDDEN_SHOWN), hiddenTotal: hiddenAll.length };
}
