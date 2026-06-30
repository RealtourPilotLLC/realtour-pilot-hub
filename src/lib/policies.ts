import "server-only";
import { prisma } from "@/lib/prisma";

// Client-facing agency policies the AI drafter must follow — fees, scheduling,
// weather/drone, turnaround, and how we handle common situations. Pulled from the
// taught knowledge base so anything Jordan teaches the Hub ("from now on…") flows
// straight into the drafts. CREATIVE/ADMIN tier only — owner-only strategy,
// margins, and costs never go into a client reply.
const POLICY_CATEGORIES = ["fee", "pricing", "sop", "policy", "comms", "client_insight"];

// Returns a short bullet list of the policies most relevant to `message`. The KB
// holds hundreds of facts, so a plain keyword count drowns the specific policy
// (e.g. "drone weather") under generic SOPs that share common words. We score by
// INVERSE DOCUMENT FREQUENCY: a rare, discriminating word the client used ("drone",
// "weather", "reschedule") counts far more than a common one ("shoot", "client").
// Explicit fee/policy rules also get a small floor so we never contradict them.
export async function relevantPolicies(message?: string | null): Promise<string | null> {
  const items = await prisma.knowledgeItem.findMany({
    where: { archived: false, minRole: { in: ["CREATIVE", "ADMIN"] }, category: { in: POLICY_CATEGORIES } },
    orderBy: [{ confidence: "desc" }, { updatedAt: "desc" }],
    take: 200,
    select: { title: true, body: true, category: true },
  });
  if (!items.length) return null;

  const hayOf = (i: { title: string; body: string }) => `${i.title} ${i.body}`.toLowerCase();
  const words = [...new Set((message || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3))];

  if (words.length === 0) {
    return items.slice(0, 8).map((i) => `- ${i.body.trim()}`).join("\n");
  }

  // Document frequency of each message-word across the candidate policies.
  const df = new Map<string, number>();
  for (const w of words) {
    let c = 0;
    for (const it of items) if (hayOf(it).includes(w)) c++;
    df.set(w, c);
  }

  const scored = items
    .map((it) => {
      const hay = hayOf(it);
      let s = 0;
      for (const w of words) if (hay.includes(w)) s += 1 / (1 + (df.get(w) ?? 0));
      if (it.category === "fee" || it.category === "policy") s += 0.15; // hard-rule floor
      return { it, s };
    })
    .filter((x) => x.s > 0.05)
    .sort((a, b) => b.s - a.s)
    .slice(0, 12);

  const chosen = scored.length ? scored.map((s) => s.it) : items.slice(0, 6);
  return chosen.map((i) => `- ${i.body.trim()}`).join("\n");
}
