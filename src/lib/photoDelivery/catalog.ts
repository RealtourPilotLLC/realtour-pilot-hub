import "server-only";

import { getSetting, putSetting } from "@/lib/settings";
import { autohdr, autohdrConfigured, type AutohdrCapability, type AutohdrModel } from "@/lib/integrations/autohdr";

// ---------------------------------------------------------------------------
// AutoHDR's live catalogue (docs/photo-delivery/01 §5.1, §8.1): transform
// names, versions and credit costs (listCapabilities) and the editing models
// (listModels). Prices and model ids are NEVER hardcoded: they are read here
// and cached for an hour in AppSetting, so every lambda shares one copy and a
// price change at AutoHDR reaches the Fix Cart within the hour.
// ---------------------------------------------------------------------------

const CAP_KEY = "photo_delivery:autohdr_capabilities";
const MODEL_KEY = "photo_delivery:autohdr_models";
const TTL_MS = 60 * 60_000;

type Cached<T> = { at: string; items: T[] };

async function cached<T>(key: string, load: () => Promise<T[]>, force = false): Promise<T[] | null> {
  const hit = await getSetting<Cached<T> | null>(key, null);
  if (!force && hit && Date.now() - Date.parse(hit.at) < TTL_MS && Array.isArray(hit.items)) return hit.items;
  if (!(await autohdrConfigured())) return hit?.items ?? null;
  try {
    const items = await load();
    await putSetting(key, { at: new Date().toISOString(), items }, "system");
    return items;
  } catch (e) {
    console.warn("autohdr catalogue read failed", key, (e as Error).message);
    return hit?.items ?? null; // a stale price list beats none; callers label estimates
  }
}

export async function capabilityCatalog(force = false): Promise<AutohdrCapability[] | null> {
  return cached<AutohdrCapability>(CAP_KEY, () => autohdr.capabilities(), force);
}

export async function modelCatalog(force = false): Promise<AutohdrModel[] | null> {
  return cached<AutohdrModel>(MODEL_KEY, () => autohdr.models("all"), force);
}

export async function catalogReadAt(): Promise<Date | null> {
  const hit = await getSetting<Cached<unknown> | null>(CAP_KEY, null);
  return hit?.at ? new Date(hit.at) : null;
}
