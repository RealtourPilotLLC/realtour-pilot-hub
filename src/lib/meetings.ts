import "server-only";
import { prisma } from "@/lib/prisma";
import { aiJson } from "@/lib/integrations/ai";
import { listMeetTranscripts, readTranscript } from "@/lib/integrations/googleDrive";
import { etDayKey, etAt } from "@/lib/datetime";

// ---------------------------------------------------------------------------
// MEET TRANSCRIPTS → A REVIEW CARD.
//
// Jordan's shape, verbatim: "it should land in a review list and tap to accept…
// it should all be one task with multiple tasks in it… give a detailed summary
// of the call, action items, and a deadline."
//
// So one OwnerMeeting card holds many proposed items and NOTHING is created
// until he taps Accept. A meeting recap that silently spawns eight to-dos is a
// list he stops trusting; one he approves in a glance is a list he keeps.
//
// `sourceId` is unique on the Drive file id, so re-running the scan can never
// duplicate a meeting — it is safe to run on a cron and safe to run by hand.
// ---------------------------------------------------------------------------

/** Transcripts are long; this is roughly a 90-minute call and well inside limits. */
const MAX_TRANSCRIPT_CHARS = 60_000;

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "A detailed recap in markdown: what the meeting was about, what was decided, and anything left open. 150-350 words.",
    },
    actionItems: {
      type: "array",
      description: "Only things JORDAN owes someone. Not what other people agreed to do.",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Imperative and specific, e.g. 'Send Kelly the revised video quote'. Max 90 chars." },
          notes: { type: "string", description: "The context needed to act without re-reading the transcript. 1-2 sentences." },
          dueInDays: { type: "number", description: "Days from the meeting date. Use what was actually agreed; 7 if nothing was said." },
          energy: { type: "string", enum: ["DEEP", "SHALLOW"], description: "DEEP = needs uninterrupted focus. SHALLOW = a call, an email, an errand." },
          estimateMin: { type: "number", description: "Realistic minutes: 15, 30, 60 or 120." },
        },
        required: ["title", "notes", "dueInDays", "energy", "estimateMin"],
        additionalProperties: false,
      },
    },
    draftEmail: {
      type: "string",
      description: "A follow-up email Jordan could send the other attendees: subject line on the first line, then the body. Warm, direct, no filler. Empty string if there is no sensible recipient.",
    },
  },
  required: ["summary", "actionItems", "draftEmail"],
  additionalProperties: false,
} as const;

type Extracted = {
  summary: string;
  actionItems: { title: string; notes: string; dueInDays: number; energy: string; estimateMin: number }[];
  draftEmail: string;
};

const SYSTEM = `You read a meeting transcript and pull out what the OWNER of a real-estate media agency has to do next.

Rules:
- Action items are ONLY things Jordan himself committed to. If someone else took the task, it is not an action item — mention it in the summary instead.
- Do not invent deadlines. Use what was agreed; if nothing was agreed, use 7 days.
- Never guess at anyone's gender. If you don't know a person's pronouns, use "they".
- Quote figures only if they were actually said. Do not estimate money.
- If the transcript is mostly small talk or has no commitments, return an empty actionItems array. An honest empty list is more useful than a padded one.
- The draft email is a starting point Jordan will edit. Never imply it has been sent.`;

/** Read a transcript and propose a summary + action items. Nothing is created. */
async function extract(title: string, heldAt: Date, text: string): Promise<Extracted> {
  return await aiJson<Extracted>({
    system: SYSTEM,
    prompt: `Meeting: ${title}\nDate: ${heldAt.toLocaleDateString("en-US", { timeZone: "America/New_York", dateStyle: "full" })}\n\nTranscript:\n${text.slice(0, MAX_TRANSCRIPT_CHARS)}`,
    schema: SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4000,
  });
}

/**
 * Pull this month's Meet transcripts into review cards.
 *
 * Deliberately scoped to the current month — Jordan asked for "only backfilling
 * this month", and a wider sweep would bury the real ones under history.
 */
export async function scanMeetTranscripts(opts?: { since?: Date; until?: Date; limit?: number }): Promise<{
  found: number;
  created: number;
  skipped: number;
  failed: number;
}> {
  const now = new Date();
  // Midnight EASTERN on the 1st. Anchoring at midnight UTC would start the
  // window at 8pm ET on the last day of the previous month and sweep in a call
  // that belongs to it.
  const since = opts?.since ?? etAt(`${etDayKey(now).slice(0, 7)}-01`, 0);
  // `until` exists so an older call can be pulled in on its own, without
  // dragging every meeting since alongside it.
  const files = await listMeetTranscripts(since, opts?.until ?? now);

  // Everything we already hold, in one query — one round trip, not one per file.
  const known = new Set(
    (
      await prisma.ownerMeeting.findMany({
        where: { sourceId: { in: files.map((f) => f.id) } },
        select: { sourceId: true },
      })
    ).map((r) => r.sourceId),
  );

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const fresh = files.filter((f) => !known.has(f.id)).slice(0, opts?.limit ?? 25);
  skipped = files.length - fresh.length;

  for (const f of fresh) {
    try {
      const text = await readTranscript(f.id);
      // A transcript with almost no words is a meeting nobody spoke in.
      if (text.trim().length < 400) {
        skipped++;
        continue;
      }
      const out = await extract(f.name, f.createdAt, text);
      await prisma.ownerMeeting.create({
        data: {
          title: f.name.slice(0, 200),
          heldAt: f.createdAt,
          source: "google_meet",
          sourceId: f.id,
          summary: out.summary?.slice(0, 8000) || null,
          transcript: text.slice(0, MAX_TRANSCRIPT_CHARS),
          proposed: JSON.stringify(out.actionItems ?? []),
          draftEmail: out.draftEmail?.trim()?.slice(0, 4000) || null,
          status: "REVIEW",
        },
      });
      created++;
    } catch {
      // One unreadable meeting must not stop the rest of the month importing.
      failed++;
    }
  }

  return { found: files.length, created, skipped, failed };
}

export type ProposedItem = { title: string; notes: string; dueInDays: number; energy: string; estimateMin: number };

export function parseProposed(raw: string | null): ProposedItem[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ProposedItem[]) : [];
  } catch {
    return [];
  }
}

/** Meetings waiting on a decision, newest first. */
export async function meetingsForReview(limit = 10) {
  const rows = await prisma.ownerMeeting.findMany({
    where: { status: "REVIEW" },
    orderBy: { heldAt: "desc" },
    take: limit,
    select: { id: true, title: true, heldAt: true, summary: true, proposed: true, draftEmail: true },
  });
  return rows.map((r) => ({ ...r, items: parseProposed(r.proposed) }));
}
