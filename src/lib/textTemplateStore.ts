import "server-only";
import { prisma } from "@/lib/prisma";
import {
  TEXT_TEMPLATES, TEXT_TEMPLATE_KEYS, TEXT_TEMPLATE_SETTING_PREFIX, DEFAULT_TEXTS,
  checkTemplateBody, isTextTemplateKey, templateSet, textTemplateSettingKey,
  type TemplateOverride, type TemplateSource, type TemplateVars, type TextTemplateKey, type TextTemplateSet,
} from "@/lib/textTemplates";

// ---------------------------------------------------------------------------
// THE SAVED WORDING (Oct 21 2026), the server half of lib/textTemplates.ts.
//
// Each edited template is one AppSetting row, `text_template:<key>`, holding
// {"body": …, "by": "<name>"}; the row's own updatedAt / updatedBy say when
// and who. No row = the default. No schema change.
//
// FIVE CLIENT TEXTS HAD BOXES BEFORE THIS (the old "Text wording" card and the
// welcome box under Automated texts). Whatever was saved there is still sent
// exactly as it was, until Jordan saves or resets that template here, which
// replaces it and empties the old box:
//   client_confirmation       ← text_templates.confirmation
//   client_delivery_feedback  ← text_templates.deliveryAll
//   client_delivery_partial   ← text_templates.deliveryPartial (Oct 22 2026:
//                               the part-delivered text a Send button sends)
//   client_welcome            ← auto_texts.welcome.message
//   client_after_hours        ← auto_texts.afterHours.message
//
// Read once per minute per server (the same 60-second rule as every other
// setting), so a saved change reaches the next text within a minute. A read
// that fails never stops a text: the defaults go.
// ---------------------------------------------------------------------------

type Legacy = { setting: "text_templates"; field: "confirmation" | "deliveryAll" | "deliveryPartial" } | { setting: "auto_texts"; field: "welcome" | "afterHours" };
const LEGACY: Partial<Record<TextTemplateKey, Legacy>> = {
  client_confirmation: { setting: "text_templates", field: "confirmation" },
  client_delivery_feedback: { setting: "text_templates", field: "deliveryAll" },
  client_delivery_partial: { setting: "text_templates", field: "deliveryPartial" },
  client_welcome: { setting: "auto_texts", field: "welcome" },
  client_after_hours: { setting: "auto_texts", field: "afterHours" },
};
const LEGACY_WHERE: Record<Legacy["setting"], string> = {
  text_templates: "the old Text wording box",
  auto_texts: "the old box under Automated texts",
};

type SavedRow = { body: string; byName: string | null; byEmail: string | null; at: Date };

async function readSaved(): Promise<Map<TextTemplateKey, SavedRow>> {
  const out = new Map<TextTemplateKey, SavedRow>();
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: TEXT_TEMPLATE_SETTING_PREFIX } },
    select: { key: true, value: true, updatedAt: true, updatedBy: true },
  });
  for (const r of rows) {
    const key = r.key.slice(TEXT_TEMPLATE_SETTING_PREFIX.length);
    if (!isTextTemplateKey(key)) continue;
    try {
      const v = JSON.parse(r.value) as { body?: unknown; by?: unknown };
      if (typeof v.body !== "string") continue;
      out.set(key, { body: v.body, byName: typeof v.by === "string" ? v.by : null, byEmail: r.updatedBy, at: r.updatedAt });
    } catch { /* an unreadable row is no saved wording */ }
  }
  return out;
}

/** What the old boxes hold, exactly as the senders used it before Oct 21 2026
 *  (both reads go through lib/settings, which never throws). A box that is
 *  empty, or holds the default word for word, is no wording of its own. */
async function readLegacy(): Promise<Partial<Record<TextTemplateKey, { body: string; where: string }>>> {
  const { textTemplates, autoTextRules } = await import("@/lib/settings");
  const [tt, at] = await Promise.all([textTemplates(), autoTextRules()]);
  const out: Partial<Record<TextTemplateKey, { body: string; where: string }>> = {};
  const put = (key: TextTemplateKey, body: string) => {
    const l = LEGACY[key]!;
    if (body.trim() && body.trim() !== TEXT_TEMPLATES[key].body) out[key] = { body, where: LEGACY_WHERE[l.setting] };
  };
  put("client_confirmation", tt.confirmation);
  put("client_delivery_feedback", tt.deliveryAll);
  put("client_delivery_partial", tt.deliveryPartial);
  put("client_welcome", at.welcome.message);
  put("client_after_hours", at.afterHours.message);
  return out;
}

// Only the rows saved HERE are cached by this module; the old boxes are read
// through lib/settings each time, whose own one-minute cache a putSetting
// clears, so a write there is never hidden behind a second cache.
const TTL = 60_000;
let cache: { at: number; rows: Map<TextTemplateKey, SavedRow> } | null = null;
async function savedRows(): Promise<Map<TextTemplateKey, SavedRow>> {
  if (cache && Date.now() - cache.at < TTL) return cache.rows;
  const rows = await readSaved();
  cache = { at: Date.now(), rows };
  return rows;
}
// A saved wording that fails the checks is logged once per server, not on
// every five-minute tick.
const warned = new Set<string>();
const warnOnce = (message: string) => {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
};

/** The wording every automatic text sends right now. Never throws: a read
 *  that fails sends the defaults (and an old box's wording, when that read). */
export async function loadTextTemplates(): Promise<TextTemplateSet> {
  const overrides: Partial<Record<TextTemplateKey, TemplateOverride>> = {};
  try {
    const legacy = await readLegacy();
    for (const [k, v] of Object.entries(legacy)) overrides[k as TextTemplateKey] = { body: v.body, legacy: true };
  } catch (e) {
    console.warn("text templates: the old wording boxes could not be read", e);
  }
  try {
    for (const [k, v] of await savedRows()) overrides[k] = { body: v.body };
  } catch (e) {
    console.warn("text templates: the saved wording could not be read, sending the defaults", e);
  }
  return Object.keys(overrides).length ? templateSet(overrides, warnOnce) : DEFAULT_TEXTS;
}

/** Fill one template with the wording in use right now. */
export async function renderText<K extends TextTemplateKey>(key: K, vars: TemplateVars<K>): Promise<string> {
  return (await loadTextTemplates()).render(key, vars);
}

// ---- Settings → Text messages ---------------------------------------------------

export type TextTemplateRow = {
  key: TextTemplateKey;
  /** The wording saved here, with who and when. */
  saved: { body: string; by: string | null; atISO: string } | null;
  /** Why the saved wording is not being sent (it fails a check), else null. */
  savedProblems: string[] | null;
  /** Wording from an old box that is still being sent, until saved or reset here. */
  legacy: { body: string; where: string } | null;
  /** What goes out now. */
  source: TemplateSource;
};

export async function textTemplateRows(): Promise<TextTemplateRow[]> {
  const [saved, legacy] = await Promise.all([readSaved(), readLegacy().catch(() => ({}) as Awaited<ReturnType<typeof readLegacy>>)]);
  return TEXT_TEMPLATE_KEYS.map((key) => {
    const s = saved.get(key) ?? null;
    const check = s ? checkTemplateBody(key, s.body) : null;
    const l = s ? null : (legacy[key] ?? null);
    const source: TemplateSource = s && check?.ok ? "saved" : l ? "legacy" : "default";
    return {
      key,
      saved: s ? { body: s.body, by: s.byName ?? s.byEmail, atISO: s.at.toISOString() } : null,
      savedProblems: check && !check.ok ? check.problems : null,
      legacy: l,
      source,
    };
  });
}

/** Empty the old box behind a template, so Reset means the default and a save
 *  here is the only wording. Only that one field changes. */
async function clearLegacy(key: TextTemplateKey, by: string | null): Promise<void> {
  const l = LEGACY[key];
  if (!l) return;
  const row = await prisma.appSetting.findUnique({ where: { key: l.setting }, select: { value: true } });
  if (!row) return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(row.value) as Record<string, unknown>;
  } catch {
    return; // unreadable: the senders already read it as the default
  }
  const { putSetting } = await import("@/lib/settings");
  if (l.setting === "text_templates") {
    if (typeof raw[l.field] !== "string" || !(raw[l.field] as string)) return;
    await putSetting(l.setting, { ...raw, [l.field]: "" }, by);
    return;
  }
  const part = raw[l.field];
  if (!part || typeof part !== "object" || typeof (part as { message?: unknown }).message !== "string" || !(part as { message: string }).message) return;
  await putSetting(l.setting, { ...raw, [l.field]: { ...(part as object), message: "" } }, by);
}

/** The welcome and after-hours wording exactly as stored in auto_texts ("" for
 *  none), so saving the Automated texts rules carries them through untouched:
 *  their wording is edited here now, not in that form. */
export async function storedAutoTextMessages(): Promise<{ welcome: string; afterHours: string }> {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: "auto_texts" }, select: { value: true } });
    const raw = row ? (JSON.parse(row.value) as { welcome?: { message?: unknown }; afterHours?: { message?: unknown } }) : {};
    return {
      welcome: typeof raw.welcome?.message === "string" ? raw.welcome.message : "",
      afterHours: typeof raw.afterHours?.message === "string" ? raw.afterHours.message : "",
    };
  } catch {
    return { welcome: "", afterHours: "" };
  }
}

export type TemplateSaveResult = { ok: true; message: string } | { ok: false; message: string; problems: string[] };

/** Save a wording. Refused unless it passes every check; the default word
 *  for word is the same as Reset. */
export async function saveTextTemplate(key: TextTemplateKey, body: string, by: { email: string | null; name: string | null }): Promise<TemplateSaveResult> {
  const text = String(body ?? "").replace(/\r\n?/g, "\n").trim();
  const check = checkTemplateBody(key, text);
  if (!check.ok) return { ok: false, message: "Not saved.", problems: check.problems };
  if (text === TEXT_TEMPLATES[key].body) {
    await resetTextTemplate(key, by);
    return { ok: true, message: "That is the default wording, so the default is in use." };
  }
  await prisma.appSetting.upsert({
    where: { key: textTemplateSettingKey(key) },
    create: { key: textTemplateSettingKey(key), value: JSON.stringify({ body: text, by: by.name ?? by.email }), updatedBy: by.email },
    update: { value: JSON.stringify({ body: text, by: by.name ?? by.email }), updatedBy: by.email },
  });
  cache = null;
  await clearLegacy(key, by.email);
  return { ok: true, message: "Saved. The next text uses this wording (within a minute)." };
}

/** Back to the default: the saved wording and any old-box wording both go. */
export async function resetTextTemplate(key: TextTemplateKey, by: { email: string | null; name: string | null }): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: textTemplateSettingKey(key) } });
  cache = null;
  await clearLegacy(key, by.email);
}

/** Drills only: forget the cached wording. */
export function forgetTextTemplateCache(): void {
  cache = null;
}
