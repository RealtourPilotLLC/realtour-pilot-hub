import "server-only";

// ---------------------------------------------------------------------------
// GOOGLE MAPS, SAID ONCE (Oct 29 2026). GOOGLE_MAPS_API_KEY lives only on
// Vercel, as a secret, so nobody can try it from a laptop. Every address
// lookup and suggestion records Google's last answer here (AppSetting
// `maps:google:status`): "OK", or the refusal in Google's own words
// ("REQUEST_DENIED: This API project is not authorized to use this API"),
// so a lookup that quietly fell back to the free maps can be told apart from
// one Google answered. Written at most once per ten minutes per answer, and
// the key itself is never part of what is stored.
// ---------------------------------------------------------------------------

const KEY = "maps:google:status";
const EVERY_MS = 10 * 60_000;
let last: { at: number; sig: string } | null = null;

export type MapsApi = "geocode" | "places";
export type MapsStatus = Partial<Record<MapsApi, { ok: boolean; detail: string; at: string }>>;

export async function noteMaps(api: MapsApi, ok: boolean, detail: string): Promise<void> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const said = (key ? detail.split(key).join("[key]") : detail).replace(/\s+/g, " ").trim().slice(0, 300);
  const sig = `${api}:${ok}:${said}`;
  if (last && last.sig === sig && Date.now() - last.at < EVERY_MS) return;
  last = { at: Date.now(), sig };
  try {
    const { prisma } = await import("@/lib/prisma");
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    let cur: MapsStatus = {};
    try { cur = row ? (JSON.parse(row.value) as MapsStatus) : {}; } catch { cur = {}; }
    cur[api] = { ok, detail: said, at: new Date().toISOString() };
    const value = JSON.stringify(cur);
    await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
  } catch { /* the lookup's answer stands without the note */ }
}

export async function mapsStatus(): Promise<MapsStatus> {
  try {
    const { prisma } = await import("@/lib/prisma");
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    return row ? (JSON.parse(row.value) as MapsStatus) : {};
  } catch {
    return {};
  }
}
