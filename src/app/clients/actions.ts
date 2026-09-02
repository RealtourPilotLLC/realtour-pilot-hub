"use server";

import { requireAdmin } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { OpenPhone, defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";
import { closeReplyForOutbound } from "@/lib/tasks";

export type ActionResult = { ok: boolean; message: string; draft?: string };

// (Re)build the client's AI working profile from comms, shoot notes, revisions.
export async function regenerateClientProfile(clientId: string): Promise<{ ok: boolean; message: string }> {
  await requireAdmin();
  const { buildClientProfile } = await import("@/lib/clientProfile");
  const r = await buildClientProfile(clientId);
  if (r.ok) revalidatePath(`/clients/${clientId}`);
  return { ok: r.ok, message: r.ok ? "Profile updated." : r.error ?? "Could not build the profile." };
}

// Most-recent project for a client (for logging activity against).
async function recentProjectId(clientId: string): Promise<string | null> {
  const p = await prisma.project.findFirst({
    where: { clientId },
    orderBy: [
      { orderedAt: { sort: "desc", nulls: "last" } },
      { shootDate: { sort: "desc", nulls: "last" } },
      { createdAt: "desc" },
    ],
    select: { id: true },
  });
  return p?.id ?? null;
}

// Send a text to the client via OpenPhone. Human-initiated (Kyle clicks Send).
export async function sendClientText(clientId: string, body: string): Promise<ActionResult> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { phone: true, name: true } });
  if (!client?.phone) return { ok: false, message: "No phone number on file for this client." };
  const k = phoneKey(client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };

  try {
    await OpenPhone.sendMessage(from, `+1${k}`, text);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send text." };
  }

  // Log it + clear any open reply task (the webhook also does this; do it now too).
  const projectId = await recentProjectId(clientId);
  if (projectId) {
    await prisma.activity.create({
      data: { projectId, type: "SYSTEM", body: `Text sent to ${client.name}: ${text.slice(0, 200)}` },
    });
  }
  await closeReplyForOutbound(clientId, text);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/");
  revalidatePath("/queue");
  return { ok: true, message: "Text sent." };
}

// Load the client's recent Gmail conversation (read-only) for the email panel.
export async function loadClientEmails(
  clientId: string,
): Promise<{ ok: boolean; message: string; emails?: import("@/lib/integrations/google").GmailEmail[] }> {
  await requireAdmin();
  const { googleConfigured, clientEmailThreads } = await import("@/lib/integrations/google");
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!googleConfigured() || !(await getSecret("gmail"))) {
    return { ok: false, message: "Connect Gmail in Connections to see email here." };
  }
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { email: true, backupEmail: true },
  });
  const addrs = [c?.email, c?.backupEmail].filter((e): e is string => Boolean(e));
  if (addrs.length === 0) return { ok: false, message: "No email on file for this client." };
  try {
    const emails = await clientEmailThreads(addrs);
    return { ok: true, message: "ok", emails };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't load emails." };
  }
}

// AI-draft a reply in our voice (for email — Kyle copies/sends from their mail app).
export async function draftClientReply(
  clientId: string,
  channel: "email" | "text",
  lastMessage: string,
): Promise<ActionResult> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft replies." };
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true, segment: true, socialClient: true, socialPlan: true,
      projects: { orderBy: { orderedAt: { sort: "desc", nulls: "last" } }, take: 6, select: { title: true, status: true } },
    },
  });
  try {
    const { relevantPolicies } = await import("@/lib/policies");
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const draft = await draftReplyWithContext({
      channel,
      clientName: client?.name,
      segment: client?.segment ?? null,
      socialPlan: client?.socialClient ? (client?.socialPlan ?? "yes") : null,
      propertyAddress: client?.projects[0]?.title ?? null,
      projects: client?.projects ?? [],
      transcript: [{ role: "client", text: lastMessage || "(no recent message — write a friendly check-in)" }],
      policies: await relevantPolicies(lastMessage),
    });
    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(draft)) return { ok: false, message: "Looks handled — no reply needed here." };
    return { ok: true, message: "Draft ready. Review before sending.", draft };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not draft a reply." };
  }
}

// Draft an AI reply to a client's most recent EMAIL — reads the whole Gmail
// thread for context, and when they're asking about availability, pulls real
// open shoot dates from Aryeo's scheduling calendar so the draft offers them.
export async function draftEmailReply(clientId: string): Promise<ActionResult> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft replies." };
  const { googleConfigured, clientEmailThreads } = await import("@/lib/integrations/google");
  if (!googleConfigured() || !(await getSecret("gmail"))) return { ok: false, message: "Connect Gmail to draft email replies." };

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: {
      name: true, email: true, backupEmail: true, segment: true, socialClient: true, socialPlan: true,
      projects: { orderBy: { orderedAt: { sort: "desc", nulls: "last" } }, take: 6, select: { title: true, status: true } },
    },
  });
  const addrs = [client?.email, client?.backupEmail].filter((e): e is string => Boolean(e));
  if (addrs.length === 0) return { ok: false, message: "No email on file for this client." };

  let emails;
  try {
    emails = await clientEmailThreads(addrs);
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not load the email thread." };
  }
  if (!emails || emails.length === 0) return { ok: false, message: "No email thread to reply to." };

  const transcript = emails.map((e) => ({
    role: e.fromUs ? ("us" as const) : ("client" as const),
    text: [e.subject, e.body || e.snippet].filter(Boolean).join("\n"),
    at: e.date,
    sender: e.fromUs ? null : e.from || client?.name || null,
  }));
  const lastClient = [...emails].reverse().find((e) => !e.fromUs);
  const lastText = lastClient ? `${lastClient.subject}\n${lastClient.body || lastClient.snippet}` : "";

  // If they're asking when we can shoot, fetch real open dates from Aryeo.
  let availability: string | null = null;
  if (/\b(availab|when can|what (day|days|time|times)|schedul|book|come out|opening|calendar|times? work|soonest)\b/i.test(lastText)) {
    try {
      const { getSchedulingAvailability } = await import("@/lib/integrations/aryeo");
      const { etDate } = await import("@/lib/datetime");
      const slots = await getSchedulingAvailability({ limit: 6 });
      if (slots?.length) availability = slots.map((s) => etDate(new Date(`${s.date}T12:00:00Z`))).join(", ");
    } catch {
      /* draft without availability */
    }
  }

  try {
    const { relevantPolicies } = await import("@/lib/policies");
    const policies = await relevantPolicies(lastText);
    const { draftReplyWithContext } = await import("@/lib/integrations/ai");
    const draft = await draftReplyWithContext({
      channel: "email",
      clientName: client?.name,
      segment: client?.segment ?? null,
      socialPlan: client?.socialClient ? client?.socialPlan ?? "yes" : null,
      propertyAddress: client?.projects[0]?.title ?? null,
      projects: client?.projects ?? [],
      transcript,
      availability,
      policies,
    });
    if (/^\s*NO_REPLY_NEEDED\s*$/i.test(draft)) return { ok: false, message: "Looks handled — no reply needed here." };
    return {
      ok: true,
      message: availability ? "Draft ready with our open shoot dates. Review before sending." : "Draft ready. Review before sending.",
      draft,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not draft a reply." };
  }
}

// ---------------------------------------------------------------------------
// Customer notes — ONE list, Aryeo owns it.
//
// Jordan, Sep 2: "if we add customer notes to the hub it should save to the
// customer notes in Aryeo — I just want to make sure we don't have different
// customer notes in different spots." So `Client.generalNotes` is a mirror of
// the Aryeo customer's `internal_notes`, never a second, parallel note.
//
// This is the ONLY writer of a customer note in the app. The older
// `Client.editingPreferences` column lost its writer when this card replaced
// saveClientNotes, and no second box is coming back: a probe on Sep 2 found it
// NULL on all 349 clients while the 17 real notes live in generalNotes and read
// as editing instructions anyway ("Always add his animated logo on his videos").
// A second box would rebuild exactly the split Jordan asked us to remove, and
// only one of the two would reach Aryeo. Every creative surface therefore reads
// the merged note through src/lib/clientNotes.ts (legacy column as fallback), so
// what is typed here is what the photographer, the editor and QC see.
// ---------------------------------------------------------------------------

export type CustomerNotesState = {
  ok: boolean;
  message: string;
  /** false = no Aryeo customer behind this client, so the note IS hub-only. */
  linked: boolean;
  /** Aryeo's own copy, as plain text (null when we couldn't read it). */
  aryeoNotes: string | null;
  /** Set when the last write-back failed — the note is saved here but not there. */
  syncError: string | null;
  /** ET string for "last confirmed against Aryeo". */
  syncedAt: string | null;
};

// Read Aryeo's live copy so the card can show ONE reconciled list (and say so
// out loud when Aryeo's copy has moved on since we last mirrored it).
export async function loadCustomerNotes(clientId: string): Promise<CustomerNotesState> {
  await requireAdmin();
  const { etDateTime } = await import("@/lib/datetime");
  const c = await prisma.client.findUnique({
    where: { id: clientId },
    select: { aryeoCustomerId: true, notesSyncedAt: true, notesSyncError: true },
  });
  const base = {
    linked: !!c?.aryeoCustomerId,
    syncError: c?.notesSyncError ?? null,
    syncedAt: c?.notesSyncedAt ? etDateTime(c.notesSyncedAt) : null,
  };
  if (!c?.aryeoCustomerId) {
    return { ok: true, message: "Not linked to an Aryeo customer.", aryeoNotes: null, ...base };
  }
  const { readAryeoCustomerNotes } = await import("@/lib/integrations/aryeo");
  const r = await readAryeoCustomerNotes(c.aryeoCustomerId);
  if (!r.ok) return { ok: false, message: r.error, aryeoNotes: null, ...base };
  return { ok: true, message: "ok", aryeoNotes: r.text, ...base };
}

// Save the customer note. Order matters: the hub row is written FIRST so a
// flaky API can never eat what somebody typed, then the note is pushed to Aryeo
// and the outcome is recorded ON THE ROW. A failed push is remembered
// (notesSyncError) and shown in red on the card with a Retry — never swallowed.
export async function saveCustomerNotes(clientId: string, notes: string): Promise<CustomerNotesState> {
  await requireAdmin();
  const { etDateTime } = await import("@/lib/datetime");
  const text = notes.trim();

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { aryeoCustomerId: true },
  });
  if (!client) return { ok: false, message: "Client not found.", linked: false, aryeoNotes: null, syncError: null, syncedAt: null };

  // 1. Local first — the note exists from here on, whatever Aryeo does next.
  await prisma.client.update({ where: { id: clientId }, data: { generalNotes: text || null } });

  // 2. No Aryeo customer behind this client → honestly hub-only. Clear any
  //    stale error so the card doesn't keep warning about a push it can't make.
  if (!client.aryeoCustomerId) {
    await prisma.client.update({
      where: { id: clientId },
      data: { notesSyncError: null, notesSyncedAt: null },
    });
    revalidatePath(`/clients/${clientId}`);
    return {
      ok: true,
      message: "Saved in the hub. This client isn't linked to an Aryeo customer, so the note stays here only.",
      linked: false,
      aryeoNotes: null,
      syncError: null,
      syncedAt: null,
    };
  }

  // 3. Push to Aryeo — the system of record — and verify it landed.
  const { writeAryeoCustomerNotes } = await import("@/lib/integrations/aryeo");
  const w = await writeAryeoCustomerNotes(client.aryeoCustomerId, text);
  if (!w.ok) {
    await prisma.client.update({
      where: { id: clientId },
      data: { notesSyncError: w.error.slice(0, 500) },
    });
    revalidatePath(`/clients/${clientId}`);
    return {
      ok: false,
      message: `Saved in the hub, but it did NOT reach Aryeo: ${w.error}`,
      linked: true,
      aryeoNotes: null,
      syncError: w.error,
      syncedAt: null,
    };
  }

  const now = new Date();
  await prisma.client.update({
    where: { id: clientId },
    // Store Aryeo's own copy back into the mirror so the two are byte-identical
    // and the next sync sees nothing to reconcile. A cleared note stores NULL,
    // never an empty string — every surface tests `generalNotes &&`.
    data: { generalNotes: text ? w.raw ?? text : null, notesSyncedAt: now, notesSyncError: null },
  });
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/clients");
  return {
    ok: true,
    message: "Saved — and updated in Aryeo.",
    linked: true,
    aryeoNotes: w.text,
    syncError: null,
    syncedAt: etDateTime(now),
  };
}

// Save the Agent Profile — brand colors + how the client likes to work.
export async function saveAgentProfile(
  clientId: string,
  clientPreferences: string,
  brandColors: string,
): Promise<ActionResult> {
  await requireAdmin();
  await prisma.client.update({
    where: { id: clientId },
    data: {
      clientPreferences: clientPreferences.trim() || null,
      brandColors: brandColors.trim() || null,
    },
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, message: "Agent profile saved." };
}

// Create / link the client's brand-assets Dropbox folder.
export async function setupBrandFolder(
  clientId: string,
): Promise<ActionResult & { url?: string }> {
  await requireAdmin();
  const { ensureClientBrandFolder } = await import("@/lib/clientFolders");
  const r = await ensureClientBrandFolder(clientId);
  if (r.ok) revalidatePath(`/clients/${clientId}`);
  return { ok: r.ok, message: r.message, url: r.url };
}
