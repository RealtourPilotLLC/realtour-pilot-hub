import "server-only";
import { prisma } from "@/lib/prisma";
import { stripMoneySentences } from "@/lib/text";
import { factsForPrompt } from "@/lib/clientFacts";

// ---------------------------------------------------------------------------
// Profile-tab prefill (Jordan, Aug 28, third pass): "Video Style" and
// "Working Preferences" must contain the client's ACTUAL stated preferences
// from their strategy / brand-discovery calls — not facts that merely mention
// videos (the keyword filter surfaced "Bernadette's kicking ass and my
// competitive nature's coming out", which is motivation, not a style pref).
//
// Sep 17: the input is the client's ACCEPTED ClientFacts (aiContext ALLOWED,
// never confidential) — not the unreviewed ContentNote pile that fed the
// portal for two weeks with seven confidential facts inside it. Until Jordan
// accepts facts on the client file the prefill is EMPTY, which is the honest
// state. The extraction is cached per enrollment for a week (AppSetting) so a
// page load never pays for a model call; the run is logged.
// ---------------------------------------------------------------------------

type Prefill = { videoStyle: string; preferences: string };
const TTL_MS = 7 * 86_400_000;
const FAIL_TTL_MS = 60 * 60_000;

export async function getPortalPrefill(enrollmentId: string, clientId: string): Promise<Prefill> {
  const key = `portal-prefill-${enrollmentId}`;
  const cached = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
  if (cached) {
    try {
      const v = JSON.parse(cached.value) as Prefill & { at: number; failed?: boolean };
      const ttl = v.failed ? FAIL_TTL_MS : TTL_MS;
      if (Date.now() - v.at < ttl) return { videoStyle: v.videoStyle ?? "", preferences: v.preferences ?? "" };
    } catch { /* stale/corrupt cache → recompute */ }
  }

  const accepted = await factsForPrompt(clientId, { take: 80 });
  const facts = accepted
    .filter((f) => f.category === "BRAND_PREFERENCE" || f.category === "PRODUCTION_PREFERENCE" || f.category === "DECISION")
    .map((f) => stripMoneySentences(f.body).trim())
    .filter((f) => f.length > 3 && !/\[CONFIDENTIAL/i.test(f)); // belt and braces: the column already excludes these
  const write = async (v: Prefill, failed = false) =>
    prisma.appSetting
      .upsert({
        where: { key },
        update: { value: JSON.stringify({ ...v, at: Date.now(), failed }) },
        create: { key, value: JSON.stringify({ ...v, at: Date.now(), failed }) },
      })
      .catch(() => {});
  if (facts.length === 0) {
    await write({ videoStyle: "", preferences: "" });
    return { videoStyle: "", preferences: "" };
  }

  try {
    const { runAiJson } = await import("@/lib/aiRuns");
    const { output: out } = await runAiJson<{ videoStyle: string[]; preferences: string[] }>({
      // A page render is nobody's click: unattended, so the ai_runs switch gates it
      // (off → the catch below caches an empty prefill for an hour; staff pay nothing).
      kind: "profile_draft", enrollmentId, clientId, promptKey: "portal-prefill", requestedBy: "portal-render", unattended: true, dedupeKey: `prefill:${enrollmentId}`,
      system: `You extract a real-estate agent's OWN STATED PREFERENCES from facts recorded off their strategy and brand-discovery calls, for display back to them on their client portal.

STRICT RULES:
1. Include ONLY things the client explicitly expressed as a preference or direction:
   - videoStyle: how they want their videos to look, feel, sound or be edited (pacing, polish level, text style, music taste, tone on camera).
   - preferences: how they prefer to WORK — scheduling, locations, filming logistics, communication, comfort on set.
2. A fact that merely mentions video or work is NOT a preference. Motivation, anecdotes, brand lore, competitor talk, performance chatter: exclude.
3. When directions conflict, keep only the LATEST (facts are newest-first).
4. Phrase each as a short standalone preference in neutral third person ("Prefers a more polished edit with motion"), faithful to their words — never invent.
5. EMPTY LISTS ARE A CORRECT ANSWER. When nothing qualifies, return [].
6. Never include money, pricing or billing.`,
      prompt: `Accepted facts, newest first:\n${facts.map((f) => `- ${f}`).join("\n").slice(0, 16000)}`,
      schema: {
        type: "object",
        properties: {
          videoStyle: { type: "array", items: { type: "string" }, description: "Stated video style/edit preferences, or []" },
          preferences: { type: "array", items: { type: "string" }, description: "Stated working/logistics preferences, or []" },
        },
        required: ["videoStyle", "preferences"],
      },
      maxTokens: 1200,
    });
    // NAME SCRUB — the prefill is written from call intel, and the model happily
    // grounds a preference in somebody else: Ashley Brunner's live portal read
    // "benchmarked against the reel produced for agent Erica", naming a current
    // paying client to another one. (Arielle Roemer's own recorded preference is
    // that her strategy must not be shared with agents in her markets.) Money was
    // scrubbed here from the start; people were not. Deterministic, not a prompt
    // instruction — this is a page the client reads.
    //
    // Two lists, deliberately: FULL names of every other client (unambiguous),
    // and bare FIRST names only for the clients on the content program — that is
    // the realistic leak ("agent Erica") and it is a set of a dozen. Surnames at
    // large are not usable as a filter: real ones here include Good, King, West
    // and Hey, and dropping any line containing them would delete "good
    // lighting". Team names stay: the client already works with their crew.
    const [otherClients, programEnrollments] = await Promise.all([
      prisma.client.findMany({ where: { id: { not: clientId } }, select: { id: true, name: true } }),
      prisma.contentEnrollment.findMany({
        where: { status: { in: ["ACTIVE", "PAUSED"] }, clientId: { not: clientId } },
        select: { clientId: true },
      }),
    ]);
    const nameById = new Map(otherClients.map((c) => [c.id, (c.name ?? "").trim()]));
    const terms = [
      // Full name, and the first two words when the record carries a suffix or a
      // team label ("Gary Mercer Sr" → also "Gary Mercer", which is how another
      // client's prefill actually referred to him).
      ...otherClients.flatMap((c) => {
        const n = (c.name ?? "").trim();
        const w = n.split(/\s+/);
        return w.length >= 3 ? [n, `${w[0]} ${w[1]}`] : w.length === 2 ? [n] : [];
      }),
      ...programEnrollments.map((e) => (nameById.get(e.clientId) ?? "").split(/\s+/)[0]).filter((n) => n.length >= 4),
    ].filter((n, i, a) => n && a.indexOf(n) === i);
    const namesRe = terms.length
      ? new RegExp(`\\b(${terms.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i")
      : null;

    const clean = (arr: unknown): string =>
      (Array.isArray(arr) ? arr : [])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 3)
        .filter((x) => !namesRe || !namesRe.test(x))
        .slice(0, 6)
        .map((x) => `• ${stripMoneySentences(x.trim())}`)
        .filter((x) => x.length > 4)
        .join("\n")
        .slice(0, 1400);
    const result = { videoStyle: clean(out.videoStyle), preferences: clean(out.preferences) };
    await write(result);
    return result;
  } catch {
    // AI unreachable → empty prefill for an hour, never a broken page.
    await write({ videoStyle: "", preferences: "" }, true);
    return { videoStyle: "", preferences: "" };
  }
}

/** Drop the cache (used after facts are accepted / new calls are analyzed, so prefs refresh). */
export async function invalidatePortalPrefill(enrollmentId: string): Promise<void> {
  await prisma.appSetting.delete({ where: { key: `portal-prefill-${enrollmentId}` } }).catch(() => {});
}
