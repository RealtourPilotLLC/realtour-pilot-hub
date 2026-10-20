import "server-only";

import { getConnection, getSecret } from "@/lib/integrations/connections";
import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// ARYEO, THE WAY KYLE'S BROWSER DOES IT (Oct 14 2026).
//
// Jordan: "Is there any way to automate the file upload and delivery on
// Aryeo? There has to be." Aryeo's public API (v1) cannot put a photo on a
// listing or deliver it, and the v2 API that can (ingest-intents, deliveries)
// answers 401 to our key: it needs partner access, asked for separately. So
// the hub does what the web app does, signed in as its own Aryeo team login
// (Connections → Aryeo hub login; Jordan enters the password, never Claude):
//   1. sign in at app.aryeo.com/login (a Laravel + Inertia app: session
//      cookie, XSRF header), the session kept ENCRYPTED and reused;
//   2. send each photo to Uploadcare with Aryeo's own public upload key (read
//      from Aryeo's page), then make one Uploadcare group of them, in order;
//   3. POST admin/listing/{id}/image-uploads {form_uuid_field: <group>}, the
//      call the listing editor makes after its upload widget finishes;
//   4. optionally PUT admin/listing/{id}/images to set the order;
//   5. POST admin/listings/{id}/deliver with the deliver form's own defaults
//      (no added recipients: the listing's customers get Aryeo's usual email).
// Everything is read back through the public API before the hub believes it.
// The shapes were read from Aryeo's web app code on Oct 14 2026 (route table
// in the login page, the listing editor's script). It is not a published
// API: when Aryeo changes its app, a call can start failing, and every
// failure says so in plain words instead of guessing.
// ---------------------------------------------------------------------------

export const ARYEO_WEB_PROVIDER = "aryeo_web";
const APP = "https://app.aryeo.com";
const SESSION_KEY = "aryeo_web:session";
const UPLOADCARE = "https://upload.uploadcare.com";
const UA = "RealtourPilotHub/1.0 (+https://hub.realtourpilot.com)";

/** The company's admin host (listing pages live there; the session cookie covers *.aryeo.com). */
export function aryeoAdminOrigin(): string {
  const base = (process.env.ARYEO_ADMIN_BASE || "https://realtourpilot.aryeo.com/admin").replace(/\/+$/, "");
  return new URL(base).origin;
}

export type AryeoWebFailure = "not-connected" | "sign-in" | "refused" | "changed" | "transient";
export class AryeoWebError extends Error {
  constructor(message: string, public kind: AryeoWebFailure) {
    super(message);
    this.name = "AryeoWebError";
  }
}

type Jar = Record<string, string>;
type Session = { cookies: Jar; version: string | null; at: string; email: string };

// ---- the login and the session ---------------------------------------------------------------

/** The hub's Aryeo login, or null. The password is the connection's secret; the email is in its metadata. */
export async function aryeoWebCredentials(): Promise<{ email: string; password: string } | null> {
  const conn = await getConnection(ARYEO_WEB_PROVIDER).catch(() => null);
  const password = await getSecret(ARYEO_WEB_PROVIDER).catch(() => null);
  let email: unknown = null;
  try {
    email = conn?.metadata ? (JSON.parse(conn.metadata) as { email?: unknown }).email : null;
  } catch {
    email = null;
  }
  return password && typeof email === "string" && email.includes("@") ? { email, password } : null;
}

async function loadSession(): Promise<Session | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SESSION_KEY }, select: { value: true } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(decryptSecret(JSON.parse(row.value) as string)) as Session;
  } catch {
    return null;
  }
}

async function saveSession(s: Session | null): Promise<void> {
  if (!s) {
    await prisma.appSetting.deleteMany({ where: { key: SESSION_KEY } }).catch(() => {});
    return;
  }
  const value = JSON.stringify(encryptSecret(JSON.stringify(s)));
  await prisma.appSetting.upsert({ where: { key: SESSION_KEY }, create: { key: SESSION_KEY, value, updatedBy: "aryeo-web" }, update: { value, updatedBy: "aryeo-web" } });
}

/** Forget the stored session (a new login, a disconnect). */
export async function forgetAryeoWebSession(): Promise<void> {
  await saveSession(null);
}

function takeCookies(jar: Jar, res: Response): void {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const line of list) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "deleted";
    if (gone) delete jar[name];
    else jar[name] = value;
  }
}

const cookieHeader = (jar: Jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
const xsrf = (jar: Jar) => (jar["XSRF-TOKEN"] ? decodeURIComponent(jar["XSRF-TOKEN"]) : "");

/** The Inertia page object embedded in an HTML page (data-page), or null. */
function pageFromHtml(html: string): { component?: string; version?: string; props?: Record<string, unknown> } | null {
  const m = /data-page="([^"]+)"/.exec(html);
  if (!m) return null;
  const raw = m[1].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  try {
    return JSON.parse(raw) as { component?: string; version?: string; props?: Record<string, unknown> };
  } catch {
    return null;
  }
}

let uploadcareKeyCache: { key: string; at: number } | null = null;
let uploadcareVideoKeyCache: { key: string; at: number } | null = null;

async function fetchLoginPage(jar: Jar): Promise<{ version: string | null; uploadcareKey: string | null; uploadcareVideoKey: string | null }> {
  const res = await fetch(`${APP}/login`, { headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookieHeader(jar) }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  takeCookies(jar, res);
  const html = await res.text();
  const page = pageFromHtml(html);
  const key = /UPLOADCARE_PUBLIC_KEY\s*=\s*"([a-f0-9]+)"/.exec(html)?.[1] ?? null;
  if (key) uploadcareKeyCache = { key, at: Date.now() };
  // Videos go to a DIFFERENT Uploadcare project (Oct 19 2026): the listing
  // editor's Add Video window uses window.ARYEO_UPLOADCARE_VIDEO_PUBLIC_KEY.
  // A public key (it is on Aryeo's login page), not a secret.
  const videoKey = /UPLOADCARE_VIDEO_PUBLIC_KEY\s*=\s*"([a-f0-9]+)"/.exec(html)?.[1] ?? null;
  if (videoKey) uploadcareVideoKeyCache = { key: videoKey, at: Date.now() };
  return { version: page?.version ?? null, uploadcareKey: key, uploadcareVideoKey: videoKey };
}

/** Sign in fresh. Throws AryeoWebError("sign-in") with Aryeo's own words when it refuses. */
export async function signIn(creds?: { email: string; password: string } | null): Promise<Session> {
  const c = creds ?? (await aryeoWebCredentials());
  if (!c) throw new AryeoWebError("The hub's Aryeo login is not set up. Jordan adds it on Connections → Aryeo hub login.", "not-connected");
  const jar: Jar = {};
  const { version } = await fetchLoginPage(jar);
  if (!jar["XSRF-TOKEN"]) throw new AryeoWebError("Aryeo's sign-in page did not answer as expected (no security cookie). Aryeo may have changed its sign-in.", "changed");
  const res = await fetch(`${APP}/login`, {
    method: "POST",
    headers: inertiaHeaders(jar, version, true),
    body: JSON.stringify({ email: c.email.toLowerCase(), password: c.password }),
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  takeCookies(jar, res);
  if (res.status === 419) throw new AryeoWebError("Aryeo refused the sign-in's security check (419). Aryeo may have changed its sign-in.", "changed");
  if (res.status >= 500) throw new AryeoWebError(`Aryeo's sign-in failed on Aryeo's side (${res.status}). It is tried again later.`, "transient");
  // Follow Aryeo all the way, the way a browser does: after the password it
  // goes to the company picker (/companies), which puts the company on the
  // session, then to the dashboard. Stopping after the password left a
  // session with no company, and every listing page bounced back to the login
  // (seen live, Oct 14, Bob Kelley's push).
  const end = await followRedirects(jar, version, res, `${APP}/login`);
  if (!end.page || /Login/i.test(end.page.component) || /\/login(\b|\/|\?|$)/.test(new URL(end.url).pathname)) {
    const reason = Object.values((end.page?.props?.errors as Record<string, unknown> | undefined) ?? {}).flat().filter((x) => typeof x === "string").join(" ");
    throw new AryeoWebError(`Aryeo did not accept the hub's login${reason ? `: ${reason}` : ""}. Check the email and password on Connections → Aryeo hub login.`, "sign-in");
  }
  const s: Session = { cookies: jar, version, at: new Date().toISOString(), email: c.email };
  await saveSession(s);
  // Signed in: a "Sign-in failing" left on Connections from an earlier try is over.
  if (!creds) {
    const { getConnection, markSynced } = await import("@/lib/integrations/connections");
    const conn = await getConnection(ARYEO_WEB_PROVIDER).catch(() => null);
    if (conn?.lastError) await markSynced(ARYEO_WEB_PROVIDER).catch(() => {});
  }
  return s;
}

/** Where a response sends the browser next: Location, or Inertia's 409 + X-Inertia-Location. */
function nextHop(res: Response, from: string): string | null {
  const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : res.status === 409 ? res.headers.get("x-inertia-location") : null;
  return to ? new URL(to, from).toString() : null;
}

/** Follow redirects with Inertia GETs (cookies kept), up to 6 hops; returns the page the chain ends on. */
async function followRedirects(jar: Jar, version: string | null, first: Response, from: string): Promise<{ res: Response; url: string; page: InertiaPage | null }> {
  let res = first;
  let url = from;
  for (let hop = 0; hop < 6; hop++) {
    const to = nextHop(res, url);
    if (!to) break;
    url = to;
    res = await fetch(url, { headers: inertiaHeaders(jar, version, false, url), redirect: "manual", signal: AbortSignal.timeout(60_000) });
    takeCookies(jar, res);
  }
  const page = res.headers.get("content-type")?.includes("json") ? ((await res.clone().json().catch(() => null)) as InertiaPage | null) : null;
  return { res, url, page: page?.component ? page : null };
}

function inertiaHeaders(jar: Jar, version: string | null, json: boolean, referer?: string, extra?: Record<string, string>): Record<string, string> {
  const origin = referer ? new URL(referer).origin : APP;
  return {
    "User-Agent": UA,
    // A browser always says where a request comes from; Aryeo sends a change
    // without it to the login page (seen live Oct 14: Deliver Listing).
    Origin: origin,
    Referer: referer ?? `${origin}/`,
    ...(extra ?? {}),
    Accept: "text/html, application/xhtml+xml",
    "X-Requested-With": "XMLHttpRequest",
    "X-Inertia": "true",
    ...(version ? { "X-Inertia-Version": version } : {}),
    ...(json ? { "Content-Type": "application/json" } : {}),
    "X-XSRF-TOKEN": xsrf(jar),
    Cookie: cookieHeader(jar),
  };
}

type InertiaPage = { component: string; props: Record<string, unknown>; url: string; version: string | null };

/**
 * One signed-in Inertia request. GET returns the page; a form POST/PUT
 * follows Aryeo's redirect back and returns that page (its props.errors say
 * whether Aryeo accepted it). Signs in again once when the session expired.
 */
type InertiaOpts = { referer?: string; partial?: { component: string; data: string[] } };

async function inertia(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown, retried = false, opts: InertiaOpts = {}): Promise<InertiaPage> {
  let s = (await loadSession()) ?? (await signIn());
  const extra = opts.partial ? { "X-Inertia-Partial-Component": opts.partial.component, "X-Inertia-Partial-Data": opts.partial.data.join(",") } : undefined;
  const first = await fetch(url, { method, headers: inertiaHeaders(s.cookies, s.version, body !== undefined, opts.referer ?? url, extra), ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: "manual", signal: AbortSignal.timeout(60_000) });
  takeCookies(s.cookies, first);
  // A version change of Aryeo's app (409 without a location): refresh the version and try once more.
  if (first.status === 409 && !first.headers.get("x-inertia-location") && !retried) {
    const { version } = await fetchLoginPage(s.cookies);
    s = { ...s, version };
    await saveSession(s);
    return inertia(method, url, body, true, opts);
  }
  // A form answer redirects back (the page there carries the outcome); a page may redirect too.
  const end = await followRedirects(s.cookies, s.version, first, url);
  const res = end.res;
  if (/\/login(\b|\/|\?|$)/.test(new URL(end.url).pathname) || (end.page && /Login/i.test(end.page.component))) return expired();
  if (res.status === 401 || res.status === 419) return expired();
  if (res.status === 403) throw new AryeoWebError("Aryeo says the hub's login may not do that (403). Give the hub's Aryeo login admin access to listings.", "refused");
  if (res.status === 404) throw new AryeoWebError("Aryeo did not find that listing page (404). The listing may have been removed, or Aryeo changed its pages.", "changed");
  if (res.status === 422) {
    const j = (await res.json().catch(() => null)) as { errors?: Record<string, unknown>; message?: string } | null;
    throw new AryeoWebError(`Aryeo refused it: ${j?.message ?? Object.values(j?.errors ?? {}).flat().join(" ")}`.slice(0, 300), "refused");
  }
  if (res.status >= 500) throw new AryeoWebError(`Aryeo answered ${res.status}. It is tried again later.`, "transient");
  const page = end.page;
  if (!page) throw new AryeoWebError(`Aryeo answered in a way the hub does not recognise (${res.status}). Aryeo may have changed its app.`, "changed");
  await saveSession(s);
  return page;

  async function expired(): Promise<InertiaPage> {
    if (retried) throw new AryeoWebError("Aryeo signed the hub out and would not sign it back in. Check Connections → Aryeo hub login.", "sign-in");
    await saveSession(null);
    await signIn();
    // A change (add, order, delete, deliver) is NEVER sent twice: Aryeo may
    // have done it before it bounced the session (Oct 14, Bob Kelley: the
    // photos were added twice). The caller checks Aryeo and decides.
    if (method !== "GET") throw new AryeoWebError("Aryeo asked the hub to sign in again in the middle of a change. Signed back in; the hub checks the listing before doing anything else.", "transient");
    return inertia(method, url, body, true, opts);
  }
}

/** Sign in and read one listing page: the connection test (nothing is changed). */
export async function testAryeoWebLogin(creds: { email: string; password: string }): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    await signIn(creds);
    const any = await prisma.project.findFirst({ where: { aryeoListingId: { not: null } }, orderBy: { createdAt: "desc" }, select: { aryeoListingId: true } });
    if (any?.aryeoListingId) await listingPage(any.aryeoListingId);
    return { ok: true, label: `Signed in to Aryeo as ${creds.email}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ---- the listing -----------------------------------------------------------------------------

const editor = (listingId: string) => `${aryeoAdminOrigin()}/admin/listings/${encodeURIComponent(listingId)}/edit`;

export type AryeoWebImage = { id: string; title: string | null; is_live: boolean; filename: string; filename_extension: string };

function deepFind(o: unknown, key: string, depth = 0): unknown {
  if (!o || typeof o !== "object" || depth > 6) return undefined;
  if (key in (o as Record<string, unknown>)) return (o as Record<string, unknown>)[key];
  for (const v of Object.values(o as Record<string, unknown>)) {
    const f = deepFind(v, key, depth + 1);
    if (f !== undefined) return f;
  }
  return undefined;
}

/** The listing editor's page props: its images and the settings the deliver form starts from. */
export async function listingPage(listingId: string): Promise<{ images: AryeoWebImage[]; requiresMediaLicense: boolean; fulfillByDefault: boolean; timezone: string | null; delivered: boolean; recipients: { id: string; name: string }[]; component: string }> {
  const page = await inertia("GET", editor(listingId));
  const p = page.props;
  const rawImages = (p.images as { data?: unknown[] } | unknown[] | undefined) ?? (deepFind(p, "images") as unknown[] | undefined);
  const list = Array.isArray(rawImages) ? rawImages : Array.isArray((rawImages as { data?: unknown[] })?.data) ? (rawImages as { data: unknown[] }).data : [];
  const images = (list as Record<string, unknown>[])
    .filter((i) => typeof i?.id === "string")
    .map((i) => {
      // The editor's filename already carries its extension ("01-Front-Exterior.jpg" + "jpg", seen live Oct 14): keep the base only.
      const ext = String(i.filename_extension ?? "jpg").replace(/^\./, "") || "jpg";
      const name = String(i.filename ?? "");
      const base = name.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? name.slice(0, -(ext.length + 1)) : name;
      return { id: String(i.id), title: typeof i.title === "string" ? i.title : null, is_live: i.is_live !== false, filename: base, filename_extension: ext };
    });
  const company = (p.company ?? deepFind(p, "company")) as Record<string, unknown> | undefined;
  const listing = (p.listing ?? {}) as Record<string, unknown>;
  return {
    images,
    requiresMediaLicense: deepFind(p, "image_uploads_require_media_license") === true,
    fulfillByDefault: company?.default_enable_mark_orders_fulfilled === true,
    timezone: typeof company?.default_timezone === "string" ? company.default_timezone : null,
    delivered: String(listing.delivery_status ?? "").toLowerCase() === "delivered",
    // Who the Deliver Listing window lists by default: the listing's customer memberships.
    recipients: (Array.isArray(listing.customer_team_memberships) ? (listing.customer_team_memberships as Record<string, unknown>[]) : [])
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: String(m.id), name: String((m.customer_user as { full_name?: string } | undefined)?.full_name ?? "customer") })),
    component: page.component,
  };
}

/** The delivery email Aryeo fills in when the Deliver Listing window opens (subject, body, cc, bcc). */
export async function deliveryEmail(listingId: string, component: string): Promise<{ subject: string; body: string; cc: string; bcc: string }> {
  const page = await inertia("GET", editor(listingId), undefined, false, { referer: editor(listingId), partial: { component, data: ["delivery_email"] } });
  const d = (page.props.delivery_email ?? {}) as Record<string, unknown>;
  const subject = typeof d.email_subject === "string" ? d.email_subject : "";
  if (!subject) throw new AryeoWebError("Aryeo did not give its delivery email (subject) for this listing. Deliver it in Aryeo by hand.", "changed");
  return { subject, body: typeof d.email_body === "string" ? d.email_body : "", cc: typeof d.email_cc_list === "string" ? d.email_cc_list : "", bcc: typeof d.email_bcc_list === "string" ? d.email_bcc_list : "" };
}

// ---- Uploadcare (Aryeo's own upload service) ---------------------------------------------------

async function uploadcareKey(): Promise<string> {
  if (uploadcareKeyCache && Date.now() - uploadcareKeyCache.at < 6 * 3_600_000) return uploadcareKeyCache.key;
  const { uploadcareKey: key } = await fetchLoginPage({});
  if (!key) throw new AryeoWebError("Aryeo's page no longer shows its upload key. Aryeo may have changed how photos are uploaded.", "changed");
  return key;
}

/** One photo to Aryeo's Uploadcare project; returns the file's id. */
export async function uploadcareUpload(bytes: Uint8Array, filename: string): Promise<string> {
  const form = new FormData();
  form.set("UPLOADCARE_PUB_KEY", await uploadcareKey());
  form.set("UPLOADCARE_STORE", "auto");
  form.set("file", new Blob([bytes as unknown as BlobPart], { type: "image/jpeg" }), filename);
  const res = await fetch(`${UPLOADCARE}/base/`, { method: "POST", body: form, headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (!res.ok) throw new AryeoWebError(`Aryeo's upload service refused ${filename} (${res.status}: ${text.slice(0, 120)}).`, res.status >= 500 ? "transient" : "refused");
  const uuid = (JSON.parse(text) as { file?: string }).file;
  if (!uuid) throw new AryeoWebError(`Aryeo's upload service gave no id for ${filename}.`, "changed");
  return uuid;
}

/** One group of uploaded files, in order (what the web app's upload widget hands to the listing). */
export async function uploadcareGroup(uuids: string[]): Promise<string> {
  const form = new FormData();
  form.set("pub_key", await uploadcareKey());
  uuids.forEach((u, i) => form.set(`files[${i}]`, u));
  const res = await fetch(`${UPLOADCARE}/group/`, { method: "POST", body: form, headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  if (!res.ok) throw new AryeoWebError(`Aryeo's upload service would not group the photos (${res.status}: ${text.slice(0, 120)}).`, res.status >= 500 ? "transient" : "refused");
  const id = (JSON.parse(text) as { id?: string }).id;
  if (!id) throw new AryeoWebError("Aryeo's upload service gave no group id.", "changed");
  return id;
}

// ---- the three listing actions ---------------------------------------------------------------

function refusedBy(page: InertiaPage): string | null {
  const errs = page.props?.errors as Record<string, unknown> | undefined;
  const words = Object.values(errs ?? {}).flatMap((v) => (typeof v === "string" ? [v] : typeof v === "object" && v ? Object.values(v as Record<string, unknown>).filter((x): x is string => typeof x === "string") : []));
  return words.length ? words.join(" ").slice(0, 300) : null;
}

/** Put an Uploadcare group of photos on the listing (the listing editor's own call). */
export async function attachImages(listingId: string, groupId: string, opts: { agreesToMediaLicense: boolean }): Promise<void> {
  const page = await inertia("POST", `${aryeoAdminOrigin()}/admin/listing/${encodeURIComponent(listingId)}/image-uploads`, {
    form_uuid_field: groupId,
    set_captions: false,
    agrees_to_zillow_media_license: opts.agreesToMediaLicense,
  }, false, { referer: editor(listingId) });
  const no = refusedBy(page);
  if (no) throw new AryeoWebError(`Aryeo would not add the photos: ${no}`, "refused");
}

/** Set the listing's photo order (every image, in the order given). */
export async function reorderImages(listingId: string, images: AryeoWebImage[]): Promise<void> {
  const page = await inertia("PUT", `${aryeoAdminOrigin()}/admin/listing/${encodeURIComponent(listingId)}/images`, {
    images: images.map((i) => ({ id: i.id, caption: i.title, is_live: i.is_live, filename: `${i.filename}.${i.filename_extension}` })),
  }, false, { referer: editor(listingId) });
  const no = refusedBy(page);
  if (no) throw new AryeoWebError(`Aryeo would not reorder the photos: ${no}`, "refused");
}

/** Remove photos from the listing (the editor's own delete; used to undo photos the hub added twice). */
export async function deleteImages(listingId: string, imageIds: string[]): Promise<void> {
  if (!imageIds.length) return;
  const page = await inertia("DELETE", `${aryeoAdminOrigin()}/admin/listing/${encodeURIComponent(listingId)}/images`, { images: imageIds }, false, { referer: editor(listingId) });
  const no = refusedBy(page);
  if (no) throw new AryeoWebError(`Aryeo would not remove the photos: ${no}`, "refused");
}

/**
 * Deliver the listing exactly as the Deliver Listing window does when Kyle
 * presses Deliver without changing anything: Aryeo's own subject and body,
 * its cc/bcc, and the listing's customers as recipients (the window lists
 * them by default; an empty list would email nobody).
 *
 * `redeliver` (Oct 19 2026, videos): the listing was already delivered (the
 * photos go first, so every listing video is a Re-deliver), and the browser's
 * Re-deliver sends fulfill_orders true whatever the company default says.
 */
export async function deliverListing(listingId: string, opts: { fulfillOrders: boolean; timezone: string | null; redeliver?: boolean }): Promise<{ recipients: string[] }> {
  const page = await listingPage(listingId);
  const email = await deliveryEmail(listingId, page.component);
  const result = await inertia("POST", `${aryeoAdminOrigin()}/admin/listings/${encodeURIComponent(listingId)}/deliver`, {
    added_customer_ids: page.recipients.map((r) => r.id),
    added_emails: [],
    email_bcc_list: email.bcc,
    email_body: email.body,
    email_cc_list: email.cc,
    email_subject: email.subject,
    fulfill_orders: opts.redeliver ? true : opts.fulfillOrders,
    notify_via_email: true,
    schedule_date: null,
    schedule_time: null,
    schedule_timezone: opts.timezone ?? "America/New_York",
  }, false, { referer: editor(listingId) });
  const no = refusedBy(result);
  if (no) throw new AryeoWebError(`Aryeo would not deliver the listing: ${no}`, "refused");
  return { recipients: page.recipients.map((r) => r.name) };
}

// ---- videos (Oct 19 2026) --------------------------------------------------------------------
//
// Jordan: "We should be able to send the videos just like we send the photos
// to Aryeo." Read from the listing editor's Add Video window (Oct 19):
//   · its uploader is Uploadcare under a SECOND public key
//     (ARYEO_UPLOADCARE_VIDEO_PUBLIC_KEY), uploading through upload.aryeo.com
//     (Uploadcare's upload API under Aryeo's name) and naming each file by its
//     CDN address on aryeo.ucarecd.net; a file of 25 MB or more goes up in
//     5 MB parts (Uploadcare's multipart upload), which is how the browser
//     sends a 113 MB listing video;
//   · "Add" posts admin/listing/{id}/videos with
//       { video_title: null, display_type: "both", video_url: null,
//         videos: [{ url: <the CDN address>, video_title, display_type: "both" }] };
//   · the listing page lists its videos (props.videos.data: uuid, title,
//     duration, created_at), and a video is removed with DELETE
//     admin/videos/{uuid}.
// Aryeo converts the file in the background; the public API is what the hub
// believes (it lists the video once Aryeo has it, with its length).
// A file the hub hands over is never a guess at a link: Uploadcare either
// fetches it from a temporary Dropbox link (from_url), or the hub sends it in
// parts. The push (lib/videoAryeoPush) picks and resumes these.

const VIDEO_UPLOAD = "https://upload.aryeo.com";
const VIDEO_CDN = "https://aryeo.ucarecd.net/";
/** Uploadcare's own part size for a multipart upload (its default, 5 MiB). */
export const UPLOADCARE_PART_BYTES = 5 * 1024 * 1024;

async function uploadcareVideoKey(): Promise<string> {
  if (uploadcareVideoKeyCache && Date.now() - uploadcareVideoKeyCache.at < 6 * 3_600_000) return uploadcareVideoKeyCache.key;
  const { uploadcareVideoKey: key } = await fetchLoginPage({});
  if (!key) throw new AryeoWebError("Aryeo's page no longer shows its video upload key. Aryeo may have changed how videos are uploaded.", "changed");
  return key;
}

/** The address the Add Video window hands Aryeo for an uploaded file. */
export const videoCdnUrl = (uuid: string) => `${VIDEO_CDN}${uuid}/`;

/** Uploadcare's answer as JSON, or a plain-words error (4xx refused, 5xx a bad minute). */
async function ucJson<T>(res: Response, what: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) throw new AryeoWebError(`Aryeo's upload service refused ${what} (${res.status}: ${text.slice(0, 160)}).`, res.status >= 500 || res.status === 429 ? "transient" : "refused");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AryeoWebError(`Aryeo's upload service answered ${what} in a way the hub does not recognise.`, "changed");
  }
}

/**
 * Ask Uploadcare to fetch the file from a link (a temporary Dropbox link):
 * no bytes pass through the hub. A token to poll, or the file at once (a
 * duplicate Uploadcare already holds). A project that does not allow it
 * answers 4xx ("refused"), and the push falls back to the multipart upload.
 */
export async function uploadcareVideoFromUrl(sourceUrl: string, filename: string): Promise<{ token: string } | { uuid: string }> {
  const form = new FormData();
  form.set("pub_key", await uploadcareVideoKey());
  form.set("source_url", sourceUrl);
  form.set("store", "auto");
  form.set("filename", filename);
  form.set("check_URL_duplicates", "0");
  form.set("save_URL_duplicates", "0");
  const res = await fetch(`${VIDEO_UPLOAD}/from_url/`, { method: "POST", body: form, headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
  const j = await ucJson<{ type?: string; token?: string; uuid?: string; file_id?: string }>(res, `to fetch ${filename}`);
  if (j.type === "token" && j.token) return { token: j.token };
  const uuid = j.uuid ?? j.file_id;
  if (uuid) return { uuid };
  throw new AryeoWebError("Aryeo's upload service gave no token for the video.", "changed");
}

export type FromUrlStatus = { status: "waiting" | "progress" | "success" | "error" | "unknown"; uuid: string | null; error: string | null; done: number | null; total: number | null };

/** Where Uploadcare's fetch has got to. */
export async function uploadcareFromUrlStatus(token: string): Promise<FromUrlStatus> {
  const res = await fetch(`${VIDEO_UPLOAD}/from_url/status/?token=${encodeURIComponent(token)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  const j = await ucJson<{ status?: string; uuid?: string; file_id?: string; error?: string; done?: number; total?: number }>(res, "the fetch's status");
  const status = (["waiting", "progress", "success", "error"].includes(String(j.status)) ? j.status : "unknown") as FromUrlStatus["status"];
  return { status, uuid: j.uuid ?? j.file_id ?? null, error: j.error ?? null, done: typeof j.done === "number" ? j.done : null, total: typeof j.total === "number" ? j.total : null };
}

/** Start a multipart upload: the file's id and one signed address per 5 MiB part. */
export async function uploadcareMultipartStart(o: { filename: string; size: number; contentType: string }): Promise<{ uuid: string; parts: string[] }> {
  const form = new FormData();
  form.set("UPLOADCARE_PUB_KEY", await uploadcareVideoKey());
  form.set("UPLOADCARE_STORE", "auto");
  form.set("filename", o.filename);
  form.set("size", String(o.size));
  form.set("content_type", o.contentType);
  const res = await fetch(`${VIDEO_UPLOAD}/multipart/start/`, { method: "POST", body: form, headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
  const j = await ucJson<{ uuid?: string; parts?: unknown[] }>(res, `to start ${o.filename}`);
  const parts = Array.isArray(j.parts) ? j.parts.filter((p): p is string => typeof p === "string" && /^https:\/\//.test(p)) : [];
  if (!j.uuid || !parts.length) throw new AryeoWebError("Aryeo's upload service did not hand out the upload's parts.", "changed");
  return { uuid: j.uuid, parts };
}

/** One part, to the signed address Uploadcare handed out. */
export async function uploadcarePutPart(url: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(url, { method: "PUT", body: bytes as unknown as BodyInit, headers: { "Content-Type": "application/octet-stream" }, signal: AbortSignal.timeout(120_000) });
  if (res.ok) return;
  const text = await res.text().catch(() => "");
  // 403 on a signed address = it expired: the upload starts again from the first part.
  throw new AryeoWebError(`Aryeo's upload service refused a part of the video (${res.status}${text ? `: ${text.slice(0, 80)}` : ""}).`, res.status === 403 ? "refused" : res.status >= 500 ? "transient" : "refused");
}

/** Every part is up: Uploadcare puts the file together. */
export async function uploadcareMultipartComplete(uuid: string): Promise<{ isReady: boolean }> {
  const form = new FormData();
  form.set("UPLOADCARE_PUB_KEY", await uploadcareVideoKey());
  form.set("uuid", uuid);
  const res = await fetch(`${VIDEO_UPLOAD}/multipart/complete/`, { method: "POST", body: form, headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  const j = await ucJson<{ is_ready?: boolean }>(res, "to finish the video");
  return { isReady: j.is_ready === true };
}

/** One uploaded file, as Uploadcare sees it. */
export async function uploadcareVideoInfo(uuid: string): Promise<{ isReady: boolean; size: number | null; mimeType: string | null }> {
  const key = await uploadcareVideoKey();
  const res = await fetch(`${VIDEO_UPLOAD}/info/?pub_key=${encodeURIComponent(key)}&file_id=${encodeURIComponent(uuid)}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
  const j = await ucJson<{ is_ready?: boolean; size?: number; mime_type?: string }>(res, "the video's details");
  return { isReady: j.is_ready === true, size: typeof j.size === "number" ? j.size : null, mimeType: typeof j.mime_type === "string" ? j.mime_type : null };
}

export type AryeoWebVideo = { uuid: string; title: string | null; durationSec: number | null; createdAt: string | null };

/** The listing editor's own list of the listing's videos; null when the page carries none (Aryeo changed it). */
export async function listingVideos(listingId: string): Promise<AryeoWebVideo[] | null> {
  const page = await inertia("GET", editor(listingId));
  let raw = (page.props.videos ?? deepFind(page.props, "videos")) as { data?: unknown[] } | unknown[] | undefined;
  if (raw === undefined) {
    // A lazy prop: the editor's own partial reload asks for it by name.
    const again = await inertia("GET", editor(listingId), undefined, false, { referer: editor(listingId), partial: { component: page.component, data: ["videos"] } });
    raw = again.props.videos as { data?: unknown[] } | unknown[] | undefined;
  }
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { data?: unknown[] } | undefined)?.data) ? (raw as { data: unknown[] }).data : null;
  if (!list) return null;
  return (list as Record<string, unknown>[])
    .map((v) => ({
      uuid: typeof v?.uuid === "string" ? v.uuid : typeof v?.id === "string" ? v.id : "",
      title: typeof v?.title === "string" ? v.title : null,
      durationSec: typeof v?.duration === "number" && Number.isFinite(v.duration) ? v.duration : null,
      createdAt: typeof v?.created_at === "string" ? v.created_at : null,
    }))
    .filter((v) => !!v.uuid);
}

/**
 * Put one uploaded video file on the listing (the Add Video window's own call). Never retried by this function.
 *
 * THE WINDOW'S WHOLE FILE RECORD (Oct 19 2026, first two real presses refused:
 * "Video title is required for each video. Display type is required for each
 * video. File size is required for each video."). The window's submit maps
 * each file to {url, video_title, display_type}, but its upload-finished
 * handler installs a form transform that swaps `videos` back to the raw file
 * records ({uuid, internalId, url, filename, size, titleValue, titleError,
 * displayType, uploadProgress}) just before the POST, and that is what Aryeo's
 * server checks. Both spellings go up; Aryeo ignores the keys it does not read.
 */
export async function addListingVideo(listingId: string, o: { uuid: string; cdnUrl: string; title: string; filename: string; size: number }): Promise<void> {
  const page = await inertia("POST", `${aryeoAdminOrigin()}/admin/listing/${encodeURIComponent(listingId)}/videos`, {
    video_title: null,
    display_type: "both",
    video_url: null,
    videos: [{
      uuid: o.uuid,
      internalId: o.uuid,
      url: o.cdnUrl,
      filename: o.filename,
      size: o.size,
      titleValue: o.title,
      titleError: "",
      displayType: "both",
      uploadProgress: 100,
      video_title: o.title,
      display_type: "both",
    }],
  }, false, { referer: editor(listingId) });
  const no = refusedBy(page);
  if (no) throw new AryeoWebError(`Aryeo would not add the video: ${no}`, "refused");
}

/** Remove one video from the listing (the editor's own delete). The push only ever removes a video it put there itself. */
export async function deleteListingVideo(listingId: string, videoUuid: string): Promise<void> {
  const page = await inertia("DELETE", `${aryeoAdminOrigin()}/admin/videos/${encodeURIComponent(videoUuid)}`, undefined, false, { referer: editor(listingId) });
  const no = refusedBy(page);
  if (no) throw new AryeoWebError(`Aryeo would not remove the earlier video: ${no}`, "refused");
}
