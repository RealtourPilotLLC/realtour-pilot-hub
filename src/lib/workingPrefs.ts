import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { stripMoneySentences } from "@/lib/text";
import { noLongDashes } from "@/lib/clientIssuePlanCore";
import { EDIT_TOPICS, type SortedPrefs, type SortedPref, type EditTopic } from "@/lib/workingPrefsCore";

// ---------------------------------------------------------------------------
// WORKING PREFERENCES, SORTED (Jordan, Oct 29 2026: "Working preferences
// should be summarized and organized and shown in full. The working
// preferences shown in the editor brief should only be editing related, not
// shooting related or communication related or anything else, just editing
// preferences should be shown.")
//
// A client's standing preferences sit in five places: their Brand Profile's
// working preferences box, the office's customer note (mirrored to Aryeo),
// the office's client preferences field, the call notes the office accepted,
// and the hub's working profile. The editor brief used to pick lines out of
// them with a keyword list (lib/editorPrefs), which got it backwards on
// Renee Ryan: her "PHOTO NOTE: ... capture a shot from the front of the living
// room" reached the editor, cut at 220 characters, while her one edit rule
// (fireplaces never show fire) was filtered out.
//
// Now one model pass reads all five, merges what repeats, keeps every detail
// (names, colors, phone numbers, links) and sorts each preference into
// editing, shooting, communication or other, the editing ones by topic. The
// result is cached per client against a hash of what it read, so a page never
// waits on it: a stale or missing sort is rebuilt after the response
// (sortedWorkingPrefs + buildSortedWorkingPrefs) and by the nightly client
// sweep. Display only: nothing here writes to a note, Aryeo or the client.
// ---------------------------------------------------------------------------

const PROMPT_VERSION = "working-prefs-v1";
const KEY = (clientId: string) => `working_prefs:${clientId}`;
const LOCK = (clientId: string) => `working_prefs_lock:${clientId}`;
const LOCK_MS = 3 * 60_000;

export type PrefSource = { label: string; text: string };

/** Everything the sort reads for one client, in full, money-scrubbed. */
export async function workingPrefSources(clientId: string): Promise<{ sources: PrefSource[]; hash: string }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, generalNotes: true, editingPreferences: true, clientPreferences: true, portalPreferences: true, profileJson: true },
  });
  if (!client) return { sources: [], hash: "" };
  const { creativeCustomerNote } = await import("@/lib/clientNotes");
  const [{ productionDefaults }, { productionFactsForBrief }, { parseClientProfile }] = await Promise.all([
    import("@/lib/clientAssets"), import("@/lib/clientFacts"), import("@/lib/clientProfile"),
  ]);
  const [defaults, facts] = await Promise.all([
    productionDefaults(clientId).catch(() => []),
    productionFactsForBrief(clientId, null).catch(() => []),
  ]);
  const profile = parseClientProfile(client.profileJson);
  const clean = (s: string | null | undefined) => {
    const t = stripMoneySentences((s ?? "").trim()).trim();
    return t || null;
  };
  const list = (xs: (string | null | undefined)[]) => xs.map(clean).filter((x): x is string => !!x).map((x) => `- ${x}`).join("\n");
  const sources: PrefSource[] = [
    { label: "Their Brand Profile, working preferences (the client's own words)", text: clean(client.portalPreferences) ?? "" },
    { label: "Customer note (the office's note on the client, also on Aryeo)", text: clean(creativeCustomerNote(client)) ?? "" },
    { label: "Client preferences (the office's field on the client page)", text: clean(client.clientPreferences) ?? "" },
    { label: "Standing production defaults (the office's)", text: list(defaults.map((d) => `${d.name}: ${d.text}`)) },
    { label: "Accepted from their calls", text: list(facts.filter((f) => f.scope === "PERMANENT").map((f) => f.body)) },
    {
      label: "The hub's working profile, edit notes (from their messages and jobs)",
      text: list([...(profile?.editing?.prefs ?? []), ...(profile?.editing?.customerNotes ?? []), ...(profile?.editing?.dos ?? []), ...(profile?.editing?.donts ?? []).map((d) => (/^(never|don'?t|do not|avoid)\b/i.test(d) ? d : `Avoid: ${d}`))]),
    },
    { label: "The hub's working profile, shoot notes", text: list(profile?.shootNotes ?? []) },
    { label: "The hub's working profile, how they communicate", text: clean(profile?.communication) ?? "" },
  ].filter((s) => s.text.trim());
  const hash = sources.length ? createHash("sha256").update(PROMPT_VERSION).update(JSON.stringify(sources)).digest("hex").slice(0, 32) : "";
  return { sources, hash };
}

export type WorkingPrefsRead =
  | { state: "none"; prefs: null }
  | { state: "ready"; prefs: SortedPrefs }
  /** What it read changed since the last sort (prefs is that older sort, or null). */
  | { state: "stale"; prefs: SortedPrefs | null };

function parse(value: string | null | undefined): SortedPrefs | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as SortedPrefs;
    return v && v.v === 1 && Array.isArray(v.editing) ? v : null;
  } catch {
    return null;
  }
}

/** The client's sorted preferences, and whether they are current. Never calls the model. */
export async function sortedWorkingPrefs(clientId: string): Promise<WorkingPrefsRead> {
  const [{ hash }, row] = await Promise.all([
    workingPrefSources(clientId),
    prisma.appSetting.findUnique({ where: { key: KEY(clientId) }, select: { value: true } }),
  ]);
  const prefs = parse(row?.value);
  if (!hash) return { state: "none", prefs: null };
  if (prefs && prefs.hash === hash) return { state: "ready", prefs };
  return { state: "stale", prefs };
}

const SYSTEM = `You sort a real estate agent's standing working preferences for a real estate media agency (listing photos, video, drone, floor plans, social content). The notes come from several places: the agent's own Brand Profile, the office's customer note, the office's client preferences, standing production defaults, notes the office accepted from calls, and the hub's working profile written from their messages and jobs.

Return every distinct preference ONCE, in exactly one group:
- editing: anything that changes the finished, edited work: the video edit, photo editing and retouching, graphics, logo, contact details on screen, text and captions, colors, fonts, music and sound, length, pacing, transitions, what must or must not appear in the final cut, how the editor handles their revisions. Give each a topic.
- shooting: what the photographer or videographer does on site: angles and shots to capture, framing, equipment, wardrobe, staging a room, arrival, taking their time.
- communication: scheduling, availability, how and when to reach them, who to copy, how fast they expect replies.
- other: anything else that is a standing preference (links to their pages, who they are, team details).

Rules:
1. Summarize: one plain sentence per preference, as an instruction or in the third person ("Add his animated logo to every video."). Merge duplicates and near duplicates from different places into one line.
2. Keep every concrete detail: names, brokerage, colors and hex codes, font names, phone numbers, links, song or artist names, counts, times. Never drop a detail to make a line shorter; a preference may take two sentences.
3. Be faithful: never invent and never widen the words. When two notes conflict, the agent's own Brand Profile wins, then the office's notes, then the hub's working profile.
4. A note that mixes the shoot and the edit is split: the edit half to editing, the shoot half to shooting.
5. A description that is not a preference (a story, a compliment, how a past job went) is left out.
6. Nothing about money, prices, invoices or payment.
7. No em dashes or en dashes.
8. Empty groups are a correct answer.`;

const LINE = (withTopic: boolean) => ({
  type: "object",
  properties: {
    ...(withTopic ? { topic: { type: "string", enum: [...EDIT_TOPICS] } } : {}),
    text: { type: "string" },
  },
  required: withTopic ? ["topic", "text"] : ["text"],
});
const SCHEMA = {
  type: "object",
  properties: {
    editing: { type: "array", items: LINE(true) },
    shooting: { type: "array", items: LINE(false) },
    communication: { type: "array", items: LINE(false) },
    other: { type: "array", items: LINE(false) },
  },
  required: ["editing", "shooting", "communication", "other"],
};

/**
 * Sort a client's preferences with the model and cache the result. One at a
 * time per client (a lock row), and a no-op when the cache already matches.
 */
export async function buildSortedWorkingPrefs(clientId: string, by: string): Promise<{ ok: boolean; message: string; prefs?: SortedPrefs }> {
  const { sources, hash } = await workingPrefSources(clientId);
  if (!hash) return { ok: true, message: "Nothing on file to sort." };
  const cur = parse((await prisma.appSetting.findUnique({ where: { key: KEY(clientId) }, select: { value: true } }))?.value);
  if (cur?.hash === hash) return { ok: true, message: "Already sorted.", prefs: cur };
  const now = Date.now();
  const lock = await prisma.appSetting.findUnique({ where: { key: LOCK(clientId) }, select: { value: true } });
  if (lock && now - Number(lock.value) < LOCK_MS) return { ok: false, message: "Already sorting." };
  await prisma.appSetting.upsert({ where: { key: LOCK(clientId) }, create: { key: LOCK(clientId), value: String(now) }, update: { value: String(now) } });
  try {
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { name: true } });
    const prompt = [`Agent: ${client?.name ?? "unknown"}`, ...sources.map((s) => `${s.label}:\n${s.text.slice(0, 4000)}`)].join("\n\n");
    const { aiJsonWithUsage } = await import("@/lib/integrations/ai");
    type Out = { editing: { topic: string; text: string }[]; shooting: { text: string }[]; communication: { text: string }[]; other: { text: string }[] };
    const out = await aiJsonWithUsage<Out>({ system: SYSTEM, prompt, schema: SCHEMA, maxTokens: 2500, feature: "client_prefs" });
    const tidy = (t: unknown): string => noLongDashes(stripMoneySentences(String(t ?? "").trim()).trim()).slice(0, 600);
    const lines = (xs: unknown): SortedPref[] =>
      (Array.isArray(xs) ? xs : [])
        .map((x) => ({ text: tidy((x as { text?: unknown })?.text), topic: (EDIT_TOPICS as readonly string[]).includes(String((x as { topic?: unknown })?.topic)) ? (String((x as { topic: unknown }).topic) as EditTopic) : null }))
        .filter((x) => x.text.length > 2)
        .slice(0, 30);
    const prefs: SortedPrefs = {
      v: 1, hash, at: new Date().toISOString(), by, model: out.model,
      editing: lines(out.result.editing).map((x) => ({ ...x, topic: x.topic ?? "Other" })),
      shooting: lines(out.result.shooting).map((x) => ({ text: x.text, topic: null })),
      communication: lines(out.result.communication).map((x) => ({ text: x.text, topic: null })),
      other: lines(out.result.other).map((x) => ({ text: x.text, topic: null })),
    };
    await prisma.appSetting.upsert({ where: { key: KEY(clientId) }, create: { key: KEY(clientId), value: JSON.stringify(prefs) }, update: { value: JSON.stringify(prefs) } });
    return { ok: true, message: "Sorted.", prefs };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    await prisma.appSetting.delete({ where: { key: LOCK(clientId) } }).catch(() => null);
  }
}

/**
 * The nightly sweep: clients with a job shot in the last 30 days or booked in
 * the next 14 whose sort is missing or stale, oldest work first, on a time
 * budget. Returns how many were sorted.
 */
export async function refreshSortedWorkingPrefs(limit = 25, budgetMs = 90_000): Promise<{ sorted: number; ranOut: boolean }> {
  const now = Date.now();
  const deadline = now + budgetMs;
  const recent = await prisma.project.findMany({
    where: { shootDate: { gte: new Date(now - 30 * 86_400_000), lte: new Date(now + 14 * 86_400_000) }, status: { not: "CANCELLED" } },
    select: { clientId: true },
    distinct: ["clientId"],
    take: 200,
  });
  let sorted = 0;
  let ranOut = false;
  for (const { clientId } of recent) {
    if (sorted >= limit) break;
    if (Date.now() >= deadline) { ranOut = true; break; }
    const r = await sortedWorkingPrefs(clientId).catch(() => null);
    if (r?.state !== "stale") continue;
    const b = await buildSortedWorkingPrefs(clientId, "nightly").catch(() => null);
    if (b?.ok && b.prefs) sorted++;
  }
  return { sorted, ranOut };
}
