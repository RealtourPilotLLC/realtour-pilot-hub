"use server";

import { requireAdmin } from "@/lib/auth/guards";

import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, defaultOpenPhoneNumberId, phoneKey, recentOpenPhoneConversations } from "@/lib/integrations/openphone";
import { loadConversation } from "@/lib/commsThread";
import { resolveParticipants } from "@/lib/queries";
import { closeReplyForOutbound } from "@/lib/tasks";
import type { ChatItem, ConvoClient, ChatMember } from "@/components/comms/ConversationView";

export type SendResult = { ok: boolean; message: string };

// One selectable conversation on a client's chat: their direct 1:1 line, plus
// any GROUP threads that include them or a folded teammate (e.g. Kelly/Ruthie
// on Jamie's team). `participants` is the E.164 recipient list to text into.
export type ClientThread = {
  id: string;
  participants: string[];
  isGroup: boolean;
  label: string;
  members: ChatMember[]; // resolved, for the group header + sender labels
  lastActivityAt: string | null;
};

// The GROUP threads a client (or a folded teammate, e.g. Kelly/Ruthie on Jamie's
// team) is part of. Scans recent OpenPhone conversations — slower than the direct
// thread, so the client chat loads this in the background and adds the switcher
// once it returns (the direct line shows instantly via loadClientThread).
export async function loadClientGroupThreads(
  clientId: string,
): Promise<{ ok: boolean; message: string; threads?: ClientThread[] }> {
  await requireAdmin();
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { phone: true, teamMembers: { select: { phone: true } } },
  });
  if (!c) return { ok: false, message: "Client not found." };

  // "Our people" = this client + every teammate folded under them.
  const ourKeys = new Set<string>();
  const ck = phoneKey(c.phone);
  if (ck.length === 10) ourKeys.add(ck);
  for (const m of c.teamMembers) { const k = phoneKey(m.phone); if (k.length === 10) ourKeys.add(k); }
  if (ourKeys.size === 0) return { ok: true, message: "ok", threads: [] };

  // Our own OpenPhone line(s) — drop them from participants so we don't text
  // ourselves and the group reads as just the real people. Also drop anything
  // that resolves to our own brand name (a mis-saved "RealTour Pilot" contact).
  const { OpenPhone } = await import("@/lib/integrations/openphone");
  const selfKeys = new Set<string>();
  try { for (const n of await OpenPhone.phoneNumbers()) { const k = phoneKey(n.number); if (k.length === 10) selfKeys.add(k); } } catch { /* best effort */ }
  const isUs = (name: string) => /realtour\s*pilot/i.test(name);

  let convos: Awaited<ReturnType<typeof recentOpenPhoneConversations>> = [];
  try { convos = await recentOpenPhoneConversations(12); } catch { return { ok: true, message: "ok", threads: [] }; }

  const groups = convos
    .map((conv) => ({
      conv,
      keys: [...new Set((conv.participants ?? []).map((p) => phoneKey(p)).filter((k) => k.length === 10 && !selfKeys.has(k)))],
    }))
    .filter(({ keys }) => keys.length >= 2 && keys.some((k) => ourKeys.has(k)))
    .slice(0, 8);

  const threads: ClientThread[] = [];
  for (const { conv, keys } of groups) {
    // IMPORTANT: keep the FULL participant set for fetch/send — OpenPhone matches
    // a group conversation by its exact participants, so dropping any (even our
    // own "RealTour Pilot" line that's genuinely in the thread) returns 0 messages
    // and would fork a new conversation on reply. We only clean the DISPLAY label.
    const e164 = keys.map((k) => `+1${k}`);
    const members = (await resolveParticipants(e164)) as ChatMember[]; // all, for sender attribution
    const real = members.filter((m) => !isUs(m.name));
    if (real.length < 2) continue; // needs ≥2 real (non-us) people to be a group
    const labelNames = (real.length ? real : members).map((m) => m.name);
    const label = labelNames.slice(0, 3).join(", ") + (labelNames.length > 3 ? ` +${labelNames.length - 3}` : "");
    threads.push({
      id: conv.id ?? e164.join(","),
      participants: e164,
      isGroup: true,
      label,
      members,
      lastActivityAt: conv.lastActivityAt ?? null,
    });
  }
  return { ok: true, message: "ok", threads };
}

// Load the messages/calls for one selected thread (direct or group).
export async function loadThreadItems(
  participantsCsv: string,
): Promise<{ ok: boolean; message: string; items?: ChatItem[] }> {
  await requireAdmin();
  const numId = await defaultOpenPhoneNumberId();
  if (!numId) return { ok: false, message: "OpenPhone isn't connected." };
  const parts = participantsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return { ok: false, message: "No recipients." };
  const { items, note } = await loadConversation(numId, parts);
  // Nothing live AND nothing saved → report the failure rather than an empty room.
  if (note && items.length === 0) return { ok: false, message: note };
  return { ok: true, message: note ?? "ok", items };
}

// Load a client's live OpenPhone thread + header info, for the embedded chat on
// the client detail page (lazy — keeps the page fast).
export async function loadClientThread(
  clientId: string,
): Promise<{ ok: boolean; message: string; toPhone?: string; items?: ChatItem[]; client?: ConvoClient }> {
  await requireAdmin();
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true, name: true, phone: true, email: true, backupEmail: true, company: true, segment: true, socialClient: true, socialPlan: true },
  });
  if (!c?.phone) return { ok: false, message: "No phone number on file for this client." };
  const k = phoneKey(c.phone);
  if (k.length !== 10) return { ok: false, message: "Phone number looks invalid." };
  const numId = await defaultOpenPhoneNumberId();
  if (!numId) return { ok: false, message: "OpenPhone isn't connected." };

  const { items, note } = await loadConversation(numId, [`+1${k}`]);
  if (note && items.length === 0) return { ok: false, message: note };
  return { ok: true, message: note ?? "ok", toPhone: `+1${k}`, items, client: c };
}

// Send a text/MMS in a conversation. Human-initiated (a person clicks Send).
export async function sendThreadText(
  toPhone: string,
  content: string,
  mediaUrls?: string[],
  clientId?: string | null,
): Promise<SendResult> {
  await requireAdmin();
  const text = content.trim();
  if (!text && !(mediaUrls && mediaUrls.length)) return { ok: false, message: "Write a message first." };
  // toPhone may be a comma-separated list for a group message.
  const tos = toPhone.split(",").map((x) => phoneKey(x)).filter((k) => k.length === 10).map((k) => `+1${k}`);
  if (tos.length === 0) return { ok: false, message: "That phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  try {
    await OpenPhone.sendMessage(from, tos.length === 1 ? tos[0] : tos, text || "📎", mediaUrls);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send." };
  }

  if (clientId) {
    const recent = await prisma.project.findFirst({
      where: { clientId }, orderBy: [{ orderedAt: { sort: "desc", nulls: "last" } }], select: { id: true },
    });
    if (recent) {
      await prisma.activity.create({ data: { projectId: recent.id, type: "SYSTEM", body: `Text sent: ${(text || "[attachment]").slice(0, 200)}` } });
    }
    await closeReplyForOutbound(clientId, text || "");
  }
  return { ok: true, message: "Sent." };
}

// A trimmed turn the chat UI hands back so the AI can read the whole thread.
export type DraftTurn = { kind: string; direction?: string; text?: string; at?: string; from?: string };

// AI-draft a reply using the FULL conversation plus who the client is and what
// work they have in flight — a genuinely informed "smart reply", not a one-liner
// reaction to the last message. The chat already holds the thread in memory, so
// it passes it straight back (no re-fetch); we add the client/project context.
export async function draftThreadReply(
  clientId: string | null,
  clientName: string | null,
  transcript: DraftTurn[],
  opts?: { isGroup?: boolean; memberNames?: Record<string, string> },
): Promise<{ ok: boolean; message: string; draft?: string }> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft replies." };
  try {
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");

    // Build the conversation transcript (messages only, oldest first).
    const memberNames = opts?.memberNames ?? {};
    const key10 = (p?: string) => (p || "").replace(/\D/g, "").slice(-10);
    const turns = (transcript || [])
      .filter((t) => t.kind === "message" && t.text && t.text.trim())
      .map((t) => {
        const out = (t.direction || "").toLowerCase().startsWith("out");
        return {
          role: (out ? "us" : "client") as "us" | "client",
          text: t.text!,
          at: t.at ?? null,
          sender: !out && opts?.isGroup ? (memberNames[key10(t.from)] ?? null) : null,
        };
      });
    if (turns.length === 0) return { ok: false, message: "Nothing to reply to yet." };

    // Client relationship + work in flight (cheap, indexed lookups).
    let segment: string | null = null;
    let socialPlan: string | null = null;
    let projects: { title: string; status: string }[] = [];
    if (clientId) {
      const c = await prisma.client.findUnique({
        where: { id: clientId },
        select: { segment: true, socialClient: true, socialPlan: true },
      });
      segment = c?.segment ?? null;
      socialPlan = c?.socialClient ? (c?.socialPlan ?? "yes") : null;
      projects = await prisma.project.findMany({
        where: { clientId },
        orderBy: { orderedAt: { sort: "desc", nulls: "last" } },
        take: 6,
        select: { title: true, status: true },
      });
    }
    const propertyAddress = projects[0]?.title ?? null;
    const lastClientText = [...turns].reverse().find((t) => t.role === "client")?.text ?? "";
    const { relevantPolicies } = await import("@/lib/policies");

    const draft = await draftReplyWithContext({
      channel: "text",
      clientName,
      segment,
      socialPlan,
      propertyAddress,
      projects,
      transcript: turns,
      isGroup: opts?.isGroup,
      policies: await relevantPolicies(lastClientText),
    });

    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(draft)) {
      return { ok: false, message: "Looks handled — no reply needed here." };
    }
    return { ok: true, message: "Draft ready.", draft };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not draft a reply." };
  }
}

// Upload an image attachment to Dropbox and return a public URL for MMS.
export async function uploadCommAttachment(
  form: FormData,
): Promise<{ ok: boolean; url?: string; name?: string; message: string }> {
  await requireAdmin();
  const file = form.get("file");
  if (!(file instanceof File)) return { ok: false, message: "No file." };
  if (file.size > 8 * 1024 * 1024) return { ok: false, message: "Image too large (max 8 MB)." };
  try {
    const { dropboxConfigured } = await import("@/lib/integrations/dropbox");
    const { getSecret } = await import("@/lib/integrations/connections");
    if (!dropboxConfigured() || !(await getSecret("dropbox"))) {
      return { ok: false, message: "Connect Dropbox to send photo attachments." };
    }
    const { dropboxUploadPublic } = await import("@/lib/integrations/dropbox");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = `/RealTour Pilot/Attachments/${Date.now()}-${safe}`;
    const url = await dropboxUploadPublic(path, bytes);
    if (!url) return { ok: false, message: "Couldn't create a link for the attachment." };
    return { ok: true, url, name: file.name, message: "Attached." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Upload failed." };
  }
}
