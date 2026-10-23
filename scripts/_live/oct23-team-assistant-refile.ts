// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026): re-file a team assistant's past messages to the
// team agent whose job they name.
//
// Jordan: "Go ahead and fix Olivia's routing too." Olivia Vecere (Gary Mercer
// Team) folds onto Mike Flatley in Aryeo, so every email she sent about Sharra
// Mercer's or Joe Sutow's jobs filed on Mike. The receivers now route by
// lib/teamRouting (the Gmail scan, the OpenPhone receiver, the ask filing).
// This applies the SAME rule (decideTeamRoute) to the last 120 days:
//
//   · the rows: a folded assistant's or team member's inbound emails (by the
//     name or address on the mail) and texts (by her own number, when it is
//     that one client row) still filed where the fold put them (the parent
//     agent, or the sender);
//   · MOVE when the message names another team agent's job (house number and
//     street, or its listing link; the subject, then her words, then the
//     quoted thread; an address that is two or more clients' job, like the
//     team office in every signature, names nobody): to that agent and job;
//   · LEAVE when it names no job, or the parent's own: where it is;
//   · our replies in a moved conversation follow it (the same email thread
//     subject, every one of whose team messages moves to the same agent; a
//     text we sent her number after a moved text and before her next one);
//   · her OPEN asks from a moved message move with clientAsks.refileAskToClientJob
//     (client and job together, the reason on the ask's history and the job's
//     timeline). A closed ask, and the tasks made from these messages, are
//     listed and left: nothing in the app moves a task across clients (their
//     dedupe keys carry the client), and a closed ask is history.
//
// Calls are not re-filed: a call row carries the account it folded to, not
// the caller's number, so after the fact it cannot say who rang.
//
// Rows another re-file already moved are not touched (they are no longer
// where the fold put them): Olivia's Oct 21 "New construction videos for
// Sussex" is on Sharra Mercer's 1337 Carolannes Way since the info@ re-file
// v2 (scripts/_live/oct23-info-mail-refile-v2.ts), and stays there.
//
// Dry run (default; read-only database connection):
//   NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct23-team-assistant-refile.ts
// Write it:
//   ... scripts/_live/oct23-team-assistant-refile.ts --apply
// ---------------------------------------------------------------------------
export {};

const APPLY = process.argv.includes("--apply");
if (!APPLY) {
  const u = process.env.DATABASE_URL ?? "";
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}
const BY = "team assistant re-file (Oct 23 2026)";
const DAYS = 120;
const OLIVIA = "cmqmhmvrq000i9krz4w5r5dj4";
const OLIVIA_OCT21 = "cmvi9rekj0003l308tftoneum";
const day = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const street = (t: string | null | undefined) => (t ?? "").split(",")[0] || "no job";

type Row = { id: string; channel: string; direction: string; clientId: string | null; clientName: string | null; contactName: string | null; subject: string | null; body: string; projectId: string | null; projectGuess: boolean; occurredAt: Date; fromPhone: string | null; source: string };
type Move = { row: Row; senderId: string; toClientId: string; toClientName: string; toProjectId: string | null; why: string; follows?: string };

(async () => {
  const { prisma } = await import("@/lib/prisma");
  const { loadTeamDirectory, teamCandidates, decideTeamRoute } = await import("@/lib/teamRouting");
  const { sameSenderName } = await import("@/lib/mailMatch");
  const { threadSubject } = await import("@/lib/replyQueue");
  const { phoneKey } = await import("@/lib/integrations/openphone");
  console.log(`${APPLY ? "APPLYING" : "DRY RUN (read-only connection)"}: a team assistant's messages to the team agent whose job they name (last ${DAYS} days)\n`);

  const dir = await loadTeamDirectory();
  const name = (id: string | null | undefined) => (id ? dir.clients.get(id)?.name ?? id : "nobody");
  const jobTitle = new Map(dir.jobs.map((j) => [j.id, j.title]));
  const titleOf = async (id: string | null) => {
    if (!id) return "no job";
    if (!jobTitle.has(id)) jobTitle.set(id, (await prisma.project.findUnique({ where: { id }, select: { title: true } }))?.title ?? id);
    return street(jobTitle.get(id));
  };

  // ---- who: every folded assistant or team member with another agent to file on ----
  const phonesOf = new Map<string, string[]>();
  for (const c of await prisma.client.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true } })) {
    const k = phoneKey(c.phone);
    if (k.length === 10) phonesOf.set(k, [...(phonesOf.get(k) ?? []), c.id]);
  }
  const senders = [...dir.clients.values()].flatMap((c) => {
    const cand = teamCandidates(dir, c.id);
    return cand && cand.roots.size >= 2 ? [{ c, cand }] : [];
  });
  // A text is hers only when her number is her one client row (as the receiver reads it).
  const phoneOfClient = new Map<string, string>();
  for (const [k, ids] of phonesOf) if (ids.length === 1) phoneOfClient.set(ids[0], k);
  console.log(`team senders (folded assistants and team members with another team agent to file on): ${senders.length}`);

  // ---- their inbound messages, still where the fold put them ----
  const since = new Date(Date.now() - DAYS * 86_400_000);
  const defaults = [...new Set(senders.map((s) => s.cand.defaultId))];
  const rows: Row[] = await prisma.commLog.findMany({
    where: { occurredAt: { gte: since }, clientId: { in: defaults }, OR: [{ channel: { in: ["email", "email_duplicate"] }, direction: "in" }, { channel: "text", direction: "in" }] },
    orderBy: { occurredAt: "asc" },
    select: { id: true, channel: true, direction: true, clientId: true, clientName: true, contactName: true, subject: true, body: true, projectId: true, projectGuess: true, occurredAt: true, fromPhone: true, source: true },
  });
  const senderOf = (r: Row): string | null => {
    const fits = senders.filter((s) => {
      if (s.cand.defaultId !== r.clientId) return false;
      if (r.channel === "text") return !!r.fromPhone && phoneOfClient.get(s.c.id) === r.fromPhone;
      const who = (r.contactName ?? "").trim().toLowerCase();
      if (!who) return false;
      if (who.includes("@")) return [s.c.email, s.c.backupEmail].some((a) => a && a.trim().toLowerCase() === who);
      return sameSenderName(r.contactName, s.c.name);
    });
    return fits.length === 1 ? fits[0].c.id : null;
  };

  const moves: Move[] = [];
  const leaves: { row: Row; senderId: string; why: string }[] = [];
  for (const r of rows) {
    if (r.channel !== "text" && !/^gmail/.test(r.source)) continue;
    const senderId = senderOf(r);
    if (!senderId) continue;
    const d = decideTeamRoute(dir, senderId, { subject: r.subject, body: r.body });
    if (d.action === "move") {
      if (d.route.clientId === r.clientId && d.route.project.id === r.projectId) continue;
      moves.push({ row: r, senderId, toClientId: d.route.clientId, toClientName: d.route.clientName, toProjectId: d.route.project.id, why: d.route.how });
    } else {
      leaves.push({ row: r, senderId, why: d.action === "stay" ? d.why : "no team" });
    }
  }

  // ---- our replies in a moved conversation follow it ----
  const follows: Move[] = [];
  const movedIds = new Set(moves.map((m) => m.row.id));
  // Email: a thread subject on one client every one of whose team messages moves to one agent.
  const threads = new Map<string, Move[]>();
  for (const m of moves) if (m.row.channel !== "text") {
    const k = `${m.row.clientId}|${threadSubject(m.row.subject)}`;
    threads.set(k, [...(threads.get(k) ?? []), m]);
  }
  for (const [k, ms] of threads) {
    const [clientId, subj] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    if (!subj) continue;
    const to = new Set(ms.map((m) => m.toClientId));
    const inbound = [...rows.filter((r) => r.clientId === clientId && r.channel !== "text" && threadSubject(r.subject) === subj)];
    if (to.size !== 1 || inbound.some((r) => !movedIds.has(r.id))) continue; // someone else on the thread, or a part stays: our replies stay
    const first = ms[0].row.occurredAt;
    const out = await prisma.commLog.findMany({
      where: { clientId, channel: "email", direction: "out", occurredAt: { gte: first, lte: new Date(ms[ms.length - 1].row.occurredAt.getTime() + 14 * 86_400_000) } },
      orderBy: { occurredAt: "asc" },
      select: { id: true, channel: true, direction: true, clientId: true, clientName: true, contactName: true, subject: true, body: true, projectId: true, projectGuess: true, occurredAt: true, fromPhone: true, source: true },
    });
    for (const o of out) {
      if (threadSubject(o.subject) !== subj) continue;
      const before = [...ms].reverse().find((m) => m.row.occurredAt <= o.occurredAt) ?? ms[0];
      follows.push({ row: o, senderId: before.senderId, toClientId: before.toClientId, toClientName: before.toClientName, toProjectId: before.toProjectId, why: "our reply in her thread follows it", follows: before.row.id });
    }
  }
  // Text: what we sent her number after a moved text and before her next one (14 days at most).
  for (const m of moves) if (m.row.channel === "text" && m.row.fromPhone) {
    const next = rows.find((r) => r.channel === "text" && r.fromPhone === m.row.fromPhone && r.occurredAt > m.row.occurredAt);
    const out = await prisma.commLog.findMany({
      where: { clientId: m.row.clientId, channel: "text", direction: "out", fromPhone: m.row.fromPhone, occurredAt: { gt: m.row.occurredAt, lt: next?.occurredAt ?? new Date(m.row.occurredAt.getTime() + 14 * 86_400_000) } },
      select: { id: true, channel: true, direction: true, clientId: true, clientName: true, contactName: true, subject: true, body: true, projectId: true, projectGuess: true, occurredAt: true, fromPhone: true, source: true },
    });
    for (const o of out) follows.push({ row: o, senderId: m.senderId, toClientId: m.toClientId, toClientName: m.toClientName, toProjectId: m.toProjectId, why: "our reply to her text follows it", follows: m.row.id });
  }

  // ---- print ----
  const line = async (m: Move) =>
    `  · ${m.row.id} ${day(m.row.occurredAt)} ${m.row.channel}${m.row.direction === "out" ? " (ours)" : ""} from ${m.row.direction === "out" ? "us" : name(m.senderId)} "${(m.row.subject ?? m.row.body.replace(/\s+/g, " ")).slice(0, 70)}"\n` +
    `      from: ${m.row.clientName ?? name(m.row.clientId)} on ${await titleOf(m.row.projectId)}${m.row.projectGuess ? " (guessed)" : ""}\n` +
    `      to:   ${m.toClientName} on ${await titleOf(m.toProjectId)}   (${m.why})`;
  console.log(`\nMOVE: her message names another team agent's job (${moves.length}):`);
  for (const m of moves) console.log(await line(m));
  console.log(`\nFOLLOWS: our replies in a moved conversation (${follows.length}):`);
  for (const m of follows) console.log(await line(m));

  const olivia = leaves.filter((l) => l.senderId === OLIVIA);
  console.log(`\nLEAVE: Olivia Vecere's other messages, where they are (${olivia.length}):`);
  for (const l of olivia) console.log(`  · ${l.row.id} ${day(l.row.occurredAt)} ${l.row.channel} "${(l.row.subject ?? "").slice(0, 70)}"\n      stays: ${l.row.clientName} on ${await titleOf(l.row.projectId)}${l.row.projectGuess ? " (guessed)" : ""}   (${l.why})`);
  const bySender = new Map<string, number>();
  for (const l of leaves) if (l.senderId !== OLIVIA) bySender.set(l.senderId, (bySender.get(l.senderId) ?? 0) + 1);
  console.log(`\nLEAVE: everyone else's messages that name no other team agent's job: ${[...bySender.values()].reduce((a, b) => a + b, 0)} (${[...bySender].map(([id, n]) => `${name(id)} ${n}`).join(", ") || "none"})`);
  const o21 = await prisma.commLog.findUnique({ where: { id: OLIVIA_OCT21 }, select: { clientName: true, projectId: true } });
  console.log(`\nOlivia's Oct 21 "New construction videos for Sussex" (${OLIVIA_OCT21}): now ${o21?.clientName ?? "?"} on ${await titleOf(o21?.projectId ?? null)}; ${o21?.clientName === "Mike Flatley" ? "STILL ON MIKE FLATLEY: run the info@ re-file v2 first" : "moved by the info@ re-file v2, not touched here"}.`);

  // ---- asks and tasks from the moved messages ----
  const all = [...moves, ...follows];
  const asks = await prisma.clientAsk.findMany({ where: { sourceRef: { in: moves.map((m) => m.row.id) } }, select: { id: true, clientId: true, projectId: true, state: true, summary: true, text: true, sourceRef: true } });
  const askMoves = asks.flatMap((a) => {
    const m = moves.find((x) => x.row.id === a.sourceRef)!;
    return a.clientId === m.toClientId && a.projectId === m.toProjectId ? [] : [{ a, m }];
  });
  console.log(`\nASKS from the moved messages (${askMoves.length}):`);
  for (const { a, m } of askMoves) console.log(`  · ${a.id} [${a.state}] "${(a.summary || a.text).replace(/\s+/g, " ").slice(0, 90)}"\n      from: ${name(a.clientId)} on ${await titleOf(a.projectId)}\n      to:   ${a.state === "OPEN" ? `${m.toClientName} on ${await titleOf(m.toProjectId)} (clientAsks.refileAskToClientJob)` : "left as it is (not open)"}`);
  const tasks: string[] = [];
  const seenTasks = new Set<string>();
  for (const m of moves) {
    const t = await prisma.smartTask.findMany({
      where: { clientId: m.row.clientId, createdAt: { gte: new Date(m.row.occurredAt.getTime() - 60_000), lte: new Date(m.row.occurredAt.getTime() + 20 * 60_000) }, contactName: { equals: name(m.senderId), mode: "insensitive" } },
      select: { id: true, title: true, status: true, taskType: true, projectId: true },
    });
    for (const x of t) if (!seenTasks.has(x.id) && seenTasks.add(x.id)) tasks.push(`${x.id} [${x.status}, ${x.taskType}] "${x.title}" on ${m.row.clientName}, ${await titleOf(x.projectId)} (from ${m.row.id}; belongs with ${m.toClientName}, ${await titleOf(m.toProjectId)})`);
  }
  console.log(`\nTASKS made from the moved messages, listed and left (${tasks.length}):`);
  for (const t of tasks) console.log(`  · ${t}`);
  console.log(`\nTOTAL: ${moves.length} of her messages move, ${follows.length} of our replies follow, ${askMoves.filter((x) => x.a.state === "OPEN").length} open ask(s) move; ${leaves.length} left where they are.`);

  if (!APPLY) {
    console.log("\nNothing was written. Run with --apply to make these changes.");
    process.exit(0);
  }
  let moved = 0;
  for (const m of all) {
    const u = await prisma.commLog.updateMany({ where: { id: m.row.id, clientId: m.row.clientId, projectId: m.row.projectId }, data: { clientId: m.toClientId, clientName: m.toClientName, projectId: m.toProjectId, projectGuess: false } });
    moved += u.count;
  }
  const { refileAskToClientJob } = await import("@/lib/clientAsks");
  const askResults: string[] = [];
  for (const { a, m } of askMoves) {
    if (a.state !== "OPEN" || !m.toProjectId) continue;
    const r = await refileAskToClientJob(a.id, m.toProjectId, BY, `${name(m.senderId)} wrote it about ${m.toClientName}'s job: ${m.why}.`);
    askResults.push(`${a.id}: ${r.message}`);
  }
  console.log(`\nMoved ${moved} of ${all.length} row(s); asks: ${askResults.join("; ") || "none"}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
