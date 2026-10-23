// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 22 2026, comms audit M3): the duplicates already made.
//
//   A. OPEN CLIENT ASKS filed more than once, by the rule createAsk now uses
//      (lib/clientAsks duplicateAskReason): the same client, kind and job with
//      the same words within 48 hours, or a scheduling ask in the same
//      booking conversation within 24 hours. Nehemiah Lindo's one booking
//      made 7 open scheduling asks; Joe Sutow has 2 identical photo 38 asks.
//      One ask stays (a keyed photo-part ask over a plain one, else the
//      oldest), takes the others' words, and the others are set aside as
//      "Not needed: merged into ...", through clientAsks.markNotNeeded.
//   B. AN EMAIL SENT TO BOTH info@ AND hello@, logged once per inbox. The
//      RFC Message-ID that now stops it (integrations/google.ts) is not on
//      the old rows, so a pair is: inbound, the same subject and the same
//      words, from the two inboxes, within 5 minutes. The first one logged
//      stays; the other is set aside, not deleted: its channel becomes
//      "email_duplicate", which no screen or AI context reads (set it back to
//      "email" to undo).
//   C. SLACK CARD fdmx2h1a, which rolled several clients' asks onto one card
//      (the roll now needs the same client too, integrations/slackSync.ts):
//      its lines and the client each names, listed only. Not changed.
//
// Dry run (default; read-only connection):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct22-duplicate-cleanup.ts
// Write A and B:
//   ... scripts/_live/oct22-duplicate-cleanup.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}
const BY = "Hub repair (Oct 22 audit)";
const one = (s: string | null | undefined, n = 110) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const when = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { duplicateAskReason, markNotNeeded } = await import("@/lib/clientAsks");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: comms audit M3 duplicates\n`);

  // ---------------------------------------------------------------- A
  console.log("A. OPEN CLIENT ASKS FILED MORE THAN ONCE");
  const askRows = await prisma.clientAsk.findMany({
    where: { state: "OPEN" },
    orderBy: { askedAt: "asc" },
    select: { id: true, clientId: true, kind: true, projectId: true, text: true, summary: true, askedAt: true, source: true, dedupeKey: true, historyJson: true },
  });
  const clientNames = new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(askRows.map((a) => a.clientId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const asks = askRows.map((a) => ({ ...a, client: { name: clientNames.get(a.clientId) ?? null } }));
  const keyed = (k: string | null) => !!k && (k.startsWith("photo-office:") || k.startsWith("photo-shared:"));
  const fromMessage = (k: string | null) => !!k && (k.startsWith("msg:") || k.startsWith("ask:") || keyed(k));
  const groups = new Map<string, typeof asks>();
  // --skip-job=<projectId>[,…]: leave a job's asks unmerged (Oct 22: 859 N
  // Lawrence's "pic 11 dining area and pic 38" is not a twin of the pic 38
  // office question; pic 11 stays its own change).
  const skipJobs = new Set((process.argv.find((x) => x.startsWith("--skip-job=")) ?? "").slice(11).split(",").filter(Boolean));
  for (const a of asks) {
    if (!fromMessage(a.dedupeKey)) continue;
    if (a.projectId && skipJobs.has(a.projectId)) continue;
    const k = `${a.clientId}|${a.kind}|${a.projectId ?? "-"}`;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const merges: { keep: (typeof asks)[number]; drop: { a: (typeof asks)[number]; why: string }[] }[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Chains: each ask joins the open cluster it duplicates.
    const clusters: (typeof asks)[] = [];
    for (const a of g) {
      const c = clusters.find((cl) => cl.some((b) => duplicateAskReason(b, a)));
      if (c) c.push(a); else clusters.push([a]);
    }
    for (const c of clusters) {
      if (c.length < 2) continue;
      const keep = c.find((x) => keyed(x.dedupeKey)) ?? c[0];
      merges.push({ keep, drop: c.filter((x) => x.id !== keep.id).map((a) => ({ a, why: duplicateAskReason(keep, a) ?? duplicateAskReason(c.find((b) => b.id !== a.id && duplicateAskReason(b, a))!, a) ?? "same-booking" })) });
    }
  }
  if (!merges.length) console.log("  none");
  for (const m of merges) {
    console.log(`  ${m.keep.client?.name ?? m.keep.clientId} · ${m.keep.kind}${m.keep.projectId ? ` on job ${m.keep.projectId}` : ", no job"}: ${m.drop.length + 1} open asks → 1`);
    console.log(`    KEEP ${m.keep.id} (${when(m.keep.askedAt)}, ${m.keep.dedupeKey?.split(":")[0]}) "${one(m.keep.summary || m.keep.text)}"`);
    for (const d of m.drop) console.log(`    set aside ${d.a.id} (${when(d.a.askedAt)}, ${d.why}) "${one(d.a.summary || d.a.text)}"`);
  }

  // ---------------------------------------------------------------- B
  console.log("\nB. ONE EMAIL LOGGED ONCE PER INBOX (info@ and hello@)");
  const rows = await prisma.commLog.findMany({
    where: { channel: "email", direction: "in", source: "gmail", externalId: { startsWith: "gmail-" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, externalId: true, subject: true, body: true, occurredAt: true, createdAt: true, clientName: true },
  });
  const mailbox = (x: string | null) => /^gmail-([^:\s]+@[^:\s]+):/.exec(x ?? "")?.[1]?.toLowerCase() ?? null;
  const bySig = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!mailbox(r.externalId)) continue;
    const k = `${(r.subject ?? "").trim().toLowerCase()}|${r.body.trim()}`;
    bySig.set(k, [...(bySig.get(k) ?? []), r]);
  }
  const twins: { keep: (typeof rows)[number]; dup: (typeof rows)[number] }[] = [];
  for (const g of bySig.values()) {
    if (g.length < 2) continue;
    const used = new Set<string>();
    for (const a of g) {
      if (used.has(a.id)) continue;
      const b = g.find((x) => x.id !== a.id && !used.has(x.id) && mailbox(x.externalId) !== mailbox(a.externalId) && Math.abs(x.occurredAt.getTime() - a.occurredAt.getTime()) <= 5 * 60_000);
      if (!b) continue;
      used.add(a.id); used.add(b.id);
      twins.push({ keep: a, dup: b });
    }
  }
  const recent = twins.filter((t) => t.keep.occurredAt >= new Date(Date.now() - 30 * 86_400_000)).length;
  console.log(`  ${twins.length} email(s) logged twice (${recent} in the last 30 days); the second copy of each is set aside`);
  for (const t of twins.slice(0, 15)) console.log(`    · ${when(t.keep.occurredAt)} ${t.keep.clientName ?? "(no client)"} "${one(t.keep.subject, 70)}": keep ${t.keep.id} (${mailbox(t.keep.externalId)}), set aside ${t.dup.id} (${mailbox(t.dup.externalId)})`);
  if (twins.length > 15) console.log(`    … and ${twins.length - 15} more`);

  // ---------------------------------------------------------------- C
  console.log("\nC. SLACK CARD fdmx2h1a (listed only)");
  const card = await prisma.smartTask.findFirst({ where: { id: { endsWith: "fdmx2h1a" } }, select: { id: true, title: true, status: true, assignedKey: true, description: true, clientId: true } });
  if (!card) console.log("  not found");
  else {
    console.log(`  ${card.id} [${card.status}, ${card.assignedKey ?? "nobody"}] "${one(card.title, 120)}"`);
    const clients = await prisma.client.findMany({ where: { parentClientId: null }, select: { id: true, name: true } });
    const first = new Map<string, { id: string; name: string }[]>();
    for (const c of clients) { const f = c.name.trim().split(/\s+/)[0]?.toLowerCase(); if (f && f.length >= 3) first.set(f, [...(first.get(f) ?? []), c]); }
    const lines = (card.description ?? "").split(/\n\s*\n/).map((l) => l.trim()).filter(Boolean);
    for (const l of lines) {
      const low = l.toLowerCase();
      const full = clients.filter((c) => c.name.includes(" ") && low.includes(c.name.toLowerCase()));
      const names = full.length ? full : [...first.entries()].filter(([f]) => new RegExp(`\\b${f}('s)?\\b`).test(low)).flatMap(([, cs]) => (cs.length === 1 ? cs : []));
      console.log(`    · ${one(l, 100)}\n        names: ${names.length ? [...new Set(names.map((c) => `${c.name} (${c.id})`))].join(", ") : "no client"}`);
    }
    console.log("  (a person splits this card; the roll that made it now needs the same client)");
  }

  if (!APPLY) {
    console.log("\nNothing was written. Run with --apply to write A and B.");
    process.exit(0);
  }
  for (const m of merges) {
    const words = [m.keep.text, ...m.drop.map((d) => d.a.text)].filter((t, i, all) => all.findIndex((x) => x.trim() === t.trim()) === i);
    const latest = m.drop[m.drop.length - 1]?.a;
    await prisma.clientAsk.update({
      where: { id: m.keep.id },
      data: {
        text: words.join("\n").slice(0, 4000),
        ...(m.keep.kind === "SCHEDULING" && latest?.summary ? { summary: latest.summary } : {}),
      },
    });
    for (const d of m.drop) await markNotNeeded(d.a.id, BY, `Merged into ${m.keep.id}: ${d.why === "same-booking" ? "the same booking" : "the same ask"}.`);
  }
  let hidden = 0;
  for (const t of twins) hidden += (await prisma.commLog.updateMany({ where: { id: t.dup.id, channel: "email" }, data: { channel: "email_duplicate" } })).count;
  console.log(`\nMerged ${merges.reduce((s, m) => s + m.drop.length, 0)} ask(s) into ${merges.length}; set aside ${hidden} duplicate email row(s).`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
