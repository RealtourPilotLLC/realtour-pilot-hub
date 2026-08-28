import "server-only";
import { prisma } from "@/lib/prisma";
import { stripMoneySentences } from "@/lib/text";

// ---------------------------------------------------------------------------
// Profile-tab prefill (Jordan, Aug 28, third pass): "Video Style" and
// "Working Preferences" must contain the client's ACTUAL stated preferences
// from their strategy / brand-discovery calls — not facts that merely mention
// videos (the keyword filter surfaced "Bernadette's kicking ass and my
// competitive nature's coming out", which is motivation, not a style pref).
//
// So: a strict AI extraction over the call facts, cached per enrollment for a
// week (AppSetting) so a page load never pays for a model call. The prompt's
// contract: explicit preferences only, latest direction wins, empty is a
// correct answer.
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

  const notes = await prisma.contentNote.findMany({
    where: { clientId, intelligence: true, authorName: "AI (call extraction)" },
    orderBy: { createdAt: "desc" },
    take: 80,
    select: { body: true },
  });
  const facts = notes
    .map((n) => stripMoneySentences(n.body).trim())
    .filter((f) => f.length > 3 && !/^\[CONFIDENTIAL/i.test(f));
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
    const { aiJson } = await import("@/lib/integrations/ai");
    const out = await aiJson<{ videoStyle: string[]; preferences: string[] }>({
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
      prompt: `Call facts, newest first:\n${facts.map((f) => `- ${f}`).join("\n").slice(0, 16000)}`,
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
    const clean = (arr: unknown): string =>
      (Array.isArray(arr) ? arr : [])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 3)
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

/** Drop the cache (used after new calls are analyzed, so prefs refresh). */
export async function invalidatePortalPrefill(enrollmentId: string): Promise<void> {
  await prisma.appSetting.delete({ where: { key: `portal-prefill-${enrollmentId}` } }).catch(() => {});
}
