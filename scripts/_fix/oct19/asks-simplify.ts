// ---------------------------------------------------------------------------
// CLIENT ASKS SIMPLIFIED (Oct 19 2026, evening audit; lib/clientAsks). From
// this change on, only a client's own words (a text, an email, a call) or an
// ask staff typed for them is an ask, and an ask closes when its job is
// delivered. The rows filed before that are not asks any more:
//   · order notes and add-ons (source order_note): they show on the job's
//     "Before you send" box as notes now;
//   · portal session requests (source portal): the portal desk task covers it;
//   · moves and cancels seen in Aryeo (source aryeo): the appointment bell did;
//   · any open ask on a job already delivered or cancelled (or a photo-only
//     request whose photos went out).
// The boards already hide all of these; this closes the rows (DONE, with the
// reason as the note), so the history says why. Nothing is deleted, and each
// closed row can be reopened on /ops/requests.
//
//   DRY RUN (default, on a read-only connection, proved) · --apply
//   set -a && source .env && set +a && NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct19/asks-simplify.ts
// ---------------------------------------------------------------------------
export {};
import { pinReadOnlyDatabaseUrl, proveReadOnly } from "../../_lib/dbGuard";

const APPLY = process.argv.includes("--apply");
const BY = "Hub (asks simplified, Oct 19)";

const REASONS: Record<string, string> = {
  order_note: "An order note: it shows on the job's Before you send box as a note now, not as an ask.",
  addon: "An add-on on the order: it shows on the job's Before you send box as a note now, not as an ask.",
  portal: "A portal session request: its desk task on Kyle's list covers it.",
  aryeo: "A move or cancel seen in Aryeo: the appointment bell covered it.",
};

async function main() {
  if (!APPLY) pinReadOnlyDatabaseUrl();
  const { prisma } = await import("@/lib/prisma");
  if (!APPLY) {
    await proveReadOnly(prisma);
    console.log("DRY RUN on a read-only connection (proved, 25006). Nothing is written.\n");
  }
  const ca = await import("@/lib/clientAsks");
  const open = await prisma.clientAsk.findMany({
    where: { state: "OPEN" },
    orderBy: { askedAt: "asc" },
    select: { id: true, kind: true, source: true, medium: true, askedAt: true, projectId: true, clientId: true, summary: true, text: true, dedupeKey: true },
  });
  const pids = [...new Set(open.map((a) => a.projectId).filter((x): x is string => !!x))];
  const [projects, clients, photoJobs] = await Promise.all([
    prisma.project.findMany({ where: { id: { in: pids } }, select: { id: true, title: true, status: true, deliveredAt: true } }),
    prisma.client.findMany({ where: { id: { in: [...new Set(open.map((a) => a.clientId))] } }, select: { id: true, name: true } }),
    prisma.photoJob.findMany({ where: { projectId: { in: pids }, stage: "DELIVERED" }, select: { projectId: true, deliveredAt: true, stageChangedAt: true } }),
  ]);
  const pById = new Map(projects.map((p) => [p.id, p]));
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const photosOut = new Map(photoJobs.map((j) => [j.projectId, j.deliveredAt ?? j.stageChangedAt]));

  const plan: { id: string; group: string; why: string; line: string }[] = [];
  for (const a of open) {
    const p = a.projectId ? pById.get(a.projectId) : null;
    let group: string | null = null;
    let why: string | null = null;
    if (a.source === "order_note") {
      const addon = (a.dedupeKey ?? "").startsWith("addon:");
      group = addon ? "add-on" : "order note";
      why = REASONS[addon ? "addon" : "order_note"];
    } else if (a.source === "portal" || a.source === "aryeo") {
      group = a.source === "portal" ? "portal session request" : "Aryeo move/cancel";
      why = REASONS[a.source];
    } else {
      const d = ca.deliveryCloseReason(a, p, a.projectId ? photosOut.get(a.projectId) ?? null : null);
      if (d) {
        group = "delivered job";
        why = `${d.charAt(0).toUpperCase()}${d.slice(1)}.`;
      }
    }
    if (!group || !why) continue;
    const street = (p?.title ?? "no job").split(",")[0].trim();
    const words = (a.summary?.trim() || a.text).replace(/\s+/g, " ").slice(0, 90);
    plan.push({ id: a.id, group, why, line: `${group.padEnd(22)} | ${(nameOf.get(a.clientId) ?? "?").slice(0, 24).padEnd(24)} | ${street.slice(0, 26).padEnd(26)} | ${a.kind === "SCHEDULING" ? "scheduling" : a.medium ?? "?"} | ${words}` });
  }

  console.log(`Open asks: ${open.length}. ${APPLY ? "Closing" : "Would close"}: ${plan.length}.`);
  const groups = [...new Set(plan.map((x) => x.group))];
  for (const g of groups) console.log(`  ${g}: ${plan.filter((x) => x.group === g).length}`);
  console.log("");
  for (const x of plan) console.log(`${APPLY ? "CLOSE" : "would close"} | ${x.line}`);
  console.log(`\nStaying open (the client's own words on work not yet delivered): ${open.length - plan.length}.`);

  if (APPLY) {
    let n = 0;
    for (const x of plan) {
      const r = await ca.closeAskWithReason(x.id, BY, x.why);
      if (r.ok) n++;
      else console.log(`  not closed (${r.message}): ${x.id}`);
    }
    console.log(`Closed ${n} of ${plan.length}.`);
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
