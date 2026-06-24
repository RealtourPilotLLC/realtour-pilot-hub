import { prisma } from "@/lib/prisma";
import { openphoneRequest, recentOpenPhoneConversations, phoneKey, type OpMessage } from "@/lib/integrations/openphone";
import { logComm } from "@/lib/commLog";

// FULL OpenPhone text archive → comms memory. Pages every conversation and every
// message, resolves each to a client, and writes the full body to CommLog so the
// brain knows clients' real history. Idempotent on externalId=op-<messageId>
// (same scheme as the live webhook), so it's safe to re-run and it dedupes
// against messages the webhook already captured.
//   npx tsx --env-file=.env scripts/backfillOpenPhone.ts

const CONCURRENCY = 4;

// Retry OpenPhone calls on rate limit / transient errors.
async function op<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      if (i < tries - 1 && (status === 429 || status === undefined || (status && status >= 500))) {
        await new Promise((r) => setTimeout(r, (i + 1) * 1500));
        continue;
      }
      throw e;
    }
  }
  throw new Error("unreachable");
}

// All messages in one conversation (paged).
async function allMessages(phoneNumberId: string, participants: string[]): Promise<OpMessage[]> {
  const out: OpMessage[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 40; i++) {
    const res = await op(() =>
      openphoneRequest<{ data: OpMessage[]; nextPageToken?: string | null }>("/messages", {
        query: { phoneNumberId, "participants[]": participants, maxResults: 100, pageToken },
      }),
    );
    out.push(...(res.data ?? []));
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return out;
}

async function main() {
  // 1) Preload a phone(last10) -> client map (fold assistants onto the agent).
  const [clients, contacts] = await Promise.all([
    prisma.client.findMany({ select: { id: true, name: true, phone: true, parentClientId: true } }),
    prisma.contact.findMany({ where: { clientId: { not: null } }, select: { clientId: true, phones: true } }),
  ]);
  const byId = new Map(clients.map((c) => [c.id, c]));
  const effective = (id: string) => { const c = byId.get(id); return c?.parentClientId ? byId.get(c.parentClientId) ?? c : c; };
  const phoneToClient = new Map<string, { id: string; name: string }>();
  for (const c of clients) {
    const k = phoneKey(c.phone);
    if (k.length === 10) { const e = effective(c.id); if (e) phoneToClient.set(k, { id: e.id, name: e.name }); }
  }
  for (const ct of contacts) {
    if (!ct.clientId) continue;
    let phones: string[] = [];
    try { phones = ct.phones ? JSON.parse(ct.phones) : []; } catch { /* skip */ }
    for (const p of phones) {
      const k = phoneKey(p);
      if (k.length === 10 && !phoneToClient.has(k)) { const e = effective(ct.clientId); if (e) phoneToClient.set(k, { id: e.id, name: e.name }); }
    }
  }
  console.log(`Phone map: ${phoneToClient.size} numbers -> clients.`);

  // 2) Every conversation.
  let convos = await op(() => recentOpenPhoneConversations(300));
  if (process.env.LIMIT) convos = convos.slice(0, parseInt(process.env.LIMIT, 10));
  console.log(`Fetched ${convos.length} conversations. Archiving messages...`);

  // 3) Pool through conversations, paging + logging each message.
  let idx = 0, done = 0, logged = 0, matched = 0;
  async function worker() {
    while (idx < convos.length) {
      const conv = convos[idx++];
      const phoneNumberId = conv.phoneNumberId;
      const participants = (conv.participants ?? []).filter(Boolean);
      if (!phoneNumberId || participants.length === 0) { done++; continue; }
      // Resolve client from any participant.
      let client: { id: string; name: string } | undefined;
      for (const p of participants) { const hit = phoneToClient.get(phoneKey(p)); if (hit) { client = hit; break; } }
      if (client) matched++;
      let msgs: OpMessage[] = [];
      try { msgs = await allMessages(phoneNumberId, participants); }
      catch { done++; continue; }
      for (const m of msgs) {
        const text = (typeof m.text === "string" ? m.text : m.body) ?? "";
        if (!text.trim()) continue;
        const outbound = (m.direction ?? "").toLowerCase().startsWith("out");
        await logComm({
          channel: "text",
          direction: outbound ? "out" : "in",
          clientId: client?.id ?? null,
          clientName: client?.name ?? null,
          contactName: outbound ? "RealTour Pilot" : client?.name ?? (m.from ?? null),
          body: text,
          occurredAt: m.createdAt ? new Date(m.createdAt) : undefined,
          source: "openphone",
          externalId: m.id ? `op-${m.id}` : undefined,
        });
        logged++;
      }
      done++;
      if (done % 50 === 0) console.log(`  ${done}/${convos.length} convos · ${matched} matched to clients · ${logged} messages logged`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const total = await prisma.commLog.count();
  console.log(`\nDone. ${done} conversations, ${matched} matched to clients, ${logged} messages logged. CommLog total: ${total}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
