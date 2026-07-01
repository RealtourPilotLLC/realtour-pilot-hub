import "server-only";
import crypto from "crypto";
import { getSecret, saveSecret } from "./connections";

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
  opts: { method?: string; query?: Query; body?: unknown; key?: string } = {},
): Promise<T> {
  const key = opts.key ?? (await getSecret("openphone"));
  if (!key) throw new OpenPhoneError("OpenPhone is not connected.", 401);

  const url = new URL(`${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item));
    else url.searchParams.set(k, String(v));
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

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

export const OpenPhone = {
  request: openphoneRequest,
  phoneNumbers: () => openphoneRequest<Paged<OpPhoneNumber>>("/phone-numbers").then((r) => r.data ?? []),
  users: () => openphoneRequest<Paged<OpUser>>("/users").then((r) => r.data ?? []),
  contacts: (q?: Query) => openphoneRequest<Paged<OpContact>>("/contacts", { query: q }),
  conversations: (q?: Query) => openphoneRequest<Paged<OpConversation>>("/conversations", { query: q }),
  callTranscript: (callId: string) =>
    openphoneRequest<{ data: OpTranscript }>(`/call-transcripts/${callId}`).then((r) => r.data),
  // NB: OpenPhone wants the participants as the array param `participants[]`.
  messages: (phoneNumberId: string, participants: string[], maxResults = 30) =>
    openphoneRequest<Paged<OpMessage>>("/messages", {
      query: { phoneNumberId, "participants[]": participants, maxResults },
    }).then((r) => r.data ?? []),
  calls: (phoneNumberId: string, participants: string[], maxResults = 30) =>
    openphoneRequest<Paged<OpCall>>("/calls", {
      query: { phoneNumberId, "participants[]": participants, maxResults },
    }).then((r) => r.data ?? []),
  // Send an SMS/MMS. `from` is one of our OpenPhone numbers (E.164), `to` the
  // client. Human-initiated only (a person clicks Send) — never auto-sent.
  sendMessage: (from: string, to: string | string[], content: string, mediaUrls?: string[]) =>
    openphoneRequest<{ data: OpMessage }>("/messages", {
      method: "POST",
      body: { content, from, to: Array.isArray(to) ? to : [to], ...(mediaUrls?.length ? { mediaUrls } : {}) },
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
  const [msgs, calls] = await Promise.all([
    OpenPhone.messages(phoneNumberId, participants).catch(() => [] as OpMessage[]),
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

// Register message + call webhooks pointing at our endpoint (idempotent: clears
// any existing hooks for the same URL first).
export async function registerOpenPhoneWebhooks(
  callbackUrl: string,
): Promise<{ created: number; transcripts: boolean }> {
  // A shared-secret token in the callback URL authenticates inbound events: a
  // spoofer who doesn't know it can't POST fake texts/calls and inject tasks or
  // revisions. Rotated on every (re)registration; the receiver reads it back
  // from the stored "openphone_webhook" secret.
  const token = crypto.randomBytes(24).toString("hex");
  await saveSecret("openphone_webhook", token);
  const url = `${callbackUrl}?t=${token}`;

  const existing = await listWebhooks();
  for (const w of existing) {
    // Match regardless of any prior token query param.
    if ((w.url || "").split("?")[0] === callbackUrl) {
      await openphoneRequest(`/webhooks/${w.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  await openphoneRequest("/webhooks/messages", {
    method: "POST",
    body: { url, events: MESSAGE_EVENTS, label: "RealTour Pilot Hub" },
  });
  await openphoneRequest("/webhooks/calls", {
    method: "POST",
    body: { url, events: CALL_EVENTS, label: "RealTour Pilot Hub" },
  });
  // Call transcripts have a dedicated webhook resource; not every plan exposes
  // it, so don't let a failure here break message/call registration.
  let transcripts = false;
  try {
    await openphoneRequest("/webhooks/call-transcripts", {
      method: "POST",
      body: { url, events: TRANSCRIPT_EVENTS, label: "RealTour Pilot Hub" },
    });
    transcripts = true;
  } catch {
    /* plan may not include transcripts */
  }
  return { created: transcripts ? 3 : 2, transcripts };
}

// Verify an inbound OpenPhone webhook's shared-secret token (constant-time).
// Returns true when there's nothing to verify against yet (no token stored) so
// the pipeline keeps working until the webhook is (re)registered with a token.
export async function openPhoneRequestAuthorized(token: string | null): Promise<boolean> {
  const expected = await getSecret("openphone_webhook");
  if (!expected) return true; // not yet activated — backward compatible
  const got = token ?? "";
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
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
