"use server";

import { requireAdmin, requireCreativeLead, requireRole } from "@/lib/auth/guards";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { defaultOpenPhoneNumber, phoneKey } from "@/lib/integrations/openphone";
import { closeReplyForOutbound } from "@/lib/tasks";

export type ActionResult = { ok: boolean; message: string; draft?: string };

// (Re)build the client's AI working profile from comms, shoot notes, revisions.
export async function regenerateClientProfile(clientId: string): Promise<{ ok: boolean; message: string }> {
  await requireCreativeLead();
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

// Send a text to the client via OpenPhone. Human-initiated (a person clicks
// Send on Ask the Hub's draft card).
//
// THROUGH THE OUTBOX (Oct 20 2026, audit F2). This called OpenPhone directly:
// no per-press identity, no duplicate check, no TEST-client floor, a timeout
// or 5xx reported as a plain failure (the text may well have gone), and the
// bookkeeping after an accepted send unguarded, so one throw there brought the
// Send button back. Every one of those invites the second press that puts the
// message on the client's phone twice. Same rail and same rules as
// communications/threadActions.sendThreadText.
export async function sendClientText(
  clientId: string,
  body: string,
  /** The id the BROWSER minted for this press (see outbox.manualKey). */
  intentId?: string,
): Promise<ActionResult & { pending?: boolean }> {
  await requireAdmin();
  const text = body.trim();
  if (!text) return { ok: false, message: "Write a message first." };
  if (!intentId || !/^[A-Za-z0-9_-]{8,64}$/.test(intentId)) {
    return { ok: false, message: "Refresh this page and try again. We couldn't identify this send, and we won't guess in case it doubles up." };
  }
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { phone: true, name: true } });
  if (!client?.phone) return { ok: false, message: "No phone number on file for this client." };
  const k = phoneKey(client.phone);
  if (k.length !== 10) return { ok: false, message: "Client phone number looks invalid." };
  const from = await defaultOpenPhoneNumber();
  if (!from) return { ok: false, message: "OpenPhone isn't connected." };
  // Oct 22 2026 (comms audit H6): no "your time is set" while a booking conflict is open for this client.
  {
    const { staffConfirmationRefusal } = await import("@/lib/bookingConflictHold");
    const refused = await staffConfirmationRefusal({ clientId, body: text });
    if (refused) return { ok: false, message: refused };
  }

  const { getCurrentUser } = await import("@/lib/auth/user");
  const actor = await getCurrentUser().catch(() => null);
  const { sendThroughOutbox, manualKey } = await import("@/lib/outbox");
  let sentId: string | null = null;
  try {
    const res = await sendThroughOutbox({
      channel: "sms",
      toRef: k,
      body: text,
      dedupeKey: manualKey(intentId),
      clientId,
      requestedBy: actor?.email ?? actor?.name ?? null,
    });
    if (res.outcome === "accepted") sentId = res.providerId ?? null;
    else if (res.outcome === "failed") return { ok: false, message: `OpenPhone refused it: ${res.error}` };
    else if (res.outcome === "duplicate" || res.outcome === "busy") return { ok: true, message: "That one's already going out. We didn't send it twice." };
    else {
      return {
        ok: false,
        pending: true,
        message: `OpenPhone didn't confirm this one, so we can't say yet whether it reached ${client.name}. It's saved and marked unconfirmed. Check the conversation before sending again.`,
      };
    }
  } catch (e) {
    if ((e as Error)?.name === "TestClientSendRefusedError") return { ok: false, message: (e as Error).message };
    return { ok: false, message: e instanceof Error ? e.message : "Failed to send text." };
  }

  // Our own record, so the conversation stops reading "waiting" before the
  // delivery webhook lands. Same externalId the webhook uses, so it dedupes.
  await import("@/lib/commLog")
    .then(({ logComm }) =>
      logComm({
        channel: "text",
        direction: "out",
        clientId,
        clientName: client.name,
        contactName: "Us",
        fromPhone: k,
        body: text,
        source: "openphone",
        externalId: sentId ? `op-${sentId}` : undefined,
      }),
    )
    .catch(() => { /* already sent: a log failure must not report failure */ });
  if (sentId) {
    await import("@/lib/commSenders")
      .then(({ stampCommActor }) => stampCommActor({ externalId: `op-${sentId}`, wrote: "the hub" }))
      .catch(() => { /* attribution never fails a sent text */ });
  }

  // The text has gone. Every step below is isolated, and a failure is a note
  // on a SUCCESSFUL send, never a failure of it.
  const notLogged: string[] = [];
  try {
    const projectId = await recentProjectId(clientId);
    if (projectId) {
      await prisma.activity.create({
        data: { projectId, type: "SYSTEM", body: `Text sent to ${client.name}: ${text.slice(0, 200)}` },
      });
    }
  } catch {
    notLogged.push("it isn't on the job's timeline");
  }
  try {
    await closeReplyForOutbound(clientId, text);
  } catch {
    notLogged.push("the reply task didn't close");
  }
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/");
  revalidatePath("/queue");
  if (notLogged.length) return { ok: true, message: `Sent, but ${notLogged.join(" and ")}. The text went out; this is only our own record.` };
  return { ok: true, message: "Text sent." };
}

// Load the client's recent Gmail conversation (read-only) for the email panel.
export async function loadClientEmails(
  clientId: string,
): Promise<{ ok: boolean; message: string; emails?: import("@/lib/integrations/google").GmailEmail[] }> {
  // A read: allowed while the owner previews "view as" (audit F8, Oct 20 2026).
  try { await requireRole(["OWNER", "ADMIN"], { allowImpersonation: true }); } catch (e) { return { ok: false, message: e instanceof Error ? e.message : "You don't have access to this." }; }
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
    // The money rule on the client's own words (audit F7): owner only.
    const { viewerMoneyView } = await import("@/components/comms/viewerScrub");
    const { seesMoney, clean } = await viewerMoneyView();
    return {
      ok: true,
      message: "ok",
      emails: seesMoney ? emails : emails.map((e) => ({ ...e, subject: clean(e.subject ?? ""), snippet: clean(e.snippet ?? ""), body: clean(e.body ?? "") })),
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Couldn't load emails." };
  }
}

// Oct 21 2026 (audit F9, Jordan): draftClientReply, the customer-notes card's
// "Email draft" tab, is gone with that tab. The page keeps one email draft,
// draftEmailReply below (ClientEmails), which reads the whole Gmail thread.

// Draft an AI reply to a client's most recent EMAIL — reads the whole Gmail
// thread for context, and when they're asking about availability, pulls real
// open shoot dates from Aryeo's scheduling calendar so the draft offers them.
// Oct 27 2026: the draft is the starting text of the reply box under it, which
// sends into that Gmail thread when a person presses Send (app/emailActions).
// The drafting itself is lib/emailReplyDraft, shared with Messages · Email.
export async function draftEmailReply(clientId: string): Promise<ActionResult> {
  await requireAdmin();
  const { getSecret } = await import("@/lib/integrations/connections");
  if (!(await getSecret("ai"))) return { ok: false, message: "Add an AI key in Connections to draft replies." };
  const { googleConfigured, clientEmailThreads } = await import("@/lib/integrations/google");
  if (!googleConfigured() || !(await getSecret("gmail"))) return { ok: false, message: "Connect Gmail to draft email replies." };

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true, email: true, backupEmail: true },
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

  const { draftEmailFromTranscript } = await import("@/lib/emailReplyDraft");
  return draftEmailFromTranscript({ clientId, fallbackName: client?.name ?? null, transcript, lastText });
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
  await requireCreativeLead();
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
  await requireCreativeLead();
  const { ensureClientBrandFolder } = await import("@/lib/clientFolders");
  const r = await ensureClientBrandFolder(clientId);
  if (r.ok) revalidatePath(`/clients/${clientId}`);
  return { ok: r.ok, message: r.message, url: r.url };
}
