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
// Config is pure env (like Google/Frame.io app creds) so a rotated key just
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
  return sc<StudioProject>("/projects", { method: "POST", body });
}

// Full detail for a Studio project addressed by the HUB's id (external_id).
export async function scriptingGetByExternalId(hubProjectId: string): Promise<StudioProject> {
  return sc<StudioProject>(`/projects/${encodeURIComponent(hubProjectId)}?by=external_id`);
}

// Reconcile: projects changed at/after `sinceIso` (source of truth for webhooks).
export async function scriptingListSince(sinceIso: string, limit = 100): Promise<StudioProject[]> {
  const r = await sc<{ projects?: StudioProject[] }>(`/projects?since=${encodeURIComponent(sinceIso)}&limit=${limit}`);
  return r.projects ?? [];
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

// The best single link to open in the Studio for a project, given its status.
export function studioBestLink(p: StudioProject): string | null {
  const links = (p.links ?? {}) as Record<string, string>;
  const review = firstString(links.review, links.review_url, links.client, links.client_url, at(p, "review_url"));
  const intake = firstString(p.intake_url, links.intake, links.intake_url, at(p, "links", "intake"));
  const ready = READY_STATUSES.has(String(p.status ?? ""));
  return (ready ? review || intake : intake || review) || review || intake;
}

// Map a Studio detail → the fields we mirror into the reel recipe. Only returns
// what it actually found, so a partial payload never blanks existing recipe data.
export function studioToRecipe(p: StudioProject): { hook?: string; script?: string; song?: string; url?: string; status?: string } {
  const hook = firstString(
    at(p, "hooks", "chosen", "text"), at(p, "hooks", "chosen_hook"), at(p, "hooks", "chosen"),
    at(p, "hooks", "selected", "text"), at(p, "script", "hook"),
  );
  const script = firstString(at(p, "script", "raw"), at(p, "script", "markdown"), at(p, "script", "text"), at(p, "script", "body"));
  const song = firstString(at(p, "script", "song"), at(p, "intake", "answers", "song"), at(p, "intake", "answers", "music"), at(p, "song"));
  const url = studioBestLink(p) ?? undefined;
  const out: { hook?: string; script?: string; song?: string; url?: string; status?: string } = {};
  if (hook) out.hook = hook;
  if (script) out.script = script;
  if (song) out.song = song;
  if (url) out.url = url;
  if (p.status) out.status = String(p.status);
  return out;
}
