import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// HAS THIS SCRIPT'S VIDEO BEEN FILMED? (Oct 22 2026, Jordan: "If a script has
// not been approved but has been filmed, like for John Collins, he shouldn't
// have to approve it. It should just show up as filmed.")
//
// THE ONE ANSWER every client-approval ask reads: the portal card and its
// counts, Home's next step, the month PDF, the approval email, the scripts-
// ready notice, Kyle's before-the-shoot task, the office's script chips.
//
// It invents no signal. It is the rule the planning reader (planningFacts)
// and the portal's topic state already use for "this topic was filmed", read
// through the script's own links as well as its topic:
//   · a ContentVideo for the script (ContentScript.videoId, ContentVideo.scriptId)
//     or its topic (ContentVideo.topicId) that a person CONFIRMED filmed
//     (filmedConfirmedAt, written by the upload portal's filming report:
//     filmedTopics.confirmFilmedTopics), or whose status is past filming
//     (FILMED, EDITING, CLIENT_REVIEW, APPROVED, DELIVERED);
//   · the topic's own status past filming (FILMED, EDITING, DELIVERED).
//
// WHAT IS NOT A SIGNAL, on purpose:
//   · a shoot date in the past ("never 'the date has passed'", CP-10);
//   · the client's own "I've done this one" tick (ContentScript.clientMarkedDoneAt
//     is advisory only: filming is proven by the upload portal);
//   · the Script Studio filmed record (Project.reelScript / scriptingOnSiteBy):
//     it belongs to a listing reel's Studio script, which is not a program
//     ContentScript and has no link to one.
//
// FILMED IS NOT APPROVED. Nothing here, or anywhere that reads it, writes a
// client sign-off: clientApprovedAt / clientApprovedByUserId stay exactly as
// they are, and the script's words are never touched. Filmed only means the
// client is no longer asked. A script the client DID approve reads approved,
// as it always has.
// ---------------------------------------------------------------------------

/** A video row past filming (planningFacts / contentTopics use the same list). */
export const FOOTAGE_VIDEO_STATUSES = ["FILMED", "EDITING", "CLIENT_REVIEW", "APPROVED", "DELIVERED"] as const;
/** A topic past filming (planningFacts, portal topic state, monthScriptApprovals). */
export const FILMED_TOPIC_STATUSES = ["FILMED", "EDITING", "DELIVERED"] as const;

/**
 * Which record said it:
 *   VIDEO_CONFIRMED  a person confirmed it filmed (the upload portal's filming report)
 *   VIDEO_STATUS     the video row is past filming (in editing, in review, delivered)
 *   TOPIC_STATUS     the topic is past filming, with no video row to date it
 */
export type FilmedSignal = "VIDEO_CONFIRMED" | "VIDEO_STATUS" | "TOPIC_STATUS";
export type ScriptFilmed = {
  /** When it was filmed, when the hub knows: the video's filming moment, else the moment it was confirmed. Null = not known. */
  atISO: string | null;
  signal: FilmedSignal;
  /** The video row that says so (null for TOPIC_STATUS). */
  videoId: string | null;
};

type When = Date | string | null | undefined;
export type FilmedVideoFacts = { id: string; scriptId: string | null; topicId: string | null; status: string; filmedAt?: When; filmedConfirmedAt?: When };
export type ScriptFilmedFacts = {
  script: { id: string; topicId: string | null; videoId?: string | null };
  /** The script's topic's status (null when it has no topic). */
  topicStatus: string | null;
  /** Video rows to consider; the ones that are not this script's or its topic's are ignored. */
  videos: readonly FilmedVideoFacts[];
};

const iso = (d: When): string | null => {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
};

/** Footage: confirmed filmed, or a status past filming. */
export function isFootage(v: Pick<FilmedVideoFacts, "status" | "filmedConfirmedAt">): boolean {
  return !!v.filmedConfirmedAt || (FOOTAGE_VIDEO_STATUSES as readonly string[]).includes(v.status);
}

export function topicIsFilmed(status: string | null | undefined): boolean {
  return !!status && (FILMED_TOPIC_STATUSES as readonly string[]).includes(status);
}

/**
 * THE RULE, pure. Null = not filmed (still the client's to approve, when it is
 * shared). A confirmation outranks a status, the script's own video outranks
 * its topic's, and the earliest filming moment dates it.
 */
export function scriptFilmedFrom(f: ScriptFilmedFacts): ScriptFilmed | null {
  const s = f.script;
  const direct = (v: FilmedVideoFacts) => (!!s.videoId && v.id === s.videoId) || v.scriptId === s.id;
  const mine = f.videos.filter((v) => isFootage(v) && (direct(v) || (!!s.topicId && v.topicId === s.topicId)));
  if (mine.length) {
    const when = (v: FilmedVideoFacts) => iso(v.filmedAt) ?? iso(v.filmedConfirmedAt);
    const best = [...mine].sort((a, b) =>
      Number(!!b.filmedConfirmedAt) - Number(!!a.filmedConfirmedAt)
      || Number(direct(b)) - Number(direct(a))
      || (when(a) ?? "9999").localeCompare(when(b) ?? "9999")
      || a.id.localeCompare(b.id))[0];
    return { atISO: when(best), signal: best.filmedConfirmedAt ? "VIDEO_CONFIRMED" : "VIDEO_STATUS", videoId: best.id };
  }
  if (s.topicId && topicIsFilmed(f.topicStatus)) return { atISO: null, signal: "TOPIC_STATUS", videoId: null };
  return null;
}

/**
 * The rule for many scripts at once: two reads however many there are. Both
 * always run (an empty list is a cheap empty read), so a reader that calls
 * this costs the same statements for one month or a roster (cp10's guard).
 */
export async function readScriptsFilmed(scripts: readonly { id: string; topicId: string | null; videoId?: string | null }[]): Promise<Map<string, ScriptFilmed>> {
  const ids = [...new Set(scripts.map((s) => s.id))];
  const topicIds = [...new Set(scripts.map((s) => s.topicId).filter((x): x is string => !!x))];
  const videoIds = [...new Set(scripts.map((s) => s.videoId).filter((x): x is string => !!x))];
  const [videos, topics] = await Promise.all([
    prisma.contentVideo.findMany({
      where: {
        AND: [
          { OR: [{ id: { in: videoIds } }, { scriptId: { in: ids } }, { topicId: { in: topicIds } }] },
          { OR: [{ filmedConfirmedAt: { not: null } }, { status: { in: [...FOOTAGE_VIDEO_STATUSES] } }] },
        ],
      },
      select: { id: true, scriptId: true, topicId: true, status: true, filmedAt: true, filmedConfirmedAt: true },
    }),
    prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, status: true } }),
  ]);
  const topicStatus = new Map(topics.map((t) => [t.id, t.status]));
  const out = new Map<string, ScriptFilmed>();
  for (const s of scripts) {
    const filmed = scriptFilmedFrom({ script: s, topicStatus: s.topicId ? topicStatus.get(s.topicId) ?? null : null, videos });
    if (filmed) out.set(s.id, filmed);
  }
  return out;
}

/** "Oct 14", for a client or a chip (Eastern). */
export function filmedDayLabel(atISO: string | null | undefined): string | null {
  if (!atISO) return null;
  const d = new Date(atISO);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
}
