// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, comms audit H2): info@ mail filed to a client
// by a street or town name, from someone who is not a client.
//
// info@ is Jordan's personal inbox. The Gmail scan matched an UNKNOWN sender
// to a client by any street or town named in the mail (integrations/google.ts,
// findProjectByText), so a family memorial email, a Green Dot refund, Apple
// Cash, a line of credit and the chamber's billing were filed to clients:
// Kyle could read them, and they fed the AI's client context. The code no
// longer does it (lib/mailMatch streetMatchAllowed: never for an unknown
// sender in info@). This re-files the rows it already filed, by the same rule,
// as unmatched and owner-only: no client, no job, minRole OWNER.
//
// THE SAME RULE. The sender's address is not on a CommLog row, so it is read
// from Gmail (one metadata read per message, nothing changed in Gmail), and a
// sender is known exactly as the scan knows one: a client's email, or a
// synced contact's email that belongs to a client. Only rows the street or
// town match could have filed are read: a job set by name (projectGuess
// false); a guessed job or no job means the sender was already known. A staff
// address (Jordan's own mail, comms audit H3) is listed, not re-filed here:
// scripts/_live/oct22-jordan-staff-contact.ts covers it.
//
// Nothing else changes: tasks made from these emails are listed, not touched.
//
// Dry run (default; read-only database connection):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-info-mail-refile.ts
// Write it:
//   ... scripts/_live/oct22-info-mail-refile.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}
const INFO = "info@realtourpilot.com";
const day = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { streetMatchAllowed, sameSenderName } = await import("@/lib/mailMatch");
  const { staffAddressBook, isStaffAddress } = await import("@/lib/staffEmail");
  const { gmailSenderAddresses } = await import("@/lib/integrations/google");
  if (streetMatchAllowed({ mailbox: INFO, senderKnown: false })) throw new Error("the code rule still allows the street match for unknown info@ senders: not refiling");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: info@ mail filed to a client by a street or town name\n`);

  const rows = await prisma.commLog.findMany({
    where: { channel: "email", direction: "in", externalId: { startsWith: `gmail-${INFO}:` }, clientId: { not: null } },
    orderBy: { occurredAt: "desc" },
    select: { id: true, externalId: true, clientId: true, clientName: true, contactName: true, subject: true, projectId: true, projectGuess: true, minRole: true, occurredAt: true },
  });
  const named = rows.filter((r) => r.projectId && !r.projectGuess);
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  console.log(`info@ rows filed to a client: ${rows.length} (${rows.filter((r) => r.occurredAt >= cutoff).length} in the last 30 days); on a job named by the mail: ${named.length}`);

  // Who the scan knows, exactly as integrations/google.ts builds it.
  const [clients, contacts, book] = await Promise.all([
    prisma.client.findMany({ where: { email: { not: null } }, select: { email: true } }),
    prisma.contact.findMany({ where: { email: { not: null }, clientId: { not: null } }, select: { email: true } }),
    staffAddressBook(),
  ]);
  const knownAddresses = new Set([...clients.map((c) => c.email!.toLowerCase()), ...contacts.map((c) => c.email!.toLowerCase())]);
  const ids = named.map((r) => r.externalId!.slice(`gmail-${INFO}:`.length));
  const senders = await gmailSenderAddresses(INFO, ids);
  console.log(`read the sender of ${senders.size} message(s) from Gmail (read only)\n`);

  const wrong: typeof named = [];
  const self: typeof named = [];
  const staff: typeof named = [];
  const unread: typeof named = [];
  const fromOf = new Map<string, string>();
  for (const r of named) {
    const from = senders.get(r.externalId!.slice(`gmail-${INFO}:`.length)) ?? null;
    if (!from) { unread.push(r); continue; }
    fromOf.set(r.id, from);
    if (isStaffAddress(from, book)) { staff.push(r); continue; }
    if (knownAddresses.has(from.toLowerCase())) continue;
    // The code's one exception: the client writing from an address the hub does not have.
    if (sameSenderName(r.contactName, r.clientName)) { self.push(r); continue; }
    wrong.push(r);
  }
  console.log(`from a sender the hub does not know (the street or town match): ${wrong.length} (${wrong.filter((r) => r.occurredAt >= cutoff).length} in the last 30 days)`);
  console.log(`from a staff address (left for the H3 script): ${staff.length}; sender unreadable (left as they are): ${unread.length}`);
  console.log(`the client themself from an address the hub does not have (kept; add the address to the client): ${self.length}\n`);
  const projects = new Map((await prisma.project.findMany({ where: { id: { in: [...new Set(wrong.map((r) => r.projectId!))] } }, select: { id: true, title: true } })).map((p) => [p.id, p.title.split(",")[0]]));
  for (const r of wrong) {
    console.log(`  · ${r.id} ${day(r.occurredAt)} from ${fromOf.get(r.id)} ("${r.contactName ?? "?"}") "${(r.subject ?? "").slice(0, 70)}"`);
    console.log(`      filed to ${r.clientName} on ${projects.get(r.projectId!) ?? r.projectId} [${r.minRole}] → no client, no job, owner-only`);
  }
  if (self.length) {
    console.log(`\nThe client themself, from an address not on file (kept as they are):`);
    for (const a of [...new Map(self.map((r) => [`${r.clientName}|${fromOf.get(r.id)}`, r])).values()]) console.log(`  · ${a.clientName} writes from ${fromOf.get(a.id)} (${self.filter((r) => r.clientName === a.clientName && fromOf.get(r.id) === fromOf.get(a.id)).length} row(s))`);
  }
  if (staff.length) {
    console.log(`\nFrom a staff address (not changed here):`);
    for (const r of staff) console.log(`  · ${r.id} ${day(r.occurredAt)} from ${fromOf.get(r.id)} "${(r.subject ?? "").slice(0, 70)}" filed to ${r.clientName}`);
  }

  // Tasks the scan made from these emails (same client, a gmail to-do within 15 minutes, naming the subject): listed only.
  const tasks: { id: string; title: string; status: string; client: string | null; row: string }[] = [];
  for (const r of wrong) {
    const subj = (r.subject ?? "").replace(/^(re|fwd?|fw)\s*:\s*/i, "").slice(0, 30);
    if (subj.length < 6) continue;
    const t = await prisma.smartTask.findMany({
      where: { clientId: r.clientId, source: { startsWith: "gmail" }, createdAt: { gte: new Date(r.occurredAt.getTime() - 60_000), lte: new Date(r.occurredAt.getTime() + 15 * 60_000) }, OR: [{ title: { contains: subj, mode: "insensitive" } }, { description: { contains: subj, mode: "insensitive" } }, { summary: { contains: subj, mode: "insensitive" } }] },
      select: { id: true, title: true, status: true },
    });
    for (const x of t) tasks.push({ ...x, client: r.clientName, row: r.id });
  }
  console.log(`\nTasks made from these emails (left as they are; a person decides): ${tasks.length}`);
  for (const t of tasks) console.log(`  · ${t.id} [${t.status}] "${t.title}" on ${t.client} (from ${t.row})`);

  if (!APPLY) {
    console.log("\nNothing was written. Run with --apply to re-file these rows.");
    process.exit(0);
  }
  let n = 0;
  for (const r of wrong) {
    const u = await prisma.commLog.updateMany({
      where: { id: r.id, clientId: r.clientId, projectId: r.projectId },
      data: { clientId: null, clientName: null, projectId: null, projectGuess: false, minRole: "OWNER" },
    });
    n += u.count;
  }
  console.log(`\nRe-filed ${n} row(s) as unmatched and owner-only.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
