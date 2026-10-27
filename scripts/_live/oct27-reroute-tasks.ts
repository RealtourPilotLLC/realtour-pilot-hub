// ---------------------------------------------------------------------------
// KYLE'S OPEN TASKS, REROUTED AND CLEANED (Oct 27 2026).
//
// Jordan: "Kyle handles comms, delegation, review, delivery, and coordination.
// James is the creative manager. I am CEO." The engines now route at the
// source (src/lib/taskRouting.ts); this moves the rows they already put on
// Kyle's desk, once:
//
//   brand update confirmations (brand-ack:…)          → the creative manager
//   content-program mid-month checks                  → the creative manager,
//     or closed when the program has not started (Kristen Pavillard) or the
//     month's ask is already answered (programTaskCloser's own verdict)
//   "Filmed beyond the plan" (content_capacity_review) → the creative manager
//   editing recovery ("Late with <editor>") tasks      → the creative manager
//   Script Studio script package / client response    → the listing-scripts
//                                                        owner (Jordan)
//   a Google Calendar acceptance turned into a to-do   → closed, a duplicate of
//     (Kristen's "Prepare for Brand Discovery Call")      Jordan's own Calendly
//                                                        meeting_prep task
//   a client reply task we have since answered        → closed, the reply named
//   a reply task that is only a thank-you             → closed, nothing to answer
//
// Never deletes. Never sends. A task a person assigned or delegated is left
// as it is (printed). Every close appends "Closed by the hub on Oct 27: …" to
// the task's description (the program closer's note), status COMPLETED.
// Bookkeeping to-dos the AI filed from a client message ("Log USP…", "Log
// access code…") are printed and left: a reply to the client does not do them.
//
// Every row is printed: id, title, client, from → to, or the close reason.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-reroute-tasks.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

type Desk = { id: string; key: string; name: string };
type Row = { id: string; title: string; client: string; from: string; act: "move" | "close" | "leave"; to?: Desk; why: string };

const DONE_STATUSES = ["COMPLETED", "CANCELLED", "DONE", "CLOSED"];

async function main() {
  const prisma = await db();
  const now = new Date();
  const { creativeWorkDesk, listingScriptsDesk } = await import("../../src/lib/taskRouting");
  const cm = await creativeWorkDesk();
  const scripts = await listingScriptsDesk();
  if (!cm) throw new Error("No creative manager (or owner) on the roster: nothing to move to. Stopping.");
  if (!scripts) throw new Error("No owner roster row for listing scripts: nothing to move to. Stopping.");
  const kyle = await prisma.teamMember.findFirst({ where: { name: { startsWith: "Kyle" }, active: true }, select: { id: true, name: true } });
  if (!kyle) throw new Error("Kyle is not on the roster: stopping.");
  console.log(`creative work → ${cm.name} (${cm.key}); listing scripts → ${scripts.name} (${scripts.key}); Kyle = ${kyle.name}\n`);

  // Kyle's open tasks: his key, his roster row with no key, or the shared ops
  // pile (no key, no owner), as his desk reads them (taskAging.personTaskWhere).
  const open = await prisma.smartTask.findMany({
    where: {
      status: { notIn: DONE_STATUSES },
      OR: [{ assignedKey: "kyle" }, { assignedKey: null, ownerId: kyle.id }, { assignedKey: null, ownerId: null }],
    },
    select: {
      id: true, title: true, taskType: true, source: true, dedupeKey: true, description: true, reasonCreated: true,
      assignedKey: true, ownerId: true, assignedManually: true, delegatedAt: true, clientId: true, createdAt: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const fromOf = (t: (typeof open)[number]) => t.assignedKey ?? (t.ownerId === kyle.id ? "kyle (owner row)" : "unassigned (Kyle's ops pile)");
  const rows: Row[] = [];
  const row = (t: (typeof open)[number], r: Omit<Row, "id" | "title" | "client" | "from">) =>
    rows.push({ id: t.id, title: t.title, client: t.client?.name ?? "-", from: fromOf(t), ...r });
  const personal = (t: (typeof open)[number]) => t.assignedManually || !!t.delegatedAt;

  // 1. Brand update confirmations, filmed-beyond-plan, editing recovery → the creative manager.
  for (const t of open) {
    const key = t.dedupeKey ?? "";
    const kind = key.startsWith("brand-ack:")
      ? "brand update confirmation"
      : t.taskType === "content_capacity_review"
        ? "filmed beyond the plan"
        : /\blate with\b/i.test(t.title) || /\bediting recovery\b/i.test(t.title)
          ? "editing recovery"
          : null;
    if (!kind) continue;
    if (t.assignedKey !== "kyle" && t.ownerId !== kyle.id && kind !== "editing recovery") continue; // only what is on Kyle
    if (personal(t)) { row(t, { act: "leave", why: `${kind}: a person assigned or delegated it` }); continue; }
    row(t, { act: "move", to: cm, why: `${kind} is the creative manager's` });
  }

  // 2. Mid-month checks: closed when the closer's own verdict says it no longer holds, else moved.
  const mid = open.filter((t) => (t.dedupeKey ?? "").startsWith("program-reminder-midmonth:"));
  if (mid.length) {
    const { programTaskVerdicts } = await import("../../src/lib/programTaskCloser");
    const { verdicts } = await programTaskVerdicts({ now, taskIds: mid.map((t) => t.id) });
    for (const t of mid) {
      const v = verdicts.find((x) => x.taskId === t.id);
      if (personal(t)) { row(t, { act: "leave", why: "mid-month check: a person assigned or delegated it" }); continue; }
      if (v && !v.holds) row(t, { act: "close", why: v.evidence });
      else row(t, { act: "move", to: cm, why: `mid-month check is the creative manager's${v ? ` (still holds: ${v.evidence})` : ""}` });
    }
  }

  // 3. Script Studio → the listing-scripts owner.
  for (const t of open) {
    const key = t.dedupeKey ?? "";
    if (!key.startsWith("scripting-script-") && !key.startsWith("scripting-client-")) continue;
    if (personal(t)) { row(t, { act: "leave", why: "Script Studio: a person assigned or delegated it" }); continue; }
    row(t, { act: "move", to: scripts, why: "listing scripts are the owner's (Script Studio)" });
  }

  // 4. Calendar notices that became to-dos: closed when the meeting already has its Calendly prep.
  const { isCalendarNotice } = await import("../../src/lib/integrations/google");
  for (const t of open) {
    if (t.source !== "gmail" || !["todo", "client_reply"].includes(t.taskType) || !t.clientId) continue;
    const d = (t.description ?? "").trim();
    const sep = d.indexOf(" — ");
    const notice = isCalendarNotice({ subject: sep >= 0 ? d.slice(0, sep) : d, body: sep >= 0 ? d.slice(sep + 3) : "" })
      || (/Pavillard/i.test(t.client?.name ?? "") && /brand discovery call/i.test(t.title));
    if (!notice) continue;
    if (personal(t)) { row(t, { act: "leave", why: "calendar notice: a person assigned or delegated it" }); continue; }
    const prep = await prisma.smartTask.findFirst({ where: { clientId: t.clientId, taskType: "meeting_prep" }, orderBy: { createdAt: "desc" }, select: { id: true, assignedKey: true, status: true } });
    if (!prep) { row(t, { act: "leave", why: "calendar notice, but no Calendly meeting_prep task for this client to defer to" }); continue; }
    row(t, { act: "close", why: `a Google Calendar notice, not the client writing; a duplicate of the Calendly meeting prep task ${prep.id} (${prep.assignedKey ?? "unassigned"}, ${prep.status.toLowerCase()})` });
  }

  // 5. Reply tasks: answered since, or only a thank-you.
  const decided = new Set(rows.map((r) => r.id));
  const replies = open.filter((t) => !decided.has(t.id) && t.taskType === "client_reply" && (t.assignedKey === "kyle" || t.ownerId === kyle.id || (!t.assignedKey && !t.ownerId)));
  const { replyVerdicts } = await import("../../src/lib/taskEvidence");
  const { isAckOnlyInbound } = await import("../../src/lib/replyQueue");
  const verdicts = replies.length ? await replyVerdicts({ now, taskIds: replies.map((t) => t.id) }) : [];
  for (const t of replies) {
    if (personal(t)) { row(t, { act: "leave", why: "reply: a person assigned or delegated it" }); continue; }
    const v = verdicts.find((x) => x.taskId === t.id);
    if (v?.evidence) { row(t, { act: "close", why: v.evidence }); continue; }
    const msg = (t.description ?? "").trim();
    const single = msg && !/\n\n— /.test(msg) && !/Closed by the hub/.test(msg);
    if (single && isAckOnlyInbound(msg, t.source === "gmail" ? "email" : "text")) {
      row(t, { act: "close", why: `the client's message is only a thank-you or acknowledgment ("${msg.replace(/\s+/g, " ").slice(0, 80)}"), nothing to answer` });
      continue;
    }
    row(t, { act: "leave", why: `reply still owed: ${v?.kept ?? "not checked"}` });
  }

  // 6. The AI's bookkeeping to-dos from client messages: printed, left.
  for (const t of open) {
    if (decided.has(t.id) || rows.some((r) => r.id === t.id)) continue;
    if (t.taskType !== "todo" || !/^Inbound message from client/i.test(t.reasonCreated ?? "")) continue;
    const msg = (t.description ?? "").trim();
    const single = msg && !/\n\n— /.test(msg);
    if (single && isAckOnlyInbound(msg, t.source === "gmail" ? "email" : "text") && !personal(t)) {
      row(t, { act: "close", why: `the client's message is only a thank-you or acknowledgment ("${msg.replace(/\s+/g, " ").slice(0, 80)}"), nothing to do` });
      continue;
    }
    const ageDays = Math.floor((now.getTime() - t.createdAt.getTime()) / 864e5);
    row(t, { act: "leave", why: `a to-do the AI filed from a client message (${ageDays}d old); a reply to the client does not do it, so it is left for a person` });
  }

  // ---- print ------------------------------------------------------------------
  const show = (r: Row) =>
    `${r.id}  ${r.title.slice(0, 70)}  [${r.client}]\n    ${r.from} → ${r.act === "move" ? `${r.to!.key} (${r.to!.name})` : r.act === "close" ? "COMPLETED" : "unchanged"}: ${r.why}`;
  for (const act of ["move", "close", "leave"] as const) {
    const list = rows.filter((r) => r.act === act);
    console.log(`\n=== ${act === "move" ? "MOVE" : act === "close" ? "CLOSE" : "LEAVE"} (${list.length}) ===`);
    for (const r of list) console.log(show(r));
  }
  console.log(`\n${rows.filter((r) => r.act === "move").length} to move, ${rows.filter((r) => r.act === "close").length} to close, ${rows.filter((r) => r.act === "leave").length} left.`);

  if (!APPLY) { console.log("\ndry run: nothing written. Re-run with --apply."); return; }

  const { closingNote } = await import("../../src/lib/programTaskCloser");
  let moved = 0, closed = 0;
  for (const r of rows) {
    if (r.act === "move") {
      const u = await prisma.smartTask.updateMany({
        where: { id: r.id, status: { notIn: DONE_STATUSES }, assignedManually: false, delegatedAt: null },
        data: { assignedKey: r.to!.key, ownerId: r.to!.id },
      });
      moved += u.count;
    } else if (r.act === "close") {
      const t = await prisma.smartTask.findUnique({ where: { id: r.id }, select: { description: true } });
      const u = await prisma.smartTask.updateMany({
        where: { id: r.id, status: { notIn: DONE_STATUSES }, assignedManually: false, delegatedAt: null },
        data: { status: "COMPLETED", completedAt: now, description: `${t?.description ? `${t.description}\n\n` : ""}${closingNote(r.why, now)}`.slice(0, 20_000) },
      });
      closed += u.count;
    }
  }
  console.log(`\nwritten: ${moved} moved, ${closed} closed. Nothing deleted, nothing sent.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
