import { prisma } from "@/lib/prisma";
import { countSpokenWords } from "../contentPolicy/policy";
import { versionFormatOf } from "../contentPolicy/videoFormat";
import { contentWordsOf, hasDash, WRITER_LENGTH } from "./rules";

// ---------------------------------------------------------------------------
// THE BAR (writer v2.6, Oct 23 2026): the examples the writer and the review
// are shown are scripts Jordan approved and sent to OTHER clients, chosen at
// draft time from the hub's own record:
//
//   · a monthly script (not historical, not imported) that was approved and
//     released to the client's portal (approvedAt and sharedAt set);
//   · approved by an OWNER login (AppUser role OWNER, not disabled), never a
//     script another staff member approved;
//   · the text released (sharedVersionId, else approvedVersionId), in its
//     five parts (a hook, three talking points, a close; never a skit);
//   · 55 to 110 spoken words on those five parts, and no em or en dash;
//   · never the enrollment the script is being written for (her own scripts
//     would carry her facts from one video into another), never one on the
//     same topic, at most one per client, up to three, the most recently
//     released first (ties by id), so a topic's examples are the same for
//     every step of one run and its cached prompt block stays stable;
//   · never words that are not Jordan's bar (audit, Oct 23 2026): a bulk
//     plan's script (the client's own bank, kept word for word, bulkPlan.ts),
//     a version a one-off wrote outside the hub's own presses (createdBy
//     "dev@local", or "... (via Claude ...)"), and never Erica Walker's four
//     October scripts Claude rewrote by hand on Oct 23 (CLAUDE_HAND_WRITTEN):
//     those are never called Jordan's and never used as the bar, whoever
//     approves them later.
//
// Nothing qualifies → no examples: the writer works from the rules alone.
// Offline (asOf): only scripts released by that moment.
// ---------------------------------------------------------------------------

export const BAR_EXAMPLES_SHOWN = 3;
/** How many released scripts are read before filtering (the most recent first). */
const CANDIDATES_READ = 300;

/** An example as the prompts show it: the five parts only (never the client, the title or a date). */
export type BarExample = { scriptId: string; enrollmentId: string; clientId: string; title: string; hook: string; rehook: string; buildup: string; payoff: string; close: string };

/** A released script as read from the database, before the picker's rules. */
export type BarCandidate = {
  scriptId: string; enrollmentId: string; clientId: string; title: string; topicTitle: string | null;
  source: string | null; historical: boolean; approvedBy: string | null; approvedAt: Date | null; sharedAt: Date | null;
  version: { hook: string; pointsJson: string; close: string; speakerLabelsJson?: string | null; validationJson?: string | null; createdBy?: string | null } | null;
  /** A bulk plan's script: the client's own bank, never the bar. */
  bulkBank?: boolean;
};

/**
 * Erica Walker's four October scripts Claude rewrote by hand on Oct 23 2026
 * (scripts/_live/oct23-erica-scripts-rewrite.ts): never the bar, whoever
 * approves them and whatever version is sent.
 */
export const CLAUDE_HAND_WRITTEN: ReadonlySet<string> = new Set([
  "cmvh4a9mt005ujs08ucz5bvdp", // Your Backyard Vision Starts With the Lot, Not the Landscaper
  "cmvh4b2jo005zjs08gdq9v1co", // More Space, or Space That Actually Works?
  "cmvh4s01n00apjs08v7cx0g77", // Empty Nesters Are Upsizing, Not Downsizing
  "cmvh4spk600aujs08mxo7xf8b", // I Once Watched a Deal Fall Apart Over a Doorknob
]);

/** A version written outside the hub's own presses (a local one-off's stamp), never the bar. Pure. */
export function writtenOffHub(createdBy: string | null | undefined): boolean {
  return /dev@local|\(via claude/i.test(createdBy ?? "");
}

/** The email in an approvedBy stamp ("info@x.com", or "info@x.com (via ...)"), lowercased, or null. */
export function approverEmail(approvedBy: string | null | undefined): string | null {
  const m = /[^\s<>()"']+@[^\s<>()"']+/.exec(approvedBy ?? "");
  return m ? m[0].toLowerCase() : null;
}

/** The same topic (pure): the same title, or three or more of its content words. */
export function sameTopic(a: string | null | undefined, b: string | null | undefined): boolean {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!a?.trim() || !b?.trim()) return false;
  if (key(a) === key(b)) return true;
  const mine = contentWordsOf(a);
  return [...contentWordsOf(b)].filter((w) => mine.has(w)).length >= 3;
}

/** A version's five parts, or null when it is not a hook, three talking points and a close (pure). */
export function fiveParts(v: BarCandidate["version"]): Omit<BarExample, "scriptId" | "enrollmentId" | "clientId" | "title"> | null {
  if (!v) return null;
  let points: { text?: unknown }[] = [];
  try { points = JSON.parse(v.pointsJson ?? "[]") as { text?: unknown }[]; } catch { return null; }
  const t = (x: unknown) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim() : "");
  const [rehook, buildup, payoff] = (Array.isArray(points) ? points : []).map((p) => t(p?.text));
  const hook = t(v.hook), close = t(v.close);
  if (!Array.isArray(points) || points.length !== 3 || ![hook, rehook, buildup, payoff, close].every(Boolean)) return null;
  return { hook, rehook, buildup, payoff, close };
}

/**
 * THE PICKER (pure). `candidates` in any order; `owners` the OWNER logins'
 * emails. Returns up to BAR_EXAMPLES_SHOWN examples by the rules above.
 */
export function pickBarExamples(candidates: readonly BarCandidate[], o: { enrollmentId: string; topicTitle: string; owners: readonly string[] }): BarExample[] {
  const owners = new Set(o.owners.map((e) => e.toLowerCase().trim()).filter(Boolean));
  if (!owners.size) return [];
  const ordered = [...candidates].sort((a, b) => (b.sharedAt?.getTime() ?? 0) - (a.sharedAt?.getTime() ?? 0) || (a.scriptId < b.scriptId ? -1 : a.scriptId > b.scriptId ? 1 : 0));
  const out: BarExample[] = [];
  const clients = new Set<string>();
  for (const c of ordered) {
    if (out.length >= BAR_EXAMPLES_SHOWN) break;
    if (c.enrollmentId === o.enrollmentId || clients.has(c.clientId)) continue;
    if (c.historical || (c.source ?? "").toLowerCase() === "import" || !c.sharedAt || !c.approvedAt) continue;
    if (c.bulkBank || CLAUDE_HAND_WRITTEN.has(c.scriptId) || writtenOffHub(c.version?.createdBy)) continue;
    const by = approverEmail(c.approvedBy);
    if (!by || !owners.has(by)) continue;
    if (versionFormatOf(c.version) === "SKIT") continue;
    const parts = fiveParts(c.version);
    if (!parts) continue;
    const spoken = [parts.hook, parts.rehook, parts.buildup, parts.payoff, parts.close].join("\n");
    const words = countSpokenWords(spoken);
    if (words < WRITER_LENGTH.aim[0] || words > WRITER_LENGTH.cap || hasDash(spoken)) continue;
    if (sameTopic(o.topicTitle, c.title) || sameTopic(o.topicTitle, c.topicTitle)) continue;
    clients.add(c.clientId);
    out.push({ scriptId: c.scriptId, enrollmentId: c.enrollmentId, clientId: c.clientId, title: c.title, ...parts });
  }
  return out;
}

/**
 * The examples for one script being written (reads the database; never
 * throws: no examples on any error). As of `asOf` for the offline test.
 */
export async function barExamplesFor(o: { enrollmentId: string; topicTitle: string; asOf?: Date | null }): Promise<BarExample[]> {
  try {
    const owners = (await prisma.appUser.findMany({ where: { role: "OWNER", status: { not: "DISABLED" } }, select: { email: true } })).map((u) => u.email);
    if (!owners.length) return [];
    const rows = await prisma.contentScript.findMany({
      where: {
        historical: false, enrollmentId: { not: o.enrollmentId }, approvedBy: { not: null },
        approvedAt: { not: null }, sharedAt: o.asOf ? { not: null, lte: o.asOf } : { not: null },
        source: { not: "import" },
      },
      orderBy: [{ sharedAt: "desc" }, { id: "asc" }], take: CANDIDATES_READ,
      select: { id: true, enrollmentId: true, clientId: true, monthId: true, title: true, topicId: true, source: true, historical: true, approvedBy: true, approvedAt: true, sharedAt: true, sharedVersionId: true, approvedVersionId: true },
    });
    const ownerSet = new Set(owners.map((e) => e.toLowerCase()));
    const mine = rows.filter((r) => ownerSet.has(approverEmail(r.approvedBy) ?? ""));
    const versionIds = mine.map((r) => r.sharedVersionId ?? r.approvedVersionId).filter((x): x is string => !!x);
    const versions = new Map((await prisma.contentScriptVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, hook: true, pointsJson: true, close: true, speakerLabelsJson: true, validationJson: true, createdBy: true } })).map((v) => [v.id, v]));
    // A bulk plan's months hold the client's own bank (bulkPlan.ts).
    const monthIds = [...new Set(mine.map((r) => r.monthId).filter((x): x is string => !!x))];
    const bulkMonths = new Set(monthIds.length ? (await prisma.contentBulkPlan.findMany({ where: { monthId: { in: monthIds }, status: { not: "CANCELLED" } }, select: { monthId: true } })).map((b) => b.monthId) : []);
    const topicIds = [...new Set(mine.map((r) => r.topicId).filter((x): x is string => !!x))];
    const topics = new Map((topicIds.length ? await prisma.contentTopic.findMany({ where: { id: { in: topicIds } }, select: { id: true, title: true } }) : []).map((t) => [t.id, t.title]));
    return pickBarExamples(mine.map((r) => ({
      scriptId: r.id, enrollmentId: r.enrollmentId, clientId: r.clientId, title: r.title, topicTitle: r.topicId ? topics.get(r.topicId) ?? null : null,
      source: r.source, historical: r.historical, approvedBy: r.approvedBy, approvedAt: r.approvedAt, sharedAt: r.sharedAt,
      version: versions.get(r.sharedVersionId ?? r.approvedVersionId ?? "") ?? null,
      bulkBank: !!r.monthId && bulkMonths.has(r.monthId),
    })), { enrollmentId: o.enrollmentId, topicTitle: o.topicTitle, owners });
  } catch {
    return [];
  }
}
