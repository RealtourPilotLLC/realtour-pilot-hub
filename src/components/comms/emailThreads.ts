import "server-only";
import { formatDistanceToNow } from "date-fns";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth/user";
import { contentTier } from "@/lib/auth/access";
import { etDateTime } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// Email tab data for the Communications hub.
//
// Client/lead email already syncs into CommLog (channel "email", source
// "gmail") — Gmail itself stays the send surface (no gmail.send scope), so this
// is a READ-ONLY view: recent mail grouped into threads, with an "Open in
// Gmail" jump-out per thread for anyone who needs to reply.
// ---------------------------------------------------------------------------

export type EmailMessage = {
  id: string;
  direction: "in" | "out";
  sender: string; // who wrote it (contact/client name, or us)
  body: string;
  atLabel: string; // absolute ET timestamp (ET-everywhere date rule)
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
  messages: EmailMessage[]; // oldest first, for natural reading order
};

// Same role tiers as every other CommLog reader (see hubTools.ts search_comms):
// a viewer only sees rows at or below their tier. ADMIN sees ADMIN+CREATIVE
// mail but NOT owner-only rows (unknown-sender leads on Jordan's personal
// inbox are logged minRole OWNER); OWNER sees everything.
const ROLE_RANK: Record<string, number> = { CREATIVE: 1, ADMIN: 2, OWNER: 3 };

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

const WINDOW_DAYS = 60;
const THREAD_CAP = 50;
const FRESH_MS = 48 * 3600_000;

export async function getEmailThreads(): Promise<{ threads: EmailThread[]; fresh: number }> {
  // Sessionless local dev renders the full owner view — same convention as the
  // dashboard (src/app/page.tsx). contentTier folds app roles (EDITOR,
  // PHOTOGRAPHER, …) onto the CREATIVE/ADMIN/OWNER sensitivity ladder.
  const me = await getCurrentUser().catch(() => null);
  const tier = contentTier(me?.role ?? "OWNER");
  const allowed = Object.keys(ROLE_RANK).filter((r) => ROLE_RANK[r] <= ROLE_RANK[tier]);

  const rows = await prisma.commLog.findMany({
    where: {
      channel: "email",
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
    },
  });

  // Group into threads: normalized subject + counterpart. Gmail's threadId isn't
  // stored on CommLog, so subject+person is the closest stable stand-in — it
  // correctly merges "Re:"/"Fwd:" chains without gluing two clients' identically
  // titled mail ("Photos ready!") into one thread.
  const buckets = new Map<string, typeof rows>();
  for (const r of rows) {
    const who = r.clientId ?? (r.clientName ?? r.contactName ?? "").trim().toLowerCase();
    const key = `${normalizeSubject(r.subject)}::${who || "unknown"}`;
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
    threads.push({
      key,
      counterpart,
      isClient: Boolean(latest.clientId),
      subject: (latest.subject ?? "").trim() || "(no subject)",
      // No gmail.send scope is connected, so replies happen in Gmail itself —
      // a subject search is the most reliable deep link we can build without
      // the Gmail thread id.
      gmailHref: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent((latest.subject ?? "").trim() || counterpart)}`,
      count: msgs.length,
      snippet: oneLine(decodeEntities(latest.body), 140),
      lastAgo: formatDistanceToNow(latest.occurredAt, { addSuffix: true }),
      lastDirection: latest.direction === "out" ? "out" : "in",
      fresh: latest.direction !== "out" && now - latest.occurredAt.getTime() <= FRESH_MS,
      messages: [...msgs].reverse().map((m) => ({
        id: m.id,
        direction: m.direction === "out" ? "out" : "in",
        sender: m.direction === "out" ? m.contactName || "RealTour Pilot" : m.contactName || m.clientName || "Unknown sender",
        body: decodeEntities(m.body),
        atLabel: etDateTime(m.occurredAt),
        ago: formatDistanceToNow(m.occurredAt, { addSuffix: true }),
      })),
    });
  }

  return { threads, fresh: threads.filter((t) => t.fresh).length };
}
