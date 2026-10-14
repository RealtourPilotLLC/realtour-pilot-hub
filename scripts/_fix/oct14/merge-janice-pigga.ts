// Oct 14 2026 (Jordan): "Merge her duplicate record." Janice Pigga had two
// Client rows:
//   OLD cmsj7ok4g0007k404bt6xjnb2: janicepigga@gmail.com, her Aryeo customer,
//       phone, 2 jobs, comms, tasks, an AI client profile, and an ENDED content
//       enrollment (one 2025-09 imported month, 7 call topics, 9 facts).
//   NEW cmue43gra0040k404isckhu5s: pigga3803@gmail.com from her Sep 23 signup,
//       her ACTIVE program, strategy, scripts, portal account and welcome.
// clientDedupe.mergeClientsById refuses this (both enrolled) and would keep
// OLD as survivor (more projects) while re-pointing only some content tables,
// orphaning the portal seat, facts, strategy versions and more. So: NEW
// survives. Every column on every table that holds OLD's id (any column named
// clientId / *ClientId) is re-pointed to NEW; the ended enrollment's children
// move onto the active enrollment and the empty ended enrollment row is
// deleted; OLD's Aryeo link, phone, brand folder and profile move to NEW;
// janicepigga@gmail.com becomes the backup email. One AuditLog row carries the
// full before-image (both client rows, the deleted enrollment, every moved id)
// so it can be put back by hand. All in one transaction.
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/oct14/merge-janice-pigga.ts [--apply]
import { prisma } from "@/lib/prisma";

const OLD = "cmsj7ok4g0007k404bt6xjnb2";
const NEW = "cmue43gra0040k404isckhu5s";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "APPLY" : "DRY RUN");
  const [o, n] = await Promise.all([prisma.client.findUnique({ where: { id: OLD } }), prisma.client.findUnique({ where: { id: NEW } })]);
  if (!o || !n || o.name !== "Janice Pigga" || n.name !== "Janice Pigga") throw new Error("Both Janice Pigga rows must exist — stopping.");
  const oe = await prisma.contentEnrollment.findUnique({ where: { clientId: OLD } });
  const ne = await prisma.contentEnrollment.findUnique({ where: { clientId: NEW } });
  if (!ne || ne.status !== "ACTIVE") throw new Error("NEW must hold the active enrollment — stopping.");
  if (oe && oe.status !== "ENDED") throw new Error("OLD's enrollment is not ENDED — stopping.");

  // Every column that can hold a client id.
  const cols = await prisma.$queryRawUnsafe<{ table_name: string; column_name: string }[]>(
    `select table_name, column_name from information_schema.columns where table_schema='public' and (column_name = 'clientId' or column_name ilike '%ClientId') and data_type in ('text','character varying') order by 1,2`,
  );
  const plan: { table: string; column: string; ids: string[] }[] = [];
  for (const c of cols) {
    if (c.table_name === "ContentEnrollment" && c.column_name === "clientId") continue; // handled below
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`select id from "${c.table_name}" where "${c.column_name}" = $1`, OLD).catch(() => [] as { id: string }[]);
    if (rows.length) plan.push({ table: c.table_name, column: c.column_name, ids: rows.map((r) => r.id) });
  }
  // The ended enrollment's children (by enrollmentId).
  const enrPlan: { table: string; ids: string[] }[] = [];
  if (oe) {
    const ecols = await prisma.$queryRawUnsafe<{ table_name: string }[]>(`select table_name from information_schema.columns where table_schema='public' and column_name='enrollmentId'`);
    for (const c of ecols) {
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(`select id from "${c.table_name}" where "enrollmentId" = $1`, oe.id).catch(() => [] as { id: string }[]);
      if (rows.length) enrPlan.push({ table: c.table_name, ids: rows.map((r) => r.id) });
    }
  }
  for (const p of plan) console.log(`re-point ${p.table}.${p.column}: ${p.ids.length}`);
  for (const p of enrPlan) console.log(`move to active enrollment ${p.table}.enrollmentId: ${p.ids.length}`);
  console.log(`delete ended enrollment ${oe?.id ?? "(none)"}; delete client ${OLD}`);
  const merged = {
    email: n.email, backupEmail: o.email, phone: n.phone ?? o.phone, company: n.company ?? o.company,
    brandAssetsPath: n.brandAssetsPath ?? o.brandAssetsPath, profileSummary: n.profileSummary ?? o.profileSummary, profileJson: n.profileJson ?? o.profileJson, profileUpdatedAt: n.profileUpdatedAt ?? o.profileUpdatedAt,
    aryeoCustomerId: n.aryeoCustomerId ?? o.aryeoCustomerId, licenseNumber: n.licenseNumber ?? o.licenseNumber, avatarUrl: n.avatarUrl ?? o.avatarUrl,
    editingPreferences: n.editingPreferences ?? o.editingPreferences, generalNotes: n.generalNotes ?? o.generalNotes, clientPreferences: n.clientPreferences ?? o.clientPreferences,
    brandColors: n.brandColors ?? o.brandColors, socialClient: n.socialClient || o.socialClient, socialPlan: n.socialPlan ?? o.socialPlan,
    firstSeenAt: n.firstSeenAt ?? o.firstSeenAt, firstSeenVia: n.firstSeenVia ?? o.firstSeenVia, welcomeTextAt: n.welcomeTextAt ?? o.welcomeTextAt,
    aryeoTeamId: n.aryeoTeamId ?? o.aryeoTeamId, aryeoTeamName: n.aryeoTeamName ?? o.aryeoTeamName,
    createdAt: o.createdAt < n.createdAt ? o.createdAt : n.createdAt,
  };
  console.log("survivor fields:", JSON.stringify({ ...merged, profileSummary: merged.profileSummary ? "(kept)" : null, profileJson: merged.profileJson ? "(kept)" : null }));
  if (!apply) return;

  await prisma.$transaction(async (tx) => {
    const snapshot = {
      survivorId: NEW, deletedClientId: OLD,
      oldClient: o, newClientBefore: n, deletedEnrollment: oe,
      repointed: plan.map((p) => ({ table: p.table, column: p.column, ids: p.ids })),
      enrollmentMoved: oe ? { from: oe.id, to: ne.id, rows: enrPlan } : null,
    };
    await tx.auditLog.create({ data: { actor: "info@realtourpilot.com", action: "client_merge", target: "Janice Pigga", detail: JSON.stringify(snapshot) } });
    for (const p of enrPlan) {
      await tx.$executeRawUnsafe(`update "${p.table}" set "enrollmentId" = $1 where "enrollmentId" = $2`, ne.id, oe!.id);
    }
    for (const p of plan) {
      await tx.$executeRawUnsafe(`update "${p.table}" set "${p.column}" = $1 where "${p.column}" = $2`, NEW, OLD);
    }
    if (oe) await tx.contentEnrollment.delete({ where: { id: oe.id } });
    await tx.client.delete({ where: { id: OLD } });
    await tx.client.update({ where: { id: NEW }, data: merged });
  }, { timeout: 60_000 });
  const left = [];
  for (const p of plan) {
    const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint n from "${p.table}" where "${p.column}" = $1`, OLD);
    if (Number(r[0].n)) left.push(`${p.table}.${p.column}`);
  }
  console.log(left.length ? `STILL POINTING AT OLD: ${left.join(", ")}` : "Merged. Nothing points at the old record any more.");
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err); await prisma.$disconnect(); process.exit(1); });
