// ---------------------------------------------------------------------------
// DELEGATED EMAILS THAT STAYED ON JORDAN'S LIST (Oct 27 2026).
//
// Jordan's Loom, 5:00: "I delegated these emails to Kyle ... They're still
// showing under Email needing my reply." The dashboard now keys a delegated
// email to its THREAD (lib/emailDelegation: the Messages link, bounded to
// 300 characters) instead of the client's reply to-do, and the list leaves
// out what is delegated. This repairs the rows the old way left behind:
//
//   · ANSWERED: the thread has a reply from us after it was delegated (the
//     Sent-folder read, or the hub's own send). The task closes as the hub's
//     change with that as its evidence (closeDelegatedEmailTasks: a task that
//     needs Jordan's check goes to Ready for verification instead).
//   · UNLINKED: still waiting, but its record has no thread link (a subject
//     too long for the old 300-character link, or the reply to-do itself
//     delegated). The thread link is added to the record, so it shows under
//     Delegated by me and on Kyle's Client Communications with Reply.
//   · Everything else is printed and left.
//
// Never deletes, never sends, never reassigns. Every row is printed.
//
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_live/oct27-loom-delegated-emails.ts [--apply]
// ---------------------------------------------------------------------------
import { APPLY, db } from "./_oct22-guard";

const DONE = ["COMPLETED", "CANCELLED", "DONE", "CLOSED"];

async function main() {
  const prisma = await db();
  const now = new Date();
  const ed = await import("../../src/lib/emailDelegation");

  const tasks = await prisma.smartTask.findMany({
    where: {
      delegatedAt: { not: null },
      status: { notIn: DONE },
      OR: [
        { dedupeKey: { startsWith: `deleg:${ed.EMAIL_THREAD_PREFIX}` } },
        { delegation: { contains: `"sourceHref":"${ed.EMAIL_THREAD_PREFIX}` } },
        { source: "gmail" },
        { title: { startsWith: "Reply to " } },
      ],
    },
    select: { id: true, title: true, clientId: true, source: true, sourceDetail: true, dedupeKey: true, delegation: true, delegatedAt: true, delegatedBy: true, assignedKey: true, status: true, client: { select: { name: true } } },
    orderBy: { delegatedAt: "asc" },
  });

  type Plan = { id: string; line: string; act: "close" | "link" | "leave"; why: string; clientId: string | null; subject: string | null; href?: string };
  const plans: Plan[] = [];
  for (const t of tasks) {
    let rec: Record<string, unknown> = {};
    try { rec = JSON.parse(t.delegation ?? "{}") ?? {}; } catch { rec = {}; }
    const fromRec = ed.parseEmailThreadHref(typeof rec.sourceHref === "string" ? rec.sourceHref : t.dedupeKey?.startsWith("deleg:") ? t.dedupeKey.slice(6) : null);
    // The subject: the record's link, else the task's own "Reply to <name>: <subject>", else the client's newest email.
    let subject = fromRec?.subject ?? (/^Reply to [^:]+:\s*(.+)$/.exec(t.title)?.[1]?.trim() || null);
    if ((!subject || subject === "their email") && t.clientId) {
      const last = await prisma.commLog.findFirst({ where: { clientId: t.clientId, channel: "email", direction: "in" }, orderBy: { occurredAt: "desc" }, select: { subject: true } });
      subject = last?.subject ?? null;
    }
    const line = `${t.id}  ${t.title.slice(0, 80)}  [${t.client?.name ?? "-"}]  with ${t.assignedKey ?? "-"} since ${t.delegatedAt?.toISOString().slice(0, 16)}  by ${String(rec.byName ?? t.delegatedBy ?? "-")}`;
    if (!subject) { plans.push({ id: t.id, line, act: "leave", why: "no email subject on the task or the client: not an email thread", clientId: t.clientId, subject: null }); continue; }
    const ref = { subject: fromRec?.subject ?? subject, clientId: fromRec?.clientId ?? t.clientId };
    const status = (await ed.emailThreadStatus([ref], now)).get(ed.emailThreadKey(ref));
    if (status?.answeredAt && t.delegatedAt && status.answeredAt.getTime() > t.delegatedAt.getTime()) {
      // An unlinked one is linked first, so the one close path (which reads thread links) finds it.
      plans.push({ id: t.id, line, act: "close", why: `answered ${status.answeredAt.toISOString().slice(0, 16)} (after it was delegated)`, clientId: ref.clientId, subject: ref.subject, href: fromRec ? undefined : ed.emailThreadHref(subject, t.clientId) });
      continue;
    }
    if (!fromRec) {
      plans.push({ id: t.id, line, act: "link", why: `still waiting; its record has no thread link: "${subject.slice(0, 80)}"`, clientId: t.clientId, subject, href: ed.emailThreadHref(subject, t.clientId) });
      continue;
    }
    plans.push({ id: t.id, line, act: "leave", why: `still waiting, linked to its thread (${status?.lastInAt ? `last email in ${status.lastInAt.toISOString().slice(0, 16)}` : "no email found in 45 days"})`, clientId: ref.clientId, subject: ref.subject });
  }

  for (const act of ["close", "link", "leave"] as const) {
    const list = plans.filter((p) => p.act === act);
    console.log(`\n=== ${act === "close" ? "CLOSE (answered)" : act === "link" ? "ADD THREAD LINK" : "LEAVE"} (${list.length}) ===`);
    for (const p of list) console.log(`${p.line}\n    ${p.why}`);
  }

  if (!APPLY) { console.log("\ndry run: nothing written. Re-run with --apply."); return; }
  let closed = 0, linked = 0;
  const link = async (id: string, href: string) => {
    const t = await prisma.smartTask.findUnique({ where: { id }, select: { delegation: true, status: true } });
    if (!t || DONE.includes(t.status)) return false;
    let rec: Record<string, unknown> = {};
    try { rec = JSON.parse(t.delegation ?? "{}") ?? {}; } catch { rec = {}; }
    rec.sourceHref = href;
    await prisma.smartTask.update({ where: { id }, data: { delegation: JSON.stringify(rec) } });
    return true;
  };
  for (const p of plans) {
    if (p.act === "close") {
      if (p.href) await link(p.id, p.href);
      closed += await ed.closeDelegatedEmailTasks({ clientId: p.clientId, subject: p.subject ?? undefined, why: "sent", by: null, now });
    } else if (p.act === "link" && p.href) {
      if (await link(p.id, p.href)) linked++;
    }
  }
  console.log(`\nwritten: ${closed} closed (answered), ${linked} linked to their thread. Nothing deleted, nothing sent.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
