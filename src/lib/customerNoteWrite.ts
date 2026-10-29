import "server-only";
import { prisma } from "@/lib/prisma";

// ---------------------------------------------------------------------------
// WRITING THE CUSTOMER NOTE (moved here Oct 29 2026 from app/clients/actions
// saveCustomerNotes, unchanged): the one note, mirrored to Aryeo's customer
// notes (lib/clientNotes). The notes card saves through it, and so does a
// complaint's "Add to client notes" (lib/clientIssuePlan), so a preference
// added from a complaint lands exactly where a typed one does: on the shoot
// screen, the upload page and the editor's brief. The caller checks who may
// write; this never does.
//
// Order matters: the hub row is written FIRST so a flaky API can never eat
// what somebody typed, then the note is pushed to Aryeo and the outcome is
// recorded ON THE ROW. A failed push is remembered (notesSyncError) and shown
// in red on the card with a Retry, never swallowed.
// ---------------------------------------------------------------------------

export type CustomerNoteWrite = {
  ok: boolean;
  message: string;
  linked: boolean;
  /** Aryeo's copy after the push, when there is one */
  aryeoNotes: string | null;
  syncError: string | null;
  syncedAt: Date | null;
};

export async function writeCustomerNote(clientId: string, notes: string): Promise<CustomerNoteWrite> {
  const text = notes.trim();
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { aryeoCustomerId: true } });
  if (!client) return { ok: false, message: "Client not found.", linked: false, aryeoNotes: null, syncError: null, syncedAt: null };

  // 1. Local first: the note exists from here on, whatever Aryeo does next.
  await prisma.client.update({ where: { id: clientId }, data: { generalNotes: text || null } });

  // 2. No Aryeo customer behind this client → honestly hub-only. Clear any
  //    stale error so the card doesn't keep warning about a push it can't make.
  if (!client.aryeoCustomerId) {
    await prisma.client.update({ where: { id: clientId }, data: { notesSyncError: null, notesSyncedAt: null } });
    return { ok: true, message: "Saved in the hub. This client isn't linked to an Aryeo customer, so the note stays here only.", linked: false, aryeoNotes: null, syncError: null, syncedAt: null };
  }

  // 3. Push to Aryeo (the system of record) and verify it landed.
  const { writeAryeoCustomerNotes } = await import("@/lib/integrations/aryeo");
  const w = await writeAryeoCustomerNotes(client.aryeoCustomerId, text);
  if (!w.ok) {
    await prisma.client.update({ where: { id: clientId }, data: { notesSyncError: w.error.slice(0, 500) } });
    return { ok: false, message: `Saved in the hub, but it did NOT reach Aryeo: ${w.error}`, linked: true, aryeoNotes: null, syncError: w.error, syncedAt: null };
  }

  const now = new Date();
  await prisma.client.update({
    where: { id: clientId },
    // Store Aryeo's own copy back into the mirror so the two are byte-identical
    // and the next sync sees nothing to reconcile. A cleared note stores NULL,
    // never an empty string: every surface tests `generalNotes &&`.
    data: { generalNotes: text ? w.raw ?? text : null, notesSyncedAt: now, notesSyncError: null },
  });
  return { ok: true, message: "Saved, and updated in Aryeo.", linked: true, aryeoNotes: w.text, syncError: null, syncedAt: now };
}
