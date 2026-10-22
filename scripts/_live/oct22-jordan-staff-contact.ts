// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, audit H3). Jordan's own emails filed under a
// client named "Jordan Spackman".
//
// A HubSpot import (OpenPhone contacts, source openphone-hubspot / csv-v2)
// linked info@realtourpilot.com and jspackman215@gmail.com to the client
// cmqikskt1008u9k9qej9ltjy5 ("Jordan Spackman", Jordan's own Aryeo customer
// record). Gmail sync resolves a sender by Client.email, then by Contact.email,
// so every email Jordan forwarded or wrote from those addresses was logged as
// that client writing in, and the Smart Brain opened that client's tasks for
// other clients' work (Alex's Pine Ford photos, Bernadette's 2236 Gregory
// staging, Jeff Scott's 75 Nield audio).
//
// The code fix (staff addresses are staff before any client lookup) stops new
// ones. This script:
//   (a) unlinks the two addresses from that client: the Contact rows carrying
//       them lose their clientId, and any ClientEmailAlias row for them goes
//       inactive. The client's own email column (Client.email, which is also
//       how the Aryeo enrichment finds this customer) is cleared only with
//       --clear-client-email as well, so that choice is Jordan's;
//   (b) lists every open task and open client ask on that client and, for each
//       that is about another client's work, PROPOSES the right client (from
//       the job it names, the sender address in a forwarded email, the street
//       it names, the first name it names). Nothing is moved, even on --apply.
//   (c) counts the CommLog rows filed under that client.
// Nothing is sent to anyone.
//
// Dry run (default; the database connection is read-only):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-jordan-staff-contact.ts
// Write the unlink (a):
//   ... scripts/_live/oct22-jordan-staff-contact.ts --apply [--clear-client-email]
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
const CLEAR_CLIENT_EMAIL = process.argv.includes("--clear-client-email");
if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

const CLIENT = "cmqikskt1008u9k9qej9ltjy5";
const ADDRESSES = ["info@realtourpilot.com", "jspackman215@gmail.com"];
const DONE = ["COMPLETED", "CANCELLED"];
const ASK_CLOSED = ["DONE", "CANCELLED", "CONFIRMED", "DISMISSED", "CLOSED"];

const one = (s: string | null | undefined, n = 160) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { etDateTime } = await import("@/lib/datetime");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: client ${CLIENT}\n`);

  const client = await prisma.client.findUnique({ where: { id: CLIENT }, select: { id: true, name: true, email: true, backupEmail: true, phone: true, company: true, aryeoCustomerId: true } });
  if (!client) throw new Error("client not found");
  console.log(`CLIENT: ${client.name} <${client.email ?? "-"}> backup <${client.backupEmail ?? "-"}> ${client.phone ?? ""} ${client.company ?? ""} aryeo ${client.aryeoCustomerId ?? "-"}`);

  // ---- (a) where the two addresses sit ----------------------------------
  const lower = ADDRESSES.map((a) => a.toLowerCase());
  const contacts = await prisma.contact.findMany({
    where: { email: { in: ADDRESSES, mode: "insensitive" } },
    select: { id: true, clientId: true, firstName: true, lastName: true, email: true, source: true, externalId: true },
    orderBy: { createdAt: "asc" },
  });
  const aliases = await prisma.clientEmailAlias.findMany({ where: { email: { in: lower } }, select: { id: true, clientId: true, email: true, source: true, active: true } });
  const clientCols = await prisma.client.findMany({
    where: { OR: [{ email: { in: ADDRESSES, mode: "insensitive" } }, { backupEmail: { in: ADDRESSES, mode: "insensitive" } }] },
    select: { id: true, name: true, email: true, backupEmail: true },
  });
  const allContacts = await prisma.contact.findMany({ where: { clientId: CLIENT }, select: { id: true, email: true, source: true, firstName: true, lastName: true } });

  console.log(`\n(a) WHERE THE TWO ADDRESSES SIT`);
  console.log(`  Contact rows (${contacts.length}):`);
  for (const k of contacts) console.log(`    · ${k.id} ${k.email} "${[k.firstName, k.lastName].filter(Boolean).join(" ")}" source ${k.source} → client ${k.clientId ?? "none"}${k.clientId === CLIENT ? " (THIS client)" : ""}`);
  console.log(`  ClientEmailAlias rows (${aliases.length}):`);
  for (const a of aliases) console.log(`    · ${a.id} ${a.email} → client ${a.clientId} ${a.active ? "active" : "inactive"} (${a.source})`);
  console.log(`  Client columns (${clientCols.length}):`);
  for (const c of clientCols) console.log(`    · ${c.id} "${c.name}" email ${c.email ?? "-"} backupEmail ${c.backupEmail ?? "-"}`);
  const others = allContacts.filter((k) => !contacts.some((x) => x.id === k.id));
  console.log(`  Other Contact rows on this client, left as they are (${others.length}): ${others.map((k) => k.email ?? "(no email)").join(", ")}`);

  const contactUnlink = contacts.filter((k) => k.clientId === CLIENT);
  const aliasOff = aliases.filter((a) => a.clientId === CLIENT && a.active);
  const emailCol = client.email && lower.includes(client.email.toLowerCase()) ? client.email : null;
  const backupCol = client.backupEmail && lower.includes(client.backupEmail.toLowerCase()) ? client.backupEmail : null;
  console.log(`\n  PLAN (a):`);
  console.log(`    1. Contact.clientId → null on ${contactUnlink.length} row(s): ${contactUnlink.map((k) => `${k.id} (${k.email})`).join(", ") || "none"}`);
  console.log(`    2. ClientEmailAlias.active → false on ${aliasOff.length} row(s)${aliasOff.length ? `: ${aliasOff.map((a) => a.id).join(", ")}` : ""}`);
  if (emailCol || backupCol) {
    console.log(`    3. Client.${emailCol ? "email" : "backupEmail"} "${emailCol ?? backupCol}" on ${client.id}: ${CLEAR_CLIENT_EMAIL ? "cleared (--clear-client-email)" : "LEFT AS IT IS (pass --clear-client-email to clear it; it is how the Aryeo enrichment finds this customer, and the code fix already reads it as staff)"}`);
  }

  // ---- (b) open tasks and asks, with the client each belongs to ---------
  const tasks = await prisma.smartTask.findMany({
    where: { clientId: CLIENT, status: { notIn: DONE } },
    orderBy: { createdAt: "asc" },
    select: { id: true, title: true, description: true, taskType: true, status: true, projectId: true, source: true, createdAt: true, assignedKey: true },
  });
  const asks = await prisma.clientAsk.findMany({
    where: { clientId: CLIENT, state: { notIn: ASK_CLOSED } },
    orderBy: { createdAt: "asc" },
    select: { id: true, kind: true, state: true, text: true, summary: true, projectId: true, sourceRef: true, createdAt: true },
  });
  const ownProjects = new Set((await prisma.project.findMany({ where: { clientId: CLIENT }, select: { id: true } })).map((p) => p.id));

  // Staff addresses never name a client.
  const staff = new Set<string>(lower);
  for (const u of await prisma.appUser.findMany({ select: { email: true } })) if (u.email) staff.add(u.email.toLowerCase());
  for (const m of await prisma.teamMember.findMany({ select: { email: true } })) if (m.email) staff.add(m.email.toLowerCase());
  const isStaff = (a: string) => staff.has(a) || a.endsWith("@realtourpilot.com") || a.endsWith("@realtorpilot.com");

  type Vote = { clientId: string; why: string[] };
  const propose = async (text: string, projectId: string | null): Promise<Vote[]> => {
    const votes = new Map<string, Vote>();
    const vote = (clientId: string | null | undefined, why: string) => {
      if (!clientId || clientId === CLIENT) return;
      const v = votes.get(clientId) ?? { clientId, why: [] };
      if (!v.why.includes(why)) v.why.push(why);
      votes.set(clientId, v);
    };
    // 1. the job the row is on, when it is another client's
    if (projectId && !ownProjects.has(projectId)) {
      const p = await prisma.project.findUnique({ where: { id: projectId }, select: { clientId: true, title: true } });
      vote(p?.clientId, `its job "${p?.title}" is theirs`);
    }
    // 2. sender addresses in a forwarded email ("From: Alex <alex@...>")
    const emails = [...new Set((text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((e) => e.toLowerCase()))].filter((e) => !isStaff(e));
    for (const e of emails) {
      const c = await prisma.client.findFirst({ where: { OR: [{ email: { equals: e, mode: "insensitive" } }, { backupEmail: { equals: e, mode: "insensitive" } }] }, select: { id: true, parentClientId: true } });
      if (c) { vote(c.parentClientId ?? c.id, `the email names ${e}`); continue; }
      const k = await prisma.contact.findFirst({ where: { email: { equals: e, mode: "insensitive" }, clientId: { not: null } }, select: { clientId: true } });
      if (k) { vote(k.clientId, `the email names ${e} (a contact)`); continue; }
      const a = await prisma.clientEmailAlias.findFirst({ where: { email: e, active: true }, select: { clientId: true } });
      if (a) vote(a.clientId, `the email names ${e} (an alias)`);
    }
    // 3. a street it names ("2236 Gregory", "75 Nield Rd") or a named place ("Pine Ford")
    const streets = [...new Set([...text.matchAll(/\b(\d{1,5})\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)/g)].map((m) => `${m[1]} ${m[2].split(/\s+/)[0]}`))];
    for (const s of streets) {
      const ps = await prisma.project.findMany({ where: { title: { startsWith: s, mode: "insensitive" }, clientId: { not: CLIENT } }, select: { clientId: true, title: true }, take: 3 });
      for (const p of ps) vote(p.clientId, `the text names ${s} ("${p.title}")`);
    }
    for (const place of [...new Set([...text.matchAll(/\b([A-Z][a-z]+ [A-Z][a-z]+)\s+(?:Zillow|listing|photos?|shoot|video)/g)].map((m) => m[1]))]) {
      const ps = await prisma.project.findMany({ where: { title: { contains: place, mode: "insensitive" }, clientId: { not: CLIENT } }, select: { clientId: true, title: true }, take: 3 });
      for (const p of ps) vote(p.clientId, `the text names "${place}" ("${p.title}")`);
    }
    // 4. a first name it names that belongs to a client already voted for
    for (const v of votes.values()) {
      const c = await prisma.client.findUnique({ where: { id: v.clientId }, select: { name: true } });
      const first = (c?.name ?? "").split(/\s+/)[0];
      if (first.length >= 3 && new RegExp(`\\b${first}\\b`, "i").test(text)) v.why.push(`the text names ${first}`);
    }
    return [...votes.values()].sort((a, b) => b.why.length - a.why.length);
  };

  const nameOf = async (id: string) => (await prisma.client.findUnique({ where: { id }, select: { name: true } }))?.name ?? "?";
  console.log(`\n(b) OPEN TASKS ON THIS CLIENT (${tasks.length}). Proposals only: nothing is moved.`);
  for (const t of tasks) {
    const text = `${t.title}\n${t.description ?? ""}`;
    const votes = await propose(text, t.projectId);
    console.log(`  · ${t.id} [${t.taskType}, ${t.status}, ${t.assignedKey ?? "unassigned"}, from ${t.source}, ${etDateTime(t.createdAt)} ET] "${one(t.title, 110)}"`);
    if (t.projectId) {
      const p = await prisma.project.findUnique({ where: { id: t.projectId }, select: { title: true, clientId: true } });
      console.log(`      on job: ${p?.title ?? t.projectId}${p?.clientId === CLIENT ? " (one of THIS client's own jobs)" : ""}`);
    }
    console.log(`      text: "${one(t.description, 220)}"`);
    if (!votes.length) console.log("      PROPOSAL: none found (Jordan's own, or nothing names another client): leave it");
    for (const [i, v] of votes.entries()) console.log(`      ${i === 0 ? "PROPOSAL" : "   or   "}: ${await nameOf(v.clientId)} (${v.clientId}), because ${v.why.join("; ")}`);
  }
  console.log(`\n    OPEN CLIENT ASKS ON THIS CLIENT (${asks.length})`);
  for (const a of asks) {
    const votes = await propose(`${a.summary ?? ""}\n${a.text}`, a.projectId);
    console.log(`  · ${a.id} [${a.kind}, ${a.state}] "${one(a.summary ?? a.text, 140)}"`);
    if (!votes.length) console.log("      PROPOSAL: none found: leave it");
    for (const [i, v] of votes.entries()) console.log(`      ${i === 0 ? "PROPOSAL" : "   or   "}: ${await nameOf(v.clientId)} (${v.clientId}), because ${v.why.join("; ")}`);
  }

  // ---- (c) what was logged under this client ----------------------------
  const logs = await prisma.commLog.findMany({ where: { clientId: CLIENT }, select: { channel: true, direction: true, externalId: true, source: true, occurredAt: true } });
  const by = new Map<string, number>();
  for (const l of logs) {
    const mailbox = l.channel === "email" ? (/^gmail-([^:]+):/.exec(l.externalId ?? "")?.[1] ?? (l.source === "gmail-sent" ? "sent (any inbox)" : l.source)) : l.source;
    const k = `${l.channel} ${l.direction} ${mailbox}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const since30 = logs.filter((l) => l.occurredAt.getTime() > Date.now() - 30 * 86_400_000).length;
  console.log(`\n(c) COMMLOG ROWS FILED UNDER THIS CLIENT: ${logs.length} (${since30} in the last 30 days)`);
  for (const [k, n] of [...by].sort((a, b) => b[1] - a[1])) console.log(`    · ${k}: ${n}`);
  console.log("    (left where they are; the code fix stops new ones)");

  if (!APPLY) {
    console.log("\nDRY RUN: nothing written. --apply writes (a) only; tasks and asks are never moved by this script.");
    process.exit(0);
  }

  const r1 = contactUnlink.length ? await prisma.contact.updateMany({ where: { id: { in: contactUnlink.map((k) => k.id) }, clientId: CLIENT }, data: { clientId: null } }) : { count: 0 };
  const r2 = aliasOff.length ? await prisma.clientEmailAlias.updateMany({ where: { id: { in: aliasOff.map((a) => a.id) } }, data: { active: false } }) : { count: 0 };
  let r3 = 0;
  if (CLEAR_CLIENT_EMAIL && (emailCol || backupCol)) {
    await prisma.client.update({ where: { id: CLIENT }, data: { ...(emailCol ? { email: null } : {}), ...(backupCol ? { backupEmail: null } : {}) } });
    r3 = 1;
  }
  const after = await prisma.contact.count({ where: { clientId: CLIENT, email: { in: ADDRESSES, mode: "insensitive" } } });
  console.log(`\nAFTER: ${r1.count} contact row(s) unlinked, ${r2.count} alias row(s) made inactive, client email column ${r3 ? "cleared" : "unchanged"}; contact rows still linking the two addresses here: ${after}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
