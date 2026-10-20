import "server-only";

// ---------------------------------------------------------------------------
// Script Studio integration — Jordan's external script-generator/tracker
// (its own app). Machine-to-machine JSON API under `/api/v1`, bearer-auth.
//
// The hub is the single source of truth: it CREATES a Studio project (passing
// its own project id as `external_id`, the dedupe key), then reads the generated
// hooks/script back into the reel recipe. Inbound Studio webhooks (see
// /api/webhooks/scripting) are the fast-path; a GET is the source of truth.
//
// Config is pure env (like Google app creds) so a rotated key just
// works and nothing sensitive ever lands in source or the DB:
//   SCRIPTING_BASE_URL  — the Studio app's base URL (e.g. https://…vercel.app)
//   SCRIPTING_API_KEY   — the bearer key the Studio checks on /api/v1 requests
// ---------------------------------------------------------------------------

const BASE = (process.env.SCRIPTING_BASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SCRIPTING_API_KEY || "";

export class ScriptingError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ScriptingError";
  }
}

// True once both the base URL and API key are set — the UI hides the Script
// Studio panel until then, and every call no-ops safely.
export function scriptingConfigured(): boolean {
  return Boolean(BASE && KEY);
}

// One known Studio status → is the script far enough along to pull/review?
const READY_STATUSES = new Set([
  "hooks_proposed", "generating", "awaiting_review", "approved",
  "sent_to_client", "done", "client_approved", "client_revision_requested", "revising",
]);

// JSON-in/JSON-out wrapper. Errors surface as `{ error }` with a 4xx/5xx.
async function sc<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!scriptingConfigured()) throw new ScriptingError("Script Studio is not configured.", 500);
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
    // The auto-sync runs on edit-page render — a hung Studio must degrade to
    // "no script yet", never hold the page (or a cron step) hostage.
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : undefined; } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error || `Script Studio ${path} ${res.status}`;
    throw new ScriptingError(msg, res.status);
  }
  return json as T;
}

// The Studio project shape we care about (loose — the API returns more).
export type StudioProject = {
  id: string;
  external_id?: string | null;
  aryeo_order_id?: string | null;
  updated_at?: string | null;
  appointment_date?: string | null;
  status?: string;
  client_name?: string;
  address?: string;
  video_type?: string;
  intake_url?: string;
  deduped?: boolean;
  links?: Record<string, string> | null;
  hooks?: unknown;
  script?: unknown;
  client_response?: unknown;
  intake?: unknown;
  script_version?: unknown;
  on_site_script?: unknown;
};

export type CreateStudioInput = {
  externalId: string; // the hub project id (dedupe key)
  clientName: string;
  address: string;
  clientEmail?: string | null;
  clientFirstName?: string | null;
  city?: string | null;
  appointmentDate?: Date | null;
  assignedCreative?: string | null;
  videoType?: "listing" | "viral";
  brandWords?: string | null;
};

// Create (or dedupe to the existing) Studio project for a hub job. Returns the
// project + whether it already existed (`deduped`).
export async function scriptingCreateProject(input: CreateStudioInput): Promise<StudioProject> {
  const body: Record<string, unknown> = {
    client_name: input.clientName,
    address: input.address,
    external_id: input.externalId,
    external_source: "ops-hub",
    video_type: input.videoType ?? "listing",
    video_goal: input.videoType ?? "listing",
  };
  if (input.clientEmail) body.client_email = input.clientEmail;
  if (input.clientFirstName) body.client_first_name = input.clientFirstName;
  if (input.city) body.city = input.city;
  if (input.appointmentDate) body.appointment_date = input.appointmentDate.toISOString();
  if (input.assignedCreative) body.assigned_creative = input.assignedCreative;
  if (input.brandWords) body.brand_words = input.brandWords;
  const r = await sc<unknown>("/projects", { method: "POST", body });
  return unwrap(r) as StudioProject;
}

// Full detail for a Studio project addressed by the HUB's id (external_id).
// The detail endpoint wraps the record as { project: {...} } — normalize it flat.
export async function scriptingGetByExternalId(hubProjectId: string): Promise<StudioProject> {
  const r = await sc<unknown>(`/projects/${encodeURIComponent(hubProjectId)}?by=external_id`);
  return unwrap(r) as StudioProject;
}

// Reconcile: projects changed at/after `sinceIso` (source of truth for webhooks).
export async function scriptingListSince(sinceIso: string, limit = 100): Promise<StudioProject[]> {
  const r = await sc<{ projects?: StudioProject[] }>(`/projects?since=${encodeURIComponent(sinceIso)}&limit=${limit}`);
  return r.projects ?? [];
}

// Every project, newest first (the platform caps a page at 200; it held 83 on
// Oct 20 2026). `since` filters on created_at, so a reconcile that must see
// CHANGES to older projects reads the whole list and compares updated_at.
export async function scriptingListAll(limit = 200): Promise<StudioProject[]> {
  const r = await sc<{ projects?: StudioProject[] }>(`/projects?limit=${limit}`);
  return r.projects ?? [];
}

/**
 * Full detail for a hub job, however the platform knows it (Oct 20 2026).
 * Most projects come from Aryeo bookings and carry only aryeo_order_id; the
 * ones the hub created carry its id as external_id; a stored scripting id
 * works for either. Tried in that order; a 404 moves to the next; null when
 * the platform has no project for the job.
 */
export async function scriptingGetDetail(ref: { aryeoOrderId?: string | null; hubId?: string | null; scriptingId?: string | null }): Promise<StudioProject | null> {
  const tries: string[] = [];
  if (ref.aryeoOrderId) tries.push(`/projects/${encodeURIComponent(ref.aryeoOrderId)}?by=aryeo_order_id`);
  if (ref.hubId) tries.push(`/projects/${encodeURIComponent(ref.hubId)}?by=external_id`);
  if (ref.scriptingId) tries.push(`/projects/${encodeURIComponent(ref.scriptingId)}`);
  for (const path of tries) {
    try {
      return unwrap(await sc<unknown>(path)) as StudioProject;
    } catch (e) {
      if (e instanceof ScriptingError && e.status === 404) continue;
      throw e;
    }
  }
  return null;
}

// --- Tolerant extraction (the exact nested shapes are confirmed against a live
// payload; these read the documented + likely spots and no-op on anything else).

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}
function at(o: unknown, ...keys: string[]): unknown {
  let cur = o;
  for (const k of keys) cur = cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

// The detail endpoint wraps the record as { project: {...} }; list/create return
// it flat. Normalize to the flat project object either way.
function unwrap(raw: unknown): Record<string, unknown> {
  const r = raw as Record<string, unknown> | null;
  if (r && typeof r === "object" && r.project && typeof r.project === "object") return r.project as Record<string, unknown>;
  return (r ?? {}) as Record<string, unknown>;
}

// The chosen hook text: chosen_hook when a hook is picked, else the recommended
// option. Handles options being strings or {hook/text/...} objects.
function chosenHookText(hooks: unknown): string | null {
  if (typeof hooks === "string") return hooks.trim() || null;
  if (!hooks || typeof hooks !== "object") return null;
  const h = hooks as Record<string, unknown>;
  const chosen = firstString(h.chosen_hook, at(h, "chosen", "text"), h.chosen, at(h, "selected", "text"));
  if (chosen) return chosen;
  const opts = Array.isArray(h.options) ? h.options : [];
  const idx = typeof h.recommended_index === "number" ? h.recommended_index : 0;
  const o = opts[idx] ?? opts[0];
  if (typeof o === "string") return o.trim() || null;
  return firstString(at(o, "hook"), at(o, "text"), at(o, "hook_text"), at(o, "line"), at(o, "value"));
}

// The best single link to open in the Studio for a project, given its status.
// Real link keys: intake_url (agent form) · creative_url (tokenized script view)
// · admin_url (Jordan's console).
export function studioBestLink(raw: StudioProject | unknown): string | null {
  const p = unwrap(raw);
  const links = (p.links ?? {}) as Record<string, string>;
  const creative = firstString(links.creative_url, links.creative);
  const intake = firstString(p.intake_url, links.intake_url, links.intake);
  const admin = firstString(links.admin_url, links.admin);
  const ready = READY_STATUSES.has(String(p.status ?? ""));
  // Once a script exists, the creative page shows it; before that, the intake form.
  return (ready ? creative || intake || admin : intake || creative || admin) || creative || intake || admin || null;
}

/**
 * What the platform says the crew is shooting, and the versions around it
 * (Oct 20 2026). The CREW script is `on_site_script` when the creative changed
 * the released script on the shoot link (Edit or Revise with AI), else
 * `script` (released to the creative, else delivered to the agent, else
 * approved). A draft waiting on Jordan's review is never in the detail at all
 * (`script` is null while only a draft exists): the hub shows it as a status.
 */
export type StudioSnapshot = {
  studioId: string | null;
  status: string | null;
  updatedAt: Date | null;
  url: string | null;
  hook: string | null;
  song: string | null;
  crew: { text: string; version: number | null; at: Date | null; onSiteBy: string | null } | null;
  /** The version the agent received, when the detail says so (its delivered_at). */
  client: { version: number | null; sentAt: Date } | null;
};

function asDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function asInt(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null;
}

export function studioSnapshot(raw: StudioProject | unknown): StudioSnapshot {
  const p = unwrap(raw);
  const onSite = p.on_site_script && typeof p.on_site_script === "object" ? (p.on_site_script as Record<string, unknown>) : null;
  const script = p.script && typeof p.script === "object" ? (p.script as Record<string, unknown>) : null;
  const sv = p.script_version && typeof p.script_version === "object" ? (p.script_version as Record<string, unknown>) : null;
  const onSiteText = onSite ? firstString(onSite.raw) : null;
  const scriptText = script ? firstString(script.raw) : typeof p.script === "string" ? firstString(p.script) : null;
  const crew = onSiteText
    ? { text: onSiteText, version: asInt(onSite!.version_number), at: asDate(onSite!.generated_at), onSiteBy: firstString(onSite!.edited_by) ?? "creative" }
    : scriptText
      ? { text: scriptText, version: asInt(sv?.version_number), at: asDate(sv?.delivered_at) ?? asDate(sv?.approved_at) ?? asDate(script?.generated_at), onSiteBy: null }
      : null;
  const crewSource = onSiteText ? onSite : script;
  const firstOption = (o: Record<string, unknown> | null) => (o && Array.isArray(o.options) ? (o.options[0] as Record<string, unknown> | undefined) : undefined);
  const hook = firstString(firstOption(crewSource)?.hook) ?? chosenHookText(p.hooks) ?? firstString(at(p, "script", "hook"));
  const songLine = crew ? crew.text.match(/(?:^|\n)\s*(?:\*{0,2})song(?:\*{0,2})\s*[:\-–—]\s*(.+)/i)?.[1]?.trim() : null;
  const song = firstString(crewSource?.song, at(p, "script", "song"), at(p, "intake", "answers", "song"), at(p, "intake", "answers", "music"), songLine);
  const delivered = asDate(sv?.delivered_at);
  return {
    studioId: p.id ? String(p.id) : null,
    status: p.status ? String(p.status) : null,
    updatedAt: asDate(p.updated_at),
    url: studioBestLink(p),
    hook,
    song,
    crew,
    client: delivered ? { version: asInt(sv?.version_number), sentAt: delivered } : null,
  };
}

/**
 * The snapshot an EVENT carries on its own, when it carries the crew script
 * (Oct 20 2026): `project.script_updated` (the creative changed the script on
 * the shoot link) and `project.updated` on a release to the creative. Saves a
 * round trip inside the platform's 5-second webhook timeout. Null for every
 * other event: those are read back with a GET.
 */
export function studioSnapshotFromEvent(event: string, data: StudioProject & Record<string, unknown>): StudioSnapshot | null {
  const change = data.change && typeof data.change === "object" ? (data.change as Record<string, unknown>) : null;
  const release = event === "project.updated" && change?.kind === "released_to_creative";
  if (event !== "project.script_updated" && !release) return null;
  const script = data.script && typeof data.script === "object" ? (data.script as Record<string, unknown>) : null;
  const text = script ? firstString(script.raw) : null;
  if (!text) return null;
  const sv = data.script_version && typeof data.script_version === "object" ? (data.script_version as Record<string, unknown>) : null;
  const opt = Array.isArray(script!.options) ? (script!.options[0] as Record<string, unknown> | undefined) : undefined;
  return {
    studioId: data.id ? String(data.id) : null,
    status: data.status ? String(data.status) : null,
    updatedAt: asDate(data.updated_at),
    url: null,
    hook: firstString(opt?.hook),
    song: firstString(script!.song),
    crew: { text, version: asInt(sv?.version_number), at: asDate(sv?.created_at) ?? asDate(script!.generated_at) ?? new Date(), onSiteBy: release ? null : firstString(change?.by) ?? "creative" },
    client: null,
  };
}

// Map a Studio detail → the fields we mirror into the reel recipe. Only returns
// what it actually found, so a partial payload never blanks existing recipe data.
export function studioToRecipe(raw: StudioProject): { hook?: string; script?: string; song?: string; url?: string; status?: string } {
  const p = unwrap(raw);
  const hook = chosenHookText(p.hooks) ?? firstString(at(p, "script", "hook"));
  // Script markdown lives at script.raw (also handle raw_ai_output / a bare string).
  const script = firstString(
    typeof p.script === "string" ? p.script : null,
    at(p, "script", "raw"), at(p, "script", "raw_ai_output"), at(p, "script", "markdown"),
    at(p, "script", "text"), at(p, "script", "body"),
  );
  // Song: the dedicated script.song field, else a SONG: line inside the script.
  const songLine = script ? script.match(/(?:^|\n)\s*(?:\*{0,2})song(?:\*{0,2})\s*[:\-–—]\s*(.+)/i)?.[1]?.trim() : null;
  const song = firstString(at(p, "script", "song"), at(p, "intake", "answers", "song"), at(p, "intake", "answers", "music"), at(p, "song"), songLine);
  const url = studioBestLink(p) ?? undefined;
  const out: { hook?: string; script?: string; song?: string; url?: string; status?: string } = {};
  if (hook) out.hook = hook;
  if (script) out.script = script;
  if (song) out.song = song;
  if (url) out.url = url;
  if (p.status) out.status = String(p.status);
  return out;
}
