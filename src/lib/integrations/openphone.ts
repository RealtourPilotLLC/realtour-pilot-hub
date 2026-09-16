import "server-only";
import crypto from "crypto";
import { disconnect, getSecret, saveSecret } from "./connections";

// ---------------------------------------------------------------------------
// OpenPhone (Quo) REST client. Base: https://api.openphone.com/v1
// Auth: the API key goes in the Authorization header RAW (no "Bearer").
// ---------------------------------------------------------------------------

const BASE_URL = "https://api.openphone.com/v1";

export class OpenPhoneError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "OpenPhoneError";
  }
}

type Query = Record<string, string | number | boolean | string[] | undefined>;

export async function openphoneRequest<T = unknown>(
  path: string,
  // `timeoutMs` (RTP-08, Sep 16) is used by the SEND call alone: a hung POST
  // used to hold a cron step open until the platform killed it, which is the
  // one shape of failure that loses a message with no record. Bounded, it
  // becomes a normal ambiguous outcome the outbox can hold and show.
  opts: { method?: string; query?: Query; body?: unknown; key?: string; timeoutMs?: number } = {},
): Promise<T> {
  const key = opts.key ?? (await getSecret("openphone"));
  if (!key) throw new OpenPhoneError("OpenPhone is not connected.", 401);

  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: key,
        "Content-Type": "application/json",
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
  } catch (e) {
    // A timed-out send is AMBIGUOUS, never a rejection: OpenPhone may have
    // taken the message before it stopped answering. 408 is the status the
    // outbox's classifier reads as "we cannot tell" (lib/outbox.ts).
    if ((e as { name?: string } | null)?.name === "TimeoutError" || (e as { name?: string } | null)?.name === "AbortError") {
      throw new OpenPhoneError(`OpenPhone did not answer within ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`, 408);
    }
    throw e;
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const msg = (json as { message?: string })?.message || `OpenPhone API ${res.status}`;
    throw new OpenPhoneError(msg, res.status);
  }
  return json as T;
}

// ---- shapes (read defensively) --------------------------------------------
export interface OpUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  pictureUrl?: string;
}
export interface OpPhoneNumber {
  id: string;
  name?: string;
  number?: string;
  formattedNumber?: string;
  users?: OpUser[];
}
export interface OpConversation {
  id: string;
  name?: string | null;
  participants?: string[]; // phone numbers
  phoneNumberId?: string;
  lastActivityAt?: string;
  lastActivityId?: string;
  assignedTo?: string | null;
  mutedUntil?: string | null;
  updatedAt?: string;
}
export interface OpMessage {
  id: string;
  to?: string[] | string;
  from?: string;
  text?: string;
  body?: string;
  direction?: string; // incoming | outgoing
  status?: string;
  createdAt?: string;
}
export interface OpCall {
  id: string;
  participants?: string[];
  direction?: string;
  status?: string;
  duration?: number;
  createdAt?: string;
}
export interface OpContact {
  id: string;
  externalId?: string;
  source?: string;
  defaultFields?: {
    firstName?: string;
    lastName?: string;
    company?: string;
    emails?: ({ value?: string } | string)[];
    phoneNumbers?: ({ value?: string } | string)[];
  };
  createdAt?: string;
}

// A call transcript: dialogue lines, each tagged with the speaker's phone
// (identifier) and userId (non-null = our team member; null = the other party).
export interface OpTranscriptLine {
  content?: string;
  start?: number;
  end?: number;
  identifier?: string; // speaker phone number
  userId?: string | null; // our team member id, or null for the external party
}
export interface OpTranscript {
  callId?: string;
  createdAt?: string;
  dialogue?: OpTranscriptLine[];
  status?: string;
}

type Paged<T> = { data: T[]; nextPageToken?: string | null; totalItems?: number };

// Follow nextPageToken until the list runs out (or `cap` rows / 10 pages, so a
// pathological thread can't stall a request). Errors propagate — callers decide
// what a failure means.
async function pageAll<T>(path: string, query: Query, cap: number): Promise<T[]> {
  const out: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await openphoneRequest<Paged<T>>(path, {
      query: { ...query, maxResults: 100, ...(pageToken ? { pageToken } : {}) },
    });
    out.push(...(r.data ?? []));
    pageToken = r.nextPageToken ?? undefined;
    if (!pageToken || out.length >= cap) break;
  }
  return out;
}

export const OpenPhone = {
  request: openphoneRequest,
  phoneNumbers: () => openphoneRequest<Paged<OpPhoneNumber>>("/phone-numbers").then((r) => r.data ?? []),
  users: () => openphoneRequest<Paged<OpUser>>("/users").then((r) => r.data ?? []),
  contacts: (q?: Query) => openphoneRequest<Paged<OpContact>>("/contacts", { query: q }),
  conversations: (q?: Query) => openphoneRequest<Paged<OpConversation>>("/conversations", { query: q }),
  callTranscript: (callId: string) =>
    openphoneRequest<{ data: OpTranscript }>(`/call-transcripts/${callId}`).then((r) => r.data),
  // NB: the participants filter is the plain key `participants`, REPEATED once
  // per number — NOT `participants[]`. The bracketed form is rejected with
  // "/participants: Expected array" (400), and because the old thread loader
  // swallowed that error, every conversation in the inbox rendered as "No
  // messages yet" instead of the real texts (Aug 18: Janice Pigga's thread).
  // Both endpoints page (100/page) so a long thread loads in full, not just
  // its newest 30.
  messages: (phoneNumberId: string, participants: string[], cap = 300) =>
    pageAll<OpMessage>("/messages", { phoneNumberId, participants }, cap),
  calls: (phoneNumberId: string, participants: string[], cap = 100) =>
    pageAll<OpCall>("/calls", { phoneNumberId, participants }, cap),
  // Send an SMS/MMS. `from` is one of our OpenPhone numbers (E.164).
  // Automated callers: the TEAM SMS bridge in notify.ts (TeamMember phones
  // only) and — since Sep 2026, on Jordan's explicit order — the confirmation
  // + delivery sweeps in clientTextSweeps.ts, which text CLIENTS under strict
  // idempotency claims and a 9am-8pm ET gate. Everything else client-facing
  // stays human-initiated (a person clicks Send).
  //
  // Sep 16 (RTP-08): the CLIENT-text rails (both sweeps and the Send-all panel)
  // and the staff digest now reach this through the durable outbox
  // (lib/outbox.ts), which keeps `data.id` as the proof a message really left.
  // The remaining direct callers — app/actions.ts, the per-screen send buttons,
  // uploadDigest — are still to move. The 30s bound applies to all of them: it
  // turns "the request hung until the platform killed the function" into a
  // recorded, ambiguous outcome instead of a message nothing remembers.
  sendMessage: (from: string, to: string | string[], content: string, mediaUrls?: string[]) =>
    openphoneRequest<{ data: OpMessage }>("/messages", {
      method: "POST",
      body: { content, from, to: Array.isArray(to) ? to : [to], ...(mediaUrls?.length ? { mediaUrls } : {}) },
      timeoutMs: 30_000,
    }),
};

// Our first OpenPhone number (E.164), used as the "from" when sending.
export async function defaultOpenPhoneNumber(): Promise<string | null> {
  try {
    const nums = await OpenPhone.phoneNumbers();
    return nums[0]?.number ?? null;
  } catch {
    return null;
  }
}

// Our own OpenPhone numbers as 10-digit keys, briefly cached (per lambda). The
// webhook uses this to tell OUR messages — which echo back as "incoming" in
// group threads — from a client's, and to keep our own lines out of the
// client-match / lead paths. Best-effort: an API failure returns the last known
// set (or empty) rather than throwing, so a blip never blocks event processing.
let ourNumbersCache: { at: number; keys: Set<string> } | null = null;
export async function ourOpenPhoneNumberKeys(): Promise<Set<string>> {
  if (ourNumbersCache && Date.now() - ourNumbersCache.at < 10 * 60_000) return ourNumbersCache.keys;
  try {
    const nums = await OpenPhone.phoneNumbers();
    const keys = new Set(nums.map((n) => phoneKey(n.number)).filter((k) => k.length === 10));
    ourNumbersCache = { at: Date.now(), keys };
    return keys;
  } catch {
    return ourNumbersCache?.keys ?? new Set();
  }
}

// Our first OpenPhone number's RESOURCE id, used as `phoneNumberId` when
// querying messages/calls/threads.
export async function defaultOpenPhoneNumberId(): Promise<string | null> {
  try {
    const nums = await OpenPhone.phoneNumbers();
    return nums[0]?.id ?? null;
  } catch {
    return null;
  }
}

// Close open OpenPhone reply tasks for any conversation whose latest message is
// outbound — i.e. we've already replied. Backstop to the real-time outbound
// webhook (covers missed webhooks + the existing backlog). Returns # closed.
export async function sweepRepliedOpenPhoneTasks(): Promise<number> {
  const { prisma } = await import("@/lib/prisma");
  const tasks = await prisma.smartTask.findMany({
    // Include call-sourced reply tasks (voicemail callbacks) — legacy ones were
    // filed as "openphone-call" and would otherwise never be swept closed.
    where: { source: { in: ["openphone", "openphone-call"] }, taskType: "client_reply", status: { notIn: ["COMPLETED", "CANCELLED"] }, clientId: { not: null } },
    select: { id: true, clientId: true, client: { select: { phone: true } } },
  });
  if (tasks.length === 0) return 0;

  // With per-order reply tasks a client can have several open at once; this
  // phone-level sweep can't tell which order a reply addressed, so skip those
  // clients and let the real-time, project-aware close handle them.
  const perClient = new Map<string, number>();
  for (const t of tasks) if (t.clientId) perClient.set(t.clientId, (perClient.get(t.clientId) ?? 0) + 1);

  // Our OpenPhone numbers (the message endpoint needs a phoneNumberId).
  let numbers: string[] = [];
  try {
    numbers = (await OpenPhone.phoneNumbers()).map((n) => n.id).filter((id): id is string => Boolean(id));
  } catch {
    return 0;
  }
  if (numbers.length === 0) return 0;

  let closed = 0;
  for (const t of tasks) {
    if (t.clientId && (perClient.get(t.clientId) ?? 0) > 1) continue; // multi-order: skip
    const k = phoneKey(t.client?.phone);
    if (k.length !== 10) continue;
    const participant = `+1${k}`; // OpenPhone wants E.164; their clients are US.

    // Query the client's thread DIRECTLY (don't scan the conversation list — it's
    // capped/ordered and can miss older threads). Find the newest message across
    // our numbers; if it's outbound, we've already replied → close the task.
    let latest: OpMessage | undefined;
    for (const numId of numbers) {
      let msgs: OpMessage[] = [];
      try {
        msgs = await OpenPhone.messages(numId, [participant], 5);
      } catch {
        continue;
      }
      for (const m of msgs) {
        if (!latest || (m.createdAt && (!latest.createdAt || m.createdAt > latest.createdAt))) latest = m;
      }
    }
    if (latest && (latest.direction ?? "").toLowerCase().startsWith("out")) {
      const r = await prisma.smartTask.updateMany({
        where: { id: t.id, status: { notIn: ["COMPLETED", "CANCELLED"] } },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      closed += r.count;
    }
  }
  return closed;
}

// Pull conversations across pages and return them sorted newest-first.
// CRITICAL: OpenPhone's /conversations endpoint does NOT sort by lastActivityAt
// (its native order is arbitrary), so a single page can omit a thread that's
// active today. We must page through and sort ourselves, or recent conversations
// (especially groups) silently go missing from the inbox. Page size caps at 50.
export async function recentOpenPhoneConversations(maxPages = 20): Promise<OpConversation[]> {
  const out: OpConversation[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const res = await openphoneRequest<Paged<OpConversation>>("/conversations", {
      query: { maxResults: 50, pageToken },
    });
    out.push(...(res.data ?? []));
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out.sort(
    (a, b) => new Date(b.lastActivityAt ?? 0).getTime() - new Date(a.lastActivityAt ?? 0).getTime(),
  );
}

// Pull EVERY contact (paginated). OpenPhone caps page size at 50.
export async function allOpenPhoneContacts(): Promise<OpContact[]> {
  const out: OpContact[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 200; i++) {
    const res = await openphoneRequest<Paged<OpContact>>("/contacts", {
      query: { maxResults: 50, pageToken },
    });
    out.push(...(res.data ?? []));
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

// Pull a phone number's values off a contact regardless of string/object shape.
export function contactPhoneValues(c: OpContact): string[] {
  const raw = c.defaultFields?.phoneNumbers ?? [];
  return raw.map((p) => (typeof p === "string" ? p : p?.value ?? "")).filter(Boolean);
}
export function contactEmailValues(c: OpContact): string[] {
  const raw = c.defaultFields?.emails ?? [];
  return raw.map((e) => (typeof e === "string" ? e : e?.value ?? "")).filter(Boolean);
}

// Fetch a call's transcript and split it into the full text and just the OTHER
// party's words (userId === null), which is what we scan for revision requests.
export async function callTranscriptText(
  callId: string,
): Promise<{ ok: boolean; full: string; clientText: string }> {
  try {
    const t = await OpenPhone.callTranscript(callId);
    const lines = t?.dialogue ?? [];
    const full = lines.map((l) => l.content ?? "").join(" ").replace(/\s+/g, " ").trim();
    const clientText = lines
      .filter((l) => !l.userId) // null/undefined userId = external party (the client)
      .map((l) => l.content ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return { ok: Boolean(full), full, clientText };
  } catch {
    return { ok: false, full: "", clientText: "" };
  }
}

// Merged, newest-first timeline of texts + calls for one conversation.
export type ThreadItem =
  | { kind: "message"; id: string; at: string; direction?: string; text: string; from?: string }
  | { kind: "call"; id: string; at: string; direction?: string; duration?: number; status?: string };

// Load a 1:1 OR group conversation. Pass all participant numbers for a group.
export async function conversationThread(
  phoneNumberId: string,
  participant: string | string[],
): Promise<ThreadItem[]> {
  const participants = Array.isArray(participant) ? participant : [participant];
  // The MESSAGES error propagates on purpose: texts are the thread, and a
  // swallowed failure here reads to the user as "this client never wrote us"
  // — which is how a broken query param went unnoticed. Calls stay
  // best-effort; a missing call log shouldn't blank out the texts.
  const [msgs, calls] = await Promise.all([
    OpenPhone.messages(phoneNumberId, participants),
    OpenPhone.calls(phoneNumberId, participants).catch(() => [] as OpCall[]),
  ]);
  const items: ThreadItem[] = [
    ...msgs.map((m) => ({
      kind: "message" as const,
      id: m.id,
      at: m.createdAt ?? "",
      direction: m.direction,
      text: (typeof m.text === "string" ? m.text : m.body) ?? "",
      from: m.from,
    })),
    ...calls.map((c) => ({
      kind: "call" as const,
      id: c.id,
      at: c.createdAt ?? "",
      direction: c.direction,
      duration: c.duration,
      status: c.status,
    })),
  ];
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

// ---- Webhooks --------------------------------------------------------------
export const MESSAGE_EVENTS = ["message.received", "message.delivered"];
export const CALL_EVENTS = ["call.completed", "call.ringing", "call.recording.completed"];
// Transcripts arrive on their own event a moment after the call ends.
export const TRANSCRIPT_EVENTS = ["call.transcript.completed"];

interface OpWebhook {
  id: string;
  url?: string;
  events?: string[];
  label?: string;
}

export async function listWebhooks(): Promise<OpWebhook[]> {
  const r = await openphoneRequest<{ data: OpWebhook[] }>("/webhooks");
  return r.data ?? [];
}

// The path part of a webhook URL, ignoring host and query string (our
// shared-secret token rides in `?t=`). Used to recognise OUR receiver whatever
// host it was registered under.
function webhookPath(u: string): string {
  try {
    return new URL(u).pathname.replace(/\/+$/, "");
  } catch {
    return u.split("?")[0].replace(/^https?:\/\/[^/]+/, "").replace(/\/+$/, "");
  }
}

// POST one webhook resource and hand back its id. The id matters: a partial
// registration has to be able to take its OWN leftovers back out (see below).
// Read it defensively — OpenPhone wraps created resources in `data`, but a bare
// object would otherwise leave us holding a hook we can't identify.
async function createWebhook(resource: string, events: string[], url: string): Promise<string | undefined> {
  const r = await openphoneRequest<{ data?: OpWebhook; id?: string }>(`/webhooks/${resource}`, {
    method: "POST",
    body: { url, events, label: "RealTour Pilot Hub" },
  });
  return r?.data?.id ?? r?.id;
}

// Register message + call webhooks pointing at our endpoint (idempotent: clears
// any existing hooks for the same receiver first).
//
// THE ORDER HERE IS THE SAFETY. The stored token is what flips the receiver
// fail-closed, so it must be the LAST thing that changes: mint → create the
// replacements → store the token → only then delete the old hooks. This used
// to store the secret FIRST, before it had even talked to OpenPhone; any throw
// after that point (a 429, an expired API key, a plan restriction) left the
// account with the old hooks deleted, no new hooks, and a secret that rejects
// everything — every inbound text AND call gone until someone noticed, and the
// owner presses this button by hand. In this order the worst case is a brief
// window where old and new hooks both fire (the receiver's externalId dedupe
// absorbs the doubles) and where the new hooks arrive carrying `?t=` before the
// secret exists (which the receiver already accepts, loudly, as unsigned).
export async function registerOpenPhoneWebhooks(
  callbackUrl: string,
): Promise<{ created: number; transcripts: boolean }> {
  // A shared-secret token in the callback URL authenticates inbound events: a
  // spoofer who doesn't know it can't POST fake texts/calls and inject tasks or
  // revisions. Rotated on every (re)registration; the receiver reads it back
  // from the stored "openphone_webhook" secret.
  const token = crypto.randomBytes(24).toString("hex");
  const url = `${callbackUrl}?t=${token}`;

  // Snapshot the old hooks BEFORE creating anything: the delete pass at the end
  // then works off a list that cannot possibly contain the replacements we're
  // about to make. A failure right here aborts with nothing changed at all —
  // old hooks still live, old token still stored, inbound comms untouched.
  const existing = await listWebhooks();
  const receiverPath = webhookPath(callbackUrl);

  const createdIds: string[] = [];
  let transcripts = false;
  try {
    const msgId = await createWebhook("messages", MESSAGE_EVENTS, url);
    if (msgId) createdIds.push(msgId);
    const callId = await createWebhook("calls", CALL_EVENTS, url);
    if (callId) createdIds.push(callId);
    // Call transcripts have a dedicated webhook resource; not every plan exposes
    // it, so don't let a failure here break message/call registration.
    try {
      const trId = await createWebhook("call-transcripts", TRANSCRIPT_EVENTS, url);
      if (trId) createdIds.push(trId);
      transcripts = true;
    } catch {
      /* plan may not include transcripts */
    }
  } catch (e) {
    // Half-registered. Nothing destructive has happened (the old hooks are still
    // there doing the real work), but whatever we DID create carries the new
    // token while the store still holds the previous one — so it would bounce
    // every event it delivers and bury the genuine rejection alert under false
    // ones. Take our own leftovers back out; best-effort, the retry's snapshot
    // sweeps anything that survives.
    for (const id of createdIds) {
      await openphoneRequest(`/webhooks/${id}`, { method: "DELETE" }).catch(() => {});
    }
    throw e;
  }

  // Both replacements are live and already carrying the new token — only NOW is
  // it safe for the receiver to start demanding it.
  let stored = false;
  try {
    await saveSecret("openphone_webhook", token);
    stored = true;

    for (const w of existing) {
      // Never delete what we just created (the snapshot predates them, so this is
      // belt-and-braces in case OpenPhone ever returns an already-registered id).
      if (createdIds.includes(w.id)) continue;
      // Match on the RECEIVER PATH, not the full URL: comparing the whole URL
      // missed every hook registered under the old host (the app moved to
      // hub.realtourpilot.com, Sep 2026), and those hooks keep firing — they'd
      // double-deliver each event AND fail the freshly-rotated token, burying the
      // real rejection alert under a flood of false ones.
      if (webhookPath(w.url || "") === receiverPath) {
        await openphoneRequest(`/webhooks/${w.id}`, { method: "DELETE" }).catch(() => {});
      }
    }
  } catch (e) {
    // Self-heal: if we got as far as storing the token and then couldn't finish,
    // the receiver is gated on a registration we can't vouch for. Drop the
    // secret. An accept-unsigned receiver still hears every text and call (and
    // shouts about it on every request and every stored row); a fail-closed one
    // pointed at hooks that may not carry the token hears nothing at all.
    if (stored) await disconnect("openphone_webhook").catch(() => {});
    throw e;
  }

  return { created: transcripts ? 3 : 2, transcripts };
}

// Verify an inbound OpenPhone webhook's shared-secret token (constant-time).
//
// `unsigned: true` means NOTHING was verified because no token is stored yet:
// the request is still accepted so live inbound texts/calls don't stop the
// moment this ships, but the caller MUST record it as an unsigned acceptance.
// A bare `true` here is how the receiver ran wide open for 30 days without one
// rejection — anyone who guessed hub.realtourpilot.com/api/webhooks/openphone
// could post a message attributed to a named client (which mints tasks, can
// raise a revision, and feeds the AI's memory as that client's own words).
//
// RTP-28 (Sep 16): the failure now carries WHY. "No token on the request" and
// "a token that doesn't match" are different faults — the first is a hook
// registered without the `?t=` query, the second a rotated token — and the
// receiver writes the reason onto the REJECTED row so /connections can say
// which one bounced instead of "unsigned: token missing or mismatched".
export type OpenPhoneAuth =
  | { ok: true; unsigned: boolean }
  | { ok: false; unsigned: false; reason: "no token on the request" | "token did not match the saved one" };
export async function openPhoneRequestAuthorized(token: string | null): Promise<OpenPhoneAuth> {
  const expected = await getSecret("openphone_webhook");
  if (!expected) return { ok: true, unsigned: true }; // not yet activated — the receiver's setting decides
  // Compare BYTES, and gate on BYTE length. timingSafeEqual THROWS when the two
  // buffers differ in length, and a JS string's .length counts characters, not
  // bytes — so a 48-character `?t=` made of multibyte characters cleared the
  // old character gate and then blew up inside the compare, handing a prober a
  // 500 (and a stack trace) instead of a clean 401.
  const got = Buffer.from(token ?? "", "utf8");
  const want = Buffer.from(expected, "utf8");
  if (got.length !== want.length) {
    return { ok: false, unsigned: false, reason: token ? "token did not match the saved one" : "no token on the request" };
  }
  const match = crypto.timingSafeEqual(got, want);
  return match ? { ok: true, unsigned: false } : { ok: false, unsigned: false, reason: "token did not match the saved one" };
}

export async function testOpenPhoneKey(
  key: string,
): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  try {
    const res = await openphoneRequest<Paged<OpPhoneNumber>>("/phone-numbers", { key });
    const first = res.data?.[0];
    return { ok: true, label: first?.formattedNumber ? `OpenPhone · ${first.formattedNumber}` : "OpenPhone" };
  } catch (e) {
    return { ok: false, error: e instanceof OpenPhoneError ? e.message : String(e) };
  }
}

// Normalize a phone number to its last 10 digits for matching.
export function phoneKey(p?: string | null): string {
  return (p ?? "").replace(/\D/g, "").slice(-10);
}
