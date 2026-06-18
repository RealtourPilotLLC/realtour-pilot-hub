import "server-only";
import { getSecret } from "./connections";

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
  defaultFields?: { firstName?: string; lastName?: string; company?: string; phoneNumbers?: { value?: string }[] };
  createdAt?: string;
}

type Paged<T> = { data: T[]; nextPageToken?: string | null; totalItems?: number };

export const OpenPhone = {
  request: openphoneRequest,
  phoneNumbers: () => openphoneRequest<Paged<OpPhoneNumber>>("/phone-numbers").then((r) => r.data ?? []),
  users: () => openphoneRequest<Paged<OpUser>>("/users").then((r) => r.data ?? []),
  contacts: (q?: Query) => openphoneRequest<Paged<OpContact>>("/contacts", { query: q }),
  conversations: (q?: Query) => openphoneRequest<Paged<OpConversation>>("/conversations", { query: q }),
  // NB: OpenPhone wants the participants as the array param `participants[]`.
  messages: (phoneNumberId: string, participants: string[], maxResults = 30) =>
    openphoneRequest<Paged<OpMessage>>("/messages", {
      query: { phoneNumberId, "participants[]": participants, maxResults },
    }).then((r) => r.data ?? []),
  calls: (phoneNumberId: string, participants: string[], maxResults = 30) =>
    openphoneRequest<Paged<OpCall>>("/calls", {
      query: { phoneNumberId, "participants[]": participants, maxResults },
    }).then((r) => r.data ?? []),
};

// Merged, newest-first timeline of texts + calls for one conversation.
export type ThreadItem =
  | { kind: "message"; id: string; at: string; direction?: string; text: string }
  | { kind: "call"; id: string; at: string; direction?: string; duration?: number; status?: string };

export async function conversationThread(
  phoneNumberId: string,
  participant: string,
): Promise<ThreadItem[]> {
  const [msgs, calls] = await Promise.all([
    OpenPhone.messages(phoneNumberId, [participant]).catch(() => [] as OpMessage[]),
    OpenPhone.calls(phoneNumberId, [participant]).catch(() => [] as OpCall[]),
  ]);
  const items: ThreadItem[] = [
    ...msgs.map((m) => ({
      kind: "message" as const,
      id: m.id,
      at: m.createdAt ?? "",
      direction: m.direction,
      text: (typeof m.text === "string" ? m.text : m.body) ?? "",
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
export async function registerOpenPhoneWebhooks(callbackUrl: string): Promise<{ created: number }> {
  const existing = await listWebhooks();
  for (const w of existing) {
    if (w.url === callbackUrl) {
      await openphoneRequest(`/webhooks/${w.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  await openphoneRequest("/webhooks/messages", {
    method: "POST",
    body: { url: callbackUrl, events: MESSAGE_EVENTS, label: "RealTour Pilot Hub" },
  });
  await openphoneRequest("/webhooks/calls", {
    method: "POST",
    body: { url: callbackUrl, events: CALL_EVENTS, label: "RealTour Pilot Hub" },
  });
  return { created: 2 };
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
